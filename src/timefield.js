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
  plateRank: 2,   // the plate takes the (rank+1)-th farthest depth seen, so a single noisy frame cannot set it
  steady: true,   // keep the depth of things that do not move constant over time
};

// ---- the static world and the actors -----------------------------------------------------------------
//
// In footage from a fixed (stabilised) camera most of every frame never changes. Split it:
//   world   - what stays put: one clean colour plate (the average of the frames in which a pixel looks
//             like its usual self, so noise averages away) and one steady depth. It becomes a single
//             sharp textured mesh, exactly like a photo, and does not depend on time at all.
//   actors  - what moves through it: a per-frame mask. Time only decides which moment the actors show.

// For every pixel: in which frames does it look like its usual self (luma near its temporal median),
// and what is its average colour then. Depends only on the footage, so it is cached on the clip.
function analyzeStatic(frames, N, F) {
  const usual = new Uint8Array(N * F);
  const bgColor = new Uint8Array(N * 4);
  const ch = [new Float32Array(F), new Float32Array(F), new Float32Array(F)];
  const sorted = new Float32Array(F);
  const med = [0, 0, 0];
  const THRESHOLD = 26;
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < F; k++) ch[c][k] = frames[k][o + c];
      sorted.set(ch[c]);
      sorted.sort();
      med[c] = sorted[F >> 1];
    }
    let n = 0, r = 0, g = 0, b = 0;
    let best = 0, bestDev = Infinity;
    for (let k = 0; k < F; k++) {
      const dev = Math.max(Math.abs(ch[0][k] - med[0]), Math.abs(ch[1][k] - med[1]), Math.abs(ch[2][k] - med[2]));
      if (dev < bestDev) { bestDev = dev; best = k; }
      if (dev < THRESHOLD) {
        usual[k * N + i] = 1;
        r += ch[0][k]; g += ch[1][k]; b += ch[2][k];
        n++;
      }
    }
    if (n === 0) {
      // the three channel medians came from different frames: take the closest single frame
      usual[best * N + i] = 1;
      r = ch[0][best]; g = ch[1][best]; b = ch[2][best];
      n = 1;
    }
    bgColor[o] = r / n; bgColor[o + 1] = g / n; bgColor[o + 2] = b / n; bgColor[o + 3] = 255;
  }
  return { usual, bgColor };
}

// Steady depth: frames in which a pixel looks like its usual self share the median depth of those
// frames (when it is usually itself); whatever moves through keeps its own per-frame depth.
// Returns the background depth (log metres) of every pixel.
function steadyBackground(depth, usual, N, F, assign) {
  const pool = new Float32Array(F);
  const bg = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let n = 0;
    for (let k = 0; k < F; k++) if (usual[k * N + i]) pool[n++] = depth[k][i];
    const part = pool.subarray(0, n);
    part.sort();
    const m = part[n >> 1];
    bg[i] = m;
    if (assign && n >= F * 0.4) {
      for (let k = 0; k < F; k++) if (usual[k * N + i]) depth[k][i] = m;
    }
  }
  return bg;
}

// separable max / min filters on a mask (radius r)
function rankFilter(src, W, H, r, wantMax) {
  const tmp = new Uint8Array(src.length), out = new Uint8Array(src.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = wantMax ? 0 : 1;
      for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) {
        const t = src[y * W + k];
        if (wantMax ? t > v : t < v) v = t;
      }
      tmp[y * W + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = wantMax ? 0 : 1;
      for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) {
        const t = tmp[k * W + x];
        if (wantMax ? t > v : t < v) v = t;
      }
      out[y * W + x] = v;
    }
  }
  return out;
}

// Colour-guided smoothing of a depth map: each pixel averages the neighbours that look like it (similar
// colour, similar depth), so flat areas lose their depth noise while real edges stay put.
function guidedSmooth(src, rgba, W, H, r, passes, depthTol) {
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, o = i * 4;
        const c0 = a[i];
        let sum = 0, w = 0;
        for (let yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r); yy++) {
          for (let xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++) {
            const j = yy * W + xx, q = j * 4;
            if (Math.abs(a[j] - c0) > depthTol) continue;
            const dc = Math.max(Math.abs(rgba[q] - rgba[o]), Math.abs(rgba[q + 1] - rgba[o + 1]), Math.abs(rgba[q + 2] - rgba[o + 2]));
            if (dc > 24) continue;
            sum += a[j]; w++;
          }
        }
        b[i] = sum / w;
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

function boxBlur(src, W, H, r, passes = 1) {
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  const size = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[row + Math.min(W - 1, Math.max(0, k))];
      for (let x = 0; x < W; x++) {
        b[row + x] = sum / size;
        sum += a[row + Math.min(W - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += b[Math.min(H - 1, Math.max(0, k)) * W + x];
      for (let y = 0; y < H; y++) {
        a[y * W + x] = sum / size;
        sum += b[Math.min(H - 1, y + r + 1) * W + x] - b[Math.max(0, y - r) * W + x];
      }
    }
  }
  return a;
}

// Per-frame actor mask (0..255): what differs from the clean plate. A strong difference counts, a
// weak one only next to a strong one; specks are removed, then the mask grows two pixels (to take in
// soft edges and cast shadows) and is feathered.
function actorMasks(frames, bgColor, W, H, F) {
  const N = W * H;
  const out = new Uint8Array(N * F);
  const strong = new Uint8Array(N), weak = new Uint8Array(N), joined = new Uint8Array(N);
  for (let k = 0; k < F; k++) {
    const fr = frames[k];
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      const d = Math.max(Math.abs(fr[o] - bgColor[o]), Math.abs(fr[o + 1] - bgColor[o + 1]), Math.abs(fr[o + 2] - bgColor[o + 2]));
      strong[i] = d > 32 ? 1 : 0;
      weak[i] = d > 18 ? 1 : 0;
    }
    const near = rankFilter(strong, W, H, 2, true);
    for (let i = 0; i < N; i++) joined[i] = strong[i] || (weak[i] && near[i]) ? 1 : 0;
    const grown = rankFilter(rankFilter(joined, W, H, 1, false), W, H, 3, true);
    const soft = boxBlur(grown, W, H, 1, 2);
    const base = k * N;
    for (let i = 0; i < N; i++) out[base + i] = Math.min(255, Math.round(soft[i] * 255));
  }
  return out;
}

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

  // 3b. steady depth for everything that stays put
  const stat = input.__static || (input.__static = analyzeStatic(frames, N, F));
  const bgL = steadyBackground(smooth, stat.usual, N, F, P.steady);
  const masks = input.__masks || (input.__masks = actorMasks(frames, stat.bgColor, W, H, F));

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
  // the three farthest depths seen at each pixel, and the frames they came from
  const top = [0, 1, 2].map(() => new Float32Array(N).fill(-Infinity));
  const topFrame = [0, 1, 2].map(() => new Uint8Array(N));
  for (let k = 0; k < F; k++) {
    const l = snap(smooth[k]);
    const off = k * N;
    for (let i = 0; i < N; i++) {
      const v = l[i];
      depth[off + i] = Math.exp(v);
      if (v > top[0][i]) {
        top[2][i] = top[1][i]; topFrame[2][i] = topFrame[1][i];
        top[1][i] = top[0][i]; topFrame[1][i] = topFrame[0][i];
        top[0][i] = v; topFrame[0][i] = k;
      } else if (v > top[1][i]) {
        top[2][i] = top[1][i]; topFrame[2][i] = topFrame[1][i];
        top[1][i] = v; topFrame[1][i] = k;
      } else if (v > top[2][i]) {
        top[2][i] = v; topFrame[2][i] = k;
      }
    }
    color.set(frames[k], off * 4);
    // the alpha channel carries the actor mask (the particle renderer ignores it)
    for (let i = 0; i < N; i++) color[(off + i) * 4 + 3] = masks[off + i];
  }
  const rank = F >= 6 ? Math.min(2, Math.max(0, P.plateRank | 0)) : 0;
  const plateL = top[rank], plateFrame = topFrame[rank];

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

  // 7. the static world: steady depth, a clean plate, and a smooth depth that only decides *when*
  const bgSnap = snap(guidedSmooth(bgL, stat.bgColor, W, H, 3, 2, 0.25));
  const worldDepth = new Float32Array(N);
  for (let i = 0; i < N; i++) worldDepth[i] = Math.exp(bgSnap[i]);
  const timeL = boxBlur(bgL, W, H, 10, 3);
  const timeDepth = new Float32Array(N);
  for (let i = 0; i < N; i++) timeDepth[i] = Math.exp(timeL[i]);

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
    world: { depth: worldDepth, rgba: stat.bgColor, timeDepth },
    focal,
    jump: P.jump,
    vfov: (2 * Math.atan(H / 2 / focal) * 180) / Math.PI,
  };
}
