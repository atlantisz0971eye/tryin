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
uniform vec2 uGrid;
uniform float uFocal;
uniform float uSoft;
uniform float uSoftMul;
uniform float uSoftLo;
uniform float uSoftHi;
uniform float uFeather;
uniform float uPassScale;
varying float vSoft;
varying float vEdge;
varying float vWeight;

// Vision Pro style border: inside a band along the picture's edge, points grow, soften and fade,
// so the picture itself dissolves into the blurred backdrop rather than ending in a hard line.
float edgeT(vec2 pix) {
  float edge = min(min(pix.x, uGrid.x - pix.x), min(pix.y, uGrid.y - pix.y)) / (uFeather * max(uGrid.x, uGrid.y) + 1e-4);
  return uFeather > 0.0 ? smoothstep(0.0, 1.0, clamp(edge, 0.0, 1.0)) : 1.0;
}

void edgeBlend(vec2 pix, inout float ps, float sizeSoft) {
  float t = edgeT(pix);
  float e = 1.0 - t;
  float grow = 1.0 + 4.0 * e * e;
  // inside the band: halo only, with blur set by the growth and opacity by the distance to the edge
  vSoft = t < 0.98 ? 1.0 : sizeSoft;
  vEdge = t;
  // bigger blobs overlap more, so divide by their area to keep coverage ~ t
  vWeight = pow(t, 1.3) / (grow * grow);
  ps *= (1.0 + 0.7 * sizeSoft) * grow;
}
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
  // once a point is blown up on screen it turns into a soft blob: up close the cloud reads as
  // out-of-focus light instead of hard coins
  vec2 pix = position.xy / max(-position.z, 1e-4) * uFocal * vec2(1.0, -1.0) + uGrid * 0.5;
  float sizeSoft = uSoft * uSoftMul * smoothstep(uSoftLo, uSoftHi, ps);
  bool hide = false;
  if (uIsPhoto > 0.5) {
    edgeBlend(pix, ps, sizeSoft);
  } else {
    // only the picture itself melts into the backdrop (shadow and ash halos would smear dark
    // across it); these layers just thin out towards the border
    float t = edgeT(pix);
    hide = fract(h * 91.7) >= smoothstep(0.85, 1.0, t);   // >= so a zero random value is hidden too
    // Seen from the capture point the photo has to be whole. The charred imprint and the ash hang
    // in the gap behind the picture, so they only come out as you step off the original ray.
    float par = length(cross(normalize(cameraPosition - position), normalize(-position)));
    hide = hide || fract(h * 37.7) >= smoothstep(0.012, 0.1, par);
    vAlpha *= t;
    vSoft = sizeSoft;
    vEdge = 1.0;
    vWeight = 1.0;
    ps *= 1.0 + 0.7 * sizeSoft;
  }
  if (d < 0.03 || hide) {
    // clip it away instead of giving it size 0: on some GPUs a zero-size point still draws one pixel
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  } else {
    gl_PointSize = min(ps, uMaxPx * (1.0 + 3.0 * (1.0 - vEdge))) * uPassScale;
  }
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
varying float vSoft;
varying float vEdge;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  // inside the border band everything is drawn as halo only
  if (vEdge < 0.98) discard;
  // soft points keep only a small opaque core; the halo is drawn by FRAG_HALO
  if (dot(c, c) > mix(1.0, 0.06, vSoft)) discard;
  gl_FragColor = vec4(vColor, 1.0);
}
`;

const FRAG_HALO = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vSoft;
varying float vWeight;
void main() {
  if (vSoft < 0.01 || vWeight < 0.001) discard;
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float a = vSoft * vWeight * exp(-r2 * 2.2);
  gl_FragColor = vec4(vColor * a, a);
}
`;

// Resolves the accumulated halos: weighted average colour, coverage from the summed weight.
const COMPOSITE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tAccum;
varying vec2 vUv;
void main() {
  vec4 acc = texture2D(tAccum, vUv);
  if (acc.a < 0.002) discard;
  gl_FragColor = vec4(acc.rgb / acc.a, clamp(acc.a * 1.4, 0.0, 1.0));
}
`;

// An enormous, heavily blurred copy of the picture around everything, like the glow that
// surrounds spatial photos on Vision Pro. Edge colours stretch outwards and fade.
const BG_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BG_FRAG = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uBg;
uniform float uBgFrame;
uniform float uBgFrames;
uniform float uBgStrength;
uniform vec2 uGrid;
uniform float uFocal;
varying vec3 vDir;

vec3 sampleBg(vec2 uv) {
  float fl = floor(uBgFrame);
  float l1 = min(fl + 1.0, uBgFrames - 1.0);
  return mix(texture(uBg, vec3(uv, fl)).rgb, texture(uBg, vec3(uv, l1)).rgb, uBgFrame - fl);
}

void main() {
  vec3 d = normalize(vDir);
  float fwd = max(-d.z, 0.08);
  vec2 uv = vec2(d.x / fwd * uFocal / uGrid.x, -d.y / fwd * uFocal / uGrid.y) + 0.5;
  vec2 cuv = clamp(uv, 0.0, 1.0);
  vec2 out2 = max(abs(uv - 0.5) - 0.5, 0.0) * vec2(uGrid.x / uGrid.y, 1.0);
  float outside = length(out2);
  // blend in a sample pulled towards the centre so stretched edges smear into a wide glow
  vec3 col = mix(sampleBg(cuv), sampleBg(mix(cuv, vec2(0.5), 0.35)), clamp(outside, 0.0, 0.6));
  float behind = smoothstep(-0.1, 0.5, d.z);
  float glow = mix(0.88, 0.14, 1.0 - exp(-outside * 1.1)) * (1.0 - 0.75 * behind);
  gl_FragColor = vec4(col * glow * uBgStrength, 1.0);
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
uniform vec3 uVel;
uniform float uGamma;
uniform vec3 uW;
uniform float uTint;
uniform vec2 uViewport;
uniform float uPxScale;
uniform float uMaxPx;
uniform float uSizeMul;
uniform float uReveal;
uniform float uBleach;
uniform float uSoft;
uniform float uSoftMul;
uniform float uSoftLo;
uniform float uSoftHi;
uniform float uFeather;
uniform float uPassScale;
varying float vSoft;
varying float vEdge;
varying float vWeight;

// Vision Pro style border: inside a band along the picture's edge, points grow, soften and fade,
// so the picture itself dissolves into the blurred backdrop rather than ending in a hard line.
float edgeT(vec2 pix) {
  float edge = min(min(pix.x, uGrid.x - pix.x), min(pix.y, uGrid.y - pix.y)) / (uFeather * max(uGrid.x, uGrid.y) + 1e-4);
  return uFeather > 0.0 ? smoothstep(0.0, 1.0, clamp(edge, 0.0, 1.0)) : 1.0;
}

void edgeBlend(vec2 pix, inout float ps, float sizeSoft) {
  float t = edgeT(pix);
  float e = 1.0 - t;
  float grow = 1.0 + 4.0 * e * e;
  // inside the band: halo only, with blur set by the growth and opacity by the distance to the edge
  vSoft = t < 0.98 ? 1.0 : sizeSoft;
  vEdge = t;
  // bigger blobs overlap more, so divide by their area to keep coverage ~ t
  vWeight = pow(t, 1.3) / (grow * grow);
  ps *= (1.0 + 0.7 * sizeSoft) * grow;
}
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

// Which moment this particle shows (see timemodel.js):
//   T = T0 + w.x * γ (v·r)/c²  (relativity of simultaneity)
//          - w.y * |r|/c       (light travel time)
//          + w.z * (|p|-|r|)/c (change in distance since the original viewpoint)
float frameFor(ivec2 p, vec3 ray) {
  float fmax = uFrames - 1.0;
  float f = clamp(uAnchor, 0.0, fmax);
  // the particle's position depends on the frame it shows, so settle it in two passes
  for (int k = 0; k < 2; k++) {
    vec3 wp = ray * depthAt(p, f);
    vec3 r = wp - cameraPosition;
    float dist = length(r);
    float sec = uW.x * uGamma * dot(uVel, r) / (uC * uC)
              - uW.y * dist / uC
              + uW.z * (length(wp) - dist) / uC;
    f = clamp(uAnchor + sec * uFps, 0.0, fmax);
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
    // time tint, after the Doppler shift: the future you move towards turns blue, the past red
    float ahead = clamp((f - clamp(uAnchor, 0.0, uFrames - 1.0)) / (uFps * 2.0), -1.0, 1.0);
    vec3 shift = ahead > 0.0 ? vec3(0.78, 0.93, 1.22) : vec3(1.22, 0.9, 0.74);
    col = clamp(col * mix(vec3(1.0), shift, abs(ahead) * uTint), 0.0, 1.0);
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
  edgeBlend(pix, ps, uSoft * uSoftMul * smoothstep(uSoftLo, uSoftHi, ps));
  if (uIsPlate > 0.5 && vEdge < 0.98) visible = false;
  if (!visible || d < 0.03) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  } else {
    gl_PointSize = min(max(ps, 1.0), uMaxPx * (1.0 + 3.0 * (1.0 - vEdge))) * uPassScale;
  }
}
`;

// The photo as a height-field mesh textured with the full-resolution picture. Colour comes from the
// texture, so it stays sharp however coarse the depth grid is; geometry only decides where it sits.
const MESH_VERT = /* glsl */ `
attribute float aChar;
varying vec2 vUv;
varying float vChar;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vChar = aChar;
  vWorld = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MESH_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform vec2 uGrid;
uniform float uFeather;
uniform float uReveal;
uniform float uBleach;
uniform float uStretch;
varying vec2 vUv;
varying float vChar;
varying vec3 vWorld;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 pix = vUv * uGrid;
  float edge = min(min(pix.x, uGrid.x - pix.x), min(pix.y, uGrid.y - pix.y)) / (uFeather * max(uGrid.x, uGrid.y) + 1e-4);
  float t = uFeather > 0.0 ? smoothstep(0.0, 1.0, clamp(edge, 0.0, 1.0)) : 1.0;

  // torn silhouettes crumble: the closer to the torn edge, the more of it is gone. Only as you
  // step away from the capture point; from there the photo is whole and its edges are clean.
  float h = hash21(floor(vUv * uGrid * 3.0));
  float par = length(cross(normalize(cameraPosition - vWorld), normalize(-vWorld)));
  float vp = smoothstep(0.012, 0.1, par);
  if (vChar * 0.7 * vp > 0.2 + 0.8 * h) discard;

  // Stretched picture: how squarely this triangle faces you now, against how squarely it faced the
  // capture camera at the origin. Both use the same triangle, so at the capture point the ratio is
  // exactly 1 whatever the depth noise. A big jump means a sliver of the photo smeared over a wide
  // area; dissolve it into grain.
  vec3 nrm = cross(dFdx(vWorld), dFdy(vWorld));
  float nl = length(nrm);
  vec3 nn = nl > 1e-12 ? nrm / nl : vec3(0.0, 0.0, 1.0);
  float facingNow = abs(dot(nn, normalize(cameraPosition - vWorld)));
  float facingThen = abs(dot(nn, normalize(-vWorld)));
  float k = smoothstep(uStretch * 0.5, uStretch * 1.6, facingNow / (facingThen + 0.03));
  if (k > h) discard;

  // the picture's border melts into the backdrop: blurrier and fainter towards the edge
  vec3 col = textureLod(uMap, vUv, (1.0 - t) * 4.5).rgb;

  if (uBleach > 0.0) {
    float amt = uBleach * smoothstep(0.2, 3.0, length(cameraPosition));
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, mix(vec3(lum), vec3(0.93, 0.91, 0.86), 0.3 + 0.5 * lum), amt);
  }
  col *= 1.0 - 0.5 * vChar * vp;         // scorched where it tore
  if (!gl_FrontFacing) col *= 0.35;      // seen from behind

  float a = t * smoothstep(0.0, 1.0, uReveal);
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
}
`;

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 1);

    this.scene = new THREE.Scene();
    this.bgTexture = null;
    this.renderer.autoClear = false;
    // the soft halos need a float render target; without one, skip them rather than draw garbage
    const ext = this.renderer.extensions;
    this.halosOk = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');

    // soft halos are accumulated at half resolution, then averaged over the sharp scene
    this.haloScene = new THREE.Scene();
    this.accum = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.compScene = new THREE.Scene();
    this.compCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const comp = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { tAccum: { value: this.accum.texture } },
        vertexShader: COMPOSITE_VERT,
        fragmentShader: COMPOSITE_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    comp.frustumCulled = false;
    this.compScene.add(comp);
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
      uMaxPx: { value: 44 },
      uSoft: { value: 1 },
      uSoftLo: { value: 5 },
      uSoftHi: { value: 18 },
      uFeather: { value: 0.15 },
      uPassScale: { value: 1 },
      uGrid: { value: new THREE.Vector2(1, 1) },
      uFocal: { value: 1 },
    };
    this.feather = 0.15;
    this.halos = {};
    this.wanted = {};          // which layers the person wants shown
    this.surface = 'mesh';     // 'mesh' (sharp photo mesh) or 'particles'
    this.stretchUniform = { value: 4 };
    this.photoTex = null;
    this.photoTexSrc = null;
    this.bgUniforms = {
      uBg: { value: null },
      uBgFrame: { value: 0 },
      uBgFrames: { value: 1 },
      uBgStrength: { value: 1 },
      uGrid: this.uniforms.uGrid,
      uFocal: this.uniforms.uFocal,
    };
    this.bg = new THREE.Mesh(
      new THREE.SphereGeometry(300, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: this.bgUniforms,
        vertexShader: BG_VERT,
        fragmentShader: BG_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.bg.renderOrder = -1;
    this.bg.frustumCulled = false;
    this.bg.visible = false;
    this.layers = {};
    this.textures = [];
    this.revealStart = 0;
    this.timeUniforms = {
      uDepth: { value: null },
      uColor: { value: null },
      uPlateDepth: { value: null },
      uPlateColor: { value: null },
      uFrames: { value: 1 },
      uAnchor: { value: 0 },
      uC: { value: 1.5 },
      uFps: { value: 8 },
      uJump: { value: 0.12 },
      uGhost: { value: 0.6 },
      uVel: { value: new THREE.Vector3() },
      uGamma: { value: 1 },
      uW: { value: new THREE.Vector3(1, 0, 0) },
      uTint: { value: 0.6 },
    };
    this.onTick = null;
    this.wheelVel = 0;

    this.pos = new THREE.Vector3();
    // yaw / pitch are the viewer's own look offset; lookYaw / lookPitch is where the camera faces
    // after the gaze assist turns it towards the subject
    this.yaw = 0;
    this.pitch = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.assist = true;
    this.motion = null;   // a MotionWalker when walking with the phone
    this.focus = new THREE.Vector3(0, 0, -5);
    this.prevPos = new THREE.Vector3();
    this.keys = new Set();
    this.returning = null;
    this.onMove = null;

    this.scene.add(this.bg);
    this._bindInput();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    // the canvas lives inside the print's frame, which can change size on its own
    if (window.ResizeObserver) new ResizeObserver(() => this._resize()).observe(canvas);
    this.paused = false;
    this.timer = new THREE.Timer();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  _clear() {
    for (const obj of [...Object.values(this.layers), ...Object.values(this.halos)]) {
      this.scene.remove(obj);
      this.haloScene.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    }
    for (const t of this.textures) t.dispose();
    this.layers = {};
    this.halos = {};
    this.textures = [];
  }

  // the soft halo of every blown-up point of an opaque layer, summed into the accumulation buffer
  _addHalo(name, solid) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...solid.material.uniforms, uPassScale: { value: 0.5 } },
      vertexShader: solid.material.vertexShader,
      fragmentShader: FRAG_HALO,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    const halo = new THREE.Points(solid.geometry, mat);
    halo.frustumCulled = false;
    this.halos[name] = halo;
    this.haloScene.add(halo);
  }

  setScene(built) {
    this._clear();
    this.layers = {
      photo: this._makePoints(built.photo, FRAG_SOLID, false, true),
      shadow: this._makePoints(built.shadow, FRAG_SOLID, false),
      ash: this._makePoints(built.ash, FRAG_ASH, true),
    };
    this.layers.ash.renderOrder = 2;
    for (const obj of Object.values(this.layers)) this.scene.add(obj);
    this._addHalo('photo', this.layers.photo);
    this._addHalo('shadow', this.layers.shadow);
    this._applyVisibility();
    this.uniforms.uGrid.value.set(built.meta.width, built.meta.height);
    this.uniforms.uFocal.value = built.meta.focal;
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
    this.uniforms.uGrid.value.set(W, H);
    this.uniforms.uFocal.value = tf.focal;
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
        uniforms: { ...this.uniforms, ...u, uIsPlate: { value: isPlate ? 1 : 0 }, uSoftMul: { value: 1 } },
        vertexShader: TIME_VERT,
        fragmentShader: FRAG_SOLID,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      return pts;
    };
    this.layers = { frames: make(false), plate: make(true) };
    for (const obj of Object.values(this.layers)) this.scene.add(obj);
    this._addHalo('frames', this.layers.frames);
    this._addHalo('plate', this.layers.plate);
    this._applyVisibility();
    // the photo texture is only for photo mode
    if (this.photoTex) { this.photoTex.dispose(); this.photoTex = null; this.photoTexSrc = null; }
    this.camera.fov = tf.vfov;
    this._resize();
    this.revealStart = this.timer.getElapsed();
  }

  setTime({ anchor, c, vel, gamma, weights, ghost, tint } = {}) {
    const u = this.timeUniforms;
    if (anchor !== undefined) u.uAnchor.value = anchor;
    if (c !== undefined) u.uC.value = c;
    if (vel !== undefined) u.uVel.value.fromArray(vel);
    if (gamma !== undefined) u.uGamma.value = gamma;
    if (weights !== undefined) u.uW.value.fromArray(weights);
    if (ghost !== undefined) u.uGhost.value = ghost;
    if (tint !== undefined) u.uTint.value = tint;
  }

  get isReturning() {
    return !!this.returning;
  }

  get isWalking() {
    return !!(this.motion && this.motion.active);
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
      uniforms: { ...this.uniforms, uIsPhoto: { value: isPhoto ? 1 : 0 }, uSoftMul: { value: 1 } },
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
    this.wanted[name] = visible;
    this._applyVisibility();
  }

  // how much stretching of the photo is tolerated before it dissolves (higher = more)
  setStretch(v) { this.stretchUniform.value = v; }

  setRenderMode(mode) {
    this.surface = mode;
    this._applyVisibility();
  }

  // 'photo' means whichever surface is active: the textured mesh or the photo particles
  _applyVisibility() {
    const w = this.wanted, L = this.layers, H = this.halos;
    const mesh = this.surface === 'mesh' && !!L.mesh;
    const set = (obj, on) => { if (obj) obj.visible = on; };
    const photo = w.photo !== false;
    set(L.photo, photo && !mesh);
    set(H.photo, photo && !mesh);
    set(L.mesh, photo && mesh);
    for (const k of ['shadow', 'ash', 'frames', 'plate']) {
      set(L[k], w[k] !== false);
      set(H[k], w[k] !== false);
    }
    // halos ignore depth, so with the mesh in front the shadow stays as plain discs
    if (L.shadow) L.shadow.material.uniforms.uSoftMul.value = mesh ? 0 : 1;
  }

  _photoTexture(bitmap) {
    if (this.photoTex && this.photoTexSrc === bitmap) return this.photoTex;
    if (this.photoTex) this.photoTex.dispose();
    const coarse = matchMedia('(pointer: coarse)').matches;
    const cap = Math.min(this.renderer.capabilities.maxTextureSize, coarse ? 2560 : 4096);
    const scale = Math.min(1, cap / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false;   // v runs down the picture, matching the mesh UVs
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.photoTex = tex;
    this.photoTexSrc = bitmap;
    return tex;
  }

  // mesh: from build.js; bitmap: the full-resolution picture
  setPhotoMesh(mesh, bitmap) {
    if (this.layers.mesh) {
      this.scene.remove(this.layers.mesh);
      this.layers.mesh.geometry.dispose();
      this.layers.mesh.material.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
    geo.setAttribute('aChar', new THREE.BufferAttribute(mesh.char, 1));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uMap: { value: this._photoTexture(bitmap) }, uStretch: this.stretchUniform },
      vertexShader: MESH_VERT,
      fragmentShader: MESH_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
    });
    const obj = new THREE.Mesh(geo, mat);
    obj.frustumCulled = false;
    this.layers.mesh = obj;
    this.scene.add(obj);
    this._applyVisibility();
  }

  // frames: array of small blurred RGBA images (one for a photo, one per frame for a video)
  setBackground(frames, width, height) {
    if (this.bgTexture) this.bgTexture.dispose();
    const data = new Uint8Array(width * height * 4 * frames.length);
    frames.forEach((f, i) => data.set(f, i * width * height * 4));
    const tex = new THREE.DataArrayTexture(data, width, height, frames.length);
    tex.format = THREE.RGBAFormat;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.bgTexture = tex;
    this.bgUniforms.uBg.value = tex;
    this.bgUniforms.uBgFrames.value = frames.length;
    this.bgUniforms.uBgFrame.value = 0;
    this.setImmersive(this.immersive !== false);
  }

  setImmersive(on) {
    this.immersive = on;
    this.bg.visible = on && !!this.bgTexture;
    this.uniforms.uFeather.value = on ? this.feather : 0;
  }

  setBackgroundStrength(v) { this.bgUniforms.uBgStrength.value = v; }
  setBackgroundFrame(f) { this.bgUniforms.uBgFrame.value = Math.max(0, Math.min(this.bgUniforms.uBgFrames.value - 1, f)); }
  setSoftness(v) { this.uniforms.uSoft.value = v; }
  setFeather(v) {
    this.feather = v;
    if (this.immersive !== false) this.uniforms.uFeather.value = v;
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
    const dpr = this.renderer.getPixelRatio();
    this.uniforms.uMaxPx.value = 44 * dpr;
    this.uniforms.uSoftLo.value = 3 * dpr;
    this.uniforms.uSoftHi.value = 12 * dpr;
    this.accum.setSize(Math.max(1, Math.floor(buf.x / 2)), Math.max(1, Math.floor(buf.y / 2)));
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
      if (pointers.size === 1 && !this.isWalking) {
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

    // the wheel pushes you along with some inertia, so it reads as walking speed, not a jump
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.returning = null;
      this.wheelVel = Math.max(-3, Math.min(3, this.wheelVel - e.deltaY * 0.004));
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

  setAssist(on) {
    // keep the view where it is when switching, so nothing jumps
    if (on) { this.yaw = 0; this.pitch = 0; } else { this.yaw = this.lookYaw; this.pitch = this.lookPitch; }
    this.assist = on;
  }

  setFocusDepth(d) {
    this.focus.set(0, 0, -Math.max(0.5, d));
  }

  // forward / right / up in metres, relative to where the viewer faces (horizontal plane)
  _moveLocal(fwd, right, up) {
    const s = Math.sin(this.lookYaw), c = Math.cos(this.lookYaw);
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
    if (Math.abs(this.wheelVel) > 0.01) {
      this._moveLocal(this.wheelVel * dt, 0, 0);
      this.wheelVel *= Math.exp(-dt / 0.35);
    } else {
      this.wheelVel = 0;
    }

    if (this.returning) {
      const r = this.returning;
      r.t = Math.min(1, r.t + dt / 1.2);
      const e = 1 - Math.pow(1 - r.t, 3);
      this.pos.copy(r.from).multiplyScalar(1 - e);
      this.yaw = r.yaw * (1 - e);
      this.pitch = r.pitch * (1 - e);
      if (r.t >= 1) this.returning = null;
    }

    // walking with the phone: steps carry you where you face
    const walking = this.isWalking;
    let step = null;
    if (walking) {
      step = this.motion.update(dt);
      this.pos.x += step.dx;
      this.pos.z += step.dz;
    }

    // gaze assist: face the subject while moving sideways, so walking becomes orbiting the moment
    let baseYaw = 0, basePitch = 0;
    if (this.assist && !walking) {
      const d = this.focus.clone().sub(this.pos);
      // fade out as you reach the subject, so the view never flips when passing it
      const w = THREE.MathUtils.smoothstep(-d.z, 0.5, 1.5);
      baseYaw = w * Math.atan2(-d.x, -d.z);
      basePitch = w * Math.atan2(d.y, Math.hypot(d.x, d.z));
      // your own look offset relaxes back only while you move
      const moved = this.pos.distanceTo(this.prevPos) / Math.max(dt, 1e-3);
      if (moved > 0.05 && !this.returning) {
        const k = Math.exp(-dt / 1.5);
        this.yaw *= k;
        this.pitch *= k;
      }
    }
    this.prevPos.copy(this.pos);
    this.lookYaw = baseYaw + this.yaw;
    this.lookPitch = Math.max(-1.45, Math.min(1.45, basePitch + this.pitch));

    if (this.onTick) this.onTick(dt, this.pos);

    this.camera.position.copy(this.pos);
    if (walking && step.ready) {
      // the phone is the window: its orientation is the camera's
      this.camera.quaternion.copy(step.quat);
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(step.quat);
      this.lookYaw = Math.atan2(-f.x, -f.z);
    } else {
      this.camera.rotation.set(this.lookPitch, this.lookYaw, 0);
    }
    this.bg.position.copy(this.pos);
    if (this.onMove) this.onMove(this.pos.length());
    if (this.paused) return;
    const r = this.renderer;
    r.setRenderTarget(this.accum);
    r.setClearColor(0x000000, 0);
    r.clear();
    const halos = this.halosOk && (this.uniforms.uSoft.value > 0 || this.uniforms.uFeather.value > 0);
    if (halos) r.render(this.haloScene, this.camera);
    r.setRenderTarget(null);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(this.scene, this.camera);
    if (halos) r.render(this.compScene, this.compCamera);
  }
}
