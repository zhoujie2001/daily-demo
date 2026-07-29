export const PET_MASK_SIZE = Object.freeze({
  mobile: 224,
  desktop: 288,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(edge0, edge1, value) {
  const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function ellipseProtection(x, y, centerX, centerY, radiusX, radiusY) {
  const distance = Math.hypot(
    (x - centerX) / radiusX,
    (y - centerY) / radiusY
  );
  return 1 - smoothstep(0.62, 1.05, distance);
}

export function resolvePetMaskSize({
  viewportWidth = 1280,
  deviceMemory = 8,
} = {}) {
  return viewportWidth <= 700 || deviceMemory <= 4
    ? PET_MASK_SIZE.mobile
    : PET_MASK_SIZE.desktop;
}

export function createPetProtectionMask(width, height) {
  const protection = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const yRatio = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const xRatio = x / Math.max(1, width - 1);
      const head = ellipseProtection(
        xRatio,
        yRatio,
        0.5,
        0.42,
        0.105,
        0.095
      );
      const chest = ellipseProtection(
        xRatio,
        yRatio,
        0.49,
        0.6,
        0.13,
        0.22
      );
      const mane = ellipseProtection(
        xRatio,
        yRatio,
        0.41,
        0.54,
        0.075,
        0.16
      );
      const lowerBody = ellipseProtection(
        xRatio,
        yRatio,
        0.52,
        0.72,
        0.12,
        0.08
      );
      const bodySide = ellipseProtection(
        xRatio,
        yRatio,
        0.58,
        0.61,
        0.09,
        0.17
      );
      const tail = ellipseProtection(
        xRatio,
        yRatio,
        0.68,
        0.76,
        0.15,
        0.055
      );
      protection[y * width + x] = Math.max(
        head,
        chest,
        mane,
        bodySide,
        lowerBody,
        tail
      );
    }
  }

  return protection;
}

export function createPetEnvelopeMask(width, height) {
  const envelope = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const yRatio = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const xRatio = x / Math.max(1, width - 1);
      const head = ellipseProtection(
        xRatio,
        yRatio,
        0.5,
        0.39,
        0.24,
        0.23
      );
      const body = ellipseProtection(
        xRatio,
        yRatio,
        0.49,
        0.61,
        0.27,
        0.34
      );
      const tail = ellipseProtection(
        xRatio,
        yRatio,
        0.64,
        0.73,
        0.29,
        0.2
      );
      envelope[y * width + x] = Math.max(head, body, tail);
    }
  }

  return envelope;
}

export function createSpatialBackgroundModel(data, width, height) {
  const rowLeft = new Float32Array(height * 3);
  const rowRight = new Float32Array(height * 3);
  const columnTop = new Float32Array(width * 3);
  const columnBottom = new Float32Array(width * 3);
  const band = Math.max(2, Math.round(Math.min(width, height) * 0.025));

  const averagePixelBand = (positions) => {
    const result = [0, 0, 0];
    for (const [x, y] of positions) {
      const index = (y * width + x) * 4;
      result[0] += data[index];
      result[1] += data[index + 1];
      result[2] += data[index + 2];
    }
    result[0] /= positions.length;
    result[1] /= positions.length;
    result[2] /= positions.length;
    return result;
  };

  for (let y = 0; y < height; y += 1) {
    const left = averagePixelBand(
      Array.from({ length: band }, (_, x) => [x, y])
    );
    const right = averagePixelBand(
      Array.from({ length: band }, (_, offset) => [
        width - 1 - offset,
        y,
      ])
    );
    for (let channel = 0; channel < 3; channel += 1) {
      rowLeft[y * 3 + channel] = left[channel];
      rowRight[y * 3 + channel] = right[channel];
    }
  }

  for (let x = 0; x < width; x += 1) {
    const top = averagePixelBand(
      Array.from({ length: band }, (_, y) => [x, y])
    );
    const bottom = averagePixelBand(
      Array.from({ length: band }, (_, offset) => [
        x,
        height - 1 - offset,
      ])
    );
    for (let channel = 0; channel < 3; channel += 1) {
      columnTop[x * 3 + channel] = top[channel];
      columnBottom[x * 3 + channel] = bottom[channel];
    }
  }

  return {
    width,
    height,
    rowLeft,
    rowRight,
    columnTop,
    columnBottom,
  };
}

export function sampleSpatialBackground(model, x, y, target = [0, 0, 0]) {
  const xRatio = x / Math.max(1, model.width - 1);
  const yRatio = y / Math.max(1, model.height - 1);

  for (let channel = 0; channel < 3; channel += 1) {
    const horizontal =
      model.rowLeft[y * 3 + channel] * (1 - xRatio) +
      model.rowRight[y * 3 + channel] * xRatio;
    const vertical =
      model.columnTop[x * 3 + channel] * (1 - yRatio) +
      model.columnBottom[x * 3 + channel] * yRatio;
    target[channel] = horizontal * 0.55 + vertical * 0.45;
  }

  return target;
}

export function closeAlphaMask(source, width, height, target, scratch) {
  const pixelCount = width * height;
  if (
    source.length !== pixelCount ||
    target.length !== pixelCount ||
    scratch.length !== pixelCount
  ) {
    throw new RangeError('Alpha mask buffers must match the mask dimensions');
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let maximum = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const sampleY = clamp(y + offsetY, 0, height - 1);
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const sampleX = clamp(x + offsetX, 0, width - 1);
          maximum = Math.max(
            maximum,
            source[sampleY * width + sampleX]
          );
        }
      }
      scratch[y * width + x] = maximum;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let minimum = 255;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const sampleY = clamp(y + offsetY, 0, height - 1);
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const sampleX = clamp(x + offsetX, 0, width - 1);
          minimum = Math.min(
            minimum,
            scratch[sampleY * width + sampleX]
          );
        }
      }
      target[y * width + x] = minimum;
    }
  }

  return target;
}

export function stabilizePetAlpha({
  alpha,
  previousAlpha,
  envelope,
  width,
  height,
  hasPrevious,
  output,
  scratch,
}) {
  const pixelCount = width * height;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    alpha[pixel] = Math.min(
      alpha[pixel],
      envelope[pixel] * 255
    );
  }

  closeAlphaMask(
    alpha,
    width,
    height,
    output,
    scratch
  );

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const candidate = output[pixel];
    const previous = previousAlpha[pixel];
    const temporal = hasPrevious
      ? candidate >= previous
        ? previous * 0.28 + candidate * 0.72
        : previous * 0.58 + candidate * 0.42
      : candidate;
    output[pixel] = Math.min(
      temporal,
      envelope[pixel] * 255
    );
  }

  return output;
}
