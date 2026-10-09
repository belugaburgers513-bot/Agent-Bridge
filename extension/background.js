'use strict';
// Service worker: the only place that talks to the bridge server(s).
// Content scripts send { type: 'API', method, path, body, profileId } and get { success, ... } back,
// which avoids page CSP / CORS / mixed-content problems on chat sites.
// Binary helpers: UPLOAD (raw body -> /api/upload) and DOWNLOAD (file -> base64 data URL).
// v1.1: multi-VPS profiles, keepalive for long tool calls, and a periodic alarm that
// nudges chat tabs so queued work resumes after the browser reopens.
// v1.2: live event stream port for the panel's Live tab.
// v1.4: NO POPUP AT ALL. Android Chromium forks (Lemur/Kiwi) render extension
// popups AS A TAB — the popup tab hijacks the screen, chrome.tabs.query then
// resolves to the popup itself, and window.close() is ignored, so the button
// looked dead. With no default_popup in the manifest, the toolbar tap fires
// chrome.action.onClicked DIRECTLY in this worker with the correct tab: no
// extra window, no focus loss, no query guessing. Docs: "This event will not
// fire if the action has a popup" — that single manifest line was the bug.

const DEFAULT_URL = 'http://127.0.0.1:3456';

const CHAT_MATCHES = [
  'https://chat.deepseek.com/*',
  'https://chat.z.ai/*',
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://claude.ai/*',
  'https://gemini.google.com/*'
];

/* ------------------------------------------------------------ VPS profiles */
// Storage layout:
//   vpsProfiles: [{ id, name, url, token }, ...]   (v1.1)
//   activeVps:   <profile id>
//   serverUrl / authToken: legacy keys, kept in sync with the ACTIVE profile so
//   older code paths (and exports) keep working.
async function getSettings(profileId) {
  const r = await chrome.storage.local.get(['serverUrl', 'authToken', 'vpsProfiles', 'activeVps']);
  let profiles = Array.isArray(r.vpsProfiles) ? r.vpsProfiles.filter(p => p && p.url) : [];
  // One-time migration: turn the legacy single-server config into profile #1.
  if (!profiles.length && r.serverUrl) {
    profiles = [{ id: 'vps1', name: 'VPS 1', url: String(r.serverUrl), token: String(r.authToken || '') }];
    try { await chrome.storage.local.set({ vpsProfiles: profiles, activeVps: 'vps1' }); } catch (e) { /* ignore */ }
  }
  let profile = null;
  if (profileId) profile = profiles.find(p => p.id === profileId) || null;
  if (!profile) profile = profiles.find(p => p.id === r.activeVps) || profiles[0] || null;
  if (profile) {
    return { base: String(profile.url || '').trim().replace(/\/+$/, ''), token: String(profile.token || '').trim(), name: profile.name || 'VPS', id: profile.id, profiles };
  }
  return { base: (r.serverUrl || DEFAULT_URL).trim().replace(/\/+$/, ''), token: (r.authToken || '').trim(), name: 'VPS', id: null, profiles };
}

async function callApi({ method = 'GET', path, body, timeoutMs = 90000, profileId }) {
  const { base, token } = await getSettings(profileId);
  if (!token && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(base)) {
    return { success: false, code: 'NO_TOKEN', error: 'No token set. Open Settings and paste your token.' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      method,
      cache: 'no-store',
      signal: ctrl.signal,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (res.status === 401) return { success: false, code: 'UNAUTHORIZED', error: 'Wrong token. Check Settings.' };
    if (res.status === 429) return { success: false, code: 'RATE', error: 'Too many failed attempts. Wait a minute.' };
    if (!res.ok && !data) return { success: false, code: 'HTTP', error: `Server returned HTTP ${res.status}` };
    return data && typeof data === 'object' ? data : { success: res.ok, data };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return {
      success: false,
      code: aborted ? 'TIMEOUT' : 'OFFLINE',
      error: aborted ? 'Request timed out' : 'Cannot reach the server. Check the URL, the tunnel and pm2.'
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------- binary helpers */
function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function uploadBinary({ name, b64, timeoutMs = 10 * 60 * 1000, profileId }) {
  const { base, token } = await getSettings(profileId);
  if (!token && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(base)) {
    return { success: false, code: 'NO_TOKEN', error: 'No token set. Open Settings and paste your token.' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/upload?name=${encodeURIComponent(name || 'file')}`, {
      method: 'POST',
      cache: 'no-store',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(name || 'file'),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      body: b64ToBytes(b64)
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (res.status === 401) return { success: false, code: 'UNAUTHORIZED', error: 'Wrong token. Check Settings.' };
    if (res.status === 413) return { success: false, code: 'TOO_LARGE', error: (data && data.error) || 'File too large for the server limit.' };
    if (!res.ok) return { success: false, code: 'HTTP', error: (data && data.error) || `Server returned HTTP ${res.status}` };
    return data;
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return { success: false, code: aborted ? 'TIMEOUT' : 'OFFLINE', error: aborted ? 'Upload timed out' : 'Cannot reach the server. Check the URL, the tunnel and pm2.' };
  } finally {
    clearTimeout(timer);
  }
}

async function downloadBinary({ path, timeoutMs = 10 * 60 * 1000, profileId }) {
  const { base, token } = await getSettings(profileId);
  if (!token && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(base)) {
    return { success: false, code: 'NO_TOKEN', error: 'No token set. Open Settings and paste your token.' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/download?path=${encodeURIComponent(path || '')}`, {
      cache: 'no-store',
      signal: ctrl.signal,
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch (e) { /* non-JSON */ }
      if (res.status === 401) return { success: false, code: 'UNAUTHORIZED', error: 'Wrong token. Check Settings.' };
      return { success: false, code: 'HTTP', error: (data && data.error) || `Server returned HTTP ${res.status}` };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 80 * 1024 * 1024) {
      return { success: false, code: 'TOO_LARGE', error: 'File over 80 MB — download it on a desktop or zip+split it.' };
    }
    const mime = res.headers.get('content-type') || 'application/octet-stream';
    const cd = res.headers.get('content-disposition') || '';
    let name = '';
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
    if (m) { try { name = decodeURIComponent(m[1]); } catch (e) { name = m[1]; } }
    return { success: true, name, size: buf.byteLength, mime, dataUrl: `data:${mime};base64,${bytesToB64(buf)}` };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return { success: false, code: aborted ? 'TIMEOUT' : 'OFFLINE', error: aborted ? 'Download timed out' : 'Cannot reach the server. Check the URL, the tunnel and pm2.' };
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------- messages */
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req && req.type === 'API') {
    callApi(req).then(sendResponse).catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (req && req.type === 'UPLOAD') {
    uploadBinary(req).then(sendResponse).catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (req && req.type === 'DOWNLOAD') {
    downloadBinary(req).then(sendResponse).catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (req && req.type === 'GET_PROMPT') {
    fetch(chrome.runtime.getURL('prompt.txt'))
      .then(r => r.text())
      .then(text => sendResponse({ success: true, text }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (req && req.type === 'KEEPALIVE') {
    // Content script pings this while a tool call is in flight so the MV3
    // service worker is not reaped mid-execute on mobile (Lemur/Android).
    sendResponse({ ok: true });
    return false;
  }
  if (req && req.type === 'PROFILE_PROBE') {
    // Used by Settings: check one profile without switching to it.
    callApi({ method: 'GET', path: '/api/status', timeoutMs: 12000, profileId: req.profileId })
      .then(sendResponse).catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }
  return false;
});

/* ------------------------------------------------- live event stream (v1.2) */
// The panel's Live tab opens a Port named 'ob-events'. We fetch the server's
// SSE endpoint (host_permissions bypass CORS) and forward parsed events over
// the port. Every port message resets the MV3 service-worker idle timer, so the
// stream survives while the panel is open.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ob-events') return;
  const ctrl = new AbortController();
  let stopped = false;
  (async () => {
    try {
      const { base, token } = await getSettings(); // active VPS profile
      if (!base || !/^https?:\/\//.test(base)) { port.postMessage({ type: 'EVENTS_ERR', error: 'No server URL configured' }); return; }
      const url = base + '/api/events?token=' + encodeURIComponent(token || '');
      const res = await fetch(url, {
        cache: 'no-store',
        signal: ctrl.signal,
        headers: token ? { Authorization: 'Bearer ' + token } : {}
      });
      if (!res.ok || !res.body) { port.postMessage({ type: 'EVENTS_ERR', error: 'Stream refused (HTTP ' + res.status + ')' }); return; }
      port.postMessage({ type: 'EVENTS_OPEN' });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try { port.postMessage({ type: 'EVENT', evt: JSON.parse(line.slice(6)) }); } catch (e) { /* partial */ }
          }
        }
      }
      if (!stopped) port.postMessage({ type: 'EVENTS_CLOSED' });
    } catch (e) {
      if (!stopped && !(e && e.name === 'AbortError')) port.postMessage({ type: 'EVENTS_ERR', error: e.message });
    }
  })();
  port.onDisconnect.addListener(() => { stopped = true; try { ctrl.abort(); } catch (e) { /* ignore */ } });
});

/* ------------------------------------------ toolbar button: reliable open */
// v1.4 open pipeline (fired by action.onClicked, no popup involved):
//   1. fast path: the tab already runs live scripts -> OPEN_PANEL just works.
//   2. reviver:    a 1-line probe checks window.__obBeat (see content.js).
//                  Orphaned scripts (extension updated/reloaded) are wiped from
//                  the page and ui.js+content.js are injected FRESH. This was the
//                  #1 cause of "the blue button does nothing" on Lemur: after any
//                  extension update, old tabs kept zombie scripts that blocked
//                  re-injection and never answered messages.
//   3. last resort: the page cannot host the panel -> open a chat site tab and
//                  auto-open the panel there once it loads. No user choices.
function tabMessage(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res || null);
      });
    } catch (e) { resolve(null); }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHAT_HOME = 'https://chat.z.ai/';

// Runs in the PAGE. Distinguishes live scripts from zombies (orphaned by an
// extension update/reload). Heartbeat ticks every 1.5s, but Android throttles
// timers hard in background tabs — so only 'stale' (orphaned: chrome.runtime.id
// throws) is an immediate zombie; a frozen timestamp must lag >90s to count.
function probeBeat() {
  const b = window.__obBeat;
  if (b === undefined || b === null) return { fresh: true };   // nothing injected yet
  if (b === 'stale') return { fresh: false, zombie: true };
  const age = Date.now() - b;
  return { fresh: age < 90000, zombie: age >= 90000 };
}

// Runs in the PAGE. Removes zombie scripts + panel DOM so a fresh injection mounts.
function exciseZombie() {
  try { document.getElementById('ob-root') && document.getElementById('ob-root').remove(); } catch (e) { /* ignore */ }
  try { delete window.OB_UI; } catch (e) { try { window.OB_UI = undefined; } catch (e2) { /* ignore */ } }
  try { window.__obEngine = false; } catch (e) { /* ignore */ }
  try { delete window.__obBeat; } catch (e) { try { window.__obBeat = undefined; } catch (e2) { /* ignore */ } }
}

async function injectFresh(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, func: exciseZombie });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['ui.js', 'content.js'] });
}

async function openOnTab(tab, attempts = 4) {
  if (!tab || tab.id == null) return false;
  // 1) fast path
  let res = await tabMessage(tab.id, { type: 'OPEN_PANEL' });
  if (res && res.success) return true;
  for (let i = 0; i < attempts; i++) {
    // 2) probe for zombies, then inject fresh
    let probe = null;
    try { [{ result: probe }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probeBeat }); }
    catch (e) { return false; } // cannot access this page at all
    if (probe && probe.zombie) { try { await injectFresh(tab.id); } catch (e) { /* fall through to messaging */ } }
    else if (!probe || probe.fresh === false) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['ui.js', 'content.js'] }); } catch (e) { /* maybe already there */ }
    }
    await sleep(220);
    res = await tabMessage(tab.id, { type: 'OPEN_PANEL' });
    if (res && res.success) return true;
    if (res && res.reason === 'no_ui') { try { await injectFresh(tab.id); } catch (e) { /* ignore */ } }
  }
  return false;
}

async function openChatTabWithPanel() {
  try {
    const tab = await chrome.tabs.create({ url: CHAT_HOME, active: true });
    // content_scripts auto-inject at document_end; poll until the panel answers.
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      const res = await tabMessage(tab.id, { type: 'OPEN_PANEL' });
      if (res && res.success) return true;
    }
    // SPA still warming up — inject explicitly and try once more.
    try {
      await injectFresh(tab.id);
      for (let i = 0; i < 6; i++) {
        await sleep(600);
        const res = await tabMessage(tab.id, { type: 'OPEN_PANEL' });
        if (res && res.success) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  } catch (e) { return false; }
}

async function openPanel(tab) {
  if (await openOnTab(tab)) return { ok: true, where: 'tab' };
  const ok = await openChatTabWithPanel();
  return { ok, where: ok ? 'chat' : 'none' };
}

// Badge flash: the tap must ALWAYS give visible feedback, even on builds where
// badges render oddly — on success the panel opens anyway; on failure a chat
// tab opens. This is mostly a diagnostic aid (green check = tap registered).
function flashBadge(tabId, text, color, ms) {
  try {
    const opts = { text };
    if (tabId != null) opts.tabId = tabId;
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText(opts);
    setTimeout(() => {
      try { chrome.action.setBadgeText({ tabId: tabId != null ? tabId : undefined, text: '' }); } catch (e) { /* ignore */ }
    }, ms);
  } catch (e) { /* badges unsupported on some builds */ }
}

chrome.action.onClicked.addListener((tab) => {
  openPanel(tab).then((r) => {
    if (r && r.ok) flashBadge(tab && tab.id, '✓', '#2fa464', 1500);
    else flashBadge(tab && tab.id, '!', '#e05252', 4000);
  }).catch(() => flashBadge(tab && tab.id, '!', '#e05252', 4000));
});

async function launchFromActiveTab() {
  let tab = null;
  try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch (e) { /* ignore */ }
  if (!tab) { try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (e) { /* ignore */ } }
  const url = (tab && tab.url) || '';
  if (!/^https?:\/\//i.test(url)) return openPanel(null); // new tab page / chrome:// -> straight to chat site
  return openPanel(tab);
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req && req.type === 'LAUNCH_PANEL') {
    // Kept as a compatibility route (older helpers / future UI may use it),
    // but the toolbar button no longer depends on any messaging at all.
    launchFromActiveTab().then((r) => sendResponse(r)).catch(() => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

/* ------------------------------------------------------- alarms (resume) */
// Keeps a slow heartbeat: every minute the worker wakes and nudges open chat
// tabs so a queued prompt continues even if the tab sat in the background.
try {
  chrome.alarms.create('ob-nudge', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (!a || a.name !== 'ob-nudge') return;
    try {
      chrome.tabs.query({ url: CHAT_MATCHES }, (tabs) => {
        for (const t of tabs || []) {
          if (t.id == null) continue;
          tabMessage(t.id, { type: 'NUDGE' });
        }
      });
    } catch (e) { /* ignore */ }
  });
} catch (e) { /* alarms unavailable */ }
