'use strict';
/**
 * Minimal MCP (Model Context Protocol) stdio client.
 * Performs the real handshake (initialize -> notifications/initialized), then supports
 * tools/list and tools/call. Servers are configured in server/config.json:
 *   "mcpServers": { "name": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/root"], "env": {} } }
 */
const { spawn } = require('child_process');

const servers = new Map(); // name -> instance
let nextId = 1;

function baseEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  delete env.BRIDGE_TOKEN;
  return env;
}

function startServer(name, cfg) {
  if (!cfg || !cfg.command) throw new Error(`MCP server '${name}' has no "command" in config.json`);
  const child = spawn(cfg.command, cfg.args || [], {
    env: baseEnv(cfg.env),
    cwd: cfg.cwd || undefined,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const pending = new Map();
  let buffer = '';
  let stderrTail = '';
  const inst = { name, child, ready: null, tools: null, pending };

  const failAll = (err) => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(err); }
    pending.clear();
  };

  child.stdout.on('data', (d) => {
    buffer += d.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
        else resolve(msg.result);
      }
    }
  });
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-2000); });
  child.on('error', (err) => { failAll(new Error(`MCP '${name}' failed to start: ${err.message}`)); servers.delete(name); });
  child.on('exit', (code) => {
    failAll(new Error(`MCP '${name}' exited (code ${code}). ${stderrTail.trim()}`));
    servers.delete(name);
  });

  inst.request = (method, params, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP '${name}' ${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  inst.notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  inst.ready = (async () => {
    await inst.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'deepseek-bridge', version: '3.1.0' }
    }, 60000);
    inst.notify('notifications/initialized');
  })();

  // If the handshake fails (bad command, timeout, crash), drop the instance so the
  // NEXT call starts a fresh process instead of reusing a permanently-rejected
  // ready promise (previously a single failed init poisoned the server until restart).
  inst.ready.catch(() => {
    try { inst.child.kill('SIGTERM'); } catch (e) { /* gone */ }
    if (servers.get(name) === inst) servers.delete(name);
  });

  servers.set(name, inst);
  return inst;
}

async function getServer(config, name) {
  const cfgs = config.mcpServers || {};
  const sName = name || Object.keys(cfgs)[0];
  if (!sName || !cfgs[sName]) {
    const known = Object.keys(cfgs);
    throw new Error(`MCP server '${sName || '(none)'}' is not configured. ${known.length ? 'Configured: ' + known.join(', ') : 'Add one under "mcpServers" in server/config.json.'}`);
  }
  const inst = servers.get(sName) || startServer(sName, cfgs[sName]);
  await inst.ready;
  return inst;
}

async function listMcp({ serverName }, config) {
  const cfgs = config.mcpServers || {};
  if (!Object.keys(cfgs).length) return { servers: [], message: 'No MCP servers configured in server/config.json' };
  const names = serverName ? [serverName] : Object.keys(cfgs);
  const out = [];
  for (const n of names) {
    try {
      const inst = await getServer(config, n);
      const res = await inst.request('tools/list', {});
      out.push({ server: n, tools: (res.tools || []).map(t => ({ name: t.name, description: (t.description || '').slice(0, 300), inputSchema: t.inputSchema })) });
    } catch (err) {
      out.push({ server: n, error: err.message });
    }
  }
  return { servers: out };
}

async function callMcpTool({ serverName, toolName, arguments: toolArgs }, config) {
  if (!toolName) throw new Error('toolName is required');
  const inst = await getServer(config, serverName);
  const res = await inst.request('tools/call', { name: toolName, arguments: toolArgs || {} }, 120000);
  const text = (res.content || []).map(c => c.type === 'text' ? c.text : `[${c.type} content]`).join('\n');
  return { isError: !!res.isError, text: text.length > 12000 ? text.slice(0, 12000) + '\n...[truncated]' : text, raw: res.content ? undefined : res };
}

function stopAll() {
  for (const inst of servers.values()) { try { inst.child.kill('SIGTERM'); } catch (e) { /* gone */ } }
}

module.exports = { callMcpTool, listMcp, stopAll };
