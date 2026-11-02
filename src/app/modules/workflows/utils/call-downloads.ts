import { Injectable, inject, signal } from '@angular/core';
import { finalize } from 'rxjs/operators';
import { ConversationService } from '../services/conversation.service';
import { downloadBlob } from './csv-download';

/** A call as far as downloads care: its conversation and a name for the file. */
export interface DownloadableCall {
  id: string;
  activeConversationId?: string | null;
  resolvedContact?: { name?: string | null; phone?: string | null } | null;
}

/**
 * Transcript and audio downloads straight from a list row (quick actions).
 * Both go through HttpClient so the sign in token is sent; a bare link would not carry it.
 */
@Injectable({ providedIn: 'root' })
export class CallDownloadsService {
  private readonly conversations = inject(ConversationService);
  /** "<callId>:transcript" or "<callId>:audio" while that download runs. */
  readonly busy = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  transcript(call: DownloadableCall): void {
    if (!call.activeConversationId || this.busy()) return;
    this.busy.set(`${call.id}:transcript`);
    this.conversations.fetchTranscript(call.activeConversationId).pipe(finalize(() => this.busy.set(null))).subscribe({
      next: (text) => downloadBlob(`${this.base(call)}_transcript.txt`, new Blob([text], { type: 'text/plain;charset=utf-8' })),
      error: (m: string) => this.error.set(`No transcript for this call (${m})`),
    });
  }

  audio(call: DownloadableCall): void {
    if (!call.activeConversationId || this.busy()) return;
    this.busy.set(`${call.id}:audio`);
    this.conversations.fetchAudioBlob(call.activeConversationId).pipe(finalize(() => this.busy.set(null))).subscribe({
      next: (blob) => downloadBlob(`${this.base(call)}_recording.wav`, blob),
      error: (m: string) => this.error.set(`No recording for this call (${m})`),
    });
  }

  private base(call: DownloadableCall): string {
    return `${call.resolvedContact?.name || call.resolvedContact?.phone || 'call'}_${call.id}`.replace(/[^A-Za-z0-9_-]+/g, '_');
  }
}
