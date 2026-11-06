// Screen recording of the scene, entirely on the device. The picture is copied from the WebGL canvas
// into a 2D canvas right after each render (a WebGL canvas cannot be read later), a small mark is
// added, and MediaRecorder turns that into a video file: mp4 where the browser offers it (Safari),
// otherwise webm. Only the picture is recorded, never the buttons.

const MAX_SECONDS = 60;
const LONG_SIDE = 1080;
const FPS = 30;
const BITRATE = 8_000_000;

export function recordingSupported() {
  return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
}

function pickType() {
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export class Recorder {
  constructor(source) {
    this.source = source;        // the viewer's WebGL canvas
    this.active = false;
    this.onTick = null;          // (seconds) while recording
    this.onStop = null;          // (file | null)
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
  }

  start() {
    if (this.active || !recordingSupported()) return false;
    const sw = this.source.width, sh = this.source.height;
    const k = Math.min(1, LONG_SIDE / Math.max(sw, sh));
    this.canvas.width = Math.max(2, Math.round((sw * k) / 2) * 2);
    this.canvas.height = Math.max(2, Math.round((sh * k) / 2) * 2);
    const stream = this.canvas.captureStream(FPS);
    this.mime = pickType();
    this.chunks = [];
    this.rec = new MediaRecorder(stream, { ...(this.mime ? { mimeType: this.mime } : {}), videoBitsPerSecond: BITRATE });
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.onstop = () => this._finish();
    this.startedAt = performance.now();
    this.active = true;
    this.rec.start(500);
    return true;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    try { this.rec.stop(); } catch (_) { this._finish(); }
  }

  // called by the viewer straight after it renders a frame
  capture() {
    if (!this.active) return;
    const { ctx, canvas } = this;
    ctx.drawImage(this.source, 0, 0, canvas.width, canvas.height);
    const size = Math.round(canvas.height * 0.028);
    ctx.font = `italic ${size}px "Cormorant Garamond", Georgia, serif`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255, 250, 240, 0.7)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = size * 0.4;
    ctx.fillText("tryin'", canvas.width - size * 0.9, canvas.height - size * 0.9);
    ctx.shadowBlur = 0;
    const secs = (performance.now() - this.startedAt) / 1000;
    if (this.onTick) this.onTick(secs);
    if (secs >= MAX_SECONDS) this.stop();
  }

  _finish() {
    const type = (this.mime || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    const file = blob.size ? new File([blob], `tryin-${Date.now()}.${ext}`, { type }) : null;
    if (this.onStop) this.onStop(file);
  }
}

// share sheet on phones, a download everywhere else
export async function saveFile(file) {
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
