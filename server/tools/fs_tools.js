const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const ARCHIVE_RE = /\.(zip|tar|gz|tgz|bz2|xz)$/i;
const isArchive = (name) => ARCHIVE_RE.test(String(name || ''));

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          const hint = cmd === 'zip' ? "the 'zip' binary is not installed (apt-get install -y zip)" : cmd === 'unzip' ? "the 'unzip' binary is not installed (apt-get install -y unzip)" : `${cmd} is not available`;
          return reject(new Error(`${cmd} failed: ${hint}`));
        }
        return reject(new Error(`${cmd} failed: ${(stderr || stdout || err.message || '').toString().trim().slice(0, 300)}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

function walkBounded(root, maxEntries = 100, maxDepth = 3) {
  const out = [];
  const visit = (dir, depth) => {
    if (out.length >= maxEntries || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of entries) {
      if (out.length >= maxEntries) { out.push('...'); return; }
      const full = path.join(dir, d.name);
      out.push(path.relative(root, full).replace(/\\/g, '/') + (d.isDirectory() ? '/' : ''));
      if (d.isDirectory()) visit(full, depth + 1);
    }
  };
  visit(root, 1);
  return out;
}

function resolveSafePath(userPath, workspaceRoot, strictWorkspace = false) {
  const root = workspaceRoot || process.cwd();
  if (!userPath) {
    return path.resolve(root);
  }

  // Clean up quotes or leading/trailing whitespace
  let cleanPath = userPath.trim().replace(/^["']|["']$/g, '');

  // Expand ~ to user home directory
  if (cleanPath === '~' || cleanPath.startsWith('~/')) {
    cleanPath = path.join(os.homedir(), cleanPath.slice(1));
  }

  let resolved;
  if (path.isAbsolute(cleanPath)) {
    resolved = path.resolve(cleanPath);
  } else {
    resolved = path.resolve(path.join(root, cleanPath));
  }

  if (strictWorkspace) {
    const normalizedRoot = path.resolve(root);
    const rel = path.relative(normalizedRoot, resolved);

    // If path goes outside or starts with .. or is absolute on different drive
    let isOutside = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);

    // Defeat symlink escapes: compare real paths of the deepest existing ancestor
    if (!isOutside) {
      try {
        let probe = resolved;
        while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
        const realRoot = fs.realpathSync(normalizedRoot);
        const realProbe = fs.realpathSync(probe);
        const relReal = path.relative(realRoot, realProbe);
        isOutside = relReal === '..' || relReal.startsWith('..' + path.sep) || path.isAbsolute(relReal);
      } catch (e) { /* fall back to lexical check */ }
    }

    if (isOutside) {
      throw new Error(`Security Violation: Path '${cleanPath}' resolves outside authorized workspace '${root}'`);
    }
  }

  return resolved;
}

async function readFile({ path: targetPath, offset = 0, length = null, withLineNumbers = false }, config) {
  const filePath = resolveSafePath(targetPath, config.workspaceRoot, config.strictWorkspace);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${filePath}. Use list_dir instead.`);
  }

  // Check if file is suspiciously large or binary
  if (stat.size > 25 * 1024 * 1024) {
    throw new Error(`File is too large to read into memory (${Math.round(stat.size / (1024 * 1024))}MB). Maximum supported size is 25MB.`);
  }

  const buffer = fs.readFileSync(filePath);
  // Quick binary check: look for null bytes in the first 8KB
  let isBinary = false;
  const checkLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) {
      isBinary = true;
      break;
    }
  }

  if (isBinary) {
    return {
      filePath,
      isBinary: true,
      sizeBytes: stat.size,
      message: `Binary file detected (${stat.size} bytes). Cannot display as text.`
    };
  }

  const content = buffer.toString('utf8');

  if (offset > 0 || length !== null || withLineNumbers) {
    const lines = content.split('\n');
    const start = Math.max(0, parseInt(offset, 10) || 0);
    const len = length !== null ? parseInt(length, 10) : lines.length;
    const end = Math.min(lines.length, start + len);
    const sliced = lines.slice(start, end);

    let output = '';
    if (withLineNumbers) {
      output = sliced.map((line, idx) => `${start + idx + 1}: ${line}`).join('\n');
    } else {
      output = sliced.join('\n');
    }

    return {
      filePath,
      totalLines: lines.length,
      startLine: start + 1,
      linesReturned: sliced.length,
      content: output
    };
  }

  return {
    filePath,
    sizeBytes: stat.size,
    content
  };
}

async function writeFile({ path: targetPath, content }, config) {
  const filePath = resolveSafePath(targetPath, config.workspaceRoot, config.strictWorkspace);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, content ?? '', 'utf8');
  const bytesWritten = Buffer.byteLength(content ?? '', 'utf8');
  return {
    success: true,
    filePath,
    bytesWritten,
    message: `Successfully wrote ${bytesWritten} bytes to ${filePath}`
  };
}

async function editFile({ path: targetPath, search, replace, allowMultiple = false }, config) {
  const filePath = resolveSafePath(targetPath, config.workspaceRoot, config.strictWorkspace);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  let content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(search)) {
    throw new Error(`Search pattern not found in file: ${filePath}`);
  }

  let replacementsCount = 0;
  if (allowMultiple) {
    // split/join is already literal — no $-pattern interpretation
    const parts = content.split(search);
    replacementsCount = parts.length - 1;
    content = parts.join(replace);
  } else {
    replacementsCount = 1;
    // IMPORTANT: pass a function, not the string. `content.replace(search, replace)`
    // would interpret $&, $1, $' ... inside the replacement and corrupt files
    // (e.g. shell scripts containing $1 or sed patterns containing $&).
    content = content.replace(search, () => replace);
  }

  fs.writeFileSync(filePath, content, 'utf8');
  return {
    success: true,
    filePath,
    replacementsCount,
    message: `Successfully replaced ${replacementsCount} occurrence(s) in ${filePath}`
  };
}

async function listDir({ path: targetPath = '.', recursive = false, maxDepth = 2 }, config) {
  const dirPath = resolveSafePath(targetPath, config.workspaceRoot, config.strictWorkspace);
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is a file, not a directory: ${dirPath}`);
  }

  function scan(currentDir, currentDepth) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const fullPath = path.join(currentDir, entry.name);
      const isDir = entry.isDirectory();
      const item = {
        name: entry.name,
        path: path.relative(dirPath, fullPath).replace(/\\/g, '/'),
        isDir
      };

      if (!isDir) {
        try {
          const s = fs.statSync(fullPath);
          item.sizeBytes = s.size;
        } catch (_) {}
      }

      if (isDir && recursive && currentDepth < maxDepth) {
        item.children = scan(fullPath, currentDepth + 1);
      }

      items.push(item);
    }
    return items;
  }

  const items = scan(dirPath, 1);
  return {
    dirPath,
    itemCount: items.length,
    items
  };
}

async function makeDir({ path: targetPath }, config) {
  const dirPath = resolveSafePath(targetPath, config.workspaceRoot, config.strictWorkspace);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return {
    success: true,
    dirPath,
    message: `Created directory ${dirPath}`
  };
}

async function deleteFile({ path: targetPath, recursive = false }, config) {
  const target = resolveSafePath(targetPath, config.workspaceRoot, config.strictWorkspace);
  if (!fs.existsSync(target)) {
    throw new Error(`Target path not found: ${target}`);
  }

  // Security Guards: Never allow deleting root drives or system directories
  const parsed = path.parse(target);
  if (target === parsed.root) {
    throw new Error(`Security Violation: Refusing to delete root directory '${target}'`);
  }

  const PROTECTED = ['/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/usr', '/var'];
  if (PROTECTED.includes(target.replace(/\/+$/, ''))) {
    throw new Error(`Security Violation: Refusing to delete system path '${target}'`);
  }

  // Refuse to delete workspace root itself
  if (config.workspaceRoot && path.resolve(target) === path.resolve(config.workspaceRoot)) {
    throw new Error(`Security Violation: Refusing to delete the active workspace root '${target}'`);
  }

  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
  } else {
    fs.unlinkSync(target);
  }

  return {
    success: true,
    target,
    message: `Successfully deleted ${target}`
  };
}

async function fileExists({ path: targetPath }, config) {
  try {
    const target = resolveSafePath(targetPath, config.workspaceRoot, config.strictWorkspace);
    const exists = fs.existsSync(target);
    const isDir = exists ? fs.statSync(target).isDirectory() : false;
    return { exists, isDir, path: target };
  } catch (err) {
    return { exists: false, error: err.message };
  }
}

async function batchWriteFiles({ files = [] }, config) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('files array is required and must not be empty');
  }

  const results = [];
  for (const f of files) {
    const res = await writeFile({ path: f.path, content: f.content }, config);
    results.push(res);
  }

  return {
    success: true,
    totalFilesWritten: results.length,
    files: results
  };
}

async function searchFiles({ path: targetPath = '.', query = '', isRegex = false, maxResults = 50 }, config) {
  const dirPath = resolveSafePath(targetPath, config.workspaceRoot, config.strictWorkspace);
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }

  const results = [];
  let regex = null;
  if (isRegex) {
    try {
      regex = new RegExp(query, 'i');
    } catch (e) {
      throw new Error(`Invalid regular expression: ${query}`);
    }
  }

  function searchDir(currentDir) {
    if (results.length >= maxResults) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        searchDir(fullPath);
      } else if (entry.isFile()) {
        // Search in file name
        const matchName = regex ? regex.test(entry.name) : entry.name.toLowerCase().includes(query.toLowerCase());
        if (matchName) {
          results.push({
            type: 'filename',
            path: path.relative(dirPath, fullPath).replace(/\\/g, '/'),
            fullPath
          });
        }

        // Search in file content (for text files < 2MB)
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size < 2 * 1024 * 1024) {
            const fd = fs.openSync(fullPath, 'r');
            const head = Buffer.alloc(Math.min(stat.size, 1024));
            fs.readSync(fd, head, 0, head.length, 0);
            fs.closeSync(fd);
            if (head.includes(0)) continue; // binary file — don't search, don't decode
            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split('\n');
            for (let lineNum = 0; lineNum < lines.length; lineNum++) {
              const line = lines[lineNum];
              const matchContent = regex ? regex.test(line) : line.toLowerCase().includes(query.toLowerCase());
              if (matchContent) {
                results.push({
                  type: 'content',
                  path: path.relative(dirPath, fullPath).replace(/\\/g, '/'),
                  line: lineNum + 1,
                  snippet: line.trim().slice(0, 200)
                });
                if (results.length >= maxResults) break;
              }
            }
          }
        } catch (_) {}
      }
    }
  }

  searchDir(dirPath);
  return {
    query,
    totalMatches: results.length,
    matches: results
  };
}

/* ----- archives (zip/tar via arg-array execFile — no shell, workspace-jailed) ----- */

async function zipFiles({ paths = [], out = null }, config) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths array is required (one or more files/folders to zip)');
  }
  if (paths.length > 500) throw new Error('Too many paths (max 500 per zip)');

  const targets = paths.map((p) => resolveSafePath(String(p), config.workspaceRoot, config.strictWorkspace));
  for (const t of targets) {
    if (!fs.existsSync(t)) throw new Error(`Not found: ${t}`);
  }

  let outPath;
  if (out) {
    outPath = resolveSafePath(String(out), config.workspaceRoot, config.strictWorkspace);
    if (!outPath.toLowerCase().endsWith('.zip')) outPath += '.zip';
  } else if (targets.length === 1) {
    outPath = targets[0].replace(/\/+$/, '') + '.zip';
  } else {
    outPath = path.join(config.workspaceRoot, `archive-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`);
  }
  if (fs.existsSync(outPath)) {
    throw new Error(`Output already exists: ${outPath}. Pass a different "out" or delete it first.`);
  }

  // Group targets by parent dir so zip can store clean relative names.
  const groups = new Map();
  for (const t of targets) {
    const parent = path.dirname(t);
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(path.basename(t));
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  let first = true;
  for (const [parent, names] of groups) {
    const args = first ? ['-r'] : ['-r', '-u']; // update mode after the first pass
    await run('zip', [...args, outPath, ...names], { cwd: parent });
    first = false;
  }

  const size = fs.statSync(outPath).size;
  return {
    success: true,
    out: outPath,
    sizeBytes: size,
    zipped: targets.length,
    message: `Zipped ${targets.length} item(s) -> ${outPath} (${size} bytes)`
  };
}

async function unzipFile({ path: targetPath, dest = null }, config) {
  const src = resolveSafePath(targetPath, config.workspaceRoot, config.strictWorkspace);
  if (!fs.existsSync(src)) throw new Error(`Not found: ${src}`);
  if (fs.statSync(src).isDirectory()) throw new Error(`Path is a directory: ${src}`);
  if (!isArchive(src)) {
    throw new Error('Not a supported archive (.zip, .tar, .tar.gz, .tgz, .tar.bz2, .tar.xz). Use unzip/7z via terminal for exotic formats.');
  }

  const base = path.basename(src).replace(/\.(zip|tar|tar\.gz|tgz|tar\.bz2|tar\.xz|gz|bz2|xz)$/i, '');
  const destPath = dest
    ? resolveSafePath(dest, config.workspaceRoot, config.strictWorkspace)
    : path.join(path.dirname(src), `${base}-extracted`);
  if (fs.existsSync(destPath) && fs.readdirSync(destPath).length > 0) {
    throw new Error(`Destination already exists and is not empty: ${destPath}. Pass a different "dest".`);
  }
  fs.mkdirSync(destPath, { recursive: true });

  if (/\.zip$/i.test(src)) {
    await run('unzip', ['-o', '-q', src, '-d', destPath]);
  } else {
    await run('tar', ['-xf', src, '-C', destPath]);
  }

  const entries = walkBounded(destPath);
  return {
    success: true,
    dest: destPath,
    extractedCount: entries.filter((e) => e !== '...').length,
    entries: entries.slice(0, 100),
    message: `Extracted ${path.basename(src)} -> ${destPath}`
  };
}

/* ----- move / copy (recursive, jailed) ----- */

function guardSystemPath(p, verb) {
  const PROTECTED = ['/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/usr', '/var'];
  const clean = String(p).replace(/\/+$/, '');
  if (clean === path.parse(clean).root) throw new Error(`Security Violation: refusing to ${verb} the filesystem root`);
  if (PROTECTED.includes(clean)) throw new Error(`Security Violation: refusing to ${verb} system path '${clean}'`);
}

function resolveTarget(from, to) {
  // If `to` is an existing directory, move/copy INSIDE it keeping the basename.
  let target = to;
  if (fs.existsSync(to) && fs.statSync(to).isDirectory()) {
    target = path.join(to, path.basename(from));
  }
  if (fs.existsSync(target)) {
    throw new Error(`Target already exists: ${target}. Choose another name.`);
  }
  return target;
}

async function movePath({ from, to }, config) {
  if (!from || !to) throw new Error('from and to are required');
  const src = resolveSafePath(from, config.workspaceRoot, config.strictWorkspace);
  if (!fs.existsSync(src)) throw new Error(`Not found: ${src}`);
  guardSystemPath(src, 'move');
  const dst = resolveSafePath(to, config.workspaceRoot, config.strictWorkspace);
  guardSystemPath(dst, 'move');
  const target = resolveTarget(src, dst);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(src, target);
  } catch (e) {
    if (e.code === 'EXDEV') { // cross-device: copy + remove
      fs.cpSync(src, target, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else throw e;
  }
  return { success: true, from: src, to: target, message: `Moved ${src} -> ${target}` };
}

async function copyPath({ from, to }, config) {
  if (!from || !to) throw new Error('from and to are required');
  const src = resolveSafePath(from, config.workspaceRoot, config.strictWorkspace);
  if (!fs.existsSync(src)) throw new Error(`Not found: ${src}`);
  const dst = resolveSafePath(to, config.workspaceRoot, config.strictWorkspace);
  const target = resolveTarget(src, dst);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(src, target, { recursive: true });
  return { success: true, from: src, to: target, message: `Copied ${src} -> ${target}` };
}

async function getSystemInfo({}, config) {
  return {
    platform: process.platform,
    arch: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    hostname: os.hostname(),
    username: os.userInfo().username,
    homeDir: os.homedir(),
    workspaceRoot: config.workspaceRoot,
    strictWorkspace: config.strictWorkspace,
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    freeMemMB: Math.floor(os.freemem() / (1024 * 1024)),
    totalMemMB: Math.floor(os.totalmem() / (1024 * 1024))
  };
}

module.exports = {
  readFile,
  writeFile,
  editFile,
  listDir,
  makeDir,
  deleteFile,
  fileExists,
  batchWriteFiles,
  searchFiles,
  zipFiles,
  unzipFile,
  movePath,
  copyPath,
  isArchive,
  getSystemInfo,
  resolveSafePath
};
