import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { GameService } from './core/game.service';
import { ToastService } from './core/toast.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    @if (!game.configured) {
      <div class="banner">
        ⚠️ Supabase n'est pas configuré. Renseigne <code>src/app/supabase.config.ts</code> (voir README).
      </div>
    }
    @if (toast.message(); as msg) {
      <div class="toast">{{ msg }}</div>
    }
    <router-outlet />
  `,
})
export class App implements OnInit {
  readonly game = inject(GameService);
  readonly toast = inject(ToastService);

  ngOnInit() {
    this.removeInjectedBadges();
    const obs = new MutationObserver(() => this.removeInjectedBadges());
    obs.observe(document.documentElement, { childList: true, subtree: true });
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
