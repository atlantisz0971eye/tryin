// Walking with the phone, identical on iPhone and Android, using only what both browsers offer:
//   turning: the gyroscope (deviceorientation) sets where the camera looks — the phone is a window
//   moving: the on-screen thumb stick (main.js). Counting real footsteps from the accelerometer
//           (devicemotion) is still here as an experiment, off by default.
// No camera is needed. When you start (or re-centre), the way you face becomes the way the
// picture was taken.

import * as THREE from 'three';
import { StepDetector, motionMagnitude } from './steps.js';

const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const TO_CAMERA = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // device looks out of the back

export function motionSupported() {
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window && matchMedia('(pointer: coarse)').matches;
}

// iOS asks for permission, and only from inside a tap; Android just works
export async function requestMotionPermission() {
  for (const E of [window.DeviceOrientationEvent, window.DeviceMotionEvent]) {
    if (E && typeof E.requestPermission === 'function') {
      const r = await E.requestPermission();
      if (r !== 'granted') return false;
    }
  }
  return true;
}

export class MotionWalker {
  constructor() {
    this.active = false;
    this.countSteps = false;   // experimental: real footsteps also move you
    this.stepLength = 0.7;     // metres per real step
    this.scale = 1;            // scene metres per real metre ("walk scale")
    this.steps = new StepDetector();
    this.raw = new THREE.Quaternion();
    this.quat = new THREE.Quaternion();
    this.yawOffset = new THREE.Quaternion();
    this.euler = new THREE.Euler();
    this.tmp = new THREE.Quaternion();
    this.forward = new THREE.Vector3();
    this.hasOrientation = false;
    this.needsRecenter = true;
    this.pending = 0;          // distance still to glide for the steps taken
    this.lastStepAt = -Infinity;
    this.stepCount = 0;
    this._onOrientation = (e) => this.onOrientation(e);
    this._onMotion = (e) => this.onMotion(e);
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.needsRecenter = true;
    this.pending = 0;
    window.addEventListener('deviceorientation', this._onOrientation);
    if (this.countSteps) window.addEventListener('devicemotion', this._onMotion);
  }

  setCountSteps(on) {
    this.countSteps = on;
    this.pending = 0;
    if (!this.active) return;
    if (on) window.addEventListener('devicemotion', this._onMotion);
    else window.removeEventListener('devicemotion', this._onMotion);
  }

  stop() {
    this.active = false;
    window.removeEventListener('deviceorientation', this._onOrientation);
    window.removeEventListener('devicemotion', this._onMotion);
  }

  onOrientation(e) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    const d = THREE.MathUtils.DEG2RAD;
    const screenAngle = ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * d;
    this.euler.set(e.beta * d, e.alpha * d, -e.gamma * d, 'YXZ');
    this.raw.setFromEuler(this.euler).multiply(TO_CAMERA).multiply(this.tmp.setFromAxisAngle(Z, -screenAngle));
    this.hasOrientation = true;
  }

  onMotion(e) {
    const t = (e.timeStamp || performance.now()) / 1000;
    if (this.steps.feed(motionMagnitude(e), t)) {
      this.pending = Math.min(this.pending + this.stepLength * this.scale, 3 * this.stepLength * this.scale);
      this.lastStepAt = performance.now() / 1000;
      this.stepCount++;
    }
  }

  // the direction you face right now becomes the direction of the original photo
  recenter() {
    this.forward.set(0, 0, -1).applyQuaternion(this.raw);
    const yaw = Math.atan2(-this.forward.x, -this.forward.z);
    this.yawOffset.setFromAxisAngle(Y, -yaw);
    this.needsRecenter = false;
  }

  // per frame: where to look and how far to move (horizontal, scene metres)
  update(dt) {
    if (this.needsRecenter && this.hasOrientation) this.recenter();
    this.quat.copy(this.yawOffset).multiply(this.raw);

    this.forward.set(0, 0, -1).applyQuaternion(this.quat);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();

    // each step glides over about half a second, so movement is continuous, not jumps
    const now = performance.now() / 1000;
    if (now - this.lastStepAt > 1.5) this.pending = 0;
    const speed = (this.stepLength * this.scale) / 0.5;
    const d = Math.min(this.pending, speed * dt);
    this.pending -= d;
    return { quat: this.quat, dx: this.forward.x * d, dz: this.forward.z * d, ready: this.hasOrientation };
  }
}
