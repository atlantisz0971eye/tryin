// UniverseChopLAb: an immersive block universe made of the uploaded clip (see labdata.js).
//
//   block view   the whole history floats in space. The "now" slice cuts through it; push the stick
//                up or down to move now through time, sideways to move fast (the slice tilts by
//                Lorentz: t = T0 + beta x / c). Where the slice cuts the worldtubes, the actors light up.
//   inside       you stand on the slice at the capture point, at human scale: the static world and
//                the actors of now around you, the future stacked overhead, the past under your feet.
//                Turn the phone (or drag) to look; the stick still moves now and tilts it.

import * as THREE from 'three';
import { buildLabData, RELIEF } from './labdata.js';
import { Stick } from '../stick.js';
import { MotionWalker, motionSupported, requestMotionPermission } from '../motion.js';

const ACTOR_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aTime;
uniform float uK;
uniform float uT0;
uniform float uBeta;
uniform float uC;
uniform float uRelief;
uniform float uSigma;
uniform float uDur;
uniform float uPx;
uniform float uFocal;
uniform float uStride;
uniform float uGhostA;
uniform float uInside;
varying vec3 vCol;
varying float vA;
void main() {
  float tSlice = uT0 + uBeta * position.x / uC;
  float d = aTime - tSlice;
  float on = exp(-(d * d) / (uSigma * uSigma));
  vec3 p = vec3(position.x, aTime * uK + position.y * uRelief, position.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // the past glows warm, the future cool, as in the photo's time tint
  float ahead = clamp(d / (uDur * 0.3), -1.0, 1.0);
  vec3 tint = ahead > 0.0 ? vec3(0.55, 0.78, 1.3) : vec3(1.3, 0.82, 0.55);
  float lum = dot(aColor, vec3(0.3, 0.59, 0.11));
  vec3 ghost = mix(aColor, vec3(lum) * tint, 0.75);
  vCol = mix(ghost, aColor * mix(1.15, 0.7, uInside), on);
  // inside, far moments fade so the stack around you stays readable
  float keep = mix(1.0, exp(-abs(d) / (uDur * 0.1)), uInside);
  vA = mix(uGhostA * keep, 1.0, on);
  float spacing = max(-position.z, 0.5) / uFocal * uStride * 1.7;
  gl_PointSize = clamp(uPx * spacing * mix(0.8, 1.25, on) / max(-mv.z, 0.05), 1.0, 24.0);
}
`;

const POINT_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = dot(c, c);
  if (r > 0.25) discard;
  float a = vA * smoothstep(0.25, 0.05, r);
  gl_FragColor = vec4(vCol, a);
}
`;

// the static world rides on the slice: the "now" of everything that stays put
const FLOOR_VERT = /* glsl */ `
attribute vec3 aColor;
uniform float uK;
uniform float uT0;
uniform float uBeta;
uniform float uC;
uniform float uRelief;
uniform float uPx;
uniform float uFocal;
uniform float uFloorA;
varying vec3 vCol;
varying float vA;
void main() {
  float t = uT0 + uBeta * position.x / uC;
  vec3 p = vec3(position.x, t * uK + position.y * uRelief, position.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vCol = aColor;
  vA = uFloorA;
  float spacing = max(-position.z, 0.5) / uFocal * 2.0 * 1.6;
  gl_PointSize = clamp(uPx * spacing / max(-mv.z, 0.05), 1.0, 20.0);
}
`;

// straight worldlines of the static world; they glow amber where the slice crosses them
const LINE_VERT = /* glsl */ `
attribute vec4 aColor;
uniform float uK;
uniform float uDur;
uniform float uRelief;
uniform float uT0;
uniform float uBeta;
uniform float uC;
uniform float uSigma;
uniform float uLineA;
varying vec3 vCol;
varying float vA;
void main() {
  float t = position.w * uDur;
  vec3 p = vec3(position.x, t * uK + position.y * uRelief, position.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  float tSlice = uT0 + uBeta * position.x / uC;
  float glow = exp(-pow((t - tSlice) / (uSigma * 2.5), 2.0));
  vec3 star = vec3(1.0, 0.72, 0.32);
  vCol = mix(mix(aColor.rgb, star, 0.55), star, glow);
  vA = (aColor.a * uLineA) * (1.0 + 6.0 * glow);
}
`;

const LINE_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vA;
void main() { gl_FragColor = vec4(vCol, vA); }
`;

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

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
    this.objects = [];

    this.u = {
      uK: { value: 1 }, uT0: { value: 0 }, uBeta: { value: 0 }, uC: { value: 2 },
      uRelief: { value: RELIEF }, uSigma: { value: 0.2 }, uDur: { value: 1 },
      uPx: { value: 500 }, uFocal: { value: 400 }, uStride: { value: 1 },
      uGhostA: { value: 0.14 }, uInside: { value: 0 }, uFloorA: { value: 0.9 }, uLineA: { value: 0.12 },
    };

    // state
    this.t0 = 0;
    this.beta = 0;
    this.betaTarget = 0;
    this.play = false;
    this.inside = 0;          // 0 block view .. 1 standing on the slice
    this.insideTarget = 0;
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
    this.diveBtn = $('#lab-dive');
    $('#lab-close').onclick = () => this.close();
    const play = $('#lab-play');
    play.onchange = () => { this.play = play.checked; };
    this.playInput = play;
    this.diveBtn.onclick = async () => {
      const goingIn = this.insideTarget < 0.5;
      if (goingIn && motionSupported()) {
        // ask for motion from inside the tap, as iOS requires
        let ok = false;
        try { ok = await requestMotionPermission(); } catch (_) { ok = false; }
        if (ok) this.motion.start();
      }
      if (!goingIn) this.motion.stop();
      this.insideTarget = goingIn ? 1 : 0;
      this.look.yaw = 0; this.look.pitch = 0;
      this._labels();
    };
    new Stick($('#lab-stick'), $('#lab-knob'), (x, y) => { this.stickV.x = x; this.stickV.y = y; });
  }

  _labels() {
    const t = this.t;
    this.diveBtn.textContent = t(this.insideTarget > 0.5 ? 'lab.rise' : 'lab.dive');
    const touch = matchMedia('(pointer: coarse)').matches;
    this.hint.textContent = t(this.insideTarget > 0.5 ? (touch ? 'lab.hint.inside.touch' : 'lab.hint.inside') : (touch ? 'lab.hint.block.touch' : 'lab.hint.block'));
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

  // tf: the time field; opts: { far, duration, c, fps }
  open(tf, opts) {
    this._dispose();
    const data = buildLabData(tf, opts);
    const b = data.bounds;
    this.bounds = b;
    const u = this.u;
    u.uK.value = b.k;
    this.k = b.k;
    u.uDur.value = b.duration;
    u.uC.value = opts.c || 2;
    u.uFocal.value = tf.focal;
    u.uStride.value = data.actors.stride;
    u.uSigma.value = Math.max(b.dt * 0.75, 0.05);
    this.t0 = opts.t0 ?? b.duration / 2;
    this.beta = this.betaTarget = 0;
    this.inside = this.insideTarget = 0;
    this.motion.stop();

    const actors = new THREE.BufferGeometry();
    actors.setAttribute('position', new THREE.BufferAttribute(data.actors.positions, 3));
    actors.setAttribute('aColor', new THREE.BufferAttribute(data.actors.colors, 3, true));
    actors.setAttribute('aTime', new THREE.BufferAttribute(data.actors.times, 1));
    const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
    this._add(new THREE.Points(actors, new THREE.ShaderMaterial({ uniforms: u, vertexShader: ACTOR_VERT, fragmentShader: POINT_FRAG, ...additive })));

    const floor = new THREE.BufferGeometry();
    floor.setAttribute('position', new THREE.BufferAttribute(data.floor.positions, 3));
    floor.setAttribute('aColor', new THREE.BufferAttribute(data.floor.colors, 3, true));
    this._add(new THREE.Points(floor, new THREE.ShaderMaterial({ uniforms: u, vertexShader: FLOOR_VERT, fragmentShader: POINT_FRAG, transparent: true, depthWrite: false })));

    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.BufferAttribute(data.lines.positions, 4));
    lines.setAttribute('aColor', new THREE.BufferAttribute(data.lines.colors, 4, true));
    this._add(new THREE.LineSegments(lines, new THREE.ShaderMaterial({ uniforms: u, vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, ...additive })));

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
    const grid = new THREE.GridHelper(Math.max(w, d), 16, 0x1d2840, 0x141c2e);
    grid.position.set(this.center.x, 0, this.center.z);
    grid.material.transparent = true;
    grid.material.opacity = 0.7;
    this.grid = grid;
    this._add(grid);

    // the now slice
    const sliceGeo = new THREE.PlaneGeometry(w * 1.12, d * 1.12).rotateX(-Math.PI / 2);
    const slice = new THREE.Mesh(sliceGeo, new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
    slice.add(new THREE.LineSegments(new THREE.EdgesGeometry(sliceGeo), new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.8 })));
    this.slice = slice;
    this._add(slice);

    const span = Math.max(w, d, b.height);
    this.minDist = span * 0.35;
    this.maxDist = span * 4;
    this.orbit = { az: 0.75, el: 0.32, dist: span * 1.9 };

    this.active = true;
    this.root.classList.remove('hidden');
    this.playInput.checked = this.play = false;
    this._labels();
    this._resize();
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
    this.objects = [];
  }

  _resize() {
    const w = this.root.clientWidth || window.innerWidth, h = this.root.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.u.uPx.value = (this.camera.projectionMatrix.elements[5] * buf.y) / 2;
  }

  _frame() {
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const b = this.bounds, u = this.u;

    // inputs: the stick (or keys) moves now through time and sets the speed
    const k = this.keys;
    const ky = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const kx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const sy = this.stickV.y || ky, sx = this.stickV.x || kx;
    this.t0 += sy * dt * (b.duration / 4);
    if (this.play) this.t0 += dt;
    if (this.t0 > b.duration) this.t0 = this.play ? 0 : b.duration;
    if (this.t0 < 0) this.t0 = 0;
    this.betaTarget = THREE.MathUtils.clamp(sx, -1, 1) * 0.75;
    this.beta += (this.betaTarget - this.beta) * (1 - Math.exp(-dt / 0.25));
    u.uT0.value = this.t0;
    u.uBeta.value = this.beta;

    // block view <-> standing on the slice
    const step = dt / 1.6;
    this.inside = this.insideTarget > this.inside ? Math.min(this.insideTarget, this.inside + step) : Math.max(this.insideTarget, this.inside - step);
    const m = ease(this.inside);
    u.uInside.value = m;
    u.uRelief.value = RELIEF + (1 - RELIEF) * m;
    u.uK.value = this.k * (1 + 1.5 * m);
    u.uGhostA.value = 0.14 + 0.06 * m;
    u.uLineA.value = 0.3 * (1 - 0.6 * m);
    this.box.material.opacity = 0.55 * (1 - m);
    this.grid.material.opacity = 0.7 * (1 - m);

    // the slice: height k (T0 + beta x / c), tilted along x
    const kk = u.uK.value;
    this.slice.position.set(this.center.x, kk * (this.t0 + (this.beta * this.center.x) / u.uC.value), this.center.z);
    this.slice.rotation.set(0, 0, Math.atan((kk * this.beta) / u.uC.value));
    this.slice.material.opacity = 0.08 * (1 - 0.7 * m);
    this.box.scale.y = 1 + 1.5 * m;
    this.box.position.y = (b.height * (1 + 1.5 * m)) / 2;

    // camera: orbit around the block, or stand at the capture point on the slice
    const o = this.orbit;
    const target = new THREE.Vector3(this.center.x, b.height * 0.5, this.center.z);
    const orbitPos = new THREE.Vector3(
      target.x + o.dist * Math.cos(o.el) * Math.sin(o.az),
      target.y + o.dist * Math.sin(o.el),
      target.z + o.dist * Math.cos(o.el) * Math.cos(o.az),
    );
    const orbitQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(orbitPos, target, new THREE.Vector3(0, 1, 0)));
    const insidePos = new THREE.Vector3(0, kk * this.t0, 0);
    let insideQ;
    if (this.motion.active) {
      const step2 = this.motion.update(dt);
      insideQ = step2.ready ? step2.quat.clone() : new THREE.Quaternion();
    } else {
      insideQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.look.pitch, this.look.yaw, 0, 'YXZ'));
    }
    this.camera.position.lerpVectors(orbitPos, insidePos, m);
    this.camera.quaternion.slerpQuaternions(orbitQ, insideQ, m);
    this.stars.position.copy(this.camera.position);

    this.readout.textContent = this.t('lab.readout', {
      t: this.t0.toFixed(1), d: b.duration.toFixed(1), b: this.beta.toFixed(2),
      s: (Math.abs(this.beta) * Math.max(Math.abs(b.minX), Math.abs(b.maxX)) / u.uC.value).toFixed(1),
    });

    this.renderer.render(this.scene, this.camera);
    if (this.afterRender) this.afterRender();
  }
}
