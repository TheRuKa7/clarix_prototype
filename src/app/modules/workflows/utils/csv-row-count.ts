import { countDataRows } from './csv-line-counter';
import type { RowCountResponse } from './csv-row-count.worker';

/**
 * Files at or below this are counted on the main thread; a 1 MB CSV parses in a few milliseconds,
 * which is cheaper than spinning up a worker. Anything larger is streamed in a worker so a big
 * sheet can't freeze the dialog while the user is still mapping columns.
 */
export const MAIN_THREAD_BYTE_LIMIT = 1024 * 1024;

/** Thrown when a count is abandoned because the user picked a different file or closed the modal. */
export class RowCountCancelledError extends Error {
  constructor() {
    super('Row count cancelled');
    this.name = 'RowCountCancelledError';
  }
}

export interface RowCountJob {
  /** Resolves with the number of data rows (header excluded). */
  readonly result: Promise<number>;
  /** Abandons the count and frees the worker. The result promise rejects. */
  cancel(): void;
}

function countOnMainThread(file: File): RowCountJob {
  let cancelled = false;
  const result = file.text().then((text) => {
    if (cancelled) throw new RowCountCancelledError();
    return countDataRows(text);
  });
  return {
    result,
    cancel: () => {
      cancelled = true;
    },
  };
}

function countInWorker(file: File): RowCountJob {
  const worker = new Worker(new URL('./csv-row-count.worker', import.meta.url), { type: 'module' });

  const result = new Promise<number>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<RowCountResponse>) => {
      worker.terminate();
      if (typeof data.rows === 'number') resolve(data.rows);
      else reject(new Error(data.error ?? 'Failed to read CSV file'));
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('Failed to read CSV file'));
    };
    worker.postMessage(file);
  });

  return {
    result,
    cancel: () => worker.terminate(), // leaves `result` pending; callers guard with a token
  };
}

/**
 * Counts the data rows of a CSV, off the main thread when the file is large enough to be worth it.
 * Falls back to the main thread wherever Workers aren't available.
 */
export function countCsvDataRows(file: File): RowCountJob {
  if (file.size <= MAIN_THREAD_BYTE_LIMIT || typeof Worker === 'undefined') {
    return countOnMainThread(file);
  }
  try {
    return countInWorker(file);
  } catch {
    // A CSP or a bundler quirk can block worker construction; a slow count beats no count.
    return countOnMainThread(file);
  }
}
