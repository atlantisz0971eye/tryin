import * as THREE from 'three';

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
uniform float uPxScale;
uniform float uSizeMul;
uniform float uReveal;
uniform float uTime;
uniform float uShimmer;
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
  float ps = aSize * uSizeMul * uPxScale / max(d, 0.001);
  ps *= smoothstep(h * 0.6, h * 0.6 + 0.4, uReveal);
  vAlpha = aAlpha * (1.0 - uShimmer * 0.45 * (0.5 + 0.5 * sin(uTime * 0.6 + h * 40.0)));
  if (ps < 1.0) { vAlpha *= ps; ps = 1.0; }
  gl_PointSize = d < 0.03 ? 0.0 : min(ps, 96.0);
  vColor = aColor;
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

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x050505, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.02, 500);
    this.camera.rotation.order = 'YXZ';

    this.uniforms = {
      uPxScale: { value: 1 },
      uSizeMul: { value: 1.4 },
      uReveal: { value: 0 },
      uTime: { value: 0 },
      uShimmer: { value: 1 },
    };
    this.layers = {};
    this.revealStart = 0;

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

  setScene(built) {
    for (const obj of Object.values(this.layers)) {
      this.scene.remove(obj);
      obj.geometry.dispose();
    }
    this.layers = {
      photo: this._makePoints(built.photo, FRAG_SOLID, false),
      shadow: this._makePoints(built.shadow, FRAG_SOLID, false),
      ash: this._makePoints(built.ash, FRAG_ASH, true),
    };
    for (const obj of Object.values(this.layers)) this.scene.add(obj);
    this.camera.fov = built.meta.vfov;
    this._resize();
    this.revealStart = this.timer.getElapsed();
  }

  _makePoints(layer, frag, transparent) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(layer.positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(layer.colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(layer.sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(layer.alphas, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
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

  resetView() {
    this.returning = { from: this.pos.clone(), yaw: this.yaw, pitch: this.pitch, t: 0 };
  }

  _resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const bufH = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    this.uniforms.uPxScale.value = (this.camera.projectionMatrix.elements[5] * bufH) / 2;
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

    this.camera.position.copy(this.pos);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    if (this.onMove) this.onMove(this.pos.length());
    this.renderer.render(this.scene, this.camera);
  }
}
