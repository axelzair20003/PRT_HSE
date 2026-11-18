// Export Excel fidèle au fichier PRT d'origine (assets/prt-template.xlsx) :
// on ouvre le modèle, on remplit les cellules, la mise en forme, les formules et les listes déroulantes restent celles du modèle.
// Les résultats des formules sont aussi écrits, pour que l'aperçu (iPhone, Teams…) affiche les bons chiffres sans recalcul.

const SHEETS = { scoring: 'HSE Scoring Sheet', summary: 'Executive Summary', actions: 'Action Report' };
const RATING = p => p === null || p === '' ? 'N/A' : p >= 0.9 ? 'Excellent' : p >= 0.8 ? 'Good' : p >= 0.7 ? 'Satisfactory' : p >= 0.5 ? 'Weak' : 'Unacceptable';
const PROGRESS = { Open: 'Open', 'In progress': 'In Progress', 'In Progress': 'In Progress', Closed: 'Closed' };

/**
 * @param ExcelJS  la bibliothèque ExcelJS
 * @param template ArrayBuffer du modèle
 * @param d { subject, site, date (Date|string), inspectors, ref, bonus, penalty, themes:[{ref, criteria:[{ref, v, c}]}], actions:[{observation, priority, corrective, responsibility, dueDate, status, reference}] }
 * @returns ArrayBuffer du classeur rempli
 */
export async function fillPRTTemplate(ExcelJS, template, d) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(template);
  const S = wb.getWorksheet(SHEETS.scoring), E = wb.getWorksheet(SHEETS.summary), A = wb.getWorksheet(SHEETS.actions);

  // ---------- HSE Scoring Sheet ----------
  // libellés « Sub-Contractor » / « Inspection Date » lisibles en entier
  S.getColumn('A').width = Math.max(S.getColumn('A').width || 0, 15);
  S.getColumn('C').width = Math.max(S.getColumn('C').width || 0, 15);
  S.getColumn('E').width = Math.max(S.getColumn('E').width || 0, 13);
  S.getCell('B2').value = d.subject || '';
  S.getCell('D2').value = d.date || '';
  S.getCell('F2').value = d.inspectors || '';
  const rowOf = {};
  S.eachRow((row, n) => { const ref = String(row.getCell(1).value ?? '').trim(); if (/^\d+\.\d+$/.test(ref)) rowOf[ref] = n; });
  const themePct = {};
  for (const t of d.themes) {
    const tr = rowOf[t.ref]; if (!tr) continue;
    let sum = 0, cnt = 0;
    for (const c of t.criteria) {
      const r = rowOf[c.ref]; if (!r) continue;
      const num = typeof c.v === 'number';
      S.getCell(`C${r}`).value = num ? c.v : c.v === 'NA' || c.v === 'N/A' ? 'N/A' : null;
      S.getCell(`F${r}`).value = c.c || null;
      S.getCell(`E${r}`).value = { formula: `IF(ISNUMBER(C${r}),C${r}/D${r},"")`, result: num ? c.v / 5 : '' };
      if (num) { sum += c.v; cnt++; }
    }
    const first = tr + 1, last = tr + t.criteria.length;
    const pct = cnt ? sum / (cnt * 5) : null;
    themePct[t.ref] = pct;
    // thème sans note : cellules vides (et non 0 en rouge), et exclu de la moyenne — comme dans l'app
    const none = `COUNT(C${first}:C${last})=0`;
    S.getCell(`C${tr}`).value = { formula: `IF(${none},"",SUM(C${first}:C${last}))`, result: cnt ? sum : '' };
    S.getCell(`D${tr}`).value = { formula: `IF(${none},"",COUNT(C${first}:C${last})*5)`, result: cnt ? cnt * 5 : '' };
    S.getCell(`E${tr}`).value = { formula: `IF(${none},"",C${tr}/D${tr})`, result: pct === null ? '' : pct };
  }

  // ---------- Executive Summary ----------
  E.getCell('B3').value = d.site || '';
  E.getCell('B4').value = d.date || '';
  E.getCell('B5').value = d.inspectors || '';
  E.getCell('B6').value = d.ref || '';
  E.getCell('B7').value = Number(d.bonus) || 0;
  E.getCell('B8').value = Number(d.penalty) || 0;
  E.eachRow((row, n) => {
    const f = row.getCell(2).formula || row.getCell(2).value?.formula;
    const m = typeof f === 'string' && f.match(/^'HSE Scoring Sheet'!E(\d+)$/);
    if (!m) return;
    const ref = String(S.getCell(`A${m[1]}`).value ?? '').trim();
    const pct = themePct[ref] ?? null;
    row.getCell(2).value = { formula: f, result: pct === null ? '' : pct };
    row.getCell(3).value = { formula: `IF(B${n}="","N/A",IF(B${n}>=0.9,"Excellent",IF(B${n}>=0.8,"Good",IF(B${n}>=0.7,"Satisfactory",IF(B${n}>=0.5,"Weak","Unacceptable")))))`, result: RATING(pct) };
  });
  const vals = Object.values(themePct).filter(p => p !== null);
  const overall = vals.length ? Math.min(1, Math.max(0, vals.reduce((a, b) => a + b, 0) / vals.length + (Number(d.bonus) || 0) / 100 - (Number(d.penalty) || 0) / 100)) : 0;
  E.eachRow((row, n) => {
    if (String(row.getCell(1).value ?? '').trim() !== 'Overall Site Score') return;
    const f = row.getCell(2).formula || row.getCell(2).value?.formula;
    // même règle que l'app : limité entre 0 % et 100 %
    row.getCell(2).value = { formula: `IFERROR(MAX(0,MIN(1,${String(f).replace(/^IFERROR\((.*),0\)$/, '$1')})),0)`, result: overall };
    row.getCell(3).value = { formula: `IF(B${n}>=0.9,"Excellent",IF(B${n}>=0.8,"Good",IF(B${n}>=0.7,"Satisfactory",IF(B${n}>=0.5,"Weak","Unacceptable"))))`, result: RATING(overall) };
  });

  // ---------- Action Report ----------
  const FIRST = 4;
  let lastTpl = FIRST; A.eachRow((row, n) => { if (n >= FIRST && typeof row.getCell(1).value === 'number') lastTpl = n; });
  d.actions.forEach((a, k) => {
    const r = FIRST + k;
    if (r > lastTpl) { // plus d'actions que de lignes prévues : on recopie le style de la dernière ligne
      const src = A.getRow(lastTpl), dst = A.getRow(r);
      src.eachCell({ includeEmpty: true }, (c, col) => { dst.getCell(col).style = { ...c.style }; });
      dst.height = src.height; A.getCell(`A${r}`).value = k + 1;
    }
    A.getCell(`B${r}`).value = a.observation || '';
    A.getCell(`C${r}`).value = a.priority || '';
    A.getCell(`D${r}`).value = a.corrective || '';
    A.getCell(`E${r}`).value = a.responsibility || '';
    A.getCell(`F${r}`).value = a.dueDate || '';
    A.getCell(`G${r}`).value = PROGRESS[a.status] || a.status || '';
    A.getCell(`H${r}`).value = a.reference || '';
  });

  // listes déroulantes du modèle, réécrites proprement (ExcelJS les dédouble sinon, ce qui ferait « réparer » le fichier par Excel)
  const lists = (ws, rules) => { ws.dataValidations.model = {}; rules.forEach(([range, items]) => ws.dataValidations.add(range, { type: 'list', allowBlank: true, showErrorMessage: true, formulae: [`"${items}"`] })); };
  lists(S, [['C5:C147', '0,1,2,3,4,5,N/A']]);
  const lastAct = Math.max(lastTpl, FIRST + d.actions.length - 1);
  lists(A, [[`C4:C${lastAct}`, 'High,Medium,Low'], [`G4:G${lastAct}`, 'Open,In Progress,Closed']]);

  wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };
  return wb.xlsx.writeBuffer();
}
