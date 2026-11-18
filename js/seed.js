// Données de départ FACULTATIVES (entreprises, zones, plan) : elles ne sont PAS publiées avec l'app,
// pour que rien de confidentiel ne soit visible sur Internet. Si un fichier assets/seed.json existe
// (installation privée), il est lu au premier démarrage ; sinon l'app démarre vide :
// Ahmed crée le projet, importe le plan et ajoute les entreprises (ou restaure une sauvegarde).
export let SEED_SUBS = [];
export let SEED_LOCATIONS = [];
export let SEED_PLAN = null;   // { name, code, file }
export let SEED_SITE = '';
export let SEED_PROJECT = null; // { name, code, site }
export async function loadSeed() {
  try {
    const res = await fetch('assets/seed.json', { cache: 'no-store' });
    if (!res.ok) return;
    const s = await res.json();
    SEED_SUBS = s.subs || []; SEED_LOCATIONS = s.locations || []; SEED_PLAN = s.plan || null;
    SEED_SITE = s.site || ''; SEED_PROJECT = s.project || null;
  } catch { /* pas de données de départ : normal */ }
}
