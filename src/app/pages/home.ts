import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { GameService } from '../core/game.service';
import { sanitizeName } from '../core/crypto.service';
import { ToastService } from '../core/toast.service';
import { PwaService } from '../core/pwa.service';

@Component({
  selector: 'app-home',
  imports: [RouterLink],
  template: `
    <section class="screen">
      <div class="home-wrap">
        <div class="logo">
          <img src="icons/icon-192x192.png" alt="" />
          <h1>Tracker <span>Man</span></h1>
          <p class="tagline">Le cache-cache géant grandeur nature au radar GPS</p>
          <p class="intro-desc">
            Cache-toi ou pars à la recherche de tes amis dans la vraie vie : les chercheurs traquent les cachés grâce à des zones radar qui rétrécissent au fil du temps !
          </p>
        </div>

        @if (savedCode()) {
          <button class="btn secondary big" (click)="resume()">↩️ Reprendre la partie {{ savedCode() }}</button>
        }

        <label class="field">
          <span>Ton pseudo</span>
          <input #nameInput type="text" maxlength="20" placeholder="Ex : Renard" autocomplete="nickname"
                 [value]="name()" (input)="name.set($any($event.target).value)" (keyup.enter)="onNameEnter()" />
        </label>

        @if (fromQr()) {
          <div class="card qr-join-banner">
            <p style="margin:0 0 8px">📲 Session détectée : <b>{{ code() }}</b></p>
            <button class="btn primary big" [disabled]="busy()" (click)="join()">🚀 Rejoindre la session {{ code() }}</button>
          </div>
        }

        <button class="btn primary big" (click)="goCreate()">🎯 Créer une session</button>

        <div class="divider"><span>ou</span></div>

        <label class="field">
          <span>Code de session</span>
          <input type="text" maxlength="6" placeholder="ABC123" autocomplete="off" class="code-input"
                 [value]="code()" (input)="onCode($event)" (keyup.enter)="join()" />
        </label>
        <button class="btn secondary big" [disabled]="busy()" (click)="join()">🚪 Rejoindre</button>

        @if (pwa.canInstall()) {
          <button class="btn ghost" (click)="pwa.install()">📲 Installer l'application</button>
        }

        <footer class="home-legal-footer">
          <div class="legal-footer-links">
            <a routerLink="/mentions">Mentions Légales & CGU</a>
            <span>•</span>
            <a routerLink="/confidentialite">Politique de Confidentialité</a>
          </div>
          <div class="legal-sub">Un service <a href="https://paddock-actu.com" target="_blank" rel="noopener">Paddock Actu</a> — © 2026 @Célian MLUDEK</div>
        </footer>
      </div>
    </section>
  `,
})
export class HomePage {
  private game = inject(GameService);
  private router = inject(Router);
  private toast = inject(ToastService);
  readonly pwa = inject(PwaService);

  readonly name = signal(localStorage.getItem('tm_name') ?? '');
  readonly code = signal('');
  readonly fromQr = signal(false);
  readonly savedCode = signal(localStorage.getItem('tm_code'));
  readonly busy = signal(false);

  constructor() {
    const route = inject(ActivatedRoute);
    const hashParams = new URLSearchParams(location.hash.replace(/^[#/?]+/, '?'));
    const paramCode = (
      route.snapshot.queryParamMap.get('code') ??
      hashParams.get('code') ??
      new URLSearchParams(location.search).get('code') ??
      ''
    ).toUpperCase().replace(/[^A-Z0-9]/g, '');

    const keyToken = route.snapshot.queryParamMap.get('k') ?? hashParams.get('k') ?? new URLSearchParams(location.search).get('k');
    if (paramCode.length === 6) {
      this.code.set(paramCode);
      this.fromQr.set(true);
      if (keyToken) {
        try { sessionStorage.setItem(`tm_sk_${paramCode}`, keyToken); } catch { /* ignore */ }
      }
      if (this.name().trim() && this.game.configured) {
        setTimeout(() => this.join(), 150);
      }
    }
  }

  onNameEnter() {
    if (this.code().length === 6) this.join();
  }

  onCode(e: Event) {
    const input = e.target as HTMLInputElement;
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    this.code.set(input.value);
  }

  private checkName(): string | null {
    const n = sanitizeName(this.name());
    if (!n) { this.toast.show("Entre ton pseudo d'abord 🙂"); return null; }
    if (!this.game.configured) { this.toast.show("Application non initialisée."); return null; }
    try { localStorage.setItem('tm_name', n); } catch { /* ignore */ }
    return n;
  }

  goCreate() {
    if (this.checkName()) this.router.navigate(['/create']);
  }

  resume() {
    this.router.navigate(['/session', this.savedCode()]);
  }

  async join() {
    const name = this.checkName();
    if (!name) return;
    const code = this.code().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) return this.toast.show('Le code fait 6 caractères.');
    this.busy.set(true);
    try {
      await this.game.join(code, name);
      this.router.navigate(['/session', code]);
    } catch (e) {
      this.toast.show((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
