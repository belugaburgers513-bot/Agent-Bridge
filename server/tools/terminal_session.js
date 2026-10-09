'use strict';
/**
 * Persistent shell session for Linux (bash).
 *
 * Every command runs in its own `bash` process, but the session carries state between
 * commands: the working directory AND exported environment variables (so `cd`, `export`,
 * `source venv/bin/activate`, `nvm use` ... keep working across tool calls).
 *
 * A command returns when it exits, times out, or looks like it is waiting for input
 * (then the process is left running so `terminal_input` can answer it).
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MAX_RESULT_CHARS = 12000;
const MAX_HISTORY = 500;
const MAX_HISTORY_TEXT = 8000;
const IDLE_PROMPT_MS = 1200;
// Per-run capture caps so something like `yes` or a runaway build can't OOM the bridge
// (max 15 min x ~1 GB/s of stdout would otherwise accumulate in memory).
// Layout: keep the FIRST CAP_HEAD chars, then (once overflowing) a rolling tail of
// CAP_TAIL chars; everything trimmed from the tail is counted in `dropped`.
const CAP_HEAD = 160 * 1024;
const CAP_TAIL = 240 * 1024;

function makeCapture() {
  return { head: '', tail: '', dropped: 0, crossed: false };
}

function appendCapture(cap, s) {
  if (!cap.crossed) {
    cap.head += s;
    if (cap.head.length > CAP_HEAD + CAP_TAIL) {
      cap.crossed = true;
      cap.tail = cap.head.slice(CAP_HEAD);
      cap.head = cap.head.slice(0, CAP_HEAD);
    }
    return;
  }
  cap.tail += s;
  if (cap.tail.length > CAP_TAIL) {
    cap.dropped += cap.tail.length - CAP_TAIL;
    cap.tail = cap.tail.slice(cap.tail.length - CAP_TAIL);
  }
}

function captureText(cap) {
  if (!cap.crossed) return cap.head;
  const marker = cap.dropped > 0 ? `\n...[${cap.dropped} chars dropped]...\n` : '\n...[output truncated]...\n';
  return cap.head + marker + cap.tail;
}
const SKIP_ENV = new Set(['_', 'SHLVL', 'PWD', 'OLDPWD', 'BRIDGE_CMD', 'BRIDGE_CWD_FILE', 'BRIDGE_ENV_FILE', 'BRIDGE_TOKEN']);
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
// Prompt heuristics. Deliberately conservative: a bare "?"/":" alternative used to
// match ANY output ending that way (help texts, YAML dumps, progress lines) and made
// running commands look like AWAITING_INPUT. Keep explicit patterns only; bare "?"
// must sit on a short line to count.
const PROMPT_RE = /(\[[yY]\/[nN]\]|\(y\/n\)|\(yes\/no\)|\[Y\/n\]|\[y\/N\]|password[^\n]*:|passphrase[^\n]*:|enter[^\n:]*:|confirm[^\n:]*:|overwrite[^\n:]*:|continue\?|are you sure\?)/i;
const PROMPT_MAX_LINE = 100;

const stripAnsi = (s) => s.replace(ANSI_RE, '').replace(/\r(?!\n)/g, '\n');

function truncate(text, max = MAX_RESULT_CHARS) {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return {
    text: text.slice(0, head) + `\n...[${text.length - max} chars truncated]...\n` + text.slice(-tail),
    truncated: true
  };
}

function cleanBaseEnv() {
  const env = { ...process.env };
  delete env.BRIDGE_TOKEN; // never expose the bridge secret to commands the model runs
  env.TERM = 'dumb';
  env.DEBIAN_FRONTEND = env.DEBIAN_FRONTEND || 'noninteractive';
  env.GIT_TERMINAL_PROMPT = env.GIT_TERMINAL_PROMPT || '0';
  env.PAGER = 'cat';
  env.GIT_PAGER = 'cat';
  return env;
}

class TerminalSession {
  constructor(defaultCwd) {
    this.defaultCwd = defaultCwd || process.cwd();
    this.currentCwd = this.defaultCwd;
    this.env = cleanBaseEnv();
    this.history = [];
    this.seq = 0;
    this.epoch = 1;
    this.run = null; // currently active run
    this._execChain = null; // v1.1: serializes concurrent exec calls
    this.listeners = new Set();
    this.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-term-'));
  }

  /* ---------- events ---------- */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  broadcast(data) {
    for (const l of this.listeners) {
      try { l(data); } catch (e) { /* listener gone */ }
    }
  }

  emit(entry) {
    const e = { ...entry, seq: ++this.seq, cwd: this.currentCwd, ts: Date.now() };
    if (typeof e.text === 'string' && e.text.length > MAX_HISTORY_TEXT) {
      e.text = e.text.slice(0, MAX_HISTORY_TEXT) + '\n…[truncated]';
    }
    this.history.push(e);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.broadcast(e);
  }

  setCwd(newCwd) {
    if (newCwd && fs.existsSync(newCwd) && fs.statSync(newCwd).isDirectory()) {
      this.currentCwd = path.resolve(newCwd);
    }
  }

  getEnv() {
    return { ...this.env };
  }

  get isRunning() {
    return !!(this.run && !this.run.closed);
  }

  /* ---------- run control ---------- */
  killActiveProcess() {
    const run = this.run;
    if (!run || run.closed) return { success: false, message: 'No active command running' };
    this._terminate(run);
    const msg = `[Command terminated (PID ${run.child.pid})]`;
    this.emit({ type: 'stderr', text: msg });
    return { success: true, message: msg };
  }

  _terminate(run) {
    const pid = run.child.pid;
    const send = (sig) => { try { process.kill(-pid, sig); } catch (e) { try { run.child.kill(sig); } catch (e2) { /* gone */ } } };
    send('SIGTERM');
    setTimeout(() => { if (!run.closed) send('SIGKILL'); }, 2000).unref();
  }

  _loadState(run) {
    try {
      const cwd = fs.readFileSync(run.cwdFile, 'utf8').trim();
      if (cwd && fs.existsSync(cwd)) this.currentCwd = cwd;
    } catch (e) { /* command exited before trap, keep cwd */ }
    try {
      const raw = fs.readFileSync(run.envFile);
      const next = {};
      for (const part of raw.toString('utf8').split('\0')) {
        const i = part.indexOf('=');
        if (i <= 0) continue;
        const k = part.slice(0, i);
        if (SKIP_ENV.has(k) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        next[k] = part.slice(i + 1);
      }
      if (Object.keys(next).length) {
        this.env = { ...next, TERM: 'dumb' };
        delete this.env.BRIDGE_TOKEN;
      }
    } catch (e) { /* keep old env */ }
    for (const f of [run.cwdFile, run.envFile]) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }
  }

  /**
   * Wait for the run to finish, time out, or go idle on a prompt.
   * `mark` = offsets into the captured text, so callers only see NEW output.
   * (Once the capture overflows and the tail starts trimming, an old mark may point
   * past the current text — we then fall back to the newest 12K, close enough.)
   */
  _wait(run, mark, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let idleTimer = null;
      const since = (cap, from) => {
        const full = captureText(cap);
        return full.length >= from ? full.slice(from) : full.slice(Math.max(0, full.length - MAX_RESULT_CHARS));
      };
      const finish = (extra) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(idleTimer);
        run.onActivity = null;
        run.onClose = null;
        const out = truncate(stripAnsi(since(run.capOut, mark.out)).trim());
        const err = truncate(stripAnsi(since(run.capErr, mark.err)).trim());
        resolve({
          cwd: this.currentCwd,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
          durationMs: Date.now() - run.startedAt,
          ...extra
        });
      };

      const timeout = setTimeout(() => {
        this._terminate(run);
        const msg = `[Command timed out after ${timeoutMs}ms and was killed. For long-running processes (servers, watchers) use start_background.]`;
        this.emit({ type: 'stderr', text: msg });
        finish({ success: false, exitCode: -1, timedOut: true, stderr: msg });
      }, timeoutMs);

      const armIdle = () => {
        clearTimeout(idleTimer);
        const tail = stripAnsi(since(run.capOut, mark.out) + since(run.capErr, mark.err)).trimEnd();
        if (!tail) return;
        const lastLine = tail.split('\n').pop() || '';
        if (lastLine.length > PROMPT_MAX_LINE) return;
        if (!PROMPT_RE.test(lastLine)) return;
        idleTimer = setTimeout(() => {
          if (run.closed) return;
          run.needsInput = true;
          this.emit({ type: 'prompt', text: lastLine });
          finish({ success: true, exitCode: null, running: true, needsInput: true });
        }, IDLE_PROMPT_MS);
      };

      run.onActivity = armIdle;
      run.onClose = (code) => finish({ success: code === 0, exitCode: code ?? 1 });
      if (run.closed) run.onClose(run.exitCode);
    });
  }

  /**
   * Parallel-safe entry point (v1.1): concurrent exec calls are SERIALIZED via a
   * promise chain instead of the old behavior (a second exec killed the running
   * command — that destroyed parallel tool batches). `opts.force` (human "Run"
   * from the panel) drops the queue, kills the active run and starts immediately.
   * If the session is parked AWAITING_INPUT, a queued exec returns an informative
   * error instead of silently killing the process that is waiting for input.
   */
  exec(command, timeoutMs = 60000, opts = {}) {
    if (!command || typeof command !== 'string') return Promise.reject(new Error('Command is required'));
    timeoutMs = Math.min(Math.max(parseInt(timeoutMs, 10) || 60000, 1000), 15 * 60 * 1000);
    if (opts && opts.force) {
      // Human barge-in: drop the queue, kill whatever runs, go NOW (v1.0 spirit).
      // The epoch bump makes queued continuations skip themselves instead of
      // starting later and killing the manual command; their processes are
      // killed below and the close-race guard keeps state snapshots clean.
      this._execEpoch = (this._execEpoch || 0) + 1;
      this._execChain = null;
      if (this.isRunning) this.killActiveProcess();
      const p = this._execNow(command, timeoutMs, true);
      this._execChain = p.catch(() => {});
      return p;
    }
    const ep = this._execEpoch || 0;
    const prev = this._execChain;
    const p = (prev ? prev.catch(() => {}) : Promise.resolve())
      .then(() => {
        if ((this._execEpoch || 0) !== ep) {
          return { success: false, exitCode: null, cwd: this.currentCwd, stdout: '', stderr: 'Skipped: a manual run barged in while this command was queued.' };
        }
        return this._execNow(command, timeoutMs, false);
      });
    this._execChain = p.catch(() => {});
    return p;
  }

  async _execNow(command, timeoutMs, force) {
    if (this.isRunning) {
      if (this.run && this.run.needsInput && !force) {
        return {
          success: false, exitCode: null, needsInput: true, cwd: this.currentCwd, stdout: '',
          stderr: 'Terminal is AWAITING_INPUT on a previous command. Reply with terminal_input or abort it with terminal_kill first (parallel terminal calls share one session, so run terminal commands one at a time).'
        };
      }
      this.killActiveProcess();
    }

    const id = Math.random().toString(36).slice(2, 10);
    const cwdFile = path.join(this.stateDir, `${id}.cwd`);
    const envFile = path.join(this.stateDir, `${id}.env`);

    const script = 'trap \'pwd -P > "$BRIDGE_CWD_FILE" 2>/dev/null; env -0 > "$BRIDGE_ENV_FILE" 2>/dev/null\' EXIT; eval "$BRIDGE_CMD"';

    if (!fs.existsSync(this.currentCwd)) this.currentCwd = this.defaultCwd;
    this.emit({ type: 'command', text: command });

    let child;
    try {
      child = spawn('/bin/bash', ['-c', script], {
        cwd: this.currentCwd,
        env: { ...this.env, BRIDGE_CMD: command, BRIDGE_CWD_FILE: cwdFile, BRIDGE_ENV_FILE: envFile },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      this.emit({ type: 'stderr', text: err.message });
      return { success: false, exitCode: 1, cwd: this.currentCwd, stdout: '', stderr: err.message };
    }

    const run = {
      child,
      capOut: makeCapture(), capErr: makeCapture(),
      closed: false, exitCode: null, startedAt: Date.now(), cwdFile, envFile, onActivity: null, onClose: null, needsInput: false
    };
    this.run = run;

    child.stdin.on('error', () => { /* process ended before stdin write */ });
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      appendCapture(run.capOut, s);
      this.emit({ type: 'stdout', text: stripAnsi(s) });
      if (run.onActivity) run.onActivity();
    });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      appendCapture(run.capErr, s);
      this.emit({ type: 'stderr', text: stripAnsi(s) });
      if (run.onActivity) run.onActivity();
    });
    child.on('error', (err) => {
      appendCapture(run.capErr, err.message);
      this.emit({ type: 'stderr', text: err.message });
    });
    child.on('close', (code, signal) => {
      run.closed = true;
      run.exitCode = code ?? (signal ? 128 : 1);
      // Race guard: if a NEW exec already started, this close belongs to a killed/stale
      // command. Its cwd/env snapshot is older than the new run's state — applying it
      // would clobber the fresh session state mid-flight.
      if (this.run === run) {
        this._loadState(run);
        this.run = null;
      }
      this.emit({ type: 'exit', code: run.exitCode, durationMs: Date.now() - run.startedAt });
      if (run.onClose) run.onClose(run.exitCode);
    });

    return this._wait(run, { out: 0, err: 0 }, timeoutMs);
  }

  async sendInput(text) {
    const run = this.run;
    if (!run || run.closed || !run.child.stdin.writable) {
      return { success: false, message: 'No active command waiting for input' };
    }
    const line = String(text ?? '').endsWith('\n') ? String(text) : String(text ?? '') + '\n';
    // Marks are offsets into the captured text at the moment of sending; _wait then
    // only reports output newer than the mark (see the fallback in _wait.since).
    const mark = { out: captureText(run.capOut).length, err: captureText(run.capErr).length };
    this.emit({ type: 'stdin', text: line.trimEnd() });
    run.child.stdin.write(line);
    run.needsInput = false;
    const result = await this._wait(run, mark, 30000);
    return { ...result, message: `Sent input: ${String(text ?? '').trim()}` };
  }

  clear() {
    this.history = [];
    this.epoch++;
    this.broadcast({ type: 'clear' });
    return { success: true };
  }

  /** Entries newer than `since` (for polling clients). */
  getSince(since = 0) {
    return {
      epoch: this.epoch,
      latest: this.seq,
      cwd: this.currentCwd,
      busy: this.isRunning,
      entries: this.history.filter(e => e.seq > since)
    };
  }

  dispose() {
    if (this.isRunning) this.killActiveProcess();
    try { fs.rmSync(this.stateDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

let defaultSession = null;
function getTerminalSession(cwd) {
  if (!defaultSession) defaultSession = new TerminalSession(cwd);
  if (cwd) defaultSession.setCwd(cwd);
  return defaultSession;
}

module.exports = { TerminalSession, getTerminalSession, stripAnsi, truncate };
