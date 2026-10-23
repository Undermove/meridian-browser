// Writes THIRD_PARTY_NOTICES.md: every package shipped with Meridian (production dependencies, all
// levels) with its license text. Chromium's own notices ship inside Electron as LICENSES.chromium.html.
// Usage: node scripts/third-party-notices.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const tree = JSON.parse(execFileSync('npm', ['ls', '--omit=dev', '--all', '--json', '--long'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }));
const seen = new Map();
(function walk(node) {
  for (const dep of Object.values(node.dependencies || {})) {
    if (dep.path && dep.name && !seen.has(`${dep.name}@${dep.version}`)) seen.set(`${dep.name}@${dep.version}`, dep);
    walk(dep);
  }
})(tree);

const licenseText = (dir) => {
  try {
    const f = fs.readdirSync(dir).find((n) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(n));
    return f ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : null;
  } catch { return null; }
};

const rows = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
let out = `# Third-party notices\n\nMeridian is MIT-licensed (see LICENSE). It includes the following open-source packages, listed with their licenses. Electron and Chromium notices ship with the app as \`LICENSES.chromium.html\`.\n\n| Package | Version | License |\n|---|---|---|\n`;
for (const d of rows) out += `| ${d.name} | ${d.version} | ${typeof d.license === 'string' ? d.license : (d.license?.type || 'see below')} |\n`;
out += '\n---\n';
for (const d of rows) {
  const text = licenseText(d.path);
  out += `\n## ${d.name} ${d.version}\n\n${text ? '```\n' + text.replace(/```/g, "'''") + '\n```' : `License: ${d.license || 'not stated'} (no license file in the package)`}\n`;
}
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), out);
const licenses = {};
for (const d of rows) { const l = typeof d.license === 'string' ? d.license : d.license?.type || 'unknown'; licenses[l] = (licenses[l] || 0) + 1; }
console.log(`${rows.length} packages:`, JSON.stringify(licenses));
