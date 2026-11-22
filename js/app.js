// PRT HSE — application principale (routeur + écrans)
import { THEMES } from './prt-data.js';
import { NA, SCALE, RATINGS, rating, themeScore, overallScore, criterionOfRef, themeOfRef, fmtPct } from './calc.js';
import * as db from './db.js';
import { createPlanViewer, centroid } from './plan.js';
import { compressImage, planFileToBlob, pdfPageCount } from './images.js';
import { ic } from './icons.js';
import * as cloud from './cloud.js';
import { SEED_SUBS, SEED_LOCATIONS, SEED_PLAN, SEED_SITE, SEED_PROJECT, loadSeed } from './seed.js';
import { CRIT_FR, THEME_FR, TXT as RTXT, RATING_FR, RANGE_FR } from './report-fr.js';
import { REPORT_DEFAULTS, REPORT_TITLES, buildXLSX, buildPDF, shareFile, download, canShareFile, actionRef } from './export.js';

export const APP_VERSION = '4.0.6';

// ---------- utilitaires ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let view = $('#view');
const todayISO = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('sv-SE'); };
const dateFR = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
const isLate = a => a.status !== 'Closed' && a.dueDate && a.dueDate < todayISO();
const clamp01 = v => Math.min(1, Math.max(0, v));
const pendingSaves = new Set();
const debounce = (fn, ms = 400) => {
  let t;
  const d = (...a) => { clearTimeout(t); pendingSaves.add(d); t = setTimeout(() => { pendingSaves.delete(d); fn(...a); }, ms); };
  d.flush = (...a) => { clearTimeout(t); pendingSaves.delete(d); return fn(...a); };
  return d;
};
const PALETTE = ['#E65100', '#6D4C41', '#C62828', '#00897B', '#AD1457', '#1565C0', '#6A1B9A', '#2E7D32', '#F9A825', '#455A64', '#00ACC1', '#7CB342'];
// Types d'entreprise : clé interne → libellé affiché (à modifier ici si besoin)
const COMPANY_TYPES = {
  entreprise: { label: 'Sous-traitant', plural: 'Sous-traitants', hint: 'réalise et livre un lot' },
  sub: { label: 'Prestataire', plural: 'Prestataires', hint: 'intervient puis repart (échafaudage, levage…)' },
};
const typeOf = s => COMPANY_TYPES[s?.type === 'sub' ? 'sub' : 'entreprise'];
const PRIOS = ['High', 'Medium', 'Low'];
const PRIO_FR = { High: 'Haute', Medium: 'Moyenne', Low: 'Basse' };
const STATUSES = ['Open', 'In progress', 'Closed'];
const STATUS_FR = { Open: 'Ouverte', 'In progress': 'En cours', Closed: 'Clôturée' };
const DUE_BY_PRIO = { High: 1, Medium: 7, Low: 14 };

let cleanups = [];
const onCleanup = f => cleanups.push(f);

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function openSheet(html, onMount) {
  const root = $('#sheet-root');
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog">${html}</div>`;
  root.appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  onMount?.(bg.firstElementChild, close);
  return close;
}
function ask(title, text, buttons) {
  return new Promise(res => {
    const close = openSheet(`<h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}<div style="display:grid;gap:10px">${buttons.map((b, i) => `<button class="btn block ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`,
      el => el.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) { close(); res(buttons[+b.dataset.i].value); } }));
    void close;
  });
}
const confirmBox = (title, text, ok = 'Confirmer', cls = 'danger') => ask(title, text, [{ label: ok, value: true, cls }, { label: 'Annuler', value: false }]);

function setTop({ title, sub = '', back = null, actions = [], onTitle = null }) {
  const t = $('#title');
  t.innerHTML = `<span>${esc(title)}${onTitle ? ic('chevron', 16).replace('class="ic"', 'class="ic title-chev"') : ''}</span>` + (sub ? `<small>${esc(sub)}</small>` : '');
  t.classList.toggle('clickable', !!onTitle);
  t.onclick = onTitle;
  const b = $('#back');
  b.hidden = !back;
  // logo de l'app à gauche du titre sur les écrans principaux (sans bouton retour)
  const tl = $('#top-logo'); if (tl) { tl.hidden = !!back; if (!back && tl.getAttribute('src') !== BRAND.logo) tl.src = BRAND.logo; }
  b.onclick = () => { if (back === true) history.back(); else location.hash = back; };
  const ta = $('#top-actions');
  ta.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = 'icon-btn' + (a.txt ? ' txt' : '');
    btn.innerHTML = a.icon ? ic(a.icon, 24) : esc(a.label); btn.setAttribute('aria-label', a.aria || a.label || a.icon);
    btn.onclick = a.onClick;
    ta.appendChild(btn);
  }
}
const helpAction = { icon: 'help', aria: 'Barème', onClick: () => showScale() };
function showScale() {
  openSheet(`<h3>Barème de notation</h3>
    ${SCALE.map(s => `<div class="scale-row"><b>${s.v}</b><div>${esc(s.fr)}<div class="muted small">${esc(s.en)}</div></div></div>`).join('')}
    <div class="scale-row"><b style="font-size:16px">N/A</b><div>Non applicable — exclu du total et du maximum</div></div>
    <h3 style="margin-top:16px">Appréciation</h3>
    ${RATINGS.map(r => `<div class="row" style="margin:6px 0"><span class="badge ${TN[r.name]}" style="min-width:130px">${rName(r)}</span><span>${esc(RANGE_FR[r.name] || r.range)}</span></div>`).join('')}
    <p class="muted small">Un thème entièrement N/A est exclu de la moyenne globale. Overall = moyenne des thèmes notés + Bonus/100 − Pénalité/100, borné 0–100 %.</p>
    <button class="btn block primary" data-close>Fermer</button>`);
}

const TN = { Excellent: 'tn-ex', Good: 'tn-good', Satisfactory: 'tn-sat', Weak: 'tn-weak', Unacceptable: 'tn-bad' };
/** classe de ton doux (pastilles) selon le score — v4 */
const tnCls = pct => pct === null || pct === undefined ? 'tn-na' : (TN[rating(pct).name] || 'tn-na');
const badge = pct => `<span class="badge ${tnCls(pct)}">${pct === null ? 'N/A' : Math.round(pct * 100) + '%'}</span>`;
const rName = r => RATING_FR[r.name] || r.name; // libellé affiché dans l'app (le PDF anglais garde l'anglais)
const ratingChip = pct => `<span class="chip ${tnCls(pct)}">${rName(rating(pct))}</span>`;
/** Texte lisible sur une couleur d'entreprise : foncé sur les couleurs claires (jaune, orange clair…), blanc sinon */
const inkOn = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); if (!m) return '#fff';
  const n = parseInt(m[1], 16), lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255);
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#111827' : '#fff';
};
/** couleur de note utilisée comme TEXTE sur fond clair : jaune et orange foncés pour rester lisibles */
const textTone = c => ({ '#FBC02D': '#8A6100', '#EF6C00': '#B45309' })[c] || c;
/** pose --on (couleur du texte) sur tout élément coloré par une entreprise (--c) */
function inkEl(el) {
  const c = el.style?.getPropertyValue('--c'); if (!c) return;
  const strong = inkStrong(c);
  el.style.setProperty('--on', strong ? '#fff' : inkOn(c));
  if (strong) el.style.setProperty('--cbg', strong); else el.style.removeProperty('--cbg');
}
function applyInk(root) {
  if (root.style) inkEl(root);
  root.querySelectorAll?.('[style*="--c"]').forEach(inkEl);
  // champs sans étiquette : nom lu par VoiceOver = texte d'exemple
  const FIELDS = 'input:not([type=hidden]):not([type=file]), select, textarea';
  [...(root.matches?.(FIELDS) ? [root] : []), ...(root.querySelectorAll?.(FIELDS) || [])].forEach(labelField);
}
/** champ sans étiquette : nom lu par VoiceOver = étiquette visible voisine ou texte d'exemple */
function labelField(el) {
  if (el.getAttribute('aria-label') || el.labels?.length || el.getAttribute('aria-labelledby')) return;
  const prev = el.previousElementSibling, near = prev && /^(LABEL|SPAN|B|SMALL|H3|H4|P)$/.test(prev.tagName) && prev.textContent.trim().length < 60 ? prev.textContent : '';
  const t = near || el.getAttribute('placeholder') || el.getAttribute('title') || (el.tagName === 'SELECT' ? el.options[0]?.textContent : '');
  if (t) el.setAttribute('aria-label', t.replace(/[…:*]+\s*$/, '').trim());
}
/** couleur intermédiaire (ni texte noir ni blanc à 4,5:1) → fond assombri pour un texte blanc lisible */
function inkStrong(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); if (!m) return null;
  let [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  const lum = (r, g, b) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const L = lum(r, g, b);
  if (Math.max(1.05 / (L + 0.05), (L + 0.05) / (0.0137 + 0.05)) >= 4.5) return null;
  for (let k = 0; k < 20 && 1.05 / (lum(r, g, b) + 0.05) < 4.6; k++) { r *= 0.93; g *= 0.93; b *= 0.93; }
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}
const subChip = s => s ? `<span class="chip sub" title="${esc(s.name || '')}" style="background:${esc(inkStrong(s.color || '#1A56A8') || s.color || '#1A56A8')};color:${inkStrong(s.color || '#1A56A8') ? '#fff' : inkOn(s.color || '#1A56A8')}">${esc(s.name || 'Sans nom')}</span>` : '<span class="chip" style="background:#9E9E9E">—</span>';

/** Sauvegarde complète (JSON) : à garder hors du téléphone (mail, OneDrive…) */
async function backupNow() {
  toast('Préparation de la sauvegarde…');
  const json = await db.exportAll();
  await db.setMeta('lastBackup', new Date().toISOString());
  readySheet(new File([JSON.stringify(json)], `PRT-HSE-sauvegarde-${todayISO()}.json`, { type: 'application/json' }));
}
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
/** Bandeaux de l'accueil : installer l'app (sinon l'iPhone peut effacer les données), sauvegarder (mode sans compte) */
async function homeNotices(nAudits) {
  const out = [], now = Date.now();
  const snooze = await db.getMeta('noticeSnooze', {});
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!isStandalone() && !(snooze.install > now) && (ios || installEvt)) out.push(`<div class="card notice" data-notice="install"><span class="notice-ic">${ic('download', 20)}</span>
    <span class="grow"><b>Installez l’app sur l’écran d’accueil</b><span class="muted small">${ios ? 'Touchez Partager ⬆︎ puis « Sur l’écran d’accueil ». ' : ''}Elle s’ouvre plus vite, en plein écran, et vos audits restent protégés.</span></span>
    ${installEvt ? '<button class="btn primary small-btn" data-inst>Installer</button>' : ''}<button class="notice-x" data-snooze="install" aria-label="Plus tard">${ic('x', 18)}</button></div>`);
  if (!cloud.enabled && nAudits) {
    const last = await db.getMeta('lastBackup');
    const days = last ? Math.floor((now - new Date(last)) / 864e5) : null;
    if ((days === null || days >= 7) && !(snooze.backup > now)) out.push(`<div class="card notice warn" data-notice="backup"><span class="notice-ic">${ic('alert', 20)}</span>
      <span class="grow"><b>${days === null ? 'Aucune sauvegarde pour le moment' : `Dernière sauvegarde il y a ${days} jours`}</b><span class="muted small">Vos audits ne sont que dans ce téléphone. Une sauvegarde par semaine suffit.</span></span>
      <button class="btn primary small-btn" data-bk>Sauvegarder</button><button class="notice-x" data-snooze="backup" aria-label="Plus tard">${ic('x', 18)}</button></div>`);
  }
  return out.join('');
}
function bindNotices() {
  view.querySelectorAll('[data-snooze]').forEach(b => b.onclick = async () => {
    const sn = await db.getMeta('noticeSnooze', {}); sn[b.dataset.snooze] = Date.now() + (b.dataset.snooze === 'install' ? 7 : 3) * 864e5;
    await db.setMeta('noticeSnooze', sn); b.closest('.notice').remove();
  });
  view.querySelector('[data-bk]')?.addEventListener('click', async e => { await backupNow(); e.target.closest('.notice')?.remove(); });
  view.querySelector('[data-inst]')?.addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); const r = await installEvt.userChoice.catch(() => null); installEvt = null; if (r?.outcome === 'accepted') view.querySelector('[data-notice=install]')?.remove(); });
}
async function getSettings() { return await db.getMeta('settings', { inspector: '', site: SEED_SITE, theme: 'auto' }); }
async function saveSettings(s) { await db.setMeta('settings', s); }
function applyTheme(t) {
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]').content = '#0B2D5B';
}

// ---------- projets (chantiers) ----------
const DEFAULT_PROJECT = 'proj-sam2a';
let PROJECT = null; // projet courant
const pid = r => r?.projectId || DEFAULT_PROJECT;
const inProject = r => !PROJECT || pid(r) === PROJECT.id;
async function allowedProjects() {
  return (await db.all('projects')).filter(p => !p.archived && cloud.canProject(p.id)).sort((a, b) => a.name.localeCompare(b.name));
}
/** Barre de recherche automatique au-dessus de toute liste d'entreprises à choisir (dès 6 entreprises) */
function addPickSearch(g) {
  g.dataset.srch = '1';
  const items = () => g.querySelectorAll('.pick, .check-item');
  if (items().length < 6) return;
  const w = document.createElement('div');
  w.className = 'pick-search';
  w.innerHTML = `${ic('search', 18)}<input class="in" type="search" placeholder="Rechercher une entreprise…" autocomplete="off" enterkeyhint="search">`;
  g.before(w);
  const inp = w.querySelector('input');
  inp.addEventListener('input', () => {
    const q = hseKey(inp.value);
    // les entreprises déjà choisies restent visibles
    items().forEach(b => { b.hidden = !!q && !hseKey(b.textContent).includes(q) && !b.classList.contains('on') && !b.querySelector('input:checked'); });
  });
}
new MutationObserver(() => document.querySelectorAll('.pick-grid:not([data-srch]), .check-grid:not([data-srch])').forEach(addPickSearch))
  .observe(document.body, { childList: true, subtree: true });

/** Nom et logo de l'app (réglables par l'administrateur dans Réglages → Apparence) */
const BRAND = { name: 'Audit HSE', logo: 'icons/icon-192.png' };
async function applyBrand() {
  const cache = await db.getMeta('brand', null);
  const name = (PROJECT?.appName || cache?.name || '').trim() || 'Audit HSE';
  const logoId = PROJECT ? PROJECT.appLogoId : cache?.logoId;
  let logo = 'icons/icon-192.png';
  if (logoId && logoId === BRAND.logoId) logo = BRAND.logo; // déjà lu
  else if (logoId) { const b = await db.getBlob(logoId).catch(() => null); if (b) logo = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); }); }
  if (name === BRAND.name && (logoId || null) === (BRAND.logoId || null) && BRAND.applied) return;
  BRAND.name = name; BRAND.logo = logo; BRAND.logoId = logoId || null; BRAND.applied = true;
  if (PROJECT && (cache?.name !== name || cache?.logoId !== (logoId || null))) await db.setMeta('brand', { name, logoId: logoId || null });
  document.title = name;
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', name);
  // icône proposée lors de « Sur l'écran d'accueil » (les icônes déjà installées ne changent pas)
  document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', logoId ? logo : 'icons/apple-touch-icon.png');
  const bi = document.getElementById('brand-img'), bn = document.getElementById('brand-name');
  if (bi) bi.src = logo; if (bn) bn.textContent = name;
  const tl = document.getElementById('top-logo'); if (tl) tl.src = logo;
}
async function loadProject() {
  const list = await allowedProjects();
  const id = await db.getMeta('project');
  PROJECT = list.find(p => p.id === id) || list[0] || null;
  if (PROJECT && PROJECT.id !== id) await db.setMeta('project', PROJECT.id);
  return PROJECT;
}
/** Enregistrements du projet courant uniquement */
async function pAll(store) {
  const l = (await db.all(store)).filter(inProject);
  // HSE : ses propres actions seulement (celles des autres, s'il a le droit, ne s'affichent que sur l'audit d'une entreprise)
  return store === 'actions' && cloud.enabled && !cloud.isAdmin() ? l.filter(a => !a.owner || a.owner === cloud.uid()) : l;
}
const isMine = r => !cloud.enabled || cloud.isAdmin() || !r.owner || r.owner === cloud.uid();
/** Actions encore ouvertes des autres HSE sur cette entreprise (droit « actions des autres ») */
async function teamOpenActions(subId) {
  if (!cloud.can('teamActions') || !subId) return [];
  return (await db.all('actions')).filter(a => inProject(a) && !isMine(a) && a.subId === subId && a.status !== 'Closed' && !a.deleted).sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
}
async function switchProject(id) {
  await db.setMeta('project', id); await loadProject();
  const plans = await pAll('plans');
  if (plans[0]) await db.setMeta('lastPlan', plans[0].id);
  toast('Projet : ' + PROJECT.name); location.hash = '#/'; render();
}
async function projectSheet() {
  const [list, insps] = await Promise.all([allowedProjects(), db.all('inspections')]);
  openSheet(`<h3>Changer de projet</h3>
    <div class="proj-list">${list.map(p => {
      const n = insps.filter(i => pid(i) === p.id).length;
      return `<button class="proj-item ${p.id === PROJECT?.id ? 'on' : ''}" data-p="${p.id}">
        <span class="mono" style="--c:${esc(p.color || '#0B2D5B')}">${esc((p.code || p.name).replace(/\s/g, '').slice(0, 5).toUpperCase())}</span>
        <span class="grow"><b>${esc(p.name)}</b><span class="muted small">${esc(p.site || '')}${p.site ? ' · ' : ''}${n} audit${n > 1 ? 's' : ''}</span></span>
        ${p.id === PROJECT?.id ? ic('check') : ''}</button>`;
    }).join('')}</div>
    ${cloud.isAdmin() ? `<a class="btn block" href="#/projects" data-close style="margin-top:10px">${ic('edit')} Gérer les projets</a>` : ''}
    <button class="btn block" data-close style="margin-top:8px">Fermer</button>`,
  (el, close) => el.addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) { close(); if (b.dataset.p !== PROJECT?.id) switchProject(b.dataset.p); } }));
}

/** Installations existantes : tout est rattaché au projet par défaut */
async function migrateProjects() {
  if (await db.getMeta('projects-v1')) return;
  if (!(await db.get('projects', DEFAULT_PROJECT))) {
    const subs = (await db.all('subs')).filter(s => (s.name || '').trim());
    await db.put('projects', { id: DEFAULT_PROJECT, name: SEED_PROJECT?.name || 'Mon chantier', code: SEED_PROJECT?.code || 'CHANTIER', site: SEED_PROJECT?.site || '', color: '#0B2D5B', companyIds: subs.map(s => s.id), archived: false });
  }
  for (const store of ['plans', 'inspections', 'actions']) {
    for (const r of await db.all(store, { includeDeleted: true })) if (!r.projectId) await db.putRaw(store, { ...r, projectId: DEFAULT_PROJECT });
  }
  for (const sub of await db.all('subs')) {
    const seedSub = SEED_SUBS.find(x => x.name.toLowerCase() === (sub.name || '').toLowerCase());
    if (!sub.type) await db.put('subs', { ...sub, type: seedSub?.type || 'entreprise' });
  }
  await db.setMeta('projects-v1', true);
}

async function maps() {
  const [subs, plans] = await Promise.all([db.all('subs', { includeDeleted: true }), db.all('plans')]);
  const named = subs.filter(s => !s.deleted && (s.name || '').trim());
  const inProj = s => !PROJECT || !Array.isArray(PROJECT.companyIds) || PROJECT.companyIds.includes(s.id);
  const projPlans = plans.filter(inProject);
  return { subs: Object.fromEntries(subs.map(s => [s.id, s])), subList: named.filter(inProj), allSubs: named,
    plans: Object.fromEntries(plans.map(p => [p.id, p])), planList: projPlans };
}

async function nextRef(plan, sub, date) {
  const clean = (t, n) => (t || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, n);
  const site = clean(PROJECT?.code || plan?.code || plan?.name, 10) || 'SITE';
  const ini = cloud.enabled ? '-' + clean((cloud.myName() || 'X').split(/[\s.@_-]+/).filter(Boolean).map(w => w[0]).join(''), 3) : '';
  const base = `PRT-${site}-${clean(sub?.name, 12) || 'SUB'}-${date || todayISO()}${ini}`;
  const all = await db.all('inspections', { includeDeleted: true });
  let ref = base, n = 1;
  while (all.some(i => i.ref === ref)) ref = `${base}-${++n}`;
  return ref;
}

async function createAction(insp, { critRef = '', observation = '', priority = 'Medium', subId, planId, pin } = {}) {
  let p = pin ?? null;
  if (!p && insp?.pin) {
    const n = (await db.byIndex('actions', 'inspectionId', insp.id)).length + 1;
    const ang = n * 2.4, r = 0.03;
    p = { x: clamp01(insp.pin.x + Math.cos(ang) * r), y: clamp01(insp.pin.y + Math.sin(ang) * r) };
  }
  const sid = subId !== undefined ? subId : (subIdsOf(insp).length === 1 ? subIdsOf(insp)[0] : null);
  const sub = sid ? await db.get('subs', sid) : null;
  return db.put('actions', {
    owner: insp?.owner || cloud.uid(), projectId: insp?.projectId || PROJECT?.id || DEFAULT_PROJECT,
    inspectionId: insp?.id || null, inspectionRef: insp?.ref || '', subId: sid || null, planId: planId ?? insp?.planId ?? null, pin: p,
    critRef, observation, priority, corrective: '', responsibility: sub?.contact || sub?.name || '',
    dueDate: todayISO(DUE_BY_PRIO[priority] ?? 7), status: 'Open', photos: [],
  });
}

// ---------- photos (commun critères / actions) ----------
async function thumbsHTML(ids = []) {
  const urls = await Promise.all(ids.map(id => db.blobURL(id)));
  return urls.map((u, i) => u ? `<img src="${u}" data-photo="${ids[i]}" alt="photo">` : '').join('');
}
/** Visionneuse plein écran : double-tap pour zoomer ; Annoter / Supprimer selon les droits */
function photoViewer(id, onDelete, onReplace) {
  db.blobURL(id).then(u => {
    document.querySelector('.pviewer')?.remove();
    const el = document.createElement('div');
    el.className = 'pviewer';
    el.innerHTML = `<div class="pv-top"><button type="button" class="pv-x" aria-label="Fermer">${ic('x', 26)}</button></div>
      <div class="pv-scroll"><img src="${u}" alt="photo"></div>
      <div class="pv-bar">${onReplace ? `<button type="button" class="btn" data-ann>${ic('edit', 18)} Annoter</button>` : ''}${onDelete ? `<button type="button" class="btn danger" data-del>${ic('trash', 18)} Supprimer</button>` : ''}${onReplace || onDelete ? '' : '<button type="button" class="btn primary" data-x>Fermer</button>'}</div>
      <p class="pv-hint">Touchez deux fois la photo pour zoomer</p>`;
    document.body.appendChild(el);
    const close = () => { el.remove(); window.removeEventListener('hashchange', close); };
    window.addEventListener('hashchange', close);
    el.querySelector('.pv-x').onclick = close; el.querySelector('[data-x]')?.addEventListener('click', close);
    let lastTap = 0;
    el.querySelector('.pv-scroll').addEventListener('click', e => {
      const now = Date.now(); if (now - lastTap < 320) { const sc = el.querySelector('.pv-scroll'); const z = !sc.classList.contains('zoomed'); sc.classList.toggle('zoomed', z);
        if (z) { const r = sc.getBoundingClientRect(); sc.scrollLeft = (e.clientX - r.left) * 1.2; sc.scrollTop = (e.clientY - r.top) * 1.2; } }
      lastTap = now;
    });
    el.querySelector('[data-del]')?.addEventListener('click', async () => { if (await confirmBox('Supprimer la photo ?', '')) { close(); onDelete(); } });
    el.querySelector('[data-ann]')?.addEventListener('click', async () => { close(); const nid = await annotatePhoto(id); if (nid) { await onReplace(nid); toast('Photo annotée'); } });
  });
}

/** Annotation d'une photo (flèche, cercle, trait, texte). Renvoie l'id de la nouvelle photo, ou null. */
function annotatePhoto(id) {
  return new Promise(async resolve => {
    const url = await db.blobURL(id);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }).catch(() => null);
    if (!img) { toast('Photo introuvable'); return resolve(null); }
    const k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.round(img.naturalWidth * k), H = Math.round(img.naturalHeight * k);
    const COLORS = [['#E53935', 'Rouge'], ['#FFD600', 'Jaune'], ['#FFFFFF', 'Blanc']];
    const TOOLS = [['arrow', 'Flèche', '<path d="M5 19 19 5M9 5h10v10"/>'], ['circle', 'Cercle', '<circle cx="12" cy="12" r="8"/>'], ['free', 'Trait', '<path d="M4 16c3-6 6 2 9-4s5-4 7-2"/>'], ['text', 'Texte', '<path d="M5 6h14M12 6v13"/>']];
    let tool = 'arrow', color = COLORS[0][0];
    const shapes = []; let cur = null;
    const lw = Math.max(5, W / 160), fs = Math.max(26, W / 20);
    const el = document.createElement('div');
    el.className = 'annot';
    el.innerHTML = `<div class="an-top">
        <div class="an-tools">${TOOLS.map(([t, l, p]) => `<button type="button" data-tool="${t}" class="${t === tool ? 'on' : ''}"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${p}</svg><span>${l}</span></button>`).join('')}</div>
        <div class="an-colors">${COLORS.map(([c, l]) => `<button type="button" data-col="${c}" class="${c === color ? 'on' : ''}" style="--sw:${c}" aria-label="${l}"></button>`).join('')}<button type="button" class="an-undo" data-undo aria-label="Annuler le dernier trait">${ic('back', 18)}<span>Retour</span></button></div>
      </div>
      <div class="an-stage"><canvas width="${W}" height="${H}"></canvas></div>
      <div class="an-bar"><button type="button" class="btn" data-cancel>Annuler</button><button type="button" class="btn primary" data-save>${ic('check', 18)} Enregistrer</button></div>`;
    document.body.appendChild(el);
    const cv = el.querySelector('canvas'), g = cv.getContext('2d');
    const arrow = (a, b, c) => {
      const ang = Math.atan2(b.y - a.y, b.x - a.x), h = lw * 4.2;
      g.strokeStyle = c; g.lineWidth = lw; g.lineCap = 'round';
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      g.beginPath(); g.moveTo(b.x, b.y); g.lineTo(b.x - h * Math.cos(ang - 0.45), b.y - h * Math.sin(ang - 0.45));
      g.lineTo(b.x - h * Math.cos(ang + 0.45), b.y - h * Math.sin(ang + 0.45)); g.closePath(); g.fillStyle = c; g.fill();
    };
    const drawShape = s => {
      g.save(); g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = lw * 1.2;
      if (s.type === 'arrow') arrow(s.a, s.b, s.color);
      if (s.type === 'circle') { g.strokeStyle = s.color; g.lineWidth = lw; g.beginPath(); g.ellipse((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, Math.abs(s.b.x - s.a.x) / 2 || 1, Math.abs(s.b.y - s.a.y) / 2 || 1, 0, 0, Math.PI * 2); g.stroke(); }
      if (s.type === 'free') { g.strokeStyle = s.color; g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath(); s.pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.stroke(); }
      if (s.type === 'text') {
        g.shadowBlur = 0; g.font = `bold ${fs}px -apple-system, Segoe UI, Roboto, sans-serif`; const w = g.measureText(s.text).width, pad = fs * 0.3;
        g.fillStyle = 'rgba(0,0,0,.72)'; g.beginPath(); g.roundRect?.(s.a.x - pad, s.a.y - fs - pad * 0.6, w + pad * 2, fs + pad * 1.6, pad) ?? g.rect(s.a.x - pad, s.a.y - fs - pad * 0.6, w + pad * 2, fs + pad * 1.6); g.fill();
        g.fillStyle = s.color; g.fillText(s.text, s.a.x, s.a.y);
      }
      g.restore();
    };
    const render = () => { g.drawImage(img, 0, 0, W, H); shapes.forEach(drawShape); if (cur) drawShape(cur); };
    render();
    const pt = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height }; };
    cv.addEventListener('pointerdown', e => {
      e.preventDefault(); cv.setPointerCapture(e.pointerId);
      const p = pt(e);
      if (tool === 'text') {
        openSheet(`<h3>Texte sur la photo</h3><input class="in" id="ant" placeholder="ex. Garde-corps manquant" autocomplete="off"><div class="btns" style="margin-top:12px"><button class="btn" data-close>Annuler</button><button class="btn primary" id="anok">Ajouter</button></div>`,
          (sh, close) => { setTimeout(() => sh.querySelector('#ant').focus(), 50); sh.querySelector('#anok').onclick = () => { const t = sh.querySelector('#ant').value.trim(); if (t) { shapes.push({ type: 'text', a: p, text: t, color }); render(); } close(); }; });
        return;
      }
      cur = tool === 'free' ? { type: 'free', pts: [p], color } : { type: tool, a: p, b: p, color };
    });
    cv.addEventListener('pointermove', e => { if (!cur) return; const p = pt(e); if (cur.type === 'free') cur.pts.push(p); else cur.b = p; render(); });
    const up = () => { if (!cur) return; const s = cur; cur = null; const big = s.type === 'free' ? s.pts.length > 2 : Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) > lw * 2; if (big) shapes.push(s); render(); };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    el.querySelector('.an-tools').onclick = e => { const b = e.target.closest('[data-tool]'); if (!b) return; tool = b.dataset.tool; el.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x === b)); };
    el.querySelector('.an-colors').onclick = e => {
      if (e.target.closest('[data-undo]')) { shapes.pop(); render(); return; }
      const b = e.target.closest('[data-col]'); if (!b) return; color = b.dataset.col; el.querySelectorAll('[data-col]').forEach(x => x.classList.toggle('on', x === b));
    };
    const done = v => { el.remove(); resolve(v); };
    el.querySelector('[data-cancel]').onclick = () => done(null);
    el.querySelector('[data-save]').onclick = async () => {
      if (!shapes.length) return done(null);
      render();
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.86));
      done(await db.putBlob(blob));
    };
  });
}
async function addPhotos(fileList) {
  const ids = [];
  for (const f of fileList) { const b = await compressImage(f); ids.push(await db.putBlob(b)); }
  return ids;
}

// =====================================================================
// ÉCRANS
// =====================================================================

/** « Reprendre l'audit » : le dernier audit ouvert sur ce téléphone depuis moins de 12 h, s'il n'est pas terminé */
async function resumeCard(subs) {
  const last = await db.getMeta('lastInsp').catch(() => null);
  if (!last?.id || Date.now() - last.at > 12 * 3600e3) return '';
  const i = await db.get('inspections', last.id);
  if (!i || i.deleted || isLocked(i)) return '';
  const { n, st } = auditState(i);
  if (st === 'done') return '';
  const zoneTxt = i.zone ? `Zone ${esc(i.zone)}` : '';
  const what = subIdsOf(i).length ? esc(auditLabel(i, subs)) : (zoneTxt || 'Audit de zone');
  const meta = [subIdsOf(i).length ? zoneTxt : '', `${n}/124`].filter(Boolean).join(' · ');
  const th = last.ref && THEMES.find(t => t.ref === last.ref);
  const pc = Math.round(n / 124 * 100);
  return `<a class="resume-card" href="#/insp/${i.id}${th ? '/t/' + th.ref : ''}"><span class="mini-ring" style="--p:${pc}" aria-hidden="true"><span>${pc}%</span></span><span><b>Reprendre l’audit en cours</b><small>${what} · ${meta}${th ? ` · thème ${th.ref.split('.')[0]}` : ''}</small></span>${ic('chevron', 20)}</a>`;
}
/** « Pouls du chantier » : score moyen 30 j, tendance, courbe des 8 dernières semaines */
function pulseCard(insps, month, avgPct, nLate, nOpen) {
  const DAY = 864e5, now = Date.now();
  const pctOf = i => overallScore(i.scores, i.bonus, i.penalty).pct;
  const avg = l => { const v = l.map(pctOf).filter(x => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const from = d => new Date(now - d * DAY).toISOString().slice(0, 10);
  const prev = avg(insps.filter(i => i.date >= from(60) && i.date < from(30)));
  const delta = avgPct !== null && prev !== null ? Math.round((avgPct - prev) * 100) : null;
  const weeks = Array.from({ length: 8 }, (_, k) => avg(insps.filter(i => i.date >= from((8 - k) * 7) && i.date < from((7 - k) * 7))));
  const vals = weeks.filter(v => v !== null), mid = vals.length ? (Math.min(...vals) + Math.max(...vals)) / 2 : 0.75;
  const span = Math.max(0.12, vals.length ? Math.max(...vals) - Math.min(...vals) : 0) * 1.25;
  const pts = weeks.map((v, k) => v === null ? null : [k * (116 / 7) + 2, 24 - ((v - mid) / span) * 36]).filter(Boolean);
  const line = pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  const last = pts[pts.length - 1];
  const spark = pts.length > 1 ? `<svg class="pl-spark" viewBox="0 0 120 44" aria-hidden="true"><defs><linearGradient id="plg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFC20E" stop-opacity=".32"/><stop offset="1" stop-color="#FFC20E" stop-opacity="0"/></linearGradient></defs><polygon points="${pts[0][0].toFixed(1)},44 ${line} ${last[0].toFixed(1)},44" fill="url(#plg)"/><polyline points="${line}" class="pl-line"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" class="pl-dot"/></svg>` : '';
  const trend = delta === null ? '' : `<span class="pl-trend ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${delta === 0 ? 'Stable' : `${delta > 0 ? '▲ +' : '▼ '}${delta} pt${Math.abs(delta) > 1 ? 's' : ''}`}</span>`;
  return `<section class="pulse">
    <a class="pl-main" href="${cloud.isAdmin() ? '#/stats' : '#/audits'}">
      <span class="pl-top"><span>Score moyen du chantier · 30 jours</span>${trend}</span>
      <span class="pl-row"><b>${avgPct === null ? '—' : Math.round(avgPct * 100)}${avgPct === null ? '' : '<small> %</small>'}</b>${spark}</span>
    </a>
    <div class="pl-foot"><a href="#/audits"><b>${month.length}</b> audit${month.length > 1 ? 's' : ''}</a><a href="#/actions"><b>${nOpen}</b> action${nOpen > 1 ? 's' : ''} ouverte${nOpen > 1 ? 's' : ''}</a><a href="#/actions?late=1" class="${nLate ? 'late' : 'ok'}">${nLate ? `<b>${nLate}</b> en retard` : 'Rien en retard'}</a></div>
  </section>`;
}
/** prénom de la personne connectée (ou de l'inspecteur réglé), pour lui parler simplement */
async function firstName() {
  const raw = cloud.enabled ? cloud.myName() : (await getSettings()).inspector;
  const w = String(raw || '').split('@')[0].split(/[\s._-]+/).filter(Boolean)[0] || '';
  return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '';
}
async function vHome() {
  setTop({ title: PROJECT?.name || 'Inspections HSE', sub: 'Inspections HSE · changer de projet', onTitle: projectSheet, actions: [{ icon: 'gear', aria: 'Réglages', onClick: () => location.hash = '#/settings' }] });
  const [{ subs, subList }, insps, acts] = await Promise.all([maps(), pAll('inspections'), pAll('actions')]);
  const recent = [...insps].sort((a, b) => (b.date + b.updatedAt).localeCompare(a.date + a.updatedAt)).slice(0, 4);
  const late = acts.filter(isLate).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const today = new Date().toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' });
  // bandeau de tête (écran large) : projet, photo du chantier, chiffres clés
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const month = insps.filter(i => i.date >= since);
  const pcts = month.map(i => overallScore(i.scores, i.bonus, i.penalty).pct).filter(x => x !== null);
  const avgPct = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
  const openActs = acts.filter(a => a.status !== 'Closed').length;
  const notices = await homeNotices(insps.length);
  const resume = cloud.can('audit') ? await resumeCard(subs) : '';
  const fn = await firstName();
  const hello = new Date().getHours() >= 18 ? 'Bonsoir' : 'Bonjour';
  const nActive = subList.filter(s => !s.archived).length;
  view.classList.add('v-home');
  view.innerHTML = `
    ${cloud.enabled ? '<button class="sync-pill" id="sync-now" hidden></button>' : ''}
    <section class="greet"><small>${esc(today.charAt(0).toUpperCase() + today.slice(1))}</small><h1>${hello}${fn ? ' ' + esc(fn) : ''}</h1></section>
    ${notices}
    <section class="home-hero">
      <div class="hero-id">
        <img class="hero-logo" id="hero-logo" src="icons/icon-192.png" alt="">
        <div><span class="hero-kicker">${esc(today)}</span><h2>${esc(PROJECT?.name || 'Inspections HSE')}</h2><span class="hero-site">${esc([PROJECT?.site, 'Inspections HSE des entreprises'].filter(Boolean).join(' · '))}</span></div>
      </div>
      <div class="hero-kpis">
        <a href="#/audits"><b>${month.length}</b><span>audits · 30 jours</span></a>
        <a href="#/stats"><b style="color:${avgPct === null ? '#fff' : rating(avgPct).color}">${avgPct === null ? '—' : Math.round(avgPct * 100) + ' %'}</b><span>score moyen</span></a>
        <a href="#/actions"><b>${openActs}</b><span>actions ouvertes</span></a>
        <a href="#/actions?late=1" class="${late.length ? 'warn' : ''}"><b>${late.length}</b><span>en retard</span></a>
      </div>
      ${cloud.can('audit') ? `<a class="hero-cta" href="#/start">${ic('plus')} Nouvel audit</a>` : ''}
    </section>
    ${resume}
    ${cloud.can('audit') ? `<a class="btn primary big new-audit" href="#/start">${ic('plus')}<span>Nouvel audit<small>zone, une ou plusieurs entreprises</small></span></a>` : ''}
    ${pulseCard(insps, month, avgPct, late.length, openActs)}
    <div class="home-cols"><div class="home-main">
    <div class="section-head"><span>Audit rapide</span>${nActive ? `<span class="muted small">${nActive} entreprise${nActive > 1 ? 's' : ''}</span>` : ''}</div>
    ${cloud.can('audit') ? (subList.some(s => !s.archived) ? subGrid(subList, insps, acts) : noCompanyCard()) : '<div class="card muted">Votre accès ne permet pas de lancer des audits. Contactez l’administrateur HSE.</div>'}
    </div><div class="home-side">
    ${late.length ? `<div class="section-head late"><span class="row" style="gap:6px">${ic('alert', 18)} Actions en retard</span><span>${late.length}</span></div>
      ${late.slice(0, 3).map(a => actionCard(a, subs)).join('')}
      ${late.length > 3 ? `<a class="btn block" href="#/actions?late=1">Voir les ${late.length} actions en retard</a>` : ''}` : ''}
    <div class="section-head"><span>${cloud.enabled && cloud.isAdmin() ? 'Audits de l’équipe' : cloud.enabled ? 'Mes audits' : 'Inspections récentes'}</span>${insps.length ? `<span class="muted small">${insps.length} au total</span>` : ''}</div>
    ${inspList(recent, subs) || '<div class="empty">Aucune inspection pour l’instant.<br>Touchez une entreprise pour commencer.</div>'}
    </div></div>`;
  // photo du chantier (plan) en fond du bandeau, logo du projet s'il existe
  (async () => {
    const plan = (await maps()).planList[0];
    const hero = view.querySelector('.home-hero');
    if (plan?.blobId && hero) hero.style.setProperty('--hero-img', `url("${await db.blobURL(plan.blobId)}")`);
    $('#hero-logo').src = BRAND.logo;
  })();
  bindSubGrid();
  if ($('#kit-in')) $('#kit-in').onchange = e => restoreFile(e.target.files[0], true);
  bindNotices();
  $('#pick-comp')?.addEventListener('click', pickProjectCompanies);
  drawSync();
  $('#sync-now')?.addEventListener('click', () => cloud.sync());
}

/** Projet encore sans entreprise : on explique et on propose de les choisir tout de suite */
function noCompanyCard() {
  return `<div class="card empty-proj"><b>Aucune entreprise dans ${esc(PROJECT?.name || 'ce projet')}</b>
    <p class="muted small">${cloud.isAdmin() ? 'Choisissez dans l’annuaire les entreprises qui travaillent sur ce projet.' : 'L’administrateur HSE doit d’abord ajouter les entreprises de ce projet.'}</p>
    ${cloud.isAdmin() ? `<button class="btn primary block" id="pick-comp">${ic('plus')} Ajouter des entreprises</button>` : ''}
    ${cloud.enabled ? '' : `<label class="btn block" style="margin-top:10px">${ic('upload')} Importer un kit de démarrage<input type="file" accept="application/json,.json" class="hidden-input" id="kit-in"></label>
    <p class="muted small" style="margin:8px 0 0">Fichier .json reçu de votre responsable HSE : projet, plan et entreprises déjà prêts.</p>`}</div>`;
}
async function pickProjectCompanies() {
  const { allSubs } = await maps();
  const chosen = new Set(PROJECT.companyIds || []);
  const list = allSubs.filter(s => !s.archived).sort((a, b) => a.name.localeCompare(b.name));
  openSheet(`<h3>Entreprises de ${esc(PROJECT.name)}</h3>
    ${list.length ? `<div class="check-grid">${list.map(s => `<label class="check-item" style="--c:${esc(s.color)}"><input type="checkbox" data-comp="${s.id}" ${chosen.has(s.id) ? 'checked' : ''}><span class="mono">${esc(abbr(s.name))}</span><b>${esc(s.name)}</b></label>`).join('')}</div>` : '<p class="muted">L’annuaire est vide.</p>'}
    <div class="btns" style="margin-top:12px"><button class="btn" id="pc-new">${ic('plus')} Nouvelle entreprise</button><button class="btn primary" id="pc-ok">Valider</button></div>`,
  (el, close) => {
    el.addEventListener('change', e => { const c = e.target.dataset.comp; if (c) e.target.checked ? chosen.add(c) : chosen.delete(c); });
    el.querySelector('#pc-new').onclick = () => { close(); newSub(); };
    el.querySelector('#pc-ok').onclick = async () => {
      const p = await db.get('projects', PROJECT.id); p.companyIds = [...chosen]; await db.put('projects', p);
      close(); toast(`${chosen.size} entreprise${chosen.size > 1 ? 's' : ''} dans ${p.name}`); render();
    };
  });
}
function subGrid(subList, insps = [], acts = []) {
  const active = subList.filter(s => !s.archived).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const today = todayISO();
  return `<div class="sub-grid">${active.map(s => {
    const mine = insps.filter(i => hasSub(i, s.id)).sort((a, b) => b.date.localeCompare(a.date));
    const last = mine[0];
    const pct = last ? overallScore(last.scores, last.bonus, last.penalty).pct : null;
    const open = acts.filter(a => a.subId === s.id && a.status !== 'Closed').length;
    const late = acts.filter(a => a.subId === s.id && isLate(a)).length;
    const isToday = last?.date === today;
    const meta = isToday ? 'Audit en cours'
      : late ? `${late} action${late > 1 ? 's' : ''} en retard`
      : last ? `Dernier audit le ${dateFR(last.date).slice(0, 5)}${open ? ` · ${open} action${open > 1 ? 's' : ''}` : ''}`
      : 'Aucun audit';
    const pill = isToday ? '<span class="st-pill st-tag s-wip">En cours</span>' : last && pct !== null ? `<span class="st-pill ${tnCls(pct)}">${pct === null ? '—' : Math.round(pct * 100) + ' %'}</span>` : '';
    return `<button type="button" class="sub-tile" data-start="${s.id}" style="--c:${esc(s.color)}">
      <span class="mono">${esc(abbr(s.name))}</span>
      <span class="st-main"><b>${esc(s.name)}</b><small class="${late && !isToday ? 'late' : ''}">${s.type === 'sub' ? COMPANY_TYPES.sub.label + ' · ' : ''}${meta}</small></span>
      ${pill}${ic('chevron', 18).replace('class="ic"', 'class="ic st-chev"')}
    </button>`;
  }).join('')}</div>`;
}
function bindSubGrid() {
  view.querySelectorAll('[data-start]').forEach(b => b.onclick = () => startInspection(b.dataset.start));
}
// ---------- audits : 0, 1 ou plusieurs entreprises ----------
const subIdsOf = i => Array.isArray(i?.subIds) ? i.subIds : (i?.subId ? [i.subId] : []);
const hasSub = (i, id) => subIdsOf(i).includes(id);
/** Libellé d'un audit : « Entreprise A », « A + B », « A + 3 autres » ou « Audit de zone » */
function auditLabel(i, subs) {
  const n = subIdsOf(i).map(id => subs[id]?.name).filter(Boolean);
  if (!n.length) return i.zone ? `Zone · ${i.zone}` : 'Audit de zone';
  return n.length <= 2 ? n.join(' + ') : `${n[0]} + ${n.length - 1} autres`;
}
// une entreprise supprimée ou sans nom ne compte pas : l'audit redevient un audit de zone (pastille « ZON »)
const namedSubs = (i, subs) => subIdsOf(i).filter(id => subs[id]?.name);
const auditColor = (i, subs) => { const ids = namedSubs(i, subs); return ids.length === 1 ? (subs[ids[0]].color || '#9E9E9E') : '#0B2D5B'; };
const auditAbbr = (i, subs) => { const ids = namedSubs(i, subs); return ids.length === 1 ? abbr(subs[ids[0]].name) : ids.length ? '×' + ids.length : 'ZON'; };

// ---------- démarrage d'un audit ----------
/** Dernier audit noté de la même entreprise (avant celui-ci) — sert de repère, jamais recopié */
async function lastAudit(insp) {
  if (subIdsOf(insp).length !== 1) return null;
  const key = i => i.date + (i.createdAt || '');
  return (await pAll('inspections')).filter(i => i.id !== insp.id && subIdsOf(i).length === 1 && hasSub(i, insp.subId) && key(i) < key(insp)
    && Object.values(i.scores || {}).some(x => typeof x?.v === 'number')).sort((a, b) => key(b).localeCompare(key(a)))[0] || null;
}
async function startInspection(subId) {
  // même entreprise déjà auditée seule aujourd'hui → on reprend cet audit (pas de doublon)
  const today = (await pAll('inspections')).find(i => i.date === todayISO() && subIdsOf(i).length === 1 && hasSub(i, subId));
  if (today) { location.hash = '#/insp/' + today.id; return; }
  location.hash = '#/start/' + subId;
}
async function createInspection(subIds, pin, zone = '', visitId = null, area = null) {
  const st = await getSettings();
  const plans = await pAll('plans');
  const last = await db.getMeta('lastPlan');
  const plan = plans.find(p => p.id === last) || plans[0] || null;
  const subs = (await Promise.all(subIds.map(id => db.get('subs', id)))).filter(Boolean);
  const date = todayISO();
  const ref = await nextRef(plan, subs.length === 1 ? subs[0] : { name: subs.length ? 'MULTI' : 'ZONE' }, date);
  return db.put('inspections', { owner: cloud.uid(), visitId, subIds, subId: subIds[0] || null, planId: plan?.id || null, pin: pin || null, zone, area: area || null, inspectors: cloud.enabled ? cloud.myName() : st.inspector, date, site: PROJECT?.site ? `${PROJECT.name} — ${PROJECT.site}` : (PROJECT?.name || st.site), projectId: PROJECT?.id || DEFAULT_PROJECT, ref, scores: {}, bonus: 0, penalty: 0 });
}
/** Nouvel audit : zone sur le plan (facultative) + entreprises concernées (0, 1 ou plusieurs) */
async function vStart(subId) {
  const { subs, plans, planList, subList } = await maps();
  if (subId && !subs[subId]) return vNotFound();
  const chosen = new Set(subId ? [subId] : []);
  setTop({ title: 'Nouvel audit', sub: `${PROJECT?.name || ''} · ${dateFR(todayISO())}`, back: '#/' });
  const plan = plans[await db.getMeta('lastPlan')] || planList[0];
  const active = subList.filter(s => !s.archived).sort((a, b) => a.name.localeCompare(b.name));
  const za = { pin: null, area: null, zone: '' };
  view.innerHTML = `
    <div class="step-head"><span class="step-n">1</span><b>Où ?</b><span class="muted small">Touchez une zone, un point, ou tracez la zone (facultatif)</span></div>
    <div id="spick" class="pv start-map2"></div>
    ${plan ? '<div class="plan-tools" id="s-tools"></div>' : ''}
    <input class="in" id="s-zone" autocomplete="off" placeholder="Nom de la zone (ex. Bâtiment A, niveau 2…)" style="margin-top:8px">
    <div class="step-head"><span class="step-n">2</span><b>Quelle(s) entreprise(s) ?</b><span class="muted small" id="s-count"></span></div>
    <div class="pick-grid">${active.map(s => `<button type="button" class="pick ${chosen.has(s.id) ? 'on' : ''}" data-s="${s.id}" style="--c:${esc(s.color)}"><span class="mono xs">${esc(abbr(s.name))}</span><span class="grow">${esc(s.name)}</span>${ic('check', 16)}</button>`).join('')}</div>
    <p class="muted small" id="s-note" style="margin:8px 2px 0"></p>
    <button class="btn primary big" id="go" style="margin-top:14px">Commencer l’audit</button>`;
  const refresh = () => {
    const n = chosen.size;
    $('#s-count').textContent = n ? `${n} sélectionnée${n > 1 ? 's' : ''}` : 'aucune = audit de zone';
    $('#go').textContent = n === 0 ? 'Commencer l’audit de zone' : n === 1 ? `Commencer l’audit ${subs[[...chosen][0]].name}` : `Créer ${n} audits séparés`;
    $('#s-note').textContent = n > 1 ? `Un audit et un score par entreprise. Vous passez de l’un à l’autre en un tap.` : 'Aucune entreprise cochée = audit de la zone ou du chantier en général.';
    pv?.setPins(za.pin && !za.area ? [{ id: 'p', ...za.pin, color: n === 1 ? subs[[...chosen][0]].color : '#0B2D5B', label: n === 1 ? abbr(subs[[...chosen][0]].name) : n ? '×' + n : 'ZON', ghost: true }] : []);
  };
  zonePicker($('#s-zone'), plan);
  let pv = null;
  if (plan) {
    const kit = zoneKit({ plan, state: za, nameInput: $('#s-zone'), toolsEl: $('#s-tools'), onChange: refresh });
    pv = createPlanViewer($('#spick'), {
      imageURL: await db.blobURL(plan.blobId), pins: [], cover: 2.4, ...kit.viewerOpts,
      onTap: (x, y) => { kit.point(x, y); navigator.vibrate?.(15); },
    });
    kit.bind(pv);
    onCleanup(() => pv.destroy());
  } else $('#spick').outerHTML = '<div class="card muted small">Aucun plan pour ce projet (Réglages → Projets et plans).</div>';
  view.querySelector('.pick-grid').onclick = e => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    chosen.has(b.dataset.s) ? chosen.delete(b.dataset.s) : chosen.add(b.dataset.s);
    b.classList.toggle('on', chosen.has(b.dataset.s)); refresh();
  };
  refresh();
  $('#go').onclick = async () => {
    $('#go').disabled = true;
    const ids = [...chosen], zone = $('#s-zone').value.trim(), pin = za.pin, area = za.area ? { ...za.area, name: zone || za.area.name } : null;
    if (ids.length <= 1) { const insp = await createInspection(ids, pin, zone, null, area); location.replace('#/insp/' + insp.id); return; }
    // plusieurs entreprises → une tournée de N audits séparés (même zone, même date)
    const visitId = db.uid(); let first = null;
    for (const [k, id] of ids.entries()) {
      const p2 = pin ? { x: clamp01(pin.x + (k ? Math.cos(k * 2.1) * 0.025 : 0)), y: clamp01(pin.y + (k ? Math.sin(k * 2.1) * 0.025 : 0)) } : null;
      const insp = await createInspection([id], p2, zone, visitId, area); first ||= insp;
    }
    toast(`${ids.length} audits créés`);
    location.replace('#/insp/' + first.id); // « retour » ne recrée pas d'audit
  };
}
/**
 * Zone d'un audit sur le plan : toucher une zone du plan, toucher un point, ou tracer un rectangle.
 * state = { pin, area, zone } (area = { name, pts, zoneId? }) ; onChange() après chaque changement.
 * l'admin HSE peut ajouter la zone tracée aux zones du plan ; les autres HSE la gardent pour leur audit.
 */
function zoneKit({ plan, state, nameInput, toolsEl, onChange, color = () => '#F5C400' }) {
  let pv = null;
  // mode : '' (normal) · 'choose' (rectangle ou forme libre ?) · 'rect' · 'poly' · 'edit'
  let mode = '', nPts = 0, dead = false;
  const zones = () => (plan?.zones || []).filter(z => z.pts?.length > 2);
  // affichage : pendant le tracé ou la modification, rien d'autre ; une zone choisie = elle seule ; sinon les zones du plan, discrètes
  const areas = () => mode && mode !== 'choose' ? []
    : state.area?.pts ? [{ id: 'sel', pts: state.area.pts, kind: 'sel', label: state.area.name || state.zone || 'Zone' }]
    : zones().map(z => ({ id: z.id, pts: z.pts, kind: 'zone', label: z.name }));
  const draw = () => { pv?.setAreas(areas()); drawTools(); };
  const select = (z, focus = false) => {
    state.area = { zoneId: z.id, name: z.name, pts: z.pts }; state.zone = z.name; state.pin = centroid(z.pts);
    if (nameInput) nameInput.value = z.name;
    draw(); onChange?.('area'); if (focus) pv?.focusArea(z.pts); navigator.vibrate?.(15);
  };
  const B = (zt, icon, label, cls = '') => `<button type="button" class="btn ${cls}" data-zt="${zt}">${ic(icon, 18)} ${label}</button>`;
  const drawTools = () => {
    if (!toolsEl) return;
    toolsEl.classList.add('ztools');
    toolsEl.innerHTML =
      mode === 'choose' ? `${B('rect', 'fit', 'Rectangle')}${B('poly', 'edit', 'Forme libre')}${B('cancel', 'x', 'Annuler')}`
      : mode === 'rect' ? `<p class="zhint">Glissez le doigt sur le plan pour tracer le rectangle.</p>${B('cancel', 'x', 'Annuler')}`
      : mode === 'poly' ? `<p class="zhint">Touchez les coins de la zone un par un (${nPts} posé${nPts > 1 ? 's' : ''}). Touchez le 1er coin ou « Terminer » pour fermer.</p>
          ${B('undo', 'back', 'Retour', nPts ? '' : 'disabled')}${B('finish', 'check', 'Terminer', nPts >= 3 ? 'primary' : 'disabled')}${B('cancel', 'x', 'Annuler')}`
      : mode === 'edit' ? `<p class="zhint">Glissez un coin pour le déplacer, un point jaune pour ajouter un coin, ou l’intérieur pour déplacer toute la zone.</p>${B('done', 'check', 'Terminer', 'primary')}`
      : `${B('draw', 'edit', state.area ? 'Nouvelle zone' : 'Tracer une zone')}${state.area ? B('edit', 'fit', 'Modifier la forme') : ''}${state.area || state.pin ? B('clear', 'x', 'Effacer') : ''}`;
    toolsEl.querySelectorAll('.btn.disabled').forEach(b => { b.disabled = true; });
  };
  const setMode = m => {
    mode = m; nPts = 0;
    pv?.setDrawMode(m === 'rect' || m === 'poly', drawn, m === 'poly' ? 'poly' : 'rect', n => { nPts = n; drawTools(); });
    if (m !== 'edit') pv?.setEditArea(null);
    draw();
  };
  const drawn = pts => {
    setMode('');
    const admin = cloud.isAdmin();
    openSheet(`<h3>Nouvelle zone</h3>
      <label class="f" style="margin-top:0">Nom de la zone</label><input class="in" id="zn" value="${esc(nameInput?.value || state.zone || '')}" placeholder="ex. Bâtiment A nord, Zone 3…" autocomplete="off">
      ${admin && plan ? `<label class="row check-line" style="margin-top:12px"><input type="checkbox" id="zsave"><span>Garder cette zone sur le plan pour les prochains audits</span></label>` : ''}
      <div class="btns" style="margin-top:14px"><button class="btn" data-close>Annuler</button><button class="btn primary" id="zok">Valider</button></div>`,
    (el, close) => {
      setTimeout(() => el.querySelector('#zn').focus(), 50);
      el.querySelector('#zok').onclick = async () => {
        const name = el.querySelector('#zn').value.trim();
        let zoneId = null;
        if (admin && plan && el.querySelector('#zsave')?.checked && name) {
          zoneId = db.uid(); plan.zones = [...(plan.zones || []), { id: zoneId, name, pts }];
          await db.put('plans', plan); toast('Zone gardée sur le plan');
        }
        state.area = { zoneId, name, pts }; state.zone = name; state.pin = centroid(pts);
        if (nameInput) nameInput.value = name;
        close(); draw(); onChange?.('area');
      };
    });
  };
  toolsEl?.addEventListener('click', e => {
    const t = !dead && e.target.closest('[data-zt]:not([disabled])')?.dataset.zt; if (!t) return;
    if (t === 'draw') return setMode('choose');
    if (t === 'rect') { setMode('rect'); return toast('Glissez le doigt sur le plan', 2000); }
    if (t === 'poly') { setMode('poly'); return toast('Touchez les coins de la zone', 2000); }
    if (t === 'undo') return pv?.undoPoly();
    if (t === 'finish') return pv?.finishPoly();
    if (t === 'cancel') return setMode('');
    if (t === 'edit' && state.area?.pts) {
      setMode('edit');
      pv?.setEditArea(state.area.pts, pts => {
        // une zone du plan modifiée pour cet audit devient une zone propre à l'audit (la zone du plan ne change pas)
        state.area = { zoneId: null, name: state.area.name, pts }; state.pin = centroid(pts); onChange?.('area');
      });
      return;
    }
    if (t === 'done') { pv?.setEditArea(null); setMode(''); return; }
    if (t === 'clear') { state.area = null; state.pin = null; draw(); onChange?.('clear'); }
  });
  // nom tapé ou choisi dans la liste = zone du plan du même nom → elle s'allume sur le plan
  nameInput?.addEventListener('change', () => {
    if (dead) return;
    const v = zoneKey(nameInput.value || ''); state.zone = nameInput.value.trim();
    const z = zones().find(x => zoneKey(x.name) === v);
    if (z && state.area?.zoneId !== z.id) select(z, true);
    else if (state.area && !state.area.zoneId) { state.area.name = state.zone; draw(); onChange?.('name'); }
  });
  return {
    viewerOpts: { areas: areas(), onZoneTap: a => { if (mode) return; const z = zones().find(x => x.id === a.id); if (z) select(z); } },
    bind(v) { pv = v; draw(); if (state.area?.pts) setTimeout(() => pv.focusArea(state.area.pts), 120); },
    point(x, y) { if (mode) return; state.pin = { x, y }; state.area = null; draw(); onChange?.('pin'); },
    refresh: draw,
    dispose() { dead = true; },
  };
}
/** Ajouter une ou plusieurs entreprises à la tournée (même zone, même plan) : un audit séparé par entreprise */
async function addCompaniesToVisit(insp, siblings, subs) {
  const { subList } = await maps();
  const already = new Set(siblings.flatMap(subIdsOf).concat(subIdsOf(insp)));
  const list = subList.filter(s => !s.archived && !already.has(s.id)).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) return toast('Toutes les entreprises du projet sont déjà dans cet audit de zone');
  const chosen = new Set();
  openSheet(`<h3>Entreprises dans ${esc(insp.zone || 'cette zone')}</h3><p class="muted small" style="margin-top:-4px">Un audit et un score par entreprise.</p>
    <div class="pick-grid">${list.map(s => `<button type="button" class="pick" data-s="${s.id}" style="--c:${esc(s.color)}"><span class="mono xs">${esc(abbr(s.name))}</span><span class="grow">${esc(s.name)}</span>${ic('check', 16)}</button>`).join('')}</div>
    <button class="btn primary big" id="va-go" style="margin-top:14px" disabled>Choisissez au moins une entreprise</button>`,
  (el, close) => {
    const go = el.querySelector('#va-go');
    el.querySelector('.pick-grid').onclick = e => {
      const b = e.target.closest('[data-s]'); if (!b) return;
      chosen.has(b.dataset.s) ? chosen.delete(b.dataset.s) : chosen.add(b.dataset.s); b.classList.toggle('on', chosen.has(b.dataset.s));
      go.disabled = !chosen.size; go.textContent = chosen.size ? `Auditer ${chosen.size === 1 ? subs[[...chosen][0]].name : chosen.size + ' entreprises'}` : 'Choisissez au moins une entreprise';
    };
    go.onclick = async () => {
      go.disabled = true;
      if (!insp.visitId) { insp.visitId = db.uid(); await db.put('inspections', insp); }
      const base = insp.pin, n0 = siblings.length || 1; let first = null;
      for (const [k, sid] of [...chosen].entries()) {
        const a = (n0 + k) * 2.1, p2 = base ? { x: clamp01(base.x + Math.cos(a) * 0.025), y: clamp01(base.y + Math.sin(a) * 0.025) } : null;
        const ni = await createInspection([sid], p2, insp.zone || '', insp.visitId, insp.area ? { ...insp.area } : null);
        if (insp.planId && ni.planId !== insp.planId) { ni.planId = insp.planId; await db.put('inspections', ni); }
        first ||= ni;
      }
      close(); toast(chosen.size > 1 ? `${chosen.size} entreprises ajoutées` : 'Entreprise ajoutée');
      location.hash = '#/insp/' + first.id;
    };
  });
}
// ---------- bonnes pratiques (reconnaissance positive, en lien avec le bonus BE SAFE) ----------
/** Ajouter / modifier une bonne pratique. critRef facultatif. Renvoie l'audit mis à jour, ou null. */
function goodSheet(insp, { critRef = '', good = null, readOnly = false } = {}) {
  return new Promise(resolve => {
    const g = good ? { ...good, photos: [...(good.photos || [])] } : { id: db.uid(), critRef, text: critRef ? (insp.scores?.[critRef]?.c || '') : '', photos: [], createdAt: new Date().toISOString() };
    const crit = g.critRef ? criterionOfRef(g.critRef) : null;
    openSheet(`<h3>${ic('check', 20)} Bonne pratique</h3>
      ${crit ? `<p class="muted small" style="margin-top:-6px">${esc(g.critRef)} · ${esc(crit.name)}</p>` : ''}
      <label class="f" style="margin-top:0">Ce qui a été observé</label>
      <textarea class="in" id="gtext" rows="3" placeholder="ex. Zone de levage parfaitement balisée, signaleur présent" ${readOnly ? 'disabled' : ''}>${esc(g.text)}</textarea>
      <div class="thumbs" id="gthumbs"></div>
      ${readOnly ? '' : `<div class="btns" style="margin-top:10px"><label class="btn" style="margin:0">${ic('camera')} Photo<input type="file" accept="image/*" class="hidden-input" id="gphoto"></label>
        ${good ? `<button class="btn danger" id="gdel">${ic('trash', 18)} Supprimer</button>` : '<span></span>'}</div>
      <button class="btn primary big good-btn" id="gok" style="margin-top:4px">Enregistrer la bonne pratique</button>`}`,
    (el, close) => {
      const draw = async () => { el.querySelector('#gthumbs').innerHTML = await thumbsHTML(g.photos); };
      draw();
      el.querySelector('#gphoto')?.addEventListener('change', async e => { g.photos.push(...await addPhotos(e.target.files)); e.target.value = ''; draw(); });
      el.querySelector('#gthumbs').addEventListener('click', e => { const ph = e.target.closest('[data-photo]'); if (ph) photoViewer(ph.dataset.photo); });
      el.querySelector('#gdel')?.addEventListener('click', async () => {
        if (!await confirmBox('Supprimer cette bonne pratique ?', '')) return;
        insp.goods = (insp.goods || []).filter(x => x.id !== g.id); await db.put('inspections', insp); close(); resolve(insp);
      });
      el.querySelector('#gok')?.addEventListener('click', async () => {
        g.text = el.querySelector('#gtext').value.trim();
        if (!g.text && !g.photos.length) return toast('Décrivez ce qui a été observé');
        insp.goods = [...(insp.goods || []).filter(x => x.id !== g.id), g];
        await db.put('inspections', insp); close(); navigator.vibrate?.(15); toast('Bonne pratique enregistrée'); resolve(insp);
      });
    });
  });
}
function goodCard(g) {
  const crit = g.critRef ? criterionOfRef(g.critRef) : null;
  return `<button type="button" class="card good-card" data-good="${g.id}"><span class="good-ic">${ic('check', 18)}</span>
    <span class="grow"><b>${esc(g.text || 'Bonne pratique')}</b>${crit ? `<span class="muted small">${esc(g.critRef)} · ${esc(crit.name)}</span>` : ''}</span>
    ${(g.photos || []).length ? `<span class="good-ph">${ic('camera', 16)} ${g.photos.length}</span>` : ''}</button>`;
}

// ---------- signature du responsable de l'entreprise en fin d'audit ----------
function signatureSheet(insp, subs) {
  return new Promise(resolve => {
    const sub = subIdsOf(insp).length === 1 ? subs[insp.subId] : null;
    openSheet(`<h3>Signature</h3><p class="muted small" style="margin-top:-6px">Le responsable ${sub ? 'de ' + esc(sub.name) + ' ' : ''}confirme avoir pris connaissance des constats et des actions.</p>
      <div class="btns" style="margin:0"><div><label class="f" style="margin-top:0">Nom</label><input class="in" id="sgn" value="${esc(insp.signature?.name || '')}" autocomplete="name"></div>
      <div><label class="f" style="margin-top:0">Fonction</label><input class="in" id="sgr" value="${esc(insp.signature?.role || 'Chef d’équipe')}"></div></div>
      <label class="f">Signez dans le cadre</label>
      <canvas class="sig-pad" id="sgc"></canvas>
      <div class="btns" style="margin-top:10px"><button class="btn" id="sgx">Effacer</button><button class="btn primary" id="sgok">Valider la signature</button></div>`,
    (el, close) => {
      const cv = el.querySelector('#sgc'), r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = r.width * dpr; cv.height = r.height * dpr;
      const g = cv.getContext('2d'); g.scale(dpr, dpr); g.lineWidth = 2.6; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#0A1322';
      let drawing = false, inked = false, last = null;
      const pt = e => { const b = cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
      cv.addEventListener('pointerdown', e => { e.preventDefault(); cv.setPointerCapture(e.pointerId); drawing = true; last = pt(e); });
      cv.addEventListener('pointermove', e => { if (!drawing) return; const p = pt(e); g.beginPath(); g.moveTo(last.x, last.y); g.lineTo(p.x, p.y); g.stroke(); last = p; inked = true; });
      const up = () => { drawing = false; }; cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
      el.querySelector('#sgx').onclick = () => { g.clearRect(0, 0, cv.width, cv.height); inked = false; };
      el.querySelector('#sgok').onclick = async () => {
        const name = el.querySelector('#sgn').value.trim();
        if (!name) return toast('Indiquez le nom du signataire');
        if (!inked) return toast('Signez dans le cadre');
        // fond blanc pour le PDF
        const out = document.createElement('canvas'); out.width = cv.width; out.height = cv.height;
        const o = out.getContext('2d'); o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height); o.drawImage(cv, 0, 0);
        const blob = await new Promise(rs => out.toBlob(rs, 'image/jpeg', 0.9));
        const old = insp.signature?.blobId;
        insp.signature = { name, role: el.querySelector('#sgr').value.trim(), date: new Date().toISOString(), blobId: await db.putBlob(blob) };
        await db.put('inspections', insp); if (old) db.deleteBlob(old).catch(() => {});
        close(); toast('Signature enregistrée'); resolve(insp);
      };
    });
  });
}
/** Abréviation affichée dans les épingles : 3 premières lettres */
const abbr = name => (name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
/** Audit à plusieurs entreprises : à laquelle rattacher l'action ? */
function chooseCompany(insp, subs) {
  const ids = subIdsOf(insp);
  if (ids.length <= 1) return Promise.resolve(ids[0] || null);
  return ask('Action pour quelle entreprise ?', '', [...ids.map(id => ({ label: subs[id]?.name || '?', value: id, cls: 'primary' })), { label: 'Toutes / générale', value: '' }]).then(v => v === undefined ? null : (v || null));
}

/** État d'un audit : brouillon (rien noté), en cours, terminé (complet, signé ou transmis) */
function auditState(i) {
  const o = overallScore(i.scores, i.bonus, i.penalty), n = o.themes.reduce((a, t) => a + t.done, 0);
  const st = i.signature || n >= 124 ? 'done' : n ? 'wip' : 'draft';
  return { o, n, st };
}
const ST_TAG = { draft: 'Brouillon', wip: 'En cours', done: 'Terminé' };
const stTag = (st, n) => `<span class="st-tag s-${st}">${st === 'done' ? ic('check', 12) + ' ' : ''}${ST_TAG[st]}${st === 'wip' ? ` · ${n}/124` : ''}</span>`;
/** Une ligne d'audit, même format partout (pastille · nom · état · score) */
function auditRow(i, subs, { meta = true } = {}) {
  const { o, n, st } = auditState(i);
  const who = cloud.enabled && cloud.isAdmin() && i.owner !== cloud.uid() && i.inspectors ? ` · ${esc(i.inspectors)}` : '';
  return `<a class="vg-row" href="#/insp/${i.id}" style="--c:${esc(auditColor(i, subs))}"><span class="mono">${esc(auditAbbr(i, subs))}</span>
    <span class="grow"><b>${esc(auditLabel(i, subs))}</b><small>${stTag(st, n)}${isLocked(i) ? ' <span class="st-tag s-lock">Transmis</span>' : ''}${meta ? ` ${dateFR(i.date)}${i.zone && namedSubs(i, subs).length ? ' · ' + esc(i.zone) : ''}${who}` : ''}</small></span>${o.pct === null ? '<span class="badge none">—</span>' : badge(o.pct)}</a>`;
}
function inspCard(i, subs) { return `<div class="card visit-group single" style="--c:${esc(auditColor(i, subs))}">${auditRow(i, subs)}</div>`; }
// ---------- choix de la zone : liste propre, triée, regroupée par secteur ----------
const ZONE_GROUPS = [['DCH', /^dch/i], ['FSA', /^fsa/i], ['MYD', /^myd/i], ['EYD', /^eyd/i], ['Utilités (UTI)', /^(uti|utilit|zone 17)/i], ['Toitures', /^roof/i], ['SB', /^sb\d/i], ['Tranchées', /trench/i], ['Axes / D', /^(axis|d\d)/i]];
const zoneKey = z => z.toLowerCase().replace(/^(on the |the )/, '').replace(/^roof of (the )?/, 'roof ').replace(/\s+/g, ' ').trim();
const natural = (a, b) => a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' });
async function zoneOptions() {
  const used = (await pAll('inspections')).sort((a, b) => (b.date + (b.updatedAt || '')).localeCompare(a.date + (a.updatedAt || ''))).map(i => (i.zone || '').trim()).filter(Boolean);
  const all = new Map();
  [...used, ...((await db.getMeta('locations')) || SEED_LOCATIONS)].forEach(z => { z = String(z).trim(); if (!z || /^\d+(\.\d+)?$/.test(z)) return; const k = zoneKey(z); if (!all.has(k)) all.set(k, z.charAt(0).toUpperCase() + z.slice(1)); });
  const recent = [...new Map(used.map(z => [zoneKey(z), z])).values()].slice(0, 6);
  return { list: [...all.values()].sort(natural), recent };
}
async function zonePicker(input, plan = null) {
  if (!input) return;
  const { list, recent } = await zoneOptions();
  const planZones = [...new Set((plan?.zones || []).map(z => z.name).filter(Boolean))].sort(natural);
  const panel = document.createElement('div'); panel.className = 'zone-panel'; panel.hidden = true;
  input.after(panel);
  const chip = z => `<button type="button" data-z="${esc(z)}">${esc(z)}</button>`;
  const draw = () => {
    const q = zoneKey(input.value);
    if (q) {
      const hits = [...new Set([...planZones, ...list])].filter(z => zoneKey(z).includes(q)).slice(0, 40);
      panel.innerHTML = hits.length ? `<div class="zp-chips">${hits.map(chip).join('')}</div>` : `<p class="muted small">Nouvelle zone : « ${esc(input.value.trim())} »</p>`;
      return;
    }
    const groups = ZONE_GROUPS.map(([label, re]) => [label, list.filter(z => re.test(z))]);
    const placed = new Set(groups.flatMap(([, l]) => l));
    groups.push(['Autres', list.filter(z => !placed.has(z))]);
    panel.innerHTML = (planZones.length ? `<div class="zp-group"><b>Zones du plan</b><div class="zp-chips">${planZones.map(chip).join('')}</div></div>` : '') + (recent.length ? `<div class="zp-group"><b>Récentes</b><div class="zp-chips">${recent.map(chip).join('')}</div></div>` : '') +
      groups.filter(([, l]) => l.length).map(([label, l]) => `<div class="zp-group"><b>${esc(label)}</b><div class="zp-chips">${l.map(chip).join('')}</div></div>`).join('');
  };
  const open = () => { draw(); panel.hidden = false; };
  input.addEventListener('focus', open);
  input.addEventListener('input', () => { if (!panel.hidden) draw(); else open(); });
  input.addEventListener('blur', () => setTimeout(() => { panel.hidden = true; }, 150));
  input.addEventListener('keydown', e => { if (e.key === 'Escape' || e.key === 'Enter') { panel.hidden = true; if (e.key === 'Enter') input.blur(); } });
  panel.addEventListener('pointerdown', e => e.preventDefault()); // garde le clavier ouvert pendant le choix
  panel.addEventListener('click', e => {
    const b = e.target.closest('[data-z]'); if (!b) return;
    input.value = b.dataset.z; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    panel.hidden = true; input.blur(); navigator.vibrate?.(10);
  });
}
/** Liste d'audits : ceux d'une même tournée (lancés ensemble) sont regroupés ; la zone en est le titre */
function inspList(list, subs) {
  const byVisit = {};
  list.forEach(i => { if (i.visitId) (byVisit[i.visitId] ||= []).push(i); });
  const done = new Set();
  return list.map(i => {
    const grp = i.visitId && byVisit[i.visitId].length > 1 ? byVisit[i.visitId] : null;
    if (!grp) return inspCard(i, subs);
    if (done.has(i.visitId)) return '';
    done.add(i.visitId);
    const zAudit = grp.find(x => !namedSubs(x, subs).length);
    const comps = grp.filter(x => x !== zAudit).sort((a, b) => auditLabel(a, subs).localeCompare(auditLabel(b, subs)));
    const zone = grp.find(x => x.zone)?.zone;
    const nC = new Set(comps.flatMap(x => namedSubs(x, subs))).size;
    const who = cloud.enabled && cloud.isAdmin() && i.owner !== cloud.uid() && i.inspectors ? ' · ' + esc(i.inspectors) : '';
    const zs = zAudit ? auditState(zAudit) : null;
    const head = `${ic('pin', 18)}<span class="grow"><b>${esc(zone || 'Audit de zone')}</b><small>${dateFR(i.date)} · ${nC} entreprise${nC > 1 ? 's' : ''}${who}${zs ? ' · ' + { draft: 'zone non notée', wip: 'zone en cours', done: 'zone terminée' }[zs.st] : ''}</small></span>${zs ? (zs.o.pct === null ? '<span class="badge none">—</span>' : badge(zs.o.pct)) : ''}`;
    return `<div class="card visit-group">${zAudit ? `<a class="vg-head" href="#/insp/${zAudit.id}">${head}</a>` : `<div class="vg-head">${head}</div>`}${comps.map(x => auditRow(x, subs, { meta: false })).join('')}</div>`;
  }).join('');
}
const daysTo = d => Math.round((new Date(d + 'T12:00:00') - new Date(todayISO() + 'T12:00:00')) / 864e5);
function dueChip(a) {
  if (a.status === 'Closed') return `<span class="due ok">${ic('check', 15)} Clôturée</span>`;
  if (!a.dueDate) return '';
  const n = daysTo(a.dueDate);
  if (n < 0) return `<span class="due late">J+${-n}</span>`;
  if (n === 0) return `<span class="due soon">Aujourd’hui</span>`;
  return `<span class="due">J-${n}</span>`;
}
function actionCard(a, subs) {
  return `<a class="card link act-card prio-${a.priority}" href="#/action/${a.id}">
    <div class="row">${subChip(subs[a.subId])}<span class="prio-txt p-${a.priority}">${PRIO_FR[a.priority] || a.priority}</span><span class="grow"></span>${dueChip(a)}</div>
    <div class="act-title">${esc(a.observation || 'Observation à compléter')}</div>
    <div class="muted small ellip">${esc(actionRef(a) || 'Action libre')}${a.status === 'In progress' ? ' · <b>En cours</b>' : ''}</div></a>`;
}

// ---------- formulaire inspection (création + modification) ----------
async function inspForm(state, { live }) {
  const { subList, plans, planList } = await maps();
  const subsActive = subList.filter(s => !s.archived || subIdsOf(state).includes(s.id));
  state.subIds = [...subIdsOf(state)];
  if (!state.planId && planList.length) state.planId = planList[0].id;
  view.innerHTML = `
    <label class="f" style="margin-top:4px">Zone — touchez une zone, un point, ou tracez la zone</label>
    <div id="pick" class="pv plan-box"></div>
    <div class="plan-tools" id="f-tools"></div>
    <input class="in" id="f-zone" autocomplete="off" placeholder="Zone (ex. Bâtiment A, niveau 2…)" value="${esc(state.zone || '')}" style="margin-top:8px">
    <label class="f">Entreprise auditée</label>
    <div class="pick-grid" id="f-subs">${subsActive.map(s => `<button type="button" class="pick ${subIdsOf(state).includes(s.id) ? 'on' : ''}" data-s="${s.id}" style="--c:${esc(s.color)}"><span class="mono xs">${esc(abbr(s.name))}</span><span class="grow">${esc(s.name)}</span>${ic('check', 16)}</button>`).join('')}</div>
    ${planList.length > 1 ? `<label class="f">Plan</label><select class="in" id="f-plan">${planList.map(p => `<option value="${p.id}" ${p.id === state.planId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
    <label class="f">Inspecteur(s)</label><input class="in" id="f-insp" list="hse-list" value="${esc(state.inspectors || '')}" autocomplete="off">
    <div class="btns" style="margin:0"><div><label class="f">Date</label><input class="in" type="date" id="f-date" value="${esc(state.date)}"></div>
    <div><label class="f">Projet / chantier</label><input class="in" id="f-site" value="${esc(state.site || '')}"></div></div>
    <div id="form-foot" style="margin-top:16px"></div>`;
  view.querySelectorAll('[data-logo]').forEach(async im => { im.src = await db.blobURL(im.dataset.logo); });

  let pv = null, kit = null;
  const mountPlan = async () => {
    pv?.destroy(); kit?.dispose();
    const plan = plans[state.planId];
    const box = $('#pick');
    if (!plan) { box.innerHTML = '<div class="empty">Aucun plan</div>'; $('#f-tools').innerHTML = ''; return; }
    const sub = () => state.subIds.length === 1 ? subList.find(s => s.id === state.subIds[0]) : null;
    const pinsNow = () => state.pin && !state.area ? [{ id: 'p', ...state.pin, color: sub()?.color || '#0B2D5B', label: '', ghost: true }] : [];
    const tools = $('#f-tools').cloneNode(false); $('#f-tools').replaceWith(tools);
    kit = zoneKit({ plan, state, nameInput: $('#f-zone'), toolsEl: tools, onChange: k => { pv?.setPins(pinsNow()); live?.(k === 'name' ? 'zone' : 'pin'); } });
    pv = createPlanViewer(box, {
      imageURL: await db.blobURL(plan.blobId), pins: pinsNow(), cover: 2.4, ...kit.viewerOpts,
      focus: state.area ? null : state.pin || null,
      onTap: (x, y) => kit.point(x, y),
    });
    kit.bind(pv);
    onCleanup(() => pv?.destroy());
  };
  await mountPlan();
  zonePicker($('#f-zone'), plans[state.planId]);

  $('#f-subs').onclick = e => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    // une seule entreprise par audit (toucher à nouveau = audit de zone)
    state.subIds = state.subIds[0] === b.dataset.s ? [] : [b.dataset.s]; state.subId = state.subIds[0] || null;
    $('#f-subs').querySelectorAll('[data-s]').forEach(x => x.classList.toggle('on', state.subIds.includes(x.dataset.s))); live?.('sub');
  };
  if ($('#f-plan')) $('#f-plan').onchange = e => { state.planId = e.target.value; state.pin = null; state.area = null; mountPlan(); live?.('plan'); };
  const bind = (sel, key) => { $(sel).addEventListener('input', e => { state[key] = e.target.value; live?.(key); }); };
  bind('#f-zone', 'zone'); bind('#f-insp', 'inspectors'); bind('#f-date', 'date'); bind('#f-site', 'site');
  return { plans };
}

async function vNew(q) {
  if (q.get('sub')) { await startInspection(q.get('sub')); return; }
  location.replace('#/start'); return;
  setTop({ title: 'Nouvelle inspection', back: '#/' });
  const { subList } = await maps();
  const [insps, acts] = await Promise.all([pAll('inspections'), pAll('actions')]);
  view.innerHTML = `<div class="section-head"><span>Choisissez l’entreprise</span></div>${subGrid(subList, insps, acts)}`;
  bindSubGrid();
}

async function vInspEdit(id) {
  const insp = await db.get('inspections', id);
  setTop({ title: 'Détails', back: '#/insp/' + id });
  const save = debounce(async () => { await db.put('inspections', insp); }, 300);
  // les actions de l'audit encore sans emplacement reprennent la zone posée sur le plan
  const pinActions = debounce(async () => {
    const acts = (await db.byIndex('actions', 'inspectionId', id)).filter(a => !a.pin && insp.pin);
    for (const [k, a] of acts.entries()) {
      const ang = (k + 1) * 2.4;
      await db.put('actions', { ...a, planId: insp.planId, pin: { x: clamp01(insp.pin.x + Math.cos(ang) * 0.03), y: clamp01(insp.pin.y + Math.sin(ang) * 0.03) } });
    }
  }, 300);
  onCleanup(() => pinActions.flush());
  await inspForm(insp, { live: k => { save(); if (k === 'pin') pinActions(); } });
  onCleanup(() => save.flush());
  $('#form-foot').innerHTML = `<p class="muted small">Référence : <b>${esc(insp.ref)}</b> · enregistrement automatique</p>
    <button class="btn danger block" id="del">Supprimer l’inspection</button>`;
  $('#del').onclick = async () => {
    if (await confirmDeleteInspection(id, '')) location.replace('#/');
  };
}

async function deleteInspection(id) {
  const insp = await db.get('inspections', id);
  const acts = await db.byIndex('actions', 'inspectionId', id);
  const photos = [...Object.values(insp?.scores || {}).flatMap(s => s?.photos || []), ...(insp?.goods || []).flatMap(g => g.photos || []), insp?.signature?.blobId, ...acts.flatMap(a => [...(a.photos || []), ...(a.photosAfter || [])])].filter(Boolean);
  for (const a of acts) await db.remove('actions', a.id);
  await db.remove('inspections', id);
  for (const p of photos) await db.deleteBlob(p).catch(() => {});
}
async function confirmDeleteInspection(id, name) {
  const n = (await db.byIndex('actions', 'inspectionId', id)).length;
  if (!await confirmBox(`Supprimer l’audit ${name || ''} ?`, n ? `L’audit et ses ${n} action${n > 1 ? 's' : ''} seront supprimés définitivement.` : 'L’audit sera supprimé définitivement.', 'Supprimer')) return false;
  await deleteInspection(id); toast('Audit supprimé'); return true;
}

/** HSE sans le droit « voir le détail » : un audit passé n'affiche que ses chiffres */
const isLocked = insp => cloud.enabled && !cloud.isAdmin() && !cloud.can('details') && insp.date !== todayISO();
function lockedView(insp, sub, acts) {
  const o = overallScore(insp.scores, insp.bonus, insp.penalty);
  const done = o.themes.reduce((a, t) => a + t.done, 0);
  view.innerHTML = `
    <div class="card locked-card">
      <span class="ic-round">${ic('check')}</span>
      <b>Audit transmis à l’administrateur HSE</b>
      <p class="muted small">Le détail est consultable par l’administrateur. Voici le résumé de votre audit.</p>
    </div>
    <div class="kpi-row">
      <div><b>${o.pct === null ? '—' : Math.round(o.pct * 100) + '%'}</b><span>Score</span></div>
      <div><b>${done}</b><span>Critères notés</span></div>
      <div><b>${acts.length}</b><span>Actions</span></div>
    </div>
    <div class="card"><div class="muted small">Entreprise</div><b>${esc(sub?.name || '')}</b>
      <div class="muted small" style="margin-top:8px">Date · zone</div><b>${dateFR(insp.date)}${insp.zone ? ' · ' + esc(insp.zone) : ''}</b></div>`;
}

async function vInsp(id) {
  const insp = await db.get('inspections', id);
  if (!insp || insp.deleted) return vNotFound();
  db.setMeta('lastInsp', { id, at: Date.now() }).catch(() => {});
  const { subs, plans } = await maps();
  const sub = { name: auditLabel(insp, subs), color: auditColor(insp, subs) };
  const acts = await db.byIndex('actions', 'inspectionId', id);
  if (isLocked(insp)) { setTop({ title: sub?.name || 'Audit', sub: `Audit du ${dateFR(insp.date)}`, back: '#/' }); return lockedView(insp, sub, acts); }
  setTop({ title: sub?.name || 'Audit', sub: `Audit du ${dateFR(insp.date)}`, back: '#/', actions: [
    { icon: 'trash', aria: 'Supprimer l’audit', onClick: async () => { if (await confirmDeleteInspection(id, sub?.name)) location.replace('#/'); } },
    { icon: 'edit', aria: 'Modifier', onClick: () => location.hash = `#/insp/${id}/edit` }] });
  const siblings = insp.visitId ? (await pAll('inspections')).filter(i => i.visitId === insp.visitId).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')) : [];
  const visitBar = siblings.length > 1 ? `<div class="visit-bar"><span class="muted small">Audit de zone · ${siblings.length} audits</span><div class="visit-chips">${siblings.map(v => {
    const vo = overallScore(v.scores, v.bonus, v.penalty), vs = subs[v.subId];
    const vz = !namedSubs(v, subs).length;
    return `<a href="#/insp/${v.id}" class="vchip ${v.id === id ? 'on' : ''}" style="--c:${esc(vz ? '#0B2D5B' : (vs?.color || '#9E9E9E'))}"><span class="mono xs">${vz ? 'ZON' : esc(abbr(vs?.name))}</span>${esc(vz ? (v.zone || 'Zone') : (vs?.name || ''))}<em>${vo.pct === null ? '—' : Math.round(vo.pct * 100) + '%'}</em></a>`;
  }).join('')}${cloud.can('audit') ? `<button type="button" class="vchip vadd" id="v-add">${ic('plus', 16)} Entreprise</button>` : ''}</div></div>` : '';
  const isZone = subIdsOf(insp).length === 0;
  // audit de zone (seul) : on peut y ajouter les entreprises rencontrées
  const zoneAdd = isZone && siblings.length <= 1 && cloud.can('audit') ? `<button type="button" class="card link row zone-add" id="v-add">
      <span class="ic-round">${ic('plus')}</span><span class="grow"><b>Auditer une entreprise dans cette zone</b><span class="muted small">Une ou plusieurs — un audit et un score par entreprise, regroupés avec cette zone</span></span>${ic('chevron')}</button>` : '';
  const teamActs = subIdsOf(insp).length === 1 ? await teamOpenActions(insp.subId) : [];
  const prev = await lastAudit(insp);
  const prevPct = prev ? overallScore(prev.scores, prev.bonus, prev.penalty).pct : null;
  const draw = () => {
    const o = overallScore(insp.scores, insp.bonus, insp.penalty);
    const done = o.themes.reduce((a, t) => a + t.done, 0);
    const next = o.themes.find(t => t.done < t.total);
    view.innerHTML = visitBar + zoneAdd + `
      <div class="card score-card">
        <div><div class="score-big" style="--sc:${o.pct === null ? 'var(--muted)' : o.rating.color};--sct:${o.pct === null ? 'var(--muted)' : textTone(o.rating.color)}">${o.pct === null ? '—' : Math.round(o.pct * 100) + '<small>%</small>'}</div>
          ${o.pct === null ? '<span class="muted small">Pas encore noté</span>' : ratingChip(o.pct)}</div>
        <div class="score-meta"><b>${done} / 124</b><span>critères</span>
          <span class="muted small">${esc(insp.inspectors || '')}</span></div>
      </div>
      ${prev ? `<a class="prev-line" href="#/insp/${prev.id}/sum">${ic('clock', 16)}<span>Dernier audit le ${dateFR(prev.date)} : <b>${prevPct === null ? '—' : Math.round(prevPct * 100) + ' %'}</b> — anciennes notes affichées sous chaque critère</span></a>` : ''}
      ${next ? `<a class="btn primary big" href="#/insp/${id}/t/${next.theme.ref}" style="margin-bottom:10px">${done ? 'Continuer' : 'Commencer'} : ${esc(next.theme.ref.replace('.0', ''))}. ${esc(next.theme.name)}</a>` : `<a class="btn primary big" href="#/insp/${id}/sum" style="margin-bottom:10px">${ic('check')} Audit complet — voir le résumé</a>`}
      <a class="card link row loc-row" href="${insp.pin ? `#/map?plan=${insp.planId}&insp=${id}` : `#/insp/${id}/edit`}">
        <span class="ic-round">${ic('pin')}</span>
        <span class="grow"><b>${insp.pin ? (insp.zone ? esc(insp.zone) : 'Zone localisée') : 'Localiser sur le plan'}</b><div class="muted small">${insp.pin ? 'Voir sur le plan' : 'Facultatif'}</div></span>${ic('chevron')}</a>
      <div class="toolbar three">
        <a href="#/insp/${id}/sum">${ic('file')}<span>Résumé</span></a>
        ${cloud.can('export') ? `<button id="exp">${ic('share')}<span>Exporter</span></button>` : ''}
        <a href="#/actions?insp=${id}">${ic('list')}<span>Actions${acts.length ? ` (${acts.length})` : ''}</span></a>
      </div>
      <div class="section-head"><span>Thèmes</span><span class="muted small">${o.countedThemes}/19 notés</span></div>
      ${o.themes.map(t => {
        const allNA = t.na === t.total;
        return `<div class="theme-row ${t.done === t.total ? 'complete' : ''}">
          <a class="grow row" href="#/insp/${id}/t/${t.theme.ref}">
            <span class="num">${t.theme.ref.replace('.0', '')}</span>
            <span class="grow"><b>${esc(t.theme.name)}</b><span class="muted small">${allNA ? 'Non applicable' : `${t.done} / ${t.total}`}</span></span>
            ${allNA ? '<span class="badge none">N/A</span>' : t.done ? badge(t.pct) : '<span class="badge none">—</span>'}${ic('chevron', 18)}</a></div>`;
      }).join('')}
      <div class="section-head"><span>Bonnes pratiques</span><span class="muted small">${(insp.goods || []).length || ''}</span></div>
      ${(insp.goods || []).map(goodCard).join('')}
      <button class="btn block good-add" id="g-add">${ic('plus', 18)} Ajouter une bonne pratique</button>
      ${subIdsOf(insp).length === 1 ? `<div class="section-head"><span>Fin d’audit</span></div>
      <div class="card sig-card">${insp.signature ? `<div class="row"><img class="sig-img" data-sigimg="${insp.signature.blobId}" alt="signature"><span class="grow"><b>${esc(insp.signature.name)}</b><span class="muted small">${esc(insp.signature.role || '')} · signé le ${dateFR(insp.signature.date.slice(0, 10))}</span></span></div>
        <button class="btn block" id="sig" style="margin-top:10px">Refaire la signature</button>` : `<b>Faire signer le responsable de ${esc(subs[insp.subId]?.name || 'l’entreprise')}</b><span class="muted small">Facultatif — la signature apparaît dans le rapport PDF.</span>
        <button class="btn block" id="sig" style="margin-top:10px">${ic('edit', 18)} Signer sur l’écran</button>`}</div>` : ''}`;
    if ($('#exp')) $('#exp').onclick = () => exportSheet([insp]);
    $('#v-add')?.addEventListener('click', () => addCompaniesToVisit(insp, siblings, subs));
    $('#g-add')?.addEventListener('click', async () => { if (await goodSheet(insp)) draw(); });
    view.querySelectorAll('[data-good]').forEach(b => b.onclick = async () => { if (await goodSheet(insp, { good: (insp.goods || []).find(g => g.id === b.dataset.good) })) draw(); });
    $('#sig')?.addEventListener('click', async () => { if (await signatureSheet(insp, subs)) draw(); });
    view.querySelectorAll('[data-sigimg]').forEach(async im => { im.src = await db.blobURL(im.dataset.sigimg); });
    // actions encore ouvertes chez cette entreprise, signalées par d'autres HSE : à vérifier sur place
    const themesHead = [...view.querySelectorAll('.section-head')].find(h => /Thèmes/.test(h.textContent));
    if (teamActs.length) (themesHead || view).insertAdjacentHTML(themesHead ? 'beforebegin' : 'beforeend', `<div class="section-head"><span>À vérifier · signalé par l’équipe</span><span class="muted small">${teamActs.length}</span></div>
      <p class="muted small" style="margin:-4px 2px 8px">Actions encore ouvertes chez ${esc(subs[insp.subId]?.name || '')}, relevées par d’autres HSE.</p>
      ${teamActs.slice(0, 6).map(a => actionCard(a, subs)).join('')}`);
  };
  draw();
  view.addEventListener('click', async e => {
    const b = e.target.closest('[data-na]'); if (!b) return;
    const th = THEMES.find(t => t.ref === b.dataset.na);
    insp.scores ||= {};
    const allNA = th.criteria.every(c => insp.scores[c.ref]?.v === NA);
    if (!allNA && th.criteria.some(c => typeof insp.scores[c.ref]?.v === 'number') &&
      !await confirmBox(`Marquer « ${th.name} » N/A ?`, 'Les notes déjà saisies dans ce thème seront remplacées.', 'Tout en N/A', 'primary')) return;
    for (const c of th.criteria) { insp.scores[c.ref] = { ...(insp.scores[c.ref] || {}), v: allNA ? null : NA }; }
    await db.put('inspections', insp); draw();
  });
}

async function vTheme(id, ref) {
  const insp = await db.get('inspections', id);
  if (!insp) return vNotFound();
  if (isLocked(insp)) { location.replace('#/insp/' + id); return; }
  db.setMeta('lastInsp', { id, ref, at: Date.now() }).catch(() => {});
  const th = THEMES.find(t => t.ref === ref);
  const idx = THEMES.indexOf(th);
  insp.scores ||= {};
  setTop({ title: th.name, sub: `Thème ${idx + 1} / ${THEMES.length}`, back: '#/insp/' + id, actions: [helpAction] });
  const acts = await db.byIndex('actions', 'inspectionId', id);
  const save = debounce(() => db.put('inspections', insp), 350);
  onCleanup(() => save.flush());
  const sc = ref => (insp.scores[ref] ||= { v: null, c: '', photos: [] });
  // repère : la note donnée au même critère lors du dernier audit de cette entreprise (rien n'est recopié)
  const prev = await lastAudit(insp);
  const PV = { 0: '#C62828', 1: '#C62828', 2: '#EF6C00', 3: '#FBC02D', 4: '#43A047', 5: '#1B5E20' };
  const prevNote = c => {
    const p = prev?.scores?.[c.ref]; if (!p || p.v === null || p.v === undefined) return '';
    const v = p.v === NA ? 'N/A' : p.v;
    return `<div class="prev-note"><span>Dernier audit ${dateFR(prev.date).slice(0, 5)}</span><b class="pvn" style="--pv:${PV[p.v] || '#9E9E9E'};color:${p.v === 2 || p.v === 3 || p.v === NA ? '#111' : '#fff'}">${v}</b>${p.c ? `<em>${esc(p.c)}</em>` : ''}</div>`;
  };

  view.innerHTML = `
    <div class="card row sticky-score" id="tscore"></div>
    ${th.criteria.map(c => {
      const s = insp.scores[c.ref] || {};
      const n = acts.filter(a => a.critRef === c.ref).length;
      return `<div class="card crit" data-ref="${c.ref}">
        <h3><small>${c.ref}</small>${esc(c.name)}</h3>
        ${prevNote(c)}
        <div class="scores">${[0, 1, 2, 3, 4, 5, NA].map(v => `<button type="button" data-v="${v}" class="${v === NA ? 'na' : ''} ${s.v === v ? 'on' : ''}">${v === NA ? 'N/A' : v}</button>`).join('')}</div>
        <div class="crit-tools3">
          <button type="button" class="tbtn ${s.c ? 'on' : ''}" data-cbtn>${ic('edit', 17)}<span>Constat</span></button>
          <label class="tbtn">${ic('camera', 17)}<span>Photo</span><input type="file" accept="image/*" class="hidden-input" data-photo-in multiple></label>
          ${cloud.can('actions') ? `<button type="button" class="tbtn ${n ? 'on' : ''}" data-act>${ic('plus', 17)}<span>Action${n ? ` (${n})` : ''}</span></button>` : ''}</div>
        <textarea class="in crit-c" placeholder="Constat / commentaire" data-c ${s.c || (typeof s.v === 'number' && s.v <= 2) ? '' : 'hidden'}>${esc(s.c || '')}</textarea>
        <div class="thumbs" data-thumbs></div><div class="good-slot" data-gs></div></div>`;
    }).join('')}
    <p class="muted small swipe-hint">Glissez à gauche ou à droite pour changer de thème</p>
    <div class="btns">
      ${idx > 0 ? `<a class="btn" href="#/insp/${id}/t/${THEMES[idx - 1].ref}">‹ ${THEMES[idx - 1].ref.replace('.0', '')}</a>` : '<span></span>'}
      ${idx < THEMES.length - 1 ? `<a class="btn primary" href="#/insp/${id}/t/${THEMES[idx + 1].ref}">${THEMES[idx + 1].ref.replace('.0', '')} ›</a>` : `<a class="btn primary" href="#/insp/${id}/sum">Résumé ›</a>`}
    </div>`;

  const drawScore = () => {
    const t = themeScore(th, insp.scores);
    const allNA = th.criteria.every(c => insp.scores[c.ref]?.v === NA);
    $('#tscore').innerHTML = `<div class="grow"><b>Score du thème</b><div class="muted small">${t.done}/${t.total} traités${t.max ? ` · ${t.sum}/${t.max} pts` : ''}</div></div>
      <button type="button" class="na-btn ${allNA ? 'on' : ''}" id="th-na" aria-label="Thème non applicable" title="Tout le thème non applicable">N/A</button>
      ${t.done === 0 || allNA ? '<span class="badge none">—</span>' : badge(t.pct)}`;
  };
  const drawThumbs = async card => { card.querySelector('[data-thumbs]').innerHTML = await thumbsHTML(insp.scores[card.dataset.ref]?.photos); };
  // note 5 : proposer de la noter comme bonne pratique (reconnaissance positive)
  const drawGood = card => {
    const ref = card.dataset.ref, g = (insp.goods || []).find(x => x.critRef === ref), v = insp.scores[ref]?.v;
    card.querySelector('[data-gs]').innerHTML = g ? `<button type="button" class="good-chip" data-goodedit>${ic('check', 16)} Bonne pratique : ${esc(g.text || 'voir')}</button>`
      : v === 5 ? `<button type="button" class="good-link sm" data-goodnew>${ic('plus', 15)} Bonne pratique</button>` : '';
  };
  drawScore();
  view.querySelectorAll('.crit').forEach(c => { drawThumbs(c); drawGood(c); });

  // tout le thème N/A d'un toucher (ex. Plongée), sans revenir à l'écran de l'audit
  view.addEventListener('click', async e => {
    if (!e.target.closest('#th-na')) return;
    const allNA = th.criteria.every(c => insp.scores[c.ref]?.v === NA);
    if (!allNA && th.criteria.some(c => typeof insp.scores[c.ref]?.v === 'number') &&
      !await confirmBox(`Marquer « ${th.name} » N/A ?`, 'Les notes déjà saisies dans ce thème seront remplacées.', 'Tout en N/A', 'primary')) return;
    for (const c of th.criteria) sc(c.ref).v = allNA ? null : NA;
    await db.put('inspections', insp); toast(allNA ? 'Thème réactivé' : 'Thème entier en N/A'); render();
  });
  view.addEventListener('click', async e => {
    const card = e.target.closest('.crit'); if (!card) return;
    const cref = card.dataset.ref;
    const vb = e.target.closest('[data-v]');
    if (vb) {
      const v = vb.dataset.v === NA ? NA : Number(vb.dataset.v);
      const s = sc(cref);
      s.v = s.v === v ? null : v;
      card.querySelectorAll('[data-v]').forEach(b => b.classList.toggle('on', b === vb && s.v !== null));
      navigator.vibrate?.(15);
      save.flush(); drawScore(); drawGood(card);
      // note 0 à 2 : la case « constat » s'ouvre d'elle-même
      if (typeof s.v === 'number' && s.v <= 2) card.querySelector('[data-c]').hidden = false;
      // passage automatique au critère suivant
      if (s.v !== null && !(typeof s.v === 'number' && s.v <= 2)) {
        const next = card.nextElementSibling;
        if (next?.classList.contains('crit')) setTimeout(() => next.scrollIntoView({ behavior: 'smooth', block: 'center' }), 180);
      }
      if (typeof s.v === 'number' && s.v <= 2 && cloud.can('actions')) {
        const existing = (await db.byIndex('actions', 'inspectionId', id)).filter(a => a.critRef === cref);
        if (!existing.length) {
          const go = await ask(`Note ${s.v} — action corrective ?`, `${esc(cref)} ${esc(criterionOfRef(cref).name)}`, [
            { label: 'Créer l’action corrective', value: true, cls: 'primary' }, { label: 'Plus tard', value: false }]);
          if (go) { const a = await createAction(insp, { subId: await chooseCompany(insp, (await maps()).subs), critRef: cref, observation: s.c || '', priority: s.v <= 1 ? 'High' : 'Medium' }); location.hash = '#/action/' + a.id; }
        }
      }
      return;
    }
    if (e.target.closest('[data-cbtn]')) { const t = card.querySelector('[data-c]'); t.hidden = false; t.focus(); return; }
    if (e.target.closest('[data-goodnew], [data-goodedit]')) {
      save.flush();
      await goodSheet(insp, { critRef: cref, good: (insp.goods || []).find(x => x.critRef === cref) || null });
      drawGood(card); return;
    }
    if (e.target.closest('[data-act]')) {
      const s = sc(cref);
      const a = await createAction(insp, { subId: await chooseCompany(insp, (await maps()).subs), critRef: cref, observation: s.c || '', priority: typeof s.v === 'number' && s.v <= 1 ? 'High' : 'Medium' });
      location.hash = '#/action/' + a.id; return;
    }
    const ph = e.target.closest('[data-photo]');
    if (ph) photoViewer(ph.dataset.photo, async () => {
      const s = sc(cref); s.photos = s.photos.filter(p => p !== ph.dataset.photo); await db.deleteBlob(ph.dataset.photo); save.flush(); drawThumbs(card);
    }, async nid => {
      const s = sc(cref), old = ph.dataset.photo; s.photos = s.photos.map(p => p === old ? nid : p); save.flush(); drawThumbs(card); db.deleteBlob(old).catch(() => {});
    });
  });
  // glisser à gauche / à droite : thème suivant / précédent
  let sw = null;
  view.addEventListener('touchstart', e => { if (e.touches.length === 1 && !e.target.closest('textarea, input')) sw = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }; }, { passive: true });
  view.addEventListener('touchend', e => {
    if (!sw) return; const t = e.changedTouches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y; const quick = Date.now() - sw.t < 600; sw = null;
    if (!quick || Math.abs(dx) < 90 || Math.abs(dy) > 50) return;
    const to = dx < 0 ? THEMES[idx + 1] : THEMES[idx - 1];
    if (to) location.hash = `#/insp/${id}/t/${to.ref}`; else if (dx < 0) location.hash = `#/insp/${id}/sum`;
  }, { passive: true });
  // reprise : on se place sur le 1er critère pas encore noté
  const firstTodo = [...view.querySelectorAll('.crit')].find(c => { const v = insp.scores[c.dataset.ref]?.v; return v === null || v === undefined; });
  if (firstTodo && firstTodo !== view.querySelector('.crit')) setTimeout(() => firstTodo.scrollIntoView({ block: 'center' }), 60);
  view.addEventListener('input', e => {
    if (!e.target.matches('[data-c]')) return;
    sc(e.target.closest('.crit').dataset.ref).c = e.target.value; save();
    e.target.closest('.crit').querySelector('[data-cbtn]')?.classList.toggle('on', !!e.target.value.trim());
  });
  view.addEventListener('change', async e => {
    if (!e.target.matches('[data-photo-in]')) return;
    const card = e.target.closest('.crit');
    toast('Compression des photos…');
    const ids = await addPhotos(e.target.files);
    const s = sc(card.dataset.ref); s.photos = [...(s.photos || []), ...ids];
    save.flush(); drawThumbs(card); e.target.value = ''; toast(ids.length > 1 ? `${ids.length} photos ajoutées — touchez-en une pour l’annoter` : 'Photo ajoutée — touchez-la pour l’annoter', 3000);
  });
}

async function vSummary(id) {
  const insp = await db.get('inspections', id);
  if (!insp) return vNotFound();
  if (isLocked(insp)) { location.replace('#/insp/' + id); return; }
  const { subs } = await maps();
  setTop({ title: 'Résumé', sub: auditLabel(insp, subs), back: '#/insp/' + id, actions: [helpAction] });
  const fnName = await firstName(); let firstDraw = true;
  const save = debounce(() => db.put('inspections', insp), 300);
  onCleanup(() => save.flush());
  view.innerHTML = `
    <div id="sum-out"></div>
    ${cloud.can('export') ? `<button class="btn primary block" id="exp" style="margin:12px 0">${ic('share')} Exporter (Excel / PDF)</button>` : ''}
    <div class="section-head"><span>Informations</span></div>
    <div class="card">
      <div class="ref-line"><span class="muted small">Référence</span><b>${esc(insp.ref)}</b></div>
      <label class="f">Projet / chantier</label><input class="in" data-k="site" value="${esc(insp.site || '')}">
      <label class="f">Date de l’audit</label><input class="in" type="date" data-k="date" value="${esc(insp.date)}">
      <label class="f">Inspecteur(s)</label><input class="in" data-k="inspectors" list="hse-list" value="${esc(insp.inspectors || '')}" autocomplete="off">
      <div class="btns" style="margin-bottom:0"><div><label class="f">Bonus BE SAFE</label><input class="in" type="number" inputmode="decimal" step="0.5" data-k="bonus" value="${Number(insp.bonus) || 0}"></div>
      <div><label class="f">Pénalité LSR</label><input class="in" type="number" inputmode="decimal" step="0.5" data-k="penalty" value="${Number(insp.penalty) || 0}"></div></div>
    </div>`;
  const draw = () => {
    const o = overallScore(insp.scores, insp.bonus, insp.penalty);
    const pc = o.pct === null ? 0 : Math.round(o.pct * 1000) / 10;
    const ringC = o.pct === null ? 'var(--line-2)' : ({ Excellent: '#1B5E20', Good: '#2E7D32', Satisfactory: '#A87900', Weak: '#C25A00', Unacceptable: '#C62828' })[o.rating.name];
    const done = auditState(insp).st === 'done';
    $('#sum-out').innerHTML = `
      <div class="sum-hero">
        <div class="score-ring ${firstDraw && o.pct !== null ? 'fill' : ''}" style="--p:${pc};--rc:${ringC}" role="img" aria-label="Score global ${fmtPct(o.pct)}"><div><b>${o.pct === null ? '—' : String(pc).replace('.', ',')}${o.pct === null ? '' : '<small> %</small>'}</b><span>score global</span></div></div>
        <div class="sum-id"><span class="chip ${tnCls(o.pct)}">${o.pct === null ? 'Pas encore noté' : rName(o.rating)}</span><b>${esc(auditLabel(insp, subs))}</b><span class="muted">${[insp.zone ? esc(insp.zone) : '', dateFR(insp.date), `${o.countedThemes} / 19 thèmes notés`].filter(Boolean).join('<br>')}</span></div>
      </div>
      ${done && fnName ? `<div class="sum-thanks">${ic('check', 18)} Audit complet, merci ${esc(fnName)}.</div>` : ''}
      <div class="sum-list">${o.themes.map(t => {
        const w = t.pct === null ? 0 : Math.round(t.pct * 100), r = rating(t.pct);
        return `<a class="sum-row" href="#/insp/${id}/t/${t.theme.ref}">
          <span class="sum-n">${t.theme.ref.replace('.0', '')}</span>
          <span class="sum-main"><b>${esc(t.theme.name)}</b>
            <span class="sum-bar">${t.pct === null ? '' : `<i style="width:${w}%;background:${r.color}"></i>`}</span></span>
          ${t.pct === null ? `<span class="sum-na">${t.total && t.done === t.total ? 'N/A' : '—'}</span>` : `<span class="badge ${tnCls(t.pct)}">${w}%</span>`}</a>`;
      }).join('')}</div>`;
  };
  draw(); firstDraw = false;
  const big = view.querySelector('.score-ring.fill b');
  if (big && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const target = parseFloat(big.firstChild.textContent.replace(',', '.')), t0 = performance.now(), D = 1100;
    const ease = t => 1 - Math.pow(1 - t, 4);
    const step = now => { const t = Math.min(1, (now - t0) / D); big.firstChild.textContent = String(Math.round(target * ease(t) * 10) / 10).replace('.', ','); if (t < 1 && big.isConnected) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  view.addEventListener('input', e => {
    const k = e.target.dataset.k; if (!k) return;
    insp[k] = (k === 'bonus' || k === 'penalty') ? (parseFloat(e.target.value.replace(',', '.')) || 0) : e.target.value;
    save(); draw();
  });
  if ($('#exp')) $('#exp').onclick = () => exportSheet([insp]);
}


// ---------- export ----------
function exportSheet(insps, opts = {}) {
  const name = insps.length === 1 ? insps[0].ref : `PRT-export-${todayISO()}`;
  openSheet(`<h3>Exporter ${insps.length === 1 ? esc(insps[0].ref) : insps.length + ' inspections'}</h3>
    <div style="display:grid;gap:10px">
      <button class="btn block primary" data-x="xlsx">${insps.length === 1 ? 'Excel — fichier PRT d’origine rempli' : 'Excel (.xlsx) — 4 feuilles PRT'}</button>
      ${insps.length === 1 ? '<button class="btn block primary" data-x="pdf">Rapport PDF — personnaliser puis générer</button>' : ''}
      <button class="btn block" data-close>Annuler</button></div>`,
    (el, close) => el.addEventListener('click', async e => {
      const x = e.target.closest('[data-x]')?.dataset.x; if (!x) return;
      if (x === 'pdf') { close(); location.hash = `#/insp/${insps[0].id}/report`; return; }
      el.innerHTML = '<h3>Génération en cours…</h3><p class="muted">Quelques secondes, surtout avec des photos.</p>';
      try {
        const blob = x === 'xlsx' ? await buildXLSX(insps, opts) : await buildPDF(insps[0]);
        close(); readySheet(new File([blob], `${name}.${x}`, { type: blob.type }));
      } catch (err) { console.error(err); close(); toast('Erreur export : ' + err.message, 4000); }
    }));
}
/** Export « données brutes » pour Power BI : des tableaux plats, une ligne = un enregistrement,
 *  1re ligne = en-têtes, dates en vraies dates, scores en nombres (0–1), identifiants pour relier les feuilles. */
async function exportPowerBI() {
  const XLSX = window.XLSX; if (!XLSX) return toast('Excel pas encore chargé, réessayez');
  const admin = cloud.isAdmin();
  const projects = await db.all('projects'), plans = await db.all('plans'), subsL = await db.all('subs');
  const subs = Object.fromEntries(subsL.map(x => [x.id, x]));
  const insps = (admin ? await db.all('inspections') : await pAll('inspections')).filter(i => !i.deleted).sort((a, b) => a.date.localeCompare(b.date));
  const acts = (admin ? await db.all('actions') : await pAll('actions')).filter(a => !a.deleted);
  if (!insps.length) return toast('Aucun audit à exporter');
  const D = iso => iso ? new Date(iso + 'T12:00:00') : null;
  const r3 = v => v === null || v === undefined ? null : Math.round(v * 1000) / 1000;
  const week = iso => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7); const y = new Date(d.getFullYear(), 0, 4); return 1 + Math.round(((d - y) / 864e5 - 3 + (y.getDay() + 6) % 7) / 7); };
  const projName = i => projects.find(p => p.id === pid(i))?.name || '';
  const who = i => i.inspectors || '';
  const crName = ref => criterionOfRef(ref)?.name || ref;
  // 1) Audits : tout l'audit sur une seule ligne (+ une colonne par thème)
  // visite lisible : « 19/11 · Zone B · n°1 » (audits faits ensemble lors d'un même passage)
  const visitLbl = {}, visitN = {};
  for (const i of insps) {
    if (!i.visitId || visitLbl[i.visitId]) continue;
    const base = `${i.date.slice(8, 10)}/${i.date.slice(5, 7)} · ${i.zone || 'Sans zone'}`;
    visitN[base] = (visitN[base] || 0) + 1; visitLbl[i.visitId] = `${base} · n°${visitN[base]}`;
  }
  const auditRows = [];
  for (const i of insps) {
    const o = overallScore(i.scores, i.bonus, i.penalty), st = auditState(i), ids = namedSubs(i, subs);
    const ia = acts.filter(a => a.inspectionId === i.id);
    const row = {
      audit_id: i.id, date: D(i.date), annee: +i.date.slice(0, 4), mois: i.date.slice(0, 7), semaine: week(i.date),
      projet: projName(i), plan: plans.find(p => p.id === i.planId)?.name || '', zone: i.zone || '',
      visite: visitLbl[i.visitId] || '', type_audit: ids.length ? 'Entreprise' : 'Zone',
      entreprise: ids.map(id => subs[id].name).join(', '), type_entreprise: ids.length === 1 ? typeOf(subs[ids[0]]).label : '',
      hse: who(i), statut: ST_TAG[st.st], criteres_notes: st.n, criteres_total: 124,
      score_global: r3(o.pct), bonus: +i.bonus || 0, penalite: +i.penalty || 0,
      infractions: Object.entries(i.scores || {}).filter(([r, x]) => criterionOfRef(r) && typeof x?.v === 'number' && x.v <= 2).length,
      photos: Object.values(i.scores || {}).reduce((t, x) => t + (x?.photos || []).length, 0),
      actions: ia.length, actions_ouvertes: ia.filter(a => a.status !== 'Closed').length, actions_en_retard: ia.filter(isLate).length,
      bonnes_pratiques: (i.goods || []).length, signe: i.signature ? 'Oui' : 'Non', signataire: i.signature?.name || '', reference: i.ref || '',
    };
    for (const t of o.themes) row[`T${String(parseInt(t.theme.ref, 10)).padStart(2, '0')} ${t.theme.name}`] = t.done ? r3(t.pct) : null;
    auditRows.push(row);
  }
  // 2) Critères : une ligne par critère noté (pour les infractions, les thèmes, les tendances)
  const critRows = [];
  for (const i of insps) {
    const ids = namedSubs(i, subs);
    for (const [ref, x] of Object.entries(i.scores || {})) {
      const c = criterionOfRef(ref); if (!c || x?.v === null || x?.v === undefined) continue;
      const th = themeOfRef(ref), na = x.v === NA;
      critRows.push({ audit_id: i.id, date: D(i.date), projet: projName(i), zone: i.zone || '', entreprise: ids.map(id => subs[id].name).join(', '), hse: who(i),
        theme_ref: th.ref, theme: th.name, critere_ref: ref, critere: crName(ref), note: na ? null : x.v, na: na ? 'Oui' : 'Non',
        infraction: !na && x.v <= 2 ? 1 : 0, regle_vitale: /LSR/.test(th.name) ? 'Oui' : 'Non', commentaire: x.c || '', photos: (x.photos || []).length });
    }
  }
  // 3) Actions : une ligne par action corrective
  const actRows = acts.map(a => {
    const i = insps.find(x => x.id === a.inspectionId);
    const late = isLate(a), due = a.dueDate ? D(a.dueDate) : null;
    return { action_id: a.id, audit_id: a.inspectionId || '', date_audit: i ? D(i.date) : null, projet: i ? projName(i) : (projects.find(p => p.id === a.projectId)?.name || ''),
      zone: i?.zone || '', entreprise: subs[a.subId]?.name || '', hse: i ? who(i) : '', critere_ref: a.critRef || '', critere: a.critRef ? crName(a.critRef) : '',
      constat: a.observation || '', action_corrective: a.corrective || '', responsable: a.responsibility || '', priorite: a.priority || '', statut: a.status || '',
      echeance: due, cloturee_le: a.closedAt ? D(a.closedAt) : null, en_retard: late ? 'Oui' : 'Non',
      jours_de_retard: late && due ? Math.max(0, Math.round((Date.now() - due) / 864e5)) : 0, photos_avant: (a.photos || []).length, photos_apres: (a.photosAfter || []).length };
  });
  const wb = XLSX.utils.book_new();
  const add = (rows, name, widths) => {
    const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'dd/mm/yyyy' });
    const keys = Object.keys(rows[0] || {}); ws['!cols'] = keys.map(k => ({ wch: widths?.[k] || Math.min(40, Math.max(10, k.length + 2)) }));
    if (rows.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: keys.length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add(auditRows, 'Audits', { visite: 26, entreprise: 22, hse: 18, projet: 14, zone: 16, reference: 26 });
  add(critRows, 'Criteres', { theme: 30, critere: 40, commentaire: 40, entreprise: 22 });
  if (actRows.length) add(actRows, 'Actions', { constat: 40, action_corrective: 40, critere: 34, entreprise: 22 });
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellDates: true, compression: true });
  readySheet(new File([out], `AuditHSE-donnees-${todayISO()}.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}
function readySheet(file) {
  // Le partage iOS doit être déclenché par un tap : d'où cette 2e étape
  openSheet(`<h3>Fichier prêt</h3><p><b>${esc(file.name)}</b> · ${(file.size / 1024).toFixed(0)} Ko</p>
    <div style="display:grid;gap:10px">
      ${canShareFile(file) ? '<button class="btn block primary" data-s>Partager (Mail, WhatsApp, Teams…)</button>' : ''}
      <button class="btn block" data-d>Télécharger / Enregistrer</button><button class="btn block" data-close>Fermer</button></div>`,
    (el, close) => {
      el.querySelector('[data-s]')?.addEventListener('click', async () => { await shareFile(file); close(); });
      el.querySelector('[data-d]').addEventListener('click', () => { download(file, file.name); close(); });
    });
}

// ---------- actions ----------
const actionFilters = { sub: '', view: 'todo', insp: '', mode: innerWidth < 760 ? 'list' : 'board' }; // téléphone : liste à onglets ; PC : tableau
async function vActions(q) {
  const editable = cloud.can('actions');
  const setHeader = () => setTop({ title: 'Actions', sub: PROJECT?.name || '', back: q.get('insp') ? '#/insp/' + q.get('insp') : null,
    actions: [{ icon: actionFilters.mode === 'board' ? 'list' : 'board', aria: actionFilters.mode === 'board' ? 'Vue liste' : 'Vue tableau', onClick: () => { actionFilters.mode = actionFilters.mode === 'board' ? 'list' : 'board'; draw(); setHeader(); } }] });
  setHeader();
  if (q.has('late')) { actionFilters.view = 'late'; actionFilters.mode = 'list'; setHeader(); }
  actionFilters.insp = q.get('insp') || '';
  const { subs, subList } = await maps();
  const all = await pAll('actions');
  const match = a => (!actionFilters.sub || a.subId === actionFilters.sub) && (!actionFilters.insp || a.inspectionId === actionFilters.insp);
  const views = { todo: a => a.status !== 'Closed', late: isLate, done: a => a.status === 'Closed' };
  const sorter = (a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9') || PRIOS.indexOf(a.priority) - PRIOS.indexOf(b.priority);

  const kcard = a => {
    const s = subs[a.subId], next = STATUSES[STATUSES.indexOf(a.status) + 1];
    return `<div class="kcard prio-${a.priority}" data-id="${a.id}">
      <a class="kcard-main" href="#/action/${a.id}">
        <span class="row" style="gap:6px"><span class="mono xs" style="--c:${esc(s?.color || '#9E9E9E')}">${esc(abbr(s?.name))}</span><span class="prio-txt p-${a.priority}">${PRIO_FR[a.priority] || ''}</span><span class="grow"></span>${dueChip(a)}</span>
        <b>${esc(a.observation || 'Observation à compléter')}</b>
        <span class="muted small ellip">${esc(actionRef(a) || 'Action libre')}</span></a>
      ${editable && next ? `<button class="knext" data-next="${a.id}" aria-label="Passer à ${STATUS_FR[next]}">${STATUS_FR[next]} ${ic('chevron', 16)}</button>` : ''}
    </div>`;
  };

  const draw = () => {
    const f = actionFilters;
    const pool = all.filter(a => !a.deleted && match(a));
    if (f.mode === 'board') {
      $('#abody').innerHTML = `
        ${editable ? `<p class="muted small board-hint">${matchMedia('(pointer: fine)').matches ? 'Glissez une carte vers une autre colonne pour changer son statut' : 'Appui long sur une carte puis glisser vers une autre colonne'} — ou bouton en bas de carte.</p>` : ''}
        <div class="kanban" id="kanban">${STATUSES.map(st => {
          const items = pool.filter(a => a.status === st).sort(sorter);
          return `<section class="kcol" data-st="${st}"><header><i class="kdot st-${st.replace(' ', '')}"></i>${{ Open: 'Ouvertes', 'In progress': 'En cours', Closed: 'Clôturées' }[st]}<em>${items.length}</em></header>
            <div class="kbody">${items.map(kcard).join('') || '<div class="kempty">Aucune action</div>'}</div></section>`;
        }).join('')}</div>`;
      if (editable) enableBoardDrag($('#kanban'), moveAction);
    } else {
      const list = pool.filter(views[f.view]).sort(sorter);
      $('#abody').innerHTML = `
        <div class="tabs3">${[['todo', 'À faire'], ['late', 'En retard'], ['done', 'Clôturées']].map(([k, l]) => `<button data-view="${k}" class="${f.view === k ? 'on' : ''}">${l} <em>${pool.filter(views[k]).length}</em></button>`).join('')}</div>
        ${list.map(a => actionCard(a, subs)).join('') || '<div class="empty">Rien à afficher</div>'}`;
    }
  };
  const moveAction = async (id, status) => {
    const a = all.find(x => x.id === id); if (!a || a.status === status) return;
    a.status = status; if (status === 'Closed') a.closedAt = todayISO();
    await db.put('actions', a); navigator.vibrate?.(20);
    if (status === 'Closed' && !(a.photosAfter || []).length) afterPhotoSheet(async files => { a.photosAfter = await addPhotos(files); await db.put('actions', a); toast('Photo après correction ajoutée'); });
    toast(`Action : ${STATUS_FR[status]}`); draw();
  };
  view.innerHTML = `
    <select class="in" id="f-sub" style="margin-bottom:10px"><option value="">Toutes les entreprises</option>${subList.filter(s => !s.archived).sort((a, b) => a.name.localeCompare(b.name)).map(s => `<option value="${s.id}" ${actionFilters.sub === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
    ${actionFilters.insp ? `<div class="card small row">Actions d’un audit<span class="grow"></span><a href="#/actions">Tout afficher</a></div>` : ''}
    <div id="abody"></div>`;
  draw();
  view.addEventListener('click', e => {
    const v = e.target.closest('[data-view]'); if (v) { actionFilters.view = v.dataset.view; draw(); return; }
    const n = e.target.closest('[data-next]');
    if (n) { const a = all.find(x => x.id === n.dataset.next); moveAction(a.id, STATUSES[STATUSES.indexOf(a.status) + 1]); }
  });
  $('#f-sub').onchange = e => { actionFilters.sub = e.target.value; draw(); };
}

/** Glisser-déposer des cartes entre colonnes : appui long (doigt) ou clic maintenu (souris) */
let boardDragOff = null;
function enableBoardDrag(board, onDrop) {
  let timer = null, drag = null, start = null, scrollTimer = null;
  const colAt = (x, y) => document.elementFromPoint(x, y)?.closest('.kcol');
  // retire toute carte fantôme restante et force Safari à redessiner l'en-tête (sinon une trace peut rester affichée)
  const sweep = () => {
    document.querySelectorAll('.kghost').forEach(g => g.remove());
    board.querySelectorAll('.kdragging, .kover').forEach(c => c.classList.remove('kdragging', 'kover'));
    const tb = document.getElementById('topbar'); if (tb) { tb.style.transform = 'translateZ(0)'; requestAnimationFrame(() => { tb.style.transform = ''; }); }
  };
  const begin = (card, x, y) => {
    if (drag) return;
    sweep();
    const r = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.className = 'kcard kghost ' + [...card.classList].filter(c => c.startsWith('prio-')).join(' ');
    Object.assign(ghost.style, { width: r.width + 'px', left: r.left + 'px', top: r.top + 'px' });
    document.body.appendChild(ghost);
    card.classList.add('kdragging');
    drag = { card, ghost, dx: x - r.left, dy: y - r.top, from: card.closest('.kcol') };
    navigator.vibrate?.(25);
  };
  const move = (x, y) => {
    drag.ghost.style.left = x - drag.dx + 'px'; drag.ghost.style.top = y - drag.dy + 'px';
    drag.ghost.style.display = 'none'; const col = colAt(x, y); drag.ghost.style.display = '';
    board.querySelectorAll('.kcol').forEach(c => c.classList.toggle('kover', c === col && c !== drag.from));
    // défilement horizontal automatique près des bords
    clearInterval(scrollTimer);
    const w = window.innerWidth;
    if (x < 36 || x > w - 36) scrollTimer = setInterval(() => { board.scrollLeft += x < 36 ? -14 : 14; }, 16);
  };
  const end = (x, y) => {
    clearInterval(scrollTimer);
    drag.ghost.style.display = 'none';
    const col = colAt(x, y);
    const id = drag.card.dataset.id; drag = null; sweep();
    if (col && col.dataset.st) onDrop(id, col.dataset.st);
  };
  const cancel = () => { clearTimeout(timer); timer = null; };
  // --- doigt (iPhone) : appui long 300 ms, puis glisser
  board.addEventListener('touchstart', e => {
    const card = e.target.closest('.kcard'); if (!card || e.target.closest('.knext') || e.touches.length > 1) return;
    const t = e.touches[0]; start = { x: t.clientX, y: t.clientY };
    timer = setTimeout(() => { timer = null; begin(card, start.x, start.y); }, 300);
  }, { passive: true });
  const tMove = e => {
    const t = e.touches[0];
    if (drag) { e.preventDefault(); move(t.clientX, t.clientY); return; }
    if (timer && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 8) cancel(); // c'est un défilement
  };
  // fin du geste écoutée sur toute la page : si la carte a été redessinée pendant le glisser,
  // iOS n'envoie plus l'événement au tableau et la carte fantôme restait bloquée à l'écran
  const tEnd = e => { cancel(); if (drag) { e.preventDefault(); const t = e.changedTouches[0]; end(t.clientX, t.clientY); } };
  const tCancel = () => { cancel(); clearInterval(scrollTimer); drag = null; sweep(); };
  // nouveau toucher alors qu'un glisser est encore « ouvert » (fin manquée) : on nettoie
  const tStartAny = e => { if (drag && e.touches.length === 1) tCancel(); };
  boardDragOff?.(); // tableau redessiné : on retire les écouteurs du précédent (et tout glisser en cours)
  document.addEventListener('touchmove', tMove, { passive: false });
  document.addEventListener('touchend', tEnd, { passive: false });
  document.addEventListener('touchcancel', tCancel);
  document.addEventListener('touchstart', tStartAny, { capture: true, passive: true });
  const off = () => { tCancel(); document.removeEventListener('touchmove', tMove); document.removeEventListener('touchend', tEnd); document.removeEventListener('touchcancel', tCancel); document.removeEventListener('touchstart', tStartAny, { capture: true }); if (boardDragOff === off) boardDragOff = null; };
  boardDragOff = off; onCleanup(off);
  // l'app passe en arrière-plan ou le doigt se lève hors du tableau : on nettoie
  const lost = () => { cancel(); clearInterval(scrollTimer); if (drag) { drag = null; sweep(); } };
  window.addEventListener('pagehide', lost); document.addEventListener('visibilitychange', lost);
  onCleanup(() => { lost(); window.removeEventListener('pagehide', lost); document.removeEventListener('visibilitychange', lost); });
  board.addEventListener('contextmenu', e => { if (e.target.closest('.kcard')) e.preventDefault(); });
  // --- souris (ordinateur)
  board.addEventListener('mousedown', e => {
    const card = e.target.closest('.kcard'); if (!card || e.button !== 0 || e.target.closest('.knext')) return;
    start = { x: e.clientX, y: e.clientY };
    const onMove = ev => { if (!drag && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) begin(card, start.x, start.y); if (drag) { ev.preventDefault(); move(ev.clientX, ev.clientY); } };
    const onUp = ev => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); if (drag) { end(ev.clientX, ev.clientY); suppressClick = true; setTimeout(() => { suppressClick = false; }, 50); } };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  });
  let suppressClick = false;
  board.addEventListener('click', e => { if (suppressClick) { e.preventDefault(); e.stopPropagation(); } }, true);
  board.addEventListener('dragstart', e => e.preventDefault());
}

/** Envoie une action à l'entreprise (WhatsApp, mail, Teams…) avec la photo du constat */
/** Photos du constat préparées à l'avance : sur iPhone, le partage doit partir dès le tap */
async function actionFiles(a) {
  const files = [];
  for (const id of (a.photos || []).slice(0, 3)) { const b = await db.getBlob(id); if (b) files.push(new File([b], `constat-${files.length + 1}.jpg`, { type: 'image/jpeg' })); }
  return files;
}
async function shareAction(a, subs, files = []) {
  const s = subs[a.subId];
  const lines = [
    `Action corrective HSE — ${s?.name || 'Chantier'}${PROJECT ? ' · ' + PROJECT.name : ''}`,
    `Priorité : ${PRIO_FR[a.priority] || a.priority} · Échéance : ${dateFR(a.dueDate)}`,
    '', a.observation ? `Constat : ${a.observation}` : '', `Action demandée : ${a.corrective || 'à définir'}`,
    a.critRef ? `Réf. PRT : ${a.critRef} ${CRIT_FR[a.critRef] || criterionOfRef(a.critRef)?.name || ''}` : (a.reference ? `Réf. : ${a.reference}` : ''), '', 'Merci de confirmer la correction (photo) au service HSE.',
  ].filter((l, i, arr) => l !== '' || arr[i - 1] !== '').join('\n');
  try {
    if (navigator.share) {
      // certaines apps (WhatsApp) ignorent le texte quand il y a une photo : il est aussi copié, prêt à coller
      if (files.length && navigator.canShare?.({ files, text: lines })) { navigator.clipboard?.writeText(lines).catch(() => {}); await navigator.share({ text: lines, files }); }
      else await navigator.share({ text: lines });
      return;
    }
  } catch (e) { if (e.name === 'AbortError') return; }
  const phone = (s?.phone || '').replace(/[^\d]/g, '');
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(lines)}`, '_blank');
}
/** Clôture : proposer la photo « après correction » (le bouton est un vrai champ fichier, compatible iPhone) */
function afterPhotoSheet(onFiles) {
  openSheet(`<h3>Action clôturée</h3><p class="muted">Ajoutez une photo après correction : elle apparaîtra dans le rapport à côté du constat.</p>
    <div style="display:grid;gap:10px"><label class="btn primary block">${ic('camera')} Photo après correction<input type="file" accept="image/*" class="hidden-input" id="aft-in"></label>
    <button class="btn block" data-close>Plus tard</button></div>`,
  (el, close) => el.querySelector('#aft-in').onchange = e => { close(); onFiles(e.target.files); });
}

async function vAction(id) {
  const a = await db.get('actions', id);
  if (!a || a.deleted) return vNotFound();
  const { subs, subList, plans } = await maps();
  const insp = a.inspectionId ? await db.get('inspections', a.inspectionId) : null;
  setTop({ title: 'Action corrective', sub: PRIO_FR[a.priority] ? 'Priorité ' + PRIO_FR[a.priority].toLowerCase() : '', back: true });
  const save = debounce(() => db.put('actions', a), 300);
  onCleanup(() => save.flush());
  const crit = a.critRef ? criterionOfRef(a.critRef) : null;
  view.innerHTML = `
    <div class="card act-head prio-${a.priority}">
      <div class="row wrap">${subChip(subs[a.subId])}${dueChip(a)}</div>
      <div class="act-head-title">${esc(a.observation || 'Observation à compléter')}</div>
      <div class="muted small">${crit ? `<a href="#/insp/${a.inspectionId}/t/${themeOfRef(a.critRef).ref}">${esc(actionRef(a))}</a>` : 'Action libre'}${insp ? ` · <a href="#/insp/${insp.id}">audit du ${dateFR(insp.date)}</a>` : ''}</div>
      <div class="seg status-seg" data-seg="status" style="margin-top:12px">${STATUSES.map(s => `<button type="button" data-val="${s}" class="${a.status === s ? 'on' : ''}">${STATUS_FR[s]}</button>`).join('')}</div>
      <button class="btn block send-btn" id="a-send">${ic('share')} Envoyer à l’entreprise</button>
    </div>

    <div class="section-head"><span>Constat</span></div>
    <div class="card">
      <label class="f" style="margin-top:0">Observation</label><textarea class="in" data-k="observation" placeholder="Ce qui a été constaté">${esc(a.observation)}</textarea>
      <label class="f">Priorité</label><div class="seg prio-seg" data-seg="priority">${PRIOS.map(p => `<button type="button" data-val="${p}" data-p="${p}" class="${a.priority === p ? 'on' : ''}">${PRIO_FR[p]}</button>`).join('')}</div>
      <label class="f">Photos</label>
      <label class="btn block">${ic('camera')} Ajouter une photo<input type="file" accept="image/*" class="hidden-input" id="a-photo" multiple></label>
      <div class="thumbs" id="a-thumbs"></div>
      ${crit ? '' : `<label class="f">Critère PRT concerné</label><select class="in" data-k="critRef"><option value="">—</option>${THEMES.map(t => `<optgroup label="${esc(t.ref + ' ' + t.name)}">${t.criteria.map(c => `<option value="${c.ref}" ${a.critRef === c.ref ? 'selected' : ''}>${c.ref} ${esc(c.name)}</option>`).join('')}</optgroup>`).join('')}</select>`}
    </div>

    <div class="section-head"><span>Suivi</span></div>
    <div class="card">
      <label class="f" style="margin-top:0">Action corrective demandée</label><textarea class="in" data-k="corrective" placeholder="Ce que l’entreprise doit faire">${esc(a.corrective)}</textarea>
      <label class="f">Responsable</label><input class="in" data-k="responsibility" value="${esc(a.responsibility)}">
      <div class="btns" style="margin-bottom:0">
        <div><label class="f">Échéance</label><input class="in" type="date" data-k="dueDate" value="${esc(a.dueDate || '')}"></div>
        <div><label class="f">Entreprise</label><select class="in" data-k="subId"><option value="" ${!a.subId ? 'selected' : ''}>Générale</option>${subList.map(s => `<option value="${s.id}" ${s.id === a.subId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      </div>
    </div>

    <div id="after-sec" ${a.status === 'Closed' || (a.photosAfter || []).length ? '' : 'hidden'}><div class="section-head"><span>Après correction</span><span class="muted small">${(a.photosAfter || []).length || ''}</span></div>
    <div class="card">
      <label class="btn block">${ic('camera')} Photo après correction<input type="file" accept="image/*" class="hidden-input" id="a-after"></label>
      <div class="thumbs" id="a-after-thumbs"></div>
    </div></div>

    <div class="section-head"><span>Emplacement</span><span class="muted small">${a.planId ? esc(plans[a.planId]?.name || '') : ''}</span></div>
    ${a.planId && plans[a.planId] ? `<div id="a-plan" class="pv plan-box" style="height:38vh"></div>
      <div class="plan-legend"><span><i class="lg-zone"></i>Zone auditée${insp?.zone ? ' · ' + esc(insp.zone) : ''}</span><span><i class="lg-act">!</i>Cette action</span></div>
      <button class="btn block" id="mv" style="margin-top:8px">${a.pin ? 'Déplacer l’épingle' : 'Placer l’épingle'}</button>` : '<div class="muted">Aucun plan lié</div>'}
    <button class="btn danger block" id="del" style="margin-top:20px">${ic('trash')} Supprimer l’action</button>
    <p class="muted small" style="text-align:center">Enregistrement automatique</p>`;

  if (!isMine(a)) view.insertAdjacentHTML('afterbegin', `<div class="card muted small ro-note">${ic('check', 16)} Action relevée par un autre HSE — consultation seule.</div>`);
  if (!cloud.can('actions') || !isMine(a)) { // lecture seule (droits, ou action d'un autre HSE)
    view.querySelectorAll('input, textarea, select, .seg button').forEach(el => { el.disabled = true; });
    ['#del', '#mv'].forEach(sel => view.querySelector(sel)?.remove());
    view.querySelectorAll('label.btn').forEach(el => el.remove());
  }
  const drawThumbs = async () => { $('#a-thumbs').innerHTML = await thumbsHTML(a.photos); $('#a-after-thumbs').innerHTML = await thumbsHTML(a.photosAfter); };
  drawThumbs();
  const addAfter = async files => { const as = $('#after-sec'); if (as) as.hidden = false; toast('Compression…'); a.photosAfter = [...(a.photosAfter || []), ...await addPhotos(files)]; save.flush(); drawThumbs(); toast('Photo après correction ajoutée'); };
  let shareFiles = [];
  const sharePh = (await getSettings()).sharePhotos !== false;
  if (sharePh) actionFiles(a).then(f => { shareFiles = f; });
  $('#a-send').onclick = () => shareAction(a, subs, shareFiles);
  view.addEventListener('input', e => {
    const k = e.target.dataset.k; if (!k) return;
    a[k] = e.target.value; save();
  });
  view.addEventListener('change', async e => {
    if (e.target.dataset.k === 'subId') { a.subId = e.target.value; save.flush(); render(); return; }
    if (e.target.id === 'a-after') { await addAfter(e.target.files); e.target.value = ''; return; }
    if (e.target.id !== 'a-photo') return;
    toast('Compression…'); a.photos = [...(a.photos || []), ...await addPhotos(e.target.files)]; save.flush(); drawThumbs(); e.target.value = '';
    if (sharePh) actionFiles(a).then(f => { shareFiles = f; });
  });
  view.addEventListener('click', async e => {
    const sb = e.target.closest('[data-seg] [data-val]');
    if (sb && !sb.disabled) {
      const key = sb.closest('[data-seg]').dataset.seg;
      a[key] = sb.dataset.val;
      sb.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === sb));
      if (key === 'status') { const as = $('#after-sec'); if (as) as.hidden = a.status !== 'Closed' && !(a.photosAfter || []).length; }
      if (key === 'status' && a.status === 'Closed') { a.closedAt = todayISO(); if (!(a.photosAfter || []).length && cloud.can('actions')) afterPhotoSheet(addAfter); }
      save.flush();
      const head = view.querySelector('.act-head');
      head.className = 'card act-head prio-' + a.priority;
      const due = head.querySelector('.due'); if (due) due.outerHTML = dueChip(a);
      return;
    }
    const ph = e.target.closest('[data-photo]');
    if (ph) photoViewer(ph.dataset.photo, readOnly ? null : async () => { a.photos = (a.photos || []).filter(p => p !== ph.dataset.photo); a.photosAfter = (a.photosAfter || []).filter(p => p !== ph.dataset.photo); await db.deleteBlob(ph.dataset.photo); save.flush(); drawThumbs(); }, readOnly ? null : async nid => {
      const old = ph.dataset.photo; a.photos = (a.photos || []).map(p => p === old ? nid : p); a.photosAfter = (a.photosAfter || []).map(p => p === old ? nid : p);
      save.flush(); drawThumbs(); if (sharePh) actionFiles(a).then(f => { shareFiles = f; }); db.deleteBlob(old).catch(() => {});
    });
  });
  const readOnly = !cloud.can('actions') || !isMine(a);
  if ($('#del')) $('#del').onclick = async () => { if (await confirmBox('Supprimer cette action ?', '')) { await db.remove('actions', id); history.back(); } };

  if (a.planId && plans[a.planId]) {
    let moving = false;
    const color = subs[a.subId]?.color;
    const sameP = insp && insp.planId === a.planId;
    const iz = insp && !subIdsOf(insp).length;
    const hasArea = sameP && insp.area?.pts?.length > 2;
    const pins = () => [...(sameP && insp.pin && !hasArea ? [{ id: 'i', ...insp.pin, color: iz ? '#0B2D5B' : (subs[insp.subId]?.color || color), label: iz ? 'ZON' : abbr(subs[insp.subId]?.name) }] : []), ...(a.pin ? [{ id: 'a', ...a.pin, label: '!', kind: 'action', ghost: moving }] : [])];
    const pv = createPlanViewer($('#a-plan'), {
      imageURL: await db.blobURL(plans[a.planId].blobId), pins: pins(), focus: a.pin || insp?.pin,
      areas: hasArea ? [{ id: 'ia', pts: insp.area.pts, kind: 'area', color: '#1A56A8' }] : [], // le nom est dans la légende : rien ne passe sous l'épingle
      onTap: (x, y) => { if (!moving) return; a.pin = { x, y }; moving = false; $('#mv').textContent = 'Déplacer l’épingle'; $('#mv').classList.remove('primary'); pv.setPins(pins()); save.flush(); toast('Épingle déplacée'); },
    });
    onCleanup(() => pv.destroy());
    if (hasArea) setTimeout(() => pv.focusArea([...insp.area.pts, ...(a.pin ? [a.pin] : [])]), 200);
    if ($('#mv')) $('#mv').onclick = e => { moving = !moving; e.target.textContent = moving ? 'Tapez l’emplacement sur le plan…' : (a.pin ? 'Déplacer l’épingle' : 'Placer l’épingle'); e.target.classList.toggle('primary', moving); pv.setPins(pins()); };
  }
}

// ---------- carte / plan ----------
const mapF = { view: 'audits', period: 30, sub: '' };
async function vMap(q) {
  view.classList.add('full', 'map-page');
  const { subs, subList, plans, planList } = await maps();
  setTop({ title: 'Plan', sub: plans[await db.getMeta('lastPlan')]?.name || '' });
  if (!planList.length) { view.classList.remove('full', 'map-page'); view.innerHTML = `<div class="empty">Aucun plan.<br><br><a class="btn primary" href="#/plans">Importer un plan</a></div>`; return; }
  const planId = q.get('plan') && plans[q.get('plan')] ? q.get('plan') : (plans[await db.getMeta('lastPlan')] ? await db.getMeta('lastPlan') : planList[0].id);
  await db.setMeta('lastPlan', planId);
  const onlyInsp = q.get('insp'), onlyTeam = q.get('team');
  const [insps, acts] = await Promise.all([pAll('inspections'), pAll('actions')]);
  const team = cloud.can('team') ? (await cloud.teamAudits()).filter(a => (!PROJECT || a.projectId === PROJECT.id)) : [];
  const active = subList.filter(s => !s.archived).sort((a, b) => a.name.localeCompare(b.name));
  const pctOf = i => overallScore(i.scores, i.bonus, i.penalty).pct;
  const VIEWS = [['audits', 'Audits'], ['actions', 'Actions'], ['zones', 'Zones · score']];
  view.innerHTML = `
    <div class="map-bar">
      ${onlyInsp || onlyTeam ? `<div class="map-only"><span class="grow"><b>Un seul audit affiché</b></span><a class="btn small-btn" href="#/map?plan=${planId}">Tout afficher</a></div>` : `
      <div class="seg map-views">${VIEWS.map(([k, l]) => `<button data-mv="${k}" class="${mapF.view === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="map-sels">
        <select class="in f-sel" id="m-per">${[[7, '7 jours'], [30, '30 jours'], [90, '3 mois'], [0, 'Depuis le début']].map(([v, l]) => `<option value="${v}" ${mapF.period === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select class="in f-sel ${mapF.sub ? 'set' : ''}" id="m-sub"><option value="">Entreprises</option>${active.map(s => `<option value="${s.id}" ${mapF.sub === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        ${planList.length > 1 ? `<select class="in f-sel" id="m-plan">${planList.map(p => `<option value="${p.id}" ${p.id === planId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
      </div>`}
    </div>
    <div id="map" class="pv map-fill"></div>
    <div class="map-key" id="m-key"></div>`;
  // le plan occupe exactement la place restante (la barre de filtres peut faire 1 ou 2 lignes)
  const sizeMap = () => {
    const m = $('#map'); if (!m) return;
    const tb = document.getElementById('tabbar')?.getBoundingClientRect();
    const bottom = tb && tb.top > innerHeight / 2 ? innerHeight - tb.top : 0;
    m.style.height = Math.max(260, innerHeight - m.getBoundingClientRect().top - window.scrollY * 0 - bottom - 2) + 'px';
  };
  sizeMap(); addEventListener('resize', sizeMap); onCleanup(() => removeEventListener('resize', sizeMap));

  const since = () => mapF.period ? todayISO(-mapF.period) : '0000';
  const visible = () => insps.filter(i => i.planId === planId && (onlyInsp ? i.id === onlyInsp : !onlyTeam && i.date >= since() && (!mapF.sub || hasSub(i, mapF.sub))));
  const areaKey = i => i.area?.pts?.length > 2 ? 'a:' + (i.area.zoneId || JSON.stringify(i.area.pts)) : null;
  /** « lieux » : une zone tracée (toutes les tournées qui y ont eu lieu), ou une tournée / un audit placé par une épingle */
  const places = () => {
    const m = new Map();
    for (const i of visible()) {
      if (!i.pin && !areaKey(i)) continue;
      const k = areaKey(i) || 'v:' + (i.visitId || i.id);
      const e = m.get(k) || { k, list: [], area: null, pin: null };
      e.list.push(i);
      if (!e.area && areaKey(i)) e.area = i.area;
      if (!subIdsOf(i).length && i.pin) e.pin = i.pin; else e.pin ||= i.pin;
      m.set(k, e);
    }
    return [...m.values()].map(e => {
      e.list.sort((a, b) => (b.date + (b.updatedAt || '')).localeCompare(a.date + (a.updatedAt || '')));
      e.zone = e.list.find(i => i.zone)?.zone || e.area?.name || '';
      // score de la zone : dernier audit noté
      const lastScored = e.list.find(i => pctOf(i) !== null); e.pct = lastScored ? pctOf(lastScored) : null;
      const comp = e.list.filter(i => subIdsOf(i).length);
      e.n = Math.max(1, comp.length); return e;
    });
  };
  const planZones = () => plans[planId].zones || [];
  const computeAreas = () => {
    const ps = places(), used = new Set(ps.map(e => e.area?.zoneId).filter(Boolean));
    const zonesView = mapF.view === 'zones';
    const out = planZones().filter(z => !used.has(z.id)).map(z => ({ id: 'z:' + z.id, pts: z.pts, kind: 'zone', label: zonesView ? z.name : '', color: '#607D8B' }));
    if (mapF.view === 'actions' && !onlyInsp) return out;
    for (const e of ps) if (e.area) {
      const one = e.list.length === 1 ? e.list[0] : null;
      const color = zonesView ? (e.pct === null ? '#9E9E9E' : rating(e.pct).color) : one && subIdsOf(one).length ? auditColor(one, subs) : '#1A56A8';
      const label = zonesView ? `${e.zone || 'Zone'} · ${e.pct === null ? '—' : Math.round(e.pct * 100) + ' %'}` : `${e.zone || 'Zone'}${e.list.length > 1 ? ' · ' + e.list.length : ''}`;
      out.push({ id: 'p:' + e.k, pts: e.area.pts, kind: zonesView ? 'score' : 'area', color, label, tap: true });
    }
    team.filter(a => !onlyInsp && a.planId === planId && a.area?.pts && (onlyTeam ? a.id === onlyTeam : a.date >= since() && (!mapF.sub || (a.subIds || []).includes(mapF.sub))))
      .forEach(a => out.push({ id: 'ta:' + a.id, pts: a.area.pts, kind: 'team', color: teamColor(a, subs) }));
    return out;
  };
  const computePins = () => {
    const out = [];
    if (onlyInsp) {
      insps.filter(i => i.id === onlyInsp && i.pin && !areaKey(i)).forEach(i => out.push({ id: 'i:' + i.id, ...i.pin, color: auditColor(i, subs), label: auditAbbr(i, subs) }));
      acts.filter(a => a.planId === planId && a.pin && a.inspectionId === onlyInsp).forEach(a => out.push({ id: 'a:' + a.id, ...a.pin, label: '!', kind: 'action' }));
      return out;
    }
    if (mapF.view === 'actions') {
      acts.filter(a => a.planId === planId && a.pin && a.status !== 'Closed' && (!mapF.sub || a.subId === mapF.sub))
        .forEach(a => out.push({ id: 'a:' + a.id, ...a.pin, label: '!', kind: 'action' }));
      return out;
    }
    for (const e of places()) if (!e.area && e.pin) {
      const one = e.list.length === 1 ? e.list[0] : null;
      if (mapF.view === 'zones') out.push({ id: 'p:' + e.k, ...e.pin, fixed: true, color: e.pct === null ? '#9E9E9E' : rating(e.pct).color, label: e.pct === null ? '—' : Math.round(e.pct * 100) });
      else out.push({ id: one ? 'i:' + one.id : 'p:' + e.k, ...e.pin, fixed: !one, count: e.list.length, color: one ? auditColor(one, subs) : '#0B2D5B', label: one ? auditAbbr(one, subs) : String(e.list.length) });
    }
    if (mapF.view === 'audits') team.filter(a => a.planId === planId && a.pin && !a.area?.pts && (onlyTeam ? a.id === onlyTeam : a.date >= since() && (!mapF.sub || (a.subIds || []).includes(mapF.sub))))
      .forEach(a => out.push({ id: 't:' + a.id, ...a.pin, fixed: true, color: teamColor(a, subs), label: (a.subIds || []).length === 1 ? abbr(subs[a.subIds[0]]?.name) : 'ZON', ghost: true }));
    return out;
  };
  const drawKey = () => {
    const ps = places(), nA = ps.reduce((a, e) => a + e.list.length, 0);
    const nAct = acts.filter(a => a.planId === planId && a.pin && a.status !== 'Closed' && (!mapF.sub || a.subId === mapF.sub)).length;
    const k = $('#m-key'); if (!k) return;
    k.innerHTML = onlyInsp || onlyTeam ? '' : mapF.view === 'zones'
      ? `${RATINGS.map((r, k) => `<span><i style="background:${r.color}"></i>${['≥ 90 %', '80–89', '70–79', '50–69', '< 50 %'][k]}</span>`).join('')}<span><i style="background:#9E9E9E"></i>non noté</span>`
      : mapF.view === 'actions' ? `<span><i class="k-act">!</i>${nAct} action${nAct > 1 ? 's' : ''} ouverte${nAct > 1 ? 's' : ''}</span>`
      : `<span><b>${nA}</b> audit${nA > 1 ? 's' : ''} · ${ps.length} lieu${ps.length > 1 ? 'x' : ''}</span><span class="muted">bulle = audits regroupés · touchez pour zoomer</span>`;
  };
  const placeSheet = k => {
    const e = places().find(x => x.k === k); if (!e) return;
    openSheet(`<h3>${esc(e.zone || 'Lieu')}</h3>
      <div class="row"><span class="grow muted">${e.list.length} audit${e.list.length > 1 ? 's' : ''} sur la période${e.pct === null ? '' : ' · dernier score'}</span>${e.pct === null ? '' : badge(e.pct)}</div>
      <div class="place-list">${inspList(e.list, subs)}</div>
      <button class="btn block" data-close style="margin-top:10px">Fermer</button>`, el => el.querySelectorAll('a').forEach(a => a.setAttribute('data-close', '')));
  };
  const pv = createPlanViewer($('#map'), {
    imageURL: await db.blobURL(plans[planId].blobId), pins: computePins(), areas: computeAreas(), cover: 6, cluster: !onlyInsp,
    focus: onlyInsp ? (insps.find(i => i.id === onlyInsp)?.pin) : onlyTeam ? team.find(a => a.id === onlyTeam)?.pin : null,
    onPinTap: p => p.id.startsWith('t:') ? teamSheet(team.find(a => a.id === p.id.slice(2)), subs) : p.id.startsWith('p:') ? placeSheet(p.id.slice(2)) : pinSheet(p.id, { subs, insps, acts }),
    onZoneTap: (z, x, y) => z.id.startsWith('p:') ? placeSheet(z.id.slice(2)) : z.id.startsWith('ta:') ? teamSheet(team.find(a => a.id === z.id.slice(3)), subs) : newObservationHere(planId, { x, y }, subList),
    // appui long sur une épingle puis glisser : on la déplace
    onPinMove: cloud.can('actions') ? async (p, x, y) => {
      const [kind, id] = p.id.split(':');
      const rec = kind === 'i' ? insps.find(i => i.id === id) : acts.find(a => a.id === id);
      if (!rec) return;
      rec.pin = { x, y }; await db.put(kind === 'i' ? 'inspections' : 'actions', rec);
      toast('Épingle déplacée');
    } : null,
    onTap: (x, y) => newObservationHere(planId, { x, y }, subList),
  });
  onCleanup(() => pv.destroy());
  if (onlyInsp) { const ia = insps.find(i => i.id === onlyInsp)?.area?.pts; if (ia) setTimeout(() => pv.focusArea(ia), 150); }
  const redraw = () => { pv.setPins(computePins()); pv.setAreas(computeAreas()); drawKey(); };
  drawKey();
  view.querySelector('.map-views')?.addEventListener('click', e => {
    const b = e.target.closest('[data-mv]'); if (!b) return;
    mapF.view = b.dataset.mv; view.querySelectorAll('[data-mv]').forEach(x => x.classList.toggle('on', x === b));
    $('#m-per').disabled = mapF.view === 'actions'; redraw();
  });
  if ($('#m-per')) { $('#m-per').disabled = mapF.view === 'actions'; $('#m-per').onchange = e => { mapF.period = +e.target.value; redraw(); }; }
  $('#m-sub')?.addEventListener('change', e => { mapF.sub = e.target.value; e.target.classList.toggle('set', !!mapF.sub); redraw(); });
  $('#m-plan')?.addEventListener('change', e => { location.hash = '#/map?plan=' + e.target.value; });
}
function pinSheet(pid, { subs, insps, acts }) {
  const [kind, id] = pid.split(':');
  if (kind === 'i') {
    const i = insps.find(x => x.id === id); const o = overallScore(i.scores, i.bonus, i.penalty);
    openSheet(`<h3>${esc(auditLabel(i, subs))}</h3><div class="row"><span class="grow muted">${dateFR(i.date)} · ${esc(i.inspectors || '')}</span>${badge(o.pct)}</div>
      ${i.zone ? `<p>${esc(i.zone)}</p>` : ''}
      <div class="btns"><a class="btn primary" href="#/insp/${i.id}" data-close>Ouvrir l’audit</a><button class="btn" data-close>Fermer</button></div>`);
  } else {
    const a = acts.find(x => x.id === id);
    openSheet(`<h3>Action — priorité ${esc((PRIO_FR[a.priority] || '').toLowerCase())}</h3>${actionCard(a, subs)}
      <div class="btns"><a class="btn primary" href="#/action/${a.id}" data-close>Ouvrir</a><button class="btn" data-close>Fermer</button></div>`);
  }
}
function newObservationHere(planId, pin, subList) {
  const active = subList.filter(s => !s.archived);
  if (!active.length) { toast('Ajoutez d’abord une entreprise'); return; }
  openSheet(`<h3>Nouvelle action à cet endroit</h3><p class="muted">Choisissez l’entreprise concernée :</p>
    <div class="sub-pick">${active.map(s => `<button data-s="${s.id}"><span class="dot" style="background:${esc(s.color)};width:26px;height:26px"></span>${esc(s.name)}</button>`).join('')}</div>
    <button class="btn block" data-close style="margin-top:10px">Annuler</button>`,
    (el, close) => el.addEventListener('click', async e => {
      const b = e.target.closest('[data-s]'); if (!b) return;
      close();
      const a = await createAction(null, { subId: b.dataset.s, planId, pin });
      location.hash = '#/action/' + a.id;
    }));
}

// ---------- sous-traitants ----------
let showArchived = false;
// ---------- onglet Audits : par date / par sous-traitant ----------
let auditSub = '';
/** Onglets de la page Audits (+ « Équipe » pour un HSE qui a le droit d'aperçu) */
const auditTabs = on => {
  const tabs = [['date', '#/audits', 'Par date'], ['sub', '#/subs', 'Par entreprise'], ...(cloud.can('team') ? [['team', '#/audits-team', 'Équipe']] : [])];
  return `<div class="tabs3 ${tabs.length === 2 ? 'two' : ''}">${tabs.map(([k, h, l]) => `<a class="${k === on ? 'on' : ''}" href="${h}">${l}</a>`).join('')}</div>`;
};
/** Aperçu d'un audit d'un autre HSE : chiffres et lieu, sans le détail */
const teamLabel = (a, subs) => { const n = (a.subIds || []).map(id => subs[id]?.name).filter(Boolean); return n.length ? n.join(' + ') : a.zone ? `Zone · ${a.zone}` : 'Audit de zone'; };
const teamColor = (a, subs) => (a.subIds || []).length === 1 ? subs[a.subIds[0]]?.color || '#607D8B' : '#607D8B';
function teamCard(a, subs) {
  return `<button type="button" class="card link insp-card team-card" data-team="${a.id}" style="--c:${esc(teamColor(a, subs))}">
    <div class="grow"><b class="insp-sub">${esc(teamLabel(a, subs))}</b>
      <div class="insp-meta">${esc(a.inspectors || 'HSE')} · ${dateFR(a.date)} · ${a.done || 0}/124 critères</div>
      ${a.zone ? `<div class="insp-loc">${ic('pin', 14)} ${esc(a.zone)}</div>` : ''}</div>
    ${a.pct === null || a.pct === undefined ? '<span class="badge none">—</span>' : badge(a.pct)}</button>`;
}
function teamSheet(a, subs) {
  openSheet(`<h3>${esc(teamLabel(a, subs))}</h3>
    <div class="row"><span class="grow muted">${dateFR(a.date)} · ${esc(a.inspectors || 'HSE')}</span>${a.pct === null || a.pct === undefined ? '' : badge(a.pct)}</div>
    ${a.zone ? `<p>${ic('pin', 16)} ${esc(a.zone)}</p>` : ''}
    <p class="muted small">${a.done || 0}/124 critères notés · aperçu de l’équipe : le détail reste visible par l’auteur et l’administrateur.</p>
    <div class="btns">${a.planId && (a.pin || a.area) ? `<a class="btn" href="#/map?plan=${a.planId}&team=${a.id}" data-close>${ic('map', 18)} Voir sur le plan</a>` : ''}<button class="btn primary" data-close>Fermer</button></div>`);
}
async function vTeamAudits() {
  if (!cloud.can('team')) return vNotFound();
  setTop({ title: 'Audits', sub: 'Aperçu de l’équipe' });
  const { subs } = await maps();
  const list = (await cloud.teamAudits()).filter(a => !PROJECT || a.projectId === PROJECT.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const today = todayISO(), week = todayISO(-7), month = todayISO(-31);
  const groups = [['Aujourd’hui', a => a.date === today], ['Cette semaine', a => a.date < today && a.date >= week], ['Ce mois-ci', a => a.date < week && a.date >= month], ['Plus ancien', a => a.date < month]];
  view.innerHTML = `${auditTabs('team')}
    <p class="muted small" style="margin:0 2px 10px">Audits des autres HSE : date, zone, entreprise et score. Le détail reste chez leur auteur.</p>
    ${groups.map(([label, f]) => { const g = list.filter(f); return g.length ? `<div class="section-head"><span>${label}</span><span class="muted small">${g.length}</span></div>${g.map(a => teamCard(a, subs)).join('')}` : ''; }).join('') || '<div class="empty">Aucun audit de l’équipe pour le moment.</div>'}`;
  view.addEventListener('click', e => { const b = e.target.closest('[data-team]'); if (b) teamSheet(list.find(a => a.id === b.dataset.team), subs); });
}
// HSE : un même nom tapé différemment (« jean » / « Jean ») = une seule personne
const hseKey = n => (n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const hseSplit = s => (s || '').split(/\s*(?:,|;|\/|&|\bet\b)\s*/i).map(x => x.trim()).filter(Boolean);
const titleCase = n => n.replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
/** Nom d'affichage : la variante écrite avec majuscule la plus fréquente */
function hseNames(list, namesOf) {
  const m = new Map();
  list.forEach(i => [...new Set(namesOf(i))].forEach(n => { const k = hseKey(n); if (!k) return; const e = m.get(k) || { k, v: new Map(), l: [] }; e.v.set(n, (e.v.get(n) || 0) + 1); e.l.push(i); m.set(k, e); }));
  return [...m.values()].map(e => { const v = [...e.v.entries()].sort((a, b) => (/\p{Lu}/u.test(b[0]) - /\p{Lu}/u.test(a[0])) || b[1] - a[1])[0][0]; return { k: e.k, n: /\p{Lu}/u.test(v) ? v : titleCase(v), l: e.l }; });
}
const auditF = { q: '', st: '', sub: '', hse: '' };
const openMonths = new Set();
const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
async function vAudits(q) {
  // en haut à droite : Excel d'un toucher, et le Pilotage (admin)
  setTop({ title: 'Audits', actions: [
    ...(cloud.isAdmin() ? [{ icon: 'chart', aria: 'Pilotage', onClick: () => location.hash = '#/stats' }] : []),
    ...(cloud.can('export') ? [{ icon: 'download', aria: 'Exporter en Excel', onClick: () => exportPowerBI().catch(e => toast('Erreur export : ' + e.message, 4000)) }] : []),
  ] });
  if (q?.get('hse') !== null && q?.get('hse') !== undefined) { auditF.hse = q.get('hse'); auditF.sub = ''; auditF.st = ''; }
  if (auditSub) { auditF.sub = auditSub; auditSub = ''; }
  const [{ subs, subList }, insps] = await Promise.all([maps(), pAll('inspections')]);
  const active = subList.filter(s => s.name && !s.archived).sort((a, b) => a.name.localeCompare(b.name));
  const people = hseNames(insps, i => hseSplit(i.inspectors)).sort((a, b) => a.n.localeCompare(b.n));
  const info = new Map(insps.map(i => [i.id, auditState(i)]));
  const today = todayISO(), week = todayISO(-6), thisMonth = today.slice(0, 7);
  // brouillons oubliés : rien noté depuis plus de 2 jours → rangés à part
  const staleDraft = i => info.get(i.id).st === 'draft' && i.date < todayISO(-2);
  const text = i => hseKey([auditLabel(i, subs), i.zone, i.ref, i.inspectors].join(' '));
  const draw = () => {
    const qk = hseKey(auditF.q);
    const base = insps.filter(i => (!auditF.sub || hasSub(i, auditF.sub)) && (!auditF.hse || hseSplit(i.inspectors).some(n => hseKey(n) === auditF.hse)) && (!qk || text(i).includes(qk)));
    const counts = { '': base.filter(i => !staleDraft(i)).length, wip: 0, done: 0, draft: 0 };
    base.forEach(i => counts[info.get(i.id).st]++);
    $('#a-st').innerHTML = [['', 'Tous'], ['wip', 'En cours'], ['done', 'Terminés'], ['draft', 'Brouillons']].map(([k, l]) => `<button data-st="${k}" class="${auditF.st === k ? 'on' : ''}">${l}<em>${counts[k]}</em></button>`).join('');
    const list = base.filter(i => auditF.st ? info.get(i.id).st === auditF.st : !staleDraft(i)).sort((a, b) => (b.date + (b.updatedAt || '')).localeCompare(a.date + (a.updatedAt || '')));
    // tranches : aujourd'hui, 7 derniers jours, puis un bloc par mois (les mois passés sont repliés)
    const buckets = new Map();
    list.forEach(i => {
      const k = i.date === today ? 'today' : i.date >= week ? 'week' : i.date.slice(0, 7);
      (buckets.get(k) || buckets.set(k, []).get(k)).push(i);
    });
    const search = !!(qk || auditF.hse || auditF.sub || auditF.st);
    const html = [...buckets.entries()].map(([k, g]) => {
      const label = k === 'today' ? 'Aujourd’hui' : k === 'week' ? '7 derniers jours' : k === thisMonth ? 'Plus tôt ce mois-ci' : `${MONTHS[+k.slice(5, 7) - 1]} ${k.slice(0, 4)}`;
      const scores = g.map(i => info.get(i.id).o.pct).filter(x => x !== null);
      const avgTxt = scores.length ? ` · moyenne ${Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 100)} %` : '';
      const fold = k.length === 7 && k !== thisMonth && !search && !openMonths.has(k);
      if (fold) return `<button type="button" class="card month-fold" data-m="${k}"><span class="grow"><b>${label}</b><small>${g.length} audit${g.length > 1 ? 's' : ''}${avgTxt}</small></span>${ic('chevron')}</button>`;
      return `<div class="section-head"><span>${label}</span><span class="muted small">${g.length}${k.length === 7 ? avgTxt : ''}</span></div>${inspList(g, subs)}`;
    }).join('');
    const stale = !auditF.st ? base.filter(staleDraft) : [];
    $('#alist').innerHTML = (html || `<div class="empty">${search ? 'Aucun audit ne correspond' : 'Aucun audit'}</div>`) +
      (stale.length ? `<button type="button" class="card month-fold drafts-fold" data-st-go="draft"><span class="grow"><b>${stale.length} brouillon${stale.length > 1 ? 's' : ''} oublié${stale.length > 1 ? 's' : ''}</b><small>Commencés mais rien de noté depuis plus de 2 jours</small></span>${ic('chevron')}</button>` : '') +
      (auditF.st === 'draft' && base.some(staleDraft) ? `<button class="btn block danger" id="a-purge" style="margin-top:12px">${ic('trash')} Supprimer les brouillons de plus de 2 jours</button>` : '');
  };
  const sel = (id, all, opts, v) => `<select class="in f-sel ${v ? 'set' : ''}" id="${id}"><option value="">${all}</option>${opts.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  view.innerHTML = `
    ${auditTabs('date')}
    <div class="a-top"><div class="a-search">${ic('search', 18)}<input class="in" id="a-q" type="search" placeholder="Entreprise, zone, référence…" value="${esc(auditF.q)}" autocomplete="off"></div>
      <button type="button" class="btn a-fbtn ${auditF.sub || auditF.hse ? 'set' : ''}" id="a-fbtn" aria-expanded="false">${ic('filter', 18)}<span>Filtres${(auditF.sub ? 1 : 0) + (auditF.hse ? 1 : 0) ? ` (${(auditF.sub ? 1 : 0) + (auditF.hse ? 1 : 0)})` : ''}</span></button></div>
    <div class="a-filters" id="a-filters" ${auditF.sub || auditF.hse ? '' : 'hidden'}>
      ${sel('a-sub', 'Entreprises', active.map(s => [s.id, s.name]), auditF.sub)}
      ${people.length > 1 || auditF.hse ? sel('a-hse', 'Tous les HSE', people.map(p => [p.k, p.n]), auditF.hse) : ''}
    </div>
    <div class="seg a-st" id="a-st"></div>
    <div id="alist"></div>`;
  draw();
  $('#a-fbtn').onclick = () => { const f = $('#a-filters'); f.hidden = !f.hidden; $('#a-fbtn').setAttribute('aria-expanded', String(!f.hidden)); };
  const fcount = () => { const n = (auditF.sub ? 1 : 0) + (auditF.hse ? 1 : 0); $('#a-fbtn span').textContent = n ? `Filtres (${n})` : 'Filtres'; $('#a-fbtn').classList.toggle('set', !!n); };
  let qt; $('#a-q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { auditF.q = e.target.value; draw(); }, 200); });
  $('#a-sub').onchange = e => { auditF.sub = e.target.value; e.target.classList.toggle('set', !!e.target.value); fcount(); draw(); };
  $('#a-hse') && ($('#a-hse').onchange = e => { auditF.hse = e.target.value; e.target.classList.toggle('set', !!e.target.value); fcount(); draw(); });
  view.addEventListener('click', async e => {
    const st = e.target.closest('[data-st]'); if (st) { auditF.st = st.dataset.st; draw(); return; }
    const go = e.target.closest('[data-st-go]'); if (go) { auditF.st = go.dataset.stGo; draw(); window.scrollTo(0, 0); return; }
    const m = e.target.closest('[data-m]'); if (m) { openMonths.add(m.dataset.m); draw(); return; }
    if (e.target.closest('#a-purge')) {
      const old = insps.filter(staleDraft);
      if (!await confirmBox(`Supprimer ${old.length} brouillon${old.length > 1 ? 's' : ''} ?`, 'Audits commencés il y a plus de 2 jours sans aucun critère noté.', 'Supprimer')) return;
      for (const i of old) await deleteInspection(i.id);
      toast('Brouillons supprimés'); render();
    }
  });
}

async function vSubs() {
  setTop({ title: 'Audits', actions: cloud.isAdmin() ? [{ icon: 'plus', aria: 'Ajouter', onClick: newSub }] : [] });
  const [{ subList: subs }, insps, acts] = await Promise.all([maps(), pAll('inspections'), pAll('actions')]);
  const rows = subs.filter(s => showArchived || !s.archived).map(s => {
    const mine = insps.filter(i => hasSub(i, s.id)).map(i => ({ i, pct: overallScore(i.scores, i.bonus, i.penalty).pct })).filter(x => x.pct !== null).sort((a, b) => b.i.date.localeCompare(a.i.date));
    const last = mine[0]?.i, prev = mine[1];
    return { s, n: mine.length, last, trend: prev ? Math.round((mine[0].pct - prev.pct) * 100) : null, pct: mine[0]?.pct ?? null, open: acts.filter(a => a.subId === s.id && a.status !== 'Closed').length, late: acts.filter(a => a.subId === s.id && isLate(a)).length };
  }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.s.name.localeCompare(b.s.name));
  let rank = 0;
  view.innerHTML = `
    ${auditTabs('sub')}
    <div class="section-head"><span>Classement — dernier audit</span></div>
    ${rows.map(({ s, pct, open, late, n, last, trend }) => `<a class="card link row sub-row" href="#/sub/${s.id}" style="--c:${esc(s.color)};${s.archived ? 'opacity:.5' : ''}">
        <span class="rank">${pct === null ? '–' : ++rank}</span>
        <div class="grow"><b>${esc(s.name || 'Sans nom')}</b>
          <div class="small muted">${n ? `${n} audit${n > 1 ? 's' : ''} · dernier le ${dateFR(last.date).slice(0, 5)}` : 'Pas encore audité'}${trend !== null && trend !== 0 ? ` · <span class="trend ${trend > 0 ? 'up' : 'down'}">${trend > 0 ? '▲ +' : '▼ '}${trend} pts</span>` : ''}</div>
          ${open ? `<div class="small ${late ? 'late' : 'muted'}">${open} action${open > 1 ? 's' : ''} ouverte${open > 1 ? 's' : ''}${late ? ` · ${late} en retard` : ''}</div>` : ''}</div>
        ${pct === null ? '' : badge(pct)}</a>`).join('') || '<div class="empty">Aucune entreprise</div>'}
    <div class="row" style="justify-content:space-between;margin:14px 4px">
      <label class="row small" style="gap:8px"><input type="checkbox" id="arch" ${showArchived ? 'checked' : ''} style="width:22px;height:22px"> Archivés</label>
      ${cloud.isAdmin() ? '<button class="link-btn" id="bulk">Import rapide</button>' : ''}</div>`;
  $('#arch').onchange = e => { showArchived = e.target.checked; render(); };
  $('#bulk') && ($('#bulk').onclick = () => openSheet(`<h3>Import rapide</h3>
    <p class="muted small">Un nom d’entreprise par ligne (copier-coller depuis Excel possible).</p>
    <textarea class="in" id="bulk-t" style="min-height:180px" placeholder="Entreprise A&#10;Entreprise B"></textarea>
    <div class="btns"><button class="btn" data-close>Annuler</button><button class="btn primary" id="bulk-go">Importer</button></div>`,
    (el, close) => el.querySelector('#bulk-go').onclick = async () => {
      const existing = await db.all('subs', { includeDeleted: true });
      const lines = el.querySelector('#bulk-t').value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      let n = 0;
      for (const l of lines) {
        const [name, contact = '', phone = ''] = l.split(/\t|;/).map(x => x.trim());
        if (!name || existing.some(e => (e.name || '').toLowerCase() === name.toLowerCase())) continue;
        await db.put('subs', { name, contact, phone, color: PALETTE[(existing.length + n) % PALETTE.length], archived: false }); n++;
      }
      close(); toast(`${n} entreprise(s) ajoutée(s)`); render();
    }));
}
async function newSub() {
  const n = (await db.all('subs', { includeDeleted: true })).length;
  const s = await db.put('subs', { name: '', contact: '', phone: '', type: 'entreprise', color: PALETTE[n % PALETTE.length], archived: false });
  if (PROJECT) { PROJECT.companyIds = [...new Set([...(PROJECT.companyIds || []), s.id])]; await db.put('projects', PROJECT); }
  location.hash = `#/sub/${s.id}/edit`;
}
async function vSubEdit(id) {
  if (!cloud.isAdmin()) return vNotFound();
  // fiche abandonnée sans nom → supprimée en quittant l'écran
  onCleanup(async () => { const cur = await db.get('subs', id); if (cur && !cur.deleted && !(cur.name || '').trim()) await db.remove('subs', id); });
  const s = await db.get('subs', id);
  if (!s) return vNotFound();
  setTop({ title: s.name || 'Nouvelle entreprise', sub: typeOf(s).label, back: true });
  const save = debounce(() => db.put('subs', s), 300);
  onCleanup(() => save.flush());
  view.innerHTML = `
    <label class="f">Nom *</label><input class="in" data-k="name" value="${esc(s.name)}" placeholder="ex. Entreprise A">
    <label class="f">Type</label>
    <div class="seg type-seg" id="ctype">${Object.entries(COMPANY_TYPES).map(([k, t]) => `<button type="button" data-t="${k}" class="${(s.type || 'entreprise') === k ? 'on' : ''}">${t.label}<small>${t.hint}</small></button>`).join('')}</div>
    <label class="f">Responsable</label><input class="in" data-k="contact" value="${esc(s.contact)}">
    <label class="f">Téléphone</label><input class="in" type="tel" data-k="phone" value="${esc(s.phone)}">
    <label class="f">Couleur des épingles</label>
    <div class="row wrap">${PALETTE.map(c => `<button type="button" data-col="${c}" style="width:48px;height:48px;border-radius:12px;border:3px solid ${c === s.color ? 'var(--ink)' : 'transparent'};background:${c}"></button>`).join('')}
      <input type="color" data-k="color" value="${esc(s.color)}" style="width:56px;height:48px;border:0;background:none"></div>
    <label class="f">Logo (facultatif)</label>
    <div class="row"><img class="logo" id="logo" style="width:64px;height:64px;${s.logoId ? '' : 'display:none'}">
      <label class="btn grow">Choisir une image<input type="file" accept="image/*" class="hidden-input" id="logo-in"></label>
      ${s.logoId ? `<button class="btn danger" id="logo-del" aria-label="Retirer">${ic('x')}</button>` : ''}</div>
    <button class="btn block ${s.archived ? 'primary' : ''}" id="arch" style="margin-top:20px">${s.archived ? 'Désarchiver' : 'Archiver'}</button>
    <p class="muted small" style="text-align:center">Enregistrement automatique</p>`;
  if (s.logoId) $('#logo').src = await db.blobURL(s.logoId);
  view.addEventListener('input', e => { const k = e.target.dataset.k; if (k) { s[k] = e.target.value; save(); if (k === 'name') $('#title').firstChild.textContent = s.name || 'Entreprise'; } });
  $('#ctype').onclick = e => { const b = e.target.closest('[data-t]'); if (!b) return; s.type = b.dataset.t; $('#ctype').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); save.flush(); };
  view.addEventListener('click', e => {
    const c = e.target.closest('[data-col]'); if (!c) return;
    s.color = c.dataset.col; save.flush();
    view.querySelectorAll('[data-col]').forEach(b => b.style.borderColor = b === c ? 'var(--ink)' : 'transparent');
  });
  $('#logo-in').onchange = async e => { const f = e.target.files[0]; if (!f) return; s.logoId = await db.putBlob(await compressImage(f, 256, 0.85)); save.flush(); render(); };
  $('#logo-del')?.addEventListener('click', () => { s.logoId = null; save.flush(); render(); });
  $('#arch').onclick = () => { s.archived = !s.archived; save.flush(); toast(s.archived ? 'Archivé' : 'Réactivé'); render(); };
}
async function vSub(id) {
  const s = await db.get('subs', id);
  if (!s) return vNotFound();
  setTop({ title: s.name || 'Entreprise', sub: `${typeOf(s).label} · historique des audits`, back: '#/subs', actions: cloud.isAdmin() ? [{ icon: 'edit', aria: 'Modifier', onClick: () => location.hash = `#/sub/${id}/edit` }] : [] });
  const [insps, acts] = await Promise.all([pAll('inspections').then(l => l.filter(i => hasSub(i, id))), pAll('actions').then(l => l.filter(a => a.subId === id))]);
  insps.sort((a, b) => a.date.localeCompare(b.date));
  const pts = insps.map(i => ({ i, pct: overallScore(i.scores, i.bonus, i.penalty).pct }));
  const open = acts.filter(a => a.status !== 'Closed');
  const late = acts.filter(isLate).length;
  const last = [...pts].reverse().find(p => p.pct !== null);
  const { subs } = await maps();
  view.innerHTML = `
    <div class="card sub-head" style="--c:${esc(s.color)}">
      ${s.logoId ? `<img class="logo" id="lg" style="width:56px;height:56px">` : `<span class="mono big">${esc(abbr(s.name))}</span>`}
      <div class="grow"><b>${esc(s.name)}</b>
        <div class="muted small">${insps.length} audit${insps.length > 1 ? 's' : ''}${s.contact ? ' · ' + esc(s.contact) : ''}${s.phone ? ` · <a href="tel:${esc(s.phone.replace(/\s/g, ''))}">${esc(s.phone)}</a>` : ''}</div></div>
      ${last ? badge(last.pct) : ''}
    </div>
    <div class="kpi-row">
      <div><b>${last ? Math.round(last.pct * 100) + '%' : '—'}</b><span>Dernier score</span></div>
      <div><b>${open.length}</b><span>Actions ouvertes</span></div>
      <div class="${late ? 'late' : ''}"><b>${late}</b><span>En retard</span></div>
    </div>
    <a class="btn primary big" href="#/new?sub=${id}" style="margin:6px 0 4px">${ic('plus')} Nouvel audit</a>
    <div class="section-head"><span>Évolution du score</span></div>${scoreBars(pts)}
    <div class="section-head"><span>Actions ouvertes</span><span class="muted small">${open.length}</span></div>${open.map(a => actionCard(a, subs)).join('') || '<div class="empty">Aucune action ouverte</div>'}
    <div class="section-head"><span>Audits</span><span class="muted small">${insps.length}</span></div>${[...insps].reverse().map(i => inspCard(i, subs)).join('') || '<div class="empty">Aucun audit</div>'}`;
  if (s.logoId) $('#lg').src = await db.blobURL(s.logoId);
}
/** Score de chaque audit en barres verticales colorées (plus lisible qu'une courbe) */
function scoreBars(pts) {
  const v = pts.filter(p => p.pct !== null).slice(-8);
  if (!v.length) return '<div class="empty">Pas encore de score</div>';
  const w = 340, h = 200, L = 34, R = 6, T = 22, B = 26, bw = Math.min(34, (w - L - R) / v.length - 10);
  const y = p => T + (1 - p) * (h - T - B);
  const x = i => L + (i + 0.5) * (w - L - R) / v.length;
  return `<svg viewBox="0 0 ${w} ${h}" class="chart-box" role="img" aria-label="Évolution du score">
    ${[0, 0.5, 0.8, 1].map(t => `<line x1="${L}" x2="${w - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" ${t ? 'stroke-dasharray="3 3"' : ''}/><text x="${L - 5}" y="${y(t) + 4}" font-size="12" text-anchor="end" opacity=".75">${t * 100}</text>`).join('')}
    ${v.map((p, i) => `<rect x="${x(i) - bw / 2}" y="${y(p.pct)}" width="${bw}" height="${y(0) - y(p.pct)}" rx="4" fill="${rating(p.pct).color}"/>
      <text x="${x(i)}" y="${y(p.pct) - 5}" font-size="13" font-weight="800" text-anchor="middle">${Math.round(p.pct * 100)}</text>
      <text x="${x(i)}" y="${h - 7}" font-size="12" text-anchor="middle" opacity=".8">${p.i.date.slice(5).split('-').reverse().join('/')}</text>`).join('')}
  </svg>`;
}

// ---------- plans ----------
// ---------- gestion des projets (admin) ----------
/** Nouvelle version du même plan (photo aérienne plus récente…) : audits, épingles et zones restent à leur place */
async function replacePlanImage(f, plan) {
  if (!await confirmBox('Mettre à jour l’image du plan ?', 'Les audits, épingles et zones restent sur ce plan. La nouvelle image doit montrer exactement le même cadrage (même emprise, même orientation), sinon les épingles seront décalées.', 'Mettre à jour', 'primary')) return null;
  let page = 1;
  if (/pdf/i.test(f.type) || /\.pdf$/i.test(f.name)) {
    const n = await pdfPageCount(f);
    if (n > 1) page = await ask('Quelle page importer ?', `Le PDF contient ${n} pages.`, [...Array(Math.min(n, 12))].map((_, i) => ({ label: 'Page ' + (i + 1), value: i + 1 })));
    if (!page) return null;
  }
  toast('Conversion du plan…', 6000);
  const { blob } = await planFileToBlob(f, page);
  const old = plan.blobId;
  plan.blobId = await db.putBlob(blob); plan.imageDate = todayISO();
  await db.put('plans', plan);
  if (old && old !== plan.blobId) db.deleteBlob(old).catch(() => {});
  toast('Image du plan mise à jour');
  return plan;
}
async function importPlanFile(f, projectId) {
  let page = 1;
  if (/pdf/i.test(f.type) || /\.pdf$/i.test(f.name)) {
    toast('Lecture du PDF…');
    const n = await pdfPageCount(f);
    if (n > 1) page = await ask('Quelle page importer ?', `Le PDF contient ${n} pages.`, [...Array(Math.min(n, 12))].map((_, i) => ({ label: 'Page ' + (i + 1), value: i + 1 })));
    if (!page) return null;
  }
  toast('Conversion du plan…', 6000);
  const { blob } = await planFileToBlob(f, page);
  const blobId = await db.putBlob(blob);
  const base = f.name.replace(/\.[^.]+$/, '');
  const plan = await db.put('plans', { name: base, code: '', blobId, projectId });
  toast('Plan importé');
  return plan;
}

async function vProjects() {
  if (!cloud.isAdmin()) return vNotFound();
  setTop({ title: 'Projets', sub: 'Chantiers et plans', back: '#/settings', actions: [{ icon: 'plus', aria: 'Nouveau projet', onClick: () => location.hash = '#/project/new' }] });
  const [projects, insps, plans] = await Promise.all([db.all('projects'), db.all('inspections'), db.all('plans')]);
  const list = projects.sort((a, b) => (a.archived - b.archived) || a.name.localeCompare(b.name));
  view.innerHTML = `
    <a class="btn primary big" href="#/project/new">${ic('plus')} Nouveau projet</a>
    <div class="section-head"><span>Projets</span><span class="muted small">${list.filter(p => !p.archived).length} actif${list.length > 1 ? 's' : ''}</span></div>
    ${list.map(p => {
      const n = insps.filter(i => pid(i) === p.id).length, np = plans.filter(x => pid(x) === p.id).length;
      return `<a class="card link proj-card ${p.archived ? 'archived' : ''}" href="#/project/${p.id}" style="--c:${esc(p.color || '#0B2D5B')}">
        <span class="mono">${esc((p.code || p.name).replace(/\s/g, '').slice(0, 5).toUpperCase())}</span>
        <span class="grow"><b>${esc(p.name)}</b>${p.id === PROJECT?.id ? ' <span class="chip role">Actif</span>' : ''}${p.archived ? ' <span class="chip role insp">Archivé</span>' : ''}
          <span class="muted small">${esc(p.site || '—')}</span>
          <span class="proj-stats">${n} audit${n > 1 ? 's' : ''} · ${(p.companyIds || []).length} entreprises · ${np} plan${np > 1 ? 's' : ''}</span></span>
        ${ic('chevron')}</a>`;
    }).join('')}`;
}

/** Zones d'un plan (admin HSE) : tracer, renommer, supprimer — utilisées ensuite par toute l'équipe pendant les audits */
async function vZones(id) {
  if (!cloud.isAdmin()) return vNotFound();
  const plan = await db.get('plans', id);
  if (!plan) return vNotFound();
  plan.zones ||= [];
  setTop({ title: 'Zones du plan', sub: plan.name, back: '#/project/' + pid(plan) });
  const save = async () => { await db.put('plans', plan); };
  view.innerHTML = `
    <p class="muted small" style="margin:0 2px 8px">Tracez les zones du chantier une fois pour toutes : pendant un audit, un toucher sur la zone la sélectionne et remplit son nom.</p>
    <div id="zmap" class="pv zones-map"></div>
    <div class="plan-tools ztools" id="ztools"></div>
    <div class="section-head"><span>Zones</span><span class="muted small" id="zcount"></span></div>
    <div id="zlist"></div>`;
  let mode = '', nPts = 0, editing = null;
  const areas = () => mode === 'rect' || mode === 'poly' ? [] : plan.zones.filter(z => z !== editing).map(z => ({ id: z.id, pts: z.pts, kind: 'zone', label: z.name }));
  const B = (zt, icon, label, cls = '') => `<button type="button" class="btn ${cls}" data-zt="${zt}" ${cls === 'disabled' ? 'disabled' : ''}>${ic(icon, 18)} ${label}</button>`;
  const tools = () => { $('#ztools').innerHTML =
      mode === 'choose' ? `${B('rect', 'fit', 'Rectangle')}${B('poly', 'edit', 'Forme libre')}${B('cancel', 'x', 'Annuler')}`
      : mode === 'rect' ? `<p class="zhint">Glissez le doigt sur le plan pour tracer le rectangle.</p>${B('cancel', 'x', 'Annuler')}`
      : mode === 'poly' ? `<p class="zhint">Touchez les coins un par un (${nPts} posé${nPts > 1 ? 's' : ''}). Touchez le 1er coin ou « Terminer ».</p>${B('undo', 'back', 'Retour', nPts ? '' : 'disabled')}${B('finish', 'check', 'Terminer', nPts >= 3 ? 'primary' : 'disabled')}${B('cancel', 'x', 'Annuler')}`
      : mode === 'edit' ? `<p class="zhint">${esc(editing?.name || '')} : glissez un coin, un point jaune pour ajouter un coin, ou l’intérieur pour déplacer.</p>${B('done', 'check', 'Terminer', 'primary')}`
      : B('draw', 'edit', 'Tracer une nouvelle zone', 'primary'); };
  const setMode = m => { mode = m; nPts = 0; pv.setDrawMode(m === 'rect' || m === 'poly', onDrawn, m === 'poly' ? 'poly' : 'rect', n => { nPts = n; tools(); }); if (m !== 'edit') { pv.setEditArea(null); editing = null; } pv.setAreas(areas()); tools(); };
  let pv = null;
  const drawList = () => {
    $('#zcount').textContent = plan.zones.length;
    $('#zlist').innerHTML = plan.zones.length ? [...plan.zones].sort((a, b) => natural(a.name, b.name)).map(z => `<div class="card row zone-row" data-zid="${z.id}">
      <span class="ic-round">${ic('map', 18)}</span><input class="in grow" data-zn="${z.id}" value="${esc(z.name)}">
      <button class="btn small-btn" data-zfocus="${z.id}" aria-label="Voir">${ic('pin', 18)}</button>
      <button class="btn danger small-btn" data-zdel="${z.id}" aria-label="Supprimer">${ic('trash', 18)}</button></div>`).join('')
      : '<div class="empty">Aucune zone pour le moment.<br>Touchez « Tracer une nouvelle zone ».</div>';
    pv?.setAreas(areas());
  };
  const startEdit = z => { setMode('edit'); editing = z; pv.setAreas(areas()); pv.focusArea(z.pts); pv.setEditArea(z.pts, async pts => { z.pts = pts; await save(); }); tools(); };
  const editZone = z => openSheet(`<h3>Zone</h3><label class="f" style="margin-top:0">Nom</label><input class="in" id="zr" value="${esc(z.name)}">
    <button class="btn block" id="zshape" style="margin-top:12px">${ic('fit', 18)} Modifier la forme</button>
    <div class="btns" style="margin-top:14px"><button class="btn danger" id="zd">${ic('trash', 18)} Supprimer</button><button class="btn primary" id="zo">Enregistrer</button></div>`,
  (el, close) => {
    el.querySelector('#zshape').onclick = () => { close(); startEdit(z); };
    el.querySelector('#zo').onclick = async () => { z.name = el.querySelector('#zr').value.trim() || z.name; await save(); close(); drawList(); };
    el.querySelector('#zd').onclick = async () => { if (!await confirmBox(`Supprimer la zone ${z.name} ?`, 'Les audits déjà faits gardent leur zone.', 'Supprimer')) return; plan.zones = plan.zones.filter(x => x !== z); await save(); close(); drawList(); };
  });
  pv = createPlanViewer($('#zmap'), {
    imageURL: await db.blobURL(plan.blobId), pins: [], areas: areas(), cover: 2.4,
    onZoneTap: a => { if (mode) return; const z = plan.zones.find(x => x.id === a.id); if (z) editZone(z); },
  });
  onCleanup(() => pv.destroy());
  const onDrawn = pts => {
    setMode('');
    openSheet(`<h3>Nouvelle zone</h3><label class="f" style="margin-top:0">Nom de la zone</label><input class="in" id="zn" placeholder="ex. Bâtiment A nord, Zone 3…" autocomplete="off">
      <div class="btns" style="margin-top:14px"><button class="btn" data-close>Annuler</button><button class="btn primary" id="zok">Ajouter</button></div>`,
    (el, close) => {
      setTimeout(() => el.querySelector('#zn').focus(), 50);
      el.querySelector('#zok').onclick = async () => {
        const name = el.querySelector('#zn').value.trim(); if (!name) return toast('Donnez un nom à la zone');
        plan.zones.push({ id: db.uid(), name, pts }); await save(); close(); drawList(); toast('Zone ajoutée');
      };
    });
  };
  $('#ztools').addEventListener('click', e => {
    const t = e.target.closest('[data-zt]:not([disabled])')?.dataset.zt; if (!t) return;
    if (t === 'draw') setMode('choose');
    else if (t === 'rect' || t === 'poly') setMode(t);
    else if (t === 'undo') pv.undoPoly();
    else if (t === 'finish') pv.finishPoly();
    else if (t === 'cancel' || t === 'done') { setMode(''); drawList(); }
  });
  tools();
  $('#zlist').addEventListener('change', async e => { const z = plan.zones.find(x => x.id === e.target.dataset.zn); if (z) { z.name = e.target.value.trim() || z.name; await save(); pv.setAreas(areas()); } });
  $('#zlist').addEventListener('click', async e => {
    const f = e.target.closest('[data-zfocus]'); if (f) { const z = plan.zones.find(x => x.id === f.dataset.zfocus); pv.focusArea(z.pts); $('#zmap').scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    const d = e.target.closest('[data-zdel]'); if (!d) return;
    const z = plan.zones.find(x => x.id === d.dataset.zdel);
    if (!await confirmBox(`Supprimer la zone ${z.name} ?`, 'Les audits déjà faits gardent leur zone.', 'Supprimer')) return;
    plan.zones = plan.zones.filter(x => x !== z); await save(); drawList();
  });
  drawList();
}
async function vProject(id) {
  if (!cloud.isAdmin()) return vNotFound();
  const isNew = id === 'new';
  const p = isNew ? { name: '', code: '', site: '', color: PALETTE[(await db.all('projects')).length % PALETTE.length], companyIds: [], archived: false } : await db.get('projects', id);
  if (!p) return vNotFound();
  setTop({ title: isNew ? 'Nouveau projet' : p.name, sub: isNew ? '' : 'Paramètres du projet', back: '#/projects' });
  const { allSubs } = await maps();
  const plans = isNew ? [] : (await db.all('plans')).filter(x => pid(x) === p.id);
  const save = debounce(() => !isNew && db.put('projects', p), 300);
  onCleanup(() => save.flush());
  const types = { entreprise: allSubs.filter(s => (s.type || 'entreprise') === 'entreprise'), sub: allSubs.filter(s => s.type === 'sub') };
  view.innerHTML = `
    <div class="card">
      <label class="f" style="margin-top:0">Nom du projet *</label><input class="in" data-k="name" value="${esc(p.name)}" placeholder="ex. SAM 3">
      <div class="btns" style="margin-bottom:0">
        <div><label class="f">Code (références)</label><input class="in" data-k="code" value="${esc(p.code)}" placeholder="SAM3" style="text-transform:uppercase"></div>
        <div><label class="f">Site</label><input class="in" data-k="site" value="${esc(p.site)}" placeholder="ex. Ville"></div>
      </div>
      <label class="f">Logos du rapport PDF <span class="muted small">(2 maximum, ex. Jan De Nul + Besix)</span></label>
      <div class="logo-slots">${[['logoId', 'Logo 1'], ['logo2Id', 'Logo 2']].map(([k, l]) => `<div class="logo-slot">
        <div class="logo-box" data-lbox="${k}">${p[k] ? '<img alt="">' : `<span class="muted small">${l}</span>`}</div>
        <div class="row" style="gap:6px"><label class="btn grow small-btn">${p[k] ? 'Changer' : 'Ajouter'}<input type="file" accept="image/*" class="hidden-input" data-lin="${k}"></label>${p[k] ? `<button class="btn danger small-btn" data-ldel="${k}" aria-label="Retirer">${ic('x', 18)}</button>` : ''}</div></div>`).join('')}</div>
      <p class="muted small" style="margin:6px 0 0">Utilisez les fichiers officiels (PNG ou JPG, fond blanc) fournis par votre société.</p>
    </div>
    ${isNew ? `<button class="btn primary big" id="create">Créer le projet</button>` : `
    <div class="section-head"><span>Plans</span><span class="muted small">${plans.length}</span></div>
    ${plans.map(x => `<div class="card row plan-row" data-plan="${x.id}"><img class="plan-thumb" data-img="${x.blobId}">
      <input class="in grow" data-pn="${x.id}" value="${esc(x.name)}"><a class="btn small-btn" href="#/plan/${x.id}/zones">${ic('map', 18)} Zones${(x.zones || []).length ? ` (${x.zones.length})` : ''}</a>
      <label class="btn small-btn" title="Nouvelle image du même plan (épingles et zones conservées)" aria-label="Mettre à jour l’image">${ic('upload', 18)}<input type="file" accept="image/*,application/pdf,.pdf" class="hidden-input" data-prep="${x.id}"></label>
      <button class="btn danger small-btn" data-pdel="${x.id}" aria-label="Supprimer">${ic('trash', 18)}</button></div>`).join('')}
    ${plans.length ? '<p class="muted small" style="margin:-2px 2px 8px">' + ic('upload', 14) + ' = nouvelle image du même plan : audits, épingles et zones restent en place.</p>' : ''}
    <label class="btn block">${ic('upload')} Ajouter un plan (image ou PDF)<input type="file" accept="image/*,application/pdf,.pdf" class="hidden-input" id="p-in"></label>
    <div class="section-head"><span>Entreprises du projet</span><span class="muted small" id="ncomp">${(p.companyIds || []).length} sélectionnée(s)</span></div>
    <p class="muted small" style="margin:-4px 2px 8px">Cochez les entreprises qui travaillent sur ce projet. <a href="#/companies">Gérer l’annuaire</a></p>
    ${[['entreprise', COMPANY_TYPES.entreprise.plural], ['sub', COMPANY_TYPES.sub.plural]].map(([t, label]) => types[t].length ? `
      <div class="muted small" style="margin:10px 2px 6px;font-weight:700">${label}</div>
      <div class="check-grid">${types[t].map(s => `<label class="check-item" style="--c:${esc(s.color)}"><input type="checkbox" data-comp="${s.id}" ${(p.companyIds || []).includes(s.id) ? 'checked' : ''}><span class="mono">${esc(abbr(s.name))}</span><b>${esc(s.name)}</b></label>`).join('')}</div>` : '').join('')}
    <button class="btn block" id="parch" style="margin-top:20px">${p.archived ? 'Réactiver le projet' : 'Archiver le projet'}</button>
    <p class="muted small" style="text-align:center">Enregistrement automatique</p>`}`;
  for (const k of ['logoId', 'logo2Id']) if (p[k]) { const im = view.querySelector(`[data-lbox="${k}"] img`); if (im) im.src = await db.blobURL(p[k]); }
  view.querySelectorAll('[data-img]').forEach(async im => { im.src = await db.blobURL(im.dataset.img); });
  view.addEventListener('input', e => {
    const k = e.target.dataset.k;
    if (k) { p[k] = k === 'code' ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') : e.target.value; save(); }
    const pn = e.target.dataset.pn;
    if (pn) { const pl = plans.find(x => x.id === pn); pl.name = e.target.value; db.put('plans', pl); }
  });
  view.addEventListener('change', e => {
    const c = e.target.dataset.comp; if (!c) return;
    p.companyIds = e.target.checked ? [...new Set([...(p.companyIds || []), c])] : (p.companyIds || []).filter(x => x !== c);
    $('#ncomp').textContent = p.companyIds.length + ' sélectionnée(s)'; save.flush();
  });
  view.querySelectorAll('[data-lin]').forEach(inp => inp.onchange = async e => {
    const f = e.target.files[0]; if (!f) return; const k = inp.dataset.lin;
    p[k] = await db.putBlob(await compressImage(f, 600, 0.92)); save.flush(); toast('Logo ajouté');
    if (isNew) view.querySelector(`[data-lbox="${k}"]`).innerHTML = `<img alt="" src="${await db.blobURL(p[k])}">`; else render();
  });
  view.querySelectorAll('[data-ldel]').forEach(b => b.onclick = () => { p[b.dataset.ldel] = null; save.flush(); render(); });
  if (isNew) {
    $('#create').onclick = async () => {
      if (!p.name.trim()) return toast('Indiquez le nom du projet');
      p.code ||= p.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const created = await db.put('projects', p);
      toast('Projet créé'); location.replace('#/project/' + created.id);
    };
    return;
  }
  view.querySelectorAll('[data-prep]').forEach(inp => inp.onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { if (await replacePlanImage(f, plans.find(x => x.id === inp.dataset.prep))) render(); } catch (err) { toast('Import impossible : ' + err.message, 4000); }
  });
  $('#p-in').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { await importPlanFile(f, p.id); render(); } catch (err) { toast('Import impossible : ' + err.message, 4000); } };
  view.addEventListener('click', async e => {
    const d = e.target.closest('[data-pdel]'); if (!d) return;
    if (await confirmBox('Supprimer ce plan ?', 'Les audits restent, mais leurs épingles ne seront plus visibles.')) {
      const pl = await db.get('plans', d.dataset.pdel);
      await db.remove('plans', d.dataset.pdel); if (pl?.blobId) db.deleteBlob(pl.blobId).catch(() => {});
      if (await db.getMeta('lastPlan') === d.dataset.pdel) await db.setMeta('lastPlan', null);
      render();
    }
  });
  $('#parch').onclick = async () => {
    if (!p.archived && p.id === PROJECT?.id && (await allowedProjects()).length < 2) return toast('Créez d’abord un autre projet');
    p.archived = !p.archived; save.flush(); toast(p.archived ? 'Projet archivé' : 'Projet réactivé');
    if (p.archived && p.id === PROJECT?.id) { await db.setMeta('project', null); await loadProject(); }
    render();
  };
}

// ---------- annuaire des entreprises ----------
let compFilter = '';
async function vCompanies() {
  if (!cloud.isAdmin()) return vNotFound();
  setTop({ title: 'Annuaire des entreprises', sub: `${COMPANY_TYPES.entreprise.plural} et ${COMPANY_TYPES.sub.plural.toLowerCase()}`, back: '#/settings', actions: [{ icon: 'plus', aria: 'Ajouter', onClick: () => newSub() }] });
  const { allSubs } = await maps();
  const projects = await db.all('projects');
  const draw = () => {
    const list = allSubs.filter(s => !compFilter || (s.type || 'entreprise') === compFilter).sort((a, b) => a.name.localeCompare(b.name));
    $('#clist').innerHTML = list.map(s => {
      const inP = projects.filter(p => !p.archived && (p.companyIds || []).includes(s.id)).map(p => p.code || p.name);
      return `<a class="card link comp-row" href="#/sub/${s.id}/edit" style="--c:${esc(s.color)};${s.archived ? 'opacity:.5' : ''}">
        <span class="mono">${esc(abbr(s.name))}</span>
        <span class="grow"><b>${esc(s.name)}</b><span class="muted small">${typeOf(s).label}${inP.length ? ' · ' + esc(inP.join(', ')) : ' · aucun projet'}</span></span>
        ${ic('chevron')}</a>`;
    }).join('') || '<div class="empty">Aucune entreprise</div>';
    view.querySelectorAll('[data-cf]').forEach(b => b.classList.toggle('on', b.dataset.cf === compFilter));
  };
  view.innerHTML = `
    <div class="tabs3"><button data-cf="">Toutes</button><button data-cf="entreprise">${COMPANY_TYPES.entreprise.plural}</button><button data-cf="sub">${COMPANY_TYPES.sub.plural}</button></div>
    <div id="clist"></div>
    <button class="link-btn" id="bulk" style="display:block;margin:10px auto">Import rapide</button>`;
  draw();
  view.querySelector('.tabs3').onclick = e => { const b = e.target.closest('[data-cf]'); if (b) { compFilter = b.dataset.cf; draw(); } };
  $('#bulk').onclick = () => openSheet(`<h3>Import rapide</h3>
    <p class="muted small">Un nom par ligne (copier-coller depuis Excel possible). Elles sont ajoutées au projet en cours.</p>
    <textarea class="in" id="bulk-t" style="min-height:180px" placeholder="Entreprise A&#10;Entreprise B"></textarea>
    <div class="btns"><button class="btn" data-close>Annuler</button><button class="btn primary" id="bulk-go">Importer</button></div>`,
    (el, close) => el.querySelector('#bulk-go').onclick = async () => {
      const existing = await db.all('subs', { includeDeleted: true });
      const lines = el.querySelector('#bulk-t').value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const added = [];
      for (const l of lines) {
        const [name, contact = '', phone = ''] = l.split(/\t|;/).map(x => x.trim());
        if (!name || existing.some(e => (e.name || '').toLowerCase() === name.toLowerCase())) continue;
        added.push((await db.put('subs', { name, contact, phone, type: 'entreprise', color: PALETTE[(existing.length + added.length) % PALETTE.length], archived: false })).id);
      }
      if (PROJECT && added.length) { PROJECT.companyIds = [...new Set([...(PROJECT.companyIds || []), ...added])]; await db.put('projects', PROJECT); }
      close(); toast(`${added.length} entreprise(s) ajoutée(s)`); render();
    });
}

// ---------- réglages ----------
async function vSettings() {
  setTop({ title: 'Réglages', back: '#/' });
  const st = await getSettings();
  let est = '';
  try { const e = await navigator.storage?.estimate?.(); if (e) est = `${(e.usage / 1048576).toFixed(1)} Mo utilisés`; } catch { /* ignore */ }
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  view.innerHTML = `
    ${cloud.enabled ? `<div class="card row member">
      <span class="avatar">${esc((cloud.myName() || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())}</span>
      <div class="grow"><b>${esc(cloud.myName())}</b> ${cloud.isAdmin() ? '<span class="chip role">Admin</span>' : '<span class="chip role insp">Inspecteur</span>'}
        <div class="muted small ellip">${esc(cloud.profile?.email || '')}</div></div></div>
    <button class="sync-pill" id="sync-now" hidden></button>
` : ''}
    <div class="card">
      ${cloud.enabled ? '' : `<label class="f" style="margin-top:0">Inspecteur par défaut</label><input class="in" data-s="inspector" list="hse-list" value="${esc(st.inspector)}" autocomplete="off">`}
      <label class="row check-line perm-row" style="margin-top:12px"><span class="grow"><b>Joindre les photos aux actions envoyées</b><small>« Envoyer à l’entreprise » : décochez si le client interdit de diffuser les photos du site</small></span>
        <input type="checkbox" class="switch" id="share-ph" ${st.sharePhotos === false ? '' : 'checked'}></label>
      <label class="f">Affichage</label><div class="seg" id="theme">${[['auto', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']].map(([v, l]) => `<button data-val="${v}" class="${st.theme === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    ${cloud.isAdmin() ? `<div class="section-head"><span>Apparence de l’app</span></div>
    <div class="card brand-card">
      <div class="logo-box brand-logo" id="b-logo"><img alt="" src="${esc(BRAND.logo)}"></div>
      <div class="grow">
        <label class="f" style="margin-top:0">Nom de l’app</label><input class="in" id="b-name" value="${esc(BRAND.name)}" maxlength="24" autocomplete="off">
        <div class="row" style="gap:6px;margin-top:8px"><label class="btn grow small-btn">${ic('upload', 18)} Changer le logo<input type="file" accept="image/*" class="hidden-input" id="b-in"></label>
          ${BRAND.logoId ? `<button class="btn small-btn" id="b-reset">Logo d’origine</button>` : ''}</div>
      </div>
      <p class="muted small" style="margin:8px 0 0;flex-basis:100%">Visible par toute l’équipe. L’icône de l’écran d’accueil se met à jour quand on réinstalle l’app.</p>
    </div>
    <div class="section-head"><span>Administration</span></div>
    <div class="menu-list">

      <a href="#/projects">${ic('map')}<span class="grow"><b>Projets et plans</b><small>${esc(PROJECT?.name || '')} · changer, créer, archiver</small></span>${ic('chevron')}</a>
      <a href="#/companies">${ic('building')}<span class="grow"><b>Annuaire des entreprises</b><small>Sous-traitants et prestataires</small></span>${ic('chevron')}</a>
      ${cloud.enabled ? `<a href="#/team">${ic('list')}<span class="grow"><b>Équipe et accès</b><small>Invitations, droits, projets autorisés</small></span>${ic('chevron')}</a>` : ''}
    </div>` : ''}
    <button class="btn block" id="scale" style="margin-bottom:10px">Barème de notation (Notes)</button>
    ${cloud.can('export') ? `<h2>Exports</h2>
    <button class="btn block" id="x-all" style="margin-bottom:10px">Excel — tous les audits du projet (format PRT)</button>` : ''}
    <h2>Données</h2>
    <button class="btn block danger" id="reset" style="margin-bottom:10px">${ic('trash')} Effacer tous les audits</button>
    <h2>Sauvegarde</h2>
    <button class="btn block" id="bk" style="margin-bottom:10px">${ic('download')} Sauvegarde complète (JSON)</button>
    ${cloud.enabled ? '' : `<label class="btn block danger">${ic('upload')} Restaurer une sauvegarde<input type="file" accept="application/json,.json" class="hidden-input" id="rs"></label>`}
    ${cloud.enabled ? `<button class="btn block danger" id="logout" style="margin-top:20px">Se déconnecter</button>` : ''}
    <p class="muted small" style="margin-top:14px">${cloud.enabled ? 'Données envoyées automatiquement au serveur HSE' : 'Données stockées uniquement sur cet appareil'}${est ? ' · ' + est : ''}${cloud.enabled ? '' : ` · stockage ${persisted ? 'persistant' : 'non garanti — faites des sauvegardes régulières'}`}.<br>
    Version ${APP_VERSION} · fonctionne hors ligne.</p>`;
  drawSync();
  $('#sync-now')?.addEventListener('click', () => cloud.sync());
  $('#logout')?.addEventListener('click', async () => {
    if (!await confirmBox('Se déconnecter ?', 'Les données de ce téléphone seront effacées après envoi au serveur.', 'Se déconnecter')) return;
    try { await cloud.signOut(); location.hash = '#/'; location.reload(); } catch (e) { toast(e.message, 5000); }
  });
  const save = debounce(() => saveSettings(st), 300);
  onCleanup(() => save.flush());
  view.addEventListener('input', e => { const k = e.target.dataset.s; if (k) { st[k] = e.target.value; save(); } });
  $('#share-ph').onchange = e => { st.sharePhotos = e.target.checked; save.flush(); toast(e.target.checked ? 'Les photos seront jointes' : 'Seul le texte sera envoyé'); };
  $('#theme').onclick = e => { const b = e.target.closest('[data-val]'); if (!b) return; st.theme = b.dataset.val; save.flush(); applyTheme(st.theme); render(); };
  $('#scale').onclick = showScale;
  $('#reset').onclick = async () => {
    const insps = await pAll('inspections');
    if (!insps.length) return toast('Aucun audit à effacer');
    if (!await confirmBox(`Effacer les ${insps.length} audit${insps.length > 1 ? 's' : ''} ?`, 'Tous les audits, actions et photos de ce téléphone seront supprimés. Les entreprises, projets et plans sont conservés.', 'Tout effacer')) return;
    if (!await confirmBox('Vraiment tout effacer ?', 'Cette opération est définitive.', 'Oui, tout effacer')) return;
    for (const i of insps) await deleteInspection(i.id);
    for (const a of await pAll('actions')) await db.remove('actions', a.id);
    toast('Tous les audits ont été effacés'); location.hash = '#/';
  };
  if ($('#x-bi')) $('#x-bi').onclick = () => exportPowerBI().catch(e => toast('Erreur export : ' + e.message, 4000));
  if ($('#x-all')) $('#x-all').onclick = async () => { const all = (await pAll('inspections')).sort((a, b) => a.date.localeCompare(b.date)); if (!all.length) return toast('Aucune inspection'); exportSheet(all, { allActions: true }); };
  // apparence : nom et logo appliqués à tous les projets (donc à toute l'équipe en mode équipe)
  const setBrand = async (patch) => {
    for (const pr of await db.all('projects')) { Object.assign(pr, patch); await db.put('projects', pr); }
    BRAND.applied = false; await loadProject(); await applyBrand();
  };
  $('#b-name')?.addEventListener('change', async e => { await setBrand({ appName: e.target.value.trim() || 'Audit HSE' }); toast('Nom de l’app enregistré'); });
  $('#b-in')?.addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    const id = await db.putBlob(await compressImage(f, 512, 0.92)); await setBrand({ appLogoId: id }); toast('Logo enregistré'); render();
  });
  $('#b-reset')?.addEventListener('click', async () => { await setBrand({ appLogoId: null }); toast('Logo d’origine'); render(); });
  $('#bk').onclick = backupNow;
  if ($('#rs')) $('#rs').onchange = e => restoreFile(e.target.files[0]);
}
/** Restaure une sauvegarde ou un kit de démarrage (.json) */
async function restoreFile(f, kit = false) {
  if (!f) return;
  if (!await confirmBox(kit ? 'Importer ce kit de démarrage ?' : 'Restaurer cette sauvegarde ?', kit ? 'Le projet, le plan et les entreprises du kit seront chargés dans l’app.' : 'Toutes les données actuelles de l’app seront <b>remplacées</b>.', kit ? 'Importer' : 'Remplacer mes données')) return;
  try { await db.importAll(JSON.parse(await f.text())); toast(kit ? 'Kit importé' : 'Restauration terminée'); location.hash = '#/'; render(); }
  catch (err) { toast('Fichier non reconnu : ' + err.message, 4000); }
}

// ---------- équipe et accès (admin) ----------
const PERM_HINTS = {
  audit: 'Lancer des audits et noter les critères',
  details: 'Rouvrir ses audits passés (sinon : uniquement ses chiffres)',
  export: 'Générer les rapports PDF et Excel',
  actions: 'Créer, déplacer et clôturer les actions',
  team: 'Date, zone, entreprise et score des audits des autres — sans le détail ni les photos',
  teamActions: 'Sur l’entreprise qu’il audite : les actions encore ouvertes relevées par les autres',
};
const permSummary = p => {
  if (p.role === 'admin') return 'Administrateur · accès complet';
  const on = Object.keys(cloud.PERMS).filter(k => cloud.OPT_IN.includes(k) ? p.perms?.[k] === true : p.perms?.[k] !== false);
  const L = { audit: 'Audits', details: 'Détail', export: 'Export', actions: 'Actions', team: 'Aperçu équipe', teamActions: 'Actions des autres' };
  return on.length === Object.keys(cloud.PERMS).length ? 'Tous les droits' : on.length ? on.map(k => L[k]).join(' · ') : 'Lecture seule';
};
const projSummary = (ids, projects) => !ids || !ids.length ? 'Tous les projets' : ids.map(id => projects.find(p => p.id === id)?.name || '?').join(', ');
const inviteLink = (email, name, code) => `${location.origin}${location.pathname}#/join?e=${encodeURIComponent(email)}&n=${encodeURIComponent(name || '')}${code ? '&c=' + encodeURIComponent(code) : ''}`;
async function shareInvite(email, name, code) {
  // le code d'invitation protège le compte : sans lui, personne d'autre ne peut créer le compte à cette adresse
  if (!code) code = (await cloud.inviteCode(email).catch(() => null)) || '';
  const link = inviteLink(email, name, code);
  const text = `Bonjour${name ? ' ' + name.split(' ')[0] : ''}, voici ton accès à l’application ${BRAND.name} : ${link}\n1. Ouvre le lien dans Safari\n2. « Créer mon compte » avec ${email}${code ? ` (code d’invitation : ${code})` : ''}\n3. Partager → « Sur l’écran d’accueil »\nCe lien est personnel : ne le transfère pas.`;
  openSheet(`<h3>Invitation prête</h3>
    <p class="muted">Envoyez ce lien à <b>${esc(name || email)}</b> uniquement : il contient son code d’invitation personnel${code ? ` (<b>${esc(code)}</b>)` : ''}.</p>
    <div class="invite-link">${esc(link)}</div>
    <div style="display:grid;gap:10px;margin-top:12px">
      ${navigator.share ? `<button class="btn primary block" data-s>${ic('share')} Envoyer (WhatsApp, mail, Teams…)</button>` : ''}
      <button class="btn block" data-c>Copier le message</button>
      <button class="btn block" data-close>Fermer</button></div>`,
  (el, close) => {
    el.querySelector('[data-s]')?.addEventListener('click', async () => { try { await navigator.share({ title: 'Accès ' + BRAND.name, text }); close(); } catch { /* annulé */ } });
    el.querySelector('[data-c]').onclick = async () => { try { await navigator.clipboard.writeText(text); toast('Message copié'); } catch { toast('Copie impossible'); } };
  });
}
function accessForm(state, projects) {
  return `
    <label class="f">Rôle</label>
    <div class="seg type-seg" id="a-role">
      <button type="button" data-role="inspector" class="${state.role !== 'admin' ? 'on' : ''}">HSE<small>application de terrain</small></button>
      <button type="button" data-role="admin" class="${state.role === 'admin' ? 'on' : ''}">Administrateur<small>voit tout, gère l’équipe</small></button></div>
    <div id="a-hse" ${state.role === 'admin' ? 'hidden' : ''}>
      <label class="f">Droits</label>
      <div class="perm-list">${Object.entries(cloud.PERMS).map(([k, l]) => `
        <label class="perm-row"><span class="grow"><b>${l}</b><small>${PERM_HINTS[k]}</small></span>
          <input type="checkbox" class="switch" data-perm="${k}" ${(cloud.OPT_IN.includes(k) ? state.perms?.[k] === true : state.perms?.[k] !== false) ? 'checked' : ''}></label>`).join('')}</div>
      <label class="f">Projets autorisés</label>
      <div class="perm-list">
        <label class="perm-row"><span class="grow"><b>Tous les projets</b><small>y compris les futurs projets</small></span>
          <input type="checkbox" class="switch" id="a-all" ${!state.projects || !state.projects.length ? 'checked' : ''}></label>
        <div id="a-projs" class="chips-wrap" ${!state.projects || !state.projects.length ? 'hidden' : ''}>${projects.filter(p => !p.archived).map(p => `<button type="button" class="pchip ${(state.projects || []).includes(p.id) ? 'on' : ''}" data-proj="${p.id}">${esc(p.name)}</button>`).join('')}</div>
      </div>
    </div>`;
}
function bindAccessForm(state, onChange) {
  $('#a-role').onclick = e => { const b = e.target.closest('[data-role]'); if (!b) return; state.role = b.dataset.role; $('#a-role').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); $('#a-hse').hidden = state.role === 'admin'; onChange(); };
  view.querySelectorAll('[data-perm]').forEach(i => i.onchange = () => { state.perms = { ...state.perms, [i.dataset.perm]: i.checked }; onChange(); });
  $('#a-all').onchange = e => { $('#a-projs').hidden = e.target.checked; if (e.target.checked) state.projects = null; else state.projects = PROJECT ? [PROJECT.id] : []; view.querySelectorAll('[data-proj]').forEach(b => b.classList.toggle('on', (state.projects || []).includes(b.dataset.proj))); onChange(); };
  $('#a-projs').onclick = e => { const b = e.target.closest('[data-proj]'); if (!b) return; const id = b.dataset.proj; const cur = new Set(state.projects || []); cur.has(id) ? cur.delete(id) : cur.add(id); state.projects = [...cur]; b.classList.toggle('on', cur.has(id)); onChange(); };
}

async function vTeam() {
  if (!cloud.isAdmin()) return vNotFound();
  setTop({ title: 'Équipe et accès', sub: 'Qui peut utiliser l’application', back: '#/settings', actions: [{ icon: 'plus', aria: 'Inviter', onClick: () => location.hash = '#/invite' }] });
  view.innerHTML = '<div class="empty">Chargement…</div>';
  let t;
  try { t = await cloud.team(); } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}<br>Une connexion internet est nécessaire.</div>`; return; }
  const [insps, projects] = await Promise.all([db.all('inspections'), db.all('projects')]);
  const pending = t.invites.filter(i => !t.profiles.some(p => p.email === i.email));
  const initials = n => esc((n || '?').split(/[\s.@]+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase());
  view.innerHTML = `
    <a class="btn primary big" href="#/invite">${ic('plus')} Inviter une personne</a>
    <div class="section-head"><span>Membres</span><span class="muted small">${t.profiles.length}</span></div>
    ${t.profiles.map(p => {
      const mine = insps.filter(i => i.owner === p.id);
      const last = mine.sort((a, b) => b.date.localeCompare(a.date))[0];
      return `<a class="card link member-card ${p.active ? '' : 'off'}" href="#/member/${p.id}">
        <span class="avatar ${p.role === 'admin' ? 'admin' : ''}">${initials(p.name || p.email)}</span>
        <span class="grow"><b>${esc(p.name || p.email)}</b>${p.role === 'admin' ? ' <span class="chip role">Admin</span>' : ''}${p.active ? '' : ' <span class="chip role danger-chip">Bloqué</span>'}
          <span class="muted small ellip">${esc(permSummary(p))}</span>
          <span class="member-meta">${mine.length} audit${mine.length > 1 ? 's' : ''}${last ? ' · dernier ' + dateFR(last.date) : ''} · ${esc(projSummary(p.projects, projects))}</span></span>
        ${ic('chevron')}</a>`;
    }).join('')}
    ${pending.length ? `<div class="section-head"><span>Invitations en attente</span><span class="muted small">${pending.length}</span></div>
      ${pending.map(i => `<div class="card member-card"><span class="avatar pending">${ic('clock', 18)}</span>
        <span class="grow"><b>${esc(i.name || i.email)}</b><span class="muted small ellip">${esc(i.email)}</span><span class="member-meta">${esc(permSummary(i))} · ${esc(projSummary(i.projects, projects))}</span></span>
        <span class="col-btns"><button class="btn small-btn" data-resend="${esc(i.email)}" data-name="${esc(i.name || '')}" data-code="${esc(i.code || '')}">${ic('share', 18)}</button>
        <button class="btn small-btn danger" data-del="${esc(i.email)}" aria-label="Annuler">${ic('x', 18)}</button></span></div>`).join('')}` : ''}`;
  view.addEventListener('click', async e => {
    const r = e.target.closest('[data-resend]'); if (r) return shareInvite(r.dataset.resend, r.dataset.name, r.dataset.code);
    const d = e.target.closest('[data-del]');
    if (d && await confirmBox('Annuler cette invitation ?', esc(d.dataset.del), 'Annuler l’invitation')) {
      try { await cloud.removeInvite(d.dataset.del); render(); } catch (err) { toast(err.message, 4000); }
    }
  });
}

async function vInvite() {
  if (!cloud.isAdmin()) return vNotFound();
  setTop({ title: 'Inviter une personne', back: '#/team' });
  const projects = await db.all('projects');
  const state = { role: 'inspector', perms: { audit: true, details: false, export: true, actions: true }, projects: null };
  view.innerHTML = `
    <div class="card">
      <label class="f" style="margin-top:0">Nom et prénom</label><input class="in" id="t-name" autocomplete="off" placeholder="ex. Jan Peeters">
      <label class="f">Email</label><input class="in" id="t-mail" type="email" inputmode="email" autocomplete="off" placeholder="prenom.nom@…">
    </div>
    <div class="card">${accessForm(state, projects)}</div>
    <button class="btn primary big" id="t-go">${ic('share')} Créer l’invitation et envoyer le lien</button>`;
  bindAccessForm(state, () => {});
  $('#t-go').onclick = async () => {
    const mail = $('#t-mail').value.trim(), name = $('#t-name').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return toast('Adresse email invalide');
    try {
      await cloud.invite(mail, name, state.role, state.role === 'admin' ? null : state.perms, state.role === 'admin' ? null : state.projects);
      history.replaceState(null, '', '#/team'); render();
      shareInvite(mail.toLowerCase(), name);
    } catch (e) { toast(e.message, 4000); }
  };
}

async function vMember(id) {
  if (!cloud.isAdmin()) return vNotFound();
  view.innerHTML = '<div class="empty">Chargement…</div>';
  let t; try { t = await cloud.team(); } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const p = t.profiles.find(x => x.id === id); if (!p) return vNotFound();
  const [projects, insps] = await Promise.all([db.all('projects'), db.all('inspections')]);
  setTop({ title: p.name || p.email, sub: p.email, back: '#/team' });
  const mine = insps.filter(i => i.owner === id);
  const state = { role: p.role, perms: { audit: true, details: true, export: true, actions: true, ...(p.perms || {}) }, projects: p.projects };
  view.innerHTML = `
    <div class="kpi-row">
      <div><b>${mine.length}</b><span>Audits</span></div>
      <div><b>${mine.length ? Math.round(mine.map(i => overallScore(i.scores, i.bonus, i.penalty).pct).filter(x => x !== null).reduce((a, b, _, arr) => a + b / arr.length, 0) * 100) + '%' : '—'}</b><span>Score moyen</span></div>
      <div><b>${mine[0] ? dateFR(mine.sort((a, b) => b.date.localeCompare(a.date))[0].date).slice(0, 5) : '—'}</b><span>Dernier audit</span></div>
    </div>
    ${p.id === cloud.uid() ? '<div class="card small">C’est votre compte : vos droits d’administrateur ne peuvent pas être modifiés ici.</div>' : `
    <div class="card">${accessForm(state, projects)}</div>
    <p class="muted small" style="text-align:center">Enregistrement automatique · effet à la prochaine ouverture de l’app</p>
    <button class="btn block ${p.active ? 'danger' : 'primary'}" id="m-act">${p.active ? 'Bloquer l’accès' : 'Réactiver l’accès'}</button>`}`;
  if (p.id === cloud.uid()) return;
  const save = debounce(async () => {
    try { await cloud.setAccess(id, { role: state.role, perms: state.perms, projects: state.projects }); toast('Accès mis à jour'); } catch (e) { toast(e.message, 4000); }
  }, 600);
  onCleanup(() => save.flush && pendingSaves.has(save) && save.flush());
  bindAccessForm(state, save);
  $('#m-act').onclick = async () => {
    if (p.active && !await confirmBox('Bloquer cet accès ?', 'La personne ne pourra plus envoyer ni consulter de données. Ses audits restent visibles pour vous.', 'Bloquer')) return;
    try { await cloud.setActive(id, !p.active); render(); } catch (e) { toast(e.message, 4000); }
  };
}

// ---------- pilotage (admin) : statistiques par HSE, entreprise, période ----------
const statsF = { period: 30, scope: 'project' };
async function vStats() {
  if (!cloud.isAdmin()) return vNotFound();
  const [allInsps, allActs, { subs }, projects] = await Promise.all([db.all('inspections'), db.all('actions'), maps(), db.all('projects')]);
  // périmètre : un projet au choix, ou tous
  const pList = projects.filter(p => !p.archived).sort((a, b) => a.name.localeCompare(b.name));
  if (statsF.scope === 'project' || (statsF.scope !== 'all' && !pList.some(p => p.id === statsF.scope))) statsF.scope = PROJECT?.id || 'all';
  const scopeName = statsF.scope === 'all' ? 'Tous les projets' : (pList.find(p => p.id === statsF.scope)?.name || '');
  setTop({ title: 'Pilotage', sub: scopeName });
  const names = cloud.enabled ? await cloud.names() : {};
  const since = statsF.period ? todayISO(-statsF.period) : '0000';
  const scope = r => statsF.scope === 'all' || pid(r) === statsF.scope;
  const insps = allInsps.filter(i => scope(i) && i.date >= since);
  const acts = allActs.filter(a => scope(a) && !a.deleted);
  const pctOf = i => overallScore(i.scores, i.bonus, i.penalty).pct;
  const avg = l => { const v = l.map(pctOf).filter(x => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const who = i => (cloud.enabled && names[i.owner]?.name) || i.inspectors || 'Non renseigné';
  const group = (l, key) => { const m = new Map(); l.forEach(x => { const k = key(x); m.set(k, [...(m.get(k) || []), x]); }); return [...m.entries()]; };
  // un audit fait à deux compte pour chacun des deux HSE
  const people = i => (cloud.enabled && names[i.owner]?.name) ? [names[i.owner].name] : (i.inspectors || 'Non renseigné').split(/\s*(?:,|;|\/|&|\bet\b)\s*/i).map(x => x.trim()).filter(Boolean);
  const byHse = hseNames(insps, people).map(x => {
    const ids = new Set(x.l.map(i => i.id)), mineActs = acts.filter(a => ids.has(a.inspectionId) && a.status !== 'Closed');
    return { ...x, avg: avg(x.l), open: mineActs.length, late: mineActs.filter(isLate).length, last: x.l.reduce((m, i) => i.date > m ? i.date : m, '') };
  }).sort((a, b) => b.l.length - a.l.length || a.n.localeCompare(b.n));
  const bySub = [...new Set(insps.flatMap(subIdsOf))].map(id => [id, insps.filter(i => hasSub(i, id))]).map(([id, l]) => ({ s: subs[id], l, avg: avg(l), open: acts.filter(a => a.subId === id && a.status !== 'Closed').length })).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));
  const open = acts.filter(a => a.status !== 'Closed'), late = acts.filter(isLate);
  // infractions = critères notés 0, 1 ou 2 (comme les « constats prioritaires » du rapport), audits d'entreprise uniquement
  const compAudits = insps.filter(i => subIdsOf(i).length);
  const infr = (list) => {
    const m = new Map();
    for (const i of list) for (const [ref, sc] of Object.entries(i.scores || {})) {
      if (!criterionOfRef(ref) || sc?.v === null || sc?.v === undefined || sc.v === NA) continue;
      const e = m.get(ref) || { ref, n: 0, rated: 0, subs: new Map() };
      e.rated++;
      if (typeof sc.v === 'number' && sc.v <= 2) { e.n++; subIdsOf(i).forEach(id => e.subs.set(id, (e.subs.get(id) || 0) + 1)); }
      m.set(ref, e);
    }
    return [...m.values()].filter(e => e.n).sort((a, b) => b.n - a.n || b.n / b.rated - a.n / a.rated || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  };
  const topAll = infr(compAudits);
  const infSubs = [...new Set(compAudits.flatMap(subIdsOf))].map(id => ({ id, s: subs[id], l: compAudits.filter(i => hasSub(i, id)) }))
    .map(x => ({ ...x, top: infr(x.l) })).filter(x => x.s).sort((a, b) => b.top.reduce((t, e) => t + e.n, 0) - a.top.reduce((t, e) => t + e.n, 0));
  if (statsF.infSub && !infSubs.some(x => x.id === statsF.infSub)) statsF.infSub = '';
  const critName = ref => CRIT_FR[ref] || criterionOfRef(ref)?.name || ref;
  const themeName = ref => { const t = themeOfRef(ref); return t ? (THEME_FR[t.ref] || t.name) : ''; };
  // ---- tableau de bord infractions : 3 chiffres clés + top 10 en barres (noms entiers) ----
  const infCur = () => statsF.infSub ? (infSubs.find(x => x.id === statsF.infSub)?.top || []) : topAll;
  const isLSR = ref => /LSR/.test(themeOfRef(ref)?.name || '');
  const prevAudits = statsF.period ? allInsps.filter(i => scope(i) && subIdsOf(i).length && i.date >= todayISO(-2 * statsF.period) && i.date < since) : null;
  const sum = l => l.reduce((t, e) => t + e.n, 0);
  const subRank = infSubs.map(x => ({ id: x.id, t: sum(x.top) })).sort((a, b) => b.t - a.t);
  const infDash = () => {
    const list = infCur(), tot = sum(list), lsr = sum(list.filter(e => isLSR(e.ref))), pctL = tot ? Math.round(lsr / tot * 100) : 0;
    const prev = prevAudits ? sum(infr(prevAudits.filter(i => !statsF.infSub || hasSub(i, statsF.infSub)))) : null, d = prev === null ? null : tot - prev;
    const r = statsF.infSub ? subRank.findIndex(x => x.id === statsF.infSub) + 1 : 0, first = subRank[0] && subs[subRank[0].id];
    const top = list.slice(0, 10), max = Math.max(1, ...top.map(e => e.n));
    return `<div class="idash-kpi">
        <div class="ik"><b class="red">${tot}</b><span>infractions</span>${d === null ? '' : `<small class="${d > 0 ? 'bad' : d < 0 ? 'good' : ''}">${d > 0 ? '▲ +' + d : d < 0 ? '▼ ' + d : '='} vs période préc.</small>`}</div>
        <div class="ik ring-k"><span class="ring" style="--p:${pctL}"><b>${pctL}%</b></span><span>règles vitales (LSR)<small>${lsr} sur ${tot}</small></span></div>
        <div class="ik">${statsF.infSub ? `<b>${r}<sup>${r === 1 ? 're' : 'e'}</sup></b><span>sur ${subRank.length} entreprises</span><small>(1re = la plus concernée)</small>`
          : `<b class="nm">${esc(first?.name || '—')}</b><span>la plus concernée</span><small>${subRank[0]?.t || 0} infractions</small>`}</div>
      </div>
      <div class="ihead">Top 10 des infractions${statsF.infSub ? ' · ' + esc(subs[statsF.infSub]?.name || '') : ''}</div>
      ${top.map((e, k) => `<div class="ibar ${k < 3 ? 'hot' : ''}"><span class="ibar-l">${esc(critName(e.ref))}${isLSR(e.ref) ? ' <span class="lsr">LSR</span>' : ''}</span>
        <span class="ibar-r"><span class="ibar-b"><i style="width:${Math.max(3, e.n / max * 100)}%"></i></span><b>${e.n}</b></span></div>`).join('') || '<div class="empty">Aucune infraction sur la période 👍</div>'}`;
  };
  // activité : audits par semaine (8 dernières)
  const weeks = [...Array(8)].map((_, k) => { const end = todayISO(-7 * k), start = todayISO(-7 * k - 6); return { start, end, n: allInsps.filter(i => scope(i) && i.date >= start && i.date <= end).length }; }).reverse();
  const maxW = Math.max(1, ...weeks.map(w => w.n));
  const st = { Open: acts.filter(a => a.status === 'Open').length, 'In progress': acts.filter(a => a.status === 'In progress').length, Closed: acts.filter(a => a.status === 'Closed').length };
  const tot = Math.max(1, st.Open + st['In progress'] + st.Closed);

  view.innerHTML = `
    <div class="tabs3 four">${[[7, '7 j'], [30, '30 j'], [90, '3 mois'], [0, 'Tout']].map(([v, l]) => `<button data-per="${v}" class="${statsF.period === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${pList.length > 1 ? `<div class="chips-bar flush scope-bar"><button data-scope="all" class="${statsF.scope === 'all' ? 'on' : ''}">Tous les projets</button>${pList.map(p => `<button data-scope="${p.id}" class="${statsF.scope === p.id ? 'on' : ''}" style="--c:${esc(p.color || '#1A56A8')}"><i></i>${esc(p.name)}</button>`).join('')}</div>` : ''}
    <div class="kpi-grid">
      <div><b>${insps.length}</b><span>Audits</span></div>
      <div><b style="color:${rating(avg(insps)).color === '#9E9E9E' ? 'inherit' : textTone(rating(avg(insps)).color)}">${avg(insps) === null ? '—' : Math.round(avg(insps) * 100) + '%'}</b><span>Score moyen</span></div>
      <div><b>${open.length}</b><span>Actions ouvertes</span></div>
      <div class="${late.length ? 'late' : ''}"><b>${late.length}</b><span>En retard</span></div>
    </div>

    <div class="section-head"><span>Audits par HSE</span><span class="muted small">${byHse.length} personne${byHse.length > 1 ? 's' : ''} · touchez un nom pour ses audits</span></div>
    <div class="card stat-list hse-list">${byHse.map((x, k) => `
      <a class="stat-row hse-row ${k >= 5 ? 'more' : ''}" href="#/audits?hse=${encodeURIComponent(x.k)}"><span class="avatar sm">${esc(x.n.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())}</span>
        <span class="grow"><b>${esc(x.n)}</b><small class="muted">${x.l.length} audit${x.l.length > 1 ? 's' : ''} · dernier le ${dateFR(x.last).slice(0, 5)}${x.open ? ` · <span class="${x.late ? 'late' : ''}">${x.open} action${x.open > 1 ? 's' : ''} ouverte${x.open > 1 ? 's' : ''}${x.late ? ` (${x.late} en retard)` : ''}</span>` : ''}</small></span>
        ${x.avg === null ? '<span class="badge none">—</span>' : badge(x.avg)}</a>`).join('') || '<div class="empty">Aucun audit sur la période</div>'}
      ${byHse.length > 5 ? `<button type="button" class="link-btn hse-more" id="hse-more">Voir les ${byHse.length - 5} autres</button>` : ''}</div>

    <div class="section-head"><span>Activité</span><span class="muted small">audits par semaine</span></div>
    <div class="card week-chart">${weeks.map(w => `<div class="wcol"><span class="wn">${w.n || ''}</span><i style="height:${w.n / maxW * 100}%"></i><small>${w.start.slice(8, 10)}/${w.start.slice(5, 7)}</small></div>`).join('')}</div>

    <div class="section-head"><span>Entreprises</span><span class="muted small">score moyen sur la période</span></div>
    <div class="card stat-list">${bySub.map(x => `
      <a class="stat-row" href="#/sub/${x.s?.id}"><span class="mono xs" style="--c:${esc(x.s?.color || '#9E9E9E')}">${esc(abbr(x.s?.name))}</span>
        <span class="grow"><b>${esc(x.s?.name || '—')}</b><small class="muted">${typeOf(x.s).label} · ${x.l.length} audit${x.l.length > 1 ? 's' : ''}${x.open ? ` · <span class="${acts.some(a => a.subId === x.s?.id && isLate(a)) ? 'late' : ''}">${x.open} action${x.open > 1 ? 's' : ''}</span>` : ''}</small></span>
        ${x.avg === null ? '<span class="badge none">—</span>' : badge(x.avg)}</a>`).join('') || '<div class="empty">Aucun audit sur la période</div>'}</div>

    <div class="section-head"><span>Actions</span><span class="muted small">${acts.length} au total</span></div>
    <div class="card">
      <div class="stack">${STATUSES.map(k => st[k] ? `<i class="st-${k.replace(' ', '')}" style="width:${st[k] / tot * 100}%"></i>` : '').join('')}</div>
      <div class="stack-legend">${STATUSES.map(k => `<span><i class="kdot st-${k.replace(' ', '')}"></i>${{ Open: 'Ouvertes', 'In progress': 'En cours', Closed: 'Clôturées' }[k]} <b>${st[k]}</b></span>`).join('')}</div>
      <div class="stack-legend">${PRIOS.map(p => `<span class="prio-txt p-${p}">${PRIO_FR[p]} <b>${open.filter(a => a.priority === p).length}</b></span>`).join('')}<span class="muted small">(ouvertes)</span></div>
    </div>


    <div class="section-head"><span>Infractions</span><span class="muted small">critères notés 0 à 2</span></div>
    <div class="card idash">
      <select class="in f-sel ${statsF.infSub ? 'set' : ''}" id="inf-sub"><option value="">Toutes les entreprises</option>${infSubs.map(x => `<option value="${x.id}" ${x.id === statsF.infSub ? 'selected' : ''}>${esc(x.s.name)}</option>`).join('')}</select>
      <div id="inf-rows">${infDash()}</div>
    </div>

    <button class="btn block primary" id="st-x" style="margin-top:12px">${ic('download')} Exporter ces statistiques (Excel)</button>
    <button class="btn block" id="st-bi" style="margin-top:8px">${ic('download')} Excel données (Power BI) — une ligne par audit</button>`;
  view.addEventListener('click', e => {
    const p = e.target.closest('[data-per]'); if (p) { statsF.period = +p.dataset.per; render(); return; }
    const sc = e.target.closest('[data-scope]'); if (sc) { statsF.scope = sc.dataset.scope; render(); return; }
    if (e.target.closest('#hse-more')) { view.querySelector('.hse-list').classList.add('all'); e.target.closest('#hse-more').remove(); return; }
  });
  $('#inf-sub')?.addEventListener('change', e => { statsF.infSub = e.target.value; e.target.classList.toggle('set', !!statsF.infSub); $('#inf-rows').innerHTML = infDash(); });
  $('#st-bi').onclick = () => exportPowerBI().catch(e => toast('Erreur export : ' + e.message, 4000));
  $('#st-x').onclick = () => {
    const XLSX = window.XLSX, wb = XLSX.utils.book_new();
    const period = statsF.period ? `${statsF.period} derniers jours` : 'toute la période';
    const head = [[BRAND.name + ' — Pilotage'], [`Périmètre : ${scopeName} · ${period} · édité le ${dateFR(todayISO())}`], []];
    const sh1 = XLSX.utils.aoa_to_sheet([...head, ['HSE', 'Audits', 'Score moyen', 'Actions ouvertes', 'Dernier audit'], ...byHse.map(x => [x.n, x.l.length, x.avg === null ? '' : Math.round(x.avg * 1000) / 10 + ' %', x.open, dateFR(x.last)])]);
    const sh2 = XLSX.utils.aoa_to_sheet([...head, ['Entreprise', 'Type', 'Audits', 'Score moyen', 'Actions ouvertes'], ...bySub.map(x => [x.s?.name, typeOf(x.s).label, x.l.length, x.avg === null ? '' : Math.round(x.avg * 1000) / 10 + ' %', x.open])]);
    const sh3 = XLSX.utils.aoa_to_sheet([...head, ['Date', 'Projet', 'Entreprise', 'HSE', 'Référence', 'Score'], ...insps.sort((a, b) => a.date.localeCompare(b.date)).map(i => [dateFR(i.date), projects.find(p => p.id === pid(i))?.name || '', auditLabel(i, subs), who(i), i.ref, pctOf(i) === null ? '' : Math.round(pctOf(i) * 1000) / 10 + ' %'])]);
    [sh1, sh2, sh3].forEach(sh => { sh['!cols'] = [{ wch: 28 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 34 }, { wch: 10 }]; });
    const infLine = (e, k) => [k + 1, e.ref, critName(e.ref), themeName(e.ref), e.n, e.rated, Math.round(e.n / e.rated * 1000) / 10 + ' %'];
    const sh4 = XLSX.utils.aoa_to_sheet([...head, ['Rang', 'Réf.', 'Critère', 'Thème', 'Infractions (note 0–2)', 'Fois noté', 'Taux', 'Entreprises concernées'], ...topAll.slice(0, 10).map((e, k) => [...infLine(e, k), [...e.subs.keys()].map(id => subs[id]?.name).join(', ')])]);
    const sh5 = XLSX.utils.aoa_to_sheet([...head, ['Entreprise', 'Rang', 'Réf.', 'Critère', 'Thème', 'Infractions (note 0–2)', 'Fois noté', 'Taux', 'Objectif (à remplir)'], ...infSubs.flatMap(x => x.top.slice(0, 10).map((e, k) => [x.s.name, ...infLine(e, k), '']))]);
    sh4['!cols'] = [{ wch: 6 }, { wch: 7 }, { wch: 40 }, { wch: 30 }, { wch: 12 }, { wch: 10 }, { wch: 9 }, { wch: 40 }];
    sh5['!cols'] = [{ wch: 22 }, { wch: 6 }, { wch: 7 }, { wch: 40 }, { wch: 30 }, { wch: 12 }, { wch: 10 }, { wch: 9 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, sh1, 'Par HSE'); XLSX.utils.book_append_sheet(wb, sh2, 'Par entreprise'); XLSX.utils.book_append_sheet(wb, sh3, 'Audits');
    XLSX.utils.book_append_sheet(wb, sh4, 'Top 10 infractions'); XLSX.utils.book_append_sheet(wb, sh5, 'Infractions par entreprise');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    readySheet(new File([out], `PRT-pilotage-${todayISO()}.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  };
}

// ---------- personnalisation du rapport PDF (page de garde) ----------
const SECTION_LABELS = {
  findings: ['Constats prioritaires', 'critères notés 0 à 2'], actions: ['Actions correctives', 'tableau à suivre par l’entreprise'],
  plan: ['Localisation sur le plan', 'plan + zoom sur la zone'], details: ['Détail des constats', 'tous les critères évalués'],
  photos: ['Photos', 'avec légendes'], guide: ['Guide de lecture', 'barème et méthode de calcul'],
};
async function vReport(id) {
  const insp = await db.get('inspections', id);
  if (!insp || isLocked(insp) || !cloud.can('export')) return vNotFound();
  const { subs } = await maps();
  setTop({ title: 'Rapport PDF', sub: auditLabel(insp, subs), back: '#/insp/' + id });
  const lastLang = await db.getMeta('reportLang');
  const fresh0 = !insp.report?.lang;
  insp.report = { ...REPORT_DEFAULTS, ...(insp.report || {}), sections: { ...REPORT_DEFAULTS.sections, ...(insp.report?.sections || {}) } };
  const R = insp.report;
  // nouvelle langue par défaut = la dernière utilisée
  if (fresh0 && lastLang && lastLang !== R.lang) { if (R.title === REPORT_TITLES[R.lang]) R.title = REPORT_TITLES[lastLang]; R.lang = lastLang; }
  // mention au-dessus du nom de l'entreprise (« SOUS-TRAITANT », « PRESTATAIRE »…) : automatique selon la langue, ou personnalisée
  const ids = subIdsOf(insp);
  const kindKey = ids.length === 1 ? (subs[insp.subId]?.type === 'sub' ? 'sub' : 'entreprise') : ids.length ? 'multi' : 'zone';
  const kindAuto = () => (RTXT[R.lang] || RTXT.en).type[kindKey];
  const kindOf = () => (R.kind || '').trim() ? R.kind.trim().toUpperCase() : kindAuto();
  const save = debounce(() => db.put('inspections', insp), 300);
  onCleanup(() => save.flush());
  view.innerHTML = `
    <div class="report-preview">
      <div class="rp-band">${esc(R.title)}</div>
      <div class="rp-body"><small id="rp-kind">${esc(kindOf())}</small><b>${esc(auditLabel(insp, subs))}</b>
        <span>${dateFR(insp.date)} · ${esc(insp.inspectors || '')}</span></div>
    </div>
    <div class="section-head"><span>Page de garde</span></div>
    <div class="card">
      <label class="f" style="margin-top:0">Langue du rapport</label>
      <div class="seg" id="r-lang"><button type="button" data-lang="en" class="${R.lang !== 'fr' ? 'on' : ''}">English</button><button type="button" data-lang="fr" class="${R.lang === 'fr' ? 'on' : ''}">Français</button></div>
      <label class="f">Titre du rapport</label><input class="in" data-r="title" value="${esc(R.title)}">
      <label class="f">Mention au-dessus du nom</label><input class="in" data-r="kind" value="${esc(R.kind || '')}" placeholder="${esc(kindAuto())} (automatique)">
      <label class="f">À l’attention de</label><input class="in" data-r="to" value="${esc(R.to)}" placeholder="ex. Direction de chantier ${esc(subIdsOf(insp).length === 1 ? subs[insp.subId]?.name || '' : '')}">
      <label class="f">Synthèse</label><textarea class="in" data-r="summary" rows="5" placeholder="Message d’introduction : contexte de la visite, points forts, priorités…">${esc(R.summary)}</textarea>
    </div>
    <div class="section-head"><span>Informations de l’audit</span></div>
    <div class="card">
      <label class="f" style="margin-top:0">Projet / chantier</label><input class="in" data-i="site" value="${esc(insp.site || '')}">
      <label class="f">Zone</label><input class="in" data-i="zone" autocomplete="off" value="${esc(insp.zone || '')}">
      <div class="btns" style="margin-bottom:0"><div><label class="f">Inspecteur(s)</label><input class="in" data-i="inspectors" list="hse-list" value="${esc(insp.inspectors || '')}" autocomplete="off"></div>
      <div><label class="f">Date</label><input class="in" type="date" data-i="date" value="${esc(insp.date)}"></div></div>
    </div>
    <div class="section-head"><span>Contenu du rapport</span></div>
    <div class="perm-list">${Object.entries(SECTION_LABELS).map(([k, [l, h]]) => `<label class="perm-row"><span class="grow"><b>${l}</b><small>${h}</small></span><input type="checkbox" class="switch" data-sec="${k}" ${R.sections[k] ? 'checked' : ''}></label>`).join('')}</div>
    <button class="btn primary big" id="gen" style="margin-top:14px">${ic('file')} Générer le PDF</button>
    <button class="link-btn" id="reset-r" style="display:block;margin:8px auto">Rétablir les textes par défaut</button>`;
  zonePicker(view.querySelector('[data-i=zone]'));
  view.addEventListener('input', e => {
    const r = e.target.dataset.r, i = e.target.dataset.i;
    if (r) { R[r] = e.target.value; if (r === 'title') view.querySelector('.rp-band').textContent = e.target.value; if (r === 'kind') $('#rp-kind').textContent = kindOf(); save(); }
    if (i) { insp[i] = e.target.value; save(); }
  });
  view.addEventListener('change', e => { const k = e.target.dataset.sec; if (k) { R.sections[k] = e.target.checked; save(); } });
  $('#r-lang').onclick = e => {
    const b = e.target.closest('[data-lang]'); if (!b || b.dataset.lang === R.lang) return;
    if (!R.title || R.title === REPORT_TITLES[R.lang]) { R.title = REPORT_TITLES[b.dataset.lang]; view.querySelector('[data-r=title]').value = R.title; view.querySelector('.rp-band').textContent = R.title; }
    R.lang = b.dataset.lang; db.setMeta('reportLang', R.lang);
    $('#rp-kind').textContent = kindOf(); view.querySelector('[data-r=kind]').placeholder = kindAuto() + ' (automatique)';
    $('#r-lang').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); save.flush();
  };
  $('#reset-r').onclick = () => { const lang = R.lang || 'en'; insp.report = { ...REPORT_DEFAULTS, lang, title: REPORT_TITLES[lang], sections: { ...REPORT_DEFAULTS.sections } }; save.flush(); render(); };
  $('#gen').onclick = async () => {
    save.flush();
    const btn = $('#gen'); btn.disabled = true; btn.textContent = 'Génération…';
    try { const blob = await buildPDF(insp); readySheet(new File([blob], `${insp.ref}.pdf`, { type: 'application/pdf' })); }
    catch (err) { console.error(err); toast('Erreur : ' + err.message, 4000); }
    btn.disabled = false; btn.innerHTML = `${ic('file')} Générer le PDF`;
  };
}

function vNotFound() { setTop({ title: 'Introuvable', back: '#/' }); view.innerHTML = '<div class="empty">Élément introuvable ou supprimé.</div>'; }

// =====================================================================
// ROUTEUR
// =====================================================================
const routes = [
  [/^\/?$/, vHome, 'home'],
  [/^\/new$/, vNew, 'home'],
  [/^\/join$/, () => { location.replace('#/'); }, 'home'],
  [/^\/start\/([^/]+)$/, vStart, 'home'],
  [/^\/start$/, () => vStart(null), 'home'],
  [/^\/audits$/, vAudits, 'audits'],
  [/^\/audits-team$/, vTeamAudits, 'audits'],
  [/^\/insp\/([^/]+)$/, vInsp, 'audits'],
  [/^\/insp\/([^/]+)\/edit$/, vInspEdit, 'audits'],
  [/^\/insp\/([^/]+)\/sum$/, vSummary, 'audits'],
  [/^\/insp\/([^/]+)\/report$/, vReport, 'audits'],
  [/^\/insp\/([^/]+)\/t\/([\d.]+)$/, vTheme, 'audits'],
  [/^\/actions$/, vActions, 'actions'],
  [/^\/stats$/, vStats, 'stats'],
  [/^\/action\/([^/]+)$/, vAction, 'actions'],
  [/^\/map$/, vMap, 'map'],
  [/^\/subs$/, vSubs, 'audits'],
  [/^\/sub\/([^/]+)$/, vSub, 'audits'],
  [/^\/sub\/([^/]+)\/edit$/, vSubEdit, 'audits'],
  [/^\/plans$/, vProjects, 'home'],
  [/^\/settings$/, vSettings, 'home'],
  [/^\/projects$/, vProjects, 'home'],
  [/^\/project\/([^/]+)$/, vProject, 'home'],
  [/^\/plan\/([^/]+)\/zones$/, vZones, 'home'],
  [/^\/companies$/, vCompanies, 'home'],
  [/^\/team$/, vTeam, 'home'],
  [/^\/invite$/, vInvite, 'home'],
  [/^\/member\/([^/]+)$/, vMember, 'home'],
];

let renderSeq = 0;
/** Suggestions du champ « Inspecteur » : les noms déjà utilisés, écrits proprement (évite « jean » / « Jean ») */
async function fillHseList() {
  let dl = document.getElementById('hse-list');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'hse-list'; document.body.appendChild(dl); }
  const names = hseNames(await db.all('inspections'), i => hseSplit(i.inspectors)).map(x => x.n);
  if (cloud.enabled && cloud.myName()) names.unshift(cloud.myName());
  dl.innerHTML = [...new Set(names)].sort((a, b) => a.localeCompare(b)).map(n => `<option value="${esc(n)}">`).join('');
}
/** Menu latéral (écran large) : projet actif en bas, cliquable pour en changer */
function drawSideFoot() {
  const f = document.getElementById('side-foot'); if (!f) return;
  f.innerHTML = PROJECT ? `<button type="button" class="side-proj"><span class="side-dot" style="background:${esc(PROJECT.color || '#1A56A8')}">${esc(abbr(PROJECT.name))}</span>
    <span class="side-pname"><b>${esc(PROJECT.name)}</b><small>${esc(PROJECT.site || 'Projet actif')} · changer</small></span></button>
    <span class="side-ver">${esc(BRAND.name)} · v${APP_VERSION}</span>` : '';
  f.querySelector('.side-proj')?.addEventListener('click', () => projectSheet());
}
let lastPath = null;
async function render() {
  const seq = ++renderSeq;
  cleanups.forEach(f => { try { f(); } catch { /* ignore */ } }); cleanups = [];
  document.querySelectorAll('.sheet-bg, .kghost, .pviewer, .annot').forEach(s => s.remove());
  if (PROJECT) await loadProject(); // projet actif relu à chaque écran (entreprises cochées, nom, plans…)
  await applyBrand(); drawSideFoot();
  // nouveau nœud pour supprimer les écouteurs de l'écran précédent
  const fresh = view.cloneNode(false); view.replaceWith(fresh); view = fresh;
  fresh.className = ''; // chaque écran repart d'une mise en page neutre (sinon le mode « plan » restait actif)
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const q = new URLSearchParams(qs || '');
  for (const [re, fn, tab] of routes) {
    const m = path.match(re);
    if (!m) continue;
    document.querySelectorAll('#tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
    try {
      const args = m.slice(1);
      await (args.length ? fn(...args, q) : fn(q));
      if (seq === renderSeq && fresh.querySelector('[list="hse-list"]')) fillHseList();
      if (seq === renderSeq && path !== lastPath && !matchMedia('(prefers-reduced-motion: reduce)').matches) fresh.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: 170, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
      lastPath = path;
    } catch (err) { console.error(err); if (seq === renderSeq) fresh.innerHTML = `<div class="empty">Erreur : ${esc(err.message)}</div>`; }
    window.scrollTo(0, 0);
    return;
  }
  vNotFound();
}

window.addEventListener('hashchange', render);
// app mise en arrière-plan : on écrit immédiatement les saisies en attente
document.addEventListener('visibilitychange', () => { if (document.hidden) [...pendingSaves].forEach(d => d.flush()); });
window.addEventListener('pagehide', () => [...pendingSaves].forEach(d => d.flush()));

const seedId = name => 'sub-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const SEED_PLAN_ID = 'plan-sam2a', SEED_PLAN_BLOB = 'blob-plan-sam2a';

/** Anciennes installations : les sous-traitants / le plan de départ reçoivent leur identifiant fixe */
async function migrateSeedIds() {
  if (await db.getMeta('ids-v3')) return;
  const remap = {};
  for (const s of await db.all('subs', { includeDeleted: true })) {
    const seedSub = SEED_SUBS.find(x => x.name.toLowerCase() === (s.name || '').toLowerCase());
    if (!seedSub || s.id === seedId(seedSub.name)) continue;
    remap[s.id] = seedId(seedSub.name);
    await db.putRaw('subs', { ...s, id: remap[s.id] }); await db.purge('subs', s.id);
  }
  for (const p of await db.all('plans', { includeDeleted: true })) {
    if (!SEED_PLAN || p.code !== SEED_PLAN.code || p.id === SEED_PLAN_ID) continue;
    remap[p.id] = SEED_PLAN_ID;
    await db.putRaw('plans', { ...p, id: SEED_PLAN_ID }); await db.purge('plans', p.id);
    if (await db.getMeta('lastPlan') === p.id) await db.setMeta('lastPlan', SEED_PLAN_ID);
  }
  if (Object.keys(remap).length) {
    for (const store of ['inspections', 'actions']) for (const r of await db.all(store, { includeDeleted: true })) {
      if (remap[r.subId] || remap[r.planId]) await db.putRaw(store, { ...r, subId: remap[r.subId] || r.subId, planId: remap[r.planId] || r.planId });
    }
  }
  await db.setMeta('ids-v3', true);
}

/** Couleurs distinctes pour les sous-traitants de départ + nettoyage des fiches vides */
async function fixSubs() {
  if (await db.getMeta('subs-v4')) return;
  for (const s of await db.all('subs')) {
    const seedSub = SEED_SUBS.find(x => x.name.toLowerCase() === (s.name || '').toLowerCase());
    if (seedSub && s.color !== seedSub.color) await db.put('subs', { ...s, color: seedSub.color });
    if (!(s.name || '').trim()) {
      const used = (await db.byIndex('inspections', 'subId', s.id)).length + (await db.byIndex('actions', 'subId', s.id)).length;
      if (!used) await db.remove('subs', s.id);
    }
  }
  await db.setMeta('subs-v4', true);
}

async function seed() {
  await migrateSeedIds();
  await fixSubs();
  if (SEED_LOCATIONS.length && !(await db.getMeta('locations'))) await db.setMeta('locations', SEED_LOCATIONS); // noms de zones suggérés (gardés après le 1er démarrage)
  if (await db.getMeta('seeded-v3')) return;
  const existing = await db.all('subs', { includeDeleted: true });
  for (const s of SEED_SUBS) {
    if (!existing.some(e => (e.name || '').toLowerCase() === s.name.toLowerCase())) await db.put('subs', { ...s, id: seedId(s.name), contact: '', phone: '', archived: false });
  }
  const plans = await db.all('plans');
  if (SEED_PLAN && !plans.some(p => p.code === SEED_PLAN.code)) {
    // le plan de départ est facultatif : s'il n'est plus publié (confidentialité), on l'importe depuis Réglages → Projets et plans
    const res = await fetch(SEED_PLAN.file).catch(() => null);
    const blob = res?.ok ? await res.blob() : null;
    if (blob && /^image\//.test(blob.type)) {
      await db.putBlob(blob, SEED_PLAN_BLOB);
      await db.put('plans', { id: SEED_PLAN_ID, name: SEED_PLAN.name, code: SEED_PLAN.code, blobId: SEED_PLAN_BLOB });
      await db.setMeta('lastPlan', SEED_PLAN_ID);
    }
  }
  await db.setMeta('seeded-v3', true);
}

// couleurs lisibles partout, y compris sur ce qui s'affiche après coup (épingles, listes…)
new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
  if (n.nodeType !== 1) return;
  applyInk(n);
}))).observe(document.body, { childList: true, subtree: true });
(async function boot() {
  navigator.storage?.persist?.().catch(() => {}); // demande au navigateur de ne pas effacer les audits
  applyTheme((await getSettings()).theme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', async () => applyTheme((await getSettings()).theme));
  if ('serviceWorker' in navigator) watchUpdates();
  if (!(await db.getMeta('seeded-v3')) || !(await db.getMeta('ids-v3'))) await loadSeed(); // données de départ privées : premier démarrage (ou très ancienne installation)
  try { await cloud.init(); } catch (e) { console.error('cloud', e); }
  await applyBrand().catch(() => {});
  if (cloud.enabled && !cloud.session) return showLogin();
  await startApp();
})();

/** Mise à jour : la nouvelle version se télécharge en arrière-plan, puis un bandeau propose de l'activer en un toucher */
function watchUpdates() {
  let asked = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (asked) location.reload(); });
  const offer = w => {
    if (!w || !navigator.serviceWorker.controller || document.querySelector('.upd-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'upd-bar';
    bar.innerHTML = `<span>${ic('download', 20)}<b>Nouvelle version disponible</b></span><button class="btn primary small-btn">Mettre à jour</button>`;
    bar.querySelector('button').onclick = () => { asked = true; [...pendingSaves].forEach(d => d.flush()); bar.querySelector('button').textContent = 'Mise à jour…'; w.postMessage('skipWaiting'); };
    document.body.appendChild(bar);
  };
  navigator.serviceWorker.register('sw.js').then(reg => {
    offer(reg.waiting);
    reg.addEventListener('updatefound', () => { const w = reg.installing; w?.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); }); });
    // vérifie s'il y a du neuf quand on revient dans l'app (au plus une fois par minute)
    let last = Date.now();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - last > 60000) { last = Date.now(); reg.update().catch(() => {}); } });
  }).catch(e => console.warn('SW', e));
}

async function startApp() {
  document.body.classList.remove('login-mode');
  document.body.classList.toggle('role-hse', !cloud.isAdmin());
  // sous-traitants et plan de départ avec identifiants fixes, identiques sur tous les téléphones
  // (seul l'admin les envoie au serveur, voir cloud.push)
  try { await seed(); await migrateProjects(); } catch (e) { console.error('seed', e); }
  await loadProject();
  cloud.onStatus(drawSync);
  cloud.syncSoon(0);
  render();
}

// ---------- écran de connexion ----------
function showLogin() {
  document.body.classList.add('login-mode');
  const join = location.hash.startsWith('#/join') ? new URLSearchParams(location.hash.split('?')[1] || '') : null;
  let mode = join ? 'up' : 'in';
  const label = () => mode === 'up' ? 'Créer mon compte' : 'Se connecter';
  const draw = () => {
    view.innerHTML = `
      <div class="login">
        <div class="login-logo"><img src="icons/icon-192.png" alt=""></div>
        <h1>${esc(BRAND.name)}</h1>
        <p class="muted">Inspections HSE · Site HSE Performance Rating</p>
        <div class="tabs3 two"><button type="button" data-m="in" class="${mode === 'in' ? 'on' : ''}">Se connecter</button><button type="button" data-m="up" class="${mode === 'up' ? 'on' : ''}">Créer mon compte</button></div>
        <form id="lf" autocomplete="on">
          ${mode === 'up' ? '<label class="f">Nom et prénom</label><input class="in" id="l-name" autocomplete="name" required>' : ''}
          ${mode === 'up' ? '<label class="f">Code d’invitation <span class="muted small">(dans le message reçu)</span></label><input class="in" id="l-code" autocomplete="off" autocapitalize="characters" spellcheck="false">' : ''}
          <label class="f">Email professionnel</label><input class="in" id="l-mail" type="email" inputmode="email" autocomplete="username" required>
          <label class="f">Mot de passe</label><input class="in" id="l-pass" type="password" autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}" minlength="8" required>
          <p class="login-err" id="l-err"></p>
          <button class="btn primary big" id="l-go">${label()}</button>
        </form>
        <p class="muted small login-foot">${mode === 'up' ? 'Réservé aux adresses invitées par l’administrateur HSE.' : 'Accès sur invitation · une seule connexion par téléphone.'}</p>
      </div>`;
    view.querySelector('.tabs3').onclick = e => { const b = e.target.closest('[data-m]'); if (b) { mode = b.dataset.m; draw(); } };
    $('#lf').onsubmit = async e => {
      e.preventDefault();
      const btn = $('#l-go'); btn.disabled = true; btn.textContent = 'Connexion…'; $('#l-err').textContent = '';
      try {
        if (mode === 'up') await cloud.signUp($('#l-mail').value, $('#l-pass').value, $('#l-name').value, $('#l-code').value);
        else await cloud.signIn($('#l-mail').value, $('#l-pass').value);
        history.replaceState(null, '', '#/'); await startApp();
      } catch (err) { $('#l-err').textContent = err.message; btn.disabled = false; btn.textContent = label(); }
    };
  };
  setTop({ title: '' });
  draw();
  if (join) { $('#l-mail').value = join.get('e') || ''; if ($('#l-name')) $('#l-name').value = join.get('n') || ''; if ($('#l-code')) $('#l-code').value = join.get('c') || ''; $('#l-pass').focus(); }
}

// ---------- indicateur de synchronisation ----------
function syncLabel(st) {
  if (!cloud.enabled) return null;
  if (st.state === 'offline') return { cls: 'off', txt: st.pending ? `Hors ligne · ${st.pending} en attente` : 'Hors ligne' };
  if (st.state === 'syncing') return { cls: 'run', txt: 'Synchronisation…' };
  if (st.state === 'error') return { cls: 'err', txt: st.pending ? `${st.pending} en attente · réessayer` : 'Erreur · réessayer' };
  if (st.pending) return { cls: 'run', txt: `${st.pending} en attente d’envoi` };
  return { cls: 'ok', txt: 'Synchronisé' };
}
function drawSync(st = cloud.status) {
  document.querySelectorAll('.sync-pill').forEach(el => {
    const l = syncLabel(st); if (!l) { el.hidden = true; return; }
    el.hidden = false; el.className = 'sync-pill ' + l.cls; el.innerHTML = `<i></i>${esc(l.txt)}`;
  });
}
