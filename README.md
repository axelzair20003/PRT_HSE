# PRT HSE — Site HSE Performance Rating Tool (PWA)

Web app mobile hors ligne pour noter les sous-traitants selon le PRT (grille « PRT Subbies Friendly »).
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

> Mise à jour de l'app : remplacer les fichiers sur GitHub **et** changer `CACHE` dans `sw.js` (ex. `prt-hse-v3.11.1`). L'app affiche alors « Nouvelle version disponible » : toucher **Mettre à jour**.

## 2. Ajouter à l'écran d'accueil de l'iPhone
1. Ouvrir l'URL dans **Safari** (pas Chrome ; c'est obligatoire sur iOS).
2. Attendre que la page d'accueil s'affiche (l'app se met en cache pour le hors ligne).
3. Bouton **Partager** (carré avec flèche) → **Sur l'écran d'accueil** → **Ajouter**.
4. Lancer l'app depuis l'icône « Audit HSE » : elle s'ouvre en plein écran et fonctionne sans réseau.

⚠️ Les données sont stockées **dans l'app sur ce téléphone uniquement**. Faire régulièrement **Réglages → Sauvegarde complète (JSON)** et l'envoyer par mail / OneDrive. Ne pas supprimer l'icône de l'app (iOS effacerait les données).

## 3. Plan et entreprises : jamais publiés
Pour un chantier client, **rien de confidentiel n'est dans le dépôt** : ni plan, ni noms d'entreprises, ni zones.
Au premier lancement, l'app démarre vide (« Mon chantier ») :
1. Réglages → Projets et plans : renommer le projet, **importer le plan** (fichier venant du PC ou d'un mail interne, pas d'internet) ;
2. Accueil → « Ajouter des entreprises » ;
3. ou plus simple : **importer le kit de démarrage** (.json reçu en privé) avec le bouton de l'accueil vide, ou Réglages → Restaurer.
En mode équipe, l'admin HSE le fait une seule fois : plan et entreprises arrivent ensuite sur tous les téléphones.

Les téléphones qui avaient déjà l'app **gardent** leur plan et leurs audits (ils sont stockés dans le téléphone).

⚠️ Un fichier supprimé d'un dépôt GitHub public reste visible dans son **historique**. Pour effacer complètement l'ancien plan : supprimer le dépôt, le recréer **avec le même nom**, y envoyer ce zip, puis réactiver GitHub Pages. L'adresse de l'app ne change pas et les données des téléphones sont conservées.

## Nouveautés v3.15
- Accueil : « Reprendre l’audit en cours » (dernier audit ouvert, moins de 12 h, non terminé).
- App vierge : bouton « Importer un kit de démarrage » (.json envoyé en privé — jamais sur GitHub).
- Score lisible en plein soleil ; appréciations en français dans l’app (le PDF anglais reste en anglais).
- Photo : l’iPhone propose appareil photo OU photothèque.
- Actions : liste à onglets sur téléphone, tableau sur PC. Onglet « Audits » actif dans un audit.
- Confidentialité : exemples génériques dans les champs, modèle Excel nettoyé.

## Nouveautés v3.14
- L'app s'appelle **Audit HSE** (nouvelle icône) ; l'administrateur peut changer le **nom et le logo** (Réglages → Apparence de l'app), pour toute l'équipe.
- Téléphone : 4 onglets (Accueil, Audits, Plan, Actions). Dans « Audits », en haut à droite : **Pilotage** et **Excel** (un toucher). Sur PC, Pilotage reste dans la barre latérale.
- **Excel données (Power BI)** : feuilles « Audits » (une ligne par audit, scores par thème en colonnes), « Criteres » (une ligne par critère noté) et « Actions » — tableaux simples, dates et scores en vrais nombres.
- **Recherche d'entreprise** au-dessus de chaque liste à choisir.

## Nouveautés v3.13
- **Zones** : tracer un rectangle ou une **forme libre** (on touche les coins), puis **modifier la forme** (glisser un coin, ajouter un coin, déplacer toute la zone) ; même chose pour les zones du plan (Plan → Zones).
- Nouvel audit : zones du plan discrètes, masquées pendant le tracé, seule la zone choisie reste affichée ; « garder la zone sur le plan » décoché par défaut.
- **Mettre à jour l'image d'un plan** (Projet → Plans → bouton ⬆) : audits, épingles et zones restent en place.

## Nouveautés v3.12
- **iPhone plus léger** : écran du thème compact (Constat · Photo · Action sur une ligne ; la case de constat ne s'ouvre que si besoin ou pour une note de 0 à 2), liste des thèmes sans les boutons N/A, filtres de la liste derrière un bouton « Filtres », accueil allégé (rappel sur une ligne, 3 actions en retard), noms des petites zones masqués sur le plan tant qu'on n'a pas zoomé.

## Nouveautés v3.11
- **Confidentialité** : plan, entreprises et zones retirés du dépôt public ; l'app démarre vide et neutre.
- **Mise à jour en un toucher** : bandeau « Nouvelle version disponible → Mettre à jour » (plus besoin de rouvrir 2 fois).
- **Thème N/A d'un toucher** depuis l'écran du thème (ex. Plongée).
- **Mode équipe plus sûr** : code d'invitation personnel dans le lien ; photos des actions des autres visibles (droit « Actions des autres ») ; plans et projets limités aux projets autorisés ; photos supprimées aussi effacées du serveur.
- Graphique de la fiche entreprise lisible (texte ≥ 12 px), barre du bas agrandie, plan supprimé = image effacée.

## Nouveautés v3.10
- Audits : recherche, filtres entreprise / HSE, états (brouillon, en cours, terminé), mois passés repliés, brouillons oubliés rangés à part.
- Tournée : la zone sert de titre ; pastille « ZON » dans la barre de tournée.
- Plan : vues Audits / Actions / Zones · score, période (7 j, 30 j, 3 mois, tout), bulles de regroupement, fiche d'un lieu.
- Pilotage : HSE fusionnés (« jean » = « Jean »), 5 premiers + « Voir les autres », clic = ses audits.
- Action : épingle rouge, zone auditée dessinée, légende ; photo après correction affichée à la clôture.
- PDF : zoom serré sur la zone, nom de zone sous la zone, 2 logos (Projet → Logos du rapport).
- Pilotage : bloc « Infractions » (total + tendance, part des règles vitales LSR, entreprise la plus concernée ou classement) + Top 10 en barres, toutes entreprises ou une au choix ; export Excel avec colonne « Objectif ».

## Nouveautés v3.9
- **Lisibilité chantier** : textes agrandis (rien d'important sous 14 px), contrastes renforcés, Résumé lisible thème par thème.
- **Photos** : grandes vignettes, visionneuse plein écran (double-tap pour zoomer), **annotation** (flèche, cercle, trait, texte).
- **Bonnes pratiques** : sur un critère noté 5, ou depuis l'audit ; section verte dans le PDF.
- **Signature** du responsable de l'entreprise en fin d'audit, reprise dans le PDF.
- **Protection des données** : invitation à installer l'app sur l'écran d'accueil, rappel de sauvegarde hebdomadaire (mode sans compte), réglage « joindre les photos » pour l'envoi aux entreprises.

## Utilisation rapide
- Thème → gros boutons 0–5 / N/A (re-taper une note l'efface). Une note ≤ 2 propose une action corrective.
- Tout est enregistré automatiquement à chaque tap.
- Bouton **?** : barème (feuille Notes).
- **Exporter / Partager** : Excel (4 feuilles identiques à l'original), PDF (résumé, détail, photos, plan avec épingles, actions) → Mail, WhatsApp, Teams.
- Plan : filtres sous-traitant / type / thème / priorité / statut ; tap sur le plan = nouvelle observation libre à cet endroit.

## Mode équipe (connexion + l'admin HSE voit tout) — Supabase gratuit

Tant que `js/config.js` est vide, l'app fonctionne **100 % en local** (comme avant).
Une fois configurée :
- connexion par **email + mot de passe**, sur **invitation** de l'administrateur ;
- chaque **inspecteur** fait tout le processus et ne voit **que ses audits et actions** ;
- l'**administrateur HSE** voit **les audits de toute l'équipe** (plan, actions, classement, exports) et gère l'équipe (Réglages → Équipe) ;
- tout reste utilisable **hors ligne** : l'envoi se fait automatiquement au retour du réseau ;
- le cloisonnement est appliqué **par le serveur** (Row Level Security), pas seulement par l'app.

### Mise en route (≈ 15 min, une seule fois)
1. **Créer le projet** : supabase.com → *Start your project* → se connecter (idéalement avec le compte de l'admin HSE) → *New project* → nom `prt-hse`, région **Central EU (Frankfurt)**, mot de passe de base de données (à garder) → *Create*.
2. **Créer la base** : menu **SQL Editor** → *New query* → coller tout le fichier `supabase/schema.sql` → **remplacer `ADRESSE-EMAIL-ADMIN@exemple.com`** (tout en bas) par l'email de l'admin HSE → **Run**.
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
6. **L'admin HSE crée son compte TOUT DE SUITE après l'étape 2** (son invitation n'a pas de code : il faut fermer cette porte au plus vite) : ouvrir l'app → *Créer mon compte* avec son email → il est administrateur et envoie les entreprises et le plan au serveur.
7. **Inviter l'équipe** : Réglages → **Équipe et invitations** → nom + email → *Inviter* → envoyer le message à la personne. Le lien contient son **code d'invitation personnel** : sans lui, personne d'autre ne peut créer le compte à son adresse.

### Au quotidien
- **Bloquer un accès** : Réglages → Équipe → *Bloquer* (ses audits restent visibles pour l'admin).
- **Mot de passe oublié** : supprimer l'utilisateur dans Supabase (**Authentication → Users**) ; l'invitation reste valable (même lien, même code), il recrée son compte. (La réinitialisation par email demande un serveur mail d'entreprise branché sur Supabase.)
- **Gratuit** : 500 Mo de base (des dizaines de milliers d'audits), 1 Go de photos (≈ 5 000 photos), 50 000 utilisateurs/mois. Un projet gratuit est mis en pause après 7 jours sans activité : les données sont conservées, il suffit de le relancer depuis supabase.com.
- **Avec 15–20 HSE** : le 1 Go de photos gratuit sera plein en quelques semaines → passer au plan **Pro (25 $/mois)** : 100 Go de photos, 8 Go de base, plus de mise en pause, sauvegardes quotidiennes. À faire payer par le projet / Jan De Nul.
- **Pas de sauvegarde automatique** en gratuit : l'admin HSE fait régulièrement Réglages → *Excel — toutes les inspections* et *Sauvegarde complète*.
- **Données personnelles** : photos de chantier et noms de sous-traitants sont hébergés chez Supabase (UE). À valider avec Jan De Nul si nécessaire.

