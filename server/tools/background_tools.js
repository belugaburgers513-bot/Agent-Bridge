'use strict';
/**
 * Long-running processes (dev servers, bots, watchers) that must outlive a single command.
 * Detached, logged to ~/.deepseek-bridge/logs/<name>.log, tracked in ~/.deepseek-bridge/bg.json
 * so they survive bridge restarts.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripAnsi } = require('./terminal_session');

const BASE = path.join(os.homedir(), '.deepseek-bridge');
const LOG_DIR = path.join(BASE, 'logs');
const REG = path.join(BASE, 'bg.json');

function load() {
  try { return JSON.parse(fs.readFileSync(REG, 'utf8')); } catch (e) { return {}; }
}
function save(reg) {
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(REG, JSON.stringify(reg, null, 2));
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}
function safeName(n) {
  const s = String(n || '').trim().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40);
  if (!s) throw new Error('name is required (letters, numbers, - _ .)');
  return s;
}

async function startBackground({ command, name, cwd }, config, session) {
  if (!command || typeof command !== 'string') throw new Error('command is required');
  const id = safeName(name);
  const reg = load();
  if (reg[id] && alive(reg[id].pid)) throw new Error(`'${id}' is already running (PID ${reg[id].pid}). Use stop_background first.`);

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${id}.log`);
  const fd = fs.openSync(logPath, 'a');
  const workDir = cwd ? path.resolve(session.currentCwd, cwd) : session.currentCwd;
  if (!fs.existsSync(workDir)) throw new Error(`cwd does not exist: ${workDir}`);

  const child = spawn('/bin/bash', ['-c', command], {
    cwd: workDir,
    env: session.getEnv(),
    detached: true,
    stdio: ['ignore', fd, fd]
  });
  child.unref();
  fs.closeSync(fd);

  await new Promise(r => setTimeout(r, 800)); // catch instant crashes
  const running = alive(child.pid);
  reg[id] = { pid: child.pid, command, cwd: workDir, startedAt: new Date().toISOString(), logPath };
  save(reg);

  let firstLines = '';
  try { firstLines = stripAnsi(fs.readFileSync(logPath, 'utf8')).slice(-1500); } catch (e) { /* none yet */ }
  return {
    success: running,
    name: id,
    pid: child.pid,
    running,
    logPath,
    output: firstLines.trim(),
    message: running ? `Started '${id}' (PID ${child.pid}). Use tail_log to watch it.` : `'${id}' exited immediately. Output above.`
  };
}

async function listBackground() {
  const reg = load();
  const items = Object.entries(reg).map(([name, v]) => ({
    name, pid: v.pid, running: alive(v.pid), command: v.command, cwd: v.cwd, startedAt: v.startedAt
  }));
  return { count: items.length, processes: items };
}

async function tailLog({ name, lines = 50 }) {
  const id = safeName(name);
  const reg = load();
  const logPath = reg[id]?.logPath || path.join(LOG_DIR, `${id}.log`);
  if (!fs.existsSync(logPath)) throw new Error(`No log for '${id}'`);
  const stat = fs.statSync(logPath);
  const start = Math.max(0, stat.size - 64 * 1024);
  const buf = Buffer.alloc(stat.size - start);
  const fd = fs.openSync(logPath, 'r');
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const n = Math.min(Math.max(parseInt(lines, 10) || 50, 1), 500);
  const out = stripAnsi(buf.toString('utf8')).split('\n').slice(-n).join('\n');
  return { name: id, running: reg[id] ? alive(reg[id].pid) : false, log: out };
}

async function stopBackground({ name }) {
  const id = safeName(name);
  const reg = load();
  const entry = reg[id];
  if (!entry) throw new Error(`No background process named '${id}'`);
  if (alive(entry.pid)) {
    try { process.kill(-entry.pid, 'SIGTERM'); } catch (e) { try { process.kill(entry.pid, 'SIGTERM'); } catch (e2) { /* gone */ } }
    await new Promise(r => setTimeout(r, 1500));
    if (alive(entry.pid)) {
      try { process.kill(-entry.pid, 'SIGKILL'); } catch (e) { try { process.kill(entry.pid, 'SIGKILL'); } catch (e2) { /* gone */ } }
    }
  }
  delete reg[id];
  save(reg);
  return { success: true, message: `Stopped '${id}'` };
}

module.exports = { startBackground, listBackground, tailLog, stopBackground };
