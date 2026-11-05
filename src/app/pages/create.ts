import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { GameService } from '../core/game.service';
import { ToastService } from '../core/toast.service';
import { DEFAULT_SETTINGS, Settings } from '../core/models';
import { SettingsEditor } from './settings-editor';

@Component({
  selector: 'app-create',
  imports: [RouterLink, SettingsEditor],
  template: `
    <section class="screen">
      <header class="topbar">
        <a class="btn icon" routerLink="/">←</a>
        <h2>Paramètres de la partie</h2>
      </header>
      <div class="content">
        <app-settings-editor
          [initial]="defaultSettings"
          submitLabel="Créer la session"
          [busy]="busy()"
          (save)="create($event)" />
      </div>
    </section>
  `,
})
export class CreatePage {
  private game = inject(GameService);
  private router = inject(Router);
  private toast = inject(ToastService);

  readonly defaultSettings = DEFAULT_SETTINGS;
  readonly busy = signal(false);

  constructor() {
    this.toast.show('⚠️ Une mise à jour est en cours : réouverture prévue le 12 novembre', 4500);
    this.router.navigate(['/']);
  }

  async create(_settings: Settings) {
    this.toast.show('⚠️ Une mise à jour est en cours : réouverture prévue le 12 novembre', 4500);
    this.router.navigate(['/']);
  }
}
