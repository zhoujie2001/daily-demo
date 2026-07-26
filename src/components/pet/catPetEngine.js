import {
  advanceCatPetSchedule,
  blinkAmount,
  CAT_PET_EVENT,
  CAT_PET_REACTION,
  chooseCatPetReaction,
  createCatPetSchedule,
  reactionPose,
} from '../../utils/catPetBehavior';

const COLORS = Object.freeze({
  silver: [0.72, 0.73, 0.72, 1],
  silverLight: [0.82, 0.81, 0.77, 1],
  silverDark: [0.34, 0.36, 0.36, 1],
  stripe: [0.43, 0.44, 0.43, 1],
  white: [0.94, 0.91, 0.84, 1],
  eye: [0.65, 0.53, 0.18, 1],
  pupil: [0.055, 0.05, 0.042, 1],
  nose: [0.63, 0.31, 0.25, 1],
  innerEar: [0.78, 0.56, 0.52, 1],
});

const VERTEX_SHADER = `
  attribute vec3 a_position;
  attribute vec3 a_normal;

  uniform mat4 u_projection;
  uniform mat4 u_view;
  uniform mat4 u_model;

  varying vec3 v_normal;
  varying vec3 v_world;

  void main() {
    vec4 world = u_model * vec4(a_position, 1.0);
    v_world = world.xyz;
    v_normal = normalize(mat3(u_model) * a_normal);
    gl_Position = u_projection * u_view * world;
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;

  uniform vec4 u_color;
  uniform vec3 u_light;
  uniform vec3 u_camera;

  varying vec3 v_normal;
  varying vec3 v_world;

  void main() {
    vec3 normal = normalize(v_normal);
    float diffuse = max(dot(normal, normalize(u_light)), 0.0);
    vec3 viewDirection = normalize(u_camera - v_world);
    float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 2.0) * 0.13;
    float light = 0.62 + diffuse * 0.38 + rim;
    gl_FragColor = vec4(u_color.rgb * light, u_color.a);
  }
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Cat pet shader failed: ${message}`);
  }

  return shader;
}

function createProgram(gl) {
  const program = gl.createProgram();
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Cat pet program failed: ${message}`);
  }

  return program;
}

function createSphereGeometry(segments = 16, rings = 10) {
  const positions = [];
  const normals = [];
  const indices = [];

  for (let ring = 0; ring <= rings; ring += 1) {
    const v = ring / rings;
    const theta = v * Math.PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    for (let segment = 0; segment <= segments; segment += 1) {
      const u = segment / segments;
      const phi = u * Math.PI * 2;
      const x = Math.cos(phi) * sinTheta;
      const y = cosTheta;
      const z = Math.sin(phi) * sinTheta;
      positions.push(x, y, z);
      normals.push(x, y, z);
    }
  }

  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const first = ring * (segments + 1) + segment;
      const second = first + segments + 1;
      indices.push(first, second, first + 1, second, second + 1, first + 1);
    }
  }

  return { positions, normals, indices };
}

function triangleNormal(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const normal = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const length = Math.hypot(...normal) || 1;
  return normal.map((value) => value / length);
}

function createEarGeometry() {
  const apex = [0, 0.62, 0];
  const frontLeft = [-0.5, -0.5, 0.23];
  const frontRight = [0.5, -0.5, 0.23];
  const backRight = [0.34, -0.5, -0.2];
  const backLeft = [-0.34, -0.5, -0.2];
  const faces = [
    [apex, frontLeft, frontRight],
    [apex, frontRight, backRight],
    [apex, backRight, backLeft],
    [apex, backLeft, frontLeft],
    [frontLeft, backLeft, backRight],
    [frontLeft, backRight, frontRight],
  ];
  const positions = [];
  const normals = [];
  const indices = [];

  faces.forEach((face, faceIndex) => {
    const normal = triangleNormal(...face);
    face.forEach((vertex) => {
      positions.push(...vertex);
      normals.push(...normal);
    });
    const offset = faceIndex * 3;
    indices.push(offset, offset + 1, offset + 2);
  });

  return { positions, normals, indices };
}

function createMesh(gl, geometry) {
  const position = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, position);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array(geometry.positions),
    gl.STATIC_DRAW
  );

  const normal = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, normal);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array(geometry.normals),
    gl.STATIC_DRAW
  );

  const index = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
  gl.bufferData(
    gl.ELEMENT_ARRAY_BUFFER,
    new Uint16Array(geometry.indices),
    gl.STATIC_DRAW
  );

  return {
    position,
    normal,
    index,
    count: geometry.indices.length,
  };
}

function identityMatrix() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

function multiplyMatrices(a, b) {
  const result = new Float32Array(16);

  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      result[column * 4 + row] =
        a[row] * b[column * 4]
        + a[4 + row] * b[column * 4 + 1]
        + a[8 + row] * b[column * 4 + 2]
        + a[12 + row] * b[column * 4 + 3];
    }
  }

  return result;
}

function composeMatrix({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = [1, 1, 1],
} = {}) {
  const [rx, ry, rz] = rotation;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);

  const r00 = cz * cy;
  const r01 = cz * sy * sx - sz * cx;
  const r02 = cz * sy * cx + sz * sx;
  const r10 = sz * cy;
  const r11 = sz * sy * sx + cz * cx;
  const r12 = sz * sy * cx - cz * sx;
  const r20 = -sy;
  const r21 = cy * sx;
  const r22 = cy * cx;

  return new Float32Array([
    r00 * scale[0], r10 * scale[0], r20 * scale[0], 0,
    r01 * scale[1], r11 * scale[1], r21 * scale[1], 0,
    r02 * scale[2], r12 * scale[2], r22 * scale[2], 0,
    position[0], position[1], position[2], 1,
  ]);
}

function perspectiveMatrix(fieldOfView, aspect, near, far) {
  const f = 1 / Math.tan(fieldOfView / 2);
  const range = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (near + far) * range, -1,
    0, 0, near * far * range * 2, 0,
  ]);
}

function lookAtMatrix(eye, target, up) {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  const zLength = Math.hypot(zx, zy, zz) || 1;
  zx /= zLength;
  zy /= zLength;
  zz /= zLength;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xLength = Math.hypot(xx, xy, xz) || 1;
  xx /= xLength;
  xy /= xLength;
  xz /= xLength;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function smooth(current, target, factor) {
  return current + (target - current) * factor;
}

function createDrawPart(gl, program, meshes, uniforms, attributes) {
  return function drawPart({
    mesh = 'sphere',
    color,
    position,
    rotation,
    scale,
    parent = identityMatrix(),
  }) {
    const geometry = meshes[mesh];
    const local = composeMatrix({ position, rotation, scale });
    const model = multiplyMatrices(parent, local);

    gl.uniformMatrix4fv(uniforms.model, false, model);
    gl.uniform4fv(uniforms.color, color);

    gl.bindBuffer(gl.ARRAY_BUFFER, geometry.position);
    gl.vertexAttribPointer(attributes.position, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(attributes.position);

    gl.bindBuffer(gl.ARRAY_BUFFER, geometry.normal);
    gl.vertexAttribPointer(attributes.normal, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(attributes.normal);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, geometry.index);
    gl.drawElements(gl.TRIANGLES, geometry.count, gl.UNSIGNED_SHORT, 0);
  };
}

function drawTail(drawPart, globalMatrix, time, reducedMotion) {
  const sway = reducedMotion
    ? 0
    : Math.sin(time * 0.00072) * 0.07 + Math.sin(time * 0.00131) * 0.025;
  const points = [
    [0.52, -0.3, -0.18],
    [0.78, -0.48 + sway * 0.2, -0.08],
    [0.98 + sway, -0.68, 0.06],
    [0.93 + sway * 1.15, -0.86, 0.24],
    [0.7 + sway, -0.98, 0.41],
    [0.42 + sway * 0.65, -1.03, 0.53],
    [0.14 + sway * 0.3, -1.03, 0.58],
  ];

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    drawPart({
      color: index < 3 ? COLORS.silver : COLORS.silverLight,
      position: [
        (start[0] + end[0]) / 2,
        (start[1] + end[1]) / 2,
        (start[2] + end[2]) / 2,
      ],
      rotation: [0, 0, Math.atan2(dy, dx)],
      scale: [length * 0.94, 0.26 - index * 0.012, 0.24 - index * 0.01],
      parent: globalMatrix,
    });
  }
}

export function createCatPetEngine(canvas, {
  reducedMotion = false,
  onUnavailable,
} = {}) {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    powerPreference: 'low-power',
  });

  if (!gl) {
    onUnavailable?.();
    return null;
  }

  const program = createProgram(gl);
  const meshes = {
    sphere: createMesh(gl, createSphereGeometry()),
    ear: createMesh(gl, createEarGeometry()),
  };
  const attributes = {
    position: gl.getAttribLocation(program, 'a_position'),
    normal: gl.getAttribLocation(program, 'a_normal'),
  };
  const uniforms = {
    projection: gl.getUniformLocation(program, 'u_projection'),
    view: gl.getUniformLocation(program, 'u_view'),
    model: gl.getUniformLocation(program, 'u_model'),
    color: gl.getUniformLocation(program, 'u_color'),
    light: gl.getUniformLocation(program, 'u_light'),
    camera: gl.getUniformLocation(program, 'u_camera'),
  };
  const drawPart = createDrawPart(gl, program, meshes, uniforms, attributes);
  const camera = [0, 0.55, 5.15];
  const view = lookAtMatrix(camera, [0, 0.45, 0], [0, 1, 0]);

  let animationFrame = null;
  let running = false;
  let isReducedMotion = reducedMotion;
  let schedule = createCatPetSchedule(performance.now());
  let pointerTarget = { x: 0, y: 0, inside: false };
  let pointer = { x: 0, y: 0 };
  let reaction = null;
  let previousReaction = null;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.6);
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    return width / height;
  }

  function render(time) {
    if (!running) return;

    const aspect = resize();
    const advanced = advanceCatPetSchedule(schedule, time);
    schedule = advanced.schedule;
    const active = advanced.active;
    const blink = blinkAmount(active[CAT_PET_EVENT.BLINK] || 0);
    const earProgress = active[CAT_PET_EVENT.EAR_FLICK] || 0;
    const lookProgress = active[CAT_PET_EVENT.LOOK_AROUND] || 0;
    const lookArc = Math.sin(lookProgress * Math.PI * 2);
    const targetX = pointerTarget.inside ? pointerTarget.x : lookArc * 0.28;
    const targetY = pointerTarget.inside ? pointerTarget.y : 0;
    pointer.x = smooth(pointer.x, targetX, 0.055);
    pointer.y = smooth(pointer.y, targetY, 0.055);

    let interaction = { headTilt: 0, pawLift: 0, bodyBounce: 0 };
    if (reaction) {
      const progress = (time - reaction.startedAt) / reaction.duration;
      if (progress <= 1) {
        interaction = reactionPose(reaction.type, progress);
      } else {
        reaction = null;
      }
    }

    const breath = isReducedMotion ? 0 : Math.sin(time * 0.00155) * 0.024;
    const bodyBounce = interaction.bodyBounce;
    const globalMatrix = composeMatrix({
      position: [0, -0.03 + bodyBounce, 0],
      rotation: [0, -0.08, 0],
    });
    const headMatrix = multiplyMatrices(
      globalMatrix,
      composeMatrix({
        position: [0, 1.2 + breath * 0.4, 0.28],
        rotation: [
          pointer.y * -0.08,
          pointer.x * 0.16,
          interaction.headTilt,
        ],
      })
    );

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program);

    const projection = perspectiveMatrix(Math.PI / 4.5, aspect, 0.1, 100);
    gl.uniformMatrix4fv(uniforms.projection, false, projection);
    gl.uniformMatrix4fv(uniforms.view, false, view);
    gl.uniform3fv(uniforms.light, [-0.45, 0.8, 0.65]);
    gl.uniform3fv(uniforms.camera, camera);

    drawTail(drawPart, globalMatrix, time, isReducedMotion);

    drawPart({
      color: COLORS.silver,
      position: [0, 0.05 + breath, 0],
      scale: [0.78, 1.05 + breath, 0.56],
      parent: globalMatrix,
    });
    drawPart({
      color: COLORS.silverLight,
      position: [0.34, -0.18, -0.01],
      scale: [0.57, 0.72, 0.51],
      parent: globalMatrix,
    });
    drawPart({
      color: COLORS.white,
      position: [0, 0.27 + breath * 1.2, 0.48],
      scale: [0.56, 0.68 + breath, 0.21],
      parent: globalMatrix,
    });
    drawPart({
      color: COLORS.white,
      position: [-0.37, 0.55, 0.36],
      rotation: [0, 0, -0.18],
      scale: [0.33, 0.5, 0.19],
      parent: globalMatrix,
    });
    drawPart({
      color: COLORS.white,
      position: [0.37, 0.55, 0.36],
      rotation: [0, 0, 0.18],
      scale: [0.33, 0.5, 0.19],
      parent: globalMatrix,
    });

    const liftedPaw = interaction.pawLift;
    [-1, 1].forEach((side) => {
      const isLifted = side > 0;
      const lift = isLifted ? liftedPaw : 0;
      drawPart({
        color: COLORS.silverLight,
        position: [side * 0.28, -0.48 + lift * 0.62, 0.46 + lift * 0.22],
        rotation: [0, 0, isLifted ? -lift * 0.32 : 0],
        scale: [0.18, 0.57, 0.18],
        parent: globalMatrix,
      });
      drawPart({
        color: COLORS.white,
        position: [side * 0.29, -1.0 + lift, 0.56 + lift * 0.28],
        scale: [0.25, 0.14, 0.29],
        parent: globalMatrix,
      });

      [0, 1, 2].forEach((stripe) => {
        drawPart({
          color: COLORS.stripe,
          position: [
            side * 0.285,
            -0.25 - stripe * 0.16 + lift * 0.62,
            0.625 + lift * 0.22,
          ],
          rotation: [0, 0, side * 0.04],
          scale: [0.14, 0.024, 0.016],
          parent: globalMatrix,
        });
      });
    });

    drawPart({
      color: COLORS.silverLight,
      scale: [0.59, 0.52, 0.47],
      parent: headMatrix,
    });
    drawPart({
      mesh: 'ear',
      color: COLORS.silver,
      position: [-0.35, 0.38, -0.02],
      rotation: [0, 0, -0.11 - Math.sin(earProgress * Math.PI * 3) * 0.1],
      scale: [0.29, 0.47, 0.2],
      parent: headMatrix,
    });
    drawPart({
      mesh: 'ear',
      color: COLORS.silver,
      position: [0.35, 0.38, -0.02],
      rotation: [0, 0, 0.11],
      scale: [0.29, 0.47, 0.2],
      parent: headMatrix,
    });
    drawPart({
      mesh: 'ear',
      color: COLORS.innerEar,
      position: [-0.35, 0.37, 0.095],
      rotation: [0, 0, -0.11 - Math.sin(earProgress * Math.PI * 3) * 0.1],
      scale: [0.15, 0.34, 0.08],
      parent: headMatrix,
    });
    drawPart({
      mesh: 'ear',
      color: COLORS.innerEar,
      position: [0.35, 0.37, 0.095],
      rotation: [0, 0, 0.11],
      scale: [0.15, 0.34, 0.08],
      parent: headMatrix,
    });

    const eyeScale = Math.max(0.035, 1 - blink * 0.94);
    [-1, 1].forEach((side) => {
      drawPart({
        color: COLORS.eye,
        position: [side * 0.2, 0.06, 0.43],
        rotation: [0, side * -0.04, 0],
        scale: [0.105, 0.115 * eyeScale, 0.055],
        parent: headMatrix,
      });
      drawPart({
        color: COLORS.pupil,
        position: [
          side * 0.2 + pointer.x * 0.014,
          0.06 - pointer.y * 0.015,
          0.49,
        ],
        scale: [0.026, 0.072 * eyeScale, 0.02],
        parent: headMatrix,
      });
    });

    drawPart({
      color: COLORS.white,
      position: [-0.13, -0.13, 0.42],
      scale: [0.21, 0.17, 0.13],
      parent: headMatrix,
    });
    drawPart({
      color: COLORS.white,
      position: [0.13, -0.13, 0.42],
      scale: [0.21, 0.17, 0.13],
      parent: headMatrix,
    });
    drawPart({
      color: COLORS.nose,
      position: [0, -0.12, 0.55],
      scale: [0.075, 0.055, 0.052],
      parent: headMatrix,
    });

    [
      { x: 0, y: 0.25, rotate: 0, scale: [0.038, 0.125, 0.022] },
      { x: -0.105, y: 0.23, rotate: 0.2, scale: [0.034, 0.1, 0.021] },
      { x: 0.105, y: 0.23, rotate: -0.2, scale: [0.034, 0.1, 0.021] },
    ].forEach((stripe) => {
      drawPart({
        color: COLORS.stripe,
        position: [stripe.x, stripe.y, 0.43],
        rotation: [0, 0, stripe.rotate],
        scale: stripe.scale,
        parent: headMatrix,
      });
    });

    animationFrame = window.requestAnimationFrame(render);
  }

  function start() {
    if (running) return;
    running = true;
    animationFrame = window.requestAnimationFrame(render);
  }

  function stop() {
    running = false;
    if (animationFrame) window.cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }

  function destroy() {
    stop();
    Object.values(meshes).forEach((mesh) => {
      gl.deleteBuffer(mesh.position);
      gl.deleteBuffer(mesh.normal);
      gl.deleteBuffer(mesh.index);
    });
    gl.deleteProgram(program);
  }

  return {
    start,
    stop,
    destroy,
    setReducedMotion(value) {
      isReducedMotion = Boolean(value);
    },
    setPointer(x, y, inside = true) {
      pointerTarget = {
        x: Math.min(1, Math.max(-1, x)),
        y: Math.min(1, Math.max(-1, y)),
        inside,
      };
    },
    clearPointer() {
      pointerTarget = { x: 0, y: 0, inside: false };
    },
    react() {
      const type = chooseCatPetReaction(previousReaction);
      previousReaction = type;
      reaction = {
        type,
        startedAt: performance.now(),
        duration: type === CAT_PET_REACTION.PAW ? 1050 : 920,
      };
      return type;
    },
  };
}
