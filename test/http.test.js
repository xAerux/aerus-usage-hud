// Runs the real server.js as a child process on a free loopback port with a throw-away profile
// (no account lookup, no real Codex/Claude/Ollama data) and talks to it over raw HTTP.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRequest } from '../src/http-guard.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
let root;
let child;
let port;
let output = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: chosen } = probe.address();
      probe.close(() => resolve(chosen));
    });
  });
}

// One raw HTTP/1.1 exchange. Returns { status, headers, body } without any client-side URL cleaning.
function raw(requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const [head, ...rest] = text.split('\r\n\r\n');
      const lines = head.split('\r\n');
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(lines[0])?.[1] ?? 0);
      const headers = Object.fromEntries(lines.slice(1).map((line) => {
        const at = line.indexOf(':');
        return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
      }));
      let body = rest.join('\r\n\r\n');
      if (headers['transfer-encoding'] === 'chunked') body = dechunk(body);
      resolve({ status, headers, body });
    });
    socket.write(requestText);
  });
}

function dechunk(text) {
  let out = '';
  let rest = text;
  for (;;) {
    const eol = rest.indexOf('\r\n');
    if (eol < 0) return out;
    const size = parseInt(rest.slice(0, eol), 16);
    if (!size) return out;
    out += rest.slice(eol + 2, eol + 2 + size);
    rest = rest.slice(eol + 2 + size + 2);
  }
}

const request = (target, { method = 'GET', headers = {} } = {}) => {
  const merged = { Host: `127.0.0.1:${port}`, Connection: 'close', ...headers };
  const lines = Object.entries(merged).filter(([, value]) => value !== null).map(([key, value]) => `${key}: ${value}`);
  return raw(`${method} ${target} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
};

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aerus-http-'));
  // One Ollama capture of 100 tokens, in place before the server starts (the reader caches its first answer).
  const captures = path.join(root, 'ollama');
  fs.mkdirSync(captures, { recursive: true });
  const completed = { type: 'response.completed', response: { model: 'local-test', usage: { input_tokens: 80, output_tokens: 20 } } };
  fs.writeFileSync(path.join(captures, '0001-2026-09-20T19-36-30-854Z-RAW-UPSTREAM-SSE.txt'), `data: ${JSON.stringify(completed)}\n`);
  port = await freePort();
  child = spawn(process.execPath, [SERVER, '--no-open'], {
    env: {
      ...process.env,
      PORT: String(port),
      AERUS_ACCOUNT_LOOKUP: 'off',
      AERUS_DATA_DIR: path.join(root, 'data'),
      AERUS_CODEX_DIR: path.join(root, 'codex'),
      AERUS_CLAUDE_DIR: path.join(root, 'claude'),
      AERU_OLLAMA_CAPTURE_DIR: path.join(root, 'ollama'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const deadline = Date.now() + 10_000;
  while (!output.includes('Dashboard  http://')) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // The server moves to the next port if ours was taken between probing and binding; tests must not
  // silently talk to some other listener.
  const announced = Number(/Dashboard  http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1]);
  assert.equal(announced, port, 'server bound the port that was probed');
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('the server answers a normal dashboard page and usage request', async () => {
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  const usage = await request('/api/usage?range=today');
  assert.equal(usage.status, 200);
  assert.ok(JSON.parse(usage.body).totals);
});

test('malformed or hostile request targets never take the process down', async () => {
  const targets = ['/%', '/%E0%A4%A', '/%zz', '/%00', '/..%2f..%2fserver.js', '/%2e%2e/%2e%2e/server.js',
    '/..\\..\\server.js', '/index.html%00.png', '/C:/Windows/win.ini', '//', '/api/usage?range=%', '/api/usage?offset=%E0%A4%A'];
  for (const target of targets) {
    const reply = await request(target);
    assert.ok([200, 400, 403, 404].includes(reply.status), `${target} gave ${reply.status}`);
    assert.ok(!reply.body.includes('createServer'), `${target} must not serve server.js`);
  }
  assert.equal(child.exitCode, null, 'server process is still running');
  assert.equal((await request('/api/usage')).status, 200);
});

test('a percent escape that decodes to a NUL byte is a client error, not a 500', async () => {
  assert.equal((await request('/%00')).status, 400);
});

test('requests whose Host is not this dashboard are refused (DNS rebinding)', async () => {
  const hosts = ['attacker.invalid', `attacker.invalid:${port}`, `127.0.0.1.attacker.invalid:${port}`, `localhost.:${port}`,
    `127.0.0.1:${port + 1}`, '127.0.0.1', `user@127.0.0.1:${port}`, `[::1]:${port}`, `0.0.0.0:${port}`];
  for (const host of hosts) {
    const reply = await request('/api/usage', { headers: { Host: host } });
    assert.equal(reply.status, 403, `Host ${host}`);
    assert.ok(!reply.body.includes('totals'));
  }
  // Node itself answers an HTTP/1.1 request without a Host header with 400; either way nothing is served.
  assert.ok([400, 403].includes((await request('/api/usage', { headers: { Host: null } })).status));
});

test('localhost and the numeric loopback name are both accepted, in any letter case', async () => {
  for (const host of [`localhost:${port}`, `LOCALHOST:${port}`, `127.0.0.1:${port}`]) {
    assert.equal((await request('/api/usage', { headers: { Host: host } })).status, 200, host);
  }
});

test('a foreign or null Origin is refused, the dashboard\'s own Origin is accepted', async () => {
  for (const origin of ['http://attacker.invalid', 'null', 'https://127.0.0.1:' + port, `http://127.0.0.1:${port + 1}`]) {
    assert.equal((await request('/api/usage', { headers: { Origin: origin } })).status, 403, origin);
  }
  assert.equal((await request('/api/usage', { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
});

test('cross-site browser requests to the API are refused, same-origin and address-bar visits are not', async () => {
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await request('/api/usage', { headers: { 'Sec-Fetch-Site': site } })).status, 403, site);
  }
  for (const site of ['same-origin', 'none']) {
    assert.equal((await request('/api/usage', { headers: { 'Sec-Fetch-Site': site } })).status, 200, site);
  }
  assert.equal((await request('/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200, 'following a link to the page still works');
});

test('methods other than GET and HEAD are refused and cause no scan', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const reply = await request('/api/usage', { method, headers: { 'Content-Length': '0' } });
    assert.equal(reply.status, 405, method);
    assert.equal(reply.headers.allow, 'GET, HEAD');
  }
  const head = await request('/api/usage', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('an absolute-form request target is judged by its Host header, not by the URL in the request line', async () => {
  const reply = await request('http://attacker.invalid/api/usage', { headers: { Host: 'attacker.invalid' } });
  assert.equal(reply.status, 403);
});

test('64 overlapping All Time refreshes all succeed and leave one valid snapshot file', async () => {
  const burst = await Promise.all(Array.from({ length: 64 }, () => request('/api/usage?range=all')));
  assert.deepEqual(burst.map((reply) => reply.status), Array(64).fill(200));
  const file = path.join(root, 'data', 'account-snapshots.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.ollama.total, 100);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')).filter((name) => name.endsWith('.tmp')), []);
  const summary = JSON.parse(burst[0].body);
  assert.equal(summary.allTime.ollama.total, 100);
});

test('a damaged saved snapshot is kept aside and reported, not silently replaced', async () => {
  const data = path.join(root, 'data');
  const file = path.join(data, 'account-snapshots.json');
  fs.mkdirSync(data, { recursive: true });
  const damaged = '{"version":1,"current":{"lifetimeTokens":123';
  fs.writeFileSync(file, damaged);
  const reply = await request('/api/usage?range=all');
  assert.equal(reply.status, 200);
  const body = JSON.parse(reply.body);
  assert.ok(body.warnings.some((warning) => /Saved account snapshots were damaged/.test(warning)), JSON.stringify(body.warnings));
  const backups = fs.readdirSync(data).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(data, backups[0]), 'utf8'), damaged);
});

test('a damaged Claude ledger degrades the Claude figures with a warning but the dashboard keeps working', async () => {
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const ledger = path.join(data, 'claude-ledger.json');
  fs.writeFileSync(ledger, '{"version":1,"records":{"m":');
  const reply = await request('/api/usage?range=all');
  assert.equal(reply.status, 200);
  const body = JSON.parse(reply.body);
  assert.ok(body.warnings.some((warning) => /Saved Claude history .* is damaged/.test(warning)), JSON.stringify(body.warnings));
  assert.equal(body.allTime.ollama.total, 100, 'other providers are unaffected');
  assert.equal(fs.readFileSync(ledger, 'utf8'), '{"version":1,"records":{"m":');
});

test('checkRequest accepts port 80 without an explicit port in Host', () => {
  assert.equal(checkRequest({ method: 'GET', pathname: '/', headers: { host: 'localhost' }, port: 80 }).ok, true);
  assert.equal(checkRequest({ method: 'GET', pathname: '/', headers: { host: 'localhost' }, port: 8790 }).ok, false);
});
