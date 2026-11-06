// Decides which moment of the clip each particle shows.
//
//   T(p) = T0                       the moment at your own position (your worldline)
//        + γ (v · r) / c²           relativity of simultaneity: moving tilts your "now"
//        − |r| / c                  light travel time: far things are seen as they were
//        + (|p| − |r|) / c          legacy: change in distance since the original viewpoint
//
// r is the particle relative to you, v your velocity, c the (slow) speed of light of this world.
// Each preset is a set of weights for the last three terms; the shader evaluates the formula.

export const PRESETS = {
  simultaneity: { label: '同时性：怎么走，此刻就怎么倾斜', tilt: 1, delay: 0, rel: 0 },
  seen: { label: '真实所见：同时性 + 光行时间', tilt: 1, delay: 1, rel: 0 },
  slowLight: { label: '光速很慢：越远越是过去', tilt: 0, delay: 1, rel: 0 },
  relative: { label: '以拍摄点为此刻：走近 = 未来', tilt: 0, delay: 0, rel: 1 },
};

export const DRIVERS = {
  walk: '随步行累积：走才有时间，站着不动就凝固',
  fixed: '固定：此刻不动，只在移动时倾斜',
  clock: '时钟：此刻自己来回流动',
};

export const END_MODES = {
  bounce: '往返：走到尽头，时间往回流',
  loop: '循环：回到开头继续',
  stop: '停在尽头',
};

const MAX_BETA = 0.95;

// Fits this world's speed of light and walking scale to the scene, so a street and a room both
// show a readable effect at a normal walking pace.
//   R  characteristic distance (median scene depth)     L  walkable range before things get too close
//   tilt:  walking at v shifts R by a quarter of the clip:  v R / c² = D / 4
//   delay: the far scene (90th percentile) arrives within 80% of the clip:  R90 / c = 0.8 D
//   relative: walking the range L changes distances by about half the clip:  L / c = D / 2
//   walk:  going across the range and back covers the whole clip:  s/m = D / 2L
export function calibrate({ median, p90 }, duration, walkSpeed = 1.2) {
  const D = Math.max(duration, 0.5);
  const R = Math.max(median, 0.5);
  const range = Math.min(6, Math.max(1, 0.35 * R));
  const cTilt = Math.max(Math.sqrt((walkSpeed * R) / (0.25 * D)), walkSpeed / 0.7);
  const cDelay = Math.max(p90, R) / (0.8 * D);
  return {
    R,
    range,
    walkSpeed,
    c: {
      simultaneity: cTilt,
      seen: Math.max(cTilt, cDelay),
      slowLight: cDelay,
      relative: range / (0.5 * D),
    },
    secondsPerMeter: D / (2 * range),
  };
}

export class TimeModel {
  constructor() {
    this.preset = 'simultaneity';
    this.driver = 'walk';
    this.c = 2;                 // m/s
    this.secondsPerMeter = 0.8; // walk driver: how much of your own time one metre costs
    this.duration = 1;
    this.fps = 1;
    this.t0 = 0;                // seconds into the clip
    this.clockDir = 1;
    this.endMode = 'bounce';
    this.walkDir = 1;
    this.lastWalked = 0;
    this.beta = 0;
    this.gamma = 1;
    this.v = [0, 0, 0];
    this.auto = true;
    this.depthStats = null;
    this.calib = null;
    this.speedEst = 1.2;   // typical walking speed, learned while moving
    this.recalClock = 0;
  }

  // assumed starting pace per input: keyboard ~1.2 m/s, fingers slower, real walking ~0.9
  setDepthStats(stats, walkSpeed) {
    this.depthStats = stats;
    if (walkSpeed) this.speedEst = walkSpeed;
    this.recalibrate();
  }

  recalibrate() {
    if (!this.depthStats) return;
    this.calib = calibrate(this.depthStats, this.duration, this.speedEst);
    if (!this.auto) return;
    this.c = this.calib.c[this.preset];
    this.secondsPerMeter = this.calib.secondsPerMeter;
  }

  configure(duration, fps) {
    this.duration = duration;
    this.fps = fps;
    this.reset();
  }

  // Presets that include light delay look into the past from the end of the clip.
  get startTime() {
    return PRESETS[this.preset].delay > 0 ? this.duration : this.duration * 0.25;
  }

  reset(walked = 0) {
    this.t0 = this.startTime;
    this.walkDir = 1;
    this.lastWalked = walked;
  }

  // keeps the walk inside the clip according to endMode
  _wrap(t) {
    const d = this.duration;
    if (this.endMode === 'stop') return Math.min(d, Math.max(0, t));
    if (this.endMode === 'loop') return ((t % d) + d) % d;
    if (t > d) { this.walkDir = -1; return Math.max(0, 2 * d - t); }
    if (t < 0) { this.walkDir = 1; return Math.min(d, -t); }
    return t;
  }

  setPreset(name) {
    this.preset = name;
    if (this.auto && this.calib) this.c = this.calib.c[name];
    this.reset(this.lastWalked);
  }

  update(observer, dt) {
    const walkedDelta = observer.walked - this.lastWalked;
    this.lastWalked = observer.walked;

    // learn how fast this person actually walks, slowly, and refit about once a second
    if (this.auto && observer.speed > 0.3) {
      const k = 1 - Math.exp(-dt / 8);
      this.speedEst += (Math.min(2.5, Math.max(0.4, observer.speed)) - this.speedEst) * k;
      this.recalClock += dt;
      if (this.recalClock > 1) { this.recalClock = 0; this.recalibrate(); }
    }

    if (this.driver === 'walk') {
      this.t0 = this._wrap(this.t0 + this.walkDir * walkedDelta * this.secondsPerMeter);
    } else if (this.driver === 'clock') {
      this.t0 += this.clockDir * dt * 0.5;
      if (this.t0 > this.duration) { this.t0 = this.duration; this.clockDir = -1; }
      if (this.t0 < 0) { this.t0 = 0; this.clockDir = 1; }
    }

    // at rest, settle onto a whole recorded frame so the moment is crisp, not a double exposure
    if (this.driver !== 'clock' && observer.speed < 0.05) {
      const target = (Math.round(this.t0 * this.fps - 0.5) + 0.5) / this.fps;
      this.t0 += (Math.min(this.duration, Math.max(0, target)) - this.t0) * (1 - Math.exp(-dt / 0.4));
    }

    // keep the world's light speed out of reach so the Lorentz factor stays finite
    let v = observer.v;
    const speed = Math.hypot(v[0], v[1], v[2]);
    const cap = MAX_BETA * this.c;
    if (speed > cap) v = v.map((x) => (x * cap) / speed);
    this.v = v;
    this.beta = Math.min(speed, cap) / this.c;
    this.gamma = 1 / Math.sqrt(1 - this.beta * this.beta);
  }

  // seconds per metre: slope of the "now" line along a direction with velocity component vx
  tiltSlope(vx) {
    return PRESETS[this.preset].tilt * this.gamma * vx / (this.c * this.c);
  }

  uniforms() {
    const p = PRESETS[this.preset];
    return {
      anchor: this.t0 * this.fps - 0.5,
      c: this.c,
      vel: this.v,
      gamma: this.gamma,
      weights: [p.tilt, p.delay, p.rel],
    };
  }
}
