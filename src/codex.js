// Codex CLI history: ~/.codex/sessions and archived_sessions (JSONL).
// Each turn is read from last_token_usage (the per-turn delta). Cumulative totals are only used
// as a fallback when no per-turn delta exists, so nothing is counted twice.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boundedLines } from './bounded-lines.js';
import { codexCost } from './pricing.js';
import { clip, isDirectory, listJsonl, normalizeModel, parseTime, projectFromCwd, tokenCount } from './util.js';

// A rollout line longer than this is not a token record; it is skipped without being held in memory.
const MAX_LINE_CHARS = 2_000_000;

export function defaultCodexDir() {
  return process.env.AERUS_CODEX_DIR || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// Parsed file results, keyed by path, so unchanged sessions are not re-read on every open.
const fileCache = new Map();

export async function scanCodex(codexDir = defaultCodexDir()) {
  const found = await isDirectory(codexDir);
  if (!found) return { found, files: 0, events: [] };

  const files = [
    ...(await listJsonl(path.join(codexDir, 'sessions'))),
    ...(await listJsonl(path.join(codexDir, 'archived_sessions'))),
  ];
  // Events already counted for each session id, by identity. The same session can show up in more than one
  // file (an archived copy of an active session, or a log continued in a new file): a copied event counts
  // once, while events that exist in only one of the files all count.
  const seenBySession = new Map();
  const events = [];

  for (const file of files) {
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      continue;
    }
    const key = `${stat.mtimeMs}:${stat.size}:${codexDir}`;
    let cached = fileCache.get(file);
    if (!cached || cached.key !== key) {
      cached = { key, session: await parseCodexFile(file, codexDir) };
      fileCache.set(file, cached);
    }
    const earlier = seenBySession.get(cached.session.sessionId) ?? new Set();
    const here = new Set();
    for (const event of cached.session.events) {
      const key = eventKey(event);
      if (earlier.has(key)) continue;
      here.add(key);
      events.push(event);
    }
    seenBySession.set(cached.session.sessionId, new Set([...earlier, ...here]));
  }
  return { found, files: files.length, events };
}

function eventKey(event) {
  return `${event.at}|${event.input}|${event.output}|${event.cacheRead}`;
}

async function parseCodexFile(file, codexDir) {
  const meta = { id: path.basename(file, '.jsonl'), cwd: '', model: 'unknown' };
  const counts = [];
  try {
    for await (const line of boundedLines(file, MAX_LINE_CHARS)) {
      if (!line) continue;
      if (!line.includes('token_count') && !line.includes('token_usage') && !line.includes('session_meta') && !line.includes('turn_context')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
      if (record.type === 'session_meta') {
        meta.id = clip(payload.id || payload.session_id || meta.id);
        meta.cwd = clip(payload.cwd || meta.cwd, 500);
        if (payload.model) meta.model = normalizeModel(payload.model);
        continue;
      }
      if (record.type === 'turn_context') {
        if (payload.model) meta.model = normalizeModel(payload.model);
        if (payload.cwd) meta.cwd = clip(payload.cwd, 500);
        continue;
      }
      const info = payload.info && typeof payload.info === 'object' ? payload.info : payload;
      const isCount =
        (record.type === 'event_msg' && (payload.type === 'token_count' || payload.type === 'token_usage')) ||
        record.type === 'token_count';
      if (!isCount) continue;
      counts.push({
        last: info.last_token_usage || payload.last_token_usage,
        total: info.total_token_usage || payload.total_token_usage,
        model: normalizeModel(info.model || payload.model || meta.model),
        at: parseTime(record.timestamp || payload.timestamp || record.time),
      });
    }
  } catch {
    return { sessionId: meta.id, events: [] };
  }

  const project = projectFromCwd(meta.cwd, codexDir);
  const events = [];
  let prev = null;
  for (const count of counts) {
    let tokens = null;
    const cur = count.total ? codexTokens(count.total) : null;
    if (count.last) {
      // The same notification delivered twice carries an unchanged cumulative total: not new usage.
      if (cur && prev && cur.total === prev.total && cur.input === prev.input && cur.output === prev.output) continue;
      tokens = codexTokens(count.last);
      // Last usage is the delta; total, when supplied, is also the next baseline.
      if (cur) prev = cur;
    } else if (cur) {
      tokens =
        !prev || cur.total + 1 < prev.total
          ? cur
          : {
              input: Math.max(0, cur.input - prev.input),
              output: Math.max(0, cur.output - prev.output),
              cached: Math.max(0, cur.cached - prev.cached),
              total: Math.max(0, cur.total - prev.total),
            };
      prev = cur;
    }
    if (!tokens || count.at == null || (!tokens.input && !tokens.output)) continue;
    const input = Math.max(0, tokens.input - tokens.cached);
    const cacheRead = tokens.cached;
    events.push({
      provider: 'codex',
      at: count.at,
      sessionId: meta.id,
      project,
      model: count.model,
      input,
      output: tokens.output,
      cacheRead,
      cacheWrite: 0,
      total: input + cacheRead + tokens.output,
      cost: codexCost(count.model, { input, cached: cacheRead, output: tokens.output }),
    });
  }
  return { sessionId: meta.id, events };
}

// Codex reports input_tokens including cached input, so cached is split out where it is counted.
function codexTokens(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = tokenCount(raw.input_tokens ?? raw.inputTokens);
  const output = tokenCount(raw.output_tokens ?? raw.outputTokens);
  const cached = Math.min(input, tokenCount(raw.cached_input_tokens ?? raw.cachedInputTokens));
  const total = tokenCount(raw.total_tokens ?? raw.totalTokens) || input + output;
  if (!input && !output && !total) return null;
  return { input, output, cached, total };
}
