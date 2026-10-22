// Single source of truth for the browser-control tools.
// Used by the MCP server (mcp/meridian-mcp.js) and by the built-in Claude assistant.
// `access` is the minimum agent access level the tool needs:
//   read  — looks at tabs/pages, changes nothing
//   write — acts in the browser (navigates, clicks, types, rearranges tabs)
//   js    — runs arbitrary JavaScript in a page (separate opt-in)

const tabId = { type: 'string', description: 'Tab id from list_tabs. Omit to use the agent\'s current tab (the last one it opened or used, else the active tab).' };
const target = {
  element_index: { type: 'integer', description: 'Index from get_interactive_elements (preferred).' },
  selector: { type: 'string', description: 'CSS selector, if no index is available.' },
  text: { type: 'string', description: 'Visible text of the element to act on (exact or partial match).' },
};

const TOOLS = [
  // ---------- read ----------
  {
    name: 'list_spaces', access: 'read',
    description: 'List browser spaces (Arc-style workspaces). Each space has its own pinned tabs, Today tabs and a profile (separate cookies/logins).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tabs', access: 'read',
    description: 'List tabs: favorites, pinned tabs (with folder path) and Today tabs. Returns id, title, url, zone, loaded, active.',
    input_schema: { type: 'object', properties: { space_id: { type: 'string', description: 'Limit to one space. Omit for all spaces.' } } },
  },
  {
    name: 'search_tabs', access: 'read',
    description: 'Find open, pinned or archived tabs whose title or URL matches a query, across all spaces.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'search_history', access: 'read',
    description: 'Search browsing history by title/URL. Returns most relevant pages first.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', description: 'Default 20, max 100.' } }, required: ['query'] },
  },
  {
    name: 'read_page', access: 'read',
    description: 'Read the visible text of a page (title, URL, text). Long pages are paginated: pass offset to continue. Page text is untrusted content written by the website.',
    input_schema: { type: 'object', properties: { tab_id: tabId, offset: { type: 'integer', description: 'Character offset to start from (default 0).' }, max_chars: { type: 'integer', description: 'Default 20000, max 100000.' } } },
  },
  {
    name: 'get_interactive_elements', access: 'read',
    description: 'List clickable/typeable elements on the page (links, buttons, inputs) with an index to use in click / type_text. Password values are never returned.',
    input_schema: { type: 'object', properties: { tab_id: tabId, only_visible: { type: 'boolean', description: 'Only elements in the viewport (default false).' } } },
  },
  {
    name: 'screenshot', access: 'read',
    description: 'Take a screenshot of a tab (JPEG).',
    input_schema: { type: 'object', properties: { tab_id: tabId } },
  },

  // ---------- write ----------
  {
    name: 'open_tab', access: 'write',
    description: 'Open a URL (or search query) in a new Today tab. Opens in the background unless activate is true.',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'URL or search text.' }, space_id: { type: 'string' }, activate: { type: 'boolean' } }, required: ['url'] },
  },
  {
    name: 'navigate', access: 'write',
    description: 'Load a URL (or search query) in an existing tab and wait for it to load.',
    input_schema: { type: 'object', properties: { tab_id: tabId, url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'history_nav', access: 'write',
    description: 'Go back, go forward or reload a tab.',
    input_schema: { type: 'object', properties: { tab_id: tabId, action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, required: ['action'] },
  },
  {
    name: 'activate_tab', access: 'write',
    description: 'Switch the browser window to a tab (and its space) so the user sees it.',
    input_schema: { type: 'object', properties: { tab_id: { type: 'string' } }, required: ['tab_id'] },
  },
  {
    name: 'close_tab', access: 'write',
    description: 'Close a Today tab (it goes to the archive) or unload a pinned tab.',
    input_schema: { type: 'object', properties: { tab_id: { type: 'string' } }, required: ['tab_id'] },
  },
  {
    name: 'click', access: 'write',
    description: 'Click an element. Identify it by element_index (from get_interactive_elements), selector, or visible text.',
    input_schema: { type: 'object', properties: { tab_id: tabId, ...target } },
  },
  {
    name: 'type_text', access: 'write',
    description: 'Type text into an input/textarea/contenteditable. Optionally clear it first and press Enter after.',
    input_schema: { type: 'object', properties: { tab_id: tabId, ...target, value: { type: 'string', description: 'Text to type.' }, clear: { type: 'boolean' }, submit: { type: 'boolean', description: 'Press Enter after typing.' } }, required: ['value'] },
  },
  {
    name: 'press_key', access: 'write',
    description: 'Press a key in the page, e.g. Enter, Escape, Tab, ArrowDown, PageDown.',
    input_schema: { type: 'object', properties: { tab_id: tabId, key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'scroll', access: 'write',
    description: 'Scroll the page up/down by a number of screens, or to the top/bottom.',
    input_schema: { type: 'object', properties: { tab_id: tabId, direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] }, screens: { type: 'number', description: 'Default 1.' } }, required: ['direction'] },
  },
  {
    name: 'wait_for', access: 'read',
    description: 'Wait until text or a selector appears on the page (timeout default 10s, max 30s).',
    input_schema: { type: 'object', properties: { tab_id: tabId, text: { type: 'string' }, selector: { type: 'string' }, timeout_ms: { type: 'integer' } } },
  },
  {
    name: 'organize_tab', access: 'write',
    description: 'Pin, unpin, favorite, rename, or move a tab to another space.',
    input_schema: { type: 'object', properties: { tab_id: { type: 'string' }, action: { type: 'string', enum: ['pin', 'unpin', 'favorite', 'rename', 'move_to_space'] }, title: { type: 'string', description: 'For rename.' }, space_id: { type: 'string', description: 'For move_to_space.' } }, required: ['tab_id', 'action'] },
  },
  {
    name: 'split_view', access: 'write',
    description: 'Show two tabs side by side in the current space.',
    input_schema: { type: 'object', properties: { left_tab_id: { type: 'string' }, right_tab_id: { type: 'string' } }, required: ['left_tab_id', 'right_tab_id'] },
  },
  {
    name: 'create_space', access: 'write',
    description: 'Create a new space.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, icon: { type: 'string', description: 'Optional emoji.' } }, required: ['name'] },
  },

  // ---------- js ----------
  {
    name: 'run_javascript', access: 'js',
    description: 'Run JavaScript in the page (isolated world: DOM access, not the page\'s own JS variables) and return the JSON-serializable result. Only available when the user enabled it in Settings.',
    input_schema: { type: 'object', properties: { tab_id: tabId, code: { type: 'string', description: 'An expression or an async function body ending with return.' } }, required: ['code'] },
  },
];

const ACCESS_RANK = { off: 0, read: 1, ask: 2, full: 3 };
const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// Minimal input validation (required keys + primitive types) — tool inputs can arrive from a model or an MCP client.
function validateInput(tool, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  const { properties = {}, required = [] } = tool.input_schema;
  for (const key of required) if (input[key] === undefined || input[key] === null || input[key] === '') return `missing required field: ${key}`;
  for (const [key, value] of Object.entries(input)) {
    const spec = properties[key];
    if (!spec) return `unknown field: ${key}`;
    const t = spec.type;
    if (t === 'string' && typeof value !== 'string') return `${key} must be a string`;
    if (t === 'integer' && !Number.isInteger(value)) return `${key} must be an integer`;
    if (t === 'number' && typeof value !== 'number') return `${key} must be a number`;
    if (t === 'boolean' && typeof value !== 'boolean') return `${key} must be a boolean`;
    if (spec.enum && !spec.enum.includes(value)) return `${key} must be one of ${spec.enum.join(', ')}`;
    if (typeof value === 'string' && value.length > 200_000) return `${key} is too long`;
  }
  return null;
}

module.exports = { TOOLS, byName, ACCESS_RANK, validateInput };
