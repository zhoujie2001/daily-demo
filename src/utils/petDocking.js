const DOCK_SIDES = ['right', 'left'];

function intersectionArea(left, right) {
  const width = Math.max(
    0,
    Math.min(left.right, right.right) - Math.max(left.left, right.left)
  );
  const height = Math.max(
    0,
    Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top)
  );
  return width * height;
}

function createDockRect({
  dock,
  size,
  viewportWidth,
  viewportHeight,
  sideInset,
  bottomInset,
}) {
  const left = dock === 'left' ? sideInset : viewportWidth - sideInset - size;
  const top = viewportHeight - bottomInset - size;
  return {
    left,
    right: left + size,
    top,
    bottom: top + size,
  };
}

function scoreCandidate(rect, obstacles, clearance) {
  const expanded = {
    left: rect.left - clearance,
    right: rect.right + clearance,
    top: rect.top - clearance,
    bottom: rect.bottom + clearance,
  };
  return obstacles.reduce(
    (score, obstacle) => score + intersectionArea(expanded, obstacle),
    0
  );
}

export function resolvePetDock({
  viewportWidth,
  viewportHeight,
  fullSize = 104,
  compactSize = 56,
  sideInset = 8,
  bottomInset = 8,
  clearance = 8,
  obstacles = [],
} = {}) {
  const baseSizes = [
    { size: fullSize, compact: false },
    { size: compactSize, compact: true },
  ];
  const raisedOffsets = obstacles
    .map((obstacle) => viewportHeight - obstacle.top + clearance)
    .filter(
      (offset) =>
        offset > bottomInset &&
        viewportHeight - offset - compactSize >= 64
    )
    .sort((left, right) => left - right);
  const phases = [
    ...baseSizes.map((option) => ({ ...option, bottomOffset: bottomInset })),
    ...raisedOffsets.flatMap((bottomOffset) => [
      { size: compactSize, compact: true, bottomOffset },
      { size: fullSize, compact: false, bottomOffset },
    ]),
  ];
  let best = null;

  for (const sizeOption of phases) {
    for (const dock of DOCK_SIDES) {
      const rect = createDockRect({
        dock,
        size: sizeOption.size,
        viewportWidth,
        viewportHeight,
        sideInset,
        bottomInset: sizeOption.bottomOffset,
      });
      const score = scoreCandidate(rect, obstacles, clearance);
      const candidate = {
        dock,
        compact: sizeOption.compact,
        bottomOffset: sizeOption.bottomOffset,
        score,
      };
      if (!best || score < best.score) best = candidate;
      if (score === 0) return candidate;
    }
  }

  return best ?? {
    dock: 'right',
    compact: false,
    bottomOffset: bottomInset,
    score: 0,
  };
}
