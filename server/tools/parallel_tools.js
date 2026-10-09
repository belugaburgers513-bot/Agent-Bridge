'use strict';
/**
 * parallel_commands (v1.2) — run several shell commands at the SAME TIME on one VPS.
 * Each command gets its own process (own bash), so they truly run concurrently,
 * unlike terminal_exec which is one shared persistent shell (queued).
 * Zero deps. Outputs are capped per command. Denylist is checked by server.js.
 */
const { spawn } = require('child_process');
const path = require('path');

const MAX_COMMANDS = 8;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const OUT_CAP = 40000; // per stream, per command (head+tail keeps start and end)

function clip(buf) {
  const s = buf.toString('utf8');
  if (s.length <= OUT_CAP) return s;
  const head = s.slice(0, 24000);
  const tail = s.slice(-14000);
  return head + `\n...[output clipped: ${s.length} chars total]...\n` + tail;
}

function resolveCwd(cwd, config) {
  const root = config.workspaceRoot;
  if (!cwd) return root;
  const p = path.resolve(String(cwd).startsWith('~') ? path.join(root, String(cwd).slice(1)) : String(cwd));
  if (p === root || p.startsWith(root + path.sep)) return p;
  return root; // jail to the workspace like everything else
}

function runOne(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('bash', ['-c', command], { cwd, env: process.env });
    let out = '', err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < OUT_CAP * 2) out += d; });
    child.stderr.on('data', (d) => { if (err.length < OUT_CAP * 2) err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ command, exitCode: null, stdout: '', stderr: `spawn failed: ${e.message}`, timedOut: false, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ command, exitCode: code, stdout: clip(out), stderr: clip(err), timedOut, durationMs: Date.now() - started });
    });
  });
}

async function parallelCommands(params, config) {
  const commands = Array.isArray(params && params.commands)
    ? params.commands.map((c) => String(c || '')).filter((c) => c.trim())
    : [];
  if (!commands.length) throw new Error('parallel_commands needs { commands: ["...", "..."] } (1-8 commands)');
  if (commands.length > MAX_COMMANDS) throw new Error(`Too many commands (${commands.length}) — max ${MAX_COMMANDS} per call`);
  const timeoutMs = Math.min(Math.max(parseInt(params.timeoutMs, 10) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  const cwd = resolveCwd(params.cwd, config);

  const t0 = Date.now();
  // All at once — that is the entire point of this tool.
  const results = await Promise.all(commands.map((c) => runOne(c, cwd, timeoutMs)));
  const failed = results.filter((r) => r.exitCode !== 0).length;
  return {
    cwd,
    count: results.length,
    wallMs: Date.now() - t0,
    failed,
    results
  };
}

module.exports = { parallelCommands };
