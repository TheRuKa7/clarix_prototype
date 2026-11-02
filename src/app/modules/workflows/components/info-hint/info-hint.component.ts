import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';

let uid = 0;

/**
 * Standard info icon, the same as Echo's app-hint: a small quiet "i" whose
 * tooltip opens on hover or keyboard focus and closes by itself when the pointer
 * or focus leaves; a tap toggles it on touch screens; Escape closes it. The text
 * is linked with aria-describedby. Fixed on the page, so scrolling boxes never
 * cut it off. Line breaks in the text are kept.
 */
@Component({
  selector: 'app-info-hint',
  template: `
    <span class="ih" tabindex="0" role="button" [attr.aria-label]="label()" [attr.aria-describedby]="open() ? id : null" [attr.aria-expanded]="open()"
      (pointerenter)="enter($event)" (pointerleave)="leave()" (focus)="show($event)" (blur)="hide()" (click)="tap($event)" (keydown.enter)="tap($event)">
      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5" /><circle cx="12" cy="7.6" r="0.7" class="d" /></svg>
    </span>
    @if (open()) { <span class="ih-tip" role="tooltip" [id]="id" [class.above]="pos().above" [style.top.px]="pos().top" [style.left.px]="pos().left">{{ text() }}</span> }
  `,
  styles: [`
    :host { display: inline-flex; vertical-align: middle; }
    .ih { display: inline-flex; margin-left: 2px; padding: 2px; color: var(--ds-text-placeholder); cursor: help; border-radius: 50%; }
    .ih:hover, .ih[aria-expanded="true"] { color: var(--ds-text); }
    .ih:focus-visible { outline: 2px solid var(--ds-focus, currentColor); outline-offset: 1px; }
    .ih svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
    .ih .d { fill: currentColor; stroke: none; }
    .ih-tip { position: fixed; z-index: 1300; max-width: 320px; padding: 9px 11px; border-radius: var(--ds-r-md); background: var(--ds-tooltip-bg); color: var(--ds-tooltip-text);
      font-family: var(--ds-font); font-size: var(--ds-fs-sm); font-weight: 400; line-height: 1.5; text-align: left; white-space: pre-line; text-transform: none; letter-spacing: 0;
      box-shadow: var(--ds-shadow-md); pointer-events: none; animation: ih-in .14s var(--ds-ease) both; }
    .ih-tip.above { translate: 0 -100%; animation-name: ih-in-up; }
    @keyframes ih-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
    @keyframes ih-in-up { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  `],
  host: { '(document:keydown.escape)': 'hide()', '(window:scroll)': 'open() && hide()', '(document:click)': 'pinned && hide()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InfoHintComponent {
  readonly text = input('');
  readonly label = input('More information');
  protected readonly id = `ih-${++uid}`;
  protected readonly open = signal(false);
  protected readonly pos = signal({ top: 0, left: 0, above: false });
  protected pinned = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected enter(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    const el = e.currentTarget as HTMLElement;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.place(el), 120);
  }
  protected leave(): void { clearTimeout(this.timer); if (!this.pinned) this.open.set(false); }
  protected show(e: Event): void { this.place(e.currentTarget as HTMLElement); }
  protected hide(): void { clearTimeout(this.timer); this.pinned = false; this.open.set(false); }
  protected tap(e: Event): void {
    e.stopPropagation(); e.preventDefault();
    this.pinned = !this.open() || !this.pinned;
    if (this.pinned) this.place(e.currentTarget as HTMLElement); else this.open.set(false);
  }
  private place(el: HTMLElement): void {
    const r = el.getBoundingClientRect();
    const W = Math.min(320, window.innerWidth - 16);
    const above = r.bottom + 110 > window.innerHeight;
    this.pos.set({ above, top: above ? r.top - 6 : r.bottom + 6, left: Math.max(8, Math.min(r.left - 12, window.innerWidth - W - 8)) });
    this.open.set(true);
  }
}
