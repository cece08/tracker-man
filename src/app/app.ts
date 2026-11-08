import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { ToastService } from './core/toast.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    @if (toast.message(); as msg) {
      <div class="toast">{{ msg }}</div>
    }
    <router-outlet />
  `,
})
export class App implements OnInit {
  readonly toast = inject(ToastService);
  private readonly swUpdate = inject(SwUpdate);

  ngOnInit() {
    // Redirige les chemins directs (/mentions, /confidentialite) vers les routes hash (#/mentions, #/confidentialite)
    const p = location.pathname.replace(/\/+$/, '');
    if (p.endsWith('/mentions') && !location.hash.includes('/mentions')) {
      history.replaceState(null, '', location.pathname.replace(/\/mentions$/, '/') + '#/mentions');
    } else if (p.endsWith('/confidentialite') && !location.hash.includes('/confidentialite')) {
      history.replaceState(null, '', location.pathname.replace(/\/confidentialite$/, '/') + '#/confidentialite');
    }
    this.removeInjectedBadges();
    // Les badges injectés sont des enfants directs de <body> : inutile d'observer tout l'arbre DOM
    // (la carte Leaflet génère énormément de mutations et ralentissait l'appli).
    const obs = new MutationObserver(() => this.removeInjectedBadges());
    obs.observe(document.body, { childList: true });

    this.setupServiceWorkerRecovery();
  }

  /**
   * Évite l'écran blanc au lancement quand le cache du service worker est corrompu ou obsolète
   * (fichiers JS d'une ancienne version supprimés du serveur après un déploiement).
   */
  private setupServiceWorkerRecovery() {
    if (!this.swUpdate.isEnabled) return;
    this.swUpdate.unrecoverable.subscribe(() => {
      location.reload();
    });
    this.swUpdate.versionUpdates.subscribe((evt) => {
      if (evt.type !== 'VERSION_READY') return;
      // Ne recharge jamais en pleine partie : la mise à jour s'appliquera au prochain lancement.
      if (location.hash.includes('/session/')) return;
      void this.swUpdate.activateUpdate().then(() => location.reload());
    });
  }

  /** Supprime tout badge flottant injecté par l'hébergeur (ex. "Powered by Netlify"). */
  private removeInjectedBadges() {
    document.querySelectorAll('body > *:not(app-root):not(script):not(noscript)').forEach((el) => {
      const txt = (el.textContent ?? '').toLowerCase();
      const html = el.outerHTML.toLowerCase();
      if (txt.includes('netlify') || html.includes('netlify')) {
        el.remove();
      }
    });
  }
}
