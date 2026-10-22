// "Connect Claude Code / Codex": registers Meridian's MCP server with a coding-agent CLI.
// The CLIs are found on the login shell's PATH (GUI apps on macOS don't inherit it), the exact
// command is shown to the user in a native dialog, and only runs after they confirm. No shell:
// the binary is executed directly with an argument array.

const { execFile } = require('child_process');
const { loginPath, which } = require('./dev/env');

const CLIS = {
  claude: { name: 'Claude Code', args: (script) => ['mcp', 'add', '-s', 'user', 'meridian', '--', 'node', script] },
  codex: { name: 'Codex', args: (script) => ['mcp', 'add', 'meridian', '--', 'node', script] },
};

const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`);
const commandLine = (cli, script) => [cli, ...CLIS[cli].args(script)].map(quote).join(' ');

async function detectClis(script) {
  const searchPath = await loginPath();
  const out = {};
  for (const cli of Object.keys(CLIS)) out[cli] = { name: CLIS[cli].name, path: which(cli, searchPath), command: commandLine(cli, script) };
  return out;
}

// confirm(detail) -> Promise<boolean>, shown by the caller as a native dialog.
async function connectCli(cli, script, confirm) {
  if (!CLIS[cli]) return { ok: false, error: 'Unknown CLI' };
  const searchPath = await loginPath();
  const bin = which(cli, searchPath);
  if (!bin) return { ok: false, error: `${cli} was not found on your PATH` };
  const command = commandLine(cli, script);
  if (!(await confirm(command, CLIS[cli].name))) return { ok: false, cancelled: true };
  return new Promise((resolve) => {
    execFile(bin, CLIS[cli].args(script), { timeout: 30_000, env: { ...process.env, PATH: searchPath }, encoding: 'utf8' }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim().slice(0, 2000);
      if (err) {
        // Already registered is fine: that's the state the user wants.
        if (/already exists/i.test(output)) return resolve({ ok: true, already: true, output });
        return resolve({ ok: false, error: output || err.message });
      }
      resolve({ ok: true, output });
    });
  });
}

module.exports = { detectClis, connectCli, commandLine };
