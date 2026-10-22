// Workbench Pro: personal hub folders — a folder of posts / notes / code that you work on with coding
// agents through AGENTS.md / CLAUDE.md conventions.
//
// Creating a hub only ever writes inside a NEW folder (or an empty existing one) whose parent the user
// picked in a native dialog; the name is a single plain path segment. Files are created with 'wx'
// (never overwrite). `git init` runs via execFile with an argv array.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const COMMON_GITIGNORE = `# OS / editors
.DS_Store
Thumbs.db
.idea/
.vscode/
*.swp

# Secrets never go into git — keep them in the Meridian vault (they reach agents as env vars)
.env
.env.*
!.env.example
*.pem
id_rsa*
`;

const TEMPLATES = {
  content: {
    label: 'Content hub',
    description: 'Posts, articles and their images, with a drafts convention.',
    dirs: ['posts', 'posts/drafts', 'articles', 'images', 'ideas'],
    files: (name) => ({
      'AGENTS.md': `# ${name} — instructions for agents

This folder is a personal content hub: posts, long-form articles and the images that go with them.
You (the coding agent) help write, edit and organise them. Read this file before doing anything.

## Where things live

- Short posts → \`posts/\`, one file per post, named \`YYYY-MM-DD-topic.md\`.
- Drafts that are not published yet → \`posts/drafts/\` (same naming). Move a post out of drafts only
  when the user says it was published.
- Long-form articles → \`articles/YYYY-MM-DD-topic.md\`.
- Images for a post → \`images/<topic>/\`. Reference them with relative links.
- Loose ideas and links → \`ideas/\` (one file per idea or a running \`ideas/inbox.md\`).

## Conventions

- Write in the user's voice and language. Keep their wording when they dictate; don't pad.
- Never invent facts, quotes or numbers. If something needs a source, put the link inline.
- Don't reference a draft from another post as if it were published.
- Don't delete files; move obsolete ones to \`posts/drafts/archive/\` and say so.
- Secrets (API keys, tokens) are never written into files here. If a task needs one, use the
  environment variable Meridian provides (e.g. \`$OPENAI_API_KEY\`) and never print its value.

## Typical tasks

- "Write a post about X" → draft in \`posts/drafts/\`, show it to the user, wait for approval.
- "Turn these notes into an article" → \`articles/\`, keep a short outline at the top while drafting.
- "Find the post about X" → search \`posts/\` and \`articles/\` by content, not just file names.
`,
      'posts/drafts/.gitkeep': '',
      'images/.gitkeep': '',
      'articles/.gitkeep': '',
      'ideas/inbox.md': `# Ideas inbox\n\n- ${today()} — first idea goes here\n`,
      'README.md': `# ${name}\n\nPersonal content hub. Conventions for agents (and humans) are in [AGENTS.md](AGENTS.md).\n`,
    }),
  },
  knowledge: {
    label: 'Knowledge base',
    description: 'Notes, an inbox for quick capture and daily notes.',
    dirs: ['notes', 'inbox', 'daily', 'attachments'],
    files: (name) => ({
      'AGENTS.md': `# ${name} — instructions for agents

This folder is a personal knowledge base in plain Markdown. You (the coding agent) help capture,
file, link and summarise notes. Read this file before doing anything.

## Structure

- \`inbox/\` — quick captures, unsorted. One file per capture: \`YYYY-MM-DD-short-title.md\`.
- \`notes/\` — permanent notes, one topic per file, named by topic in kebab-case (\`http-caching.md\`).
- \`daily/\` — daily notes: \`daily/YYYY-MM-DD.md\`.
- \`attachments/\` — images and PDFs referenced from notes.

## Conventions

- Link notes with relative Markdown links (\`[HTTP caching](../notes/http-caching.md)\`).
- When filing an inbox item, move its content into an existing note if one fits; otherwise create a
  new note. Keep a "Sources" line with links when the content came from somewhere.
- Preserve the user's wording in quotes and personal notes; summarise only when asked.
- Never delete notes. Merge, then leave a one-line pointer in the old file.
- Frontmatter is optional; if a file has it, keep it valid YAML.
- Secrets never go into notes. Use the environment variables Meridian provides instead.

## Typical tasks

- "Process the inbox" → file each item into \`notes/\` or today's daily note, list what you did.
- "What do I know about X?" → search \`notes/\` and \`daily/\`, answer with links to the notes.
- "Start today's note" → create \`daily/${today()}.md\` from the previous day's open items.
`,
      'inbox/.gitkeep': '',
      'attachments/.gitkeep': '',
      'notes/index.md': `# Index\n\nStart here. Link the most important notes from this page.\n`,
      [`daily/${today()}.md`]: `# ${today()}\n\n## Today\n\n- \n`,
      'README.md': `# ${name}\n\nPersonal knowledge base. Conventions for agents (and humans) are in [AGENTS.md](AGENTS.md).\n`,
    }),
  },
  code: {
    label: 'Code project',
    description: 'A fresh repository with agent instructions and a src/ folder.',
    dirs: ['src', 'docs'],
    files: (name) => ({
      'AGENTS.md': `# ${name} — instructions for agents

## Project

Describe what this project does in two or three sentences, and who uses it.

## Layout

- \`src/\` — source code.
- \`docs/\` — design notes and decisions (\`docs/YYYY-MM-DD-decision.md\`).

## How to work here

- Before changing code, read the relevant files and explain the plan in one or two lines.
- Keep changes small and focused; match the existing style.
- Run the tests / build after every change and report the result honestly.
- Don't add dependencies without asking.
- Commit only when the user asks. Never push.
- Secrets come from environment variables that Meridian injects from its vault. Never write keys into
  files, never print them, and never commit \`.env\` files.

## Commands

- Build: _fill in_
- Test: _fill in_
- Run: _fill in_
`,
      'src/.gitkeep': '',
      'docs/.gitkeep': '',
      'README.md': `# ${name}\n\nSee [AGENTS.md](AGENTS.md) for how agents (and humans) work in this repository.\n`,
    }),
  },
};

const CLAUDE_MD = '# CLAUDE.md\n\nAll instructions for agents live in [AGENTS.md](AGENTS.md). Read it first and follow it.\n\n@AGENTS.md\n';

const SKILL_MD = (template) => `---
name: hub-conventions
description: Use when creating, moving or naming files in this ${TEMPLATES[template].label.toLowerCase()} — applies the folder conventions from AGENTS.md.
---

# Hub conventions

1. Re-read AGENTS.md at the root of this folder.
2. Pick the folder and file name exactly as AGENTS.md describes (dates as YYYY-MM-DD).
3. Never overwrite or delete an existing file without asking; propose a new name instead.
4. After creating or moving files, list the paths you touched.
`;

function validHubName(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 80 || /[\\/:\0*?"<>|]/.test(n) || n === '.' || n === '..' || n.startsWith('.')) throw new Error('Use a plain folder name (no slashes, not starting with a dot).');
  return n;
}

async function gitInit(dir, gitPath) {
  if (!gitPath) return { git: false, reason: 'git was not found on your PATH' };
  return new Promise((resolve) => {
    execFile(gitPath, ['init', '-q'], { cwd: dir, timeout: 10_000 }, (err) => {
      if (err) return resolve({ git: false, reason: err.message.slice(0, 200) });
      // First commit is best-effort (fails without user.name/email configured).
      execFile(gitPath, ['add', '-A'], { cwd: dir, timeout: 10_000 }, (e1) => {
        if (e1) return resolve({ git: true, committed: false });
        execFile(gitPath, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'Create hub with Meridian'], { cwd: dir, timeout: 10_000 }, (e2) => resolve({ git: true, committed: !e2 }));
      });
    });
  });
}

// parent: real folder picked in a native dialog. Returns { root, git, committed }.
async function createHub({ parent, name, template, git = true, skills = true, gitPath = null }) {
  const t = TEMPLATES[template];
  if (!t) throw new Error('Unknown template');
  const n = validHubName(name);
  const parentReal = await fsp.realpath(parent);
  const root = path.join(parentReal, n);
  if (path.dirname(root) !== parentReal) throw new Error('Invalid name');
  let existing = null;
  try { existing = await fsp.readdir(root); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (existing && existing.filter((f) => f !== '.DS_Store').length) throw new Error(`“${n}” already exists and isn’t empty. Pick another name, or open it with “Open folder as hub”.`);
  if (!existing) await fsp.mkdir(root);
  const write = async (rel, content) => {
    const abs = path.join(root, rel);
    if (!abs.startsWith(root + path.sep)) throw new Error('invalid template path');
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, { flag: 'wx' });
  };
  for (const d of t.dirs) await fsp.mkdir(path.join(root, d), { recursive: true });
  for (const [rel, content] of Object.entries(t.files(n))) await write(rel, content);
  await write('CLAUDE.md', CLAUDE_MD);
  await write('.gitignore', COMMON_GITIGNORE);
  if (skills) await write('.claude/skills/hub-conventions/SKILL.md', SKILL_MD(template));
  const g = git ? await gitInit(root, gitPath) : { git: false };
  return { root, ...g };
}

// ---------- hub panel data ----------

const CONVENTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md', 'README.md'];
const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', 'target', '.venv', 'venv', '__pycache__', '.cache']);

async function hubInfo(root) {
  const conventions = [];
  for (const rel of CONVENTION_FILES) {
    try {
      const abs = path.join(root, rel);
      const real = await fsp.realpath(abs);
      if (!real.startsWith(root + path.sep)) continue;
      const st = await fsp.stat(real);
      if (!st.isFile()) continue;
      const entry = { path: rel, size: st.size, headings: [] };
      if (st.size < 512 * 1024 && rel !== 'README.md') {
        const text = await fsp.readFile(real, 'utf8');
        text.split('\n').forEach((line, i) => {
          const m = /^(#{1,3})\s+(.+)$/.exec(line);
          if (m && entry.headings.length < 30) entry.headings.push({ level: m[1].length, text: m[2].trim().slice(0, 120), line: i + 1 });
        });
      }
      conventions.push(entry);
    } catch {}
  }
  let skills = [];
  try { skills = (await fsp.readdir(path.join(root, '.claude', 'skills'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).slice(0, 30); } catch {}
  // Recent files: bounded walk, newest first.
  const files = [];
  let seen = 0;
  const walk = async (dir, depth) => {
    if (depth > 5 || seen > 8000) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (++seen > 8000) return;
      if (d.name === '.DS_Store') continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) { if (!SKIP.has(d.name) && !(d.name.startsWith('.') && d.name !== '.claude')) await walk(abs, depth + 1); continue; }
      if (!d.isFile()) continue;
      try { const st = await fsp.stat(abs); files.push({ path: path.relative(root, abs).split(path.sep).join('/'), mtimeMs: st.mtimeMs }); } catch {}
    }
  };
  await walk(root, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const isHub = conventions.some((c) => c.path !== 'README.md');
  return { isHub, conventions, skills, recent: files.slice(0, 15) };
}

module.exports = { TEMPLATES, createHub, hubInfo, validHubName };
