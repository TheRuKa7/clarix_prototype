// UI audit: paste into the browser console on any page (light and dark). Reports text below WCAG AA contrast,
// text clipped by overflow, and sideways page scroll. Animations are paused first so results are stable;
// reload the page afterwards to bring them back.
(() => {
  if (!document.getElementById('no-tr')) { const st = document.createElement('style'); st.id = 'no-tr'; st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'; document.head.appendChild(st); document.body.offsetHeight; }
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const mix = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => { const stack = []; let e = el; while (e && e.nodeType === 1) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } e = e.parentElement; } let base = { r: 255, g: 255, b: 255, a: 1 }; const root = parse(getComputedStyle(document.body).backgroundColor); if (root && root.a) base = root; for (let i = stack.length - 1; i >= 0; i--) base = mix(stack[i], base); return base; };
  const sel = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0'; };
  const contrast = [], clipped = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.closest('svg')) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    const cs = getComputedStyle(el);
    if (own) {
      const fg = parse(cs.color); if (!fg) continue;
      const bg = bgOf(el); const f = fg.a < 1 ? mix(fg, bg) : fg;
      const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio < need && !el.closest(':disabled, [aria-disabled="true"], .disabled, .off')) contrast.push(`${ratio.toFixed(2)} ${sel(el)} "${el.textContent.trim().slice(0, 40)}"`);
    }
    if (/hidden|clip/.test(cs.overflow + cs.overflowX + cs.overflowY) && cs.textOverflow !== 'ellipsis' && own && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)) clipped.push(`${sel(el)} "${el.textContent.trim().slice(0, 40)}"`);
  }
  const out = { page: location.pathname, contrast: [...new Set(contrast)], clipped, sidewaysScroll: document.documentElement.scrollWidth > innerWidth + 1 };
  console.table(out.contrast); console.table(out.clipped); return out;
})();
