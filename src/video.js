// Samples evenly spaced frames from a video file, entirely in the browser.
export async function extractFrames(blob, { maxSide = 480, maxFrames = 40, maxSeconds = 10, sampleFps = 8 } = {}, onProgress) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('video decode failed'));
    });
    const duration = Math.min(video.duration || 0, maxSeconds);
    if (!isFinite(duration) || duration <= 0) throw new Error('video has no duration');

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
      await new Promise((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = (i + 0.5) * dt;
      });
      ctx.drawImage(video, 0, 0, w, h);
      frames.push(ctx.getImageData(0, 0, w, h).data);
      if (onProgress) onProgress(i + 1, count);
    }
    return { width: w, height: h, frames, fps: 1 / dt, duration };
  } finally {
    URL.revokeObjectURL(url);
  }
}
