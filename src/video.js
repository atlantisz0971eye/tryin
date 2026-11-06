// Samples evenly spaced frames from a video file, entirely in the browser.
//
// iOS Safari needs extra care: it does not load media data until playback starts (so
// 'loadeddata' may never fire on its own), decodes more reliably when the element is in the
// document, and can hand back a stale frame right after a seek. Every wait has a timeout so a
// stubborn file ends in an error message instead of a frozen progress bar.

function waitFor(target, event, ms, what) {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      target.removeEventListener('error', fail);
      resolve();
    };
    const fail = () => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      reject(new Error(`video decode failed (${what})`));
    };
    const timer = setTimeout(() => {
      target.removeEventListener(event, done);
      target.removeEventListener('error', fail);
      reject(new Error(`video timed out (${what})`));
    }, ms);
    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', fail, { once: true });
  });
}

// resolves once the frame at the current position has actually been decoded
function frameReady(video, ms = 250) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
    }
  });
}

async function seek(video, t) {
  if (Math.abs(video.currentTime - t) < 1e-3) return;
  const seeked = waitFor(video, 'seeked', 8000, 'seek');
  video.currentTime = t;
  await seeked;
  await frameReady(video);
}

export async function extractFrames(blob, { maxSide = 480, maxFrames = 40, maxSeconds = 10, sampleFps = 8 } = {}, onProgress) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'auto';
  // kept in the document but invisible: iOS decodes detached videos unreliably
  Object.assign(video.style, {
    position: 'fixed', left: '0', top: '0', width: '2px', height: '2px',
    opacity: '0', pointerEvents: 'none', zIndex: '-1',
  });
  document.body.appendChild(video);

  try {
    const meta = waitFor(video, 'loadedmetadata', 20000, 'metadata');
    video.src = url;
    video.load();
    await meta;

    // nudge iOS into actually loading and decoding: a muted inline play is always allowed
    if (video.readyState < 2) {
      try {
        await video.play();
        video.pause();
      } catch (_) {
        // some browsers refuse; fall through and wait for data the normal way
      }
      if (video.readyState < 2) await waitFor(video, 'loadeddata', 15000, 'data');
    }

    const duration = Math.min(video.duration || 0, maxSeconds);
    if (!isFinite(duration) || duration <= 0) throw new Error('video has no duration');
    if (!video.videoWidth || !video.videoHeight) throw new Error('video has no picture');

    const count = Math.max(2, Math.min(maxFrames, Math.round(duration * sampleFps)));
    const dt = duration / count;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.max(16, Math.round(video.videoWidth * scale));
    const h = Math.max(16, Math.round(video.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const frames = [];
    for (let i = 0; i < count; i++) {
      await seek(video, (i + 0.5) * dt);
      ctx.drawImage(video, 0, 0, w, h);
      frames.push(ctx.getImageData(0, 0, w, h).data);
      if (onProgress) onProgress(i + 1, count);
    }
    return { width: w, height: h, frames, fps: 1 / dt, duration };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}
