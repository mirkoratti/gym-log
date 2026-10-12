// Single-series line chart in plain SVG, with tap/drag tooltip.
// points: [{ x: timestamp, y: number, detail: string }], sorted by x.

import { h } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 340, H = 210;
const M = { top: 14, right: 14, bottom: 26, left: 40 };

function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

function niceStep(range, count) {
  const raw = range / Math.max(count, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

const fmtTick = (v) => (Math.abs(v) >= 10000 ? `${Math.round(v / 1000)}K` : String(Math.round(v * 10) / 10));
const fmtAxisDate = new Intl.DateTimeFormat('it-CH', { day: 'numeric', month: 'short' });
const fmtTipDate = new Intl.DateTimeFormat('it-CH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export function lineChart(points, { unit = 'kg', decimals = 1 } = {}) {
  const wrap = h('div', { class: 'chart' });
  if (!points.length) {
    wrap.append(h('div', { class: 'chart-empty' }, 'Nessun dato nel periodo scelto.'));
    return wrap;
  }

  // ---- scales
  let x0 = points[0].x, x1 = points[points.length - 1].x;
  if (x0 === x1) { x0 -= 86400000 * 3; x1 += 86400000 * 3; }
  let yMin = Math.min(...points.map((p) => p.y)), yMax = Math.max(...points.map((p) => p.y));
  const minSpan = Math.max(Math.abs(yMax) * 0.15, 2);   // avoid exaggerating tiny changes
  if (yMax - yMin < minSpan) { const mid = (yMax + yMin) / 2; yMin = mid - minSpan / 2; yMax = mid + minSpan / 2; }
  const step = niceStep(yMax - yMin, 4);
  yMin = Math.floor(yMin / step) * step;
  yMax = Math.ceil(yMax / step) * step;
  if (yMin < 0 && points.every((p) => p.y >= 0)) yMin = 0;

  const pw = W - M.left - M.right, ph = H - M.top - M.bottom;
  const sx = (x) => M.left + ((x - x0) / (x1 - x0)) * pw;
  const sy = (y) => M.top + ph - ((y - yMin) / (yMax - yMin)) * ph;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': 'Grafico dell\'andamento' });

  // ---- grid + y ticks
  for (let v = yMin; v <= yMax + step / 2; v += step) {
    const y = sy(v);
    svg.append(s('line', { x1: M.left, x2: W - M.right, y1: y, y2: y, class: 'grid' }));
    svg.append(s('text', { x: M.left - 6, y: y + 4, class: 'tick', 'text-anchor': 'end' }, fmtTick(v)));
  }
  // ---- x ticks: first, last and up to 2 in between (by time)
  const xt = [x0, x1];
  const span = x1 - x0;
  if (span > 86400000 * 20) xt.splice(1, 0, x0 + span / 3, x0 + (2 * span) / 3);
  xt.forEach((x, i) => {
    const anchor = i === 0 ? 'start' : i === xt.length - 1 ? 'end' : 'middle';
    svg.append(s('text', { x: sx(x), y: H - 6, class: 'tick', 'text-anchor': anchor }, fmtAxisDate.format(new Date(x))));
  });

  // ---- area wash + line + dots
  const coords = points.map((p) => [sx(p.x), sy(p.y)]);
  const d = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  if (coords.length > 1) {
    svg.append(s('path', { d: `${d} L${coords.at(-1)[0].toFixed(1)},${M.top + ph} L${coords[0][0].toFixed(1)},${M.top + ph} Z`, class: 'area' }));
    svg.append(s('path', { d, class: 'line' }));
  }
  const showDots = points.length <= 40;
  if (showDots) for (const [x, y] of coords) svg.append(s('circle', { cx: x, cy: y, r: 4, class: 'dot' }));

  // ---- end label (latest value)
  const [lx, ly] = coords.at(-1);
  svg.append(s('circle', { cx: lx, cy: ly, r: 5, class: 'dot end' }));

  // ---- hover / tap layer
  const cross = s('line', { y1: M.top, y2: M.top + ph, class: 'cross', visibility: 'hidden' });
  const focus = s('circle', { r: 6, class: 'dot focus', visibility: 'hidden' });
  svg.append(cross, focus);
  const hit = s('rect', { x: M.left - 10, y: 0, width: pw + 20, height: H, fill: 'transparent' });
  svg.append(hit);

  const tip = h('div', { class: 'chart-tip' });
  const fmtVal = (v) => `${(Math.round(v * 10 ** decimals) / 10 ** decimals).toLocaleString('it-CH')} ${unit}`;
  const select = (i) => {
    const p = points[i];
    const [x, y] = coords[i];
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
    focus.setAttribute('cx', x); focus.setAttribute('cy', y); focus.setAttribute('visibility', 'visible');
    tip.replaceChildren(
      h('b', null, fmtVal(p.y)),
      h('span', null, ` · ${fmtTipDate.format(new Date(p.x))}`),
      p.detail ? h('div', { class: 'small muted' }, p.detail) : null);
  };
  const nearest = (evt) => {
    const r = svg.getBoundingClientRect();
    const vx = ((evt.clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < coords.length; i++) if (Math.abs(coords[i][0] - vx) < Math.abs(coords[best][0] - vx)) best = i;
    return best;
  };
  hit.addEventListener('pointerdown', (e) => select(nearest(e)));
  hit.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'mouse') select(nearest(e)); });
  select(points.length - 1);

  wrap.append(tip, svg);
  return wrap;
}
