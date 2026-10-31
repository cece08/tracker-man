import { AfterViewInit, Component, ElementRef, OnDestroy, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import * as L from 'leaflet';
import { GameService } from '../core/game.service';
import { ToastService } from '../core/toast.service';
import { DEFAULT_SETTINGS, Settings, Zone } from '../core/models';

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
          <h3>⭕ Cercles des chassés</h3>
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

        <div class="card">
          <h3>🚧 Zone autorisée</h3>
          <div class="segmented">
            <button [class.active]="!zoneEnabled()" (click)="toggleZone(false)">Aucune limite</button>
            <button [class.active]="zoneEnabled()" (click)="toggleZone(true)">Zone limitée</button>
          </div>

          @if (zoneEnabled()) {
            <p class="hint">Touche la carte pour déplacer le centre de la zone autorisée.</p>
            <div class="zone-map-wrap">
              <div #zoneMap class="zone-map"></div>
              <button type="button" class="btn small secondary zone-gps-btn" (click)="centerOnMe()">📍 Ma position</button>
            </div>
            <label class="field row">
              <span>Rayon de la zone (m)</span>
              <input type="number" min="50" max="50000" step="50" [value]="zone().r" (input)="onZoneRadius($event)" />
            </label>
            <label class="field row">
              <span>Temps max hors zone (sec)</span>
              <input type="number" min="5" max="600" [value]="s().outGraceSec ?? 30" (input)="set('outGraceSec', $event)" />
            </label>
            <p class="hint">Si un chassé sort de ce cercle, il a <b>{{ s().outGraceSec ?? 30 }} s</b> pour y rentrer avant d'être éliminé.</p>
          }
        </div>

        <button class="btn primary big" [disabled]="busy()" (click)="create()">Créer la session</button>
      </div>
    </section>
  `,
})
export class CreatePage implements AfterViewInit, OnDestroy {
  private game = inject(GameService);
  private router = inject(Router);
  private toast = inject(ToastService);
  private zoneMapEl = viewChild<ElementRef<HTMLDivElement>>('zoneMap');

  readonly s = signal<Settings>({ ...DEFAULT_SETTINGS });
  readonly zoneEnabled = signal(false);
  readonly zone = signal<Zone>({ lat: 48.8566, lng: 2.3522, r: 1000 });
  readonly busy = signal(false);

  private map?: L.Map;
  private circleLayer?: L.Circle;
  private centerMarker?: L.Marker;

  ngAfterViewInit() {
    // Pré-récupère la position GPS si possible
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (p) => this.setZoneCenter(p.coords.latitude, p.coords.longitude, true),
        () => {},
        { enableHighAccuracy: true, timeout: 8000 },
      );
    }
  }

  ngOnDestroy() {
    this.map?.remove();
  }

  toggleZone(on: boolean) {
    this.zoneEnabled.set(on);
    if (on) {
      setTimeout(() => this.initZoneMap(), 50);
    } else {
      this.map?.remove();
      this.map = undefined;
      this.circleLayer = undefined;
      this.centerMarker = undefined;
    }
  }

  private initZoneMap() {
    const el = this.zoneMapEl()?.nativeElement;
    if (!el || this.map) return;
    const z = this.zone();
    this.map = L.map(el, { zoomControl: true }).setView([z.lat, z.lng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(this.map);

    this.circleLayer = L.circle([z.lat, z.lng], {
      radius: z.r, color: '#3b8bff', weight: 2, dashArray: '6 6', fillOpacity: 0.12,
    }).addTo(this.map);

    this.centerMarker = L.marker([z.lat, z.lng], {
      icon: L.divIcon({ className: '', html: '<div class="me-marker" style="background:#3b8bff"></div>', iconSize: [18, 18] }),
    }).addTo(this.map);

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      this.setZoneCenter(e.latlng.lat, e.latlng.lng, false);
    });

    setTimeout(() => {
      this.map?.invalidateSize();
      if (this.circleLayer) this.map?.fitBounds(this.circleLayer.getBounds(), { padding: [20, 20] });
    }, 100);
  }

  centerOnMe() {
    if (!('geolocation' in navigator)) return this.toast.show('GPS non disponible');
    navigator.geolocation.getCurrentPosition(
      (p) => this.setZoneCenter(p.coords.latitude, p.coords.longitude, true),
      () => this.toast.show('Impossible de récupérer ta position GPS'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  private setZoneCenter(lat: number, lng: number, fit: boolean) {
    this.zone.update((z) => ({ ...z, lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) }));
    const z = this.zone();
    this.circleLayer?.setLatLng([z.lat, z.lng]);
    this.centerMarker?.setLatLng([z.lat, z.lng]);
    if (fit && this.map && this.circleLayer) {
      this.map.fitBounds(this.circleLayer.getBounds(), { padding: [20, 20] });
    }
  }

  onZoneRadius(e: Event) {
    const r = Math.max(50, Math.round(Number((e.target as HTMLInputElement).value) || 50));
    this.zone.update((z) => ({ ...z, r }));
    if (this.circleLayer) {
      this.circleLayer.setRadius(r);
      this.map?.fitBounds(this.circleLayer.getBounds(), { padding: [20, 20] });
    }
  }

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
    if (this.zoneEnabled()) {
      if (!(this.zone().r >= 50)) return 'Le rayon de la zone autorisée doit faire au moins 50 m.';
      if (!((st.outGraceSec ?? 30) >= 5)) return 'Le temps hors zone doit être d’au moins 5 secondes.';
    }
    return null;
  }

  async create() {
    const name = localStorage.getItem('tm_name');
    if (!name) return void this.router.navigate(['/']);
    const err = this.validate();
    if (err) return this.toast.show(err);
    this.busy.set(true);
    try {
      const settings: Settings = {
        ...this.s(),
        zone: this.zoneEnabled() ? this.zone() : null,
      };
      const code = await this.game.createSession(name, settings);
      this.router.navigate(['/session', code]);
    } catch (e) {
      this.toast.show('Erreur : ' + (e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
