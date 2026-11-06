// Interface text in English (default) and Chinese. t(key, vars) fills {placeholders};
// static page text is marked with data-i18n / data-i18n-html / data-i18n-aria attributes.

const STRINGS = {
  en: {
    'doc.description': 'Turn any photo or short video into a frozen moment you can walk into. Everything stays on your device.',
    'intro.lede': 'freeze a moment, then walk into it',
    'drop.title': 'choose a photo or a short video',
    'intro.fine': 'it never leaves your device',
    'guide.home': 'back to<br />the start',
    'guide.menu': 'turn it over<br /><small>settings · new photo</small>',
    'busy.ready': 'getting ready',
    'label.home': 'back to origin',
    'label.menuAria': 'Turn over: settings and new material',
    'label.flipBack': 'turn back',
    'label.backAria': 'Turn to the front',
    'btn.new': 'new material',
    'btn.lang': '中文',
    'btn.langAria': '切换到中文',
    'credit': "inspired by James Blake's Trying Times, Interstellar, Minkowski spacetime and the Andromeda paradox",
    'diagram.aria': 'Minkowski diagram',
    'walk.title': 'Hold your phone up and walk in',
    'walk.sub': 'Turn to look around, take real steps to move. Make sure there is room around you.',
    'walk.go': 'walk in',
    'walk.stay': 'just look',
    'walk.denied': 'Motion access was not allowed, so touch controls stay on.',
    walkToggle: 'walk with the phone',
    walkScale: 'walk scale',
    stepLength: 'step length',
    'label.recenter': 're-center',
    'hint.walk': 'turn to look · take real steps to move · re-center to start over',
    'edge.warn': 'you are reaching the edge of the moment, turn around',
    'hud.show': 'Show details',
    'hud.hide': 'Hide details',

    'err.model': 'Could not load the depth model. Check your connection and reload.',
    'err.read': 'Could not read that. Try another file.',
    'err.decode': 'This browser cannot open that file (HEIC, for example). Try JPG, PNG or MP4.',
    'err.depth': 'Depth estimation failed: {m}',
    'err.video': 'This video could not be processed: {m}. Try an MP4 or a shorter clip.',
    'busy.download': 'downloading depth model {a} / {b} MB',
    'busy.read': 'reading file',
    'busy.prepare': 'preparing depth model',
    'busy.framesStart': 'extracting frames',
    'busy.frames': 'extracting frames {i} / {n}',
    'busy.depth': 'estimating depth {i} / {n} ({d})',
    'busy.freeze': 'freezing',
    'dist.origin': 'at the capture point',
    'dist.away': '{d} m from the capture point',
    'hint.touch': 'one finger to look · pinch to walk · two fingers to sidestep',
    'hint.mouse': 'drag to look · wasd / scroll to move · q e up and down',
    'hint.video': 'move, and the moment tilts',
    'tstat': 'v {v} m/s · β {b} · now {t} / {d} s',
    'stats.video': '{f} frames · {s} s · {p} particles per frame\ndepth {dm} s ({dev}) · build {bm} ms',
    'stats.photo': 'photo {p} · shadow {s} · ash {a} · tears {t}\ndepth {dm} ms ({dev}) · build {bm} ms',
    'calib': 'scene depth {r} m · walkable about {w} m · pace {p} m/s',
    'calib.manual': ' (by hand)',

    far: 'far distance',
    near: 'near distance',
    fov: 'field of view',
    jump: 'tear threshold',
    ash: 'edge ash',
    smoke: 'smoke in the shadow',
    shadowTone: 'shadow tone',
    size: 'particle size',
    bleach: 'flash bleach',
    soft: 'soft focus up close',
    bg: 'backdrop brightness',
    feather: 'edge blend',
    immersive: 'immersive backdrop',
    assist: 'face the picture while moving',
    res: 'detail (particles)',
    'res.default': ' (default)',
    'res.desktop': ' (desktop)',
    'layer.frames': 'now',
    'layer.plate': 'other moments',
    'layer.photo': 'photo',
    'layer.shadow': 'shadow',
    'layer.ash': 'ash',
    shimmer: 'shimmer',
    preset: 'time',
    driver: 'how now moves',
    end: 'at the end of the clip',
    auto: 'calibrate from scene depth',
    c: 'speed of light',
    spm: 'each metre walked moves now by',
    anchor: 'now',
    tint: 'time tint',
    ghost: 'other-moment tint',
    diagram: 'spacetime diagram',
    'preset.simultaneity': 'simultaneity: how you move tilts now',
    'preset.seen': 'what you would see: simultaneity + light delay',
    'preset.slowLight': 'slow light: the farther, the older',
    'preset.relative': 'capture point is now: closer = future',
    'driver.walk': 'walking: time passes only as you walk',
    'driver.fixed': 'fixed: now stays, it only tilts',
    'driver.clock': 'clock: now drifts on its own',
    'end.bounce': 'bounce: time flows back',
    'end.loop': 'loop: start over',
    'end.stop': 'stop at the end',
  },

  zh: {
    'doc.description': '上传任意一张照片或一段短视频，把那一瞬间凝固成可以走进去的粒子空间。素材只在你的设备上处理。',
    'intro.lede': '把一瞬间凝固下来，然后走进去',
    'drop.title': '选一张照片或一段短视频',
    'intro.fine': '素材不会离开你的设备',
    'guide.home': '回到<br />原点',
    'guide.menu': '翻过去<br /><small>设置 · 换素材</small>',
    'busy.ready': '准备中',
    'label.home': '回到原点',
    'label.menuAria': '翻到背面：参数与换素材',
    'label.flipBack': '翻回去',
    'label.backAria': '翻回正面',
    'btn.new': '换素材',
    'btn.lang': 'english',
    'btn.langAria': 'Switch to English',
    'credit': '灵感来自 James Blake《Trying Times》、《星际穿越》、闵可夫斯基时空与"仙女座悖论"',
    'diagram.aria': '闵可夫斯基时空图',
    'walk.title': '举起手机，走进去',
    'walk.sub': '转动手机看四周，真实迈步就会移动。请确认周围有足够的空间。',
    'walk.go': '走进去',
    'walk.stay': '只是看看',
    'walk.denied': '没有获得动作权限，继续使用触屏操作。',
    walkToggle: '用手机走动',
    walkScale: '行走比例',
    stepLength: '步长',
    'label.recenter': '重新对准',
    'hint.walk': '转动手机看四周 · 真实迈步移动 · 点重新对准从头开始',
    'edge.warn': '快走到这一瞬间的边缘了，转身回去吧',
    'hud.show': '显示信息',
    'hud.hide': '收起信息',

    'err.model': '深度模型加载失败，请检查网络后刷新重试。',
    'err.read': '读取失败，换一个文件试试。',
    'err.decode': '这个文件浏览器读不了（比如 HEIC 格式）。换成 JPG、PNG 或 MP4 试试。',
    'err.depth': '深度估计失败：{m}',
    'err.video': '这段视频处理失败：{m}。换成 MP4 或更短的视频试试。',
    'busy.download': '下载深度模型 {a} / {b} MB',
    'busy.read': '读取文件',
    'busy.prepare': '准备深度模型',
    'busy.framesStart': '抽取画面',
    'busy.frames': '抽取画面 {i} / {n}',
    'busy.depth': '估计深度 {i} / {n}（{d}）',
    'busy.freeze': '凝固中',
    'dist.origin': '站在拍摄点',
    'dist.away': '距拍摄点 {d} m',
    'hint.touch': '单指看四周 · 双指张合前进 · 双指平移侧移',
    'hint.mouse': '拖动看四周 · wasd / 滚轮 移动 · q e 升降',
    'hint.video': '动起来，此刻就会倾斜',
    'tstat': 'v {v} m/s · β {b} · 此刻 {t} / {d} s',
    'stats.video': '{f} 帧 · {s} s · 每帧 {p} 粒子\n深度 {dm} s（{dev}）· 生成 {bm} ms',
    'stats.photo': '照片 {p} · 影子 {s} · 灰烬 {a} · 断裂 {t}\n深度 {dm} ms（{dev}）· 生成 {bm} ms',
    'calib': '场景纵深 {r} m · 可走范围约 {w} m · 步速 {p} m/s',
    'calib.manual': '（手动）',

    far: '远处距离',
    near: '近处距离',
    fov: '视场角',
    jump: '断裂阈值',
    ash: '边缘灰烬',
    smoke: '影中烟尘',
    shadowTone: '影子明度',
    size: '粒子大小',
    bleach: '闪光漂白',
    soft: '近处柔焦',
    bg: '背景亮度',
    feather: '边缘融合',
    immersive: '沉浸背景',
    assist: '移动时自动正对画面',
    res: '精度（粒子数）',
    'res.default': '（默认）',
    'res.desktop': '（电脑）',
    'layer.frames': '当下',
    'layer.plate': '别处时刻',
    'layer.photo': '照片',
    'layer.shadow': '影子',
    'layer.ash': '灰烬',
    shimmer: '微光',
    preset: '时间预设',
    driver: '此刻怎么前进',
    end: '走到尽头',
    auto: '按场景深度自动校准',
    c: '世界光速',
    spm: '每走 1 米，此刻前进',
    anchor: '此刻',
    tint: '时差色调',
    ghost: '异时色调',
    diagram: '时空图',
    'preset.simultaneity': '同时性：怎么走，此刻就怎么倾斜',
    'preset.seen': '真实所见：同时性 + 光行时间',
    'preset.slowLight': '光速很慢：越远越是过去',
    'preset.relative': '以拍摄点为此刻：走近 = 未来',
    'driver.walk': '随步行累积：走才有时间，站着不动就凝固',
    'driver.fixed': '固定：此刻不动，只在移动时倾斜',
    'driver.clock': '时钟：此刻自己来回流动',
    'end.bounce': '往返：走到尽头，时间往回流',
    'end.loop': '循环：回到开头继续',
    'end.stop': '停在尽头',
  },
};

const STORAGE_KEY = 'tryin.lang';
let lang = 'en';
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'en' || saved === 'zh') lang = saved;
} catch (_) {
  // storage can be unavailable (private mode); English it is
}

const listeners = new Set();

export function t(key, vars = {}) {
  const s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
}

export function getLang() {
  return lang;
}

export function setLang(next) {
  if (next === lang || !STRINGS[next]) return;
  lang = next;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) { /* not persisted */ }
  applyStatic();
  for (const fn of listeners) fn(lang);
}

export function onLangChange(fn) {
  listeners.add(fn);
}

// fill every element marked in the page with the current language
export function applyStatic(root = document) {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.documentElement.dataset.lang = lang;
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.content = t('doc.description');
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
}
