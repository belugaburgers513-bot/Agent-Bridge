const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolveSafePath } = require('./fs_tools');

function execGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 5 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function gitStatus({ cwd }, config) {
  const targetCwd = resolveSafePath(cwd || '.', config.workspaceRoot, config.strictWorkspace);

  try {
    const rawStatus = await execGit(['status', '--porcelain=v1', '-b'], targetCwd);
    const lines = rawStatus.split('\n').filter(l => l.trim().length > 0);

    let branch = 'unknown';
    const staged = [];
    const modified = [];
    const untracked = [];

    for (const line of lines) {
      if (line.startsWith('## ')) {
        branch = line.slice(3).trim();
        continue;
      }

      const code = line.slice(0, 2);
      const filePath = line.slice(3).trim();

      const indexStatus = code[0];
      const workTreeStatus = code[1];

      if (indexStatus !== ' ' && indexStatus !== '?') {
        staged.push({ status: indexStatus, path: filePath });
      }
      if (workTreeStatus === 'M' || workTreeStatus === 'D') {
        modified.push({ status: workTreeStatus, path: filePath });
      } else if (code === '??') {
        untracked.push(filePath);
      }
    }

    return {
      success: true,
      cwd: targetCwd,
      branch,
      clean: staged.length === 0 && modified.length === 0 && untracked.length === 0,
      stagedCount: staged.length,
      modifiedCount: modified.length,
      untrackedCount: untracked.length,
      staged,
      modified,
      untracked
    };
  } catch (err) {
    if (err.message.includes('not a git repository')) {
      return {
        success: false,
        isGitRepo: false,
        cwd: targetCwd,
        error: 'Not a git repository. Run `git init` to initialize.'
      };
    }
    throw err;
  }
}

async function gitDiff({ path: targetFile, staged = false, cwd }, config) {
  const targetCwd = resolveSafePath(cwd || '.', config.workspaceRoot, config.strictWorkspace);
  const args = ['diff'];
  if (staged) args.push('--cached');
  if (targetFile) args.push('--', String(targetFile));

  try {
    const diff = await execGit(args, targetCwd);
    return {
      success: true,
      staged,
      file: targetFile || 'all',
      diff: diff.slice(0, 15000),
      truncated: diff.length > 15000
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

async function gitLog({ maxCount = 10, cwd }, config) {
  const targetCwd = resolveSafePath(cwd || '.', config.workspaceRoot, config.strictWorkspace);
  const count = Math.min(50, Math.max(1, parseInt(maxCount, 10) || 10));

  try {
    const rawLog = await execGit(['log', '-n', String(count), '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=short'], targetCwd);
    const commits = rawLog.split('\n').filter(l => l.trim()).map(line => {
      const [hash, author, date, message] = line.split('\t');
      return { hash, author, date, message };
    });

    return {
      success: true,
      commitCount: commits.length,
      commits
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

module.exports = {
  gitStatus,
  gitDiff,
  gitLog
};
