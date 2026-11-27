// Connexion + synchronisation avec Supabase.
// Principe : l'app reste 100 % utilisable hors ligne. Chaque écriture locale est
// journalisée (outbox) puis envoyée dès qu'il y a du réseau ; les données des autres
// (visibles uniquement par l'admin, filtrées par le serveur) sont récupérées en retour.
import { CLOUD } from './config.js';
import * as db from './db.js';
import { overallScore } from './calc.js';

export const enabled = !!(CLOUD.url && CLOUD.anonKey);
let sb = null;
export let session = null;
export let profile = null;

const KIND = { projects: 'project', inspections: 'inspection', actions: 'action', subs: 'sub', plans: 'plan' };
const ADMIN_ONLY = ['subs', 'plans', 'projects'];
const STORE = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));

// ---------- état de synchro (affiché dans l'app) ----------
export const status = { state: 'idle', pending: 0, last: null, error: null };
const listeners = new Set();
export const onStatus = f => { listeners.add(f); return () => listeners.delete(f); };
const emit = p => { Object.assign(status, p); listeners.forEach(f => f(status)); };

export const uid = () => session?.user?.id || null;
export const isAdmin = () => !enabled || profile?.role === 'admin';
export const myName = () => profile?.name || profile?.email || '';

export async function init() {
  if (!enabled) return;
  sb = window.supabase.createClient(CLOUD.url, CLOUD.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'prt-hse-auth' },
  });
  session = (await sb.auth.getSession()).data.session; // lu en local : marche hors ligne
  sb.auth.onAuthStateChange((_e, s) => { session = s; });
  if (session) await loadProfile();
  db.setBlobResolver(fetchBlob);
  db.onWrite(store => { if (KIND[store]) syncSoon(); });
  window.addEventListener('online', () => syncSoon(300));
  window.addEventListener('prt:blob-deleted', async e => { const l = await db.getMeta('blobDeletes', []); if (!l.includes(e.detail)) { l.push(e.detail); await db.setMeta('blobDeletes', l); } });
  setInterval(() => syncSoon(0), 60_000);
  await refreshPending();
}

async function loadProfile() {
  try {
    const { data, error } = await sb.from('profiles').select('*').eq('id', uid()).single();
    if (error) throw error;
    profile = data; await db.setMeta('profile', data);
    // un droit d'aperçu vient d'être accordé : on récupère aussi l'historique de l'équipe
    const key = OPT_IN.map(k => k + ':' + (data?.perms?.[k] === true)).join(',');
    if (key !== await db.getMeta('optInSeen')) { await db.setMeta('optInSeen', key); await db.setMeta('lastPull', '1970-01-01T00:00:00Z'); }
  } catch { profile = await db.getMeta('profile'); }
}

const friendly = e => {
  const m = e?.message || String(e);
  if (/invalid login/i.test(m)) return new Error('Email ou mot de passe incorrect.');
  if (/bad invite code/i.test(m)) return new Error('Code d’invitation incorrect : utilisez le lien reçu dans le message d’invitation.');
  if (/database error saving new user|not invited/i.test(m)) return new Error('Adresse non invitée ou code d’invitation incorrect. Utilisez le lien reçu, ou demandez une nouvelle invitation.');
  if (/already registered|already been registered/i.test(m)) return new Error('Ce compte existe déjà : utilisez « Se connecter ».');
  if (/password should|at least/i.test(m)) return new Error('Mot de passe trop court (8 caractères minimum).');
  if (/fetch|network/i.test(m)) return new Error('Pas de connexion internet. La première connexion nécessite du réseau.');
  return new Error(m);
};

export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (error) throw friendly(error);
  session = data.session; await loadProfile(); await afterLogin();
}
export async function signUp(email, password, name, code = '') {
  const { data, error } = await sb.auth.signUp({ email: email.trim().toLowerCase(), password, options: { data: { name: name.trim(), code: code.trim().toUpperCase() } } });
  if (error) throw friendly(error);
  if (!data.session) throw new Error('Compte créé, mais Supabase demande une confirmation par email : désactivez « Confirm email » (voir guide).');
  session = data.session; await loadProfile(); await afterLogin();
}
/** Changer son propre mot de passe (connecté) */
export async function changePassword(pw) {
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) throw friendly(error);
}
/** Admin : mot de passe provisoire pour un inspecteur qui l'a oublié (pas besoin d'email) */
export async function adminSetPassword(id, pw) {
  const { error } = await sb.rpc('admin_set_password', { target: id, new_password: pw });
  if (error) throw friendly(error);
}
export async function signOut() {
  try { await sync(); } catch { /* on déconnecte quand même */ }
  const left = await db.outboxCount(Object.keys(KIND));
  if (left) throw new Error(`${left} élément(s) pas encore envoyé(s). Connectez-vous à internet avant de vous déconnecter.`);
  await sb.auth.signOut();
  await db.wipe();
}

/** Les audits faits avant la connexion deviennent ceux de l'utilisateur */
async function afterLogin() {
  for (const store of ['inspections', 'actions']) {
    for (const r of await db.all(store, { includeDeleted: true })) if (!r.owner) await db.put(store, { ...r, owner: uid() });
  }
  if (!isAdmin()) { // l'inspecteur reçoit les sous-traitants/plans du serveur
    for (const store of ADMIN_ONLY) {
      const ids = (await db.outboxAll()).filter(o => o.store === store).map(o => o.seq);
      await db.outboxClear(ids);
    }
  }
  await sync();
}

// ---------- synchronisation ----------
let timer = null, running = null;
export function syncSoon(ms = 2500) {
  if (!enabled || !session) return;
  clearTimeout(timer); timer = setTimeout(() => sync().catch(() => {}), ms);
}
export async function refreshPending() {
  if (!enabled) return;
  emit({ pending: await db.outboxCount(Object.keys(KIND)) });
}
export function sync() {
  if (!enabled || !session) return Promise.resolve();
  if (running) return running;
  running = (async () => {
    if (!navigator.onLine) { emit({ state: 'offline' }); await refreshPending(); return; }
    emit({ state: 'syncing', error: null });
    try {
      await push();
      await purgeRemoteBlobs();
      await pull();
      await db.setMeta('lastSync', new Date().toISOString());
      emit({ state: 'ok', last: new Date().toISOString() });
    } catch (e) {
      console.warn('sync', e);
      emit({ state: navigator.onLine ? 'error' : 'offline', error: friendly(e).message });
    } finally { await refreshPending(); }
  })().finally(() => { running = null; });
  return running;
}

const photosOf = (store, r) => store === 'inspections' ? [...Object.values(r.scores || {}).flatMap(s => s?.photos || []), ...(r.goods || []).flatMap(g => g.photos || []), r.signature?.blobId]
  : store === 'actions' ? [...(r.photos || []), ...(r.photosAfter || [])] : store === 'plans' ? [r.blobId] : store === 'projects' ? [r.logoId, r.logo2Id, r.appLogoId] : store === 'subs' ? [r.logoId] : [];
const blobPath = (store, owner, id) => ADMIN_ONLY.includes(store) ? { bucket: 'shared', path: id } : { bucket: 'photos', path: `${owner}/${id}` };

async function push() {
  const out = await db.outboxAll();
  const groups = new Map();
  const done = [];
  for (const o of out) {
    if (!KIND[o.store]) { done.push(o.seq); continue; }
    const k = o.store + '|' + o.recordId;
    (groups.get(k) || groups.set(k, []).get(k)).push(o);
  }
  for (const [, list] of groups) {
    const { store, recordId } = list[0];
    const seqs = list.map(o => o.seq);
    const rec = await db.get(store, recordId);
    if (!rec || (ADMIN_ONLY.includes(store) && !isAdmin())) { done.push(...seqs); continue; }
    const owner = rec.owner || uid();
    try {
      for (const id of photosOf(store, rec).filter(Boolean)) await uploadBlob(id, blobPath(store, owner, id));
      const { error } = await sb.from('docs').upsert({
        id: rec.id, kind: KIND[store], owner, project: store === 'projects' ? rec.id : (rec.projectId || null),
        data: { ...rec, owner }, deleted: !!rec.deleted,
      });
      if (error) throw error;
      // aperçu de l'audit (sans notes détaillées, commentaires ni photos) : visible des HSE qui ont le droit « aperçu équipe »
      if (store === 'inspections') {
        const { error: e2 } = await sb.from('docs').upsert({
          id: 'sum-' + rec.id, kind: 'summary', owner, project: rec.projectId || null, data: summaryOf(rec), deleted: !!rec.deleted,
        });
        if (e2) throw e2;
      }
      done.push(...seqs);
    } catch (e) {
      if (!refused(e)) { await db.outboxClear(done); throw e; }        // réseau : on réessaiera plus tard
      await loadProfile();
      if (profile && profile.active === false) { await db.outboxClear(done); throw new Error('Votre accès a été bloqué par l’administrateur HSE. Vos audits restent sur ce téléphone.'); }
      // refusé par le serveur (droits retirés, projet non autorisé…) : on le met de côté au lieu de bloquer tout l'envoi
      const rej = await db.getMeta('rejected', {});
      rej[store + '|' + recordId] = { store, id: recordId, ref: rec.ref || rec.title || rec.name || '', at: new Date().toISOString() };
      await db.setMeta('rejected', rej);
      done.push(...seqs);
    }
  }
  await db.outboxClear(done);
}
const refused = e => /row-level security|permission denied|42501|violates|not allowed|unauthorized|403/i.test(`${e?.code || ''} ${e?.message || ''} ${e?.statusCode || ''}`);
/** Éléments refusés par le serveur (à signaler à l'admin) */
export async function rejected() { return Object.values(await db.getMeta('rejected', {})); }
export async function clearRejected() { await db.setMeta('rejected', {}); }

function summaryOf(i) {
  const o = overallScore(i.scores || {}, i.bonus, i.penalty);
  return { id: i.id, date: i.date, zone: i.zone || '', area: i.area || null, pin: i.pin || null, planId: i.planId || null, projectId: i.projectId || null,
    subIds: i.subIds || (i.subId ? [i.subId] : []), visitId: i.visitId || null, inspectors: i.inspectors || '', ref: i.ref || '',
    pct: o.pct, done: o.themes.reduce((a, t) => a + t.done, 0) };
}
/** Aperçu des audits des autres HSE (droit « aperçu équipe ») */
export async function teamAudits() { return Object.values(await db.getMeta('teamAudits', {})).filter(a => !a.deleted); }

/** Photos effacées dans l'app → effacées aussi du stockage (sinon on paie pour des photos inutiles) */
async function purgeRemoteBlobs() {
  const ids = await db.getMeta('blobDeletes', []);
  if (!ids.length) return;
  const paths = await db.getMeta('blobPaths', {});
  for (const id of ids) {
    const p = paths[id] || { bucket: 'photos', path: `${uid()}/${id}` };
    if (p.bucket === 'shared' && !isAdmin()) continue;
    await sb.storage.from(p.bucket).remove([p.path]).catch(() => {});
    delete paths[id];
  }
  await db.setMeta('blobPaths', paths); await db.setMeta('blobDeletes', []);
}

async function uploadBlob(id, { bucket, path }) {
  const r = await db.blobRecord(id);
  if (!r || r.synced) return;
  const { error } = await sb.storage.from(bucket).upload(path, r.blob, { upsert: true, contentType: r.type || 'image/jpeg' });
  if (error && !/exists/i.test(error.message)) throw error;
  await db.markBlobSynced(id);
}

async function pull() {
  let since = await db.getMeta('lastPull', '1970-01-01T00:00:00Z');
  const paths = await db.getMeta('blobPaths', {});
  const team = await db.getMeta('teamAudits', {});
  for (;;) {
    const { data, error } = await sb.from('docs').select('*').gt('updated_at', since).order('updated_at').limit(500);
    if (error) throw error;
    const pendingSet = new Set((await db.outboxAll()).map(o => o.store + '|' + o.recordId));
    for (const row of data) {
      if (row.kind === 'summary') {
        if (!isAdmin() && row.owner !== uid()) { team[row.data.id] = { ...row.data, owner: row.owner, deleted: row.deleted, updatedAt: row.updated_at }; }
        since = row.updated_at; continue;
      }
      const store = STORE[row.kind];
      if (!store) { since = row.updated_at; continue; }
      if (!pendingSet.has(store + '|' + row.id)) {
        await db.putRaw(store, { ...row.data, owner: row.owner, deleted: row.deleted, updatedAt: row.updated_at });
      }
      for (const id of photosOf(store, row.data).filter(Boolean)) paths[id] = blobPath(store, row.owner, id);
      since = row.updated_at;
    }
    if (data.length < 500) break;
  }
  await db.setMeta('blobPaths', paths);
  await db.setMeta('teamAudits', team);
  await db.setMeta('lastPull', since);
}

async function fetchBlob(id) {
  if (!session || !navigator.onLine) return null;
  const p = (await db.getMeta('blobPaths', {}))[id];
  if (!p) return null;
  const { data, error } = await sb.storage.from(p.bucket).download(p.path);
  return error ? null : data;
}

// ---------- équipe (admin) ----------
export async function team() {
  const [p, i] = await Promise.all([sb.from('profiles').select('*').order('name'), sb.from('invites').select('*').order('created_at')]);
  if (p.error) throw friendly(p.error);
  if (i.error) throw friendly(i.error);
  await db.setMeta('profiles', Object.fromEntries(p.data.map(x => [x.id, { name: x.name, email: x.email, role: x.role, active: x.active, audit: !!x.perms?.audit }])));
  return { profiles: p.data, invites: i.data };
}
export async function invite(email, name, role = 'inspector', perms = null, projects = null) {
  const row = { email: email.trim().toLowerCase(), name: name.trim(), role, projects: projects && projects.length ? projects : null };
  if (perms) row.perms = perms;
  const { error } = await sb.from('invites').upsert(row);
  if (error) throw friendly(error);
}
/** Code d'invitation personnel (lisible par l'admin uniquement) */
export async function inviteCode(email) {
  const { data, error } = await sb.from('invites').select('code').eq('email', email.trim().toLowerCase()).single();
  if (error) throw friendly(error);
  return data?.code || '';
}
/** Modifier les accès d'un membre (rôle, droits, projets autorisés) */
export async function setAccess(id, { role, perms, projects }) {
  const patch = {};
  if (role) patch.role = role;
  if (perms) patch.perms = perms;
  if (projects !== undefined) patch.projects = projects && projects.length ? projects : null;
  const { error } = await sb.from('profiles').update(patch).eq('id', id);
  if (error) throw friendly(error);
}
export async function removeInvite(email) {
  const { error } = await sb.from('invites').delete().eq('email', email);
  if (error) throw friendly(error);
}
export async function setActive(id, active) {
  const { error } = await sb.from('profiles').update({ active }).eq('id', id);
  if (error) throw friendly(error);
}
/** Noms des inspecteurs (cache local pour l'affichage hors ligne) */
export async function names() { return await db.getMeta('profiles', {}); }

// ---------- droits ----------
export const PERMS = {
  audit: 'Créer des audits',
  details: 'Voir le détail de ses audits',
  export: 'Exporter PDF / Excel',
  actions: 'Gérer les actions',
  team: 'Voir les audits de l’équipe (aperçu)',
  teamActions: 'Voir les actions ouvertes des autres',
};
/** droits à activer explicitement (décochés par défaut) */
export const OPT_IN = ['team', 'teamActions'];
/** Droit accordé ? (mode local ou admin : tout est permis) */
export const can = p => OPT_IN.includes(p) ? enabled && !isAdmin() && profile?.perms?.[p] === true : (!enabled || isAdmin() || profile?.perms?.[p] !== false);
/** Projet accessible ? (null = tous les projets) */
export const canProject = id => !enabled || isAdmin() || !Array.isArray(profile?.projects) || profile.projects.includes(id);
