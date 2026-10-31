import { AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import * as L from 'leaflet';
import { GameService } from '../core/game.service';
import { ToastService } from '../core/toast.service';
import { distance, fmtClock, fmtDuration } from '../core/utils';
import { Player, Pos } from '../core/models';

const PALETTE = [
  '#ff5a1f', '#2fd17a', '#3b8bff', '#f5c518', '#b86bff',
  '#ff4d8d', '#00d2d3', '#ff9f43', '#54a0ff', '#10ac84',
];

interface PlayerReport {
  player: Player;
  color: string;
  points: Pos[];
  distanceMeters: number;
  survivedMs: number;
  capturesCount: number;
  statusLabel: string;
  statusType: 'survived' | 'caught' | 'zone' | 'hunter';
  caughtAtClock: string | null;
}

@Component({
  selector: 'app-end',
  template: `
    <section class="screen">
      <div class="content center-content">
        <div class="end-title" [class]="huntedWin() ? 'hunted' : 'hunter'">
          {{ huntedWin() ? '🟢 Les chassés ont gagné !' : '🔴 Les chasseurs ont gagné !' }}
        </div>
        <p class="hint center">{{ subtitle() }}</p>

        <!-- Résumé global -->
        <div class="stats-grid">
          <div class="stat-box">
            <small>Durée jouée</small>
            <strong>{{ fmt(gameDurationMs()) }}</strong>
          </div>
          <div class="stat-box">
            <small>Survivants</small>
            <strong>{{ game.alive().length }} / {{ initialHuntedCount() }}</strong>
          </div>
          <div class="stat-box">
            <small>Captures</small>
            <strong>{{ catches().length }}</strong>
          </div>
        </div>

        <!-- Carte des trajectoires -->
        <div class="card">
          <div class="row-between">
            <h3>🗺️ Trajectoires de la partie</h3>
            <button class="btn ghost small" (click)="fitAll()">Recentrer</button>
          </div>
          <p class="hint">Touche un joueur ci-dessous pour filtrer sa trace. Les ⭐ marquent les captures.</p>
          <div class="filter-chips">
            <button class="chip" [class.active]="selectedPlayer() === null" (click)="selectPlayer(null)">
              Tous ({{ reports().length }})
            </button>
            @for (r of reports(); track r.player.id) {
              <button class="chip" [class.active]="selectedPlayer() === r.player.id" (click)="selectPlayer(r.player.id)">
                <span class="swatch" [style.background]="r.color"></span>
                {{ r.player.name }}
              </button>
            }
          </div>
          <div #recapMap class="recap-map"></div>
        </div>

        <!-- Bilan détaillé par joueur -->
        <div class="card">
          <h3>📊 Détail par joueur</h3>
          <div class="player-reports">
            @for (r of reports(); track r.player.id) {
              <div class="report-item" (click)="selectPlayer(r.player.id)">
                <div class="report-head">
                  <span class="swatch big" [style.background]="r.color"></span>
                  <strong class="name">{{ r.player.name }}@if (r.player.id === game.uid) { (toi) }</strong>
                  <span class="tag" [class]="r.statusType === 'survived' ? 'hunted' : r.statusType === 'hunter' ? 'hunter' : 'caught'">
                    {{ r.statusLabel }}
                  </span>
                </div>
                <div class="report-metrics">
                  <span>🚶 <b>{{ formatDist(r.distanceMeters) }}</b> parcourus</span>
                  <span>⏱️ Temps chassé : <b>{{ r.player.initial_role === 'hunter' ? '—' : fmt(r.survivedMs) }}</b></span>
                  @if (r.capturesCount > 0) {
                    <span>🎯 <b>{{ r.capturesCount }}</b> capture{{ r.capturesCount > 1 ? 's' : '' }}</span>
                  }
                  @if (r.caughtAtClock) {
                    <span>🕒 Éliminé à <b>{{ r.caughtAtClock }}</b></span>
                  }
                </div>
              </div>
            }
          </div>
        </div>

        <!-- Chronologie complète -->
        <div class="card">
          <h3>⏱️ Chronologie complète</h3>
          <ul class="log timeline">
            @for (e of game.logEvents(); track e.id) {
              <li>
                <time>{{ clock(e.t) }} (+{{ fmt(e.t - (game.session()?.start_at ?? e.t)) }})</time>
                @if (e.type === 'start') {
                  <span>🚀 <b>Début de la partie</b></span>
                } @else if (e.type === 'out_of_zone') {
                  <span>🚫 <b>{{ e.data.victimName }}</b> éliminé pour sortie de zone</span>
                } @else if (e.type === 'caught') {
                  <span>🎯 <b>{{ e.data.victimName }}</b> attrapé par <b>{{ e.data.hunterName }}</b></span>
                }
              </li>
            } @empty {
              <li>Aucun événement.</li>
            }
            @if (game.session()?.ended_at; as endAt) {
              <li>
                <time>{{ clock(endAt) }} (+{{ fmt(gameDurationMs()) }})</time>
                <span>🏁 <b>Fin de la partie</b></span>
              </li>
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
export class EndView implements AfterViewInit, OnDestroy {
  readonly game = inject(GameService);
  private router = inject(Router);
  private toast = inject(ToastService);
  private mapEl = viewChild.required<ElementRef<HTMLDivElement>>('recapMap');

  readonly clock = fmtClock;
  readonly fmt = fmtDuration;
  readonly busy = signal(false);
  readonly selectedPlayer = signal<string | null>(null);

  private map?: L.Map;
  private layerGroup?: L.LayerGroup;
  private ready = signal(false);
  private autoFitted = false;

  readonly huntedWin = computed(() => this.game.session()?.winner !== 'hunters');
  readonly catches = computed(() => this.game.events().filter((e) => e.type === 'caught' || e.type === 'out_of_zone'));
  readonly gameDurationMs = computed(() => {
    const s = this.game.session();
    if (!s?.start_at) return 0;
    return Math.max(0, (s.ended_at ?? this.game.now()) - s.start_at);
  });
  readonly initialHuntedCount = computed(() =>
    this.game.sortedPlayers().filter((p) => p.initial_role !== 'hunter').length
  );

  readonly subtitle = computed(() => {
    const m = this.game.me();
    if (!m) return '';
    if (m.role === 'hunted') return "Tu as survécu jusqu'au bout 🎉";
    if (m.caught_by === 'ZONE') return 'Tu as été éliminé hors de la zone autorisée 🚫';
    if (m.initial_role === 'hunted') {
      return `Tu as été attrapé par ${this.game.players()[m.caught_by ?? '']?.name ?? 'un chasseur'} à ${ m.caught_at ? fmtClock(m.caught_at) : '' }.`;
    }
    return 'Tu étais chasseur dès le départ.';
  });

  /** Construit le rapport complet de chaque joueur avec ses points GPS, distance, temps survécu et captures. */
  readonly reports = computed<PlayerReport[]>(() => {
    const players = this.game.sortedPlayers();
    const events = this.game.events();
    const s = this.game.session();
    const startAt = s?.start_at ?? 0;
    const endAt = s?.ended_at ?? this.game.now();
    const byPlayer = new Map<string, Pos[]>();

    for (const e of events) {
      if (e.type === 'pos' && e.data.playerId && e.data.lat != null && e.data.lng != null) {
        let arr = byPlayer.get(e.data.playerId);
        if (!arr) { arr = []; byPlayer.set(e.data.playerId, arr); }
        arr.push({ lat: e.data.lat, lng: e.data.lng, t: e.t, role: e.data.role });
      }
    }

    return players.map((p, idx) => {
      const pts = (byPlayer.get(p.id) ?? []).slice().sort((a, b) => a.t - b.t);
      if (!pts.length && p.pos) pts.push(p.pos);
      let dist = 0;
      for (let i = 1; i < pts.length; i++) dist += distance(pts[i - 1], pts[i]);

      const capturesCount = events.filter((e) => e.type === 'caught' && e.data.hunter === p.id).length;
      const survivedMs = p.initial_role === 'hunter'
        ? 0
        : Math.max(0, (p.caught_at ?? endAt) - startAt);

      let statusLabel = 'Survivant 🏆';
      let statusType: PlayerReport['statusType'] = 'survived';
      if (p.initial_role === 'hunter') {
        statusLabel = 'Chasseur initial 🔴';
        statusType = 'hunter';
      } else if (p.caught_by === 'ZONE') {
        statusLabel = 'Éliminé hors zone 🚫';
        statusType = 'zone';
      } else if (p.caught_by) {
        const hunterName = this.game.players()[p.caught_by]?.name ?? '?';
        statusLabel = `Attrapé par ${hunterName}`;
        statusType = 'caught';
      }

      return {
        player: p,
        color: PALETTE[idx % PALETTE.length],
        points: pts,
        distanceMeters: Math.round(dist),
        survivedMs,
        capturesCount,
        statusLabel,
        statusType,
        caughtAtClock: p.caught_at ? fmtClock(p.caught_at) : null,
      };
    });
  });

  constructor() {
    effect(() => {
      if (this.ready()) this.renderRecapMap();
    });
  }

  ngAfterViewInit() {
    this.map = L.map(this.mapEl().nativeElement, { zoomControl: true }).setView([46.6, 2.4], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(this.map);
    this.layerGroup = L.layerGroup().addTo(this.map);
    setTimeout(() => {
      this.map?.invalidateSize();
      this.ready.set(true);
    }, 100);
  }

  ngOnDestroy() {
    this.map?.remove();
  }

  selectPlayer(id: string | null) {
    this.selectedPlayer.set(this.selectedPlayer() === id ? null : id);
    this.autoFitted = false;
  }

  formatDist(m: number): string {
    return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m} m`;
  }

  private renderRecapMap() {
    if (!this.map || !this.layerGroup) return;
    this.layerGroup.clearLayers();
    const boundsPts: L.LatLng[] = [];
    const filterId = this.selectedPlayer();
    const zone = this.game.session()?.settings.zone;

    if (zone) {
      const zc = L.circle([zone.lat, zone.lng], {
        radius: zone.r, color: '#3b8bff', weight: 2, dashArray: '8 6', fillOpacity: 0.04,
      }).bindTooltip('Zone autorisée', { className: 'lbl' }).addTo(this.layerGroup);
      boundsPts.push(zc.getBounds().getNorthEast(), zc.getBounds().getSouthWest());
    }

    for (const r of this.reports()) {
      if (filterId && r.player.id !== filterId) continue;
      if (!r.points.length) continue;

      const latlngs = r.points.map((pt) => L.latLng(pt.lat, pt.lng));
      boundsPts.push(...latlngs);

      // Ligne de trajectoire complète
      L.polyline(latlngs, { color: r.color, weight: 4, opacity: 0.9 }).addTo(this.layerGroup);

      // Point de départ
      const first = r.points[0];
      L.circleMarker([first.lat, first.lng], {
        radius: 6, color: '#fff', weight: 2, fillColor: r.color, fillOpacity: 1,
      }).bindTooltip(`Départ ${r.player.name} (${fmtClock(first.t)})`, { className: 'lbl' }).addTo(this.layerGroup);

      // Point de capture / élimination si applicable
      if (r.player.caught_at) {
        const catchPt = r.points.reduce((best, cur) =>
          Math.abs(cur.t - r.player.caught_at!) < Math.abs(best.t - r.player.caught_at!) ? cur : best
        , first);
        L.marker([catchPt.lat, catchPt.lng], {
          icon: L.divIcon({
            className: '',
            html: `<div class="catch-pin" style="border-color:${r.color}">${r.player.caught_by === 'ZONE' ? '🚫' : '⭐'}</div>`,
            iconSize: [26, 26],
          }),
        }).bindTooltip(`${r.player.name} : ${r.statusLabel} (${r.caughtAtClock})`, { permanent: false, className: 'lbl' })
          .addTo(this.layerGroup);
      }

      // Dernier point connu
      const last = r.points[r.points.length - 1];
      L.circleMarker([last.lat, last.lng], {
        radius: 8, color: '#fff', weight: 2, fillColor: r.color, fillOpacity: 1,
      }).bindTooltip(`${r.player.name} (fin)`, { permanent: true, direction: 'top', offset: [0, -8], className: 'lbl' })
        .addTo(this.layerGroup);
    }

    if (!this.autoFitted && boundsPts.length > 0) {
      this.autoFitted = true;
      if (boundsPts.length > 1) this.map.fitBounds(L.latLngBounds(boundsPts), { padding: [30, 30], maxZoom: 17 });
      else this.map.setView(boundsPts[0], 16);
    }
  }

  fitAll() {
    this.autoFitted = false;
    this.renderRecapMap();
  }

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
