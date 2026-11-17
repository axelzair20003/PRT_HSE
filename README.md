# PRT HSE — Site HSE Performance Rating Tool (PWA)

Web app mobile hors ligne pour noter les sous-traitants selon le PRT (fichier « PRT Subbies Friendly SAM2 Layout »).
19 thèmes et 124 critères repris tels quels depuis l'Excel. Chaque inspection et chaque action est liée à un sous-traitant et à une épingle sur le plan.

## Contenu
```
index.html, manifest.webmanifest, sw.js   → app + installation + hors ligne
css/app.css                               → design (fort contraste, boutons ≥ 52 px, mode sombre)
js/prt-data.js                            → les 19 thèmes / 124 critères (générés depuis l'Excel)
js/calc.js                                → logique de calcul (fonctions pures)
js/db.js                                  → IndexedDB + journal "outbox" (prévu pour une synchro future)
js/cloud.js + js/config.js               → connexion et synchronisation Supabase (mode équipe)
supabase/schema.sql                       → base de données + règles d’accès à coller dans Supabase
js/plan.js                                → plan zoomable + épingles
js/images.js                              → compression photos, import PDF/image du plan
js/export.js                              → Excel 4 feuilles, PDF, partage iOS
js/app.js                                 → écrans
vendor/                                   → SheetJS, jsPDF, pdf.js (embarqués, aucun CDN)
test/calc.test.mjs                        → tests de calcul (node test/calc.test.mjs)
```

## Logique de calcul
- Critère : note / 5 ; N/A exclu du total ET du maximum.
- Thème : somme des notes / (nb critères notés × 5). Ex. 5, 4, N/A → 9/10 = **90 %** (testé).
- Thème 100 % N/A (ou non noté) → exclu de la moyenne globale (correction voulue par rapport à l'Excel).
- Overall = moyenne des thèmes notés + Bonus/100 − Pénalité/100, borné 0–100 %.
- Rating : Excellent ≥ 90 · Good 80–90 · Satisfactory 70–80 · Weak 50–70 · Unacceptable < 50.

---

## 1. Mettre en ligne (GitHub Pages, gratuit)
1. Sur github.com : **New repository** → nom `prt-hse` → *Public* → **Create repository**.
2. **Add file → Upload files** → glisser **le contenu** du dossier `prt-hse` (pas le dossier lui-même : `index.html` doit être à la racine du dépôt) → **Commit changes**.
3. **Settings → Pages** → *Source* : `Deploy from a branch` → *Branch* : `main` / `(root)` → **Save**.
4. Après 1–2 min, l'URL s'affiche : `https://<ton-pseudo>.github.io/prt-hse/`.

Alternative Netlify : app.netlify.com → **Add new site → Deploy manually** → glisser le dossier `prt-hse`.

> Mise à jour de l'app : remplacer les fichiers sur GitHub **et** changer `CACHE = 'prt-hse-v1.0.0'` dans `sw.js` (ex. `v1.0.1`). Sur l'iPhone, fermer et rouvrir l'app deux fois.

## 2. Ajouter à l'écran d'accueil de l'iPhone
1. Ouvrir l'URL dans **Safari** (pas Chrome ; c'est obligatoire sur iOS).
2. Attendre que la page d'accueil s'affiche (l'app se met en cache pour le hors ligne).
3. Bouton **Partager** (carré avec flèche) → **Sur l'écran d'accueil** → **Ajouter**.
4. Lancer l'app depuis l'icône « PRT HSE » : elle s'ouvre en plein écran et fonctionne sans réseau.

⚠️ Les données sont stockées **dans l'app sur ce téléphone uniquement**. Faire régulièrement **Réglages → Sauvegarde complète (JSON)** et l'envoyer par mail / OneDrive. Ne pas supprimer l'icône de l'app (iOS effacerait les données).

## 3. Plan et sous-traitants : déjà intégrés
Au premier lancement, l'app charge automatiquement :
- le plan **SAM 2A — vue aérienne** (`assets/plan-sam2a.jpg`, code `SAM2A` → références `PRT-SAM2A-2026-001`) ;
- 10 sous-traitants : Alphascaff, Betocor, Blocotelha, Borgel, Hommema, JDN/Besix, Reditec, TRBA, Unitec, VKE (modifiable dans l'onglet Sous-traitants) ;
- les 70 zones du fichier (« Roof DCH4 », « UTI 11 »…) en suggestions dans le champ Zone.

**Démarrer une inspection = 1 tap** sur le sous-traitant depuis l'accueil. L'inspecteur (« Ahmed » par défaut, modifiable dans Réglages), la date, le site et le plan sont remplis tout seuls. Placer la zone sur le plan est facultatif (carte « 📍 Placer la zone » dans l'inspection).

Pour remplacer le plan : remplacer `assets/plan-sam2a.jpg` par une image du même nom, ou importer un autre plan via Réglages → Gérer les plans.

## Utilisation rapide
- Thème → gros boutons 0–5 / N/A (re-taper une note l'efface). Une note ≤ 2 propose une action corrective.
- Tout est enregistré automatiquement à chaque tap.
- Bouton **?** : barème (feuille Notes).
- **Exporter / Partager** : Excel (4 feuilles identiques à l'original), PDF (résumé, détail, photos, plan avec épingles, actions) → Mail, WhatsApp, Teams.
- Plan : filtres sous-traitant / type / thème / priorité / statut ; tap sur le plan = nouvelle observation libre à cet endroit.

## Mode équipe (connexion + Ahmed voit tout) — Supabase gratuit

Tant que `js/config.js` est vide, l'app fonctionne **100 % en local** (comme avant).
Une fois configurée :
- connexion par **email + mot de passe**, sur **invitation** de l'administrateur ;
- chaque **inspecteur** fait tout le processus et ne voit **que ses audits et actions** ;
- l'**administrateur (Ahmed)** voit **les audits de toute l'équipe** (plan, actions, classement, exports) et gère l'équipe (Réglages → Équipe) ;
- tout reste utilisable **hors ligne** : l'envoi se fait automatiquement au retour du réseau ;
- le cloisonnement est appliqué **par le serveur** (Row Level Security), pas seulement par l'app.

### Mise en route (≈ 15 min, une seule fois)
1. **Créer le projet** : supabase.com → *Start your project* → se connecter (idéalement avec le compte d'Ahmed) → *New project* → nom `prt-hse`, région **Central EU (Frankfurt)**, mot de passe de base de données (à garder) → *Create*.
2. **Créer la base** : menu **SQL Editor** → *New query* → coller tout le fichier `supabase/schema.sql` → **remplacer `ADRESSE-EMAIL-AHMED@exemple.com`** (tout en bas) par l'email d'Ahmed → **Run**.
3. **Désactiver la confirmation par email** : **Authentication → Sign In / Providers → Email** → décocher **Confirm email** → *Save*.
   (Le service email gratuit de Supabase n'envoie que ~2 emails/heure : on n'en a pas besoin.)
4. **Récupérer les 2 valeurs** : **Project Settings → API** (ou *Data API* / *API Keys*) :
   - *Project URL* (ex. `https://abcd1234.supabase.co`)
   - clé **publishable** ou **anon public** (jamais la clé *secret* / *service_role*)
5. **Les coller dans `js/config.js`** sur GitHub (crayon ✏️ → modifier → *Commit changes*) :
   ```js
   export const CLOUD = { url: 'https://abcd1234.supabase.co', anonKey: 'sb_publishable_…' };
   ```
   puis changer `CACHE` dans `sw.js` (ex. `prt-hse-v2.0.1`) → *Commit changes*.
6. **Ahmed se connecte en premier** : ouvrir l'app → *Créer mon compte* avec son email → il est administrateur et envoie les sous-traitants et le plan au serveur.
7. **Inviter l'équipe** : Réglages → **Équipe et invitations** → nom + email → *Inviter*. La personne ouvre l'app → *Créer mon compte* avec cette adresse.

### Au quotidien
- **Bloquer un accès** : Réglages → Équipe → *Bloquer* (ses audits restent visibles pour l'admin).
- **Mot de passe oublié** : supprimer l'utilisateur dans Supabase (**Authentication → Users**) ; l'invitation reste valable, il recrée son compte.
- **Gratuit** : 500 Mo de base (des dizaines de milliers d'audits), 1 Go de photos (≈ 5 000 photos), 50 000 utilisateurs/mois. Un projet gratuit est mis en pause après 7 jours sans activité : les données sont conservées, il suffit de le relancer depuis supabase.com.
- **Pas de sauvegarde automatique** en gratuit : Ahmed fait régulièrement Réglages → *Excel — toutes les inspections* et *Sauvegarde complète*.
- **Données personnelles** : photos de chantier et noms de sous-traitants sont hébergés chez Supabase (UE). À valider avec Jan De Nul si nécessaire.

