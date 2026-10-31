// Reads a text file line by line without ever holding more than `maxChars` of one line (plus one read chunk)
// in memory. readline buffers a whole line before it hands it over, so a log written by something else
// with one enormous line, or no newline at all, could use as much memory as the file is big. Lines longer
// than the limit are skipped; the lines after them are still delivered.
import fs from 'node:fs';

export async function* boundedLines(file, maxChars) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let carry = '';
  let skipping = false;
  try {
    for await (const chunk of stream) {
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf('\n', start);
        if (newline < 0) {
          if (!skipping) {
            carry += chunk.slice(start);
            if (carry.length > maxChars) {
              carry = '';
              skipping = true;
            }
          }
          break;
        }
        if (skipping) {
          skipping = false;
        } else {
          const line = carry + chunk.slice(start, newline);
          carry = '';
          if (line.length <= maxChars) yield line.endsWith('\r') ? line.slice(0, -1) : line;
        }
        start = newline + 1;
      }
    }
    if (!skipping && carry && carry.length <= maxChars) yield carry;
  } finally {
    stream.destroy();
  }
}
