// The MUTANT hook: a whole browser run against a changed copy of one page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mutantFrom, mutantBody } from '../web/mutant.mjs';

const page = (text) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutant-'));
  fs.writeFileSync(path.join(dir, 'p.html'), text);
  return dir;
};

test('mutantFrom: no MUTANT means no mutant', () => {
  assert.equal(mutantFrom({}), null);
  assert.equal(mutantFrom({ MUTANT: '' }), null);
});

test('mutantFrom: reads file, from and to', () => {
  assert.deepEqual(mutantFrom({ MUTANT: '{"file":"p.html","from":"a","to":"b"}' }), { file: 'p.html', from: 'a', to: 'b' });
});

test('mutantFrom: a mutant without file, from or to is refused', () => {
  assert.throws(() => mutantFrom({ MUTANT: '{"file":"p.html","from":"a"}' }), /MUTANT needs file, from and to/);
  assert.throws(() => mutantFrom({ MUTANT: '{"from":"a","to":"b"}' }), /MUTANT needs file, from and to/);
  assert.throws(() => mutantFrom({ MUTANT: '{"file":"p.html","to":"b"}' }), /MUTANT needs file, from and to/);
});

test('mutantFrom: an empty `to` is allowed (a deletion)', () => {
  assert.deepEqual(mutantFrom({ MUTANT: '{"file":"p.html","from":"a","to":""}' }), { file: 'p.html', from: 'a', to: '' });
});

test('mutantBody: replaces the one occurrence', () => {
  const root = page('x = a + 1;');
  assert.equal(mutantBody({ file: 'p.html', from: 'a + 1', to: 'a - 1' }, root), 'x = a - 1;');
});

test('mutantBody: `from` must occur exactly once', () => {
  const root = page('a; a;');
  assert.throws(() => mutantBody({ file: 'p.html', from: 'a', to: 'b' }, root), /occurs 2 times/);
  assert.throws(() => mutantBody({ file: 'p.html', from: 'zzz', to: 'b' }, root), /occurs 0 times/);
});

test('mutantBody: `to` with $ signs is inserted as is', () => {
  const root = page('x = 1;');
  assert.equal(mutantBody({ file: 'p.html', from: '1', to: "$&$'" }, root), "x = $&$';");
});
