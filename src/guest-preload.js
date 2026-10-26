// Runs in every web page tab, in its own isolated world (the page can't see or call it). Its one job is
// the two-finger swipe: Electron has no history swipe of its own and the trackpad's wheel deltas never
// reach the main process, so the page reports a horizontal swipe to the UI (app.js: onPageSwipe) and the
// UI goes back / forward. Nothing about the page itself is sent.
//
// A swipe only counts when the page doesn't take it: not on a carousel, a map, a code block or a page
// that is scrolled sideways, and not when the page handled the wheel itself (preventDefault).

const { ipcRenderer } = require('electron');

let acc = 0;
let mode = null; // null: waiting for a gesture; 'swipe': reporting; 'skip': the page takes this one
let idle = null;

function canScrollX(el, dx) {
  for (let n = el instanceof Element ? el : null; n; n = n.parentElement) {
    if (n.scrollWidth <= n.clientWidth + 1) continue;
    const isRoot = n === document.scrollingElement || n === document.documentElement || n === document.body;
    if (!isRoot && !/(auto|scroll)/.test(getComputedStyle(n).overflowX)) continue;
    if (dx < 0 ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true;
  }
  const r = document.scrollingElement;
  return !!r && (dx < 0 ? r.scrollLeft > 0 : r.scrollLeft + r.clientWidth < r.scrollWidth - 1);
}

function end() {
  if (mode === 'swipe') ipcRenderer.sendToHost('swipe', { dx: acc, end: true });
  acc = 0; mode = null;
}

// Bubble phase on window: the page's own handlers have already run, so defaultPrevented is final.
window.addEventListener('wheel', (e) => {
  clearTimeout(idle);
  idle = setTimeout(end, 180); // the gesture (and its momentum) is over once the wheel goes quiet
  if (mode === 'skip') return;
  if (!mode) {
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5 && Math.abs(e.deltaX) >= 2;
    const ok = horizontal && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && !e.defaultPrevented && !canScrollX(e.target, e.deltaX);
    mode = ok ? 'swipe' : 'skip';
    if (!ok) return;
  }
  acc += e.deltaX;
  ipcRenderer.sendToHost('swipe', { dx: acc });
}, { passive: true });
