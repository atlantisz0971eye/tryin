import { Viewer } from './viewer.js';
import { buildScene, DEFAULTS } from './build.js';
import { buildTimeField, TIME_DEFAULTS } from './timefield.js';
import { extractFrames } from './video.js';
import { Observer } from './observer.js';
import { TimeModel, PRESETS, DRIVERS, END_MODES } from './timemodel.js';
import { blurThumb } from './glow.js';
import { t as tr, getLang, setLang, onLangChange, applyStatic } from './i18n.js';
import { drawDiagram } from './diagram.js';
import { MotionWalker, motionSupported, requestMotionPermission } from './motion.js';

const $ = (id) => document.getElementById(id);
const intro = $('intro'), busy = $('busy'), hud = $('hud'), panel = $('panel');
const busyText = $('busy-text'), busyBar = $('busy-bar');

const viewer = new Viewer($('stage'));
const worker = new Worker(new URL('./depth-worker.js', import.meta.url), { type: 'module' });
const observer = new Observer();
const model = new TimeModel();
const walker = new MotionWalker();
viewer.motion = walker;

const state = {
  mode: 'photo',      // 'photo' | 'video'
  // photo
  bitmap: null,
  resolution: 640,
  depth: null,        // { width, height, rgba, disparity }
  params: { ...DEFAULTS },
  shimmer: true,
  layers: { photo: true, shadow: true, ash: true },
  // video
  videoBlob: null,
  videoResolution: 480,
  clip: null,         // { width, height, frames, disparities, fps, duration }
  timeParams: { ...TIME_DEFAULTS },
  time: { ghost: 0.6, tint: 0.6, diagram: true },
  videoLayers: { frames: true, plate: true },
  // shared
  sizeMul: 1.4,
  bleach: 0,
  immersive: true,
  assist: true,
  walking: false,
  walkOffered: false,    // the walk-in invitation shows once per visit
  walkRange: 3,          // metres you can comfortably walk in this scene
  bgStrength: 1,
  feather: 0.15,
  softness: 1,
  device: '',
  stats: null,
  loadToken: 0,
};

// ---------------------------------------------------------------- depth worker

let jobSeq = 0;
const jobs = new Map();
const downloads = new Map();

function estimateDepth(width, height, rgba) {
  const id = ++jobSeq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    worker.postMessage({ id, width, height, pixels: rgba.slice() });
  });
}

worker.onerror = (e) => {
  console.error(e);
  showError(tr('err.model'));
};

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') {
    downloads.set(m.file, m);
    let loaded = 0, total = 0;
    for (const d of downloads.values()) { loaded += d.loaded; total += d.total; }
    if (loaded < total) {
      showBusy(tr('busy.download', { a: (loaded / 1048576).toFixed(0), b: (total / 1048576).toFixed(0) }), loaded / total);
    }
  } else if (m.type === 'status') {
    state.device = m.device === 'webgpu' ? 'WebGPU' : 'CPU';
  } else if (m.type === 'result' || m.type === 'error') {
    const job = jobs.get(m.id);
    if (!job) return;
    jobs.delete(m.id);
    if (m.type === 'result') job.resolve(m);
    else job.reject(new Error(m.message));
  }
};

// ---------------------------------------------------------------- panel

const PHOTO_SLIDERS = [
  { key: 'far', label: 'far', min: 4, max: 80, step: 1, unit: ' m' },
  { key: 'near', label: 'near', min: 0.3, max: 6, step: 0.1, unit: ' m' },
  { key: 'fov', label: 'fov', min: 30, max: 110, step: 1, unit: '°' },
  { key: 'jump', label: 'jump', min: 0.04, max: 0.4, step: 0.01, unit: '' },
  { key: 'ash', label: 'ash', min: 0, max: 3, step: 0.1, unit: '' },
  { key: 'smoke', label: 'smoke', min: 0, max: 3, step: 0.1, unit: '' },
  { key: 'shadowTone', label: 'shadowTone', min: 0, max: 0.2, step: 0.01, unit: '' },
];

const VIDEO_SLIDERS = [
  { key: 'far', label: 'far', min: 4, max: 80, step: 1, unit: ' m' },
  { key: 'near', label: 'near', min: 0.3, max: 6, step: 0.1, unit: ' m' },
  { key: 'fov', label: 'fov', min: 30, max: 110, step: 1, unit: '°' },
  { key: 'jump', label: 'jump', min: 0.04, max: 0.4, step: 0.01, unit: '' },
];

function renderPanel() {
  panel.innerHTML = '';
  if (state.mode === 'video') renderVideoControls();

  const sliders = state.mode === 'video' ? VIDEO_SLIDERS : PHOTO_SLIDERS;
  const target = state.mode === 'video' ? state.timeParams : state.params;
  for (const s of sliders) panel.appendChild(sliderRow(s, target[s.key], (v) => {
    target[s.key] = v;
    scheduleRebuild();
  }));
  panel.appendChild(sliderRow({ label: 'size', min: 0.6, max: 3, step: 0.05, unit: '' }, state.sizeMul, (v) => {
    state.sizeMul = v;
    viewer.setSizeMul(v);
  }));
  panel.appendChild(sliderRow({ label: 'bleach', min: 0, max: 1, step: 0.05, unit: '' }, state.bleach, (v) => {
    state.bleach = v;
    viewer.setBleach(v);
  }));
  panel.appendChild(sliderRow({ label: 'soft', min: 0, max: 1, step: 0.05, unit: '' }, state.softness, (v) => {
    state.softness = v;
    viewer.setSoftness(v);
  }));
  panel.appendChild(sliderRow({ label: 'bg', min: 0, max: 1.6, step: 0.05, unit: '' }, state.bgStrength, (v) => {
    state.bgStrength = v;
    viewer.setBackgroundStrength(v);
  }));
  panel.appendChild(sliderRow({ label: 'feather', min: 0, max: 0.35, step: 0.01, unit: '' }, state.feather, (v) => {
    state.feather = v;
    viewer.setFeather(v);
  }));
  const imm = document.createElement('div');
  imm.className = 'checks';
  imm.appendChild(checkbox('immersive', state.immersive, (on) => {
    state.immersive = on;
    viewer.setImmersive(on);
  }));
  imm.appendChild(checkbox('assist', state.assist, (on) => {
    state.assist = on;
    viewer.setAssist(on);
  }));
  panel.appendChild(imm);

  if (motionSupported()) {
    const walk = document.createElement('div');
    walk.className = 'checks';
    walk.appendChild(checkbox('walkToggle', state.walking, (on) => {
      if (on) startWalking(); else stopWalking();
    }));
    panel.appendChild(walk);
    panel.appendChild(sliderRow({ label: 'walkScale', min: 0.3, max: 3, step: 0.05, unit: '×' }, walker.scale, (v) => {
      walker.scale = v;
    }));
    panel.appendChild(sliderRow({ label: 'stepLength', min: 0.4, max: 1, step: 0.05, unit: ' m' }, walker.stepLength, (v) => {
      walker.stepLength = v;
    }));
  }

  const res = document.createElement('div');
  res.className = 'row';
  res.innerHTML = `<label><span>${tr('res')}</span></label>`;
  const sel = document.createElement('select');
  const options = state.mode === 'video' ? [256, 384, 480, 640] : [384, 512, 640, 800, 1024];
  const current = state.mode === 'video' ? state.videoResolution : state.resolution;
  const def = state.mode === 'video' ? 480 : 640;
  for (const r of options) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = `${r} px` + (r === def ? tr('res.default') : r > def ? tr('res.desktop') : '');
    if (r === current) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    if (state.mode === 'video') {
      state.videoResolution = Number(sel.value);
      processVideo();
    } else {
      state.resolution = Number(sel.value);
      processPhoto();
    }
  };
  res.appendChild(sel);
  panel.appendChild(res);

  const checks = document.createElement('div');
  checks.className = 'checks';
  if (state.mode === 'video') {
    const names = { frames: 'layer.frames', plate: 'layer.plate' };
    for (const [k, label] of Object.entries(names)) {
      checks.appendChild(checkbox(label, state.videoLayers[k], (on) => {
        state.videoLayers[k] = on;
        viewer.setLayerVisible(k, on);
      }));
    }
  } else {
    const names = { photo: 'layer.photo', shadow: 'layer.shadow', ash: 'layer.ash' };
    for (const [k, label] of Object.entries(names)) {
      checks.appendChild(checkbox(label, state.layers[k], (on) => {
        state.layers[k] = on;
        viewer.setLayerVisible(k, on);
      }));
    }
    checks.appendChild(checkbox('shimmer', state.shimmer, (on) => {
      state.shimmer = on;
      viewer.setShimmer(on);
    }));
  }
  panel.appendChild(checks);

  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.id = 'stats';
  panel.appendChild(stats);
  renderStats();
}

let anchorInput = null, anchorOut = null;
let autoInput = null, calibRefs = null, calibInfo = null;

// show the current (possibly auto-fitted) light speed and walking scale in the panel
function syncCalibration() {
  if (!calibRefs) return;
  const [ci, co] = calibRefs.c, [si, so] = calibRefs.spm;
  if (document.activeElement !== ci) { ci.value = model.c; co.textContent = `${model.c.toFixed(2)} m/s`; }
  if (document.activeElement !== si) { si.value = model.secondsPerMeter; so.textContent = `${model.secondsPerMeter.toFixed(2)} s`; }
  const cal = model.calib;
  if (calibInfo && cal) {
    calibInfo.textContent = tr('calib', { r: cal.R.toFixed(1), w: cal.range.toFixed(1), p: model.speedEst.toFixed(2) }) +
      (model.auto ? '' : tr('calib.manual'));
  }
}

const defaultPace = () => (matchMedia('(pointer: coarse)').matches ? 0.8 : 1.2);

function selectRow(label, options, current, onChange) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label><span>${tr(label)}</span></label>`;
  const sel = document.createElement('select');
  for (const [value, text] of Object.entries(options)) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = tr(text);
    if (value === current) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => onChange(sel.value);
  row.appendChild(sel);
  return row;
}

function renderVideoControls() {
  const t = state.time;
  const presetLabels = Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, p.label]));
  panel.appendChild(selectRow('preset', presetLabels, model.preset, (v) => model.setPreset(v)));
  panel.appendChild(selectRow('driver', DRIVERS, model.driver, (v) => { model.driver = v; }));
  panel.appendChild(selectRow('end', END_MODES, model.endMode, (v) => { model.endMode = v; }));

  const autoRow = document.createElement('div');
  autoRow.className = 'checks';
  const autoBox = checkbox('auto', model.auto, (on) => {
    model.auto = on;
    if (on) model.recalibrate();
    syncCalibration();
  });
  autoRow.appendChild(autoBox);
  panel.appendChild(autoRow);
  autoInput = autoBox.querySelector('input');

  const cRow = sliderRow({ label: 'c', min: 0.3, max: 10, step: 0.05, unit: ' m/s' }, model.c, (v) => {
    model.c = v;
    model.auto = false;
    autoInput.checked = false;
  });
  const spmRow = sliderRow({ label: 'spm', min: 0.1, max: 4, step: 0.05, unit: ' s' }, model.secondsPerMeter, (v) => {
    model.secondsPerMeter = v;
    model.auto = false;
    autoInput.checked = false;
  });
  calibRefs = {
    c: [cRow.querySelector('input'), cRow.querySelector('output')],
    spm: [spmRow.querySelector('input'), spmRow.querySelector('output')],
  };
  panel.append(cRow, spmRow);
  calibInfo = document.createElement('div');
  calibInfo.className = 'stats';
  panel.appendChild(calibInfo);
  syncCalibration();

  const dur = state.clip ? state.clip.duration : 1;
  const row = sliderRow({ label: 'anchor', min: 0, max: dur, step: 0.01, unit: ' s' }, model.t0, (v) => {
    model.t0 = v;
  });
  anchorInput = row.querySelector('input');
  anchorOut = row.querySelector('output');
  panel.appendChild(row);

  panel.appendChild(sliderRow({ label: 'tint', min: 0, max: 1, step: 0.05, unit: '' }, t.tint, (v) => {
    t.tint = v;
    viewer.setTime({ tint: v });
  }));
  panel.appendChild(sliderRow({ label: 'ghost', min: 0, max: 1, step: 0.05, unit: '' }, t.ghost, (v) => {
    t.ghost = v;
    viewer.setTime({ ghost: v });
  }));

  const checks = document.createElement('div');
  checks.className = 'checks';
  checks.appendChild(checkbox('diagram', t.diagram, (on) => {
    t.diagram = on;
    diagramEl.classList.toggle('hidden', !on || state.mode !== 'video');
  }));
  panel.appendChild(checks);
}

// ---------------------------------------------------------------- time, every frame

const diagramEl = $('diagram');
const tstatEl = $('tstat');
let hudClock = 0;

viewer.onTick = (dt, pos) => {
  if (state.mode !== 'video' || !state.clip) return;
  const p = [pos.x, pos.y, pos.z];
  observer.update(p, dt, viewer.isReturning);
  model.update(observer, dt);
  const u = model.uniforms();
  viewer.setTime(u);
  viewer.setBackgroundFrame(u.anchor);

  if (state.time.diagram) drawDiagram(diagramEl, model, p);

  hudClock += dt;
  if (hudClock < 0.1) return;
  hudClock = 0;
  tstatEl.textContent = tr('tstat', { v: observer.speed.toFixed(2), b: model.beta.toFixed(2), t: model.t0.toFixed(1), d: model.duration.toFixed(1) });
  if (flipped) syncCalibration();
  if (anchorInput && flipped && document.activeElement !== anchorInput) {
    anchorInput.value = model.t0;
    anchorOut.textContent = `${model.t0.toFixed(2)} s`;
  }
};

function sliderRow(s, value, onInput) {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  const name = document.createElement('span');
  name.textContent = tr(s.label);
  const out = document.createElement('output');
  const fmt = s.format || ((v) => `${Number(v).toFixed(s.step < 0.1 ? 2 : s.step < 1 ? 1 : 0)}${s.unit}`);
  out.textContent = fmt(value);
  label.append(name, out);
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min: s.min, max: s.max, step: s.step, value });
  input.oninput = () => {
    out.textContent = fmt(input.value);
    onInput(Number(input.value));
  };
  row.append(label, input);
  return row;
}

function checkbox(label, checked, onChange) {
  const l = document.createElement('label');
  const c = document.createElement('input');
  c.type = 'checkbox';
  c.checked = checked;
  c.onchange = () => onChange(c.checked);
  l.append(c, ' ' + tr(label));
  return l;
}

function renderStats() {
  const el = $('stats');
  if (!el || !state.stats) return;
  const s = state.stats;
  const k = (n) => (n / 1000).toFixed(0) + 'k';
  el.style.whiteSpace = 'pre-line';
  if (s.kind === 'video') {
    el.textContent = tr('stats.video', {
      f: s.frames, s: s.duration.toFixed(1), p: k(s.points),
      dm: (s.depthMs / 1000).toFixed(1), dev: state.device, bm: s.buildMs.toFixed(0),
    });
  } else {
    el.textContent = tr('stats.photo', {
      p: k(s.photo), s: k(s.shadow), a: k(s.ash), t: k(s.tears),
      dm: s.depthMs.toFixed(0), dev: state.device, bm: s.buildMs.toFixed(0),
    });
  }
}

// ---------------------------------------------------------------- flow

function showBusy(text, progress = null) {
  busy.classList.remove('hidden');
  busyText.textContent = text;
  busyBar.parentElement.style.visibility = progress === null ? 'hidden' : 'visible';
  if (progress !== null) busyBar.style.width = `${Math.round(progress * 100)}%`;
}

function showError(msg) {
  busy.classList.add('hidden');
  intro.classList.remove('hidden');
  hud.classList.add('hidden');
  let el = intro.querySelector('.error');
  if (!el) {
    el = document.createElement('p');
    el.className = 'fine error';
    intro.querySelector('.intro-inner').appendChild(el);
  }
  el.textContent = msg;
}

function showScene() {
  busy.classList.add('hidden');
  hud.classList.remove('hidden');
  $('btn-home').disabled = false;
  $('hud-handle').classList.remove('hidden');
  $('hint').textContent = hintText();
  const video = state.mode === 'video';
  tstatEl.classList.toggle('hidden', !video);
  diagramEl.classList.toggle('hidden', !video || !state.time.diagram);
  if (motionSupported() && !state.walkOffered && !state.walking) {
    state.walkOffered = true;
    $('walk-prompt').classList.remove('hidden');
  }
}

function hintText() {
  const touch = matchMedia('(pointer: coarse)').matches;
  const move = touch
    ? tr('hint.touch')
    : tr('hint.mouse');
  if (state.walking) return tr('hint.walk');
  return state.mode === 'video' ? `${move} · ${tr('hint.video')}` : move;
}

const isVideo = (blob, name = '') => blob.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|ogv)$/i.test(name);

async function loadMedia(source) {
  const token = ++state.loadToken;
  intro.classList.add('hidden');
  showBusy(tr('busy.read'));
  let blob;
  try {
    blob = source instanceof Blob ? source : await (await fetch(source)).blob();
  } catch (err) {
    console.error(err);
    showError(tr('err.read'));
    return;
  }
  if (token !== state.loadToken) return;
  const name = source instanceof File ? source.name : String(source);
  if (isVideo(blob, name)) {
    state.mode = 'video';
    state.videoBlob = blob;
    renderPanel();
    processVideo();
  } else {
    state.mode = 'photo';
    try {
      state.bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (err) {
      console.error(err);
      showError(tr('err.decode'));
      return;
    }
    renderPanel();
    processPhoto();
  }
}

async function processPhoto() {
  const token = ++state.loadToken;
  const bmp = state.bitmap;
  if (!bmp) return;
  const scale = Math.min(1, state.resolution / Math.max(bmp.width, bmp.height));
  const w = Math.max(16, Math.round(bmp.width * scale));
  const h = Math.max(16, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;

  showBusy(tr('busy.prepare'));
  try {
    const m = await estimateDepth(w, h, rgba);
    if (token !== state.loadToken) return;
    state.depth = { width: w, height: h, rgba, disparity: m.disparity };
    state.depthMs = m.ms;
    rebuild();
  } catch (err) {
    console.error(err);
    showError(tr('err.depth', { m: err.message }));
  }
}

async function processVideo() {
  const token = ++state.loadToken;
  try {
    showBusy(tr('busy.framesStart'), 0);
    const clip = await extractFrames(state.videoBlob, { maxSide: state.videoResolution }, (i, n) => {
      if (token === state.loadToken) showBusy(tr('busy.frames', { i, n }), i / n);
    });
    if (token !== state.loadToken) return;

    showBusy(tr('busy.prepare'));
    const disparities = [];
    const t0 = performance.now();
    for (let i = 0; i < clip.frames.length; i++) {
      const m = await estimateDepth(clip.width, clip.height, clip.frames[i]);
      if (token !== state.loadToken) return;
      disparities.push(m.disparity);
      showBusy(tr('busy.depth', { i: i + 1, n: clip.frames.length, d: state.device }), (i + 1) / clip.frames.length);
    }
    state.clip = { ...clip, disparities };
    state.depthMs = performance.now() - t0;
    model.configure(clip.duration, clip.fps);
    observer.reset();
    viewer.setTime({ ghost: state.time.ghost, tint: state.time.tint });
    renderPanel();
    rebuild();
  } catch (err) {
    console.error(err);
    showError(tr('err.video', { m: err.message }));
  }
}

let rebuildTimer = 0;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 180);
}

function rebuild() {
  if (state.mode === 'video' ? !state.clip : !state.depth) return;
  showBusy(tr('busy.freeze'));
  // let the busy text paint before the synchronous build (no rAF: it stalls in background tabs)
  setTimeout(() => {
    const t0 = performance.now();
    if (state.mode === 'video') {
      const tf = buildTimeField(state.clip, state.timeParams);
      const buildMs = performance.now() - t0;
      viewer.setTimeField(tf);
      model.setDepthStats(tf.depthStats, model.depthStats ? undefined : defaultPace());
      viewer.setFocusDepth(tf.depthStats.median);
      state.walkRange = model.calib ? model.calib.range : 3;
      syncCalibration();
      const thumbs = state.clip.frames.map((f) => blurThumb(f, tf.width, tf.height));
      viewer.setBackground(thumbs.map((t) => t.data), thumbs[0].width, thumbs[0].height);
      for (const [k, on] of Object.entries(state.videoLayers)) viewer.setLayerVisible(k, on);
      state.stats = {
        kind: 'video', frames: tf.frames, duration: state.clip.duration,
        points: tf.width * tf.height, depthMs: state.depthMs || 0, buildMs,
      };
    } else {
      const built = buildScene(state.depth, state.params);
      const buildMs = performance.now() - t0;
      viewer.setScene(built);
      viewer.setFocusDepth(built.meta.focusDepth);
      state.walkRange = Math.min(6, Math.max(1, 0.35 * built.meta.focusDepth));
      const thumb = blurThumb(state.depth.rgba, state.depth.width, state.depth.height);
      viewer.setBackground([thumb.data], thumb.width, thumb.height);
      for (const [k, on] of Object.entries(state.layers)) viewer.setLayerVisible(k, on);
      state.stats = {
        kind: 'photo', photo: built.photo.count, shadow: built.shadow.count, ash: built.ash.count,
        tears: built.meta.tears, depthMs: state.depthMs || 0, buildMs,
      };
    }
    renderStats();
    showScene();
  }, 30);
}

// ---------------------------------------------------------------- input wiring

const fileInput = $('file');
fileInput.onchange = () => {
  if (fileInput.files[0]) {
    setFlipped(false);
    loadMedia(fileInput.files[0]);
  }
  fileInput.value = '';
};

const drop = $('drop');
for (const ev of ['dragenter', 'dragover']) {
  window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
window.addEventListener('dragleave', () => drop.classList.remove('over'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) loadMedia(f);
});
window.addEventListener('paste', (e) => {
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
  if (item) loadMedia(item.getAsFile());
});

// ---------------------------------------------------------------- the print: front and back

const card = $('card');
const desk = card.parentElement;
const front = card.querySelector('.front'), back = card.querySelector('.back');
let flipped = false;
let faceSwapTimer = 0;
back.inert = true;

function setFlipped(on) {
  if (on === flipped) return;
  flipped = on;
  desk.classList.remove('turning');
  void desk.offsetWidth; // restart the lift animation
  desk.classList.add('turning');
  card.classList.toggle('flipped', on);
  // The face turned away still takes clicks in some browsers even with backface-visibility hidden
  // (the back's "turn back" sits right over the front's "tryin'"), so switch it off entirely.
  front.inert = on;
  back.inert = !on;
  front.setAttribute('aria-hidden', String(on));
  back.setAttribute('aria-hidden', String(!on));
  // WebKit (iPhone Safari) ignores backface-visibility on children with their own layers, so the
  // labels of the far face show through. Swap which face is visible when the turn passes 90°
  // (about 45% of the way through, with this easing).
  clearTimeout(faceSwapTimer);
  faceSwapTimer = setTimeout(() => card.classList.toggle('show-back', flipped), 510);
  // the scene keeps running underneath; it just is not drawn while the back is up
  setTimeout(() => desk.classList.remove('turning'), 1150);
  if (on) setTimeout(() => { viewer.paused = flipped; }, 1150);
  else viewer.paused = false;
  if (on) syncCalibration();
}

$('btn-menu').onclick = () => setFlipped(true);
$('btn-menu-back').onclick = () => setFlipped(false);
$('btn-flip-back').onclick = () => setFlipped(false);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && flipped) setFlipped(false);
});

$('btn-new').onclick = () => fileInput.click();
$('btn-home').onclick = () => {
  if (state.walking) {
    // you cannot be moved back physically: wherever you stand and face becomes the capture point
    viewer.pos.set(0, 0, 0);
    observer.reset([0, 0, 0]);
    walker.recenter();
  } else {
    viewer.resetView();
  }
  model.reset(observer.walked);
};

// ---------------------------------------------------------------- walking with the phone

let wakeLock = null;

async function startWalking() {
  let ok = false;
  try { ok = await requestMotionPermission(); } catch (_) { ok = false; }
  if (!ok) {
    $('hint').textContent = tr('walk.denied');
    setDrawer(true);
    renderPanel();
    return;
  }
  state.walking = true;
  viewer.pos.set(0, 0, 0);
  observer.reset([0, 0, 0]);
  model.reset(observer.walked);
  walker.start();
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (_) { wakeLock = null; }
  updateWalkingUi();
}

function stopWalking() {
  state.walking = false;
  walker.stop();
  viewer.yaw = viewer.lookYaw;
  viewer.pitch = 0;
  try { wakeLock?.release(); } catch (_) { /* already released */ }
  wakeLock = null;
  updateWalkingUi();
}

function updateWalkingUi() {
  const home = $('btn-home');
  home.dataset.i18n = state.walking ? 'label.recenter' : 'label.home';
  home.textContent = tr(home.dataset.i18n);
  $('hint').textContent = hintText();
  $('edge-warn').style.opacity = '0';
  renderPanel();
}

// the screen lock is dropped when the page is hidden; take it again on return
document.addEventListener('visibilitychange', async () => {
  if (state.walking && document.visibilityState === 'visible') {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (_) { wakeLock = null; }
  }
});

$('btn-walk-go').onclick = () => {
  $('walk-prompt').classList.add('hidden');
  startWalking(); // still inside the tap, as iOS requires for the permission prompt
};
$('btn-walk-stay').onclick = () => $('walk-prompt').classList.add('hidden');

const distEl = $('dist');
let lastDist = -1;
const edgeWarn = $('edge-warn');
viewer.onMove = (d) => {
  if (state.walking) {
    // darken the edges as you walk past the space this moment can hold
    const R = state.walkRange;
    edgeWarn.style.opacity = String(Math.min(1, Math.max(0, (d - 1.3 * R) / (0.7 * R))));
  }
  const r = Math.round(d * 10) / 10;
  if (r === lastDist) return;
  lastDist = r;
  distEl.textContent = r < 0.1 ? tr('dist.origin') : tr('dist.away', { d: r.toFixed(1) });
};

// ---------------------------------------------------------------- status drawer

// The status text lives in a drawer under the picture, closed by default. Tap the pull dot to
// toggle it, or drag it up to open and down to close.
const handle = $('hud-handle');
const drawer = $('hud-drawer');
let drawerOpen = false;

function setDrawer(open) {
  drawerOpen = open;
  hud.classList.toggle('drawer-open', open);
  handle.setAttribute('aria-expanded', String(open));
  handle.setAttribute('aria-label', tr(open ? 'hud.hide' : 'hud.show'));
  drawer.setAttribute('aria-hidden', String(!open));
}

let dragFrom = null;
handle.addEventListener('pointerdown', (e) => {
  dragFrom = e.clientY;
  handle.setPointerCapture(e.pointerId);
});
handle.addEventListener('pointerup', (e) => {
  if (dragFrom === null) return;
  const dy = e.clientY - dragFrom;
  dragFrom = null;
  if (dy < -8) setDrawer(true);
  else if (dy > 8) setDrawer(false);
  else setDrawer(!drawerOpen);
});
handle.addEventListener('pointercancel', () => { dragFrom = null; });
handle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrawer(!drawerOpen); }
});

// ---------------------------------------------------------------- language

applyStatic();
setDrawer(false);
distEl.textContent = tr('dist.origin');
$('btn-lang').onclick = () => setLang(getLang() === 'en' ? 'zh' : 'en');
onLangChange(() => {
  setDrawer(drawerOpen);
  renderPanel();
  $('hint').textContent = hintText();
  lastDist = -1; // rewrite the distance line on the next frame
});

$('hint').textContent = hintText();
$('btn-home').disabled = true;
renderPanel();

// ?src=<image or video url> loads a file directly (handy for sharing examples and for testing)
const src = new URLSearchParams(location.search).get('src');
if (src) loadMedia(src);

// exposed for tinkering from the devtools console
window.atom = { viewer, state, rebuild, model, observer };
