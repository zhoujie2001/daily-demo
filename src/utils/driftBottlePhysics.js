const MAX_POINTER_SPEED = 1200;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Converts a pointer collision into a small impulse around the bottle's
 * waterline. The torque is the two-dimensional cross product r × F, so a
 * pointer arriving from the left and moving right tips the bottle clockwise,
 * while the mirrored collision tips it counter-clockwise.
 */
export function calculateBottleCollision({
  pointerX,
  pointerY,
  velocityX,
  velocityY,
  rect,
}) {
  const width = Math.max(1, finiteNumber(rect?.width, 1));
  const height = Math.max(1, finiteNumber(rect?.height, 1));
  const left = finiteNumber(rect?.left);
  const top = finiteNumber(rect?.top);
  const centerX = left + width / 2;
  const pivotY = top + height * 0.78;
  const contactX = clamp((finiteNumber(pointerX) - centerX) / (width / 2), -1, 1);
  const contactY = clamp((finiteNumber(pointerY) - pivotY) / (height * 0.78), -1, 0.3);
  const rawVelocityX = finiteNumber(velocityX);
  const rawVelocityY = finiteNumber(velocityY);
  const speed = Math.hypot(rawVelocityX, rawVelocityY);
  const energy = clamp(speed / MAX_POINTER_SPEED, 0.18, 1);

  let directionX;
  let directionY;

  if (speed > 24) {
    directionX = rawVelocityX / speed;
    directionY = rawVelocityY / speed;
  } else {
    const fallbackLength = Math.max(0.001, Math.hypot(contactX, contactY));
    directionX = -contactX / fallbackLength;
    directionY = -contactY / fallbackLength;
  }

  const forceX = directionX * energy;
  const forceY = directionY * energy;
  const torque = contactX * forceY - contactY * forceX;
  const slowContactBias = speed <= 24 ? -contactX * 0.16 : 0;

  return {
    tilt: clamp((torque + slowContactBias) * 30, -22, 22),
    shiftX: clamp(forceX * 9, -9, 9),
    shiftY: clamp(forceY * 4 - energy * 1.4, -5, 4),
    energy,
    rippleScale: 0.8 + energy * 0.9,
    rippleOffset: contactX,
  };
}

export function samplePointerMotion(previous, next) {
  const timestamp = finiteNumber(next?.time);
  const lastTimestamp = finiteNumber(previous?.time);
  const deltaSeconds = clamp((timestamp - lastTimestamp) / 1000, 0.008, 0.08);
  const nextX = finiteNumber(next?.x);
  const nextY = finiteNumber(next?.y);

  if (!lastTimestamp) {
    return {
      x: nextX,
      y: nextY,
      velocityX: 0,
      velocityY: 0,
      time: timestamp,
    };
  }

  const measuredX = (nextX - finiteNumber(previous?.x)) / deltaSeconds;
  const measuredY = (nextY - finiteNumber(previous?.y)) / deltaSeconds;

  return {
    x: nextX,
    y: nextY,
    velocityX: finiteNumber(previous?.velocityX) * 0.38 + measuredX * 0.62,
    velocityY: finiteNumber(previous?.velocityY) * 0.38 + measuredY * 0.62,
    time: timestamp,
  };
}
