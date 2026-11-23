import { Resvg } from '@resvg/resvg-js';

export interface ChartDay {
  label: string;
  count: number;
}

const W = 1200;
const H = 600;
const BG = '#2b2d31';
const BAR = '#5865f2';
const GRID = '#ffffff';
const TEXT = '#dbdee1';
const MUTED = '#949ba4';
const FONT = "'Helvetica Neue', Helvetica, Arial, 'DejaVu Sans', sans-serif";

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Round the axis maximum up to a "nice" number and pick a tick step. */
function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 };
  const target = 4;
  const raw = max / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  return { top: Math.ceil(max / step) * step, step };
}

/** Top-rounded bar path (radius clamped to bar size). */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

export function renderDailyChartSvg(days: ChartDay[]): string {
  const left = 90;
  const right = 40;
  const top = 90;
  const bottom = 90;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const max = Math.max(0, ...days.map((d) => d.count));
  const { top: axisMax, step } = niceScale(max);
  const yOf = (v: number): number => top + plotH - (v / axisMax) * plotH;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" rx="32" ry="32" fill="${BG}"/>`);
  parts.push(`<text x="${left}" y="56" font-family="${FONT}" font-size="30" font-weight="bold" fill="${TEXT}">Messages per day</text>`);

  for (let v = 0; v <= axisMax + 1e-9; v += step) {
    const y = yOf(v);
    parts.push(`<line x1="${left}" y1="${y}" x2="${W - right}" y2="${y}" stroke="${GRID}" stroke-opacity="${v === 0 ? 0.25 : 0.08}" stroke-width="2"/>`);
    parts.push(`<text x="${left - 14}" y="${y + 8}" text-anchor="end" font-family="${FONT}" font-size="22" fill="${MUTED}">${esc(String(v))}</text>`);
  }

  const n = Math.max(1, days.length);
  const slot = plotW / n;
  const barW = Math.min(110, slot * 0.6);
  days.forEach((d, i) => {
    const cx = left + slot * i + slot / 2;
    const h = (d.count / axisMax) * plotH;
    const y = yOf(d.count);
    if (d.count > 0) parts.push(`<path d="${barPath(cx - barW / 2, y, barW, h, 14)}" fill="${BAR}"/>`);
    parts.push(`<text x="${cx}" y="${y - 12}" text-anchor="middle" font-family="${FONT}" font-size="26" font-weight="bold" fill="${TEXT}">${esc(d.count.toLocaleString('en-US'))}</text>`);
    parts.push(`<text x="${cx}" y="${H - bottom + 40}" text-anchor="middle" font-family="${FONT}" font-size="24" fill="${MUTED}">${esc(d.label)}</text>`);
  });

  parts.push('</svg>');
  return parts.join('');
}

/** Render a dark-themed vertical bar chart (1200x600 PNG, rendered at 2x for crispness). */
export function renderDailyChart(days: ChartDay[]): Buffer {
  const resvg = new Resvg(renderDailyChartSvg(days), {
    fitTo: { mode: 'width', value: W * 2 },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: process.platform === 'darwin' ? 'Helvetica Neue' : 'DejaVu Sans',
    },
  });
  return resvg.render().asPng();
}
