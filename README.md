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
js/sync.js                                → point d'extension Supabase / SharePoint (vide en V1)
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

## 3. Importer le premier plan et les sous-traitants
**Plan**
1. Envoyer le plan SAM2 (PDF ou image) sur l'iPhone (mail, Teams, Fichiers…) et l'enregistrer dans **Fichiers**.
2. App → **Accueil → Plans** (ou Réglages → Gérer les plans) → **Importer un plan** → choisir le fichier.
3. Si le PDF a plusieurs pages, choisir la page. Vérifier le **Code** (ex. `SAM2`) : il sert à générer les références `PRT-SAM2-2026-001`.
4. Ajouter d'autres plans (SAM3…) de la même façon.

**Sous-traitants**
- Un par un : **Sous-trait. → ＋ Ajouter** → nom, société, responsable, téléphone, couleur, logo.
- En masse : **Sous-trait. → Import rapide** → coller une ligne par sous-traitant :
  `Nom ; Société ; Responsable ; Téléphone` (ou copier-coller 4 colonnes depuis Excel).

**Première inspection** : Accueil → **Nouvelle inspection** → sous-traitant → plan → tap sur la zone → **Démarrer**.

## Utilisation rapide
- Thème → gros boutons 0–5 / N/A (re-taper une note l'efface). Une note ≤ 2 propose une action corrective.
- Tout est enregistré automatiquement à chaque tap.
- Bouton **?** : barème (feuille Notes).
- **Exporter / Partager** : Excel (4 feuilles identiques à l'original), PDF (résumé, détail, photos, plan avec épingles, actions) → Mail, WhatsApp, Teams.
- Plan : filtres sous-traitant / type / thème / priorité / statut ; tap sur le plan = nouvelle observation libre à cet endroit.

## Synchronisation future
Tous les enregistrements ont un UUID, `createdAt`, `updatedAt` et une suppression logique (`deleted`). Chaque écriture est journalisée dans le store `outbox`. Brancher un adaptateur `push/pull` dans `js/sync.js` (Supabase ou Microsoft Graph pour SharePoint) suffit pour synchroniser.
