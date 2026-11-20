// A stand-in program for a test (an agent CLI such as `codex`), written in JavaScript so the same
// stand-in runs everywhere: on macOS and Linux as a script this node runs (#!), on Windows through
// <name>.exe, since Meridian looks for programs there as .exe only. That .exe is a tiny launcher,
// compiled once with the C# compiler Windows ships, that runs <name>.cjs beside it with this node,
// passing on the arguments, stdin, stdout and stderr, and the exit code.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WINDOWS = process.platform === 'win32';

// C#'s verbatim string: quotes doubled.
const verbatim = (s) => `@"${s.replace(/"/g, '""')}"`;

const LAUNCHER = `using System; using System.Diagnostics; using System.IO; using System.Text;
class StandIn {
  static int Main(string[] args) {
    string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
    var line = new StringBuilder(Quote(Path.ChangeExtension(exe, ".cjs")));
    foreach (string a in args) line.Append(' ').Append(Quote(a));
    var p = Process.Start(new ProcessStartInfo(${verbatim(process.execPath)}, line.ToString()) { UseShellExecute = false });
    p.WaitForExit();
    return p.ExitCode;
  }
  // As CommandLineToArgvW reads it back.
  static string Quote(string a) {
    var s = new StringBuilder("\\"");
    int slashes = 0;
    foreach (char c in a) {
      if (c == '\\\\') { slashes++; continue; }
      s.Append('\\\\', c == '"' ? slashes * 2 + 1 : slashes);
      slashes = 0;
      s.Append(c);
    }
    s.Append('\\\\', slashes * 2).Append('"');
    return s.ToString();
  }
}
`;

let launcher;
function windowsLauncher() {
  if (launcher && fs.existsSync(launcher)) return launcher;
  const id = crypto.createHash('sha256').update(LAUNCHER).digest('hex').slice(0, 12);
  launcher = path.join(os.tmpdir(), `meridian-stand-in-${id}.exe`);
  if (!fs.existsSync(launcher)) {
    const src = `${launcher}.cs`;
    fs.writeFileSync(src, LAUNCHER);
    const csc = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    execFileSync(csc, ['/nologo', `/out:${launcher}`, src], { stdio: 'pipe' });
  }
  return launcher;
}

// Writes the stand-in `name` into `dir`; returns the path to run it by.
export function standIn(dir, name, js) {
  if (!WINDOWS) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!${process.execPath}\n${js}`, { mode: 0o755 });
    return file;
  }
  fs.writeFileSync(path.join(dir, `${name}.cjs`), js);
  const exe = path.join(dir, `${name}.exe`);
  fs.copyFileSync(windowsLauncher(), exe);
  return exe;
}
