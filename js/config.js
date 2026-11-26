// Connexion au serveur Supabase.
// Laisser vide = l'app fonctionne 100 % en local sur chaque téléphone (pas de compte).
// Renseigner = connexion obligatoire, données centralisées, l'admin HSE voit tout.
// Ces deux valeurs sont publiques par nature : la sécurité est assurée par le serveur (RLS).
export const CLOUD = {
  url: 'https://gumkyisjdvxpixfbllrj.supabase.co',      // ex. 'https://abcdefghijkl.supabase.co'  (Project Settings → API → Project URL)
  anonKey: 'sb_publishable_s-I5u-hfXcredF7Ia_Xp4A_OD74XPeX',  // clé « publishable » ou « anon public »   (Project Settings → API Keys)
};
