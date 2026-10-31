// Token conservation matrix for Codex rollout files. Every case writes synthetic JSONL, scans it through
// scanCodex and compares the summed event totals with the number of tokens the fixture really used.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCodex } from '../src/codex.js';

const temps = [];
after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

let clock = Date.UTC(2026, 8, 1, 12, 0, 0);
const stamp = () => new Date((clock += 1000)).toISOString();

const usage = (input, output = 0, cached = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached });
const count = ({ last, total, at = stamp() }) => ({
  type: 'event_msg',
  timestamp: at,
  payload: { type: 'token_count', info: { ...(last ? { last_token_usage: last } : {}), ...(total ? { total_token_usage: total } : {}) } },
});
const meta = (id) => ({ type: 'session_meta', timestamp: stamp(), payload: { id, cwd: '/work/demo', model: 'gpt-5' } });

function codexHome(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aerus-codex-'));
  temps.push(home);
  for (const [name, lines] of Object.entries(files)) {
    const file = path.join(home, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  }
  return home;
}

const sum = (scan) => scan.events.reduce((n, event) => n + event.total, 0);

const single = (id, lines) => codexHome({ [`sessions/${id}.jsonl`]: [meta(id), ...lines] });

const matrix = [
  ['cumulative only', 200, () => [count({ total: usage(100) }), count({ total: usage(150) }), count({ total: usage(200) })]],
  ['cumulative only, unchanged repeat adds nothing', 150, () => [count({ total: usage(100) }), count({ total: usage(150) }), count({ total: usage(150) })]],
  ['last only', 50, () => [count({ last: usage(20) }), count({ last: usage(30) })]],
  ['last and total together', 130, () => [count({ last: usage(100), total: usage(100) }), count({ last: usage(30), total: usage(130) })]],
  ['mixed: total, then last+total, then total', 130, () => [count({ total: usage(100) }), count({ last: usage(20), total: usage(120) }), count({ total: usage(130) })]],
  ['replayed notification (same last and total twice)', 100, () => [count({ last: usage(100), total: usage(100) }), count({ last: usage(100), total: usage(100) })]],
  ['replayed notification in the middle of a run', 130, () => [
    count({ last: usage(100), total: usage(100) }), count({ last: usage(20), total: usage(120) }),
    count({ last: usage(20), total: usage(120) }), count({ last: usage(10), total: usage(130) })]],
  ['cumulative total reset (new context) counts the new run from zero', 280, () => [
    count({ total: usage(100) }), count({ total: usage(200) }), count({ total: usage(50) }), count({ total: usage(80) })]],
  ['last+total reset still charges the delta', 240, () => [count({ last: usage(200), total: usage(200) }), count({ last: usage(40), total: usage(40) })]],
  ['a turn with no new tokens adds nothing', 100, () => [count({ last: usage(100), total: usage(100) }), count({ last: usage(0), total: usage(100) })]],
  ['cached input is part of the total, once', 100, () => [count({ last: usage(100, 0, 60), total: usage(100, 0, 60) })]],
  ['output tokens count', 150, () => [count({ last: usage(100, 50), total: usage(100, 50) })]],
  ['events without a usable timestamp are skipped', 50, () => [count({ last: usage(50) }), { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage(999) } } }]],
  ['non-count records and null info are ignored', 40, () => [
    { type: 'event_msg', timestamp: stamp(), payload: { type: 'agent_message', message: 'token_count' } },
    { type: 'event_msg', timestamp: stamp(), payload: { type: 'token_count', info: null } },
    count({ last: usage(40) })]],
  ['a truncated final line is ignored, earlier lines still count', 30, () => [count({ last: usage(30) }), '{"type":"event_msg","payload":{"type":"token_count","info":{"last_tok']],
  ['garbage lines between records are ignored', 30, () => [count({ last: usage(10) }), 'not json token_count', count({ last: usage(20) })]],
  ['negative counters never reduce the total', 20, () => [count({ last: usage(20) }), count({ last: usage(-500) })]],
  ['string and missing counters are tolerated', 10, () => [count({ last: { input_tokens: '10' } }), count({ last: {} })]],
  ['a line over the size bound is skipped without aborting the file', 25, () => [count({ last: usage(25) }), `{"type":"event_msg","pad":"${'x'.repeat(2_100_000)}token_count"}`]],
];

for (const [name, expected, build] of matrix) {
  test(`conserves tokens: ${name}`, async () => {
    const scan = await scanCodex(single(`matrix-${Math.random().toString(36).slice(2)}`, build()));
    assert.equal(sum(scan), expected);
    for (const event of scan.events) {
      assert.ok(event.input >= 0 && event.output >= 0 && event.cacheRead >= 0, 'no negative components');
      assert.equal(event.total, event.input + event.output + event.cacheRead);
    }
  });
}

test('an empty file produces no events and does not throw', async () => {
  const home = codexHome({ 'sessions/empty.jsonl': [] });
  fs.writeFileSync(path.join(home, 'sessions', 'empty.jsonl'), '');
  assert.equal(sum(await scanCodex(home)), 0);
});

test('timestamps out of order do not change what is counted', async () => {
  const early = new Date(Date.UTC(2026, 8, 1, 9)).toISOString();
  const late = new Date(Date.UTC(2026, 8, 1, 15)).toISOString();
  const scan = await scanCodex(single('ooo', [count({ last: usage(10), at: late }), count({ last: usage(20), at: early })]));
  assert.equal(sum(scan), 30);
});

test('cached reads are real usage and are priced at the cached rate, not also as fresh input', async () => {
  const scan = await scanCodex(single('cache', [count({ last: usage(1_000_000, 0, 1_000_000), total: usage(1_000_000, 0, 1_000_000) })]));
  assert.equal(scan.events[0].cacheRead, 1_000_000);
  assert.equal(scan.events[0].input, 0);
  assert.equal(scan.events[0].total, 1_000_000);
  assert.ok(scan.events[0].cost < 1, 'cached tokens are billed at the cached rate');
});

test('an archived copy of an active session is counted once', async () => {
  const lines = [meta('dup'), count({ last: usage(40), total: usage(40) }), count({ last: usage(60), total: usage(100) })];
  const home = codexHome({ 'sessions/a.jsonl': lines, 'archived_sessions/a.jsonl': lines });
  assert.equal(sum(await scanCodex(home)), 100);
});

test('an archived copy that is a shorter prefix of the active session is counted once', async () => {
  const first = count({ last: usage(40), total: usage(40) });
  const second = count({ last: usage(60), total: usage(100) });
  const home = codexHome({ 'sessions/a.jsonl': [meta('dup'), first, second], 'archived_sessions/a.jsonl': [meta('dup'), first] });
  assert.equal(sum(await scanCodex(home)), 100);
});

test('one session id spread over two non-overlapping files keeps all of its usage', async () => {
  const home = codexHome({
    'sessions/part1.jsonl': [meta('split'), count({ last: usage(40), total: usage(40) })],
    'archived_sessions/part2.jsonl': [meta('split'), count({ last: usage(60), total: usage(100) })],
  });
  assert.equal(sum(await scanCodex(home)), 100);
});

test('different sessions with identical numbers are different usage', async () => {
  const at = stamp();
  const home = codexHome({
    'sessions/a.jsonl': [meta('one'), count({ last: usage(10), at })],
    'sessions/b.jsonl': [meta('two'), count({ last: usage(10), at })],
  });
  assert.equal(sum(await scanCodex(home)), 20);
});
