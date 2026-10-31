#!/usr/bin/env node
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanCodex, defaultCodexDir } from './src/codex.js';
import { scanClaude, defaultClaudeDir } from './src/claude.js';
import { readAccountUsage } from './src/codex-account.js';
import { readLocalOllamaUsage } from './src/local-ollama.js';
import { updateStore, recordSnapshot } from './src/account-store.js';
import { checkRequest, parseAllowedHosts } from './src/http-guard.js';
import { shortPath } from './src/util.js';
import { computeCodexTotals, computeOllamaTotal, ollamaEvents } from './src/totals.js';
import { buildView, RANGES } from './src/aggregate.js';
import { codexRate, claudeRate } from './src/pricing.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'public');
const DATA_DIR = process.env.AERUS_DATA_DIR || path.join(HERE, 'data');
const HOST = '127.0.0.1';
const EXTRA_HOSTS = parseAllowedHosts(process.env.AERUS_ALLOWED_HOSTS);
const PREFERRED = Number(process.env.PORT) || 8790;
const SHOULD_OPEN = !process.argv.includes('--no-open');
// A live account lookup is reused for this long. After that the next All Time view checks again.
const ACCOUNT_FRESH_MS = 10 * 60_000;
const LOOKUP_RETRY_MS = 60_000;
let lastLookupFailure = null;
// Set AERUS_ACCOUNT_LOOKUP=off to run fully offline (the saved snapshot is still used).
const ACCOUNT_LOOKUP_OFF = process.env.AERUS_ACCOUNT_LOOKUP === 'off';

const MAX_MODELS_IN_WARNING = 10;

// The dashboard loads only its own script, style, icon and API. Nothing else may be loaded into it, and no
// other page may frame it.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

// Asks the local Codex app-server for the account lifetime total and records it only if the lookup succeeds.
async function reconcileAccount(store, localTotal) {
  if (ACCOUNT_LOOKUP_OFF) return { status: 'off', reason: 'online lookup is turned off', changed: false };
  if (store.current && Date.now() - Date.parse(store.current.checkedAt) < ACCOUNT_FRESH_MS) {
    return { status: 'current', reason: null, changed: false };
  }
  // A failed lookup is not repeated for a minute: each attempt starts a Codex process and can take seconds.
  if (lastLookupFailure && Date.now() - lastLookupFailure.at < LOOKUP_RETRY_MS) {
    return { status: 'unavailable', reason: lastLookupFailure.reason, changed: false };
  }
  const result = await readAccountUsage().catch(() => ({ available: false, reason: 'Codex account lookup failed.' }));
  if (!result.available) {
    lastLookupFailure = { at: Date.now(), reason: result.reason };
    return { status: 'unavailable', reason: result.reason, changed: false };
  }
  lastLookupFailure = null;

  const capturedAt = new Date().toISOString();
  const outcome = recordSnapshot(store, {
    lifetimeTokens: Math.round(result.lifetimeTokens),
    capturedAt,
    localTotalAtCapture: localTotal,
    source: 'Codex app-server account/usage/read',
  });
  if (!outcome.accepted) {
    lastLookupFailure = { at: Date.now(), reason: outcome.reason };
    return { status: 'rejected', reason: outcome.reason, changed: false };
  }
  return { status: 'live', reason: null, changed: true };
}

// Keeps the largest Ollama total verified so far. Captures can be deleted, and a stored total is never lowered.
function recordOllama(store, ollama) {
  if (!ollama?.available) return false;
  const observed = Math.round(ollama.totalTokens);
  const total = Math.max(observed, store.ollama?.total ?? 0);
  if (total === (store.ollama?.total ?? 0)) return false;
  store.ollama = { total, observedAt: new Date().toISOString(), source: 'local Ollama adapter captures' };
  return true;
}

function clampOffset(raw) {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.min(0, Math.max(-3650, n));
}

// Overlapping requests for the same view share one scan instead of each running their own.
const inFlight = new Map();
function usageShared(url) {
  const key = url.search;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = usageFor(url).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

async function usageFor(url) {
  const requested = url.searchParams.get('range');
  const range = RANGES.includes(requested) ? requested : 'today';
  const offset = clampOffset(url.searchParams.get('offset'));
  const claudeDir = defaultClaudeDir();
  const codexDir = defaultCodexDir();
  const warnings = [];

  const [codex, claude, ollama] = await Promise.all([
    scanCodex(codexDir),
    scanClaude({ claudeDir, dataDir: DATA_DIR }),
    readLocalOllamaUsage().catch(() => null),
  ]);
  if (!codex.found) warnings.push(`Codex history not found at ${shortPath(codexDir)}.`);
  if (!claude.found) warnings.push(`Claude Code logs not found at ${shortPath(path.join(claudeDir, 'projects'))}.`);
  if (claude.degraded) {
    warnings.push(
      `Saved Claude history (claude-ledger.json) is ${claude.degraded === 'corrupt' ? 'damaged' : claude.degraded === 'unsupported' ? 'from an unknown version' : 'unreadable'}. ` +
      'The file was left untouched. Claude figures below come only from the transcripts Claude Code still has, so older usage is missing until it is restored.',
    );
  }
  const ollamaUsage = ollamaEvents(ollama?.records ?? []);
  // Preserve fallback-price assumptions as explicit user-facing warnings.
  const assumedRates = new Set([...codex.events, ...claude.events].filter((event) =>
    !(event.provider === 'claude' ? claudeRate(event.model).known : codexRate(event.model).known)
  ).map((event) => event.provider + ': ' + event.model));
  if (assumedRates.size) {
    const named = [...assumedRates].sort();
    const shown = named.slice(0, MAX_MODELS_IN_WARNING).join(', ') + (named.length > MAX_MODELS_IN_WARNING ? ` and ${named.length - MAX_MODELS_IN_WARNING} more` : '');
    warnings.push(`Estimated API costs use substitute rates for unrecognized models: ${shown}. These are not official prices.`);
  }

  let allTime = null;
  if (range === 'all') {
    const localTotal = codex.events.reduce((sum, event) => sum + event.total, 0);
    const { store, result: lookup, problem, backup } = await updateStore(DATA_DIR, async (store) => {
      const lookup = await reconcileAccount(store, localTotal);
      const ollamaChanged = recordOllama(store, ollama);
      return { ...lookup, changed: lookup.changed || ollamaChanged };
    });
    if (problem) {
      warnings.push(
        `Saved account snapshots were ${problem === 'corrupt' ? 'damaged' : problem === 'unsupported' ? 'from an unknown version' : 'unreadable'}` +
        (backup ? `; the original was kept as ${backup} in the HUD data folder.` : '; the original was left untouched and new snapshots are not being saved.'),
      );
    }

    allTime = {
      codex: computeCodexTotals({ events: codex.events, account: store.current }),
      ollama: computeOllamaTotal({ events: ollamaUsage, stored: store.ollama }),
      lookup,
    };

    if (lookup.status === 'unavailable' || lookup.status === 'rejected' || lookup.status === 'off') {
      warnings.push(
        store.current
          ? `Online account total not refreshed (${lookup.reason}). Showing the verified snapshot from ${new Date(store.current.checkedAt).toLocaleString('en-US')}.`
          : `No verified account total yet (${lookup.reason}). All Time shows local sessions and Ollama only.`,
      );
    }
  }

  return buildView({
    events: [...codex.events, ...claude.events, ...ollamaUsage],
    range,
    offset,
    allTime,
    warnings,
    sources: {
      codex: { found: codex.found, files: codex.files },
      claude: { found: claude.found, files: claude.files, records: claude.ledgerRecords },
      ollama: { found: Boolean(ollama?.available), files: ollama?.captureFiles ?? 0, records: ollama?.responses ?? 0 },
    },
  });
}

function send(response, status, body, type, extra = {}) {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer', ...extra });
  response.end(body);
}

function createServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${HOST}`);
      const verdict = checkRequest({
        method: request.method,
        pathname: url.pathname,
        headers: request.headers,
        port: request.socket.localPort,
        extraHosts: EXTRA_HOSTS,
      });
      if (!verdict.ok) {
        send(response, verdict.status, verdict.reason, 'text/plain; charset=utf-8', verdict.status === 405 ? { Allow: 'GET, HEAD' } : {});
        return;
      }

      if (url.pathname === '/api/usage') {
        try {
          send(response, 200, JSON.stringify(await usageShared(url)), 'application/json; charset=utf-8');
        } catch (error) {
          console.error('Aerus usage scan failed:', error);
          send(response, 500, JSON.stringify({ error: 'Unable to scan local usage.' }), 'application/json; charset=utf-8');
        }
        return;
      }

      const decoded = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      if (decoded.includes('\0')) {
        send(response, 400, JSON.stringify({ error: 'Malformed URL.' }), 'application/json; charset=utf-8');
        return;
      }
      const file = path.normalize(path.join(ROOT, decoded));
      if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
        send(response, 403, 'Forbidden', 'text/plain; charset=utf-8');
        return;
      }
      try {
        const body = await fsp.readFile(file);
        send(response, 200, body, TYPES[path.extname(file)] || 'application/octet-stream');
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'ENOTDIR') {
          send(response, 404, 'Not found', 'text/plain; charset=utf-8');
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const malformed = error instanceof URIError || error.code === 'ERR_INVALID_URL';
      send(response, malformed ? 400 : 500,
        JSON.stringify({ error: malformed ? 'Malformed URL.' : 'Unable to process request.' }),
        'application/json; charset=utf-8');
      if (!malformed) console.error('Request failed:', error);
    }
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true });
  else if (process.platform === 'darwin') execFile('open', [url]);
  else execFile('xdg-open', [url]);
}

const server = createServer();
let port = PREFERRED;
for (; port < PREFERRED + 10; port += 1) {
  try {
    await listen(server, port);
    break;
  } catch (error) {
    if (error.code !== 'EADDRINUSE' || port === PREFERRED + 9) throw error;
  }
}

const url = `http://${HOST}:${port}`;
console.log('\nAERUS AI USAGE HUD');
console.log('Local logs stay on this computer.\n');
console.log(`Dashboard  ${url}`);
console.log(`Codex      ${defaultCodexDir()}`);
console.log(`Claude     ${path.join(defaultClaudeDir(), 'projects')}`);
console.log(`Data       ${DATA_DIR}\n`);
if (SHOULD_OPEN) openBrowser(url);

const close = () => server.close(() => process.exit(0));
process.once('SIGINT', close);
process.once('SIGTERM', close);
