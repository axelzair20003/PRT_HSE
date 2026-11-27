// Compression des photos et conversion des plans (image ou PDF) en image.

function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Image illisible')); i.src = src; });
}

/** Redimensionne et compresse une image (photo iPhone) en JPEG */
export async function compressImage(file, maxSide = 1280, quality = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', quality));
  } finally { URL.revokeObjectURL(url); }
}

const MAX_PIXELS = 15_000_000; // limite des canvas sur iOS Safari (~16,7 Mpx)

/** Importe un plan : image → JPEG ≤ 4000 px ; PDF → rendu de la page choisie */
export async function planFileToBlob(file, pageNumber = 1) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const pdfjs = window.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const page = await pdf.getPage(Math.min(Math.max(1, pageNumber), pdf.numPages));
    const v1 = page.getViewport({ scale: 1 });
    let scale = Math.min(4000 / Math.max(v1.width, v1.height), 6);
    if (v1.width * v1.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (v1.width * v1.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.9));
    return { blob, pages: pdf.numPages };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    let k = Math.min(1, 4000 / Math.max(img.naturalWidth, img.naturalHeight));
    if (img.naturalWidth * img.naturalHeight * k * k > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (img.naturalWidth * img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return { blob: await new Promise(res => c.toBlob(res, 'image/jpeg', 0.9)), pages: 1 };
  } finally { URL.revokeObjectURL(url); }
}

export async function pdfPageCount(file) {
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  return pdf.numPages;
}
