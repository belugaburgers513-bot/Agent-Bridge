# Changelog

## OrbitBridge v1.8.3 (2026-10-10)

Fixes the extension self-update (OTA) path: the Settings card could never show
its status, and "no update found" could mean three different things without
saying which.

### Fixed — extension updates

- **The "Extension updates" status line always said "Unavailable outside the
  extension context".** The background's `OTA_STATUS` handler answered
  asynchronously but returned `false`, which closes an MV3 message port before
  the answer is sent. The installed/running version line was dead for everyone.
  Now returns `true` (async response) and the line works.
- **"Up to date" was ambiguous.** The extension can only update from its own
  VPS, so when the check found nothing, you could not tell whether (a) the
  server is current, (b) the server package is NEWER than the extension copy it
  serves (old installers did not refresh `OB_HOME/extension`), or (c) the
  served copy is older than the installed one. The check now distinguishes all
  three: a stale server answers **server_stale** with the exact command to run
  (`bash ob-install.sh --update`), shown as a toast and as a persistent hint.
- The OTA manifest now reports the server package version (`server` field), so
  the mismatch above is detectable at all.
- "Check now" toasts now say "Up to date **with your VPS**" and the hint
  explains that newer releases reach the extension only after the server is
  updated.

## OrbitBridge v1.8.2 (2026-10-10)

Bug-fix and polish release: the panel, the terminal, the Live feed and the engine.

### Fixed — panel

- **VPS setup guide never opened.** `row` was declared inside `guideSteps()` but
  called from `renderGuide()`, so Settings -> VPS setup guide threw
  "row is not defined". Guide commands are also HTML-escaped now, keyboard
  reachable (Enter/Space), and bold words no longer break onto their own lines.
- **Live tab: finished tools stuck on "running...", oldest rows on top, rows
  duplicated on every reconnect.** The server's replay is oldest -> newest, but the
  panel reversed it, so a tool's "end" arrived before its "start". Replay is now
  processed in order and de-duplicated by event id.
- **Terminal input row looked boxed/pressed; Live terminal rows were shifted.**
  Two CSS class-name collisions (`.cmdrow` shared by the terminal form and the guide
  command boxes; `.term` shared by the terminal box and the Live row icon). Renamed
  (`.gcmd`, `.ic-term`, `.ic-file`, `.ic-web`).
- **Text typed in the Quick prompt box was nearly invisible** in dark mode
  (`textarea` did not inherit the text colour).
- **Status ring spinner restarted on every status tick** (looked frozen). The ring is
  rebuilt only when its state actually changes.
- **Quick-prompt modal hid behind the on-screen keyboard.** It now rides above the
  keyboard and scrolls on short screens.

### Fixed — mobile keyboard (on top of the v1.8.1 guard)

- Terminal quick chips (`ls -la`, `git status`, history arrows) only fill the
  command box; they no longer pop the keyboard. The Quick-prompt box and the "Add
  VPS" URL field no longer auto-focus on touch screens.
- Closing the panel really blurs the focused field (the panel lives in a shadow
  root, where `document.activeElement` is only the host, so the old blur did nothing).

### Fixed — engine (`content.js`)

- All automated sends go through one queue (two concurrent sends could clobber
  or double-send in the same composer).
- Timers and observers are torn down when a newer engine takes over the page.
- Cover overlay: watchdog so a hung send can never leave the composer covered;
  fixed a race between hide/show timers.
- Rate-limit detection no longer fires on the AI's own words ("try again later").
- Queue: a prompt is no longer lost if the chat did not accept it; queue edits made
  during a send survive; the queue waits for the reply to start.
- Long tool output keeps its head AND tail (errors are usually at the end); a batch
  shares one size budget.
- Empty lines in a typed result are preserved; `#hash` navigation no longer wipes
  the dedup set; the dedup signature ignores our own chips.
- Status bar: if the composer's container is a no-wrap row flex, a grid or inline,
  the bar uses the anchored mode instead of squeezing the text box to a sliver.

### Added — look & feel

- **Terminal motion:** new lines slide in, a progress sweep and glow run while a
  command is busy, a blinking caret trails the output, exit status is a coloured
  pill, and commands get an accent bar.
- **Running chips show live elapsed time** ("running... 12s") on the AI message.

### Server

- Atomic `config.json` writes; `.token` forced to mode 600.
- Request bodies are decoded from Buffers (multi-byte characters split across
  chunks were corrupted); invalid / non-object JSON answers 400, oversize 413
  (connection drained so the answer is delivered).
- Event/terminal streams and downloads release their resources when the client
  disconnects (`res` close, not `req`).
- Symlink-safe path checks, including dangling symlinks; regular-file checks for
  read/download (FIFOs/devices could block the process); validated tool params;
  `zip` stores symlinks as links instead of following them out of the workspace;
  logged params are clipped so big writes cannot pin memory.

## OrbitBridge v1.8.1 (2026-10-10)

Mobile keyboard fix. Extension + version strings only.

### Fixed

- **On-screen keyboard popping up when a tool result is sent back to the AI.**
  The old fix blurred the composer once right after the send click, but chat
  sites refocus their composer on their own a moment later (after the submit,
  and again when the reply finishes), which raised the keyboard. A keyboard
  guard now covers the whole send-and-reply cycle: the composer is set to
  `inputmode="none"` while OrbitBridge automates it, any focus the user did
  not cause is blurred immediately (capture-phase `focusin`), and a blur burst
  runs after every send. Tapping the composer yourself lifts the guard at once,
  so typing normally still works.

## OrbitBridge v1.8.0 (2026-10-09)

Detection rewritten, tools-per-message control, and the extension now updates
itself from your server — no more download/unzip/reload cycles.

### Fixed — tool-call detection

- **New calls mistaken for old ones** (the "Found an earlier terminal call"
  misfire on fresh AI replies). The v1.7 boot window permanently swallowed any
  tool call that landed within 3.5s of a page load or chat switch — which is
  exactly when the first reply of a new chat arrives. History is now decided
  per chat turn (stable node identity), never by a timing window: turns whose
  text is settled and that are not streaming when the page boots are history;
  everything after is live and runs.
- **Answered calls could replay.** The old dedup key used the message's first
  100 chars, which shift while the message streams — an already-run call could
  pass the check and execute a second time. A call whose turn is followed by a
  later `[TOOL_RESULT]` wall can never run again, regardless of re-renders.
- **Prose quoting JSON could trigger a run.** Bare (unfenced) JSON must now
  sit on its own line(s), carry an explicit `"params"` key and a sane tool id;
  fenced blocks stay lenient. Extracted text also strips thinking blocks, our
  own chips and editors, and restores line structure around rendered code
  blocks (plain textContent glues adjacent `<pre>` blocks into one line).
- **History offers spammed.** A stale call is now offered once per turn.
- **Identical repeated calls in one message** were silently deduped to one;
  both run now (occurrence-indexed signatures keep re-render dedup correct).

### Added

- **Tools per message**: set your own cap (1–12) for how many tool calls one
  AI message may run — Agent tab stepper, stored per browser, default 6.
- **Extension auto-update (OTA)**: the server ships its copy of the extension
  and the browser extension pulls new builds from it — sha256-verified, then
  injected via the `chrome.userScripts` API. Idle chat tabs reload
  automatically (busy ones are skipped and picked up later); falls back to the
  bundled engine when the browser can't run user scripts. Settings → Extension
  updates shows installed vs running version, Check now and an Auto-update
  toggle (30-minute silent checks). One last manual install of v1.8 is needed;
  after that, updates flow from the server.

### Server

- New authenticated endpoints: `GET /api/ota/manifest` (version + sha256 per
  file) and `GET /api/ota/file?name=` (whitelisted text files), served from
  `OB_HOME/extension`. `ob-install.sh` now installs the extension copy next to
  the server (and stops deleting it from the codeload fallback).

## OrbitBridge v1.7.0 (2026-10-09)

"Animations don't show up" — fixed at the root, and the floating blue button
is gone. Two ZeroScript systems replace it: the composer status bar and a
working chip pipeline on DeepSeek. Extension-only release; the server change
is the version string.

### Fixed

- **Chips never fired on DeepSeek** (the actual "animations don't show" bug).
  The v1.6.1 sweep rejected any text inside an "assistant turn" — but on
  DeepSeek every turn (user result walls included) lives in a `.ds-message`
  and there is no user selector, so the sweep rejected EVERYTHING and no chip
  ever appeared; raw `[1/2] [TOOL_RESULT: ...]` walls stayed fully visible.
  The rule is now per-site (`isAssistantText`): on DeepSeek only
  `.ds-markdown` counts as assistant-rendered. Covered by regression test
  phase 2 (F1-F5).
- **Wall text truncation** — the result chip now reads the wall from the
  verified turn root, so walls the site splits across several paragraph
  nodes collapse completely (chip body capped at 4000 chars).
- **Scroll shift on collapse** — when a wall folds into a chip the page
  height change is measured and compensated, so the chat no longer appears
  to jump up.

### Added

- **ZeroScript composer status bar** (replaces the blue FAB + quick-prompt
  button + floating activity pill). A single strip docked to the chat
  composer: live dot (green pulse = working, amber = your turn, gray =
  offline), brand, state text, Console button. Tap anywhere on it to open
  the panel. Ported from ZeroScript's placeBar with its three mount modes:
  in-flow inside the composer box (DeepSeek, ChatGPT), in-flow above it
  (Gemini), fixed anchored with reserved padding (Claude, z.ai, fallback).
  Repositioned every animation frame — survives SPA re-renders, keyboard
  slide and composer re-layouts; self-heals when detached. State updates are
  signature-deduped so the live-dot animation never stutters.
- **Chip sweep watches characterData** — walls streamed into an existing
  text node (no childList mutation) now trigger decoration too.

### Changed

- Panel opens from the bar's Console button (or the toolbar icon) — there is
  no floating button over the chat anymore; quick prompts open from the
  panel's New prompt button.
- Server VERSION bumped to 1.7.0 (cosmetic; updating the VPS is optional).

## OrbitBridge v1.6.0 (2026-10-08)

The real ZeroScript port. v1.5 imitated the look and shipped broken chips on
DeepSeek (inherited site colours washed everything out, the tool name fell
back to "tool", nothing animated while a tool ran). v1.6 ports ZeroScript's
actual tool-card system from its source (overlay.css + core/main.js): the
chip CSS is near-verbatim, the chip builder keeps ZeroScript's
signature-dedup trick, and tool runs get a live card. No server changes
beyond the version string.

### Added

- **Live run chip** — the moment a tool batch starts, a card is pinned onto
  the AI message that issued the calls: spinner + ZeroScript's seamless
  210px shimmer while the VPS works, green tick / red cross + "done in 1.3s"
  when it finishes. The raw call blocks are hidden (ZeroScript camouflage)
  but stay expandable inside the chip; the AI's own prose is untouched.
- **Signature-deduped chip DOM** — ported from ZeroScript's chip(): the
  card's innerHTML is rebuilt ONLY when its content signature changes, so
  sweep passes never restart the spinner/shimmer animation mid-flight.
- **Wipe-proof decoration** — the sweep now rebuilds a chip when a site
  re-render wiped it while its root survived (v1.5 lost chips forever on the
  first re-render).
- **Fingerprint result matching** — right after OrbitBridge sends a result,
  a whitespace-free fingerprint of the result body is armed; the sweep uses
  it to find the sent bubble even when the site mangled the [TOOL_RESULT]
  header away. Chip labels/statuses/durations come from the ACTUAL execution
  results (known in JS), not from parsing the site's rendering.
- **Light-theme chips** — a background-luminance probe re-runs on every
  sweep tick and flips the chip palette (html.ob-light) so cards stay
  readable when the site theme flips.

### Fixed

- Chips no longer inherit the site's text colours: every element pins
  ZeroScript's explicit palette (#d7d7dc card, #cdd2e0 mono body, --cat
  accent icon), ending the washed-out purple look on DeepSeek.
- Tool name now shows the real tool (get_server_info) instead of the "tool"
  fallback — label/detail are computed from execution results, with the DOM
  parse (brackets now optional) kept as fallback for history reloads.
- Chip body expands smoothly (max-height 0 -> 460px, 0.22s ease) instead of
  display:none snapping; chevron rotates; only the head toggles.

## OrbitBridge v1.5.0 (2026-10-08)

The ZeroScript clone: composer cover, result chips, verified sends. Ported the
three best UX mechanics from the ZeroScript/AgentBridge extension (studied its
input-cover implementation: opaqueBg alpha-compositing, rAF placement loop with
clipping-ancestor clipping, .typing text mask) into OrbitBridge's content.js.
No server changes beyond the version string.

### Added

- **Composer cover** — while the agent types a tool result (or queue/quick
  prompt) into the chat box, an opaque overlay shaped to the composer hides
  the raw text completely: background colour is alpha-composited from the
  composer's translucent ancestors so it matches the page exactly, a rAF loop
  re-places it every frame (SPA editors get recreated — the text mask is
  re-asserted each frame), it clips to the nearest scrolling ancestor so a
  ballooning editor can never drag it off-screen, and it eats clicks so
  nothing can be typed behind it. Fades in/out; minimum 450ms so it never
  flashes.
- **Result chips** — every sent `[TOOL_RESULT: …]` message collapses into a
  small animated card (status dot green/red/amber, tool name, status + exit +
  duration, chevron) instead of a wall of JSON. Tap to expand the raw text in
  a scrollable monospace body. A MutationObserver re-applies chips after SPA
  re-renders, so the raw text never flashes back.
- **Verified sends with retry** — every automated send (tool result, queue,
  quick prompt, run-now, resume-after-reopen) now goes through one primitive:
  type → click send → VERIFY the composer actually emptied → retry up to 3×
  if the site swallowed the click. Rate-limit toasts hand control to the
  existing rate-limit retry logic; a hard failure surfaces as "Send failed"
  instead of silently waiting forever.

## OrbitBridge v1.4.0 (2026-10-07)

The real blue-button fix, found by research: the `default_popup` manifest line
was the bug. Chrome, MDN and the Chromium tracker all document that
`action.onClicked` NEVER fires while a popup is set — so every toolbar tap was
routed through the popup layer. Android Chromium forks (Lemur, Kiwi) render
extension popups AS A TAB: the popup tab steals the screen, tab queries resolve
to the popup itself, and window.close() is ignored — the tap looked completely
dead. No server changes beyond the version string.

### Fixed

- **Popup removed from the manifest for good** — with no popup, the toolbar tap
  fires `chrome.action.onClicked` directly in the service worker, with the
  correct tab passed in as an argument. No extra window, no focus loss, no tab
  guessing; the v1.3 revive/inject/fallback pipeline is now always reachable.
  The popup.html/popup.js launcher is deleted from the package.
- **Triple-channel FAB taps** — the in-page floating button now accepts
  pointerup, touchend AND click (one shared 600ms debounce; touchend calls
  preventDefault so quirky builds cannot also synthesize a click), covering
  Android WebViews that swallow one or two of those channels.

### Added

- **Badge feedback on every toolbar tap** — a green ✓ flashes on the icon
  (1.5s) when the panel opened, a red ! (4s) when the page could not host the
  panel and a chat tab took over. Never a silent tap again.

## OrbitBridge v1.3.1 (2026-10-07)

The screenshot fix: the launcher card stayed on screen after opening the panel
(Lemur ignores window.close() for extension popups) and covered the panel that
had just opened — making the blue button look dead. Plus the VPS setup tutorial
now lives inside the GUI.

### Fixed

- **Ghost launcher** — the toolbar popup is now invisible by default: the panel
  opens behind it and the popup vanishes. It only fades in if the job takes
  longer than 700ms (first-time injection, chat-tab fallback), and on success
  it force-hides itself even when window.close() is ignored by the browser
  (body -> html display:none fallbacks at 250ms/700ms). Transparent background
  so the dialog frame can't flash a white box.
- **FAB feedback** — 12px drag threshold (was 8, fewer accidental drags on
  touch), light vibration (12ms) on a successful tap so you can feel it open.

### Added

- **VPS setup guide in the GUI** — Settings tab, first card, "Show" to expand:
  8 numbered steps from zero to connected (get a VPS, SSH from your phone with
  Termius, install Node 20, upload the server folder via SFTP, start under
  pm2, read server/.token, expose HTTPS with a Cloudflare quick tunnel, paste
  URL + token). Every command is a tap-to-copy row. The Live tab's installer
  card now points to it for first-timers.

## OrbitBridge v1.3.0 (2026-10-07)

"Make it actually open on my phone" release: the toolbar button pipeline was
rebuilt around Lemur's realities, the popup became a silent auto-launcher with
zero buttons, and the whole UI got an animation pass. No server changes beyond
the version string; design untouched.

### Fixed

- **Blue button opens the GUI — every time** — the #1 cause was zombie content
  scripts: after ANY extension update/reload, open tabs kept ORPHANED scripts
  whose chrome.* calls throw "Extension context invalidated" while they still
  export window.OB_UI / window.__obEngine — so the launcher believed injection
  was unnecessary and messages went nowhere. The launcher now probes a page
  heartbeat (`window.__obBeat`, ticks only while the context is alive), excises
  zombies (removes #ob-root + globals) and injects ui.js+content.js fresh.
  Background tab timer throttling is respected (90s freshness window) so live
  engines are never wiped.
- **Popup is now silent and automatic** — no more "Open panel here" /
  "Open AI chat site" buttons. Tap the icon: it asks the service worker to
  open the panel and closes itself. If the current page cannot host the panel
  (new tab page, chrome://, site down), it AUTOMATICALLY opens a chat site tab
  and the panel opens there once loaded. Zero choices, zero manual steps.
- **OPEN_PANEL can never die silently** — the content-script handler now wraps
  open logic in try/catch and always answers ({success:false, reason:'no_ui'}
  when the UI is missing), so the launcher retries correctly instead of
  guessing.
- **"Extension context invalidated" crashes** — alive() helpers in ui.js and
  content.js access chrome.runtime.id inside try/catch; orphaned scripts now
  degrade to "offline" instead of throwing through every code path.
- **Never-crash panel open** — setOpen() applies the visual open/close FIRST
  (sheet, FAB, scrim) and only then runs feature loadouts, each guarded. A
  broken widget can no longer leave the user with a button that does nothing.
- **Tap-proof FAB** — the floating button now accepts pointerup AND click
  (600ms debounce) and treats a pointercancel on a non-drag as a tap, fixing
  lost taps on quirky mobile gesture stacks.

### Added

- **Animations** — spring FAB/quick-FAB entrance (scale+rotate pop), sliding
  bottom sheet (already there, kept), tab-content fade/slide on every switch,
  confirm-modal backdrop fade + card slide-up, press feedback on buttons/tabs
  (scale), animated progress bar in the launcher. All transform/opacity only —
  no layout thrash, GPU-friendly on phones.

### Changed

- Bigger floating button (56 -> 60px) and quick-FAB (40 -> 44px), both honoring
  env(safe-area-inset-bottom) so Lemur's gesture bar never covers them.
- Versions unified at 1.3.0 (manifest, panel, server, package.json).

## OrbitBridge v1.2.0 (2026-10-07)

"Watch it work" release: a **Live tab** inside the panel that shows every
command and tool hitting the server in real time (the actual work, not the
chat text), an **in-panel service installer**, **true parallel tools on ONE
VPS**, **prompts from .txt/.md files**, and a **popup launcher** that fixes
the toolbar button for good. No ZeroScript anywhere; design untouched.

### Fixed

- **Blue toolbar button opens the GUI on the first tap** — v1.1 still relied on
  `chrome.action.onClicked`, which on Lemur/mobile Chromium often does nothing
  while the service worker sleeps. The action now has a real `default_popup`:
  the browser itself opens it on every tap, the popup injects + opens the panel
  (with retries) and closes itself. If the current page cannot host the panel,
  it says so and offers an "open chat site" button instead of dying silently.
- **Series queue auto-send actually works now** — `agentIdleForQueue()` tested
  `isGenerating` without calling it, so the truthy function reference blocked
  every automatic send. Queued prompts stalled forever unless you tapped
  "Run now". Fixed: the queue advances by itself whenever the agent is idle.

### Added

- **Live tab (in the extension menu, same design)** — a sixth tab with an
  animated real-time feed of tool executions on the VPS: tool name, the exact
  shell command / file path, running spinner, duration and pass/fail. Powered
  by a server-side event bus (`GET /api/events`, SSE) relayed to the panel over
  an extension port; a 120-event ring buffer replays what you missed when you
  open the tab. Uploads appear too.
- **Install as a service — inside the panel** — the Live tab also hosts an
  8-step animated installer (check Node → verify workspace → check token →
  write systemd unit → daemon-reload → enable on boot → start → verify).
  Steps are whitelisted server-side (`/api/install/run`, `/api/install/state`),
  stream live output per step, and the port-conflict case is explained in plain
  words ("stop the foreground instance so the service can take over").
- **parallel_commands tool** — `{ commands: ["..", ".."] }` runs 2–8 shell
  commands **at the same time** on ONE VPS, each in its own process, returning
  one result block per command (exit code, stdout/stderr, duration, wall time).
  Denylist applies per command; cwd is workspace-jailed.
- **Up to 6 tool calls per batch, terminal included** — the old "only one
  terminal call per message" cap is gone: batched terminal calls simply queue
  in order on the shared shell (safely), while everything else runs truly
  parallel. Prompt updated to teach the model the difference.
- **Prompts from .txt / .md files** — the Quick Prompt modal has an
  "Import from .txt / .md file" button (multi-select, each file becomes a
  saved prompt named after the file); the Files tab shows a "Save as prompt"
  action on text files on the VPS. Both feed the same prompt library used by
  the quick-prompt chips and the series queue.

## OrbitBridge v1.1.0 (2026-10-07)

Feedback release: parallel execution, keyboard-free typing on mobile, a series
prompt queue that survives closing the browser, quick prompts without opening
the panel, and multiple VPS servers. Design untouched — everything is additive
in the same visual language. Zero dependencies kept.

### Fixed

- **Toolbar icon now opens the panel on the first tap** — the old path sent one
  message into the void when the content script was not alive yet (first tap
  after waking the service worker, pages opened before an update, mobile
  tab-restores). The worker now pings, injects `ui.js`/`content.js` via
  `chrome.scripting` when needed, retries, and only as a last resort opens a
  chat site in a new tab. Clicking the icon opens (never accidentally
  closes) the panel.
- **No more soft keyboard on agent pastes** — tool results used to focus the
  chat box, popping up the Lemur/Android keyboard every time. Typing is now
  focus-free (native value setter + input events for textareas, direct DOM
  write + InputEvent for contenteditable editors) and only falls back to the
  focus path — with an immediate blur — if a site rejects the write. Automated
  sends also blur afterwards, so the keyboard never stays open.
- **Parallel-safe terminal** — a second `terminal_exec` used to KILL the
  running command (hard-coded `killActiveProcess()`). Concurrent exec calls
  are now serialized through a promise chain; if the shell is parked
  AWAITING_INPUT, a new exec returns an informative error instead of silently
  destroying the waiting process. The human "Run" button in the panel keeps
  its old barge-in semantics (`force`).

### Added — parallel tool calls

- The engine detects multiple tool calls in ONE AI message (JSON array in a
  ```tool block, or several blocks) and runs up to 4 of them **in parallel**,
  sending one combined, numbered result message back.
- Terminal tools are auto-collapsed to one per batch (single shared shell) —
  the extra ones get an explanatory result instead of racing.
- One approval dialog covers the whole batch when Autopilot is off.
- `prompt.txt` documents the batch format and its limits.

### Added — series prompt queue (survives closing the browser)

- **Quick prompt box without opening the panel** — a small ⚡ button floats
  above the main one: type a prompt, then *Send now*, add to the *Queue*, or
  *Save* it as a reusable custom prompt (saved prompts show as chips).
- **Series queue** — queued prompts send one after another automatically
  whenever the agent is idle. The queue lives in `chrome.storage`, so closing
  the browser, killing the tab or losing the page does not lose it: on reopen
  it resumes where it left off. Pause / resume, clear, remove, "send now" per
  item. A periodic `chrome.alarms` nudge re-kicks the queue in background
  tabs every minute.
- **Interrupted results resume too** — a tool result that was being typed when
  the browser closed is re-sent automatically on return (10 min freshness
  window, same chat only).
- **Long tasks on VPS card** (Agent tab) — lists `start_background` jobs with
  pid / start time / alive dot. These keep running with the browser closed;
  the AI is instructed (rule 4) to run anything longer than ~10 minutes this
  way.
- Service-worker keepalive: while a tool call is in flight the content script
  pings the worker every 20 s so Android does not reap the request mid-execute.

### Added — multiple VPS servers

- **VPS profiles** (Settings → VPS servers): add / remove / switch servers
  (name + URL + token each), per-profile test button. The legacy single
  server config migrates automatically to "VPS 1".
- **One chat ↔ one server**: the first server a chat uses is pinned to that
  chat (shown as "This chat runs on …" on the Agent tab); *Switch* rebinds.
- **Spread parallel calls across all VPSes**: new toggle. With it on, parallel
  batches rotate across profiles; individual calls can still target a specific
  server with `"vps": "<name>"` (server names are injected into the agent
  prompt ENVIRONMENT when more than one is configured).

### Server changes (still zero-dep)

- Terminal session: exec serialization queue + `needsInput` tracking
  (see Fixed) and `force` option for the panel route.
- Version 1.1.0 everywhere; nothing else changed — auth, denylist, SSRF guard,
  uploads, zip endpoints are exactly as in 1.0.

### Notes for Lemur / Android

- The browser must be open for chat-side automation (typing results, sending
  queued prompts) — Android does not let extensions run with the browser
  closed. What DOES keep running with the browser closed: every
  `start_background` job, the bridge itself, and the queue (it resumes the
  moment you reopen).

## OrbitBridge v1.0.0 (2026-10-07)

New product identity: **OrbitBridge** (formerly "DeepSeek Bridge / VPS Agent").
Same hardened engine, clean rebrand, plus file transfer and archive powers.
Zero dependencies kept.

### Added — file transfer (panel + tools)

- **Upload from phone to VPS** — new upload button in the Files tab. Files are
  POSTed binary-safe (octet-stream) to `POST /api/upload`, land in
  `uploads/` inside the workspace with a timestamp+random prefix, and the AI can
  read them right away. Filenames are sanitised (basename, traversal-safe).
- **Download from VPS to phone** — per-file download button, backed by
  `GET /api/download?path=` (workspace-jailed, MIME-typed, RFC 5987 filename,
  500 MB server cap / 80 MB to-the-phone cap).
- **`GET /api/uploads`** — lists the newest 300 uploads (name, size, mtime).
- Upload cap configurable via `MAX_UPLOAD_MB` (default 200) and shown in
  `/api/status` (`uploadsDir`, `maxUploadMb`, plus new `uptimeSec`, `node`,
  `startedAt`).

### Added — archives and file management

- **`zip_files { paths, out? }`** — zips files/folders (arg-array `zip`, no
  shell, workspace-jailed, refuses to overwrite).
- **`unzip_file { path, dest? }`** — extracts .zip / .tar / .tar.gz / .tgz /
  .tar.bz2 / .tar.xz into `<name>-extracted`, returns a bounded extracted tree.
- **`move_path { from, to }`** / **`copy_path { from, to }`** — recursive,
  jailed, refuse system paths and existing targets; `EXDEV` handled as
  copy+remove.
- Files tab rows now carry per-item actions: **download**, **zip**, and
  **extract** for archives — same design language (icon buttons, toasts).
- The same archive actions are exposed to the panel via `POST /api/fs/zip` and
  `POST /api/fs/unzip`.

### Changed

- Rebrand to **OrbitBridge** everywhere: extension name, panel header, server
  banner, package name, docs. Internal handles renamed (`ob-root`, `OB_UI`,
  `__obEngine`, `ob.*` storage keys).
- `prompt.txt` documents the four new tools and the `uploads/` convention
  (still compact).
- Server CORS allowlist now also covers chatgpt.com / chat.openai.com /
  claude.ai / gemini.google.com to match the manifest.
- New extension icons (orbit mark, indigo→blue gradient).
- "Server" card in the Agent tab now also shows the Node version.

### Fixed

- Legacy `dsb.*` storage keys migrated to `ob.*` (FAB position and sheet size
  reset once after the rebrand — cosmetic only).
- No functional regressions: the 3.1 lockdown set (edit_file `$` literal,
  terminal capture cap, stale-run race fix, MCP handshake retry, SSRF guard,
  spoof-proof brute-force brake) ships unchanged.

## v3.1.0 (2026-10-07)

Security lockdown, real bug fixes, small features, docs. Zero dependencies kept.

### Fixed — real bugs

- **edit_file corrupted replacements containing `$` patterns** — `server/tools/fs_tools.js`
  used `content.replace(search, replace)` with a string replacement, so
  `$&`, `$'`, `` $` `` etc. were interpreted as special patterns. Editing a shell
  script containing `$1` (or any sed-style `$&`) silently corrupted the file.
  Now passes a function (`() => replace`) so the replacement is literal.
  *(allowMultiple already used split/join and was safe.)*
- **Terminal output could OOM the bridge** — `server/tools/terminal_session.js`
  appended stdout/stderr without limit; a `yes`, a runaway build or 15 minutes of
  verbose logs accumulated unbounded in memory (max case: hundreds of MB to GB).
  Capture is now capped per run: first 160 KB + rolling 240 KB tail, dropped chars
  are counted and shown in the result (`...[N chars dropped]...`).
- **Stale command clobbered session cwd/env (race)** — `terminal_session.js`
  `exec()` kills a still-running command before starting a new one; when the old
  process's `close` event fired *after* the new run started, `_loadState()` applied
  the dead command's cwd/env snapshot on top of the fresh run's state. The close
  handler now only applies state if it belongs to the current run.
- **One failed MCP handshake poisoned the server until restart** —
  `server/tools/mcp_client.js`: if `initialize` timed out or failed, the instance
  stayed in the map with a permanently-rejected `ready` promise; every later
  `mcp_list` / `mcp_call` re-threw the stale error. Failed handshakes now kill the
  child process and drop the instance so the next call starts fresh.
- **AWAITING_INPUT false positives** — the prompt heuristic in
  `terminal_session.js` matched ANY output line ending with `?` or `:` (help
  texts, YAML dumps, progress lines), making running commands look like they were
  waiting for input. Now only explicit patterns (y/n, password/passphrase, enter/
  confirm/overwrite prompts, "continue?", "are you sure?") on lines ≤ 100 chars
  trigger it.
- **search_files choked on binaries** — every file < 2 MB was read and decoded as
  UTF-8, including binaries. Files are now null-byte-checked before decoding.
- **Version mismatch** — folder said v3, code/docs/manifest all said 2.0.0.
  Everything is now 3.1.0 (server.js, manifest.json, ui.js, package.json,
  MCP clientInfo).

### Security — lockdown defaults

- **SSRF guard for fetch_web_url** (`server/tools/web_tools.js`) — fetch_web_url
  could read `http://127.0.0.1:6379`, `http://169.254.169.254/...` (cloud
  metadata) and other internal services; combined with prompt injection from
  fetched pages this was a real exfiltration path. DNS is now resolved and
  checked against loopback/private/link-local/CGNAT ranges, and every redirect
  hop is re-validated (redirects are followed manually). Override with
  `allowPrivateFetch: true` in config.json.
- **Unspoofable brute-force brake** (`server/server.js`) — the per-client failure
  counter trusted the `cf-connecting-ip` header unconditionally; when any request
  path is not behind Cloudflare an attacker can rotate that header per try and
  never hit the 15/min cap. Proxy headers are now only trusted when
  `trustProxyHeaders: true` (env `TRUST_PROXY_HEADERS=1`). Safe default either
  way: without it, all tunnel traffic shares one socket-level bucket.
- **Command denylist** (`server/server.js`) — new lockdown guard for
  terminal_exec / run_command / start_background: obvious destructive commands
  (`rm -rf /`, `mkfs`, fork bomb, `shutdown`, `iptables -F`, ...) are refused with
  a clear POLICY_BLOCKED error the model can understand. Best-effort accident
  guard, not a sandbox. Tunable via `commandDenylist` in config.json or
  `COMMAND_DENYLIST` env (entries joined with `||`).

### Added

- **`GET /api/tools`** — self-documenting tool catalog (name, group, params) plus
  the active policy knobs; keeps prompts/UIs in sync with the running server.
- **fetch_web_url upgrades** — streams the body with a size cap (default 5 MB,
  per-request `maxBytes`, hard max 20 MB) instead of `response.text()` OOM risk;
  non-text content types are reported as `[binary response: ...]` instead of
  being decoded into mojibake; result now includes `finalUrl` and `bytesReceived`.
- **Multi-site extension support (best-effort)** — manifest now also injects on
  chatgpt.com, chat.openai.com, claude.ai and gemini.google.com. Content script
  gains per-site preferred input selectors (`#prompt-textarea`, ProseMirror,
  rich-textarea), Claude/Gemini user-message markers, and ChatGPT stop/send
  test-ids. DeepSeek/z.ai behavior is unchanged.
- **prompt.txt** — documents the policy-block behavior for the model and the new
  maxBytes param.

### Docs

- README rewritten: security defaults table, config knob reference, non-root
  recommendation, `/api/tools` note, multi-site caveats.
- This changelog added.
