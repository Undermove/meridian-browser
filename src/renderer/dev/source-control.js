/* Workbench — Source Control: git in the project, as in VS Code. The changed files (staged and not),
 * a side-by-side diff of each, stage / unstage / discard, a commit, branches, the recent commits,
 * pull and push, and pull requests through the GitHub CLI when it is installed. git runs in the
 * browser (only the commands this panel uses, paths inside the project); the terminal is there for
 * anything else. */

const SCM = {
  info: null,        // {git, gh}
  repo: false,
  branch: '',
  upstream: '',
  ahead: 0,
  behind: 0,
  staged: [],        // {path, code, orig}
  changes: [],
  log: [],
  prs: null,         // null: not loaded / no gh
  busy: '',
  error: '',
  diff: null,        // {path, staged}
  timer: null,
  loaded: false,
  open: false,       // the left pane shows changes instead of files
  repos: [],         // {path, name, kind}
  root: '',          // another repository shown ('': the project's); viewing only
  picking: false,
  mode: 'changes',   // 'changes' (not committed) or 'branch' (this branch against its base)
  base: '',
  mergeBase: '',
  branchFiles: [],
  pr: null,
};

const scmGit = async (args, opts) => {
  const r = await wb.git(args, { ...opts, repo: SCM.root || undefined });
  if (r.timedOut) throw new Error(`git ${args[0]} took too long`);
  return r;
};

// `git status --porcelain=v2 -z --branch`: the branch, and each file's staged (X) and unstaged (Y)
// state.
function scmParseStatus(out) {
  const st = { branch: '', upstream: '', ahead: 0, behind: 0, staged: [], changes: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) st.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) { st.ahead = +m[1]; st.behind = +m[2]; } }
    else if (line.startsWith('? ')) st.changes.push({ path: line.slice(2), code: 'U', untracked: true });
    else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      const f = line.split(' ');
      const xy = f[1];
      const n = line.startsWith('1 ') ? 8 : line.startsWith('2 ') ? 9 : 10;
      const path = f.slice(n).join(' ');
      const orig = line.startsWith('2 ') ? parts[++i] : undefined;
      if (line.startsWith('u ')) { st.changes.push({ path, code: '!', conflict: true }); continue; }
      if (xy[0] !== '.') st.staged.push({ path, code: xy[0], orig });
      if (xy[1] !== '.') st.changes.push({ path, code: xy[1] });
    }
  }
  return st;
}

async function scmRefresh() {
  if (!S.project) return;
  // Only the latest look counts: an older one may be of another repository or view.
  const look = SCM.look = (SCM.look || 0) + 1;
  try {
    SCM.info = SCM.info || await wb.gitInfo();
    if (!SCM.info.git) { SCM.repo = false; SCM.loaded = true; scmRender(); return; }
    const st = await scmGit(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
    if (look !== SCM.look) return;
    SCM.repo = st.code === 0;
    if (SCM.repo) {
      Object.assign(SCM, scmParseStatus(st.stdout));
      const log = await scmGit(['log', '-n', '30', '--format=%h%x09%s%x09%an%x09%ar']);
      if (look !== SCM.look) return;
      SCM.log = log.code === 0 ? log.stdout.split('\n').filter(Boolean).map((l) => { const [hash, subject, author, when] = l.split('\t'); return { hash, subject, author, when }; }) : [];
      if (SCM.mode === 'branch') await scmLoadBranch(look);
      if (look !== SCM.look) return;
    }
    SCM.error = '';
  } catch (err) { if (look !== SCM.look) return; SCM.error = err.message; }
  SCM.loaded = true;
  scmRender();
}

// What this branch changed against the one it came from.
async function scmLoadBranch(look) {
  let base = '';
  const head = await scmGit(['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (head.code === 0 && head.stdout.trim() !== 'origin/HEAD') base = head.stdout.trim();
  for (const c of ['origin/main', 'origin/master', 'main', 'master']) {
    if (base) break;
    if (c !== SCM.branch && (await scmGit(['rev-parse', '--verify', '-q', c])).code === 0) base = c;
  }
  let mergeBase = '';
  const files = [];
  if (base) {
    const mb = await scmGit(['merge-base', base, 'HEAD']);
    if (mb.code === 0) {
      mergeBase = mb.stdout.trim();
      const d = await scmGit(['diff', '--name-status', '-z', '--no-renames', mergeBase, 'HEAD']);
      const parts = d.code === 0 ? d.stdout.split('\0').filter(Boolean) : [];
      for (let i = 0; i + 1 < parts.length; i += 2) files.push({ code: parts[i][0], path: parts[i + 1], committed: true });
    }
  }
  if (look !== SCM.look) return;
  Object.assign(SCM, { base, mergeBase, branchFiles: files });
}

async function scmLoadPr() {
  SCM.pr = null;
  if (!SCM.info?.gh || !SCM.branch) return;
  const root = SCM.root;
  try {
    const r = await wb.gh(['pr', 'view', '--json', 'number,title,url,state'], { repo: root || undefined });
    if (root === SCM.root && r.code === 0) { SCM.pr = JSON.parse(r.stdout); scmRender(); }
  } catch {}
}

async function scmLoadRepos() {
  try { SCM.repos = await wb.gitRepos(); } catch { SCM.repos = []; }
  scmRender();
}

async function scmPickRepo(repo) {
  SCM.picking = false;
  scmCloseDiff();
  SCM.root = repo.kind === 'project' ? '' : repo.path;
  Object.assign(SCM, { loaded: false, staged: [], changes: [], log: [], prs: null, pr: null, branchFiles: [] });
  scmRender();
  await scmRefresh();
  scmLoadPr();
}

function scmSetMode(mode) {
  SCM.mode = mode;
  scmCloseDiff();
  scmRefresh();
}

function scmSetOpen(open) {
  SCM.open = open;
  $('#tree').hidden = open;
  $('#scm-view').hidden = !open;
  $('#tree-tools').hidden = open;
  $('#view-files').classList.toggle('on', !open);
  $('#view-scm').classList.toggle('on', open);
  if (open) { scmLoadRepos(); scmRefresh(); scmLoadPr(); }
}

// Soon after files change (the project's watcher), not on every keystroke of a save.
function scmSoon() {
  clearTimeout(SCM.timer);
  SCM.timer = setTimeout(scmRefresh, 400);
}

function scmRender() {
  scmRenderCount();
  if (SCM.open) scmRenderPane();
}

// Keeps the place and the caret: this redraws whenever files change.
function scmRenderPane() {
  // Not under a pressed mouse button: the click would be lost with the row.
  if (SCM.pressed) { SCM.redraw = true; return; }
  const view = $('#scm-view');
  const top = view.scrollTop;
  const box = document.getElementById('scm-message');
  const typing = box && document.activeElement === box ? [box.selectionStart, box.selectionEnd] : null;
  const el = document.createElement('div');
  el.className = 'panel';
  renderScmPanel(el);
  iconize(el);
  // Nothing new: the rows stay, so a click in progress isn't lost.
  if (view.firstElementChild?.innerHTML === el.innerHTML) return;
  view.replaceChildren(el);
  view.scrollTop = top;
  if (typing) { const b = document.getElementById('scm-message'); b?.focus(); b?.setSelectionRange(...typing); }
}

function scmRenderCount() {
  const c = document.getElementById('scm-count');
  if (!c) return;
  const n = SCM.repo ? SCM.staged.length + SCM.changes.length : 0;
  c.hidden = !n;
  c.textContent = n;
  $('#view-scm').title = SCM.repo ? `Changes on ${SCM.branch || 'no branch'}${n ? `: ${n}` : ''}` : 'Changes';
}

async function scmRun(label, fn) {
  if (SCM.busy) return;
  SCM.busy = label;
  scmRender();
  try { await fn(); } catch (err) { toast(err.message, 5000); }
  SCM.busy = '';
  await scmRefresh();
}

// A git command that must succeed: its own message when it doesn't.
async function scmMust(args, opts) {
  const r = await scmGit(args, opts);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `git ${args[0]} failed`).trim().split('\n').slice(-3).join('\n'));
  return r;
}

const scmStage = (paths) => scmRun('Staging…', () => scmMust(['add', '--', ...paths]));
const scmUnstage = (paths) => scmRun('Unstaging…', () => scmMust(['restore', '--staged', '--', ...paths]));

async function scmDiscard(file) {
  const ok = await confirmBox(file.untracked ? `Delete ${file.path}?` : `Discard the changes to ${file.path}?`,
    file.untracked ? 'The file is not in git: it goes to the Trash.' : 'This brings back the last committed version. It can’t be undone.', file.untracked ? 'Move to Trash' : 'Discard', true);
  if (!ok) return;
  await scmRun('Discarding…', async () => {
    if (file.untracked) await wb.remove(file.path);
    else await scmMust(['restore', '--worktree', '--', file.path]);
  });
}

async function scmCommit() {
  const box = document.getElementById('scm-message');
  const message = box?.value.trim() || '';
  if (!message) { box?.focus(); toast('Write a commit message'); return; }
  await scmRun('Committing…', async () => {
    // Nothing staged: everything that changed, as VS Code offers.
    if (!SCM.staged.length) await scmMust(['add', '-A']);
    await scmMust(['commit', '-F', '-'], { stdin: message + '\n' });
    SCM.message = '';
    if (box) box.value = '';
    toast('Committed');
  });
}

async function scmBranchMenu() {
  const r = await scmGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const branches = r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  const items = [
    ...branches.map((b) => ({ id: 'b:' + b, label: b === SCM.branch ? `✓ ${b}` : b })),
    { type: 'separator' },
    { id: 'new', label: 'New Branch…' },
  ];
  const choice = await wb.menu(items);
  if (!choice) return;
  if (choice === 'new') {
    const name = await askText('New branch name', '', 'A name like fix-login');
    if (!name) return;
    await scmRun('Creating the branch…', () => scmMust(['switch', '-c', name.trim()]));
  } else if (choice.startsWith('b:') && choice.slice(2) !== SCM.branch) {
    await scmRun('Switching…', () => scmMust(['switch', choice.slice(2)]));
  }
}

const scmPull = () => scmRun('Pulling…', async () => { await scmMust(['pull', '--ff-only']); toast('Pulled'); });
const scmPush = () => scmRun('Pushing…', async () => {
  if (SCM.upstream) await scmMust(['push']);
  else await scmMust(['push', '--set-upstream', 'origin', SCM.branch]);
  toast('Pushed');
});

async function scmLoadPrs() {
  if (!SCM.info?.gh) { SCM.prs = null; return; }
  try {
    const r = await wb.gh(['pr', 'list', '--json', 'number,title,headRefName,url,state', '--limit', '15'], { repo: SCM.root || undefined });
    SCM.prs = r.code === 0 ? JSON.parse(r.stdout || '[]') : { error: (r.stderr || 'gh failed').trim().split('\n')[0] };
  } catch (err) { SCM.prs = { error: err.message }; }
  if (SCM.open) scmRenderPane();
}

const scmCreatePr = () => scmRun('Creating the pull request…', async () => {
  if (!SCM.upstream) await scmMust(['push', '--set-upstream', 'origin', SCM.branch]);
  const r = await wb.gh(['pr', 'create', '--fill']);
  if (r.code !== 0) throw new Error((r.stderr || 'gh pr create failed').trim().split('\n').slice(-2).join('\n'));
  const url = (r.stdout.match(/https:\/\/\S+/) || [])[0];
  if (url) wb.toHost({ type: 'link', url });
  await scmLoadPrs();
});

// ------------------------------------------------------------------ the diff

async function scmShowDiff(file, staged) {
  const monaco = await loadMonaco();
  // The file as it was: in the last commit (staged changes), else as staged.
  let original = '';
  if (file.committed) {
    if (file.code !== 'A') { const r = await scmGit(['show', `${SCM.mergeBase}:${file.path}`]); original = r.code === 0 ? r.stdout : ''; }
  } else if (!file.untracked) {
    const ref = staged ? `HEAD:${file.orig || file.path}` : `:${file.path}`;
    const r = await scmGit(['show', ref]);
    original = r.code === 0 ? r.stdout : '';
  }
  let modified = '';
  if (file.committed) {
    if (file.code !== 'D') { const r = await scmGit(['show', `HEAD:${file.path}`]); modified = r.code === 0 ? r.stdout : ''; }
  } else if (SCM.root) {
    if (file.code !== 'D') { try { modified = await wb.gitReadFile(SCM.root, file.path); } catch { modified = ''; } }
  } else if (staged) {
    const r = await scmGit(['show', `:${file.path}`]);
    modified = r.code === 0 ? r.stdout : '';
  } else if (file.code !== 'D') {
    const open = S.tabs.find((t) => t.path === file.path && t.model);
    if (open) modified = open.model.getValue();
    else { try { modified = (await wb.read(file.path)).content || ''; } catch { modified = ''; } }
  }
  let host = document.getElementById('diff-pane');
  if (!host) {
    host = document.createElement('div');
    host.id = 'diff-pane';
    host.innerHTML = '<div class="diff-head"><span class="diff-title"></span><span class="grow"></span><button class="btn small" id="diff-open">Open File</button><button class="icon-btn" id="diff-close" title="Close the diff"></button></div><div id="diff-host"></div>';
    $('#editor-area').appendChild(host);
    host.querySelector('#diff-close').innerHTML = icon('x', 13);
    host.querySelector('#diff-close').addEventListener('click', scmCloseDiff);
    host.querySelector('#diff-open').addEventListener('click', () => { const p = SCM.diff?.path; scmCloseDiff(); if (p) openFile(p, { focus: true }); });
  }
  host.hidden = false;
  host.querySelector('#diff-open').hidden = !!SCM.root;
  host.querySelector('.diff-title').textContent = `${file.path} — ${file.committed ? `against ${SCM.base}` : staged ? 'staged' : 'changes'}`;
  if (!S.diffEditor) {
    S.diffEditor = monaco.editor.createDiffEditor(host.querySelector('#diff-host'), {
      renderSideBySide: true, readOnly: true, originalEditable: false, automaticLayout: true,
      minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13,
    });
  }
  const lang = monaco.editor.createModel('', undefined, monaco.Uri.from({ scheme: 'git', path: '/lang/' + file.path })).getLanguageId();
  monaco.editor.getModels().filter((m) => m.uri.scheme === 'git').forEach((m) => m.dispose());
  const before = monaco.editor.createModel(original, lang, monaco.Uri.from({ scheme: 'git', path: '/before/' + file.path }));
  const after = monaco.editor.createModel(modified, lang, monaco.Uri.from({ scheme: 'git', path: '/after/' + file.path }));
  S.diffEditor.setModel({ original: before, modified: after });
  SCM.diff = { path: file.path, staged };
  if (SCM.open) scmRenderPane();
}

function scmCloseDiff() {
  const host = document.getElementById('diff-pane');
  if (host) host.hidden = true;
  SCM.diff = null;
  if (S.diffEditor) S.diffEditor.setModel(null);
  S.monaco?.editor.getModels().filter((m) => m.uri.scheme === 'git').forEach((m) => m.dispose());
  if (SCM.open) scmRenderPane();
}

// ------------------------------------------------------------------ the panel

function scmRow(file, staged) {
  const row = h('div', 'scm-row' + (SCM.diff?.path === file.path && SCM.diff.staged === staged ? ' active' : ''));
  row.dataset.path = file.path;
  const name = h('span', 'scm-name', file.path.split('/').pop());
  const dir = h('span', 'scm-dir', file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '');
  const code = h('span', `scm-code c-${file.code}`, file.code);
  code.title = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Untracked', '!': 'Conflict', T: 'Type changed', C: 'Copied' }[file.code] || file.code;
  row.append(name, dir, h('span', 'grow'));
  const act = (label, title, fn, cls) => { const b = h('button', `icon-btn scm-act ${cls}`, label); b.title = title; b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
  if (SCM.root || file.committed) { /* viewing only */ }
  else if (staged) row.append(act('−', 'Unstage', () => scmUnstage([file.path]), 'unstage'));
  else {
    row.append(act('↺', file.untracked ? 'Delete' : 'Discard changes', () => scmDiscard(file), 'discard'));
    row.append(act('+', 'Stage', () => scmStage([file.path]), 'stage'));
  }
  row.append(code);
  row.addEventListener('click', () => scmShowDiff(file, staged));
  return row;
}

// Which repository: the project's, or one an agent changed.
function scmRepoPicker(el) {
  if (SCM.repos.length < 2) return;
  const current = SCM.repos.find((r) => (SCM.root ? r.path === SCM.root : r.kind === 'project')) || SCM.repos[0];
  const b = h('button', 'scm-repo-btn');
  b.id = 'scm-repo';
  b.title = current.path;
  b.innerHTML = `${icon('folder', 13)}<span class="name"></span>${icon('chevronDown', 12)}`;
  b.querySelector('.name').textContent = current.name;
  b.addEventListener('click', () => { SCM.picking = !SCM.picking; scmRender(); });
  el.append(b);
  if (!SCM.picking) return;
  const list = h('div', 'scm-repos');
  const kinds = { project: 'this project', agent: 'agent changed', nested: 'inside' };
  for (const r of SCM.repos) {
    const item = h('button', 'scm-repo-item' + (r === current ? ' on' : ''));
    item.dataset.repo = r.path;
    item.title = r.path;
    item.append(h('span', 'scm-name', r.name), h('span', 'kind', kinds[r.kind] || ''));
    item.addEventListener('click', () => scmPickRepo(r));
    list.append(item);
  }
  el.append(list);
}

function scmModes(el) {
  const m = h('div', 'scm-modes');
  for (const [id, label] of [['changes', 'Not committed'], ['branch', 'This branch']]) {
    const b = h('button', 'scm-mode' + (SCM.mode === id ? ' on' : ''), label);
    b.dataset.mode = id;
    b.addEventListener('click', () => scmSetMode(id));
    m.append(b);
  }
  el.append(m);
  if (SCM.pr) {
    const pr = h('button', 'scm-pr-chip');
    pr.id = 'scm-this-pr';
    pr.title = SCM.pr.url;
    pr.append(h('span', 'scm-num', `#${SCM.pr.number}`), h('span', 'scm-name', SCM.pr.title), h('span', 'scm-dir', SCM.pr.state.toLowerCase()));
    pr.addEventListener('click', () => wb.toHost({ type: 'link', url: SCM.pr.url }));
    el.append(pr);
  }
}

function renderScmPanel(el) {
  scmRepoPicker(el);
  if (!SCM.loaded) { el.append(h('p', 'muted', 'Reading the repository…')); scmRefresh(); return; }
  if (!SCM.info?.git) { el.append(h('p', 'muted', 'git isn’t installed on this computer. Install it (on a Mac: xcode-select --install) to use Source Control.')); return; }
  if (!SCM.repo) {
    el.append(h('p', 'muted', 'This folder isn’t a git repository.'));
    if (!SCM.root) el.append(btn('Initialize Repository', 'primary', () => scmRun('Initializing…', () => scmMust(['init']))));
    return;
  }
  // Branch, pull, push.
  const head = h('div', 'scm-head');
  const branch = btn('', 'scm-branch-btn', () => { if (!SCM.root) scmBranchMenu(); }, SCM.root ? 'The current branch' : 'Switch or create a branch');
  branch.innerHTML = `${icon('branch', 13)}<span></span>`;
  branch.querySelector('span').textContent = SCM.branch || 'detached';
  head.append(branch, h('span', 'grow'));
  if (!SCM.root && (SCM.upstream || SCM.branch)) {
    const pull = btn(`Pull${SCM.behind ? ` ↓${SCM.behind}` : ''}`, 'scm-pull', scmPull, 'git pull --ff-only');
    const push = btn(`Push${SCM.ahead ? ` ↑${SCM.ahead}` : ''}`, 'scm-push', scmPush, SCM.upstream ? 'git push' : 'Publish this branch (git push --set-upstream origin)');
    head.append(pull, push);
  }
  el.append(head);
  scmModes(el);
  if (SCM.root) el.append(h('p', 'scm-readonly', 'Viewing only: this repository is outside the project.'));
  if (SCM.busy) el.append(h('p', 'muted scm-busy', SCM.busy));
  if (SCM.error) el.append(h('p', 'warn-box', SCM.error));
  if (SCM.mode === 'branch') {
    if (!SCM.base) el.append(h('p', 'muted', 'No main branch to compare with.'));
    else {
      const g = h('div', 'scm-group');
      g.append(h('div', 'scm-group-title', `Against ${SCM.base} (${SCM.branchFiles.length})`));
      g.append(...SCM.branchFiles.map((f) => scmRow(f, false)));
      el.append(g);
      if (!SCM.branchFiles.length) el.append(h('p', 'muted', 'This branch has no commits of its own.'));
    }
    return;
  }
  // Commit.
  const msg = h('textarea', 'scm-message');
  msg.id = 'scm-message';
  msg.rows = 3;
  msg.placeholder = SCM.staged.length ? 'Message (⌘↩ to commit the staged changes)' : 'Message (⌘↩ to commit all changes)';
  msg.value = SCM.message || '';
  msg.addEventListener('input', () => { SCM.message = msg.value; });
  msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); scmCommit(); } });
  const commit = btn(SCM.staged.length ? 'Commit' : 'Commit All', 'primary scm-commit', scmCommit);
  commit.disabled = !SCM.staged.length && !SCM.changes.length;
  if (!SCM.root) el.append(msg, commit);
  // Changes.
  const group = (title, files, staged) => {
    const g = h('div', 'scm-group');
    const t = h('div', 'scm-group-title', `${title} (${files.length})`);
    if (files.length && !SCM.root) {
      const all = h('button', 'icon-btn scm-act', staged ? '−' : '+');
      all.title = staged ? 'Unstage all' : 'Stage all';
      all.addEventListener('click', () => (staged ? scmUnstage(files.map((f) => f.path)) : scmStage(files.map((f) => f.path))));
      t.append(all);
    }
    g.append(t, ...files.map((f) => scmRow(f, staged)));
    return g;
  };
  if (SCM.staged.length) el.append(group('Staged', SCM.staged, true));
  el.append(group('Changes', SCM.changes, false));
  if (!SCM.staged.length && !SCM.changes.length) el.append(h('p', 'muted', 'No changes.'));
  // Pull requests (GitHub CLI).
  if (SCM.info.gh) {
    const g = h('div', 'scm-group scm-prs');
    const t = h('div', 'scm-group-title', 'Pull requests');
    const create = h('button', 'icon-btn scm-act', '+');
    create.title = 'Create a pull request for this branch (gh pr create --fill)';
    create.addEventListener('click', scmCreatePr);
    if (!SCM.root) t.append(create);
    g.append(t);
    if (SCM.prs === null) { g.append(h('p', 'muted', 'Loading…')); scmLoadPrs(); }
    else if (SCM.prs.error) g.append(h('p', 'muted', SCM.prs.error));
    else if (!SCM.prs.length) g.append(h('p', 'muted', 'No open pull requests.'));
    else for (const pr of SCM.prs) {
      const row = h('div', 'scm-row scm-pr');
      row.append(h('span', 'scm-num', `#${pr.number}`), h('span', 'scm-name', pr.title), h('span', 'grow'), h('span', 'scm-dir', pr.headRefName));
      row.title = pr.url;
      row.addEventListener('click', () => wb.toHost({ type: 'link', url: pr.url }));
      g.append(row);
    }
    el.append(g);
  }
  // Recent commits.
  if (SCM.log.length) {
    const g = h('div', 'scm-group');
    g.append(h('div', 'scm-group-title', 'Recent commits'));
    for (const c of SCM.log) {
      const row = h('div', 'scm-row scm-commit-row');
      row.append(h('span', 'scm-hash', c.hash), h('span', 'scm-name', c.subject), h('span', 'grow'), h('span', 'scm-dir', c.when));
      row.title = `${c.subject}\n${c.author}, ${c.when}`;
      g.append(row);
    }
    el.append(g);
  }
}

// The project's repository: read when a project opens and after files change.
bus.addEventListener('project', () => {
  Object.assign(SCM, { info: null, repo: false, loaded: false, staged: [], changes: [], log: [], prs: null, diff: null, message: '', root: '', repos: [], picking: false, mode: 'changes', pr: null, branchFiles: [] });
  scmRefresh();
  scmLoadRepos();
});
document.addEventListener('DOMContentLoaded', () => {
  wb.onFsChange(() => { if (S.project) scmSoon(); });
  $('#view-files').addEventListener('click', () => scmSetOpen(false));
  $('#view-scm').addEventListener('click', () => scmSetOpen(true));
  $('#scm-view').addEventListener('mousedown', () => { SCM.pressed = true; });
  window.addEventListener('mouseup', () => setTimeout(() => {
    if (!SCM.pressed) return;
    SCM.pressed = false;
    if (SCM.redraw) { SCM.redraw = false; scmRender(); }
  }, 0));
  // Another repository has no watcher here: looked at while it is on screen.
  setInterval(() => { if (SCM.open && SCM.root && !document.hidden && !SCM.busy) scmRefresh(); }, 5000);
});
