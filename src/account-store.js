// Verified account snapshots and Ollama totals, kept in the HUD data folder so they survive restarts
// and work offline. Snapshots are only written from a successful live lookup. Nothing is estimated.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readFileWithRetry, withFileLock, writeFileAtomic } from './atomic-write.js';

const VERSION = 1;
const HISTORY_LIMIT = 200;

export function storePath(dataDir) {
  return path.join(dataDir, 'account-snapshots.json');
}

export function emptyStore() {
  return { version: VERSION, current: null, history: [], ollama: null };
}

// Reads the store and says what happened. A missing file is normal first use. A file that exists but cannot
// be used (damaged JSON, a version this build does not know, unreadable) is never silently replaced by an
// empty store: its bytes are first copied to a side file, and if that copy cannot be made the store is
// reported as not writable so the damaged original stays the only copy.
//   problem: null | 'corrupt' | 'unsupported' | 'unreadable'
export async function loadStoreChecked(dataDir) {
  const file = storePath(dataDir);
  let raw;
  try {
    raw = await readFileWithRetry(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { store: emptyStore(), problem: null, writable: true, backup: null };
    return { store: emptyStore(), problem: 'unreadable', writable: false, backup: null };
  }
  let problem = null;
  try {
    const data = JSON.parse(raw.toString('utf8'));
    if (data && data.version === VERSION) return { store: { ...emptyStore(), ...data }, problem: null, writable: true, backup: null };
    problem = 'unsupported';
  } catch {
    problem = 'corrupt';
  }
  // Named after the content so repeated loads of the same damaged file make one copy, not one per refresh.
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const backup = `${path.basename(file)}.${problem}-${digest}`;
  try {
    await fsp.copyFile(file, path.join(dataDir, backup), fsp.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') return { store: emptyStore(), problem, writable: false, backup: null };
  }
  return { store: emptyStore(), problem, writable: true, backup };
}

export async function loadStore(dataDir) {
  return (await loadStoreChecked(dataDir)).store;
}

export async function saveStore(dataDir, store) {
  await writeFileAtomic(storePath(dataDir), JSON.stringify(store, null, 2));
}

// Runs load, change and save as one step so overlapping requests in this process cannot lose each other's
// update. `mutate` returns { changed } (anything else is passed back to the caller untouched).
export function updateStore(dataDir, mutate) {
  return withFileLock(`${storePath(dataDir)}#update`, async () => {
    const loaded = await loadStoreChecked(dataDir);
    const result = (await mutate(loaded.store, loaded)) ?? {};
    if (result.changed && loaded.writable) await saveStore(dataDir, loaded.store);
    return { store: loaded.store, problem: loaded.problem, backup: loaded.backup, writable: loaded.writable, result };
  });
}

// Records a successful live lookup. The lifetime total can only stay the same or grow. A lower value is
// rejected and the stored snapshot stays as it was. Every accepted check moves the snapshot forward, so
// the local-after-snapshot calculation always starts from the latest verified point.
export function recordSnapshot(store, { lifetimeTokens, capturedAt, localTotalAtCapture, source }) {
  if (!Number.isFinite(lifetimeTokens) || lifetimeTokens < 0) return { accepted: false, reason: 'Account total was not a valid number.' };
  const prior = store.current;
  if (prior && lifetimeTokens < prior.lifetimeTokens) {
    return { accepted: false, reason: `Account total went down (${lifetimeTokens} < ${prior.lifetimeTokens}); kept the stored snapshot.` };
  }
  const snapshot = {
    lifetimeTokens,
    capturedAt,
    checkedAt: capturedAt,
    localTotalAtCapture,
    source,
  };
  if (!prior || prior.lifetimeTokens !== lifetimeTokens) {
    store.history = [...store.history, { lifetimeTokens, capturedAt, source }].slice(-HISTORY_LIMIT);
  }
  store.current = snapshot;
  return { accepted: true };
}
