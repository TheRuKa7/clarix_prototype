import { Injectable, signal } from '@angular/core';

export type ConfirmTone = 'default' | 'danger';

export interface ConfirmOptions {
  /** Bold heading at the top of the dialog. */
  title?: string;
  /** Body text explaining what the user is confirming. */
  message: string;
  /** Label of the confirm button (default "Confirm"). */
  confirmText?: string;
  /** Label of the cancel button (default "Cancel"). */
  cancelText?: string;
  /** 'danger' paints the confirm button red for destructive actions. */
  tone?: ConfirmTone;
  /** Optional lucide icon name shown beside the title. */
  icon?: string;
}

/** A fully-defaulted confirm request, as consumed by the dialog component. */
export interface ConfirmRequest extends Required<Omit<ConfirmOptions, 'title' | 'icon'>> {
  title?: string;
  icon?: string;
}

/**
 * App-wide confirmation dialog, a drop-in replacement for the native `confirm()`.
 *
 * Usage:
 *   const ok = await this.confirm.ask({ message: 'Delete this?', tone: 'danger', confirmText: 'Delete' });
 *   if (!ok) return;
 *
 * A single dialog is shown at a time; asking again while one is open resolves the previous ask as
 * cancelled. The dialog host (<app-confirm-dialog>) is mounted once at the app root.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  /** The currently-open request, or null when nothing is showing. Read by the dialog component. */
  readonly request = signal<ConfirmRequest | null>(null);
  private resolver: ((confirmed: boolean) => void) | null = null;

  ask(options: ConfirmOptions): Promise<boolean> {
    // Only one dialog at a time — a superseded ask resolves as "cancelled".
    this.resolver?.(false);

    this.request.set({
      title: options.title,
      icon: options.icon,
      message: options.message,
      confirmText: options.confirmText ?? 'Confirm',
      cancelText: options.cancelText ?? 'Cancel',
      tone: options.tone ?? 'default',
    });

    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
    });
  }

  /** Called by the dialog component when the user confirms, cancels, or dismisses. */
  resolve(confirmed: boolean): void {
    this.request.set(null);
    const resolver = this.resolver;
    this.resolver = null;
    resolver?.(confirmed);
  }
}
