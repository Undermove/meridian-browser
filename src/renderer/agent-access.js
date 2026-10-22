// Agent access levels, shared by the main UI (⌘J panel, onboarding) and the Settings window.
const AGENT_ACCESS = [
  ['off', 'Off', 'Agents can’t see or touch the browser.'],
  ['read', 'Read only', 'Agents can list tabs, read pages and take screenshots.'],
  ['ask', 'Ask before acting', 'Agents can also navigate, click and type — you confirm every action.'],
  ['full', 'Full control', 'Agents act without asking. Only for agents you trust.'],
];
