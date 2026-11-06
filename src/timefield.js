// Turns a short video (frames + per-frame relative depth) into a "time field":
//   depth / colour for every frame, stacked as layers, so the viewer can pick a frame per particle
//   a "plate": for every pixel, the farthest surface ever seen there and the moment it was seen.
//     Where the current moment is blocked by something in front, the plate shows what was really
//     there at another time. Nothing is generated: pixels never seen stay empty.

export const TIME_DEFAULTS = {
  near: 1.5,
  far: 25,
  fov: 65,
  jump: 0.12,
};

function percentile(sample, q) {
  const s = Float32Array.from(sample).sort();
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

// Least-squares a*d + b ~ ref, refit once without outliers (moving people) so the static scene drives it.
function alignTo(d, ref, step) {
  let a = 1, b = 0;
  let limit = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
    for (let i = 0; i < d.length; i += step) {
      const x = d[i], y = ref[i];
      if (Math.abs(a * x + b - y) > limit) continue;
      sx += x; sy += y; sxx += x * x; sxy += x * y; n++;
    }
    const den = n * sxx - sx * sx;
    if (n < 10 || Math.abs(den) < 1e-12) break;
    a = (n * sxy - sx * sy) / den;
    b = (sy - a * sx) / n;
    // second pass keeps only points within ~1.5 sigma of the first fit
    let err = 0, cnt = 0;
    for (let i = 0; i < d.length; i += step) { err += (a * d[i] + b - ref[i]) ** 2; cnt++; }
    limit = 1.5 * Math.sqrt(err / Math.max(1, cnt));
  }
  return [a, b];
}

// Median / 10th / 90th percentile of scene depth in metres, sky excluded.
export function sceneDepthStats(depth, skyLimit) {
  const step = Math.max(1, Math.floor(depth.length / 20000));
  const vals = [];
  for (let i = 0; i < depth.length; i += step) if (depth[i] < skyLimit) vals.push(depth[i]);
  if (vals.length < 10) for (let i = 0; i < depth.length; i += step) vals.push(depth[i]);
  vals.sort((a, b) => a - b);
  const q = (x) => vals[Math.min(vals.length - 1, Math.floor(x * vals.length))];
  return { p10: q(0.1), median: q(0.5), p90: q(0.9) };
}

export function buildTimeField(input, opts = {}) {
  const P = { ...TIME_DEFAULTS, ...opts };
  const { width: W, height: H, frames, disparities, fps } = input;
  const F = disparities.length;
  const N = W * H;
  const step = Math.max(1, Math.floor(N / 20000));
  const refIndex = F >> 1;
  const ref = disparities[refIndex];

  // 1. one shared scale for every frame
  const aligned = disparities.map((d, k) => {
    if (k === refIndex) return d;
    const [a, b] = alignTo(d, ref, step);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = a * d[i] + b;
    return out;
  });

  // 2. relative disparity -> depth, with percentiles taken across the whole clip
  const sample = [];
  for (const d of aligned) for (let i = 0; i < N; i += step * F) sample.push(d[i]);
  const lo = percentile(sample, 0.01), hi = percentile(sample, 0.995);
  const span = Math.max(1e-6, hi - lo);
  const invNear = 1 / P.near, invFar = 1 / P.far;
  const L = aligned.map((d) => {
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const dn = Math.min(1, Math.max(0, (d[i] - lo) / span));
      out[i] = -Math.log(invFar + dn * (invNear - invFar));
    }
    return out;
  });

  // 3. calm per-frame flicker where nothing actually moved
  const smooth = L.map((cur, k) => {
    const prev = L[Math.max(0, k - 1)], next = L[Math.min(F - 1, k + 1)];
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const c = cur[i];
      out[i] = Math.abs(prev[i] - c) < 0.08 && Math.abs(next[i] - c) < 0.08
        ? 0.25 * prev[i] + 0.5 * c + 0.25 * next[i]
        : c;
    }
    return out;
  });

  // 4. snap the smeared "flying pixels" at depth tears to one side
  const snap = (src) => {
    const out = Float32Array.from(src);
    for (const s of [2, 1]) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const c = out[i];
          if (x >= s && x < W - s) {
            const a = src[i - s], b = src[i + s];
            if (Math.abs(a - b) > P.jump) out[i] = Math.abs(c - a) < Math.abs(c - b) ? a : b;
          }
          if (y >= s && y < H - s) {
            const a = src[i - s * W], b = src[i + s * W];
            if (Math.abs(a - b) > P.jump) out[i] = Math.abs(out[i] - a) < Math.abs(out[i] - b) ? a : b;
          }
        }
      }
    }
    return out;
  };

  const depth = new Float32Array(N * F);
  const color = new Uint8Array(N * F * 4);
  const plateL = new Float32Array(N).fill(-Infinity);
  const plateFrame = new Uint8Array(N);
  for (let k = 0; k < F; k++) {
    const l = snap(smooth[k]);
    const off = k * N;
    for (let i = 0; i < N; i++) {
      depth[off + i] = Math.exp(l[i]);
      if (l[i] > plateL[i]) { plateL[i] = l[i]; plateFrame[i] = k; }
    }
    color.set(frames[k], off * 4);
  }

  // 5. the plate: farthest surface seen at each pixel, coloured by the moment it was seen
  const plateDepth = new Float32Array(N);
  const plateColor = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const k = plateFrame[i];
    plateDepth[i] = Math.exp(plateL[i]);
    const src = frames[k];
    plateColor[i * 4] = src[i * 4];
    plateColor[i * 4 + 1] = src[i * 4 + 1];
    plateColor[i * 4 + 2] = src[i * 4 + 2];
    plateColor[i * 4 + 3] = k;
  }

  // 6. scene scale from the middle frame, ignoring sky (it sits at the far limit)
  const depthStats = sceneDepthStats(depth.subarray(refIndex * N, (refIndex + 1) * N), P.far * 0.9);

  const focal = Math.max(W, H) / 2 / Math.tan((P.fov * Math.PI) / 360);
  return {
    depthStats,
    width: W,
    height: H,
    frames: F,
    fps,
    depth,
    color,
    plateDepth,
    plateColor,
    focal,
    jump: P.jump,
    vfov: (2 * Math.atan(H / 2 / focal) * 180) / Math.PI,
  };
}
