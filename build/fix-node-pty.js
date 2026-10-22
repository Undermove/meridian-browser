// node-pty ships its macOS `spawn-helper` in prebuilds/ without the executable bit in some installs,
// which makes every terminal fail with "posix_spawnp failed". Run after npm install (postinstall).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules', 'node-pty');
const dirs = [path.join(root, 'build', 'Release')];
try { for (const d of fs.readdirSync(path.join(root, 'prebuilds'))) dirs.push(path.join(root, 'prebuilds', d)); } catch {}
for (const dir of dirs) {
  const helper = path.join(dir, 'spawn-helper');
  try { fs.chmodSync(helper, 0o755); } catch {}
}
