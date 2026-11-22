// The Chromium watcher's decisions (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './chromium_watch.mjs';

const day = 86400000;
const now = new Date('2026-11-20T00:00:00Z');
const rel = (channel, version, ago) => ({ channel, version, milestone: Number(version.split('.')[0]), time: now - ago * day });

test('up to date: nothing to do', () => {
  const r = decide('158.0.8127.5', [rel('Stable', '157.0.8103.30', 3), rel('Beta', '158.0.8127.5', 2)], now);
  assert.equal(r.action, 'none');
});

test('a newer build of our branch: rebuild, urgent after two weeks', () => {
  let r = decide('158.0.8127.5', [rel('Stable', '157.0.8103.30', 3), rel('Beta', '158.0.8127.9', 2), rel('Beta', '158.0.8127.7', 5)], now);
  assert.equal(r.action, 'patch');
  assert.equal(r.version, '158.0.8127.9');
  assert.equal(r.urgent, false);
  assert.match(r.title, /Chromium 158\.0\.8127\.9 is out/);
  r = decide('158.0.8127.5', [rel('Stable', '158.0.8127.20', 15)], now);
  assert.equal(r.urgent, true);
});

test('a newer branch is stable: move to it', () => {
  const r = decide('158.0.8127.40', [rel('Stable', '159.0.8160.12', 20), rel('Stable', '159.0.8160.30', 1), rel('Stable', '158.0.8127.41', 25)], now);
  assert.equal(r.action, 'milestone');
  assert.equal(r.branch, 8160);
  assert.equal(r.urgent, true);
  assert.match(r.body, /--branch 8160/);
});

test('other branches and older builds are ignored', () => {
  const r = decide('158.0.8127.5', [rel('Stable', '157.0.8103.40', 1), rel('Beta', '158.0.8127.3', 1), rel('Beta', '158.0.8128.1', 1)], now);
  assert.equal(r.action, 'none');
});
