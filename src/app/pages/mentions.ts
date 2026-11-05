import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-mentions',
  imports: [RouterLink],
  template: `
    <section class="screen">
      <header class="topbar">
        <a class="btn icon" routerLink="/">←</a>
        <h2>Mentions Légales & CGU</h2>
      </header>

      <div class="content legal-content">
        <div class="card legal-hero">
          <span class="legal-badge">Un service Paddock Actu</span>
          <h1>Mentions Légales & Conditions Générales d'Utilisation</h1>
          <p class="hint">
            Conformité LCEN n° 2004-575, RGPD (UE 2016/679), ANSSI / ENISA & Code de la Propriété Intellectuelle — Dernière mise à jour : 05/11/2026
          </p>
        </div>

        <div class="card warn-card">
          <b>⚠️ Avertissement de sécurité physique & Responsabilité en jeu réel</b>
          <p class="hint" style="color:var(--text); line-height:1.5">
            <b>Tracker Man</b> est une application web (PWA) de cache-cache grandeur nature assistée par radar GPS.
            L'utilisation du service en extérieur s'effectue sous la responsabilité exclusive des participants :
            respectez en toutes circonstances le Code de la route, les propriétés privées, les arrêtés municipaux et votre environnement.
            Ne regardez jamais votre écran en traversant une chaussée ou en vous déplaçant dans une zone dangereuse.
          </p>
        </div>

        <div class="card legal-card">
          <h3>1. Éditeur du site & Rattachement à Paddock Actu</h3>
          <p>
            Le présent site et l'application web progressive (PWA) <b>Tracker Man</b> sont un service ludique édité et placé sous la direction de <b>Paddock Actu</b> (<a href="https://paddock-actu.com" target="_blank" rel="noopener">paddock-actu.com</a>).
          </p>
          <p>
            <b>Éditeur :</b> Célian MLUDEK<br>
            Personne physique / Développeur et éditeur de services de communication au public en ligne à titre non professionnel (au sens de l'article 6-III-2 de la loi n° 2004-575 du 21 juin 2004 pour la confiance dans l'économie numérique — LCEN).<br>
            <b>Directeur de la publication :</b> Célian MLUDEK<br>
            <b>Entité de rattachement :</b> Paddock Actu<br>
            <b>Adresse e-mail de contact :</b> <a href="mailto:paddock.actu.f1@gmail.com">paddock.actu.f1@gmail.com</a>
          </p>
        </div>

        <div class="card legal-card">
          <h3>2. Hébergement statique & Architecture Sans Base de Données (P2P)</h3>
          <p>Conformément à l'article 6-III-1-b de la LCEN :</p>
          <ul>
            <li>
              <b>Hébergement statique Frontend & Distribution CDN sécurisée :</b><br>
              Netlify, Inc.<br>
              512 2nd Street, Suite 200, San Francisco, CA 94107, États-Unis<br>
              Site web : <a href="https://www.netlify.com/" target="_blank" rel="noopener">www.netlify.com</a>
            </li>
            <li>
              <b>Absence de serveur de base de données (Architecture 100 % Peer-to-Peer E2EE) :</b><br>
              Tracker Man fonctionne sans aucune base de données centrale. Les échanges temps réel s'effectuent directement entre les terminaux des joueurs via <code>WebRTC DataChannels</code> et routage éphémère chiffré de bout en bout (<code>AES-256-GCM</code> + <code>ECDSA P-256</code>).
            </li>
            <li>
              <b>Fonds cartographiques (avec politique <code>no-referrer</code>) :</b><br>
              Contributeurs OpenStreetMap (<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">www.openstreetmap.org</a>) via la bibliothèque open-source Leaflet.
            </li>
          </ul>
        </div>

        <div class="card legal-card">
          <h3>3. Propriété intellectuelle</h3>
          <p>
            <b>Éléments originaux du Service :</b> La structure générale, le code source Angular, les protocoles cryptographiques P2P E2EE, les algorithmes de calcul de zones radar décalées par CSPRNG, l'ergonomie visuelle, le graphisme ainsi que les marques et logos <b>Tracker Man</b> et <b>Paddock Actu</b> sont protégés par le Code de la Propriété Intellectuelle (articles L.111-1 et suivants).
          </p>
          <p>
            Toute reproduction, représentation, diffusion ou exploitation commerciale partielle ou totale sans accord préalable écrit de l'éditeur est strictement interdite (art. L.335-2 du CPI).
          </p>
        </div>

        <div class="card legal-card">
          <h3>4. Nature du service & Architecture de Sécurité P2P E2EE</h3>
          <p>
            Tracker Man permet à un groupe d'amis de créer ou rejoindre une session éphémère via un code à 6 caractères ou un QR code afin d'organiser une partie de cache-cache géolocalisée :
          </p>
          <ul>
            <li><b>Zéro base de données & Zéro sauvegarde serveur :</b> Aucune coordonnée GPS ni aucune trajectoire n'est enregistrée sur un serveur. Toutes les données géographiques transitent exclusivement en mémoire vive (RAM) chiffrée de bout en bout (<code>AES-256-GCM</code>).</li>
            <li><b>Séparation cryptographique des rôles :</b> Pendant la partie, la position exacte des joueurs « Chassés » n'est jamais transmise aux « Chasseurs » (seul un cercle radar au centre décalé par générateur cryptographique CSPRNG est partagé), et les positions des chasseurs sont chiffrées avec une clé dédiée inaccessible aux chassés.</li>
            <li><b>Récapitulatif éphémère en mémoire vive :</b> En fin de partie uniquement, le bilan des trajectoires est échangé directement en P2P chiffré entre les participants connectés à la session et disparaît dès la fermeture de la partie.</li>
          </ul>
        </div>

        <div class="card legal-card">
          <h3>5. Conditions Générales d'Utilisation (CGU) & Règles de comportement</h3>
          <p>L'accès et l'utilisation de Tracker Man impliquent l'acceptation pleine et entière des présentes conditions :</p>
          <ul>
            <li><b>Accès sans création de compte :</b> Le service est gratuit et fonctionne sans inscription par e-mail ni mot de passe. Une paire de clés asymétriques <code>ECDSA P-256</code> locale protège votre session contre l'usurpation.</li>
            <li><b>Usage loyal & Interdictions :</b> Il est strictement interdit d'utiliser Tracker Man à des fins de surveillance, de filature ou de géolocalisation d'une personne sans son consentement libre, éclairé et explicite.</li>
            <li><b>Sécurité informatique :</b> L'utilisateur s'interdit tout comportement malveillant, toute falsification de coordonnées GPS (spoofing), toute tentative d'intrusion et tout pseudonyme injurieux, haineux ou diffamatoire.</li>
            <li><b>Sécurité sur le terrain :</b> Les joueurs s'engagent à pratiquer le jeu uniquement dans des lieux publics sûrs et autorisés, sans jamais se mettre en danger ni troubler l'ordre public. L'éditeur décline toute responsabilité en cas d'accident, de chute, d'infraction ou de dommage matériel ou corporel survenant lors d'une partie.</li>
          </ul>
        </div>

        <div class="card legal-card">
          <h3>6. Données personnelles (RGPD), Géolocalisation & Cookies</h3>
          <p>
            Tracker Man et Paddock Actu appliquent une politique stricte de minimisation des données et de chiffrement de bout en bout conformément au Règlement Général sur la Protection des Données (RGPD — UE 2016/679, articles 25 et 32).
          </p>
          <p>
            Les coordonnées GPS ne sont traitées qu'en mémoire vive pendant la durée active de votre partie, uniquement avec votre autorisation système explicite, et ne sont jamais stockées sur serveur. Aucune donnée n'est vendue ni utilisée à des fins publicitaires.
            Pour consulter le détail complet de l'architecture cryptographique et vos droits, consultez notre <a routerLink="/confidentialite">Politique de Confidentialité (Conforme RGPD & ANSSI)</a>.
          </p>
          <p>
            <b>Absence de cookies publicitaires :</b> Le Site ne dépose aucun cookie publicitaire, aucun cookie de profilage commercial ni traceur tiers.
          </p>
        </div>

        <div class="card legal-card">
          <h3>7. Signalement d'abus (LCEN) & Contact</h3>
          <p>
            Conformément à l'article 6-I-5 de la LCEN, tout abus ou contenu illicite peut être signalé à tout moment à l'adresse :
            <a href="mailto:paddock.actu.f1@gmail.com">paddock.actu.f1@gmail.com</a>.
          </p>
        </div>

        <div class="card legal-card">
          <h3>8. Droit applicable et juridiction compétente</h3>
          <p>
            Les présentes mentions légales et CGU sont régies par le droit français. En cas de litige, les parties s'engagent à rechercher une solution amiable avant toute action devant les tribunaux français compétents.
          </p>
        </div>

        <footer class="legal-footer">
          <div class="legal-footer-links">
            <a routerLink="/">Accueil Tracker Man</a>
            <span>•</span>
            <a routerLink="/mentions">Mentions Légales & CGU</a>
            <span>•</span>
            <a routerLink="/confidentialite">Politique de Confidentialité</a>
            <span>•</span>
            <a href="https://paddock-actu.com" target="_blank" rel="noopener">Paddock Actu</a>
          </div>
          <p class="hint center">© 2026 Paddock Actu — @Célian MLUDEK</p>
        </footer>
      </div>
    </section>
  `,
})
export class MentionsPage {}
