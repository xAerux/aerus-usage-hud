import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as requireHttp from 'node:http';
import { once } from 'node:events';
import { scanCodex } from '../src/codex.js';
import { scanClaude } from '../src/claude.js';
import { emptyStore, loadStore, saveStore } from '../src/account-store.js';

const fixtures = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aerus-regression-'));
  fixtures.push(dir);
  return dir;
};
process.on('exit', () => fixtures.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
const total = x => x.events.reduce((n, event) => n + event.total, 0);

test('mixed Codex cumulative plus last-count records count each token once', async () => {
  const root = temp();
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date().toISOString();
  const counter = (last, count) => ({ type: 'event_msg', timestamp: t, payload: {
    type: 'token_count', info: {
      ...(last == null ? {} : { last_token_usage: { input_tokens: last, output_tokens: 0 } }),
      total_token_usage: { input_tokens: count, output_tokens: 0 },
    },
  } });
  fs.writeFileSync(path.join(dir, 'mixed.jsonl'), [
    counter(null, 100), counter(20, 120), counter(null, 130),
  ].map(v => JSON.stringify(v)).join('\n') + '\n');
  const found = await scanCodex(root);
  assert.equal(total(found), 130);
});

test('concurrent account snapshot writes use distinct temporary files', async () => {
  const root = temp();
  const writes = Array.from({ length: 16 }, (_, i) => {
    const state = emptyStore();
    state.ollama = { total: i };
    return saveStore(root, state);
  });
  await Promise.all(writes);
  const loaded = await loadStore(root);
  assert.ok(Number.isInteger(loaded.ollama.total));
  assert.ok(loaded.ollama.total >= 0 && loaded.ollama.total < 16);
  assert.equal(fs.readdirSync(root).filter(name => name.endsWith('.tmp')).length, 0);
});

test('damaged existing Claude ledger is reported, never shown as a clean zero, and remains byte-identical', async () => {
  const claudeDir = temp();
  const dataDir = temp();
  const file = path.join(dataDir, 'claude-ledger.json');
  fs.writeFileSync(file, '{broken ledger');
  const scan = await scanClaude({ claudeDir, dataDir });
  assert.equal(scan.degraded, 'corrupt');
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken ledger');
});

test('bad static URI returns 400 while HTTP server remains alive', async () => {
  const root = temp();
  const child = spawn(process.execPath, ['server.js', '--no-open'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: '18979',
      AERUS_ACCOUNT_LOOKUP: 'off',
      AERUS_DATA_DIR: root,
      AERUS_CODEX_DIR: path.join(root, 'codex'),
      AERUS_CLAUDE_DIR: path.join(root, 'claude'),
      AERU_OLLAMA_CAPTURE_DIR: path.join(root, 'ollama'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  try {
    const deadline = Date.now() + 5000;
    while (!output.includes('Dashboard  http://') && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(output);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(output, /Dashboard  http:\/\//);
    const host = output.match(/Dashboard  (http:\/\/[^\s]+)/)[1];
    const invalid = await fetch(host + '/%');
    assert.equal(invalid.status, 400);
    const valid = await fetch(host + '/api/usage');
    assert.equal(valid.status, 200);
    const hostile = await new Promise((resolve, reject) => {
      const req = requireHttp.get(host + '/api/usage', { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
    });
    assert.equal(hostile, 403);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))]);
  }
});
