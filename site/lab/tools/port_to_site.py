import re, json
R='/Users/jackuait/meridian-browser/'; N='/private/tmp/claude-501/-Users-jackuait-meridian-browser/baf5fbaa-89ae-4eb0-a36e-07b93748b572/scratchpad/'
cur=open(R+'site/pages/index.html').read() if 'webui' not in '' else ''
import subprocess
cur=subprocess.run(['git','-C',R,'show','HEAD:site/pages/index.html'],capture_output=True,text=True).stdout
s=open(R+'site/lab/04-spaces.html').read()
dc=open(N+'variants/project/LiveHeroApart.dc.html').read()
def sub(a,b,n=1):
    global s
    assert s.count(a)==n,(s.count(a),a[:70]); s=s.replace(a,b)
def rsub(pat,b,flags=re.S):
    global s
    s,k=re.subn(pat,lambda m:b,s,count=1,flags=flags); assert k==1,pat[:60]

# ---------- head
head=cur[cur.index('<title>'):cur.index('<link rel="icon"')]
rsub(r'<meta name="robots" content="noindex">\n<title>.*?<link rel="icon" href="[^"]*">\n', head+'<link rel="icon" href="icon.png">\n')
sub('</style>\n</head>','</style>\n<script data-goatcounter="https://meridianbrowser.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>\n</head>')
sub('<body>','<body data-lang="en">')

# ---------- hero scene (from the canvas artboard)
hcss=dc[dc.index('.pl{position:absolute;'):dc.index('</style>')]
hcss=re.sub(r'\.(tile|cast|slab|fv)[^{]*\{[^}]*\}\n','',hcss)
hcss=re.sub(r'\.ph\{[^\n]*\n\.ph img\{[^\n]*\n\.ph::after\{[^\n]*\n','',hcss)
hcss=hcss.replace('.rw.in{','.rw.ind{').replace('.pl{position:absolute;box-sizing:border-box;','.pl{position:absolute;')
# scope every rule under .asm
out=[]
for line in hcss.split('\n'):
    if line.startswith('.') :
        sel,rest=line.split('{',1)
        line=','.join('.asm '+x for x in sel.split(','))+'{'+rest
    out.append(line)
hcss='\n'.join(out)
assert '.asm .pg{' in hcss and '.asm .sp{' in hcss and '.asm .sbase{' in hcss, hcss[:300]
hcss='''/* ---------- hero: the browser, assembled and taken apart ---------- */
/* Drawn in a 960 x 640 box that --k scales to the column. Every box from .scene down to a part keeps preserve-3d. */
.asm{position:relative;width:100%;aspect-ratio:3/2}
.asmf{position:absolute;left:0;top:0;width:960px;height:640px;transform-origin:0 0;transform:scale(var(--k,1))}
.asm .scene{position:absolute;left:500px;top:344px;width:0;height:0;transform:scale(.82) rotateX(36deg) rotateZ(31deg)}
.asm .scene,.asm .pl,.asm .sp,.asm .pg,.asm .sbase{transform-style:preserve-3d}
.asm .sbase{position:absolute;border-radius:20px}
.asm .sbase::after{content:"";position:absolute;inset:0;border-radius:inherit;background:#2a1a22;transform:translateZ(-12px)}
'''+hcss
sub('/* ---------- marquee ---------- */',hcss+'\n/* ---------- marquee ---------- */')

a=dc.index('<div class="pl bs"'); b=dc.index('  </div>\n  <button type="button"')
body=dc[a:b]
body=body.replace('class="rw in"','class="rw ind"').replace('class="ph sbase"','class="sbase"')
def bind(m):
    key=m.group(1)
    z,sc={'base':(0,1),'a':(14,1),'b':(14,.5437),'c':(14,.5437)}.get(key,(23,.2752))
    t='none' if key=='base' else f'translate3d(0px,0px,{z}px) scale({sc})'
    return f'transform: {t}" data-p="{key}'
body,k=re.subn(r'transform: \{\{(\w+)\}\}; transition: \{\{tr\}\}(?:; transition-delay: \{\{\w+\}\})?(?:; --e: \{\{e\}\})?(?:; pointer-events: none)?',bind,body); assert k==20,k
assert '{{' not in body, re.findall(r'\{\{\w+\}\}',body)
scene='<div class="asm" id="asm" role="img" aria-label="Drawing of the Meridian window: a sidebar with favorites, pinned tabs and Today tabs, and two pages side by side"><div class="asmf" aria-hidden="true"><div class="scene">\n    '+body.strip()+'\n  </div></div></div>\n      '
rsub(r'<div class="win" id="win">.*?</div></div></div>\n',scene)
sub('<div class="sky" aria-hidden="true">','<div class="win" id="win" aria-hidden="true"><div class="bob"><div class="sc3" id="scene"></div></div></div>\n<div class="sky" aria-hidden="true">')
sub('.win{width:100%}','.win{display:none}')
sub('.kin .win{position:fixed;','.kin .win{display:block;position:fixed;')

# ---------- text: both languages
M=json.load(open(N+'ru.json'))
M.update({'The browser':'Браузер','for people who':'для тех, кто','loved Arc':'любил Arc',
 'A space':'Спейс','for work.':'для работы.','for life.':'для жизни.',
 'Bring':'Заберите','your whole Arc':'весь свой Arc','with you.':'с собой.',
 'Today':'Today','tidies':'убирается','itself.':'сам.',
 'Side by side.':'Бок о бок.','Or just':'Или просто','a peek.':'Peek.',
 'Ask':'Спросите','about any page.':'о любой странице.','Or anything.':'Или о чём угодно.',
 'Private':'Приватно','by default.':'по умолчанию.','Quest':'Воп','ions':'росы',
 'Spaces':'Спейсы','Pinned tabs':'Закреплённые вкладки','Split view':'Сплит-вью','Command bar':'Командная строка','Free &amp; open source':'Бесплатно и с открытым кодом',
 'Or with Homebrew':'Или через Homebrew','Copy':'Копировать','Screenshot of Meridian':'Скриншот Meridian',
 'Hello':'Привет','Import':'Импорт','Split':'Сплит','AI':'ИИ','01 Hello':'01 Привет',
 'Still stuck? Ask on ':'Не получилось? Спросите в ',' or open an issue on ':' или создайте issue на '})
a=s.index('<header class="nav">'); b=s.index('<script>\n(() => {')
t=s[a:b]
t=t.replace('<span class="vh">Today</span>','<span class="vh">\x01</span>')
for e in sorted(M,key=len,reverse=True):
    if len(e)<2: continue
    t=t.replace('>'+e+'<',f'><span lang="en">{e}</span><span lang="ru">{M[e]}</span><')
t=t.replace('\x01','<span lang="en">Today</span><span lang="ru">Сегодня</span>')
t=t.replace('<span class="vh"><span lang="en">Private</span><span lang="ru">Приватно</span>','<span class="vh"><span lang="en">Private</span><span lang="ru">Приватность</span>')
s=s[:a]+t+s[b:]
sub('</a>.</p>\n      </div>\n      <div class="qa">','</a><span lang="en">.</span><span lang="ru">.</span></p>\n      </div>\n      <div class="qa">')
# the headline says itself to screen readers in the page's language (the script sets it)
sub(' aria-label="The browser for people who loved Arc"','')
sub(' aria-hidden="true"><span lang="en">The browser','><span lang="en">The browser'); sub(' aria-hidden="true"><span lang="en">for people who','><span lang="en">for people who'); sub(' aria-hidden="true"><span lang="en">loved Arc','><span lang="en">loved Arc')

# nav: language switch (the build turns it into a link)
sub('<a class="x" href="https://discord.gg/kuQRHfG39r">Discord</a>\n  </nav>','<a class="x" href="https://discord.gg/kuQRHfG39r">Discord</a>\n    <div class="lang" role="group" aria-label="Language"></div>\n  </nav>')
# hero: version label slot and the send box
rsub(r'<p class="sub"><a href="#install">.*?</p>','<p class="sub" id="cta-sub"></p>\n        <div class="sendbox" id="sendbox" hidden>\n          <p id="send-note"></p>\n          <div class="row"><input id="send-url" readonly aria-label="Link"><button id="send-copy" type="button"></button></div>\n          <a id="send-email" href="#"></a>\n        </div>')
sub('.sub a{text-underline-offset:3px}','.sub a{text-underline-offset:3px}\n.sendbox{margin-top:18px;max-width:420px;display:grid;gap:8px}\n.sendbox[hidden]{display:none}\n.sendbox p{font-size:14.5px;font-weight:600}\n.sendbox .row{display:flex;gap:8px}\n.sendbox input{flex:1;min-width:0;font:500 14px/1.2 "DM Mono",monospace;padding:11px 12px;border-radius:12px;border:2px solid var(--ink);background:none;color:inherit}\n.sendbox button,.sendbox a{font:600 14px/1.2 "Instrument Sans",sans-serif;color:inherit;background:none;border:2px solid var(--ink);border-radius:12px;padding:11px 14px;text-align:center;text-decoration:none;cursor:pointer}')
sub('<img src="img/app-split.jpg"','<img src="app-split.jpg"')

# questions: numbers come from a counter, so the heading is only the question
s,k=re.subn(r'<h3><span>\d\d</span>','<h3>',s); assert k==6
sub('.qa h3 span{font:500 12.5px/1 "DM Mono",monospace;opacity:.75}','.qa{counter-reset:q}\n.qa h3::before{counter-increment:q;content:counter(q,decimal-leading-zero);font:500 12.5px/1 "DM Mono",monospace;opacity:.75}')
# footer from the live page
foot=cur[cur.index('<div class="mentions">'):cur.index('</footer>')]
rsub(r'<footer>.*?</footer>','<footer>\n      '+foot.strip()+'\n    </footer>')
sub('footer a{text-underline-offset:3px}','footer a{text-underline-offset:3px}\n.mentions{display:grid;gap:8px}\n.mentions .label{font:500 12px/1 "DM Mono",monospace;letter-spacing:.08em;text-transform:uppercase;opacity:.75;margin-right:10px}')

# ---------- script
a=s.index("  // ---- download: same OS detection as the main page"); b=s.index("  // ---- poster type: every line is sized to fill its column")
DL=r'''  // ---- language (the build sets <html lang>)
  const lang = root.lang === 'ru' ? 'ru' : 'en';
  const T = {
    en: { mac: 'Download for Mac', win: 'Download for Windows', linux: "Linux isn't out yet", other: 'Download Meridian', free: 'Free · ', macSub: 'Apple silicon (M1 and newer)', winSub: 'Windows 10 and 11', linuxSub: 'Meridian is for macOS and Windows', otherOs: 'Other systems', copy: 'Copy', copied: 'Copied!', send: 'Send to my computer', sendSub: 'Meridian is for Mac and Windows', sendNote: 'Open this link on your Mac or Windows computer:', sendEmail: 'Email it to me', sendSubject: 'Meridian browser' },
    ru: { mac: 'Скачать для Mac', win: 'Скачать для Windows', linux: 'Для Linux пока нет', other: 'Скачать Meridian', free: 'Бесплатно · ', macSub: 'Apple silicon (M1 и новее)', winSub: 'Windows 10 и 11', linuxSub: 'Meridian для macOS и Windows', otherOs: 'Другие системы', copy: 'Копировать', copied: 'Скопировано!', send: 'Отправить себе на компьютер', sendSub: 'Meridian для Mac и Windows', sendNote: 'Откройте эту ссылку на компьютере с Mac или Windows:', sendEmail: 'Отправить себе на почту', sendSubject: 'Браузер Meridian' },
  }[lang];

  // ---- download
  const REPO = 'Undermove/meridian-browser';
  const RELEASES = `https://github.com/${REPO}/releases/latest`;
  // Each release also carries version-less copies (Meridian-win.exe…), so these links always start a download.
  const DOWNLOAD = `${RELEASES}/download/Meridian-`;
  const ua = navigator.userAgent;
  const plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const os = /Win/i.test(plat) || /Windows/.test(ua) ? 'win'
    : /Mac/i.test(plat) || /Macintosh/.test(ua) ? 'mac'
    : /Linux|X11/i.test(plat + ua) && !/Android/.test(ua) ? 'linux' : 'other';
  const mobile = /iPhone|iPad|Android/.test(ua) || (os === 'mac' && navigator.maxTouchPoints > 1);
  const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>';
  const SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5L20 4"/></svg>';
  const key = mobile ? 'send' : os;
  const tabs = $$('[role=tab]');
  function showTab(which) {
    tabs.forEach((b) => {
      const on = b.dataset.os === which;
      b.setAttribute('aria-selected', on);
      b.tabIndex = on ? 0 : -1;
      $('#p-' + b.dataset.os).hidden = !on;
    });
    schedule(true);
  }
  tabs.forEach((b, i) => {
    b.addEventListener('click', () => showTab(b.dataset.os));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const n = tabs[(i + d + tabs.length) % tabs.length];
      showTab(n.dataset.os); n.focus();
    });
  });
  const sendUrl = () => location.origin + (lang === 'ru' ? '/ru/' : '/') + '?ref=send';
  const gc = (path) => { try { window.goatcounter && window.goatcounter.count({ path, title: path, event: true }); } catch {} };
  // On a phone there's nothing to install: send the link to a computer instead.
  async function sendToComputer(e) {
    e.preventDefault();
    if (navigator.share) {
      try { await navigator.share({ title: 'Meridian', text: T.sendSubject, url: sendUrl() }); gc('send-shared'); return; } catch {}
    }
    $('#sendbox').hidden = false;
    $('#sendbox').scrollIntoView({ behavior: 'smooth', block: 'center' });
    gc('send-shown');
  }
  let version = '';
  const paintSub = () => { $('#cta-sub').innerHTML = `${version ? 'v' + version + ' · ' : ''}<a href="#install">${T.otherOs}</a> · <a href="${RELEASES}">GitHub</a>`; };
  $$('[data-cta]').forEach((a) => {
    $('.ci', a).innerHTML = key === 'send' ? SEND : ARROW;
    $('.cl', a).textContent = T[key];
    $('.cs', a).textContent = key === 'other' ? '' : T.free + (T[key + 'Sub'] || '');
    a.href = key === 'win' ? DOWNLOAD + 'win.exe' : key === 'mac' ? DOWNLOAD + 'mac-arm64.dmg' : '#install';
    if (key === 'send') a.addEventListener('click', sendToComputer);
    else a.addEventListener('click', () => { if (key === 'win' || key === 'mac') setTimeout(() => $('#install').scrollIntoView(), 400); });
  });
  $('#send-note').textContent = T.sendNote; $('#send-copy').textContent = T.copy; $('#send-email').textContent = T.sendEmail;
  $('#send-url').value = sendUrl();
  $('#send-email').href = 'mailto:?subject=' + encodeURIComponent(T.sendSubject) + '&body=' + encodeURIComponent(sendUrl());
  $('#send-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(sendUrl()); } catch { $('#send-url').select(); } $('#send-copy').textContent = T.copied; gc('send-copied'); });
  $('#send-email').addEventListener('click', () => gc('send-email'));
  paintSub();
  // the version label from the latest release (the links work without it)
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => { if (rel) { version = String(rel.tag_name || '').replace(/^v/, ''); paintSub(); } })
    .catch(() => {});
  $('#copy').addEventListener('click', async () => {
    const code = $('#brew');
    try { await navigator.clipboard.writeText(code.textContent.trim()); }
    catch { const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    $('#copy').textContent = T.copied;
    setTimeout(() => { $('#copy').textContent = T.copy; }, 1800);
  });

  // ---- hero: the browser drops into place piece by piece, then the pointer takes it apart
  const asm = $('#asm'), asmScene = $('.scene', asm), parts = $$('[data-p]', asm);
  const still = matchMedia('(prefers-reduced-motion:reduce)').matches;
  // sidebar parts, top to bottom: how high each lifts when the window is fully apart
  const SUP = [300, 285, 262, 272, 262, 272, 236, 223, 210, 197, 184, 162, 150, 138, 126, 104];
  // part -> [resting height, height when apart, scale, when it drops in (s)]
  const spec = (k) => k === 'base' ? [0, 0, 1, 0] : k === 'a' ? [14, 80, 1, .28] : k === 'b' ? [14, 170, .5437, .54] : k === 'c' ? [14, 260, .5437, .8]
    : [23, SUP[+k.slice(1)], .2752, 1.1 + k.slice(1) * .05];
  const ABOVE = 2400; // far enough up that a waiting piece is off the top of the page
  // Glide down, touch, lift a little and settle. Every stop is at or below 1, so a piece never goes under the plate.
  const DROP = 'transform .85s linear(0, .42 10%, .7 20%, .88 31%, .97 41%, 1 50%, .984 61%, .978 66%, .984 71%, 1 82%, .996 89%, 1)';
  let asmReady = still, asmRaf = 0, asmAt = null;
  function poseAsm(e, turn, tr, drop) {
    parts.forEach((el) => {
      const [flat, up, sc, at] = spec(el.dataset.p);
      el.style.transition = tr;
      el.style.transitionDelay = drop ? at + 's' : '0s';
      el.style.transform = `translate3d(0px,0px,${(e < 0 ? ABOVE : flat + (up - flat) * e).toFixed(1)}px) scale(${sc})`;
      if (el.classList.contains('pg')) el.style.setProperty('--e', Math.max(0, e).toFixed(3));
    });
    asmScene.style.transition = tr === DROP ? 'none' : tr;
    asmScene.style.transform = `scale(.82) rotateX(36deg) rotateZ(${(31 + turn * 12).toFixed(1)}deg)`;
  }
  if (!still) {
    poseAsm(-1, 0, 'none', false);
    asm.getBoundingClientRect(); // the start pose has to be drawn before the drop begins
    poseAsm(0, 0, DROP, true);
    setTimeout(() => { asmReady = true; }, 2800);
  }
  // The pointer opens the window by coming close to its middle and turns it by going left or right.
  // Both are zero all along the drawing's edge, so coming in from any side starts from the assembled window.
  function trackAsm() {
    asmRaf = 0;
    if (!asmReady) return;
    const b = asm.getBoundingClientRect();
    const px = asmAt ? (asmAt[0] - b.left) / b.width * 2 - 1 : 2, py = asmAt ? (asmAt[1] - b.top) / b.height * 2 - 1 : 2;
    const over = Math.abs(px) <= 1 && Math.abs(py) <= 1;
    const e = over ? .5 * clamp((1 - Math.hypot(px, py)) / .7) : 0;
    const turn = over ? px * clamp((1 - Math.max(Math.abs(px), Math.abs(py))) / .25) : 0;
    poseAsm(e, turn, over ? 'transform .16s ease-out' : 'transform .5s cubic-bezier(.2,.8,.3,1)', false);
  }
  if (!still) {
    addEventListener('pointermove', (ev) => { if (ev.pointerType === 'mouse') { asmAt = [ev.clientX, ev.clientY]; if (!asmRaf) asmRaf = requestAnimationFrame(trackAsm); } }, { passive: true });
    document.addEventListener('pointerleave', () => { asmAt = null; if (!asmRaf) asmRaf = requestAnimationFrame(trackAsm); });
  }

'''
s=s[:a]+DL+s[b:]
sub("  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);\n","")
sub("  const $$ = (s, r = document) => [...r.querySelectorAll(s)];\n  const root = document.documentElement;\n","  const $$ = (s, r = document) => [...r.querySelectorAll(s)];\n  const root = document.documentElement;\n  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);\n")
# letters: say the headline once, in its own words
sub("  $$('.l[data-k]').forEach((l) => {\n","  $$('.fit').filter((h) => $('.l[data-k]', h)).forEach((h) => {\n    h.setAttribute('aria-label', [...h.children].map((l) => l.textContent.trim()).join(' '));\n    [...h.children].forEach((l) => l.setAttribute('aria-hidden', 'true'));\n  });\n  $$('.l[data-k]').forEach((l) => {\n")
# the gliding stack belongs to the feature spaces only: it stays out of the hero
sub("[26, 4, 0, 0, 0, 1, 1], [-22, 2, 0, 0, 0, 1, 1]","[-22, 40, 0, 0, 0, .8, 0], [-22, 2, 0, 0, 0, 1, 1]")
rsub(r"      if \(kin\) \{\n        document\.body\.appendChild\(win\);\n      \} else \{\n        ins\[0\]\.appendChild\(win\);\n","      if (!kin) {\n")
sub("  const sizeScenes = () => [live, ...stills].forEach((sc) => { sc.k = sc.mount.clientWidth / K; sc.mount.style.setProperty('--k', sc.k); });","  const sizeScenes = () => {\n    [live, ...stills].forEach((sc) => { sc.k = sc.mount.clientWidth / K; sc.mount.style.setProperty('--k', sc.k); });\n    asm.style.setProperty('--k', asm.clientWidth / 960);\n  };")
sub("    dotname.textContent = String(a + 1).padStart(2, '0') + ' ' + dots[a].textContent;","    dotname.textContent = String(a + 1).padStart(2, '0') + ' ' + dots[a].textContent.trim();")
sub('  .hero .in{grid-template-columns:minmax(0,54fr) minmax(0,40fr);gap:5vw}','  .hero .in{grid-template-columns:minmax(0,54fr) minmax(0,40fr);gap:5vw}\n  /* the drawing is wider than its column: it runs under the gap and out to the page edge */\n  .asm{width:132%;margin-left:-14%}')
# auto margins would shrink this grid item to its text: the Russian headline is shorter
sub('.kin .hero .in{padding-top:70px}','.kin .hero .in{padding-top:70px;width:100%}')
sub('<a href="https://github.com/Undermove/meridian-browser">GitHub</a>\n    <a class="x"','<a class="x" href="https://github.com/Undermove/meridian-browser">GitHub</a>\n    <a class="x"')
open(R+'site/pages/index.html','w').write(s)
print('written',len(s))
