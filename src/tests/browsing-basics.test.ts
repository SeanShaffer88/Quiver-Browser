import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Input } from 'electron';
import { cleanUserAgent, nextZoom, ZOOM_STEPS } from '../main/browsing';
import { shortcutFor } from '../main/shortcuts';

test('the user agent drops Electron and app tokens but keeps Chrome', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quiver/0.1.0-beta.3 Chrome/142.0.7444.59 Electron/45.3.1 Safari/537.36';
  assert.equal(cleanUserAgent(ua, 'quiver'), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.59 Safari/537.36');
  assert.equal(cleanUserAgent('Mozilla/5.0 Chrome/1 Safari/1', 'quiver'), 'Mozilla/5.0 Chrome/1 Safari/1');
});

test('zoom follows Chrome-like steps and clamps', () => {
  assert.equal(nextZoom(1, 1), 1.1);
  assert.equal(nextZoom(1, -1), 0.9);
  assert.equal(nextZoom(1.05, 1), 1.1, 'an off-step factor moves to the next step');
  assert.equal(nextZoom(1.05, -1), 1);
  assert.equal(nextZoom(ZOOM_STEPS.at(-1)!, 1), ZOOM_STEPS.at(-1));
  assert.equal(nextZoom(ZOOM_STEPS[0], -1), ZOOM_STEPS[0]);
  assert.equal(nextZoom(1.5, 0), 1);
});

test('find and zoom shortcuts', () => {
  const key = (code: string, mods: Partial<Input> = {}) => shortcutFor({ type: 'keyDown', code, control: true, shift: false, alt: false, ...mods } as Input);
  assert.equal(key('KeyF'), 'find');
  assert.equal(key('F3', { control: false }), 'find-next');
  assert.equal(key('F3', { control: false, shift: true }), 'find-prev');
  assert.equal(key('Equal'), 'zoom-in');
  assert.equal(key('Equal', { shift: true }), 'zoom-in');
  assert.equal(key('NumpadAdd'), 'zoom-in');
  assert.equal(key('Minus'), 'zoom-out');
  assert.equal(key('NumpadSubtract'), 'zoom-out');
  assert.equal(key('Digit0'), 'zoom-reset');
  assert.equal(key('Numpad0'), 'zoom-reset');
});
