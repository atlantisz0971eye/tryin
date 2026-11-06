import * as THREE from 'three';

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute vec3 aOffR;
attribute vec3 aOffD;
uniform vec2 uViewport;
uniform float uPxScale;
uniform float uMaxPx;
uniform float uSizeMul;
uniform float uReveal;
uniform float uTime;
uniform float uShimmer;
uniform float uBleach;
uniform float uIsPhoto;
varying vec3 vColor;
varying float vAlpha;

float hash(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  float h = hash(position);
  float base = aSize * uSizeMul * uPxScale / max(d, 0.001);
  // From the original viewpoint each point covers its own pixel. From anywhere else, grow it to the
  // on-screen distance to its neighbours so surfaces stay closed without smearing.
  vec2 ndc = gl_Position.xy / gl_Position.w;
  float gap = 0.0;
  vec4 pr = projectionMatrix * (modelViewMatrix * vec4(position + aOffR, 1.0));
  vec4 pd = projectionMatrix * (modelViewMatrix * vec4(position + aOffD, 1.0));
  if (pr.w > 0.0) gap = max(gap, length((pr.xy / pr.w - ndc) * uViewport * 0.5));
  if (pd.w > 0.0) gap = max(gap, length((pd.xy / pd.w - ndc) * uViewport * 0.5));
  float ps = max(base, min(gap * 1.15, base * 4.0));
  ps *= smoothstep(h * 0.6, h * 0.6 + 0.4, uReveal);
  vAlpha = aAlpha * (1.0 - uShimmer * 0.45 * (0.5 + 0.5 * sin(uTime * 0.6 + h * 40.0)));
  if (ps < 1.0) { vAlpha *= ps; ps = 1.0; }
  gl_PointSize = d < 0.03 ? 0.0 : min(ps, uMaxPx);
  vColor = aColor;
  if (uIsPhoto > 0.5 && uBleach > 0.0) {
    // flash bleach: the further from the moment's viewpoint, the more the world is burnt pale,
    // leaving the shadows as the only thing that keeps its darkness
    float amt = uBleach * smoothstep(0.2, 3.0, length(cameraPosition));
    float lum = dot(aColor, vec3(0.299, 0.587, 0.114));
    vec3 pale = mix(vec3(lum), vec3(0.93, 0.91, 0.86), 0.3 + 0.5 * lum);
    vColor = mix(aColor, pale, amt);
  }
}
`;

const FRAG_SOLID = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  if (dot(c, c) > 1.0) discard;
  gl_FragColor = vec4(vColor, 1.0);
}
`;

const FRAG_ASH = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor, vAlpha * exp(-r2 * 2.5));
}
`;

// Video mode: every particle is one pixel ray. Its depth and colour come from a stack of frames,
// and which frame it shows is decided by where the viewer stands relative to it.
const TIME_VERT = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uDepth;
uniform sampler2DArray uColor;
uniform sampler2D uPlateDepth;
uniform sampler2D uPlateColor;
uniform vec2 uGrid;
uniform float uFocal;
uniform float uFrames;
uniform float uAnchor;
uniform float uC;
uniform float uFps;
uniform float uJump;
uniform float uIsPlate;
uniform float uGhost;
uniform int uMode;
uniform vec2 uViewport;
uniform float uPxScale;
uniform float uMaxPx;
uniform float uSizeMul;
uniform float uReveal;
uniform float uBleach;
varying vec3 vColor;
varying float vAlpha;

vec3 rayOf(vec2 p) {
  return vec3((p.x + 0.5 - uGrid.x * 0.5) / uFocal, -(p.y + 0.5 - uGrid.y * 0.5) / uFocal, -1.0);
}

ivec2 clampPix(ivec2 p) {
  return clamp(p, ivec2(0), ivec2(uGrid) - 1);
}

// between two frames, particles drift from one moment to the next
float ease(float t) { return smoothstep(0.15, 0.85, t); }

float depthAt(ivec2 p, float f) {
  float fl = floor(f);
  int i0 = int(fl);
  int i1 = min(i0 + 1, int(uFrames) - 1);
  return mix(texelFetch(uDepth, ivec3(p, i0), 0).r, texelFetch(uDepth, ivec3(p, i1), 0).r, ease(f - fl));
}

vec3 colorAt(ivec2 p, float f) {
  float fl = floor(f);
  int i0 = int(fl);
  int i1 = min(i0 + 1, int(uFrames) - 1);
  return mix(texelFetch(uColor, ivec3(p, i0), 0).rgb, texelFetch(uColor, ivec3(p, i1), 0).rgb, ease(f - fl));
}

// mode 0: at the original viewpoint everything is the anchor moment; stepping towards a particle
//         carries it into its future, stepping away sends it into its past
// mode 1: slow light - the farther a particle is from you, the older the moment you see
float frameFor(ivec2 p, vec3 r) {
  float fmax = uFrames - 1.0;
  float f = clamp(uAnchor, 0.0, fmax);
  for (int k = 0; k < 2; k++) {
    vec3 wp = r * depthAt(p, f);
    float dc = distance(cameraPosition, wp);
    float sec = uMode == 0 ? (length(wp) - dc) / uC : -dc / uC;
    f = clamp((uMode == 0 ? uAnchor : fmax) + sec * uFps, 0.0, fmax);
  }
  return f;
}

float gapPx(vec3 npos, vec2 ndc) {
  vec4 c = projectionMatrix * (modelViewMatrix * vec4(npos, 1.0));
  if (c.w <= 0.0) return 0.0;
  return length((c.xy / c.w - ndc) * uViewport * 0.5);
}

void main() {
  vec2 pix = position.xy;
  ivec2 p = ivec2(pix);
  vec3 r = rayOf(pix);
  float f = frameFor(p, r);
  float z = depthAt(p, f);
  ivec2 pr = clampPix(p + ivec2(1, 0));
  ivec2 pd = clampPix(p + ivec2(0, 1));
  float zr, zd;
  vec3 col;
  bool visible = true;

  if (uIsPlate > 0.5) {
    // another moment, shown only where the current one is blocked by something in front
    float zp = texelFetch(uPlateDepth, p, 0).r;
    visible = log(zp) - log(z) > uJump;
    vec4 pc = texelFetch(uPlateColor, p, 0);
    float dt = abs(pc.a * 255.0 - f) / max(uFrames - 1.0, 1.0);
    float lum = dot(pc.rgb, vec3(0.299, 0.587, 0.114));
    col = mix(pc.rgb, vec3(lum) * vec3(0.8, 0.9, 1.06), uGhost * (0.35 + 0.65 * clamp(dt * 2.0, 0.0, 1.0)));
    z = zp;
    zr = texelFetch(uPlateDepth, pr, 0).r;
    zd = texelFetch(uPlateDepth, pd, 0).r;
  } else {
    col = colorAt(p, f);
    zr = depthAt(pr, f);
    zd = depthAt(pd, f);
    if (uBleach > 0.0) {
      float amt = uBleach * smoothstep(0.2, 3.0, length(cameraPosition));
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, mix(vec3(lum), vec3(0.93, 0.91, 0.86), 0.3 + 0.5 * lum), amt);
    }
  }

  vec3 pos = r * z;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  float base = z / uFocal * uSizeMul * uPxScale / max(d, 0.001);
  vec2 ndc = gl_Position.xy / gl_Position.w;
  float gap = 0.0;
  if (abs(log(zr / z)) < uJump) gap = max(gap, gapPx(rayOf(vec2(pr)) * zr, ndc));
  if (abs(log(zd / z)) < uJump) gap = max(gap, gapPx(rayOf(vec2(pd)) * zd, ndc));
  float ps = max(base, min(gap * 1.15, base * 4.0));
  float h = fract(sin(dot(pix, vec2(12.9898, 78.233))) * 43758.5453);
  ps *= smoothstep(h * 0.6, h * 0.6 + 0.4, uReveal);
  vAlpha = 1.0;
  vColor = col;
  if (!visible || d < 0.03) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  } else {
    gl_PointSize = min(max(ps, 1.0), uMaxPx);
  }
}
`;

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.02, 500);
    this.camera.rotation.order = 'YXZ';

    this.uniforms = {
      uPxScale: { value: 1 },
      uSizeMul: { value: 1.4 },
      uReveal: { value: 0 },
      uTime: { value: 0 },
      uShimmer: { value: 1 },
      uBleach: { value: 0 },
      uViewport: { value: new THREE.Vector2(1, 1) },
      // up close, points stop growing and the surface dissolves into particles
      uMaxPx: { value: 28 },
    };
    this.layers = {};
    this.textures = [];
    this.revealStart = 0;
    this.timeUniforms = {
      uDepth: { value: null },
      uColor: { value: null },
      uPlateDepth: { value: null },
      uPlateColor: { value: null },
      uGrid: { value: new THREE.Vector2(1, 1) },
      uFocal: { value: 1 },
      uFrames: { value: 1 },
      uAnchor: { value: 0 },
      uC: { value: 1.5 },
      uFps: { value: 8 },
      uJump: { value: 0.12 },
      uGhost: { value: 0.6 },
      uMode: { value: 0 },
    };
    this.timeFlow = false;
    this.flowDir = 1;
    this.onTime = null;

    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.returning = null;
    this.onMove = null;

    this._bindInput();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this.timer = new THREE.Timer();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  _clear() {
    for (const obj of Object.values(this.layers)) {
      this.scene.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    }
    for (const t of this.textures) t.dispose();
    this.layers = {};
    this.textures = [];
  }

  setScene(built) {
    this._clear();
    this.layers = {
      photo: this._makePoints(built.photo, FRAG_SOLID, false, true),
      shadow: this._makePoints(built.shadow, FRAG_SOLID, false),
      ash: this._makePoints(built.ash, FRAG_ASH, true),
    };
    for (const obj of Object.values(this.layers)) this.scene.add(obj);
    this.camera.fov = built.meta.vfov;
    this._resize();
    this.revealStart = this.timer.getElapsed();
  }

  setTimeField(tf) {
    this._clear();
    const { width: W, height: H, frames: F } = tf;
    const depthTex = new THREE.DataArrayTexture(tf.depth, W, H, F);
    depthTex.format = THREE.RedFormat;
    depthTex.type = THREE.FloatType;
    const colorTex = new THREE.DataArrayTexture(tf.color, W, H, F);
    colorTex.format = THREE.RGBAFormat;
    const plateDepthTex = new THREE.DataTexture(tf.plateDepth, W, H, THREE.RedFormat, THREE.FloatType);
    const plateColorTex = new THREE.DataTexture(tf.plateColor, W, H, THREE.RGBAFormat);
    for (const t of [depthTex, colorTex, plateDepthTex, plateColorTex]) {
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.unpackAlignment = 1;
      t.needsUpdate = true;
    }
    this.textures = [depthTex, colorTex, plateDepthTex, plateColorTex];

    const u = this.timeUniforms;
    u.uDepth.value = depthTex;
    u.uColor.value = colorTex;
    u.uPlateDepth.value = plateDepthTex;
    u.uPlateColor.value = plateColorTex;
    u.uGrid.value.set(W, H);
    u.uFocal.value = tf.focal;
    u.uFrames.value = F;
    u.uFps.value = tf.fps;
    u.uJump.value = tf.jump;
    if (u.uAnchor.value > F - 1) u.uAnchor.value = (F - 1) / 2;

    const grid = new Float32Array(W * H * 3);
    for (let y = 0, i = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i++) { grid[i * 3] = x; grid[i * 3 + 1] = y; }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(grid, 3));
    const make = (isPlate) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...this.uniforms, ...u, uIsPlate: { value: isPlate ? 1 : 0 } },
        vertexShader: TIME_VERT,
        fragmentShader: FRAG_SOLID,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      return pts;
    };
    this.layers = { frames: make(false), plate: make(true) };
    for (const obj of Object.values(this.layers)) this.scene.add(obj);
    this.camera.fov = tf.vfov;
    this._resize();
    this.revealStart = this.timer.getElapsed();
  }

  setTime({ anchor, c, mode, ghost, flow } = {}) {
    const u = this.timeUniforms;
    if (anchor !== undefined) u.uAnchor.value = anchor;
    if (c !== undefined) u.uC.value = c;
    if (mode !== undefined) u.uMode.value = mode;
    if (ghost !== undefined) u.uGhost.value = ghost;
    if (flow !== undefined) this.timeFlow = flow;
  }

  _makePoints(layer, frag, transparent, isPhoto = false) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(layer.positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(layer.colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(layer.sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(layer.alphas, 1));
    const zero = new Float32Array(layer.count * 3);
    geo.setAttribute('aOffR', new THREE.BufferAttribute(layer.offRight || zero, 3));
    geo.setAttribute('aOffD', new THREE.BufferAttribute(layer.offDown || zero, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uIsPhoto: { value: isPhoto ? 1 : 0 } },
      vertexShader: VERT,
      fragmentShader: frag,
      transparent,
      depthWrite: !transparent,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    if (transparent) pts.renderOrder = 1;
    return pts;
  }

  setLayerVisible(name, visible) {
    if (this.layers[name]) this.layers[name].visible = visible;
  }

  setSizeMul(v) { this.uniforms.uSizeMul.value = v; }
  setShimmer(on) { this.uniforms.uShimmer.value = on ? 1 : 0; }
  setBleach(v) { this.uniforms.uBleach.value = v; }

  resetView() {
    this.returning = { from: this.pos.clone(), yaw: this.yaw, pitch: this.pitch, t: 0 };
  }

  _resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.uniforms.uViewport.value.copy(buf);
    this.uniforms.uMaxPx.value = 28 * this.renderer.getPixelRatio();
    this.uniforms.uPxScale.value = (this.camera.projectionMatrix.elements[5] * buf.y) / 2;
  }

  _bindInput() {
    const el = this.canvas;
    const pointers = new Map();
    let pinch = null;

    const lookScale = () => ((this.camera.fov * Math.PI) / 180) / (el.clientHeight || 1);

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.returning = null;
      if (pointers.size === 2) pinch = this._pinchState(pointers);
    });

    el.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      if (pointers.size === 1) {
        // drag the world, like a panorama
        const k = lookScale();
        this.yaw += (cur.x - prev.x) * k;
        this.pitch += (cur.y - prev.y) * k;
        this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
      }
      pointers.set(e.pointerId, cur);
      if (pointers.size === 2 && pinch) {
        const next = this._pinchState(pointers);
        this._moveLocal((next.dist - pinch.dist) * 0.01, -(next.mx - pinch.mx) * 0.006, (next.my - pinch.my) * 0.006);
        pinch = next;
      }
    });

    const up = (e) => {
      pointers.delete(e.pointerId);
      pinch = pointers.size === 2 ? this._pinchState(pointers) : null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.returning = null;
      this._moveLocal(-e.deltaY * 0.003, 0, 0);
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      this.keys.add(e.code);
      this.returning = null;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  _pinchState(pointers) {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  // forward / right / up in metres, relative to where the viewer faces (horizontal plane)
  _moveLocal(fwd, right, up) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this.pos.x += -s * fwd + c * right;
    this.pos.z += -c * fwd - s * right;
    this.pos.y += up;
  }

  _frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.05);
    const t = this.timer.getElapsed();
    this.uniforms.uTime.value = t;
    this.uniforms.uReveal.value = Math.min(1, (t - this.revealStart) / 2.2);

    const k = this.keys;
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1.2) * dt;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const right = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const up = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    if (fwd || right || up) this._moveLocal(fwd * speed, right * speed, up * speed);

    if (this.returning) {
      const r = this.returning;
      r.t = Math.min(1, r.t + dt / 1.2);
      const e = 1 - Math.pow(1 - r.t, 3);
      this.pos.copy(r.from).multiplyScalar(1 - e);
      this.yaw = r.yaw * (1 - e);
      this.pitch = r.pitch * (1 - e);
      if (r.t >= 1) this.returning = null;
    }

    if (this.timeFlow && this.layers.frames) {
      // let the anchor moment drift back and forth through the clip
      const u = this.timeUniforms;
      const fmax = u.uFrames.value - 1;
      let a = u.uAnchor.value + this.flowDir * dt * u.uFps.value * 0.5;
      if (a > fmax) { a = fmax; this.flowDir = -1; }
      if (a < 0) { a = 0; this.flowDir = 1; }
      u.uAnchor.value = a;
      if (this.onTime) this.onTime(a);
    }

    this.camera.position.copy(this.pos);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    if (this.onMove) this.onMove(this.pos.length());
    this.renderer.render(this.scene, this.camera);
  }
}
