/**
 * The calling report as one picture (1080 x 1350, the size chat apps show without cropping).
 * Drawn from the same summary the dashboard shows, so the picture, the PDF and the spreadsheet
 * can never disagree. Light colours always: it is read on phones in chat.
 */
import { ReportSummary } from '../services/report.service';

const INK = '#0c0a09', MUTED = '#5c5752', FAINT = '#a8a29e', LINE = '#e7e5e2', WELL = '#f0eee9', ACCENT = '#4c4184', ALERT = '#b91c1c';
export const GROUPS = [
  { key: 'reached', label: 'Reached', color: '#16a34a' }, { key: 'not_reached', label: 'Not reached', color: '#dc2626' }, { key: 'failed', label: 'Failed', color: '#e28a0b' },
  { key: 'in_progress', label: 'In progress', color: '#6b62d6' }, { key: 'not_dialled', label: 'Not dialled', color: '#a8a29e' },
] as const;
const FONT = "'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif";
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export interface ReportCardInput { title: string; workspace: string; period: string; byLabel: string; summary: ReportSummary }

export function drawReportCard(x: ReportCardInput): HTMLCanvasElement {
  const W = 1080, H = 1350, P = 64;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!; const t = x.summary.total;
  const text = (s: string, px: number, py: number, size: number, color = INK, weight = 400, align: CanvasTextAlign = 'left') => { g.font = `${weight} ${size}px ${FONT}`; g.fillStyle = color; g.textAlign = align; g.fillText(s, px, py); };
  const fit = (s: string, max: number, size: number, weight = 400) => { g.font = `${weight} ${size}px ${FONT}`; if (g.measureText(s).width <= max) return s; let out = s; while (out.length > 1 && g.measureText(out + '…').width > max) out = out.slice(0, -1); return out + '…'; };
  const box = (px: number, py: number, w: number, h: number, r: number, fill: string) => { g.fillStyle = fill; g.beginPath(); g.roundRect(px, py, w, h, r); g.fill(); };

  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  box(P, 56, 12, 44, 3, ACCENT);
  text(x.title, P + 28, 92, 40, INK, 650);
  text(`${x.workspace} · ${x.period}`, P, 142, 24, MUTED);

  const tiles = [
    { k: 'Dialled', v: t.dialled, s: `${t.contacts} contacts` },
    { k: 'Reached', v: t.reached, s: `${pct(t.reached, t.dialled)}% of dialled` },
    { k: 'Completed', v: t.completed, s: `${pct(t.completed, t.reached)}% of reached` },
    { k: 'Needs follow up', v: t.follow_up, s: 'a person takes these' },
  ];
  const tw = (W - P * 2 - 18 * 3) / 4;
  tiles.forEach((tile, i) => {
    const px = P + i * (tw + 18);
    box(px, 180, tw, 170, 16, WELL);
    text(tile.k, px + 20, 220, 20, MUTED, 500);
    text(String(tile.v), px + 20, 290, 58, i === 3 && tile.v ? ALERT : INK, 650);
    text(tile.s, px + 20, 326, 17, MUTED);
  });

  text('Call status', P, 410, 22, INK, 600);
  const groups = GROUPS.map((gr) => ({ ...gr, n: t[gr.key] || 0 })).filter((gr) => gr.n);
  const total = groups.reduce((n, gr) => n + gr.n, 0) || 1; let bx = P; const bw = W - P * 2;
  g.save(); g.beginPath(); g.roundRect(P, 430, bw, 26, 13); g.clip();
  for (const gr of groups) { const w = (gr.n / total) * bw; g.fillStyle = gr.color; g.fillRect(bx, 430, w + 1, 26); bx += w; }
  g.restore();
  let lx = P;
  for (const gr of groups) { box(lx, 478, 14, 14, 4, gr.color); const label = `${gr.label} ${gr.n}`; text(label, lx + 22, 491, 19, MUTED); g.font = `400 19px ${FONT}`; lx += 22 + g.measureText(label).width + 28; }

  const trend = x.summary.trend.slice(-14);
  text('Day by day', P, 566, 22, INK, 600);
  text('Dialled and reached', W - P, 566, 18, MUTED, 400, 'right');
  const ch = 190, cy = 590, max = Math.max(1, ...trend.map((d) => d.dialled));
  g.fillStyle = LINE; g.fillRect(P, cy + ch, bw, 2);
  const slot = bw / Math.max(trend.length, 1), barW = Math.min(46, slot * 0.6);
  trend.forEach((d, i) => {
    const cx = P + slot * i + (slot - barW) / 2; const h1 = (d.dialled / max) * ch, h2 = (d.reached / max) * ch;
    if (h1) box(cx, cy + ch - h1, barW, h1, 5, '#d6d3d1'); if (h2) box(cx, cy + ch - h2, barW, h2, 5, '#16a34a');
    text(String(d.dialled), cx + barW / 2, cy + ch - h1 - 8, 15, MUTED, 500, 'center');
    text(new Date(d.day + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), cx + barW / 2, cy + ch + 26, 15, FAINT, 400, 'center');
  });
  if (!trend.length) text('No calls in this period', W / 2, cy + ch / 2, 20, FAINT, 400, 'center');

  const rows = x.summary.rows.slice(0, 6); const ty = 870;
  text(`By ${x.byLabel.toLowerCase()}`, P, ty, 22, INK, 600);
  const cols = [W - P - 420, W - P - 290, W - P - 150, W - P];
  ['Dialled', 'Reached', 'Completed', 'Follow up'].forEach((h, i) => text(h, cols[i], ty + 44, 17, MUTED, 500, 'right'));
  g.fillStyle = LINE; g.fillRect(P, ty + 58, bw, 2);
  rows.forEach((r, i) => {
    const y = ty + 100 + i * 52;
    text(fit(r.label, cols[0] - P - 110, 21, 500), P, y, 21, INK, 500);
    text(String(r.dialled), cols[0], y, 21, INK, 400, 'right');
    text(`${r.reached} · ${pct(r.reached, r.dialled)}%`, cols[1], y, 21, INK, 400, 'right');
    text(String(r.completed), cols[2], y, 21, INK, 400, 'right');
    text(String(r.follow_up), cols[3], y, 21, r.follow_up ? ALERT : FAINT, r.follow_up ? 600 : 400, 'right');
    g.fillStyle = LINE; g.fillRect(P, y + 18, bw, 1);
  });
  const more = x.summary.rows.length - rows.length;
  if (more > 0) text(`and ${more} more in the spreadsheet`, P, ty + 100 + rows.length * 52 + 4, 17, FAINT);

  g.fillStyle = LINE; g.fillRect(P, H - 92, bw, 2);
  text('Clarix', P, H - 50, 20, INK, 600);
  text(`Made ${new Date(x.summary.generated_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`, W - P, H - 50, 18, MUTED, 400, 'right');
  return c;
}

export function saveBlob(blob: Blob, name: string): void {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export function downloadReportCard(x: ReportCardInput, name: string): void {
  drawReportCard(x).toBlob((blob) => { if (blob) saveBlob(blob, name); }, 'image/jpeg', 0.92);
}
