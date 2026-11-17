// PRT HSE — application principale (routeur + écrans)
import { THEMES } from './prt-data.js';
import { NA, SCALE, RATINGS, rating, themeScore, overallScore, criterionOfRef, themeOfRef, fmtPct } from './calc.js';
import * as db from './db.js';
import { createPlanViewer } from './plan.js';
import { compressImage, planFileToBlob, pdfPageCount } from './images.js';
import { ic } from './icons.js';
import * as cloud from './cloud.js';
import { SEED_SUBS, SEED_LOCATIONS, SEED_PLAN, SEED_SITE } from './seed.js';
import { buildXLSX, buildPDF, shareFile, download, canShareFile, actionRef } from './export.js';

export const APP_VERSION = '2.0.0';

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
const PALETTE = ['#1A56A8', '#C62828', '#2E7D32', '#EF6C00', '#6A1B9A', '#00838F', '#AD1457', '#5D4037', '#F9A825', '#37474F'];
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

function setTop({ title, sub = '', back = null, actions = [] }) {
  $('#title').innerHTML = esc(title) + (sub ? `<small>${esc(sub)}</small>` : '');
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

async function maps() {
  const [subs, plans] = await Promise.all([db.all('subs', { includeDeleted: true }), db.all('plans')]);
  return { subs: Object.fromEntries(subs.map(s => [s.id, s])), subList: subs.filter(s => !s.deleted), plans: Object.fromEntries(plans.map(p => [p.id, p])), planList: plans };
}

async function nextRef(plan, date) {
  const code = (plan?.code || plan?.name || 'SITE').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10) || 'SITE';
  const ini = cloud.enabled ? (cloud.myName() || 'X').split(/[\s.@_-]+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 3) : '';
  const prefix = `PRT-${code}-${(date || todayISO()).slice(0, 4)}-${ini}`;
  const all = await db.all('inspections', { includeDeleted: true });
  const max = all.filter(i => i.ref?.startsWith(prefix)).map(i => parseInt(i.ref.slice(prefix.length), 10) || 0).reduce((a, b) => Math.max(a, b), 0);
  return prefix + String(max + 1).padStart(3, '0');
}

async function createAction(insp, { critRef = '', observation = '', priority = 'Medium', subId, planId, pin } = {}) {
  let p = pin ?? null;
  if (!p && insp?.pin) {
    const n = (await db.byIndex('actions', 'inspectionId', insp.id)).length + 1;
    const ang = n * 2.4, r = 0.03;
    p = { x: clamp01(insp.pin.x + Math.cos(ang) * r), y: clamp01(insp.pin.y + Math.sin(ang) * r) };
  }
  const sid = subId ?? insp?.subId;
  const sub = sid ? await db.get('subs', sid) : null;
  return db.put('actions', {
    owner: insp?.owner || cloud.uid(),
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
  setTop({ title: 'Inspections HSE', sub: 'SAM 2A', actions: [{ icon: 'gear', aria: 'Réglages', onClick: () => location.hash = '#/settings' }] });
  const [{ subs, subList }, insps, acts] = await Promise.all([maps(), db.all('inspections'), db.all('actions')]);
  const recent = [...insps].sort((a, b) => (b.date + b.updatedAt).localeCompare(a.date + a.updatedAt)).slice(0, 6);
  const late = acts.filter(isLate).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const today = new Date().toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' });
  view.innerHTML = `
    ${cloud.enabled ? '<button class="sync-pill" id="sync-now" hidden></button>' : ''}
    <div class="section-head"><span>Nouvelle inspection</span><span class="muted small" style="text-transform:capitalize">${esc(today)}</span></div>
    ${subGrid(subList, insps, acts)}
    ${late.length ? `<div class="section-head late"><span class="row" style="gap:6px">${ic('alert', 18)} Actions en retard</span><span>${late.length}</span></div>
      ${late.slice(0, 5).map(a => actionCard(a, subs)).join('')}
      ${late.length > 5 ? `<a class="btn block" href="#/actions?late=1">Voir les ${late.length} actions</a>` : ''}` : ''}
    <div class="section-head"><span>${cloud.enabled && cloud.isAdmin() ? 'Audits de l’équipe' : cloud.enabled ? 'Mes audits' : 'Inspections récentes'}</span>${insps.length ? `<span class="muted small">${insps.length} au total</span>` : ''}</div>
    ${recent.map(i => inspCard(i, subs)).join('') || '<div class="empty">Aucune inspection pour l’instant.<br>Touchez un sous-traitant pour commencer.</div>'}`;
  bindSubGrid();
  drawSync();
  $('#sync-now')?.addEventListener('click', () => cloud.sync());
}

function subGrid(subList, insps = [], acts = []) {
  const active = subList.filter(s => !s.archived).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return `<div class="sub-grid">${active.map(s => {
    const last = insps.filter(i => i.subId === s.id).sort((a, b) => b.date.localeCompare(a.date))[0];
    const pct = last ? overallScore(last.scores, last.bonus, last.penalty).pct : null;
    const open = acts.filter(a => a.subId === s.id && a.status !== 'Closed').length;
    return `<button type="button" data-start="${s.id}" style="--c:${esc(s.color)}">
      <b>${esc(s.name)}</b>
      <span class="meta">${last ? `<i style="background:${rating(pct).color}"></i>${pct === null ? 'N/A' : Math.round(pct * 100) + ' %'}` : '&nbsp;'}${open ? ` · ${open} action${open > 1 ? 's' : ''}` : ''}</span>
    </button>`;
  }).join('')}</div>`;
}
function bindSubGrid() {
  view.querySelectorAll('[data-start]').forEach(b => b.onclick = () => startInspection(b.dataset.start));
}
async function startInspection(subId) {
  // même sous-traitant déjà audité aujourd'hui → on reprend cet audit (pas de doublon)
  const today = (await db.byIndex('inspections', 'subId', subId)).find(i => i.date === todayISO());
  if (today) { location.hash = '#/insp/' + today.id; return; }
  const st = await getSettings();
  const plans = await db.all('plans');
  const last = await db.getMeta('lastPlan');
  const plan = plans.find(p => p.id === last) || plans[0] || null;
  const date = todayISO();
  const ref = await nextRef(plan, date);
  const insp = await db.put('inspections', { owner: cloud.uid(), subId, planId: plan?.id || null, pin: null, zone: '', inspectors: cloud.enabled ? cloud.myName() : st.inspector, date, site: st.site, ref, scores: {}, bonus: 0, penalty: 0 });
  location.replace('#/insp/' + insp.id); // pas d'entrée d'historique : « retour » ne recrée pas d'inspection
}

function inspCard(i, subs) {
  const o = overallScore(i.scores, i.bonus, i.penalty);
  const done = o.themes.reduce((a, t) => a + t.done, 0);
  return `<a class="card link row" href="#/insp/${i.id}">
    <div class="grow"><div class="row wrap">${subChip(subs[i.subId])}<span class="muted small">${dateFR(i.date)}</span></div>
      <div style="font-weight:700;margin-top:4px">${esc(i.ref)}</div>
      <div class="muted small ellip">${cloud.enabled && cloud.isAdmin() && i.owner !== cloud.uid() ? `<b>${esc(i.inspectors || '')}</b> · ` : ''}${i.zone ? esc(i.zone) + ' · ' : ''}${done}/124 critères</div></div>
    ${badge(o.pct)}</a>`;
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
    <div class="row">${subChip(subs[a.subId])}<span class="prio-txt">${a.priority}</span><span class="grow"></span>${dueChip(a)}</div>
    <div class="act-title">${esc(a.observation || 'Observation à compléter')}</div>
    <div class="muted small ellip">${esc(actionRef(a) || 'Action libre')}${a.status === 'In progress' ? ' · En cours' : ''}</div></a>`;
}

// ---------- formulaire inspection (création + modification) ----------
async function inspForm(state, { live }) {
  const { subList, plans, planList } = await maps();
  const subsActive = subList.filter(s => !s.archived || s.id === state.subId);
  if (!state.planId && planList.length) state.planId = planList[0].id;
  view.innerHTML = `
    <label class="f" style="margin-top:4px">Zone — touchez le plan pour poser l’épingle</label>
    <div id="pick" class="pv plan-box"></div>
    <input class="in" id="f-zone" list="zones" placeholder="Zone (ex. Roof DCH4, UTI 11, FSA C…)" value="${esc(state.zone || '')}" style="margin-top:8px">
    <datalist id="zones">${SEED_LOCATIONS.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
    <label class="f">Sous-traitant</label>
    <select class="in" id="f-sub">${subsActive.map(s => `<option value="${s.id}" ${s.id === state.subId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
    ${planList.length > 1 ? `<label class="f">Plan</label><select class="in" id="f-plan">${planList.map(p => `<option value="${p.id}" ${p.id === state.planId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
    <label class="f">Inspecteur(s)</label><input class="in" id="f-insp" value="${esc(state.inspectors || '')}" autocomplete="name">
    <div class="btns" style="margin:0"><div><label class="f">Date</label><input class="in" type="date" id="f-date" value="${esc(state.date)}"></div>
    <div><label class="f">Projet / Site</label><input class="in" id="f-site" value="${esc(state.site || '')}"></div></div>
    <div id="form-foot" style="margin-top:16px"></div>`;
  view.querySelectorAll('[data-logo]').forEach(async im => { im.src = await db.blobURL(im.dataset.logo); });

  let pv = null;
  const mountPlan = async () => {
    pv?.destroy();
    const plan = plans[state.planId];
    const box = $('#pick');
    if (!plan) { box.innerHTML = '<div class="empty">Aucun plan</div>'; return; }
    const sub = subList.find(s => s.id === state.subId);
    pv = createPlanViewer(box, {
      imageURL: await db.blobURL(plan.blobId),
      pins: state.pin ? [{ id: 'p', ...state.pin, color: sub?.color, label: '', ghost: true }] : [],
      focus: state.pin || null,
      onTap: (x, y) => { state.pin = { x, y }; pv.setPins([{ id: 'p', x, y, color: subList.find(s => s.id === state.subId)?.color, label: '', ghost: true }]); live?.('pin'); },
    });
    onCleanup(() => pv?.destroy());
  };
  await mountPlan();

  $('#f-sub').onchange = e => {
    state.subId = e.target.value;
    if (state.pin) pv?.setPins([{ id: 'p', ...state.pin, color: subList.find(s => s.id === state.subId)?.color, ghost: true }]);
    live?.('sub');
  };
  if ($('#f-plan')) $('#f-plan').onchange = e => { state.planId = e.target.value; state.pin = null; mountPlan(); live?.('plan'); };
  const bind = (sel, key) => { $(sel).addEventListener('input', e => { state[key] = e.target.value; live?.(key); }); };
  bind('#f-zone', 'zone'); bind('#f-insp', 'inspectors'); bind('#f-date', 'date'); bind('#f-site', 'site');
  return { plans };
}

async function vNew(q) {
  if (q.get('sub')) { await startInspection(q.get('sub')); return; }
  setTop({ title: 'Nouvelle inspection', back: '#/' });
  const { subList } = await maps();
  const [insps, acts] = await Promise.all([db.all('inspections'), db.all('actions')]);
  view.innerHTML = `<div class="section-head"><span>Choisissez le sous-traitant</span></div>${subGrid(subList, insps, acts)}`;
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
    if (!await confirmBox('Supprimer cette inspection ?', 'Les actions liées sont conservées.')) return;
    await db.remove('inspections', id); location.replace('#/');
  };
}

async function vInsp(id) {
  const insp = await db.get('inspections', id);
  if (!insp || insp.deleted) return vNotFound();
  const { subs, plans } = await maps();
  const sub = subs[insp.subId];
  setTop({ title: sub?.name || insp.ref, sub: insp.ref, back: '#/', actions: [{ icon: 'edit', aria: 'Modifier', onClick: () => location.hash = `#/insp/${id}/edit` }] });
  const acts = await db.byIndex('actions', 'inspectionId', id);
  const draw = () => {
    const o = overallScore(insp.scores, insp.bonus, insp.penalty);
    view.innerHTML = `
      <div class="card score-card">
        <div><div class="score-big" style="color:${o.pct === null ? 'var(--muted)' : o.rating.color}">${o.pct === null ? '—' : Math.round(o.pct * 100) + '<small>%</small>'}</div>
          ${o.pct === null ? '<span class="muted small">Pas encore noté</span>' : ratingChip(o.pct)}</div>
        <div class="score-meta"><b>${o.themes.reduce((a, t) => a + t.done, 0)} / 124</b><span>critères</span>
          <span class="muted small">${dateFR(insp.date)} · ${esc(insp.inspectors || '')}</span>${insp.zone ? `<span class="muted small">${esc(insp.zone)}</span>` : ''}</div>
      </div>
      <div class="toolbar">
        <a href="#/insp/${id}/sum">${ic('file')}<span>Résumé</span></a>
        <button id="exp">${ic('share')}<span>Exporter</span></button>
        <a href="${insp.pin ? `#/map?plan=${insp.planId}&insp=${id}` : `#/insp/${id}/edit`}">${ic('pin')}<span>${insp.pin ? 'Plan' : 'Localiser'}</span></a>
        <a href="#/actions?insp=${id}">${ic('list')}<span>Actions${acts.length ? ` (${acts.length})` : ''}</span></a>
      </div>
      ${o.themes.map(t => {
        const allNA = t.na === t.total;
        return `<div class="card theme-card">
          <a class="grow row" href="#/insp/${id}/t/${t.theme.ref}" style="color:inherit;text-decoration:none">
            <span class="num">${t.theme.ref.replace('.0', '')}</span>
            <span class="grow"><b>${esc(t.theme.name)}</b><div class="muted small">${t.done} / ${t.total}${t.na ? ` · ${t.na} N/A` : ''}</div>
            <div class="progress"><i style="width:${t.done / t.total * 100}%"></i></div></span>
            ${t.done ? badge(t.pct) : '<span class="badge none">—</span>'}</a>
          <button class="na-btn ${allNA ? 'on' : ''}" data-na="${t.theme.ref}" aria-label="Thème non applicable">N/A</button></div>`;
      }).join('')}`;
    $('#exp').onclick = () => exportSheet([insp]);
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
  const th = THEMES.find(t => t.ref === ref);
  const idx = THEMES.indexOf(th);
  insp.scores ||= {};
  setTop({ title: th.name, sub: `Thème ${idx + 1} / ${THEMES.length}`, back: '#/insp/' + id, actions: [helpAction] });
  const acts = await db.byIndex('actions', 'inspectionId', id);
  const save = debounce(() => db.put('inspections', insp), 350);
  onCleanup(() => save.flush());
  const sc = ref => (insp.scores[ref] ||= { v: null, c: '', photos: [] });

  view.innerHTML = `
    <div class="card row sticky-score" id="tscore"></div>
    ${th.criteria.map(c => {
      const s = insp.scores[c.ref] || {};
      const n = acts.filter(a => a.critRef === c.ref).length;
      return `<div class="card crit" data-ref="${c.ref}">
        <h3><small>${c.ref}</small>${esc(c.name)}</h3>
        <div class="scores">${[0, 1, 2, 3, 4, 5, NA].map(v => `<button type="button" data-v="${v}" class="${v === NA ? 'na' : ''} ${s.v === v ? 'on' : ''}">${v === NA ? 'N/A' : v}</button>`).join('')}</div>
        <textarea class="in" style="margin-top:8px;min-height:60px" placeholder="Evidence / Comments" data-c>${esc(s.c || '')}</textarea>
        <div class="crit-tools">
          <label class="btn" style="margin:0">${ic('camera')} Photo<input type="file" accept="image/*" capture="environment" class="hidden-input" data-photo-in multiple></label>
          <button class="btn" data-act>${ic('plus')} Action${n ? ` (${n})` : ''}</button></div>
        <div class="thumbs" data-thumbs></div></div>`;
    }).join('')}
    <div class="btns">
      ${idx > 0 ? `<a class="btn" href="#/insp/${id}/t/${THEMES[idx - 1].ref}">‹ ${THEMES[idx - 1].ref.replace('.0', '')}</a>` : '<span></span>'}
      ${idx < THEMES.length - 1 ? `<a class="btn primary" href="#/insp/${id}/t/${THEMES[idx + 1].ref}">${THEMES[idx + 1].ref.replace('.0', '')} ›</a>` : `<a class="btn primary" href="#/insp/${id}/sum">Résumé ›</a>`}
    </div>`;

  const drawScore = () => {
    const t = themeScore(th, insp.scores);
    $('#tscore').innerHTML = `<div class="grow"><b>Score du thème</b><div class="muted small">${t.done}/${t.total} traités · ${t.sum}/${t.max} pts</div></div>${badge(t.pct)}`;
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
      if (typeof s.v === 'number' && s.v <= 2) {
        const existing = (await db.byIndex('actions', 'inspectionId', id)).filter(a => a.critRef === cref);
        if (!existing.length) {
          const go = await ask(`Note ${s.v} — action corrective ?`, `${esc(cref)} ${esc(criterionOfRef(cref).name)}`, [
            { label: 'Créer l’action corrective', value: true, cls: 'primary' }, { label: 'Plus tard', value: false }]);
          if (go) { const a = await createAction(insp, { critRef: cref, observation: s.c || '', priority: s.v <= 1 ? 'High' : 'Medium' }); location.hash = '#/action/' + a.id; }
        }
      }
      return;
    }
    if (e.target.closest('[data-act]')) {
      const s = sc(cref);
      const a = await createAction(insp, { critRef: cref, observation: s.c || '', priority: typeof s.v === 'number' && s.v <= 1 ? 'High' : 'Medium' });
      location.hash = '#/action/' + a.id; return;
    }
    const ph = e.target.closest('[data-photo]');
    if (ph) photoViewer(ph.dataset.photo, async () => {
      const s = sc(cref); s.photos = s.photos.filter(p => p !== ph.dataset.photo); await db.deleteBlob(ph.dataset.photo); save.flush(); drawThumbs(card);
    });
  });
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
  const { subs } = await maps();
  setTop({ title: 'Résumé', sub: insp.ref, back: '#/insp/' + id, actions: [helpAction] });
  const save = debounce(() => db.put('inspections', insp), 300);
  onCleanup(() => save.flush());
  view.innerHTML = `
    <div class="card">
      <label class="f">Project / Site</label><input class="in" data-k="site" value="${esc(insp.site || '')}">
      <div class="btns" style="margin:0"><div><label class="f">Inspection Date</label><input class="in" type="date" data-k="date" value="${esc(insp.date)}"></div>
      <div><label class="f">Inspection Reference</label><input class="in" value="${esc(insp.ref)}" readonly></div></div>
      <label class="f">Inspector(s)</label><input class="in" data-k="inspectors" value="${esc(insp.inspectors || '')}">
      <div class="muted small" style="margin-top:8px">Sous-traitant : ${subChip(subs[insp.subId])}</div>
      <div class="btns" style="margin-bottom:0"><div><label class="f">BE SAFE Bonus Points</label><input class="in" type="number" inputmode="decimal" step="0.5" data-k="bonus" value="${Number(insp.bonus) || 0}"></div>
      <div><label class="f">LSR Penalty Points</label><input class="in" type="number" inputmode="decimal" step="0.5" data-k="penalty" value="${Number(insp.penalty) || 0}"></div></div>
    </div>
    <div id="sum-out"></div>
    <button class="btn primary block" id="exp" style="margin-top:12px">${ic('share')} Exporter</button>`;
  const draw = () => {
    const o = overallScore(insp.scores, insp.bonus, insp.penalty);
    $('#sum-out').innerHTML = `
      <div class="overall" style="background:${o.rating.color};color:${o.rating.fg}"><div>Overall Site Score</div><b>${fmtPct(o.pct)}</b><span>${o.rating.name}</span>
        <div class="small">${o.countedThemes}/19 thèmes notés</div></div>
      ${barChart(o.themes)}
      <table class="t" style="margin-top:12px"><tr><th>Theme</th><th class="r">Score %</th><th>Rating</th></tr>
      ${o.themes.map(t => `<tr><td><a href="#/insp/${id}/t/${t.theme.ref}">${t.theme.ref} ${esc(t.theme.name)}</a></td><td class="r">${fmtPct(t.pct)}</td><td>${ratingChip(t.pct)}</td></tr>`).join('')}
      <tr><th>Overall Site Score</th><th class="r">${fmtPct(o.pct)}</th><th>${ratingChip(o.pct)}</th></tr></table>`;
  };
  draw();
  view.addEventListener('input', e => {
    const k = e.target.dataset.k; if (!k) return;
    insp[k] = (k === 'bonus' || k === 'penalty') ? (parseFloat(e.target.value.replace(',', '.')) || 0) : e.target.value;
    save(); draw();
  });
  $('#exp').onclick = () => exportSheet([insp]);
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
      ${insps.length === 1 ? '<button class="btn block primary" data-x="pdf">Rapport PDF (résumé, détail, photos, plan, actions)</button>' : ''}
      <button class="btn block" data-close>Annuler</button></div>`,
    (el, close) => el.addEventListener('click', async e => {
      const x = e.target.closest('[data-x]')?.dataset.x; if (!x) return;
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
const actionFilters = { sub: '', view: 'todo', insp: '' };
async function vActions(q) {
  setTop({ title: 'Actions', back: q.get('insp') ? '#/insp/' + q.get('insp') : null });
  if (q.has('late')) actionFilters.view = 'late';
  actionFilters.insp = q.get('insp') || '';
  const { subs, subList } = await maps();
  const all = await db.all('actions');
  const views = { todo: a => a.status !== 'Closed', late: isLate, done: a => a.status === 'Closed' };
  const count = k => all.filter(a => views[k](a) && (!actionFilters.sub || a.subId === actionFilters.sub) && (!actionFilters.insp || a.inspectionId === actionFilters.insp)).length;
  const draw = () => {
    const f = actionFilters;
    const list = all.filter(a => views[f.view](a) && (!f.sub || a.subId === f.sub) && (!f.insp || a.inspectionId === f.insp))
      .sort((a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9') || PRIOS.indexOf(a.priority) - PRIOS.indexOf(b.priority));
    view.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === f.view); b.querySelector('em').textContent = count(b.dataset.view); });
    $('#alist').innerHTML = list.map(a => actionCard(a, subs)).join('') || '<div class="empty">Rien à afficher</div>';
  };
  view.innerHTML = `
    <div class="tabs3">
      <button data-view="todo">À faire <em></em></button>
      <button data-view="late">En retard <em></em></button>
      <button data-view="done">Clôturées <em></em></button>
    </div>
    <select class="in" id="f-sub" style="margin-bottom:12px"><option value="">Tous les sous-traitants</option>${subList.filter(s => !s.archived).sort((a, b) => a.name.localeCompare(b.name)).map(s => `<option value="${s.id}" ${actionFilters.sub === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
    ${actionFilters.insp ? `<div class="card small row">Actions d’une inspection<span class="grow"></span><a href="#/actions">Tout afficher</a></div>` : ''}
    <div id="alist"></div>`;
  draw();
  view.querySelector('.tabs3').onclick = e => { const b = e.target.closest('[data-view]'); if (b) { actionFilters.view = b.dataset.view; draw(); } };
  $('#f-sub').onchange = e => { actionFilters.sub = e.target.value; draw(); };
}

async function vAction(id) {
  const a = await db.get('actions', id);
  if (!a || a.deleted) return vNotFound();
  const { subs, subList, plans } = await maps();
  const insp = a.inspectionId ? await db.get('inspections', a.inspectionId) : null;
  setTop({ title: 'Action', sub: a.critRef ? actionRef(a) : '', back: true });
  const save = debounce(() => db.put('actions', a), 300);
  onCleanup(() => save.flush());
  const crit = a.critRef ? criterionOfRef(a.critRef) : null;
  view.innerHTML = `
    <div class="card">
      <div class="row wrap">${subChip(subs[a.subId])}${insp ? `<a class="chip" style="background:var(--surface-2)" href="#/insp/${insp.id}">${esc(insp.ref)}</a>` : '<span class="chip" style="background:var(--surface-2)">Observation libre</span>'}</div>
      ${crit ? `<div style="margin-top:8px"><b>Reference :</b> <a href="#/insp/${a.inspectionId}/t/${themeOfRef(a.critRef).ref}">${esc(actionRef(a))}</a></div>` : ''}
    </div>
    <label class="f">Sous-traitant</label>
    <select class="in" data-k="subId">${subList.map(s => `<option value="${s.id}" ${s.id === a.subId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
    ${crit ? '' : `<label class="f">Reference (critère)</label><select class="in" data-k="critRef"><option value="">—</option>${THEMES.map(t => `<optgroup label="${esc(t.ref + ' ' + t.name)}">${t.criteria.map(c => `<option value="${c.ref}" ${a.critRef === c.ref ? 'selected' : ''}>${c.ref} ${esc(c.name)}</option>`).join('')}</optgroup>`).join('')}</select>`}
    <label class="f">Observation</label><textarea class="in" data-k="observation">${esc(a.observation)}</textarea>
    <label class="f">Priority</label><div class="seg" data-seg="priority">${PRIOS.map(p => `<button type="button" data-val="${p}" class="${a.priority === p ? 'on' : ''}">${p}</button>`).join('')}</div>
    <label class="f">Corrective Action Required</label><textarea class="in" data-k="corrective">${esc(a.corrective)}</textarea>
    <label class="f">Responsibility</label><input class="in" data-k="responsibility" value="${esc(a.responsibility)}">
    <label class="f">Due Date</label><input class="in" type="date" data-k="dueDate" value="${esc(a.dueDate || '')}">
    <label class="f">Progress</label><div class="seg" data-seg="status">${STATUSES.map(s => `<button type="button" data-val="${s}" class="${a.status === s ? 'on' : ''}">${s}</button>`).join('')}</div>
    <label class="f">Photos</label>
    <label class="btn block">${ic('camera')} Ajouter une photo<input type="file" accept="image/*" capture="environment" class="hidden-input" id="a-photo" multiple></label>
    <div class="thumbs" id="a-thumbs"></div>
    <label class="f">Emplacement sur le plan ${a.planId ? '— ' + esc(plans[a.planId]?.name || '') : ''}</label>
    ${a.planId && plans[a.planId] ? `<div id="a-plan" class="pv plan-box" style="height:42vh"></div>
      <button class="btn block" id="mv" style="margin-top:8px">${a.pin ? 'Déplacer l’épingle' : 'Placer l’épingle'}</button>` : '<div class="muted">Aucun plan lié</div>'}
    <button class="btn danger block" id="del" style="margin-top:20px">Supprimer l’action</button>
    <p class="muted small" style="text-align:center">Enregistrement automatique</p>`;

  const drawThumbs = async () => { $('#a-thumbs').innerHTML = await thumbsHTML(a.photos); };
  drawThumbs();
  view.addEventListener('input', e => {
    const k = e.target.dataset.k; if (!k) return;
    a[k] = e.target.value; save();
  });
  view.addEventListener('change', async e => {
    if (e.target.dataset.k === 'subId') { a.subId = e.target.value; save.flush(); render(); return; }
    if (e.target.id !== 'a-photo') return;
    toast('Compression…'); a.photos = [...(a.photos || []), ...await addPhotos(e.target.files)]; save.flush(); drawThumbs(); e.target.value = '';
  });
  view.addEventListener('click', async e => {
    const sb = e.target.closest('[data-seg] [data-val]');
    if (sb) {
      const key = sb.closest('[data-seg]').dataset.seg;
      a[key] = sb.dataset.val;
      sb.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === sb));
      if (key === 'status' && a.status === 'Closed') a.closedAt = todayISO();
      save.flush(); return;
    }
    const ph = e.target.closest('[data-photo]');
    if (ph) photoViewer(ph.dataset.photo, async () => { a.photos = a.photos.filter(p => p !== ph.dataset.photo); await db.deleteBlob(ph.dataset.photo); save.flush(); drawThumbs(); });
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
let mapSub = '';
async function vMap(q) {
  view.classList.add('full', 'map-page');
  const { subs, subList, plans, planList } = await maps();
  setTop({ title: 'Plan', sub: plans[await db.getMeta('lastPlan')]?.name || '' });
  if (!planList.length) { view.classList.remove('full', 'map-page'); view.innerHTML = `<div class="empty">Aucun plan.<br><br><a class="btn primary" href="#/plans">Importer un plan</a></div>`; return; }
  const planId = q.get('plan') && plans[q.get('plan')] ? q.get('plan') : (plans[await db.getMeta('lastPlan')] ? await db.getMeta('lastPlan') : planList[0].id);
  await db.setMeta('lastPlan', planId);
  const onlyInsp = q.get('insp');
  const [insps, acts] = await Promise.all([db.all('inspections'), db.all('actions')]);
  const active = subList.filter(s => !s.archived).sort((a, b) => a.name.localeCompare(b.name));
  view.innerHTML = `
    <div class="chips-bar">
      <button data-ms="" class="${!mapSub ? 'on' : ''}">Tous</button>
      ${active.map(s => `<button data-ms="${s.id}" class="${mapSub === s.id ? 'on' : ''}" style="--c:${esc(s.color)}"><i></i>${esc(s.name)}</button>`).join('')}
    </div>
    ${planList.length > 1 ? `<select class="in" id="m-plan" style="margin:0 12px 8px;width:calc(100% - 24px)">${planList.map(p => `<option value="${p.id}" ${p.id === planId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
    <div id="map" class="pv map-fill"></div>
    <div class="map-legend"><span><b class="lg-i">I</b> Inspection</span><span><b class="lg-a">!</b> Action ouverte</span></div>`;
  const computePins = () => {
    const out = [];
    insps.filter(i => i.planId === planId && i.pin && (!mapSub || i.subId === mapSub) && (!onlyInsp || i.id === onlyInsp))
      .forEach(i => out.push({ id: 'i:' + i.id, ...i.pin, color: subs[i.subId]?.color, label: 'I' }));
    acts.filter(a => a.planId === planId && a.pin && a.status !== 'Closed' && (!mapSub || a.subId === mapSub) && (!onlyInsp || a.inspectionId === onlyInsp))
      .forEach(a => out.push({ id: 'a:' + a.id, ...a.pin, color: subs[a.subId]?.color, label: '!', kind: 'action' }));
    return out;
  };
  const pv = createPlanViewer($('#map'), {
    imageURL: await db.blobURL(plans[planId].blobId), pins: computePins(), cover: true,
    onPinTap: p => pinSheet(p.id, { subs, insps, acts }),
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
}
function pinSheet(pid, { subs, insps, acts }) {
  const [kind, id] = pid.split(':');
  if (kind === 'i') {
    const i = insps.find(x => x.id === id); const o = overallScore(i.scores, i.bonus, i.penalty);
    openSheet(`<h3>Inspection ${esc(i.ref)}</h3><div class="row">${subChip(subs[i.subId])}<span class="grow muted">${dateFR(i.date)}</span>${badge(o.pct)}</div>
      <p>${esc(i.zone || '')}<br><span class="muted small">${esc(i.inspectors || '')}</span></p>
      <div class="btns"><a class="btn primary" href="#/insp/${i.id}" data-close>Ouvrir</a><button class="btn" data-close>Fermer</button></div>`);
  } else {
    const a = acts.find(x => x.id === id);
    openSheet(`<h3>Action — ${esc(a.priority)}</h3>${actionCard(a, subs)}
      <div class="btns"><a class="btn primary" href="#/action/${a.id}" data-close>Ouvrir</a><button class="btn" data-close>Fermer</button></div>`);
  }
}
function newObservationHere(planId, pin, subList) {
  const active = subList.filter(s => !s.archived);
  if (!active.length) { toast('Ajoutez d’abord un sous-traitant'); return; }
  openSheet(`<h3>Nouvelle action à cet endroit</h3><p class="muted">Choisissez le sous-traitant concerné :</p>
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
async function vSubs() {
  setTop({ title: 'Sous-traitants', actions: cloud.isAdmin() ? [{ icon: 'plus', aria: 'Ajouter', onClick: newSub }] : [] });
  const [subs, insps, acts] = await Promise.all([db.all('subs'), db.all('inspections'), db.all('actions')]);
  const rows = subs.filter(s => showArchived || !s.archived).map(s => {
    const last = insps.filter(i => i.subId === s.id).sort((a, b) => b.date.localeCompare(a.date))[0];
    return { s, pct: last ? overallScore(last.scores, last.bonus, last.penalty).pct : null, open: acts.filter(a => a.subId === s.id && a.status !== 'Closed').length, late: acts.filter(a => a.subId === s.id && isLate(a)).length };
  }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.s.name.localeCompare(b.s.name));
  let rank = 0;
  view.innerHTML = `
    <div class="section-head"><span>Classement — dernier audit</span></div>
    ${rows.map(({ s, pct, open, late }) => `<a class="card link row sub-row" href="#/sub/${s.id}" style="--c:${esc(s.color)};${s.archived ? 'opacity:.5' : ''}">
        <span class="rank">${pct === null ? '–' : ++rank}</span>
        <div class="grow"><b>${esc(s.name || 'Sans nom')}</b>
          <div class="small ${late ? 'late' : 'muted'}">${open ? `${open} action${open > 1 ? 's' : ''} ouverte${open > 1 ? 's' : ''}${late ? ` · ${late} en retard` : ''}` : (pct === null ? 'Pas encore audité' : 'Aucune action ouverte')}</div></div>
        ${pct === null ? '' : badge(pct)}</a>`).join('') || '<div class="empty">Aucun sous-traitant</div>'}
    <div class="row" style="justify-content:space-between;margin:14px 4px">
      <label class="row small" style="gap:8px"><input type="checkbox" id="arch" ${showArchived ? 'checked' : ''} style="width:22px;height:22px"> Archivés</label>
      ${cloud.isAdmin() ? '<button class="link-btn" id="bulk">Import rapide</button>' : ''}</div>`;
  $('#arch').onchange = e => { showArchived = e.target.checked; render(); };
  $('#bulk') && ($('#bulk').onclick = () => openSheet(`<h3>Import rapide</h3>
    <p class="muted small">Un nom de sous-traitant par ligne (copier-coller depuis Excel possible).</p>
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
      close(); toast(`${n} sous-traitant(s) ajouté(s)`); render();
    }));
}
async function newSub() {
  const n = (await db.all('subs', { includeDeleted: true })).length;
  const s = await db.put('subs', { name: '', contact: '', phone: '', color: PALETTE[n % PALETTE.length], archived: false });
  location.hash = `#/sub/${s.id}/edit`;
}
async function vSubEdit(id) {
  if (!cloud.isAdmin()) return vNotFound();
  const s = await db.get('subs', id);
  if (!s) return vNotFound();
  setTop({ title: s.name || 'Nouveau sous-traitant', back: true });
  const save = debounce(() => db.put('subs', s), 300);
  onCleanup(() => save.flush());
  view.innerHTML = `
    <label class="f">Nom *</label><input class="in" data-k="name" value="${esc(s.name)}" placeholder="ex. Alphascaff">
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
  view.addEventListener('input', e => { const k = e.target.dataset.k; if (k) { s[k] = e.target.value; save(); if (k === 'name') $('#title').textContent = s.name || 'Sous-traitant'; } });
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
  setTop({ title: s.name || 'Sous-traitant', back: '#/subs', actions: cloud.isAdmin() ? [{ icon: 'edit', aria: 'Modifier', onClick: () => location.hash = `#/sub/${id}/edit` }] : [] });
  const [insps, acts] = await Promise.all([db.byIndex('inspections', 'subId', id), db.byIndex('actions', 'subId', id)]);
  insps.sort((a, b) => a.date.localeCompare(b.date));
  const pts = insps.map(i => ({ i, pct: overallScore(i.scores, i.bonus, i.penalty).pct }));
  const open = acts.filter(a => a.status !== 'Closed');
  const { subs } = await maps();
  view.innerHTML = `
    <div class="card row">${s.logoId ? `<img class="logo" id="lg" style="width:60px;height:60px">` : `<span class="dot" style="background:${esc(s.color)};width:40px;height:40px"></span>`}
      <div class="grow"><b style="font-size:20px">${esc(s.name)}</b>
      <div>${esc(s.contact || '')}${s.phone ? ` · <a href="tel:${esc(s.phone.replace(/\s/g, ''))}">${esc(s.phone)}</a>` : ''}</div></div></div>
    <div class="btns"><a class="btn primary" href="#/new?sub=${id}">${ic('plus')} Inspection</a><a class="btn" href="#/actions" id="go-acts">Actions (${open.length})</a></div>
    <h2>Évolution du score</h2>${lineChart(pts)}
    <h2>Actions ouvertes (${open.length})</h2>${open.map(a => actionCard(a, subs)).join('') || '<div class="empty">Aucune</div>'}
    <h2>Inspections (${insps.length})</h2>${[...insps].reverse().map(i => inspCard(i, subs)).join('') || '<div class="empty">Aucune</div>'}`;
  if (s.logoId) $('#lg').src = await db.blobURL(s.logoId);
  $('#go-acts').onclick = () => { actionFilters.sub = id; actionFilters.view = 'todo'; };
}
function lineChart(pts) {
  const v = pts.filter(p => p.pct !== null);
  if (!v.length) return '<div class="empty">Pas encore de score</div>';
  const w = 340, h = 170, L = 30, R = 10, T = 10, B = 26;
  const x = i => v.length === 1 ? (L + w - R) / 2 : L + i * (w - L - R) / (v.length - 1);
  const y = p => T + (1 - p) * (h - T - B);
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;background:var(--surface);border-radius:14px;border:2px solid var(--line)">
    ${[0.5, 0.7, 0.8, 0.9, 1].map(t => `<line x1="${L}" x2="${w - R}" y1="${y(t)}" y2="${y(t)}" stroke="${rating(t).color}" stroke-opacity=".5" stroke-dasharray="3 3"/><text x="2" y="${y(t) + 3}" font-size="9">${t * 100}%</text>`).join('')}
    <polyline fill="none" stroke="var(--brand-2)" stroke-width="2.5" points="${v.map((p, i) => `${x(i)},${y(p.pct)}`).join(' ')}"/>
    ${v.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.pct)}" r="5.5" fill="${rating(p.pct).color}" stroke="#fff" stroke-width="1.5"/>
      <text x="${x(i)}" y="${h - 8}" font-size="8.5" text-anchor="middle">${p.i.date.slice(5).split('-').reverse().join('/')}</text>`).join('')}
  </svg>`;
}

// ---------- plans ----------
async function vPlans() {
  if (!cloud.isAdmin()) return vNotFound();
  setTop({ title: 'Plans', back: true });
  const plans = await db.all('plans');
  view.innerHTML = `
    <label class="btn primary big">⬆ Importer un plan (image ou PDF)<input type="file" accept="image/*,application/pdf,.pdf" class="hidden-input" id="p-in"></label>
    <p class="muted small">Le PDF est converti en image haute définition (page au choix). Plusieurs plans possibles (SAM2, SAM3…).</p>
    ${plans.map(p => `<div class="card" data-p="${p.id}"><div class="row"><img class="plan-thumb" data-img="${p.blobId}">
      <div class="grow"><label class="f" style="margin-top:0">Nom</label><input class="in" data-k="name" value="${esc(p.name)}"></div></div>
      <div class="btns" style="margin-bottom:0"><div><label class="f">Code (référence)</label><input class="in" data-k="code" value="${esc(p.code || '')}" placeholder="SAM2"></div>
      <div style="display:flex;align-items:end;gap:6px"><a class="btn grow" href="#/map?plan=${p.id}">Ouvrir</a><button class="btn danger" data-del aria-label="Supprimer">${ic('x')}</button></div></div></div>`).join('') || '<div class="empty">Aucun plan importé</div>'}`;
  view.querySelectorAll('[data-img]').forEach(async im => { im.src = await db.blobURL(im.dataset.img); });
  const saves = {};
  view.addEventListener('input', e => {
    const k = e.target.dataset.k, card = e.target.closest('[data-p]'); if (!k || !card) return;
    const p = plans.find(x => x.id === card.dataset.p); p[k] = k === 'code' ? e.target.value.toUpperCase() : e.target.value;
    (saves[p.id] ||= debounce(() => db.put('plans', p), 300))();
  });
  onCleanup(() => Object.values(saves).forEach(s => s.flush()));
  view.addEventListener('click', async e => {
    if (!e.target.closest('[data-del]')) return;
    const p = plans.find(x => x.id === e.target.closest('[data-p]').dataset.p);
    if (await confirmBox(`Supprimer le plan « ${p.name} » ?`, 'Les inspections et actions restent, mais leurs épingles ne seront plus visibles.')) { await db.remove('plans', p.id); render(); }
  });
  $('#p-in').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      let page = 1;
      if (/pdf/i.test(f.type) || /\.pdf$/i.test(f.name)) {
        toast('Lecture du PDF…');
        const n = await pdfPageCount(f);
        if (n > 1) page = await ask('Quelle page importer ?', `Le PDF contient ${n} pages.`, [...Array(Math.min(n, 12))].map((_, i) => ({ label: 'Page ' + (i + 1), value: i + 1 })));
        if (!page) return;
      }
      toast('Conversion du plan…', 6000);
      const { blob } = await planFileToBlob(f, page);
      const blobId = await db.putBlob(blob);
      const base = f.name.replace(/\.[^.]+$/, '');
      const code = (base.match(/SAM\s*\d+/i)?.[0] || '').replace(/\s/g, '').toUpperCase() || base.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      await db.put('plans', { name: base, code, blobId });
      toast('Plan importé'); render();
    } catch (err) { console.error(err); toast('Import impossible : ' + err.message, 4000); }
  };
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
    ${cloud.isAdmin() ? `<a class="btn block primary" href="#/team" style="margin:10px 0">${ic('building')} Équipe et invitations</a>` : ''}` : ''}
    <div class="card">
      ${cloud.enabled ? '' : `<label class="f" style="margin-top:0">Inspecteur par défaut</label><input class="in" data-s="inspector" value="${esc(st.inspector)}">`}
      <label class="f">Projet / Site par défaut</label><input class="in" data-s="site" value="${esc(st.site)}">
      <label class="f">Affichage</label><div class="seg" id="theme">${[['auto', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']].map(([v, l]) => `<button data-val="${v}" class="${st.theme === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    ${cloud.isAdmin() ? '<a class="btn block" href="#/plans" style="margin-bottom:10px">Gérer les plans</a>' : ''}
    <button class="btn block" id="scale" style="margin-bottom:10px">Barème de notation (Notes)</button>
    <h2>Exports</h2>
    <button class="btn block primary" id="x-all" style="margin-bottom:10px">Excel — toutes les inspections</button>
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
  $('#x-all').onclick = async () => { const all = (await db.all('inspections')).sort((a, b) => a.date.localeCompare(b.date)); if (!all.length) return toast('Aucune inspection'); exportSheet(all, { allActions: true }); };
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

// ---------- équipe (admin) ----------
async function vTeam() {
  setTop({ title: 'Équipe', sub: 'Accès à l’application', back: '#/settings' });
  if (!cloud.isAdmin()) return vNotFound();
  view.innerHTML = '<div class="empty">Chargement…</div>';
  let t;
  try { t = await cloud.team(); } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}<br>Une connexion internet est nécessaire.</div>`; return; }
  const insps = await db.all('inspections');
  const pending = t.invites.filter(i => !t.profiles.some(p => p.email === i.email));
  view.innerHTML = `
    <div class="card">
      <b>Inviter une personne</b>
      <p class="muted small" style="margin:4px 0 8px">Elle pourra ensuite créer son compte dans l’app avec cette adresse.</p>
      <input class="in" id="t-name" placeholder="Nom et prénom" autocomplete="off">
      <input class="in" id="t-mail" type="email" inputmode="email" placeholder="Email" style="margin-top:8px" autocomplete="off">
      <div class="seg" id="t-role" style="margin-top:8px"><button data-val="inspector" class="on">Inspecteur</button><button data-val="admin">Administrateur</button></div>
      <button class="btn primary block" id="t-go" style="margin-top:10px">${ic('plus')} Inviter</button>
    </div>
    <div class="section-head"><span>Membres</span><span class="muted small">${t.profiles.length}</span></div>
    ${t.profiles.map(p => {
      const n = insps.filter(i => i.owner === p.id).length;
      const last = insps.filter(i => i.owner === p.id).sort((a, b) => b.date.localeCompare(a.date))[0];
      return `<div class="card row member ${p.active ? '' : 'off'}">
        <span class="avatar">${esc((p.name || p.email).split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())}</span>
        <div class="grow"><b>${esc(p.name || p.email)}</b>${p.role === 'admin' ? ' <span class="chip role">Admin</span>' : ''}
          <div class="muted small ellip">${esc(p.email)}</div>
          <div class="small">${n} audit${n > 1 ? 's' : ''}${last ? ` · dernier ${dateFR(last.date)}` : ''}${p.active ? '' : ' · <b class="late">bloqué</b>'}</div></div>
        ${p.id !== cloud.uid() ? `<button class="btn small-btn" data-act="${p.id}" data-on="${p.active ? 0 : 1}">${p.active ? 'Bloquer' : 'Réactiver'}</button>` : ''}
      </div>`;
    }).join('')}
    ${pending.length ? `<div class="section-head"><span>Invitations en attente</span><span class="muted small">${pending.length}</span></div>
      ${pending.map(i => `<div class="card row member"><span class="avatar pending">${ic('clock', 18)}</span>
        <div class="grow"><b>${esc(i.name || i.email)}</b>${i.role === 'admin' ? ' <span class="chip role">Admin</span>' : ''}<div class="muted small ellip">${esc(i.email)} · pas encore inscrit</div></div>
        <button class="btn small-btn danger" data-del="${esc(i.email)}" aria-label="Annuler">${ic('x', 18)}</button></div>`).join('')}` : ''}`;
  let role = 'inspector';
  $('#t-role').onclick = e => { const b = e.target.closest('[data-val]'); if (!b) return; role = b.dataset.val; $('#t-role').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); };
  $('#t-go').onclick = async () => {
    const mail = $('#t-mail').value.trim(), name = $('#t-name').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return toast('Adresse email invalide');
    try { await cloud.invite(mail, name, role); toast('Invitation enregistrée'); render(); } catch (e) { toast(e.message, 4000); }
  };
  view.addEventListener('click', async e => {
    const a = e.target.closest('[data-act]');
    if (a) {
      const on = a.dataset.on === '1';
      if (!on && !await confirmBox('Bloquer cet accès ?', 'La personne ne pourra plus envoyer ni consulter de données. Ses audits restent visibles pour vous.', 'Bloquer')) return;
      try { await cloud.setActive(a.dataset.act, on); render(); } catch (err) { toast(err.message, 4000); }
    }
    const d = e.target.closest('[data-del]');
    if (d && await confirmBox('Annuler cette invitation ?', esc(d.dataset.del), 'Annuler l’invitation')) {
      try { await cloud.removeInvite(d.dataset.del); render(); } catch (err) { toast(err.message, 4000); }
    }
  });
}

function vNotFound() { setTop({ title: 'Introuvable', back: '#/' }); view.innerHTML = '<div class="empty">Élément introuvable ou supprimé.</div>'; }

// =====================================================================
// ROUTEUR
// =====================================================================
const routes = [
  [/^\/?$/, vHome, 'home'],
  [/^\/new$/, vNew, 'home'],
  [/^\/insp\/([^/]+)$/, vInsp, 'home'],
  [/^\/insp\/([^/]+)\/edit$/, vInspEdit, 'home'],
  [/^\/insp\/([^/]+)\/sum$/, vSummary, 'home'],
  [/^\/insp\/([^/]+)\/t\/([\d.]+)$/, vTheme, 'home'],
  [/^\/actions$/, vActions, 'actions'],
  [/^\/action\/([^/]+)$/, vAction, 'actions'],
  [/^\/map$/, vMap, 'map'],
  [/^\/subs$/, vSubs, 'subs'],
  [/^\/sub\/([^/]+)$/, vSub, 'subs'],
  [/^\/sub\/([^/]+)\/edit$/, vSubEdit, 'subs'],
  [/^\/plans$/, vPlans, 'home'],
  [/^\/settings$/, vSettings, 'home'],
  [/^\/team$/, vTeam, 'home'],
];

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  cleanups.forEach(f => { try { f(); } catch { /* ignore */ } }); cleanups = [];
  document.querySelectorAll('.sheet-bg').forEach(s => s.remove());
  // nouveau nœud pour supprimer les écouteurs de l'écran précédent
  const fresh = view.cloneNode(false); view.replaceWith(fresh); view = fresh;
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

async function seed() {
  await migrateSeedIds();
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
  // sous-traitants et plan de départ avec identifiants fixes, identiques sur tous les téléphones
  // (seul l'admin les envoie au serveur, voir cloud.push)
  try { await seed(); } catch (e) { console.error('seed', e); }
  cloud.onStatus(drawSync);
  cloud.syncSoon(0);
  render();
}

// ---------- écran de connexion ----------
function showLogin() {
  document.body.classList.add('login-mode');
  let mode = 'in';
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
