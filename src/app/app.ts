import { Component, inject } from '@angular/core';
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
export class App {
  readonly game = inject(GameService);
  readonly toast = inject(ToastService);
}
