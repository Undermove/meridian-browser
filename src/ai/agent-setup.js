// "Install" and "Sign in" for local AI agents. Both are interactive (installers may ask for a password,
// sign-in opens the browser or asks questions), so they run in the system terminal, where the person can
// see and answer them. The command always comes from the PROVIDERS table, never from the renderer, and is
// shown in a native confirmation first. Meridian then polls the agent list until the status changes.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { which, IS_WIN } = require('../dev/env');

// The first alternative whose tool is available. `needs` is a binary on the login PATH.
function installCommand(p, searchPath) {
  const plat = process.platform === 'darwin' ? 'mac' : IS_WIN ? 'win' : 'linux';
  const options = [].concat(p.install[plat] || []);
  for (const o of options) {
    const opt = typeof o === 'string' ? { cmd: o } : o;
    if (!opt.needs || which(opt.needs, searchPath)) return { cmd: opt.cmd };
  }
  const need = options.map((o) => o.needs).filter(Boolean);
  return { cmd: null, missing: need.includes('npm') ? 'Node.js (nodejs.org)' : need[0] || null };
}

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Open the platform terminal running `cmd` in the user's login shell, then leave the window open.
function openInTerminal(cmd, title = 'Meridian setup') {
  if (process.platform === 'darwin') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-setup-'));
    const file = path.join(dir, 'setup.command');
    const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
    fs.writeFileSync(file, [
      `#!${shell} -l`,
      `printf '\\033]0;%s\\007' ${shQuote(title)}`,
      'clear',
      `echo ${shQuote(`▶ ${cmd}`)}`,
      'echo',
      cmd,
      'echo',
      `echo ${shQuote('Done. You can close this window and go back to Meridian.')}`,
      `rm -rf ${shQuote(dir)}`,
      `exec ${shell} -l`,
      '',
    ].join('\n'), { mode: 0o700 });
    spawn('open', ['-a', 'Terminal', file], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  if (IS_WIN) {
    // Fixed commands from our table only. A detached process gets its own console window on Windows;
    // -NoExit keeps it open. No cmd.exe in between (it would re-parse the pipe in `irm … | iex`).
    spawn('powershell.exe', ['-NoExit', '-Command', `Write-Host '> ${cmd.replace(/'/g, "''")}'; ${cmd}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  }
  const inner = `echo ${shQuote(`▶ ${cmd}`)}; echo; ${cmd}; echo; echo ${shQuote('Done. You can close this window.')}; exec "\${SHELL:-bash}" -l`;
  for (const [bin, args] of [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', inner]],
    ['gnome-terminal', ['--', 'bash', '-lc', inner]],
    ['konsole', ['-e', 'bash', '-lc', inner]],
    ['xfce4-terminal', ['-x', 'bash', '-lc', inner]],
    ['kitty', ['bash', '-lc', inner]],
    ['alacritty', ['-e', 'bash', '-lc', inner]],
    ['xterm', ['-e', 'bash', '-lc', inner]],
  ]) {
    if (which(bin, process.env.PATH || '/usr/bin:/bin')) { spawn(bin, args, { detached: true, stdio: 'ignore' }).unref(); return true; }
  }
  return false;
}

module.exports = { installCommand, openInTerminal };
