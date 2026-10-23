// Sites that break when a tracker script is blocked: they load it as part of their own code (a dynamic
// import that fails takes the page down with it). Each exception is as narrow as the broken file allows. Added to the
// Ghostery engine in main.js (getBlocker).
const SITE_FIXES = [
  // New Reddit imports its Sentry error reporter as a module; blocked, /settings and other pages stay blank.
  // Any request type (a dynamic import isn't always typed 'script') and no $domain: Electron doesn't always
  // report the requesting site, and the exception would silently not apply. The file only exists on Reddit's
  // own static host, so this doesn't open anything up elsewhere.
  '@@||redditstatic.com/shreddit/sentry-',
  // The two json-prune scriptlets the lists inject on reddit.com (stripping outbound-link tracking) wrap the
  // same functions and recurse until the stack overflows, which kills Reddit's own components: the compose
  // form's Send never enables, settings render empty. No scriptlets on Reddit; network blocking stays on.
  'reddit.com#@#+js()',
  // Same on X: the lists inject ten scriptlets there (five json-prune ones among them); with them the composer
  // never renders (/compose/post shows "Something went wrong"). Promoted-post requests are still blocked.
  'x.com#@#+js()',
  'twitter.com#@#+js()',
];

module.exports = { SITE_FIXES };
