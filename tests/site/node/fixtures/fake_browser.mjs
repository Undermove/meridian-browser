// A harness browser object that records what the driver asks of it and answers with canned tabs.
export const TITLES = ['Field Notes: Slow mornings', 'Coastline: North by night train', 'Weekend Recipes',
  'Linear', 'Notion', 'Spotify', 'Figma', 'GitHub', 'Telegram', 'YouTube'];

export function fakeBrowser({ folder = { itemId: 'folder-1' }, failOn = null } = {}) {
  const calls = [];
  const record = (name, ...args) => {
    calls.push([name, ...args]);
    if (failOn && failOn(name, args)) throw new Error(`fake ${name} failed`);
  };
  const tabs = TITLES.map((title, i) => ({ id: `tab-${i}`, title, active: i === 0 }));
  return {
    calls,
    closed: false,
    async waitFor(expr, timeout) { record('waitFor', expr, timeout); return true; },
    async eval(expr) {
      record('eval', expr);
      if (expr.endsWith('.state_.activeSpaceId')) return 'space-1';
      if (expr.includes('.addFolder(')) return folder;
      return undefined;
    },
    async tabs() { record('tabs'); return tabs; },
    async click(expr) { record('click', expr); },
    async menu(expr, item) { record('menu', expr, item); },
    async state() { record('state'); return { active: 0 }; },
    async pinned() { record('pinned'); return ['GitHub']; },
    async favorites() { record('favorites'); return ['Linear']; },
    async screenshot(file) { record('screenshot', file); },
    async close() { record('close'); this.closed = true; },
  };
}
