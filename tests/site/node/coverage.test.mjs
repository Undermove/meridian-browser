// The coverage mapper the browser suite trusts: V8 ranges -> missed HTML lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inlineScripts, ranByte, report, ranges, allowed } from '../web/coverage.mjs';

test('inlineScripts skips src, JSON-LD and empty scripts', () => {
  const html = '<script src="a.js"></script><script type="application/ld+json">{}</script><script> </script><script>go()</script>';
  const found = inlineScripts(html);
  assert.equal(found.length, 1);
  assert.equal(html.slice(...found[0]), 'go()');
});

test('ranByte: the innermost range decides', () => {
  const src = 'if (a) { b() } else { c() }';
  const fns = [{ ranges: [
    { startOffset: 0, endOffset: src.length, count: 1 },
    { startOffset: src.indexOf('else') + 5, endOffset: src.length, count: 0 },
  ] }];
  const bytes = ranByte(src, fns);
  assert.equal(bytes[src.indexOf('b()')], 1);
  assert.equal(bytes[src.indexOf('c()')], 0);
});

test('ranByte: of two ranges with the same start, the shorter one is inner', () => {
  const src = 'skip(); run();';
  const fns = [{ ranges: [
    { startOffset: 0, endOffset: 7, count: 0 },
    { startOffset: 0, endOffset: src.length, count: 1 },
  ] }];
  const bytes = ranByte(src, fns);
  assert.equal(bytes[src.indexOf('skip')], 0);
  assert.equal(bytes[src.indexOf('run')], 1);
});

test('report: lines map into the page; changed copies of a script are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-'));
  const body = '\nran();\nif (x) {\n  never();\n}\n';
  fs.writeFileSync(path.join(dir, 'p.html'), `<p>hi</p>\n<script>${body}</script>\n`);
  const entry = (source, ranges) => ({ url: '/p.html', source, functions: [{ ranges }] });
  const never = body.indexOf('{');
  const res = report([
    entry(body, [{ startOffset: 0, endOffset: body.length, count: 1 }, { startOffset: never, endOffset: never + 14, count: 0 }]),
    entry(body.replace('ran', 'RAN'), [{ startOffset: 0, endOffset: body.length, count: 1 }]),
  ], ['p.html'], dir);
  assert.deepEqual([...res['p.html'].code].sort(), [3, 4, 5]);
  assert.deepEqual([...res['p.html'].missed], [5]);
});

test('ranges joins consecutive lines', () => {
  assert.deepEqual(ranges(new Set([7, 3, 4, 5, 9])), ['3-5', '7', '9']);
});

test('allowed: an exclusion names its line by code, and must match exactly one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-'));
  fs.writeFileSync(path.join(dir, 'p.html'), 'a();\nguard();\nb();\nb();\n');
  const ex = { 'p.html': [{ code: 'guard()' }, { code: 'b()' }, { code: 'gone()' }] };
  const { set, problems } = allowed('p.html', ex, dir);
  assert.deepEqual([...set], [2]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /matches 2 lines/);
  assert.match(problems[1], /matches 0 lines/);
});

test('report: the same script served by another page counts for this one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-'));
  const body = '\nshared();\n';
  fs.writeFileSync(path.join(dir, 'p.html'), `<script>${body}</script>\n`);
  const res = report([{ url: '/ru/p.html', source: body, functions: [{ ranges: [{ startOffset: 0, endOffset: body.length, count: 1 }] }] }], ['p.html'], dir);
  assert.deepEqual([...res['p.html'].missed], []);
  assert.deepEqual([...res['p.html'].code], [2]);
});
