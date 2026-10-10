'use strict';
/**
 * OrbitBridge panel — mobile-first UI rendered in a Shadow DOM so the host site's CSS can't touch it.
 * Exposes window.OB_UI for content.js (the agent engine).
 */
(() => {
  if (window.OB_UI) return;

  const HOST_ID = 'ob-root';
  const VERSION = '1.8.5';

  /* ----------------------------------------------------------------- bar CSS
     v1.7: ZeroScript-style composer status bar (light DOM, page-level styles —
     it must live INSIDE the site's composer layout, where a shadow root can't).
     Three mount modes, ported from ZeroScript's placeBar:
       • ob-bar-inline.ob-bar-inside — real child of the composer box (DeepSeek, ChatGPT)
       • ob-bar-inline               — real node above the composer (Gemini)
       • ob-bar-anchored             — position:fixed hugging the composer top edge
                                       with a reserved padding strip (Claude, z.ai,
                                       framework-reconciled subtrees, fallback)
     The bar replaces the old floating FAB + activity pill entirely: no floating
     buttons over the chat, no pill overlapping messages — status lives in the
     composer where the user is always looking. */
  const BAR_CSS = `
#ob-bar{position:fixed;z-index:2147483599;display:flex;align-items:center;gap:9px;box-sizing:border-box;padding:7px 9px 7px 12px;background:rgba(20,20,28,.97);color:#e8e8ec;border:1px solid rgba(129,140,248,.30);border-radius:13px;box-shadow:0 8px 30px rgba(0,0,0,.42);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);font-size:12px;line-height:1.3;font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;user-select:none;-webkit-user-select:none;cursor:pointer}
#ob-bar *{box-sizing:border-box}
#ob-bar .ob-dot{width:8px;height:8px;border-radius:50%;background:#34d399;flex:none;box-shadow:0 0 0 0 rgba(52,211,153,.55);animation:ob-livedot 1.8s ease-out infinite}
#ob-bar .ob-dot.run{animation-duration:1s}
#ob-bar .ob-dot.warn{background:#fbbf24;box-shadow:0 0 0 0 rgba(251,191,36,.5);animation-name:ob-livedot-warn}
#ob-bar .ob-dot.off{background:#6b7280;animation:none;box-shadow:none}
@keyframes ob-livedot{0%{box-shadow:0 0 0 0 rgba(52,211,153,.55)}100%{box-shadow:0 0 0 7px rgba(52,211,153,0)}}
@keyframes ob-livedot-warn{0%{box-shadow:0 0 0 0 rgba(251,191,36,.5)}100%{box-shadow:0 0 0 7px rgba(251,191,36,0)}}
#ob-bar .ob-brand{font-weight:700;font-size:12.5px;letter-spacing:-.1px;color:#f4f4f6;white-space:nowrap}
#ob-bar .ob-free{font-size:9.5px;font-weight:500;color:rgba(255,255,255,.55);margin-left:3px;vertical-align:middle}
#ob-bar .ob-state{flex:1;min-width:0;display:flex;align-items:center;gap:6px;font-size:11.5px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ob-bar .ob-state-txt{min-width:0;overflow:hidden;text-overflow:ellipsis}
#ob-bar.tone-act .ob-state-txt{color:#6ee7b7;opacity:1}
#ob-bar.tone-warn .ob-state-txt{color:#fca5a5;opacity:1}
#ob-bar .ob-open{flex:none;padding:7px 13px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.08);color:#e8e8ec;font:700 12px/1.3 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;cursor:pointer;white-space:nowrap;transition:background .15s ease}
#ob-bar .ob-open:active{background:rgba(255,255,255,.16)}
#ob-bar.ob-bar-inline{position:static;width:100%;left:auto;top:auto;margin:0 0 8px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);border-radius:12px;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;padding:7px 12px}
#ob-bar.ob-bar-inline.ob-bar-inside{margin:0 0 6px;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,.08);border-radius:0;padding:4px 16px 10px}
#ob-bar.ob-bar-anchored{background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,.08);border-radius:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;padding:9px 16px}
html.ob-light #ob-bar{background:rgba(246,247,249,.97);color:#26262c;border-color:rgba(99,102,241,.25);box-shadow:0 8px 30px rgba(15,23,42,.16)}
html.ob-light #ob-bar.ob-bar-inline{background:rgba(0,0,0,.04);border-color:rgba(0,0,0,.10)}
html.ob-light #ob-bar.ob-bar-inline.ob-bar-inside{background:transparent;border-bottom:1px solid rgba(0,0,0,.08)}
html.ob-light #ob-bar.ob-bar-anchored{background:transparent;border-bottom:1px solid rgba(0,0,0,.08)}
html.ob-light #ob-bar .ob-brand{color:#1c1c22}
html.ob-light #ob-bar .ob-free{color:rgba(0,0,0,.45)}
html.ob-light #ob-bar .ob-open{background:rgba(0,0,0,.06);border-color:rgba(0,0,0,.14);color:#26262c}
html.ob-light #ob-bar .ob-open:active{background:rgba(0,0,0,.12)}
`;

  /* ------------------------------------------------------------------ utils */
  const $ = (root, sel) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const safeLS = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };
  const fmtBytes = (n) => {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
  };
  const fmtDur = (ms) => (ms == null ? '' : ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's');
  const fmtClock = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return ''; } };
  const fmtDate = (ms) => { try { return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }); } catch (e) { return ''; } };
  // v1.3: accessing chrome.runtime.id in an ORPHANED content script (extension was
  // reloaded/updated) THROWS "Extension context invalidated" — it used to crash every
  // caller. Now it is a plain boolean.
  const alive = () => { try { return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };

  /* ------------------------------------------------------------------ icons */
  const P = {
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/>',
    list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    up: '<polyline points="18 15 12 9 6 15"/>',
    down: '<polyline points="6 9 12 15 18 9"/>',
    back: '<polyline points="15 18 9 12 15 6"/>',
    play: '<polygon points="6 4 20 12 6 20 6 4"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    wand: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M12.2 6.2L11 5M3 21l9-9"/>',
    server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/>',
    alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    archive: '<rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><line x1="10" y1="13" x2="14" y2="13"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    pause: '<line x1="10" y1="5" x2="10" y2="19"/><line x1="14" y1="5" x2="14" y2="19"/>'
  };
  const icon = (name, size = 20) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;

  /* -------------------------------------------------------------------- CSS */
  const CSS = `
:host{all:initial}
*,*::before,*::after{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
.root{
  --bg:#0a0c11;--surface:#10131a;--surface-2:#161a23;--surface-3:#1d222d;--border:#252b39;--border-2:#313950;
  --text:#e8ebf2;--muted:#8a93a8;--faint:#5d667b;
  --accent:#7b8cff;--accent-2:#5566f5;--accent-soft:rgba(123,140,255,.14);
  --ok:#34d399;--ok-soft:rgba(52,211,153,.14);--warn:#fbbf24;--warn-soft:rgba(251,191,36,.14);--err:#f87171;--err-soft:rgba(248,113,113,.14);
  --term:#070910;
  --mono:ui-monospace,SFMono-Regular,"JetBrains Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;
  --vvh:100vh;--kb:0px;--sheet-h:60vh;
  position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:var(--sans);font-size:14px;line-height:1.4;color:var(--text);
  -webkit-font-smoothing:antialiased;
}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;touch-action:manipulation}
input,textarea{font:inherit;color:inherit}
svg{display:block;flex:none}
.hidden{display:none!important}

/* v1.7: the floating FAB and the floating activity pill are GONE — replaced by
   the ZeroScript-style composer status bar (light DOM, see BAR_CSS). The panel
   opens from the bar's Console button; status text lives in the bar. */
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,.35)}50%{box-shadow:0 0 0 6px rgba(255,255,255,0)}}

/* ---------- Sheet ---------- */
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .2s}
.scrim.show{opacity:1;pointer-events:auto}
.sheet{position:fixed;left:0;right:0;bottom:var(--kb);height:min(var(--sheet-h),calc(var(--vvh) - 10px));pointer-events:auto;
  display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--border);border-bottom:0;border-radius:22px 22px 0 0;
  box-shadow:0 -12px 40px rgba(0,0,0,.5);transform:translateY(105%);transition:transform .28s cubic-bezier(.2,.8,.2,1);overflow:hidden;overscroll-behavior:contain}
.sheet.open{transform:none}
.sheet.dragging{transition:none}
@media (min-width:700px){
  .sheet{left:auto;right:16px;bottom:16px;width:440px;height:min(var(--sheet-h),calc(100vh - 32px));border:1px solid var(--border);border-radius:22px}
}
.grab{flex:none;padding:8px 0 2px;display:grid;place-items:center;touch-action:none;cursor:grab}
.grab i{display:block;width:40px;height:4px;border-radius:4px;background:var(--border-2)}
.head{flex:none;display:flex;align-items:center;gap:10px;padding:4px 14px 10px}
.brand{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.logo{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(145deg,var(--accent),var(--accent-2));color:#fff;flex:none}
.brand b{display:block;font-size:15px;font-weight:650;letter-spacing:.1px}
.brand small{display:block;color:var(--muted);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:12px;font-weight:600;background:var(--surface-3);color:var(--muted);flex:none}
.pill::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.pill.online{color:var(--ok);background:var(--ok-soft)}.pill.offline{color:var(--err);background:var(--err-soft)}
.pill.thinking{color:var(--accent);background:var(--accent-soft)}.pill.thinking::before,.pill.running::before{animation:blink 1s infinite}
.pill.running{color:var(--warn);background:var(--warn-soft)}.pill.question{color:#c084fc;background:rgba(192,132,252,.14)}
@keyframes blink{50%{opacity:.25}}
.iconbtn{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;color:var(--muted);flex:none}
.iconbtn:active{background:var(--surface-3)}

.body{flex:1;min-height:0;position:relative}
.panel{position:absolute;inset:0;display:none;flex-direction:column;min-height:0}
.panel.active{display:flex}
.panel.active .scroll{animation:panelin .28s cubic-bezier(.2,.8,.2,1) both}
@keyframes panelin{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:4px 14px 18px}

.tabs{flex:none;display:flex;border-top:1px solid var(--border);background:var(--surface);padding:6px 6px calc(6px + env(safe-area-inset-bottom,0px))}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 0;border-radius:12px;color:var(--faint);font-size:10.5px;font-weight:600;position:relative;min-height:48px;transition:color .18s,background .18s,transform .1s}
.tab:active{transform:scale(.93)}
.tab.active{color:var(--accent);background:var(--accent-soft)}
.tab .badge{position:absolute;top:3px;left:calc(50% + 6px);min-width:8px;height:8px;border-radius:8px;background:var(--warn)}
.sheet.kb .tabs{display:none}

/* ---------- Cards / controls ---------- */
.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:14px;margin-top:12px}
.card h4{margin:0 0 10px;font-size:11.5px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.row{display:flex;align-items:center;gap:10px}
.grow{flex:1;min-width:0}
.muted{color:var(--muted)}.small{font-size:12px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:46px;padding:0 16px;border-radius:13px;background:var(--surface-3);border:1px solid var(--border-2);font-weight:600;font-size:14px;transition:transform .1s ease,filter .15s ease}
.btn:active{filter:brightness(1.2);transform:scale(.97)}
.btn.primary{background:linear-gradient(145deg,var(--accent),var(--accent-2));border-color:transparent;color:#fff}
.btn.ok{background:var(--ok);border-color:transparent;color:#04130d}
.btn.danger{background:var(--err-soft);border-color:rgba(248,113,113,.35);color:var(--err)}
.btn.block{width:100%}.btn.sm{min-height:36px;padding:0 12px;font-size:13px;border-radius:10px}
.btn[disabled]{opacity:.5;pointer-events:none}
.field{display:block;margin-top:12px}
.field>span{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px}
.input{width:100%;min-height:46px;padding:0 14px;border-radius:12px;background:var(--bg);border:1px solid var(--border-2);outline:none;font-size:16px}
.input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.input.mono{font-family:var(--mono);font-size:14px}
.switch{position:relative;width:50px;height:30px;border-radius:30px;background:var(--surface-3);border:1px solid var(--border-2);flex:none;transition:background .2s}
.switch::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#cfd5e6;transition:transform .2s}
.switch.on{background:var(--accent-2);border-color:transparent}.switch.on::after{transform:translateX(20px);background:#fff}
.toggle{display:flex;align-items:center;gap:12px;width:100%;text-align:left;min-height:48px}
.toggle b{display:block;font-size:14px;font-weight:600}.toggle small{display:block;color:var(--muted);font-size:12px;margin-top:1px}

.status{display:flex;align-items:center;gap:14px}
.status .ring{width:52px;height:52px;border-radius:16px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);flex:none}
.status.online .ring{background:var(--ok-soft);color:var(--ok)}.status.offline .ring{background:var(--err-soft);color:var(--err)}
.status.running .ring{background:var(--warn-soft);color:var(--warn)}.status.question .ring{background:rgba(192,132,252,.14);color:#c084fc}
.status h3{margin:0;font-size:17px;font-weight:650}
.status p{margin:3px 0 0;color:var(--muted);font-size:13px;word-break:break-word}
.spin{width:22px;height:22px;border-radius:50%;border:3px solid currentColor;border-right-color:transparent;animation:rot .8s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}
.callout{display:flex;gap:12px;padding:14px;border-radius:14px;background:var(--err-soft);border:1px solid rgba(248,113,113,.3);color:#ffd3d3;margin-top:12px}
.callout b{display:block;color:var(--err);margin-bottom:2px}
.callout .btn{margin-top:10px}
.code{font-family:var(--mono);font-size:12px;line-height:1.5;background:var(--term);border:1px solid var(--border);border-radius:12px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;color:#cdd5ea}
.meter{margin-top:12px}.meter .top{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:6px}
.meter .bar{height:8px;border-radius:8px;background:var(--surface-3);overflow:hidden}
.meter .bar i{display:block;height:100%;border-radius:8px;background:linear-gradient(90deg,var(--accent),var(--accent-2));transition:width .4s}
.meter .bar i.hot{background:linear-gradient(90deg,var(--warn),var(--err))}
.tags{display:flex;flex-wrap:wrap;gap:8px}
.tag{padding:6px 10px;border-radius:9px;background:var(--surface-3);font-size:12px;color:var(--muted);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag b{color:var(--text);font-weight:600}

/* ---------- Terminal ---------- */
.tbar{flex:none;display:flex;align-items:center;gap:8px;padding:2px 14px 8px}
.cwd{flex:1;min-width:0;font-family:var(--mono);font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:10px}
.cwd bdi{direction:ltr;unicode-bidi:isolate}
.term{flex:1;min-height:0;margin:0 14px;border-radius:14px;background:var(--term);border:1px solid var(--border);position:relative;display:flex;flex-direction:column;overflow:hidden}
.out{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:10px 12px;font-family:var(--mono);font-size:12.5px;line-height:1.5}
.ln{white-space:pre-wrap;word-break:break-word;color:#cfd6ea}
.ln.cmd{color:#7dd3fc;margin-top:8px;font-weight:600}.ln.cmd .ps{color:var(--ok)}
.ln.stderr{color:#fca5a5}.ln.stdin{color:var(--warn)}
.ln.exit{display:inline-block;font-size:10.5px;font-weight:600;letter-spacing:.2px;color:var(--faint);margin:3px 0 6px;padding:1px 9px;border-radius:999px;background:var(--surface-2)}
.ln.exit.bad{color:#f87171;background:var(--err-soft)}.ln.exit.good{color:#4ade80;background:var(--ok-soft)}
.ln.sys{color:var(--faint);font-style:italic}
/* v1.8.2 terminal motion: new lines slide in, a thin progress sweep runs along the
   top while a command is busy, and a blinking block caret trails the output. */
.ln.fx{animation:lnin .24s cubic-bezier(.2,.8,.2,1) both}
@keyframes lnin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ln.cmd{padding-left:9px;border-left:2px solid var(--ok);margin-left:-2px}
.term.busy::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;z-index:2;pointer-events:none;
  background:linear-gradient(90deg,transparent,var(--accent),transparent);background-size:38% 100%;background-repeat:no-repeat;animation:tsweep 1.15s ease-in-out infinite}
@keyframes tsweep{from{background-position:-45% 0}to{background-position:145% 0}}
.term.busy .out::after{content:"";display:block;width:8px;height:15px;margin-top:6px;border-radius:1.5px;background:var(--accent);animation:caret 1s steps(1) infinite}
@keyframes caret{0%,55%{opacity:1}56%,100%{opacity:0}}
.term{transition:border-color .25s,box-shadow .25s}
.term.busy{border-color:rgba(123,140,255,.45);box-shadow:0 0 0 3px rgba(123,140,255,.08)}
.empty{color:var(--faint);text-align:center;padding:30px 12px;font-size:13px}
.empty svg{margin:0 auto 10px;opacity:.6}
.jump{position:absolute;right:10px;bottom:10px;width:38px;height:38px;border-radius:50%;background:var(--accent-2);color:#fff;display:grid;place-items:center;box-shadow:0 4px 14px rgba(0,0,0,.5)}
.askbar{flex:none;margin:8px 14px 0;padding:10px 12px;border-radius:12px;background:rgba(192,132,252,.13);border:1px solid rgba(192,132,252,.35);display:flex;align-items:center;gap:10px}
.askbar .q{flex:1;min-width:0;font-family:var(--mono);font-size:12px;word-break:break-word}
.quick{flex:none;display:flex;gap:8px;overflow-x:auto;padding:8px 14px 2px;scrollbar-width:none}
.quick::-webkit-scrollbar{display:none}
.qk{flex:none;min-height:34px;padding:0 12px;border-radius:10px;background:var(--surface-2);border:1px solid var(--border-2);font-family:var(--mono);font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:6px}
.qk:active{background:var(--surface-3);color:var(--text)}
.qk.danger{color:var(--err)}
.cmdrow{flex:none;display:flex;gap:8px;align-items:center;padding:8px 14px 10px}
.cmdrow .in{flex:1;min-width:0;display:flex;align-items:center;gap:8px;min-height:46px;padding:0 12px;border-radius:13px;background:var(--term);border:1px solid var(--border-2)}
.cmdrow .in:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.cmdrow .ps{font-family:var(--mono);color:var(--ok);font-weight:700}
.cmdrow input{flex:1;min-width:0;background:none;border:0;outline:none;font-family:var(--mono);font-size:16px}
.cmdrow .go{width:46px;height:46px;border-radius:13px;background:linear-gradient(145deg,var(--accent),var(--accent-2));color:#fff;display:grid;place-items:center;flex:none}

/* ---------- Files ---------- */
.crumb{flex:none;display:flex;align-items:center;gap:8px;padding:2px 14px 8px}
.list{display:flex;flex-direction:column}
.item{display:flex;align-items:center;gap:12px;min-height:54px;padding:6px 8px;border-radius:12px;text-align:left;width:100%}
.item:active{background:var(--surface-2)}
.item .ic{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--surface-2);color:var(--muted);flex:none}
.item.dir .ic{background:var(--accent-soft);color:var(--accent)}
.item .nm{font-size:14px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .meta{font-size:11.5px;color:var(--faint)}
.viewer{position:absolute;inset:0;background:var(--bg);display:flex;flex-direction:column;z-index:3}
.viewer .vh{flex:none;display:flex;align-items:center;gap:8px;padding:2px 14px 8px}
.viewer .vh .nm{flex:1;min-width:0;font-family:var(--mono);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.viewer pre{flex:1;min-height:0;margin:0 14px 14px;overflow:auto;background:var(--term);border:1px solid var(--border);border-radius:14px;padding:12px;font-family:var(--mono);font-size:12px;line-height:1.55;white-space:pre;color:#cdd5ea;tab-size:2;-webkit-overflow-scrolling:touch}

/* ---------- Logs ---------- */
.log{width:100%;text-align:left;display:block;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:12px;margin-top:10px}
.log .top{display:flex;align-items:center;gap:10px}
.log .st{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;flex:none}
.log .st.ok{background:var(--ok-soft);color:var(--ok)}.log .st.bad{background:var(--err-soft);color:var(--err)}
.log .tn{font-weight:650;font-size:13.5px}
.log .sum{margin-top:6px;font-size:12px;color:var(--muted);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.log.exp .sum{white-space:pre-wrap;word-break:break-word}
.log .det{margin-top:8px}

/* ---------- Modal / toast ---------- */
.modal{position:fixed;inset:0;bottom:var(--kb);background:rgba(0,0,0,.62);display:flex;align-items:flex-end;justify-content:center;pointer-events:auto;padding:0;animation:fadein .2s ease both;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
.mcard{max-height:calc(var(--vvh) - 12px);overflow-y:auto;overscroll-behavior:contain}
@keyframes fadein{from{opacity:0}to{opacity:1}}
.mcard{width:100%;max-width:520px;background:var(--surface);border:1px solid var(--border-2);border-radius:22px 22px 0 0;padding:18px 16px calc(16px + env(safe-area-inset-bottom,0px));box-shadow:0 -10px 40px rgba(0,0,0,.6);animation:sheetin .32s cubic-bezier(.2,.8,.2,1) both}
@keyframes sheetin{from{opacity:0;transform:translateY(60px) scale(.98)}to{opacity:1;transform:none}}
@media (min-width:700px){.modal{align-items:center}.mcard{border-radius:22px}}
.mcard h3{margin:0 0 4px;font-size:17px}.mcard p{margin:0 0 12px;color:var(--muted);font-size:13px}
.mcard .actions{display:grid;grid-template-columns:1fr 1.4fr;gap:10px;margin-top:14px}
.toast{position:fixed;left:50%;bottom:calc(90px + env(safe-area-inset-bottom,0px));transform:translate(-50%,10px);opacity:0;background:#e8ebf2;color:#0a0c11;padding:10px 16px;border-radius:999px;font-weight:600;font-size:13px;pointer-events:none;transition:all .25s;max-width:86vw;text-align:center}
.toast.show{opacity:1;transform:translate(-50%,0)}
@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;transition-duration:.01ms!important}}
.item .item-main{flex:1;display:flex;align-items:center;gap:12px;min-width:0;min-height:50px;padding:6px;background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:12px}
.item .item-main:active{background:var(--surface-2)}
.item .item-main .grow{min-width:0}
.acts{display:flex;gap:6px;flex:none;align-items:center}
.act{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:var(--surface-2);border:1px solid var(--border);color:var(--muted);cursor:pointer;padding:0}
.act:active{background:var(--surface-3);color:var(--text)}

/* ---------- v1.1: quick prompt / series queue / multi-VPS ---------- */
.actions3{display:grid;grid-template-columns:1fr 1fr 1.4fr;gap:10px;margin-top:14px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.chips:empty{display:none}
.chipbtn{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:7px 11px;border-radius:999px;background:var(--surface-2);border:1px solid var(--border-2);font-size:12.5px;color:var(--text);cursor:pointer}
.chipbtn:active{background:var(--surface-3)}
.chipbtn .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
.chipbtn .chipx{display:grid;place-items:center;width:16px;height:16px;border-radius:50%;background:var(--surface-3);color:var(--muted);font-style:normal;font-size:11px;line-height:1;flex:none}
/* ---- live tab + installer (v1.2) ---- */
.livedot{width:8px;height:8px;border-radius:50%;background:var(--faint);flex:none;display:inline-block}
.livedot.on{background:var(--ok);animation:pulse 1.6s ease-in-out infinite}
.livedot.off{background:var(--err)}
.livedot.wait{background:var(--warn)}
.lfeed{display:flex;flex-direction:column;gap:7px;margin-top:10px}
.lrow{display:flex;gap:10px;align-items:flex-start;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:10px 12px;animation:lin .32s cubic-bezier(.2,.8,.3,1) both;transition:border-color .25s}
@keyframes lin{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:none}}
.lrow.still{animation:none}
.lrow.okf{border-color:var(--ok)}.lrow.badf{border-color:var(--err)}
.lic{width:30px;height:30px;flex:none;border-radius:9px;display:grid;place-items:center;font-family:var(--mono);font-size:12px;font-weight:700;background:var(--accent-soft);color:var(--accent)}
/* v1.8.2: was .lic.term — the SAME class as the terminal box (.term), which dragged
   margin/border/flex onto Live rows and shifted them. Prefixed. */
.lic.ic-term{background:rgba(34,211,238,.13);color:#67e8f9}
.lic.ic-file{background:var(--ok-soft);color:var(--ok)}
.lic.ic-web{background:var(--warn-soft);color:var(--warn)}
.lmain{flex:1;min-width:0}
.ltop{display:flex;align-items:center;gap:8px}
.ltool{font-size:12.5px}
.ltime{margin-left:auto;color:var(--faint);font-size:10.5px;font-family:var(--mono)}
.lsum{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:3px;word-break:break-all;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;line-height:1.5}
.lmeta{display:flex;align-items:center;gap:6px;margin-top:5px;font-size:11px;min-height:14px}
.lspin{width:11px;height:11px;border:2px solid var(--border-2);border-top-color:var(--accent);border-radius:50%;animation:rot .7s linear infinite;flex:none}
@keyframes rot{to{transform:rotate(360deg)}}
.lrun{color:var(--accent)}.lok{color:var(--ok)}.lbad{color:var(--err)}
.pbar{height:6px;border-radius:99px;background:var(--surface-3);overflow:hidden;margin-top:12px}
.pbar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent-2),var(--accent));border-radius:99px;transition:width .45s cubic-bezier(.3,.8,.3,1)}
.isteps{display:flex;flex-direction:column;gap:7px;margin-top:11px}
.istep{display:flex;gap:10px;align-items:flex-start;background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:10px 11px;opacity:.6;transition:opacity .25s,border-color .25s}
.istep.run{opacity:1;border-color:var(--accent)}
.istep.done{opacity:1;border-color:var(--ok)}
.istep.fail{opacity:1;border-color:var(--err)}
.inum{width:24px;height:24px;flex:none;border-radius:8px;background:var(--surface-3);display:grid;place-items:center;font-size:11px;font-weight:700;font-family:var(--mono)}
.istep.done .inum{background:var(--ok-soft);color:var(--ok)}
.istep.fail .inum{background:var(--err-soft);color:var(--err)}
.ibody{flex:1;min-width:0}
.ilabel{font-size:12.5px;font-weight:600}
.ihint{font-family:var(--mono);font-size:10px;color:var(--faint);margin-top:2px;word-break:break-all}
.iout{font-family:var(--mono);font-size:10.5px;color:var(--muted);background:var(--term);border:1px solid var(--border);border-radius:9px;padding:8px 10px;margin-top:7px;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto;line-height:1.5;animation:lin .25s both}
.qrow{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:10px 4px;border-radius:12px;background:none;border:0;color:inherit;font:inherit;cursor:pointer}
.qrow:active{background:var(--surface-2)}
.qrow .tx{font-size:13px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.qrow .meta{font-size:11px;color:var(--faint);margin-top:2px}
.vpsrow{display:flex;align-items:center;gap:10px;width:100%;padding:10px 6px;border-radius:12px;background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.vpsrow:active{background:var(--surface-2)}
.vpsrow .rd{width:16px;height:16px;border-radius:50%;border:2px solid var(--border-2);flex:none;display:grid;place-items:center}
.vpsrow.on .rd{border-color:var(--accent)}
.vpsrow.on .rd::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--accent)}
.vpsrow .nm2{flex:1;min-width:0}
.vpsrow .nm2 b{display:block;font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vpsrow .nm2 small{display:block;color:var(--muted);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bjob{display:flex;align-items:center;gap:10px;padding:9px 4px;border-radius:12px}
.bjob .st2{width:9px;height:9px;border-radius:50%;background:var(--ok);flex:none}
.bjob .st2.dead{background:var(--err)}
.bjob .nm2{flex:1;min-width:0}
.bjob .nm2 b{display:block;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bjob .nm2 small{display:block;color:var(--faint);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* ---------- VPS setup guide ---------- */
.gstep{display:flex;gap:10px;margin-top:12px;animation:panelin .3s cubic-bezier(.2,.8,.2,1) both}
.gstep .gnum{width:22px;height:22px;border-radius:8px;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:700;display:grid;place-items:center;flex:none;margin-top:1px}
.gstep b{display:block;font-size:13.5px;font-weight:600}
.gstep p{margin:3px 0 0;color:var(--muted);font-size:12.5px;line-height:1.45}
.gstep p b{display:inline;font-size:inherit;font-weight:650;color:var(--text)}
/* v1.8.2: was ".cmdrow" — the same class as the terminal input form, so the later
   rule boxed, padded and "pressed" the terminal input row. Renamed. */
.gcmd{display:flex;align-items:center;gap:8px;margin-top:7px;background:var(--term);border:1px solid var(--border);border-radius:10px;padding:8px 10px;cursor:pointer;transition:border-color .2s,transform .1s}
.gcmd:active{transform:scale(.985);border-color:var(--accent)}
.gcmd code{flex:1;min-width:0;font-family:var(--mono);font-size:11px;color:#c3d0ff;white-space:pre-wrap;word-break:break-word;line-height:1.5}
.gcmd .cpl{color:var(--muted);flex:none;display:grid;place-items:center}
.gtip{margin-top:8px;color:var(--faint);font-size:11.5px;line-height:1.45}
`;

  /* ------------------------------------------------------------------ state */
  const S = {
    handlers: {},
    online: false,
    open: false,
    tab: 'agent',
    autopilot: true,
    detected: null,
    status: { state: 'offline', label: 'Offline' },
    activity: { text: 'Connecting…', kind: 'normal', spinner: false },
    info: null,
    termSeq: 0,
    termEpoch: 0,
    termBusy: false,
    termCwd: '',
    termHistory: [],
    histIdx: -1,
    stick: true,
    filesPath: null,
    logs: [],
    logsSeen: 0,
    pollTimer: null,
    infoTimer: null,
    sheetPct: Number(safeLS.get('ob.sheetPct')) || 62,
    // v1.1
    profiles: [],
    activeVps: null,
    multiVps: false,
    queueCount: 0,
    queuePaused: false,
    chatVps: '',
    maxTools: 6
  };

  let host, shadow, R; // root nodes
  const refs = {};

  /* -------------------------------------------------------------------- api */
  function api(method, path, body, timeoutMs) {
    return new Promise((resolve) => {
      if (!alive()) { resolve({ success: false, code: 'RELOAD', error: 'Extension was updated. Reload this page.' }); return; }
      try {
        chrome.runtime.sendMessage({ type: 'API', method, path, body, timeoutMs }, (res) => {
          if (chrome.runtime.lastError) { resolve({ success: false, code: 'RELOAD', error: 'Extension was updated. Reload this page.' }); return; }
          resolve(res || { success: false, error: 'No response' });
        });
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    });
  }

  function toast(msg, ms) {
    const t = refs.toast;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), ms || 1800);
  }

  async function copyText(text, okMsg = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
      ta.remove();
    }
    toast(okMsg);
  }

  /* ------------------------------------------------------------------ build */
  function build() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    R = el('div', 'root');
    R.innerHTML = `
      <div class="scrim" id="scrim"></div>

      <section class="sheet" id="sheet" role="dialog" aria-label="OrbitBridge">
        <div class="grab" id="grab"><i></i></div>
        <div class="head">
          <div class="brand">
            <div class="logo">${icon('server', 18)}</div>
            <div class="grow"><b>OrbitBridge</b><small id="sub">Not connected</small></div>
          </div>
          <span class="pill offline" id="pill">Offline</span>
          <button class="iconbtn" id="close" aria-label="Close">${icon('x')}</button>
        </div>

        <div class="body">
          <!-- AGENT -->
          <div class="panel active" id="p-agent"><div class="scroll">
            <div class="card" style="margin-top:4px">
              <div class="status" id="statusBox">
                <div class="ring" id="ring">${icon('bot', 26)}</div>
                <div class="grow"><h3 id="stTitle">Offline</h3><p id="stText">Connecting…</p></div>
              </div>
            </div>
            <div id="offlineBox"></div>
            <div class="card hidden" id="detCard">
              <h4>Tool call detected</h4>
              <div class="code" id="detCode"></div>
              <div class="row" style="margin-top:12px"><button class="btn sm" id="detSkip">Skip</button><button class="btn primary grow" id="detRun">${icon('play', 16)}<span>Run now</span></button></div>
            </div>
            <div class="card">
              <button class="toggle" id="apToggle"><span class="switch on" id="apSwitch"></span><span class="grow"><b>Autopilot</b><small id="apHint">Runs tool calls automatically and sends results back</small></span></button>
              <div class="row" style="margin-top:12px;align-items:center">
                <span class="grow" style="font-size:12.5px;line-height:1.35"><b>Tools per message</b><br><span class="muted" style="font-size:11px">Max tool calls one AI message can run (1–12)</span></span>
                <button class="btn sm" id="mtMinus" style="width:42px;min-height:36px;padding:0;font-size:16px" aria-label="Fewer tools per message">−</button>
                <b id="mtVal" style="min-width:30px;text-align:center;font-size:16px">6</b>
                <button class="btn sm" id="mtPlus" style="width:42px;min-height:36px;padding:0;font-size:16px" aria-label="More tools per message">+</button>
              </div>
            </div>
            <div class="card">
              <h4>Get started</h4>
              <button class="btn primary block" id="inject">${icon('wand', 18)}<span>Insert agent prompt into chat</span></button>
              <button class="btn block" id="copyPrompt" style="margin-top:10px">${icon('copy', 16)}<span>Copy prompt</span></button>
            </div>
            <div class="card">
              <h4>Quick prompt</h4>
              <div class="row" style="gap:8px">
                <button class="btn primary grow" id="qNew">${icon('zap', 16)}<span>New prompt</span></button>
                <button class="btn" id="qOpenQueue">${icon('list', 16)}<span>Queue&nbsp;(<span id="qCountLbl">0</span>)</span></button>
              </div>
              <div class="chips" id="qSaved"></div>
            </div>
            <div class="card hidden" id="queueCard">
              <div class="row"><h4 style="margin:0" class="grow">Series queue <span class="muted" id="qCount">(0)</span></h4><button class="iconbtn" id="qPause" style="width:34px;height:34px" aria-label="Pause or resume the queue">${icon('pause', 15)}</button><button class="iconbtn" id="qClear" style="width:34px;height:34px" aria-label="Clear the queue">${icon('trash', 15)}</button></div>
              <div id="qList"></div>
              <div class="small muted" style="margin-top:8px">Queued prompts send one by one when the agent is free — they survive closing the browser.</div>
            </div>
            <div class="card hidden" id="bgCard">
              <div class="row"><h4 style="margin:0" class="grow">Long tasks on VPS</h4><button class="iconbtn" id="bgRefresh" style="width:34px;height:34px" aria-label="Refresh">${icon('refresh', 15)}</button></div>
              <div id="bgBody" class="muted small" style="margin-top:8px">Not connected.</div>
              <div class="small muted" style="margin-top:8px">Background jobs keep running on the server even if you close the browser or this tab.</div>
            </div>
            <div class="card" id="srvCard">
              <div class="row"><h4 style="margin:0" class="grow">Server</h4><button class="iconbtn" id="infoRefresh" style="width:34px;height:34px" aria-label="Refresh">${icon('refresh', 16)}</button></div>
              <div id="srvBody" class="muted small" style="margin-top:10px">Not connected.</div>
              <div class="row" id="chatVpsRow" style="margin-top:10px;display:none"><span class="small muted grow">This chat runs on <b id="chatVpsName">—</b></span><button class="btn sm" id="chatVpsSwitch">Switch</button></div>
            </div>
          </div></div>

          <!-- TERMINAL -->
          <div class="panel" id="p-term">
            <div class="tbar">
              <div class="cwd" id="cwd"><bdi>~</bdi></div>
              <button class="btn sm" id="termClear" aria-label="Clear">${icon('trash', 15)}</button>
            </div>
            <div class="term" id="termBox"><div class="out" id="out"></div><button class="jump hidden" id="jump" aria-label="Scroll to bottom">${icon('down', 18)}</button></div>
            <div class="askbar hidden" id="ask"><div class="q" id="askQ"></div><button class="btn sm ok" data-ans="y">Yes</button><button class="btn sm" data-ans="n">No</button></div>
            <div class="quick" id="quick"></div>
            <form class="cmdrow" id="cmdForm" autocomplete="off">
              <label class="in"><span class="ps" id="ps">$</span><input id="cmd" type="text" inputmode="text" enterkeyhint="send" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Run a command…" aria-label="Command"></label>
              <button class="go" type="submit" aria-label="Run">${icon('send', 20)}</button>
            </form>
          </div>

          <!-- FILES -->
          <div class="panel" id="p-files">
            <div class="crumb"><button class="btn sm" id="fUp" aria-label="Up">${icon('up', 16)}</button><div class="cwd" id="fPath"><bdi>/</bdi></div><button class="btn sm" id="fUpload" aria-label="Upload files here" title="Upload files here">${icon('upload', 15)}</button><button class="btn sm" id="fRefresh" aria-label="Refresh">${icon('refresh', 15)}</button><input type="file" id="fFile" multiple style="display:none"></div>
            <div class="scroll" id="fScroll"><div class="list" id="fList"></div></div>
            <div class="viewer hidden" id="viewer">
              <div class="vh"><button class="btn sm" id="vBack" aria-label="Back">${icon('back', 16)}</button><div class="nm" id="vName"></div><button class="btn sm" id="vCopy" aria-label="Copy">${icon('copy', 15)}</button></div>
              <pre id="vText"></pre>
            </div>
          </div>

          <!-- LOGS -->
          <div class="panel" id="p-logs"><div class="scroll">
            <div class="row" style="padding-top:4px"><div class="grow muted small">Latest tool executions</div><button class="btn sm" id="logRefresh">${icon('refresh', 15)}<span>Refresh</span></button></div>
            <div id="logList"></div>
          </div></div>

          <!-- LIVE -->
          <div class="panel" id="p-live"><div class="scroll">
            <div class="row" style="padding-top:4px">
              <div class="grow"><h4 style="margin:0">Live on the VPS</h4></div>
              <span class="livedot off" id="liveDot"></span>
              <button class="btn sm" id="liveReconnect" aria-label="Reconnect">${icon('refresh', 15)}<span>Reconnect</span></button>
            </div>
            <div class="small muted" style="margin:6px 2px 0">Every command and tool the AI runs on your server, as it happens — the actual work, not the chat text.</div>
            <div class="lfeed" id="liveFeed"><div class="empty" id="liveEmpty">Nothing yet.<br>Run something from the chat and watch it appear here in real time.</div></div>
            <div class="card">
              <div class="row"><h4 style="margin:0" class="grow">Install as a service</h4><button class="btn sm primary" id="instRun">${icon('play', 14)}<span>Install</span></button></div>
              <div class="small muted" style="margin-top:6px">Turns the bridge into a systemd service: every command shown live, auto-restart, survives reboots and closed SSH sessions.</div>
              <div class="pbar" id="instBar"><i id="instFill"></i></div>
              <div class="isteps" id="instSteps"></div>
              <div class="small muted" style="margin-top:9px">If the bridge currently runs in a terminal on this port, stop it first (Ctrl+C) so the service can take over. First time? Install the server first — Settings → VPS setup guide.</div>
            </div>
          </div></div>

          <!-- SETTINGS -->
          <div class="panel" id="p-set"><div class="scroll">
            <div class="card" style="margin-top:4px">
              <div class="row"><h4 style="margin:0" class="grow">VPS setup guide</h4><button class="btn sm" id="guideToggle" style="min-height:34px"><span>Show</span></button></div>
              <div class="small muted" style="margin-top:6px">From zero to connected: install the server on your VPS, expose it over HTTPS, connect this panel. About 5 minutes, all from your phone.</div>
              <div id="guideBody" class="hidden"></div>
            </div>
            <div class="card">
              <h4>VPS servers</h4>
              <div id="vpsList"></div>
              <button class="btn block" id="vpsAdd" style="margin-top:10px">${icon('plus', 16)}<span>Add VPS</span></button>
              <button class="toggle" id="multiToggle" style="margin-top:8px"><span class="switch" id="multiSwitch"></span><span class="grow"><b>Spread parallel calls</b><small>Run parallel tool calls across all your VPSes (or target one with "vps")</small></span></button>
            </div>
            <div class="card">
              <h4 id="connTitle">Connection</h4>
              <label class="field" style="margin-top:0"><span>Server URL</span><input class="input mono" id="setUrl" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://bridge.yourdomain.com"></label>
              <label class="field"><span>Token</span>
                <div class="row"><input class="input mono grow" id="setTok" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Paste token from server/.token"><button class="btn" id="tokEye" style="width:46px;padding:0" aria-label="Show">${icon('eye', 18)}</button></div>
              </label>
              <button class="btn primary block" id="saveConn" style="margin-top:14px">Save &amp; test connection</button>
              <div class="small" id="connMsg" style="margin-top:10px;min-height:18px"></div>
            </div>
            <div class="card">
              <h4>Workspace</h4>
              <label class="field" style="margin-top:0"><span>Workspace folder on the server</span><input class="input mono" id="setWs" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="/root"></label>
              <button class="toggle" id="strictToggle" style="margin-top:8px"><span class="switch" id="strictSwitch"></span><span class="grow"><b>Restrict file tools to workspace</b><small>Shell commands are not restricted</small></span></button>
              <button class="btn block" id="saveWs" style="margin-top:8px">Save workspace</button>
              <div class="small" id="wsMsg" style="margin-top:8px;min-height:18px"></div>
            </div>
            <div class="card">
              <h4>Extension updates</h4>
              <div class="small muted" id="otaLine">Checking…</div>
              <div class="row" style="margin-top:10px;gap:8px">
                <button class="btn sm primary" id="otaCheck">${icon('refresh', 15)}<span>Check now</span></button>
              </div>
              <button class="toggle" id="otaAutoToggle" style="margin-top:8px"><span class="switch on" id="otaAutoSwitch"></span><span class="grow"><b>Auto-update</b><small>Fetch new builds from your server and reload idle chat tabs — no reinstalling</small></span></button>
              <div class="small muted" id="otaHint" style="margin-top:8px;min-height:14px"></div>
            </div>
            <div class="card">
              <h4>About</h4>
              <div class="small muted">OrbitBridge v${VERSION} · your VPS inside AI chats — terminal, files (upload, download, zip), git, web and MCP. v1.8 rewrites tool-call detection: new calls are never mistaken for old ones (the “Found an earlier call” misfire), prose that merely quotes JSON can no longer trigger a run, and answered calls can never replay. You choose how many tools one AI message may run. And the extension now UPDATES ITSELF from your server (Settings → Extension updates) — after a one-time install, no more unzipping and reloading. v1.7 ports ZeroScript's status bar: a single strip docked to the chat composer (no more floating blue button, no pill hovering over messages) with a live dot and the agent state — tap it to open this console. Tool cards fire on DeepSeek too: while a tool runs you get a live shimmer + spinner chip on the AI's message, and every result wall folds into a tidy expandable card (page shift is compensated so nothing scrolls). v1.6.1 anchored cards on the chat turn so site re-renders can't wipe the spinner mid-run. v1.6 ports the real ZeroScript tool-card system with verified sends and automatic retries. v1.5 added the composer cover so raw tool text is never visible while the agent types. v1.4 removed the popup launcher (the toolbar button opens this panel). v1.3 auto-revives the engine after updates and added the VPS setup guide. v1.2 adds the Live tab, the in-panel service installer, true parallel tools on one VPS and prompts from .txt/.md files. Multiple VPS servers and the series queue that survives closing the browser are on board; long VPS jobs keep running with the browser closed.</div>
            </div>
          </div></div>
        </div>

        <nav class="tabs" id="tabs">
          <button class="tab active" data-tab="agent">${icon('bot')}<span>Agent</span></button>
          <button class="tab" data-tab="term">${icon('terminal')}<span>Terminal</span><i class="badge hidden" id="termBadge"></i></button>
          <button class="tab" data-tab="files">${icon('folder')}<span>Files</span></button>
          <button class="tab" data-tab="live">${icon('activity')}<span>Live</span></button>
          <button class="tab" data-tab="logs">${icon('list')}<span>Logs</span></button>
          <button class="tab" data-tab="set">${icon('gear')}<span>Settings</span></button>
        </nav>
      </section>

      <div class="modal hidden" id="qModal">
        <div class="mcard">
          <h3>Quick prompt</h3>
          <p class="small muted" style="margin-top:2px">Send it to the chat now, add it to the series queue, or save it for reuse.</p>
          <label class="field" style="margin-top:12px"><span>Name (for saving, optional)</span><input class="input" id="qpName" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
          <label class="field"><span>Prompt</span><textarea class="input" id="qpText" style="min-height:110px;padding:12px;resize:vertical;line-height:1.45"></textarea></label>
          <div class="chips" id="qpSaved"></div>
          <div class="actions3"><button class="btn" id="qpSave">Save</button><button class="btn" id="qpQueue">Queue</button><button class="btn primary" id="qpSend">Send now</button></div>
          <div class="row" style="margin-top:8px;gap:8px"><button class="btn block" id="qpImport">${icon('upload', 15)}<span>Import from .txt / .md file</span></button><input type="file" id="qpFile" accept=".txt,.md,.markdown,text/plain,text/markdown" multiple style="display:none"></div>
          <button class="btn block" id="qpCancel" style="margin-top:8px">Cancel</button>
        </div>
      </div>

      <div class="toast" id="toast"></div>
    `;
    shadow.appendChild(R);

    for (const id of ['scrim', 'sheet', 'grab', 'sub', 'pill', 'close', 'statusBox', 'ring', 'stTitle', 'stText', 'offlineBox',
      'detCard', 'detCode', 'detSkip', 'detRun', 'apToggle', 'apSwitch', 'mtMinus', 'mtVal', 'mtPlus', 'inject', 'copyPrompt', 'qNew', 'qOpenQueue', 'qCountLbl', 'qSaved', 'queueCard', 'qCount', 'qPause', 'qClear', 'qList', 'bgCard', 'bgRefresh', 'bgBody',
      'srvBody', 'chatVpsRow', 'chatVpsName', 'chatVpsSwitch', 'infoRefresh', 'cwd', 'termClear', 'termBox', 'out', 'jump', 'ask', 'askQ', 'quick', 'cmdForm', 'cmd', 'ps',
      'fUp', 'fPath', 'fUpload', 'fRefresh', 'fFile', 'fScroll', 'fList', 'viewer', 'vBack', 'vName', 'vCopy', 'vText', 'logRefresh', 'logList',
      'liveDot', 'liveReconnect', 'liveFeed', 'liveEmpty', 'instRun', 'instBar', 'instFill', 'instSteps',
      'vpsList', 'vpsAdd', 'multiToggle', 'multiSwitch', 'connTitle', 'setUrl', 'setTok', 'tokEye', 'saveConn', 'connMsg', 'setWs', 'strictToggle', 'strictSwitch', 'saveWs', 'wsMsg', 'termBadge', 'otaLine', 'otaCheck', 'otaAutoToggle', 'otaAutoSwitch', 'otaHint',
      'qModal', 'qpName', 'qpText', 'qpSaved', 'qpSave', 'qpQueue', 'qpSend', 'qpCancel', 'qpImport', 'qpFile', 'toast', 'tabs', 'guideToggle', 'guideBody']) {
      refs[id] = shadow.getElementById(id);
    }
    (document.documentElement || document.body).appendChild(host);

    // Keep keystrokes inside the panel away from the host page's shortcuts.
    for (const ev of ['keydown', 'keyup', 'keypress']) host.addEventListener(ev, (e) => e.stopPropagation());
  }

  /* ---------------------------------------------------------- keyboard helpers */
  // Touch screens: never auto-focus a field (it raises the on-screen keyboard
  // unasked). Desktop keeps the convenient autofocus.
  const isTouch = () => { try { return !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches); } catch (e) { return false; } };
  const focusIfDesktop = (node) => { if (!isTouch()) { try { node.focus(); } catch (e) { /* ignore */ } } };
  function blurPanelFocus() {
    try {
      const a = shadow && shadow.activeElement;
      if (a && a.blur) a.blur();
      const d = document.activeElement;
      if (d === host && d.blur) d.blur();
    } catch (e) { /* ignore */ }
  }

  /* ----------------------------------------------------------- sheet / fab */
  function applySheetSize() {
    refs.sheet.style.setProperty('--sheet-h', S.sheetPct + 'vh');
  }

  function setOpen(open, tab) {
    // v1.3: the visual open/close happens FIRST and can never be blocked by a
    // failing sub-feature — one broken widget on some site must not leave the
    // user with a button that "does nothing".
    S.open = open;
    if (tab) { try { setTab(tab); } catch (e) { /* non-fatal */ } }
    refs.sheet.classList.toggle('open', open);
    refs.scrim.classList.toggle('show', open && window.innerWidth < 700);
    if (open) {
      try {
        startPolling();
        loadInfo();
        renderQueue();
        renderSavedChips(refs.qSaved);
        if (S.online) loadBgJobs();
        if (S.tab === 'files' && !S.filesLoaded) loadFiles(S.filesPath);
        if (S.tab === 'logs') loadLogs();
        if (S.tab === 'live') { startLive(); if (S.online) loadInstallState(); }
      } catch (e) { /* panel is open; a widget failing must not close it */ }
    } else {
      try {
        stopPolling();
        stopLive();
        closeQuickPrompt();
        // v1.8.2: the panel lives in a shadow root, where document.activeElement is
        // just the host — so this blur never reached the real field and the on-screen
        // keyboard stayed up after closing. shadow.activeElement is the focused field.
        blurPanelFocus();
      } catch (e) { /* ignore */ }
    }
  }

  function setTab(tab) {
    S.tab = tab;
    for (const b of refs.tabs.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const p of R.querySelectorAll('.panel')) p.classList.toggle('active', p.id === 'p-' + tab);
    if (tab === 'term') { pollTerminal(); refs.termBadge.classList.add('hidden'); scrollOut(true); }
    if (tab === 'files' && !S.filesLoaded) loadFiles(S.filesPath);
    if (tab === 'logs') loadLogs();
    if (tab === 'set') { fillSettings(); loadVpsState(); refreshOta(); }
    if (tab === 'agent') { loadInfo(); renderQueue(); if (S.online) loadBgJobs(); }
    if (tab === 'live') { startLive(); if (S.online) loadInstallState(); }
  }

  function initViewport() {
    const vv = window.visualViewport;
    const upd = () => {
      const h = vv ? vv.height : window.innerHeight;
      const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
      R.style.setProperty('--vvh', h + 'px');
      R.style.setProperty('--kb', (kb > 80 ? kb : 0) + 'px');
      refs.sheet.classList.toggle('kb', kb > 80);
    };
    upd();
    if (vv) { vv.addEventListener('resize', upd); vv.addEventListener('scroll', upd); }
    window.addEventListener('resize', upd);
  }

  function initSheetDrag() {
    const g = refs.grab;
    let startY = 0, startPct = 0, moved = false, dragging = false;
    g.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false; startY = e.clientY; startPct = S.sheetPct;
      refs.sheet.classList.add('dragging');
      try { g.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    g.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dy = startY - e.clientY;
      if (Math.abs(dy) > 4) moved = true;
      S.sheetPct = clamp(startPct + (dy / window.innerHeight) * 100, 18, 94);
      applySheetSize();
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      refs.sheet.classList.remove('dragging');
      if (!moved) { S.sheetPct = S.sheetPct > 75 ? 55 : 93; }
      else if (S.sheetPct < 28) { S.sheetPct = 55; setOpen(false); }
      else { S.sheetPct = [40, 62, 93].reduce((a, b) => (Math.abs(b - S.sheetPct) < Math.abs(a - S.sheetPct) ? b : a)); }
      applySheetSize();
      safeLS.set('ob.sheetPct', String(S.sheetPct));
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
  }

  /* ------------------------------------------------------------ v1.7 bar */
  // Faithful port of ZeroScript's status bar: a single strip anchored to the
  // site's composer that carries the live dot, the brand and the state text.
  // Positioned EVERY animation frame by placeBar (survives SPA re-renders,
  // keyboard slides and composer re-layouts without listeners) with three mount
  // modes — in-flow inside the composer box, in-flow above it, or fixed
  // "anchored" with a reserved padding strip for framework-managed subtrees.
  let bar = null, barRaf = 0, barAnchorPad = null, lastBarSig = '';
  const BAR_ID = 'ob-bar';

  function barEnsureStyles() {
    if (document.getElementById('ob-bar-styles')) return;
    const st = document.createElement('style');
    st.id = 'ob-bar-styles';
    st.textContent = BAR_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function buildBar() {
    barEnsureStyles();
    bar = document.getElementById(BAR_ID);
    if (bar) { renderBarState(); return; }
    bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.innerHTML =
      '<span class="ob-dot off"></span>' +
      '<span class="ob-brand">OrbitBridge <span class="ob-free">v' + VERSION + '</span></span>' +
      '<span class="ob-state"><span class="ob-state-txt">Connecting…</span></span>' +
      '<button type="button" class="ob-open">Console</button>';
    (document.documentElement || document.body).appendChild(bar);
    // Whole bar is a tap target (small strip, big forgiveness); the Console
    // button is the explicit affordance. Both open the panel.
    bar.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { navigator.vibrate && navigator.vibrate(10); } catch (err) { /* ignore */ }
      setOpen(true);
    });
    barRaf = requestAnimationFrame(placeBar);
  }

  // The composer's outer box: the smallest ancestor of the input that also
  // holds the send button (ZeroScript's composerFrame/barMount recipe).
  function barComposerBox(ed, send) {
    let n = ed;
    for (let i = 0; i < 12 && n && n.parentElement; i++) {
      if (send && n.contains(send)) return n;
      n = n.parentElement;
    }
    let f = ed;
    for (let i = 0; i < 6 && f && f.parentElement; i++) f = f.parentElement;
    return f;
  }

  // Per-site in-flow mount plan (null → anchored/fixed mode).
  // v1.8.2: an in-flow bar is a full-width block. Inside a ROW flex (no wrap), a grid
  // or an inline container it becomes a sibling of the input and squeezes the text
  // box to a sliver (a composer whose input was 22px wide, unusable). Only mount
  // in-flow where children stack vertically; otherwise use the anchored mode.
  function barFlowSafe(p) {
    try {
      if (!p) return false;
      const cs = getComputedStyle(p);
      const d = cs.display || '';
      if (d.indexOf('grid') >= 0 || d.indexOf('inline') === 0) return false;
      if (d.indexOf('flex') >= 0 && !/^column/.test(cs.flexDirection) && cs.flexWrap === 'nowrap') return false;
      return true;
    } catch (e) { return true; }
  }

  function barMountPlan() {
    try {
      const getEd = S.handlers.getComposer;
      if (typeof getEd !== 'function') return null;
      const ed = getEd();
      if (!ed) return null;
      const send = typeof S.handlers.getSendBtn === 'function' ? S.handlers.getSendBtn() : null;
      const site = S.handlers.site || '';
      const box = barComposerBox(ed, send);
      if (!box || box === document.body) return null;
      if (site === 'gemini' ? !barFlowSafe(box.parentElement) : !barFlowSafe(box)) return null;
      if (site === 'deepseek' || site === 'chatgpt') {
        // Insert as the box's FIRST child (above the input), like ZeroScript on
        // DeepSeek — reflows cleanly, spans the full input width.
        let before = box.firstElementChild;
        if (before && (before.id === BAR_ID || before.nodeType !== 1)) before = before.nextElementSibling;
        if (before && before.id === BAR_ID) before = before.nextElementSibling;
        return { parent: box, before: before || null, inside: true };
      }
      if (site === 'gemini') {
        // A real full-width node ABOVE the composer frame (ZeroScript Gemini).
        if (box.parentElement) return { parent: box.parentElement, before: box, inside: false };
      }
      return null; // claude / zai / unknown → anchored mode (never enter their reconciled DOM)
    } catch (e) { return null; }
  }

  function clearAnchorPad() {
    if (barAnchorPad) { try { barAnchorPad.style.paddingTop = ''; } catch (e) { /* ignore */ } barAnchorPad = null; }
  }

  function placeBar() {
    barRaf = requestAnimationFrame(placeBar);
    if (!bar) return;
    try {
      // Self-heal: a SPA navigation can detach the bar — re-append it.
      if (!bar.isConnected) { try { (document.documentElement || document.body).appendChild(bar); } catch (e) { /* ignore */ } }
      // Preferred: in-flow mount (no overlap, full width).
      const plan = barMountPlan();
      if (plan && plan.parent && plan.parent.isConnected) {
        clearAnchorPad();
        if (bar.parentElement !== plan.parent || bar.nextElementSibling !== plan.before) {
          try { plan.parent.insertBefore(bar, plan.before || null); } catch (e) { /* fall through to anchored */ }
        }
        if (bar.parentElement === plan.parent) {
          if (!bar.classList.contains('ob-bar-inline')) {
            bar.classList.add('ob-bar-inline');
            bar.style.cssText = ''; // drop any leftover float positioning
          }
          bar.classList.toggle('ob-bar-inside', !!plan.inside);
          bar.classList.remove('ob-bar-anchored');
          bar.style.display = 'flex';
          return;
        }
      }
      // Anchored: fixed, hugging the composer's top edge; RESERVE the strip via
      // padding-top so it reads as in-flow without entering the framework DOM.
      const getEd = S.handlers.getComposer;
      const ed = typeof getEd === 'function' ? getEd() : null;
      if (ed) {
        const anchor = barComposerBox(ed, typeof S.handlers.getSendBtn === 'function' ? S.handlers.getSendBtn() : null);
        if (anchor && anchor.isConnected && anchor !== document.body) {
          bar.classList.remove('ob-bar-inline', 'ob-bar-inside');
          bar.classList.add('ob-bar-anchored');
          if (bar.parentElement !== (document.documentElement || document.body)) {
            try { document.documentElement.appendChild(bar); } catch (e) { /* ignore */ }
          }
          const r = anchor.getBoundingClientRect();
          if (!r.width) { bar.style.display = 'none'; clearAnchorPad(); return; }
          bar.style.display = 'flex';
          const bh = bar.offsetHeight || 34;
          if (barAnchorPad && barAnchorPad !== anchor) clearAnchorPad();
          barAnchorPad = anchor;
          anchor.style.paddingTop = (bh + 6) + 'px';
          bar.style.left = Math.round(r.left) + 'px';
          bar.style.top = Math.round(r.top) + 'px';
          bar.style.width = Math.round(r.width) + 'px';
          return;
        }
      }
      clearAnchorPad();
      // Final fallback: float just above the editor (fixed positioning).
      bar.classList.remove('ob-bar-anchored');
      if (bar.parentElement !== (document.documentElement || document.body)) {
        try { document.documentElement.appendChild(bar); } catch (e) { /* ignore */ }
      }
      if (!ed) { bar.style.display = 'none'; return; }
      const r = ed.getBoundingClientRect();
      if (!r.width) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';
      const w = Math.min(r.width, 560);
      const bh = bar.offsetHeight || 40;
      bar.style.width = w + 'px';
      bar.style.left = Math.round(r.left + (r.width - w) / 2) + 'px';
      bar.style.top = Math.max(4, Math.round(r.top - bh - 8)) + 'px';
    } catch (e) { /* the loop must never die on a transient DOM state */ }
  }

  // Bar state rendering — signature-deduped (ZeroScript renderBar pattern):
  // touching the DOM only when something changed, so the live dot's CSS
  // animation never stutters from per-tick rewrites.
  function renderBarState() {
    if (!bar) return;
    try {
      const st = S.status, act = S.activity;
      let dot = 'on';
      if (!S.online || st.state === 'offline') dot = 'off';
      else if (st.state === 'question') dot = 'warn';
      let tone = 'idle';
      if (act.kind === 'error' || act.kind === 'question') tone = 'warn';
      else if (act.spinner || st.state === 'thinking' || st.state === 'running' || act.kind === 'active' || act.kind === 'success') tone = 'act';
      const busy = !!(act.spinner || st.state === 'running');
      const text = act.text || st.label || (S.online ? 'Ready' : 'Offline');
      const sig = [dot, tone, text, busy].join('|');
      if (sig === lastBarSig) return;
      lastBarSig = sig;
      const d = bar.querySelector('.ob-dot');
      if (d) d.className = 'ob-dot ' + (dot === 'on' ? (busy ? 'run' : 'on') : dot);
      bar.classList.remove('tone-idle', 'tone-act', 'tone-warn');
      bar.classList.add('tone-' + tone);
      const tx = bar.querySelector('.ob-state-txt');
      if (tx) tx.textContent = text;
    } catch (e) { /* cosmetic */ }
  }

  /* ---------------------------------------------------------------- status */
  const STATE_META = {
    online: { title: 'Ready', icon: 'bot' },
    thinking: { title: 'Thinking', icon: 'bot' },
    running: { title: 'Running', icon: 'terminal' },
    question: { title: 'Waiting for you', icon: 'bot' },
    offline: { title: 'Offline', icon: 'alert' }
  };

  function renderStatus() {
    const { state, label } = S.status;
    const meta = STATE_META[state] || STATE_META.online;
    refs.pill.className = 'pill ' + state;
    refs.pill.textContent = label || meta.title;
    refs.statusBox.className = 'status ' + state;
    refs.stTitle.textContent = label || meta.title;
    refs.stText.textContent = S.activity.text || '';
    // Rebuild the ring only when it actually changes — re-setting innerHTML on every
    // status/activity tick restarted the spinner animation (it looked frozen).
    const spinning = !!(S.activity.spinner || state === 'thinking' || state === 'running');
    const ringSig = spinning ? 'spin' : 'ic:' + meta.icon;
    if (refs.ring.dataset.sig !== ringSig) {
      refs.ring.dataset.sig = ringSig;
      refs.ring.innerHTML = spinning ? '<div class="spin"></div>' : icon(meta.icon, 26);
    }
    refs.sub.textContent = S.online ? (S.info ? `${S.info.user}@${S.info.hostname}` : 'Connected') : 'Not connected';
    refs.ps.textContent = S.info && S.info.isRoot ? '#' : '$';
    renderBarState(); // v1.7: keep the composer bar in the same state

    refs.offlineBox.innerHTML = '';
    if (!S.online) {
      const c = el('div', 'callout');
      c.innerHTML = `${icon('alert', 22)}<div><b>Can't reach your server</b><div class="small" id="offMsg"></div></div>`;
      c.querySelector('#offMsg').textContent = S.lastError || 'Check the server URL and token in Settings.';
      const btn = el('button', 'btn sm', 'Open Settings');
      btn.addEventListener('click', () => setTab('set'));
      c.lastChild.appendChild(btn);
      refs.offlineBox.appendChild(c);
    }
    if (refs.bgCard) refs.bgCard.classList.toggle('hidden', !S.online);
  }

  // v1.7: the floating pill is GONE. "showChip" now flashes its message through
  // the composer bar's state line instead (API kept — content.js calls it).
  function showChip(text, spinner) {
    if (!text) return;
    S.activity = { text, kind: spinner ? 'active' : 'normal', spinner: !!spinner };
    lastBarSig = '';
    if (refs.pill) renderStatus();
    else renderBarState();
  }

  /* -------------------------------------------------------------- terminal */
  function lineNode(e) {
    switch (e.type) {
      case 'command': {
        const d = el('div', 'ln cmd');
        const ps = el('span', 'ps', '$ ');
        d.appendChild(ps); d.appendChild(document.createTextNode(e.text));
        return d;
      }
      case 'stdout': return el('div', 'ln', e.text.replace(/\n$/, ''));
      case 'stderr': return el('div', 'ln stderr', e.text.replace(/\n$/, ''));
      case 'stdin': return el('div', 'ln stdin', '› ' + e.text);
      case 'exit': {
        const ok = e.code === 0;
        return el('div', 'ln exit ' + (ok ? 'good' : 'bad'), `${ok ? '✓' : '✕'} exit ${e.code} · ${fmtDur(e.durationMs)}`);
      }
      default: return null;
    }
  }

  function scrollOut(force) {
    const o = refs.out;
    if (force || S.stick) o.scrollTop = o.scrollHeight;
  }

  function renderEmptyTerm() {
    if (refs.out.children.length) return;
    const d = el('div', 'empty');
    d.innerHTML = icon('terminal', 30);
    d.appendChild(el('div', '', 'Terminal is idle. Run a command below, or let the agent work.'));
    refs.out.appendChild(d);
  }

  function applyTerminal(data) {
    if (!data || !data.success) return;
    if (S.termEpoch && data.epoch !== S.termEpoch) {
      refs.out.innerHTML = ''; S.termSeq = 0;
      if (data.entries.length === 0) { S.termEpoch = data.epoch; renderEmptyTerm(); return; }
    }
    S.termEpoch = data.epoch;
    if (data.cwd && data.cwd !== S.termCwd) {
      S.termCwd = data.cwd;
      refs.cwd.innerHTML = ''; const b = document.createElement('bdi'); b.textContent = data.cwd; refs.cwd.appendChild(b);
    }
    S.termBusy = !!data.busy;
    refs.cmd.placeholder = S.termBusy ? 'Send input…' : 'Run a command…';
    if (refs.termBox) refs.termBox.classList.toggle('busy', S.termBusy);

    const fresh = data.entries.filter(e => e.seq > S.termSeq);
    if (fresh.length) {
      if (refs.out.querySelector('.empty')) refs.out.innerHTML = '';
      const frag = document.createDocumentFragment();
      // Animate only live arrivals — never the first bulk load of history, and
      // never a huge burst (hundreds of simultaneous animations janks phones).
      const animate = S.termSeq > 0 && fresh.length <= 40 && S.open && S.tab === 'term';
      for (const e of fresh) {
        S.termSeq = Math.max(S.termSeq, e.seq);
        if (e.type === 'prompt') { showAsk(e.text); continue; }
        if (e.type === 'command' || e.type === 'stdin' || e.type === 'exit') hideAsk();
        const n = lineNode(e);
        if (n) { if (animate) n.classList.add('fx'); frag.appendChild(n); }
      }
      refs.out.appendChild(frag);
      while (refs.out.children.length > 700) refs.out.removeChild(refs.out.firstChild);
      if (S.tab !== 'term' || !S.open) refs.termBadge.classList.remove('hidden');
      scrollOut(false);
    } else if (!refs.out.children.length) renderEmptyTerm();
    if (!S.termBusy) hideAsk();
  }

  function showAsk(text) {
    refs.askQ.textContent = text;
    refs.ask.classList.remove('hidden');
  }
  function hideAsk() { refs.ask.classList.add('hidden'); }

  async function pollTerminal() {
    if (!S.open || !S.online) return;
    const res = await api('GET', `/api/terminal/history?since=${S.termSeq}`, undefined, 15000);
    applyTerminal(res);
  }

  function pollDelay() {
    if (document.hidden) return 4000;
    if (S.tab === 'term') return S.termBusy ? 500 : 1200;
    return S.termBusy ? 1200 : 2500;
  }

  function startPolling() {
    stopPolling();
    const tick = async () => {
      if (!S.open) return;
      await pollTerminal();
      if (S.tab === 'logs') await loadLogs(true);
      S.pollTimer = setTimeout(tick, pollDelay());
    };
    S.pollTimer = setTimeout(tick, 100);
  }
  function stopPolling() { clearTimeout(S.pollTimer); S.pollTimer = null; }

  async function sendCommand(text) {
    const value = text.trim();
    if (!value) return;
    if (S.termBusy) {
      S.histIdx = -1;
      const r = await api('POST', '/api/terminal/input', { input: value }, 40000);
      if (r && r.success === false && r.message) toast(r.message);
      pollTerminal();
      return;
    }
    S.termHistory.unshift(value);
    S.termHistory = S.termHistory.slice(0, 80);
    S.histIdx = -1;
    S.stick = true;
    api('POST', '/api/terminal/exec', { command: value, timeoutMs: 120000 }, 130000).then(() => pollTerminal());
    setTimeout(pollTerminal, 150);
  }

  function initTerminal() {
    refs.cmdForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = refs.cmd.value;
      refs.cmd.value = '';
      sendCommand(v);
    });
    refs.termClear.addEventListener('click', async () => { await api('POST', '/api/terminal/clear', {}); refs.out.innerHTML = ''; S.termSeq = 0; renderEmptyTerm(); });
    refs.out.addEventListener('scroll', () => {
      const o = refs.out;
      S.stick = o.scrollHeight - o.scrollTop - o.clientHeight < 40;
      refs.jump.classList.toggle('hidden', S.stick);
    });
    refs.jump.addEventListener('click', () => { S.stick = true; scrollOut(true); });
    refs.ask.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-ans]');
      if (!b) return;
      api('POST', '/api/terminal/input', { input: b.dataset.ans }, 40000).then(pollTerminal);
      hideAsk();
    });

    const quick = [
      { t: 'ls -la', c: 'ls -la' }, { t: 'git status', c: 'git status' }, { t: 'df -h', c: 'df -h' },
      { t: 'pm2 ls', c: 'pm2 ls' }, { t: 'free -h', c: 'free -h' }, { t: 'docker ps', c: 'docker ps' }
    ];
    const mk = (label, cls, fn) => { const b = el('button', 'qk ' + (cls || ''), label); b.type = 'button'; b.addEventListener('click', fn); refs.quick.appendChild(b); return b; };
    // v1.8.2: quick chips only FILL the command box (tap Run to send it) — they no
    // longer focus the field, which popped the on-screen keyboard on every tap.
    mk('↑', '', () => { if (S.histIdx < S.termHistory.length - 1) { S.histIdx++; refs.cmd.value = S.termHistory[S.histIdx]; focusIfDesktop(refs.cmd); } });
    mk('↓', '', () => { if (S.histIdx > 0) { S.histIdx--; refs.cmd.value = S.termHistory[S.histIdx]; } else { S.histIdx = -1; refs.cmd.value = ''; } });
    mk('Ctrl+C', 'danger', async () => { const r = await api('POST', '/api/terminal/kill', {}); toast(r.message || (r.success ? 'Stopped' : 'Nothing running')); pollTerminal(); });
    for (const q of quick) mk(q.t, '', () => { refs.cmd.value = q.c; focusIfDesktop(refs.cmd); });
    mk('clear', '', () => refs.termClear.click());
  }

  /* ----------------------------------------------------------------- files */
  async function loadFiles(path) {
    if (!S.online) { refs.fList.innerHTML = ''; refs.fList.appendChild(el('div', 'empty', 'Connect to your server first.')); return; }
    const q = path ? `?path=${encodeURIComponent(path)}` : `?path=${encodeURIComponent(S.termCwd || '.')}`;
    refs.fList.innerHTML = '';
    refs.fList.appendChild(el('div', 'empty', 'Loading…'));
    const r = await api('GET', '/api/fs/list' + q, undefined, 20000);
    refs.fList.innerHTML = '';
    if (!r.success) {
      refs.fList.appendChild(el('div', 'empty', r.error || 'Could not list folder'));
      return;
    }
    S.filesLoaded = true;
    S.filesPath = r.path; S.filesParent = r.parent;
    refs.fPath.innerHTML = ''; const b = document.createElement('bdi'); b.textContent = r.path; refs.fPath.appendChild(b);
    refs.fUp.disabled = !r.parent;
    if (!r.entries.length) { refs.fList.appendChild(el('div', 'empty', 'This folder is empty.')); return; }
    const frag = document.createDocumentFragment();
    for (const e of r.entries) {
      const it = el('div', 'item' + (e.dir ? ' dir' : ''));
      const main = el('button', 'item-main');
      main.type = 'button';
      const ic = el('span', 'ic'); ic.innerHTML = icon(e.dir ? 'folder' : 'file', 18);
      const tx = el('span', 'grow');
      tx.appendChild(el('div', 'nm', e.name));
      tx.appendChild(el('div', 'meta', e.dir ? 'Folder' : `${fmtBytes(e.size)}${e.mtime ? ' · ' + fmtDate(e.mtime) : ''}`));
      main.appendChild(ic); main.appendChild(tx);
      const full = (r.path.endsWith('/') ? r.path : r.path + '/') + e.name;
      main.addEventListener('click', () => (e.dir ? loadFiles(full) : openFile(full, e.name)));
      it.appendChild(main);
      const acts = el('div', 'acts');
      const act = (label, icn, fn) => {
        const b = el('button', 'act');
        b.type = 'button'; b.title = label; b.setAttribute('aria-label', label + ' ' + e.name);
        b.innerHTML = icon(icn, 16);
        b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
        acts.appendChild(b);
      };
      if (!e.dir) act('Download', 'download', () => downloadFile(full, e.name));
      if (!e.dir && /\.(txt|md|markdown|log)$/i.test(e.name)) act('Save as prompt', 'zap', () => fileToPrompt(full, e.name));
      act('Zip', 'archive', () => zipOne(full, e.name));
      if (ARCHIVE_RE.test(e.name)) act('Extract', 'upload', () => extractArchive(full, e.name));
      it.appendChild(acts);
      frag.appendChild(it);
    }
    refs.fList.appendChild(frag);
  }

  const ARCHIVE_RE = /\.(zip|tar|gz|tgz|bz2|xz)$/i;

  function msgApi(req) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(req, (res) => {
          if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
          else resolve(res || { success: false, error: 'No response' });
        });
      } catch (e) { resolve({ success: false, error: e.message }); }
    });
  }

  function fileToB64(file) {
    return new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(String(rd.result).slice(String(rd.result).indexOf(',') + 1));
      rd.onerror = () => reject(new Error('Could not read ' + file.name));
      rd.readAsDataURL(file);
    });
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!S.online) { toast('Connect to the server first'); return; }
    let lastDir = null;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.size > 100 * 1024 * 1024) { toast(`${f.name}: over 100 MB — upload it via scp or split the zip`); continue; }
      toast(`Uploading ${i + 1}/${files.length}: ${f.name}…`);
      try {
        const b64 = await fileToB64(f);
        const res = await msgApi({ type: 'UPLOAD', name: f.name, b64 });
        if (res && res.success) {
          lastDir = String(res.path || '').slice(0, String(res.path || '').lastIndexOf('/'));
          toast(`Uploaded ${f.name} (${fmtBytes(res.size)})`);
        } else {
          toast(`${f.name}: ${(res && res.error) || 'upload failed'}`);
        }
      } catch (e) { toast(`${f.name}: ${e.message}`); }
    }
    if (lastDir) { S.filesLoaded = true; loadFiles(lastDir); }
  }

  async function downloadFile(full, name) {
    toast('Downloading ' + name + '…');
    const r = await msgApi({ type: 'DOWNLOAD', path: full });
    if (!r.success) { toast(r.error || 'Download failed'); return; }
    const a = document.createElement('a');
    a.href = r.dataUrl;
    a.download = r.name || name;
    document.body.appendChild(a); a.click(); a.remove();
    toast('Saved ' + (r.name || name) + ' (' + fmtBytes(r.size) + ')');
  }

  async function fileToPrompt(full, name) {
    const h = S.handlers;
    if (!h.onSaveCustomPrompt) { toast('Engine not ready'); return; }
    toast('Reading ' + name + '…');
    const r = await api('GET', '/api/fs/read?path=' + encodeURIComponent(full), undefined, 20000);
    if (!r || !r.success) { toast((r && r.error) || 'Could not read the file'); return; }
    if (r.binary) { toast('Binary file — only text (.txt / .md) can become a prompt'); return; }
    const text = String(r.content || '').trim();
    if (!text) { toast('This file is empty'); return; }
    const short = (name.replace(/\.(txt|md|markdown|log)$/i, '') || 'Prompt').slice(0, 28);
    await h.onSaveCustomPrompt(short, text.slice(0, 200000));
    toast('Saved as prompt: ' + short);
    renderSavedChips(refs.qSaved);
  }

  async function zipOne(full, name) {
    toast('Zipping ' + name + '…');
    const r = await api('POST', '/api/fs/zip', { paths: [full] }, 10 * 60 * 1000);
    if (r && r.success) {
      toast('Created ' + String(r.out || '').split('/').pop() + ' (' + fmtBytes(r.sizeBytes) + ')');
      loadFiles(S.filesPath);
    } else toast((r && r.error) || 'Zip failed');
  }

  async function extractArchive(full, name) {
    toast('Extracting ' + name + '…');
    const r = await api('POST', '/api/fs/unzip', { path: full }, 10 * 60 * 1000);
    if (r && r.success) {
      toast(`Extracted ${r.extractedCount} item(s) -> ${String(r.dest || '').split('/').pop()}`);
      loadFiles(S.filesPath);
    } else toast((r && r.error) || 'Extract failed');
  }

  async function openFile(full, name) {
    refs.viewer.classList.remove('hidden');
    refs.vName.textContent = full;
    refs.vText.textContent = 'Loading…';
    const r = await api('GET', '/api/fs/read?path=' + encodeURIComponent(full), undefined, 20000);
    if (!r.success) { refs.vText.textContent = r.error || 'Could not read file'; return; }
    if (r.binary) { refs.vText.textContent = `Binary file (${fmtBytes(r.size)}). Preview not available.`; S.viewerText = ''; return; }
    S.viewerText = r.content;
    refs.vText.textContent = r.content + (r.truncated ? `\n\n… truncated (${fmtBytes(r.size)} total)` : '');
  }

  function initFiles() {
    refs.fUp.addEventListener('click', () => S.filesParent && loadFiles(S.filesParent));
    refs.fRefresh.addEventListener('click', () => loadFiles(S.filesPath));
    refs.fUpload.addEventListener('click', () => { if (!S.online) { toast('Connect to the server first'); return; } refs.fFile.click(); });
    refs.fFile.addEventListener('change', () => { const fl = refs.fFile.files; refs.fFile.value = ''; uploadFiles(fl); });
    refs.vBack.addEventListener('click', () => refs.viewer.classList.add('hidden'));
    refs.vCopy.addEventListener('click', () => copyText(S.viewerText || refs.vName.textContent, 'Copied'));
  }

  /* ------------------------------------------------------------------ logs */
  async function loadLogs(quiet) {
    const r = await api('GET', '/api/logs', undefined, 15000);
    if (!r || !r.logs) { if (!quiet) { refs.logList.innerHTML = ''; refs.logList.appendChild(el('div', 'empty', r && r.error ? r.error : 'No logs')); } return; }
    const sig = r.logs.length ? r.logs[0].timestamp + r.logs.length : '';
    if (quiet && sig === S.logSig) return;
    S.logSig = sig;
    refs.logList.innerHTML = '';
    if (!r.logs.length) { refs.logList.appendChild(el('div', 'empty', 'No tool calls yet.')); return; }
    for (const l of r.logs) {
      const b = el('button', 'log');
      b.type = 'button';
      const top = el('div', 'top');
      const st = el('span', 'st ' + (l.success ? 'ok' : 'bad')); st.innerHTML = icon(l.success ? 'check' : 'x', 15);
      top.appendChild(st);
      top.appendChild(el('span', 'tn grow', l.tool));
      top.appendChild(el('span', 'muted small', `${fmtDur(l.durationMs)} · ${fmtClock(l.timestamp)}`));
      b.appendChild(top);
      const brief = l.success ? (l.resultSummary || 'OK') : (l.error || 'Failed');
      const summary = el('div', 'sum', brief);
      b.appendChild(summary);
      const det = el('div', 'det hidden');
      const code = el('div', 'code'); code.textContent = JSON.stringify(l.params || {}, null, 2);
      det.appendChild(code);
      b.appendChild(det);
      b.addEventListener('click', () => { b.classList.toggle('exp'); det.classList.toggle('hidden'); });
      refs.logList.appendChild(b);
    }
  }

  /* ------------------------------------------------------------------ info */
  function meter(label, value, text, pct) {
    const m = el('div', 'meter');
    const top = el('div', 'top'); top.appendChild(el('span', '', label)); top.appendChild(el('span', 'muted', text));
    const bar = el('div', 'bar'); const i = document.createElement('i'); i.style.width = clamp(pct, 0, 100) + '%'; if (pct > 85) i.className = 'hot';
    bar.appendChild(i); m.appendChild(top); m.appendChild(bar);
    return m;
  }

  async function loadInfo() {
    if (!S.online) { refs.srvBody.textContent = 'Not connected.'; return; }
    const r = await api('GET', '/api/info', undefined, 20000);
    if (!r.success) { refs.srvBody.textContent = r.error || 'Could not load server info'; return; }
    S.info = r.info;
    const i = r.info;
    refs.srvBody.innerHTML = '';
    const tags = el('div', 'tags');
    for (const [k, v] of [['OS', i.os], ['User', i.user + (i.isRoot ? ' (root)' : '')], ['CPU', i.cpus + ' cores'], ['Node', i.node || ''], ['Up', (i.uptime || '').replace(/^up /, '')]]) {
      const t = el('span', 'tag'); const b = el('b', '', k + ' '); t.appendChild(b); t.appendChild(document.createTextNode(v)); tags.appendChild(t);
    }
    refs.srvBody.appendChild(tags);
    if (i.memory) refs.srvBody.appendChild(meter('Memory', 0, `${i.memory.usedMB} / ${i.memory.totalMB} MB`, (i.memory.usedMB / i.memory.totalMB) * 100));
    if (i.disk) refs.srvBody.appendChild(meter('Disk', 0, `${i.disk.used} / ${i.disk.size}`, parseInt(i.disk.usedPercent, 10) || 0));
    if (i.loadAvg) refs.srvBody.appendChild(meter('Load', 0, i.loadAvg.join(' · '), (i.loadAvg[0] / Math.max(1, i.cpus)) * 100));
    const wsInfo = el('div', 'small muted'); wsInfo.style.marginTop = '12px'; wsInfo.textContent = 'Workspace: ' + i.workspaceRoot;
    refs.srvBody.appendChild(wsInfo);
    renderStatus();
  }

  /* ---------------------------------------- v1.1: queue / quick prompt / VPS */
  function renderQueueBadge() {
    if (refs.qCount) refs.qCount.textContent = `(${S.queueCount}${S.queuePaused ? ' · paused' : ''})`;
    if (refs.qCountLbl) refs.qCountLbl.textContent = String(S.queueCount);
    if (refs.queueCard) refs.queueCard.classList.toggle('hidden', S.queueCount === 0);
    if (refs.qPause) refs.qPause.innerHTML = icon(S.queuePaused ? 'play' : 'pause', 15);
  }

  async function renderQueue() {
    const h = S.handlers;
    if (!h.onQueueList) { renderQueueBadge(); return; }
    const r = await h.onQueueList();
    const items = (r && r.items) || [];
    S.queuePaused = !!(r && r.paused);
    S.queueCount = items.length;
    renderQueueBadge();
    if (!refs.qList) return;
    refs.qList.innerHTML = '';
    for (const it of items) {
      const row = el('button', 'qrow');
      row.type = 'button';
      const tx = el('span', 'grow');
      tx.appendChild(el('div', 'tx', it.text));
      let when = '';
      try { when = new Date(it.addedAt || Date.now()).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { /* ignore */ }
      tx.appendChild(el('div', 'meta', when));
      row.appendChild(tx);
      const run = el('span', 'act');
      run.innerHTML = icon('play', 15);
      run.title = 'Send now';
      run.addEventListener('click', (ev) => { ev.stopPropagation(); h.onQueueAction && h.onQueueAction('runNow', it.id); });
      const del = el('span', 'act');
      del.innerHTML = icon('x', 15);
      del.title = 'Remove';
      del.addEventListener('click', (ev) => { ev.stopPropagation(); h.onQueueAction && h.onQueueAction('remove', it.id); });
      row.appendChild(run);
      row.appendChild(del);
      refs.qList.appendChild(row);
    }
  }

  function setQueueInfo(count, paused) {
    S.queueCount = count | 0;
    S.queuePaused = !!paused;
    renderQueueBadge();
    if (S.open && S.tab === 'agent') renderQueue();
  }

  async function renderSavedChips(target) {
    if (!target) return;
    const h = S.handlers;
    const list = h.onListCustomPrompts ? await h.onListCustomPrompts() : [];
    target.innerHTML = '';
    for (const c of list) {
      const chip = el('span', 'chipbtn');
      chip.appendChild(el('span', 'nm', c.name || 'Prompt'));
      const x = el('i', 'chipx', '×');
      x.title = 'Delete';
      chip.appendChild(x);
      chip.addEventListener('click', (ev) => {
        if (ev.target === x) {
          h.onDeleteCustomPrompt && h.onDeleteCustomPrompt(c.id).then(() => { renderSavedChips(refs.qSaved); renderSavedChips(refs.qpSaved); });
          return;
        }
        if (S.open && !refs.qModal.classList.contains('hidden') && target === refs.qpSaved) {
          refs.qpText.value = c.text;
          refs.qpName.value = c.name || '';
        } else openQuickPrompt(c.text, c.name);
      });
      target.appendChild(chip);
    }
  }

  function openQuickPrompt(prefill, prename) {
    refs.qpText.value = prefill || '';
    refs.qpName.value = prename || '';
    renderSavedChips(refs.qpSaved);
    refs.qModal.classList.remove('hidden');
    setTimeout(() => focusIfDesktop(refs.qpText), 80);
  }
  function closeQuickPrompt() {
    if (refs.qModal) refs.qModal.classList.add('hidden');
  }

  async function initQuickPrompt() {
    // v1.7: the qfab launcher is gone — quick prompts open from the panel's
    // "New prompt" button (and the queue card) now.
    refs.qNew.addEventListener('click', () => openQuickPrompt());
    refs.qOpenQueue.addEventListener('click', () => {
      renderQueue();
      if (S.queueCount === 0) toast('Queue is empty — add prompts with New prompt');
    });
    refs.qpCancel.addEventListener('click', closeQuickPrompt);
    refs.qModal.addEventListener('click', (e) => { if (e.target === refs.qModal) closeQuickPrompt(); });
    const qAction = async (mode) => {
      const text = refs.qpText.value.trim();
      if (!text) { toast('Type a prompt first'); return; }
      const h = S.handlers;
      if (!h.onQuickSend) { toast('Engine not ready'); return; }
      if (mode === 'save') {
        await h.onSaveCustomPrompt(refs.qpName.value, text);
        renderSavedChips(refs.qSaved);
        renderSavedChips(refs.qpSaved);
        toast('Saved');
        return;
      }
      const r = await h.onQuickSend(text, mode);
      if (r === 'sent') { toast('Sent to the chat'); closeQuickPrompt(); }
      else if (r === 'queued') closeQuickPrompt();
      else toast(r || 'Done');
    };
    refs.qpSend.addEventListener('click', () => qAction('send'));
    refs.qpQueue.addEventListener('click', () => qAction('queue'));
    refs.qpSave.addEventListener('click', () => qAction('save'));
    // Import prompts from .txt / .md files on the device (v1.2)
    refs.qpImport.addEventListener('click', () => refs.qpFile.click());
    refs.qpFile.addEventListener('change', async () => {
      const files = Array.from(refs.qpFile.files || []);
      refs.qpFile.value = '';
      if (!files.length) return;
      const h = S.handlers;
      if (!h.onSaveCustomPrompt) { toast('Engine not ready'); return; }
      let n = 0;
      for (const f of files) {
        if (f.size > 200 * 1024) { toast(`${f.name}: over 200 KB — split it first`); continue; }
        try {
          const text = await f.text();
          if (!text.trim()) { toast(`${f.name}: empty file`); continue; }
          const name = (f.name.replace(/\.(txt|md|markdown)$/i, '') || 'Prompt').slice(0, 28);
          await h.onSaveCustomPrompt(name, text.trim());
          n++;
        } catch (e) { toast(`${f.name}: ${e.message}`); }
      }
      if (n) {
        toast(`Saved ${n} prompt${n > 1 ? 's' : ''} from files`);
        renderSavedChips(refs.qSaved);
        renderSavedChips(refs.qpSaved);
      }
    });
  }

  /* --------------------------------------- live feed + installer (v1.2) */
  let livePort = null;
  let liveRetryT = null;
  const liveRows = new Map(); // event id -> { row, meta }
  const liveSeen = new Set(); // event ids already shown (replays on reconnect must not duplicate)
  const INST_STEPS = [
    ['node', 'Check Node.js'], ['workspace', 'Verify workspace'], ['token', 'Check auth token'],
    ['service', 'Write systemd unit'], ['reload', 'Reload systemd'], ['enable', 'Enable on boot'],
    ['start', 'Start the service'], ['verify', 'Verify it is alive']
  ];
  let instStepEls = {};

  function liveSetDot(state) { if (refs.liveDot) refs.liveDot.className = 'livedot ' + state; }

  function liveIconClass(t) {
    return /^(terminal_|run_command|parallel_commands|start_background|stop_background|tail_log|list_background)/.test(t) ? 'ic-term'
      : /file|dir|zip|unzip|move|copy|search|make_dir|batch/.test(t) ? 'ic-file'
      : /web|fetch/.test(t) ? 'ic-web' : '';
  }
  function liveIconChar(t) {
    if (t === 'upload') return '↑';
    if (/^(terminal_|run_command)/.test(t)) return '$';
    if (t === 'parallel_commands') return '⫴';
    if (/^(start_background|stop_background|tail_log|list_background)/.test(t)) return 'bg';
    if (/^(read_file|write_file|edit_file|list_dir|search_files|make_dir|delete_file|file_exists|batch_write|zip|unzip|move|copy)/.test(t)) return 'F';
    if (/(web|fetch)/.test(t)) return 'W';
    if (/^git_/.test(t)) return 'G';
    if (/^mcp_/.test(t)) return 'M';
    return '*';
  }

  function liveAddRow(id, tool, summary, ts, replayed) {
    if (refs.liveEmpty && refs.liveEmpty.parentNode) refs.liveEmpty.remove();
    const row = el('div', 'lrow' + (replayed ? ' still' : ''));
    const ic = el('span', 'lic ' + liveIconClass(tool), liveIconChar(tool));
    const main = el('div', 'lmain');
    const top = el('div', 'ltop');
    top.appendChild(el('b', 'ltool', tool));
    top.appendChild(el('span', 'ltime', fmtClock(ts || new Date().toISOString())));
    const sum = el('div', 'lsum', summary || '');
    const meta = el('div', 'lmeta');
    const sp = el('span', 'lspin');
    meta.appendChild(sp);
    meta.appendChild(el('span', 'lrun', 'running…'));
    main.appendChild(top); main.appendChild(sum); main.appendChild(meta);
    row.appendChild(ic); row.appendChild(main);
    refs.liveFeed.prepend(row);
    while (refs.liveFeed.children.length > 80) refs.liveFeed.lastChild.remove();
    if (id) liveRows.set(id, { row, meta });
  }

  function liveEndRow(id, ok, durationMs, summary) {
    const found = liveRows.get(id);
    if (!found) return;
    liveRows.delete(id);
    found.meta.textContent = '';
    found.meta.appendChild(el('span', ok ? 'lok' : 'lbad',
      ok ? `✓ done${durationMs != null ? ' · ' + fmtDur(durationMs) : ''}`
         : `✗ failed${summary ? ' — ' + String(summary).slice(0, 70) : ''}`));
    found.row.classList.add(ok ? 'okf' : 'badf');
    setTimeout(() => { if (found.row) found.row.classList.remove('okf', 'badf'); }, 900);
  }

  function handleLiveEvent(e, replayed) {
    if (!e || !e.type) return;
    // v1.8.2: the server's replay is already oldest -> newest and rows are PREPENDED
    // (newest on top). It used to be reversed, so a tool's "end" arrived before its
    // "start" (rows stuck on "running…" forever), the oldest sat on top, and every
    // reconnect re-added the whole replay. Now: chronological + de-duplicated.
    if (e.type === 'init') { (e.replay || []).forEach((x) => handleLiveEvent(x, true)); return; }
    if (e.type === 'tool_start') {
      if (e.id && liveSeen.has(e.id)) return;
      if (e.id) { liveSeen.add(e.id); if (liveSeen.size > 400) liveSeen.delete(liveSeen.values().next().value); }
      liveAddRow(e.id, e.tool, e.summary, e.ts, replayed);
    } else if (e.type === 'tool_end') liveEndRow(e.id, e.ok, e.durationMs, e.summary);
    else if (e.type === 'upload') {
      const k = 'u:' + e.ts + ':' + e.name;
      if (liveSeen.has(k)) return;
      liveSeen.add(k);
      liveAddRow(null, 'upload', `${e.name} (${fmtBytes(e.size)})`, e.ts, replayed);
    } else if (e.type === 'install' && !replayed) handleInstallEvent(e);
  }

  function startLive() {
    if (!alive()) { liveSetDot('off'); return; }
    if (livePort) return; // already open or connecting
    liveSetDot('wait');
    try {
      livePort = chrome.runtime.connect({ name: 'ob-events' });
      livePort.onMessage.addListener((m) => {
        if (!m) return;
        if (m.type === 'EVENTS_OPEN') { liveSetDot('on'); return; }
        if (m.type === 'EVENT') { handleLiveEvent(m.evt); return; }
        if (m.type === 'EVENTS_CLOSED' || m.type === 'EVENTS_ERR') {
          try { livePort.disconnect(); } catch (e) { /* ignore */ }
          livePort = null;
          liveSetDot('off');
          scheduleLiveRetry();
        }
      });
      livePort.onDisconnect.addListener(() => {
        livePort = null;
        liveSetDot('off');
        scheduleLiveRetry();
      });
    } catch (e) {
      livePort = null;
      liveSetDot('off');
      scheduleLiveRetry();
    }
  }
  function scheduleLiveRetry() {
    if (liveRetryT || !S.open) return;
    liveRetryT = setTimeout(() => { liveRetryT = null; startLive(); }, 4000);
  }
  function stopLive() {
    if (liveRetryT) { clearTimeout(liveRetryT); liveRetryT = null; }
    if (livePort) { try { livePort.disconnect(); } catch (e) { /* ignore */ } livePort = null; }
    liveSetDot('off');
  }

  function renderInstSteps(steps) {
    const list = (steps && steps.length) ? steps
      : INST_STEPS.map(([id, label]) => ({ id, label, state: 'pending', output: '' }));
    refs.instSteps.textContent = '';
    instStepEls = {};
    list.forEach((s, i) => {
      const d = el('div', 'istep' + (s.state === 'running' ? ' run' : s.state === 'done' ? ' done' : s.state === 'fail' ? ' fail' : ''));
      const num = el('span', 'inum', s.state === 'done' ? '✓' : s.state === 'fail' ? '✕' : String(i + 1));
      const body = el('div', 'ibody');
      body.appendChild(el('div', 'ilabel', s.label));
      if (s.hint) body.appendChild(el('div', 'ihint', '$ ' + s.hint));
      if (s.output) body.appendChild(el('div', 'iout', s.output));
      d.appendChild(num); d.appendChild(body);
      refs.instSteps.appendChild(d);
      instStepEls[s.id] = d;
    });
    const doneCount = list.filter((x) => x.state === 'done').length;
    setInstProgress(doneCount, list.length);
  }
  function setInstProgress(done, total) { refs.instFill.style.width = (total ? Math.round(done / total * 100) : 0) + '%'; }
  async function loadInstallState() {
    try {
      const r = await api('GET', '/api/install/state', undefined, 20000);
      const st = r && r.state;
      if (!st) return;
      renderInstSteps(st.steps && st.steps.length ? st.steps : null);
      if (st.running) refs.instRun.setAttribute('disabled', '');
      else refs.instRun.removeAttribute('disabled');
    } catch (e) { renderInstSteps(null); }
  }
  async function runInstaller() {
    if (!S.online) { toast('Connect to the server first'); return; }
    refs.instRun.setAttribute('disabled', '');
    renderInstSteps(null);
    setInstProgress(0, INST_STEPS.length);
    const r = await api('POST', '/api/install/run', {}, 30000).catch((e) => ({ success: false, error: e.message }));
    if (!r || !r.success) {
      toast((r && (r.reason || r.error)) || 'Could not start the installer');
      refs.instRun.removeAttribute('disabled');
    } else {
      toast('Installing — watch the steps');
    }
  }
  function handleInstallEvent(e) {
    if (e.phase === 'start') { renderInstSteps(null); setInstProgress(0, e.total || INST_STEPS.length); toast('Install started'); return; }
    if (e.phase === 'step') {
      const d = instStepEls[e.id];
      if (!d) return;
      d.classList.remove('run', 'done', 'fail');
      if (e.state === 'running') d.classList.add('run');
      if (e.state === 'done') d.classList.add('done');
      if (e.state === 'fail') d.classList.add('fail');
      const num = d.querySelector('.inum');
      if (num && e.state === 'done') num.textContent = '✓';
      if (num && e.state === 'fail') num.textContent = '✕';
      if (e.output) {
        let o = d.querySelector('.iout');
        if (!o) { o = el('div', 'iout'); d.querySelector('.ibody').appendChild(o); }
        o.textContent = e.output;
      }
      if (e.progress != null && e.total) setInstProgress(e.progress, e.total);
      return;
    }
    if (e.phase === 'done') {
      setInstProgress(e.total || INST_STEPS.length, e.total || INST_STEPS.length);
      refs.instRun.removeAttribute('disabled');
      toast(e.ok ? 'Service installed — reboot-proof now' : 'Finished with errors — read the step outputs');
      loadInstallState();
    }
  }

  async function loadBgJobs() {
    const h = S.handlers;
    if (!h.onListBackgroundJobs || !S.online) return;
    refs.bgBody.textContent = 'Loading…';
    const r = await h.onListBackgroundJobs();
    const res = r && r.result;
    const procs = res && Array.isArray(res.processes) ? res.processes : null;
    if (!procs) {
      refs.bgBody.textContent = (r && (r.error || (res && res.error))) || 'Could not load background jobs.';
      return;
    }
    refs.bgBody.innerHTML = '';
    if (!procs.length) { refs.bgBody.textContent = 'No background jobs on the server right now.'; return; }
    for (const p of procs) {
      const row = el('div', 'bjob');
      const st = el('span', 'st2' + (p.running ? '' : ' dead'));
      const nm = el('span', 'nm2');
      nm.appendChild(el('b', '', p.name || '?'));
      let since = '';
      try { since = String(p.startedAt || '').slice(5, 16).replace('T', ' '); } catch (e) { /* ignore */ }
      nm.appendChild(el('small', '', `pid ${p.pid != null ? p.pid : '?'} · since ${since}`));
      row.appendChild(st);
      row.appendChild(nm);
      refs.bgBody.appendChild(row);
    }
  }

  /* ------------------------------- multi-VPS profiles (Settings tab) */
  async function persistProfiles() {
    await new Promise((res) => chrome.storage.local.set({ vpsProfiles: S.profiles, activeVps: S.activeVps }, res));
    const act = S.profiles.find((p) => p.id === S.activeVps);
    if (act) await new Promise((res) => chrome.storage.local.set({ serverUrl: act.url, authToken: act.token }, res));
  }

  function fillConnEditor() {
    const p = S.profiles.find((x) => x.id === S.activeVps) || S.profiles[0];
    refs.connTitle.textContent = p ? `Connection — ${p.name}` : 'Connection';
    if (p) { refs.setUrl.value = p.url || ''; refs.setTok.value = p.token || ''; }
    if (refs.chatVpsRow) refs.chatVpsRow.style.display = S.profiles.length > 1 ? '' : 'none';
  }

  function renderVpsList() {
    refs.vpsList.innerHTML = '';
    if (!S.profiles.length) { refs.vpsList.appendChild(el('div', 'empty', 'No servers yet — add one below.')); return; }
    for (const p of S.profiles) {
      const row = el('button', 'vpsrow' + (p.id === S.activeVps ? ' on' : ''));
      row.type = 'button';
      row.appendChild(el('span', 'rd'));
      const nm = el('span', 'nm2');
      nm.appendChild(el('b', '', p.name || 'VPS'));
      nm.appendChild(el('small', '', (p.url || 'not configured').replace(/^https?:\/\//, '')));
      row.appendChild(nm);
      const probe = el('span', 'act');
      probe.innerHTML = icon('refresh', 14);
      probe.title = 'Test this server';
      probe.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        toast(`Testing ${p.name}…`);
        const r = await msgApi({ type: 'PROFILE_PROBE', profileId: p.id });
        toast(r && r.status === 'online' ? `${p.name}: online (${r.user}@${r.host})` : `${p.name}: ${(r && r.error) || 'offline'}`);
      });
      row.appendChild(probe);
      if (S.profiles.length > 1) {
        const del = el('span', 'act');
        del.innerHTML = icon('trash', 14);
        del.title = 'Remove';
        del.addEventListener('click', (ev) => { ev.stopPropagation(); removeProfile(p.id); });
        row.appendChild(del);
      }
      row.addEventListener('click', async () => {
        S.activeVps = p.id;
        await persistProfiles();
        renderVpsList();
        fillConnEditor();
        toast(`${p.name} selected — new chats will use it`);
        S.handlers.recheck && S.handlers.recheck();
      });
      refs.vpsList.appendChild(row);
    }
  }

  async function loadVpsState() {
    const h = S.handlers;
    if (h.onListVps) {
      const r = await h.onListVps();
      S.profiles = (r && r.profiles) || [];
      S.multiVps = !!(r && r.multiVps);
    } else {
      const r = await new Promise((res) => chrome.storage.local.get(['vpsProfiles', 'obMultiVps'], (x) => res(x || {})));
      S.profiles = Array.isArray(r.vpsProfiles) ? r.vpsProfiles : [];
      S.multiVps = !!r.obMultiVps;
    }
    if (!S.profiles.length) {
      const lr = await new Promise((res) => chrome.storage.local.get(['serverUrl', 'authToken'], (x) => res(x || {})));
      if (lr.serverUrl) {
        S.profiles = [{ id: 'vps1', name: 'VPS 1', url: lr.serverUrl, token: lr.authToken || '' }];
        S.activeVps = 'vps1';
        await persistProfiles();
      }
    }
    if (!S.activeVps || !S.profiles.some((p) => p.id === S.activeVps)) {
      S.activeVps = S.profiles[0] ? S.profiles[0].id : null;
      if (S.activeVps) await persistProfiles();
    }
    refs.multiSwitch.classList.toggle('on', S.multiVps);
    renderVpsList();
    fillConnEditor();
  }

  async function addProfile() {
    const p = { id: 'vps' + Date.now().toString(36), name: `VPS ${S.profiles.length + 1}`, url: '', token: '' };
    S.profiles.push(p);
    S.activeVps = p.id;
    await persistProfiles();
    renderVpsList();
    fillConnEditor();
    focusIfDesktop(refs.setUrl);
  }

  async function removeProfile(id) {
    S.profiles = S.profiles.filter((p) => p.id !== id);
    if (S.activeVps === id) S.activeVps = S.profiles[0] ? S.profiles[0].id : null;
    await persistProfiles();
    renderVpsList();
    fillConnEditor();
  }

  function setChatVps(name) {
    S.chatVps = name || '';
    if (refs.chatVpsName) refs.chatVpsName.textContent = S.chatVps || '—';
    if (refs.chatVpsRow && S.chatVps) refs.chatVpsRow.style.display = '';
  }

  function confirmBatch(calls) {
    return new Promise((resolve) => {
      const m = el('div', 'modal');
      m.innerHTML = `<div class="mcard"><h3>Run ${calls.length} tools in parallel?</h3><p></p><div class="code"></div><div class="actions"><button class="btn" data-r="0">Reject all</button><button class="btn primary" data-r="1">Approve &amp; run</button></div></div>`;
      m.querySelector('p').textContent = 'The AI wants to run: ' + calls.map((c) => c.tool).join(', ');
      m.querySelector('.code').textContent = calls.map((c) => `${c.tool} ${JSON.stringify(c.params || {}).slice(0, 300)}`).join('\n\n');
      m.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-r]');
        if (!b) return;
        m.remove();
        resolve(b.dataset.r === '1');
      });
      R.appendChild(m);
      try { navigator.vibrate && navigator.vibrate(40); } catch (e) { /* ignore */ }
    });
  }

  /* -------------------------------------------------------------- settings */
  function fillSettings() {
    // URL/token fields are owned by the VPS profile editor (loadVpsState); this
    // only fills the workspace card.
    api('GET', '/api/status', undefined, 10000).then((r) => {
      if (r && r.workspaceRoot) {
        refs.setWs.value = r.workspaceRoot;
        refs.strictSwitch.classList.toggle('on', !!r.strictWorkspace);
        S.strict = !!r.strictWorkspace;
      }
    });
  }

  /* ------------------------------------------------------- VPS setup guide */
  // v1.8.2: `row` used to be declared INSIDE guideSteps() but called from renderGuide(),
  // so opening Settings → VPS setup guide threw "row is not defined" and showed nothing.
  const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const guideCmd = (cmd) => `<div class="gcmd" role="button" tabindex="0" data-cmd="${escHtml(cmd)}"><code>${escHtml(cmd)}</code><span class="cpl">${icon('copy', 14)}</span></div>`;
  function guideSteps() {
    return [
      { t: 'Get an Ubuntu VPS', p: `Any provider works (Hetzner, DigitalOcean, Oracle free tier, ...). Ubuntu 22.04 or 24.04. You need the <b>IP address</b> and the <b>root password</b>.` },
      { t: 'SSH in from your phone', p: `Install <b>Termius</b> (Play Store) → New Host → address = your VPS IP, username <b>root</b>, your password → Connect. On a PC it is:` , cmds: ['ssh root@YOUR_VPS_IP'] },
      { t: 'Install Node.js 20', p: `Paste these two lines in the Termius terminal (tap a grey box to copy it):`, cmds: ['curl -fsSL https://deb.nodesource.com/setup_20.x | bash -', 'apt-get install -y nodejs'] },
      { t: 'Upload the server folder', p: `Unzip the OrbitBridge zip on your PC. In Termius open <b>SFTP</b>, create the folder <b>/root/orbitbridge</b> and upload the <b>server</b> folder from the zip into it.` },
      { t: 'Start the server', p: `The server has zero dependencies — nothing to npm-install. pm2 keeps it running forever (reboots, closed SSH):`, cmds: ['cd /root/orbitbridge/server', 'npm i -g pm2', 'pm2 start ecosystem.config.js && pm2 save && pm2 startup systemd'] },
      { t: 'Get your token', p: `The server prints its token once and saves it to <b>server/.token</b>. Copy the long hex string:`, cmds: ['cat /root/orbitbridge/server/.token'] },
      { t: 'Expose it over HTTPS', p: `This panel talks to the server over <b>https</b> (browser rule on mobile). The fastest way is a free Cloudflare quick tunnel — it prints an <b>https://something.trycloudflare.com</b> URL. Keep the terminal open, or use your own domain for a permanent URL:`, cmds: ['curl -L --output cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x cloudflared', './cloudflared tunnel --url http://127.0.0.1:3456'], tip: 'Permanent option: a named Cloudflare Tunnel on your domain, or nginx/caddy with TLS pointing at 127.0.0.1:3456.' },
      { t: 'Connect this panel', p: `Paste the https URL in <b>Server URL</b> and the token from step 6 in <b>Token</b> below, then tap <b>Save &amp; test connection</b>. Green = done — open the Agent tab and insert the agent prompt into your AI chat.` }
    ];
  }

  function renderGuide() {
    const steps = guideSteps();
    let html = '';
    steps.forEach((s, i) => {
      html += `<div class="gstep" style="animation-delay:${i * 45}ms"><div class="gnum">${i + 1}</div><div class="grow"><b>${s.t}</b><p>${s.p}</p>`;
      if (s.cmds) for (const c of s.cmds) html += guideCmd(c);
      if (s.tip) html += `<div class="gtip">${s.tip}</div>`;
      html += `</div></div>`;
    });
    refs.guideBody.innerHTML = html;
    for (const r of refs.guideBody.querySelectorAll('.gcmd')) {
      const go = () => copyText(r.getAttribute('data-cmd'), 'Copied — paste in Termius');
      r.addEventListener('click', go);
      r.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
    }
  }

  function initSettings() {
    refs.guideToggle.addEventListener('click', () => {
      const hidden = refs.guideBody.classList.contains('hidden');
      if (hidden && !refs.guideBody.innerHTML) renderGuide();
      refs.guideBody.classList.toggle('hidden', !hidden);
      refs.guideToggle.querySelector('span').textContent = hidden ? 'Hide' : 'Show';
    });
    refs.tokEye.addEventListener('click', () => { refs.setTok.type = refs.setTok.type === 'password' ? 'text' : 'password'; });
    refs.saveConn.addEventListener('click', async () => {
      const url = refs.setUrl.value.trim().replace(/\/+$/, '');
      const tok = refs.setTok.value.trim();
      if (!/^https?:\/\//i.test(url)) { setMsg(refs.connMsg, 'Enter a full URL starting with https://', 'err'); return; }
      if (!tok) { setMsg(refs.connMsg, 'Paste your token (server/.token)', 'err'); return; }
      let p = S.profiles.find((x) => x.id === S.activeVps);
      if (!p) { p = { id: 'vps1', name: 'VPS 1' }; S.profiles.push(p); S.activeVps = 'vps1'; }
      p.url = url; p.token = tok;
      await persistProfiles();
      renderVpsList();
      setMsg(refs.connMsg, 'Testing…', '');
      const r = await api('GET', '/api/status', undefined, 15000);
      if (r && r.status === 'online') {
        setMsg(refs.connMsg, `Connected to ${r.user}@${r.host}`, 'ok');
        S.handlers.recheck && S.handlers.recheck();
        loadInfo();
      } else {
        setMsg(refs.connMsg, r.error || 'Could not connect', 'err');
      }
    });
    refs.vpsAdd.addEventListener('click', addProfile);
    refs.multiToggle.addEventListener('click', async () => {
      S.multiVps = !S.multiVps;
      refs.multiSwitch.classList.toggle('on', S.multiVps);
      await new Promise((res) => chrome.storage.local.set({ obMultiVps: S.multiVps }, res));
      toast(S.multiVps ? 'Parallel calls will spread across all VPSes' : 'Parallel calls will stay on one VPS');
    });
    refs.chatVpsSwitch.addEventListener('click', async () => {
      const h = S.handlers;
      if (!h.onListVps || !h.onSetChatVps) return;
      const r = await h.onListVps();
      const list = (r && r.profiles) || [];
      if (list.length < 2) { toast('Add another VPS first'); return; }
      const cur = list.findIndex((p) => p.id === (r.chatVps || null));
      const next = list[(cur + 1) % list.length];
      await h.onSetChatVps(next.id);
      toast(`This chat now runs on ${next.name}`);
    });
    refs.strictToggle.addEventListener('click', () => {
      S.strict = !S.strict;
      refs.strictSwitch.classList.toggle('on', S.strict);
    });
    refs.saveWs.addEventListener('click', async () => {
      const r = await api('POST', '/api/config', { workspaceRoot: refs.setWs.value.trim() || undefined, strictWorkspace: !!S.strict });
      if (r && r.success) { setMsg(refs.wsMsg, 'Saved: ' + r.workspaceRoot, 'ok'); S.filesLoaded = false; loadInfo(); } else setMsg(refs.wsMsg, (r && r.error) || 'Failed', 'err');
    });
    initOta();
  }

  /* ---------------------------------------------------- extension OTA (v1.8) */
  function sendBg(msg) {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage(msg, (x) => { if (chrome.runtime.lastError) resolve(null); else resolve(x); }); }
      catch (e) { resolve(null); }
    });
  }
  async function refreshOta() {
    if (!refs.otaLine) return;
    const r = await sendBg({ type: 'OTA_STATUS' });
    if (!r || !r.success) { refs.otaLine.textContent = 'Unavailable outside the extension context.'; return; }
    const running = window.__OB_OTA_VERSION || null; // set by the auto-updated core
    refs.otaLine.textContent = `Installed v${r.installed}` + (r.ota && r.ota !== r.installed ? ` · running auto-updated v${r.ota}` : '');
    const st = r.state || {};
    if (st.status === 'blocked') {
      // v1.8.4: prefer the background's own reason (it carries the exact fix), fall back to the classic hint.
      refs.otaHint.textContent = st.reason || 'Auto-injection is blocked by the browser: open chrome://extensions → OrbitBridge → Details → enable “Allow user scripts” (or Developer mode), then tap Check now. Until then the bundled engine runs.';
    } else if (st.status === 'server_stale') {
      // v1.8.3: the VPS is the ONLY update source — say so instead of a silent "up to date".
      refs.otaHint.textContent = st.reason || 'Your VPS serves an older extension copy. Update the server first, then Check again.';
    } else if (st.status === 'error') {
      refs.otaHint.textContent = 'Last check failed: ' + (st.reason || st.error || 'unknown');
    } else if (st.status === 'current') {
      refs.otaHint.textContent = `Up to date with your VPS (it serves extension v${st.version}). Newer releases reach the extension only after the server is updated.`;
    } else {
      refs.otaHint.textContent = '';
    }
    refs.otaAutoSwitch.classList.toggle('on', !!r.auto);
    if (running) refs.otaLine.textContent += ' (live)';
  }
  function initOta() {
    if (!refs.otaCheck) return;
    refs.otaCheck.addEventListener('click', async () => {
      toast('Checking for updates…');
      const r = await sendBg({ type: 'CHECK_OTA' });
      if (!r) { toast('Could not reach the update service'); return; }
      if (r.status === 'updated') {
        // v1.8.4: honest outcomes — the update now applies on manual checks too.
        toast(r.reloaded ? `Updated to v${r.version} — reloaded ${r.reloaded} chat tab${r.reloaded > 1 ? 's' : ''}` : `Updated to v${r.version} — reload your chat tab to switch to it`, 4500);
      } else if (r.status === 'current') {
        toast(`Up to date with your VPS (v${r.version || r.installed})`);
      } else if (r.status === 'server_stale') {
        toast('Your VPS is the update source and it is behind — ' + (r.error || 'update the server first'), 6500);
      } else if (r.status === 'blocked') {
        // v1.8.4: the browser refuses user scripts — say exactly what to flip.
        toast('Cannot auto-install: ' + r.reason, 7500);
      } else toast(r.error || 'Update check failed');
      refreshOta();
    });
    refs.otaAutoToggle.addEventListener('click', async () => {
      const next = !refs.otaAutoSwitch.classList.contains('on');
      refs.otaAutoSwitch.classList.toggle('on', next);
      await new Promise((res) => { try { chrome.storage.local.set({ obOtaAuto: next }, res); } catch (e) { res(); } });
      toast(next ? 'Auto-update on — checks every 30 min' : 'Auto-update off');
    });
  }
  function setMsg(node, text, kind) {
    node.textContent = text;
    node.style.color = kind === 'ok' ? 'var(--ok)' : kind === 'err' ? 'var(--err)' : 'var(--muted)';
  }

  /* ----------------------------------------------------------------- agent */
  function renderAutopilot() {
    refs.apSwitch.classList.toggle('on', S.autopilot);
  }

  /* ---- v1.8 tools-per-message stepper (Agent tab) ---- */
  function renderMt() { if (refs.mtVal) refs.mtVal.textContent = String(S.maxTools); }
  async function loadMaxTools() {
    const r = await new Promise((res) => {
      try { chrome.storage.local.get(['obMaxTools'], (x) => res(x && x.obMaxTools)); } catch (e) { res(null); }
    });
    S.maxTools = Math.max(1, Math.min(12, Number(r) || 6));
    renderMt();
  }
  async function stepMaxTools(d) {
    S.maxTools = Math.max(1, Math.min(12, S.maxTools + d));
    renderMt();
    await new Promise((res) => { try { chrome.storage.local.set({ obMaxTools: S.maxTools }, res); } catch (e) { res(); } });
    toast(`Up to ${S.maxTools} tool call${S.maxTools > 1 ? 's' : ''} per AI message`);
  }

  function renderDetected() {
    const d = S.detected;
    refs.detCard.classList.toggle('hidden', !d);
    if (d) {
      refs.detCode.textContent = JSON.stringify(d, null, 2);
      refs.detRun.querySelector('span').textContent = `Run ${d.tool}`;
    }
  }

  function initAgent() {
    refs.apToggle.addEventListener('click', () => {
      S.autopilot = !S.autopilot;
      renderAutopilot();
      S.handlers.onAutopilot && S.handlers.onAutopilot(S.autopilot);
    });
    refs.mtMinus.addEventListener('click', () => stepMaxTools(-1));
    refs.mtPlus.addEventListener('click', () => stepMaxTools(1));
    loadMaxTools();
    refs.inject.addEventListener('click', () => S.handlers.onInjectPrompt && S.handlers.onInjectPrompt());
    refs.copyPrompt.addEventListener('click', () => S.handlers.onCopyPrompt && S.handlers.onCopyPrompt());
    refs.detRun.addEventListener('click', () => S.handlers.onRunDetected && S.handlers.onRunDetected());
    refs.detSkip.addEventListener('click', () => S.handlers.onSkipDetected && S.handlers.onSkipDetected());
    refs.infoRefresh.addEventListener('click', loadInfo);
  }

  /* ----------------------------------------------------------------- modal */
  function confirm(toolCall) {
    return new Promise((resolve) => {
      const m = el('div', 'modal');
      m.innerHTML = `<div class="mcard"><h3>Approve this action?</h3><p></p><div class="code"></div><div class="actions"><button class="btn" data-r="0">Reject</button><button class="btn primary" data-r="1">Approve &amp; run</button></div></div>`;
      m.querySelector('p').textContent = `The AI wants to run “${toolCall.tool}” on your server.`;
      m.querySelector('.code').textContent = JSON.stringify(toolCall.params || {}, null, 2);
      m.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-r]');
        if (!b) return;
        m.remove();
        resolve(b.dataset.r === '1');
      });
      R.appendChild(m);
      try { navigator.vibrate && navigator.vibrate(40); } catch (e) { /* ignore */ }
    });
  }

  /* ------------------------------------------------------------ public API */
  function mount(handlers) {
    S.handlers = handlers || {};
    if (document.getElementById(HOST_ID)) return;
    build();
    applySheetSize();
    initViewport();
    buildBar(); // v1.7: ZeroScript-style composer status bar (replaces the FAB)
    initSheetDrag();
    initTerminal();
    initFiles();
    initSettings();
    initAgent();
    initQuickPrompt();
    refs.liveReconnect.addEventListener('click', () => { stopLive(); startLive(); });
    refs.instRun.addEventListener('click', runInstaller);
    renderInstSteps(null);
    loadVpsState();
    renderQueue();
    renderSavedChips(refs.qSaved);
    renderEmptyTerm();
    renderStatus();
    renderAutopilot();

    refs.close.addEventListener('click', () => setOpen(false));
    refs.scrim.addEventListener('click', () => setOpen(false));
    refs.tabs.addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) setTab(b.dataset.tab); });
    document.addEventListener('visibilitychange', () => { if (S.open) { stopPolling(); startPolling(); } });
  }

  window.OB_UI = {
    mount,
    api,
    toast,
    copyText,
    confirm,
    confirmBatch,
    showChip,
    openQuickPrompt,
    setQueueInfo,
    setChatVps,
    isOpen: () => S.open,
    toggle: () => setOpen(!S.open),
    open: (tab) => setOpen(true, tab),
    close: () => setOpen(false),
    setAutopilot(v) { S.autopilot = !!v; if (refs.apSwitch) renderAutopilot(); },
    setOnline(online, err) {
      const changed = S.online !== online;
      S.online = online; S.lastError = online ? '' : err || '';
      if (!online) S.status = { state: 'offline', label: 'Offline' };
      else if (S.status.state === 'offline') S.status = { state: 'online', label: 'Ready' };
      lastBarSig = '';
      if (refs.pill) renderStatus(); else renderBarState();
      if (changed && online && S.open) { loadInfo(); startPolling(); }
      if (online && S.open && S.tab === 'live') { startLive(); loadInstallState(); }
    },
    setStatus(state, label) { S.status = { state, label: label || '' }; if (refs.pill) renderStatus(); else renderBarState(); },
    setActivity(text, kind, spinner) {
      S.activity = { text, kind: kind || 'normal', spinner: !!spinner };
      lastBarSig = '';
      if (refs.pill) renderStatus();
      else renderBarState();
    },
    setDetected(tc) { S.detected = tc; if (refs.detCard) renderDetected(); },
    notifyExecuted() { if (S.open) { pollTerminal(); if (S.tab === 'logs') loadLogs(true); } }
  };
})();
