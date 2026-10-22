// Workbench: the user's shell environment.
//
// macOS GUI apps don't inherit the PATH from the user's shell profile, so `claude`, `codex`, `node`
// installed via Homebrew / npm / nvm wouldn't be found. We ask the login shell once (with a timeout)
// and use that PATH for every terminal and for CLI detection.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

function userShell() {
  if (IS_WIN) return process.env.COMSPEC && /powershell|pwsh/i.test(process.env.COMSPEC) ? process.env.COMSPEC : 'powershell.exe';
  const sh = process.env.SHELL;
  if (sh && path.isAbsolute(sh) && fs.existsSync(sh)) return sh;
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.split(':')[2] === String(process.getuid()));
    const fromPasswd = line && line.split(':')[6];
    if (fromPasswd && fs.existsSync(fromPasswd)) return fromPasswd;
  } catch {}
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

let pathPromise = null;

// PATH as the user's interactive login shell sees it. Falls back to our own PATH plus common dirs.
function loginPath() {
  if (pathPromise) return pathPromise;
  const fallback = () => {
    const extra = IS_WIN ? [] : ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    return [...new Set([...(process.env.PATH || '').split(path.delimiter), ...extra].filter(Boolean))].join(path.delimiter);
  };
  if (IS_WIN) return (pathPromise = Promise.resolve(process.env.PATH || ''));
  pathPromise = new Promise((resolve) => {
    // Markers: rc files may print banners; only take what's between them.
    const script = 'printf "__MERIDIAN_PATH__%s__MERIDIAN_END__" "$PATH"';
    execFile(userShell(), ['-ilc', script], { timeout: 5000, env: { ...process.env, TERM: 'dumb' }, encoding: 'utf8' }, (err, stdout) => {
      const m = /__MERIDIAN_PATH__(.*?)__MERIDIAN_END__/s.exec(stdout || '');
      if (m && m[1].trim()) resolve(m[1].trim());
      else { if (err) console.warn('workbench: login shell PATH lookup failed:', err.message); resolve(fallback()); }
    });
  });
  return pathPromise;
}

// Absolute path of an executable on the given PATH, or null. No shell involved.
function which(name, searchPath) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of String(searchPath || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue; // never resolve relative PATH entries (e.g. "." in the project)
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        const st = fs.statSync(candidate);
        if (!st.isFile()) continue;
        if (!IS_WIN) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

// Environment for processes started in the workbench: the user's env with the login PATH, minus our
// own dev/Electron variables (they'd confuse child Node/Electron apps the user runs).
async function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ELECTRON_|MERIDIAN_|npm_|NODE_OPTIONS$|INIT_CWD$|CHROME_DESKTOP$)/i.test(k)) continue;
    env[k] = v;
  }
  env.PATH = await loginPath();
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Meridian';
  if (!IS_WIN && !env.LANG) env.LANG = 'en_US.UTF-8';
  return { ...env, ...extra };
}

module.exports = { userShell, loginPath, which, childEnv, IS_WIN };
