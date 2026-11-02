import { ChangeDetectionStrategy, Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

/**
 * Call recording player: play, back and forward 10 s, a waveform you can click
 * or drag to jump, time, speed and download, in one row. Speaker turns tint the
 * waveform (agent and caller). The transcript calls seek() to play from a line.
 */
@Component({
  selector: 'app-call-player',
  imports: [LucideAngularModule],
  templateUrl: './call-player.component.html',
  styleUrl: './call-player.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.space)': 'onSpace($event)' },
})
export class CallPlayerComponent {
  readonly src = input<string | null>(null);
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly downloadName = input('recording.wav');
  /** Speaker changes in seconds from the start. */
  readonly turns = input<{ at: number; who: 'agent' | 'caller' }[]>([]);
  readonly seed = input('call');
  readonly retry = output<void>();

  private readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audio');
  private readonly waveRef = viewChild<ElementRef<HTMLElement>>('wave');
  protected readonly playing = signal(false);
  protected readonly t = signal(0);
  protected readonly dur = signal(0);
  protected readonly rate = signal(1);
  protected readonly pct = computed(() => (this.dur() ? this.t() / this.dur() : 0));
  /** 90 bars: heights are a stable pattern from the call, colour from who was speaking. */
  protected readonly bars = computed(() => {
    const n = 90, d = this.dur() || 1;
    let h = 0; for (const ch of this.seed()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const turns = [...this.turns()].sort((a, b) => a.at - b.at);
    return Array.from({ length: n }, (_, i) => {
      h = (h * 1103515245 + 12345) >>> 0;
      const at = (i / n) * d;
      return { h: 22 + (h % 70), who: turns.filter((x) => x.at <= at).slice(-1)[0]?.who ?? '' };
    });
  });

  private a(): HTMLAudioElement | undefined { return this.audioRef()?.nativeElement; }
  protected onMeta(): void { const d = this.a()?.duration; if (d && isFinite(d)) this.dur.set(d); }
  protected onTime(): void { this.t.set(this.a()?.currentTime ?? 0); }
  protected toggle(): void { const a = this.a(); if (!a) return; if (a.paused) void a.play(); else a.pause(); }
  /** Play from a moment, used by the transcript. */
  seek(sec: number, play = true): void {
    const a = this.a(); if (!a) return;
    a.currentTime = Math.max(0, Math.min(sec, this.dur() || sec)); this.t.set(a.currentTime);
    if (play) void a.play();
  }
  protected skip(d: number): void { const a = this.a(); if (a) this.seek(a.currentTime + d, !a.paused); }
  protected speed(): void {
    const order = [1, 1.25, 1.5, 2]; const next = order[(order.indexOf(this.rate()) + 1) % order.length];
    this.rate.set(next); const a = this.a(); if (a) a.playbackRate = next;
  }
  protected drag(e: PointerEvent): void {
    const el = this.waveRef()?.nativeElement; if (!el) return;
    const at = (x: number) => { const r = el.getBoundingClientRect(); this.seek(Math.max(0, Math.min(1, (x - r.left) / r.width)) * this.dur(), !this.a()?.paused); };
    at(e.clientX);
    const move = (m: PointerEvent) => at(m.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  protected onSpace(e: Event): void {
    if (!this.src() || (e.target as HTMLElement)?.closest('input, textarea, select, button, a, [contenteditable]')) return;
    e.preventDefault(); this.toggle();
  }
  protected clock(s: number): string { const n = Math.floor(s || 0); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; }
}
