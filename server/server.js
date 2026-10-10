'use strict';
/**
 * OrbitBridge server v1.2 — Ubuntu/Linux, built to sit behind a Cloudflare Tunnel.
 * Zero dependencies. Every /api request needs the bearer token.
 * v1.2: live event bus (panel Live tab feed), installer endpoints,
 * and the parallel_commands tool (many shell commands at once on ONE VPS).
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const fsTools = require('./tools/fs_tools');
const webTools = require('./tools/web_tools');
const systemTools = require('./tools/system_tools');
const gitTools = require('./tools/git_tools');
const mcpClient = require('./tools/mcp_client');
const bgTools = require('./tools/background_tools');
const parallelTools = require('./tools/parallel_tools');
const installer = require('./installer');
const { getTerminalSession } = require('./tools/terminal_session');

const VERSION = '1.8.2';
const STARTED_AT = new Date().toISOString();

process.on('uncaughtException', (err) => console.error('[Server Error] Uncaught:', err));
process.on('unhandledRejection', (reason) => console.error('[Server Error] Rejection:', reason));

/* ------------------------------------------------------------------ config */
const CONFIG_PATH = path.join(__dirname, 'config.json');

let config = {
  port: 3456,
  workspaceRoot: os.homedir(),
  strictWorkspace: true,
  allowedOrigins: [],
  commandTimeoutMs: 60000,
  mcpServers: {},
  // Lockdown defaults (v3.1):
  // refuse fetching loopback/private/metadata IPs from fetch_web_url
  allowPrivateFetch: false,
  // only trust X-Forwarded-For / CF-Connecting-IP when explicitly enabled —
  // otherwise clients can spoof the header and sidestep the brute-force brake.
  // Enable this ONLY when every request really comes through the tunnel.
  trustProxyHeaders: false,
  // substrings that must never appear in commands run via terminal_exec /
  // run_command / start_background (best-effort accident guard, not a sandbox)
  commandDenylist: [
    'rm -rf /', 'rm -rf /*', 'mkfs', 'dd if=/dev/zero of=/dev/',
    ':(){ :|:& };:', 'chmod -R 777 /', 'shutdown', 'reboot',
    'history -c', 'iptables -F', 'ufw disable'
  ]
};

try {
  if (fs.existsSync(CONFIG_PATH)) {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    config = { ...config, ...loaded };
  }
} catch (err) {
  console.warn('Could not read config.json, using defaults.', err.message);
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~' || p === '.') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

if (process.env.PORT) config.port = parseInt(process.env.PORT, 10) || config.port;
if (process.env.WORKSPACE_ROOT) config.workspaceRoot = process.env.WORKSPACE_ROOT;
if (process.env.ALLOWED_ORIGINS) config.allowedOrigins = process.env.ALLOWED_ORIGINS.split(',').map(x => x.trim()).filter(Boolean);
if (process.env.STRICT_WORKSPACE) config.strictWorkspace = process.env.STRICT_WORKSPACE !== '0' && process.env.STRICT_WORKSPACE !== 'false';
if (process.env.ALLOW_PRIVATE_FETCH) config.allowPrivateFetch = process.env.ALLOW_PRIVATE_FETCH === '1' || process.env.ALLOW_PRIVATE_FETCH === 'true';
if (process.env.TRUST_PROXY_HEADERS) config.trustProxyHeaders = process.env.TRUST_PROXY_HEADERS === '1' || process.env.TRUST_PROXY_HEADERS === 'true';
if (process.env.COMMAND_DENYLIST) config.commandDenylist = process.env.COMMAND_DENYLIST.split('||').map(x => x.trim()).filter(Boolean);
if (process.env.MAX_UPLOAD_MB) config.maxUploadMb = parseInt(process.env.MAX_UPLOAD_MB, 10) || 200;
if (!config.maxUploadMb) config.maxUploadMb = 200;

config.workspaceRoot = path.resolve(expandHome(config.workspaceRoot) || os.homedir());
fs.mkdirSync(config.workspaceRoot, { recursive: true });

function uploadsDir() {
  const dir = path.join(config.workspaceRoot, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function persistConfig() {
  const { port, workspaceRoot, strictWorkspace, allowedOrigins, commandTimeoutMs, mcpServers, allowPrivateFetch, trustProxyHeaders, commandDenylist, maxUploadMb } = config;
  // atomic write: a crash mid-write must not leave a truncated config.json
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ port, workspaceRoot, strictWorkspace, allowedOrigins, commandTimeoutMs, mcpServers, allowPrivateFetch, trustProxyHeaders, commandDenylist, maxUploadMb }, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

/* ------------------------------------------------------------------- token */
const TOKEN_PATH = path.join(__dirname, '.token');
let AUTH_TOKEN = (process.env.BRIDGE_TOKEN || '').trim();
if (!AUTH_TOKEN && fs.existsSync(TOKEN_PATH)) AUTH_TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
if (!AUTH_TOKEN) {
  AUTH_TOKEN = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_PATH, AUTH_TOKEN + '\n', { mode: 0o600 });
  console.log('🔑 Generated new auth token -> server/.token');
}
try { fs.chmodSync(TOKEN_PATH, 0o600); } catch (e) { /* not file-backed */ }
const TOKEN_HASH = crypto.createHash('sha256').update(AUTH_TOKEN).digest();
// Commands run by the model must never see the secret.
delete process.env.BRIDGE_TOKEN;

function isAuthorized(req, url) {
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : (url.searchParams.get('token') || '');
  const hash = crypto.createHash('sha256').update(supplied).digest();
  return crypto.timingSafeEqual(hash, TOKEN_HASH);
}

// Brute-force brake: 15 bad tokens / minute / client.
// v3.1: the client id is the socket address by default. 'cf-connecting-ip' is
// CLIENT-CONTROLLED unless the request really came through Cloudflare, so trusting
// it unconditionally let an attacker rotate the header on every try and sidestep
// the brake. Enable trustProxyHeaders only when the tunnel is the only path in.
const failures = new Map();
function clientId(req) {
  if (config.trustProxyHeaders) {
    const cf = req.headers['cf-connecting-ip'];
    const xff = req.headers['x-forwarded-for'];
    if (typeof cf === 'string' && cf.trim()) return 'cf:' + cf.trim();
    if (typeof xff === 'string' && xff.trim()) return 'xff:' + xff.trim().split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
function tooManyFailures(id) {
  const now = Date.now();
  const list = (failures.get(id) || []).filter(t => now - t < 60000);
  failures.set(id, list);
  return list.length >= 15;
}
function recordFailure(id) {
  const list = failures.get(id) || [];
  list.push(Date.now());
  failures.set(id, list);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of failures) if (!v.some(t => now - t < 60000)) failures.delete(k);
}, 60000).unref();

/* ----------------------------------------------------------------- session */
const terminalSession = getTerminalSession(config.workspaceRoot);

const recentLogs = [];
// Params can carry whole file bodies (write_file / batch_write_files up to 25 MB);
// keeping them verbatim in the 100-entry ring would pin gigabytes. Clip long strings.
function clipParams(v, depth = 0) {
  if (typeof v === 'string') return v.length > 2000 ? v.slice(0, 2000) + `…[${v.length - 2000} more chars]` : v;
  if (v == null || typeof v !== 'object' || depth > 4) return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clipParams(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v).slice(0, 50)) out[k] = clipParams(v[k], depth + 1);
  return out;
}
function addLog(entry) {
  if (entry && entry.params !== undefined) entry = { ...entry, params: clipParams(entry.params) };
  recentLogs.unshift({ timestamp: new Date().toISOString(), ...entry });
  if (recentLogs.length > 100) recentLogs.pop();
}

/* -------------------------------------------------------------- event bus */
// Everything the panel's Live feed shows goes through here: tool calls,
// uploads, install progress. Small ring buffer so a freshly opened Live tab
// can replay what it missed.
const eventSubs = new Set();
const recentEvents = [];
function emitEvent(evt) {
  const e = { ts: new Date().toISOString(), ...evt };
  recentEvents.push(e);
  if (recentEvents.length > 120) recentEvents.shift();
  for (const fn of eventSubs) {
    try { fn(e); } catch (err) { /* a dead subscriber must not kill the rest */ }
  }
}

function describeParams(tool, params) {
  try {
    if (/^(terminal_exec|run_command)$/.test(tool) && params.command) return String(params.command).slice(0, 160);
    if (tool === 'parallel_commands' && Array.isArray(params.commands)) return params.commands.map((c) => String(c).slice(0, 60)).join('  |  ').slice(0, 200);
    if (tool === 'terminal_input' && params.input != null) return `« ${String(params.input).slice(0, 120)}`;
    const p = params.path || params.from || params.to || params.url || params.cwd || params.name || '';
    if (p) return String(p).slice(0, 160);
    if (tool === 'mcp_call') return `${params.serverName || ''}::${params.toolName || ''}`;
    if (tool === 'batch_write_files' && Array.isArray(params.files)) return params.files.map((f) => f.path).join(', ').slice(0, 160);
    return JSON.stringify(params).slice(0, 140);
  } catch (e) { return ''; }
}

/* -------------------------------------------------------------------- CORS */
function isOriginAllowed(origin) {
  if (!origin) return true; // non-browser client (still needs token)
  if ((config.allowedOrigins || []).includes(origin)) return true;
  return [
    /^https:\/\/chat\.deepseek\.com$/i,
    /^https:\/\/chat\.z\.ai$/i,
    /^https:\/\/chatgpt\.com$/i,
    /^https:\/\/chat\.openai\.com$/i,
    /^https:\/\/claude\.ai$/i,
    /^https:\/\/gemini\.google\.com$/i,
    /^chrome-extension:\/\/[a-z0-9]+$/i,
    /^moz-extension:\/\/[a-z0-9-]+$/i
  ].some(p => p.test(origin));
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > 25 * 1024 * 1024) {
        done = true;
        const err = new Error('Payload too large');
        err.code = 'ETooLarge';
        req.resume(); // drain instead of destroying the socket so the 413 can actually be delivered
        reject(err);
        return;
      }
      chunks.push(chunk); // Buffers: decoding per chunk would corrupt multi-byte chars split across chunks
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const body = Buffer.concat(chunks, size).toString('utf8');
      let parsed;
      try { parsed = body.trim() ? JSON.parse(body) : {}; } catch (e) { const err = new Error('Invalid JSON body'); err.code = 'EBadJson'; reject(err); return; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { const err = new Error('JSON body must be an object'); err.code = 'EBadJson'; reject(err); return; }
      resolve(parsed);
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function parseRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error(`Upload too large (max ${Math.round(maxBytes / (1024 * 1024))} MB)`);
        err.code = 'ETooLarge';
        req.resume(); // drain what the client already sent, then answer 413
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeUploadName(name) {
  let n = path.basename(String(name || 'file'));
  n = n.replace(/[^\w.() \-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[._ ]+/, '').trim();
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n || 'file';
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.gz': 'application/gzip', '.tgz': 'application/gzip', '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json',
  '.csv': 'text/csv', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.log': 'text/plain; charset=utf-8'
};

/* ------------------------------------------------------------------- tools */
/**
 * Lockdown guard for shell-running tools. Best-effort accident guard, NOT a sandbox:
 * eval'd shell is trivially obfuscated, so this catches the obvious footguns
 * (rm -rf /, mkfs, fork bombs, ...). Tune via commandDenylist in config.json.
 */
function checkCommandPolicy(command) {
  const list = Array.isArray(config.commandDenylist) ? config.commandDenylist : [];
  const cmd = String(command || '');
  const hit = list.find(entry => entry && cmd.includes(entry));
  if (hit) {
    const err = new Error(`Blocked by bridge command policy: command contains '${hit}'. Ask the user to adjust commandDenylist in server/config.json if this is legitimate.`);
    err.code = 'POLICY_BLOCKED';
    throw err;
  }
}

async function runTool(tool, params) {
  switch (tool) {
    // files
    case 'read_file': return fsTools.readFile(params, config);
    case 'write_file': return fsTools.writeFile(params, config);
    case 'edit_file': return fsTools.editFile(params, config);
    case 'list_dir': return fsTools.listDir(params, config);
    case 'make_dir': return fsTools.makeDir(params, config);
    case 'delete_file': return fsTools.deleteFile(params, config);
    case 'file_exists': return fsTools.fileExists(params, config);
    case 'batch_write_files': return fsTools.batchWriteFiles(params, config);
    case 'search_files': return fsTools.searchFiles(params, config);
    case 'zip_files': return fsTools.zipFiles(params, config);
    case 'unzip_file': return fsTools.unzipFile(params, config);
    case 'move_path': return fsTools.movePath(params, config);
    case 'copy_path': return fsTools.copyPath(params, config);
    // web
    case 'fetch_web_url': return webTools.fetchWebUrl(params, config);
    // shell
    case 'terminal_exec':
    case 'run_command':
      checkCommandPolicy(params.command || params.cmd);
      return terminalSession.exec(params.command || params.cmd, params.timeoutMs || config.commandTimeoutMs);
    case 'parallel_commands':
      for (const c of (Array.isArray(params.commands) ? params.commands : [])) checkCommandPolicy(c);
      return parallelTools.parallelCommands(params, config);
    case 'terminal_input': return terminalSession.sendInput(params.input ?? params.text);
    case 'terminal_kill': return terminalSession.killActiveProcess();
    // background processes
    case 'start_background':
      checkCommandPolicy(params.command);
      return bgTools.startBackground(params, config, terminalSession);
    case 'list_background': return bgTools.listBackground();
    case 'tail_log': return bgTools.tailLog(params);
    case 'stop_background': return bgTools.stopBackground(params);
    // system
    case 'check_port': return systemTools.checkPort(params);
    case 'kill_port': return systemTools.killPort(params);
    case 'get_system_info':
    case 'get_server_info':
      return systemTools.getServerInfo(config);
    // git
    case 'git_status': return gitTools.gitStatus(params, config);
    case 'git_diff': return gitTools.gitDiff(params, config);
    case 'git_log': return gitTools.gitLog(params, config);
    // mcp
    case 'mcp_list': return mcpClient.listMcp(params, config);
    case 'mcp_call': return mcpClient.callMcpTool(params, config);
    default:
      throw new Error(`Unknown tool: '${tool}'`);
  }
}

function summarize(result) {
  if (result == null) return 'OK';
  if (typeof result !== 'object') return String(result).slice(0, 200);
  const s = result.message || result.stdout || result.text || (result.exitCode != null ? `exit ${result.exitCode}` : 'OK');
  return String(s).slice(0, 200);
}

/* ------------------------------------------------------------------ routes */
const server = http.createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    console.warn(`[Security] Blocked origin: ${origin}`);
    sendJson(res, 403, { success: false, error: 'Forbidden origin' });
    return;
  }

  let url;
  try { url = new URL(req.url, 'http://localhost'); } // fixed base: a hostile Host header must not be able to throw here
  catch (e) { sendJson(res, 400, { success: false, error: 'Bad request URL' }); return; }

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`OrbitBridge v${VERSION}\n`);
    return;
  }

  if (!url.pathname.startsWith('/api/')) { sendJson(res, 404, { error: 'Not found' }); return; }

  const cid = clientId(req);
  if (tooManyFailures(cid)) { sendJson(res, 429, { success: false, error: 'Too many failed attempts. Wait a minute.' }); return; }
  if (!isAuthorized(req, url)) {
    recordFailure(cid);
    sendJson(res, 401, { success: false, error: 'Unauthorized: missing or invalid token' });
    return;
  }

  try {
    if (url.pathname === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, {
        status: 'online',
        version: VERSION,
        platform: process.platform,
        host: os.hostname(),
        user: os.userInfo().username,
        workspaceRoot: config.workspaceRoot,
        strictWorkspace: config.strictWorkspace,
        terminalCwd: terminalSession.currentCwd,
        terminalBusy: terminalSession.isRunning,
        folders: systemTools.getSystemFolders(config),
        uploadsDir: path.join(config.workspaceRoot, 'uploads'),
        maxUploadMb: config.maxUploadMb,
        uptimeSec: Math.floor(process.uptime()),
        node: process.version,
        startedAt: STARTED_AT
      });
      return;
    }

    if (url.pathname === '/api/info' && req.method === 'GET') {
      sendJson(res, 200, { success: true, info: await systemTools.getServerInfo(config) });
      return;
    }

    // Self-documenting tool catalog (new in v3.1): what this bridge can run,
    // plus the active policy knobs, so prompt/UI stay in sync with the server.
    if (url.pathname === '/api/tools' && req.method === 'GET') {
      sendJson(res, 200, {
        success: true,
        version: VERSION,
        policy: {
          strictWorkspace: config.strictWorkspace,
          workspaceRoot: config.workspaceRoot,
          allowPrivateFetch: !!config.allowPrivateFetch,
          trustProxyHeaders: !!config.trustProxyHeaders,
          commandDenylistCount: Array.isArray(config.commandDenylist) ? config.commandDenylist.length : 0
        },
        tools: [
          { name: 'read_file',         group: 'files',     params: { path: 'string', offset: 'int?', length: 'int?', withLineNumbers: 'bool?' } },
          { name: 'write_file',        group: 'files',     params: { path: 'string', content: 'string' } },
          { name: 'edit_file',         group: 'files',     params: { path: 'string', search: 'string', replace: 'string', allowMultiple: 'bool?' } },
          { name: 'list_dir',          group: 'files',     params: { path: 'string?', recursive: 'bool?', maxDepth: 'int?' } },
          { name: 'make_dir',          group: 'files',     params: { path: 'string' } },
          { name: 'delete_file',       group: 'files',     params: { path: 'string', recursive: 'bool?' } },
          { name: 'file_exists',       group: 'files',     params: { path: 'string' } },
          { name: 'batch_write_files', group: 'files',     params: { files: 'array<{path, content}>' } },
          { name: 'search_files',      group: 'files',     params: { path: 'string?', query: 'string', isRegex: 'bool?', maxResults: 'int?' } },
          { name: 'zip_files',         group: 'files',     params: { paths: 'array<string>', out: 'string?' } },
          { name: 'unzip_file',        group: 'files',     params: { path: 'string', dest: 'string?' } },
          { name: 'move_path',         group: 'files',     params: { from: 'string', to: 'string' } },
          { name: 'copy_path',         group: 'files',     params: { from: 'string', to: 'string' } },
          { name: 'fetch_web_url',     group: 'web',       params: { url: 'string', maxLength: 'int?', maxBytes: 'int?' } },
          { name: 'terminal_exec',     group: 'shell',     params: { command: 'string', timeoutMs: 'int?' } },
          { name: 'parallel_commands', group: 'shell',     params: { commands: 'array<string>', timeoutMs: 'int?', cwd: 'string?' } },
          { name: 'terminal_input',    group: 'shell',     params: { input: 'string' } },
          { name: 'terminal_kill',     group: 'shell',     params: {} },
          { name: 'start_background',  group: 'background', params: { name: 'string', command: 'string', cwd: 'string?' } },
          { name: 'list_background',   group: 'background', params: {} },
          { name: 'tail_log',          group: 'background', params: { name: 'string', lines: 'int?' } },
          { name: 'stop_background',   group: 'background', params: { name: 'string' } },
          { name: 'get_server_info',   group: 'system',    params: {} },
          { name: 'check_port',        group: 'system',    params: { port: 'int' } },
          { name: 'kill_port',         group: 'system',    params: { port: 'int' } },
          { name: 'git_status',        group: 'git',       params: { cwd: 'string?' } },
          { name: 'git_diff',          group: 'git',       params: { path: 'string?', staged: 'bool?', cwd: 'string?' } },
          { name: 'git_log',           group: 'git',       params: { maxCount: 'int?', cwd: 'string?' } },
          { name: 'mcp_list',          group: 'mcp',       params: { serverName: 'string?' } },
          { name: 'mcp_call',          group: 'mcp',       params: { serverName: 'string?', toolName: 'string', arguments: 'object?' } }
        ]
      });
      return;
    }

    if (url.pathname === '/api/logs' && req.method === 'GET') {
      sendJson(res, 200, { logs: recentLogs });
      return;
    }

    // ---- Extension auto-update (v1.8): the server ships its own copy of the
    // extension (OB_HOME/extension, installed by ob-install.sh) and serves it
    // to the extension's updater. sha256 lets the worker verify every byte.
    const OTA_WHITELIST = ['ui.js', 'content.js'];
    const OTA_EXT_DIR = process.env.OB_EXT_DIR || path.join(__dirname, '..', 'extension');
    if (url.pathname === '/api/ota/manifest' && req.method === 'GET') {
      try {
        const mf = JSON.parse(fs.readFileSync(path.join(OTA_EXT_DIR, 'manifest.json'), 'utf8'));
        const files = OTA_WHITELIST.map((name) => {
          const buf = fs.readFileSync(path.join(OTA_EXT_DIR, name));
          return { name, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
        });
        sendJson(res, 200, { success: true, ota: { version: mf.version, files, built: fs.statSync(path.join(OTA_EXT_DIR, 'manifest.json')).mtime.toISOString() } });
      } catch (e) {
        sendJson(res, 200, { success: false, error: 'OTA files not installed on this server — update the server package (bash ob-install.sh --update)' });
      }
      return;
    }
    if (url.pathname === '/api/ota/file' && req.method === 'GET') {
      const name = url.searchParams.get('name') || '';
      if (!OTA_WHITELIST.includes(name)) { sendJson(res, 400, { success: false, error: 'Unknown OTA file' }); return; }
      try {
        const buf = fs.readFileSync(path.join(OTA_EXT_DIR, name));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(buf);
      } catch (e) {
        sendJson(res, 404, { success: false, error: 'OTA file missing on this server' });
      }
      return;
    }

    if (url.pathname === '/api/config' && req.method === 'POST') {
      const updates = await parseJsonBody(req);
      if (typeof updates.workspaceRoot === 'string' && updates.workspaceRoot.trim()) {
        const resolvedWs = path.resolve(expandHome(updates.workspaceRoot.trim()));
        fs.mkdirSync(resolvedWs, { recursive: true });
        config.workspaceRoot = resolvedWs;
        terminalSession.setCwd(resolvedWs);
      }
      if (typeof updates.strictWorkspace === 'boolean') config.strictWorkspace = updates.strictWorkspace;
      persistConfig();
      sendJson(res, 200, { success: true, workspaceRoot: config.workspaceRoot, strictWorkspace: config.strictWorkspace });
      return;
    }

    /* ---- file browser (UI) ---- */
    if (url.pathname === '/api/fs/list' && req.method === 'GET') {
      const target = fsTools.resolveSafePath(url.searchParams.get('path') || '.', config.workspaceRoot, config.strictWorkspace);
      const entries = fs.readdirSync(target, { withFileTypes: true }).map((d) => {
        let size = null, mtime = null;
        try { const st = fs.statSync(path.join(target, d.name)); size = d.isDirectory() ? null : st.size; mtime = st.mtimeMs; } catch (e) { /* broken link */ }
        return { name: d.name, dir: d.isDirectory(), size, mtime };
      }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      sendJson(res, 200, { success: true, path: target, parent: path.dirname(target) === target ? null : path.dirname(target), entries: entries.slice(0, 1000) });
      return;
    }

    if (url.pathname === '/api/fs/read' && req.method === 'GET') {
      const target = fsTools.resolveSafePath(url.searchParams.get('path') || '', config.workspaceRoot, config.strictWorkspace);
      const st = fs.statSync(target);
      if (st.isDirectory()) throw new Error('Path is a directory');
      if (!st.isFile()) throw new Error('Not a regular file'); // FIFOs / devices would block the event loop
      const limit = 512 * 1024;
      const fd = fs.openSync(target, 'r');
      const buf = Buffer.alloc(Math.min(st.size, limit));
      try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
      if (buf.subarray(0, 8192).includes(0)) { sendJson(res, 200, { success: true, path: target, binary: true, size: st.size }); return; }
      sendJson(res, 200, { success: true, path: target, size: st.size, truncated: st.size > limit, content: buf.toString('utf8') });
      return;
    }

    /* ---- uploads & downloads (binary-safe) ---- */
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const maxBytes = config.maxUploadMb * 1024 * 1024;
      const buf = await parseRawBody(req, maxBytes);
      if (!buf.length) throw new Error('Empty upload body');
      const name = safeUploadName(url.searchParams.get('name') || req.headers['x-filename'] || 'file');
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19) + '-' + crypto.randomBytes(3).toString('hex') + '-';
      const finalName = stamp + name;
      const dest = path.join(uploadsDir(), finalName);
      fs.writeFileSync(dest, buf);
      console.log(`📤 Upload: ${finalName} (${buf.length} bytes)`);
      emitEvent({ type: 'upload', name: finalName, size: buf.length });
      sendJson(res, 200, { success: true, name: finalName, originalName: name, path: dest, size: buf.length, uploadsDir: path.join(config.workspaceRoot, 'uploads') });
      return;
    }

    if (url.pathname === '/api/uploads' && req.method === 'GET') {
      const dir = uploadsDir();
      const uploads = fs.readdirSync(dir).map((name) => {
        try { const st = fs.statSync(path.join(dir, name)); return { name, size: st.size, mtime: st.mtimeMs }; } catch (e) { return null; }
      }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 300);
      sendJson(res, 200, { success: true, dir, uploads });
      return;
    }

    if (url.pathname === '/api/download' && req.method === 'GET') {
      const target = fsTools.resolveSafePath(url.searchParams.get('path') || '', config.workspaceRoot, config.strictWorkspace);
      const st = fs.statSync(target);
      if (st.isDirectory()) throw new Error('Path is a directory');
      if (!st.isFile()) throw new Error('Not a regular file');
      if (st.size > 500 * 1024 * 1024) throw new Error('File too large to download (max 500 MB) — zip it or use scp.');
      const mime = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      const fileName = path.basename(target);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${fileName.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Cache-Control': 'no-store'
      });
      const stream = fs.createReadStream(target);
      stream.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
      // client went away mid-download: pipe() does not close the source, so the fd would leak
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }

    /* ---- archive actions (Files tab buttons) ---- */
    if (url.pathname === '/api/fs/zip' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      sendJson(res, 200, await fsTools.zipFiles(body, config));
      return;
    }
    if (url.pathname === '/api/fs/unzip' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      sendJson(res, 200, await fsTools.unzipFile(body, config));
      return;
    }

    /* ---- terminal ---- */
    if (url.pathname === '/api/terminal/history' && req.method === 'GET') {
      sendJson(res, 200, { success: true, ...terminalSession.getSince(parseInt(url.searchParams.get('since'), 10) || 0) });
      return;
    }
    if (url.pathname === '/api/terminal/exec' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      // force: human "Run" from the panel may barge in; AI tool calls queue instead
      sendJson(res, 200, await terminalSession.exec(body.command || body.cmd, body.timeoutMs || config.commandTimeoutMs, { force: body.force === true }));
      return;
    }
    if (url.pathname === '/api/terminal/input' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      sendJson(res, 200, await terminalSession.sendInput(body.input ?? body.text));
      return;
    }
    if (url.pathname === '/api/terminal/clear' && req.method === 'POST') { sendJson(res, 200, terminalSession.clear()); return; }
    if (url.pathname === '/api/terminal/kill' && req.method === 'POST') { sendJson(res, 200, terminalSession.killActiveProcess()); return; }

    if (url.pathname === '/api/terminal/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(`retry: 3000\ndata: ${JSON.stringify({ type: 'init', cwd: terminalSession.currentCwd, busy: terminalSession.isRunning })}\n\n`);
      const unsubscribe = terminalSession.subscribe((data) => {
        try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) { /* closed */ }
      });
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* closed */ } }, 15000);
      res.on('close', () => { clearInterval(beat); unsubscribe(); });
      return;
    }

    /* ---- live event feed (panel Live tab) ---- */
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(`retry: 3000\ndata: ${JSON.stringify({ type: 'init', version: VERSION, replay: recentEvents.slice(-60) })}\n\n`);
      const fn = (e) => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch (err) { /* closed */ } };
      eventSubs.add(fn);
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* closed */ } }, 15000);
      res.on('close', () => { clearInterval(beat); eventSubs.delete(fn); });
      return;
    }

    /* ---- installer (panel) ---- */
    if (url.pathname === '/api/install/state' && req.method === 'GET') {
      sendJson(res, 200, { success: true, state: installer.getState() });
      return;
    }
    if (url.pathname === '/api/install/run' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const steps = Array.isArray(body.steps) ? body.steps.map(String) : null;
      if (installer.getState().running) { sendJson(res, 409, { success: false, started: false, reason: 'An install run is already in progress.' }); return; }
      const v = installer.validateSteps(steps);
      if (!v.ok) { sendJson(res, 400, { success: false, started: false, reason: v.reason }); return; }
      // Fire and forget: the run streams progress over /api/events (and can be
      // polled at /api/install/state), so the HTTP answer must not block on it.
      installer.runInstall(steps, config, emitEvent)
        .then((kick) => { if (!kick.started) console.warn('[Install] not started:', kick.reason); })
        .catch((e) => console.error('[Install] failed:', e.message));
      sendJson(res, 202, { success: true, started: true, total: v.total });
      return;
    }

    /* ---- tools ---- */
    if (url.pathname === '/api/execute' && req.method === 'POST') {
      const payload = await parseJsonBody(req);
      const { tool } = payload;
      let params = payload.params;
      if (params == null) params = {};
      if (!tool || typeof tool !== 'string') { sendJson(res, 400, { success: false, error: 'Missing tool name' }); return; }
      if (typeof params !== 'object' || Array.isArray(params)) { sendJson(res, 400, { success: false, error: 'params must be an object' }); return; }

      console.log(`🤖 ${tool} ${JSON.stringify(params).slice(0, 160)}`);
      const startTime = Date.now();
      const evtId = crypto.randomUUID();
      emitEvent({ type: 'tool_start', id: evtId, tool, summary: describeParams(tool, params) });
      try {
        const result = await runTool(tool, params);
        const durationMs = Date.now() - startTime;
        addLog({ tool, params, success: true, durationMs, resultSummary: summarize(result) });
        emitEvent({ type: 'tool_end', id: evtId, tool, ok: true, durationMs, summary: summarize(result) });
        sendJson(res, 200, { success: true, tool, durationMs, result });
      } catch (execErr) {
        const durationMs = Date.now() - startTime;
        console.error(`❌ ${tool}: ${execErr.message}`);
        addLog({ tool, params, success: false, durationMs, error: execErr.message });
        emitEvent({ type: 'tool_end', id: evtId, tool, ok: false, durationMs, summary: execErr.message });
        sendJson(res, 200, { success: false, tool, durationMs, error: execErr.message });
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Server error:', err.message);
    if (res.headersSent) { try { res.destroy(); } catch (e) { /* ignore */ } return; }
    const status = (err.message === 'Payload too large' || err.code === 'ETooLarge') ? 413 : (err.code === 'EBadJson' ? 400 : 500);
    sendJson(res, status, { success: false, error: err.message });
  }
});

server.requestTimeout = 0; // long-lived SSE + slow tools
server.keepAliveTimeout = 65000;

const PORT = config.port || 3456;
server.listen(PORT, '127.0.0.1', () => {
  console.log('====================================================');
  console.log(`🚀 OrbitBridge v${VERSION} (Linux)`);
  console.log(`📡 http://127.0.0.1:${PORT}  (expose via Cloudflare Tunnel)`);
  console.log(`📁 Workspace: ${config.workspaceRoot}  strict=${config.strictWorkspace ? 'ON' : 'OFF'}`);
  console.log(`👤 Running as: ${os.userInfo().username}`);
  console.log('====================================================');
});

function shutdown() {
  console.log('Shutting down...');
  try { terminalSession.dispose(); } catch (e) { /* ignore */ }
  try { mcpClient.stopAll(); } catch (e) { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
