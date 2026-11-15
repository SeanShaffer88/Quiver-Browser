import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMotion, normalizeSpaceColors, spaceColor, SPACE_PRESETS } from '../shared/theme';
// The renderer build emits these modules as ESM; Node's module syntax detection loads them here.
import { AA_TEXT, contrastRatio, isHexColor, luminance, mix, monogram, PALETTE, parseHex, readableOn, spaceTheme, strongestTint, textOn, toHex } from '../renderer/space-theme';
import { motionReduced } from '../renderer/motion';

test('contrast ratio matches the WCAG reference values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  assert.equal(contrastRatio('#ffffff', '#000000'), contrastRatio('#000000', '#ffffff'));
  // #767676 on white is the classic 4.54:1 grey.
  assert.ok(Math.abs(contrastRatio('#767676', '#ffffff') - 4.54) < 0.01);
  assert.ok(Math.abs(luminance('#ffffff') - 1) < 1e-9);
  assert.equal(luminance('#000000'), 0);
});

test('hex helpers round-trip and reject anything that is not #rrggbb', () => {
  assert.deepEqual(parseHex('#5b8cff'), [0x5b, 0x8c, 0xff]);
  assert.equal(toHex(parseHex('#5B8CFF')), '#5b8cff');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#123456', '#abcdef', 0), '#123456');
  for (const bad of ['', '#fff', 'red', '#12345g', 'url(x)', '#1234567', null, 5]) assert.equal(isHexColor(bad), false);
  assert.throws(() => parseHex('#fff'));
});

test('the base palettes meet AA, so a zero tint always works', () => {
  for (const p of [PALETTE.dark, PALETTE.light]) {
    for (const bg of [p.panel, p.panel2]) for (const fg of [p.text, p.muted]) assert.ok(contrastRatio(fg, bg) >= AA_TEXT, `${fg} on ${bg}`);
  }
});

const SAMPLE = [
  ...SPACE_PRESETS.map((p) => p.color), '#ffffff', '#000000', '#ffff00', '#00ff00', '#ff0000', '#0000ff', '#00ffff', '#ff00ff',
  '#808080', '#8b5cf6', '#1b1e24', '#f6f7f9', '#7fff00', '#ffd700',
];

test('Space themes keep text, muted text and the accent at 4.5:1 in both palettes', () => {
  for (const dark of [true, false]) {
    const p = dark ? PALETTE.dark : PALETTE.light;
    for (const c1 of SAMPLE) {
      for (const c2 of [undefined, ...SAMPLE.slice(0, 8), '#ffffff', '#000000']) {
        const t = spaceTheme(c1, c2, dark);
        const backgrounds = [...t.sidebar, t.row, ...(t.sidebar.length === 2 ? [mix(t.sidebar[0], t.sidebar[1], 0.5)] : [])];
        for (const bg of backgrounds) {
          for (const fg of [p.text, p.muted, t.accent]) {
            assert.ok(contrastRatio(fg, bg) >= AA_TEXT, `${dark ? 'dark' : 'light'} ${c1}/${c2}: ${fg} on ${bg} is ${contrastRatio(fg, bg).toFixed(2)}`);
          }
        }
        for (const bg of [p.panel, p.bg]) assert.ok(contrastRatio(t.accent, bg) >= AA_TEXT, `accent ${t.accent} on toolbar ${bg}`);
        assert.ok(contrastRatio(t.onAccent, t.accent) >= AA_TEXT, `on-accent ${t.onAccent} on ${t.accent}`);
        assert.ok(contrastRatio(t.monogramText, t.monogramBg) >= AA_TEXT, `monogram ${t.monogramText} on ${t.monogramBg}`);
      }
    }
  }
});

test('Space themes visibly tint the sidebar and keep a second colour as a gradient', () => {
  const light = spaceTheme('#ff7a59', '#2cc5d9', false);
  assert.equal(light.sidebar.length, 2);
  assert.notEqual(light.sidebar[0], PALETTE.light.panel);
  assert.notEqual(light.sidebar[0], light.sidebar[1]);
  const dark = spaceTheme('#5b8cff', undefined, true);
  assert.equal(dark.sidebar.length, 1);
  assert.notEqual(dark.sidebar[0], PALETTE.dark.panel);
  // An invalid colour falls back to the default blue instead of throwing.
  assert.deepEqual(spaceTheme('nope', 'also-bad', true), spaceTheme('#5b8cff', undefined, true));
});

test('tint and accent helpers stop at the first readable value', () => {
  assert.equal(strongestTint('#ffffff', '#000000', ['#000000'], 0), '#ffffff');
  const tinted = strongestTint('#ffffff', '#0000ff', ['#535b69'], 0.5);
  assert.ok(contrastRatio('#535b69', tinted) >= AA_TEXT);
  assert.equal(readableOn('#2f5fd6', ['#ffffff'], false), '#2f5fd6');
  assert.ok(contrastRatio(readableOn('#ffff00', ['#ffffff'], false), '#ffffff') >= AA_TEXT);
  assert.equal(textOn('#000000'), '#ffffff');
  assert.equal(textOn('#ffffff'), '#0b1020');
});

test('favicon monograms use the site name, then the title', () => {
  assert.equal(monogram('https://www.github.com/x', 'Whatever'), 'G');
  assert.equal(monogram('http://127.0.0.1:3000/', 'my app'), 'M');
  assert.equal(monogram('http://localhost:5173/', 'Vite'), 'V');
  assert.equal(monogram('quiver://app/settings.html', 'Settings'), 'S');
  assert.equal(monogram('not a url', '  ✨ ünïcode'), 'Ü');
  assert.equal(monogram('', ''), '?');
});

test('Space colours from disk and IPC are validated', () => {
  assert.equal(spaceColor('#ABCDEF'), '#abcdef');
  for (const bad of ['', 'red', '#abc', 'javascript:1', null, undefined, 3]) assert.equal(spaceColor(bad), undefined);
  assert.deepEqual(normalizeSpaceColors({ id: 'a', color: 'bad', color2: '#FF0000' }), { id: 'a', color: '#5b8cff', color2: '#ff0000' });
  assert.deepEqual(normalizeSpaceColors({ id: 'a', color: '#00FF00', color2: 'nope' }), { id: 'a', color: '#00ff00' });
  for (const p of SPACE_PRESETS) assert.equal(spaceColor(p.color), p.color);
});

test('reduce motion: the setting wins, system follows the OS', () => {
  assert.equal(motionReduced('on', false), true);
  assert.equal(motionReduced('off', true), false);
  assert.equal(motionReduced('system', true), true);
  assert.equal(motionReduced('system', false), false);
  assert.equal(motionReduced(undefined, true), true);
  assert.equal(normalizeMotion('on'), 'on');
  assert.equal(normalizeMotion('off'), 'off');
  for (const bad of [undefined, 'yes', true, 1, 'ON']) assert.equal(normalizeMotion(bad), 'system');
});
