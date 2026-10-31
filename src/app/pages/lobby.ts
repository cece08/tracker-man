import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { GameService } from '../core/game.service';
import { ToastService } from '../core/toast.service';
import { Player } from '../core/models';

@Component({
  selector: 'app-lobby',
  template: `
    <section class="screen">
      <header class="topbar">
        <button class="btn icon" (click)="leave()">✕</button>
        <h2>Salon</h2>
      </header>
      <div class="content">
        <div class="card code-card">
          <p>Code de la session</p>
          <div class="big-code">{{ s().code }}</div>
          <button class="btn ghost small" (click)="share()">🔗 Partager</button>
        </div>

        <div class="card">
          <h3>Paramètres</h3>
          <ul class="settings-list">
            <li>Durée : <b>{{ s().settings.total }} min</b></li>
            <li>Avance : <b>{{ s().settings.headStart }} min</b></li>
            <li>Rayon : <b>{{ s().settings.radiusStart }} → {{ s().settings.radiusEnd }} m</b></li>
            <li>Rétrécit : <b>toutes les {{ s().settings.shrinkEvery }} min</b></li>
            <li>Rôles : <b>{{ s().settings.roleMode === 'random' ? 'Aléatoire (' + s().settings.hunters + ' chasseur' + (s().settings.hunters > 1 ? 's' : '') + ')' : "Choisis par l'hôte" }}</b></li>
          </ul>
        </div>

        <div class="card">
          <h3>Joueurs ({{ game.sortedPlayers().length }})</h3>
          @if (manual() && game.isHost()) { <p class="hint">Touche un joueur pour changer son rôle.</p> }
          <ul class="players">
            @for (p of game.sortedPlayers(); track p.id) {
              <li [class.clickable]="manual() && game.isHost()" (click)="toggle(p)">
                <span class="dot" [class.on]="game.online().has(p.id)"></span>
                <span class="name">{{ p.name }}@if (p.id === s().host_id) { 👑 }@if (p.id === game.uid) { (toi) }</span>
                @if (manual()) {
                  <span class="tag" [class]="p.role">{{ p.role === 'hunter' ? 'Chasseur' : 'Chassé' }}</span>
                } @else {
                  <span class="tag">?</span>
                }
              </li>
            }
          </ul>
        </div>

        @if (game.isHost()) {
          <button class="btn primary big" [disabled]="game.sortedPlayers().length < 2 || busy()" (click)="start()">
            {{ game.sortedPlayers().length < 2 ? "En attente d'au moins 2 joueurs…" : '🚀 Lancer la partie' }}
          </button>
        } @else {
          <p class="hint center">En attente du lancement par l'hôte…</p>
        }
      </div>
    </section>
  `,
})
export class LobbyView {
  readonly game = inject(GameService);
  private toast = inject(ToastService);
  private router = inject(Router);

  readonly s = computed(() => this.game.session()!);
  readonly manual = computed(() => this.s().settings.roleMode === 'manual');
  readonly busy = signal(false);

  toggle(p: Player) {
    if (this.manual() && this.game.isHost()) this.game.toggleRole(p);
  }

  async start() {
    this.busy.set(true);
    try { await this.game.start(); }
    catch (e) { this.toast.show((e as Error).message); }
    finally { this.busy.set(false); }
  }

  async share() {
    const code = this.s().code;
    const url = `${location.origin}${location.pathname}#/?code=${code}`;
    const text = `Rejoins ma partie Tracker Man ! Code : ${code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Tracker Man', text, url });
      else { await navigator.clipboard.writeText(`${text}\n${url}`); this.toast.show('Lien copié !'); }
    } catch { /* partage annulé */ }
  }

  async leave() {
    if (!confirm('Quitter la session ?')) return;
    await this.game.leave();
    this.router.navigate(['/']);
  }
}
