/* Meridian Studio — the persona picker's "character select" effects (hover: the sticker tilts and
 * its own particles fly; pick: a burst). transform/opacity + canvas only; reduced motion: none.
 * studioPersonaFx(root, onPick): wires the .pc[data-k] cards inside root. */
function studioPersonaFx(root, onPick) {
  const Q = new URLSearchParams('');
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches && !Q.has('hover');
  const TAU = Math.PI * 2;
  // anchor points in sticker-local fractions (0..1 of the sticker image box)
  const HERO = {
    dev: { c: '#2ef2d2', c2: '#ff4fd8', term: [0.165, 0.37] },
    des: { c: '#c58cff', c2: '#ffcf7a', center: [0.5, 0.5], brush: [0.17, 0.33] },
    man: { c: '#ffd36b', c2: '#9aa6ff', wand: [0.055, 0.31], ticks: [[0.79, 0.44], [0.79, 0.465], [0.79, 0.49]], feet: [0.5, 0.985] },
    use: { c: '#ff9a6b', c2: '#9fd8ff', steam: [0.2, 0.47], center: [0.5, 0.3] },
  };
  function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  const clamp01 = (x) => Math.min(1, Math.max(0, x));

  const cards = [...root.querySelectorAll('.pc[data-k]')].map((el, i) => {
    const k = el.dataset.k;
    const c = {
      el, k, h: HERO[k], tilt: el.querySelector('.tilt'), stk: el.querySelector('.stk'),
      back: el.querySelector('canvas.back'), front: el.querySelector('canvas.front'),
      foil: el.querySelector('.foil i'), flash: el.querySelector('.flash'),
      rgb: [...el.querySelectorAll('.rgb')], scan: el.querySelector('.scan i'), main: el.querySelector('img.hero'),
      hover: false, t: 0, pickT: -1, mx: 0.5, my: 0.5, rx: 0, ry: 0, lift: 0, parts: [], trail: [], r: rng(7 + i * 101),
      acc: 0,
    };
    return c;
  });

  // ---------- canvas sizing: canvases extend beyond the sticker box by PAD (css px)
  const PAD = { l: 70, r: 70, t: 60, b: 40 };
  function size(c) {
    const w = c.stk.offsetWidth, h = c.stk.offsetHeight, dpr = Math.min(2, devicePixelRatio || 1);
    for (const cv of [c.back, c.front]) {
      cv.style.left = -PAD.l + 'px'; cv.style.top = -PAD.t + 'px';
      cv.style.width = w + PAD.l + PAD.r + 'px'; cv.style.height = h + PAD.t + PAD.b + 'px';
      cv.width = Math.round((w + PAD.l + PAD.r) * dpr); cv.height = Math.round((h + PAD.t + PAD.b) * dpr);
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, PAD.l * dpr, PAD.t * dpr);
    }
    c.W = w; c.H = h;
  }
  const P = (c, f) => [f[0] * c.W, f[1] * c.H];

  // ---------- particles
  function spawn(c, o) { c.parts.push(Object.assign({ age: 0, life: 900, vx: 0, vy: 0, g: 0, size: 3, layer: 'front', kind: 'dot', rot: 0, vr: 0 }, o)); }
  function star(g, x, y, r, rot) {
    g.beginPath();
    for (let i = 0; i < 8; i++) { const a = rot + i * Math.PI / 4, rr = i % 2 ? r * 0.28 : r; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    g.closePath(); g.fill();
  }

  // ---------- per-hero update (dt ms), called with c.t = ms since hover start
  const UPD = {
    dev(c, dt) {
      const t = c.t, [tx, ty] = P(c, c.h.term), R = c.r;
      if (t - dt < 140 && t >= 140) for (let i = 0; i < 16; i++) glyph(c, tx, ty, 1);
      if (t > 600) { c.acc += dt; if (c.acc > 260) { c.acc = 0; glyph(c, tx, ty, 0.6); } }
      function glyph(c, x, y, s) {
        const G = ['{ }', '</>', '=>', '01', '>_', ';', '$', 'λ', '#', '&&', '[]', '::'];
        const a = -Math.PI / 2 + (R() - 0.5) * 2.6;
        const v = (0.09 + R() * 0.14) * s;
        spawn(c, { kind: 'glyph', txt: G[(R() * G.length) | 0], x: x + (R() - 0.5) * 30, y: y + (R() - 0.5) * 20, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 700 + R() * 700, size: 10 + R() * 6, col: R() < 0.6 ? '#5dffa8' : (R() < 0.5 ? c.h.c : c.h.c2) });
      }
    },
    des(c, dt) {
      const t = c.t, R = c.r, [cx, cy] = P(c, c.h.center);
      // trail head: spiral rising from the hem, then a calm tilted orbit
      const a = t * 0.0062 + 1.2;
      const k = ease(t / 1100);
      const rx = c.W * (0.62 - 0.08 * k), ry = c.H * 0.1;
      const yb = c.H * (0.9 - 0.42 * k) + Math.sin(t * 0.0021) * c.H * 0.04;
      const hx = cx + Math.cos(a) * rx, hy = yb + Math.sin(a) * ry;
      c.trail.push({ x: hx, y: hy, z: Math.sin(a), t });
      while (c.trail.length && t - c.trail[0].t > 520) c.trail.shift();
      c.acc += dt;
      if (c.acc > (t < 900 ? 24 : 70)) { c.acc = 0; spawn(c, { kind: 'spark', x: hx + (R() - .5) * 8, y: hy + (R() - .5) * 8, vx: (R() - .5) * 0.03, vy: -0.02 - R() * 0.03, life: 600 + R() * 500, size: 2.5 + R() * 3.5, col: R() < 0.5 ? '#ffffff' : (R() < 0.5 ? c.h.c : c.h.c2), layer: Math.sin(a) < 0 ? 'back' : 'front', rot: R() * 3 }); }
    },
    man(c, dt) {
      const t = c.t, R = c.r, [wx, wy] = P(c, c.h.wand), [fx, fy] = P(c, c.h.feet);
      if (t - dt < 120 && t >= 120) for (let i = 0; i < 26; i++) { const a = R() * TAU, v = 0.08 + R() * 0.2; spawn(c, { kind: 'spark', x: wx, y: wy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.04, g: 0.00022, life: 500 + R() * 500, size: 2 + R() * 3.5, col: R() < 0.5 ? '#fff6d0' : c.h.c, rot: R() * 3 }); }
      c.acc += dt;
      if (t > 300 && c.acc > 90) { c.acc = 0;
        spawn(c, { kind: 'mote', x: fx + (R() - .5) * c.W * 1.0, y: fy + (R() - .5) * 10, vy: -0.04 - R() * 0.05, life: 1100 + R() * 800, size: 1.5 + R() * 2, col: R() < 0.5 ? c.h.c : '#fff', layer: R() < 0.5 ? 'back' : 'front' });
        if (R() < 0.35) spawn(c, { kind: 'spark', x: wx + (R() - .5) * 6, y: wy + (R() - .5) * 6, vx: (R() - .5) * 0.06, vy: -0.03 - R() * 0.04, life: 500, size: 2 + R() * 2, col: '#fff6d0', rot: R() * 3 });
      }
    },
    use(c, dt) {
      const t = c.t, R = c.r, [cx, cy] = P(c, c.h.center), [sx, sy] = P(c, c.h.steam);
      const a = t * 0.0048 - 0.6, k = ease(t / 700);
      const hx = cx + Math.cos(a) * c.W * (0.3 + 0.32 * k), hy = cy + Math.sin(a) * c.H * 0.08 - c.H * 0.06 + (1 - k) * c.H * 0.5;
      c.trail.push({ x: hx, y: hy, z: Math.sin(a), t });
      while (c.trail.length && t - c.trail[0].t > 420) c.trail.shift();
      c.acc += dt;
      if (c.acc > 110) { c.acc = 0;
        spawn(c, { kind: 'twinkle', x: -40 + R() * (c.W + 80), y: -40 + R() * c.H * 0.8, life: 900 + R() * 900, size: 2 + R() * 3.5, col: R() < 0.7 ? '#ffffff' : c.h.c2, layer: R() < 0.6 ? 'back' : 'front', rot: R() });
        spawn(c, { kind: 'steam', x: sx + (R() - .5) * 6, y: sy, vy: -0.025 - R() * 0.012, life: 1000 + R() * 400, size: 3.5 + R() * 3, ph: R() * TAU, col: '#ffffff' });
      }
      if (t - dt < 60 && t >= 60) for (let i = 0; i < 18; i++) spawn(c, { kind: 'twinkle', x: -40 + R() * (c.W + 80), y: -40 + R() * c.H * 0.9, life: 700 + R() * 900, size: 2 + R() * 4, col: '#fff', layer: R() < .6 ? 'back' : 'front', rot: R() });
    },
  };

  // ---------- per-hero draw
  function drawTrail(g, c, layer, w0, colA, colB) {
    const tr = c.trail; if (tr.length < 2) return;
    g.save(); g.lineCap = 'round'; g.globalCompositeOperation = 'lighter';
    for (let i = 1; i < tr.length; i++) {
      const p = tr[i - 1], q = tr[i];
      if ((layer === 'back') !== (q.z < 0)) continue;
      const f = i / tr.length;
      g.strokeStyle = f > 0.5 ? colB : colA; g.globalAlpha = f * f;
      g.lineWidth = w0 * f + 0.5; g.shadowColor = colA; g.shadowBlur = 10;
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
    }
    const h = tr[tr.length - 1];
    if ((layer === 'back') === (h.z < 0)) { g.globalAlpha = 1; g.fillStyle = '#fff'; g.shadowBlur = 16; g.shadowColor = colB; g.beginPath(); g.arc(h.x, h.y, w0 * 0.55, 0, TAU); g.fill(); }
    g.restore();
  }
  const DRAW = {
    dev(c, g, layer) {
      if (layer !== 'front') return;
      const t = c.t, [tx, ty] = P(c, c.h.term);
      // holo-terminal power-on flicker, then a soft breathing glow
      let on = t < 90 ? 0 : t < 420 ? ([1, 0, 1, 1, 0, 1, 0.4, 1][((t - 90) / 42) | 0] ?? 1) : 0.55 + 0.25 * Math.sin(t * 0.006);
      g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = on * 0.9;
      const rg = g.createRadialGradient(tx, ty, 2, tx, ty, c.W * 0.26);
      rg.addColorStop(0, 'rgba(90,255,190,.55)'); rg.addColorStop(1, 'rgba(46,242,210,0)');
      g.fillStyle = rg; g.fillRect(tx - c.W * 0.3, ty - c.W * 0.3, c.W * 0.6, c.W * 0.6);
      // blinking cursor block next to the prompt
      if (t > 420 && ((t / 480) | 0) % 2 === 0) { g.globalAlpha = 0.95; g.fillStyle = '#7dffb8'; g.shadowColor = '#5dffa8'; g.shadowBlur = 8; g.fillRect(tx + c.W * 0.012, ty + c.H * 0.004, c.W * 0.03, c.H * 0.012); }
      g.restore();
    },
    des(c, g, layer) {
      drawTrail(g, c, layer, 7, c.h.c, '#ffe2a8');
      // four swatch runes orbit once (100..1500ms)
      const t = c.t; if (t < 100 || t > 1500) return;
      const k = (t - 100) / 1400, [cx] = P(c, c.h.center), cols = ['#b48cff', '#ffab8a', '#6fd6c9', '#ffd36e'];
      g.save();
      cols.forEach((col, i) => {
        const a = k * TAU + i * TAU / 4 + 0.6, z = Math.sin(a);
        if ((layer === 'back') !== (z < 0)) return;
        const x = cx + Math.cos(a) * c.W * 0.62, y = c.H * 0.42 + z * c.H * 0.09, s = 15 + z * 4;
        g.globalAlpha = Math.sin(Math.PI * k) * (0.75 + 0.25 * z);
        g.shadowColor = col; g.shadowBlur = 14; g.fillStyle = '#fff';
        rr(g, x - s / 2 - 2.5, y - s / 2 - 2.5, s + 5, s + 5, 6); g.fill();
        g.fillStyle = col; rr(g, x - s / 2, y - s / 2, s, s, 4.5); g.fill();
      });
      g.restore();
    },
    man(c, g, layer) {
      const t = c.t, [fx, fy] = P(c, c.h.feet);
      if (layer === 'back') {
        // magic circle spinning up under the hero
        const k = ease(t / 480), spin = t * 0.0009 + (1 - Math.exp(-t / 260)) * 2.2;
        const R0 = c.W * 0.6 * (0.4 + 0.6 * k);
        g.save(); g.translate(fx, fy - 6); g.scale(1, 0.26); g.globalCompositeOperation = 'lighter';
        g.globalAlpha = k * (0.85 + 0.15 * Math.sin(t * 0.004));
        g.strokeStyle = c.h.c; g.shadowColor = c.h.c; g.shadowBlur = 18; g.lineWidth = 3;
        g.beginPath(); g.arc(0, 0, R0, 0, TAU); g.stroke();
        g.lineWidth = 1.6; g.beginPath(); g.arc(0, 0, R0 * 0.82, 0, TAU); g.stroke();
        g.beginPath(); g.arc(0, 0, R0 * 0.5, 0, TAU); g.stroke();
        g.rotate(spin);
        // hexagram
        g.beginPath(); for (let i = 0; i <= 6; i++) { const a = i * TAU / 3; g.lineTo(Math.cos(a) * R0 * 0.8, Math.sin(a) * R0 * 0.8); }
        g.moveTo(Math.cos(Math.PI / 3) * R0 * 0.8, Math.sin(Math.PI / 3) * R0 * 0.8);
        for (let i = 0; i <= 3; i++) { const a = Math.PI / 3 + i * TAU / 3; g.lineTo(Math.cos(a) * R0 * 0.8, Math.sin(a) * R0 * 0.8); }
        g.stroke();
        // rune ticks between the rings
        g.lineWidth = 2.2;
        for (let i = 0; i < 24; i++) { const a = i * TAU / 24; const r1 = R0 * 0.86, r2 = R0 * (i % 3 ? 0.93 : 0.97);
          g.beginPath(); g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); g.lineTo(Math.cos(a) * r2, Math.sin(a) * r2); g.stroke();
          if (i % 3 === 0) { g.beginPath(); g.arc(Math.cos(a + 0.12) * R0 * 0.91, Math.sin(a + 0.12) * R0 * 0.91, 3, 0, TAU); g.stroke(); } }
        g.restore();
        // light column
        g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = k * 0.35;
        const lg = g.createLinearGradient(0, fy, 0, fy - c.H * 0.7); lg.addColorStop(0, c.h.c); lg.addColorStop(1, 'rgba(255,211,107,0)');
        g.fillStyle = lg; g.fillRect(fx - R0 * 0.9, fy - c.H * 0.7, R0 * 1.8, c.H * 0.7); g.restore();
      } else {
        // checklist items tick in light, one after another
        c.h.ticks.forEach(([u, v], i) => {
          const s = clamp01((t - 360 - i * 170) / 220); if (s <= 0) return;
          const [x, y] = P(c, [u, v]), d = c.W * 0.017;
          const pts = [[x - d, y], [x - d * 0.3, y + d * 0.7], [x + d * 1.1, y - d * 0.9]];
          g.save(); g.globalCompositeOperation = 'lighter'; g.strokeStyle = '#fff3c4'; g.shadowColor = c.h.c; g.shadowBlur = 12; g.lineWidth = 2; g.lineCap = g.lineJoin = 'round';
          g.globalAlpha = 0.95;
          const L1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), L2 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]), L = (L1 + L2) * s;
          g.beginPath(); g.moveTo(...pts[0]);
          if (L <= L1) g.lineTo(pts[0][0] + (pts[1][0] - pts[0][0]) * L / L1, pts[0][1] + (pts[1][1] - pts[0][1]) * L / L1);
          else { g.lineTo(...pts[1]); const m = (L - L1) / L2; g.lineTo(pts[1][0] + (pts[2][0] - pts[1][0]) * m, pts[1][1] + (pts[2][1] - pts[1][1]) * m); }
          g.stroke(); g.restore();
        });
      }
    },
    use(c, g, layer) { drawTrail(g, c, layer, 5, '#9fd8ff', '#ffffff'); },
  };
  function rr(g, x, y, w, h, r) { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); }

  function drawParts(c, g, layer) {
    g.save();
    for (const p of c.parts) {
      if (p.layer !== layer) continue;
      const f = p.age / p.life, a = f < 0.15 ? f / 0.15 : 1 - (f - 0.15) / 0.85;
      g.globalAlpha = clamp01(a);
      if (p.kind === 'glyph') { g.globalCompositeOperation = 'lighter'; g.font = `600 ${p.size}px ui-monospace, Menlo, monospace`; g.fillStyle = p.col; g.shadowColor = p.col; g.shadowBlur = 8; g.fillText(p.txt, p.x, p.y); }
      else if (p.kind === 'steam') { g.globalCompositeOperation = 'source-over'; g.globalAlpha = clamp01(a) * 0.22; g.fillStyle = p.col; g.shadowColor = '#fff'; g.shadowBlur = 6; g.beginPath(); g.arc(p.x + Math.sin(p.age * 0.006 + p.ph) * 6, p.y, p.size * (0.6 + f), 0, TAU); g.fill(); }
      else if (p.kind === 'twinkle') { g.globalCompositeOperation = 'lighter'; g.fillStyle = p.col; g.shadowColor = p.col; g.shadowBlur = 8; g.globalAlpha = clamp01(a) * (0.6 + 0.4 * Math.sin(p.age * 0.02 + p.rot * 9)); star(g, p.x, p.y, p.size, p.rot); }
      else if (p.kind === 'spark') { g.globalCompositeOperation = 'lighter'; g.fillStyle = p.col; g.shadowColor = p.col; g.shadowBlur = 10; star(g, p.x, p.y, p.size * (1 - f * 0.5), p.rot + p.age * 0.004); }
      else { g.globalCompositeOperation = 'lighter'; g.fillStyle = p.col; g.shadowColor = p.col; g.shadowBlur = 8; g.beginPath(); g.arc(p.x, p.y, p.size, 0, TAU); g.fill(); }
    }
    g.restore();
  }

  // ---------- pick burst ring
  function drawPick(c, g) {
    if (c.pickT < 0) return; const s = c.pickT; if (s > 700) return;
    const k = ease(s / 700); g.save(); g.globalCompositeOperation = 'lighter';
    g.strokeStyle = c.h.c; g.shadowColor = c.h.c; g.shadowBlur = 20; g.lineWidth = 6 * (1 - k) + 1; g.globalAlpha = 1 - k;
    g.beginPath(); g.ellipse(c.W / 2, c.H * 0.55, c.W * (0.3 + 0.6 * k), c.H * (0.3 + 0.45 * k), 0, 0, TAU); g.stroke(); g.restore();
  }

  // ---------- step + render
  function step(c, dt) {
    if (c.hover) { c.t += dt; UPD[c.k](c, dt); }
    if (c.pickT >= 0) c.pickT += dt;
    for (const p of c.parts) { p.age += dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    c.parts = c.parts.filter((p) => p.age < p.life);
    if (!c.hover && c.trail.length) c.trail.shift();
    // spring the tilt and lift
    const tx = c.hover ? (c.my - 0.5) * -14 : 0, ty = c.hover ? (c.mx - 0.5) * 18 : 0;
    const kk = 1 - Math.exp(-dt / 90);
    c.rx += (tx - c.rx) * kk; c.ry += (ty - c.ry) * kk; c.lift += ((c.hover ? 1 : 0) - c.lift) * kk;
  }
  function render(c) {
    const t = c.t;
    // pick bounce: 1 -> 1.08 -> 0.98 -> 1
    let b = 0; if (c.pickT >= 0 && c.pickT < 650) { const s = c.pickT / 650; b = Math.sin(s * Math.PI * 2.2) * Math.exp(-s * 3.2) * 0.09; }
    const sc = 1 + 0.05 * c.lift + b;
    c.tilt.style.transform = `perspective(800px) translate3d(0, ${-12 * c.lift}px, 0) rotateX(${c.rx.toFixed(2)}deg) rotateY(${c.ry.toFixed(2)}deg) rotateZ(${(c.ry * -0.12).toFixed(2)}deg) scale(${sc.toFixed(4)})`;
    // foil: one sweep on entrance, then follows the tilt faintly
    if (c.foil) {
      const sw = c.hover ? clamp01(t / 750) : 1;
      const x = c.hover && t < 750 ? -70 + 140 * ease(sw) : c.ry * 3;
      c.foil.style.transform = `translate3d(${x}%,0,0) rotate(18deg)`;
      c.foil.style.opacity = c.hover ? (t < 750 ? Math.sin(Math.PI * sw) * 0.6 : 0.1 * c.lift) : 0;
    }
    if (c.flash) c.flash.style.opacity = c.pickT >= 0 && c.pickT < 420 ? (1 - c.pickT / 420) * 0.5 : 0;
    if (c.k === 'dev') {
      const gl = c.hover && t < 420, R = c.r;
      c.rgb.forEach((im, i) => { im.style.opacity = gl ? (Math.sin(t * 0.09 + i * 2) > -0.2 ? 0.75 : 0) : 0; im.style.transform = `translate3d(${gl ? (i ? 1 : -1) * (3 + 5 * (1 - t / 420)) : 0}px, ${gl ? (Math.sin(t * 0.7 + i) * 2).toFixed(1) : 0}px, 0)`; });
      c.main.style.transform = gl && Math.sin(t * 0.13) > 0.6 ? `translate3d(${(Math.sin(t) * 3).toFixed(1)}px,0,0)` : '';
      if (c.scan) { c.scan.style.opacity = c.hover ? (t < 600 ? 0.5 : 0.16) : 0; c.scan.style.transform = `translate3d(0, ${((t * 0.03) % 6).toFixed(2)}px, 0)`; }
    }
    for (const [cv, layer] of [[c.back, 'back'], [c.front, 'front']]) {
      const g = cv.getContext('2d');
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); g.restore();
      if (c.hover || c.parts.length || c.trail.length) { DRAW[c.k](c, g, layer); drawParts(c, g, layer); }
      if (layer === 'front') drawPick(c, g);
      if (Q.has('debug') && layer === 'front') dbg(c, g);
    }
  }
  function dbg(c, g) { setTimeout(() => { const d = c.front.getContext('2d').getImageData(0, 0, c.front.width, c.front.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) n += d[i] > 0; document.body.dataset['dbg' + c.k] = n + ' ' + getComputedStyle(c.front).display + ' ' + getComputedStyle(c.front).opacity + ' ' + c.front.getBoundingClientRect().width; }, 50);
    g.save(); g.strokeStyle = '#f0f'; g.strokeRect(0, 0, c.W, c.H); g.fillStyle = '#f0f';
    for (const [key, v] of Object.entries(c.h)) { const arr = Array.isArray(v?.[0]) ? v : (Array.isArray(v) ? [v] : []); for (const f of arr) { const [x, y] = P(c, f); g.beginPath(); g.arc(x, y, 4, 0, TAU); g.fill(); g.fillText(key, x + 5, y - 5); } }
    g.restore();
  }
  const busy = (c) => c.hover || c.parts.length || c.trail.length || (c.pickT >= 0 && c.pickT < 800) || Math.abs(c.rx) + Math.abs(c.ry) + c.lift > 0.01;

  let last = 0, raf = 0;
  function frame(now) {
    const dt = Math.min(40, now - (last || now)); last = now;
    let any = false;
    for (const c of cards) { if (!busy(c)) continue; any = true; step(c, dt); render(c); }
    raf = any ? requestAnimationFrame(frame) : (last = 0, 0);
  }
  const CAPTURE = Q.has('hover') || Q.has('pick');
  const kick = () => { if (!raf && !CAPTURE) raf = requestAnimationFrame(frame); };

  function pick(c) {
    for (const o of cards) { o.el.classList.toggle('sel', o === c); o.el.classList.toggle('dim', o !== c); }
    root.querySelectorAll('.pc .check').forEach((n) => n.remove());
    c.el.insertAdjacentHTML('beforeend', '<span class="check"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg></span>');
    const btn = root.querySelector('.btn.pri'); if (btn) btn.textContent = c.el.dataset.cta;
    if (typeof onPick === 'function') onPick(c.k);
    c.pickT = 0;
    if (!REDUCED) { const R = c.r; for (let i = 0; i < 22; i++) { const a = R() * TAU, v = 0.12 + R() * 0.22; spawn(c, { kind: 'spark', x: c.W / 2 + Math.cos(a) * c.W * 0.25, y: c.H * 0.5 + Math.sin(a) * c.H * 0.25, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 500 + R() * 300, size: 2.5 + R() * 3, col: R() < 0.5 ? '#fff' : c.h.c, rot: R() * 3 }); } }
    kick();
  }

  function start() {
  for (const c of cards) {
    size(c);
    if (REDUCED) { c.el.addEventListener('click', () => { for (const o of cards) { o.el.classList.toggle('sel', o === c); o.el.classList.toggle('dim', o !== c); } const btn = root.querySelector('.btn.pri'); if (btn) btn.textContent = c.el.dataset.cta; if (typeof onPick === 'function') onPick(c.k); }); continue; }
    c.el.addEventListener('pointerenter', () => { c.hover = true; c.t = 0; c.acc = 0; c.trail = []; c.el.classList.add('hov'); kick(); });
    c.el.addEventListener('pointerleave', () => { c.hover = false; c.el.classList.remove('hov'); kick(); });
    c.el.addEventListener('pointermove', (e) => { const r = c.el.getBoundingClientRect(); c.mx = (e.clientX - r.left) / r.width; c.my = (e.clientY - r.top) / r.height; });
    c.el.addEventListener('click', () => pick(c));
  }
  addEventListener('resize', () => cards.forEach((c) => { size(c); render(c); }));

  // ---------- deterministic capture mode
  if (Q.has('hover') || Q.has('pick')) {
    const T = +Q.get('t') || 0, dt = 1000 / 60;
    const hc = cards.find((c) => c.k === Q.get('hover'));
    if (hc) { hc.hover = true; hc.el.classList.add('hov'); hc.mx = +(Q.get('mx') ?? 0.68); hc.my = +(Q.get('my') ?? 0.4); }
    const pc = cards.find((c) => c.k === Q.get('pick')), pt = +(Q.get('pt') ?? -1);
    for (let s = 0; s < T; s += dt) { for (const c of cards) { if (pc === c && pt >= 0 && Math.abs(s - pt) < dt / 2) pick(c); step(c, dt); } }
    for (const c of cards) render(c);
    document.documentElement.classList.add('frozen');
  } else if (Q.has('debug')) for (const c of cards) { c.hover = true; render(c); }
  }
  Promise.all([...root.querySelectorAll('.stk img.hero')].map((i) => i.decode().catch(() => {}))).then(start);
  return { pick: (k) => { const c = cards.find((x) => x.k === k); if (c) pick(c); } };
}
