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

export interface ChartOptions {
  title?: string;
  formatValue?: (n: number) => string;
}

export function renderDailyChartSvg(days: ChartDay[], opts: ChartOptions = {}): string {
  const title = opts.title ?? 'Messages per day';
  const formatValue = opts.formatValue ?? ((n: number) => n.toLocaleString('en-US'));
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
  parts.push(`<text x="${left}" y="56" font-family="${FONT}" font-size="30" font-weight="bold" fill="${TEXT}">${esc(title)}</text>`);

  for (let v = 0; v <= axisMax + 1e-9; v += step) {
    const y = yOf(v);
    parts.push(`<line x1="${left}" y1="${y}" x2="${W - right}" y2="${y}" stroke="${GRID}" stroke-opacity="${v === 0 ? 0.25 : 0.08}" stroke-width="2"/>`);
    parts.push(`<text x="${left - 14}" y="${y + 8}" text-anchor="end" font-family="${FONT}" font-size="22" fill="${MUTED}">${esc(String(v))}</text>`);
  }

  const n = Math.max(1, days.length);
  const slot = plotW / n;
  const dense = days.length > 14; // month view: smaller bars/fonts, only the max bar gets a value label
  const barW = dense ? slot * 0.7 : Math.min(110, slot * 0.6);
  const maxIdx = dense && max > 0 ? days.findIndex((d) => d.count === max) : -1;
  days.forEach((d, i) => {
    const cx = left + slot * i + slot / 2;
    const h = (d.count / axisMax) * plotH;
    const y = yOf(d.count);
    if (d.count > 0) parts.push(`<path d="${barPath(cx - barW / 2, y, barW, h, dense ? 6 : 14)}" fill="${BAR}"/>`);
    if (!dense || i === maxIdx) {
      parts.push(`<text x="${cx}" y="${y - 12}" text-anchor="middle" font-family="${FONT}" font-size="${dense ? 22 : 26}" font-weight="bold" fill="${TEXT}">${esc(formatValue(d.count))}</text>`);
    }
    if (!dense || d.label.length <= 3 || i % 2 === 0) {
      parts.push(`<text x="${cx}" y="${H - bottom + (dense ? 36 : 40)}" text-anchor="middle" font-family="${FONT}" font-size="${dense ? 18 : 24}" fill="${MUTED}">${esc(d.label)}</text>`);
    }
  });

  parts.push('</svg>');
  return parts.join('');
}

function toPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: W * 2 },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: process.platform === 'darwin' ? 'Helvetica Neue' : 'DejaVu Sans',
    },
  });
  return resvg.render().asPng();
}

const HEATMAP_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const HEAT_GAMMA = 0.6;
// Gradient stops: dark barely-tinted blurple -> bar blurple -> brighter peak.
const HEAT_STOPS: [number, number[]][] = [
  [0, [0x3a, 0x3f, 0x6b]],
  [0.6, [0x58, 0x65, 0xf2]],
  [1, [0x7f, 0x89, 0xf7]],
];

/** Colour for a position t in 0..1 on the (already gamma-adjusted) heat scale. */
function heatColor(t: number): string {
  const x = Math.min(1, Math.max(0, t));
  let i = 1;
  while (i < HEAT_STOPS.length - 1 && x > HEAT_STOPS[i]![0]) i++;
  const [t0, c0] = HEAT_STOPS[i - 1]!;
  const [t1, c1] = HEAT_STOPS[i]!;
  const f = (x - t0) / (t1 - t0);
  const c = c0!.map((v, k) => Math.round(v + (c1![k]! - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function renderHeatmapSvg(grid: number[][], opts: { title?: string } = {}): string {
  const title = opts.title ?? 'Activity by hour';
  const left = 120;
  const right = 40;
  const top = 100;
  const bottom = 105;
  const gap = 6;
  const cols = 24;
  const rows = 7;
  const cellW = (W - left - right - gap * (cols - 1)) / cols;
  const cellH = (H - top - bottom - gap * (rows - 1)) / rows;
  let max = 0;
  for (const r of grid) for (const v of r) if (v > max) max = v;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" rx="32" ry="32" fill="${BG}"/>`);
  parts.push(`<text x="${left}" y="56" font-family="${FONT}" font-size="30" font-weight="bold" fill="${TEXT}">${esc(title)}</text>`);
  for (let d = 0; d < rows; d++) {
    const y = top + d * (cellH + gap);
    parts.push(`<text x="${left - 16}" y="${y + cellH / 2 + 8}" text-anchor="end" font-family="${FONT}" font-size="22" fill="${MUTED}">${HEATMAP_DAYS[d]}</text>`);
    for (let h = 0; h < cols; h++) {
      const v = grid[d]?.[h] ?? 0;
      const x = left + h * (cellW + gap);
      const fill = v > 0 && max > 0 ? heatColor((v / max) ** HEAT_GAMMA) : '#ffffff';
      const opacity = v > 0 && max > 0 ? 1 : 0.05;
      parts.push(`<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="6" ry="6" fill="${fill}" fill-opacity="${opacity}"/>`);
    }
  }
  for (let h = 0; h < cols; h += 3) {
    const x = left + h * (cellW + gap) + cellW / 2;
    parts.push(`<text x="${x}" y="${H - bottom + 36}" text-anchor="middle" font-family="${FONT}" font-size="22" fill="${MUTED}">${h}</text>`);
  }
  // legend, right-aligned under the grid: "Less" [5 swatches] "More"
  const sw = 22;
  const swGap = 6;
  const ly = H - 40;
  const right0 = W - right;
  const swStart = right0 - 52 - 12 - (5 * sw + 4 * swGap);
  parts.push(`<text x="${swStart - 12}" y="${ly + 7}" text-anchor="end" font-family="${FONT}" font-size="20" fill="${MUTED}">Less</text>`);
  for (let i = 0; i < 5; i++) {
    const x = swStart + i * (sw + swGap);
    const fill = i === 0 ? '#ffffff' : heatColor(i / 4);
    parts.push(`<rect y="${ly - sw / 2}" x="${x}" width="${sw}" height="${sw}" rx="5" ry="5" fill="${fill}" fill-opacity="${i === 0 ? 0.05 : 1}"/>`);
  }
  parts.push(`<text x="${right0}" y="${ly + 7}" text-anchor="end" font-family="${FONT}" font-size="20" fill="${MUTED}">More</text>`);
  parts.push('</svg>');
  return parts.join('');
}

/** Render a 7 (Mon..Sun) x 24 (hour) activity heatmap as a 1200x600 PNG at 2x. */
export function renderHeatmap(grid: number[][], opts: { title?: string } = {}): Buffer {
  return toPng(renderHeatmapSvg(grid, opts));
}

/** Render a dark-themed vertical bar chart (1200x600 PNG, rendered at 2x for crispness). */
export function renderDailyChart(days: ChartDay[], opts: ChartOptions = {}): Buffer {
  const resvg = new Resvg(renderDailyChartSvg(days, opts), {
    fitTo: { mode: 'width', value: W * 2 },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: process.platform === 'darwin' ? 'Helvetica Neue' : 'DejaVu Sans',
    },
  });
  return resvg.render().asPng();
}
