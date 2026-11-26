// src/renderer/dev/secret-detect.js scans text the user pastes into a terminal or the assistant,
// and .env files: arbitrary text. find() must not throw, and its matches must be real, sorted and
// non-overlapping; mask() must never show more than 4 + 2 characters of a value.
const { FuzzedDataProvider } = require('@jazzer.js/core');
const S = require('../src/renderer/dev/secret-detect.js');

module.exports.fuzz = function (data) {
  const fdp = new FuzzedDataProvider(data);
  const name = fdp.consumeString(fdp.consumeIntegralInRange(0, 80), 'utf-8');
  const text = fdp.consumeRemainingAsString();

  const hits = S.find(text);
  let end = 0;
  for (const h of hits) {
    if (!(h.start >= end && h.end > h.start && h.end <= text.length)) throw new Error(`bad range ${h.start}..${h.end}`);
    if (text.slice(h.start, h.end) !== h.value) throw new Error('value is not the text at its range');
    if (typeof h.name !== 'string' || typeof h.kind !== 'string') throw new Error('missing name/kind');
    end = h.end;
    const m = S.mask(h.value);
    const shown = m.replace(/…| \(\d+ chars\)|••••/g, '');
    if (shown.length > 6) throw new Error(`mask shows too much: ${m}`);
  }
  if (!S.NAME_RE.test(S.cleanName(name))) throw new Error(`cleanName(${JSON.stringify(name)}) is not a valid name`);
};
