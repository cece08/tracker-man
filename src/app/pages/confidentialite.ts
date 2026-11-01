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
            Application Web & PWA Tracker Man (sous la direction de Paddock Actu) — Dernière mise à jour : 01/11/2026
          </p>
        </div>

        <div class="card legal-card">
          <h3>Engagement de confidentialité & Protection de la vie privée</h3>
          <p>
            <b>Tracker Man</b>, service édité sous la direction de <b>Paddock Actu</b>, s'engage formellement à garantir la confidentialité et la sécurité des données de ses utilisateurs, conformément au Règlement Général sur la Protection des Données (RGPD — UE 2016/679) et aux recommandations de la CNIL.
          </p>
        </div>

        <div class="card legal-card">
          <h3>1. Présentation & Champ d'application</h3>
          <p>
            La présente Politique de Confidentialité s'applique au site web et à l'application web progressive (PWA) <b>Tracker Man</b> (ci-après le « Service »), rattachés à l'écosystème <b>Paddock Actu</b> (<a href="https://paddock-actu.com" target="_blank" rel="noopener">paddock-actu.com</a>).
          </p>
          <p>
            Elle informe les joueurs en toute transparence sur les modalités de collecte, d'utilisation en temps réel, de sécurisation et de suppression automatique des données traitées lors d'une partie.
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
          <h3>3. Données collectées & Finalités (Minimisation RGPD)</h3>
          <p>Conformément au principe de minimisation des données (article 5 du RGPD), Tracker Man fonctionne <b>sans création de compte, sans adresse e-mail et sans mot de passe</b>. Seules les données techniques suivantes sont traitées pendant une session :</p>
          <ul>
            <li>
              <b>Pseudonyme de jeu & Identifiant technique aléatoire :</b><br>
              <i>Données :</i> pseudonyme libre choisi par le joueur (1 à 20 caractères), identifiant aléatoire (<code>tm_uid</code>) et empreinte SHA-256 d'un jeton secret local (<code>tm_secret</code>).<br>
              <i>Finalité :</i> afficher les participants dans le salon et empêcher toute usurpation d'identité ou d'hôte pendant la partie.
            </li>
            <li>
              <b>Données de géolocalisation (GPS) pendant la partie :</b><br>
              <i>Données :</i> coordonnées GPS du terminal lorsque la partie est à l'état « en cours ».<br>
              <i>Protection de la position en cours de jeu :</i> tant qu'un joueur a le rôle « Chassé », sa position exacte n'est <b>jamais</b> envoyée aux « Chasseurs » ; seul un cercle radar dont le centre est décalé aléatoirement est transmis à la base temps réel (sauf activation volontaire par le joueur du partage entre alliés chassés).<br>
              <i>Récapitulatif de fin de partie :</i> la trace de la manche est conservée localement sur l'appareil pendant le jeu et n'est partagée avec les participants de la session qu'une fois la partie terminée, afin d'afficher la carte récapitulative et la distance parcourue.
            </li>
            <li>
              <b>Données NON collectées :</b><br>
              Nous ne collectons <b>aucune</b> adresse e-mail, aucun nom civil obligatoire, aucun numéro de téléphone, aucune donnée bancaire, aucun carnet de contacts, aucune photo/audio et aucune géolocalisation en arrière-plan lorsque vous avez quitté la session.
            </li>
          </ul>
        </div>

        <div class="card legal-card">
          <h3>4. Permissions du navigateur & de la PWA</h3>
          <ul>
            <li><b>Géolocalisation précise (<code>navigator.geolocation</code>) :</b> requise uniquement pendant une partie active pour calculer votre cercle radar, vérifier le maintien dans la zone autorisée et tracer le bilan de fin de manche. Vous pouvez la révoquer à tout moment dans les réglages de votre navigateur ou téléphone.</li>
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
          <h3>6. Cookies & Stockage local (ePrivacy & CNIL)</h3>
          <p>
            <b>Aucun cookie publicitaire ou de profilage :</b> aucun bandeau de consentement publicitaire n'est requis car aucun traceur commercial n'est déposé.
          </p>
          <p>
            <b>Stockage technique strictement nécessaire (<code>localStorage</code>) :</b> seuls votre pseudonyme, le code de la session en cours, votre jeton de sécurité local et les points temporaires de la manche en cours sont stockés sur votre appareil. Ces éléments techniques sont exemptés de consentement conformément à l'article 82 de la loi Informatique et Libertés.
          </p>
        </div>

        <div class="card legal-card">
          <h3>7. Sous-traitants certifiés & Sécurité des données</h3>
          <p>Vos données sont traitées sur des infrastructures conformes aux normes internationales de sécurité les plus strictes :</p>
          <ul>
            <li>
              <b>Netlify, Inc. :</b> hébergement web frontend, distribution de contenu (CDN) et fonctions serverless sécurisées (512 2nd Street, Suite 200, San Francisco, CA 94107, États-Unis — <a href="https://www.netlify.com/" target="_blank" rel="noopener">www.netlify.com</a>) avec chiffrement HTTPS/TLS et application des en-têtes de sécurité.
            </li>
            <li>
              <b>Supabase, Inc. :</b> hébergement de la base de données PostgreSQL et des canaux temps réel (970 Toa Payoh North #07-04, Singapour 318992 — <a href="https://www.supabase.com/" target="_blank" rel="noopener">www.supabase.com</a>) avec chiffrement de bout en bout en transit (TLS 1.3 / HTTPS) et au repos (AES-256), protégés par des politiques Row Level Security (RLS) en lecture seule et des procédures stockées sécurisées (<code>SECURITY DEFINER</code>).
            </li>
          </ul>
        </div>

        <div class="card legal-card">
          <h3>8. Durée de conservation & Suppression immédiate des données</h3>
          <ul>
            <li><b>En quittant la session (In-App) :</b> dès que vous cliquez sur « Quitter » (ou lorsque tous les joueurs quittent la session), votre joueur et la session complète (y compris les positions et trajectoires) sont immédiatement supprimés de la base de données par cascade (<code>ON DELETE CASCADE</code>).</li>
            <li><b>Purge automatique :</b> les sessions abandonnées sont automatiquement purgées au-delà de 48 heures via la fonction de nettoyage <code>cleanup_old_sessions()</code>.</li>
            <li><b>Sur votre appareil :</b> vous pouvez effacer vos données locales à tout moment en vidant les données du site dans votre navigateur ou par simple demande à <a href="mailto:paddock.actu.f1@gmail.com">paddock.actu.f1@gmail.com</a>.</li>
          </ul>
        </div>

        <div class="card legal-card">
          <h3>9. Protection des mineurs</h3>
          <p>
            Tracker Man ne collecte aucune donnée nominative ni coordonnée de contact. La participation de mineurs à une partie en extérieur doit se faire sous la surveillance et la responsabilité de leurs parents ou représentants légaux. Pour toute demande de suppression, contactez <a href="mailto:paddock.actu.f1@gmail.com">paddock.actu.f1@gmail.com</a>.
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
