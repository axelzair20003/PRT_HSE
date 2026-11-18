// Logique de calcul PRT — fonctions pures, testables (voir test/calc.test.mjs)
import { THEMES } from './prt-data.js';

export const NA = 'NA';

export const SCALE = [
  { v: 0, fr: "Aucune preuve de conformité / activité arrêtée — risque mortel ou impact environnemental majeur", en: 'No evidence of compliance or activity stopped; fatality risk or major adverse environmental impact' },
  { v: 1, fr: 'Très faible conformité — risque de blessure grave', en: 'Very low compliance or risk of serious injury / serious environmental threat' },
  { v: 2, fr: 'Faible conformité — personnel / environnement à risque', en: 'Low compliance or personnel / environment at risk' },
  { v: 3, fr: 'Conformité partielle — non-conformité occasionnelle sans risque significatif', en: 'Partial compliance or occasional non-conformity without significant risk' },
  { v: 4, fr: 'Pleine conformité — améliorations possibles', en: 'Full compliance with site HSE requirements; improvements remain possible' },
  { v: 5, fr: 'Conformité totale ou supérieure — bonnes pratiques du secteur', en: 'Full or above compliance; industry best practices implemented' },
];

export const RATINGS = [
  { name: 'Excellent', min: 0.9, range: '>= 90%', color: '#1B5E20', fg: '#fff' },
  { name: 'Good', min: 0.8, range: '80% to < 90%', color: '#2E7D32', fg: '#fff' },
  { name: 'Satisfactory', min: 0.7, range: '70% to < 80%', color: '#FBC02D', fg: '#000' },
  { name: 'Weak', min: 0.5, range: '50% to < 70%', color: '#EF6C00', fg: '#000' },
  { name: 'Unacceptable', min: -Infinity, range: '< 50%', color: '#C62828', fg: '#fff' },
];
export const RATING_NA = { name: 'N/A', color: '#9E9E9E', fg: '#000' };

export function rating(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return RATING_NA;
  // arrondi pour éviter 0.8999999 → Good au lieu de Excellent
  const p = Math.round(pct * 1e6) / 1e6;
  return RATINGS.find(r => p >= r.min);
}

const isNum = v => typeof v === 'number' && v >= 0 && v <= 5;

/** Score d'un critère : note/5, null si N/A ou non noté */
export function criterionScore(v) { return isNum(v) ? v / 5 : null; }

/** scores = { '2.5': { v: 4 | 'NA' | null, c: '...', photos: [] }, ... } */
export function themeScore(theme, scores = {}) {
  let sum = 0, rated = 0, na = 0;
  for (const c of theme.criteria) {
    const v = scores[c.ref]?.v;
    if (isNum(v)) { sum += v; rated++; } else if (v === NA) na++;
  }
  const max = rated * 5;
  return {
    sum, max, rated, na, total: theme.criteria.length,
    done: rated + na, // critères traités (notés ou N/A)
    pct: max > 0 ? sum / max : null, // null = thème exclu de la moyenne
  };
}

export function overallScore(scores = {}, bonus = 0, penalty = 0, themes = THEMES) {
  const per = themes.map(t => ({ theme: t, ...themeScore(t, scores) }));
  const counted = per.filter(p => p.pct !== null);
  let pct = null;
  if (counted.length) {
    const avg = counted.reduce((a, p) => a + p.pct, 0) / counted.length;
    pct = Math.min(1, Math.max(0, avg + (Number(bonus) || 0) / 100 - (Number(penalty) || 0) / 100));
  }
  return { pct, rating: rating(pct), themes: per, countedThemes: counted.length };
}

export function themeOfRef(ref) {
  const major = String(ref).split('.')[0] + '.0';
  return THEMES.find(t => t.ref === major);
}
export function criterionOfRef(ref) {
  return themeOfRef(ref)?.criteria.find(c => c.ref === ref);
}
export const fmtPct = p => (p === null || p === undefined) ? '—' : Math.round(p * 1000) / 10 + ' %';
