/**
 * One keyboard behaviour for every dialog, without touching each one (same file in Echo and Clarix):
 * - when a dialog opens, focus moves into it (autofocus, first field, else first button) and it is marked aria-modal;
 * - Tab and Shift+Tab stay inside the top dialog;
 * - Esc closes it with its own close or cancel button, else a click on its backdrop;
 * - when it closes, focus returns to what opened it.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function installDialogKeys(dialogSelector: string, backdropSelector: string): () => void {
  const opener = new WeakMap<Element, Element | null>();
  const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const topDialog = (): HTMLElement | null => {
    const all = [...document.querySelectorAll<HTMLElement>(dialogSelector)].filter(visible);
    return all.length ? all[all.length - 1] : null;
  };
  const focusables = (d: HTMLElement) => [...d.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);

  const onOpen = (d: HTMLElement) => {
    if (opener.has(d)) return;
    opener.set(d, document.activeElement);
    if (!d.hasAttribute('aria-modal')) d.setAttribute('aria-modal', 'true');
    if (!d.hasAttribute('role')) d.setAttribute('role', 'dialog');
    setTimeout(() => {
      if (d.contains(document.activeElement)) return;
      const target = d.querySelector<HTMLElement>('[autofocus]')
        || focusables(d).find((e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName))
        || focusables(d).find((e) => !/close|cancel|×/i.test((e.getAttribute('aria-label') || '') + e.textContent))
        || focusables(d)[0];
      target?.focus({ preventScroll: true });
    }, 30);
  };

  const seen = new Set<HTMLElement>();
  const observer = new MutationObserver(() => {
    const now = new Set([...document.querySelectorAll<HTMLElement>(dialogSelector)].filter(visible));
    now.forEach((d) => { if (!seen.has(d)) onOpen(d); });
    seen.forEach((d) => {
      if (!now.has(d)) { const back = opener.get(d) as HTMLElement | null; if (back && document.contains(back)) back.focus?.({ preventScroll: true }); }
    });
    seen.clear(); now.forEach((d) => seen.add(d));
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const onKey = (e: KeyboardEvent) => {
    const d = topDialog(); if (!d) return;
    if (e.key === 'Escape') {
      const close = [...d.querySelectorAll<HTMLElement>('button, [role="button"]')].find((b) =>
        /^(close|cancel|not now|×|✕)$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()) || /^close/i.test(b.getAttribute('aria-label') || ''));
      if (close) { e.preventDefault(); close.click(); return; }
      const backdrop = d.closest<HTMLElement>(backdropSelector) || (d.parentElement?.matches(backdropSelector) ? d.parentElement : null);
      if (backdrop) { e.preventDefault(); backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      return;
    }
    if (e.key === 'Tab') {
      const f = focusables(d); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !d.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey);
  return () => { observer.disconnect(); document.removeEventListener('keydown', onKey); };
}
