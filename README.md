# 🎯 Tracker Man

Chasse à l'homme GPS en temps réel, construite avec **Angular 21**, **Supabase** (PostgreSQL + Realtime + Presence) et **Leaflet**. Installable sur PC et téléphone (PWA).

## Principe

1. Un joueur **crée une session** (durée, avance des chassés, rayon des cercles, fréquence de rétrécissement, rôles aléatoires ou choisis) → un **code à 6 caractères** est généré.
2. Les autres **rejoignent** avec ce code (ou via le lien partagé).
3. L'hôte **lance la partie** : chaque joueur devient **chasseur 🔴** ou **chassé 🟢**.
4. Pendant l'**avance**, les chasseurs ne voient rien : les chassés se cachent.
5. Ensuite, les chasseurs voient pour chaque chassé un **cercle GPS approximatif** (le chassé est quelque part dedans) qui se met à jour en direct.
6. Les cercles **rétrécissent** à intervalles réguliers jusqu'au rayon final.
7. Quand un chassé est attrapé, il appuie sur **« J'ai été trouvé »** et saisit le **code chasseur** (4 chiffres affichés sur l'écran du chasseur). Il devient chasseur à son tour.
8. À la fin du temps, **les chassés restants gagnent**. Si tous sont attrapés avant, les chasseurs gagnent.

> Le vrai point GPS des chassés n'est jamais envoyé : seul le centre (décalé aléatoirement) du cercle est stocké.

## Mise en place (une seule fois)

### 1. Supabase (gratuit)

1. Crée un projet sur <https://supabase.com/dashboard>.
2. Dans **SQL Editor → New query**, colle tout le contenu de [`supabase/schema.sql`](supabase/schema.sql) puis clique **Run** (cela crée les tables `sessions`, `players`, `events`, active le temps réel et ajoute les fonctions SQL).
3. Dans **Project Settings → API** (ou le bouton **Connect** en haut) :
   - copie **Project URL** (`https://xxxx.supabase.co`) ;
   - copie la clé **anon / public** (ou **publishable**).
4. Colle ces deux valeurs dans [`src/app/supabase.config.ts`](src/app/supabase.config.ts).

### 2. GitHub Pages

Le workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) compile Angular et déploie automatiquement à chaque `git push` sur `main` :

1. Sur GitHub : **Settings → Pages → Build and deployment → Source : GitHub Actions**.
2. Le site est publié sur `https://cece08.github.io/tracker-man/`.

### 3. Installer sur téléphone

- **Android (Chrome)** : ouvre le site → bouton « Installer l'application » ou menu ⋮ → *Ajouter à l'écran d'accueil*.
- **iPhone (Safari)** : bouton Partager → *Sur l'écran d'accueil*.

## Développement local

```bash
npm install
npm start
```

Puis ouvre <http://localhost:4200>.

## Structure

```
src/app/
  supabase.config.ts     URL + clé publique Supabase
  core/
    models.ts            Interfaces TypeScript
    game.service.ts      État réactif (signals) + Supabase Realtime + GPS
    pwa.service.ts       Installation PWA
    toast.service.ts     Notifications
    utils.ts             Calculs géographiques (haversine) & formatage
  pages/
    home.ts              Accueil (créer / rejoindre)
    create.ts            Paramètres de la session
    session.ts           Conteneur de session
    lobby.ts             Salon d'attente
    game.ts              Carte Leaflet + HUD + capture
    end.ts               Écran de fin & rejouer
supabase/
  schema.sql             Schéma PostgreSQL + RLS + Realtime + fonctions RPC
```
