// Connexion au serveur Supabase.
// Laisser vide = l'app fonctionne 100 % en local sur chaque téléphone (pas de compte).
// Renseigner = connexion obligatoire, données centralisées, Ahmed (admin) voit tout.
// Ces deux valeurs sont publiques par nature : la sécurité est assurée par le serveur (RLS).
export const CLOUD = {
  url: '',      // ex. 'https://abcdefghijkl.supabase.co'  (Project Settings → API → Project URL)
  anonKey: '',  // clé « publishable » ou « anon public »   (Project Settings → API Keys)
};
