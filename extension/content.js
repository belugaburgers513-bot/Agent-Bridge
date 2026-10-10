'use strict';
/**
 * Agent engine: watches the chat for ```tool blocks, runs them on the VPS through the
 * background worker, and types the result back into the chat. UI lives in ui.js.
 * v1.2: batches of up to 6 tools all run at once on ONE VPS (terminal calls queue
 * safely on the shared shell), parallel_commands for true concurrent shell work,
 * and the series-queue auto-send fix.
 */
(() => {
  if (window.__obEngine) return;
  // v1.3: generation token. window.__obEngine used to be `true`; now each engine
  // instance stores a unique token. When the launcher revives a zombie tab it
  // injects a FRESH engine (new token) — the old zombie's timers check the token
  // and self-idle instead of double-executing tool calls alongside the new engine.
  const MY_GEN = Math.random().toString(36).slice(2);
  // v1.8 OTA: window.__obEngine is now claimed INSIDE startEngine(), so a newer
  // auto-update bundle (injected by the background via chrome.userScripts) can
  // own the page first — see bootGate() at the bottom of this file.
  const superseded = () => window.__obEngine !== MY_GEN;
  const OB_VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return '0.0.0'; } })();
  // Stamped by the background worker right before the OTA core code: marks THIS
  // copy as the auto-updated one (the bundled copy must yield to it).
  const OTA_RUNNING = typeof window.__OB_OTA_VERSION === 'string' && !!window.__OB_OTA_VERSION;
  function cmpVer(a, b) {
    const p = String(a || '').split('.').map(Number), q = String(b || '').split('.').map(Number);
    for (let i = 0; i < 3; i++) { const d = (p[i] || 0) - (q[i] || 0); if (d) return d; }
    return 0;
  }

  const UI = window.OB_UI;
  const HOST = location.hostname;
  const SITE = HOST.includes('chatgpt.com') || HOST.includes('openai.com') ? 'chatgpt'
    : HOST.includes('claude.ai') ? 'claude'
    : HOST.includes('gemini.google.com') ? 'gemini'
    : HOST.endsWith('z.ai') ? 'zai'
    : 'deepseek';
  const HOST_SEL = '#ob-root';
  const TAB_TOKEN = Math.random().toString(36).slice(2); // unique per page load (queue claim races)

  // v1.3 heartbeat: proves THIS page's scripts still belong to a LIVE extension
  // context. After the extension is updated/reloaded, old content scripts become
  // "orphaned" (every chrome.* call throws "Extension context invalidated") but
  // they keep running as plain page JS — so a ticking beat alone proves nothing.
  // The beat therefore PROBES chrome.runtime.id: a live context stores a fresh
  // timestamp, an orphaned one stores the literal string 'stale'. The background
  // reviver re-injects unless it sees a fresh timestamp.
  window.__obBeat = (function () { try { return chrome.runtime.id ? Date.now() : 'stale'; } catch (e) { return 'stale'; } })();
  const beatTimer = setInterval(() => {
    if (superseded()) { if (window.__obEngine) clearInterval(beatTimer); return; } // a fresh engine owns this page now (undefined = not claimed yet: keep beating)
    try { window.__obBeat = chrome.runtime.id ? Date.now() : 'stale'; }
    catch (e) { window.__obBeat = 'stale'; }
  }, 1500);

  const alive = () => { try { return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Registry of every long-lived timer/observer this engine starts. When a fresh
  // engine takes over the page (or the extension is reloaded) the old one tears
  // all of it down instead of idling forever (leaked intervals + observers).
  const liveTimers = new Set();
  const liveObservers = [];
  function teardown() {
    liveTimers.forEach((id) => clearInterval(id));
    liveTimers.clear();
    liveObservers.splice(0).forEach((mo) => { try { mo.disconnect(); } catch (e) { /* ignore */ } });
    try { stopKeepAlive(); } catch (e) { /* ignore */ }
    try { cancelAnimationFrame(coverState.raf); coverState.on = false; if (coverState.el) coverState.el.remove(); coverState.el = null; } catch (e) { /* ignore */ }
    try { kbRestoreIm(); } catch (e) { /* ignore */ }
  }
  function every(fn, ms) {
    const id = setInterval(() => {
      if (superseded()) { teardown(); return; }
      try {
        const r = fn();
        if (r && typeof r.catch === 'function') r.catch(() => { /* never an unhandled rejection from a poller */ });
      } catch (e) { /* a poller must never die on a site DOM surprise */ }
    }, ms);
    liveTimers.add(id);
    return id;
  }
  function observe(cb, opts) {
    const mo = new MutationObserver(() => {
      if (superseded()) { teardown(); return; }
      try { cb(); } catch (e) { /* ignore */ }
    });
    mo.observe(document.body, opts);
    liveObservers.push(mo);
    return mo;
  }

  /* ------------------------------------------------------------ storage */
  const store = {
    get(keys) {
      return new Promise((resolve) => {
        try { chrome.storage.local.get(keys, (r) => resolve(r || {})); } catch (e) { resolve({}); }
      });
    },
    set(obj) {
      return new Promise((resolve) => {
        try { chrome.storage.local.set(obj, () => resolve(true)); } catch (e) { resolve(false); }
      });
    }
  };

  let autopilot = true;
  let activeExecution = false;
  let isThinking = false;
  let awaitingResponse = false;
  let awaitingSince = 0;
  let lastDetected = null; // { toolCall, el }
  let bootUntil = Date.now() + 3500; // boot calm-down window (history is classified by turn snapshots, not by swallowing calls)
  let maxTools = 6; // v1.8: user-configurable cap of tool calls per AI message (1..12)
  let lastHref = location.pathname + location.search; // chatKey() — declared before it, same shape
  let serverOnline = false;
  let keepAliveTimer = null;
  let profilesCache = []; // [{id,name,url,token}]
  let activeVpsId = null;
  let multiVps = false;
  let chatVpsMap = {}; // chatKey -> profileId

  const clampMaxTools = (v) => Math.max(1, Math.min(12, Number(v) || 6));

  const chatKey = () => location.pathname + location.search;

  /* ----------------------------------------------------------------- DOM */
  const MD_SEL = '.ds-markdown, [class*="markdown" i]';
  // user-message markers across sites (extras are harmless where they don't exist):
  // DeepSeek: data-role / class-based; ChatGPT: data-message-author-role;
  // Claude: [data-testid="user-message"]; Gemini: .user-query wrapper.
  const USER_SEL = '[data-role="user"], [data-message-author-role="user"], [data-testid="user-message"], .user-query, [class*="user-message" i], [class*="usermessage" i], [class*="user_message" i]';
  // v1.6.1: TURN roots per site (ported from ZeroScript's provider map). Chips
  // anchor HERE — the stable node the site keeps across re-renders — never
  // inside the markdown subtree, which z.ai/ChatGPT/DeepSeek re-create at will
  // (a chip anchored there gets wiped mid-run: broken animations).
  const TURNS = {
    zai: { user: '.user-message', assistant: '.chat-assistant' },
    deepseek: { user: null, assistant: '.ds-message' }, // DS: turn root is .ds-message for BOTH; user walls are the ones WITHOUT .ds-markdown inside
    chatgpt: { user: '[data-message-author-role="user"]', assistant: '[data-message-author-role="assistant"]' },
    claude: { user: '[data-testid="user-message"]', assistant: '[data-testid="assistant-message"], .assistant-message' },
    gemini: { user: '.user-query', assistant: '.model-response, .response-container' }
  }[SITE] || {};
  // The tool-call JSON shape, used to (re)find raw call blocks by CONTENT —
  // re-created nodes carry none of our classes.
  const TOOL_SHAPE = /"tool"\s*:\s*"/i;
  const THINK_SEL = '.ds-think, [class*="think" i], details[class*="thought" i]';
  // Per-site preferred chat input (falls back to the generic picker below).
  const PREFERRED_INPUT_SEL = {
    chatgpt: '#prompt-textarea',
    claude: 'div[contenteditable="true"].ProseMirror, div[contenteditable="true"][data-placeholder]',
    gemini: 'rich-textarea div[contenteditable="true"], div[contenteditable="true"][aria-label*="prompt" i]'
  }[SITE] || '';

  const inPanel = (n) => !!(n && n.closest && n.closest(HOST_SEL));

  // --- v1.6.1 turn classification (ZeroScript pattern) -----------------------
  // The assistant TURN root: the stable ancestor whose identity survives the
  // site's stream re-renders. Falls back to the markdown container, then el.
  function assistantTurnOf(el) {
    try {
      if (!el || !el.closest) return null;
      if (TURNS.assistant) { const t = el.closest(TURNS.assistant); if (t) return t; }
      return el.closest(MD_SEL) || el;
    } catch (e) { return el || null; }
  }
  // The user TURN root that holds a sent [TOOL_RESULT] wall — the ONLY thing
  // the result sweep may collapse. Strict on purpose: decorating anything else
  // (an assistant turn, a wrapper holding many turns) hides real chat content
  // and collapses the page (the v1.6.0 scroll-jump bug).
  function userTurnOf(el) {
    try {
      if (!el || !el.closest) return null;
      if (TURNS.assistant) { const a = el.closest(TURNS.assistant); if (a && (TURNS.user ? a.matches(TURNS.user) : false)) return a; }
      if (TURNS.user) { const t = el.closest(TURNS.user); if (t) return t; }
      if (SITE === 'deepseek') {
        // DeepSeek: one .ds-message per turn for BOTH roles; assistant turns
        // render through .ds-markdown, user walls are plain — that's the split.
        const t = el.closest('.ds-message');
        if (t && !t.querySelector('.ds-markdown')) return t;
        return null;
      }
      // Generic fallback: closest USER_SEL marker (bubble-level), else a SHORT
      // bounded climb that may only ever return a bubble-sized root.
      const g = el.closest(USER_SEL);
      if (g) return g;
      let node = el, len = (el.textContent || '').length;
      for (let d = 0; d < 4; d++) {
        const p = node.parentElement;
        if (!p || p === document.body || p === document.documentElement) break;
        const pt = p.textContent || '';
        if (pt.length > len * 1.15 + 400) break; // parent holds more than this wall
        node = p; len = pt.length;
      }
      return node && node !== document.body ? node : null;
    } catch (e) { return null; }
  }

  // v1.7: is this text node inside ASSISTANT-rendered content? Per-site, because
  // the turn models differ. This is the check whose v1.6.1 form BROKE DeepSeek
  // entirely: there, TURNS.user is null and EVERY turn (user walls included)
  // lives in a .ds-message, so "inside assistant turn" was true for the user's
  // own result wall too — the sweep rejected everything and NO chip ever fired
  // (the "animations don't show up" bug). DeepSeek's real split is .ds-markdown:
  // only assistant replies render through it; user walls are plain text.
  function isAssistantText(p) {
    try {
      if (SITE === 'deepseek') return !!p.closest('.ds-markdown');
      if (TURNS.assistant) {
        const a = p.closest(TURNS.assistant);
        return !!(a && !(TURNS.user && p.closest(TURNS.user)));
      }
      return false;
    } catch (e) { return false; }
  }

  function getChatInput() {
    if (PREFERRED_INPUT_SEL) {
      const pref = Array.from(document.querySelectorAll(PREFERRED_INPUT_SEL)).find((n) => !inPanel(n) && n.offsetParent !== null);
      if (pref) return pref;
    }
    const list = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).filter((n) => !inPanel(n) && n.offsetParent !== null);
    return list.find((n) => /message|ask|deepseek|send|chat|help|prompt/i.test(n.getAttribute('placeholder') || n.getAttribute('data-placeholder') || n.getAttribute('aria-label') || '')) || list[list.length - 1] || null;
  }

  /**
   * Keyboard-free typing (v1.1). The old path focused the chat box first, which
   * popped the on-screen keyboard on Lemur/Android every time the agent pasted a
   * result. Now: write the DOM + fire input events WITHOUT focus; only fall back
   * to the focus+execCommand path if the site's editor did not accept the write,
   * and blur immediately afterwards so the keyboard closes again.
   */
  function setChatInputValue(text) {
    const input = getChatInput();
    if (!input) return false;
    const isNative = input.tagName === 'TEXTAREA' || input.tagName === 'INPUT';
    let ok = false;
    try {
      if (isNative) {
        const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
        const tracker = input._valueTracker;
        if (tracker) tracker.setValue('');
        if (setter) setter.call(input, text); else input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        ok = input.value === text;
      } else {
        // contenteditable (DeepSeek / ChatGPT / Claude / Gemini): direct DOM write.
        try { input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertReplacementText', data: text })); } catch (e) { /* optional */ }
        const usesBlocks = !!input.querySelector('p, div');
        input.textContent = '';
        if (usesBlocks) {
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const block = document.createElement('p');
            if (lines[i]) block.textContent = lines[i];
            else block.appendChild(document.createElement('br')); // empty line: an empty <p> collapses and the blank line is lost
            input.appendChild(block);
          }
        } else {
          input.textContent = text;
        }
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        ok = (input.innerText || '').replace(/\u200b/g, '').trim() === text.trim();
      }
    } catch (e) { ok = false; }

    if (!ok) {
      // Fallback: the v1.0 focus path (may raise the keyboard), then blur fast.
      try {
        input.focus({ preventScroll: true });
        if (isNative) input.select();
        else {
          const range = document.createRange();
          range.selectNodeContents(input);
          const sel = window.getSelection();
          sel.removeAllRanges(); sel.addRange(range);
        }
        document.execCommand('insertText', false, text);
      } catch (e2) { /* last resort below */ }
      const cur = input.value !== undefined ? input.value : input.innerText;
      if (!cur || cur.trim().length < Math.min(text.trim().length, 20)) {
        if (isNative) {
          const tracker2 = input._valueTracker;
          if (tracker2) tracker2.setValue('');
          const setter2 = Object.getOwnPropertyDescriptor((isNative && input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement).prototype, 'value')?.set;
          if (setter2) setter2.call(input, text); else input.value = text;
        } else {
          input.innerText = text;
        }
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      try { kbBlurBurst(); } catch (e3) { /* ignore */ }
    }
    return true;
  }

  function getSendButton() {
    const input = getChatInput();
    const bad = /file|attach|upload|image|photo|search|think|deep|voice|mic|附件|上传/i;
    // ChatGPT/Gemini expose stable test ids — try those first.
    const stable = document.querySelector('[data-testid="send-button"], button[aria-label*="Send" i], div[role="button"][aria-label*="Send" i], button[aria-label*="发送"], button[type="submit"]');
    if (stable && !inPanel(stable) && !bad.test(stable.getAttribute('aria-label') || '')) return stable;
    if (input) {
      let parent = input.parentElement;
      for (let i = 0; i < 7 && parent; i++) {
        const btns = Array.from(parent.querySelectorAll('button, div[role="button"]')).filter((b) => {
          if (inPanel(b)) return false;
          if (b.querySelector('input[type="file"]') || b.parentElement?.querySelector('input[type="file"]')) return false;
          const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
          return !bad.test(label);
        });
        for (let j = btns.length - 1; j >= 0; j--) {
          const b = btns[j];
          const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
          if (/send|发送|submit/.test(label) || b.querySelector('svg')) return b;
        }
        parent = parent.parentElement;
      }
    }
    return stable;
  }

  async function clickSend() {
    for (let i = 0; i < 40; i++) {
      const b = getSendButton();
      const disabled = b ? (b.disabled || b.getAttribute('aria-disabled') === 'true' || b.classList.contains('disabled')) : true;
      if (b && !disabled) {
        b.click();
        // Sites refocus the composer on their own right after a submit; a single
        // blur loses that race, so run the blur burst (keyboard guard).
        try { kbHold(); kbBlurBurst(); } catch (e) { /* ignore */ }
        return true;
      }
      await sleep(40);
    }
    const input = getChatInput();
    if (input) {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
      input.dispatchEvent(new KeyboardEvent('keydown', opts));
      input.dispatchEvent(new KeyboardEvent('keyup', opts));
      return true;
    }
    return false;
  }

  /* ================= v1.6: faithful ZeroScript port. The cover hides the raw
     text we type into the chat box (an opaque overlay matched to the composer's
     real blended colour), every tool run drops a LIVE chip onto the AI message
     (spinner + seamless shimmer while running, tick/cross + duration after),
     each sent [TOOL_RESULT] wall collapses into an expandable result card, and
     every send is VERIFIED (composer emptied) with automatic retries. Chip DOM
     rebuilds are signature-deduped so spinners never stutter, and anything the
     site wipes gets re-applied by the sweep. === */

  const COVER_Z = 2147483500;
  const coverState = { el: null, raf: 0, on: false, shownAt: 0, minMs: 450, offTimer: 0, bg: '', bgAt: 0, maxMs: 120000 };

  /* ================= v1.9 KEYBOARD GUARD. The on-screen keyboard used to pop up
     every time OrbitBridge typed a tool result into the chat and sent it. The
     old fix (one blur right after the click) lost the race: chat sites focus
     their composer themselves, asynchronously, after a submit (and again when
     a reply finishes streaming), and Android raises the keyboard on that focus.
     Three layers now stop it:
       1. inputmode="none" on the composer while we automate it — a focused
          editor with inputmode none never raises the keyboard;
       2. a capture-phase focusin guard that immediately blurs any focus the
          USER did not cause (no trusted tap/key on the composer just before);
       3. a blur burst after every send that out-lasts the site's own refocus.
     A real tap on the composer lifts the guard at once, so typing yourself
     still works normally. === */
  const KB_TAIL_MS = 4000;
  const kb = { until: 0, im: undefined, el: null, lastGesture: 0, timer: 0, wired: false };

  const kbIsEditable = (n) => !!(n && (n.tagName === 'TEXTAREA' || n.tagName === 'INPUT' || n.isContentEditable));
  // Guard is up while an automated send runs, for a tail after it, and for as
  // long as we are waiting for the AI's reply (the site refocuses when it ends).
  const kbActive = () => Date.now() < kb.until || coverState.on || awaitingResponse;

  // Did a (real) touch/click/key land on the composer or its box?
  function kbNearComposer(t) {
    try {
      const ed = getChatInput();
      if (!ed || !t || !t.nodeType) return false;
      const node = t.nodeType === 1 ? t : t.parentElement;
      if (!node || inPanel(node)) return false;
      if (ed === node || ed.contains(node)) return true;
      let box = ed.parentElement;
      for (let i = 0; i < 4 && box && box !== document.body; i++) {
        if (box.contains(node)) return true;
        box = box.parentElement;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function kbRestoreIm() {
    const el = kb.el;
    kb.el = null;
    if (!el) return;
    try {
      if (kb.im === null || kb.im === undefined) el.removeAttribute('inputmode');
      else el.setAttribute('inputmode', kb.im);
    } catch (e) { /* ignore */ }
    kb.im = undefined;
  }

  function kbTick() {
    clearTimeout(kb.timer);
    if (superseded()) { kbRestoreIm(); return; }
    if (kbActive()) { kb.timer = setTimeout(kbTick, 300); return; }
    kbRestoreIm();
  }

  // Blur whatever editable element is focused (except our own panel) — repeated
  // over ~1.2s so it outlasts the site's own post-send refocus.
  function kbBlurBurst() {
    const run = () => {
      try {
        if (Date.now() - kb.lastGesture < 1500) return; // the user just tapped the composer: leave it alone
        const a = document.activeElement;
        if (a && a !== document.body && !inPanel(a) && kbIsEditable(a) && a.blur) a.blur();
      } catch (e) { /* ignore */ }
    };
    run();
    for (const d of [0, 50, 140, 300, 600, 1000, 1500]) setTimeout(run, d);
  }

  function kbWire() {
    if (kb.wired) return;
    kb.wired = true;
    const onGesture = (e) => {
      if (superseded() || !e.isTrusted) return;
      if (kbNearComposer(e.target)) {
        kb.lastGesture = Date.now();
        // the user is about to type: lift the guard BEFORE the browser focuses
        kb.until = 0;
        kbRestoreIm();
      }
    };
    for (const t of ['pointerdown', 'touchstart', 'mousedown', 'keydown']) {
      document.addEventListener(t, onGesture, { capture: true, passive: true });
    }
    document.addEventListener('focusin', (e) => {
      if (superseded() || !kbActive()) return;
      const t = e.target;
      if (!t || inPanel(t) || !kbIsEditable(t)) return;
      if (Date.now() - kb.lastGesture < 1500) return; // user-caused focus
      kbBlurBurst();
    }, true);
  }

  // Raise the guard for `ms` (default tail) and mute the composer's keyboard.
  function kbHold(ms) {
    try {
      kb.until = Math.max(kb.until, Date.now() + (ms || KB_TAIL_MS));
      kbWire();
      const ed = getChatInput();
      if (ed) {
        if (kb.el && kb.el !== ed) kbRestoreIm(); // the SPA swapped the editor
        if (!kb.el) {
          kb.el = ed;
          kb.im = ed.hasAttribute('inputmode') ? ed.getAttribute('inputmode') : null;
        }
        if (ed.getAttribute('inputmode') !== 'none') ed.setAttribute('inputmode', 'none');
      }
      clearTimeout(kb.timer);
      kb.timer = setTimeout(kbTick, 300);
    } catch (e) { /* never block a send on the guard */ }
  }

  function ensurePageStyles() {
    if (document.getElementById('ob-page-styles')) return;
    const st = document.createElement('style');
    st.id = 'ob-page-styles';
    st.textContent = [
      '#ob-input-cover{position:fixed;z-index:' + COVER_Z + ';display:none;align-items:center;gap:8px;padding-left:16px;',
      'border-radius:14px;color:rgba(140,140,152,.92);font:400 12px/1.3 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;',
      'white-space:nowrap;overflow:hidden;pointer-events:auto;cursor:default;',
      'opacity:0;transition:opacity .18s ease}',
      '#ob-input-cover.on{opacity:1}',
      '.obcv-spin{width:12px;height:12px;flex:none;display:inline-block;border:2px solid rgba(150,150,162,.3);border-top-color:rgba(200,200,206,.95);border-radius:50%;animation:obrot .7s linear infinite}',
      '@keyframes obrot{to{transform:rotate(360deg)}}',
      'textarea.ob-typing,div[contenteditable].ob-typing,div[contenteditable].ob-typing *{color:transparent!important}',
      'textarea.ob-typing,div[contenteditable].ob-typing{caret-color:transparent!important}',
      'textarea.ob-typing,div[contenteditable].ob-typing{max-height:140px!important;overflow-y:hidden!important}',
      /* chips: ZeroScript overlay.css ported near-verbatim (renamed ob-) */
      '.ob-chip{--cat:#8b8b93;display:block;width:fit-content;max-width:100%;align-self:flex-start;',
      'margin:5px 0;padding:0;font-size:13px;font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;',
      'border-radius:9px;line-height:1.3;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.09);',
      'color:#d7d7dc;overflow:hidden;transition:background .18s ease,border-color .18s ease;user-select:none}',
      '.ob-chip:hover{background:rgba(255,255,255,.06)}',
      '.ob-chip-head{display:flex;align-items:center;gap:9px;padding:8px 13px}',
      '.ob-chip-ic{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:var(--cat)}',
      '.ob-chip-ic svg{width:16px;height:16px}',
      '.ob-chip-tx{font-weight:600;letter-spacing:.1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ob-chip-dt{opacity:.6;font-size:11px;margin-left:2px;flex:1;font-family:ui-monospace,"Cascadia Code",Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ob-chip-dt:empty{display:none}',
      '.ob-chip-cv{display:inline-flex;flex:none;opacity:.45;transition:transform .2s ease}',
      '.ob-chip-cv svg{width:15px;height:15px}',
      '.ob-chip.open .ob-chip-cv{transform:rotate(180deg)}',
      '.ob-chip-body{max-height:0;overflow:hidden;transition:max-height .22s ease;border-top:1px solid transparent}',
      '.ob-chip.open .ob-chip-body{max-height:460px;overflow:auto;border-top-color:rgba(139,139,147,.22)}',
      '.ob-chip-body pre{margin:0;padding:10px 13px;font-family:ui-monospace,"Cascadia Code",Menlo,Consolas,monospace;font-size:12px;line-height:1.5;color:#cdd2e0;white-space:pre-wrap;word-break:break-word;user-select:text}',
      '.ob-chip.done{--cat:#5cbf9a}',
      '.ob-chip.err{--cat:#ef6b6b;border-color:rgba(239,68,68,.38);color:#f0b8b8}',
      '.ob-chip.result,.ob-chip.sys{--cat:#8b8b93;color:#a8a8b0}',
      '.ob-chip.run{background-color:rgba(255,255,255,.05);',
      'background-image:linear-gradient(90deg,transparent 0%,rgba(255,255,255,.09) 50%,transparent 100%);',
      'background-repeat:repeat;background-size:210px 100%;animation:ob-shimmer 1.6s linear infinite}',
      '@keyframes ob-shimmer{from{background-position:0 0}to{background-position:210px 0}}',
      '.ob-hidden>*:not(.ob-chip){display:none!important}',
      '.ob-tool-hide{display:none!important}',
      'html.ob-light .ob-chip{background:rgba(0,0,0,.035);border-color:rgba(0,0,0,.1);color:#3a3a42}',
      'html.ob-light .ob-chip:hover{background:rgba(0,0,0,.06)}',
      'html.ob-light .ob-chip.err{border-color:rgba(220,38,38,.4);color:#8f2323}',
      'html.ob-light .ob-chip.result,html.ob-light .ob-chip.sys{color:#6b6b74}',
      'html.ob-light .ob-chip-body pre{color:#41474f}',
      'html.ob-light .ob-chip.run{background-color:rgba(0,0,0,.04);background-image:linear-gradient(90deg,transparent 0%,rgba(0,0,0,.06) 50%,transparent 100%)}',
      /* v1.6.1 zero-flash masks (ZeroScript pattern): the site re-creates code
         wrappers on stream updates / next send, wiping per-element hide classes.
         The TURN root keeps its identity, so these structural rules re-hide the
         recreated wrappers instantly. Inert on sites without the shapes. */
      '.chat-assistant.ob-cmd-mask div[class*="rounded-xl"]:has(.copy-code-button){display:none!important}',
      '[data-message-author-role="assistant"].ob-cmd-mask pre{display:none!important}',
      '.ds-message.ob-cmd-mask .ds-markdown pre{display:none!important}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  // --- opaque background: flatten translucent ancestors into one solid colour
  // (ported from ZeroScript) so the cover perfectly matches the composer.
  function parseColor(c) {
    if (!c || c === 'transparent') return null;
    const m = c.match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 ? p[3] : 1 };
  }
  function blendOver(fg, bg) {
    const a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  function opaqueBg(el) {
    const layers = [];
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
      n = n.parentElement;
    }
    if (!layers.length || layers[layers.length - 1].a < 0.999) {
      const base = parseColor(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
      layers.push({ r: base.r, g: base.g, b: base.b, a: 1 });
    }
    let out = layers[layers.length - 1];
    for (let i = layers.length - 2; i >= 0; i--) out = blendOver(layers[i], out);
    return `rgb(${Math.round(out.r)}, ${Math.round(out.g)}, ${Math.round(out.b)})`;
  }

  function coverPlace() {
    if (!coverState.on || !coverState.el) return;
    // Watchdog: a send path that threw / hung must never leave the composer covered.
    if (superseded() || Date.now() - coverState.shownAt > coverState.maxMs) { coverOff(true); return; }
    const ed = getChatInput();
    if (!ed) { coverState.raf = requestAnimationFrame(coverPlace); return; }
    if (!ed.classList.contains('ob-typing')) ed.classList.add('ob-typing'); // editors get recreated by SPAs
    let r = ed.getBoundingClientRect();
    // clip to the nearest scrolling/hidden ancestors so a ballooning editor can
    // never drag the cover off the visible composer band
    let clipY = false, clipX = false;
    for (let a = ed.parentElement, i = 0; a && a !== document.body && i < 8 && !(clipX && clipY); a = a.parentElement, i++) {
      const s = getComputedStyle(a);
      const clips = (v) => v === 'auto' || v === 'scroll' || v === 'hidden';
      const ar = a.getBoundingClientRect();
      if (!clipY && clips(s.overflowY)) { clipY = true; const t = Math.max(r.top, ar.top), b = Math.min(r.bottom, ar.bottom); if (b > t) r = new DOMRect(r.left, t, r.width, b - t); }
      if (!clipX && clips(s.overflowX)) { clipX = true; const l = Math.max(r.left, ar.left), rr = Math.min(r.right, ar.right); if (rr > l) r = new DOMRect(l, r.top, rr - l, r.height); }
    }
    const h = Math.min(Math.max(r.height, 36), 200);
    const cy = r.top + r.height / 2;
    coverState.el.style.left = r.left + 'px';
    coverState.el.style.top = (cy - h / 2) + 'px';
    coverState.el.style.width = r.width + 'px';
    coverState.el.style.height = h + 'px';
    // the blended colour only changes on theme flips: re-probe twice a second, not every frame
    const nowMs = Date.now();
    if (!coverState.bg || nowMs - coverState.bgAt > 500) { coverState.bg = opaqueBg(ed); coverState.bgAt = nowMs; }
    if (coverState.el.style.background !== coverState.bg) coverState.el.style.background = coverState.bg;
    coverState.raf = requestAnimationFrame(coverPlace);
  }

  function coverOn(label) {
    try {
      ensurePageStyles();
      const ed = getChatInput();
      if (!ed) return;
      ed.classList.add('ob-typing');
      if (!coverState.el) {
        const d = document.createElement('div');
        d.id = 'ob-input-cover';
        d.innerHTML = '<span class="obcv-spin"></span><span class="obcv-tx">OrbitBridge is working…</span>';
        document.documentElement.appendChild(d);
        coverState.el = d;
      }
      if (label) coverState.el.querySelector('.obcv-tx').textContent = label;
      clearTimeout(coverState.offTimer); // a pending hide from the previous send must not kill this cover
      coverState.on = true; coverState.shownAt = Date.now(); coverState.bg = '';
      coverState.el.style.display = 'flex';
      requestAnimationFrame(() => { if (coverState.el) coverState.el.classList.add('on'); });
      cancelAnimationFrame(coverState.raf);
      coverState.raf = requestAnimationFrame(coverPlace);
    } catch (e) { /* never block a send on cosmetics */ }
  }

  function coverOff(now) {
    if (!coverState.on) return;
    coverState.on = false;
    cancelAnimationFrame(coverState.raf);
    const wait = now ? 0 : Math.max(0, coverState.minMs - (Date.now() - coverState.shownAt));
    clearTimeout(coverState.offTimer);
    coverState.offTimer = setTimeout(() => {
      if (coverState.on) return; // a newer coverOn took over
      try {
        if (coverState.el) { coverState.el.classList.remove('on'); coverState.el.style.display = 'none'; }
        const ed = getChatInput();
        if (ed) ed.classList.remove('ob-typing');
      } catch (e) { /* ignore */ }
    }, wait);
  }

  // After clicking send, confirm the message actually left: the composer must
  // be empty (or a rate-limit toast took over). If the site swallowed the
  // click, the caller retries automatically.
  async function verifySent(text) {
    for (let i = 0; i < 16; i++) {
      await sleep(180);
      if (detectRateLimit()) return 'rate';
      const ed = getChatInput();
      if (!ed) return 'sent'; // page navigated away — treat as delivered
      const cur = (ed.value !== undefined && typeof ed.value === 'string') ? ed.value : (ed.innerText || '');
      if (!cur || cur.replace(/\u200b/g, '').trim().length < Math.min(text.trim().length, 40)) return 'sent';
    }
    return 'stuck';
  }

  // One primitive for EVERY automated send: cover the composer, type, click,
  // verify, retry up to 3 times. Sets the awaiting-response bookkeeping.
  // Every automated send (tool results, queue, quick-send, resume, rate-limit
  // resend) goes through ONE lane: two concurrent sends would both write the
  // same composer and the second would clobber (or double-send) the first.
  let sendLane = Promise.resolve();
  function typeAndSend(text, opts) {
    const run = sendLane.then(() => typeAndSendNow(text, opts || {}));
    sendLane = run.catch(() => false);
    return run;
  }

  async function typeAndSendNow(text, opts = {}) {
    try {
      return await typeAndSendInner(text, opts);
    } catch (e) {
      coverOff(); // an exception mid-send must never leave the composer covered
      return false;
    }
  }

  async function typeAndSendInner(text, opts = {}) {
    const maxTry = opts.retries === undefined ? 3 : opts.retries;
    kbHold(); // keyboard guard up BEFORE we touch the composer
    for (let attempt = 1; attempt <= maxTry; attempt++) {
      kbHold();
      coverOn(attempt === 1 ? (opts.label || 'OrbitBridge is working…') : `Retrying send (${attempt}/${maxTry})…`);
      const ok = setChatInputValue(text);
      if (!ok) { coverOff(); return false; }
      await sleep(80);
      await clickSend();
      lastSubmit = Date.now();
      const v = await verifySent(text);
      if (v === 'rate') { coverOff(); awaitingResponse = true; awaitingSince = Date.now(); return true; }
      if (v === 'sent') {
        awaitingResponse = true; awaitingSince = Date.now();
        try { armPendingChip(text, opts.chip); } catch (e) { /* cosmetic */ }
        try { scheduleChipSweep(); } catch (e) { /* ignore */ }
        coverOff();
        kbHold(); kbBlurBurst(); // keep guarding while the AI replies
        return true;
      }
      // 'stuck': the site never accepted the message — loop and retry
    }
    coverOff();
    UI.setActivity('The chat did not accept the message. Paused.', 'error', false);
    UI.setStatus('offline', 'Send failed');
    return false;
  }

  // --- v1.6 chips: faithful port of ZeroScript's tool-card system. A LIVE run
  // chip is pinned onto the AI message that issued the calls (spinner + seamless
  // 210px shimmer while the VPS works, tick/cross + wall time after, raw call
  // expandable inside), and each sent [TOOL_RESULT] wall collapses into an
  // expandable result card. ZeroScript's signature-dedup trick is ported too:
  // the card's DOM is rebuilt ONLY when its content changes, so re-running the
  // sweep never restarts the spinner/shimmer animation mid-flight.
  const CHIP_MARK = '[TOOL_RESULT: ';
  const chipSwept = new WeakMap(); // bubble root -> decorated at least once
  let chipPending = false;
  let pendingChip = null; // armed right after we send a result: { info, fingerprint, at }
  let runChip = null, runHost = null, runStartedAt = 0, runRaw = '', runOpts = null;
  const settledChips = []; // v1.6.1: { host, opts } — settled run chips the sweep keeps alive

  const OBSVG = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const OBICONS = {
    tool: OBSVG('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z"/>'),
    result: OBSVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    check: OBSVG('<polyline points="20 6 9 17 4 12"/>'),
    error: OBSVG('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>')
  };
  function obIcon(phase) {
    if (phase === 'run') return '<span class="obcv-spin"></span>';
    if (phase === 'err') return OBICONS.error;
    if (phase === 'done') return OBICONS.check;
    if (phase === 'result') return OBICONS.result;
    return OBICONS.tool;
  }

  // ZeroScript chip(): rebuild only when the signature changes — recreating the
  // spinner span on every pass restarts its CSS animation and reads as a frozen
  // spinner. Re-anchor + masking still run every pass.
  function buildChip(host, opts) {
    const { label, detail = '', body = '', phase, cls } = opts;
    const hasBody = !!body;
    let chip = host.querySelector(':scope > .ob-chip');
    const sig = [phase, cls || '', label, detail, hasBody ? body.length : 0].join('|');
    if (!chip) chip = document.createElement('div');
    if (chip.dataset.obSig !== sig) {
      const wasOpen = chip.classList.contains('open'); // v1.6.1: keep the user's expanded state across rebuilds
      chip.dataset.obSig = sig;
      chip.className = ('ob-chip ' + (cls || '')).trim();
      chip.innerHTML =
        '<div class="ob-chip-head">' +
          '<span class="ob-chip-ic">' + obIcon(phase) + '</span>' +
          '<span class="ob-chip-tx"></span>' +
          '<span class="ob-chip-dt"></span>' +
          (hasBody ? '<span class="ob-chip-cv">' + OBSVG('<polyline points="6 9 12 15 18 9"/>') + '</span>' : '') +
        '</div>' +
        (hasBody ? '<div class="ob-chip-body"><pre></pre></div>' : '');
      chip.querySelector('.ob-chip-tx').textContent = label;
      if (detail) chip.querySelector('.ob-chip-dt').textContent = detail;
      if (hasBody) {
        chip.querySelector('.ob-chip-body pre').textContent = body;
        const head = chip.querySelector('.ob-chip-head');
        head.style.cursor = 'pointer';
        head.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); chip.classList.toggle('open'); });
      }
      if (wasOpen) chip.classList.add('open');
    }
    if (chip.parentElement !== host || host.firstElementChild !== chip) host.insertBefore(chip, host.firstChild);
    return chip;
  }

  // Label/detail for a result, parsed from the text. Brackets are OPTIONAL:
  // sites mangle/linkify "[TOOL_RESULT: x]" in wild ways, the words survive.
  function parseChipInfo(text) {
    try {
      const raw = (text || '').replace(/\u200b/g, '');
      const names = [];
      const stats = [];
      let m;
      const nameRe = /TOOL_RESULT:?\s*([a-zA-Z_][a-zA-Z_0-9]*)/g;
      while ((m = nameRe.exec(raw))) names.push(m[1]);
      const statRe = /Status:\s*(SUCCESS|FAILED|ERROR|TIMEOUT|AWAITING_INPUT)/g;
      while ((m = statRe.exec(raw))) stats.push(m[1]);
      if (!names.length && !stats.length) return null;
      const bad = stats.filter((s) => s !== 'SUCCESS' && s !== 'AWAITING_INPUT').length;
      const label = names.length ? names[0] + (names.length > 1 ? ' +' + (names.length - 1) : '') : 'tool result';
      const detail = stats.length ? (bad ? bad + '/' + stats.length + ' failed' : stats[0].toLowerCase()) : '';
      return { label, detail, cls: bad ? 'err' : 'done' };
    } catch (e) { return null; }
  }

  // Remember what we just sent so the sweep can find the bubble even when the
  // site ate the [TOOL_RESULT] header: match on a whitespace-free fingerprint
  // of the result BODY (always rendered verbatim) instead of the header.
  function armPendingChip(text, info) {
    if (!text || !text.includes(CHIP_MARK)) { pendingChip = null; return; }
    const nl = text.indexOf('\n');
    const body = nl > -1 ? text.slice(nl + 1) : text;
    pendingChip = {
      info: info || parseChipInfo(text) || { label: 'tool result', detail: '', cls: 'result' },
      fingerprint: body.replace(/\s+/g, '').slice(0, 40),
      at: Date.now()
    };
  }

  function takePendingChip(rootText) {
    if (!pendingChip) return null;
    if (Date.now() - pendingChip.at > 120000) { pendingChip = null; return null; }
    const norm = (rootText || '').replace(/\s+/g, '');
    if (!pendingChip.fingerprint || !norm.includes(pendingChip.fingerprint)) return null;
    const info = pendingChip.info;
    pendingChip = null;
    return info;
  }

  function chipResultBubble(startEl) {
    try {
      if (!startEl) return;
    // v1.7: resolve the root FIRST, then read the wall from it. DeepSeek mobile
    // splits one result wall across several paragraph nodes — decorating from a
    // single text node only captured the first fragment and hid the rest.
    const root = userTurnOf(startEl);
    if (!root || root === document.body) return;
    const raw = (root.textContent || '').replace(/\u200b/g, '');
    if (!raw.includes('TOOL_RESULT')) return; // our marker REQUIRED (brackets optional — sites mangle them)
    const info = takePendingChip(raw) || parseChipInfo(raw);
    if (!info) return;
    // v1.6.1 (the scroll-jump fix): the ONLY root we may collapse is the user
    // turn that holds this wall — bubble-sized, verified. Collapsing anything
    // bigger (a wrapper with several turns, or the AI's reply quoting the
    // result) hid real chat content and made the page jump.
    const hBefore = document.documentElement.scrollHeight;
    root.classList.add('ob-hidden');
    // v1.7: collapsing shrinks the page; if this wall sat at/above the viewport
    // (or the user is pinned to the bottom), compensate so the chat does not
    // appear to "scroll up" when the wall folds into a chip.
    const r = root.getBoundingClientRect();
    const hAfter = document.documentElement.scrollHeight;
    const delta = hBefore - hAfter;
    if (delta > 0 && r.top < window.innerHeight) { try { window.scrollBy(0, -delta); } catch (e) { /* ignore */ } }
    buildChip(root, {
      label: info.label, detail: info.detail,
      body: raw.length > 4000 ? raw.slice(0, 4000) + '\n…[truncated]' : raw,
      phase: info.cls === 'err' ? 'err' : 'done', cls: info.cls
    });
    chipSwept.set(root, true);
    } catch (e) { /* cosmetic only */ }
  }

  // Live "running" chip pinned onto the AI message that issued the calls.
  // The raw call blocks are hidden (.ob-tool-hide + .ob-cmd-mask) but stay
  // expandable inside the chip — the AI's own prose is never touched.
  // v1.6.1: the chip anchors on the TURN root (stable across the site's stream
  // re-renders), not inside the markdown subtree that z.ai/ChatGPT re-create on
  // every token — that wipe was what broke the animation mid-run.
  function hideToolBlocks(host, els) {
    try {
      let hid = false;
      (els || []).forEach((e2) => {
        try {
          if (!e2 || inPanel(e2)) return;
          const block = e2.closest('pre, [class*="code-block" i]') || (e2.matches && e2.matches('pre, code') ? e2 : null);
          if (block && !block.closest('.ob-chip')) { block.classList.add('ob-tool-hide'); hid = true; }
        } catch (err) { /* cosmetic */ }
      });
      // Content re-scan: re-created nodes carry none of our classes, so find
      // raw call blocks by their JSON shape instead (ZeroScript GLM pattern).
      if (host) {
        host.querySelectorAll('pre, [class*="code-block" i]').forEach((b) => {
          try {
            if (b.closest('.ob-chip') || b.closest(THINK_SEL) || inPanel(b)) return;
            if (b.classList.contains('ob-tool-hide')) { hid = true; return; }
            if (TOOL_SHAPE.test(b.textContent || '')) { b.classList.add('ob-tool-hide'); hid = true; }
          } catch (err) { /* cosmetic */ }
        });
      }
      return hid;
    } catch (e) { return false; }
  }

  function startRunChip(calls, els) {
    try {
      ensurePageStyles();
      const el = els && els[0];
      const host = el ? assistantTurnOf(el) : null;
      if (!host) return;
      runHost = host;
      runStartedAt = Date.now();
      runRaw = calls.map((c) => JSON.stringify({ tool: c.tool, params: c.params || {} }, null, 1)).join('\n\n');
      runOpts = {
        label: calls.length > 1 ? calls.length + ' tools in parallel' : calls[0].tool,
        detail: 'running…',
        body: runRaw,
        phase: 'run',
        cls: 'run'
      };
      if (hideToolBlocks(host, els)) host.classList.add('ob-cmd-mask'); // zero-flash re-hide of re-created wrappers
      runChip = buildChip(host, runOpts);
    } catch (e) { runChip = null; runHost = null; runOpts = null; }
  }

  // v1.8.2: live elapsed time on the running chip ("running… 12s"). Touches ONLY the
  // detail text — never rebuilds the chip — so the spinner/shimmer is not restarted.
  function tickRunChip() {
    try {
      if (!runHost || !runOpts || !runHost.isConnected) return;
      const chip = runHost.querySelector(':scope > .ob-chip.run');
      if (!chip) return;
      const secs = Math.floor((Date.now() - runStartedAt) / 1000);
      const txt = secs >= 2 ? 'running… ' + secs + 's' : 'running…';
      runOpts.detail = txt;
      const dt = chip.querySelector('.ob-chip-dt');
      if (dt && dt.textContent !== txt) dt.textContent = txt;
    } catch (e) { /* cosmetic */ }
  }

  function endRunChip(pairs) {
    try {
      if (runHost && runHost.isConnected) {
        const dur = ((Date.now() - runStartedAt) / 1000).toFixed(1);
        const bad = pairs.filter((p) => !p.res || !p.res.success || (p.res.result && p.res.result.timedOut)).length;
        const opts = {
          label: pairs.length > 1 ? pairs.length + ' tools in parallel' : ((pairs[0].call && pairs[0].call.tool) || 'tool'),
          detail: (bad ? 'failed in ' : 'done in ') + dur + 's',
          body: runRaw,
          phase: bad ? 'err' : 'done',
          cls: bad ? 'err' : 'done'
        };
        if (runChip || runHost.querySelector(':scope > .ob-chip')) buildChip(runHost, opts);
        // v1.6.1: remember the settled chip so the sweep can re-apply it when a
        // site re-render wipes it later (ZeroScript's ensureOwnedChip pattern).
        settledChips.push({ host: runHost, opts });
        if (settledChips.length > 12) settledChips.shift();
      }
    } catch (e) { /* cosmetic */ }
    runChip = null; runHost = null; runRaw = ''; runOpts = null;
  }

  // Chip label/detail computed from the ACTUAL execution results (names,
  // statuses, durations are known in JS — never trust the site's rendering).
  function chipInfoFromPairs(pairs) {
    try {
      const items = pairs.map((p) => {
        const r = p.res || {};
        const st = !r.success ? 'ERROR' : (r.result && r.result.timedOut ? 'TIMEOUT' : 'SUCCESS');
        return { name: (p.call && p.call.tool) || 'tool', st, dur: r.durationMs };
      });
      const bad = items.filter((x) => x.st === 'ERROR' || x.st === 'TIMEOUT').length;
      if (items.length === 1) {
        return {
          label: items[0].name,
          detail: items[0].st.toLowerCase() + (items[0].dur != null ? ' in ' + (items[0].dur / 1000).toFixed(1) + 's' : ''),
          cls: bad ? 'err' : 'done'
        };
      }
      return {
        label: items.length + ' tools in parallel',
        detail: (items.length - bad) + '/' + items.length + ' ok',
        cls: bad ? 'err' : 'done'
      };
    } catch (e) { return null; }
  }

  function sweepChipsFrom(rootEl) {
    try {
      if (!rootEl || rootEl.nodeType !== 1) return;
      const fp = pendingChip ? pendingChip.fingerprint : null;
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          const t = n.textContent || '';
          if (!t.includes(CHIP_MARK) && !(fp && t.replace(/\s+/g, '').includes(fp))) return NodeFilter.FILTER_REJECT;
          const p = n.parentElement;
          if (!p || p.closest('[contenteditable="true"], textarea') || inPanel(p)) return NodeFilter.FILTER_REJECT;
          // v1.6.1 (the runaway fix): NEVER re-process our own chips — their
          // body holds the same [TOOL_RESULT] text, so without this the sweep
          // fed itself every tick and re-decorated ever-bigger parents.
          if (p.closest('.ob-chip')) return NodeFilter.FILTER_REJECT;
          // v1.7: never decorate ASSISTANT-rendered content (the AI quoting our
          // result format must not get its reply hidden behind a chip). Per-site
          // — see isAssistantText; the v1.6.1 blanket form rejected EVERYTHING
          // on DeepSeek and killed the chips there.
          if (isAssistantText(p)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const roots = [];
      let n, guard = 0;
      while ((n = walker.nextNode()) && guard < 12) {
        guard++;
        if (!roots.includes(n.parentElement)) roots.push(n.parentElement);
      }
      for (const r of roots) {
        const done = userTurnOf(r); // bubble-verify + dedupe by final root
        if (done && chipSwept.has(done) && done.querySelector(':scope > .ob-chip')) continue;
        chipResultBubble(r);
      }
    } catch (e) { /* cosmetic only */ }
  }

  function scheduleChipSweep() {
    chipPending = true;
  }

  // Site themes flip (DeepSeek light/dark) — re-probe on every sweep tick and
  // keep the chip palette on the right side of the contrast.
  function applyChipTheme() {
    try {
      const c = parseColor(getComputedStyle(document.body).backgroundColor) ||
                parseColor(getComputedStyle(document.documentElement).backgroundColor);
      const light = !!c && c.a > 0.5 && (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255 > 0.6;
      document.documentElement.classList.toggle('ob-light', light);
    } catch (e) { /* keep current */ }
  }

  function startChipSystem() {
    try {
      ensurePageStyles();
      applyChipTheme();
      // characterData too: some sites stream the result wall INTO an existing
      // text node (no childList mutation) — without this the sweep would sleep.
      observe(() => { chipPending = true; }, { childList: true, subtree: true, characterData: true });
      every(() => {
        if (document.hidden) return; // v1.6.1: no work in background tabs
        ensurePageStyles(); // a site (or SPA nav) may have dropped our <style>
        applyChipTheme();
        tickRunChip();
        if (chipPending) { chipPending = false; sweepChipsFrom(document.body); }
        // v1.6.1: keep OUR decorations alive across site re-renders.
        try {
          if (runHost && runOpts && runHost.isConnected) {
            hideToolBlocks(runHost, null); // re-hide recreated raw-call blocks
            if (!runHost.querySelector(':scope > .ob-chip')) runChip = buildChip(runHost, runOpts);
          }
          for (let i = settledChips.length - 1; i >= 0; i--) {
            const s = settledChips[i];
            if (!s.host || !s.host.isConnected) { settledChips.splice(i, 1); continue; }
            if (s.host.classList.contains('ob-cmd-mask')) hideToolBlocks(s.host, null);
            if (!s.host.querySelector(':scope > .ob-chip')) buildChip(s.host, s.opts);
          }
        } catch (e) { /* cosmetic */ }
      }, 600);
      setTimeout(() => { if (!superseded()) sweepChipsFrom(document.body); }, 3000);
    } catch (e) { /* ignore */ }
  }

  function isGenerating() {
    const stop = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i], button[title*="Stop" i], div[role="button"][aria-label*="Stop" i], button[aria-label*="停止"], [class*="stop-button" i]');
    if (stop && !inPanel(stop)) return true;
    const input = getChatInput();
    if (input) {
      let parent = input.parentElement;
      for (let i = 0; i < 6 && parent; i++) {
        const rect = parent.querySelector('button svg rect, div[role="button"] svg rect');
        if (rect && !inPanel(rect)) return true;
        parent = parent.parentElement;
      }
    }
    const streaming = document.querySelector('.ds-loading, [class*="streaming" i], [class*="cursor-blink" i]');
    return !!(streaming && !inPanel(streaming));
  }

  /* ------------------------------------------------------- tool parsing */
  const DEFAULT_MAX_TOOLS = 6;

  function safeJsonParse(str) {
    try { return JSON.parse(str); } catch (e) { /* try to repair raw newlines in strings */ }
    try {
      let out = '', inStr = false, esc = false;
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') { inStr = !inStr; out += ch; continue; }
        if (inStr && (ch === '\n' || ch === '\r')) out += ch === '\n' ? '\\n' : '\\r';
        else if (inStr && ch === '\t') out += '\\t';
        else out += ch;
      }
      return JSON.parse(out);
    } catch (e) { return null; }
  }

  function normalizeCall(p) {
    if (!p || typeof p !== 'object') return null;
    if (Array.isArray(p)) return p.map(normalizeCall).filter(Boolean);
    if (typeof p.tool === 'string' && p.tool.trim()) return { tool: p.tool.trim(), params: (p.params && typeof p.params === 'object') ? p.params : {} };
    if (typeof p.name === 'string' && p.name.trim()) return { tool: p.name.trim(), params: (p.params || p.arguments || {}) };
    return null;
  }

  /** Extract EVERY tool call in a message. v1.8 rework:
   *  - `limit` = tools per message (user setting, 1..12).
   *  - Fenced ```tool/```json blocks stay LENIENT (explicit protocol).
   *  - Bare JSON (no fence) is STRICT: it must sit on its own line(s), carry an
   *    explicit "params" key and a sane tool id. Inline JSON the AI writes in
   *    prose ("the config has \"tool\": \"terminal\"...") no longer executes.
   *  - Identical calls in one message are NO LONGER deduped away — the AI can
   *    legitimately run the same command twice (occurrence-indexed sigs in the
   *    scanner keep re-render dedup correct). */
  function extractToolCalls(rawText, limit) {
    const cap = Math.max(1, Math.min(24, Number(limit) || DEFAULT_MAX_TOOLS));
    if (!rawText) return [];
    let text = rawText;
    const thinkEnd = text.lastIndexOf('</think>');
    if (thinkEnd !== -1) text = text.slice(thinkEnd + 8);
    else if (text.includes('<think>')) return [];

    const calls = [];
    const push = (p) => {
      for (const c of [].concat(normalizeCall(p) || [])) {
        if (c && calls.length < cap) calls.push(c);
      }
    };

    // 1) fenced ```tool / ```json blocks (each may hold one object or an array)
    const fences = text.matchAll(/```(?:tool|json)?\s*\n?([\s\S]*?)```/gi);
    for (const f of fences) {
      const parsed = safeJsonParse(f[1].trim());
      if (parsed) push(parsed);
    }
    if (calls.length) return calls;

    // 2) bare JSON, STRICT (v1.8): opening { must start a line, closing } must
    // end its line, "tool" AND "params" keys required.
    const openRe = /(^|\n)[ \t]*\{/g;
    let m;
    while (calls.length < cap && (m = openRe.exec(text))) {
      const open = m.index + m[0].length - 1; // the '{'
      let depth = 0, close = -1, inStr = false, esc = false;
      for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (!inStr) {
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { close = i; break; } }
        }
      }
      if (close === -1) break;
      // closing brace must be line-final (whitespace up to \n or EOF)
      let j = close + 1;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
      if (j < text.length && text[j] !== '\n' && text[j] !== '\r') { openRe.lastIndex = close + 1; continue; }
      const body = text.slice(open, close + 1);
      if (!/"params"\s*:/.test(body) || !/"tool"\s*:/.test(body)) { openRe.lastIndex = close + 1; continue; }
      const parsed = safeJsonParse(body);
      if (parsed && typeof parsed.tool === 'string' && /^[a-z][a-z0-9_.-]*$/i.test(parsed.tool.trim())) push(parsed);
      openRe.lastIndex = close + 1;
    }
    return calls;
  }

  /* ------------------------------------------------------------ results */
  const MAX_RESULT_CHARS = 28000;

  function formatToolResult(res, originalTool, attempt = 1, maxChars) {
    res = res || {};
    const name = res.tool || (originalTool && originalTool.tool) || 'tool';
    const nonce = Math.random().toString(36).slice(2, 6).toUpperCase();
    let header = `[TOOL_RESULT: ${name}]`;
    if (res.vps) header += ` (vps: ${res.vps})`;
    if (attempt > 1) header += ` [Resend #${attempt} @ ${new Date().toLocaleTimeString()} #${nonce}]`;

    let body;
    const r = res.result;
    if (!res.success) {
      body = `Status: ERROR\nError: ${res.error || (r && r.stderr) || 'Execution failed'}`;
    } else if (name === 'parallel_commands' && r && Array.isArray(r.results)) {
      const parts = [`Status: ${r.failed ? `${r.failed}/${r.count} FAILED` : 'SUCCESS'} (wall ${(r.wallMs / 1000).toFixed(1)}s, ${r.count} commands at once, cwd ${r.cwd})`];
      r.results.forEach((x, i) => {
        parts.push(``, `--- command ${i + 1}: ${x.command} ---`, `Status: ${x.timedOut ? 'TIMEOUT' : x.exitCode === 0 ? 'SUCCESS' : 'FAILED'} (exit ${x.exitCode ?? '-'}, ${(x.durationMs / 1000).toFixed(1)}s)`);
        if (x.stdout) parts.push('stdout:', x.stdout);
        if (x.stderr) parts.push('stderr:', x.stderr);
        if (!x.stdout && !x.stderr) parts.push('(no output)');
      });
      body = parts.join('\n');
    } else if (r && typeof r === 'object' && ('stdout' in r || 'stderr' in r) && /^(terminal_|run_command)/.test(name)) {
      const status = r.needsInput ? 'AWAITING_INPUT' : r.timedOut ? 'TIMEOUT' : r.success ? 'SUCCESS' : 'FAILED';
      const parts = [`Status: ${status} (exit ${r.exitCode ?? '-'}, ${r.durationMs != null ? (r.durationMs / 1000).toFixed(1) + 's' : 'n/a'})`, `cwd: ${r.cwd || ''}`];
      if (r.stdout) parts.push('--- stdout ---', r.stdout);
      if (r.stderr) parts.push('--- stderr ---', r.stderr);
      if (!r.stdout && !r.stderr) parts.push('(no output)');
      if (r.needsInput) parts.push('', 'The command is waiting for input. Reply with terminal_input { "input": "..." }, or terminal_kill to abort.');
      body = parts.join('\n');
    } else {
      body = 'Status: SUCCESS\n' + JSON.stringify(r === undefined ? res : r, null, 1);
    }
    let text = `${header}\n${body}`;
    const cap = maxChars || MAX_RESULT_CHARS;
    if (text.length > cap) {
      // keep the head (header + status) AND the tail: the end of terminal output
      // (errors, final lines) is usually the part that matters
      const tail = Math.floor(cap * 0.3);
      text = text.slice(0, cap - tail) + `\n...[truncated ${text.length - cap} chars to fit the chat box]...\n` + text.slice(text.length - tail);
    }
    if (attempt > 1) text += `\n\n<!-- nonce ${nonce}-${Date.now()} -->`;
    return text;
  }

  function formatBatchResults(pairs, attempt = 1) {
    // pairs: [{ call, res }] in original order
    if (pairs.length === 1) return formatToolResult(pairs[0].res, pairs[0].call, attempt);
    // one shared budget for the whole message (N x 28k would overflow the composer)
    const each = Math.max(3500, Math.floor(MAX_RESULT_CHARS / pairs.length));
    const parts = pairs.map((p, i) => `[${i + 1}/${pairs.length}] ` + formatToolResult(p.res, p.call, 1, each));
    let text = parts.join('\n\n');
    if (attempt > 1) text += `\n\n<!-- resend ${attempt} ${Date.now()} -->`;
    return text;
  }

  /* --------------------------------------------------- sending to chat */
  const MIN_SEND_INTERVAL_MS = 2200;
  let lastSubmit = 0;
  let lastResult = null;   // { text, pairs } for the retry path
  let rateRetries = 0;
  let retrying = false;

  async function sendTextToChat(text, meta) {
    // Persist BEFORE sending so a browser close mid-send can be recovered.
    if (meta && meta.resumable !== false) await store.set({ obPendingResult: { text, at: Date.now(), href: location.href } });
    const wait = Math.max(120, MIN_SEND_INTERVAL_MS - (Date.now() - lastSubmit));
    if (wait > 400) { UI.setActivity('Pacing to avoid rate limits…', 'thinking', true); UI.setStatus('thinking', 'Pacing'); }
    await sleep(wait);
    const ok = await typeAndSend(text, { label: 'OrbitBridge is working…', chip: meta && meta.chip });
    if (!ok) {
      UI.setActivity('Could not find the chat box on this page.', 'error', false);
      UI.setStatus('offline', 'No chat box');
      return false;
    }
    await store.set({ obPendingResult: null }); // delivered — nothing to resume
    UI.setActivity('Result sent. Waiting for the AI…', 'thinking', true);
    UI.setStatus('thinking', 'Waiting');
    return true;
  }

  async function sendToolResultToChat(res, originalTool, attempt = 1) {
    const text = formatToolResult(res, originalTool, attempt);
    lastResult = { text, pairs: [{ call: originalTool, res }] };
    await sendTextToChat(text, { resumable: attempt === 1 });
  }

  function detectRateLimit() {
    const phrases = ['messages too frequent', 'try again later', 'too many requests', '发送频率过高', '消息发送过于频繁', '请稍后再试', 'server is busy'];
    const nodes = document.querySelectorAll('div, p, span');
    for (let i = nodes.length - 1; i >= Math.max(0, nodes.length - 80); i--) {
      const n = nodes[i];
      if (inPanel(n) || n.children.length > 2) continue;
      if (n.closest(MD_SEL) || isAssistantText(n)) continue; // the AI merely writing "try again later" is not a rate limit
      const t = (n.textContent || '').toLowerCase().trim();
      if (t.length < 160 && phrases.some((p) => t.includes(p))) return n;
    }
    return null;
  }

  function findRetryButton() {
    const btns = document.querySelectorAll('button, div[role="button"]');
    for (let i = btns.length - 1; i >= 0; i--) {
      const b = btns[i];
      if (inPanel(b)) continue;
      const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
      if (/retry|regenerate|重试/.test(label)) return b;
    }
    return null;
  }

  function checkRateLimit() {
    if (superseded() || retrying || !lastResult || Date.now() - lastSubmit > 60000) return;
    if (!detectRateLimit()) return;
    if (rateRetries >= 4) { UI.setActivity('Rate limited by the site. Paused.', 'error', false); UI.setStatus('offline', 'Rate limited'); return; }
    retrying = true; rateRetries++;
    let secs = 4 + rateRetries * 2;
    UI.setActivity(`Rate limited. Retrying in ${secs}s (${rateRetries}/4)…`, 'thinking', true);
    UI.setStatus('thinking', `Wait ${secs}s`);
    const iv = setInterval(() => { secs--; if (secs > 0) { UI.setActivity(`Rate limited. Retrying in ${secs}s (${rateRetries}/4)…`, 'thinking', true); UI.setStatus('thinking', `Wait ${secs}s`); } else clearInterval(iv); }, 1000);
    setTimeout(async () => {
      clearInterval(iv);
      try {
        if (superseded()) return;
        const retry = findRetryButton();
        if (retry && rateRetries === 1) {
          retry.click();
          await sleep(2200);
          retrying = false;
          if (detectRateLimit()) await resendVaried();
          return;
        }
        await resendVaried();
      } catch (e) { /* fall through to the reset below */ }
      retrying = false;
    }, secs * 1000);
  }

  async function resendVaried() {
    if (!lastResult) { retrying = false; return; }
    const text = lastResult.pairs && lastResult.pairs.length > 1
      ? formatBatchResults(lastResult.pairs, rateRetries + 1)
      : formatToolResult(lastResult.pairs ? lastResult.pairs[0].res : { success: false }, lastResult.pairs ? lastResult.pairs[0].call : null, rateRetries + 1);
    try { await typeAndSend(text, { label: 'Resending…', retries: 2 }); }
    finally { retrying = false; }
    UI.setActivity('Resent. Waiting for the AI…', 'thinking', true);
    UI.setStatus('thinking', 'Waiting');
  }

  /* ------------------------------------------------------------ VPS routing */
  function findProfileByName(name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    return profilesCache.find((p) => (p.name || '').toLowerCase() === n || p.id === name) || null;
  }

  function boundProfileId() {
    return chatVpsMap[chatKey()] || null;
  }

  function activeProfileId() {
    return activeVpsId || (profilesCache[0] ? profilesCache[0].id : null);
  }

  /** Which VPS runs this call? params.vps (name) > parallel spread > this chat's pin > active. */
  function routeProfile(toolCall, idx, total) {
    const byName = findProfileByName(toolCall.params && toolCall.params.vps);
    if (byName) return byName;
    const list = profilesCache.filter(Boolean);
    if (!list.length) return null;
    if (multiVps && total > 1 && list.length > 1) {
      const found = list.findIndex((p) => p.id === (boundProfileId() || activeProfileId()));
      const anchor = found >= 0 ? found : 0;
      return list[(idx + anchor) % list.length];
    }
    const bound = list.find((p) => p.id === boundProfileId());
    if (bound) return bound;
    return list.find((p) => p.id === activeProfileId()) || list[0];
  }

  /* ----------------------------------------------------- run a tool batch */
  function setDetected(tc, el) {
    lastDetected = tc ? { toolCall: tc, el } : null;
    UI.setDetected(tc);
  }

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimer = setInterval(() => {
      try { chrome.runtime.sendMessage({ type: 'KEEPALIVE' }, () => void chrome.runtime.lastError); } catch (e) { /* gone */ }
    }, 20000);
  }
  function stopKeepAlive() { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; } }

  const TERMINAL_RE = /^(terminal_|run_command)/;

  async function executeOne(toolCall, profile) {
    const params = { ...(toolCall.params || {}) };
    delete params.vps; // routing hint, not a server param
    const req = { type: 'API', method: 'POST', path: '/api/execute', body: { tool: toolCall.tool, params }, timeoutMs: 15 * 60 * 1000 + 30000 };
    if (profile && profile.id) req.profileId = profile.id;
    const res = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(req, (r) => {
          if (chrome.runtime.lastError) resolve({ success: false, tool: toolCall.tool, error: 'Extension was updated. Reload this page.' });
          else resolve(r || { success: false, tool: toolCall.tool, error: 'No response' });
        });
      } catch (e) { resolve({ success: false, tool: toolCall.tool, error: e.message }); }
    });
    if (profile) res.vps = profile.name;
    return res;
  }

  async function executeBatch(calls, els) {
    if (superseded() || activeExecution || !calls.length) return;
    try { await executeBatchInner(calls, els); }
    catch (e) {
      // anything unexpected (UI.confirm threw, a chip crashed...) must not leave the engine wedged
      if (activeExecution) {
        const pairs = calls.map((c) => ({ call: c, res: { success: false, tool: c.tool, error: 'Internal error: ' + String(e && e.message || e) } }));
        try { await finishBatch(pairs, els); } catch (e2) { activeExecution = false; stopKeepAlive(); }
      }
    }
  }

  async function executeBatchInner(calls, els) {
    activeExecution = true;
    startKeepAlive();
    (els || []).forEach((el) => {
      if (!el) return;
      try {
        // v1.8: els are TURN ROOTS now (not pre blocks) — mark the root itself
        // AND its markdown container so either shape of re-render is covered.
        el.setAttribute('data-ob-handled', 'true');
        el.setAttribute('data-ob-container-handled', 'true');
        const md = el.closest(MD_SEL);
        if (md && md !== el) md.setAttribute('data-ob-container-handled', 'true');
      } catch (e) { /* ignore */ }
    });
    setDetected(null);

    const label = calls.length > 1 ? `${calls.length} tools in parallel` : calls[0].tool;
    UI.setStatus('running', `Running ${label}`);
    UI.setActivity(`Running ${label}…`, 'active', true);
    if (calls.some((c) => TERMINAL_RE.test(c.tool) || c.tool === 'start_background')) UI.notifyExecuted();

    // Approval: one prompt for the whole batch when autopilot is off.
    if (!autopilot) {
      const ok = calls.length > 1 ? await UI.confirmBatch(calls) : await UI.confirm(calls[0]);
      if (!ok) {
        const pairs = calls.map((c) => ({ call: c, res: { success: false, tool: c.tool, error: 'The user rejected this action.' } }));
        finishBatch(pairs, els);
        return;
      }
    }

    if (!alive()) {
      activeExecution = false; stopKeepAlive();
      UI.setStatus('offline', 'Reload page');
      UI.setActivity('Extension was updated. Reload this page.', 'error', false);
      return;
    }

    // Bind this chat to the first profile it uses (sticky per chat, "only 1 for one chat").
    const firstProfile = routeProfile(calls[0], 0, calls.length);
    if (firstProfile && !chatVpsMap[chatKey()]) {
      chatVpsMap[chatKey()] = firstProfile.id;
      store.set({ obChatVps: chatVpsMap });
      UI.setChatVps(firstProfile.name);
    }

    startRunChip(calls, els);

    const jobs = calls.map(async (call, i) => {
      const profile = routeProfile(call, i, calls.length);
      const res = await executeOne(call, profile);
      return { call, res };
    });

    const settled = await Promise.all(jobs);
    // Keep the AI-facing order identical to the message order, whatever finished first.
    const pairs = calls.map((call, i) => settled[i] || { call, res: { success: false, tool: call.tool, error: 'No response' } });
    finishBatch(pairs, els);
  }

  async function finishBatch(pairs, els) {
    activeExecution = false;
    stopKeepAlive();
    endRunChip(pairs);
    const failed = pairs.filter((p) => !p.res || !p.res.success).length;
    rateRetries = 0;
    if (pairs.length > 1) {
      UI.setActivity(`${pairs.length - failed}/${pairs.length} parallel calls finished`, failed ? 'error' : 'success', false);
    } else {
      const r = pairs[0].res;
      if (r && r.success) UI.setActivity(`${pairs[0].call.tool} finished (${r.durationMs || 0}ms)`, 'success', false);
      else UI.setActivity(`${pairs[0].call.tool} failed: ${(r && r.error) || 'server error'}`, 'error', false);
    }
    try { UI.notifyExecuted(); } catch (e) { /* cosmetic */ }
    try {
      const text = formatBatchResults(pairs, 1);
      lastResult = { text, pairs };
      await sendTextToChat(text, { chip: chipInfoFromPairs(pairs) });
    } catch (e) {
      coverOff();
      UI.setActivity('Could not send the result: ' + String(e && e.message || e), 'error', false);
    }
    processQueue('after-batch').catch(() => { /* ignore */ });
  }

  /* --------------------------------------------------------- scanning */
  const executed = new Set(); // callSig()#occurrence — content-based, stable across site re-renders
  const stable = new WeakMap(); // container el -> { text, since }
  const extractCache = new WeakMap(); // container el -> { text, calls }
  // v1.8 history discrimination. This REPLACES the v1.7 boot-window
  // executed.add(), which wrongly swallowed NEW tool calls that landed within
  // 3.5s of a page load / chat switch ("Found an earlier terminal call" on a
  // fresh AI reply — the #1 user report), and whose mid-stream message
  // prefixes later shifted, so the very same old call could re-run after the
  // message finished streaming. History is now decided per TURN (stable node
  // identity), never per unstable text prefix.
  let bootTurns = new WeakSet();      // assistant turns already in the DOM at boot (hydrated history)
  let historyOffered = new WeakSet(); // turns whose stale call we already offered as "Run"
  let wallDoneTurns = new WeakSet();  // turns a later [TOOL_RESULT] wall already answered

  // v1.6.1: the dedup key is CONTENT (tool + params + message prefix), not the
  // message's DOM index — the index shifts every time a new message lands,
  // which let an already-run call re-execute (double runs).
  function callSig(container, call, cleanText) {
    // cleanText = the extraction text (no chips / think blocks / hidden raw calls):
    // raw textContent would change the moment OUR chip lands in the message and
    // let a re-created node re-run the same call under a different signature.
    const prefix = (cleanText != null ? cleanText : ((container && container.textContent) || '')).replace(/\s+/g, ' ').trim().slice(0, 100);
    return call.tool + ':' + JSON.stringify(call.params || {}) + ':' + prefix;
  }

  function getAssistantText() {
    const nodes = document.querySelectorAll(MD_SEL);
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (inPanel(nodes[i]) || nodes[i].closest(USER_SEL)) continue;
      const clone = nodes[i].cloneNode(true);
      clone.querySelectorAll(THINK_SEL + ', pre, code').forEach((n) => n.remove());
      return clone.textContent.trim();
    }
    return '';
  }

  // --- v1.8 turn helpers (history gates) --------------------------------
  // Ordered list of turn roots, assistant + user markers together.
  const ALL_TURN_SEL = SITE === 'deepseek' ? '.ds-message'
    : ([TURNS.assistant, TURNS.user].filter(Boolean).join(', ') || (MD_SEL + ', ' + USER_SEL));
  function turnIsUser(t) {
    try {
      if (SITE === 'deepseek') return !t.querySelector('.ds-markdown'); // one root for BOTH roles there
      if (TURNS.user) return t.matches(TURNS.user);
      return !!(t.matches(USER_SEL) || t.querySelector(USER_SEL));
    } catch (e) { return false; }
  }
  function assistantTurnsList() {
    try { return Array.from(document.querySelectorAll(ALL_TURN_SEL)).filter((t) => t && !inPanel(t)); }
    catch (e) { return []; }
  }
  // A call is ALREADY ANSWERED when a USER turn AFTER the call's turn carries a
  // [TOOL_RESULT] wall — the agent itself replied to it in this conversation.
  // Reads CONTENT, so it still works after the site re-created every node.
  function answeredAfterTurn(turn) {
    try {
      if (!turn) return false;
      const list = assistantTurnsList();
      const idx = list.indexOf(turn);
      if (idx === -1) return false;
      for (let i = idx + 1; i < list.length; i++) {
        const t = list[i];
        if (!turnIsUser(t)) continue;
        if ((t.textContent || '').includes('TOOL_RESULT')) return true;
      }
    } catch (e) { /* unreadable → treat as unanswered */ }
    return false;
  }
  // Boot-time history snapshot: a turn whose text is UNCHANGED across a tick
  // and that is not part of an active generation is hydrated old content.
  // Streaming replies keep mutating (or generation is on), so a fresh tool
  // call can no longer be misclassified as "earlier" — the v1.7 bug.
  function bootSnapshotTick(prevTexts) {
    try {
      if (isGenerating()) return; // something is streaming — decide nothing this tick
      for (const t of assistantTurnsList()) {
        if (bootTurns.has(t)) continue;
        const txt = t.textContent || '';
        if (prevTexts.get(t) === txt) bootTurns.add(t);
        else prevTexts.set(t, txt);
      }
    } catch (e) { /* ignore */ }
  }

  // Candidate containers, v1.8: per-site ASSISTANT TURN ROOTS (stable across
  // re-renders) instead of every pre/code/markdown node — one extraction per
  // message, no double counting between a pre block and its parent container.
  function candidateContainers() {
    let list = [];
    try { list = Array.from(document.querySelectorAll(TURNS.assistant || ('pre code, pre, [class*="code-block" i], ' + MD_SEL))); } catch (e) { return []; }
    list = list.filter((el) => !inPanel(el));
    if (TURNS.assistant) {
      // DeepSeek's turn root is shared by both roles — drop user walls here.
      return list.filter((el) => { try { return !turnIsUser(el); } catch (e) { return true; } });
    }
    // Unknown layout: keep only OUTERMOST candidates so nested pre/containers
    // are never extracted twice.
    return list.filter((el) => !list.some((o) => o !== el && o.contains(el)));
  }
  // Extraction text = message content MINUS thinking blocks, our own chips and
  // hidden raw blocks, WITH line structure restored around block elements.
  // Plain textContent concatenates adjacent <pre> blocks ("…}{"…") into ONE
  // line, which would make the strict bare-JSON scanner reject exactly the
  // rendered code blocks it must accept. Without this, a chip's expandable
  // body (holding the raw call JSON) would also re-trigger detection after
  // every site re-render.
  function containerCallText(el) {
    try {
      const clone = el.cloneNode(true);
      clone.querySelectorAll(THINK_SEL + ', .ob-chip, .ob-tool-hide, [contenteditable="true"], textarea, style, script').forEach((n) => { try { n.remove(); } catch (e2) { /* ignore */ } });
      const out = [];
      const isBlockish = (n) => {
        const tag = n.tagName;
        if (tag === 'P' || tag === 'DIV' || tag === 'BR' || tag === 'LI' || tag === 'UL' || tag === 'OL' || tag === 'TABLE' || tag === 'BLOCKQUOTE' || tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4') return true;
        try { const d = getComputedStyle(n).display; return d === 'block' || d === 'flex' || d === 'grid'; } catch (e) { return false; }
      };
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) { out.push(child.nodeValue || ''); continue; }
          if (child.nodeType !== 1) continue;
          const tag = child.tagName;
          if (tag === 'PRE' || tag === 'CODE' || (child.matches && child.matches('[class*="code-block" i]'))) {
            out.push('\n' + (child.textContent || '') + '\n'); // rendered fence: own lines
            continue;
          }
          if (tag === 'BR') { out.push('\n'); continue; }
          const blockish = isBlockish(child);
          if (blockish) out.push('\n');
          walk(child);
          if (blockish) out.push('\n');
        }
      };
      walk(clone);
      return out.join('');
    } catch (e) { return el.textContent || ''; }
  }

  function scanForToolCalls() {
    if (superseded() || activeExecution) return;
    const now = Date.now();
    const batch = []; // { call, el, sig }

    for (const el of candidateContainers()) {
      if (batch.length >= maxTools) break;
      if (el.getAttribute('data-ob-handled') === 'true' || el.getAttribute('data-ob-container-handled') === 'true') continue;
      if (el.closest('[data-ob-container-handled="true"]')) continue;
      if (el.closest(THINK_SEL) || el.closest(USER_SEL)) continue;

      const turn = assistantTurnOf(el);
      try { if (turn && turnIsUser(turn)) continue; } catch (e) { /* keep going */ }

      const text = containerCallText(el);
      if (!text || text.indexOf('"tool"') === -1) continue;

      // ---- v1.8 history gates (decided per TURN, stable across re-renders) ----
      if (turn && wallDoneTurns.has(turn)) continue;
      if (turn && answeredAfterTurn(turn)) { wallDoneTurns.add(turn); continue; }
      if (turn && bootTurns.has(turn)) {
        // Opened an existing chat: do not replay history. Offer it ONCE as a
        // manual action instead (the old code re-offered on every scan).
        if (!historyOffered.has(turn)) {
          historyOffered.add(turn);
          let c0 = null;
          try { c0 = extractToolCalls(text, 1)[0] || null; } catch (e) { c0 = null; }
          if (c0) {
            setDetected(c0, el);
            UI.setActivity(`Found an earlier ${c0.tool} call. Tap Run if you want it.`, 'normal', false);
          }
        }
        continue;
      }

      // One extraction per content revision (cached); the message must have
      // stopped changing before we act on it.
      let cached = extractCache.get(el);
      if (!cached || cached.text !== text) { cached = { text, calls: extractToolCalls(text, maxTools) }; extractCache.set(el, cached); }
      if (!cached.calls.length) continue;
      const st = stable.get(el);
      if (!st || st.text !== text) { stable.set(el, { text, since: now }); continue; }
      if (now - st.since < 700) continue;

      // Boot calm-down: observe only, decide nothing. bootSnapshotTick owns
      // history classification during this window; a NEW tool call that lands
      // here simply waits for the window to pass instead of being swallowed
      // as "earlier" (the v1.7 first-reply bug).
      if (now < bootUntil) continue;

      // Occurrence-aware signatures: two IDENTICAL calls in one message are
      // two distinct slots, while the same call re-detected after a site
      // re-render still matches its sig and stays executed.
      const seen = new Map();
      for (const call of cached.calls) {
        if (batch.length >= maxTools) break;
        const k = call.tool + '|' + JSON.stringify(call.params || {});
        const occ = seen.get(k) || 0;
        seen.set(k, occ + 1);
        const sig = callSig(el, call, text) + '#' + occ;
        if (executed.has(sig)) continue;
        executed.add(sig);
        batch.push({ call, el, sig });
      }
    }

    if (batch.length) {
      if (isGenerating()) {
        // Model is still writing; un-claim so the next scan can pick it up.
        batch.forEach((b) => executed.delete(b.sig));
        return;
      }
      executeBatch(batch.map((b) => b.call), batch.map((b) => b.el));
    }
  }

  /* ------------------------------------------------- generation tracking */
  function handleGenerationCompleted() {
    scanForToolCalls();
    if (activeExecution || lastDetected) return;
    const text = getAssistantText();
    if (!text) { UI.setActivity('Ready.', 'normal', false); UI.setStatus('online', 'Ready'); }
    processQueue('generation-done');
    if (activeExecution || lastDetected) return;
    if (!text) return;
    const isQuestion = /\?\s*$/.test(text) || /(do you want|should i|would you like|please confirm|can you tell me|what should)/i.test(text.slice(-160));
    if (isQuestion) {
      UI.setActivity('The AI asked you something. Reply in the chat.', 'question', false);
      UI.setStatus('question', 'Your turn');
    } else {
      UI.setActivity('Finished. Ready for your next message.', 'success', false);
      UI.setStatus('online', 'Ready');
    }
  }

  function checkGenerationCycle() {
    if (superseded() || activeExecution) return;
    const generating = isGenerating();
    if (generating) {
      if (!isThinking) {
        isThinking = true; awaitingResponse = false; rateRetries = 0; // a reply started: the site accepted us, so the retry budget resets
        UI.setActivity('The AI is replying…', 'thinking', true);
        UI.setStatus('thinking', 'Thinking');
      }
    } else if (isThinking) {
      isThinking = false; awaitingResponse = false;
      handleGenerationCompleted();
    } else if (awaitingResponse && Date.now() - awaitingSince > 6000) { // 3s was too short on slow starts: "Ready" + queue fired before the reply began
      awaitingResponse = false;
      handleGenerationCompleted();
    }
  }

  /* ------------------------------------------------------ prompt queue */
  // A persistent series of prompts. Each entry sends automatically when the
  // agent is idle — and the list lives in chrome.storage, so closing the
  // browser (or the tab) does NOT lose it; it resumes on reopen.
  let queueBusy = false;

  async function getQueue() {
    const r = await store.get(['obQueue', 'obQueuePaused']);
    const q = Array.isArray(r.obQueue) ? r.obQueue.filter((x) => x && typeof x.text === 'string') : [];
    return { items: q, paused: !!r.obQueuePaused };
  }

  async function renderQueueUi() {
    const { items, paused } = await getQueue();
    UI.setQueueInfo(items.length, paused);
  }

  async function enqueuePrompt(text) {
    const { items } = await getQueue();
    items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: String(text || '').trim(), addedAt: Date.now() });
    await store.set({ obQueue: items });
    renderQueueUi();
  }

  function agentIdleForQueue() {
    if (Date.now() < bootUntil) return false;
    if (activeExecution || awaitingResponse || isGenerating() || retrying || lastDetected) return false;
    if (Date.now() - lastSubmit < 3500) return false;
    if (!serverOnline) return false;
    return true;
  }

  async function processQueue(reason) {
    if (superseded() || queueBusy) return;
    if (!agentIdleForQueue()) return;
    queueBusy = true;
    try {
      const { items, paused } = await getQueue();
      if (paused || !items.length) return;
      const first = items[0];
      // Multi-tab guard: another tab may have claimed this item seconds ago.
      if (first.claim && first.claim.tab !== TAB_TOKEN && Date.now() - first.claim.at < 20000) return;
      first.claim = { tab: TAB_TOKEN, at: Date.now() };
      await store.set({ obQueue: items });
      // the awaits above took a while: a tool batch may have started meanwhile
      if (!agentIdleForQueue()) return;
      UI.setActivity(`Queue: sending “${first.text.slice(0, 60)}${first.text.length > 60 ? '…' : ''}”`, 'active', true);
      UI.setStatus('thinking', 'Queue');
      UI.showChip(`Queue ${items.length}: sending next prompt`, true);
      const ok = await typeAndSend(first.text, { label: 'Queue: sending next prompt…' });
      if (ok) {
        // re-read: prompts queued / removed while we were sending must survive
        const cur = await getQueue();
        await store.set({ obQueue: cur.items.filter((x) => x.id !== first.id).map((x) => ({ ...x, claim: null })) });
        renderQueueUi();
      }
    } finally {
      queueBusy = false;
    }
  }

  /* ------------------------------------------------------------- prompt */
  async function buildPrompt() {
    const p = await new Promise((resolve) => {
      try { chrome.runtime.sendMessage({ type: 'GET_PROMPT' }, (r) => resolve(r)); } catch (e) { resolve(null); }
    });
    if (!p || !p.success) return null;
    let env = '';
    const info = await UI.api('GET', '/api/info', undefined, 15000);
    const st = await UI.api('GET', '/api/status', undefined, 15000);
    if (info && info.success) {
      const i = info.info;
      env = `\n\n### ENVIRONMENT\n- Server: ${i.os} (${i.arch}), ${i.cpus} CPU cores, ${i.memory ? i.memory.totalMB + ' MB RAM' : ''}\n- Running as: ${i.user}${i.isRoot ? ' (root)' : ''}\n- Workspace (relative paths resolve here): ${i.workspaceRoot}\n- Current terminal directory: ${(st && st.terminalCwd) || i.workspaceRoot}\n- Node ${i.node}`;
      if (profilesCache.length > 1) {
        env += `\n- Available VPS servers: ${profilesCache.map((x) => x.name).join(', ')} (add "vps": "<name>" to a call's params to choose one)`;
      }
    }
    return p.text.trim() + env + '\n\nI am ready. What should we work on?';
  }

  /* -------------------------------------------------------------- health */
  let healthFails = 0;
  async function checkHealth() {
    if (superseded()) return;
    if (!alive()) { serverOnline = false; UI.setOnline(false, 'Extension was updated. Reload this page.'); return; }
    const r = await UI.api('GET', '/api/status', undefined, 12000);
    if (r && r.status === 'online') {
      healthFails = 0;
      serverOnline = true;
      UI.setOnline(true);
    } else if (++healthFails >= 2 || (r && (r.code === 'UNAUTHORIZED' || r.code === 'NO_TOKEN'))) {
      serverOnline = false;
      UI.setOnline(false, (r && r.error) || 'Offline');
      if (!activeExecution) UI.setActivity((r && r.error) || 'Cannot reach the server.', 'error', false);
    }
  }

  /* ------------------------------------------------ custom prompts (UI) */
  async function listCustomPrompts() {
    const r = await store.get(['obCustomPrompts']);
    return Array.isArray(r.obCustomPrompts) ? r.obCustomPrompts : [];
  }
  async function saveCustomPrompt(name, text) {
    const list = await listCustomPrompts();
    list.unshift({ id: Date.now().toString(36), name: (name || '').trim() || (String(text).trim().slice(0, 28) || 'Prompt'), text: String(text || '') });
    await store.set({ obCustomPrompts: list.slice(0, 30) });
    return list.length;
  }
  async function deleteCustomPrompt(id) {
    const list = await listCustomPrompts();
    await store.set({ obCustomPrompts: list.filter((x) => x.id !== id) });
  }

  /* -------------------------------------------------------------- init */
  function init() {
    UI.mount({
      // v1.7 ZeroScript-style composer bar: the UI needs the site's real composer
      // geometry to mount the status bar in-flow (inside the input box on
      // DeepSeek/ChatGPT, above it on Gemini, anchored on Claude/z.ai).
      site: SITE,
      getComposer: getChatInput,
      getSendBtn: getSendButton,
      onAutopilot: (v) => { autopilot = v; try { chrome.storage.local.set({ autopilot: v }); } catch (e) { /* ignore */ } },
      onInjectPrompt: async () => {
        const text = await buildPrompt();
        if (!text) { UI.toast('Could not load the prompt'); return; }
        if (setChatInputValue(text)) { UI.toast('Prompt inserted. Press send in the chat.'); UI.close(); }
        else UI.toast('Chat box not found on this page');
      },
      onCopyPrompt: async () => { const t = await buildPrompt(); if (t) UI.copyText(t, 'Prompt copied'); },
      onRunDetected: () => {
        if (!lastDetected) return;
        const { toolCall, el } = lastDetected;
        executeBatch([toolCall], [el]);
      },
      onSkipDetected: () => setDetected(null),
      onQuickSend: async (text, mode) => {
        const t = String(text || '').trim();
        if (!t) return 'Nothing to send';
        if (mode === 'queue' || !agentIdleForQueueNow()) {
          await enqueuePrompt(t);
          UI.toast(mode === 'queue' ? 'Added to queue' : 'Agent busy — added to queue');
          return 'queued';
        }
        const ok = await typeAndSend(t, { label: 'Sending…' });
        if (!ok) return 'Chat box not found';
        UI.toast('Sent');
        return 'sent';
      },
      onQueueList: getQueue,
      onQueueAction: async (action, arg) => {
        if (action === 'remove') {
          const { items } = await getQueue();
          await store.set({ obQueue: items.filter((x) => x.id !== arg) });
        } else if (action === 'clear') {
          await store.set({ obQueue: [] });
        } else if (action === 'pause') {
          await store.set({ obQueuePaused: !!arg });
          const { items, paused } = await getQueue();
          UI.setQueueInfo(items.length, paused);
          return;
        } else if (action === 'runNow') {
          const { items } = await getQueue();
          const item = items.find((x) => x.id === arg);
          if (item) {
            await store.set({ obQueue: items.filter((x) => x.id !== arg) });
            const sent = await typeAndSend(item.text, { label: 'Queue: sending…' });
            if (!sent) { // do not lose the prompt when the chat did not take it
              const cur = await getQueue();
              cur.items.unshift(item);
              await store.set({ obQueue: cur.items });
            }
            renderQueueUi();
          }
        }
        renderQueueUi();
      },
      onListCustomPrompts: listCustomPrompts,
      onSaveCustomPrompt: saveCustomPrompt,
      onDeleteCustomPrompt: deleteCustomPrompt,
      onListBackgroundJobs: async () => UI.api('POST', '/api/execute', { tool: 'list_background', params: {} }, 30000),
      onListVps: async () => ({ profiles: profilesCache, multiVps, chatVps: boundProfileId() }),
      onSetChatVps: async (profileId) => {
        chatVpsMap[chatKey()] = profileId;
        await store.set({ obChatVps: chatVpsMap });
        const p = profilesCache.find((x) => x.id === profileId);
        UI.setChatVps(p ? p.name : '');
      },
      recheck: checkHealth
    });

    try {
      chrome.storage.local.get(['autopilot', 'obMaxTools'], (r) => {
        if (r && r.autopilot !== undefined) autopilot = !!r.autopilot;
        UI.setAutopilot(autopilot);
        if (r && r.obMaxTools !== undefined) maxTools = clampMaxTools(r.obMaxTools); // v1.8
      });
      chrome.storage.onChanged.addListener((c, area) => {
        if (area !== 'local') return;
        if (superseded()) return;
        if (c.autopilot) { autopilot = !!c.autopilot.newValue; UI.setAutopilot(autopilot); }
        if (c.obMaxTools) maxTools = clampMaxTools(c.obMaxTools.newValue); // v1.8
        if (c.obQueue || c.obQueuePaused) renderQueueUi();
        if (c.vpsProfiles) { profilesCache = (c.vpsProfiles.newValue || []).map((p) => ({ ...p })); refreshVpsUi(); }
        if (c.activeVps) { activeVpsId = c.activeVps.newValue || null; }
        if (c.obMultiVps) { multiVps = !!c.obMultiVps.newValue; }
      });
      chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
        // v1.3: OPEN_PANEL must ALWAYS answer and must never throw — the toolbar
        // open pipeline treats "no answer" as failure and would wrongly re-inject
        // / fall back to opening a chat tab.
        if (req && req.type === 'OPEN_PANEL') {
          try {
            if (window.OB_UI && window.OB_UI.isOpen) { if (!window.OB_UI.isOpen()) window.OB_UI.open(); }
            else { sendResponse({ success: false, reason: 'no_ui' }); return false; }
            sendResponse({ success: true });
          } catch (e) {
            try { sendResponse({ success: false, reason: 'error', error: String(e && e.message || e) }); } catch (e2) { /* channel gone */ }
          }
          return false;
        }
        if (req && req.type === 'TOGGLE_PANEL') { try { UI.toggle(); sendResponse({ success: true }); } catch (e) { try { sendResponse({ success: false, error: String(e) }); } catch (e2) {} } return false; }
        if (req && req.type === 'NUDGE') { try { processQueue('nudge'); sendResponse({ success: true }); } catch (e) { try { sendResponse({ success: false }); } catch (e2) {} } return false; }
        return false;
      });
    } catch (e) { /* context gone */ }

    let debounce = null;
    observe(() => {
      checkGenerationCycle();
      clearTimeout(debounce);
      debounce = setTimeout(() => { try { scanForToolCalls(); } catch (e) { /* DOM surprise */ } }, 250);
    }, { childList: true, subtree: true, characterData: true });

    const prevBootTexts = new Map(); // turn -> text at previous boot tick (v1.8 history snapshot)
    every(() => {
      // navigation = a different chat (path/query). A mere #hash change must not wipe the dedup set.
      if (lastHref !== chatKey()) { // new chat / navigation: forget history, do not replay it
        lastHref = chatKey();
        executed.clear(); setDetected(null);
        bootUntil = Date.now() + 3500;
        prevBootTexts.clear(); // bootTurns survives — turn nodes of the old chat stay history
        refreshVpsUi();
      }
      if (Date.now() < bootUntil) bootSnapshotTick(prevBootTexts); // v1.8
      else if (prevBootTexts.size) prevBootTexts.clear(); // do not pin old DOM nodes after the boot window
      checkGenerationCycle();
      scanForToolCalls();
    }, 800);
    startChipSystem();
    every(checkRateLimit, 1500);
    every(checkHealth, 10000);
    every(() => processQueue('tick'), 6000);
    checkHealth().catch(() => { /* ignore */ });

    // ---- resume after browser reopen / tab reload ----
    (async () => {
      const r = await store.get(['obQueue', 'obQueuePaused', 'obPendingResult', 'obChatVps', 'obMultiVps', 'vpsProfiles', 'activeVps']);
      chatVpsMap = r.obChatVps && typeof r.obChatVps === 'object' ? r.obChatVps : {};
      multiVps = !!r.obMultiVps;
      activeVpsId = r.activeVps || null;
      profilesCache = Array.isArray(r.vpsProfiles) ? r.vpsProfiles : [];
      const pending = r.obPendingResult;
      if (pending && pending.text && pending.href === location.href && Date.now() - pending.at < 10 * 60 * 1000) {
        UI.setActivity('Resending the result that was interrupted…', 'active', true);
        setTimeout(async () => {
          const ok = await typeAndSend(pending.text, { label: 'Resending the interrupted result…' });
          if (ok) await store.set({ obPendingResult: null });
        }, 4000);
      } else if (pending) {
        await store.set({ obPendingResult: null }); // stale (different chat or too old)
      }
      const bound = profilesCache.find((p) => p.id === (chatVpsMap[chatKey()] || r.activeVps));
      UI.setChatVps(bound ? bound.name : '');
      renderQueueUi();
      setTimeout(() => processQueue('boot'), 6000);
    })();

    UI.setActivity('Connecting…', 'normal', false);
  }

  function agentIdleForQueueNow() {
    return agentIdleForQueue();
  }

  function refreshVpsUi() {
    const bound = profilesCache.find((p) => p.id === boundProfileId());
    UI.setChatVps(bound ? bound.name : (profilesCache[0] ? profilesCache[0].name : ''));
  }

  if (!UI) { console.warn('[OrbitBridge] UI failed to load'); return; }
  // Test hook: pure functions for the jsdom regression suites.
  window.__OB_TEST = { sweepChipsFrom, userTurnOf, isAssistantText, chipResultBubble, parseChipInfo, assistantTurnOf,
    extractToolCalls, scanForToolCalls, bootTick: bootSnapshotTick, expireBoot: () => { bootUntil = Date.now() - 1; },
    getState: () => ({ maxTools, bootUntil, bootTurnsSize: 0 }) };

  // ---- v1.8 OTA boot gate ----------------------------------------------
  // The bundled engine no longer starts unconditionally: a newer auto-update
  // bundle (delivered by the server, injected by the background via
  // chrome.userScripts) owns the page first. Falls back to bundled code when
  // the browser cannot run user scripts.
  function startEngine() {
    if (window.__obEngine) return; // OTA core (or a fresh re-injection) owns the page
    window.__obEngine = MY_GEN;
    init();
  }

  async function bootGate() {
    if (OTA_RUNNING) { // this IS the auto-updated core — it always owns the page
      try { sessionStorage.removeItem('obOtaBooted:' + window.__OB_OTA_VERSION); } catch (e) { /* ignore */ }
      startEngine();
      return;
    }
    try {
      const r = await store.get(['obOtaBundle']);
      const b = r && r.obOtaBundle;
      if (b && b.version && b.files && cmpVer(b.version, OB_VERSION) > 0) {
        const ens = await new Promise((resolve) => {
          try { chrome.runtime.sendMessage({ type: 'OTA_ENSURE' }, (x) => { if (chrome.runtime.lastError) resolve(null); else resolve(x); }); }
          catch (e) { resolve(null); }
        });
        if (ens && ens.ok) {
          const flag = 'obOtaBooted:' + b.version;
          let seen = false;
          try { seen = sessionStorage.getItem(flag) === '1'; } catch (e) { /* ignore */ }
          if (!seen) {
            try { sessionStorage.setItem(flag, '1'); } catch (e) { /* ignore */ }
            setTimeout(() => { try { location.reload(); } catch (e) { /* stay */ } }, 120);
            return; // reloading into the auto-updated core
          }
          // One reload already happened for this version. The auto-updated
          // core injects at document_idle — give it a moment to claim the
          // page before falling back to the bundled engine.
          const t0 = Date.now();
          while (Date.now() - t0 < 1700) {
            await sleep(150);
            if (window.__obEngine || window.__OB_OTA_VERSION) return;
          }
        }
        // Registration unavailable (old browser / "Allow user scripts" off):
        // keep the bundled engine — status quo.
      }
    } catch (e) { /* storage/context gone → bundled engine */ }
    startEngine();
  }

  // Always-on responder so the background can reload ONLY idle tabs when an
  // update lands — works even while the engine is waiting for the OTA core.
  try {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      if (req && req.type === 'OTA_BUSY') {
        sendResponse({ busy: activeExecution || isThinking || awaitingResponse || retrying });
        return false;
      }
      return false;
    });
  } catch (e) { /* context gone */ }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootGate);
  else bootGate();
})();
