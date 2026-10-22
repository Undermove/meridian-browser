// Workbench: file access scoped to one project folder.
//
// Every path coming from the workbench page is a path *relative to the project root*. It is resolved
// and then checked twice: lexically (no "..", no absolute paths) and by real path (so a symlink inside
// the project that points elsewhere can't be used to read or write outside it).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { shell } = require('electron');

const MAX_OPEN_BYTES = 5 * 1024 * 1024;   // files bigger than this aren't opened in the editor
const MAX_WRITE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 5000;                 // per directory listing
const HIDDEN_BY_DEFAULT = new Set(['.git', 'node_modules', '.DS_Store', '.hg', '.svn', 'Thumbs.db']);
const NOISY_DIRS = /(^|[\\/])(\.git|node_modules|\.hg|\.svn)([\\/]|$)/;

class ProjectFs {
  constructor(root, onChange) {
    this.root = fs.realpathSync(root);
    if (!fs.statSync(this.root).isDirectory()) throw new Error('not a folder');
    this.onChange = onChange;
    this.watcher = null;
    this.pending = new Set();
    this.flushTimer = null;
    this.watch();
  }

  get name() { return path.basename(this.root) || this.root; }

  inside(abs) { return abs === this.root || abs.startsWith(this.root + path.sep); }

  // rel -> absolute path inside the root. `mustExist` false is for create/rename targets.
  async resolve(rel, { mustExist = true } = {}) {
    if (typeof rel !== 'string' || rel.length > 4096 || rel.includes('\0')) throw new Error('invalid path');
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new Error('path must be relative to the project');
    const abs = path.resolve(this.root, rel);
    if (!this.inside(abs)) throw new Error('path is outside the project');
    if (mustExist) {
      const real = await fsp.realpath(abs);
      if (!this.inside(real)) throw new Error('path leads outside the project (symlink)');
      return abs;
    }
    // New entry: its parent must exist and really be inside the project; the name itself must be plain.
    const base = path.basename(abs);
    if (!base || base === '.' || base === '..' || abs === this.root) throw new Error('invalid name');
    const parentReal = await fsp.realpath(path.dirname(abs));
    if (!this.inside(parentReal)) throw new Error('path leads outside the project (symlink)');
    return abs;
  }

  rel(abs) { return path.relative(this.root, abs).split(path.sep).join('/'); }

  async list(rel = '', { showHidden = false } = {}) {
    const dir = await this.resolve(rel || '.');
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const d of entries.slice(0, MAX_ENTRIES)) {
      if (!showHidden && HIDDEN_BY_DEFAULT.has(d.name)) continue;
      const abs = path.join(dir, d.name);
      let type = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other';
      let outside = false;
      if (d.isSymbolicLink()) {
        try {
          const real = await fsp.realpath(abs);
          if (!this.inside(real)) outside = true;
          else type = (await fsp.stat(real)).isDirectory() ? 'dir' : 'file';
        } catch { type = 'broken'; }
      }
      out.push({ name: d.name, path: this.rel(abs), type, link: d.isSymbolicLink() || undefined, outside: outside || undefined, hidden: HIDDEN_BY_DEFAULT.has(d.name) || undefined });
    }
    out.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { path: rel, entries: out, truncated: entries.length > MAX_ENTRIES };
  }

  async read(rel) {
    const abs = await this.resolve(rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > MAX_OPEN_BYTES) return { path: rel, tooLarge: true, size: st.size, mtimeMs: st.mtimeMs };
    const buf = await fsp.readFile(abs);
    // Treat files with NUL bytes in the first 8 KB as binary.
    if (buf.subarray(0, 8192).includes(0)) return { path: rel, binary: true, size: st.size, mtimeMs: st.mtimeMs };
    return { path: rel, content: buf.toString('utf8'), size: st.size, mtimeMs: st.mtimeMs };
  }

  async stat(rel) {
    try {
      const st = await fsp.stat(await this.resolve(rel));
      return { exists: true, mtimeMs: st.mtimeMs, size: st.size, dir: st.isDirectory() };
    } catch { return { exists: false }; }
  }

  async write(rel, content) {
    if (typeof content !== 'string') throw new Error('content must be text');
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error('file is too large');
    let abs;
    try { abs = await this.resolve(rel); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      abs = await this.resolve(rel, { mustExist: false });
    }
    const st = await fsp.stat(abs).catch(() => null);
    if (st && !st.isFile()) throw new Error('not a file');
    await fsp.writeFile(abs, content, 'utf8');
    const after = await fsp.stat(abs);
    return { path: rel, mtimeMs: after.mtimeMs, size: after.size };
  }

  async create(rel, kind) {
    const abs = await this.resolve(rel, { mustExist: false });
    if (kind === 'dir') await fsp.mkdir(abs);
    else await fsp.writeFile(abs, '', { flag: 'wx' }); // never clobber an existing file
    return { path: this.rel(abs) };
  }

  async rename(from, to) {
    const src = await this.resolve(from);
    if (src === this.root) throw new Error('can’t rename the project folder');
    const dst = await this.resolve(to, { mustExist: false });
    if (fs.existsSync(dst)) throw new Error('a file with that name already exists');
    await fsp.rename(src, dst);
    return { path: this.rel(dst) };
  }

  // Deleting goes to the system Trash, so a slip is recoverable.
  async remove(rel) {
    const abs = await this.resolve(rel);
    if (abs === this.root) throw new Error('can’t delete the project folder');
    await shell.trashItem(abs);
    return true;
  }

  // ---------- external changes (agents edit files) ----------

  watch() {
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, file) => {
        if (!file) return this.queue('');
        const f = String(file);
        // Changes inside .git / node_modules are noise; still refresh their parent folder listing.
        const m = NOISY_DIRS.exec(f);
        this.queue(m ? f.slice(0, m.index + m[0].replace(/[\\/]$/, '').length) : f);
      });
      this.watcher.on('error', (err) => console.warn('workbench: watcher error', err.message));
    } catch (err) {
      console.warn('workbench: cannot watch project', err.message);
    }
  }

  queue(file) {
    this.pending.add(String(file).split(path.sep).join('/'));
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const paths = [...this.pending].slice(0, 500);
      this.pending.clear();
      this.onChange?.(paths);
    }, 150);
  }

  dispose() {
    try { this.watcher?.close(); } catch {}
    clearTimeout(this.flushTimer);
    this.watcher = null;
  }
}

module.exports = { ProjectFs, MAX_OPEN_BYTES };
