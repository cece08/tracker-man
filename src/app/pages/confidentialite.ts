import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-confidentialite',
  imports: [RouterLink],
  template: `
    <section class="screen">
      <header class="topbar">
        <a class="btn icon" routerLink="/">←</a>
        <h2>Politique de Confidentialité</h2>
      </header>

      <div class="content legal-content">
        <div class="card legal-hero">
          <span class="legal-badge">Un service Paddock Actu</span>
          <h1>Politique de Confidentialité & Protection des Données</h1>
          <p class="hint">
            Application Web & PWA Tracker Man (sous la direction de Paddock Actu) — Architecture 100 % Peer-to-Peer E2EE (Zéro Base de Données) — Dernière mise à jour : 05/11/2026
          </p>
        </div>

        <div class="card legal-card">
          <h3>Engagement de confidentialité & Architecture « Zéro Serveur / Zéro Base de Données »</h3>
          <p>
            <b>Tracker Man</b>, service édité sous la direction de <b>Paddock Actu</b>, applique une architecture de sécurité de niveau gouvernemental (« <i>Privacy by Design, Zero-Knowledge & Serverless P2P</i> »), conforme au Règlement Général sur la Protection des Données (RGPD — UE 2016/679, articles 25 et 32), aux recommandations de la CNIL, de l'ANSSI, de l'ENISA et aux référentiels internationaux ISO/IEC 27001, ISO/IEC 27701, NIST FIPS 186-5 / SP 800-38D et OWASP ASVS Niveau 3.
          </p>
          <p>
            <b>Aucune base de données et aucun serveur de stockage n'existent :</b> toutes les communications (salon, positions, cercles radar et trajectoires) s'effectuent directement entre les appareils des participants de la session en mémoire vive (RAM), protégées par un <b>chiffrement de bout en bout (E2EE) AES-256-GCM</b> et des <b>signatures numériques asymétriques ECDSA P-256</b>.
          </p>
        </div>

        <div class="card legal-card">
          <h3>1. Présentation & Champ d'application</h3>
          <p>
            La présente Politique de Confidentialité s'applique au site web et à l'application web progressive (PWA) <b>Tracker Man</b> (ci-après le « Service »), rattachés à l'écosystème <b>Paddock Actu</b> (<a href="https://paddock-actu.com" target="_blank" rel="noopener">paddock-actu.com</a>).
          </p>
          <p>
            Elle informe les joueurs en toute transparence sur les protocoles cryptographiques Peer-to-Peer (P2P), l'absence totale de base de données et la volatilité immédiate des informations traitées en mémoire vive.
          </p>
        </div>

        <div class="card legal-card">
          <h3>2. Responsable du traitement & Développeur</h3>
          <p>
            Le Service est développé et édité sous la direction de Paddock Actu par :<br>
            <b>Célian MLUDEK</b> (personne physique / développeur indépendant)<br>
            <b>Adresse électronique de contact unique :</b> <a href="mailto:paddock.actu.f1@gmail.com">paddock.actu.f1@gmail.com</a>
          </p>
        </div>

        <div class="card legal-card">
          <h3>3. Données traitées en RAM & Protocoles Cryptographiques (Minimisation RGPD)</h3>
          <p>Conformément au principe de minimisation stricte (article 5 du RGPD), Tracker Man fonctionne <b>sans création de compte, sans base de données, sans adresse e-mail et sans mot de passe</b> :</p>
          <ul>
            <li>
              <b>Identité cryptographique éphémère & Signatures ECDSA P-256 :</b><br>
              <i>Données :</i> pseudonyme libre choisi par le joueur (1 à 20 caractères), identifiant aléatoire CSPRNG 128 bits (<code>tm_uid</code>) et paire de clés asymétriques <code>ECDSA P-256</code> générée localement par puce cryptographique (Web Crypto API).<br>
              <i>Finalité :</i> signer numériquement chaque action du joueur et de l'hôte afin de rendre toute usurpation d'identité mathématiquement impossible sans serveur central.
            </li>
            <li>
              <b>Géolocalisation Peer-to-Peer chiffrée de bout en bout (E2EE) & Accord de clés ECDH P-256 :</b><br>
              <i>Protocole cryptographique :</i> les clés de session sont dérivées localement sur votre appareil à partir du code de la partie via <code>PBKDF2-HMAC-SHA-256</code> (250 000 itérations) et <code>HKDF-SHA-256</code> avec accord de clés asymétrique <code>ECDH P-256</code> (NIST SP 800-56A Rev 3) garantissant une séparation cryptographique Zero-Knowledge absolue des rôles (la clé chasseur n'est distribuée qu'aux chasseurs vérifiés, la clé alliés qu'aux chassés). Chaque paquet est chiffré par <code>AES-256-GCM</code> (AEAD 256 bits avec vecteur d'initialisation CSPRNG 96 bits, tag d'authentification 128 bits, signature <code>ECDSA P-256</code> et protection anti-rejeu stricte 25s pour le direct).<br>
              <i>Floutage spatial CSPRNG :</i> tant qu'un joueur a le rôle « Chassé », sa position exacte ne quitte <b>jamais</b> son téléphone (sauf partage volontaire chiffré entre alliés chassés) ; seul un cercle radar dont le centre est décalé aléatoirement via générateur cryptographique (<code>crypto.getRandomValues</code>) est diffusé.<br>
              <i>Zéro base de données :</i> aucune coordonnée GPS, aucun cercle et aucune trajectoire n'est jamais sauvegardé sur un serveur. Tout existe uniquement dans la mémoire vive (RAM) des téléphones des participants pendant la session.
            </li>
            <li>
              <b>Données NON collectées :</b><br>
              Nous ne collectons <b>aucune</b> adresse e-mail, aucun nom civil obligatoire, aucun numéro de téléphone, aucune donnée bancaire, aucun carnet de contacts, aucune photo/audio et aucun historique de localisation.
            </li>
          </ul>
        </div>

        <div class="card legal-card">
          <h3>4. Permissions du navigateur & de la PWA</h3>
          <ul>
            <li><b>Géolocalisation précise (<code>navigator.geolocation</code>) :</b> traitée exclusivement en mémoire locale pendant une partie active. Vous pouvez la couper et la verrouiller en un clic depuis l'application ou dans les réglages de votre appareil.</li>
            <li><b>Maintien de l'écran allumé (<code>Screen Wake Lock</code>) :</b> utilisé uniquement pendant la partie (et en 🌙 Mode poche) pour éviter que la mise en veille du téléphone ne coupe la puce GPS.</li>
            <li><b>Notifications locales (facultatif) :</b> utilisées uniquement pour vous prévenir sur votre propre téléphone si vous verrouillez l'écran par erreur en pleine partie.</li>
          </ul>
        </div>

        <div class="card legal-card">
          <h3>5. Absence de vente de données & Absence de publicité</h3>
          <p>
            <b>Engagement formel de non-commercialisation :</b> Tracker Man et Paddock Actu ne vendent, ne louent, ne monétisent et ne cèdent aucune donnée personnelle ou de localisation à des tiers, des courtiers en données (data brokers) ou des régies publicitaires. L'application ne contient aucun SDK publicitaire ni traceur analytique tiers.
          </p>
        </div>

        <div class="card legal-card">
          <h3>6. Cookies & Stockage local chiffré (ePrivacy & CNIL)</h3>
          <p>
            <b>Aucun cookie publicitaire ou de profilage :</b> aucun bandeau de consentement publicitaire n'est requis car aucun traceur commercial n'est déposé.
          </p>
          <p>
            <b>Stockage technique strictement nécessaire & Coffre non-extractible :</b> vos clés privées asymétriques <code>ECDSA / ECDH P-256</code> sont isolées avec l'attribut de sécurité <code>extractable: false</code> dans le stockage <code>IndexedDB</code> natif de votre navigateur, rendant toute exfiltration de vos clés privées techniquement impossible même en cas d'attaque XSS. Tout état temporaire de manche en cours dans <code>sessionStorage</code> est chiffré en <code>AES-256-GCM</code> et détruit dès que vous quittez la partie ou fermez l'onglet.
          </p>
        </div>

        <div class="card legal-card">
          <h3>7. Architecture Réseau P2P & Mesures de sécurité (ANSSI / OWASP)</h3>
          <p>Le Service applique les standards de sécurité européens et internationaux les plus exigeants :</p>
          <ul>
            <li>
              <b>Protection applicative & Réseau :</b> politique stricte de sécurité du contenu (<code>Content-Security-Policy</code>), transport chiffré forcé <code>HSTS Preload</code> (TLS 1.3), isolation d'origine (<code>COOP / CORP</code>), politique <code>Referrer-Policy: strict-origin-when-cross-origin</code> et verrouillage des permissions matérielles (<code>Permissions-Policy</code>).
            </li>
            <li>
              <b>Transmission P2P directe & Routage aveugle :</b> les appareils des joueurs communiquent via des canaux directs <code>WebRTC DataChannel</code> (chiffrés <code>DTLS 1.3</code> + <code>AES-256-GCM</code>) et un routage WebSocket éphémère en mémoire vive (<code>QoS 0, Retain 0</code>) sur un identifiant de canal haché aveugle <code>SHA-256</code>, sans aucune persistance disque.
            </li>
            <li>
              <b>Netlify, Inc. :</b> hébergement uniquement des fichiers statiques de l'application web (HTML/JS/CSS) via CDN chiffré HTTPS/TLS (512 2nd Street, Suite 200, San Francisco, CA 94107, États-Unis — <a href="https://www.netlify.com/" target="_blank" rel="noopener">www.netlify.com</a>).
            </li>
          </ul>
        </div>

        <div class="card legal-card">
          <h3>8. Volatilité totale & Absence de conservation</h3>
          <ul>
            <li><b>Zéro base de données :</b> aucune donnée de session, de joueur ou de localisation n'étant stockée sur un serveur, la fermeture de la session ou du navigateur par les joueurs entraîne la disparition immédiate et totale de toutes les données de la partie (effacement de la mémoire vive RAM).</li>
            <li><b>Sur votre appareil :</b> vous pouvez effacer votre pseudonyme local à tout moment en vidant les données du site dans votre navigateur.</li>
          </ul>
        </div>

        <div class="card legal-card">
          <h3>9. Protection des mineurs</h3>
          <p>
            Tracker Man ne collecte aucune donnée nominative ni coordonnée de contact. La participation de mineurs à une partie en extérieur doit se faire sous la surveillance et la responsabilité de leurs parents ou représentants légaux. Pour toute demande d'information, contactez <a href="mailto:paddock.actu.f1@gmail.com">paddock.actu.f1@gmail.com</a>.
          </p>
        </div>

        <div class="card legal-card">
          <h3>10. Vos droits RGPD (Articles 15 à 22) & CNIL</h3>
          <p>
            Vous disposez à tout moment d'un droit d'accès, de rectification, d'effacement (« droit à l'oubli »), de limitation et d'opposition en écrivant à :
            <a href="mailto:paddock.actu.f1@gmail.com">paddock.actu.f1@gmail.com</a>.
          </p>
          <p>
            Vous disposez également du droit d'introduire une réclamation auprès de la CNIL (<a href="https://www.cnil.fr" target="_blank" rel="noopener">www.cnil.fr</a>).
            Pour consulter les informations sur l'éditeur et les règles d'utilisation du jeu, rendez-vous sur nos <a routerLink="/mentions">Mentions Légales & CGU</a>.
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
export class ConfidentialitePage {}
