import { PRESETS } from './timemodel.js';

// A small Minkowski diagram: lateral space (world x) across, clip time upwards.
// Shows the clip as a block of spacetime, your worldline through it, the light cone,
// and the line of moments you currently see as "now".

const X_RANGE = 12; // metres either side of the origin

export function drawDiagram(canvas, model, pos, trail) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = 160;
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr;
    canvas.height = size * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const pad = 14;
  const w = size - pad * 2, h = size - pad * 2;
  const dur = Math.max(model.duration, 1e-3);
  const sx = (x) => pad + ((x + X_RANGE) / (2 * X_RANGE)) * w;
  const sy = (t) => pad + h - (t / dur) * h;

  // the clip: every moment that was recorded
  ctx.fillStyle = 'rgba(216, 210, 198, 0.06)';
  ctx.fillRect(pad, pad, w, h);
  ctx.strokeStyle = 'rgba(216, 210, 198, 0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad + 0.5, pad + 0.5, w - 1, h - 1);

  ctx.fillStyle = 'rgba(216, 210, 198, 0.55)';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.fillText('x', size - pad + 3, size - pad + 3);
  ctx.fillText('t', pad - 9, pad + 3);

  const x0 = pos[0], t0 = model.t0;

  // light cone through your position
  ctx.save();
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = 'rgba(216, 210, 198, 0.3)';
  const reach = X_RANGE * 2;
  for (const s of [1, -1]) {
    ctx.beginPath();
    ctx.moveTo(sx(x0 - reach), sy(t0 - (s * reach) / model.c));
    ctx.lineTo(sx(x0 + reach), sy(t0 + (s * reach) / model.c));
    ctx.stroke();
  }
  ctx.restore();

  // your worldline
  if (trail.length > 1) {
    ctx.strokeStyle = 'rgba(216, 210, 198, 0.7)';
    ctx.beginPath();
    trail.forEach(([x, t], i) => (i ? ctx.lineTo(sx(x), sy(t)) : ctx.moveTo(sx(x), sy(t))));
    ctx.stroke();
  }

  // what you see as "now", along x (same formula as the shader, restricted to one axis)
  const p = PRESETS[model.preset];
  const slope = model.tiltSlope(model.v[0]);
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad, pad, w, h);
  ctx.clip();
  ctx.strokeStyle = '#d8b48a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i <= 48; i++) {
    const x = -X_RANGE + (i / 48) * 2 * X_RANGE;
    const dx = x - x0;
    const t = t0 + slope * dx - p.delay * Math.abs(dx) / model.c + p.rel * (Math.abs(x) - Math.abs(dx)) / model.c;
    i ? ctx.lineTo(sx(x), sy(t)) : ctx.moveTo(sx(x), sy(t));
  }
  ctx.stroke();
  ctx.restore();

  // you
  ctx.fillStyle = '#f2ece2';
  ctx.beginPath();
  ctx.arc(sx(x0), sy(t0), 2.5, 0, Math.PI * 2);
  ctx.fill();
}
