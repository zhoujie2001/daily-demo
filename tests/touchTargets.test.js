import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('移动端主要控件提供至少 44px 的触控目标', async () => {
  const css = await readFile(
    new URL('src/design-system.css', root),
    'utf8'
  );
  const petCss = await readFile(
    new URL('src/components/pet/CatPet.css', root),
    'utf8'
  );

  assert.match(css, /P0 mobile ergonomics/);
  assert.match(css, /\.time-machine-menu-toggle\s*\{[\s\S]*?width:\s*44px/);
  assert.match(css, /\.song-dot,[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
  assert.match(css, /\.links a\s*\{[\s\S]*?min-height:\s*52px/);
  assert.match(css, /\.time-machine-button-group\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(css, /\.ui-modal-close\s*\{[\s\S]*?min-width:\s*44px/);
  assert.match(petCss, /\.cat-video-pet-hide\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/s);
});
