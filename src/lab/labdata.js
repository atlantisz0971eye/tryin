// UniverseChopLAb: the whole clip laid out as a block universe, "2+1" dimensional.
//   horizontal plane  the ground of the scene (x across, z away from the camera), from the depth
//   vertical axis     time, the future upwards
//   height            kept as a flattened relief (RELIEF of the real height) so people stay readable
// The static layer is the "stellar spacetime": everything that stays put draws a straight, vertical
// worldline, like the star in a block-universe diagram. The actor layer is the "earthly spacetime":
// each frame's movers stacked upwards, so a walking person becomes a bent worldtube.

export const RELIEF = 0.15;
const MAX_ACTOR_POINTS = 180000;   // per copy; each is drawn twice to fill the gap between frames

function rayAt(x, y, W, H, focal) {
  return [(x + 0.5 - W / 2) / focal, -(y + 0.5 - H / 2) / focal];
}

// tf: the time field from timefield.js (with world and the actor mask in color's alpha)
export function buildLabData(tf, { far = 25, duration = 1 } = {}) {
  const { width: W, height: H, frames: F, focal } = tf;
  const N = W * H;
  const sky = far * 0.9;

  // extent of the ground, from the static world (sky excluded)
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let y = 0; y < H; y += 4) {
    for (let x = 0; x < W; x += 4) {
      const z = tf.world.depth[y * W + x];
      if (z >= sky) continue;
      const [rx] = rayAt(x, y, W, H, focal);
      const X = rx * z;
      if (X < minX) minX = X; if (X > maxX) maxX = X;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) { minX = -5; maxX = 5; minZ = 1; maxZ = 15; }
  const span = Math.max(maxX - minX, maxZ - minZ, 1);
  const height = 0.9 * span;                       // the block's time axis, in scene metres
  const k = height / Math.max(duration, 0.1);      // metres of block per second of clip
  const dt = duration / Math.max(F - 1, 1);        // seconds between frames

  // actor layer: every moving pixel of every frame
  let count = 0;
  for (let i = 0; i < N * F; i++) if (tf.color[i * 4 + 3] > 128) count++;
  const stride = count > MAX_ACTOR_POINTS ? Math.ceil(Math.sqrt(count / MAX_ACTOR_POINTS)) : 1;
  const est = 2 * (Math.min(count, Math.ceil(count / (stride * stride)) + F * 64));
  let pos = new Float32Array(est * 3);
  let col = new Uint8Array(est * 3);
  let tim = new Float32Array(est);
  let n = 0;
  for (let f = 0; f < F; f++) {
    const off = f * N;
    const t = f * dt;
    for (let y = 0; y < H; y += stride) {
      for (let x = 0; x < W; x += stride) {
        const i = off + y * W + x;
        if (tf.color[i * 4 + 3] <= 128) continue;
        const z = tf.depth[i];
        if (z >= sky) continue;
        if (n >= tim.length) break;
        const [rx, ry] = rayAt(x, y, W, H, focal);
        pos[n * 3] = rx * z;
        pos[n * 3 + 1] = ry * z;             // real height; the shader flattens it
        pos[n * 3 + 2] = -z;
        col[n * 3] = tf.color[i * 4];
        col[n * 3 + 1] = tf.color[i * 4 + 1];
        col[n * 3 + 2] = tf.color[i * 4 + 2];
        tim[n] = t;
        n++;
        // each moment holds until the next one, so the worldtube is a tube and not a stack of plates
        if (f < F - 1 && n < tim.length) {
          pos.copyWithin(n * 3, (n - 1) * 3, n * 3);
          col.copyWithin(n * 3, (n - 1) * 3, n * 3);
          tim[n] = t + dt * 0.5;
          n++;
        }
      }
    }
  }
  pos = pos.subarray(0, n * 3); col = col.subarray(0, n * 3); tim = tim.subarray(0, n);

  // static layer, floor: the clean plate seen from above (with its relief), at the start of time
  const fs = 2;
  const floorPos = [], floorCol = [];
  for (let y = 0; y < H; y += fs) {
    for (let x = 0; x < W; x += fs) {
      const i = y * W + x;
      const z = tf.world.depth[i];
      if (z >= sky) continue;
      const [rx, ry] = rayAt(x, y, W, H, focal);
      floorPos.push(rx * z, ry * z, -z);
      floorCol.push(tf.world.rgba[i * 4], tf.world.rgba[i * 4 + 1], tf.world.rgba[i * 4 + 2]);
    }
  }

  // static layer, worldlines: sparse vertical lines through all of time, denser where the static
  // world has an edge (a building's corner draws the brightest line)
  const ls = 6;
  const linePos = [], lineCol = [];
  // a facade collapses onto one spot of the ground, so keep a single worldline per ground cell
  const cell = Math.max(span / 70, 0.15);
  const taken = new Set();
  for (let y = ls; y < H - ls; y += ls) {
    for (let x = ls; x < W - ls; x += ls) {
      const i = y * W + x;
      const z = tf.world.depth[i];
      if (z >= sky) continue;
      const zr = tf.world.depth[i + ls], zd = tf.world.depth[i + ls * W];
      const edge = Math.max(Math.abs(Math.log(zr / z)), Math.abs(Math.log(zd / z)));
      if (edge < 0.06 && ((x / ls + y / ls) % 3 !== 0)) continue;
      const [rx, ry] = rayAt(x, y, W, H, focal);
      const X = rx * z, Y = ry * z, Z = -z;
      const key = Math.round(X / cell) * 100003 + Math.round(z / cell);
      if (taken.has(key)) continue;
      taken.add(key);
      const r = tf.world.rgba[i * 4], g = tf.world.rgba[i * 4 + 1], b = tf.world.rgba[i * 4 + 2];
      linePos.push(X, Y, Z, 0, X, Y, Z, 1);           // w: 0 at the start of time, 1 at the end
      const s = edge >= 0.06 ? 255 : 150;
      lineCol.push(r, g, b, s, r, g, b, s);
    }
  }

  return {
    actors: { positions: pos, colors: col, times: tim, count: n, stride },
    floor: { positions: new Float32Array(floorPos), colors: new Uint8Array(floorCol) },
    lines: { positions: new Float32Array(linePos), colors: new Uint8Array(lineCol) },
    bounds: { minX, maxX, minZ: -maxZ, maxZ: -minZ, height, k, duration, dt, frames: F },
  };
}
