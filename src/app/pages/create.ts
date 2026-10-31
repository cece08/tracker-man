import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { GameService } from '../core/game.service';
import { ToastService } from '../core/toast.service';
import { DEFAULT_SETTINGS, Settings } from '../core/models';

@Component({
  selector: 'app-create',
  imports: [RouterLink],
  template: `
    <section class="screen">
      <header class="topbar">
        <a class="btn icon" routerLink="/">←</a>
        <h2>Paramètres de la partie</h2>
      </header>
      <div class="content">
        <div class="card">
          <h3>⏱️ Durée</h3>
          <label class="field row"><span>Durée totale (min)</span>
            <input type="number" min="5" max="600" [value]="s().total" (input)="set('total', $event)" /></label>
          <label class="field row"><span>Avance des chassés (min)</span>
            <input type="number" min="0" max="60" [value]="s().headStart" (input)="set('headStart', $event)" /></label>
        </div>
        <div class="card">
          <h3>⭕ Cercles</h3>
          <label class="field row"><span>Rayon de départ (m)</span>
            <input type="number" min="20" max="10000" [value]="s().radiusStart" (input)="set('radiusStart', $event)" /></label>
          <label class="field row"><span>Rayon final (m)</span>
            <input type="number" min="10" max="10000" [value]="s().radiusEnd" (input)="set('radiusEnd', $event)" /></label>
          <label class="field row"><span>Rétrécit toutes les (min)</span>
            <input type="number" min="1" max="120" [value]="s().shrinkEvery" (input)="set('shrinkEvery', $event)" /></label>
        </div>
        <div class="card">
          <h3>🎭 Rôles</h3>
          <div class="segmented">
            <button [class.active]="s().roleMode === 'random'" (click)="mode('random')">Aléatoire</button>
            <button [class.active]="s().roleMode === 'manual'" (click)="mode('manual')">Choisis</button>
          </div>
          @if (s().roleMode === 'random') {
            <label class="field row"><span>Nombre de chasseurs</span>
              <input type="number" min="1" max="50" [value]="s().hunters" (input)="set('hunters', $event)" /></label>
          } @else {
            <p class="hint">Tu choisiras les chasseurs dans le salon en touchant les joueurs.</p>
          }
        </div>
        <button class="btn primary big" [disabled]="busy()" (click)="create()">Créer la session</button>
      </div>
    </section>
  `,
})
export class CreatePage {
  private game = inject(GameService);
  private router = inject(Router);
  private toast = inject(ToastService);

  readonly s = signal<Settings>({ ...DEFAULT_SETTINGS });
  readonly busy = signal(false);

  set(key: keyof Settings, e: Event) {
    const v = Math.round(Number((e.target as HTMLInputElement).value));
    this.s.update((s) => ({ ...s, [key]: v }));
  }

  mode(roleMode: Settings['roleMode']) {
    this.s.update((s) => ({ ...s, roleMode }));
  }

  private validate(): string | null {
    const st = this.s();
    if (!(st.total >= 5)) return "La durée totale doit être d'au moins 5 min.";
    if (!(st.headStart >= 0) || st.headStart >= st.total) return "L'avance doit être inférieure à la durée totale.";
    if (!(st.radiusStart >= 20)) return 'Le rayon de départ doit faire au moins 20 m.';
    if (!(st.radiusEnd >= 10) || st.radiusEnd > st.radiusStart) return 'Le rayon final doit être entre 10 m et le rayon de départ.';
    if (!(st.shrinkEvery >= 1)) return "L'intervalle de rétrécissement doit être d'au moins 1 min.";
    if (!(st.hunters >= 1)) return 'Il faut au moins 1 chasseur.';
    return null;
  }

  async create() {
    const name = localStorage.getItem('tm_name');
    if (!name) return void this.router.navigate(['/']);
    const err = this.validate();
    if (err) return this.toast.show(err);
    this.busy.set(true);
    try {
      const code = await this.game.createSession(name, this.s());
      this.router.navigate(['/session', code]);
    } catch (e) {
      this.toast.show('Erreur : ' + (e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
