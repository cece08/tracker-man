import { Component, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import * as QRCode from 'qrcode';
import { GameService } from '../core/game.service';
import { ToastService } from '../core/toast.service';
import { Player, Settings } from '../core/models';
import { SettingsEditor } from './settings-editor';

@Component({
  selector: 'app-lobby',
  imports: [SettingsEditor],
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
          @if (qrDataUrl()) {
            <div class="qr-wrap" (click)="zoomQr.set(true)" title="Toucher pour agrandir">
              <img [src]="qrDataUrl()!" alt="QR code de la session" class="qr-img" />
              <span class="qr-hint">📲 Scanne pour rejoindre (touche pour agrandir)</span>
            </div>
          }
          <div style="display:flex; gap:8px; justify-content:center; margin-top:8px">
            <button class="btn ghost small" (click)="share()">🔗 Partager le lien</button>
            @if (qrDataUrl()) {
              <button class="btn ghost small" (click)="zoomQr.set(true)">🔍 Agrandir le QR</button>
            }
          </div>
        </div>

        <div class="card">
          <div class="row-between" style="margin-bottom: 10px">
            <h3>Paramètres</h3>
            @if (game.isHost()) {
              <button class="btn ghost small" (click)="editingSettings.set(true)">⚙️ Modifier</button>
            }
          </div>
          <ul class="settings-list">
            <li>Durée : <b>{{ s().settings.total }} min</b></li>
            <li>Avance : <b>{{ s().settings.headStart }} min</b></li>
            <li>Rayon : <b>{{ s().settings.radiusStart }} → {{ s().settings.radiusEnd }} m</b></li>
            <li>Rétrécit : <b>toutes les {{ s().settings.shrinkEvery }} min</b></li>
            <li>Actualisation cercle : <b>{{ s().settings.circleRefreshSec ? 'Toutes les ' + s().settings.circleRefreshSec + ' s' : 'Au bord / rétrécissement' }}</b></li>
            <li>Rôles : <b>{{ s().settings.roleMode === 'random' ? 'Aléatoire (' + s().settings.hunters + ' chasseur' + (s().settings.hunters > 1 ? 's' : '') + ')' : "Choisis par l'hôte" }}</b></li>
            <li>Zone : <b>{{ s().settings.zone ? 'Rayon ' + s().settings.zone!.r + ' m (' + (s().settings.outGraceSec ?? 30) + ' s max dehors)' : 'Illimitée' }}</b></li>
          </ul>
        </div>

        <div class="card">
          <h3>Joueurs ({{ game.sortedPlayers().length }})</h3>
          @if (manual() && game.isHost()) {
            <p class="hint">Touche le badge « Chasseur / Chassé » d'un joueur pour changer son rôle.</p>
          }
          <ul class="players">
            @for (p of game.sortedPlayers(); track p.id) {
              <li>
                <span class="dot" [class.on]="game.online().has(p.id)"></span>
                <span class="name">{{ p.name }}@if (p.id === s().host_id) { 👑 }@if (p.id === game.uid) { (toi) }</span>

                @if (game.isHost() || p.id === game.uid) {
                  <button type="button" class="mini-btn" title="Modifier le pseudo" (click)="openRename(p, $event)">✏️</button>
                }
                @if (game.isHost() && p.id !== game.uid) {
                  <button type="button" class="mini-btn danger" title="Exclure ce joueur" (click)="kick(p, $event)">👢</button>
                }

                @if (manual()) {
                  <span class="tag" [class]="p.role" [class.clickable]="game.isHost()" (click)="toggle(p)">
                    {{ p.role === 'hunter' ? 'Chasseur' : 'Chassé' }}
                  </span>
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

        <div class="card warn-card">
          <b>⚠️ Important pendant la partie</b>
          <p class="hint">
            Ne verrouille <b>jamais</b> ton téléphone avec le bouton Power (cela coupe le GPS sur navigateur).
            L'application garde l'écran allumé toute seule : utilise le bouton <b>🌙 Mode poche</b> en jeu pour éteindre l'affichage dans ta poche sans couper la localisation.
          </p>
        </div>
      </div>

      <!-- Modale : modifier les réglages de la session -->
      @if (editingSettings()) {
        <div class="modal" (click)="editingSettings.set(false)">
          <div class="modal-box" (click)="$event.stopPropagation()">
            <div class="row-between">
              <h3>⚙️ Modifier les paramètres</h3>
              <button type="button" class="btn icon" (click)="editingSettings.set(false)">✕</button>
            </div>
            <app-settings-editor
              [initial]="s().settings"
              submitLabel="💾 Enregistrer les réglages"
              [busy]="busy()"
              (save)="saveSettings($event)" />
          </div>
        </div>
      }

      <!-- Modale : renommer un joueur -->
      @if (renamingPlayer(); as rp) {
        <div class="modal" (click)="renamingPlayer.set(null)">
          <div class="modal-box" (click)="$event.stopPropagation()">
            <h3>✏️ Modifier le pseudo</h3>
            <input type="text" maxlength="20" [value]="renameValue()"
                   (input)="renameValue.set($any($event.target).value)"
                   (keyup.enter)="confirmRename()" />
            <div class="modal-actions">
              <button type="button" class="btn ghost" (click)="renamingPlayer.set(null)">Annuler</button>
              <button type="button" class="btn primary" [disabled]="busy()" (click)="confirmRename()">Enregistrer</button>
            </div>
          </div>
        </div>
      }
      <!-- Modale : QR code plein écran -->
      @if (zoomQr() && qrDataUrl()) {
        <div class="modal" (click)="zoomQr.set(false)">
          <div class="modal-box qr-modal" (click)="$event.stopPropagation()">
            <h3>📲 Scanne pour rejoindre</h3>
            <div class="big-code" style="margin: 2px 0">{{ s().code }}</div>
            <img [src]="qrDataUrl()!" alt="QR Code" class="qr-img-large" />
            <p class="hint center">Ouvre l'appareil photo de ton téléphone et vise ce QR code.</p>
            <div class="modal-actions">
              <button type="button" class="btn secondary" (click)="zoomQr.set(false)">Fermer</button>
            </div>
          </div>
        </div>
      }

      @if (showLeaveModal()) {
        <div class="modal" (click)="showLeaveModal.set(false)">
          <div class="modal-box" (click)="$event.stopPropagation()">
            <h3>🛡️ Quitter la session — Sécurité GPS</h3>
            <p class="hint" style="font-size:14px; line-height:1.45">
              Souhaites-tu aussi <b>retirer les droits de géolocalisation</b> à Tracker Man en quittant le salon ?
            </p>
            <div class="modal-actions" style="flex-direction:column; gap:8px; margin-top:10px">
              <button type="button" class="btn danger big" [disabled]="busy()" (click)="confirmLeave(true)">🔒 Quitter & retirer les droits GPS</button>
              <button type="button" class="btn secondary big" [disabled]="busy()" (click)="confirmLeave(false)">🚪 Quitter simplement</button>
              <button type="button" class="btn ghost big" [disabled]="busy()" (click)="showLeaveModal.set(false)">Annuler</button>
            </div>
          </div>
        </div>
      }
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
  readonly editingSettings = signal(false);
  readonly renamingPlayer = signal<Player | null>(null);
  readonly renameValue = signal('');
  readonly qrDataUrl = signal<string | null>(null);
  readonly zoomQr = signal(false);
  readonly showLeaveModal = signal(false);

  constructor() {
    effect(() => {
      const code = this.s()?.code;
      if (!code) return;
      const k = this.game.sessionKey();
      const url = k
        ? `${location.origin}${location.pathname}#/?code=${code}&k=${k}`
        : `${location.origin}${location.pathname}#/?code=${code}`;
      QRCode.toDataURL(url, {
        width: 360,
        margin: 2,
        color: { dark: '#0f1115', light: '#ffffff' },
      }).then((dataUrl) => this.qrDataUrl.set(dataUrl)).catch(console.error);
    });
  }

  toggle(p: Player) {
    if (this.manual() && this.game.isHost()) this.game.toggleRole(p);
  }

  async saveSettings(settings: Settings) {
    this.busy.set(true);
    try {
      await this.game.updateSettings(settings);
      this.editingSettings.set(false);
      this.toast.show('✅ Paramètres mis à jour !');
    } catch (e) {
      this.toast.show((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  openRename(p: Player, e: Event) {
    e.stopPropagation();
    this.renamingPlayer.set(p);
    this.renameValue.set(p.name);
  }

  async confirmRename() {
    const p = this.renamingPlayer();
    if (!p) return;
    this.busy.set(true);
    try {
      await this.game.renamePlayer(p.id, this.renameValue());
      this.renamingPlayer.set(null);
      this.toast.show('✅ Pseudo modifié');
    } catch (e) {
      this.toast.show((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async kick(p: Player, e: Event) {
    e.stopPropagation();
    if (!confirm(`Exclure ${p.name} du salon ?`)) return;
    try {
      await this.game.kickPlayer(p.id);
      this.toast.show(`👢 ${p.name} a été exclu.`);
    } catch (err) {
      this.toast.show((err as Error).message);
    }
  }

  async start() {
    this.busy.set(true);
    try { await this.game.start(); }
    catch (e) { this.toast.show((e as Error).message); }
    finally { this.busy.set(false); }
  }

  async share() {
    const code = this.s().code;
    const k = this.game.sessionKey();
    const url = k
      ? `${location.origin}${location.pathname}#/?code=${code}&k=${k}`
      : `${location.origin}${location.pathname}#/?code=${code}`;
    const text = `Rejoins ma partie Tracker Man ! Code : ${code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Tracker Man', text, url });
      else { await navigator.clipboard.writeText(`${text}\n${url}`); this.toast.show('Lien copié !'); }
    } catch { /* partage annulé */ }
  }

  leave() {
    this.showLeaveModal.set(true);
  }

  async confirmLeave(revokeGps: boolean) {
    this.busy.set(true);
    try {
      if (revokeGps) await this.game.revokeGpsAccess();
      await this.game.leave();
      this.showLeaveModal.set(false);
      this.router.navigate(['/']);
    } finally {
      this.busy.set(false);
    }
  }
}
