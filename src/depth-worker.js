// Runs monocular depth estimation entirely in the browser.
// The photo never leaves the user's device; only the model weights are downloaded (once, then cached).
import { pipeline, RawImage, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

const MODEL = 'onnx-community/depth-anything-v2-small';

env.allowLocalModels = false;

let estimator = null;
let deviceUsed = null;

async function pickBackend() {
  try {
    if (self.navigator && self.navigator.gpu) {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) {
        return { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'fp16' : 'fp32' };
      }
    }
  } catch (_) {
    // fall through to wasm
  }
  return { device: 'wasm', dtype: 'q8' };
}

function onProgress(p) {
  if (p.status === 'progress' && p.total) {
    self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
  }
}

async function load() {
  if (estimator) return;
  const backend = await pickBackend();
  self.postMessage({ type: 'status', key: 'loading', device: backend.device });
  try {
    estimator = await pipeline('depth-estimation', MODEL, { ...backend, progress_callback: onProgress });
    deviceUsed = backend.device;
  } catch (err) {
    if (backend.device === 'wasm') throw err;
    // WebGPU can fail on some drivers; retry on CPU.
    self.postMessage({ type: 'status', key: 'loading', device: 'wasm' });
    estimator = await pipeline('depth-estimation', MODEL, { device: 'wasm', dtype: 'q8', progress_callback: onProgress });
    deviceUsed = 'wasm';
  }
}

self.onmessage = async (event) => {
  const { id, width, height, pixels } = event.data;
  try {
    await load();
    self.postMessage({ type: 'status', key: 'estimating', device: deviceUsed });
    const image = new RawImage(pixels, width, height, 4);
    const t0 = performance.now();
    const { predicted_depth } = await estimator(image);
    const disparity = Float32Array.from(predicted_depth.data);
    self.postMessage(
      { type: 'result', id, width, height, disparity, device: deviceUsed, ms: performance.now() - t0 },
      [disparity.buffer],
    );
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String((err && err.message) || err) });
  }
};
