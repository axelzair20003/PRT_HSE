import { ic } from './icons.js';
// Visionneuse de plan : zoom au pincement, déplacement au doigt, tap pour poser une épingle.
// Coordonnées des épingles normalisées (0–1) par rapport à l'image du plan.

const clamp01 = v => Math.min(1, Math.max(0, v));
export const centroid = pts => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length });
export const bbox = pts => { const xs = pts.map(p => p.x), ys = pts.map(p => p.y); const x = Math.min(...xs), y = Math.min(...ys); return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }; };
const polyArea = pts => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p.x * q.y - q.x * p.y; }, 0) / 2);
export function inside(pts, x, y) {
  let r = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
}

export function createPlanViewer(container, opts) {
  const { imageURL, onTap, onPinTap, onPinMove } = opts;
  let pins = opts.pins || [];
  // zones : [{ id, pts:[{x,y}], color, label, kind: 'zone' (zone du plan) | 'area' (zone d'un audit) | 'sel' (sélection en cours) }]
  let areas = opts.areas || [];
  let drawMode = false, onDrawn = null, draft = null;
  container.classList.add('pv');
  container.innerHTML = `
    <div class="pv-stage"><img class="pv-img" alt="Plan" draggable="false"><svg class="pv-areas" preserveAspectRatio="none"></svg><div class="pv-alabels"></div><div class="pv-pins"></div></div>
    <div class="pv-ctrl">
      <button type="button" data-z="in" aria-label="Zoom avant">${ic('plus')}</button>
      <button type="button" data-z="out" aria-label="Zoom arrière">${ic('minus')}</button>
      <button type="button" data-z="fit" aria-label="Ajuster">${ic('fit')}</button>
    </div>`;
  const stage = container.querySelector('.pv-stage');
  const img = container.querySelector('.pv-img');
  const layer = container.querySelector('.pv-pins');
  const svg = container.querySelector('.pv-areas'), alabels = container.querySelector('.pv-alabels');
  const NS = 'http://www.w3.org/2000/svg';
  // un nom de zone n'apparaît que si la zone est assez large à l'écran (sinon les noms se chevauchent)
  const fitLabels = () => alabels.querySelectorAll('.pv-alabel').forEach(el => {
    if (el.classList.contains('k-sel')) return;
    el.classList.toggle('pv-hide', +el.dataset.aw * s < Math.min(80, el.offsetWidth * 0.6 + 24));
  });
  const renderAreas = () => {
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.style.width = W + 'px'; svg.style.height = H + 'px';
    svg.innerHTML = ''; alabels.innerHTML = '';
    const all = draft ? [...areas, { id: '_draft', pts: draft, kind: 'sel', color: '#F5C400' }] : areas;
    for (const a of all) {
      if (!a.pts || a.pts.length < 3) continue;
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', a.pts.map(p => `${p.x * W},${p.y * H}`).join(' '));
      poly.setAttribute('class', 'pv-area k-' + (a.kind || 'zone'));
      poly.style.setProperty('--c', a.color || '#1A56A8');
      svg.appendChild(poly);
      if (a.label) {
        const c = centroid(a.pts), el = document.createElement('span');
        el.className = 'pv-alabel k-' + (a.kind || 'zone'); el.textContent = a.label;
        el.style.left = c.x * W + 'px'; el.style.top = c.y * H + 'px'; el.style.setProperty('--c', a.color || '#1A56A8');
        el.dataset.aw = (Math.max(...a.pts.map(p => p.x)) - Math.min(...a.pts.map(p => p.x))) * W; // largeur de la zone (px image)
        alabels.appendChild(el);
      }
    }
    fitLabels();
  };
  // zone du plan sous le doigt (la plus petite si plusieurs se chevauchent)
  const zoneAt = (x, y) => areas.filter(a => (a.kind === 'zone' || a.tap) && a.pts?.length > 2 && inside(a.pts, x, y)).sort((a, b) => polyArea(a.pts) - polyArea(b.pts))[0] || null;
  let W = 1, H = 1, s = 1, tx = 0, ty = 0, minS = 0.05;

  // le plan ne peut jamais quitter le cadre : plus grand que le cadre, il le couvre toujours ; plus petit, il reste entièrement visible
  const clampView = () => {
    if (W <= 1) return;
    const r = container.getBoundingClientRect(), w = W * s, h = H * s, pad = 24;
    tx = w >= r.width ? Math.min(pad, Math.max(r.width - w - pad, tx)) : Math.min(r.width - w + pad, Math.max(-pad, tx));
    ty = h >= r.height ? Math.min(pad, Math.max(r.height - h - pad, ty)) : Math.min(r.height - h + pad, Math.max(-pad, ty));
  };
  const apply = () => {
    clampView();
    stage.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
    stage.style.setProperty('--inv', 1 / s);
    fitLabels();
    if (opts.cluster && W > 1) { const b = Math.round(Math.log(s) / Math.log(1.3)); if (b !== lastBucket) { lastBucket = b; renderPins(); } }
  };
  // cover = le plan remplit tout l'écran (on se déplace au doigt) ; sinon il est entièrement visible
  const fit = (cover = false) => {
    const r = container.getBoundingClientRect();
    const contain = Math.min(r.width / W, r.height / H) || 1;
    s = cover ? Math.min(Math.max(r.width / W, r.height / H), contain * (typeof cover === 'number' ? cover : 1.7)) : contain;
    minS = contain * 0.8;
    tx = (r.width - W * s) / 2; ty = (r.height - H * s) / 2;
    apply();
  };
  const zoomAt = (factor, cx, cy) => {
    const ns = Math.min(Math.max(s * factor, minS), minS * 40);
    tx = cx - (cx - tx) * (ns / s); ty = cy - (cy - ty) * (ns / s); s = ns; apply();
  };
  const focus = (x, y, zoom = 3) => {
    const r = container.getBoundingClientRect();
    fit(); s = s * zoom;
    tx = r.width / 2 - x * W * s; ty = r.height / 2 - y * H * s; apply();
  };

  // regroupement : les épingles trop proches à l'écran fusionnent en une bulle « 12 » (toucher = zoom dessus)
  let shown = [], lastBucket = null;
  const clusterize = () => {
    if (!opts.cluster || W <= 1) return pins;
    const d = 46 / s, out = [];
    for (const p of pins) {
      const px = p.x * W, py = p.y * H;
      const c = out.find(q => Math.hypot(q.cx - px, q.cy - py) < d);
      if (c) { c.m.push(p); c.cx = (c.cx * (c.m.length - 1) + px) / c.m.length; c.cy = (c.cy * (c.m.length - 1) + py) / c.m.length; }
      else out.push({ cx: px, cy: py, m: [p] });
    }
    return out.map((c, k) => c.m.length === 1 ? c.m[0] : { id: '_c' + k, x: c.cx / W, y: c.cy / H, cluster: true, members: c.m,
      label: String(c.m.reduce((a, p) => a + (p.count || 1), 0)), color: c.m.every(p => p.kind === 'action') ? '#C62828' : new Set(c.m.map(p => p.color)).size === 1 ? c.m[0].color : '#0B2D5B' });
  };
  const renderPins = () => {
    layer.innerHTML = '';
    shown = clusterize();
    for (const p of shown) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'pin' + (p.cluster ? ' pin-cluster' : '') + (p.kind === 'action' ? ' pin-action' : '') + (p.ghost ? ' pin-ghost' : '') + (p.count > 1 ? ' pin-multi' : '');
      el.style.left = p.x * W + 'px'; el.style.top = p.y * H + 'px';
      el.style.setProperty('--c', p.color || '#0B2D5B');
      el.dataset.pid = p.id;
      el.innerHTML = `<span>${p.label ?? ''}</span>`;
      layer.appendChild(el);
    }
  };

  img.onload = () => { W = img.naturalWidth; H = img.naturalHeight; stage.style.width = W + 'px'; stage.style.height = H + 'px'; fit(opts.cover); renderAreas(); renderPins(); if (opts.focus) focus(opts.focus.x, opts.focus.y); };
  img.src = imageURL;

  // --- gestes ---
  const pts = new Map();
  let holdTimer = null, dragPin = null;
  let start = null, last = null, multi = false, panning = false, draftStart = null;
  const rel = e => { const r = container.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  container.addEventListener('pointerdown', e => {
    if (e.target.closest('.pv-ctrl')) return;
    container.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, rel(e));
    if (pts.size === 1 && drawMode) { // dessin d'un rectangle : le doigt trace, le plan ne bouge pas
      const p = rel(e); draftStart = { x: (p.x - tx) / s / W, y: (p.y - ty) / s / H }; draft = null; start = null;
      last = [...pts.values()].map(q => ({ ...q })); return;
    }
    if (pts.size === 2 && drawMode) { draftStart = null; draft = null; renderAreas(); }
    if (pts.size === 1) {
      start = { ...rel(e), t: Date.now(), target: e.target }; multi = false; panning = false;
      const pinEl = e.target.closest?.('.pin');
      if (pinEl && onPinMove) {
        clearTimeout(holdTimer);
        const dp = pins.find(q => q.id === pinEl.dataset.pid);
        if (dp && !dp.fixed) holdTimer = setTimeout(() => { dragPin = { el: pinEl, pin: dp }; pinEl.classList.add('pin-drag'); navigator.vibrate?.(25); }, 350);
      }
    }
    if (pts.size === 2) { multi = true; panning = true; clearTimeout(holdTimer); }
    last = [...pts.values()].map(p => ({ ...p }));
  });
  container.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, rel(e));
    const cur = [...pts.values()];
    if (drawMode && draftStart && cur.length === 1) {
      const q = cur[0], x = clamp01((q.x - tx) / s / W), y = clamp01((q.y - ty) / s / H), a = draftStart;
      draft = [{ x: a.x, y: a.y }, { x, y: a.y }, { x, y }, { x: a.x, y }]; renderAreas(); return;
    }
    if (dragPin && cur.length === 1) { // l'épingle suit le doigt
      const q = cur[0]; dragPin.el.style.left = (q.x - tx) / s + 'px'; dragPin.el.style.top = (q.y - ty) / s + 'px';
      last = cur.map(p => ({ ...p })); return;
    }
    if (start && Math.hypot(cur[0].x - start.x, cur[0].y - start.y) > 8) clearTimeout(holdTimer);
    // un toucher qui bouge à peine reste un toucher : le plan ne bouge pas
    if (cur.length === 1 && start && !multi && !panning && Math.hypot(cur[0].x - start.x, cur[0].y - start.y) < 14) return;
    if (cur.length === 1) panning = true;
    if (cur.length === 1 && last.length === 1) {
      tx += cur[0].x - last[0].x; ty += cur[0].y - last[0].y; apply();
    } else if (cur.length === 2 && last.length === 2) {
      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (cur[0].x + cur[1].x) / 2, y: (cur[0].y + cur[1].y) / 2 };
      const pmid = { x: (last[0].x + last[1].x) / 2, y: (last[0].y + last[1].y) / 2 };
      tx += mid.x - pmid.x; ty += mid.y - pmid.y;
      zoomAt(d(cur[0], cur[1]) / (d(last[0], last[1]) || 1), mid.x, mid.y);
    }
    last = cur.map(p => ({ ...p }));
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return;
    const p = rel(e);
    pts.delete(e.pointerId);
    clearTimeout(holdTimer);
    if (drawMode && draftStart) {
      const d = draft; draftStart = null; draft = null; renderAreas();
      if (d && Math.abs(d[2].x - d[0].x) * W > 12 && Math.abs(d[2].y - d[0].y) * H > 12) onDrawn?.(d);
      last = [...pts.values()].map(q => ({ ...q })); return;
    }
    if (dragPin) {
      const d = dragPin; dragPin = null; d.el.classList.remove('pin-drag'); start = null;
      const x = Math.min(1, Math.max(0, (p.x - tx) / s / W)), y = Math.min(1, Math.max(0, (p.y - ty) / s / H));
      d.pin.x = x; d.pin.y = y; onPinMove(d.pin, x, y); return;
    }
    last = [...pts.values()].map(q => ({ ...q }));
    if (pts.size === 0 && start && !multi) {
      const moved = Math.hypot(p.x - start.x, p.y - start.y);
      if (!panning && moved < 14 && Date.now() - start.t < 700) {
        const pinEl = start.target.closest?.('.pin');
        const hit = pinEl && shown.find(q => q.id === pinEl.dataset.pid);
        if (hit?.cluster) {
          const xs = hit.members.map(m => m.x), ys = hit.members.map(m => m.y);
          const span = Math.max((Math.max(...xs) - Math.min(...xs)) * W, (Math.max(...ys) - Math.min(...ys)) * H, 1);
          const r = container.getBoundingClientRect(), target = Math.min(minS * 40, Math.max(s * 1.8, Math.min(r.width, r.height) * 0.5 / span));
          const cx = hit.x * W, cy = hit.y * H; s = target; tx = r.width / 2 - cx * s; ty = r.height / 2 - cy * s; apply();
        } else if (pinEl && onPinTap) { onPinTap(hit || pins.find(q => q.id === pinEl.dataset.pid)); }
        else {
          const x = (p.x - tx) / s / W, y = (p.y - ty) / s / H;
          const z = opts.onZoneTap ? zoneAt(x, y) : null;
          if (z) opts.onZoneTap(z, x, y);
          else if (onTap && x >= 0 && x <= 1 && y >= 0 && y <= 1) onTap(x, y);
        }
      }
      start = null;
    }
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
  container.addEventListener('wheel', e => { e.preventDefault(); const p = rel(e); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y); }, { passive: false });
  container.querySelector('.pv-ctrl').addEventListener('click', e => {
    const z = e.target.closest('button')?.dataset.z; if (!z) return;
    const r = container.getBoundingClientRect();
    if (z === 'fit') fit(); else zoomAt(z === 'in' ? 1.6 : 1 / 1.6, r.width / 2, r.height / 2);
  });
  let lastW = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.round(container.getBoundingClientRect().width);
    // 1re mesure : on la note seulement (sinon un plan déjà en cache perdait son zoom de départ)
    if (W > 1 && lastW && Math.abs(w - lastW) > 2) { lastW = w; fit(opts.cover); } else { lastW = w; clampView(); apply(); }
  });
  ro.observe(container);

  return {
    setPins(p) { pins = p; renderPins(); },
    setAreas(a) { areas = a || []; if (W > 1) renderAreas(); },
    /** mode dessin : le doigt trace un rectangle, cb(points) à la fin */
    setDrawMode(on, cb) { drawMode = !!on; onDrawn = cb || null; draft = null; draftStart = null; container.classList.toggle('pv-drawing', drawMode); if (W > 1) renderAreas(); },
    focusArea(pts) { if (!pts?.length || W <= 1) return; const b = bbox(pts); focus(b.x + b.w / 2, b.y + b.h / 2, Math.min(6, Math.max(1, 0.45 / Math.max(b.w, b.h, 0.01)))); },
    fit, focus,
    destroy() { ro.disconnect(); },
  };
}

/** Rend une image du plan avec les épingles (pour le PDF). Retourne un dataURL JPEG. */
export async function renderPlanSnapshot(imageURL, pins, { maxW = 1800, crop = null, areas = [] } = {}) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = imageURL; });
  let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
  if (crop && crop.x0 !== undefined) { // crop = rectangle normalisé {x0,y0,x1,y1}
    sx = crop.x0 * sw; sy = crop.y0 * sh; sw = (crop.x1 - crop.x0) * sw; sh = (crop.y1 - crop.y0) * sh;
  } else if (crop) { // crop = {x,y,size} normalisé autour d'un point
    const size = crop.size * Math.max(sw, sh);
    sx = Math.max(0, Math.min(sw - size, crop.x * sw - size / 2));
    sy = Math.max(0, Math.min(sh - size, crop.y * sh - size / 2));
    sw = Math.min(size, sw); sh = Math.min(size, sh);
  }
  const k = Math.min(1, maxW / sw);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const r = Math.max(16, c.width / 40);
  for (const a of areas) {
    if (!a.pts || a.pts.length < 3) continue;
    g.beginPath();
    a.pts.forEach((p, i) => { const x = (p.x * img.naturalWidth - sx) * k, y = (p.y * img.naturalHeight - sy) * k; i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.closePath();
    g.globalAlpha = 0.28; g.fillStyle = a.color || '#F5C400'; g.fill(); g.globalAlpha = 1;
    g.lineWidth = Math.max(3, c.width / 300); g.strokeStyle = a.color || '#F5C400'; g.stroke();
  }
  // nom de la zone : étiquette au-dessus de la zone, lisible
  for (const a of areas) {
    if (!a.label || !a.pts || a.pts.length < 3) continue;
    const xs = a.pts.map(p => (p.x * img.naturalWidth - sx) * k), ys = a.pts.map(p => (p.y * img.naturalHeight - sy) * k);
    const fs = Math.max(14, c.width / 55), cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    g.font = `bold ${fs}px sans-serif`; const tw = g.measureText(a.label).width + fs;
    // sous la zone : les épingles pointent vers le haut et ne cachent pas le nom
    let ty = Math.max(...ys) + fs * 0.95; if (ty > c.height - fs) ty = Math.max(...ys) - fs * 0.95;
    const tx = Math.max(tw / 2 + 2, Math.min(c.width - tw / 2 - 2, cx));
    g.fillStyle = a.color || '#0B2D5B'; g.beginPath(); if (g.roundRect) g.roundRect(tx - tw / 2, ty - fs * 0.75, tw, fs * 1.5, fs * 0.75); else g.rect(tx - tw / 2, ty - fs * 0.75, tw, fs * 1.5); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(a.label, tx, ty + 1);
  }
  for (const p of pins) {
    const x = (p.x * img.naturalWidth - sx) * k, y = (p.y * img.naturalHeight - sy) * k;
    if (x < -r || y < -r || x > c.width + r || y > c.height + r) continue;
    g.beginPath(); g.moveTo(x, y);
    g.arc(x, y - r * 1.6, r, Math.PI * 0.75, Math.PI * 0.25); g.closePath();
    g.fillStyle = p.color || '#0B2D5B'; g.fill(); g.lineWidth = r / 5; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = `bold ${r}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(p.label ?? ''), x, y - r * 1.6);
  }
  return c.toDataURL('image/jpeg', 0.85);
}
