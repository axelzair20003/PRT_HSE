import { ic } from './icons.js';
// Visionneuse de plan : zoom au pincement, déplacement au doigt, tap pour poser une épingle.
// Coordonnées des épingles normalisées (0–1) par rapport à l'image du plan.

export function createPlanViewer(container, opts) {
  const { imageURL, onTap, onPinTap, onPinMove } = opts;
  let pins = opts.pins || [];
  container.classList.add('pv');
  container.innerHTML = `
    <div class="pv-stage"><img class="pv-img" alt="Plan" draggable="false"><div class="pv-pins"></div></div>
    <div class="pv-ctrl">
      <button type="button" data-z="in" aria-label="Zoom avant">${ic('plus')}</button>
      <button type="button" data-z="out" aria-label="Zoom arrière">${ic('minus')}</button>
      <button type="button" data-z="fit" aria-label="Ajuster">${ic('fit')}</button>
    </div>`;
  const stage = container.querySelector('.pv-stage');
  const img = container.querySelector('.pv-img');
  const layer = container.querySelector('.pv-pins');
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

  const renderPins = () => {
    layer.innerHTML = '';
    for (const p of pins) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'pin' + (p.kind === 'action' ? ' pin-action' : '') + (p.ghost ? ' pin-ghost' : '');
      el.style.left = p.x * W + 'px'; el.style.top = p.y * H + 'px';
      el.style.setProperty('--c', p.color || '#0B2D5B');
      el.dataset.pid = p.id;
      el.innerHTML = `<span>${p.label ?? ''}</span>`;
      layer.appendChild(el);
    }
  };

  img.onload = () => { W = img.naturalWidth; H = img.naturalHeight; stage.style.width = W + 'px'; stage.style.height = H + 'px'; fit(opts.cover); renderPins(); if (opts.focus) focus(opts.focus.x, opts.focus.y); };
  img.src = imageURL;

  // --- gestes ---
  const pts = new Map();
  let holdTimer = null, dragPin = null;
  let start = null, last = null, multi = false, panning = false;
  const rel = e => { const r = container.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  container.addEventListener('pointerdown', e => {
    if (e.target.closest('.pv-ctrl')) return;
    container.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, rel(e));
    if (pts.size === 1) {
      start = { ...rel(e), t: Date.now(), target: e.target }; multi = false; panning = false;
      const pinEl = e.target.closest?.('.pin');
      if (pinEl && onPinMove) {
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => { dragPin = { el: pinEl, pin: pins.find(q => q.id === pinEl.dataset.pid) }; pinEl.classList.add('pin-drag'); navigator.vibrate?.(25); }, 350);
      }
    }
    if (pts.size === 2) { multi = true; panning = true; clearTimeout(holdTimer); }
    last = [...pts.values()].map(p => ({ ...p }));
  });
  container.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, rel(e));
    const cur = [...pts.values()];
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
        if (pinEl && onPinTap) { onPinTap(pins.find(q => q.id === pinEl.dataset.pid)); }
        else if (onTap) {
          const x = (p.x - tx) / s / W, y = (p.y - ty) / s / H;
          if (x >= 0 && x <= 1 && y >= 0 && y <= 1) onTap(x, y);
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
    if (W > 1 && Math.abs(w - lastW) > 2) { lastW = w; fit(opts.cover); } else { lastW = w; clampView(); apply(); }
  });
  ro.observe(container);

  return {
    setPins(p) { pins = p; renderPins(); },
    fit, focus,
    destroy() { ro.disconnect(); },
  };
}

/** Rend une image du plan avec les épingles (pour le PDF). Retourne un dataURL JPEG. */
export async function renderPlanSnapshot(imageURL, pins, { maxW = 1800, crop = null } = {}) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = imageURL; });
  let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
  if (crop) { // crop = {x,y,size} normalisé autour d'un point
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
