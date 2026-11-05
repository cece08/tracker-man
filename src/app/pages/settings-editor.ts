import { AfterViewInit, Component, ElementRef, OnDestroy, effect, inject, input, output, signal, viewChild } from '@angular/core';
import * as L from 'leaflet';
import { ToastService } from '../core/toast.service';
import { DEFAULT_SETTINGS, Settings, Zone } from '../core/models';

const HELP: Record<string, { title: string; text: string }> = {
  total: {
    title: '⏱️ Durée totale',
    text: "Temps total de la manche (avance incluse). Si au moins un chassé n'a pas été attrapé quand ce chrono tombe à 0:00, les chassés gagnent la partie.",
  },
  headStart: {
    title: '🏃 Avance des chassés',
    text: "Temps accordé aux chassés au tout début de la partie pour aller se cacher. Pendant cette période, l'écran des chasseurs est masqué et aucun cercle n'est affiché.",
  },
  radiusStart: {
    title: '⭕ Rayon de départ',
    text: "Taille initiale (en mètres) du cercle rouge affiché aux chasseurs autour de chaque chassé. Le chassé est toujours quelque part à l'intérieur, mais le centre du cercle est décalé aléatoirement.",
  },
  radiusEnd: {
    title: '🎯 Rayon final',
    text: "Taille minimale (en mètres) qu'atteindront les cercles des chassés en fin de partie après tous les rétrécissements.",
  },
  shrinkEvery: {
    title: '📉 Fréquence de rétrécissement',
    text: 'Toutes les X minutes (après la fin de l’avance), le rayon des cercles diminue progressivement du rayon de départ jusqu’au rayon final.',
  },
  circleRefresh: {
    title: '🔄 Actualisation du cercle',
    text: "En mode « Auto (au bord) », le cercle d'un chassé ne se déplace que s'il s'approche du bord (85 % du rayon) ou lors d'un rétrécissement — idéal pour se cacher sans bouger. En mode « Toutes les X sec », un nouveau cercle décalé est recalculé à intervalle régulier même si le chassé reste immobile.",
  },
  roleMode: {
    title: '🎭 Attribution des rôles',
    text: "« Aléatoire » tire au sort le nombre de chasseurs indiqué au lancement. « Choisis » permet à l'hôte de désigner manuellement qui est Chasseur ou Chassé dans le salon.",
  },
  hunters: {
    title: '🔴 Nombre de chasseurs',
    text: 'Nombre de joueurs tirés au sort comme chasseurs au début de la partie (les autres seront chassés).',
  },
  zone: {
    title: '🚧 Zone autorisée',
    text: "Délimite le terrain de jeu par un grand cercle sur la carte. Si un chassé sort de cette zone pendant la partie, une alerte retentit et un compte à rebours démarre : s'il ne rentre pas à temps, il est éliminé et devient chasseur.",
  },
  zoneRadius: {
    title: '📏 Rayon de la zone',
    text: 'Rayon (en mètres) du terrain de jeu autorisé autour du point central choisi sur la carte.',
  },
  outGraceSec: {
    title: '⏳ Temps max hors zone',
    text: "Nombre de secondes accordées à un chassé qui sort de la zone autorisée pour y rentrer avant d'être automatiquement éliminé.",
  },
};

@Component({
  selector: 'app-settings-editor',
  template: `
    <div class="settings-editor">
      <div class="card">
        <h3>⏱️ Durée</h3>
        <label class="field row">
          <span class="lbl-with-help">
            Durée totale (min)
            <button type="button" class="help-btn" (click)="openHelp('total', $event)">?</button>
          </span>
          <input type="number" min="5" max="600" [value]="s().total" (input)="set('total', $event)" />
        </label>
        <label class="field row">
          <span class="lbl-with-help">
            Avance des chassés (min)
            <button type="button" class="help-btn" (click)="openHelp('headStart', $event)">?</button>
          </span>
          <input type="number" min="0" max="60" [value]="s().headStart" (input)="set('headStart', $event)" />
        </label>
      </div>

      <div class="card">
        <h3>⭕ Cercles des chassés</h3>
        <label class="field row">
          <span class="lbl-with-help">
            Rayon de départ (m)
            <button type="button" class="help-btn" (click)="openHelp('radiusStart', $event)">?</button>
          </span>
          <input type="number" min="20" max="10000" [value]="s().radiusStart" (input)="set('radiusStart', $event)" />
        </label>
        <label class="field row">
          <span class="lbl-with-help">
            Rayon final (m)
            <button type="button" class="help-btn" (click)="openHelp('radiusEnd', $event)">?</button>
          </span>
          <input type="number" min="10" max="10000" [value]="s().radiusEnd" (input)="set('radiusEnd', $event)" />
        </label>
        <label class="field row">
          <span class="lbl-with-help">
            Rétrécit toutes les (min)
            <button type="button" class="help-btn" (click)="openHelp('shrinkEvery', $event)">?</button>
          </span>
          <input type="number" min="1" max="120" [value]="s().shrinkEvery" (input)="set('shrinkEvery', $event)" />
        </label>

        <div style="margin-top: 10px">
          <span class="hint lbl-with-help" style="margin-bottom:6px">
            Actualisation périodique du cercle
            <button type="button" class="help-btn" (click)="openHelp('circleRefresh', $event)">?</button>
          </span>
          <div class="segmented">
            <button type="button" [class.active]="!circleRefreshEnabled()" (click)="circleRefreshEnabled.set(false)">Auto (au bord)</button>
            <button type="button" [class.active]="circleRefreshEnabled()" (click)="circleRefreshEnabled.set(true)">Toutes les X sec</button>
          </div>
          @if (circleRefreshEnabled()) {
            <label class="field row">
              <span>Actualiser toutes les (sec)</span>
              <input type="number" min="5" max="600" step="5" [value]="circleRefreshSec()" (input)="onRefreshSec($event)" />
            </label>
            <p class="hint">Le cercle de chaque chassé est recalculé toutes les <b>{{ circleRefreshSec() }} s</b> (et aussi s'il sort du cercle).</p>
          } @else {
            <p class="hint">Le cercle ne bouge que si le chassé s'approche du bord ou quand le rayon rétrécit.</p>
          }
        </div>
      </div>

      <div class="card">
        <h3 class="lbl-with-help">
          🎭 Rôles
          <button type="button" class="help-btn" (click)="openHelp('roleMode', $event)">?</button>
        </h3>
        <div class="segmented">
          <button type="button" [class.active]="s().roleMode === 'random'" (click)="mode('random')">Aléatoire</button>
          <button type="button" [class.active]="s().roleMode === 'manual'" (click)="mode('manual')">Choisis</button>
        </div>
        @if (s().roleMode === 'random') {
          <label class="field row">
            <span class="lbl-with-help">
              Nombre de chasseurs
              <button type="button" class="help-btn" (click)="openHelp('hunters', $event)">?</button>
            </span>
            <input type="number" min="1" max="50" [value]="s().hunters" (input)="set('hunters', $event)" />
          </label>
        } @else {
          <p class="hint">Tu choisiras les chasseurs dans le salon en touchant leur badge de rôle.</p>
        }
      </div>

      <div class="card">
        <h3 class="lbl-with-help">
          🚧 Zone autorisée
          <button type="button" class="help-btn" (click)="openHelp('zone', $event)">?</button>
        </h3>
        <div class="segmented">
          <button type="button" [class.active]="!zoneEnabled()" (click)="toggleZone(false)">Aucune limite</button>
          <button type="button" [class.active]="zoneEnabled()" (click)="toggleZone(true)">Zone limitée</button>
        </div>

        @if (zoneEnabled()) {
          <p class="hint">Touche la carte pour déplacer le centre de la zone autorisée.</p>
          <div class="zone-map-wrap">
            <div #zoneMap class="zone-map"></div>
            <button type="button" class="btn small secondary zone-gps-btn" (click)="centerOnMe()">📍 Ma position</button>
          </div>
          <label class="field row">
            <span class="lbl-with-help">
              Rayon de la zone (m)
              <button type="button" class="help-btn" (click)="openHelp('zoneRadius', $event)">?</button>
            </span>
            <input type="number" min="50" max="50000" step="50" [value]="zone().r" (input)="onZoneRadius($event)" />
          </label>
          <label class="field row">
            <span class="lbl-with-help">
              Temps max hors zone (sec)
              <button type="button" class="help-btn" (click)="openHelp('outGraceSec', $event)">?</button>
            </span>
            <input type="number" min="5" max="600" [value]="s().outGraceSec ?? 30" (input)="set('outGraceSec', $event)" />
          </label>
          <p class="hint">Si un chassé sort de ce cercle, il a <b>{{ s().outGraceSec ?? 30 }} s</b> pour y rentrer avant d'être éliminé.</p>
        }
      </div>

      <button type="button" class="btn primary big" [disabled]="busy()" (click)="submit()">
        {{ submitLabel() }}
      </button>
    </div>

    @if (activeHelp(); as h) {
      <div class="modal" (click)="activeHelp.set(null)">
        <div class="modal-box" (click)="$event.stopPropagation()">
          <h3>{{ h.title }}</h3>
          <p class="hint" style="font-size:14px; line-height:1.5; color: var(--text)">{{ h.text }}</p>
          <div class="modal-actions">
            <button type="button" class="btn primary" (click)="activeHelp.set(null)">Compris</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class SettingsEditor implements AfterViewInit, OnDestroy {
  private toast = inject(ToastService);
  private zoneMapEl = viewChild<ElementRef<HTMLDivElement>>('zoneMap');

  readonly initial = input<Settings>(DEFAULT_SETTINGS);
  readonly submitLabel = input<string>('Enregistrer');
  readonly busy = input<boolean>(false);
  readonly save = output<Settings>();

  readonly s = signal<Settings>({ ...DEFAULT_SETTINGS });
  readonly circleRefreshEnabled = signal(false);
  readonly circleRefreshSec = signal(30);
  readonly zoneEnabled = signal(false);
  readonly zone = signal<Zone>({ lat: 48.8566, lng: 2.3522, r: 1000 });
  readonly activeHelp = signal<{ title: string; text: string } | null>(null);

  private map?: L.Map;
  private circleLayer?: L.Circle;
  private centerMarker?: L.Marker;
  private initializedFromInput = false;

  constructor() {
    effect(() => {
      const init = this.initial();
      if (!this.initializedFromInput && init) {
        this.initializedFromInput = true;
        this.s.set({ ...DEFAULT_SETTINGS, ...init });
        this.circleRefreshEnabled.set(!!init.circleRefreshSec);
        this.circleRefreshSec.set(init.circleRefreshSec ?? 30);
        if (init.zone) {
          this.zone.set({ ...init.zone });
          this.zoneEnabled.set(true);
          setTimeout(() => this.initZoneMap(), 60);
        } else {
          this.zoneEnabled.set(false);
        }
      }
    });
  }

  ngAfterViewInit() {
    if (!this.initial()?.zone && 'geolocation' in navigator) {
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

  openHelp(key: string, e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.activeHelp.set(HELP[key] ?? null);
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
      maxZoom: 19, attribution: '© OpenStreetMap', crossOrigin: 'anonymous',
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

  onRefreshSec(e: Event) {
    const v = Math.max(5, Math.round(Number((e.target as HTMLInputElement).value) || 30));
    this.circleRefreshSec.set(v);
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
    if (this.circleRefreshEnabled() && !(this.circleRefreshSec() >= 5)) {
      return "L'actualisation du cercle doit être d'au moins 5 secondes.";
    }
    if (this.zoneEnabled()) {
      if (!(this.zone().r >= 50)) return 'Le rayon de la zone autorisée doit faire au moins 50 m.';
      if (!((st.outGraceSec ?? 30) >= 5)) return 'Le temps hors zone doit être d’au moins 5 secondes.';
    }
    return null;
  }

  submit() {
    const err = this.validate();
    if (err) return this.toast.show(err);
    const settings: Settings = {
      ...this.s(),
      zone: this.zoneEnabled() ? this.zone() : null,
      circleRefreshSec: this.circleRefreshEnabled() ? this.circleRefreshSec() : null,
    };
    this.save.emit(settings);
  }
}
