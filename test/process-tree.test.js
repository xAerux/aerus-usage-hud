import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopChild } from '../src/codex-account.js';
import { scanClaude } from '../src/claude.js';

const temps = [];
after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aerus-tree-'));
  temps.push(dir);
  return dir;
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('stopChild ends the program and, on Windows, the processes it started', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempDir();
  const script = path.join(dir, 'parent.mjs');
  fs.writeFileSync(script, [
    "import { spawn } from 'node:child_process';",
    "const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "console.log('KID ' + kid.pid);",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const parent = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
  let text = '';
  parent.stdout.on('data', (data) => { text += data; });
  const deadline = Date.now() + 8000;
  while (!/KID \d+/.test(text) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const kid = Number(/KID (\d+)/.exec(text)?.[1]);
  assert.ok(kid > 0 && alive(kid), 'grandchild is running');
  stopChild(parent);
  await Promise.race([once(parent, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
  const gone = Date.now() + 5000;
  while (alive(kid) && Date.now() < gone) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(kid), false, 'the grandchild was ended with its parent');
  if (alive(kid)) process.kill(kid);
});

test('stopChild does nothing for a program that has already exited', async () => {
  const parent = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await once(parent, 'exit');
  assert.doesNotThrow(() => stopChild(parent));
  assert.doesNotThrow(() => stopChild(undefined));
});

test('a record that an older build saved with an impossible counter or time is not counted', async () => {
  const claudeDir = tempDir();
  const dataDir = tempDir();
  const now = Date.now();
  const base = { sessionId: 's', cwd: '', model: 'claude-sonnet-4-5', cacheRead: 0, cw5m: 0, cw1h: 0, output: 0 };
  const records = {
    ok: { ...base, id: 'ok', at: now, input: 5 },
    huge: { ...base, id: 'huge', at: now, input: 1e300 },
    future: { ...base, id: 'future', at: 8.64e15, input: 5 },
  };
  const file = path.join(dataDir, 'claude-ledger.json');
  const saved = JSON.stringify({ version: 1, records });
  fs.writeFileSync(file, saved);
  const scan = await scanClaude({ claudeDir, dataDir });
  assert.deepEqual(scan.events.map((event) => event.total), [5]);
  assert.equal(fs.readFileSync(file, 'utf8'), saved, 'the stored file is not rewritten');
});
