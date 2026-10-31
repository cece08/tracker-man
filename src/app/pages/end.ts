import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { GameService } from '../core/game.service';
import { ToastService } from '../core/toast.service';
import { fmtClock } from '../core/utils';

@Component({
  selector: 'app-end',
  template: `
    <section class="screen">
      <div class="content center-content">
        <div class="end-title" [class]="huntedWin() ? 'hunted' : 'hunter'">
          {{ huntedWin() ? '🟢 Les chassés ont gagné !' : '🔴 Les chasseurs ont gagné !' }}
        </div>
        <p class="hint center">{{ subtitle() }}</p>

        <div class="card">
          <h3>🏆 Survivants</h3>
          <ul class="players">
            @for (p of game.alive(); track p.id) {
              <li><span class="name">{{ p.name }}</span><span class="tag hunted">Survivant</span></li>
            } @empty {
              <li><span class="name">Aucun survivant</span></li>
            }
          </ul>
        </div>

        <div class="card">
          <h3>🎯 Captures</h3>
          <ul class="log">
            @for (e of catches(); track e.id) {
              <li><time>{{ clock(e.t) }}</time><b>{{ e.data.victimName }}</b> attrapé par <b>{{ e.data.hunterName }}</b></li>
            } @empty {
              <li>Aucune capture.</li>
            }
          </ul>
        </div>

        @if (game.isHost()) {
          <button class="btn primary big" [disabled]="busy()" (click)="replay()">🔁 Rejouer (retour au salon)</button>
        }
        <button class="btn ghost big" (click)="quit()">Quitter</button>
      </div>
    </section>
  `,
})
export class EndView {
  readonly game = inject(GameService);
  private router = inject(Router);
  private toast = inject(ToastService);
  readonly clock = fmtClock;
  readonly busy = signal(false);

  readonly huntedWin = computed(() => this.game.session()?.winner !== 'hunters');
  readonly catches = computed(() => this.game.events().filter((e) => e.type === 'caught'));
  readonly subtitle = computed(() => {
    const m = this.game.me();
    if (!m) return '';
    if (m.role === 'hunted') return "Tu as survécu jusqu'au bout 🎉";
    if (m.initial_role === 'hunted') return `Tu as été attrapé par ${this.game.players()[m.caught_by ?? '']?.name ?? 'un chasseur'}.`;
    return 'Tu étais chasseur.';
  });

  async replay() {
    this.busy.set(true);
    try { await this.game.replay(); }
    catch (e) { this.toast.show((e as Error).message); }
    finally { this.busy.set(false); }
  }

  async quit() {
    await this.game.leave();
    this.router.navigate(['/']);
  }
}
