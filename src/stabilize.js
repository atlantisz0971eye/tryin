// Video stabilisation by camera rotation.
//
// The time field assumes a fixed camera: one pixel is one ray, in every frame. Hand-held or panning
// footage breaks that, so a static building lands on different pixels from frame to frame and the
// scene swims and doubles as soon as you step off the original ray. Here every frame's camera
// rotation (yaw, pitch and roll) relative to the middle frame is estimated by direct image alignment,
// and each frame is resampled into that reference camera.
//
// A rotating camera sees the same picture whatever the depth (the mapping is a homography, no
// parallax), which is why rotation alone is enough for pans and shake. Moving people and cars are
// down-weighted by a robust (Cauchy) loss so they do not drag the estimate.

const MAX_LEVELS = 3;

export function lumaOf(rgba, w, h) {
  const l = new Float32Array(w * h);
  for (let i = 0, j = 0; i < l.length; i++, j += 4) l[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  // one 3x3 box blur against sensor noise and compression grain
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1) * w, y1 = y * w, y2 = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1);
      out[y * w + x] = (l[y0 + xl] + l[y0 + x] + l[y0 + xr] + l[y1 + xl] + l[y1 + x] + l[y1 + xr] + l[y2 + xl] + l[y2 + x] + l[y2 + xr]) / 9;
    }
  }
  return out;
}

function halve(img, w, h) {
  const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1);
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const i = 2 * y * w + 2 * x;
      out[y * w2 + x] = (img[i] + img[i + 1] + img[i + w] + img[i + w + 1]) / 4;
    }
  }
  return { img: out, w: w2, h: h2 };
}

function pyramid(img, w, h, levels) {
  const out = [{ img, w, h }];
  for (let l = 1; l < levels; l++) {
    const p = out[l - 1];
    if (p.w < 64 || p.h < 48) break;
    out.push(halve(p.img, p.w, p.h));
  }
  return out; // finest first
}

// ---- 3x3 rotation helpers (row-major) ------------------------------------------------------------

export const identity = () => new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function mul(A, B) {
  const C = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  }
  return C;
}

export function rodrigues(x, y, z) {
  const t = Math.hypot(x, y, z);
  if (t < 1e-12) return identity();
  const ax = x / t, ay = y / t, az = z / t, c = Math.cos(t), s = Math.sin(t), v = 1 - c;
  return new Float64Array([
    c + ax * ax * v, ax * ay * v - az * s, ax * az * v + ay * s,
    ay * ax * v + az * s, c + ay * ay * v, ay * az * v - ax * s,
    az * ax * v - ay * s, az * ay * v + ax * s, c + az * az * v,
  ]);
}

// angle of a rotation, degrees
export function angleOf(R) {
  const tr = R[0] + R[4] + R[8];
  return (Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2))) * 180) / Math.PI;
}

// ---- alignment ------------------------------------------------------------------------------------

function bilinear(img, w, h, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const a = img[y0 * w + x0], b = img[y0 * w + x0 + 1], c = img[(y0 + 1) * w + x0], d = img[(y0 + 1) * w + x0 + 1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// Gauss-Newton on the three rotation angles, with robust weights. R maps a reference ray to the
// ray of the same scene point in the current frame.
function refine(R, ref, cur, f, iterations) {
  const { w, h } = ref;
  const I0 = ref.img, I1 = cur.img;
  const cx = w / 2, cy = h / 2;
  const stride = w * h > 40000 ? 2 : 1;
  const margin = 2;
  const cap = Math.ceil((w / stride) * (h / stride)) + 8;
  const rs = new Float32Array(cap), j0 = new Float32Array(cap), j1 = new Float32Array(cap), j2 = new Float32Array(cap);
  let used = 0;

  for (let it = 0; it < iterations; it++) {
    let n = 0;
    for (let y = margin; y < h - margin; y += stride) {
      for (let x = margin; x < w - margin; x += stride) {
        const dx = (x + 0.5 - cx) / f, dy = (y + 0.5 - cy) / f;
        const a = R[0] * dx + R[1] * dy + R[2];
        const b = R[3] * dx + R[4] * dy + R[5];
        const c = R[6] * dx + R[7] * dy + R[8];
        if (c < 1e-3) continue;
        const px = (f * a) / c + cx - 0.5, py = (f * b) / c + cy - 0.5;
        if (px < 2 || py < 2 || px > w - 3 || py > h - 3) continue;
        const gx = (bilinear(I1, w, h, px + 1, py) - bilinear(I1, w, h, px - 1, py)) * 0.5;
        const gy = (bilinear(I1, w, h, px, py + 1) - bilinear(I1, w, h, px, py - 1)) * 0.5;
        const u = a / c, v = b / c;
        rs[n] = bilinear(I1, w, h, px, py) - I0[y * w + x];
        j0[n] = gx * (-f * u * v) + gy * (-f * (1 + v * v));
        j1[n] = gx * (f * (1 + u * u)) + gy * (f * u * v);
        j2[n] = gx * (-f * v) + gy * (f * u);
        n++;
      }
    }
    used = n;
    if (n < 200) break;

    // robust scale from the median absolute residual
    const abs = new Float32Array(n);
    for (let i = 0; i < n; i++) abs[i] = Math.abs(rs[i]);
    abs.sort();
    const sigma = Math.max(4, 2.5 * 1.4826 * abs[n >> 1]);

    let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const wt = 1 / (1 + (rs[i] / sigma) * (rs[i] / sigma));
      a00 += wt * j0[i] * j0[i]; a01 += wt * j0[i] * j1[i]; a02 += wt * j0[i] * j2[i];
      a11 += wt * j1[i] * j1[i]; a12 += wt * j1[i] * j2[i]; a22 += wt * j2[i] * j2[i];
      b0 -= wt * j0[i] * rs[i]; b1 -= wt * j1[i] * rs[i]; b2 -= wt * j2[i] * rs[i];
    }
    const damp = 1e-4 * (a00 + a11 + a22) + 1e-9;
    a00 += damp; a11 += damp; a22 += damp;
    const d = solve3(a00, a01, a02, a11, a12, a22, b0, b1, b2);
    if (!d) break;
    // never step more than ~1.5 degrees at once
    const m = Math.hypot(d[0], d[1], d[2]), lim = 0.026;
    const k = m > lim ? lim / m : 1;
    R = mul(rodrigues(d[0] * k, d[1] * k, d[2] * k), R);
    if (m < 2e-6) break;
  }
  return { R, used };
}

function solve3(a00, a01, a02, a11, a12, a22, b0, b1, b2) {
  const det = a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02);
  if (Math.abs(det) < 1e-18) return null;
  const i00 = a11 * a22 - a12 * a12, i01 = a02 * a12 - a01 * a22, i02 = a01 * a12 - a02 * a11;
  const i11 = a00 * a22 - a02 * a02, i12 = a01 * a02 - a00 * a12, i22 = a00 * a11 - a01 * a01;
  return [
    (i00 * b0 + i01 * b1 + i02 * b2) / det,
    (i01 * b0 + i11 * b1 + i12 * b2) / det,
    (i02 * b0 + i12 * b1 + i22 * b2) / det,
  ];
}

// Rotation of one frame relative to the reference, coarse to fine.
export function estimateRotation(refPyr, curPyr, f, R0 = identity()) {
  let R = R0;
  const levels = Math.min(refPyr.length, curPyr.length);
  const iters = [14, 8, 6];
  for (let l = levels - 1; l >= 0; l--) {
    const scale = 1 << l;
    R = refine(R, refPyr[l], curPyr[l], f / scale, iters[Math.min(l, 2)]).R;
  }
  return R;
}

// Median absolute luma difference between the reference and a frame warped by R (full resolution).
export function alignmentError(ref, cur, f, R) {
  const { w, h } = ref;
  const cx = w / 2, cy = h / 2;
  const diffs = [];
  for (let y = 6; y < h - 6; y += 3) {
    for (let x = 6; x < w - 6; x += 3) {
      const dx = (x + 0.5 - cx) / f, dy = (y + 0.5 - cy) / f;
      const a = R[0] * dx + R[1] * dy + R[2], b = R[3] * dx + R[4] * dy + R[5], c = R[6] * dx + R[7] * dy + R[8];
      const px = (f * a) / c + cx - 0.5, py = (f * b) / c + cy - 0.5;
      if (px < 1 || py < 1 || px > w - 2 || py > h - 2) continue;
      diffs.push(Math.abs(bilinear(cur.img, w, h, px, py) - ref.img[y * w + x]));
    }
  }
  diffs.sort((p, q) => p - q);
  return diffs[diffs.length >> 1];
}

// Resample an RGBA frame into the reference camera.
export function warpFrame(rgba, w, h, R, f) {
  const out = new Uint8ClampedArray(w * h * 4);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) / f, dy = (y + 0.5 - cy) / f;
      const a = R[0] * dx + R[1] * dy + R[2], b = R[3] * dx + R[4] * dy + R[5], c = R[6] * dx + R[7] * dy + R[8];
      // clamp to the frame: the border band is dissolved into the backdrop by the viewer anyway
      const px = Math.min(w - 1.001, Math.max(0, (f * a) / c + cx - 0.5));
      const py = Math.min(h - 1.001, Math.max(0, (f * b) / c + cy - 0.5));
      const x0 = px | 0, y0 = py | 0, fx = px - x0, fy = py - y0;
      const i00 = (y0 * w + x0) * 4, i01 = i00 + 4, i10 = i00 + w * 4, i11 = i10 + 4;
      const o = (y * w + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const t = rgba[i00 + ch] + (rgba[i01 + ch] - rgba[i00 + ch]) * fx;
        const bt = rgba[i10 + ch] + (rgba[i11 + ch] - rgba[i10 + ch]) * fx;
        out[o + ch] = t + (bt - t) * fy;
      }
    }
  }
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Stabilises clip.frames in place against the middle frame. Returns diagnostics.
export async function stabilizeFrames(clip, { fov = 65 } = {}, onProgress) {
  const { width: W, height: H, frames } = clip;
  const F = frames.length;
  const ref = F >> 1;
  const f = Math.max(W, H) / 2 / Math.tan((fov * Math.PI) / 360);
  const levels = W >= 400 ? MAX_LEVELS : 2;

  const pyr = frames.map((fr) => pyramid(lumaOf(fr, W, H), W, H, levels));
  const Rs = new Array(F);
  Rs[ref] = identity();

  const order = [];
  for (let d = 1; d < F; d++) {
    if (ref - d >= 0) order.push([ref - d, ref - d + 1]);
    if (ref + d < F) order.push([ref + d, ref + d - 1]);
  }
  let done = 0;
  for (const [k, from] of order) {
    // start from the neighbour that is closer to the reference: motion is continuous
    Rs[k] = estimateRotation(pyr[ref], pyr[k], f, Rs[from]);
    done++;
    if (onProgress) onProgress(done, F - 1);
    if (done % 3 === 0) await tick();
  }

  const before = [], after = [];
  for (let k = 0; k < F; k++) {
    before.push(alignmentError(pyr[ref][0], pyr[k][0], f, identity()));
    after.push(alignmentError(pyr[ref][0], pyr[k][0], f, Rs[k]));
  }
  const rotationDeg = Rs.map(angleOf);

  for (let k = 0; k < F; k++) {
    if (k !== ref && rotationDeg[k] > 0.02) frames[k] = warpFrame(frames[k], W, H, Rs[k], f);
    if (k % 6 === 0) await tick();
  }
  const med = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];
  return { rotations: Rs, rotationDeg, errorBefore: med(before), errorAfter: med(after), ref };
}
