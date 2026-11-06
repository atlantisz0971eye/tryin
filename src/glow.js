// A tiny, heavily blurred copy of a picture, used as the immersive glow around the scene.
export function blurThumb(rgba, W, H, outW = 48) {
  const ow = outW;
  const oh = Math.max(4, Math.round((H * outW) / W));
  const acc = new Float32Array(ow * oh * 3);
  const cnt = new Float32Array(ow * oh);

  // area-average downscale
  for (let y = 0; y < H; y++) {
    const oy = Math.min(oh - 1, Math.floor((y * oh) / H));
    for (let x = 0; x < W; x++) {
      const ox = Math.min(ow - 1, Math.floor((x * ow) / W));
      const o = oy * ow + ox, i = (y * W + x) * 4;
      acc[o * 3] += rgba[i];
      acc[o * 3 + 1] += rgba[i + 1];
      acc[o * 3 + 2] += rgba[i + 2];
      cnt[o]++;
    }
  }
  for (let o = 0; o < ow * oh; o++) {
    const c = Math.max(1, cnt[o]);
    acc[o * 3] /= c; acc[o * 3 + 1] /= c; acc[o * 3 + 2] /= c;
  }

  // three separable box blurs approximate a wide gaussian
  const r = 2;
  let src = acc, tmp = new Float32Array(acc.length);
  for (let pass = 0; pass < 3; pass++) {
    for (const horizontal of [true, false]) {
      for (let y = 0; y < oh; y++) {
        for (let x = 0; x < ow; x++) {
          let sr = 0, sg = 0, sb = 0;
          for (let k = -r; k <= r; k++) {
            const xx = horizontal ? Math.min(ow - 1, Math.max(0, x + k)) : x;
            const yy = horizontal ? y : Math.min(oh - 1, Math.max(0, y + k));
            const j = (yy * ow + xx) * 3;
            sr += src[j]; sg += src[j + 1]; sb += src[j + 2];
          }
          const o = (y * ow + x) * 3, n = 2 * r + 1;
          tmp[o] = sr / n; tmp[o + 1] = sg / n; tmp[o + 2] = sb / n;
        }
      }
      [src, tmp] = [tmp, src];
    }
  }

  const data = new Uint8Array(ow * oh * 4);
  for (let o = 0; o < ow * oh; o++) {
    data[o * 4] = src[o * 3];
    data[o * 4 + 1] = src[o * 3 + 1];
    data[o * 4 + 2] = src[o * 3 + 2];
    data[o * 4 + 3] = 255;
  }
  return { data, width: ow, height: oh };
}
