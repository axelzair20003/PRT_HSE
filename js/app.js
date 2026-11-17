// PRT HSE — application principale (routeur + écrans)
import { THEMES } from './prt-data.js';
import { NA, SCALE, RATINGS, rating, themeScore, overallScore, criterionOfRef, themeOfRef, fmtPct } from './calc.js';
import * as db from './db.js';
import { createPlanViewer } from './plan.js';
import { compressImage, planFileToBlob, pdfPageCount } from './images.js';
import { ic } from './icons.js';
import * as cloud from './cloud.js';
import { SEED_SUBS, SEED_LOCATIONS, SEED_PLAN, SEED_SITE } from './seed.js';
import { CRIT_FR, TXT as RTXT } from './report-fr.js';
import { REPORT_DEFAULTS, REPORT_TITLES, buildXLSX, buildPDF, shareFile, download, canShareFile, actionRef } from './export.js';

export const APP_VERSION = '3.6.0';

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
    <h3 style="margin-top:16px">Rating</h3>
    ${RATINGS.map(r => `<div class="row" style="margin:6px 0"><span class="badge" style="background:${r.color};color:${r.fg};min-width:130px">${r.name}</span><span>${esc(r.range)}</span></div>`).join('')}
    <p class="muted small">Un thème entièrement N/A est exclu de la moyenne globale. Overall = moyenne des thèmes notés + Bonus/100 − Pénalité/100, borné 0–100 %.</p>
    <button class="btn block primary" data-close>Fermer</button>`);
}

const badge = pct => { const r = rating(pct); return `<span class="badge" style="background:${r.color};color:${r.fg}">${pct === null ? 'N/A' : Math.round(pct * 100) + '%'}</span>`; };
const ratingChip = pct => { const r = rating(pct); return `<span class="chip" style="background:${r.color};color:${r.fg}">${r.name}</span>`; };
const subChip = s => s ? `<span class="chip" style="background:${esc(s.color || '#1A56A8')};color:#fff">${esc(s.name || 'Sans nom')}</span>` : '<span class="chip" style="background:#9E9E9E">—</span>';

async function getSettings() { return await db.getMeta('settings', { inspector: 'Ahmed', site: SEED_SITE, theme: 'auto' }); }
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
async function loadProject() {
  const list = await allowedProjects();
  const id = await db.getMeta('project');
  PROJECT = list.find(p => p.id === id) || list[0] || null;
  if (PROJECT && PROJECT.id !== id) await db.setMeta('project', PROJECT.id);
  return PROJECT;
}
/** Enregistrements du projet courant uniquement */
async function pAll(store) { return (await db.all(store)).filter(inProject); }
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

/** Installations existantes : tout est rattaché au projet SAM 2A */
async function migrateProjects() {
  if (await db.getMeta('projects-v1')) return;
  if (!(await db.get('projects', DEFAULT_PROJECT))) {
    const subs = (await db.all('subs')).filter(s => (s.name || '').trim());
    await db.put('projects', { id: DEFAULT_PROJECT, name: 'SAM 2A', code: 'SAM2A', site: 'Farciennes', color: '#0B2D5B', companyIds: subs.map(s => s.id), archived: false });
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
function photoViewer(id, onDelete) {
  db.blobURL(id).then(u => openSheet(`<img src="${u}" style="width:100%;border-radius:12px"><div class="btns"><button class="btn danger" data-del>Supprimer</button><button class="btn primary" data-close>Fermer</button></div>`,
    (el, close) => el.querySelector('[data-del]').onclick = async () => { if (await confirmBox('Supprimer la photo ?', '')) { close(); onDelete(); } }));
}
async function addPhotos(fileList) {
  const ids = [];
  for (const f of fileList) { const b = await compressImage(f); ids.push(await db.putBlob(b)); }
  return ids;
}

// =====================================================================
// ÉCRANS
// =====================================================================

async function vHome() {
  setTop({ title: PROJECT?.name || 'Inspections HSE', sub: 'Inspections HSE · changer de projet', onTitle: projectSheet, actions: [{ icon: 'gear', aria: 'Réglages', onClick: () => location.hash = '#/settings' }] });
  const [{ subs, subList }, insps, acts] = await Promise.all([maps(), pAll('inspections'), pAll('actions')]);
  const recent = [...insps].sort((a, b) => (b.date + b.updatedAt).localeCompare(a.date + a.updatedAt)).slice(0, 6);
  const late = acts.filter(isLate).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const today = new Date().toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' });
  // bandeau de tête (écran large) : projet, photo du chantier, chiffres clés
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const month = insps.filter(i => i.date >= since);
  const pcts = month.map(i => overallScore(i.scores, i.bonus, i.penalty).pct).filter(x => x !== null);
  const avgPct = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
  const openActs = acts.filter(a => a.status !== 'Closed').length;
  view.innerHTML = `
    ${cloud.enabled ? '<button class="sync-pill" id="sync-now" hidden></button>' : ''}
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
    ${cloud.can('audit') ? `<a class="btn primary big new-audit" href="#/start">${ic('plus')}<span>Nouvel audit<small>zone, une ou plusieurs entreprises</small></span></a>` : ''}
    <div class="home-cols"><div class="home-main">
    <div class="section-head"><span>Audit rapide · 1 entreprise</span><span class="muted small" style="text-transform:capitalize">${esc(today)}</span></div>
    ${cloud.can('audit') ? (subList.some(s => !s.archived) ? subGrid(subList, insps, acts) : noCompanyCard()) : '<div class="card muted">Votre accès ne permet pas de lancer des audits. Contactez l’administrateur HSE.</div>'}
    </div><div class="home-side">
    ${late.length ? `<div class="section-head late"><span class="row" style="gap:6px">${ic('alert', 18)} Actions en retard</span><span>${late.length}</span></div>
      ${late.slice(0, 5).map(a => actionCard(a, subs)).join('')}
      ${late.length > 5 ? `<a class="btn block" href="#/actions?late=1">Voir les ${late.length} actions</a>` : ''}` : ''}
    <div class="section-head"><span>${cloud.enabled && cloud.isAdmin() ? 'Audits de l’équipe' : cloud.enabled ? 'Mes audits' : 'Inspections récentes'}</span>${insps.length ? `<span class="muted small">${insps.length} au total</span>` : ''}</div>
    ${inspList(recent, subs) || '<div class="empty">Aucune inspection pour l’instant.<br>Touchez une entreprise pour commencer.</div>'}
    </div></div>`;
  // photo du chantier (plan) en fond du bandeau, logo du projet s'il existe
  (async () => {
    const plan = (await maps()).planList[0];
    const hero = view.querySelector('.home-hero');
    if (plan?.blobId && hero) hero.style.setProperty('--hero-img', `url("${await db.blobURL(plan.blobId)}")`);
    if (PROJECT?.logoId) { const u = await db.blobURL(PROJECT.logoId); if (u) $('#hero-logo').src = u; }
  })();
  bindSubGrid();
  $('#pick-comp')?.addEventListener('click', pickProjectCompanies);
  drawSync();
  $('#sync-now')?.addEventListener('click', () => cloud.sync());
}

/** Projet encore sans entreprise : on explique et on propose de les choisir tout de suite */
function noCompanyCard() {
  return `<div class="card empty-proj"><b>Aucune entreprise dans ${esc(PROJECT?.name || 'ce projet')}</b>
    <p class="muted small">${cloud.isAdmin() ? 'Choisissez dans l’annuaire les entreprises qui travaillent sur ce projet.' : 'L’administrateur HSE doit d’abord ajouter les entreprises de ce projet.'}</p>
    ${cloud.isAdmin() ? `<button class="btn primary block" id="pick-comp">${ic('plus')} Ajouter des entreprises</button>` : ''}</div>`;
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
    const r = rating(pct);
    const status = last?.date === today ? '<span class="tile-tag">En cours</span>'
      : last ? `<span class="tile-score" style="background:${r.color};color:${r.fg}">${pct === null ? 'N/A' : Math.round(pct * 100) + '%'}</span><span>${dateFR(last.date).slice(0, 5)}</span>`
      : '<span class="tile-none">Aucun audit</span>';
    return `<button type="button" class="sub-tile" data-start="${s.id}" style="--c:${esc(s.color)}">
      <span class="tile-top"><span class="mono">${esc(abbr(s.name))}</span><span class="tile-name"><b>${esc(s.name)}</b>${s.type === 'sub' ? `<span class="tile-type">${COMPANY_TYPES.sub.label}</span>` : ''}</span></span>
      <span class="tile-meta">${status}${open ? `<span class="tile-act ${late ? 'late' : ''}">${ic('list', 14)}${open}</span>` : ''}</span>
    </button>`;
  }).join('')}</div>`;
}
function bindSubGrid() {
  view.querySelectorAll('[data-start]').forEach(b => b.onclick = () => startInspection(b.dataset.start));
}
// ---------- audits : 0, 1 ou plusieurs entreprises ----------
const subIdsOf = i => Array.isArray(i?.subIds) ? i.subIds : (i?.subId ? [i.subId] : []);
const hasSub = (i, id) => subIdsOf(i).includes(id);
/** Libellé d'un audit : « TRBA », « TRBA + VKE », « TRBA + 3 autres » ou « Audit de zone » */
function auditLabel(i, subs) {
  const n = subIdsOf(i).map(id => subs[id]?.name).filter(Boolean);
  if (!n.length) return 'Audit de zone';
  return n.length <= 2 ? n.join(' + ') : `${n[0]} + ${n.length - 1} autres`;
}
const auditColor = (i, subs) => { const ids = subIdsOf(i); return ids.length === 1 ? (subs[ids[0]]?.color || '#9E9E9E') : '#0B2D5B'; };
const auditAbbr = (i, subs) => { const ids = subIdsOf(i); return ids.length === 1 ? abbr(subs[ids[0]]?.name) : ids.length ? '×' + ids.length : 'ZON'; };

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
async function createInspection(subIds, pin, zone = '', visitId = null) {
  const st = await getSettings();
  const plans = await pAll('plans');
  const last = await db.getMeta('lastPlan');
  const plan = plans.find(p => p.id === last) || plans[0] || null;
  const subs = (await Promise.all(subIds.map(id => db.get('subs', id)))).filter(Boolean);
  const date = todayISO();
  const ref = await nextRef(plan, subs.length === 1 ? subs[0] : { name: subs.length ? 'MULTI' : 'ZONE' }, date);
  return db.put('inspections', { owner: cloud.uid(), visitId, subIds, subId: subIds[0] || null, planId: plan?.id || null, pin: pin || null, zone, inspectors: cloud.enabled ? cloud.myName() : st.inspector, date, site: PROJECT?.site ? `${PROJECT.name} — ${PROJECT.site}` : (PROJECT?.name || st.site), projectId: PROJECT?.id || DEFAULT_PROJECT, ref, scores: {}, bonus: 0, penalty: 0 });
}
/** Nouvel audit : zone sur le plan (facultative) + entreprises concernées (0, 1 ou plusieurs) */
async function vStart(subId) {
  const { subs, plans, planList, subList } = await maps();
  if (subId && !subs[subId]) return vNotFound();
  const chosen = new Set(subId ? [subId] : []);
  setTop({ title: 'Nouvel audit', sub: `${PROJECT?.name || ''} · ${dateFR(todayISO())}`, back: '#/' });
  const plan = plans[await db.getMeta('lastPlan')] || planList[0];
  const active = subList.filter(s => !s.archived).sort((a, b) => a.name.localeCompare(b.name));
  let pin = null;
  view.innerHTML = `
    <div class="step-head"><span class="step-n">1</span><b>Où ?</b><span class="muted small">Touchez la zone sur le plan (facultatif)</span></div>
    <div id="spick" class="pv start-map2"></div>
    <input class="in" id="s-zone" list="zones" placeholder="Nom de la zone (ex. Roof DCH4, UTI 11…)" style="margin-top:8px">
    <datalist id="zones">${SEED_LOCATIONS.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
    <div class="step-head"><span class="step-n">2</span><b>Quelle(s) entreprise(s) ?</b><span class="muted small" id="s-count"></span></div>
    <div class="pick-grid">${active.map(s => `<button type="button" class="pick ${chosen.has(s.id) ? 'on' : ''}" data-s="${s.id}" style="--c:${esc(s.color)}"><span class="mono xs">${esc(abbr(s.name))}</span><span class="grow">${esc(s.name)}</span>${ic('check', 16)}</button>`).join('')}</div>
    <p class="muted small" id="s-note" style="margin:8px 2px 0"></p>
    <button class="btn primary big" id="go" style="margin-top:14px">Commencer l’audit</button>`;
  const refresh = () => {
    const n = chosen.size;
    $('#s-count').textContent = n ? `${n} sélectionnée${n > 1 ? 's' : ''}` : 'aucune = audit de zone';
    $('#go').textContent = n === 0 ? 'Commencer l’audit de zone' : n === 1 ? `Commencer l’audit ${subs[[...chosen][0]].name}` : `Créer ${n} audits séparés`;
    $('#s-note').textContent = n > 1 ? `Un audit et un score par entreprise. Vous passez de l’un à l’autre en un tap.` : 'Aucune entreprise cochée = audit de la zone ou du chantier en général.';
    if (pin) pv?.setPins([{ id: 'p', ...pin, color: n === 1 ? subs[[...chosen][0]].color : '#0B2D5B', label: n === 1 ? abbr(subs[[...chosen][0]].name) : n ? '×' + n : 'ZON', ghost: true }]);
  };
  let pv = null;
  if (plan) {
    pv = createPlanViewer($('#spick'), {
      imageURL: await db.blobURL(plan.blobId), pins: [], cover: 2.4,
      onTap: (x, y) => { pin = { x, y }; refresh(); navigator.vibrate?.(15); },
    });
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
    const ids = [...chosen], zone = $('#s-zone').value.trim();
    if (ids.length <= 1) { const insp = await createInspection(ids, pin, zone); location.replace('#/insp/' + insp.id); return; }
    // plusieurs entreprises → une tournée de N audits séparés (même zone, même date)
    const visitId = db.uid(); let first = null;
    for (const [k, id] of ids.entries()) {
      const p2 = pin ? { x: clamp01(pin.x + (k ? Math.cos(k * 2.1) * 0.025 : 0)), y: clamp01(pin.y + (k ? Math.sin(k * 2.1) * 0.025 : 0)) } : null;
      const insp = await createInspection([id], p2, zone, visitId); first ||= insp;
    }
    toast(`${ids.length} audits créés`);
    location.replace('#/insp/' + first.id); // « retour » ne recrée pas d'audit
  };
}
/** Abréviation affichée dans les épingles : 3 premières lettres */
const abbr = name => (name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
/** Audit à plusieurs entreprises : à laquelle rattacher l'action ? */
function chooseCompany(insp, subs) {
  const ids = subIdsOf(insp);
  if (ids.length <= 1) return Promise.resolve(ids[0] || null);
  return ask('Action pour quelle entreprise ?', '', [...ids.map(id => ({ label: subs[id]?.name || '?', value: id, cls: 'primary' })), { label: 'Toutes / générale', value: '' }]).then(v => v === undefined ? null : (v || null));
}

function inspCard(i, subs) {
  const o = overallScore(i.scores, i.bonus, i.penalty);
  const done = o.themes.reduce((a, t) => a + t.done, 0);
  const s = { name: auditLabel(i, subs), color: auditColor(i, subs) };
  const who = cloud.enabled && cloud.isAdmin() && i.owner !== cloud.uid() ? `${esc(i.inspectors || '')} · ` : '';
  const lock = isLocked(i) ? `<span class="lock-tag">${ic('check', 13)} Transmis</span>` : '';
  return `<a class="card link insp-card" href="#/insp/${i.id}" style="--c:${esc(s?.color || '#9E9E9E')}">${lock}
    <div class="grow">
      <b class="insp-sub">${esc(s.name)}</b>
      <div class="insp-meta">${who}${dateFR(i.date)} · ${done}/124 critères</div>
      ${i.pin || i.zone ? `<div class="insp-loc">${ic('pin', 14)} ${esc(i.zone || 'Localisé sur le plan')}</div>` : ''}
    </div>
    ${o.pct === null ? '<span class="badge none">—</span>' : badge(o.pct)}</a>`;
}
/** Liste d'audits : ceux d'une même tournée (lancés ensemble) sont regroupés dans un seul bloc */
function inspList(list, subs) {
  const byVisit = {};
  list.forEach(i => { if (i.visitId) (byVisit[i.visitId] ||= []).push(i); });
  const done = new Set();
  return list.map(i => {
    const grp = i.visitId && byVisit[i.visitId].length > 1 ? byVisit[i.visitId] : null;
    if (!grp) return inspCard(i, subs);
    if (done.has(i.visitId)) return '';
    done.add(i.visitId);
    const zone = grp.find(x => x.zone)?.zone;
    const rows = [...grp].sort((a, b) => auditLabel(a, subs).localeCompare(auditLabel(b, subs))).map(x => {
      const o = overallScore(x.scores, x.bonus, x.penalty), n = o.themes.reduce((a, t) => a + t.done, 0);
      return `<a class="vg-row" href="#/insp/${x.id}" style="--c:${esc(auditColor(x, subs))}"><span class="mono">${esc(auditAbbr(x, subs))}</span>
        <span class="grow"><b>${esc(auditLabel(x, subs))}</b><small>${n}/124 critères</small></span>${o.pct === null ? '<span class="badge none">—</span>' : badge(o.pct)}</a>`;
    }).join('');
    return `<div class="card visit-group">
      <div class="vg-head">${ic('pin', 16)}<span class="grow"><b>Tournée · ${grp.length} entreprises</b><small>${dateFR(i.date)}${zone ? ' · ' + esc(zone) : ''}</small></span></div>${rows}</div>`;
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
    <label class="f" style="margin-top:4px">Zone — touchez le plan pour poser l’épingle</label>
    <div id="pick" class="pv plan-box"></div>
    <input class="in" id="f-zone" list="zones" placeholder="Zone (ex. Roof DCH4, UTI 11, FSA C…)" value="${esc(state.zone || '')}" style="margin-top:8px">
    <datalist id="zones">${SEED_LOCATIONS.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
    <label class="f">Entreprise auditée</label>
    <div class="pick-grid" id="f-subs">${subsActive.map(s => `<button type="button" class="pick ${subIdsOf(state).includes(s.id) ? 'on' : ''}" data-s="${s.id}" style="--c:${esc(s.color)}"><span class="mono xs">${esc(abbr(s.name))}</span><span class="grow">${esc(s.name)}</span>${ic('check', 16)}</button>`).join('')}</div>
    ${planList.length > 1 ? `<label class="f">Plan</label><select class="in" id="f-plan">${planList.map(p => `<option value="${p.id}" ${p.id === state.planId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
    <label class="f">Inspecteur(s)</label><input class="in" id="f-insp" value="${esc(state.inspectors || '')}" autocomplete="name">
    <div class="btns" style="margin:0"><div><label class="f">Date</label><input class="in" type="date" id="f-date" value="${esc(state.date)}"></div>
    <div><label class="f">Projet / chantier</label><input class="in" id="f-site" value="${esc(state.site || '')}"></div></div>
    <div id="form-foot" style="margin-top:16px"></div>`;
  view.querySelectorAll('[data-logo]').forEach(async im => { im.src = await db.blobURL(im.dataset.logo); });

  let pv = null;
  const mountPlan = async () => {
    pv?.destroy();
    const plan = plans[state.planId];
    const box = $('#pick');
    if (!plan) { box.innerHTML = '<div class="empty">Aucun plan</div>'; return; }
    const sub = state.subIds.length === 1 ? subList.find(s => s.id === state.subIds[0]) : null;
    pv = createPlanViewer(box, {
      imageURL: await db.blobURL(plan.blobId),
      pins: state.pin ? [{ id: 'p', ...state.pin, color: sub?.color, label: '', ghost: true }] : [], cover: 2.4,
      focus: state.pin || null,
      onTap: (x, y) => { state.pin = { x, y }; pv.setPins([{ id: 'p', x, y, color: sub?.color || '#0B2D5B', label: '', ghost: true }]); live?.('pin'); },
    });
    onCleanup(() => pv?.destroy());
  };
  await mountPlan();

  $('#f-subs').onclick = e => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    // une seule entreprise par audit (toucher à nouveau = audit de zone)
    state.subIds = state.subIds[0] === b.dataset.s ? [] : [b.dataset.s]; state.subId = state.subIds[0] || null;
    $('#f-subs').querySelectorAll('[data-s]').forEach(x => x.classList.toggle('on', state.subIds.includes(x.dataset.s))); live?.('sub');
  };
  if ($('#f-plan')) $('#f-plan').onchange = e => { state.planId = e.target.value; state.pin = null; mountPlan(); live?.('plan'); };
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
  const photos = [...Object.values(insp?.scores || {}).flatMap(s => s?.photos || []), ...acts.flatMap(a => [...(a.photos || []), ...(a.photosAfter || [])])];
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
  const { subs, plans } = await maps();
  const sub = { name: auditLabel(insp, subs), color: auditColor(insp, subs) };
  const acts = await db.byIndex('actions', 'inspectionId', id);
  if (isLocked(insp)) { setTop({ title: sub?.name || 'Audit', sub: `Audit du ${dateFR(insp.date)}`, back: '#/' }); return lockedView(insp, sub, acts); }
  setTop({ title: sub?.name || 'Audit', sub: `Audit du ${dateFR(insp.date)}`, back: '#/', actions: [
    { icon: 'trash', aria: 'Supprimer l’audit', onClick: async () => { if (await confirmDeleteInspection(id, sub?.name)) location.replace('#/'); } },
    { icon: 'edit', aria: 'Modifier', onClick: () => location.hash = `#/insp/${id}/edit` }] });
  const siblings = insp.visitId ? (await pAll('inspections')).filter(i => i.visitId === insp.visitId).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')) : [];
  const visitBar = siblings.length > 1 ? `<div class="visit-bar"><span class="muted small">Tournée · ${siblings.length} audits</span><div class="visit-chips">${siblings.map(v => {
    const vo = overallScore(v.scores, v.bonus, v.penalty), vs = subs[v.subId];
    return `<a href="#/insp/${v.id}" class="vchip ${v.id === id ? 'on' : ''}" style="--c:${esc(vs?.color || '#9E9E9E')}"><span class="mono xs">${esc(abbr(vs?.name))}</span>${esc(vs?.name || 'Zone')}<em>${vo.pct === null ? '—' : Math.round(vo.pct * 100) + '%'}</em></a>`;
  }).join('')}</div></div>` : '';
  const prev = await lastAudit(insp);
  const prevPct = prev ? overallScore(prev.scores, prev.bonus, prev.penalty).pct : null;
  const draw = () => {
    const o = overallScore(insp.scores, insp.bonus, insp.penalty);
    const done = o.themes.reduce((a, t) => a + t.done, 0);
    const next = o.themes.find(t => t.done < t.total);
    view.innerHTML = visitBar + `
      <div class="card score-card">
        <div><div class="score-big" style="color:${o.pct === null ? 'var(--muted)' : o.rating.color}">${o.pct === null ? '—' : Math.round(o.pct * 100) + '<small>%</small>'}</div>
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
            ${allNA ? '<span class="badge none">N/A</span>' : t.done ? badge(t.pct) : '<span class="badge none">—</span>'}</a>
          <button class="na-btn ${allNA ? 'on' : ''}" data-na="${t.theme.ref}" aria-label="Thème non applicable">N/A</button></div>`;
      }).join('')}`;
    if ($('#exp')) $('#exp').onclick = () => exportSheet([insp]);
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
        <textarea class="in" style="margin-top:8px;min-height:60px" placeholder="Constat / commentaire" data-c>${esc(s.c || '')}</textarea>
        <div class="crit-tools">
          <label class="btn" style="margin:0">${ic('camera')} Photo<input type="file" accept="image/*" capture="environment" class="hidden-input" data-photo-in multiple></label>
          ${cloud.can('actions') ? `<button class="btn" data-act>${ic('plus')} Action${n ? ` (${n})` : ''}</button>` : '<span></span>'}</div>
        <div class="thumbs" data-thumbs></div></div>`;
    }).join('')}
    <p class="muted small swipe-hint">Glissez à gauche ou à droite pour changer de thème</p>
    <div class="btns">
      ${idx > 0 ? `<a class="btn" href="#/insp/${id}/t/${THEMES[idx - 1].ref}">‹ ${THEMES[idx - 1].ref.replace('.0', '')}</a>` : '<span></span>'}
      ${idx < THEMES.length - 1 ? `<a class="btn primary" href="#/insp/${id}/t/${THEMES[idx + 1].ref}">${THEMES[idx + 1].ref.replace('.0', '')} ›</a>` : `<a class="btn primary" href="#/insp/${id}/sum">Résumé ›</a>`}
    </div>`;

  const drawScore = () => {
    const t = themeScore(th, insp.scores);
    $('#tscore').innerHTML = `<div class="grow"><b>Score du thème</b><div class="muted small">${t.done}/${t.total} traités${t.max ? ` · ${t.sum}/${t.max} pts` : ''}</div></div>
      ${t.done === 0 ? '<span class="badge none">—</span>' : badge(t.pct)}`;
  };
  const drawThumbs = async card => { card.querySelector('[data-thumbs]').innerHTML = await thumbsHTML(insp.scores[card.dataset.ref]?.photos); };
  drawScore();
  view.querySelectorAll('.crit').forEach(drawThumbs);

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
      save.flush(); drawScore();
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
    if (e.target.closest('[data-act]')) {
      const s = sc(cref);
      const a = await createAction(insp, { subId: await chooseCompany(insp, (await maps()).subs), critRef: cref, observation: s.c || '', priority: typeof s.v === 'number' && s.v <= 1 ? 'High' : 'Medium' });
      location.hash = '#/action/' + a.id; return;
    }
    const ph = e.target.closest('[data-photo]');
    if (ph) photoViewer(ph.dataset.photo, async () => {
      const s = sc(cref); s.photos = s.photos.filter(p => p !== ph.dataset.photo); await db.deleteBlob(ph.dataset.photo); save.flush(); drawThumbs(card);
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
  });
  view.addEventListener('change', async e => {
    if (!e.target.matches('[data-photo-in]')) return;
    const card = e.target.closest('.crit');
    toast('Compression des photos…');
    const ids = await addPhotos(e.target.files);
    const s = sc(card.dataset.ref); s.photos = [...(s.photos || []), ...ids];
    save.flush(); drawThumbs(card); e.target.value = ''; toast(`${ids.length} photo(s) ajoutée(s)`);
  });
}

async function vSummary(id) {
  const insp = await db.get('inspections', id);
  if (!insp) return vNotFound();
  if (isLocked(insp)) { location.replace('#/insp/' + id); return; }
  const { subs } = await maps();
  setTop({ title: 'Résumé', sub: auditLabel(insp, subs), back: '#/insp/' + id, actions: [helpAction] });
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
      <label class="f">Inspecteur(s)</label><input class="in" data-k="inspectors" value="${esc(insp.inspectors || '')}">
      <div class="btns" style="margin-bottom:0"><div><label class="f">Bonus BE SAFE</label><input class="in" type="number" inputmode="decimal" step="0.5" data-k="bonus" value="${Number(insp.bonus) || 0}"></div>
      <div><label class="f">Pénalité LSR</label><input class="in" type="number" inputmode="decimal" step="0.5" data-k="penalty" value="${Number(insp.penalty) || 0}"></div></div>
    </div>`;
  const draw = () => {
    const o = overallScore(insp.scores, insp.bonus, insp.penalty);
    $('#sum-out').innerHTML = `
      <div class="overall" style="background:${o.rating.color};color:${o.rating.fg}"><div>Score global</div><b>${fmtPct(o.pct)}</b><span>${o.pct === null ? 'Pas encore noté' : o.rating.name}</span>
        <div class="small">${o.countedThemes}/19 thèmes notés</div></div>
      ${barChart(o.themes)}
      <table class="t" style="margin-top:12px"><tr><th>Theme</th><th class="r">Score %</th><th>Rating</th></tr>
      ${o.themes.map(t => `<tr><td><a href="#/insp/${id}/t/${t.theme.ref}">${t.theme.ref} ${esc(t.theme.name)}</a></td><td class="r">${fmtPct(t.pct)}</td><td>${ratingChip(t.pct)}</td></tr>`).join('')}
      <tr><th>Score global</th><th class="r">${fmtPct(o.pct)}</th><th>${ratingChip(o.pct)}</th></tr></table>`;
  };
  draw();
  view.addEventListener('input', e => {
    const k = e.target.dataset.k; if (!k) return;
    insp[k] = (k === 'bonus' || k === 'penalty') ? (parseFloat(e.target.value.replace(',', '.')) || 0) : e.target.value;
    save(); draw();
  });
  if ($('#exp')) $('#exp').onclick = () => exportSheet([insp]);
}

function barChart(themes) {
  const rowH = 24, labW = 44, w = 340, H = themes.length * rowH + 24;
  const x = p => labW + p * (w - labW - 44);
  return `<svg viewBox="0 0 ${w} ${H}" style="width:100%;background:var(--surface);border-radius:14px;border:2px solid var(--line)" role="img" aria-label="Score par thème">
    ${[0.5, 0.7, 0.8, 0.9, 1].map(t => `<line x1="${x(t)}" x2="${x(t)}" y1="6" y2="${H - 16}" stroke="var(--line)" stroke-dasharray="3 3"/><text x="${x(t)}" y="${H - 4}" font-size="9" text-anchor="middle">${t * 100}</text>`).join('')}
    ${themes.map((t, i) => { const y = 8 + i * rowH; const r = rating(t.pct);
      return `<text x="4" y="${y + 13}" font-size="11" font-weight="700">${t.theme.ref}</text>
        ${t.pct === null ? `<text x="${labW + 4}" y="${y + 13}" font-size="10" opacity=".6">N/A</text>` : `<rect x="${labW}" y="${y + 2}" width="${Math.max(2, x(t.pct) - labW)}" height="${rowH - 8}" rx="3" fill="${r.color}"/><text x="${x(t.pct) + 4}" y="${y + 13}" font-size="10">${Math.round(t.pct * 100)}%</text>`}`; }).join('')}
  </svg>`;
}

// ---------- export ----------
function exportSheet(insps, opts = {}) {
  const name = insps.length === 1 ? insps[0].ref : `PRT-export-${todayISO()}`;
  openSheet(`<h3>Exporter ${insps.length === 1 ? esc(insps[0].ref) : insps.length + ' inspections'}</h3>
    <div style="display:grid;gap:10px">
      <button class="btn block primary" data-x="xlsx">Excel (.xlsx) — 4 feuilles PRT</button>
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
const actionFilters = { sub: '', view: 'todo', insp: '', mode: 'board' };
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
  board.addEventListener('touchmove', e => {
    const t = e.touches[0];
    if (drag) { e.preventDefault(); move(t.clientX, t.clientY); return; }
    if (timer && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 8) cancel(); // c'est un défilement
  }, { passive: false });
  board.addEventListener('touchend', e => { cancel(); if (drag) { e.preventDefault(); const t = e.changedTouches[0]; end(t.clientX, t.clientY); } });
  board.addEventListener('touchcancel', () => { cancel(); clearInterval(scrollTimer); drag = null; sweep(); });
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
    <div style="display:grid;gap:10px"><label class="btn primary block">${ic('camera')} Photo après correction<input type="file" accept="image/*" capture="environment" class="hidden-input" id="aft-in"></label>
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
      <label class="btn block">${ic('camera')} Ajouter une photo<input type="file" accept="image/*" capture="environment" class="hidden-input" id="a-photo" multiple></label>
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

    <div class="section-head"><span>Après correction</span><span class="muted small">${(a.photosAfter || []).length || ''}</span></div>
    <div class="card">
      <label class="btn block">${ic('camera')} Photo après correction<input type="file" accept="image/*" capture="environment" class="hidden-input" id="a-after"></label>
      <div class="thumbs" id="a-after-thumbs"></div>
    </div>

    <div class="section-head"><span>Emplacement</span><span class="muted small">${a.planId ? esc(plans[a.planId]?.name || '') : ''}</span></div>
    ${a.planId && plans[a.planId] ? `<div id="a-plan" class="pv plan-box" style="height:38vh"></div>
      <button class="btn block" id="mv" style="margin-top:8px">${a.pin ? 'Déplacer l’épingle' : 'Placer l’épingle'}</button>` : '<div class="muted">Aucun plan lié</div>'}
    <button class="btn danger block" id="del" style="margin-top:20px">${ic('trash')} Supprimer l’action</button>
    <p class="muted small" style="text-align:center">Enregistrement automatique</p>`;

  if (!cloud.can('actions')) { // lecture seule
    view.querySelectorAll('input, textarea, select, .seg button').forEach(el => { el.disabled = true; });
    ['#del', '#mv'].forEach(sel => view.querySelector(sel)?.remove());
    view.querySelectorAll('label.btn').forEach(el => el.remove());
  }
  const drawThumbs = async () => { $('#a-thumbs').innerHTML = await thumbsHTML(a.photos); $('#a-after-thumbs').innerHTML = await thumbsHTML(a.photosAfter); };
  drawThumbs();
  const addAfter = async files => { toast('Compression…'); a.photosAfter = [...(a.photosAfter || []), ...await addPhotos(files)]; save.flush(); drawThumbs(); toast('Photo après correction ajoutée'); };
  let shareFiles = [];
  actionFiles(a).then(f => { shareFiles = f; });
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
    actionFiles(a).then(f => { shareFiles = f; });
  });
  view.addEventListener('click', async e => {
    const sb = e.target.closest('[data-seg] [data-val]');
    if (sb) {
      const key = sb.closest('[data-seg]').dataset.seg;
      a[key] = sb.dataset.val;
      sb.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === sb));
      if (key === 'status' && a.status === 'Closed') { a.closedAt = todayISO(); if (!(a.photosAfter || []).length && cloud.can('actions')) afterPhotoSheet(addAfter); }
      save.flush();
      const head = view.querySelector('.act-head');
      head.className = 'card act-head prio-' + a.priority;
      const due = head.querySelector('.due'); if (due) due.outerHTML = dueChip(a);
      return;
    }
    const ph = e.target.closest('[data-photo]');
    if (ph) photoViewer(ph.dataset.photo, async () => { a.photos = (a.photos || []).filter(p => p !== ph.dataset.photo); a.photosAfter = (a.photosAfter || []).filter(p => p !== ph.dataset.photo); await db.deleteBlob(ph.dataset.photo); save.flush(); drawThumbs(); });
  });
  $('#del').onclick = async () => { if (await confirmBox('Supprimer cette action ?', '')) { await db.remove('actions', id); history.back(); } };

  if (a.planId && plans[a.planId]) {
    let moving = false;
    const color = subs[a.subId]?.color;
    const pins = () => [...(insp?.pin && insp.planId === a.planId ? [{ id: 'i', ...insp.pin, color, label: 'I' }] : []), ...(a.pin ? [{ id: 'a', ...a.pin, color, label: '!', kind: 'action', ghost: moving }] : [])];
    const pv = createPlanViewer($('#a-plan'), {
      imageURL: await db.blobURL(plans[a.planId].blobId), pins: pins(), focus: a.pin || insp?.pin,
      onTap: (x, y) => { if (!moving) return; a.pin = { x, y }; moving = false; $('#mv').textContent = 'Déplacer l’épingle'; $('#mv').classList.remove('primary'); pv.setPins(pins()); save.flush(); toast('Épingle déplacée'); },
    });
    onCleanup(() => pv.destroy());
    $('#mv').onclick = e => { moving = !moving; e.target.textContent = moving ? 'Tapez l’emplacement sur le plan…' : (a.pin ? 'Déplacer l’épingle' : 'Placer l’épingle'); e.target.classList.toggle('primary', moving); pv.setPins(pins()); };
  }
}

// ---------- carte / plan ----------
let mapSub = '', mapActions = false;
async function vMap(q) {
  view.classList.add('full', 'map-page');
  const { subs, subList, plans, planList } = await maps();
  setTop({ title: 'Plan', sub: plans[await db.getMeta('lastPlan')]?.name || '' });
  if (!planList.length) { view.classList.remove('full', 'map-page'); view.innerHTML = `<div class="empty">Aucun plan.<br><br><a class="btn primary" href="#/plans">Importer un plan</a></div>`; return; }
  const planId = q.get('plan') && plans[q.get('plan')] ? q.get('plan') : (plans[await db.getMeta('lastPlan')] ? await db.getMeta('lastPlan') : planList[0].id);
  await db.setMeta('lastPlan', planId);
  const onlyInsp = q.get('insp');
  const [insps, acts] = await Promise.all([pAll('inspections'), pAll('actions')]);
  const active = subList.filter(s => !s.archived).sort((a, b) => a.name.localeCompare(b.name));
  view.innerHTML = `
    <div class="chips-bar">
      <button data-ms="" class="${!mapSub ? 'on' : ''}">Tous</button>
      ${active.map(s => `<button data-ms="${s.id}" class="${mapSub === s.id ? 'on' : ''}" style="--c:${esc(s.color)}"><i></i>${esc(s.name)}</button>`).join('')}
    </div>
    ${planList.length > 1 ? `<select class="in" id="m-plan" style="margin:0 12px 8px;width:calc(100% - 24px)">${planList.map(p => `<option value="${p.id}" ${p.id === planId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
    <div id="map" class="pv map-fill"></div>
    <button class="map-toggle ${mapActions ? 'on' : ''}" id="m-act">${ic('list', 18)}<span>${mapActions ? 'Masquer les actions' : 'Afficher les actions'}</span></button>`;
  const computePins = () => {
    const out = [];
    insps.filter(i => i.planId === planId && i.pin && (!mapSub || hasSub(i, mapSub)) && (!onlyInsp || i.id === onlyInsp))
      .forEach(i => out.push({ id: 'i:' + i.id, ...i.pin, color: auditColor(i, subs), label: auditAbbr(i, subs) }));
    if (mapActions || onlyInsp) acts.filter(a => a.planId === planId && a.pin && a.status !== 'Closed' && (!mapSub || a.subId === mapSub) && (!onlyInsp || a.inspectionId === onlyInsp))
      .forEach(a => out.push({ id: 'a:' + a.id, ...a.pin, color: subs[a.subId]?.color, label: '!', kind: 'action' }));
    return out;
  };
  const pv = createPlanViewer($('#map'), {
    imageURL: await db.blobURL(plans[planId].blobId), pins: computePins(), cover: 2.4,
    focus: onlyInsp ? insps.find(i => i.id === onlyInsp)?.pin : null,
    onPinTap: p => pinSheet(p.id, { subs, insps, acts }),
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
  view.querySelector('.chips-bar').onclick = e => {
    const b = e.target.closest('[data-ms]'); if (!b) return;
    mapSub = b.dataset.ms;
    view.querySelectorAll('[data-ms]').forEach(x => x.classList.toggle('on', x === b));
    pv.setPins(computePins());
  };
  $('#m-plan')?.addEventListener('change', e => { location.hash = '#/map?plan=' + e.target.value; });
  $('#m-act').onclick = e => {
    mapActions = !mapActions;
    const b = e.currentTarget; b.classList.toggle('on', mapActions);
    b.querySelector('span').textContent = mapActions ? 'Masquer les actions' : 'Afficher les actions';
    pv.setPins(computePins());
  };
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
async function vAudits() {
  setTop({ title: 'Audits' });
  const [{ subs, subList }, insps] = await Promise.all([maps(), pAll('inspections')]);
  const active = subList.filter(s => s.name && !s.archived).sort((a, b) => a.name.localeCompare(b.name));
  const draw = () => {
    const list = insps.filter(i => !auditSub || hasSub(i, auditSub)).sort((a, b) => (b.date + (b.updatedAt || '')).localeCompare(a.date + (a.updatedAt || '')));
    const today = todayISO(), week = todayISO(-7), month = todayISO(-31);
    const groups = [['Aujourd’hui', i => i.date === today], ['Cette semaine', i => i.date < today && i.date >= week], ['Ce mois-ci', i => i.date < week && i.date >= month], ['Plus ancien', i => i.date < month]];
    $('#alist').innerHTML = groups.map(([label, f]) => {
      const g = list.filter(f); if (!g.length) return '';
      return `<div class="section-head"><span>${label}</span><span class="muted small">${g.length}</span></div>${inspList(g, subs)}`;
    }).join('') || '<div class="empty">Aucun audit</div>';
  };
  view.innerHTML = `
    <div class="tabs3 two"><a class="on" href="#/audits">Par date</a><a href="#/subs">Par entreprise</a></div>
    <div class="chips-bar flush">
      <button data-as="" class="${!auditSub ? 'on' : ''}">Tous</button>
      ${active.map(s => `<button data-as="${s.id}" class="${auditSub === s.id ? 'on' : ''}" style="--c:${esc(s.color)}"><i></i>${esc(s.name)}</button>`).join('')}
    </div>
    <div id="alist"></div>`;
  draw();
  view.querySelector('.chips-bar').onclick = e => {
    const b = e.target.closest('[data-as]'); if (!b) return;
    auditSub = b.dataset.as;
    view.querySelectorAll('[data-as]').forEach(x => x.classList.toggle('on', x === b));
    draw();
  };
}

async function vSubs() {
  setTop({ title: 'Audits', actions: cloud.isAdmin() ? [{ icon: 'plus', aria: 'Ajouter', onClick: newSub }] : [] });
  const [{ subList: subs }, insps, acts] = await Promise.all([maps(), pAll('inspections'), pAll('actions')]);
  const rows = subs.filter(s => showArchived || !s.archived).map(s => {
    const last = insps.filter(i => hasSub(i, s.id)).sort((a, b) => b.date.localeCompare(a.date))[0];
    return { s, pct: last ? overallScore(last.scores, last.bonus, last.penalty).pct : null, open: acts.filter(a => a.subId === s.id && a.status !== 'Closed').length, late: acts.filter(a => a.subId === s.id && isLate(a)).length };
  }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.s.name.localeCompare(b.s.name));
  let rank = 0;
  view.innerHTML = `
    <div class="tabs3 two"><a href="#/audits">Par date</a><a class="on" href="#/subs">Par entreprise</a></div>
    <div class="section-head"><span>Classement — dernier audit</span></div>
    ${rows.map(({ s, pct, open, late }) => `<a class="card link row sub-row" href="#/sub/${s.id}" style="--c:${esc(s.color)};${s.archived ? 'opacity:.5' : ''}">
        <span class="rank">${pct === null ? '–' : ++rank}</span>
        <div class="grow"><b>${esc(s.name || 'Sans nom')}</b>
          <div class="small ${late ? 'late' : 'muted'}">${open ? `${open} action${open > 1 ? 's' : ''} ouverte${open > 1 ? 's' : ''}${late ? ` · ${late} en retard` : ''}` : (pct === null ? 'Pas encore audité' : 'Aucune action ouverte')}</div></div>
        ${pct === null ? '' : badge(pct)}</a>`).join('') || '<div class="empty">Aucune entreprise</div>'}
    <div class="row" style="justify-content:space-between;margin:14px 4px">
      <label class="row small" style="gap:8px"><input type="checkbox" id="arch" ${showArchived ? 'checked' : ''} style="width:22px;height:22px"> Archivés</label>
      ${cloud.isAdmin() ? '<button class="link-btn" id="bulk">Import rapide</button>' : ''}</div>`;
  $('#arch').onchange = e => { showArchived = e.target.checked; render(); };
  $('#bulk') && ($('#bulk').onclick = () => openSheet(`<h3>Import rapide</h3>
    <p class="muted small">Un nom d’entreprise par ligne (copier-coller depuis Excel possible).</p>
    <textarea class="in" id="bulk-t" style="min-height:180px" placeholder="Alphascaff&#10;Unitec"></textarea>
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
    <label class="f">Nom *</label><input class="in" data-k="name" value="${esc(s.name)}" placeholder="ex. Alphascaff">
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
  const w = 340, h = 190, L = 30, R = 8, T = 18, B = 24, bw = Math.min(34, (w - L - R) / v.length - 10);
  const y = p => T + (1 - p) * (h - T - B);
  const x = i => L + (i + 0.5) * (w - L - R) / v.length;
  return `<svg viewBox="0 0 ${w} ${h}" class="chart-box" role="img" aria-label="Évolution du score">
    ${[0, 0.5, 0.7, 0.8, 0.9, 1].map(t => `<line x1="${L}" x2="${w - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" ${t ? 'stroke-dasharray="3 3"' : ''}/><text x="${L - 4}" y="${y(t) + 3}" font-size="9" text-anchor="end" opacity=".7">${t * 100}</text>`).join('')}
    ${v.map((p, i) => `<rect x="${x(i) - bw / 2}" y="${y(p.pct)}" width="${bw}" height="${y(0) - y(p.pct)}" rx="4" fill="${rating(p.pct).color}"/>
      <text x="${x(i)}" y="${y(p.pct) - 4}" font-size="10.5" font-weight="700" text-anchor="middle">${Math.round(p.pct * 100)}%</text>
      <text x="${x(i)}" y="${h - 8}" font-size="9" text-anchor="middle" opacity=".8">${p.i.date.slice(5).split('-').reverse().join('/')}</text>`).join('')}
  </svg>`;
}

// ---------- plans ----------
// ---------- gestion des projets (admin) ----------
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
        <div><label class="f">Site</label><input class="in" data-k="site" value="${esc(p.site)}" placeholder="Farciennes"></div>
      </div>
      <label class="f">Logo du client / projet (rapport PDF)</label>
      <div class="row"><img class="logo" id="plogo" style="width:56px;height:56px;${p.logoId ? '' : 'display:none'}">
        <label class="btn grow">Choisir une image<input type="file" accept="image/*" class="hidden-input" id="plogo-in"></label></div>
    </div>
    ${isNew ? `<button class="btn primary big" id="create">Créer le projet</button>` : `
    <div class="section-head"><span>Plans</span><span class="muted small">${plans.length}</span></div>
    ${plans.map(x => `<div class="card row plan-row" data-plan="${x.id}"><img class="plan-thumb" data-img="${x.blobId}">
      <input class="in grow" data-pn="${x.id}" value="${esc(x.name)}"><button class="btn danger small-btn" data-pdel="${x.id}" aria-label="Supprimer">${ic('trash', 18)}</button></div>`).join('')}
    <label class="btn block">${ic('upload')} Ajouter un plan (image ou PDF)<input type="file" accept="image/*,application/pdf,.pdf" class="hidden-input" id="p-in"></label>
    <div class="section-head"><span>Entreprises du projet</span><span class="muted small" id="ncomp">${(p.companyIds || []).length} sélectionnée(s)</span></div>
    <p class="muted small" style="margin:-4px 2px 8px">Cochez les entreprises qui travaillent sur ce projet. <a href="#/companies">Gérer l’annuaire</a></p>
    ${[['entreprise', COMPANY_TYPES.entreprise.plural], ['sub', COMPANY_TYPES.sub.plural]].map(([t, label]) => types[t].length ? `
      <div class="muted small" style="margin:10px 2px 6px;font-weight:700">${label}</div>
      <div class="check-grid">${types[t].map(s => `<label class="check-item" style="--c:${esc(s.color)}"><input type="checkbox" data-comp="${s.id}" ${(p.companyIds || []).includes(s.id) ? 'checked' : ''}><span class="mono">${esc(abbr(s.name))}</span><b>${esc(s.name)}</b></label>`).join('')}</div>` : '').join('')}
    <button class="btn block" id="parch" style="margin-top:20px">${p.archived ? 'Réactiver le projet' : 'Archiver le projet'}</button>
    <p class="muted small" style="text-align:center">Enregistrement automatique</p>`}`;
  if (p.logoId) $('#plogo').src = await db.blobURL(p.logoId);
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
  $('#plogo-in').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    p.logoId = await db.putBlob(await compressImage(f, 400, 0.9)); $('#plogo').src = await db.blobURL(p.logoId); $('#plogo').style.display = ''; save.flush();
  };
  if (isNew) {
    $('#create').onclick = async () => {
      if (!p.name.trim()) return toast('Indiquez le nom du projet');
      p.code ||= p.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const created = await db.put('projects', p);
      toast('Projet créé'); location.replace('#/project/' + created.id);
    };
    return;
  }
  $('#p-in').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { await importPlanFile(f, p.id); render(); } catch (err) { toast('Import impossible : ' + err.message, 4000); } };
  view.addEventListener('click', async e => {
    const d = e.target.closest('[data-pdel]'); if (!d) return;
    if (await confirmBox('Supprimer ce plan ?', 'Les audits restent, mais leurs épingles ne seront plus visibles.')) { await db.remove('plans', d.dataset.pdel); render(); }
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
    <textarea class="in" id="bulk-t" style="min-height:180px" placeholder="Alphascaff&#10;Unitec"></textarea>
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
      ${cloud.enabled ? '' : `<label class="f" style="margin-top:0">Inspecteur par défaut</label><input class="in" data-s="inspector" value="${esc(st.inspector)}">`}
      <label class="f">Affichage</label><div class="seg" id="theme">${[['auto', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']].map(([v, l]) => `<button data-val="${v}" class="${st.theme === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    ${cloud.isAdmin() ? `<div class="section-head"><span>Administration</span></div>
    <div class="menu-list">
      <a href="#/projects">${ic('map')}<span class="grow"><b>Projets et plans</b><small>${esc(PROJECT?.name || '')} · changer, créer, archiver</small></span>${ic('chevron')}</a>
      <a href="#/companies">${ic('building')}<span class="grow"><b>Annuaire des entreprises</b><small>Sous-traitants et prestataires</small></span>${ic('chevron')}</a>
      ${cloud.enabled ? `<a href="#/team">${ic('list')}<span class="grow"><b>Équipe et accès</b><small>Invitations, droits, projets autorisés</small></span>${ic('chevron')}</a>` : ''}
    </div>` : ''}
    <button class="btn block" id="scale" style="margin-bottom:10px">Barème de notation (Notes)</button>
    ${cloud.can('export') ? `<h2>Exports</h2>
    <button class="btn block primary" id="x-all" style="margin-bottom:10px">Excel — tous les audits du projet</button>` : ''}
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
  if ($('#x-all')) $('#x-all').onclick = async () => { const all = (await pAll('inspections')).sort((a, b) => a.date.localeCompare(b.date)); if (!all.length) return toast('Aucune inspection'); exportSheet(all, { allActions: true }); };
  $('#bk').onclick = async () => {
    toast('Préparation de la sauvegarde…');
    const json = await db.exportAll();
    await db.setMeta('lastBackup', new Date().toISOString());
    readySheet(new File([JSON.stringify(json)], `PRT-HSE-sauvegarde-${todayISO()}.json`, { type: 'application/json' }));
  };
  if ($('#rs')) $('#rs').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    if (!await confirmBox('Restaurer cette sauvegarde ?', 'Toutes les données actuelles de l’app seront <b>remplacées</b>.', 'Remplacer mes données')) return;
    try { await db.importAll(JSON.parse(await f.text())); toast('Restauration terminée'); location.hash = '#/'; render(); }
    catch (err) { toast('Échec : ' + err.message, 4000); }
  };
}

// ---------- équipe et accès (admin) ----------
const PERM_HINTS = {
  audit: 'Lancer des audits et noter les critères',
  details: 'Rouvrir ses audits passés (sinon : uniquement ses chiffres)',
  export: 'Générer les rapports PDF et Excel',
  actions: 'Créer, déplacer et clôturer les actions',
};
const permSummary = p => {
  if (p.role === 'admin') return 'Administrateur · accès complet';
  const on = Object.keys(cloud.PERMS).filter(k => p.perms?.[k] !== false);
  return on.length === 4 ? 'Tous les droits HSE' : on.length ? on.map(k => ({ audit: 'Audits', details: 'Détail', export: 'Export', actions: 'Actions' })[k]).join(' · ') : 'Lecture seule';
};
const projSummary = (ids, projects) => !ids || !ids.length ? 'Tous les projets' : ids.map(id => projects.find(p => p.id === id)?.name || '?').join(', ');
const inviteLink = (email, name) => `${location.origin}${location.pathname}#/join?e=${encodeURIComponent(email)}&n=${encodeURIComponent(name || '')}`;
async function shareInvite(email, name) {
  const link = inviteLink(email, name);
  const text = `Bonjour${name ? ' ' + name.split(' ')[0] : ''}, voici ton accès à l’application PRT HSE : ${link}\n1. Ouvre le lien dans Safari\n2. « Créer mon compte » avec ${email}\n3. Partager → « Sur l’écran d’accueil »`;
  openSheet(`<h3>Invitation prête</h3>
    <p class="muted">Envoyez ce lien à <b>${esc(name || email)}</b>. Il ne fonctionne qu’avec l’adresse invitée.</p>
    <div class="invite-link">${esc(link)}</div>
    <div style="display:grid;gap:10px;margin-top:12px">
      ${navigator.share ? `<button class="btn primary block" data-s>${ic('share')} Envoyer (WhatsApp, mail, Teams…)</button>` : ''}
      <button class="btn block" data-c>Copier le message</button>
      <button class="btn block" data-close>Fermer</button></div>`,
  (el, close) => {
    el.querySelector('[data-s]')?.addEventListener('click', async () => { try { await navigator.share({ title: 'Accès PRT HSE', text }); close(); } catch { /* annulé */ } });
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
          <input type="checkbox" class="switch" data-perm="${k}" ${state.perms?.[k] !== false ? 'checked' : ''}></label>`).join('')}</div>
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
        <span class="col-btns"><button class="btn small-btn" data-resend="${esc(i.email)}" data-name="${esc(i.name || '')}">${ic('share', 18)}</button>
        <button class="btn small-btn danger" data-del="${esc(i.email)}" aria-label="Annuler">${ic('x', 18)}</button></span></div>`).join('')}` : ''}`;
  view.addEventListener('click', async e => {
    const r = e.target.closest('[data-resend]'); if (r) return shareInvite(r.dataset.resend, r.dataset.name);
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
  const byHseMap = new Map(); insps.forEach(i => [...new Set(people(i))].forEach(n => byHseMap.set(n, [...(byHseMap.get(n) || []), i])));
  const byHse = [...byHseMap.entries()].map(([n, l]) => ({ n, l, avg: avg(l) })).sort((a, b) => b.l.length - a.l.length);
  const bySub = [...new Set(insps.flatMap(subIdsOf))].map(id => [id, insps.filter(i => hasSub(i, id))]).map(([id, l]) => ({ s: subs[id], l, avg: avg(l), open: acts.filter(a => a.subId === id && a.status !== 'Closed').length })).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));
  const open = acts.filter(a => a.status !== 'Closed'), late = acts.filter(isLate);
  const maxH = Math.max(1, ...byHse.map(x => x.l.length));
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
      <div><b style="color:${rating(avg(insps)).color === '#9E9E9E' ? 'inherit' : rating(avg(insps)).color}">${avg(insps) === null ? '—' : Math.round(avg(insps) * 100) + '%'}</b><span>Score moyen</span></div>
      <div><b>${open.length}</b><span>Actions ouvertes</span></div>
      <div class="${late.length ? 'late' : ''}"><b>${late.length}</b><span>En retard</span></div>
    </div>

    <div class="section-head"><span>Audits par HSE</span><span class="muted small">${byHse.length} personne${byHse.length > 1 ? 's' : ''}</span></div>
    <div class="card stat-list">${byHse.map(x => `
      <div class="stat-row"><span class="avatar sm">${esc(x.n.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())}</span>
        <span class="grow"><b>${esc(x.n)}</b><span class="hbar"><i style="width:${x.l.length / maxH * 100}%"></i></span></span>
        <span class="stat-num"><b>${x.l.length}</b><small>audit${x.l.length > 1 ? 's' : ''}</small></span>
        ${x.avg === null ? '<span class="badge none">—</span>' : badge(x.avg)}</div>`).join('') || '<div class="empty">Aucun audit sur la période</div>'}</div>

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
    <button class="btn block primary" id="st-x" style="margin-top:12px">${ic('download')} Exporter ces statistiques (Excel)</button>`;
  view.addEventListener('click', e => {
    const p = e.target.closest('[data-per]'); if (p) { statsF.period = +p.dataset.per; render(); return; }
    const sc = e.target.closest('[data-scope]'); if (sc) { statsF.scope = sc.dataset.scope; render(); }
  });
  $('#st-x').onclick = () => {
    const XLSX = window.XLSX, wb = XLSX.utils.book_new();
    const period = statsF.period ? `${statsF.period} derniers jours` : 'toute la période';
    const head = [['PRT HSE — Pilotage'], [`Périmètre : ${scopeName} · ${period} · édité le ${dateFR(todayISO())}`], []];
    const sh1 = XLSX.utils.aoa_to_sheet([...head, ['HSE', 'Audits', 'Score moyen'], ...byHse.map(x => [x.n, x.l.length, x.avg === null ? '' : Math.round(x.avg * 1000) / 10 + ' %'])]);
    const sh2 = XLSX.utils.aoa_to_sheet([...head, ['Entreprise', 'Type', 'Audits', 'Score moyen', 'Actions ouvertes'], ...bySub.map(x => [x.s?.name, typeOf(x.s).label, x.l.length, x.avg === null ? '' : Math.round(x.avg * 1000) / 10 + ' %', x.open])]);
    const sh3 = XLSX.utils.aoa_to_sheet([...head, ['Date', 'Projet', 'Entreprise', 'HSE', 'Référence', 'Score'], ...insps.sort((a, b) => a.date.localeCompare(b.date)).map(i => [dateFR(i.date), projects.find(p => p.id === pid(i))?.name || '', auditLabel(i, subs), who(i), i.ref, pctOf(i) === null ? '' : Math.round(pctOf(i) * 1000) / 10 + ' %'])]);
    [sh1, sh2, sh3].forEach(sh => { sh['!cols'] = [{ wch: 28 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 34 }, { wch: 10 }]; });
    XLSX.utils.book_append_sheet(wb, sh1, 'Par HSE'); XLSX.utils.book_append_sheet(wb, sh2, 'Par entreprise'); XLSX.utils.book_append_sheet(wb, sh3, 'Audits');
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
      <label class="f">Zone</label><input class="in" data-i="zone" list="zones" value="${esc(insp.zone || '')}"><datalist id="zones">${SEED_LOCATIONS.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
      <div class="btns" style="margin-bottom:0"><div><label class="f">Inspecteur(s)</label><input class="in" data-i="inspectors" value="${esc(insp.inspectors || '')}"></div>
      <div><label class="f">Date</label><input class="in" type="date" data-i="date" value="${esc(insp.date)}"></div></div>
    </div>
    <div class="section-head"><span>Contenu du rapport</span></div>
    <div class="perm-list">${Object.entries(SECTION_LABELS).map(([k, [l, h]]) => `<label class="perm-row"><span class="grow"><b>${l}</b><small>${h}</small></span><input type="checkbox" class="switch" data-sec="${k}" ${R.sections[k] ? 'checked' : ''}></label>`).join('')}</div>
    <button class="btn primary big" id="gen" style="margin-top:14px">${ic('file')} Générer le PDF</button>
    <button class="link-btn" id="reset-r" style="display:block;margin:8px auto">Rétablir les textes par défaut</button>`;
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
  [/^\/insp\/([^/]+)$/, vInsp, 'home'],
  [/^\/insp\/([^/]+)\/edit$/, vInspEdit, 'home'],
  [/^\/insp\/([^/]+)\/sum$/, vSummary, 'home'],
  [/^\/insp\/([^/]+)\/report$/, vReport, 'home'],
  [/^\/insp\/([^/]+)\/t\/([\d.]+)$/, vTheme, 'home'],
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
  [/^\/companies$/, vCompanies, 'home'],
  [/^\/team$/, vTeam, 'home'],
  [/^\/invite$/, vInvite, 'home'],
  [/^\/member\/([^/]+)$/, vMember, 'home'],
];

let renderSeq = 0;
/** Menu latéral (écran large) : projet actif en bas, cliquable pour en changer */
function drawSideFoot() {
  const f = document.getElementById('side-foot'); if (!f) return;
  f.innerHTML = PROJECT ? `<button type="button" class="side-proj"><span class="side-dot" style="background:${esc(PROJECT.color || '#1A56A8')}">${esc(abbr(PROJECT.name))}</span>
    <span class="side-pname"><b>${esc(PROJECT.name)}</b><small>${esc(PROJECT.site || 'Projet actif')} · changer</small></span></button>
    <span class="side-ver">PRT HSE · v${APP_VERSION}</span>` : '';
  f.querySelector('.side-proj')?.addEventListener('click', () => projectSheet());
}
async function render() {
  const seq = ++renderSeq;
  cleanups.forEach(f => { try { f(); } catch { /* ignore */ } }); cleanups = [];
  document.querySelectorAll('.sheet-bg, .kghost').forEach(s => s.remove());
  if (PROJECT) await loadProject(); // projet actif relu à chaque écran (entreprises cochées, nom, plans…)
  drawSideFoot();
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
    if (p.code !== SEED_PLAN.code || p.id === SEED_PLAN_ID) continue;
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
  if (await db.getMeta('seeded-v3')) return;
  const existing = await db.all('subs', { includeDeleted: true });
  for (const s of SEED_SUBS) {
    if (!existing.some(e => (e.name || '').toLowerCase() === s.name.toLowerCase())) await db.put('subs', { ...s, id: seedId(s.name), contact: '', phone: '', archived: false });
  }
  const plans = await db.all('plans');
  if (!plans.some(p => p.code === SEED_PLAN.code)) {
    const blob = await (await fetch(SEED_PLAN.file)).blob();
    await db.putBlob(blob, SEED_PLAN_BLOB);
    await db.put('plans', { id: SEED_PLAN_ID, name: SEED_PLAN.name, code: SEED_PLAN.code, blobId: SEED_PLAN_BLOB });
    await db.setMeta('lastPlan', SEED_PLAN_ID);
  }
  await db.setMeta('seeded-v3', true);
}

(async function boot() {
  applyTheme((await getSettings()).theme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', async () => applyTheme((await getSettings()).theme));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  navigator.storage?.persist?.().catch(() => {});
  try { await cloud.init(); } catch (e) { console.error('cloud', e); }
  if (cloud.enabled && !cloud.session) return showLogin();
  await startApp();
})();

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
        <h1>PRT HSE</h1>
        <p class="muted">SAM 2A · Site HSE Performance Rating</p>
        <div class="tabs3 two"><button type="button" data-m="in" class="${mode === 'in' ? 'on' : ''}">Se connecter</button><button type="button" data-m="up" class="${mode === 'up' ? 'on' : ''}">Créer mon compte</button></div>
        <form id="lf" autocomplete="on">
          ${mode === 'up' ? '<label class="f">Nom et prénom</label><input class="in" id="l-name" autocomplete="name" required>' : ''}
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
        if (mode === 'up') await cloud.signUp($('#l-mail').value, $('#l-pass').value, $('#l-name').value);
        else await cloud.signIn($('#l-mail').value, $('#l-pass').value);
        history.replaceState(null, '', '#/'); await startApp();
      } catch (err) { $('#l-err').textContent = err.message; btn.disabled = false; btn.textContent = label(); }
    };
  };
  setTop({ title: '' });
  draw();
  if (join) { $('#l-mail').value = join.get('e') || ''; if ($('#l-name')) $('#l-name').value = join.get('n') || ''; $('#l-pass').focus(); }
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
