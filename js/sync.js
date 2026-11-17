// Point d'extension pour une synchronisation future (V2).
// V1 : 100 % local, ce module ne fait rien.
//
// Principe prévu :
//  - chaque écriture locale ajoute une ligne dans le store "outbox" (voir db.js)
//  - chaque enregistrement porte id (UUID), createdAt, updatedAt, deleted
//  - un adaptateur implémente push(changes) et pull(since) ; résolution des conflits
//    "last write wins" sur updatedAt
//
// Exemple d'adaptateur Supabase (à compléter) :
//   export const supabaseAdapter = {
//     async push(changes) { /* upsert dans les tables subs, plans, inspections, actions ; upload des blobs dans Storage */ },
//     async pull(sinceISO) { /* select * where updated_at > since */ return []; },
//   };
//
// Exemple SharePoint : même interface via Microsoft Graph (listes + bibliothèque de documents).

export const SyncAdapter = null; // aucun adaptateur en V1

export async function syncNow() {
  if (!SyncAdapter) return { ok: false, reason: 'Synchronisation non configurée (V1 hors ligne)' };
  // 1. lire l'outbox  2. SyncAdapter.push  3. SyncAdapter.pull  4. vider l'outbox
}
