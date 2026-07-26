import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('Daily 标题区同时提供时光机和漂流瓶入口', async () => {
  const [dailySource, actionsSource] = await Promise.all([
    readFile(new URL('src/components/daily/Daily.jsx', root), 'utf8'),
    readFile(new URL('src/components/daily/MemoryActions.jsx', root), 'utf8'),
  ]);

  assert.match(dailySource, /<MemoryActions/);
  assert.match(actionsSource, /<TimeMachineControls/);
  assert.match(actionsSource, /<DriftBottleControl/);
});

test('关闭漂流瓶后把键盘焦点恢复到入口', async () => {
  const source = await readFile(
    new URL('src/components/daily/drift/DriftBottleControl.jsx', root),
    'utf8'
  );

  assert.match(source, /wasOpenRef/);
  assert.match(source, /triggerRef\.current\?\.focus/);
  assert.match(source, /setTimeout/);
  assert.match(source, /lazy\(loadDriftBottleExperience\)/);
  assert.match(source, /<Suspense/);
});

test('漂流瓶体验使用模态 dialog、可退出并具有完整动画阶段', async () => {
  const source = await readFile(
    new URL('src/components/daily/drift/DriftBottleExperience.jsx', root),
    'utf8'
  );

  assert.match(source, /dialog\.showModal\(\)/);
  assert.match(source, /onCancel=/);
  assert.match(source, /window\.addEventListener\('keydown', handleEscape\)/);
  assert.match(source, /退出漂流瓶/);
  assert.match(source, /DRIFT_BOTTLE_PHASES\.UNCORKING/);
  assert.match(source, /DRIFT_BOTTLE_PHASES\.UNFOLDING/);
  assert.match(source, /DRIFT_BOTTLE_PHASES\.THROWING/);
  assert.match(source, /DRIFT_BOTTLE_PHASES\.SPLASHING/);
  assert.doesNotMatch(source, /<motion\./);
});

test('海面包含云、帆船、三层海浪和可点击瓶子', async () => {
  const source = await readFile(
    new URL('src/components/daily/drift/DriftSea.jsx', root),
    'utf8'
  );

  assert.match(source, /drift-cloud-three/);
  assert.match(source, /drift-sailboat-three/);
  assert.match(source, /drift-wave-far/);
  assert.match(source, /drift-wave-mid/);
  assert.match(source, /drift-wave-near/);
  assert.match(source, /aria-label=\{`打开第 \$\{index \+ 1\} 只漂流瓶`\}/);
});

test('海浪持续推进，瓶子根据指针速度和碰撞方位产生物理反馈', async () => {
  const [componentSource, cssSource] = await Promise.all([
    readFile(new URL('src/components/daily/drift/DriftSea.jsx', root), 'utf8'),
    readFile(new URL('src/components/daily/drift/DriftBottle.css', root), 'utf8'),
  ]);

  assert.match(componentSource, /calculateBottleCollision/);
  assert.match(componentSource, /samplePointerMotion/);
  assert.match(componentSource, /onPointerMoveCapture=\{trackPointer\}/);
  assert.match(componentSource, /onPointerEnter=\{\(event\) => applyPointerImpact\(event, true\)\}/);
  assert.match(componentSource, /className="drift-impact-ripple"/);
  assert.match(componentSource, /<MotionConfig reducedMotion="never">/);
  assert.match(cssSource, /@keyframes drift-wave-swell/);
  assert.match(cssSource, /@keyframes drift-sea-current/);
  assert.match(cssSource, /@keyframes drift-impact-ripple/);
  assert.match(cssSource, /will-change: transform/);
  assert.match(cssSource, /prefers-reduced-motion: reduce[\s\S]*?\.drift-wave-track[\s\S]*?animation-duration: 18s/);
  assert.match(cssSource, /prefers-reduced-motion: reduce[\s\S]*?\.drift-wave-track[\s\S]*?animation-iteration-count: infinite/);
  assert.match(cssSource, /prefers-reduced-motion: reduce[\s\S]*?\.drift-impact-ripple/);
});

test('漂流瓶样式覆盖移动端、安全区域和减少动态效果设置', async () => {
  const source = await readFile(
    new URL('src/components/daily/drift/DriftBottle.css', root),
    'utf8'
  );

  assert.match(source, /height: 100dvh/);
  assert.match(source, /env\(safe-area-inset-top\)/);
  assert.match(source, /@media \(max-width: 760px\)/);
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/);
});
