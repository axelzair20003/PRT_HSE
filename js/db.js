// Couche de données locale (IndexedDB).
// Toute écriture passe par put()/remove() : horodatage updatedAt + journal "outbox".
// Une future synchronisation (Supabase, SharePoint…) n'aura qu'à lire l'outbox
// et pousser les changements — voir js/sync.js.

const DB_NAME = 'prt-hse';
const DB_VERSION = 2; // v2 : ajout des projets
export const STORES = ['projects', 'subs', 'plans', 'inspections', 'actions', 'blobs', 'meta', 'outbox'];

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of STORES) {
        if (db.objectStoreNames.contains(s)) continue;
        const os = db.createObjectStore(s, { keyPath: s === 'outbox' ? 'seq' : 'id', autoIncrement: s === 'outbox' });
        if (s === 'inspections' || s === 'actions') { os.createIndex('subId', 'subId'); os.createIndex('planId', 'planId'); }
        if (s === 'actions') os.createIndex('inspectionId', 'inspectionId');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(stores, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2));

export async function get(store, id) {
  return tx([store], 'readonly', t => req(t.objectStore(store).get(id)));
}
export async function all(store, { includeDeleted = false } = {}) {
  const rows = await tx([store], 'readonly', t => req(t.objectStore(store).getAll()));
  return includeDeleted ? rows : rows.filter(r => !r.deleted);
}
export async function byIndex(store, index, value) {
  const rows = await tx([store], 'readonly', t => req(t.objectStore(store).index(index).getAll(value)));
  return rows.filter(r => !r.deleted);
}
export async function put(store, obj) {
  if (!obj.id) obj.id = uid();
  if (!obj.createdAt) obj.createdAt = new Date().toISOString();
  obj.updatedAt = new Date().toISOString();
  await tx([store, 'outbox'], 'readwrite', t => {
    t.objectStore(store).put(obj);
    if (store !== 'meta') t.objectStore('outbox').add({ store, recordId: obj.id, op: 'put', at: obj.updatedAt });
  });
  writeListeners.forEach(f => f(store, obj));
  return obj;
}
const writeListeners = new Set();
/** Appelé après chaque écriture locale (utilisé pour déclencher la synchro) */
export const onWrite = f => writeListeners.add(f);

/** Écriture venant du serveur : pas d'horodatage ni d'outbox */
export async function putRaw(store, obj) {
  await tx([store], 'readwrite', t => t.objectStore(store).put(obj));
  return obj;
}
/** Suppression physique locale (migration d'identifiants) */
export async function purge(store, id) { return tx([store], 'readwrite', t => t.objectStore(store).delete(id)); }

// --- Outbox (changements à envoyer au serveur) ---
export async function outboxAll() { return tx(['outbox'], 'readonly', t => req(t.objectStore('outbox').getAll())); }
export async function outboxClear(seqs) {
  if (!seqs.length) return;
  return tx(['outbox'], 'readwrite', t => { const os = t.objectStore('outbox'); seqs.forEach(k => os.delete(k)); });
}
export async function outboxCount(stores) {
  const all = await outboxAll();
  return new Set(all.filter(o => !stores || stores.includes(o.store)).map(o => o.store + '|' + o.recordId)).size;
}
/** Efface toutes les données locales (déconnexion) */
export async function wipe() {
  await tx(STORES, 'readwrite', t => { for (const s of STORES) t.objectStore(s).clear(); });
  urlCache.clear();
}
/** Suppression logique (deleted=true) pour pouvoir la propager lors d'une synchro */
export async function remove(store, id) {
  const o = await get(store, id);
  if (!o) return;
  o.deleted = true;
  return put(store, o);
}

// --- Blobs (photos, images de plan, logos) ---
export async function putBlob(blob, id = uid()) {
  await tx(['blobs'], 'readwrite', t => t.objectStore('blobs').put({ id, blob, type: blob.type, updatedAt: new Date().toISOString() }));
  return id;
}
export async function getBlob(id) {
  const local = (await get('blobs', id))?.blob;
  if (local || !blobResolver) return local || null;
  const remote = await blobResolver(id).catch(() => null); // téléchargement depuis le serveur si absent
  if (remote) { await tx(['blobs'], 'readwrite', t => t.objectStore('blobs').put({ id, blob: remote, type: remote.type, synced: true })); }
  return remote;
}
let blobResolver = null;
export const setBlobResolver = f => { blobResolver = f; };
export async function blobRecord(id) { return get('blobs', id); }
export async function markBlobSynced(id) {
  const r = await get('blobs', id); if (!r) return;
  r.synced = true; await tx(['blobs'], 'readwrite', t => t.objectStore('blobs').put(r));
}
export async function deleteBlob(id) { return tx(['blobs'], 'readwrite', t => t.objectStore('blobs').delete(id)); }

const urlCache = new Map();
export async function blobURL(id) {
  if (!id) return null;
  if (urlCache.has(id)) return urlCache.get(id);
  const b = await getBlob(id);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  urlCache.set(id, u);
  return u;
}

// --- Meta (réglages, compteurs) ---
export async function getMeta(key, def = null) { return (await get('meta', key))?.value ?? def; }
export async function setMeta(key, value) { return tx(['meta'], 'readwrite', t => t.objectStore('meta').put({ id: key, value })); }

// --- Sauvegarde / restauration JSON complète ---
const b64 = blob => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
export async function exportAll() {
  const out = { app: 'PRT-HSE', version: DB_VERSION, exportedAt: new Date().toISOString(), data: {} };
  for (const s of STORES) {
    if (s === 'outbox') continue;
    const rows = await tx([s], 'readonly', t => req(t.objectStore(s).getAll()));
    if (s === 'blobs') out.data.blobs = await Promise.all(rows.map(async r => ({ id: r.id, type: r.type, data: await b64(r.blob) })));
    else out.data[s] = rows;
  }
  return out;
}
export async function importAll(json) {
  if (json?.app !== 'PRT-HSE') throw new Error('Fichier de sauvegarde non reconnu');
  const blobs = await Promise.all((json.data.blobs || []).map(async b => ({ id: b.id, type: b.type, blob: await (await fetch(b.data)).blob() })));
  await tx(STORES, 'readwrite', t => {
    for (const s of STORES) t.objectStore(s).clear();
    for (const s of STORES) {
      if (s === 'outbox') continue;
      const rows = s === 'blobs' ? blobs : (json.data[s] || []);
      for (const r of rows) t.objectStore(s).put(r);
    }
  });
  urlCache.clear();
}
