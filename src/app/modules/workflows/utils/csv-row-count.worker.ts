/// <reference lib="webworker" />
import { createCsvLineCounter } from './csv-line-counter';

export interface RowCountResponse {
  rows?: number;
  error?: string;
}

/**
 * Counts the data rows of a CSV off the main thread. The file is streamed rather than read whole,
 * so peak memory stays at one chunk no matter how big the sheet is.
 */
addEventListener('message', async ({ data }: MessageEvent<File>) => {
  try {
    const counter = createCsvLineCounter();
    const decoder = new TextDecoder();
    const reader = data.stream().getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // stream: true so a multi-byte character split across chunks isn't mangled.
      counter.push(decoder.decode(value, { stream: true }));
    }
    counter.push(decoder.decode());

    const response: RowCountResponse = { rows: Math.max(0, counter.finish() - 1) };
    postMessage(response);
  } catch (err) {
    const response: RowCountResponse = {
      error: err instanceof Error ? err.message : 'Failed to read CSV file',
    };
    postMessage(response);
  }
});
