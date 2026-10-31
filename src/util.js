import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Token counters from log files: a negative or non-numeric value is damage, not usage, and counts as 0.
// No single record can honestly hold more than a trillion tokens, so larger values are damage too.
const MAX_TOKENS_PER_RECORD = 1e12;

export function tokenCount(value) {
  const n = num(value);
  return n > MAX_TOKENS_PER_RECORD ? 0 : Math.max(0, n);
}

// Free-text fields from log files (ids, model names, folders) are bounded before they are stored or shown.
export function clip(value, max = 200) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
}

// Accepts epoch seconds, epoch milliseconds, or an ISO string. Returns epoch ms or null.
// Times before 2015 or more than a day ahead are damage, not usage: they would otherwise be saved forever.
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2015, 0, 1);

export function parseTime(value, now = Date.now()) {
  let t;
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    t = value < 1e12 ? value * 1000 : value;
  } else {
    t = Date.parse(String(value));
  }
  if (Number.isNaN(t) || t < EARLIEST_PLAUSIBLE_MS || t > now + 86_400_000) return null;
  return t;
}

export function normalizeModel(name) {
  return clip(String(name || 'unknown')
    .trim()
    .replace(/^openai\//i, ''), 100);
}

// Shown to the browser instead of an absolute path: the user's profile folder is not needed to act on a message.
export function shortPath(p, home = os.homedir()) {
  const text = String(p);
  const lower = text.toLowerCase();
  const prefix = String(home || '').toLowerCase();
  const inside = prefix && (lower === prefix || (lower.startsWith(prefix) && (text[home.length] === '\\' || text[home.length] === '/')));
  return inside ? `~${text.slice(home.length).replaceAll('\\', '/')}` : text;
}

// A cwd recorded on Windows (drive letter or backslashes) must be read with Windows rules even when this
// process runs on another OS, and vice versa, so pick the path flavour from the string itself.
const WINDOWS_PATH = /^[A-Za-z]:|\\/;

// True when `child` is `root` itself or below it ('/a/.codex-old' is not inside '/a/.codex').
function isInside(child, root, flavour) {
  const a = child.toLowerCase();
  const b = root.toLowerCase().replace(/[\\/]+$/, '');
  return a === b || a.startsWith(b + flavour.sep);
}

export function projectFromCwd(cwd, root) {
  if (!cwd || typeof cwd !== 'string') return 'Unattributed';
  let decoded = cwd;
  try {
    decoded = decodeURIComponent(cwd);
  } catch {
    decoded = cwd;
  }
  const flavour = WINDOWS_PATH.test(decoded) ? path.win32 : path.posix;
  const normalized = flavour.normalize(decoded);
  if (root && isInside(normalized, flavour.normalize(String(root)), flavour)) return 'Workspace';
  const base = flavour.basename(normalized);
  if (!base || base === '.' || base === flavour.parse(normalized).root) return 'Unattributed';
  return base;
}

export async function isDirectory(dir) {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function listJsonl(dir, depth = 0) {
  const found = [];
  if (depth > 8) return found;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listJsonl(full, depth + 1)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) found.push(full);
  }
  return found;
}
