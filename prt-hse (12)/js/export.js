// Exports Excel (4 feuilles identiques au fichier d'origine), PDF, partage iOS.
import { THEMES } from './prt-data.js';
import { SCALE, RATINGS, NA, overallScore, themeScore, rating, criterionOfRef } from './calc.js';
import { renderPlanSnapshot } from './plan.js';
import * as db from './db.js';
import { TXT, THEME_FR, CRIT_FR, RATING_FR, RANGE_FR } from './report-fr.js';
import { fillPRTTemplate } from './xlsx-template.js';

const subIdsOf = i => Array.isArray(i?.subIds) ? i.subIds : (i?.subId ? [i.subId] : []);
const subNames = (i, subs) => subIdsOf(i).map(id => subs[id]?.name).filter(Boolean);
const subjectOf = (i, subs) => { const n = subNames(i, subs); return n.length ? n.join(', ') : 'Area inspection'; };
const dateFR = d => d ? new Date(d + (d.length === 10 ? 'T12:00:00' : '')).toLocaleDateString('fr-BE') : '';
export const actionRef = a => a.critRef ? `${a.critRef} ${criterionOfRef(a.critRef)?.name || ''}`.trim() : (a.reference || '');

/** Charge le contexte d'une liste d'inspections (sous-traitants, plans, actions) */
export async function loadContext(inspections, { allActions = false } = {}) {
  const subs = Object.fromEntries((await db.all('subs', { includeDeleted: true })).map(s => [s.id, s]));
  const plans = Object.fromEntries((await db.all('plans', { includeDeleted: true })).map(p => [p.id, p]));
  const actions = (await db.all('actions')).filter(a => allActions || inspections.some(i => i.id === a.inspectionId))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return { subs, plans, actions };
}

// ---------------- EXCEL ----------------
// ExcelJS n'est chargé qu'au moment d'un export (≈ 1 Mo, gardé hors ligne par le service worker)
let excelJS = null;
const loadExcelJS = () => window.ExcelJS ? Promise.resolve(window.ExcelJS) : (excelJS ||= new Promise((res, rej) => {
  const sc = document.createElement('script'); sc.src = 'vendor/exceljs.min.js';
  sc.onload = () => res(window.ExcelJS); sc.onerror = () => { excelJS = null; rej(new Error('Module Excel indisponible')); };
  document.head.appendChild(sc);
}));
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Un audit = le fichier PRT d'origine, rempli (même mise en page, mêmes formules, mêmes listes déroulantes) */
async function buildXLSXFromTemplate(insp, ctx) {
  const [ExcelJS, tpl] = await Promise.all([loadExcelJS(), fetch('assets/prt-template.xlsx').then(r => { if (!r.ok) throw new Error('Modèle Excel introuvable'); return r.arrayBuffer(); })]);
  const out = await fillPRTTemplate(ExcelJS, tpl, {
    subject: subjectOf(insp, ctx.subs), site: insp.site || '', date: dateFR(insp.date), inspectors: insp.inspectors || '', ref: insp.ref || '',
    bonus: insp.bonus, penalty: insp.penalty,
    themes: THEMES.map(t => ({ ref: t.ref, criteria: t.criteria.map(c => { const sc = insp.scores?.[c.ref] || {}; return { ref: c.ref, v: typeof sc.v === 'number' ? sc.v : sc.v === NA ? 'N/A' : null, c: sc.c || '' }; }) })),
    actions: ctx.actions.filter(a => a.inspectionId === insp.id).map(a => ({ observation: a.observation || '', priority: a.priority || '', corrective: a.corrective || '', responsibility: a.responsibility || '', dueDate: dateFR(a.dueDate), status: a.status || 'Open', reference: actionRef(a) })),
  });
  return new Blob([out], { type: XLSX_TYPE });
}

export async function buildXLSX(inspections, opts = {}) {
  const XLSX = window.XLSX;
  const ctx = await loadContext(inspections, opts);
  if (inspections.length === 1 && !opts.allActions) {
    try { return await buildXLSXFromTemplate(inspections[0], ctx); } catch (e) { console.warn('Export modèle PRT indisponible, export simple', e); }
  }
  const multi = inspections.length > 1;
  const pctCells = { scoring: [], summary: [] };

  // Feuille 1 : HSE Scoring Sheet
  const S = [];
  for (const insp of inspections) {
    const base = S.length;
    S.push(['PRT - Site HSE Performance Rating Tool']);
    S.push(['Sub-Contractor', subjectOf(insp, ctx.subs), 'Inspection Date', dateFR(insp.date), 'Inspector(s)', insp.inspectors || '']);
    S.push([multi ? insp.ref : '']);
    S.push(['Ref.', 'Audited Element', 'Evaluation', 'Maximum', 'Score %', 'Evidence / Comments']);
    for (const t of THEMES) {
      const ts = themeScore(t, insp.scores);
      S.push([t.ref, t.name, ts.sum, ts.max, ts.pct === null ? 'N/A' : ts.pct, '']);
      if (ts.pct !== null) pctCells.scoring.push(S.length - 1);
      for (const c of t.criteria) {
        const sc = insp.scores?.[c.ref] || {};
        const v = typeof sc.v === 'number' ? sc.v : sc.v === NA ? 'N/A' : '';
        S.push([c.ref, c.name, v, 5, typeof sc.v === 'number' ? sc.v / 5 : '', sc.c || '']);
        if (typeof sc.v === 'number') pctCells.scoring.push(S.length - 1);
      }
    }
    if (multi) S.push([], []);
    void base;
  }

  // Feuille 2 : Executive Summary
  const E = [];
  for (const insp of inspections) {
    const o = overallScore(insp.scores, insp.bonus, insp.penalty);
    E.push(['PRT Executive Summary']);
    E.push([multi ? subjectOf(insp, ctx.subs) : '']);
    E.push(['Project / Site', insp.site || '']);
    E.push(['Inspection Date', dateFR(insp.date)]);
    E.push(['Inspector(s)', insp.inspectors || '']);
    E.push(['Inspection Reference', insp.ref]);
    E.push(['BE SAFE Bonus Points', Number(insp.bonus) || 0]);
    E.push(['LSR Penalty Points', Number(insp.penalty) || 0]);
    E.push([]);
    E.push(['Theme', 'Score %', 'Rating']);
    for (const p of o.themes) {
      E.push([`${p.theme.ref} ${p.theme.name}`, p.pct === null ? '' : p.pct, rating(p.pct).name]);
      if (p.pct !== null) pctCells.summary.push(E.length - 1);
    }
    E.push([]);
    E.push(['Overall Site Score', o.pct === null ? '' : o.pct, o.rating.name]);
    if (o.pct !== null) pctCells.summary.push(E.length - 1);
    if (multi) E.push([], []);
  }

  // Feuille 3 : Action Report
  const A = [['HSE Site Performance - Action Report'], [], ['No.', 'Observation', 'Priority', 'Corrective Action Required', 'Responsibility', 'Due Date', 'Progress', 'Reference']];
  const acts = ctx.actions.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  acts.forEach((a, i) => {
    const insp = inspections.find(x => x.id === a.inspectionId);
    const ref = actionRef(a);
    A.push([i + 1, a.observation || '', a.priority || '', a.corrective || '', a.responsibility || '', dateFR(a.dueDate), a.status || 'Open', multi ? `${insp?.ref || 'Observation'} / ${ref}` : ref]);
  });
  if (!acts.length) for (let i = 1; i <= 20; i++) A.push([i]);

  // Feuille 4 : Notes
  const N = [['Scoring Guidance'], [], ['Score', 'Definition'], ...SCALE.map(s => [s.v, s.en]), [], ['Rating', 'Range'], ...RATINGS.map(r => [r.name, r.range])];

  const wb = XLSX.utils.book_new();
  const mk = (aoa, cols) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = cols.map(w => ({ wch: w })); return ws; };
  const wsS = mk(S, [8, 58, 12, 10, 10, 60]);
  for (const r of pctCells.scoring) { const c = wsS[XLSX.utils.encode_cell({ r, c: 4 })]; if (c && typeof c.v === 'number') c.z = '0%'; }
  const wsE = mk(E, [52, 12, 16]);
  for (const r of pctCells.summary) { const c = wsE[XLSX.utils.encode_cell({ r, c: 1 })]; if (c && typeof c.v === 'number') c.z = '0%'; }
  XLSX.utils.book_append_sheet(wb, wsS, 'HSE Scoring Sheet');
  XLSX.utils.book_append_sheet(wb, wsE, 'Executive Summary');
  XLSX.utils.book_append_sheet(wb, mk(A, [6, 50, 10, 50, 22, 12, 12, 40]), 'Action Report');
  XLSX.utils.book_append_sheet(wb, mk(N, [12, 100]), 'Notes');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------------- PDF ----------------
// Rapport pensé pour le destinataire (sous-traitant, direction, client) :
// 1. synthèse lisible en 30 s  2. actions à mener  3. localisation  4. détail des constats
// 5. photos  6. comment lire le rapport (barème, méthode de calcul)
const blobToDataURL = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
const imgSize = url => new Promise(res => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res({ w: 1, h: 1 }); i.src = url; });
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BRAND = [11, 45, 91];
const INK = [20, 28, 40], MUTED = [100, 110, 125], LINE = [215, 221, 230], SOFT = [244, 246, 249];
const SCORE_COLOR = { 0: '#C62828', 1: '#C62828', 2: '#EF6C00', 3: '#FBC02D', 4: '#43A047', 5: '#1B5E20' };
const PRIO_COLOR = { High: '#C62828', Medium: '#EF6C00', Low: '#1A56A8' };
const pct = p => p === null || p === undefined ? 'N/A' : (Math.round(p * 1000) / 10) + ' %';
const abbr3 = n => (n || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();

export const REPORT_TITLES = { en: TXT.en.title, fr: TXT.fr.title };
export const REPORT_DEFAULTS = {
  title: TXT.en.title, to: '', summary: '', lang: 'en', kind: '',
  sections: { findings: true, actions: true, plan: true, details: true, photos: true, guide: true },
};

export async function buildPDF(insp) {
  const { jsPDF } = window.jspdf;
  const ctx = await loadContext([insp]);
  const ids = subIdsOf(insp);
  const single = ids.length === 1 ? (ctx.subs[ids[0]] || {}) : null;
  const sub = single || { name: ids.length ? subNames(insp, ctx.subs).join(', ') : `${(insp.report?.lang === 'fr' ? TXT.fr : TXT.en).area}${insp.zone ? ' — ' + insp.zone : ''}`, color: '#0B2D5B', type: ids.length ? 'multi' : 'zone' };
  const pinLabel = single ? abbr3(single.name) : ids.length ? 'x' + ids.length : 'ZON';
  const plan = ctx.plans[insp.planId];
  const o = overallScore(insp.scores, insp.bonus, insp.penalty);
  const acts = ctx.actions;
  const project = await db.get('projects', insp.projectId || 'proj-sam2a');
  const R = { ...REPORT_DEFAULTS, ...(insp.report || {}) };
  R.sections = { ...REPORT_DEFAULTS.sections, ...(insp.report?.sections || {}) };
  const FR = R.lang === 'fr', L = FR ? TXT.fr : TXT.en;
  const tName = t => (FR && THEME_FR[t.ref]) || t.name;
  const cName = c => (FR && CRIT_FR[c.ref]) || c.name;
  const rName = r => FR ? (RATING_FR[r.name] || r.name) : r.name;
  const aRef = a => a.critRef ? `${a.critRef} ${(FR && CRIT_FR[a.critRef]) || criterionOfRef(a.critRef)?.name || ''}`.trim() : (a.reference || '');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, H = 297, M = 14, CW = W - 2 * M;
  let y = 0;

  const header = title => {
    doc.setFillColor(...BRAND); doc.rect(0, 0, W, 14, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5);
    doc.text(title, M, 9.2);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
    doc.text(`${(sub.name || '').length > 42 ? sub.name.slice(0, 40) + '…' : sub.name || ''}  ·  ${dateFR(insp.date)}`, W - M, 9.2, { align: 'right' });
    doc.setTextColor(...INK);
    y = 24;
  };
  const section = (title, sub2) => {
    ensure(16);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12.5); doc.setTextColor(...BRAND);
    doc.text(title, M, y);
    if (sub2) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTED); doc.text(sub2, W - M, y, { align: 'right' }); }
    doc.setDrawColor(...BRAND); doc.setLineWidth(0.5); doc.line(M, y + 2, W - M, y + 2);
    doc.setTextColor(...INK); y += 8;
  };
  const ensure = h => { if (y + h > H - 16) { doc.addPage(); header(currentTitle); } };
  let currentTitle = R.title || REPORT_DEFAULTS.title;
  const newPage = t => { currentTitle = t; doc.addPage(); header(t); };
  const tableDefaults = { theme: 'grid', margin: { left: M, right: M, top: 22 }, styles: { fontSize: 8.5, cellPadding: 2, textColor: INK, lineColor: LINE, lineWidth: 0.2 }, headStyles: { fillColor: BRAND, textColor: 255, fontStyle: 'bold' }, didDrawPage: () => header(currentTitle) };

  // ============ PAGE 1 : SYNTHÈSE ============
  header(currentTitle);
  // logos du rapport (ex. Jan De Nul + Besix) : en haut de la 1re page, en petit dans le pied des suivantes
  const logos = [];
  for (const id of [project?.logoId, project?.logo2Id].filter(Boolean)) {
    const lb = await db.getBlob(id).catch(() => null);
    if (lb) { const u = await blobToDataURL(lb); logos.push({ u, r: (s => s.w / s.h)(await imgSize(u)) }); }
  }
  { let lx = W - M; for (const lg of [...logos].reverse()) { const lh = 13, lw = Math.min(38, lh * lg.r), h2 = lw / lg.r; lx -= lw; doc.addImage(lg.u, 'JPEG', lx, 18 + (lh - h2) / 2, lw, h2); lx -= 5; } }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text((R.kind || '').trim() ? R.kind.trim().toUpperCase() : (L.type[sub.type] || L.type.entreprise), M, y);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(sub.name.length > 28 ? 17 : 24); doc.setTextColor(...INK);
  doc.text(doc.splitTextToSize(sub.name || '—', CW - (logos.length > 1 ? 85 : 50))[0], M, y + 10);
  if (sub.color) { doc.setFillColor(...hex(sub.color)); doc.rect(M - 4, y - 3.5, 1.6, 15, 'F'); }
  y += 16;
  const info = [[L.info[0], dateFR(insp.date)], [L.info[1], insp.site || '—'], [L.info[2], [plan?.name, insp.zone].filter(Boolean).join(' — ') || '—'], [L.info[3], insp.inspectors || '—'], [L.info[4], insp.ref], ...(R.to ? [[L.info[5], R.to]] : [])];
  doc.setFontSize(9);
  info.forEach(([k, v], i) => {
    const cx = M + (i % 2) * (CW / 2), cy = y + Math.floor(i / 2) * 6;
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTED); doc.text(k, cx, cy);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK); doc.text(doc.splitTextToSize(String(v), CW / 2 - 34)[0], cx + 30, cy);
  });
  y += 20;

  // Score global + échelle
  const rc = o.rating;
  doc.setFillColor(...hex(rc.color)); doc.roundedRect(M, y, 62, 38, 3, 3, 'F');
  const fg = rc.fg === '#fff' ? 255 : 0;
  doc.setTextColor(fg); doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text(L.overall, M + 5, y + 7);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(26); doc.text(pct(o.pct), M + 5, y + 21);
  doc.setFontSize(13); doc.text(rName(rc), M + 5, y + 31);
  const sx = M + 70, sw = CW - 70;
  doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.text(`${L.rating}${FR ? ' :' : ':'} ${rName(rc)}`, sx, y + 6);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text(doc.splitTextToSize(L.meaning[rc.name] || '', sw), sx, y + 11.5);
  const segs = [...RATINGS].reverse().map((r, i, arr) => ({ r, from: Math.max(0, r.min === -Infinity ? 0 : r.min), to: i < arr.length - 1 ? arr[i + 1].min : 1 }));
  const by = y + 22;
  segs.forEach(({ r, from, to }) => {
    doc.setFillColor(...hex(r.color)); doc.rect(sx + from * sw, by, (to - from) * sw, 5, 'F');
    doc.setFontSize(6.5); doc.setTextColor(...MUTED); doc.text(rName(r), sx + (from + to) / 2 * sw, by + 9, { align: 'center' });
  });
  [0.5, 0.7, 0.8, 0.9].forEach(t => { doc.setFontSize(6.5); doc.text(`${t * 100}%`, sx + t * sw, by - 1.5, { align: 'center' }); });
  if (o.pct !== null) {
    const mx = sx + o.pct * sw;
    doc.setFillColor(...INK); doc.triangle(mx - 2.2, by - 3.6, mx + 2.2, by - 3.6, mx, by - 0.4, 'F');
    doc.setLineWidth(0.6); doc.setDrawColor(...INK); doc.line(mx, by, mx, by + 5);
  }
  y += 46;

  // Chiffres clés
  const assessed = o.themes.filter(t => t.pct !== null);
  const critCount = o.themes.reduce((a, t) => a + t.rated, 0);
  const high = acts.filter(a => a.priority === 'High').length;
  const kl = L.kpi({ acts: acts.length, high });
  const kpis = [[`${assessed.length} / 19`, kl[0]], [String(critCount), kl[1]], [String(acts.length), kl[2]], [`+${Number(insp.bonus) || 0} / -${Number(insp.penalty) || 0}`, kl[3]]];
  const kw = (CW - 9) / 4;
  kpis.forEach(([v, l], i) => {
    const kx = M + i * (kw + 3);
    doc.setFillColor(...SOFT); doc.setDrawColor(...LINE); doc.roundedRect(kx, y, kw, 17, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...INK); doc.text(v, kx + kw / 2, y + 8, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED); doc.text(doc.splitTextToSize(l, kw - 4), kx + kw / 2, y + 12.5, { align: 'center' });
  });
  y += 24;

  // Synthèse rédigée par l'inspecteur (facultative)
  if ((R.summary || '').trim()) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
    const lines = doc.splitTextToSize(R.summary.trim(), CW - 10);
    const h = lines.length * 4.4 + 10;
    ensure(h + 4);
    doc.setFillColor(...SOFT); doc.setDrawColor(...LINE); doc.roundedRect(M, y, CW, h, 2, 2, 'FD');
    doc.setFillColor(...BRAND); doc.rect(M, y, 1.6, h, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...BRAND); doc.text(L.summary, M + 5, y + 6);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...INK); doc.text(lines, M + 5, y + 11.5);
    y += h + 6;
  }

  // Résultats par thème (barres)
  section(L.results, L.resultsSub);
  doc.autoTable({
    ...tableDefaults, startY: y,
    head: [L.themeHead],
    body: assessed.map(t => [`${t.theme.ref.replace('.0', '')}. ${tName(t.theme)}`, '', pct(t.pct), rName(rating(t.pct))]),
    columnStyles: { 0: { cellWidth: 72 }, 1: { cellWidth: 52 }, 2: { cellWidth: 20, halign: 'right', fontStyle: 'bold' }, 3: { cellWidth: 'auto', fontStyle: 'bold' } },
    styles: { ...tableDefaults.styles, fontSize: 8.5, cellPadding: 1.8 },
    didParseCell: d => {
      if (d.section !== 'body' || d.column.index !== 3) return;
      const r = rating(assessed[d.row.index].pct); d.cell.styles.textColor = hex(r.color === '#FBC02D' ? '#B28704' : r.color);
    },
    didDrawCell: d => {
      if (d.section !== 'body' || d.column.index !== 1) return;
      const p = assessed[d.row.index].pct, bw = d.cell.width - 4;
      doc.setFillColor(...LINE); doc.rect(d.cell.x + 2, d.cell.y + d.cell.height / 2 - 1.6, bw, 3.2, 'F');
      doc.setFillColor(...hex(rating(p).color)); doc.rect(d.cell.x + 2, d.cell.y + d.cell.height / 2 - 1.6, bw * p, 3.2, 'F');
    },
  });
  y = doc.lastAutoTable.finalY + 4;
  const naThemes = o.themes.filter(t => t.pct === null && t.na === t.total).map(t => t.theme.ref.replace('.0', '') + '. ' + tName(t.theme));
  const notThemes = o.themes.filter(t => t.pct === null && t.na !== t.total).map(t => t.theme.ref.replace('.0', '') + '. ' + tName(t.theme));
  doc.setFontSize(7.5); doc.setTextColor(...MUTED);
  for (const [label, list] of [[L.naThemes, naThemes], [L.notThemes, notThemes]]) {
    if (!list.length) continue;
    const lines = doc.splitTextToSize(label + list.join(', ') + '.', CW); ensure(lines.length * 3.5 + 2);
    doc.text(lines, M, y); y += lines.length * 3.4 + 1.5;
  }
  doc.setTextColor(...INK);

  // Constats critiques (notes 0–2)
  const critical = [];
  for (const t of THEMES) for (const c of t.criteria) { const sc = insp.scores?.[c.ref]; if (typeof sc?.v === 'number' && sc.v <= 2) critical.push({ c, sc }); }
  if (R.sections.findings && critical.length) {
    y += 3;
    section(L.key, L.keySub);
    doc.autoTable({
      ...tableDefaults, startY: y,
      head: [L.critHead],
      body: critical.map(({ c, sc }) => [c.ref, cName(c), `${sc.v} / 5`, sc.c || '—']),
      columnStyles: { 0: { cellWidth: 12 }, 1: { cellWidth: 62 }, 2: { cellWidth: 16, halign: 'center', fontStyle: 'bold' } },
      didParseCell: d => { if (d.section === 'body' && d.column.index === 2) { d.cell.styles.fillColor = hex(SCORE_COLOR[critical[d.row.index].sc.v]); d.cell.styles.textColor = critical[d.row.index].sc.v === 2 ? 0 : 255; } },
    });
    y = doc.lastAutoTable.finalY + 4;
  }

  // photos (numérotées P1, P2… et citées dans les tableaux)
  const photos = [];
  for (const [ref, sc] of Object.entries(insp.scores || {})) for (const id of sc?.photos || []) photos.push({ id, ref, label: `${ref} ${(FR && CRIT_FR[ref]) || criterionOfRef(ref)?.name || ''}`, comment: sc.c || '' });
  acts.forEach((a, i) => (a.photos || []).forEach(id => photos.push({ id, ref: `A${i + 1}`, label: `${L.action} ${i + 1} — ${L.before} — ${aRef(a) || ''}`, comment: a.observation || '' })));
  acts.forEach((a, i) => (a.photosAfter || []).forEach(id => photos.push({ id, ref: `A${i + 1}+`, label: `${L.action} ${i + 1} — ${L.after}`, comment: a.corrective || '' })));
  const goods = (insp.goods || []).filter(g => g.text || (g.photos || []).length);
  goods.forEach((g, i) => (g.photos || []).forEach(id => photos.push({ id, ref: `G${i + 1}`, label: `${L.good} ${i + 1}${g.critRef ? ' — ' + g.critRef + ' ' + ((FR && CRIT_FR[g.critRef]) || criterionOfRef(g.critRef)?.name || '') : ''}`, comment: g.text || '' })));
  photos.forEach((p, i) => { p.n = 'P' + (i + 1); });

  // ============ BONNES PRATIQUES ============
  if (goods.length) {
    ensure(30);
    section(L.goods, L.goodsSub);
    doc.autoTable({
      ...tableDefaults, startY: y,
      head: [L.goodHead],
      headStyles: { ...(tableDefaults.headStyles || {}), fillColor: [46, 125, 50], textColor: 255 },
      body: goods.map((g, i) => [g.critRef || '—', g.critRef ? ((FR && CRIT_FR[g.critRef]) || criterionOfRef(g.critRef)?.name || '') : '—', g.text || '—', photos.filter(p => p.ref === `G${i + 1}`).map(p => p.n).join(', ')]),
      columnStyles: { 0: { cellWidth: 12 }, 1: { cellWidth: 52 }, 3: { cellWidth: 18, halign: 'center' } },
    });
    y = doc.lastAutoTable.finalY + 4;
  }
  // ============ SIGNATURE ============
  const drawSignature = async () => {
    const sg = insp.signature; if (!sg?.blobId) return;
    const b = await db.getBlob(sg.blobId); if (!b) return;
    ensure(48);
    section(L.signTitle);
    doc.setFontSize(8.5); doc.setTextColor(...MUTED); doc.text(doc.splitTextToSize(L.signNote, CW), M, y); y += 6;
    const url = await blobToDataURL(b), sz = await imgSize(url), h = 24, w = Math.min(70, h * sz.w / sz.h);
    doc.setDrawColor(...LINE); doc.roundedRect(M, y, w + 6, h + 6, 2, 2);
    doc.addImage(url, 'JPEG', M + 3, y + 3, w, h);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
    doc.text(L.signText(sg.name, sg.role, dateFR((sg.date || '').slice(0, 10))), M + w + 12, y + h / 2 + 4);
    doc.setFont('helvetica', 'normal');
    y += h + 12;
  };

  if (R.sections.actions) {
  // ============ ACTIONS CORRECTIVES ============
  newPage(L.actions);
  doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text(doc.splitTextToSize(acts.length
    ? L.actIntro(acts.length)
    : L.noAct, CW), M, y);
  y += 10;
  if (acts.length) {
    doc.autoTable({
      ...tableDefaults, startY: y,
      head: [L.actHead],
      body: acts.map((a, i) => [String(i + 1), [a.observation, aRef(a) ? L.ref + ' ' + aRef(a) : ''].filter(Boolean).join('\n') || '—', a.corrective || L.toDefine, L.prio[a.priority] || a.priority || '', a.responsibility || '', dateFR(a.dueDate), (L.status[a.status || 'Open'] || a.status) + (photos.some(p => p.ref === `A${i + 1}+`) ? `\n${L.photoAfter}: ${photos.filter(p => p.ref === `A${i + 1}+`).map(p => p.n).join(', ')}` : '')]),
      styles: { ...tableDefaults.styles, fontSize: 8 },
      columnStyles: { 0: { cellWidth: 8, halign: 'center', fontStyle: 'bold' }, 1: { cellWidth: 46 }, 2: { cellWidth: 42 }, 3: { cellWidth: 16, fontStyle: 'bold', halign: 'center' }, 4: { cellWidth: 23 }, 5: { cellWidth: 20 } },
      didParseCell: d => {
        if (d.section !== 'body') return;
        if (d.column.index === 3) { d.cell.styles.fillColor = hex(PRIO_COLOR[acts[d.row.index].priority] || '#9E9E9E'); d.cell.styles.textColor = 255; }
        if (d.column.index === 5 && acts[d.row.index].status !== 'Closed' && acts[d.row.index].dueDate && acts[d.row.index].dueDate < new Date().toLocaleDateString('sv-SE')) { d.cell.styles.textColor = hex('#C62828'); d.cell.styles.fontStyle = 'bold'; }
      },
    });
    y = doc.lastAutoTable.finalY + 6;
  }
  await drawSignature();
  } else await drawSignature();

  // ============ LOCALISATION ============
  const subColor = sub.color || '#0B2D5B';
  const hasArea = insp.area?.pts?.length > 2;
  const zoneColor = single ? subColor : '#1A56A8';
  const actPins = acts.map((a, i) => a.pin && a.planId === insp.planId ? { ...a.pin, color: '#C62828', label: String(i + 1) } : null).filter(Boolean);
  // zone tracée : on dessine la zone (contour + nom) au lieu d'une épingle, pour ne pas masquer les actions
  const pins = [...(insp.pin && !hasArea ? [{ ...insp.pin, color: subColor, label: pinLabel }] : []), ...actPins];
  if (R.sections.plan && plan?.blobId && (pins.length || hasArea)) {
    newPage(L.plan);
    const url = await db.blobURL(plan.blobId);
    const areas = hasArea ? [{ pts: insp.area.pts, color: zoneColor, label: insp.zone || insp.area.name || '' }] : [];
    const full = await renderPlanSnapshot(url, pins, { maxW: 2200, areas });
    const fs = await imgSize(full);
    let ih = Math.min(120, CW * fs.h / fs.w), iw = ih * fs.w / fs.h;
    doc.addImage(full, 'JPEG', M + (CW - iw) / 2, y, iw, ih); y += ih + 5;
    doc.setFontSize(8.5); doc.setTextColor(...MUTED);
    doc.text(hasArea ? L.planLegendArea(insp.zone, actPins.length) : L.planLegend(pinLabel, insp.zone, actPins.length), M, y); y += 7;
    // zoom : cadré serré sur la zone (ou l'épingle) et les actions, format 3:2
    const pts = [...(hasArea ? insp.area.pts : insp.pin ? [insp.pin] : []), ...actPins];
    if (pts.length) {
      const fw = fs.w, fh = fs.h, R2 = 1.5;
      let x0 = Math.min(...pts.map(p => p.x)) * fw, x1 = Math.max(...pts.map(p => p.x)) * fw, y0 = Math.min(...pts.map(p => p.y)) * fh, y1 = Math.max(...pts.map(p => p.y)) * fh;
      const pad = Math.max(x1 - x0, y1 - y0) * 0.22 + fw * 0.03;
      x0 -= pad; x1 += pad; y0 -= pad * 1.6; y1 += pad; // un peu plus en haut : les épingles dépassent au-dessus du point
      let w = x1 - x0, h = y1 - y0;
      if (w / h < R2) w = h * R2; else h = w / R2;
      if (w < fw * 0.2) { w = fw * 0.2; h = w / R2; }
      if (w > fw) { w = fw; h = w / R2; }
      if (h > fh) { h = fh; w = Math.min(fw, h * R2); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const cx0 = Math.max(0, Math.min(fw - w, cx - w / 2)), cy0 = Math.max(0, Math.min(fh - h, cy - h / 2));
      if (w < fw * 0.8) {
        const crop = { x0: cx0 / fw, y0: cy0 / fh, x1: (cx0 + w) / fw, y1: (cy0 + h) / fh };
        const zoom = await renderPlanSnapshot(url, pins, { maxW: 1800, crop, areas });
        ensure(110);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK); doc.text(L.closeUp, M, y); y += 3;
        const zw = Math.min(CW, 150), zh = zw / R2;
        doc.addImage(zoom, 'JPEG', M + (CW - zw) / 2, y, zw, zh);
        doc.setDrawColor(...LINE); doc.setLineWidth(0.3); doc.rect(M + (CW - zw) / 2, y, zw, zh); y += zh + 4;
      }
    }
  }


  if (R.sections.details) {
  newPage(L.details);
  doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text(doc.splitTextToSize(L.detailsIntro, CW), M, y); y += 6;
  const body = [], meta = [];
  for (const t of THEMES) {
    const ts = themeScore(t, insp.scores);
    const rows = t.criteria.filter(c => insp.scores?.[c.ref]?.v !== undefined && insp.scores?.[c.ref]?.v !== null);
    if (!rows.length) continue;
    body.push([{ content: `${t.ref.replace('.0', '')}. ${tName(t)}`, colSpan: 2 }, { content: ts.pct === null ? 'N/A' : pct(ts.pct) }, { content: '' }]); meta.push({ theme: true });
    for (const c of rows) {
      const sc = insp.scores[c.ref];
      const ph = photos.filter(p => p.ref === c.ref).map(p => p.n);
      body.push([c.ref, cName(c), typeof sc.v === 'number' ? `${sc.v} / 5` : 'N/A', (sc.c || '') + (ph.length ? `${sc.c ? '\n' : ''}${L.photo} ${ph.join(', ')}` : '')]);
      meta.push({ v: sc.v });
    }
  }
  if (body.length) {
    doc.autoTable({
      ...tableDefaults, startY: y, head: [L.critHead], body,
      columnStyles: { 0: { cellWidth: 12 }, 1: { cellWidth: 66 }, 2: { cellWidth: 17, halign: 'center', fontStyle: 'bold' } },
      didParseCell: d => {
        if (d.section !== 'body') return;
        const m = meta[d.row.index];
        if (m.theme) { d.cell.styles.fillColor = [226, 233, 243]; d.cell.styles.fontStyle = 'bold'; d.cell.styles.textColor = BRAND; if (d.column.index === 2) d.cell.styles.halign = 'center'; return; }
        if (d.column.index === 2) {
          if (typeof m.v === 'number') { d.cell.styles.fillColor = hex(SCORE_COLOR[m.v]); d.cell.styles.textColor = m.v === 2 || m.v === 3 ? 0 : 255; }
          else d.cell.styles.textColor = MUTED;
        }
      },
    });
    y = doc.lastAutoTable.finalY + 6;
  } else { doc.text(L.noCrit, M, y); y += 8; }

  }

  // ============ PHOTOS ============
  if (R.sections.photos && photos.length) {
    newPage(L.photos);
    const cw = (CW - 6) / 2, ch = 62;
    let col = 0;
    for (const p of photos) {
      const blob = await db.getBlob(p.id); if (!blob) continue;
      const url = await blobToDataURL(blob); const s = await imgSize(url);
      const capLines = doc.splitTextToSize(`${p.n} — ${p.label}${p.comment ? ': ' + p.comment : ''}`, cw);
      const need = ch + 4 + Math.min(capLines.length, 3) * 3.6 + 4;
      if (col === 0) ensure(need);
      const px = M + col * (cw + 6);
      const k = Math.min(cw / s.w, ch / s.h);
      doc.setFillColor(...SOFT); doc.rect(px, y, cw, ch, 'F');
      doc.addImage(url, 'JPEG', px + (cw - s.w * k) / 2, y + (ch - s.h * k) / 2, s.w * k, s.h * k);
      doc.setFontSize(8); doc.setTextColor(...INK); doc.text(capLines.slice(0, 3), px, y + ch + 4);
      if (col === 1) { y += need; col = 0; } else col = 1;
    }
    if (col === 1) y += ch + 16;
  }

  if (R.sections.guide) {
  // ============ GUIDE DE LECTURE ============
  newPage(L.guide);
  doc.autoTable({ ...tableDefaults, startY: y, head: [L.scaleHead], body: SCALE.map(s => [String(s.v), FR ? s.fr : s.en]).concat([['N/A', L.naMeaning]]),
    columnStyles: { 0: { cellWidth: 16, halign: 'center', fontStyle: 'bold' } },
    didParseCell: d => { if (d.section === 'body' && d.column.index === 0 && d.row.index < 6) { d.cell.styles.fillColor = hex(SCORE_COLOR[d.row.index]); d.cell.styles.textColor = d.row.index === 2 || d.row.index === 3 ? 0 : 255; } } });
  y = doc.lastAutoTable.finalY + 6;
  doc.autoTable({ ...tableDefaults, startY: y, head: [L.ratingHead], body: RATINGS.map(r => [rName(r), FR ? RANGE_FR[r.name] : r.range, L.meaning[r.name]]),
    columnStyles: { 0: { cellWidth: 28, fontStyle: 'bold' }, 1: { cellWidth: 28 } },
    didParseCell: d => { if (d.section === 'body' && d.column.index === 0) { const r = RATINGS[d.row.index]; d.cell.styles.fillColor = hex(r.color); d.cell.styles.textColor = r.fg === '#fff' ? 255 : 0; } } });
  y = doc.lastAutoTable.finalY + 8;
  section(L.method);
  doc.setFontSize(9); doc.setTextColor(...INK);
  const method = L.methodLines;
  method.forEach(m => { const l = doc.splitTextToSize('•  ' + m, CW); doc.text(l, M, y); y += l.length * 4.4 + 1.5; });

  }

  // pieds de page
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(M, H - 11, W - M, H - 11);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
    doc.text(`${insp.ref}  ·  ${L.footer}`, M, H - 7);
    doc.text(`${L.page} ${i} / ${pages}`, W - M, H - 7, { align: 'right' });
    if (i > 1 && logos.length) { let lx = W - M - 22; for (const lg of [...logos].reverse()) { const lh = 6, lw = Math.min(20, lh * lg.r), h2 = lw / lg.r; lx -= lw; doc.addImage(lg.u, 'JPEG', lx, H - 9.6 + (lh - h2) / 2 - 1.2, lw, h2); lx -= 3; } }
  }
  return doc.output('blob');
}

// ---------------- Partage ----------------
export function canShareFile(file) {
  try { return !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch { return false; }
}
export async function shareFile(file) {
  if (canShareFile(file)) {
    try { await navigator.share({ files: [file], title: file.name }); return true; }
    catch (e) { if (e.name === 'AbortError') return true; }
  }
  download(file, file.name);
  return false;
}
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
