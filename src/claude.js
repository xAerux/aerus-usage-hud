// Claude Code history: ~/.claude/projects/**/*.jsonl (assistant messages carry a usage object).
//
// Two things matter here:
// 1. Claude Code writes several records per API message while it streams. Records are keyed by
//    message.id and only the record with the highest output_tokens is kept, so nothing is double counted.
// 2. Claude Code prunes old transcripts (about 30 days by default). Every message seen is saved to a
//    local ledger in the HUD data folder, so All Time totals keep history after the source is pruned.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { boundedLines } from './bounded-lines.js';
import { claudeCost } from './pricing.js';
import { clip, isDirectory, listJsonl, normalizeModel, parseTime, projectFromCwd, tokenCount } from './util.js';

const LEDGER_VERSION = 1;
// A transcript line longer than this is not a usage record; it is skipped without being held in memory.
const MAX_LINE_CHARS = 8_000_000;

// Thrown when a ledger file exists but cannot be trusted. The file is left exactly as found.
// kind: 'unreadable' | 'corrupt' | 'unsupported'
export class LedgerError extends Error {
  constructor(kind, file, options) {
    super(`Claude history ledger ${kind} at ${file}; original retained`, options);
    this.name = 'LedgerError';
    this.kind = kind;
  }
}

export function defaultClaudeDir() {
  return process.env.AERUS_CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Scans run one at a time, so two open tabs cannot write the ledger at the same time.
let queue = Promise.resolve();

export function scanClaude(options) {
  const run = queue.then(() => scanClaudeNow(options));
  queue = run.catch(() => {});
  return run;
}

const fileCache = new Map();

async function scanClaudeNow({ claudeDir = defaultClaudeDir(), dataDir }) {
  const projectsDir = path.join(claudeDir, 'projects');
  const found = await isDirectory(projectsDir);
  const ledgerFile = path.join(dataDir, 'claude-ledger.json');
  // A ledger that exists but cannot be trusted is never replaced and never treated as an empty history.
  // The scan still reports what the transcripts on disk show, flagged as degraded and not saved, so the
  // rest of the dashboard keeps working and the damaged file stays exactly as found.
  let ledger;
  let degraded = null;
  try {
    ledger = await loadLedgerCached(ledgerFile);
  } catch (error) {
    if (!(error instanceof LedgerError)) throw error;
    degraded = error.kind;
    ledger = { version: LEDGER_VERSION, records: {} };
  }
  const files = found ? await listJsonl(projectsDir) : [];

  let changed = false;
  try {
    for (const file of files) {
      for (const rec of await readFileRecords(file)) {
        if (mergeRecord(ledger.records, rec)) changed = true;
      }
    }
  } catch (error) {
    ledgerCache = null; // records merged in memory but never saved
    throw error;
  }
  if (changed && !degraded) await saveLedger(ledgerFile, ledger);

  // A record already saved with an impossible counter or time (an older build stored such values) is left in
  // the file but not counted or shown.
  const events = Object.values(ledger.records).filter(plausible).map(toEvent);
  return { found, files: files.length, events, ledgerRecords: events.length, degraded };
}

// Returns true when the stored record was added or replaced.
export function mergeRecord(records, rec) {
  // Message ids come from log files, so '__proto__' or 'constructor' must be ordinary keys.
  const prior = Object.hasOwn(records, rec.id) ? records[rec.id] : undefined;
  if (prior && prior.output >= rec.output) return false;
  Object.defineProperty(records, rec.id, { enumerable: true, writable: true, configurable: true, value: {
    id: rec.id,
    at: rec.at,
    sessionId: rec.sessionId,
    cwd: rec.cwd,
    model: rec.model,
    input: rec.input,
    output: rec.output,
    cacheRead: rec.cacheRead,
    cw5m: rec.cw5m,
    cw1h: rec.cw1h,
  } });
  return true;
}

function plausible(rec) {
  const counters = [rec.input, rec.output, rec.cacheRead, rec.cw5m, rec.cw1h];
  return counters.every((n) => Number.isFinite(n) && n >= 0 && n <= 1e12) && parseTime(rec.at) !== null;
}

export function toEvent(rec) {
  const cacheWrite = rec.cw5m + rec.cw1h;
  return {
    provider: 'claude',
    at: rec.at,
    sessionId: rec.sessionId,
    project: projectFromCwd(rec.cwd),
    model: rec.model,
    input: rec.input,
    output: rec.output,
    cacheRead: rec.cacheRead,
    cacheWrite,
    total: rec.input + rec.output + rec.cacheRead + cacheWrite,
    cost: claudeCost(rec.model, rec),
  };
}

async function readFileRecords(file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return [];
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = fileCache.get(file);
  if (cached && cached.key === key) return cached.records;

  const records = [];
  try {
    for await (const line of boundedLines(file, MAX_LINE_CHARS)) {
      if (!line.includes('"usage"')) continue;
      let json;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      const rec = usageRecord(json, file);
      if (rec) records.push(rec);
    }
  } catch {
    return [];
  }
  fileCache.set(file, { key, records });
  return records;
}

function usageRecord(json, file) {
  if (json.type !== 'assistant') return null;
  const message = json.message;
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const cacheRead = tokenCount(usage.cache_read_input_tokens);
  const cacheCreation = tokenCount(usage.cache_creation_input_tokens);
  if (!input && !output && !cacheRead && !cacheCreation) return null;
  // The 1-hour split is optional. Anything not marked 1-hour is treated as 5-minute.
  const cw1h = tokenCount(usage.cache_creation?.ephemeral_1h_input_tokens);
  const at = parseTime(json.timestamp);
  const id = message.id || json.uuid;
  if (at == null || !id) return null;
  return {
    id: clip(id),
    at,
    sessionId: clip(json.sessionId || path.basename(file, '.jsonl')),
    cwd: clip(json.cwd || '', 500),
    model: normalizeModel(message.model),
    input,
    output,
    cacheRead,
    cw5m: Math.max(0, cacheCreation - cw1h),
    cw1h,
  };
}

// The parsed ledger is kept between scans and reused while the file on disk is exactly what we last read or
// wrote. Re-parsing a large ledger on every refresh was the main cost of repeated /api/usage requests.
let ledgerCache = null;

async function loadLedgerCached(file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    ledgerCache = null;
    if (error.code === 'ENOENT') return { version: LEDGER_VERSION, records: {} };
    throw new LedgerError('unreadable', file, { cause: error });
  }
  if (ledgerCache && ledgerCache.file === file && ledgerCache.mtimeMs === stat.mtimeMs && ledgerCache.size === stat.size) {
    return ledgerCache.ledger;
  }
  ledgerCache = null;
  const ledger = await loadLedger(file);
  ledgerCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, ledger };
  return ledger;
}

async function loadLedger(file) {
  let contents;
  try {
    contents = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: LEDGER_VERSION, records: {} };
    throw new LedgerError('unreadable', file, { cause: error });
  }
  let data;
  try {
    data = JSON.parse(contents);
  } catch (error) {
    throw new LedgerError('corrupt', file, { cause: error });
  }
  if (data?.version === LEDGER_VERSION && data.records &&
      typeof data.records === 'object' && !Array.isArray(data.records)) return data;
  throw new LedgerError('unsupported', file);
}

async function saveLedger(file, ledger) {
  // The cached object has already been changed in memory: if the write fails it must not be trusted.
  ledgerCache = null;
  await writeFileAtomic(file, JSON.stringify(ledger));
  const stat = await fsp.stat(file);
  ledgerCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, ledger };
}
