// Lancer : node test/calc.test.mjs
import assert from 'node:assert/strict';
import { THEMES } from '../js/prt-data.js';
import { themeScore, overallScore, rating, NA } from '../js/calc.js';

let n = 0; const t = (name, fn) => { fn(); n++; console.log('✓', name); };

t('19 thèmes / 124 critères', () => {
  assert.equal(THEMES.length, 19);
  assert.equal(THEMES.reduce((a, x) => a + x.criteria.length, 0), 124);
});

const custom = { ref: 'T', name: 'Test', criteria: [{ ref: 'T.1' }, { ref: 'T.2' }, { ref: 'T.3' }] };

t('5, 4, N/A → 90 % (Excellent)', () => {
  const s = themeScore(custom, { 'T.1': { v: 5 }, 'T.2': { v: 4 }, 'T.3': { v: NA } });
  assert.equal(s.sum, 9); assert.equal(s.max, 10); assert.equal(s.pct, 0.9);
  assert.equal(rating(s.pct).name, 'Excellent');
});

t('Même cas sur le vrai thème 7.0 + 6.0 (5, 4, N/A)', () => {
  const th = THEMES.find(x => x.ref === '6.0');
  const s = themeScore(th, { '6.1': { v: 5 }, '6.2': { v: 4 }, '6.3': { v: NA } });
  assert.equal(s.pct, 0.9); assert.equal(s.rated, 2); assert.equal(s.done, 3);
});

t('Thème entièrement N/A exclu de la moyenne (Diving)', () => {
  const scores = { '8.1': { v: NA }, '10.1': { v: 4 }, '10.2': { v: 3 } };
  const o = overallScore(scores);
  assert.equal(o.countedThemes, 1);
  assert.equal(o.pct, 0.7); // seul le thème PPE compte : 7/10
  assert.equal(o.rating.name, 'Satisfactory');
});

t('Bonus / pénalité et bornes 0–100 %', () => {
  const s = { '10.1': { v: 5 } };
  assert.equal(overallScore(s, 10, 0).pct, 1);
  assert.equal(overallScore({ '10.1': { v: 0 } }, 0, 20).pct, 0);
  assert.ok(Math.abs(overallScore({ '10.1': { v: 4 } }, 5, 0).pct - 0.85) < 1e-9);
  assert.ok(Math.abs(overallScore({ '10.1': { v: 4 } }, 0, 15).pct - 0.65) < 1e-9);
});

t('Seuils de rating', () => {
  assert.equal(rating(0.9).name, 'Excellent');
  assert.equal(rating(0.8999).name, 'Good');
  assert.equal(rating(0.8).name, 'Good');
  assert.equal(rating(0.7).name, 'Satisfactory');
  assert.equal(rating(0.5).name, 'Weak');
  assert.equal(rating(0.49).name, 'Unacceptable');
  assert.equal(rating(null).name, 'N/A');
});

t('Aucune note → score global null', () => {
  assert.equal(overallScore({}).pct, null);
});

console.log(`\n${n} tests OK`);
