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
  assert.match(source, /DRIFT_BOTTLE_PHASES\.EXTRACTING/);
  assert.match(source, /DRIFT_BOTTLE_PHASES\.UNFOLDING/);
  assert.match(source, /DRIFT_BOTTLE_PHASES\.INSERTING/);
  assert.match(source, /DRIFT_BOTTLE_PHASES\.THROWING/);
  assert.match(source, /DRIFT_BOTTLE_PHASES\.SPLASHING/);
  assert.match(source, /className="drift-rolled-note"/);
  assert.match(source, /drift-splash-ring-outer/);
  assert.match(source, /drift-splash-ring-inner/);
  assert.match(source, /<MotionConfig reducedMotion="never">/);
  assert.doesNotMatch(source, /<motion\./);
});

test('取信和扔回时间轴保留可辨识的十段动作', async () => {
  const source = await readFile(
    new URL('src/components/daily/drift/DriftBottleExperience.jsx', root),
    'utf8'
  );

  const durations = Object.fromEntries(
    Array.from(source.matchAll(/^\s{2}(\w+): ([\d.]+),$/gm))
      .map(([, name, seconds]) => [name, Number(seconds)])
  );

  assert.ok(durations.approach >= 1.4);
  assert.ok(durations.uncork >= 1);
  assert.ok(durations.extract >= 1.2);
  assert.ok(durations.unfold >= 1.3);
  assert.ok(durations.fold >= 1.1);
  assert.ok(durations.insert >= 1.1);
  assert.ok(durations.cork >= 0.9);
  assert.ok(durations.throw >= 1.5);
  assert.ok(durations.splash >= 1.3);
  assert.match(source, /const PHASE_ADVANCE = Object\.freeze/);
  assert.match(source, /window\.setTimeout/);
  assert.match(source, /duration \* 1000 \+ 60/);
  assert.doesNotMatch(source, /reducedMotion \? 0\.01/);
});

test('聚焦瓶子可以在纸卷取出后隐藏瓶内纸张，并在放回后恢复', async () => {
  const [experienceSource, illustrationSource] = await Promise.all([
    readFile(new URL('src/components/daily/drift/DriftBottleExperience.jsx', root), 'utf8'),
    readFile(new URL('src/components/daily/drift/BottleIllustration.jsx', root), 'utf8'),
  ]);

  assert.match(experienceSource, /paperVisible=\{paperInsideBottle\}/);
  assert.match(illustrationSource, /paperVisible = true/);
  assert.match(illustrationSource, /\{paperVisible \? \(/);
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
