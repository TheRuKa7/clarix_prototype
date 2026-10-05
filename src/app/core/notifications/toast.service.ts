import { Injectable, signal } from '@angular/core';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
  ttl: number;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1;
  readonly toasts = signal<Toast[]>([]);

  show(message: string, type: ToastType = 'info', ttl = 4000): void {
    const toast: Toast = { id: this.nextId++, type, message, ttl };
    this.toasts.update(list => [...list, toast]);
    if (ttl > 0) {
      setTimeout(() => this.dismiss(toast.id), ttl);
    }
  }

  error(message: string, ttl = 5000): void { this.show(message, 'error', ttl); }
  success(message: string, ttl = 4000): void { this.show(message, 'success', ttl); }
  warning(message: string, ttl = 5000): void { this.show(message, 'warning', ttl); }
  info(message: string, ttl = 4000): void { this.show(message, 'info', ttl); }

  dismiss(id: number): void {
    this.toasts.update(list => list.filter(t => t.id !== id));
  }
}
