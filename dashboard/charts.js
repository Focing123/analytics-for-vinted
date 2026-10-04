/** Mini bibliothèque de graphiques canvas (aucune dépendance, rapide, adaptée au thème). */
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px system-ui, sans-serif';
  return { ctx, w, h };
}

const nice = (v) => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
const fmt = (v) => (v < 10 && !Number.isInteger(v) ? v.toFixed(1) : v >= 1e6 ? (v / 1e6).toFixed(1) + ' M' : v >= 1e4 ? Math.round(v / 1e3) + ' k' : v >= 1e3 ? (v / 1e3).toFixed(1) + ' k' : String(Math.round(v)));

export function barChart(canvas, data, { color = '--c1', labelEvery = 1 } = {}) {
  const { ctx, w, h } = setup(canvas);
  const m = { l: 40, r: 8, t: 8, b: 34 };
  const max = nice(Math.max(1, ...data.map((d) => d.value)));
  const bw = (w - m.l - m.r) / Math.max(1, data.length);
  ctx.strokeStyle = css('--grid'); ctx.fillStyle = css('--muted'); ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = m.t + (h - m.t - m.b) * (1 - i / 4);
    ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(w - m.r, y); ctx.stroke();
    ctx.fillText(fmt((max * i) / 4), m.l - 6, y + 4);
  }
  const bars = [];
  data.forEach((d, i) => {
    const bh = ((h - m.t - m.b) * d.value) / max;
    const x = m.l + i * bw + bw * 0.12, y = h - m.b - bh;
    ctx.fillStyle = css(color); ctx.fillRect(x, y, bw * 0.76, Math.max(bh, d.value ? 1 : 0));
    bars.push({ x, y, w: bw * 0.76, h: bh, d });
    if (i % labelEvery === 0) {
      ctx.save(); ctx.translate(x + bw * 0.38, h - m.b + 10); ctx.rotate(-0.5); ctx.fillStyle = css('--muted'); ctx.textAlign = 'right';
      ctx.fillText(d.label, 0, 4); ctx.restore();
    }
  });
  canvas._bars = bars;
}

export function hbarChart(canvas, data, { color = '--c2', suffix = '' } = {}) {
  const { ctx, w, h } = setup(canvas);
  const labelW = Math.min(140, w * 0.38), m = { t: 4, b: 4, r: 52 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const rh = (h - m.t - m.b) / Math.max(1, data.length);
  data.forEach((d, i) => {
    const y = m.t + i * rh;
    ctx.fillStyle = css('--text'); ctx.textAlign = 'right'; ctx.font = '12px system-ui, sans-serif';
    const lab = d.label.length > 20 ? d.label.slice(0, 19) + '…' : d.label;
    ctx.fillText(lab, labelW - 8, y + rh / 2 + 4);
    const bw = ((w - labelW - m.r) * d.value) / max;
    ctx.fillStyle = css(color); ctx.fillRect(labelW, y + rh * 0.18, Math.max(bw, 1), rh * 0.64);
    ctx.fillStyle = css('--muted'); ctx.textAlign = 'left';
    ctx.fillText(fmt(d.value) + suffix, labelW + bw + 6, y + rh / 2 + 4);
  });
}

export function scatterChart(canvas, pts, { xLabel = 'Prix (€)', yLabel = 'Likes' } = {}) {
  const { ctx, w, h } = setup(canvas);
  const m = { l: 44, r: 10, t: 8, b: 30 };
  if (!pts.length) return;
  const xs = pts.map((p) => p[0]).sort((a, b) => a - b), ys = pts.map((p) => p[1]).sort((a, b) => a - b);
  const xmax = nice(xs[Math.floor(xs.length * 0.98)] || 1), ymax = nice(ys[Math.floor(ys.length * 0.99)] || 1);
  ctx.strokeStyle = css('--grid'); ctx.fillStyle = css('--muted');
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = m.t + (h - m.t - m.b) * (1 - i / 4);
    ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(w - m.r, y); ctx.stroke();
    ctx.fillText(fmt((ymax * i) / 4), m.l - 6, y + 4);
  }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) ctx.fillText(fmt((xmax * i) / 4), m.l + ((w - m.l - m.r) * i) / 4, h - m.b + 14);
  ctx.fillText(xLabel, m.l + (w - m.l - m.r) / 2, h - 4);
  ctx.save(); ctx.translate(11, m.t + (h - m.t - m.b) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(yLabel, 0, 0); ctx.restore();
  ctx.fillStyle = css('--c1'); ctx.globalAlpha = 0.45;
  for (const [x, y] of pts) {
    const px = m.l + ((w - m.l - m.r) * Math.min(x, xmax)) / xmax, py = h - m.b - ((h - m.t - m.b) * Math.min(y, ymax)) / ymax;
    ctx.beginPath(); ctx.arc(px, py, 2.4, 0, 6.283); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

const barAt = (canvas, e) => {
  const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  // toute la colonne est cliquable (pas seulement la barre), y compris les barres très basses
  return (canvas._bars || []).find((q) => x >= q.x - 2 && x <= q.x + q.w + 2 && y >= 0 && y <= canvas.clientHeight - 30);
};

/** Rend les barres cliquables : onPick reçoit les données de la barre (label, value, lo, hi…). */
export function attachBarClick(canvas, onPick) {
  canvas.style.cursor = 'pointer';
  canvas.addEventListener('click', (e) => { const b = barAt(canvas, e); if (b && b.d.value) onPick(b.d); });
}

/** Infobulle simple pour les barres verticales. */
export function attachBarTooltip(canvas, tip, hint = '') {
  canvas.addEventListener('mousemove', (e) => {
    const b = barAt(canvas, e);
    if (!b) { tip.hidden = true; return; }
    tip.hidden = false; tip.textContent = `${b.d.label} : ${b.d.value.toLocaleString('fr-FR')}${hint && b.d.value ? ' — ' + hint : ''}`;
    tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY + 12 + 'px';
  });
  canvas.addEventListener('mouseleave', () => { tip.hidden = true; });
}
