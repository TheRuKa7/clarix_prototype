import { TranscriptMessage } from '../models/conversation.model';

/**
 * Parses a plain-text call transcript into speaker turns. Shared by the execution detail page and
 * the Call Log drawer so "who said what" reads identically in both places.
 */
export function parseTranscript(text: string): TranscriptMessage[] {
  const lines = text.split(/\r?\n/);
  const messages: TranscriptMessage[] = [];
  let current: TranscriptMessage | null = null;

  const speakerRegex =
    /^\s*(?:\[(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\]\s*)?([A-Za-z][A-Za-z _-]{0,30})\s*[:>-]\s*(.*)$/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (current) {
        messages.push(current);
        current = null;
      }
      continue;
    }
    const match = speakerRegex.exec(line);
    if (match) {
      if (current) messages.push(current);
      const speaker = match[2].trim();
      current = {
        speaker,
        time: match[1],
        text: match[3] ?? '',
        isUser: isUserSpeaker(speaker),
      };
    } else if (current) {
      current.text = current.text ? `${current.text} ${line}` : line;
    } else {
      current = { speaker: 'Transcript', text: line, isUser: false };
    }
  }
  if (current) messages.push(current);
  return messages;
}

function isUserSpeaker(speaker: string): boolean {
  const s = speaker.toLowerCase();
  return s === 'user' || s === 'customer' || s === 'human' || s === 'caller' || s.startsWith('user ');
}

export function humanizeFieldKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
