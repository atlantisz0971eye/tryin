// A thumb stick for touch screens. Drag from the centre to move: up/down is forward/back, left/right
// sidesteps, and how far you push is how fast you go. Letting go returns it to the centre.

export class Stick {
  constructor(el, knob, onChange) {
    this.el = el;
    this.knob = knob;
    this.onChange = onChange;
    this.radius = 28;     // px of knob travel at full speed
    this.id = null;
    this.x = 0;
    this.y = 0;
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, (e) => this._up(e));
  }

  _down(e) {
    if (this.id !== null) return;
    this.id = e.pointerId;
    try { this.el.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ }
    const r = this.el.getBoundingClientRect();
    this.cx = r.left + r.width / 2;
    this.cy = r.top + r.height / 2;
    this.el.classList.add('held');
    this._move(e);
    e.preventDefault();
  }

  _move(e) {
    if (e.pointerId !== this.id) return;
    let dx = e.clientX - this.cx, dy = e.clientY - this.cy;
    const len = Math.hypot(dx, dy);
    if (len > this.radius) { dx *= this.radius / len; dy *= this.radius / len; }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    // a small dead zone, then a gentle curve so slow walking is easy to hold
    const m = Math.min(1, len / this.radius);
    const amount = m < 0.12 ? 0 : Math.pow((m - 0.12) / 0.88, 1.4);
    const k = len > 0 ? amount / Math.min(len, this.radius) : 0;
    this.x = dx * k;
    this.y = -dy * k;
    this.onChange(this.x, this.y);
  }

  _up(e) {
    if (e.pointerId !== this.id && e.type !== 'lostpointercapture') return;
    if (this.id === null) return;
    this.id = null;
    this.x = 0;
    this.y = 0;
    this.knob.style.transform = '';
    this.el.classList.remove('held');
    this.onChange(0, 0);
  }
}
