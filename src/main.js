import { Viewer } from './viewer.js';
import { buildScene, DEFAULTS } from './build.js';
import { buildTimeField, TIME_DEFAULTS } from './timefield.js';
import { extractFrames } from './video.js';
import { Observer } from './observer.js';
import { TimeModel, PRESETS, DRIVERS, END_MODES } from './timemodel.js';
import { blurThumb } from './glow.js';
import { drawDiagram } from './diagram.js';

const $ = (id) => document.getElementById(id);
const intro = $('intro'), busy = $('busy'), hud = $('hud'), panel = $('panel');
const busyText = $('busy-text'), busyBar = $('busy-bar');

const viewer = new Viewer($('stage'));
const worker = new Worker(new URL('./depth-worker.js', import.meta.url), { type: 'module' });
const observer = new Observer();
const model = new TimeModel();

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
  showError('深度模型加载失败，请检查网络后刷新重试。');
};

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') {
    downloads.set(m.file, m);
    let loaded = 0, total = 0;
    for (const d of downloads.values()) { loaded += d.loaded; total += d.total; }
    if (loaded < total) {
      showBusy(`下载深度模型 ${(loaded / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`, loaded / total);
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
  { key: 'far', label: '远处距离', min: 4, max: 80, step: 1, unit: ' m' },
  { key: 'near', label: '近处距离', min: 0.3, max: 6, step: 0.1, unit: ' m' },
  { key: 'fov', label: '视场角', min: 30, max: 110, step: 1, unit: '°' },
  { key: 'jump', label: '断裂阈值', min: 0.04, max: 0.4, step: 0.01, unit: '' },
  { key: 'ash', label: '边缘灰烬', min: 0, max: 3, step: 0.1, unit: '' },
  { key: 'smoke', label: '影中烟尘', min: 0, max: 3, step: 0.1, unit: '' },
  { key: 'shadowTone', label: '影子明度', min: 0, max: 0.2, step: 0.01, unit: '' },
];

const VIDEO_SLIDERS = [
  { key: 'far', label: '远处距离', min: 4, max: 80, step: 1, unit: ' m' },
  { key: 'near', label: '近处距离', min: 0.3, max: 6, step: 0.1, unit: ' m' },
  { key: 'fov', label: '视场角', min: 30, max: 110, step: 1, unit: '°' },
  { key: 'jump', label: '断裂阈值', min: 0.04, max: 0.4, step: 0.01, unit: '' },
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
  panel.appendChild(sliderRow({ label: '粒子大小', min: 0.6, max: 3, step: 0.05, unit: '' }, state.sizeMul, (v) => {
    state.sizeMul = v;
    viewer.setSizeMul(v);
  }));
  panel.appendChild(sliderRow({ label: '闪光漂白', min: 0, max: 1, step: 0.05, unit: '' }, state.bleach, (v) => {
    state.bleach = v;
    viewer.setBleach(v);
  }));
  panel.appendChild(sliderRow({ label: '近处柔焦', min: 0, max: 1, step: 0.05, unit: '' }, state.softness, (v) => {
    state.softness = v;
    viewer.setSoftness(v);
  }));
  panel.appendChild(sliderRow({ label: '背景亮度', min: 0, max: 1.6, step: 0.05, unit: '' }, state.bgStrength, (v) => {
    state.bgStrength = v;
    viewer.setBackgroundStrength(v);
  }));
  panel.appendChild(sliderRow({ label: '边缘融合', min: 0, max: 0.35, step: 0.01, unit: '' }, state.feather, (v) => {
    state.feather = v;
    viewer.setFeather(v);
  }));
  const imm = document.createElement('div');
  imm.className = 'checks';
  imm.appendChild(checkbox('沉浸背景（边缘渐隐）', state.immersive, (on) => {
    state.immersive = on;
    viewer.setImmersive(on);
  }));
  panel.appendChild(imm);

  const res = document.createElement('div');
  res.className = 'row';
  res.innerHTML = '<label><span>精度（粒子数）</span></label>';
  const sel = document.createElement('select');
  const options = state.mode === 'video' ? [256, 384, 480, 640] : [384, 512, 640, 800, 1024];
  const current = state.mode === 'video' ? state.videoResolution : state.resolution;
  const def = state.mode === 'video' ? 480 : 640;
  for (const r of options) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = `${r} px` + (r === def ? '（默认）' : r > def ? '（电脑）' : '');
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
    const names = { frames: '当下', plate: '别处时刻' };
    for (const [k, label] of Object.entries(names)) {
      checks.appendChild(checkbox(label, state.videoLayers[k], (on) => {
        state.videoLayers[k] = on;
        viewer.setLayerVisible(k, on);
      }));
    }
  } else {
    const names = { photo: '照片', shadow: '影子', ash: '灰烬' };
    for (const [k, label] of Object.entries(names)) {
      checks.appendChild(checkbox(label, state.layers[k], (on) => {
        state.layers[k] = on;
        viewer.setLayerVisible(k, on);
      }));
    }
    checks.appendChild(checkbox('微光', state.shimmer, (on) => {
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

function selectRow(label, options, current, onChange) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label><span>${label}</span></label>`;
  const sel = document.createElement('select');
  for (const [value, text] of Object.entries(options)) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
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
  panel.appendChild(selectRow('时间预设', presetLabels, model.preset, (v) => model.setPreset(v)));
  panel.appendChild(selectRow('此刻怎么前进', DRIVERS, model.driver, (v) => { model.driver = v; }));
  panel.appendChild(selectRow('走到尽头', END_MODES, model.endMode, (v) => { model.endMode = v; }));

  panel.appendChild(sliderRow({ label: '世界光速', min: 0.5, max: 10, step: 0.1, unit: ' m/s' }, model.c, (v) => {
    model.c = v;
  }));
  panel.appendChild(sliderRow({ label: '每走 1 米，此刻前进', min: 0.1, max: 4, step: 0.1, unit: ' s' }, model.secondsPerMeter, (v) => {
    model.secondsPerMeter = v;
  }));

  const dur = state.clip ? state.clip.duration : 1;
  const row = sliderRow({ label: '此刻', min: 0, max: dur, step: 0.01, unit: ' s' }, model.t0, (v) => {
    model.t0 = v;
  });
  anchorInput = row.querySelector('input');
  anchorOut = row.querySelector('output');
  panel.appendChild(row);

  panel.appendChild(sliderRow({ label: '时差色调', min: 0, max: 1, step: 0.05, unit: '' }, t.tint, (v) => {
    t.tint = v;
    viewer.setTime({ tint: v });
  }));
  panel.appendChild(sliderRow({ label: '异时色调', min: 0, max: 1, step: 0.05, unit: '' }, t.ghost, (v) => {
    t.ghost = v;
    viewer.setTime({ ghost: v });
  }));

  const checks = document.createElement('div');
  checks.className = 'checks';
  checks.appendChild(checkbox('时空图', t.diagram, (on) => {
    t.diagram = on;
    diagramEl.classList.toggle('hidden', !on || state.mode !== 'video');
  }));
  panel.appendChild(checks);
}

// ---------------------------------------------------------------- time, every frame

const diagramEl = $('diagram');
const tstatEl = $('tstat');
const trail = [];
let hudClock = 0;

viewer.onTick = (dt, pos) => {
  if (state.mode !== 'video' || !state.clip) return;
  const p = [pos.x, pos.y, pos.z];
  observer.update(p, dt, viewer.isReturning);
  model.update(observer, dt);
  const u = model.uniforms();
  viewer.setTime(u);
  viewer.setBackgroundFrame(u.anchor);

  const last = trail[trail.length - 1];
  if (!last || Math.abs(last[0] - p[0]) > 0.02 || Math.abs(last[1] - model.t0) > 0.01) {
    trail.push([p[0], model.t0]);
    if (trail.length > 600) trail.shift();
  }

  hudClock += dt;
  if (hudClock < 0.1) return;
  hudClock = 0;
  tstatEl.textContent = `v ${observer.speed.toFixed(2)} m/s · β ${model.beta.toFixed(2)} · 此刻 ${model.t0.toFixed(1)} / ${model.duration.toFixed(1)} s`;
  if (anchorInput && !panel.classList.contains('hidden') && document.activeElement !== anchorInput) {
    anchorInput.value = model.t0;
    anchorOut.textContent = `${model.t0.toFixed(2)} s`;
  }
  if (state.time.diagram) drawDiagram(diagramEl, model, p, trail);
};

function sliderRow(s, value, onInput) {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  const name = document.createElement('span');
  name.textContent = s.label;
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
  l.append(c, ' ' + label);
  return l;
}

function renderStats() {
  const el = $('stats');
  if (!el || !state.stats) return;
  const s = state.stats;
  const k = (n) => (n / 1000).toFixed(0) + 'k';
  el.style.whiteSpace = 'pre-line';
  if (s.kind === 'video') {
    el.textContent = `${s.frames} 帧 · ${s.duration.toFixed(1)} s · 每帧 ${k(s.points)} 粒子\n` +
      `深度 ${(s.depthMs / 1000).toFixed(1)} s（${state.device}）· 生成 ${s.buildMs.toFixed(0)} ms`;
  } else {
    el.textContent = `照片 ${k(s.photo)} · 影子 ${k(s.shadow)} · 灰烬 ${k(s.ash)} · 断裂 ${k(s.tears)}\n` +
      `深度 ${s.depthMs.toFixed(0)} ms（${state.device}）· 生成 ${s.buildMs.toFixed(0)} ms`;
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
  $('hint').textContent = hintText();
  const video = state.mode === 'video';
  tstatEl.classList.toggle('hidden', !video);
  diagramEl.classList.toggle('hidden', !video || !state.time.diagram);
}

function hintText() {
  const touch = matchMedia('(pointer: coarse)').matches;
  const move = touch
    ? '单指拖动看四周 · 双指张合前进后退 · 双指平移侧移'
    : '拖动看四周 · WASD / 滚轮 移动 · Q E 升降';
  return state.mode === 'video' ? `${move} · 动起来，此刻就会倾斜；走得越多，时间走得越远` : move;
}

const isVideo = (blob, name = '') => blob.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|ogv)$/i.test(name);

async function loadMedia(source) {
  const token = ++state.loadToken;
  intro.classList.add('hidden');
  showBusy('读取文件');
  let blob;
  try {
    blob = source instanceof Blob ? source : await (await fetch(source)).blob();
  } catch (err) {
    console.error(err);
    showError('读取失败，换一个文件试试。');
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
      showError('这个文件浏览器读不了（比如 HEIC 格式）。换成 JPG、PNG 或 MP4 试试。');
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

  showBusy('准备深度模型');
  try {
    const m = await estimateDepth(w, h, rgba);
    if (token !== state.loadToken) return;
    state.depth = { width: w, height: h, rgba, disparity: m.disparity };
    state.depthMs = m.ms;
    rebuild();
  } catch (err) {
    console.error(err);
    showError('深度估计失败：' + err.message);
  }
}

async function processVideo() {
  const token = ++state.loadToken;
  try {
    showBusy('抽取画面', 0);
    const clip = await extractFrames(state.videoBlob, { maxSide: state.videoResolution }, (i, n) => {
      if (token === state.loadToken) showBusy(`抽取画面 ${i} / ${n}`, i / n);
    });
    if (token !== state.loadToken) return;

    showBusy('准备深度模型');
    const disparities = [];
    const t0 = performance.now();
    for (let i = 0; i < clip.frames.length; i++) {
      const m = await estimateDepth(clip.width, clip.height, clip.frames[i]);
      if (token !== state.loadToken) return;
      disparities.push(m.disparity);
      showBusy(`估计深度 ${i + 1} / ${clip.frames.length}（${state.device}）`, (i + 1) / clip.frames.length);
    }
    state.clip = { ...clip, disparities };
    state.depthMs = performance.now() - t0;
    model.configure(clip.duration, clip.fps);
    observer.reset();
    trail.length = 0;
    viewer.setTime({ ghost: state.time.ghost, tint: state.time.tint });
    renderPanel();
    rebuild();
  } catch (err) {
    console.error(err);
    showError('这段视频处理失败：' + err.message + '。换成 MP4 或更短的视频试试。');
  }
}

let rebuildTimer = 0;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 180);
}

function rebuild() {
  if (state.mode === 'video' ? !state.clip : !state.depth) return;
  showBusy('凝固中');
  // let the busy text paint before the synchronous build (no rAF: it stalls in background tabs)
  setTimeout(() => {
    const t0 = performance.now();
    if (state.mode === 'video') {
      const tf = buildTimeField(state.clip, state.timeParams);
      const buildMs = performance.now() - t0;
      viewer.setTimeField(tf);
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
  if (fileInput.files[0]) loadMedia(fileInput.files[0]);
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

$('btn-new').onclick = () => fileInput.click();
$('btn-home').onclick = () => {
  viewer.resetView();
  model.reset(observer.walked);
  trail.length = 0;
};
$('btn-panel').onclick = () => {
  const open = panel.classList.toggle('hidden') === false;
  $('btn-panel').setAttribute('aria-expanded', String(open));
};

const distEl = $('dist');
let lastDist = -1;
viewer.onMove = (d) => {
  const r = Math.round(d * 10) / 10;
  if (r === lastDist) return;
  lastDist = r;
  distEl.textContent = r < 0.1 ? '站在拍摄点' : `距拍摄点 ${r.toFixed(1)} m`;
};

$('hint').textContent = hintText();
renderPanel();

// ?src=<image or video url> loads a file directly (handy for sharing examples and for testing)
const src = new URLSearchParams(location.search).get('src');
if (src) loadMedia(src);

// exposed for tinkering from the devtools console
window.atom = { viewer, state, rebuild, model, observer };
