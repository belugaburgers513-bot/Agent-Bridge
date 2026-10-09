'use strict';
/**
 * Installer (v1.2) — turns "node server.js in a terminal" into a proper systemd
 * service, step by step, with every command streamed to the panel.
 * Steps are WHITELISTED here; the panel can only pick from this list.
 * Zero deps.
 */
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UNIT_NAME = 'orbitbridge.service';
const UNIT_PATH = '/etc/systemd/system/' + UNIT_NAME;
const OUT_CAP = 8000;
const STEP_TIMEOUT_MS = 45000;

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  steps: [], // { id, label, state: 'pending'|'running'|'done'|'fail'|'skip', output }
  lastError: null
};

function clip(s) {
  s = String(s || '');
  if (s.length <= OUT_CAP) return s.trim();
  return s.slice(0, OUT_CAP - 200).trim() + `\n...[clipped, ${s.length} chars]`;
}

function sh(cmd, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: clip(stdout), err: clip(stderr) });
    });
  });
}

function unitContent(config) {
  const ws = config.workspaceRoot || path.join(os.homedir(), 'agent-workspace');
  return [
    '[Unit]',
    'Description=OrbitBridge — AI chat to VPS bridge',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${__dirname}`,
    `ExecStart=${process.execPath} ${path.join(__dirname, 'server.js')}`,
    'Restart=always',
    'RestartSec=3',
    'KillSignal=SIGINT',
    `Environment=PORT=${config.port || 3456}`,
    `Environment=WORKSPACE_ROOT=${ws}`,
    `User=${os.userInfo().username}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    ''
  ].join('\n');
}

/**
 * The whitelist. Each step: { id, label, hint, run(ctx) -> { ok, output, skipMsg? } }
 * ctx: { config, emit }
 */
function buildSteps(config) {
  return [
    {
      id: 'node',
      label: 'Check Node.js',
      hint: 'node --version',
      run: async () => {
        const r = await sh('node --version', 10000);
        const v = (r.out || '').trim();
        if (!r.ok || !v) return { ok: false, output: 'Node.js not found on this machine. Install it first: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs' };
        const major = parseInt(v.replace('v', ''), 10) || 0;
        if (major < 16) return { ok: false, output: `Node ${v} is too old — OrbitBridge needs Node 16+. Update Node, then run the installer again.` };
        return { ok: true, output: `Node ${v} — good` };
      }
    },
    {
      id: 'workspace',
      label: 'Verify workspace',
      hint: `ls ${config.workspaceRoot}`,
      run: async () => {
        try {
          fs.accessSync(config.workspaceRoot, fs.constants.W_OK);
          return { ok: true, output: `${config.workspaceRoot} is writable` };
        } catch (e) {
          return { ok: false, output: `Workspace ${config.workspaceRoot} is not writable: ${e.message}` };
        }
      }
    },
    {
      id: 'token',
      label: 'Check auth token',
      hint: 'stat server/.token',
      run: async () => {
        const p = path.join(__dirname, '.token');
        if (!fs.existsSync(p)) return { ok: false, output: 'server/.token missing — it is created on first boot; start the server once, then install again.' };
        try {
          const st = fs.statSync(p);
          return { ok: true, output: `Token present (${st.size} bytes, mode ${String(st.mode & 0o777).replace(/^0*/, '')})` };
        } catch (e) {
          return { ok: false, output: e.message };
        }
      }
    },
    {
      id: 'service',
      label: 'Write systemd unit',
      hint: `write ${UNIT_PATH}`,
      run: async () => {
        const content = unitContent(config);
        const tmp = path.join(os.tmpdir(), UNIT_NAME + '.' + Date.now());
        fs.writeFileSync(tmp, content);
        if (typeof process.getuid === 'function' && process.getuid() === 0) {
          try {
            fs.mkdirSync('/etc/systemd/system', { recursive: true });
            fs.copyFileSync(tmp, UNIT_PATH);
            fs.rmSync(tmp, { force: true });
            return { ok: true, output: `Wrote ${UNIT_PATH}` };
          } catch (e) {
            return { ok: false, output: `Could not write unit: ${e.message}` };
          }
        }
        // Not root: try passwordless sudo, else fail with copy-paste instructions.
        const cp = await sh(`sudo -n install -m 644 ${tmp} ${UNIT_PATH}`, 15000);
        fs.rmSync(tmp, { force: true });
        if (cp.ok) return { ok: true, output: `Wrote ${UNIT_PATH} via sudo` };
        return {
          ok: false,
          output: `No root/sudo access. Copy the unit manually:\n\n${content}\nthen: sudo cp /tmp/${UNIT_NAME} ${UNIT_PATH} && sudo systemctl daemon-reload`
        };
      }
    },
    {
      id: 'reload',
      label: 'Reload systemd',
      hint: 'systemctl daemon-reload',
      run: async () => {
        const pre = await sh('command -v systemctl', 5000);
        if (!pre.ok) return { ok: false, output: 'systemd not found on this machine (container or non-systemd distro?). Run the server with pm2 or nohup instead — see README.' };
        const r = await sh('sudo -n systemctl daemon-reload || systemctl daemon-reload', 30000);
        return r.ok ? { ok: true, output: 'systemd reloaded' } : { ok: false, output: (r.err || r.out || 'daemon-reload failed') };
      }
    },
    {
      id: 'enable',
      label: 'Enable on boot',
      hint: 'systemctl enable orbitbridge',
      run: async () => {
        const r = await sh('sudo -n systemctl enable ' + UNIT_NAME + ' || systemctl enable ' + UNIT_NAME, 20000);
        return r.ok ? { ok: true, output: 'OrbitBridge will start automatically on boot' } : { ok: false, output: (r.err || r.out || 'enable failed') };
      }
    },
    {
      id: 'start',
      label: 'Start the service',
      hint: 'systemctl restart orbitbridge',
      run: async () => {
        const r = await sh('sudo -n systemctl restart ' + UNIT_NAME + ' || systemctl restart ' + UNIT_NAME, 30000);
        if (!r.ok) {
          const blob = (r.err || '') + (r.out || '');
          if (/address already in use|EADDRINUSE|port.*in use/i.test(blob)) {
            return {
              ok: false,
              output: 'Port conflict: THIS bridge is running on the same port in the foreground. Stop that instance first (Ctrl+C in its terminal, or: pm2 delete orbitbridge), then tap "Start the service" again — systemd will take over the port and survive reboots.'
            };
          }
          return { ok: false, output: (r.err || r.out || 'restart failed') };
        }
        return { ok: true, output: 'Service started' };
      }
    },
    {
      id: 'verify',
      label: 'Verify it is alive',
      hint: 'systemctl is-active orbitbridge',
      run: async () => {
        const r = await sh('systemctl is-active ' + UNIT_NAME, 10000);
        const st = (r.out || '').trim();
        if (st === 'active') return { ok: true, output: 'orbitbridge is active — it now survives reboots and disconnected SSH sessions' };
        if (!st) return { ok: true, output: 'Could not read status (systemctl unavailable?) — check: journalctl -u orbitbridge -n 20' };
        const log = await sh('journalctl -u ' + UNIT_NAME + ' -n 8 --no-pager 2>/dev/null || echo "(journalctl unavailable)"', 10000);
        return { ok: false, output: `Status: ${st}. Last logs:\n${log.out || log.err || '(none)'}` };
      }
    }
  ];
}

/** Validate a requested step list against the whitelist without starting anything. */
function validateSteps(stepIds) {
  const all = buildSteps({});
  if (!Array.isArray(stepIds) || !stepIds.length) return { ok: true, total: all.length, ids: null };
  const ids = stepIds.map(String);
  const chosen = ids.map((id) => all.find((s) => s.id === id)).filter(Boolean);
  if (!chosen.length) return { ok: false, reason: 'No valid steps in the request. Whitelisted ids: ' + all.map((s) => s.id).join(', ') };
  return { ok: true, total: chosen.length, ids };
}

/** Run the given whitelisted step ids in order. Emits events; never throws. */
async function runInstall(stepIds, config, emit) {
  if (state.running) return { started: false, reason: 'An install run is already in progress.' };
  const all = buildSteps(config);
  let chosen = all;
  if (Array.isArray(stepIds) && stepIds.length) {
    chosen = stepIds.map((id) => all.find((s) => s.id === id)).filter(Boolean);
    if (!chosen.length) return { started: false, reason: 'No valid steps in the request.' };
  }
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.lastError = null;
  state.steps = chosen.map((s) => ({ id: s.id, label: s.label, hint: s.hint, state: 'pending', output: '' }));
  emit({ type: 'install', phase: 'start', total: chosen.length });

  let failed = 0;
  for (let i = 0; i < chosen.length; i++) {
    const st = state.steps[i];
    st.state = 'running';
    emit({ type: 'install', phase: 'step', index: i, id: st.id, label: st.label, hint: st.hint, state: 'running', progress: i, total: chosen.length });
    let res;
    try { res = await chosen[i].run({ config }); }
    catch (e) { res = { ok: false, output: e.message }; }
    st.output = res.output || '';
    st.state = res.ok ? 'done' : 'fail';
    if (!res.ok) failed++;
    emit({ type: 'install', phase: 'step', index: i, id: st.id, label: st.label, state: st.state, output: st.output, progress: i + 1, total: chosen.length });
  }

  state.running = false;
  state.finishedAt = new Date().toISOString();
  state.lastError = failed ? `${failed} step(s) failed — read the output above.` : null;
  emit({ type: 'install', phase: 'done', failed, total: chosen.length, ok: failed === 0 });
  return { started: true, total: chosen.length };
}

function getState() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    lastError: state.lastError,
    steps: state.steps,
    unitPath: UNIT_PATH,
    isRoot: typeof process.getuid === 'function' ? process.getuid() === 0 : false,
    node: process.version,
    serviceDir: __dirname
  };
}

module.exports = { runInstall, getState, validateSteps };
