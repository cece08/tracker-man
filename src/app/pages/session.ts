import { Component, OnInit, effect, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { GameService } from '../core/game.service';
import { LobbyView } from './lobby';
import { GameView } from './game';
import { EndView } from './end';

/** Conteneur d'une session : affiche le salon, la partie ou la fin selon l'état. */
@Component({
  selector: 'app-session',
  imports: [LobbyView, GameView, EndView],
  template: `
    @if (!game.loaded()) {
      <section class="screen center-screen"><div class="spinner"></div><p class="hint">Connexion à la session…</p></section>
    } @else {
      @switch (game.session()?.status) {
        @case ('lobby') { <app-lobby /> }
        @case ('playing') { <app-game /> }
        @case ('ended') { <app-end /> }
      }
    }
  `,
})
export class SessionPage implements OnInit {
  readonly game = inject(GameService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  constructor() {
    effect(() => {
      if (this.game.gone()) this.router.navigate(['/']);
    });
  }

  ngOnInit() {
    const code = (this.route.snapshot.paramMap.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!this.game.configured || code.length !== 6) return void this.router.navigate(['/']);
    this.game.open(code);
  }
}
