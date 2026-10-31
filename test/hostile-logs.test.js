// Log files are written by other programs (and can be damaged or planted), so the HUD must stay bounded and
// must not store nonsense that would then be shown, and summed, forever.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundedLines } from '../src/bounded-lines.js';
import { scanClaude, mergeRecord } from '../src/claude.js';
import { scanCodex, } from '../src/codex.js';
import { codexCandidates } from '../src/codex-account.js';
import { clip, parseTime, shortPath, tokenCount } from '../src/util.js';

const temps = [];
after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aerus-hostile-'));
  temps.push(dir);
  return dir;
};

async function collect(text, max) {
  const file = path.join(tempDir(), 'lines.txt');
  fs.writeFileSync(file, text);
  const out = [];
  for await (const line of boundedLines(file, max)) out.push(line);
  return out;
}

test('boundedLines splits on LF and CRLF and keeps a final line without a newline', async () => {
  assert.deepEqual(await collect('a\nb\r\nc', 100), ['a', 'b', 'c']);
  assert.deepEqual(await collect('a\n\nb\n', 100), ['a', '', 'b']);
  assert.deepEqual(await collect('', 100), []);
});

test('boundedLines drops only the lines over the limit, wherever they fall', async () => {
  const long = 'x'.repeat(50);
  assert.deepEqual(await collect(`ok\n${long}\nnext\n`, 10), ['ok', 'next']);
  assert.deepEqual(await collect(`${long}\nafter\n`, 10), ['after']);
  assert.deepEqual(await collect(`ok\n${long}`, 10), ['ok'], 'an over-long unterminated final line is dropped');
  assert.deepEqual(await collect('1234567890\n12345678901\n', 10), ['1234567890'], 'the limit is inclusive');
});

test('boundedLines handles a line that spans many read chunks', async () => {
  const huge = 'y'.repeat(300_000);
  assert.deepEqual(await collect(`start\n${huge}\nend\n`, 1000), ['start', 'end']);
  const fits = 'z'.repeat(200_000);
  assert.deepEqual((await collect(`${fits}\n`, 250_000)).map((line) => line.length), [200_000]);
});

test('clip, tokenCount, parseTime and shortPath bound what log files can inject', () => {
  assert.equal(clip('x'.repeat(5000)).length, 200);
  assert.equal(clip(null), '');
  assert.equal(tokenCount(1e300), 0);
  assert.equal(tokenCount(1e12), 1e12);
  assert.equal(tokenCount(-3), 0);
  assert.equal(tokenCount('12'), 12);
  const now = Date.UTC(2026, 9, 24);
  assert.equal(parseTime('2026-10-24T00:00:00Z', now), now);
  assert.equal(parseTime('+275760-09-13T00:00:00.000Z', now), null);
  assert.equal(parseTime('1970-01-02T00:00:00Z', now), null);
  assert.equal(parseTime(now + 2 * 86_400_000, now), null);
  assert.equal(shortPath('C:\\Users\\me\\.codex', 'C:\\Users\\me'), '~/.codex');
  assert.equal(shortPath('/home/me/.codex', '/home/me'), '~/.codex');
  assert.equal(shortPath('/home/me2/.codex', '/home/me'), '/home/me2/.codex');
  assert.equal(shortPath('/srv/data', '/home/me'), '/srv/data');
});

const claudeLine = (over = {}) => JSON.stringify({
  type: 'assistant', timestamp: new Date().toISOString(), sessionId: 's', cwd: '/work/demo',
  message: { id: 'm1', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 0 }, ...over.message }, ...over.top,
});

function claudeHome(lines) {
  const claudeDir = tempDir();
  fs.mkdirSync(path.join(claudeDir, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'projects', 'p', 'a.jsonl'), lines.join('\n') + '\n');
  return claudeDir;
}

test('a message id of __proto__ is an ordinary key: counted, saved, and prototypes untouched', async () => {
  const claudeDir = claudeHome([claudeLine({ message: { id: '__proto__', usage: { input_tokens: 40, output_tokens: 0 } } }), claudeLine({ message: { id: 'constructor', usage: { input_tokens: 2, output_tokens: 0 } } })]);
  const dataDir = tempDir();
  const scan = await scanClaude({ claudeDir, dataDir });
  assert.equal(scan.events.reduce((n, event) => n + event.total, 0), 42);
  assert.equal({}.input, undefined, 'Object.prototype was not modified');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-ledger.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.records).sort(), ['__proto__', 'constructor']);
  const again = await scanClaude({ claudeDir, dataDir });
  assert.equal(again.events.reduce((n, event) => n + event.total, 0), 42, 'and after a reload from disk');
});

test('mergeRecord keeps the larger output for a __proto__ id', () => {
  const records = {};
  const base = { at: 1, sessionId: 's', cwd: '', model: 'm', input: 1, cacheRead: 0, cw5m: 0, cw1h: 0 };
  assert.equal(mergeRecord(records, { ...base, id: '__proto__', output: 5 }), true);
  assert.equal(mergeRecord(records, { ...base, id: '__proto__', output: 3 }), false);
  assert.equal(mergeRecord(records, { ...base, id: '__proto__', output: 9 }), true);
  assert.equal(Object.keys(records).length, 1);
});

test('absurd counters and timestamps are never stored in the ledger', async () => {
  const claudeDir = claudeHome([
    claudeLine({ message: { id: 'huge', usage: { input_tokens: 1e300, output_tokens: 0 } } }),
    claudeLine({ message: { id: 'future' }, top: { timestamp: '+275760-09-13T00:00:00.000Z' } }),
    claudeLine({ message: { id: 'ancient' }, top: { timestamp: '1970-01-02T00:00:00Z' } }),
    claudeLine({ message: { id: 'fine', usage: { input_tokens: 7, output_tokens: 0 } } }),
  ]);
  const dataDir = tempDir();
  const scan = await scanClaude({ claudeDir, dataDir });
  assert.deepEqual(scan.events.map((event) => event.total), [7]);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-ledger.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.records), ['fine']);
});

test('free-text fields from logs are clipped before they are stored', async () => {
  const claudeDir = claudeHome([claudeLine({ message: { id: 'i'.repeat(5000), model: 'm'.repeat(5000) }, top: { cwd: '/work/' + 'd'.repeat(5000), sessionId: 's'.repeat(5000) } })]);
  const dataDir = tempDir();
  await scanClaude({ claudeDir, dataDir });
  const [record] = Object.values(JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-ledger.json'), 'utf8')).records);
  assert.ok(record.id.length <= 200 && record.model.length <= 100 && record.sessionId.length <= 200 && record.cwd.length <= 500);
});

test('a multi-megabyte junk line does not stop the lines around it from being read', async () => {
  const claudeDir = claudeHome([claudeLine({ message: { id: 'before' } }), `{"type":"assistant","usage":"${'q'.repeat(9_000_000)}"}`, claudeLine({ message: { id: 'after' } })]);
  const scan = await scanClaude({ claudeDir, dataDir: tempDir() });
  assert.equal(scan.events.length, 2);
  const codexHome = tempDir();
  fs.mkdirSync(path.join(codexHome, 'sessions'));
  fs.writeFileSync(path.join(codexHome, 'sessions', 'x.jsonl'), `${'z'.repeat(3_000_000)}token_count\n`);
  assert.equal((await scanCodex(codexHome)).events.length, 0);
});

test('a PATH entry that is empty or relative is never searched for the Codex program', () => {
  const work = tempDir();
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  fs.mkdirSync(path.join(work, 'rel'));
  fs.writeFileSync(path.join(work, 'rel', exe), '');
  fs.writeFileSync(path.join(work, exe), '');
  const before = process.cwd();
  const savedPath = process.env.PATH;
  const savedCli = process.env.CODEX_CLI_PATH;
  try {
    process.chdir(work);
    delete process.env.CODEX_CLI_PATH;
    process.env.PATH = ['', 'rel', '.', path.join(work, 'rel')].join(path.delimiter);
    const found = codexCandidates().filter((candidate) => candidate.startsWith(work));
    assert.deepEqual(found, [path.join(work, 'rel', exe)], 'only the absolute entry is used');
  } finally {
    process.chdir(before);
    process.env.PATH = savedPath;
    if (savedCli !== undefined) process.env.CODEX_CLI_PATH = savedCli;
  }
});
