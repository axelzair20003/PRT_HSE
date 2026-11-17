// Exports Excel (4 feuilles identiques au fichier d'origine), PDF, partage iOS.
import { THEMES } from './prt-data.js';
import { SCALE, RATINGS, NA, overallScore, themeScore, rating, criterionOfRef } from './calc.js';
import { renderPlanSnapshot } from './plan.js';
import * as db from './db.js';

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
export async function buildXLSX(inspections, opts = {}) {
  const XLSX = window.XLSX;
  const ctx = await loadContext(inspections, opts);
  const multi = inspections.length > 1;
  const pctCells = { scoring: [], summary: [] };

  // Feuille 1 : HSE Scoring Sheet
  const S = [];
  for (const insp of inspections) {
    const base = S.length;
    S.push(['PRT - Site HSE Performance Rating Tool']);
    S.push(['Sub-Contractor', ctx.subs[insp.subId]?.name || '', 'Inspection Date', dateFR(insp.date), 'Inspector(s)', insp.inspectors || '']);
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
    E.push([multi ? (ctx.subs[insp.subId]?.name || '') : '']);
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
const RATING_MEANING = {
  Excellent: 'Full or above compliance, industry best practices in place.',
  Good: 'Compliant with site HSE requirements; some improvements possible.',
  Satisfactory: 'Partial compliance; occasional non-conformities without significant risk.',
  Weak: 'Low compliance; personnel and/or environment at risk.',
  Unacceptable: 'Very low compliance; serious injury or major environmental risk.',
  'N/A': 'No criteria assessed yet.',
};
const pct = p => p === null || p === undefined ? 'N/A' : (Math.round(p * 1000) / 10) + ' %';
const abbr3 = n => (n || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();

export async function buildPDF(insp) {
  const { jsPDF } = window.jspdf;
  const ctx = await loadContext([insp]);
  const sub = ctx.subs[insp.subId] || {};
  const plan = ctx.plans[insp.planId];
  const o = overallScore(insp.scores, insp.bonus, insp.penalty);
  const acts = ctx.actions;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, H = 297, M = 14, CW = W - 2 * M;
  let y = 0;

  const header = title => {
    doc.setFillColor(...BRAND); doc.rect(0, 0, W, 14, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5);
    doc.text(title, M, 9.2);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
    doc.text(`${sub.name || ''}  ·  ${dateFR(insp.date)}`, W - M, 9.2, { align: 'right' });
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
  let currentTitle = 'HSE Performance Rating — Sub-contractor Audit';
  const newPage = t => { currentTitle = t; doc.addPage(); header(t); };
  const tableDefaults = { theme: 'grid', margin: { left: M, right: M, top: 22 }, styles: { fontSize: 8.5, cellPadding: 2, textColor: INK, lineColor: LINE, lineWidth: 0.2 }, headStyles: { fillColor: BRAND, textColor: 255, fontStyle: 'bold' }, didDrawPage: () => header(currentTitle) };

  // ============ PAGE 1 : SYNTHÈSE ============
  header(currentTitle);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text('SUB-CONTRACTOR', M, y);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(24); doc.setTextColor(...INK);
  doc.text(sub.name || '—', M, y + 10);
  if (sub.color) { doc.setFillColor(...hex(sub.color)); doc.rect(M - 4, y - 3.5, 1.6, 15, 'F'); }
  y += 16;
  const info = [['Inspection date', dateFR(insp.date)], ['Project / Site', insp.site || '—'], ['Location', [plan?.name, insp.zone].filter(Boolean).join(' — ') || '—'], ['Inspector(s)', insp.inspectors || '—'], ['Reference', insp.ref]];
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
  doc.setTextColor(fg); doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text('OVERALL SITE SCORE', M + 5, y + 7);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(26); doc.text(pct(o.pct), M + 5, y + 21);
  doc.setFontSize(13); doc.text(rc.name, M + 5, y + 31);
  const sx = M + 70, sw = CW - 70;
  doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.text(`Rating: ${rc.name}`, sx, y + 6);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text(doc.splitTextToSize(RATING_MEANING[rc.name] || '', sw), sx, y + 11.5);
  const segs = [...RATINGS].reverse().map((r, i, arr) => ({ r, from: Math.max(0, r.min === -Infinity ? 0 : r.min), to: i < arr.length - 1 ? arr[i + 1].min : 1 }));
  const by = y + 22;
  segs.forEach(({ r, from, to }) => {
    doc.setFillColor(...hex(r.color)); doc.rect(sx + from * sw, by, (to - from) * sw, 5, 'F');
    doc.setFontSize(6.5); doc.setTextColor(...MUTED); doc.text(r.name, sx + (from + to) / 2 * sw, by + 9, { align: 'center' });
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
  const kpis = [[`${assessed.length} / 19`, 'themes assessed'], [String(critCount), 'criteria scored'], [String(acts.length), `corrective action${acts.length > 1 ? 's' : ''}${high ? ` (${high} high)` : ''}`], [`+${Number(insp.bonus) || 0} / -${Number(insp.penalty) || 0}`, 'BE SAFE bonus / LSR penalty']];
  const kw = (CW - 9) / 4;
  kpis.forEach(([v, l], i) => {
    const kx = M + i * (kw + 3);
    doc.setFillColor(...SOFT); doc.setDrawColor(...LINE); doc.roundedRect(kx, y, kw, 17, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...INK); doc.text(v, kx + kw / 2, y + 8, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED); doc.text(doc.splitTextToSize(l, kw - 4), kx + kw / 2, y + 12.5, { align: 'center' });
  });
  y += 24;

  // Résultats par thème (barres)
  section('Results by theme', 'Score = points obtained / maximum possible (N/A excluded)');
  doc.autoTable({
    ...tableDefaults, startY: y,
    head: [['Theme', 'Score', '%', 'Rating']],
    body: assessed.map(t => [`${t.theme.ref.replace('.0', '')}. ${t.theme.name}`, '', pct(t.pct), rating(t.pct).name]),
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
  const naThemes = o.themes.filter(t => t.pct === null && t.na === t.total).map(t => t.theme.ref.replace('.0', '') + '. ' + t.theme.name);
  const notThemes = o.themes.filter(t => t.pct === null && t.na !== t.total).map(t => t.theme.ref.replace('.0', '') + '. ' + t.theme.name);
  doc.setFontSize(7.5); doc.setTextColor(...MUTED);
  for (const [label, list] of [['Not applicable on this site: ', naThemes], ['Not assessed during this inspection: ', notThemes]]) {
    if (!list.length) continue;
    const lines = doc.splitTextToSize(label + list.join(', ') + '.', CW); ensure(lines.length * 3.5 + 2);
    doc.text(lines, M, y); y += lines.length * 3.4 + 1.5;
  }
  doc.setTextColor(...INK);

  // Constats critiques (notes 0–2)
  const critical = [];
  for (const t of THEMES) for (const c of t.criteria) { const sc = insp.scores?.[c.ref]; if (typeof sc?.v === 'number' && sc.v <= 2) critical.push({ c, sc }); }
  if (critical.length) {
    y += 3;
    section('Key findings requiring attention', 'Criteria scored 0, 1 or 2');
    doc.autoTable({
      ...tableDefaults, startY: y,
      head: [['Ref.', 'Audited element', 'Score', 'Evidence / Comments']],
      body: critical.map(({ c, sc }) => [c.ref, c.name, `${sc.v} / 5`, sc.c || '—']),
      columnStyles: { 0: { cellWidth: 12 }, 1: { cellWidth: 62 }, 2: { cellWidth: 16, halign: 'center', fontStyle: 'bold' } },
      didParseCell: d => { if (d.section === 'body' && d.column.index === 2) { d.cell.styles.fillColor = hex(SCORE_COLOR[critical[d.row.index].sc.v]); d.cell.styles.textColor = critical[d.row.index].sc.v === 2 ? 0 : 255; } },
    });
    y = doc.lastAutoTable.finalY + 4;
  }

  // ============ ACTIONS CORRECTIVES ============
  newPage('Corrective Actions');
  doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text(doc.splitTextToSize(acts.length
    ? `${acts.length} corrective action${acts.length > 1 ? 's' : ''} raised during this inspection. The sub-contractor is responsible for implementing them before the due date and informing the HSE department.`
    : 'No corrective action was raised during this inspection.', CW), M, y);
  y += 10;
  if (acts.length) {
    doc.autoTable({
      ...tableDefaults, startY: y,
      head: [['#', 'Observation', 'Corrective action required', 'Priority', 'Responsible', 'Due date', 'Status']],
      body: acts.map((a, i) => [String(i + 1), `${a.observation || '—'}\n${actionRef(a) ? 'Ref. ' + actionRef(a) : ''}`, a.corrective || 'To be defined', a.priority || '', a.responsibility || '', dateFR(a.dueDate), a.status || 'Open']),
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

  // ============ LOCALISATION ============
  const subColor = sub.color || '#0B2D5B';
  const pins = [...(insp.pin ? [{ ...insp.pin, color: subColor, label: abbr3(sub.name) }] : []),
    ...acts.map((a, i) => a.pin && a.planId === insp.planId ? { ...a.pin, color: '#C62828', label: String(i + 1) } : null).filter(Boolean)];
  if (plan?.blobId && pins.length) {
    newPage('Location on Site Plan');
    const url = await db.blobURL(plan.blobId);
    const full = await renderPlanSnapshot(url, pins, { maxW: 2200 });
    const fs = await imgSize(full);
    let ih = Math.min(120, CW * fs.h / fs.w), iw = ih * fs.w / fs.h;
    doc.addImage(full, 'JPEG', M + (CW - iw) / 2, y, iw, ih); y += ih + 5;
    doc.setFontSize(8.5); doc.setTextColor(...MUTED);
    doc.text(`${abbr3(sub.name)} = inspected zone${insp.zone ? ' (' + insp.zone + ')' : ''}${acts.some(a => a.pin) ? '   ·   red numbers = corrective actions (see table)' : ''}`, M, y); y += 7;
    if (insp.pin) {
      const zoom = await renderPlanSnapshot(url, pins, { maxW: 1400, crop: { x: insp.pin.x, y: insp.pin.y, size: 0.3 } });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK); doc.text('Close-up of the inspected zone', M, y); y += 3;
      doc.addImage(zoom, 'JPEG', M, y, 100, 100);
    }
  }

  // ============ DÉTAIL DES CONSTATS ============
  const photos = [];
  for (const [ref, sc] of Object.entries(insp.scores || {})) for (const id of sc?.photos || []) photos.push({ id, ref, label: `${ref} ${criterionOfRef(ref)?.name || ''}`, comment: sc.c || '' });
  acts.forEach((a, i) => (a.photos || []).forEach(id => photos.push({ id, ref: `A${i + 1}`, label: `Action ${i + 1} — ${actionRef(a) || ''}`, comment: a.observation || '' })));
  photos.forEach((p, i) => { p.n = 'P' + (i + 1); });

  newPage('Detailed Findings');
  doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text('Only the criteria assessed during this inspection are listed. Score 0–5 per criterion (see scoring guide at the end).', M, y); y += 6;
  const body = [], meta = [];
  for (const t of THEMES) {
    const ts = themeScore(t, insp.scores);
    const rows = t.criteria.filter(c => insp.scores?.[c.ref]?.v !== undefined && insp.scores?.[c.ref]?.v !== null);
    if (!rows.length) continue;
    body.push([{ content: `${t.ref.replace('.0', '')}. ${t.name}`, colSpan: 2 }, { content: ts.pct === null ? 'N/A' : pct(ts.pct) }, { content: '' }]); meta.push({ theme: true });
    for (const c of rows) {
      const sc = insp.scores[c.ref];
      const ph = photos.filter(p => p.ref === c.ref).map(p => p.n);
      body.push([c.ref, c.name, typeof sc.v === 'number' ? `${sc.v} / 5` : 'N/A', (sc.c || '') + (ph.length ? `${sc.c ? '\n' : ''}Photo ${ph.join(', ')}` : '')]);
      meta.push({ v: sc.v });
    }
  }
  if (body.length) {
    doc.autoTable({
      ...tableDefaults, startY: y, head: [['Ref.', 'Audited element', 'Score', 'Evidence / Comments']], body,
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
  } else { doc.text('No criteria assessed.', M, y); y += 8; }

  // ============ PHOTOS ============
  if (photos.length) {
    newPage('Photo Evidence');
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

  // ============ GUIDE DE LECTURE ============
  newPage('How to Read this Report');
  doc.autoTable({ ...tableDefaults, startY: y, head: [['Score', 'Meaning (per criterion)']], body: SCALE.map(s => [String(s.v), s.en]).concat([['N/A', 'Not applicable — excluded from both the total and the maximum']]),
    columnStyles: { 0: { cellWidth: 16, halign: 'center', fontStyle: 'bold' } },
    didParseCell: d => { if (d.section === 'body' && d.column.index === 0 && d.row.index < 6) { d.cell.styles.fillColor = hex(SCORE_COLOR[d.row.index]); d.cell.styles.textColor = d.row.index === 2 || d.row.index === 3 ? 0 : 255; } } });
  y = doc.lastAutoTable.finalY + 6;
  doc.autoTable({ ...tableDefaults, startY: y, head: [['Rating', 'Overall score', 'Meaning']], body: RATINGS.map(r => [r.name, r.range, RATING_MEANING[r.name]]),
    columnStyles: { 0: { cellWidth: 28, fontStyle: 'bold' }, 1: { cellWidth: 28 } },
    didParseCell: d => { if (d.section === 'body' && d.column.index === 0) { const r = RATINGS[d.row.index]; d.cell.styles.fillColor = hex(r.color); d.cell.styles.textColor = r.fg === '#fff' ? 255 : 0; } } });
  y = doc.lastAutoTable.finalY + 8;
  section('Calculation method');
  doc.setFontSize(9); doc.setTextColor(...INK);
  const method = [
    'Theme score = sum of the scores obtained / (number of criteria scored x 5). Criteria marked N/A are excluded.',
    'Themes that are entirely N/A or not assessed are excluded from the overall average.',
    'Overall Site Score = average of the assessed themes + BE SAFE bonus points / 100 - LSR penalty points / 100, limited between 0 % and 100 %.',
  ];
  method.forEach(m => { const l = doc.splitTextToSize('•  ' + m, CW); doc.text(l, M, y); y += l.length * 4.4 + 1.5; });

  // pieds de page
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(M, H - 11, W - M, H - 11);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
    doc.text(`${insp.ref}  ·  PRT – Site HSE Performance Rating Tool`, M, H - 7);
    doc.text(`Page ${i} / ${pages}`, W - M, H - 7, { align: 'right' });
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
