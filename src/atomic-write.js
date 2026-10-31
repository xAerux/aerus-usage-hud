// Crash-safe replacement of a small JSON file.
//
// 1. The new contents go to a uniquely named temp file next to the target and are flushed to disk.
// 2. The temp file is renamed over the target. On Windows that rename can fail with EPERM/EACCES/EBUSY
//    for a few milliseconds when another handle (antivirus, indexer, a reader) touches the target, so it
//    is retried briefly instead of failing the whole request.
// 3. Writers to the same file inside one process run one at a time.
//
// Separate processes sharing one file are not coordinated here: the rename is atomic, so a reader never
// sees half a file, but the last writer wins.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 160, 320];

const chains = new Map();

// Runs task after every earlier task for the same key has finished, whether it succeeded or not.
// A task must not call withFileLock again with the same key: it would wait for itself. Use a different
// key for an outer transaction (see updateStore) when it also calls a writer that locks the file.
export function withFileLock(key, task) {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

async function withRetry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!TRANSIENT.has(error.code) || attempt >= RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

// A reader can hit the same short Windows sharing violation while another process is replacing the file.
export function readFileWithRetry(file) {
  return withRetry(() => fsp.readFile(file));
}

// `rename` is injectable so tests can simulate a locked target without touching the real file system.
export function writeFileAtomic(file, contents, { rename = fsp.rename } = {}) {
  return withFileLock(path.resolve(file), async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fsp.open(temp, 'w');
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await withRetry(() => rename(temp, file));
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => {});
    }
  });
}
