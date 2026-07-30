import {
  createPetEnvelopeMask,
  createPetProtectionMask,
  createSpatialBackgroundModel,
  findMovementLowerBounds,
  resolvePetMaskSize,
  sampleSpatialBackground,
  stabilizePetAlpha,
} from '../../utils/petMatte.js';

const FRAME_SIZE = 360;
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
    threshold = 20,
    maskSize = null,
    matteProfile = 'portrait',
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
    this.matteProfile = matteProfile;
    this.currentAction = null;
    this.currentMatteMode = null;
    this.switchToken = 0;
    this.switching = false;
    this.renderHandle = null;
    this.renderKind = null;
    this.onEnded = onEnded;
    this.onError = onError;
    this.onFps = onFps;
    this.frameCount = 0;
    this.fpsStartedAt = 0;
    this.maskSize =
      maskSize ??
      resolvePetMaskSize({
        viewportWidth: window.innerWidth,
        deviceMemory: navigator.deviceMemory ?? 8,
      });
    this.maskPixelCount = this.maskSize * this.maskSize;
    this.backgroundReference = null;
    this.previousAlpha = new Float32Array(this.maskPixelCount);
    this.rawAlpha = new Float32Array(this.maskPixelCount);
    this.repairedAlpha = new Float32Array(this.maskPixelCount);
    this.maskScratch = new Float32Array(this.maskPixelCount);
    this.scores = new Float32Array(this.maskPixelCount);
    this.luma = new Float32Array(this.maskPixelCount);
    this.movementLowerBounds = new Int16Array(this.maskSize);
    this.protection = createPetProtectionMask(
      this.maskSize,
      this.maskSize
    );
    this.envelope = createPetEnvelopeMask(
      this.maskSize,
      this.maskSize
    );
    this.hasPreviousMask = false;
    this.transitionStartedAt = 0;
    this.transitionActive = false;
    this.initialized = false;

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = this.maskSize;
    this.maskCanvas.height = this.maskSize;
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

  resetMask() {
    this.backgroundReference = null;
    this.previousAlpha.fill(0);
    this.hasPreviousMask = false;
  }

  createStableMask(source) {
    const context = this.maskContext;
    const size = this.maskSize;
    context.clearRect(0, 0, size, size);
    context.drawImage(source, 0, 0, size, size);
    const frame = context.getImageData(0, 0, size, size);
    if (!this.backgroundReference) {
      this.backgroundReference = createSpatialBackgroundModel(
        frame.data,
        size,
        size
      );
    }
    const backgroundModel = this.backgroundReference;
    const background = [0, 0, 0];
    const pixelCount = this.maskPixelCount;
    const scores = this.scores;
    const luma = this.luma;

    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const index = pixel * 4;
      const r = frame.data[index];
      const g = frame.data[index + 1];
      const b = frame.data[index + 2];
      const x = pixel % size;
      const y = Math.floor(pixel / size);
      sampleSpatialBackground(
        backgroundModel,
        x,
        y,
        background
      );
      luma[pixel] = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const colorDistance = Math.hypot(
        r - background[0],
        g - background[1],
        b - background[2]
      );
      const chromaDistance = Math.hypot(
        r - g - (background[0] - background[1]),
        g - b - (background[1] - background[2])
      );
      scores[pixel] = colorDistance * 0.58 + chromaDistance * 0.72;
    }

    if (this.matteProfile === 'movement') {
      findMovementLowerBounds({
        scores,
        luma,
        width: size,
        height: size,
        threshold: this.threshold,
        output: this.movementLowerBounds,
      });
    }

    const mask = context.createImageData(size, size);
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const previous = this.previousAlpha[pixel];
      const x = pixel % size;
      const y = Math.floor(pixel / size);
      const left = luma[y * size + Math.max(0, x - 1)];
      const right = luma[y * size + Math.min(size - 1, x + 1)];
      const top = luma[Math.max(0, y - 1) * size + x];
      const bottom = luma[Math.min(size - 1, y + 1) * size + x];
      const detail = Math.hypot(right - left, bottom - top);
      const detailBoost =
        this.protection[pixel] *
        smoothstep(7, 24, detail) *
        214;
      const effectiveThreshold =
        this.threshold + (1 - this.protection[pixel]) * 12;
      const keyedAlpha = Math.round(
        smoothstep(
          effectiveThreshold - (previous > 128 ? 9 : 6),
          effectiveThreshold + (previous > 128 ? 15 : 19),
          scores[pixel]
        ) * 255
      );
      const protectedCoreAlpha =
        this.matteProfile === 'movement'
          ? 0
          : this.protection[pixel] * 248;
      let rawAlpha = Math.max(
        keyedAlpha,
        detailBoost,
        protectedCoreAlpha
      );
      if (this.matteProfile === 'movement') {
        const lowerZone = smoothstep(
          size * 0.66,
          size * 0.86,
          y
        );
        const detailKeep = smoothstep(5, 18, detail);
        const groundSuppression =
          lowerZone *
          (1 - detailKeep) *
          0.98;
        rawAlpha *= 1 - groundSuppression;

        let lowerBound = 0;
        for (let offset = -3; offset <= 3; offset += 1) {
          lowerBound = Math.max(
            lowerBound,
            this.movementLowerBounds[
              clamp(x + offset, 0, size - 1)
            ]
          );
        }
        const lowerFade = 1 - smoothstep(
          lowerBound + 2,
          lowerBound + Math.max(6, size * 0.035),
          y
        );
        rawAlpha *= lowerFade;
      }
      this.rawAlpha[pixel] = rawAlpha;
    }

    stabilizePetAlpha({
      alpha: this.rawAlpha,
      previousAlpha: this.previousAlpha,
      envelope: this.envelope,
      width: size,
      height: size,
      hasPrevious: this.hasPreviousMask,
      output: this.repairedAlpha,
      scratch: this.maskScratch,
    });

    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const index = pixel * 4;
      const alpha = this.repairedAlpha[pixel];
      this.previousAlpha[pixel] = alpha;
      mask.data[index] = 255;
      mask.data[index + 1] = 255;
      mask.data[index + 2] = 255;
      mask.data[index + 3] = Math.round(clamp(alpha, 0, 255));
    }
    this.hasPreviousMask = true;
    context.putImageData(mask, 0, 0);
  }

  renderSource(source) {
    if (this.currentMatteMode === 'packed-horizontal') {
      this.renderPackedAlpha(source);
      return;
    }
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

  renderPackedAlpha(source) {
    const sourceWidth = source.videoWidth || source.naturalWidth;
    const sourceHeight = source.videoHeight || source.naturalHeight;
    if (!sourceWidth || !sourceHeight || sourceWidth < 2) return;

    const colorWidth = sourceWidth / 2;
    this.context.clearRect(0, 0, FRAME_SIZE, FRAME_SIZE);
    this.context.drawImage(
      source,
      0,
      0,
      colorWidth,
      sourceHeight,
      0,
      0,
      FRAME_SIZE,
      FRAME_SIZE
    );

    this.maskContext.clearRect(0, 0, this.maskSize, this.maskSize);
    this.maskContext.drawImage(
      source,
      colorWidth,
      0,
      colorWidth,
      sourceHeight,
      0,
      0,
      this.maskSize,
      this.maskSize
    );
    const matte = this.maskContext.getImageData(
      0,
      0,
      this.maskSize,
      this.maskSize
    );
    for (let index = 0; index < matte.data.length; index += 4) {
      const alpha = Math.round(
        matte.data[index] * 0.2126 +
          matte.data[index + 1] * 0.7152 +
          matte.data[index + 2] * 0.0722
      );
      matte.data[index] = 255;
      matte.data[index + 1] = 255;
      matte.data[index + 2] = 255;
      matte.data[index + 3] = alpha;
    }
    this.maskContext.putImageData(matte, 0, 0);

    this.context.save();
    this.context.globalCompositeOperation = 'destination-in';
    this.context.filter = 'blur(0.35px)';
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
    this.currentMatteMode = null;
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
      this.currentMatteMode = action.matteMode ?? null;
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
