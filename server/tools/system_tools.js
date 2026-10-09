const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function sh(cmd, timeout = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, shell: '/bin/bash' }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** Common folders for the UI file browser (Ubuntu). */
function getSystemFolders(config) {
  const home = os.homedir();
  return {
    homeDir: home,
    tmp: os.tmpdir(),
    root: '/',
    workspaceRoot: config ? config.workspaceRoot : process.cwd()
  };
}

/** Which process listens on a TCP port (uses `ss`, present on all Ubuntu installs). */
async function checkPort({ port }) {
  const portNum = parseInt(port, 10);
  if (!portNum || portNum < 1 || portNum > 65535) throw new Error(`Invalid port number: ${port}`);
  const out = await sh(`ss -ltnpH "sport = :${portNum}" 2>/dev/null`);
  const line = out.split('\n').find(l => l.trim());
  if (line) {
    const pidMatch = line.match(/pid=(\d+)/);
    const procMatch = line.match(/users:\(\("([^"]+)"/);
    return { port: portNum, inUse: true, pid: pidMatch ? parseInt(pidMatch[1], 10) : null, process: procMatch ? procMatch[1] : null };
  }
  // Fallback when `ss` is unavailable
  const lsof = await sh(`lsof -nP -iTCP:${portNum} -sTCP:LISTEN -Fpc 2>/dev/null`);
  const pid = (lsof.match(/^p(\d+)/m) || [])[1];
  const cmd = (lsof.match(/^c(.+)$/m) || [])[1];
  if (pid) return { port: portNum, inUse: true, pid: parseInt(pid, 10), process: cmd || null };
  return { port: portNum, inUse: false };
}

async function killPort({ port }) {
  const status = await checkPort({ port });
  if (!status.inUse) return { success: true, port: status.port, message: `Port ${status.port} is not in use.` };
  if (!status.pid) throw new Error(`Port ${status.port} is in use but the PID is not visible (need root?).`);
  try {
    process.kill(status.pid, 'SIGTERM');
    await new Promise(r => setTimeout(r, 800));
    try { process.kill(status.pid, 0); process.kill(status.pid, 'SIGKILL'); } catch (e) { /* already dead */ }
  } catch (err) {
    throw new Error(`Failed to kill PID ${status.pid} on port ${status.port}: ${err.message}`);
  }
  return { success: true, port: status.port, killedPid: status.pid, message: `Terminated ${status.process || 'process'} (PID ${status.pid}) on port ${status.port}` };
}

/** Machine summary for the model and the UI header. */
async function getServerInfo(config) {
  const [disk, mem, uptime, osRelease] = await Promise.all([
    sh(`df -h --output=size,used,avail,pcent / | tail -1`),
    sh(`free -m | awk '/Mem:/ {print $2" "$3" "$7}'`),
    sh(`uptime -p`),
    sh(`. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"`)
  ]);
  const d = disk.trim().split(/\s+/);
  const m = mem.trim().split(/\s+/).map(Number);
  return {
    os: osRelease.trim() || `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    arch: os.arch(),
    node: process.version,
    user: os.userInfo().username,
    isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
    cpus: os.cpus().length,
    loadAvg: os.loadavg().map(n => +n.toFixed(2)),
    memory: m.length === 3 ? { totalMB: m[0], usedMB: m[1], availableMB: m[2] } : null,
    disk: d.length === 4 ? { size: d[0], used: d[1], avail: d[2], usedPercent: d[3] } : null,
    uptime: uptime.trim(),
    workspaceRoot: config.workspaceRoot
  };
}

module.exports = { getSystemFolders, checkPort, killPort, getServerInfo };
