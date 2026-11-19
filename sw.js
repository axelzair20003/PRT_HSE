// Service worker : tout le code de l'app est mis en cache → fonctionnement 100 % hors ligne.
// Pour publier une mise à jour : modifier CACHE (ex. v1.0.1), puis rouvrir l'app 2 fois.
const CACHE = 'prt-hse-v3.14.0';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/calc.js', 'js/db.js', 'js/export.js', 'js/images.js', 'js/plan.js', 'js/prt-data.js', 'js/cloud.js', 'js/config.js', 'js/seed.js', 'js/icons.js', 'js/report-fr.js',
  'vendor/xlsx.full.min.js', 'vendor/exceljs.min.js', 'assets/prt-template.xlsx', 'js/xlsx-template.js', 'vendor/jspdf.umd.min.js', 'vendor/jspdf.plugin.autotable.min.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/supabase.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png', 'icons/apple-touch-icon.png',
];
// Rien de confidentiel dans cette liste : le plan du chantier n'est jamais publié avec l'app.
// ⚠️ Ne lister ici QUE des fichiers présents dans le dépôt : un fichier absent bloque l'installation des mises à jour.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
});
// la page demande l'activation quand l'utilisateur touche « Mettre à jour »
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok && new URL(e.request.url).origin === location.origin) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()))
  );
});
