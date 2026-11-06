import { PRESETS } from './timemodel.js';

// A tiny Minkowski sketch for the print's bottom margin: lateral space across, clip time upwards.
// Only three marks: the light cone through you (faint), the line of moments you currently see as
// "now" (it tilts as you move), and you. Your height in the sketch is how far now has run.

const X_RANGE = 12; // metres either side of you

export function drawDiagram(canvas, model, pos) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 64, h = canvas.clientHeight || 34;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = 3;
  const dur = Math.max(model.duration, 1e-3);
  const cx = w / 2;
  const cy = pad + (h - 2 * pad) * (1 - Math.min(1, Math.max(0, model.t0 / dur)));
  const sx = (dx) => cx + (dx / X_RANGE) * (w / 2 - pad);
  const sy = (dt) => cy - (dt / dur) * (h - 2 * pad);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.lineCap = 'round';

  // light cone
  ctx.strokeStyle = 'rgba(230, 225, 214, 0.22)';
  ctx.lineWidth = 0.8;
  for (const s of [1, -1]) {
    ctx.beginPath();
    ctx.moveTo(sx(-X_RANGE), sy((-s * X_RANGE) / model.c));
    ctx.lineTo(sx(X_RANGE), sy((s * X_RANGE) / model.c));
    ctx.stroke();
  }

  // now, as you see it (same formula as the shader, along x)
  const p = PRESETS[model.preset];
  const slope = model.tiltSlope(model.v[0]);
  ctx.strokeStyle = 'rgba(216, 180, 138, 0.95)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let i = 0; i <= 24; i++) {
    const dx = -X_RANGE + (i / 24) * 2 * X_RANGE;
    const x = pos[0] + dx;
    const dt = slope * dx - (p.delay * Math.abs(dx)) / model.c + (p.rel * (Math.abs(x) - Math.abs(dx))) / model.c;
    i ? ctx.lineTo(sx(dx), sy(dt)) : ctx.moveTo(sx(dx), sy(dt));
  }
  ctx.stroke();
  ctx.restore();

  // you
  ctx.fillStyle = '#efe9de';
  ctx.beginPath();
  ctx.arc(cx, cy, 1.8, 0, Math.PI * 2);
  ctx.fill();
}
