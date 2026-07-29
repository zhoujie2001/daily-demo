const FRAME_SIZE = 360;
const MASK_SIZE = 176;
const MEDIA_TIMEOUT = 12_000;
const TRANSITION_MS = 150;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(edge0, edge1, value) {
  const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function waitForMedia(video, eventName, timeout = MEDIA_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`等待 ${eventName} 超时`));
    }, timeout);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('视频素材加载失败'));
    };
    function cleanup() {
      window.clearTimeout(timer);
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener('error', onError);
    }
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

export default class StableVideoPetPlayer {
  constructor({
    canvas,
    videos,
    baseImage,
    threshold = 36,
    onEnded,
    onError,
    onFps,
  }) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', {
      alpha: true,
      willReadFrequently: true,
    });
    this.videos = videos;
    this.activeVideo = videos[0];
    this.inactiveVideo = videos[1];
    this.baseImage = baseImage;
    this.threshold = threshold;
    this.currentAction = null;
    this.switchToken = 0;
    this.switching = false;
    this.renderHandle = null;
    this.renderKind = null;
    this.onEnded = onEnded;
    this.onError = onError;
    this.onFps = onFps;
    this.frameCount = 0;
    this.fpsStartedAt = 0;
    this.backgroundReference = null;
    this.previousAlpha = new Float32Array(MASK_SIZE * MASK_SIZE);
    this.hasPreviousMask = false;
    this.transitionStartedAt = 0;
    this.transitionActive = false;
    this.initialized = false;

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = MASK_SIZE;
    this.maskCanvas.height = MASK_SIZE;
    this.maskContext = this.maskCanvas.getContext('2d', {
      alpha: true,
      willReadFrequently: true,
    });

    this.baseFrameCanvas = document.createElement('canvas');
    this.baseFrameCanvas.width = FRAME_SIZE;
    this.baseFrameCanvas.height = FRAME_SIZE;
    this.baseFrameContext = this.baseFrameCanvas.getContext('2d');

    this.transitionCanvas = document.createElement('canvas');
    this.transitionCanvas.width = FRAME_SIZE;
    this.transitionCanvas.height = FRAME_SIZE;
    this.transitionContext = this.transitionCanvas.getContext('2d');

    this.canvas.width = FRAME_SIZE;
    this.canvas.height = FRAME_SIZE;
    this.videos.forEach((video) => {
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.addEventListener('ended', () => {
        if (video === this.activeVideo && !video.loop) {
          this.onEnded?.(this.currentAction);
        }
      });
      video.addEventListener('error', () => {
        if (video === this.activeVideo) {
          this.onError?.(new Error('当前动作视频无法播放'));
        }
      });
    });
  }

  async initialize() {
    if (!this.baseImage.complete || !this.baseImage.naturalWidth) {
      await new Promise((resolve, reject) => {
        this.baseImage.addEventListener('load', resolve, { once: true });
        this.baseImage.addEventListener(
          'error',
          () => reject(new Error('基准图加载失败')),
          { once: true }
        );
      });
    }
    this.resetMask();
    this.renderSource(this.baseImage);
    this.baseFrameContext.clearRect(0, 0, FRAME_SIZE, FRAME_SIZE);
    this.baseFrameContext.drawImage(this.canvas, 0, 0);
    this.initialized = true;
  }

  sampleBackground(data, width, height) {
    const points = [
      [0.04, 0.04],
      [0.5, 0.035],
      [0.96, 0.04],
      [0.035, 0.48],
      [0.965, 0.48],
      [0.04, 0.94],
    ];
    const total = points.reduce(
      (result, [xRatio, yRatio]) => {
        const x = Math.round((width - 1) * xRatio);
        const y = Math.round((height - 1) * yRatio);
        const index = (y * width + x) * 4;
        result.r += data[index];
        result.g += data[index + 1];
        result.b += data[index + 2];
        return result;
      },
      { r: 0, g: 0, b: 0 }
    );
    return {
      r: total.r / points.length,
      g: total.g / points.length,
      b: total.b / points.length,
    };
  }

  resetMask() {
    this.backgroundReference = null;
    this.previousAlpha.fill(0);
    this.hasPreviousMask = false;
  }

  createStableMask(source) {
    const context = this.maskContext;
    context.clearRect(0, 0, MASK_SIZE, MASK_SIZE);
    context.drawImage(source, 0, 0, MASK_SIZE, MASK_SIZE);
    const frame = context.getImageData(0, 0, MASK_SIZE, MASK_SIZE);
    if (!this.backgroundReference) {
      this.backgroundReference = this.sampleBackground(
        frame.data,
        MASK_SIZE,
        MASK_SIZE
      );
    }
    const background = this.backgroundReference;
    const pixelCount = MASK_SIZE * MASK_SIZE;
    const scores = new Float32Array(pixelCount);
    const connected = new Uint8Array(pixelCount);
    const queue = new Int32Array(pixelCount);
    let start = 0;
    let end = 0;

    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const index = pixel * 4;
      const r = frame.data[index];
      const g = frame.data[index + 1];
      const b = frame.data[index + 2];
      const colorDistance = Math.hypot(
        r - background.r,
        g - background.g,
        b - background.b
      );
      const chromaDistance = Math.hypot(
        r - g - (background.r - background.g),
        g - b - (background.g - background.b)
      );
      scores[pixel] = colorDistance * 0.58 + chromaDistance * 0.72;
    }

    const enqueue = (pixel) => {
      if (connected[pixel] || scores[pixel] > this.threshold + 18) return;
      connected[pixel] = 1;
      queue[end] = pixel;
      end += 1;
    };

    for (let x = 0; x < MASK_SIZE; x += 1) {
      enqueue(x);
      enqueue((MASK_SIZE - 1) * MASK_SIZE + x);
    }
    for (let y = 1; y < MASK_SIZE - 1; y += 1) {
      enqueue(y * MASK_SIZE);
      enqueue(y * MASK_SIZE + MASK_SIZE - 1);
    }

    while (start < end) {
      const pixel = queue[start];
      start += 1;
      const x = pixel % MASK_SIZE;
      const y = Math.floor(pixel / MASK_SIZE);
      if (x > 0) enqueue(pixel - 1);
      if (x < MASK_SIZE - 1) enqueue(pixel + 1);
      if (y > 0) enqueue(pixel - MASK_SIZE);
      if (y < MASK_SIZE - 1) enqueue(pixel + MASK_SIZE);
    }

    const mask = context.createImageData(MASK_SIZE, MASK_SIZE);
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const index = pixel * 4;
      const previous = this.previousAlpha[pixel];
      const rawAlpha = connected[pixel]
        ? Math.round(
            smoothstep(
              this.threshold - (previous > 128 ? 9 : 6),
              this.threshold + (previous > 128 ? 15 : 19),
              scores[pixel]
            ) * 255
          )
        : 255;
      const alpha = this.hasPreviousMask
        ? previous * 0.45 + rawAlpha * 0.55
        : rawAlpha;
      this.previousAlpha[pixel] = alpha;
      mask.data[index] = 255;
      mask.data[index + 1] = 255;
      mask.data[index + 2] = 255;
      mask.data[index + 3] = Math.round(alpha);
    }
    this.hasPreviousMask = true;
    context.putImageData(mask, 0, 0);
  }

  renderSource(source) {
    this.context.clearRect(0, 0, FRAME_SIZE, FRAME_SIZE);
    this.context.drawImage(source, 0, 0, FRAME_SIZE, FRAME_SIZE);
    this.createStableMask(source);
    this.context.save();
    this.context.globalCompositeOperation = 'destination-in';
    this.context.filter = 'blur(0.65px)';
    this.context.drawImage(
      this.maskCanvas,
      0,
      0,
      FRAME_SIZE,
      FRAME_SIZE
    );
    this.context.restore();
    this.context.filter = 'none';
    this.applyTransitionOverlay();
  }

  captureTransitionFrame() {
    if (!this.initialized) return;
    this.transitionContext.clearRect(0, 0, FRAME_SIZE, FRAME_SIZE);
    this.transitionContext.drawImage(this.canvas, 0, 0);
    this.transitionStartedAt = performance.now();
    this.transitionActive = true;
  }

  applyTransitionOverlay() {
    if (!this.transitionActive) return;
    const progress = clamp(
      (performance.now() - this.transitionStartedAt) / TRANSITION_MS,
      0,
      1
    );
    if (progress >= 1) {
      this.transitionActive = false;
      return;
    }
    this.context.save();
    this.context.globalAlpha = 1 - progress;
    this.context.drawImage(this.transitionCanvas, 0, 0);
    this.context.restore();
  }

  drawCachedBase() {
    this.context.clearRect(0, 0, FRAME_SIZE, FRAME_SIZE);
    this.context.drawImage(this.baseFrameCanvas, 0, 0);
    this.applyTransitionOverlay();
  }

  drawBase({ instant = false } = {}) {
    this.activeVideo.pause();
    this.cancelRendering();
    if (!instant) this.captureTransitionFrame();
    this.currentAction = null;
    this.resetMask();
    if (instant || !this.transitionActive) {
      this.drawCachedBase();
      return;
    }
    const loop = () => {
      this.drawCachedBase();
      if (this.transitionActive) {
        this.renderKind = 'animation';
        this.renderHandle = requestAnimationFrame(loop);
      } else {
        this.renderHandle = null;
        this.renderKind = null;
      }
    };
    loop();
  }

  async prepare(video, actionKey, source) {
    if (video.dataset.action !== actionKey) {
      video.pause();
      video.src = source;
      video.dataset.action = actionKey;
      video.load();
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForMedia(video, 'loadeddata');
    }
    video.currentTime = 0;
  }

  async preload(actionKey, source) {
    if (
      this.switching ||
      this.currentAction === actionKey ||
      this.inactiveVideo.dataset.action === actionKey
    ) {
      return;
    }
    try {
      await this.prepare(this.inactiveVideo, actionKey, source);
    } catch {
      // 预加载失败不阻断当前动作，正式播放时会再次报告。
    }
  }

  async play(actionKey, action) {
    const token = (this.switchToken += 1);
    this.switching = true;
    try {
      let target = this.inactiveVideo;
      if (
        this.activeVideo.dataset.action === actionKey &&
        this.activeVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        target = this.activeVideo;
      } else {
        await this.prepare(target, actionKey, action.src);
      }
      if (token !== this.switchToken) return false;

      this.cancelRendering();
      this.captureTransitionFrame();
      this.resetMask();
      this.renderSource(target);
      if (target !== this.activeVideo) {
        const previous = this.activeVideo;
        this.activeVideo = target;
        this.inactiveVideo = previous;
        this.inactiveVideo.pause();
        this.inactiveVideo.loop = false;
      }
      this.currentAction = actionKey;
      this.activeVideo.loop = Boolean(action.loop);
      this.activeVideo.playbackRate = 1;
      this.activeVideo.currentTime = 0;
      await this.activeVideo.play();
      if (token !== this.switchToken) return false;
      this.startRendering();
      return true;
    } catch (error) {
      this.drawBase();
      this.onError?.(error);
      return false;
    } finally {
      if (token === this.switchToken) this.switching = false;
    }
  }

  updateFps(timestamp) {
    this.frameCount += 1;
    if (timestamp - this.fpsStartedAt < 1_000) return;
    this.onFps?.(
      Math.round(
        (this.frameCount * 1_000) / (timestamp - this.fpsStartedAt)
      )
    );
    this.frameCount = 0;
    this.fpsStartedAt = timestamp;
  }

  startRendering() {
    this.cancelRendering();
    this.frameCount = 0;
    this.fpsStartedAt = performance.now();

    if (typeof this.activeVideo.requestVideoFrameCallback === 'function') {
      const renderVideoFrame = (timestamp) => {
        if (
          !document.hidden &&
          !this.switching &&
          this.currentAction &&
          this.activeVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        ) {
          this.renderSource(this.activeVideo);
          this.updateFps(timestamp);
        }
        this.renderKind = 'video';
        this.renderHandle =
          this.activeVideo.requestVideoFrameCallback(renderVideoFrame);
      };
      this.renderKind = 'video';
      this.renderHandle =
        this.activeVideo.requestVideoFrameCallback(renderVideoFrame);
      return;
    }

    let lastTime = -1;
    const renderAnimationFrame = (timestamp) => {
      if (
        !document.hidden &&
        !this.switching &&
        this.currentAction &&
        this.activeVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        this.activeVideo.currentTime !== lastTime
      ) {
        lastTime = this.activeVideo.currentTime;
        this.renderSource(this.activeVideo);
        this.updateFps(timestamp);
      }
      this.renderKind = 'animation';
      this.renderHandle = requestAnimationFrame(renderAnimationFrame);
    };
    this.renderKind = 'animation';
    this.renderHandle = requestAnimationFrame(renderAnimationFrame);
  }

  cancelRendering() {
    if (this.renderHandle === null) return;
    if (
      this.renderKind === 'video' &&
      typeof this.activeVideo.cancelVideoFrameCallback === 'function'
    ) {
      this.activeVideo.cancelVideoFrameCallback(this.renderHandle);
    } else {
      cancelAnimationFrame(this.renderHandle);
    }
    this.renderHandle = null;
    this.renderKind = null;
  }

  pause() {
    this.activeVideo.pause();
    this.cancelRendering();
  }

  resume() {
    if (!this.currentAction) return;
    this.activeVideo
      .play()
      .then(() => this.startRendering())
      .catch(() => {});
  }

  destroy() {
    this.switchToken += 1;
    this.cancelRendering();
    this.videos.forEach((video) => {
      video.pause();
      video.removeAttribute('src');
    });
  }
}
