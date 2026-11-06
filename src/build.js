// Turns a photo + relative depth into three particle layers:
//   photo  - every pixel lifted to its estimated depth, original colour
//   shadow - the patch of background hidden behind each occluder, at background depth, charred dark
//            (the camera is the flash; whatever stood in front left its silhouette here)
//   ash    - sparse dark particles frozen along the rays between an occluder's edge and its shadow
// Nothing is hallucinated: missing data stays missing, it is only given a shape.

export const DEFAULTS = {
  near: 1.5,        // metres, nearest thing in the photo
  far: 25,          // metres, farthest thing (sky ends up here)
  fov: 65,          // degrees across the long side of the photo
  jump: 0.12,       // log-depth step treated as a tear between surfaces
  ash: 1.0,         // ash density along silhouette edges
  smoke: 1.0,       // ash density inside the shadow volume
  shadowTone: 0.07, // brightness of the charred imprint (the void itself is pure black)
  seed: 7,
};

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Layer {
  constructor(cap) {
    this.cap = Math.max(cap, 1024);
    this.count = 0;
    this.pos = new Float32Array(this.cap * 3);
    this.col = new Float32Array(this.cap * 3);
    this.size = new Float32Array(this.cap);
    this.alpha = new Float32Array(this.cap);
    this.off = new Float32Array(this.cap * 6);
  }

  grow() {
    const cap = this.cap * 2;
    const resize = (a, n) => {
      const b = new Float32Array(n);
      b.set(a);
      return b;
    };
    this.pos = resize(this.pos, cap * 3);
    this.col = resize(this.col, cap * 3);
    this.size = resize(this.size, cap);
    this.alpha = resize(this.alpha, cap);
    this.off = resize(this.off, cap * 6);
    this.cap = cap;
  }

  // off: 3D offsets to the right and lower neighbours (6 floats), so the viewer can grow each point
  // just enough to close the gap once it is seen from a new angle
  add(x, y, z, r, g, b, size, alpha, off = null) {
    if (this.count === this.cap) this.grow();
    const i = this.count++;
    const j = i * 3;
    this.pos[j] = x; this.pos[j + 1] = y; this.pos[j + 2] = z;
    this.col[j] = r; this.col[j + 1] = g; this.col[j + 2] = b;
    this.size[i] = size;
    this.alpha[i] = alpha;
    if (off) this.off.set(off, i * 6);
  }

  finish() {
    const n = this.count;
    return {
      count: n,
      positions: this.pos.slice(0, n * 3),
      colors: this.col.slice(0, n * 3),
      sizes: this.size.slice(0, n),
      alphas: this.alpha.slice(0, n),
      offRight: pick(this.off, n, 0),
      offDown: pick(this.off, n, 3),
    };
  }
}

function pick(off, n, start) {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = off[i * 6 + start];
    out[i * 3 + 1] = off[i * 6 + start + 1];
    out[i * 3 + 2] = off[i * 6 + start + 2];
  }
  return out;
}

function percentile(values, q) {
  const step = Math.max(1, Math.floor(values.length / 20000));
  const sample = [];
  for (let i = 0; i < values.length; i += step) sample.push(values[i]);
  sample.sort((a, b) => a - b);
  return sample[Math.min(sample.length - 1, Math.floor(q * sample.length))];
}

// Scans one row or column for depth tears.
// Writes background depth behind occluding runs into zbOut, snaps blurred edge pixels in snapZ,
// marks occluder edge pixels in edgeMark and records each tear for the ash pass.
function scanLine(base, step, n, L, z, t, reach, rand, zbOut, snapZ, edgeMark, tears) {
  const at = (k) => base + k * step;
  const jumps = [];

  for (let k = 1; k < n - 2; k++) {
    const gm = L[at(k)] - L[at(k - 1)];
    const g = L[at(k + 1)] - L[at(k)];
    const gp = L[at(k + 2)] - L[at(k + 1)];
    const S = gm + g + gp;
    if (Math.abs(S) < t) continue;
    const ag = Math.abs(g);
    if (ag < Math.abs(gm) || ag <= Math.abs(gp)) continue;
    if (Math.sign(g) !== Math.sign(S)) continue;

    const nearLeft = S > 0; // depth grows towards k+1, so the k side is in front
    const a0 = z[at(k - 1)], a1 = z[at(k)], b0 = z[at(k + 1)], b1 = z[at(k + 2)];
    const zf = nearLeft ? Math.min(a0, a1) : Math.min(b0, b1);
    const zb = nearLeft ? Math.max(b0, b1) : Math.max(a0, a1);
    const fgPixel = nearLeft ? at(k) : at(k + 1);

    // Depth networks smear edges over a couple of pixels; snap those "flying pixels" to a side.
    const lf = Math.log(zf), lb = Math.log(zb);
    for (const p of [at(k), at(k + 1)]) {
      const lp = Math.log(z[p]);
      snapZ[p] = Math.abs(lp - lf) < Math.abs(lp - lb) ? zf : zb;
    }
    edgeMark[fgPixel] = 1;
    tears.push(fgPixel, zf, zb);
    jumps.push({ k, nearLeft, zb });
  }

  // Runs between tears. A run is an occluder if a neighbouring run across a tear is farther away.
  for (let j = 0; j <= jumps.length; j++) {
    const left = j > 0 ? jumps[j - 1] : null;
    const right = j < jumps.length ? jumps[j] : null;
    const start = left ? left.k + 1 : 0;
    const end = right ? right.k : n - 1;
    const occL = left && !left.nearLeft;
    const occR = right && right.nearLeft;
    if (!occL && !occR) continue;

    for (let k = start; k <= end; k++) {
      const dL = k - start, dR = end - k;
      let zbv, dist;
      if (occL && occR) {
        const w = dL / Math.max(1, dL + dR);
        zbv = 1 / ((1 - w) / left.zb + w / right.zb);
        dist = Math.min(dL, dR);
      } else if (occL) {
        zbv = left.zb; dist = dL;
      } else {
        zbv = right.zb; dist = dR;
      }
      if (dist > reach * (0.7 + 0.3 * rand())) continue;
      const p = at(k);
      if (Math.log(zbv) - L[p] < t * 0.5) continue;
      zbOut[p] = zbv;
    }
  }
}

// Averages inverse depth over valid neighbours, without growing the valid area.
function smoothValid(zb, w, h, r) {
  const out = new Float32Array(zb.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!(zb[i] > 0)) continue;
      let sum = 0, cnt = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const v = zb[yy * w + xx];
          if (v > 0) { sum += 1 / v; cnt++; }
        }
      }
      out[i] = cnt / sum;
    }
  }
  return out;
}

export function buildScene(input, opts = {}) {
  const P = { ...DEFAULTS, ...opts };
  const { width: W, height: H, rgba, disparity } = input;
  const N = W * H;
  const rand = mulberry32(P.seed);

  // Relative disparity -> metric-ish depth, linear in inverse depth between near and far.
  const lo = percentile(disparity, 0.01);
  const hi = percentile(disparity, 0.995);
  const span = Math.max(1e-6, hi - lo);
  const invNear = 1 / P.near, invFar = 1 / P.far;
  const z = new Float32Array(N);
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const dn = Math.min(1, Math.max(0, (disparity[i] - lo) / span));
    z[i] = 1 / (invFar + dn * (invNear - invFar));
    L[i] = Math.log(z[i]);
  }
  const skyZ = P.far * 0.9;

  const f = Math.max(W, H) / 2 / Math.tan((P.fov * Math.PI) / 360);
  const cx = W / 2, cy = H / 2;

  const snapZ = Float32Array.from(z);
  const edgeMark = new Uint8Array(N);
  const zbH = new Float32Array(N);
  const zbV = new Float32Array(N);
  const tears = [];

  for (let y = 0; y < H; y++) scanLine(y * W, 1, W, L, z, P.jump, W * 0.3, rand, zbH, snapZ, edgeMark, tears);
  for (let x = 0; x < W; x++) scanLine(x, W, H, L, z, P.jump, H * 0.3, rand, zbV, snapZ, edgeMark, tears);

  let zb = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = zbH[i], b = zbV[i];
    zb[i] = a > 0 && b > 0 ? 2 / (1 / a + 1 / b) : a > 0 ? a : b;
  }
  zb = smoothValid(zb, W, H, 2);

  const rayX = (u) => (u + 0.5 - cx) / f;
  const rayY = (v) => -(v + 0.5 - cy) / f;
  // Ash never streams off to the sky; it stays near what cast it.
  const ashEnd = (zf, zbv) => (zbv > skyZ ? Math.min(zbv, zf * 2.5) : zbv);

  // 3D offsets to the right / lower neighbour, zero across tears (gaps there are meant to open).
  // Seen from a new angle, a surface needs points that cover these offsets to stay closed.
  const offs = new Float32Array(6);
  const neighbourOffsets = (depth, u, v, fp) => {
    offs.fill(0);
    const i = v * W + u;
    const d = depth[i];
    const x = rayX(u) * d, y = rayY(v) * d;
    const put = (k, dn, un, vn) => {
      if (!(dn > 0) || Math.abs(Math.log(dn / d)) >= P.jump) return;
      let ox = rayX(un) * dn - x, oy = rayY(vn) * dn - y, oz = d - dn;
      const len = Math.hypot(ox, oy, oz), cap = fp * 6;
      if (len > cap) { const s = cap / len; ox *= s; oy *= s; oz *= s; }
      offs[k] = ox; offs[k + 1] = oy; offs[k + 2] = oz;
    };
    if (u + 1 < W) put(0, depth[i + 1], u + 1, v);
    if (v + 1 < H) put(3, depth[i + W], u, v + 1);
    return offs;
  };

  // --- photo layer -------------------------------------------------------
  const photo = new Layer(N);
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      let d = snapZ[i];
      let r = rgba[i * 4] / 255, g = rgba[i * 4 + 1] / 255, b = rgba[i * 4 + 2] / 255;
      if (edgeMark[i] && rand() < 0.6) {
        // singed, crumbling silhouettes
        d *= 1 + rand() * 0.05;
        const k = 0.45 + rand() * 0.4;
        r *= k; g *= k; b *= k;
      }
      photo.add(rayX(u) * d, rayY(v) * d, -d, r, g, b, d / f, 1, neighbourOffsets(snapZ, u, v, d / f));
    }
  }

  // --- shadow layer ------------------------------------------------------
  const shadow = new Layer(N / 4);
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      const d = zb[i];
      if (!(d > 0) || d > skyZ) continue;
      // charred imprint: warm charcoal with grain, clearly a surface against the pure black void
      const n = rand();
      const c = P.shadowTone * (0.75 + n * n * 0.9);
      const fp = (d / f) * 1.1;
      shadow.add(rayX(u) * d, rayY(v) * d, -d, c * 1.15, c, c * 0.88, fp, 1, neighbourOffsets(zb, u, v, fp));
    }
  }

  // --- ash layer ---------------------------------------------------------
  const ash = new Layer(N / 4);
  const addAsh = (rx, ry, d, fp, tNear) => {
    const jx = (rand() - 0.5) * 2.5 * fp, jy = (rand() - 0.5) * 2.5 * fp;
    const fade = 1 - 0.6 * tNear;
    const roll = rand();
    let r, g, b, a;
    if (roll < 0.04) {
      const c = 0.22 + rand() * 0.18; // pale dust catching light
      r = c; g = c * 0.97; b = c * 0.92; a = (0.15 + rand() * 0.2) * fade;
    } else if (roll < 0.055 && tNear < 0.2) {
      r = 0.42; g = 0.13 + rand() * 0.05; b = 0.04; a = 0.3; // last embers
    } else {
      const c = 0.03 + Math.pow(rand(), 2) * 0.1;
      r = c * 1.05; g = c; b = c * 0.95; a = (0.25 + rand() * 0.35) * fade;
    }
    ash.add(rx * d + jx, ry * d + jy, -d, r, g, b, fp * (0.6 + rand() * 0.9), a);
  };

  for (let e = 0; e < tears.length; e += 3) {
    const p = tears[e], zf = tears[e + 1];
    const zbv = ashEnd(zf, tears[e + 2]);
    const u = p % W, v = (p / W) | 0;
    const rx = rayX(u), ry = rayY(v);
    const fpMid = (zf + zbv) / 2 / f;
    const want = (P.ash * (zbv - zf)) / (fpMid * 5);
    let count = Math.floor(want) + (rand() < want % 1 ? 1 : 0);
    count = Math.min(count, 80);
    for (let s = 0; s < count; s++) {
      const tt = Math.pow(rand(), 2.2);
      const d = zf + tt * (zbv - zf);
      addAsh(rx, ry, d, d / f, tt);
    }
  }

  // smoke filling the shadow volume behind each occluder
  const smokeProb = P.smoke * 0.018;
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      if (!(zb[i] > 0) || rand() > smokeProb) continue;
      const zf = snapZ[i];
      const zbv = ashEnd(zf, zb[i]);
      if (zbv <= zf) continue;
      const tt = 0.03 + Math.pow(rand(), 1.8) * 0.94;
      const d = zf + tt * (zbv - zf);
      const fp = d / f;
      const c = 0.025 + rand() * 0.05;
      ash.add(rayX(u) * d, rayY(v) * d, -d, c, c, c, fp * (1 + rand()), (0.1 + rand() * 0.2) * (1 - 0.7 * tt));
    }
  }

  const out = { photo: photo.finish(), shadow: shadow.finish(), ash: ash.finish() };
  out.meta = {
    width: W,
    height: H,
    focal: f,
    vfov: (2 * Math.atan(H / 2 / f) * 180) / Math.PI,
    tears: tears.length / 3,
  };
  return out;
}
