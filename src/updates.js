// Update check: asks GitHub for the latest release and tells the UI when it's newer than this build.
// There's no silent auto-update (that needs paid Apple signing on macOS). Instead:
//   macOS: one click runs the site's install.sh, which closes Meridian, swaps the app and reopens it;
//   Windows/Linux: the UI downloads the installer for this computer in a tab.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'Undermove/meridian-browser';
const FEED = `https://api.github.com/repos/${REPO}/releases/latest`;
const INSTALL_SH = 'https://undermove.github.io/meridian-browser/install.sh';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const FIRST_CHECK = 15_000;
const EVERY = 24 * 60 * 60 * 1000;

// "0.2.15" > "0.2.9"; pre-release tags ("0.3.0-beta") never count as newer.
function isNewer(latest, current) {
  if (!/^\d+(\.\d+)*$/.test(latest)) return false;
  const a = latest.split('.').map(Number), b = String(current).split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

// The release asset for this computer, used where there's no in-app installer.
function assetFor(assets, platform = process.platform, arch = process.arch) {
  const suffix = platform === 'win32' ? '-win.exe'
    : platform === 'darwin' ? `-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`
    : process.env.APPIMAGE ? (arch === 'arm64' ? '-linux-arm64.AppImage' : '-linux-x86_64.AppImage')
    : (arch === 'arm64' ? '-linux-arm64.deb' : '-linux-amd64.deb');
  // Versioned names only (Meridian-0.2.15-win.exe), not the version-less copies some releases also carry.
  const a = (assets || []).find((x) => /^Meridian-\d/.test(x.name || '') && x.name.endsWith(suffix));
  return a?.browser_download_url || RELEASES;
}

// Where the running Meridian.app lives, if install.sh can replace it there.
function macInstallDir(exe) {
  const bundle = path.resolve(exe, '..', '..', '..');
  if (!bundle.endsWith('.app')) return null;
  const dir = path.dirname(bundle);
  // Run from the .dmg or from a quarantine-translocated copy: nothing to update in place.
  if (dir.startsWith('/Volumes/') || dir.includes('/AppTranslocation/')) return null;
  try { fs.accessSync(dir, fs.constants.W_OK); } catch { return null; }
  return dir;
}

class Updates {
  // send(info) delivers { version, url, inApp } to the main window's UI.
  constructor({ app, net, send, feed = FEED, log = () => {} }) {
    Object.assign(this, { app, net, send, feed, log });
    this.latest = null;
    this.timer = null;
  }

  start(delay = FIRST_CHECK) {
    const run = () => {
      this.check().catch((err) => this.log('update check failed: ' + err.message));
      this.timer = setTimeout(run, EVERY);
    };
    this.timer = setTimeout(run, delay);
  }

  stop() { clearTimeout(this.timer); }

  async check() {
    const r = await this.net.fetch(this.feed, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rel = await r.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (!isNewer(version, this.app.getVersion())) return null;
    const inApp = process.platform === 'darwin' && !!macInstallDir(this.app.getPath('exe'));
    this.latest = { version, url: assetFor(rel.assets), inApp };
    this.send(this.latest);
    return this.latest;
  }

  // macOS: install.sh closes Meridian (tabs are saved on quit), swaps the app and opens the new one.
  // Detached, so it outlives the app it is replacing. Its output goes to updates.log in the profile.
  install() {
    const dir = process.platform === 'darwin' && macInstallDir(this.app.getPath('exe'));
    if (!dir) return false;
    const out = fs.openSync(path.join(this.app.getPath('userData'), 'updates.log'), 'w');
    const child = spawn('/bin/bash', ['-c', `curl -fsSL ${INSTALL_SH} | bash`], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, MERIDIAN_INSTALL_DIR: dir },
    });
    child.unref();
    fs.closeSync(out);
    return true;
  }
}

module.exports = { Updates, isNewer, assetFor, macInstallDir };
