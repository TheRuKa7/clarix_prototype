import { computed, Directive, input, signal } from '@angular/core';

// ── Preview as (Team and access): the whole app follows the person picked there ──
// Echo and Clarix share this file (next to shared-screens.ts). Keep the two copies identical.
/** The previewed person (or the signed-in person) as the mock sees them: what they can do anywhere, where, and how. */
export interface PreviewMe {
  id: string; name: string; email: string; type: string; previewing: boolean; blocked: string; roles: string[];
  can: Record<string, string[]>; mask_numbers: boolean; units: string[]; people: { id: string; name: string; summary: string; state: string }[];
}
const PV_KEY = 'rbac.preview-as';
const readPv = (): string => { try { return sessionStorage.getItem(PV_KEY) || ''; } catch { return ''; } };
/** The person picked in Team and access, '' for yourself. Kept per browser tab. */
export const previewAs = signal(readPv());
export const previewMe = signal<PreviewMe | null>(null);
export function setPreviewAs(id: string): void {
  previewAs.set(id);
  try { if (id) sessionStorage.setItem(PV_KEY, id); else sessionStorage.removeItem(PV_KEY); } catch { /* private mode */ }
}
/** 'campaigns:create', or several as 'calls:edit|actions:edit' (any one is enough). Always true when nobody is previewed. */
export function previewCan(need: string): boolean {
  const me = previewMe(); if (!me?.previewing) return true; if (me.blocked) return false;
  return need.split('|').some((s) => { const [m, a = 'view'] = s.split(':'); return !!me.can[m]?.includes(a); });
}
// Every request to the mock carries the previewed person, so lists, numbers and refusals follow them.
const MOCK_PATH = /\/api\/|\/webrtc\/|\/ozonetel\//;
let headerOn = false;
export function sendPreviewHeader(): void {
  if (headerOn || typeof window === 'undefined') return; headerOn = true;
  const f = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!previewAs() || !MOCK_PATH.test(url)) return f(input, init);
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)); headers.set('x-preview-as', previewAs());
    return f(input, { ...init, headers });
  };
  const open = XMLHttpRequest.prototype.open; const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __pv?: boolean }, ...a: unknown[]) { this.__pv = MOCK_PATH.test(String(a[1])); return (open as (...x: unknown[]) => void).apply(this, a); } as typeof open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __pv?: boolean }, body?: Parameters<typeof send>[0]) { if (this.__pv && previewAs()) this.setRequestHeader('x-preview-as', previewAs()); return send.call(this, body); };
}

/** Hides what the previewed person cannot do: `<button need="campaigns:create">`. */
@Directive({ selector: '[need]', standalone: true, host: { '[style.display]': 'ok() ? null : "none"' } })
export class NeedDirective { readonly need = input.required<string>(); protected readonly ok = computed(() => previewCan(this.need())); }
