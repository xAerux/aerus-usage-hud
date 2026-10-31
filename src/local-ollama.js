import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { boundedLines } from './bounded-lines.js';

const RAW_CAPTURE_SUFFIX = 'RAW-UPSTREAM-SSE.txt';
// A captured event line longer than this is not a usage record; it is skipped without being held in memory.
const MAX_LINE_CHARS = 8_000_000;
const CACHE_MS = 10_000;
let cachedFiles = new Map();
let cachedAt = 0;
let cachedResult = null;

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || '';
}

function captureDir() {
  const codexHome = process.env.CODEX_HOME || path.join(homeDir(), '.codex');
  return process.env.AERU_OLLAMA_CAPTURE_DIR || path.join(codexHome, 'local14b-tool-adapter', 'captures');
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function dateFromName(name) {
  const match = name.match(/^\d+-([0-9]{4}-[0-9]{2}-[0-9]{2})T/);
  return match ? match[1] : null;
}

// Capture names look like 0001-2026-09-20T19-36-30-854Z-RAW-UPSTREAM-SSE.txt (UTC time of the response).
function timeFromName(name) {
  const match = name.match(/^\d+-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s, ms);
}

async function readCapture(file, name) {
  // The time comes from the file name when it has one, otherwise from the file's last-modified time.
  const stat = await fsp.stat(file);
  const result = { inputTokens: 0, outputTokens: 0, totalTokens: 0, responses: 0, model: 'unknown', date: dateFromName(name), at: timeFromName(name) ?? stat.mtimeMs };
  let latest = null;
  for await (const line of boundedLines(file, MAX_LINE_CHARS)) {
    if (!line.startsWith('data: ')) continue;
    let event;
    try { event = JSON.parse(line.slice(6)); } catch { continue; }
    if (event.type === 'response.completed' && event.response && typeof event.response === 'object') latest = event.response;
  }

  const usage = latest?.usage;
  if (!usage || typeof usage !== 'object') return result;
  result.inputTokens = number(usage.input_tokens ?? usage.prompt_tokens);
  result.outputTokens = number(usage.output_tokens ?? usage.completion_tokens);
  result.totalTokens = number(usage.total_tokens) || result.inputTokens + result.outputTokens;
  result.model = typeof latest.model === 'string' && latest.model ? latest.model : 'unknown';
  if (result.totalTokens > 0) result.responses = 1;
  return result;
}

function summarize(files) {
  const summary = {
    available: true,
    captureFiles: files.size,
    responses: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    models: [],
    dailyUsageBuckets: [],
  };
  const models = new Map();
  const days = new Map();
  // One record per captured response. Cache fields are not in the captures, so none are recorded.
  summary.records = [];
  for (const entry of files.values()) {
    if (!entry.usage.responses) continue;
    summary.responses += entry.usage.responses;
    summary.inputTokens += entry.usage.inputTokens;
    summary.outputTokens += entry.usage.outputTokens;
    summary.totalTokens += entry.usage.totalTokens;
    models.set(entry.usage.model, (models.get(entry.usage.model) || 0) + entry.usage.totalTokens);
    if (entry.usage.date) days.set(entry.usage.date, (days.get(entry.usage.date) || 0) + entry.usage.totalTokens);
    if (entry.usage.at != null) {
      summary.records.push({
        at: entry.usage.at,
        model: entry.usage.model,
        input: entry.usage.inputTokens,
        output: entry.usage.outputTokens,
        total: entry.usage.totalTokens,
      });
    }
  }
  summary.models = [...models.entries()].map(([name, tokens]) => ({ name, tokens })).sort((a, b) => b.tokens - a.tokens);
  summary.dailyUsageBuckets = [...days.entries()].map(([startDate, tokens]) => ({ startDate, tokens })).sort((a, b) => a.startDate.localeCompare(b.startDate));
  return summary;
}

export async function readLocalOllamaUsage() {
  if (cachedResult && Date.now() - cachedAt < CACHE_MS) return cachedResult;
  const directory = captureDir();
  try {
    const names = (await fsp.readdir(directory)).filter((name) => name.endsWith(RAW_CAPTURE_SUFFIX));
    const present = new Set(names);
    for (const name of cachedFiles.keys()) if (!present.has(name)) cachedFiles.delete(name);
    await Promise.all(names.map(async (name) => {
      const file = path.join(directory, name);
      try {
        const stat = await fsp.stat(file);
        const existing = cachedFiles.get(name);
        if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) return;
        const usage = await readCapture(file, name);
        cachedFiles.set(name, { size: stat.size, mtimeMs: stat.mtimeMs, usage });
      } catch {
        // A capture can be rotated or removed while the folder is being scanned.
      }
    }));
    cachedResult = summarize(cachedFiles);
    cachedAt = Date.now();
    return cachedResult;
  } catch {
    const result = { available: false, reason: 'Local Ollama adapter captures were not found.', captureFiles: 0, responses: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, models: [], dailyUsageBuckets: [] };
    cachedResult = result;
    cachedAt = Date.now();
    return result;
  }
}
