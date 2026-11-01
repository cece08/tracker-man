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

  async create(settings: Settings) {
    const name = localStorage.getItem('tm_name');
    if (!name) return void this.router.navigate(['/']);
    this.busy.set(true);
    try {
      const code = await this.game.createSession(name, settings);
      this.router.navigate(['/session', code]);
    } catch (e) {
      this.toast.show('Erreur : ' + (e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
