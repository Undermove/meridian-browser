// Sites that break when a tracker script is blocked: they load it as part of their own code (a dynamic
// import that fails takes the page down with it). Each exception applies only on that site. Added to the
// Ghostery engine in main.js (getBlocker).
const SITE_FIXES = [
  // New Reddit imports its Sentry error reporter as a module; blocked, /settings and other pages stay blank.
  // Any request type: a dynamic import isn't always typed 'script'.
  '@@||redditstatic.com/shreddit/sentry-$domain=reddit.com',
];

module.exports = { SITE_FIXES };
