// Detects footsteps from the phone's accelerometer, the same way on iPhone and Android.
// Feed it the magnitude of linear acceleration (gravity removed, m/s²) with a timestamp in seconds.
// A step is a bump that rises clearly above the walking baseline and falls back again.

export class StepDetector {
  constructor({ threshold = 1.1, minInterval = 0.28 } = {}) {
    this.threshold = threshold;
    this.minInterval = minInterval;
    this.smooth = 0;
    this.base = 0;
    this.armed = false;
    this.lastStep = -Infinity;
    this.lastT = null;
  }

  // returns true on the sample where a step completes
  feed(mag, t) {
    const dt = this.lastT === null ? 1 / 60 : Math.min(0.2, Math.max(1e-3, t - this.lastT));
    this.lastT = t;
    // low-pass the jitter (~8 Hz) and track a slow baseline (~0.5 Hz)
    this.smooth += (mag - this.smooth) * (1 - Math.exp(-dt * 50));
    this.base += (this.smooth - this.base) * (1 - Math.exp(-dt * 3));
    const v = this.smooth - this.base;

    if (!this.armed) {
      if (v > this.threshold && t - this.lastStep > this.minInterval) this.armed = true;
      return false;
    }
    if (v < this.threshold * 0.35) {
      this.armed = false;
      this.lastStep = t;
      return true;
    }
    return false;
  }
}

// linear acceleration magnitude from a DeviceMotionEvent, falling back to gravity-included data
export function motionMagnitude(e) {
  const a = e.acceleration;
  if (a && a.x != null) return Math.hypot(a.x, a.y, a.z);
  const g = e.accelerationIncludingGravity;
  if (g && g.x != null) return Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81);
  return 0;
}
