// Tracks how the viewer moves: smoothed velocity and distance walked.
// Velocity rises quickly when you start moving and relaxes slowly when you stop,
// so the tilted "now" settles back like a ripple instead of snapping.

const RISE = 0.3;      // seconds to pick up a new velocity
const RELAX = 1.0;     // seconds to let it fade after stopping
const TELEPORT = 15;   // m/s; faster jumps are programmatic moves, not walking

export class Observer {
  constructor() {
    this.reset();
  }

  reset(pos = null) {
    this.prev = pos ? [pos[0], pos[1], pos[2]] : null;
    this.v = [0, 0, 0];
    this.walked = 0;
  }

  // hold: the viewer is being moved by an animation (e.g. returning home); do not count it
  update(pos, dt, hold = false) {
    if (!this.prev || dt <= 0) {
      this.prev = [pos[0], pos[1], pos[2]];
      return;
    }
    const dx = pos[0] - this.prev[0], dy = pos[1] - this.prev[1], dz = pos[2] - this.prev[2];
    const step = Math.hypot(dx, dy, dz);
    this.prev = [pos[0], pos[1], pos[2]];

    if (hold || step / dt > TELEPORT) {
      this.v = [0, 0, 0];
      return;
    }

    this.walked += step;
    const raw = [dx / dt, dy / dt, dz / dt];
    const speeding = Math.hypot(...raw) > this.speed;
    const k = 1 - Math.exp(-dt / (speeding ? RISE : RELAX));
    for (let i = 0; i < 3; i++) this.v[i] += (raw[i] - this.v[i]) * k;
  }

  get speed() {
    return Math.hypot(this.v[0], this.v[1], this.v[2]);
  }
}
