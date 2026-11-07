// UniverseChopLAb: an immersive block universe made of the uploaded clip (see labdata.js).
//
//   rise above      the clockwork universe. The whole history floats in space and time runs on its
//                   own, like a clock outside the universe (switchable). The stick scrubs now up and
//                   down and, sideways, sets a speed that tilts the slice: t = T0 + beta x / c.
//   step onto now   proper time. You stand on the slice at human scale and the stick walks you through
//                   the scene. Each second you live moves the clip on by gamma seconds, and the speed
//                   you walk at tilts your now. Up is the future, down the past.
//
// Everything is a real pixel at a real moment: the slice is the actual frame (picked per pixel by the
// tilted now, on the GPU), the still world is a column of its own colours through time, and the
// movers away from now hang as ghosts along their worldtubes.

import * as THREE from 'three';
import { buildLabData, RELIEF } from './labdata.js';
import { Stick } from '../stick.js';
import { MotionWalker, motionSupported, requestMotionPermission } from '../motion.js';

// shared: the time of the slice at a point, for an observer at uObs moving with uBeta (units of c)
const SLICE_TIME = /* glsl */ `
uniform float uT0;
uniform float uC;
uniform vec2 uBeta;
uniform vec2 uObs;
float sliceTime(vec3 q) {
  return uT0 + (uBeta.x * (q.x - uObs.x) + uBeta.y * (q.z - uObs.y)) / uC;
}
`;

const SLICE_VERT = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uDepth;
uniform sampler2DArray uColor;
uniform vec2 uGrid;
uniform float uFocal;
uniform float uFrames;
uniform float uDt;
uniform float uK;
uniform float uRelief;
uniform float uPx;
uniform float uStride;
uniform float uSky;
uniform float uInside;
${SLICE_TIME}
varying vec3 vCol;
varying float vA;

vec3 pointAt(ivec2 p, float z) {
  vec2 r = vec2((float(p.x) + 0.5 - uGrid.x * 0.5) / uFocal, -(float(p.y) + 0.5 - uGrid.y * 0.5) / uFocal);
  return vec3(r.x * z, r.y * z, -z);
}

void main() {
  ivec2 p = ivec2(position.xy);
  float fmax = uFrames - 1.0;
  float f = clamp(uT0 / uDt, 0.0, fmax);
  float z = texelFetch(uDepth, ivec3(p, int(floor(f + 0.5))), 0).r;
  // where the point is depends on the moment it shows, so settle it twice
  for (int i = 0; i < 2; i++) {
    f = clamp(sliceTime(pointAt(p, z)) / uDt, 0.0, fmax);
    z = texelFetch(uDepth, ivec3(p, int(floor(f + 0.5))), 0).r;
  }
  int i0 = int(floor(f));
  int i1 = min(i0 + 1, int(fmax));
  vCol = mix(texelFetch(uColor, ivec3(p, i0), 0).rgb, texelFetch(uColor, ivec3(p, i1), 0).rgb, smoothstep(0.15, 0.85, f - floor(f)));
  vec3 q = pointAt(p, z);
  // above, the slice sits at its moment in the block; standing on it, your now is flat around you
  // and the tilt only decides which moment each place shows
  float h = mix(f * uDt, uT0, uInside);
  vec3 pos = vec3(q.x, h * uK + q.y * uRelief, q.z);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  vA = 1.0;
  float spacing = max(z, 0.5) / uFocal * uStride * 1.5;
  gl_PointSize = clamp(uPx * spacing / max(-mv.z, 0.05), 1.0, 28.0);
  if (z >= uSky || -mv.z < 0.05) { gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
}
`;

// history away from now: the movers' ghosts and the still world's columns
const HISTORY_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aTime;
uniform float uK;
uniform float uRelief;
uniform float uSigma;
uniform float uDur;
uniform float uPx;
uniform float uFocal;
uniform float uStride;
uniform float uBaseA;
uniform float uInside;
uniform float uWarm;
${SLICE_TIME}
varying vec3 vCol;
varying float vA;
void main() {
  float d = aTime - sliceTime(position);
  // the slice itself shows this moment for real, so the history steps aside there
  float on = exp(-(d * d) / (uSigma * uSigma));
  // inside, the past and future stack below and above your own now, not the block's
  float h = mix(aTime, uT0 + d, uInside);
  vec3 p = vec3(position.x, h * uK + position.y * uRelief, position.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // the past glows warm, the future cool
  float ahead = clamp(d / (uDur * 0.3), -1.0, 1.0);
  vec3 tint = ahead > 0.0 ? vec3(0.6, 0.8, 1.25) : vec3(1.25, 0.85, 0.6);
  float lum = dot(aColor, vec3(0.3, 0.59, 0.11));
  vCol = mix(aColor, vec3(lum) * tint, uWarm);
  float keep = mix(1.0, exp(-abs(d) / (uDur * 0.12)), uInside);
  vA = uBaseA * keep * (1.0 - on);
  float spacing = max(-position.z, 0.5) / uFocal * uStride * 1.6;
  gl_PointSize = clamp(uPx * spacing * mix(1.0, 0.55, uInside) / max(-mv.z, 0.05), 1.0, mix(20.0, 9.0, uInside));
  if (vA < 0.004 || -mv.z < 0.05) { gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
}
`;

const POINT_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = dot(c, c);
  if (r > 0.25) discard;
  gl_FragColor = vec4(vCol, vA * smoothstep(0.25, 0.05, r));
}
`;

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const MAX_BETA = 0.75;

export class UniverseLab {
  constructor(root, { t }) {
    this.root = root;
    this.t = t;
    this.canvas = root.querySelector('#lab-canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x020308, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 2000);
    this.active = false;
    this.afterRender = null;
    this.onRec = null;          // set by main.js: toggles recording
    this.recStatus = null;      // set by main.js: seconds recorded, or null
    this.objects = [];
    this.textures = [];
    this.coarse = matchMedia('(pointer: coarse)').matches;

    this.u = {
      uK: { value: 1 }, uT0: { value: 0 }, uC: { value: 2 },
      uBeta: { value: new THREE.Vector2() }, uObs: { value: new THREE.Vector2() },
      uRelief: { value: RELIEF }, uSigma: { value: 0.2 }, uDur: { value: 1 },
      uPx: { value: 500 }, uFocal: { value: 400 }, uInside: { value: 0 },
      uDepth: { value: null }, uColor: { value: null }, uGrid: { value: new THREE.Vector2(1, 1) },
      uFrames: { value: 1 }, uDt: { value: 1 }, uSky: { value: 22 },
    };

    this.t0 = 0;
    this.beta = new THREE.Vector2();
    this.clockOn = true;        // clockwork universe: time runs by itself
    this.inside = 0;            // 0 above .. 1 standing on now
    this.insideTarget = 0;
    this.obs = new THREE.Vector2();   // where you stand inside (x, z)
    this.tau = 0;               // your proper time inside
    this.orbit = { az: 0.75, el: 0.32, dist: 40 };
    this.look = { yaw: 0, pitch: 0 };
    this.stickV = { x: 0, y: 0 };
    this.keys = new Set();
    this.motion = new MotionWalker();

    this._stars();
    this._bindUi();
    this._bindInput();
    window.addEventListener('resize', () => this.active && this._resize());
  }

  _stars() {
    const n = 1800, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      pos.set([Math.cos(a) * s * 900, u * 900, Math.sin(a) * s * 900], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x9fb3d9, size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.55, depthWrite: false }));
    stars.frustumCulled = false;
    this.stars = stars;
    this.scene.add(stars);
  }

  _bindUi() {
    const $ = (id) => this.root.querySelector(id);
    this.readout = $('#lab-readout');
    this.hint = $('#lab-hint');
    this.mode = $('#lab-mode');
    this.diveBtn = $('#lab-dive');
    this.recBtn = $('#lab-rec');
    this.recBtn.onclick = () => this.onRec && this.onRec();
    $('#lab-close').onclick = () => this.close();
    this.playInput = $('#lab-play');
    this.playInput.onchange = () => { this.clockOn = this.playInput.checked; };
    this.diveBtn.onclick = async () => {
      const goingIn = this.insideTarget < 0.5;
      if (goingIn && motionSupported()) {
        // ask for motion from inside the tap, as iOS requires
        let ok = false;
        try { ok = await requestMotionPermission(); } catch (_) { ok = false; }
        if (ok) this.motion.start();
      }
      if (!goingIn) this.motion.stop();
      if (goingIn) { this.obs.set(0, 0); this.tau = 0; this.beta.set(0, 0); }
      this.insideTarget = goingIn ? 1 : 0;
      this.look.yaw = 0; this.look.pitch = 0;
      this._labels();
    };
    new Stick($('#lab-stick'), $('#lab-knob'), (x, y) => { this.stickV.x = x; this.stickV.y = y; });
  }

  _labels() {
    const t = this.t;
    const inside = this.insideTarget > 0.5;
    this.diveBtn.textContent = t(inside ? 'lab.rise' : 'lab.dive');
    this.mode.textContent = t(inside ? 'lab.mode.proper' : 'lab.mode.clock');
    const touch = this.coarse;
    this.hint.textContent = t(inside ? (touch ? 'lab.hint.inside.touch' : 'lab.hint.inside') : (touch ? 'lab.hint.block.touch' : 'lab.hint.block'));
    this.root.querySelector('.lab-toggle').classList.toggle('hidden', inside);
  }

  _bindInput() {
    const pointers = new Map();
    let pinch = null;
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { c.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: this.orbit.dist };
      }
    });
    c.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      pointers.set(e.pointerId, cur);
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.orbit.dist = THREE.MathUtils.clamp(pinch.dist * (pinch.d / Math.max(d, 1)), this.minDist, this.maxDist);
        return;
      }
      const dx = cur.x - prev.x, dy = cur.y - prev.y;
      if (this.insideTarget > 0.5) {
        this.look.yaw += dx * 0.005;
        this.look.pitch = THREE.MathUtils.clamp(this.look.pitch + dy * 0.005, -1.45, 1.45);
      } else {
        this.orbit.az -= dx * 0.006;
        this.orbit.el = THREE.MathUtils.clamp(this.orbit.el + dy * 0.005, -1.3, 1.45);
      }
    });
    const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.orbit.dist = THREE.MathUtils.clamp(this.orbit.dist * Math.exp(e.deltaY * 0.001), this.minDist, this.maxDist);
    }, { passive: false });
    // the lab takes the keyboard while it is open (capture phase, so the scene underneath stays put)
    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (e.code === 'Escape') { this.close(); return; }
      this.keys.add(e.code);
      e.stopImmediatePropagation();
    }, true);
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); }, true);
  }

  _uploadFrames(tf) {
    const { width: W, height: H, frames: F } = tf;
    const depth = new THREE.DataArrayTexture(tf.depth, W, H, F);
    depth.format = THREE.RedFormat;
    depth.type = THREE.FloatType;
    const color = new THREE.DataArrayTexture(tf.color, W, H, F);
    color.format = THREE.RGBAFormat;
    for (const tex of [depth, color]) {
      tex.minFilter = tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
    }
    this.textures.push(depth, color);
    this.u.uDepth.value = depth;
    this.u.uColor.value = color;
    this.u.uGrid.value.set(W, H);
    this.u.uFrames.value = F;
  }

  // tf: the time field; opts: { far, duration, c, t0 }
  open(tf, opts) {
    this._dispose();
    const data = buildLabData(tf, { ...opts, coarse: this.coarse });
    const b = data.bounds;
    this.bounds = b;
    const u = this.u;
    this.k = b.k;
    u.uK.value = b.k;
    u.uDur.value = b.duration;
    u.uDt.value = b.dt;
    u.uC.value = opts.c || 2;
    u.uFocal.value = tf.focal;
    u.uSky.value = (opts.far || 25) * 0.9;
    u.uSigma.value = Math.max(b.dt * 0.75, 0.05);
    this._uploadFrames(tf);
    this.t0 = opts.t0 ?? b.duration / 2;
    this.beta.set(0, 0);
    this.obs.set(0, 0);
    this.inside = this.insideTarget = 0;
    this.motion.stop();
    this.clockOn = true;

    // the now slice: the real frame, one point per (sampled) pixel
    const W = tf.width, H = tf.height;
    const ss = this.coarse || W * H > 200000 ? 2 : 1;
    const grid = [];
    for (let y = 0; y < H; y += ss) for (let x = 0; x < W; x += ss) grid.push(x, y, 0);
    const sliceGeo = new THREE.BufferGeometry();
    sliceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(grid), 3));
    this._add(new THREE.Points(sliceGeo, new THREE.ShaderMaterial({
      uniforms: { ...u, uStride: { value: ss } }, vertexShader: SLICE_VERT, fragmentShader: POINT_FRAG,
    })));

    const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
    // the still world's columns: its own colours through time (the stars' worldlines)
    const cols = new THREE.BufferGeometry();
    cols.setAttribute('position', new THREE.BufferAttribute(data.columns.positions, 3));
    cols.setAttribute('aColor', new THREE.BufferAttribute(data.columns.colors, 3, true));
    cols.setAttribute('aTime', new THREE.BufferAttribute(data.columns.times, 1));
    this.colMat = new THREE.ShaderMaterial({
      uniforms: { ...u, uStride: { value: data.columns.stride }, uBaseA: { value: 0.06 }, uWarm: { value: 0.3 } },
      vertexShader: HISTORY_VERT, fragmentShader: POINT_FRAG, ...additive,
    });
    this._add(new THREE.Points(cols, this.colMat));

    // the movers' ghosts along their worldtubes
    const actors = new THREE.BufferGeometry();
    actors.setAttribute('position', new THREE.BufferAttribute(data.actors.positions, 3));
    actors.setAttribute('aColor', new THREE.BufferAttribute(data.actors.colors, 3, true));
    actors.setAttribute('aTime', new THREE.BufferAttribute(data.actors.times, 1));
    this.actorMat = new THREE.ShaderMaterial({
      uniforms: { ...u, uStride: { value: data.actors.stride }, uBaseA: { value: 0.16 }, uWarm: { value: 0.75 } },
      vertexShader: HISTORY_VERT, fragmentShader: POINT_FRAG, ...additive,
    });
    this._add(new THREE.Points(actors, this.actorMat));

    // the block's outline and the grid of the first moment
    const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
    this.center = new THREE.Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, b.height, d)),
      new THREE.LineBasicMaterial({ color: 0x3a4a66, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    box.position.set(this.center.x, b.height / 2, this.center.z);
    this.box = box;
    this._add(box);
    const gridHelper = new THREE.GridHelper(Math.max(w, d), 16, 0x1d2840, 0x141c2e);
    gridHelper.position.set(this.center.x, 0, this.center.z);
    gridHelper.material.transparent = true;
    gridHelper.material.opacity = 0.7;
    this.grid = gridHelper;
    this._add(gridHelper);

    // the outline of now
    const planeGeo = new THREE.PlaneGeometry(w * 1.12, d * 1.12).rotateX(-Math.PI / 2);
    const plane = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }));
    plane.add(new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.8 })));
    this.plane = plane;
    this._add(plane);

    const span = Math.max(w, d, b.height);
    this.span = span;
    this.minDist = span * 0.35;
    this.maxDist = span * 4;

    this.active = true;
    this.root.classList.remove('hidden');
    this.playInput.checked = true;
    this._labels();
    this._resize();
    // a tall phone screen sees less across, so start further back
    this.orbit = { az: 0.75, el: 0.32, dist: Math.min(span * 1.9 * Math.max(1, 0.9 / this.camera.aspect), this.maxDist) };
    this.clock = new THREE.Timer();
    this.renderer.setAnimationLoop(() => this._frame());
    return data;
  }

  close() {
    if (!this.active) return;
    this.active = false;
    this.motion.stop();
    this.renderer.setAnimationLoop(null);
    this.root.classList.add('hidden');
    this._dispose();
    if (this.onClose) this.onClose();
  }

  _add(obj) {
    obj.frustumCulled = false;
    this.objects.push(obj);
    this.scene.add(obj);
  }

  _dispose() {
    for (const o of this.objects) {
      this.scene.remove(o);
      o.traverse((c) => { c.geometry?.dispose(); c.material?.dispose(); });
    }
    for (const tex of this.textures) tex.dispose();
    this.objects = [];
    this.textures = [];
  }

  _resize() {
    const w = this.root.clientWidth || window.innerWidth, h = this.root.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.u.uPx.value = (this.camera.projectionMatrix.elements[5] * buf.y) / 2;
  }

  _wrap(t) {
    const d = this.bounds.duration;
    return ((t % d) + d) % d;
  }

  _frame() {
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const b = this.bounds, u = this.u;
    const c = u.uC.value;

    const k = this.keys;
    const ky = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const kx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const sy = this.stickV.y || ky, sx = this.stickV.x || kx;

    let gamma = 1;
    if (this.insideTarget > 0.5) {
      // proper time: the stick walks you through space, relative to where you look
      const yaw = this.camYaw ?? 0;
      const fwd = new THREE.Vector2(-Math.sin(yaw), -Math.cos(yaw));
      const right = new THREE.Vector2(Math.cos(yaw), -Math.sin(yaw));
      const want = fwd.multiplyScalar(sy).add(right.multiplyScalar(sx));
      if (want.length() > 1) want.normalize();
      want.multiplyScalar(MAX_BETA);
      this.beta.lerp(want, 1 - Math.exp(-dt / 0.3));
      this.obs.addScaledVector(this.beta, c * dt);
      this.obs.x = THREE.MathUtils.clamp(this.obs.x, b.minX, b.maxX);
      this.obs.y = THREE.MathUtils.clamp(this.obs.y, b.minZ, b.maxZ);
      gamma = 1 / Math.sqrt(1 - Math.min(this.beta.lengthSq(), 0.99));
      // one second of your life is gamma seconds of the clip's own time
      this.tau += dt;
      this.t0 = this._wrap(this.t0 + gamma * dt);
    } else {
      // clockwork universe: a clock outside runs now on; the stick scrubs it and sets a speed along x
      this.t0 += sy * dt * (b.duration / 4);
      if (this.clockOn) this.t0 += dt;
      this.t0 = this.clockOn ? this._wrap(this.t0) : THREE.MathUtils.clamp(this.t0, 0, b.duration);
      this.beta.lerp(new THREE.Vector2(THREE.MathUtils.clamp(sx, -1, 1) * MAX_BETA, 0), 1 - Math.exp(-dt / 0.25));
      this.obs.lerp(new THREE.Vector2(0, 0), 1 - Math.exp(-dt / 0.5));
    }
    u.uT0.value = this.t0;
    u.uBeta.value.copy(this.beta);
    u.uObs.value.copy(this.obs);

    // above <-> on now
    const step = dt / 1.6;
    this.inside = this.insideTarget > this.inside ? Math.min(this.insideTarget, this.inside + step) : Math.max(this.insideTarget, this.inside - step);
    const m = ease(this.inside);
    u.uInside.value = m;
    this.root.classList.toggle('inside', m > 0.5);
    u.uRelief.value = RELIEF + (1 - RELIEF) * m;
    u.uK.value = this.k * (1 + 1.5 * m);
    this.colMat.uniforms.uBaseA.value = 0.06 - 0.035 * m;
    this.actorMat.uniforms.uBaseA.value = 0.16 - 0.06 * m;
    this.box.material.opacity = 0.55 * (1 - m);
    this.grid.material.opacity = 0.7 * (1 - m);
    this.box.scale.y = 1 + 1.5 * m;
    this.box.position.y = (b.height * (1 + 1.5 * m)) / 2;

    // the outline of now: height k * sliceTime, tilted along the velocity
    const kk = u.uK.value;
    const tCenter = this.t0 + (this.beta.x * (this.center.x - this.obs.x) + this.beta.y * (this.center.z - this.obs.y)) / c;
    this.plane.position.set(this.center.x, kk * tCenter, this.center.z);
    this.plane.rotation.set(-Math.atan((kk * this.beta.y) / c), 0, Math.atan((kk * this.beta.x) / c), 'XYZ');
    this.plane.visible = m < 0.98;

    // camera: orbit the block, or stand at your place on now
    const o = this.orbit;
    const target = new THREE.Vector3(this.center.x, b.height * 0.5, this.center.z);
    const orbitPos = new THREE.Vector3(
      target.x + o.dist * Math.cos(o.el) * Math.sin(o.az),
      target.y + o.dist * Math.sin(o.el),
      target.z + o.dist * Math.cos(o.el) * Math.cos(o.az),
    );
    const orbitQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(orbitPos, target, new THREE.Vector3(0, 1, 0)));
    const insidePos = new THREE.Vector3(this.obs.x, kk * this.t0, this.obs.y);
    let insideQ;
    if (this.motion.active) {
      const s = this.motion.update(dt);
      insideQ = s.ready ? s.quat.clone() : new THREE.Quaternion();
    } else {
      insideQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.look.pitch, this.look.yaw, 0, 'YXZ'));
    }
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(insideQ);
    this.camYaw = Math.atan2(-f.x, -f.z);
    this.camera.position.lerpVectors(orbitPos, insidePos, m);
    this.camera.quaternion.slerpQuaternions(orbitQ, insideQ, m);
    this.stars.position.copy(this.camera.position);

    const speed = this.beta.length();
    this.readout.textContent = this.insideTarget > 0.5
      ? this.t('lab.readout.inside', { tau: this.tau.toFixed(1), t: this.t0.toFixed(1), d: b.duration.toFixed(1), b: speed.toFixed(2), g: gamma.toFixed(2) })
      : this.t('lab.readout', {
        t: this.t0.toFixed(1), d: b.duration.toFixed(1), b: this.beta.x.toFixed(2),
        s: (Math.abs(this.beta.x) * Math.max(Math.abs(b.minX), Math.abs(b.maxX)) / c).toFixed(1),
      });
    const rec = this.recStatus ? this.recStatus() : null;
    this.recBtn.classList.toggle('on', rec !== null);
    this.recBtn.textContent = rec !== null ? `● ${Math.floor(rec / 60)}:${String(Math.floor(rec % 60)).padStart(2, '0')}` : '●';

    this.renderer.render(this.scene, this.camera);
    if (this.afterRender) this.afterRender();
  }
}
