import { AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import * as L from 'leaflet';
import { GameService } from '../core/game.service';
import { ToastService } from '../core/toast.service';
import { fmtClock, fmtDuration, vibrate } from '../core/utils';

interface OtherLayer { circle?: L.Circle; marker?: L.Marker; }

@Component({
  selector: 'app-game',
  template: `
    <section class="screen game-screen">
      <div #map class="map"></div>

      <div class="hud-top">
        <div class="role-badge" [class]="me().role">{{ isHunter() ? '🔴 Chasseur' : '🟢 Chassé' }}</div>
        <div class="hud-timers">
          <div><small>Fin</small><strong>{{ fmt(game.remaining()) }}</strong></div>
          @if (game.inHeadStart()) {
            <div><small>Avance</small><strong>{{ fmt(game.headStartEnd() - game.now()) }}</strong></div>
          } @else {
            <div><small>Rétrécit</small><strong>{{ game.shrink().next ? fmt(game.shrink().next! - game.now()) : '—' }}</strong></div>
          }
          <div><small>Rayon</small><strong>{{ game.shrink().radius }} m</strong></div>
        </div>

        @if (game.outOfZoneRemaining(); as rem) {
          <div class="zone-alert">
            ⚠️ HORS ZONE (+{{ game.distanceOutOfZone() }} m) — Rentre avant <b>{{ fmt(rem) }}</b> !
          </div>
        }
      </div>

      @if (isHunter() && game.inHeadStart()) {
        <div class="overlay">
          <div>
            <p>Les chassés se cachent…</p>
            <div class="big-code">{{ fmt(game.headStartEnd() - game.now()) }}</div>
          </div>
        </div>
      }

      <div class="hud-bottom">
        @if (isHunter()) {
          <div class="hunter-code">Ton code chasseur : <strong>{{ game.myCatchCode() }}</strong></div>
        } @else {
          <div class="ally-share-bar">
            <span class="ally-label">🤝 Partager aux chassés :</span>
            <div class="ally-pills">
              <button type="button" [class.active]="game.allyShareMode() === 'off'" (click)="game.setAllyShareMode('off')">Off</button>
              <button type="button" [class.active]="game.allyShareMode() === 'relative'" (click)="game.setAllyShareMode('relative')">⭕ Cercle</button>
              <button type="button" [class.active]="game.allyShareMode() === 'exact'" (click)="game.setAllyShareMode('exact')">📍 Exacte</button>
            </div>
          </div>
        }
        <div class="gps-status">
          @if (game.gpsError(); as err) { ❌ {{ err }} }
          @else if (game.myPos(); as p) { 📡 GPS ±{{ p.acc }} m }
          @else { 📡 Recherche du GPS… }
        </div>
        <div class="hud-actions">
          <button class="btn icon light" title="Recentrer" (click)="recenter()">◎</button>
          <button class="btn icon dark-icon" title="Mode poche (écran noir)" (click)="enablePocketMode()">🌙</button>
          <button class="btn secondary" (click)="showPlayers.set(true)">👥 {{ game.alive().length }} chassé{{ game.alive().length > 1 ? 's' : '' }}</button>
          @if (!isHunter()) {
            <button class="btn danger" (click)="openCaught()">🙋 J'ai été trouvé</button>
          }
        </div>
      </div>

      @if (game.gpsRevoked()) {
        <div class="modal">
          <div class="modal-box">
            <h3>🔒 Accès GPS verrouillé</h3>
            <p class="hint" style="font-size:14px; line-height:1.45">
              Tu avais retiré les droits de géolocalisation à la fin de ta dernière partie.
            </p>
            <p class="hint" style="font-size:14px; line-height:1.45">
              Autorises-tu Tracker Man à utiliser ta position <b>uniquement pendant cette nouvelle partie</b> ?
            </p>
            <div class="modal-actions">
              <button class="btn ghost" (click)="leave()">Quitter</button>
              <button class="btn primary" (click)="game.restoreGpsAccess()">📍 Autoriser pour cette partie</button>
            </div>
          </div>
        </div>
      }

      @if (showKeepOnNotice()) {
        <div class="modal" (click)="showKeepOnNotice.set(false)">
          <div class="modal-box" (click)="$event.stopPropagation()">
            <h3>⚠️ Ne verrouille pas ton téléphone !</h3>
            <p class="hint" style="font-size:14px; line-height:1.45">
              Sur téléphone, appuyer sur le bouton Power ou quitter l'application <b>coupe le GPS</b>.
            </p>
            <p class="hint" style="font-size:14px; line-height:1.45">
              👉 Garde cette page ouverte : l'écran ne se mettra pas en veille tout seul.<br>
              👉 Pour mettre ton téléphone dans ta poche sans vider la batterie ni faire de faux clics, appuie sur le bouton <b>🌙 Mode poche</b> en bas à gauche.
            </p>
            <div class="modal-actions">
              <button class="btn secondary" (click)="showKeepOnNotice.set(false); enablePocketMode()">🌙 Activer le mode poche</button>
              <button class="btn primary" (click)="showKeepOnNotice.set(false)">J'ai compris</button>
            </div>
          </div>
        </div>
      }

      @if (pocketMode()) {
        <div class="pocket-overlay" (click)="onPocketTap()">
          <div class="pocket-content">
            <div class="pocket-icon">🌙</div>
            <div class="pocket-role">{{ isHunter() ? 'Chasseur 🔴' : 'Chassé 🟢' }} — {{ fmt(game.remaining()) }}</div>
            <div class="pocket-gps">📡 GPS actif — ne verrouille pas le téléphone</div>
            @if (game.outOfZoneRemaining(); as rem) {
              <div class="zone-alert" style="margin-top:12px">⚠️ HORS ZONE — {{ fmt(rem) }}</div>
            }
            <div class="pocket-unlock">Touche 2 fois rapidement l'écran pour déverrouiller</div>
          </div>
        </div>
      }

      @if (showCaught()) {
        <div class="modal" (click)="showCaught.set(false)">
          <div class="modal-box" (click)="$event.stopPropagation()">
            <h3>Tu as été trouvé ?</h3>
            <p class="hint">Demande au chasseur qui t'a attrapé son <b>code chasseur</b> (affiché sur son écran).</p>
            <input type="text" inputmode="numeric" maxlength="4" placeholder="0000" class="code-input"
                   [value]="catchCode()" (input)="onCatchInput($event)" (keyup.enter)="confirmCaught()" />
            @if (catchError()) { <p class="error">{{ catchError() }}</p> }
            <div class="modal-actions">
              <button class="btn ghost" (click)="showCaught.set(false)">Annuler</button>
              <button class="btn danger" [disabled]="busy()" (click)="confirmCaught()">Confirmer</button>
            </div>
          </div>
        </div>
      }

      @if (showPlayers()) {
        <div class="modal" (click)="showPlayers.set(false)">
          <div class="modal-box" (click)="$event.stopPropagation()">
            <h3>Joueurs</h3>
            <ul class="players">
              @for (p of game.sortedPlayers(); track p.id) {
                <li>
                  <span class="dot" [class.on]="game.online().has(p.id)"></span>
                  <span class="name">{{ p.name }}@if (p.id === game.uid) { (toi) }</span>
                  @if (p.caught_by === 'ZONE') {
                    <span class="tag caught">🚫 hors zone</span>
                  } @else if (p.caught_by) {
                    <span class="tag caught">attrapé par {{ game.players()[p.caught_by]?.name ?? '?' }}</span>
                  }
                  <span class="tag" [class]="p.role">{{ p.role === 'hunter' ? 'Chasseur' : 'Chassé' }}</span>
                </li>
              }
            </ul>
            <h3>Journal</h3>
            <ul class="log">
              @for (e of game.logEvents(); track e.id) {
                <li><time>{{ clock(e.t) }}</time>
                  @if (e.type === 'start') { Début de la partie }
                  @else if (e.type === 'out_of_zone') { 🚫 <b>{{ e.data.victimName }}</b> éliminé (hors zone) }
                  @else { 🎯 <b>{{ e.data.victimName }}</b> attrapé par <b>{{ e.data.hunterName }}</b> }
                </li>
              }
            </ul>
            <div class="modal-actions">
              <button class="btn ghost" (click)="leave()">Quitter la partie</button>
              <button class="btn secondary" (click)="showPlayers.set(false)">Fermer</button>
            </div>
          </div>
        </div>
      }
    </section>
  `,
})
export class GameView implements AfterViewInit, OnDestroy {
  readonly game = inject(GameService);
  private toast = inject(ToastService);
  private router = inject(Router);
  private mapEl = viewChild.required<ElementRef<HTMLDivElement>>('map');

  readonly fmt = fmtDuration;
  readonly clock = fmtClock;
  readonly me = computed(() => this.game.me()!);
  readonly isHunter = computed(() => this.me().role === 'hunter');

  readonly showCaught = signal(false);
  readonly showPlayers = signal(false);
  readonly showKeepOnNotice = signal(true);
  readonly pocketMode = signal(false);
  readonly catchCode = signal('');
  readonly catchError = signal<string | null>(null);
  readonly busy = signal(false);
  private lastPocketTap = 0;

  private map?: L.Map;
  private ready = signal(false);
  private meMarker?: L.Marker;
  private meAccuracy?: L.Circle;
  private myCircle?: L.Circle;
  private zoneCircle?: L.Circle;
  private others = new Map<string, OtherLayer>();
  private centered = false;

  constructor() {
    effect(() => {
      if (this.ready()) this.render();
    });
  }

  ngAfterViewInit() {
    this.map = L.map(this.mapEl().nativeElement, { zoomControl: false }).setView([46.6, 2.4], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(this.map);
    setTimeout(() => this.map?.invalidateSize(), 100);
    this.ready.set(true);
  }

  ngOnDestroy() {
    this.map?.remove();
  }

  /** Met à jour tous les calques de la carte (appelé à chaque changement d'état). */
  private render() {
    const map = this.map!;
    const me = this.game.me();
    const pos = this.game.myPos();
    const now = this.game.now();
    const inHead = this.game.inHeadStart();
    const players = this.game.sortedPlayers();
    const zone = this.game.session()?.settings.zone;
    if (!me) return;
    const isHunter = me.role === 'hunter';
    const color = isHunter ? '#ff3b3b' : '#3b8bff';

    // Zone autorisée (si configurée)
    if (zone) {
      const out = this.game.outOfZoneSince() != null;
      const zCol = out ? '#ff3b3b' : '#3b8bff';
      if (!this.zoneCircle) {
        this.zoneCircle = L.circle([zone.lat, zone.lng], {
          radius: zone.r, color: zCol, weight: 3, dashArray: '10 6', fillOpacity: 0.04,
        }).addTo(map).bindTooltip('Zone autorisée', { direction: 'top', className: 'lbl' });
      } else {
        this.zoneCircle.setLatLng([zone.lat, zone.lng]).setRadius(zone.r).setStyle({ color: zCol });
      }
    } else if (this.zoneCircle) {
      this.zoneCircle.remove();
      this.zoneCircle = undefined;
    }

    // Ma position
    if (pos) {
      const ll: L.LatLngExpression = [pos.lat, pos.lng];
      if (!this.meMarker) {
        this.meMarker = L.marker(ll, {
          icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [18, 18] }),
          zIndexOffset: 1000,
        }).addTo(map);
        this.meAccuracy = L.circle(ll, { radius: pos.acc, weight: 0, fillOpacity: 0.12 }).addTo(map);
      }
      this.meMarker.setLatLng(ll);
      const el = this.meMarker.getElement()?.firstElementChild as HTMLElement | null;
      if (el) el.style.background = color;
      this.meAccuracy!.setLatLng(ll).setRadius(pos.acc).setStyle({ fillColor: color });
      if (!this.centered) { map.setView(ll, 16); this.centered = true; }
    }

    // Autres joueurs
    const keep = new Set<string>();
    const allyExact = this.game.allyExactPos();
    for (const p of players) {
      if (p.id === me.id) continue;
      if (isHunter && !inHead && p.role === 'hunted' && p.circle) {
        keep.add(p.id);
        const stale = now - Math.max(p.seen ?? 0, p.circle.t) > 120000;
        const col = stale ? '#888888' : '#ff3b3b';
        let o = this.others.get(p.id);
        if (!o?.circle) {
          this.removeOther(p.id);
          o = {
            circle: L.circle([p.circle.lat, p.circle.lng], { radius: p.circle.r, color: col, weight: 2, fillOpacity: 0.15 })
              .addTo(map).bindTooltip('', { permanent: true, direction: 'center', className: 'lbl' }),
          };
          this.others.set(p.id, o);
        }
        o.circle!.setLatLng([p.circle.lat, p.circle.lng]).setRadius(p.circle.r).setStyle({ color: col, fillColor: col });
        o.circle!.setTooltipContent(escapeHtml(p.name) + (stale ? ' (signal perdu)' : ''));
      } else if (isHunter && p.role === 'hunter' && p.pos) {
        keep.add(p.id);
        let o = this.others.get(p.id);
        if (!o?.marker) {
          this.removeOther(p.id);
          o = {
            marker: L.marker([p.pos.lat, p.pos.lng], {
              icon: L.divIcon({ className: '', html: '<div class="mate-marker"></div>', iconSize: [14, 14] }),
            }).addTo(map).bindTooltip(escapeHtml(p.name), { permanent: true, direction: 'top', offset: [0, -8], className: 'lbl' }),
          };
          this.others.set(p.id, o);
        }
        o.marker!.setLatLng([p.pos.lat, p.pos.lng]);
      } else if (!isHunter && p.role === 'hunted') {
        const exact = allyExact[p.id];
        if (exact && now - exact.t < 25000) {
          keep.add(p.id);
          let o = this.others.get(p.id);
          if (!o?.marker) {
            this.removeOther(p.id);
            o = {
              marker: L.marker([exact.lat, exact.lng], {
                icon: L.divIcon({ className: '', html: '<div class="ally-marker"></div>', iconSize: [14, 14] }),
              }).addTo(map).bindTooltip(`🟢 ${escapeHtml(p.name)} (exact)`, { permanent: true, direction: 'top', offset: [0, -8], className: 'lbl' }),
            };
            this.others.set(p.id, o);
          }
          o.marker!.setLatLng([exact.lat, exact.lng]);
        } else if (p.circle?.allyShare) {
          keep.add(p.id);
          let o = this.others.get(p.id);
          if (!o?.circle) {
            this.removeOther(p.id);
            o = {
              circle: L.circle([p.circle.lat, p.circle.lng], {
                radius: p.circle.r, color: '#2fd17a', weight: 2, dashArray: '5 5', fillOpacity: 0.12,
              }).addTo(map).bindTooltip(`🟢 ${escapeHtml(p.name)} (cercle)`, { permanent: true, direction: 'center', className: 'lbl' }),
            };
            this.others.set(p.id, o);
          }
          o.circle!.setLatLng([p.circle.lat, p.circle.lng]).setRadius(p.circle.r);
        }
      }
    }
    for (const id of [...this.others.keys()]) if (!keep.has(id)) this.removeOther(id);

    // Mon cercle (ce que les chasseurs voient de moi)
    if (!isHunter && me.circle) {
      const ll: L.LatLngExpression = [me.circle.lat, me.circle.lng];
      if (!this.myCircle) {
        this.myCircle = L.circle(ll, { radius: me.circle.r, color: '#2fd17a', weight: 2, dashArray: '6 6', fillOpacity: 0.08 }).addTo(map);
      }
      this.myCircle.setLatLng(ll).setRadius(me.circle.r);
    } else if (this.myCircle) {
      this.myCircle.remove();
      this.myCircle = undefined;
    }
  }

  private removeOther(id: string) {
    const o = this.others.get(id);
    o?.circle?.remove();
    o?.marker?.remove();
    this.others.delete(id);
  }

  recenter() {
    const pts: L.LatLng[] = [];
    const pos = this.game.myPos();
    if (pos) pts.push(L.latLng(pos.lat, pos.lng));
    if (this.zoneCircle) {
      const b = this.zoneCircle.getBounds();
      pts.push(b.getNorthEast(), b.getSouthWest());
    }
    for (const o of this.others.values()) {
      if (o.circle) { const b = o.circle.getBounds(); pts.push(b.getNorthEast(), b.getSouthWest()); }
      if (o.marker) pts.push(o.marker.getLatLng());
    }
    if (pts.length > 1) this.map?.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 17 });
    else if (pts.length === 1) this.map?.setView(pts[0], 16);
  }

  enablePocketMode() {
    this.pocketMode.set(true);
    this.lastPocketTap = 0;
  }

  onPocketTap() {
    const now = Date.now();
    if (now - this.lastPocketTap < 400) {
      this.pocketMode.set(false);
      this.lastPocketTap = 0;
      vibrate(60);
    } else {
      this.lastPocketTap = now;
    }
  }

  openCaught() {
    this.catchCode.set('');
    this.catchError.set(null);
    this.showCaught.set(true);
  }

  onCatchInput(e: Event) {
    const input = e.target as HTMLInputElement;
    input.value = input.value.replace(/\D/g, '');
    this.catchCode.set(input.value);
  }

  async confirmCaught() {
    if (this.catchCode().length !== 4) return this.catchError.set('Le code fait 4 chiffres.');
    this.busy.set(true);
    try {
      await this.game.declareCaught(this.catchCode());
      this.showCaught.set(false);
      vibrate([200, 100, 200]);
    } catch (e) {
      this.catchError.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async leave() {
    if (!confirm('Quitter la partie en cours ?')) return;
    await this.game.leave();
    this.router.navigate(['/']);
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
