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
const blobToDataURL = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
const imgSize = url => new Promise(res => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res({ w: 1, h: 1 }); i.src = url; });
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BRAND = [11, 45, 91];

export async function buildPDF(insp) {
  const { jsPDF } = window.jspdf;
  const ctx = await loadContext([insp]);
  const sub = ctx.subs[insp.subId] || {};
  const plan = ctx.plans[insp.planId];
  const o = overallScore(insp.scores, insp.bonus, insp.penalty);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 12;

  const header = (title) => {
    doc.setFillColor(...BRAND); doc.rect(0, 0, W, 18, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    doc.text(title, M, 11.5); doc.setFontSize(9); doc.text(insp.ref, W - M, 11.5, { align: 'right' });
    doc.setTextColor(0);
  };
  header('PRT - Site HSE Performance Rating Tool');

  doc.autoTable({
    startY: 24, theme: 'grid', styles: { fontSize: 10 }, columnStyles: { 0: { fontStyle: 'bold', cellWidth: 55, fillColor: [238, 241, 245] } },
    body: [
      ['Project / Site', insp.site || ''], ['Sub-Contractor', sub.name || ''],
      ['Inspection Date', dateFR(insp.date)], ['Inspector(s)', insp.inspectors || ''], ['Inspection Reference', insp.ref],
      ['Location', `${plan?.name || ''}${insp.zone ? ' — ' + insp.zone : ''}`],
      ['BE SAFE Bonus Points', String(Number(insp.bonus) || 0)], ['LSR Penalty Points', String(Number(insp.penalty) || 0)],
    ],
  });
  let y = doc.lastAutoTable.finalY + 6;
  const rc = o.rating;
  doc.setFillColor(...hex(rc.color)); doc.roundedRect(M, y, W - 2 * M, 22, 3, 3, 'F');
  doc.setTextColor(rc.fg === '#fff' ? 255 : 0); doc.setFontSize(12); doc.text('Overall Site Score', M + 6, y + 9);
  doc.setFontSize(22); doc.text(o.pct === null ? 'N/A' : Math.round(o.pct * 1000) / 10 + ' %', M + 6, y + 18);
  doc.setFontSize(18); doc.text(rc.name, W - M - 6, y + 14, { align: 'right' }); doc.setTextColor(0);
  y += 28;

  doc.autoTable({
    startY: y, head: [['Theme', 'Score %', 'Rating']], theme: 'grid', headStyles: { fillColor: BRAND }, styles: { fontSize: 9 },
    columnStyles: { 1: { halign: 'right', cellWidth: 22 }, 2: { cellWidth: 32 } },
    body: o.themes.map(p => [`${p.theme.ref} ${p.theme.name}`, p.pct === null ? 'N/A' : Math.round(p.pct * 1000) / 10 + ' %', rating(p.pct).name]),
    didParseCell: d => { if (d.section === 'body' && d.column.index === 2) { const r = RATINGS.find(x => x.name === d.cell.raw) || { color: '#9E9E9E', fg: '#000' }; d.cell.styles.fillColor = hex(r.color); d.cell.styles.textColor = r.fg === '#fff' ? 255 : 0; d.cell.styles.fontStyle = 'bold'; } },
  });

  // Plan avec épingles
  if (plan?.blobId) {
    const url = await db.blobURL(plan.blobId);
    const pins = [{ ...insp.pin, color: sub.color, label: 'I' }, ...ctx.actions.filter(a => a.pin && a.planId === insp.planId).map((a, i) => ({ ...a.pin, color: sub.color, label: i + 1 }))].filter(p => p.x !== undefined);
    doc.addPage(); header('Location on site plan');
    const full = await renderPlanSnapshot(url, pins, { maxW: 2000 });
    const fs = await imgSize(full);
    const fw = W - 2 * M, fh = Math.min(150, fw * fs.h / fs.w);
    const fw2 = fh * fs.w / fs.h;
    doc.addImage(full, 'JPEG', M + (fw - fw2) / 2, 24, fw2, fh);
    if (insp.pin?.x !== undefined) {
      const zoom = await renderPlanSnapshot(url, pins, { maxW: 1400, crop: { x: insp.pin.x, y: insp.pin.y, size: 0.25 } });
      doc.setFontSize(10); doc.text('Zoom on inspected zone', M, 24 + fh + 8);
      doc.addImage(zoom, 'JPEG', M, 24 + fh + 11, 95, 95);
    }
  }

  // Détail des critères
  doc.addPage(); header('HSE Scoring Sheet');
  const body = [];
  for (const t of THEMES) {
    const ts = themeScore(t, insp.scores);
    body.push([{ content: `${t.ref} ${t.name}`, colSpan: 3, styles: { fontStyle: 'bold', fillColor: [220, 228, 240] } }, { content: ts.pct === null ? 'N/A' : Math.round(ts.pct * 100) + ' %', styles: { fontStyle: 'bold', fillColor: [220, 228, 240], halign: 'right' } }, { content: '', styles: { fillColor: [220, 228, 240] } }]);
    for (const c of t.criteria) {
      const sc = insp.scores?.[c.ref] || {};
      const v = typeof sc.v === 'number' ? String(sc.v) : sc.v === NA ? 'N/A' : '';
      body.push([c.ref, c.name, v, typeof sc.v === 'number' ? Math.round(sc.v / 5 * 100) + ' %' : '', sc.c || '']);
    }
  }
  doc.autoTable({ startY: 24, head: [['Ref.', 'Audited Element', 'Eval.', 'Score %', 'Evidence / Comments']], body, theme: 'grid', headStyles: { fillColor: BRAND }, styles: { fontSize: 8, cellPadding: 1.5 }, columnStyles: { 0: { cellWidth: 12 }, 1: { cellWidth: 62 }, 2: { cellWidth: 12, halign: 'center' }, 3: { cellWidth: 16, halign: 'right' } } });

  // Photos
  const photos = [];
  for (const [ref, sc] of Object.entries(insp.scores || {})) for (const id of sc.photos || []) photos.push({ ref: `${ref} ${criterionOfRef(ref)?.name || ''}`, id });
  for (const [i, a] of ctx.actions.entries()) for (const id of a.photos || []) photos.push({ ref: `Action ${i + 1} — ${actionRef(a)}`, id });
  if (photos.length) {
    doc.addPage(); header('Photos');
    let px = M, py = 24; const cw = (W - 2 * M - 6) / 2, ch = 70;
    for (const p of photos) {
      const b = await db.getBlob(p.id); if (!b) continue;
      const url = await blobToDataURL(b); const s = await imgSize(url);
      if (py + ch + 8 > 285) { doc.addPage(); header('Photos'); py = 24; px = M; }
      const k = Math.min(cw / s.w, ch / s.h);
      doc.addImage(url, 'JPEG', px, py, s.w * k, s.h * k);
      doc.setFontSize(8); doc.text(doc.splitTextToSize(p.ref, cw)[0], px, py + ch + 4);
      if (px === M) px = M + cw + 6; else { px = M; py += ch + 9; }
    }
  }

  // Action Report
  doc.addPage(); header('HSE Site Performance - Action Report');
  doc.autoTable({
    startY: 24, theme: 'grid', headStyles: { fillColor: BRAND }, styles: { fontSize: 8, cellPadding: 1.5 },
    head: [['No.', 'Observation', 'Priority', 'Corrective Action Required', 'Responsibility', 'Due Date', 'Progress', 'Reference']],
    body: ctx.actions.length ? ctx.actions.map((a, i) => [i + 1, a.observation || '', a.priority || '', a.corrective || '', a.responsibility || '', dateFR(a.dueDate), a.status || 'Open', actionRef(a)]) : [[{ content: 'No action', colSpan: 8 }]],
  });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120); doc.text(`${insp.ref} — ${i}/${pages}`, W - M, 292, { align: 'right' }); }
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
