/* Meridian "Remix" spike: turns dodopizza.ru menu into a mobile-app prototype.
 * Injected into the page (same origin). Uses the site's own GET menu endpoint.
 * Local cart only. In-page firewall: any non-GET fetch/XHR to the site's origin is blocked + logged. */
(() => {
  if (window.__remix) return;
  const R = (window.__remix = { blocked: [], ready: false, error: null, source: null });

  // ---------- 1. In-page request firewall ----------
  const isSite = (u) => { try { return /dodo/i.test(new URL(u, location.href).hostname); } catch { return false; } };
  const safeM = (m) => ['GET', 'HEAD', 'OPTIONS'].includes(String(m || 'GET').toUpperCase());
  const ofetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init && init.method) || (input && input.method) || 'GET';
    if (!safeM(method) && isSite(url)) {
      R.blocked.push(method + ' ' + String(url).split('?')[0]);
      return Promise.reject(new TypeError('Remix firewall: blocked ' + method));
    }
    return ofetch(input, init);
  };
  const oopen = XMLHttpRequest.prototype.open, osend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__rm = [m, u]; return oopen.call(this, m, u, ...rest); };
  XMLHttpRequest.prototype.send = function (b) {
    const [m, u] = this.__rm || [];
    if (!safeM(m) && isSite(u)) { R.blocked.push(m + ' ' + String(u).split('?')[0]); this.abort(); return; }
    return osend.call(this, b);
  };

  // ---------- 2. Data ----------
  const rub = (n) => Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₽';
  const img = (images, tag = 'main', px = 584) => {
    const im = (images || []).find((i) => i.tags.includes(tag)) || (images || [])[0];
    if (!im) return '';
    const m = im.imageMeta;
    const sizes = m.size.values.slice().sort((a, b) => a.width - b.width);
    const s = sizes.find((v) => v.width >= px) || sizes[sizes.length - 1];
    return m.baseUrl + m.size.template.replace('{width}', s.width).replace('{height}', s.height) + m.id + '.webp';
  };
  // The site's API gateway routes by headers (x-backend etc.); without them it answers 404.
  // These are plain routing headers the site sends itself, no tokens. Cookies go automatically.
  const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const cookieLocality = (document.cookie.match(/(?:^|;\s*)locality=([^;]+)/) || [])[1];
  const LOCALITY = (cookieLocality && (decodeURIComponent(cookieLocality).match(GUID) || [])[0]) || '0000002b-0000-0000-0000-000000000000';
  const API_HEADERS = { accept: 'application/json', client: 'Site', countrycode: 'RU', languagecode: 'ru-RU', localityid: LOCALITY, 'x-backend': 'mapi-gateway', 'x-requested-with': 'XMLHttpRequest' };
  function menuUrl() {
    const e = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('/api/v5/menu/'));
    if (e) return e;
    return '/api/v5/menu/delivery/countries/643/localities/' + LOCALITY + '?cultures=ru-RU&subcategoriesInMenu=false';
  }
  function normalize(d) {
    const byRef = {};
    d.items.forEach((it, i) => (byRef['#/items/' + i] = it));
    return d.structure
      .sort((a, b) => a.index - b.index)
      .map((s) => ({
        code: s.code,
        title: s.title,
        items: s.items
          .filter((e) => e.menuItem)
          .map((e) => ({ it: byRef[e.menuItem.$ref] || d.items.find((x) => x.$id === e.menuItem.$ref), hero: (e.additionalData || []).some((a) => a.value === 'hero') }))
          .filter((x) => x.it && x.it.type !== 'ProductFromHalves')
          .map(({ it, hero }) => {
            const seen = new Set();
            const vars = (it.variations || [])
              .map((v) => ({ ...v.product, isDefault: v.isDefault }))
              .filter((p) => { const k = p.sizeName + p.size; if (seen.has(k)) return false; seen.add(k); return true; })
              .sort((a, b) => a.price - b.price);
            const price = vars.length ? vars[0].price : it.price || 0;
            const tag = (it.additionalData || []).find((a) => a.key === 'MarketingTag');
            return { id: it.id, name: it.name, desc: it.description || '', type: it.type, vars, price, from: vars.length > 1, img: img(it.images), imgBig: img(it.images, 'main', 760), hero, isNew: tag && tag.value === 'new', pizza: vars[0] && vars[0].traits && vars[0].traits.pizza };
          }),
      }))
      .filter((s) => s.items.length);
  }

  // ---------- 3. UI ----------
  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  .app{--acc:#FF6A1A;--acc2:#FF8A3D;--ink:#1E1915;--mute:#8A817A;--bg:#FBF7F3;--card:#fff;--line:#EFE8E1;
    position:absolute;inset:0;background:var(--bg);color:var(--ink);font:15px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",system-ui,sans-serif;overflow:hidden}
  .stage{position:fixed;inset:0;background:#FBF7F3}
  .side{display:none}
  /* Wider than a phone (a desktop tab): the app sits in a phone frame. */
  @media (min-width:600px){
    .stage{display:flex;align-items:center;justify-content:center;gap:48px;background:radial-gradient(90% 90% at 30% 20%,#FFE3CF 0%,#F4EEE8 55%,#ECE6E0 100%)}
    .app{position:relative;inset:auto;width:390px;height:min(844px,calc(100vh - 48px));border-radius:52px;box-shadow:0 0 0 11px #17130F,0 0 0 13px #3A332D,0 40px 80px -20px rgba(40,20,0,.45);transform:translateZ(0)}
    .app::before{content:"";position:absolute;top:11px;left:50%;width:120px;height:34px;margin-left:-60px;border-radius:20px;background:#17130F;z-index:60}
    .side{display:block;max-width:260px;font:14px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#5C534C}
    .side b{display:block;font-size:22px;letter-spacing:-.02em;color:#1E1915;margin-bottom:8px}
    .side .chip{display:inline-block;margin-top:12px;padding:6px 10px;border-radius:999px;background:#fff;color:#D9520B;font-weight:700;font-size:12px}
  }
  @media (min-width:600px) and (max-width:820px){.side{display:none}}
  @media (min-width:600px){.tabs.stuck{padding-top:54px}}
  .feed{position:absolute;inset:0;overflow-y:auto;overscroll-behavior:contain;padding-bottom:150px;scroll-behavior:smooth}
  .feed::-webkit-scrollbar{display:none}
  header.top{padding:54px 20px 6px;display:flex;align-items:center;justify-content:space-between}
  .loc small{display:block;color:var(--mute);font-size:12px;letter-spacing:.02em}
  .loc b{font-size:20px;letter-spacing:-.02em;display:flex;align-items:center;gap:6px}
  .loc b i{width:8px;height:8px;border-right:2px solid var(--ink);border-bottom:2px solid var(--ink);transform:rotate(45deg) translate(-2px,-2px);display:inline-block}
  .mode{display:flex;background:#F1EBE5;border-radius:999px;padding:3px;font-size:13px;font-weight:600}
  .mode span{padding:7px 12px;border-radius:999px;color:var(--mute)}
  .mode span.on{background:#fff;color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.08)}
  h1.hello{font-size:30px;line-height:1.05;letter-spacing:-.035em;padding:14px 20px 14px;font-weight:800}
  h1.hello em{font-style:normal;color:var(--acc)}
  .hero{display:flex;gap:12px;overflow-x:auto;padding:4px 20px 18px;scroll-snap-type:x mandatory;scroll-padding-left:20px}
  .hero::-webkit-scrollbar{display:none}
  .hcard{flex:0 0 78%;scroll-snap-align:start;border-radius:26px;padding:18px;color:#fff;position:relative;overflow:hidden;min-height:176px;
    background:radial-gradient(120% 140% at 100% 0%,#FFB067 0%,var(--acc) 45%,#E2470A 100%);box-shadow:0 12px 28px -12px rgba(226,71,10,.55);transition:transform .25s cubic-bezier(.2,.8,.2,1)}
  .hcard:nth-child(3n+2){background:radial-gradient(120% 140% at 100% 0%,#7B6CFF 0%,#4B3BD6 55%,#2C1F9A 100%);box-shadow:0 12px 28px -12px rgba(60,40,200,.5)}
  .hcard:nth-child(3n+3){background:radial-gradient(120% 140% at 100% 0%,#3DDC97 0%,#14A86B 55%,#0B7A4C 100%);box-shadow:0 12px 28px -12px rgba(16,140,90,.5)}
  .hcard:active{transform:scale(.97)}
  .hcard .badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:rgba(255,255,255,.22);padding:4px 8px;border-radius:999px}
  .hcard h3{font-size:21px;letter-spacing:-.02em;margin-top:10px;max-width:58%;line-height:1.1}
  .hcard p{margin-top:6px;font-weight:700;font-size:15px}
  .hcard img{position:absolute;right:-26px;bottom:-30px;width:190px;height:190px;object-fit:contain;filter:drop-shadow(0 10px 18px rgba(0,0,0,.25));transition:transform .6s cubic-bezier(.2,.8,.2,1)}
  .hcard:hover img{transform:rotate(18deg)}
  .tabs{position:sticky;top:0;z-index:5;background:rgba(251,247,243,.86);backdrop-filter:saturate(1.6) blur(16px);-webkit-backdrop-filter:saturate(1.6) blur(16px);
    display:flex;gap:6px;overflow-x:auto;padding:10px 16px;border-bottom:1px solid transparent;transition:border-color .2s}
  .tabs.stuck{border-bottom-color:var(--line)}
  .tabs::-webkit-scrollbar{display:none}
  .tab{flex:none;border:0;background:transparent;font:600 14px/1 inherit;font-family:inherit;color:var(--mute);padding:10px 14px;border-radius:999px;transition:all .25s cubic-bezier(.2,.8,.2,1)}
  .tab.on{background:var(--ink);color:#fff}
  section.cat{padding:8px 16px 4px}
  section.cat h2{font-size:24px;letter-spacing:-.03em;padding:18px 4px 10px;font-weight:800}
  .row{display:flex;gap:14px;align-items:center;background:var(--card);border-radius:22px;padding:12px;margin-bottom:10px;box-shadow:0 1px 0 rgba(30,25,21,.04),0 6px 16px -10px rgba(30,25,21,.12);transition:transform .18s ease,box-shadow .18s ease;cursor:pointer}
  .row:active{transform:scale(.975)}
  .row .pic{flex:none;width:112px;height:112px;border-radius:18px;background:#FFF1E7;display:grid;place-items:center;overflow:hidden;position:relative}
  .row .pic img{width:104%;height:104%;object-fit:cover;transition:transform .4s cubic-bezier(.2,.8,.2,1)}
  .row:active .pic img{transform:scale(1.06) rotate(-6deg)}
  .row .new{position:absolute;top:6px;left:6px;background:var(--acc);color:#fff;font-size:10px;font-weight:800;padding:3px 6px;border-radius:6px;letter-spacing:.04em}
  .row .tx{flex:1;min-width:0}
  .row h4{font-size:16px;letter-spacing:-.01em;line-height:1.2}
  .row p{color:var(--mute);font-size:13px;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .row .buy{margin-top:10px;display:inline-flex;align-items:center;gap:6px;background:#FFF1E7;color:#D9520B;font-weight:700;font-size:14px;padding:8px 12px;border-radius:999px;border:0;font-family:inherit;transition:transform .15s}
  .row .buy:active{transform:scale(.92)}
  .row .buy b{font-size:18px;line-height:0;margin-left:2px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .tile{background:var(--card);border-radius:22px;padding:10px 10px 12px;box-shadow:0 6px 16px -10px rgba(30,25,21,.12);cursor:pointer;transition:transform .18s}
  .tile:active{transform:scale(.96)}
  .tile .pic{aspect-ratio:1;border-radius:16px;background:#F7F1EB;overflow:hidden}
  .tile .pic img{width:100%;height:100%;object-fit:cover}
  .tile h4{font-size:14px;margin:8px 2px 6px;line-height:1.2;height:34px;overflow:hidden}
  .tile .buy{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:14px;padding:0 2px}
  .tile .buy i{width:30px;height:30px;border-radius:50%;background:var(--acc);color:#fff;display:grid;place-items:center;font-style:normal;font-size:20px;line-height:1}
  /* cart pill + tabbar */
  .pill{position:absolute;left:16px;right:16px;bottom:96px;height:56px;border-radius:20px;background:var(--acc);color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 18px;font-weight:700;
    box-shadow:0 14px 30px -10px rgba(255,106,26,.7);transform:translateY(160%);transition:transform .45s cubic-bezier(.2,1.3,.3,1);z-index:8;cursor:pointer}
  .pill.show{transform:none}
  .pill .n{background:rgba(255,255,255,.25);border-radius:999px;padding:4px 10px;font-size:13px}
  .bar{position:absolute;left:0;right:0;bottom:0;height:84px;padding:8px 18px 26px;display:flex;justify-content:space-around;background:rgba(255,255,255,.88);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-top:1px solid var(--line);z-index:9}
  .bar button{border:0;background:none;font:600 10.5px inherit;font-family:inherit;color:var(--mute);display:flex;flex-direction:column;align-items:center;gap:3px;width:64px;position:relative}
  .bar button.on{color:var(--acc)}
  .bar svg{width:26px;height:26px}
  .bar .cnt{position:absolute;top:-4px;right:12px;min-width:18px;height:18px;border-radius:9px;background:var(--acc);color:#fff;font-size:11px;font-weight:800;display:none;place-items:center;padding:0 5px;border:2px solid #fff}
  .bar .cnt.has{display:grid}
  .bump{animation:bump .5s cubic-bezier(.2,1.6,.4,1)}
  @keyframes bump{0%{transform:scale(1)}35%{transform:scale(1.45)}100%{transform:scale(1)}}
  /* sheets */
  .scrim{position:absolute;inset:0;background:rgba(20,14,10,.42);opacity:0;pointer-events:none;transition:opacity .3s;z-index:20}
  .scrim.on{opacity:1;pointer-events:auto}
  .sheet{position:absolute;left:0;right:0;bottom:0;background:#fff;border-radius:30px 30px 0 0;z-index:21;transform:translateY(105%);transition:transform .5s cubic-bezier(.2,.9,.2,1);max-height:92%;display:flex;flex-direction:column;box-shadow:0 -10px 40px rgba(0,0,0,.15)}
  .sheet.on{transform:none}
  .grab{width:40px;height:5px;border-radius:3px;background:#E2DAD3;margin:9px auto 0;flex:none}
  .x{position:absolute;right:16px;top:16px;width:34px;height:34px;border-radius:50%;background:#F3EEE9;border:0;font-size:18px;color:var(--ink);z-index:2}
  .pbody{overflow-y:auto;padding:6px 22px 0}
  .pimg{width:100%;aspect-ratio:1;display:grid;place-items:center;background:radial-gradient(closest-side,#FFF1E7,#fff 100%);border-radius:24px;margin-top:4px}
  .pimg img{width:88%;transition:transform .55s cubic-bezier(.2,1.2,.3,1)}
  .sheet.on .pimg img{animation:spin .8s cubic-bezier(.2,.9,.2,1)}
  @keyframes spin{from{transform:rotate(-40deg) scale(.7);opacity:0}to{opacity:1}}
  .pbody h3{font-size:26px;letter-spacing:-.03em;margin-top:10px}
  .meta{color:var(--mute);font-size:13px;margin-top:4px}
  .pbody p.d{margin-top:8px;font-size:14px;color:#4D4640}
  .seg{display:flex;background:#F3EEE9;border-radius:14px;padding:3px;margin-top:16px;position:relative}
  .seg button{flex:1;border:0;background:none;font:600 13px inherit;font-family:inherit;padding:9px 0;border-radius:11px;color:var(--mute);position:relative;z-index:1;transition:color .2s}
  .seg button.on{color:var(--ink)}
  .seg .thumb{position:absolute;top:3px;bottom:3px;border-radius:11px;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.08);transition:left .35s cubic-bezier(.2,1,.3,1),width .35s}
  .nut{display:flex;gap:8px;margin-top:14px}
  .nut div{flex:1;background:#FAF6F2;border-radius:14px;padding:8px 10px;font-size:11px;color:var(--mute)}
  .nut b{display:block;font-size:15px;color:var(--ink)}
  .cta{flex:none;padding:14px 22px 34px;background:linear-gradient(transparent,#fff 30%)}
  .cta button{width:100%;height:56px;border-radius:18px;border:0;background:var(--acc);color:#fff;font:700 17px inherit;font-family:inherit;box-shadow:0 12px 24px -10px rgba(255,106,26,.75);transition:transform .15s}
  .cta button:active{transform:scale(.97)}
  .cta button.off{background:#E9E2DB;color:#8A817A;box-shadow:none}
  .cbody{overflow-y:auto;padding:10px 22px 0}
  .cbody h3{font-size:26px;letter-spacing:-.03em;margin:8px 0 10px}
  .ci{display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line);animation:in .35s cubic-bezier(.2,1,.3,1) both}
  @keyframes in{from{opacity:0;transform:translateY(10px)}}
  .ci img{width:64px;height:64px;border-radius:14px;object-fit:cover;background:#FFF1E7}
  .ci .t{flex:1;min-width:0}.ci .t b{display:block;font-size:15px}.ci .t small{color:var(--mute);font-size:12px}
  .ci .pr{font-weight:700;font-size:15px;margin-top:4px;display:block}
  .step{display:flex;align-items:center;background:#F3EEE9;border-radius:999px}
  .step button{width:32px;height:32px;border:0;background:none;font-size:18px;color:var(--ink)}
  .step span{min-width:18px;text-align:center;font-weight:700;font-size:14px}
  .sum{display:flex;justify-content:space-between;padding:14px 0 4px;font-size:15px;color:var(--mute)}
  .sum.tot{color:var(--ink);font-weight:800;font-size:20px}
  .note{font-size:12px;color:var(--mute);text-align:center;margin-top:8px}
  .fly{position:absolute;width:64px;height:64px;border-radius:50%;z-index:40;pointer-events:none;object-fit:cover;box-shadow:0 8px 20px rgba(0,0,0,.25);transition:transform .7s cubic-bezier(.5,-0.3,.7,1),opacity .7s}
  .toast{position:absolute;left:50%;top:58px;transform:translate(-50%,-140%);background:var(--ink);color:#fff;padding:10px 16px;border-radius:14px;font-size:13px;font-weight:600;z-index:50;transition:transform .4s cubic-bezier(.2,1.3,.3,1);white-space:nowrap}
  .toast.on{transform:translate(-50%,0)}
  .skel{padding:120px 20px;color:var(--mute)}
  `;
  const ICON = {
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3a9 9 0 0 1 9 9H3a9 9 0 0 1 9-9Z"/><path d="M3 12l9 9 9-9"/><circle cx="9" cy="8.5" r=".8" fill="currentColor"/><circle cx="14.5" cy="9.5" r=".8" fill="currentColor"/></svg>',
    promo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 12V7a3 3 0 0 1 3-3h5l8 8-8 8-8-8Z"/><circle cx="8.5" cy="8.5" r="1.3"/></svg>',
    cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 7Z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/></svg>',
    me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  };

  const host = document.createElement('div');
  host.id = 'remix-host';
  const hide = document.createElement('style');
  hide.textContent = 'html{overflow:hidden!important} html>body{display:none!important} #remix-host{position:fixed;inset:0;z-index:2147483647;display:block!important}';
  // Mounted on <html>, beside <body>: the site's own app re-renders <body> while it hydrates
  // (a Boost runs at DOMContentLoaded, before that). If anything still takes us out, go back in.
  const mount = () => {
    if (!hide.isConnected) document.documentElement.appendChild(hide);
    if (!host.isConnected) document.documentElement.appendChild(host);
  };
  mount();
  new MutationObserver(mount).observe(document.documentElement, { childList: true });
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style><div class="stage"><div class="app"><div class="feed"><div class="skel">Собираем меню…</div></div></div><div class="side"><b>Remix: Додо как приложение</b>Живое меню, цены и фото с этого сайта, корзина только у вас в браузере. Заказать отсюда нельзя.<br><span class="chip">Прототип · Meridian Remix</span></div></div>`;
  const app = root.querySelector('.app'), feed = root.querySelector('.feed');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cart = new Map(); // key -> {p, v, qty}
  let byId = {};

  function toast(t) {
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = t; app.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    setTimeout(() => { el.classList.remove('on'); setTimeout(() => el.remove(), 400); }, 1800);
  }

  function render(sections) {
    R.sections = sections;
    sections.forEach((s) => s.items.forEach((p) => (byId[p.id] = p)));
    const heroes = sections.flatMap((s) => s.items.filter((p) => p.isNew)).slice(0, 6);
    const rowCats = new Set(['Пиццы', 'Комбо', 'Римские пиццы', 'Закуски', 'Обеды', 'Завтраки']);
    const hour = new Date().getHours();
    feed.innerHTML = `
      <header class="top"><div class="loc"><small>Доставка · 30–40 мин</small><b>Москва <i></i></b></div>
        <div class="mode"><span class="on">Доставка</span><span>Самовывоз</span></div></header>
      <h1 class="hello">${hour < 12 ? 'Доброе утро' : hour < 18 ? 'Время обеда' : 'Вечер пиццы'}.<br><em>Что закажем?</em></h1>
      <div class="hero">${heroes.map((p) => `<div class="hcard" data-id="${p.id}"><span class="badge">Новинка</span><h3>${esc(p.name)}</h3><p>${p.from ? 'от ' : ''}${rub(p.price)}</p><img loading="lazy" src="${p.img}"></div>`).join('')}</div>
      <nav class="tabs">${sections.map((s, i) => `<button class="tab${i ? '' : ' on'}" data-s="${s.code}">${esc(s.title)}</button>`).join('')}</nav>
      ${sections.map((s) => `<section class="cat" id="s-${s.code}"><h2>${esc(s.title)}</h2>${
        rowCats.has(s.title)
          ? s.items.map((p) => `<div class="row" data-id="${p.id}"><div class="pic">${p.isNew ? '<span class="new">NEW</span>' : ''}<img loading="lazy" src="${p.img}"></div><div class="tx"><h4>${esc(p.name)}</h4><p>${esc(p.desc)}</p><button class="buy">${p.from ? 'от ' : ''}${rub(p.price)} <b>+</b></button></div></div>`).join('')
          : `<div class="grid">${s.items.map((p) => `<div class="tile" data-id="${p.id}"><div class="pic"><img loading="lazy" src="${p.img}"></div><h4>${esc(p.name)}</h4><div class="buy">${p.from ? 'от ' : ''}${rub(p.price)}<i>+</i></div></div>`).join('')}</div>`
      }</section>`).join('')}`;
    app.insertAdjacentHTML('beforeend', `
      <div class="pill"><span class="n">0</span><span>Корзина</span><span class="ps">0 ₽</span></div>
      <div class="bar"><button class="on" data-t="menu">${ICON.menu}Меню</button><button data-t="promo">${ICON.promo}Акции</button><button data-t="cart">${ICON.cart}<span class="cnt">0</span>Корзина</button><button data-t="me">${ICON.me}Профиль</button></div>
      <div class="scrim"></div><div class="sheet" id="ps"></div><div class="sheet" id="cs"></div>`);

    // tabs: click to scroll, scrollspy
    const tabs = root.querySelector('.tabs');
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('.tab'); if (!b) return;
      const sec = root.getElementById('s-' + b.dataset.s);
      feed.scrollTo({ top: sec.offsetTop - tabs.offsetHeight + 40, behavior: 'smooth' });
    });
    feed.addEventListener('scroll', () => {
      tabs.classList.toggle('stuck', tabs.getBoundingClientRect().top <= 0.5);
      let cur = sections[0].code;
      for (const s of sections) if (root.getElementById('s-' + s.code).getBoundingClientRect().top < innerHeight * 0.45) cur = s.code;
      root.querySelectorAll('.tab').forEach((t) => {
        const on = t.dataset.s === cur;
        if (on && !t.classList.contains('on')) t.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
        t.classList.toggle('on', on);
      });
    }, { passive: true });
    feed.addEventListener('click', (e) => {
      const c = e.target.closest('[data-id]'); if (c) openProduct(c.dataset.id, c.querySelector('img'));
    });
    root.querySelector('.bar').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.t === 'cart') openCart();
      else if (b.dataset.t === 'menu') feed.scrollTo({ top: 0, behavior: 'smooth' });
      else toast('В прототипе этого экрана пока нет');
    });
    root.querySelector('.pill').addEventListener('click', openCart);
    root.querySelector('.scrim').addEventListener('click', closeSheets);
    R.ready = true;
  }

  function closeSheets() { root.querySelectorAll('.sheet.on,.scrim.on').forEach((el) => el.classList.remove('on')); }
  function openSheet(id) { root.querySelector('.scrim').classList.add('on'); root.getElementById(id).classList.add('on'); }

  function openProduct(id, srcImg) {
    const p = byId[id]; if (!p) return;
    const sh = root.getElementById('ps');
    let vi = Math.max(0, p.vars.findIndex((v) => v.isDefault));
    const v = () => p.vars[vi];
    const scale = (i) => (p.pizza && p.vars.length > 1 ? 0.72 + (0.28 * i) / (p.vars.length - 1) : 1);
    sh.innerHTML = `<div class="grab"></div><button class="x">✕</button><div class="pbody">
      <div class="pimg"><img src="${p.imgBig}"></div>
      <h3>${esc(p.name)}</h3><div class="meta"></div><p class="d">${esc(p.desc)}</p>
      ${p.vars.length > 1 ? `<div class="seg"><div class="thumb"></div>${p.vars.map((x, i) => `<button data-i="${i}">${esc(x.sizeName || x.size)}</button>`).join('')}</div>` : ''}
      <div class="nut"></div></div><div class="cta"><button class="add"></button></div>`;
    const upd = () => {
      const x = v();
      sh.querySelector('.meta').textContent = x ? [x.size && x.size.replace(/\s+/g, ' '), x.foodValue && x.foodValue.weight ? x.foodValue.weight + ' г' : ''].filter(Boolean).join(' · ') : '';
      sh.querySelector('.add').textContent = 'В корзину · ' + rub(x ? x.price : p.price);
      sh.querySelector('.pimg img').style.transform = `scale(${scale(vi)})`;
      const f = x && x.foodValue;
      sh.querySelector('.nut').innerHTML = f ? [['ккал', f.calories], ['белки', f.proteins], ['жиры', f.fats], ['углеводы', f.carbohydrates]].map(([k, n]) => `<div><b>${Math.round(n)}</b>${k}</div>`).join('') : '';
      const seg = sh.querySelector('.seg');
      if (seg) {
        const bs = seg.querySelectorAll('button'); bs.forEach((b, i) => b.classList.toggle('on', i === vi));
        const t = seg.querySelector('.thumb'); t.style.left = bs[vi].offsetLeft + 'px'; t.style.width = bs[vi].offsetWidth + 'px';
      }
    };
    sh.querySelector('.x').onclick = closeSheets;
    const seg = sh.querySelector('.seg');
    if (seg) seg.onclick = (e) => { const b = e.target.closest('button'); if (b) { vi = +b.dataset.i; upd(); } };
    sh.querySelector('.add').onclick = () => { addToCart(p, v(), sh.querySelector('.pimg img')); closeSheets(); };
    openSheet('ps');
    requestAnimationFrame(upd);
  }

  function addToCart(p, v, fromImg) {
    const key = p.id + ':' + (v ? v.id : '');
    const e = cart.get(key) || { p, v, qty: 0 };
    e.qty++; cart.set(key, e);
    // fly-to-cart
    const tgt = root.querySelector('.bar [data-t=cart] svg').getBoundingClientRect();
    const s = (fromImg || {}).getBoundingClientRect ? fromImg.getBoundingClientRect() : { left: 160, top: 300, width: 64, height: 64 };
    const f = document.createElement('img'); f.className = 'fly'; f.src = p.img;
    const o = app.getBoundingClientRect(); // .app is the containing block on desktop (transform), viewport on phone (o = 0,0)
    f.style.left = s.left - o.left + s.width / 2 - 32 + 'px'; f.style.top = s.top - o.top + s.height / 2 - 32 + 'px';
    app.appendChild(f);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      f.style.transform = `translate(${tgt.left + 13 - (s.left + s.width / 2)}px,${tgt.top + 13 - (s.top + s.height / 2)}px) scale(.25)`; f.style.opacity = '.6';
    }));
    setTimeout(() => { f.remove(); syncCart(true); }, 720);
  }

  function totals() { let n = 0, sum = 0; cart.forEach((e) => { n += e.qty; sum += e.qty * (e.v ? e.v.price : e.p.price); }); return { n, sum }; }
  function syncCart(bounce) {
    const { n, sum } = totals();
    const cnt = root.querySelector('.bar .cnt'); cnt.textContent = n; cnt.classList.toggle('has', n > 0);
    const pill = root.querySelector('.pill'); pill.classList.toggle('show', n > 0);
    pill.querySelector('.n').textContent = n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? 'товар' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'товара' : 'товаров');
    pill.querySelector('.ps').textContent = rub(sum);
    if (bounce) { [cnt, root.querySelector('.bar [data-t=cart] svg')].forEach((el) => { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }); }
    if (root.getElementById('cs').classList.contains('on')) drawCart();
  }
  function drawCart() {
    const cs = root.getElementById('cs'); const { n, sum } = totals();
    cs.innerHTML = `<div class="grab"></div><button class="x">✕</button><div class="cbody"><h3>${n ? 'Корзина' : 'Пока пусто'}</h3>
      ${[...cart.entries()].map(([k, e]) => `<div class="ci"><img src="${e.p.img}"><div class="t"><b>${esc(e.p.name)}</b><small>${e.v ? esc([...new Set([e.v.sizeName, e.v.size].filter(Boolean).map((x) => x.replace(/\s+/g, ' ')).filter(Boolean))].join(', ')) : ''}</small><span class="pr">${rub((e.v ? e.v.price : e.p.price) * e.qty)}</span></div>
        <div class="step"><button data-k="${k}" data-d="-1">−</button><span>${e.qty}</span><button data-k="${k}" data-d="1">+</button></div></div>`).join('')}
      ${n ? `<div class="sum"><span>${n} шт.</span><span>${rub(sum)}</span></div><div class="sum"><span>Доставка</span><span>0 ₽</span></div><div class="sum tot"><span>Итого</span><span>${rub(sum)}</span></div>` : '<p class="note">Добавьте что-нибудь из меню</p>'}
      </div><div class="cta"><button class="off">Оформить заказ</button><p class="note">Прототип: оформление и оплата отключены</p></div>`;
    cs.querySelector('.x').onclick = closeSheets;
    cs.querySelector('.cta button').onclick = () => toast('Это прототип: заказ не отправляется');
    cs.querySelectorAll('.step button').forEach((b) => (b.onclick = () => {
      const e = cart.get(b.dataset.k); e.qty += +b.dataset.d; if (e.qty <= 0) cart.delete(b.dataset.k); syncCart(false); drawCart();
    }));
  }
  function openCart() { drawCart(); openSheet('cs'); }

  R.openProduct = openProduct; R.openCart = openCart; R.cart = cart;
  // Meridian runs Boost scripts at DOMContentLoaded, before the site's bot check has set its
  // cookies: a 401/403/429 then is "too early", so wait for the site's own menu call and retry.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function load() {
    for (let i = 0; i < 8; i++) {
      const r = await ofetch(menuUrl(), { credentials: 'same-origin', headers: API_HEADERS });
      R.status = r.status; R.tries = i + 1;
      if (r.ok) return r.json();
      if (![401, 403, 429].includes(r.status)) break;
      await sleep(800 + i * 700);
    }
    throw new Error('HTTP ' + R.status);
  }
  load()
    .then((d) => { R.source = 'api/v5/menu (same-origin GET + routing headers)'; render(normalize(d)); })
    .catch((e) => { R.error = String(e); feed.innerHTML = '<div class="skel">Не получилось загрузить меню: ' + esc(e) + '</div>'; });
})();
