import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withFileLock, writeFileAtomic } from '../src/atomic-write.js';

const temps = [];
after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aerus-atomic-'));
  temps.push(dir);
  return dir;
};
const leftovers = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));

test('64 overlapping writers leave one complete document and no temp files', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  await Promise.all(Array.from({ length: 64 }, (_, i) => writeFileAtomic(file, JSON.stringify({ writer: i, pad: 'x'.repeat(5000) }))));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(parsed.writer >= 0 && parsed.writer < 64);
  assert.equal(parsed.pad.length, 5000);
  assert.deepEqual(leftovers(dir), []);
});

test('writers to one file apply in call order', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomic(file, String(i))));
  assert.equal(fs.readFileSync(file, 'utf8'), '19');
});

test('a transient rename failure (locked target on Windows) is retried', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  let calls = 0;
  const rename = async (from, to) => {
    calls += 1;
    if (calls <= 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return fsp.rename(from, to);
  };
  await writeFileAtomic(file, 'ok', { rename });
  assert.equal(calls, 4);
  assert.equal(fs.readFileSync(file, 'utf8'), 'ok');
  assert.deepEqual(leftovers(dir), []);
});

test('a permanent rename failure surfaces, keeps the old file and removes the temp file', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, 'old');
  const rename = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(writeFileAtomic(file, 'new', { rename }), /disk full/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  assert.deepEqual(leftovers(dir), []);
});

test('a failed task does not block the next one for the same key', async () => {
  const order = [];
  const first = withFileLock('k', async () => { order.push('first'); throw new Error('boom'); });
  const second = withFileLock('k', async () => { order.push('second'); return 2; });
  await assert.rejects(first, /boom/);
  assert.equal(await second, 2);
  assert.deepEqual(order, ['first', 'second']);
});
