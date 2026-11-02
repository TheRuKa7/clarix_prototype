const BOM = '\uFEFF';

/**
 * Counts CSV lines the way the backend's parser does, so the number shown before upload matches
 * the number of executions the trigger spawns: a newline inside a quoted field does not end a
 * line, and wholly empty lines are skipped.
 *
 * Incremental by design — the caller feeds it chunks, so a large file never has to exist in
 * memory as a single string.
 */
export function createCsvLineCounter() {
  let inQuotes = false;
  let lineHasContent = false;
  let lines = 0;
  let atStart = true;

  return {
    push(chunk: string): void {
      let i = 0;
      if (atStart) {
        atStart = false;
        if (chunk.startsWith(BOM)) i = 1;
      }
      for (; i < chunk.length; i++) {
        const ch = chunk[i];
        // A doubled "" inside a quoted field toggles twice, landing back inside the quotes.
        if (ch === '"') {
          inQuotes = !inQuotes;
          lineHasContent = true;
          continue;
        }
        if (!inQuotes && (ch === '\n' || ch === '\r')) {
          if (lineHasContent) lines++;
          // A \r\n leaves an empty second line, which the guard above already skips.
          lineHasContent = false;
          continue;
        }
        lineHasContent = true;
      }
    },

    /** Total non-empty lines, header included. Counts a final line with no trailing newline. */
    finish(): number {
      if (lineHasContent) {
        lines++;
        lineHasContent = false;
      }
      return lines;
    },
  };
}

/** Data rows in a whole-file string: non-empty lines, minus the header. */
export function countDataRows(text: string): number {
  const counter = createCsvLineCounter();
  counter.push(text);
  return Math.max(0, counter.finish() - 1);
}
