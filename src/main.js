import { Viewer } from './viewer.js';
import { buildScene, DEFAULTS } from './build.js';

const $ = (id) => document.getElementById(id);
const intro = $('intro'), busy = $('busy'), hud = $('hud'), panel = $('panel');
const busyText = $('busy-text'), busyBar = $('busy-bar');

const viewer = new Viewer($('stage'));
const worker = new Worker(new URL('./depth-worker.js', import.meta.url), { type: 'module' });
worker.onerror = (e) => {
  console.error(e);
  showError('深度模型加载失败，请检查网络后刷新重试。');
};

const state = {
  bitmap: null,
  resolution: 640,
  depth: null,      // { width, height, rgba, disparity }
  params: { ...DEFAULTS },
  sizeMul: 1.4,
  bleach: 0,
  shimmer: true,
  layers: { photo: true, shadow: true, ash: true },
  jobId: 0,
  device: '',
  stats: null,
};

// ---------------------------------------------------------------- panel

const SLIDERS = [
  { key: 'far', label: '远处距离', min: 4, max: 80, step: 1, unit: ' m' },
  { key: 'near', label: '近处距离', min: 0.3, max: 6, step: 0.1, unit: ' m' },
  { key: 'fov', label: '视场角', min: 30, max: 110, step: 1, unit: '°' },
  { key: 'jump', label: '断裂阈值', min: 0.04, max: 0.4, step: 0.01, unit: '' },
  { key: 'ash', label: '边缘灰烬', min: 0, max: 3, step: 0.1, unit: '' },
  { key: 'smoke', label: '影中烟尘', min: 0, max: 3, step: 0.1, unit: '' },
  { key: 'shadowTone', label: '影子明度', min: 0, max: 0.2, step: 0.01, unit: '' },
];

function renderPanel() {
  panel.innerHTML = '';
  for (const s of SLIDERS) panel.appendChild(sliderRow(s, state.params[s.key], (v) => {
    state.params[s.key] = v;
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

  const res = document.createElement('div');
  res.className = 'row';
  res.innerHTML = '<label><span>精度（粒子数）</span></label>';
  const sel = document.createElement('select');
  for (const r of [384, 512, 640, 800, 1024]) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = `${r} px` + (r === 640 ? '（默认）' : r >= 800 ? '（电脑）' : '');
    if (r === state.resolution) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    state.resolution = Number(sel.value);
    runDepth();
  };
  res.appendChild(sel);
  panel.appendChild(res);

  const checks = document.createElement('div');
  checks.className = 'checks';
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
  panel.appendChild(checks);

  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.id = 'stats';
  panel.appendChild(stats);
  renderStats();
}

function sliderRow(s, value, onInput) {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  const name = document.createElement('span');
  name.textContent = s.label;
  const out = document.createElement('output');
  const fmt = (v) => `${Number(v).toFixed(s.step < 0.1 ? 2 : s.step < 1 ? 1 : 0)}${s.unit}`;
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
  el.textContent = `照片 ${k(s.photo)} · 影子 ${k(s.shadow)} · 灰烬 ${k(s.ash)} · 断裂 ${k(s.tears)}\n` +
    `深度 ${s.depthMs.toFixed(0)} ms（${state.device}）· 生成 ${s.buildMs.toFixed(0)} ms`;
  el.style.whiteSpace = 'pre-line';
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

async function loadImage(source) {
  intro.classList.add('hidden');
  showBusy('读取照片');
  try {
    const blob = source instanceof Blob ? source : await (await fetch(source)).blob();
    state.bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (err) {
    console.error(err);
    showError('这张图片浏览器读不了（比如 HEIC 格式）。换成 JPG 或 PNG 试试。');
    return;
  }
  runDepth();
}

function runDepth() {
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

  const id = ++state.jobId;
  state.pending = { id, width: w, height: h, rgba };
  showBusy('准备深度模型');
  worker.postMessage({ id, width: w, height: h, pixels: rgba.slice() });
}

const downloads = new Map();
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') {
    downloads.set(m.file, m);
    let loaded = 0, total = 0;
    for (const d of downloads.values()) { loaded += d.loaded; total += d.total; }
    showBusy(`下载深度模型 ${(loaded / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`, loaded / total);
  } else if (m.type === 'status') {
    state.device = m.device === 'webgpu' ? 'WebGPU' : 'CPU';
    if (m.key === 'estimating') showBusy(`估计深度（${state.device}）`);
  } else if (m.type === 'result') {
    if (m.id !== state.jobId) return;
    state.depth = { width: m.width, height: m.height, rgba: state.pending.rgba, disparity: m.disparity };
    state.depthMs = m.ms;
    rebuild();
  } else if (m.type === 'error') {
    console.error(m.message);
    showError('深度估计失败：' + m.message);
  }
};

let rebuildTimer = 0;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 180);
}

function rebuild() {
  if (!state.depth) return;
  showBusy('凝固中');
  // let the busy text paint before the synchronous build
  requestAnimationFrame(() => setTimeout(() => {
    const t0 = performance.now();
    const built = buildScene(state.depth, state.params);
    const buildMs = performance.now() - t0;
    viewer.setScene(built);
    for (const [k, on] of Object.entries(state.layers)) viewer.setLayerVisible(k, on);
    state.stats = {
      photo: built.photo.count, shadow: built.shadow.count, ash: built.ash.count,
      tears: built.meta.tears, depthMs: state.depthMs || 0, buildMs,
    };
    renderStats();
    busy.classList.add('hidden');
    hud.classList.remove('hidden');
  }, 16));
}

// ---------------------------------------------------------------- input wiring

const fileInput = $('file');
fileInput.onchange = () => {
  if (fileInput.files[0]) loadImage(fileInput.files[0]);
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
  if (f) loadImage(f);
});
window.addEventListener('paste', (e) => {
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
  if (item) loadImage(item.getAsFile());
});

$('btn-new').onclick = () => fileInput.click();
$('btn-home').onclick = () => viewer.resetView();
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

if (matchMedia('(pointer: coarse)').matches) {
  $('hint').textContent = '单指拖动看四周 · 双指张合前进后退 · 双指平移侧移';
}

renderPanel();

// ?src=<image url> loads an image directly (handy for sharing examples and for testing)
const src = new URLSearchParams(location.search).get('src');
if (src) loadImage(src);

// exposed for tinkering from the devtools console
window.atom = { viewer, state, rebuild };
