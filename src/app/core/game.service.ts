import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_CONFIGURED, SUPABASE_URL } from '../supabase.config';
import { Circle, GameEvent, Player, Pos, Role, Session, Settings } from './models';
import { destPoint, distance, random4, randomCode, vibrate } from './utils';
import { ToastService } from './toast.service';

export interface MyPos { lat: number; lng: number; acc: number; }

/** Rayon actuel des cercles et heure du prochain rétrécissement. */
export function shrinkInfo(s: Session | null, t: number): { radius: number; next: number | null } {
  if (!s) return { radius: 0, next: null };
  const st = s.settings;
  if (s.start_at == null || s.end_at == null) return { radius: st.radiusStart, next: null };
  const hs = s.start_at + st.headStart * 60000;
  const interval = st.shrinkEvery * 60000;
  if (t < hs) return { radius: st.radiusStart, next: hs + interval < s.end_at ? hs + interval : null };
  const totalSteps = Math.max(1, Math.ceil((s.end_at - hs) / interval) - 1);
  const step = Math.min(totalSteps, Math.floor((t - hs) / interval));
  const radius = Math.round(st.radiusStart - ((st.radiusStart - st.radiusEnd) * step) / totalSteps);
  const next = step < totalSteps ? hs + (step + 1) * interval : null;
  return { radius, next: next && next < s.end_at ? next : null };
}

function getUid(): string {
  let uid = localStorage.getItem('tm_uid');
  if (!uid) {
    uid = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('tm_uid', uid);
  }
  return uid;
}

@Injectable({ providedIn: 'root' })
export class GameService {
  private toast = inject(ToastService);

  readonly configured = SUPABASE_CONFIGURED;
  private readonly sb: SupabaseClient | null = SUPABASE_CONFIGURED ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
  readonly uid = getUid();

  // ---- État réactif ----
  readonly code = signal<string | null>(null);
  readonly session = signal<Session | null>(null);
  readonly players = signal<Record<string, Player>>({});
  readonly events = signal<GameEvent[]>([]);
  readonly online = signal<Set<string>>(new Set());
  readonly loaded = signal(false);
  readonly gone = signal<string | null>(null);
  readonly now = signal(Date.now());
  readonly myPos = signal<MyPos | null>(null);
  readonly gpsError = signal<string | null>(null);

  // Hors zone
  readonly outOfZoneSince = signal<number | null>(null);
  readonly outOfZoneRemaining = computed(() => {
    const since = this.outOfZoneSince();
    const grace = (this.session()?.settings.outGraceSec ?? 30) * 1000;
    if (since == null) return null;
    return Math.max(0, grace - (this.now() - since));
  });
  readonly distanceOutOfZone = computed(() => {
    const z = this.session()?.settings.zone;
    const pos = this.myPos();
    if (!z || !pos) return 0;
    return Math.max(0, Math.round(distance(pos, z) - z.r));
  });

  readonly me = computed(() => this.players()[this.uid] ?? null);
  readonly isHost = computed(() => this.session()?.host_id === this.uid);
  readonly sortedPlayers = computed(() => Object.values(this.players()).sort((a, b) => a.joined_at - b.joined_at));
  readonly alive = computed(() => this.sortedPlayers().filter((p) => p.role === 'hunted'));
  readonly logEvents = computed(() => this.events().filter((e) => e.type !== 'pos'));
  readonly headStartEnd = computed(() => {
    const s = this.session();
    return s?.start_at != null ? s.start_at + s.settings.headStart * 60000 : 0;
  });
  readonly inHeadStart = computed(() => this.now() < this.headStartEnd());
  readonly shrink = computed(() => shrinkInfo(this.session(), this.now()));
  readonly remaining = computed(() => (this.session()?.end_at ?? 0) - this.now());

  // ---- Interne ----
  private offset = 0;
  private channel: RealtimeChannel | null = null;
  private openedAt = 0;
  private playing = false;
  private watchId: number | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private lastPosWrite = 0;
  private lastSeenWrite = 0;
  private lastCircle: Circle | null = null;
  private lastRadius: number | null = null;
  private wasHead: boolean | null = null;
  private ending = false;
  private eliminatingZone = false;
  private myTrack: Pos[] = [];
  private lastTrackSample = 0;
  private trackFlushed = false;

  constructor() {
    setInterval(() => this.now.set(this.serverNow()), 1000);

    // Démarre / arrête le GPS selon l'état de la partie
    effect(() => {
      const status = this.session()?.status;
      const hasMe = !!this.me();
      untracked(() => {
        if (status === 'playing' && hasMe) this.startPlaying();
        else {
          if (status === 'ended' && hasMe) this.flushMyTrack();
          this.stopPlaying();
        }
      });
    });

    // Boucle de jeu (chaque seconde)
    effect(() => {
      this.now();
      untracked(() => this.tick());
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.code()) {
        this.refresh();
        if (this.playing) this.requestWakeLock();
      }
    });
  }

  serverNow() { return Date.now() + this.offset; }

  private client(): SupabaseClient {
    if (!this.sb) throw new Error("Supabase n'est pas configuré (voir README).");
    return this.sb;
  }

  // =================================================================
  // Connexion à une session
  // =================================================================
  open(code: string) {
    const sb = this.client();
    if (this.code() === code && this.channel) return;
    this.close();
    this.code.set(code);
    this.gone.set(null);
    this.openedAt = Date.now();
    localStorage.setItem('tm_code', code);
    this.syncClock();

    const f = `session_code=eq.${code}`;
    const ch = sb.channel(`session-${code}`, { config: { presence: { key: this.uid } } });
    ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `code=eq.${code}` },
        (p) => this.onSessionUpdate(p.new as Session))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'sessions' },
        (p) => { if ((p.old as Partial<Session>).code === code) this.handleGone('La session a été supprimée.'); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'players', filter: f },
        (p) => this.upsertPlayer(p.new as Player))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'players', filter: f },
        (p) => this.upsertPlayer(p.new as Player))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'players' },
        (p) => {
          const o = p.old as Partial<Player>;
          if (o.session_code === code && o.id) this.removePlayer(o.id);
        })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events', filter: f },
        (p) => this.onEvent(p.new as GameEvent))
      .on('presence', { event: 'sync' }, () => this.online.set(new Set(Object.keys(ch.presenceState()))))
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await ch.track({ at: Date.now() });
          await this.refresh();
        }
      });
    this.channel = ch;
    this.refresh();
  }

  close() {
    if (this.channel) this.sb?.removeChannel(this.channel);
    this.channel = null;
    this.code.set(null);
    this.session.set(null);
    this.players.set({});
    this.events.set([]);
    this.online.set(new Set());
    this.loaded.set(false);
    this.stopPlaying();
  }

  /** Recharge tout l'état depuis la base. */
  async refresh() {
    const code = this.code();
    if (!code || !this.sb) return;
    const [s, p, e] = await Promise.all([
      this.sb.from('sessions').select('*').eq('code', code).maybeSingle(),
      this.sb.from('players').select('*').eq('session_code', code),
      this.sb.from('events').select('*').eq('session_code', code).order('t'),
    ]);
    if (this.code() !== code) return;
    if (s.error || p.error || e.error) {
      console.error(s.error || p.error || e.error);
      return;
    }
    if (!s.data) return this.handleGone('Session introuvable.');
    const map: Record<string, Player> = {};
    for (const pl of p.data as Player[]) map[pl.id] = pl;
    if (!map[this.uid]) return this.handleGone('Tu ne fais pas partie de cette session.');
    this.session.set(s.data as Session);
    this.players.set(map);
    this.events.set(e.data as GameEvent[]);
    this.loaded.set(true);
  }

  private handleGone(msg: string) {
    this.close();
    localStorage.removeItem('tm_code');
    this.gone.set(msg);
    this.toast.show(msg);
  }

  private onSessionUpdate(s: Session) {
    const prev = this.session();
    this.session.set(s);
    if (prev?.status !== s.status) {
      if (s.status === 'ended') this.flushMyTrack();
      this.refresh();
    }
  }

  private upsertPlayer(p: Player) {
    this.players.update((m) => ({ ...m, [p.id]: p }));
  }

  private removePlayer(id: string) {
    if (id === this.uid) return this.handleGone('Tu as été retiré de la session.');
    this.players.update((m) => {
      const { [id]: _removed, ...rest } = m;
      return rest;
    });
  }

  private onEvent(e: GameEvent) {
    if (this.events().some((x) => x.id === e.id)) return;
    this.events.update((l) => [...l, e]);
    if (e.type === 'caught') {
      vibrate([200, 100, 200]);
      if (e.data.victim === this.uid) this.toast.show('Tu es maintenant chasseur 🔴 !');
      else if (e.data.hunter === this.uid) this.toast.show(`🎯 Tu as attrapé ${e.data.victimName} !`);
      else this.toast.show(`🎯 ${e.data.victimName} a été attrapé par ${e.data.hunterName}`);
    } else if (e.type === 'out_of_zone') {
      vibrate([300, 100, 300]);
      if (e.data.victim === this.uid) this.toast.show('🚫 Éliminé hors zone ! Tu deviens chasseur 🔴');
      else this.toast.show(`🚫 ${e.data.victimName} a été éliminé (hors zone)`);
    } else if (e.type === 'start') {
      vibrate(300);
    }
  }

  private async syncClock() {
    if (!this.sb) return;
    const t0 = Date.now();
    const { data, error } = await this.sb.rpc('server_now');
    const t1 = Date.now();
    if (!error && typeof data === 'number') this.offset = data + (t1 - t0) / 2 - t1;
  }

  // =================================================================
  // Actions
  // =================================================================
  async createSession(name: string, settings: Settings): Promise<string> {
    const sb = this.client();
    let code = '';
    for (let i = 0; i < 8; i++) {
      code = randomCode();
      const { error } = await sb.from('sessions').insert({ code, host_id: this.uid, status: 'lobby', settings });
      if (!error) break;
      if (error.code !== '23505' || i === 7) throw new Error(error.message);
    }
    const { error } = await sb.from('players').insert({
      session_code: code, id: this.uid, name, catch_code: random4(), joined_at: Date.now(),
    });
    if (error) throw new Error(error.message);
    return code;
  }

  async join(code: string, name: string) {
    const { error } = await this.client().rpc('join_session', { p_code: code, p_id: this.uid, p_name: name });
    if (error) throw new Error(error.message);
  }

  async leave() {
    const code = this.code();
    this.close();
    localStorage.removeItem('tm_code');
    if (code) await this.client().rpc('leave_session', { p_code: code, p_id: this.uid });
  }

  async toggleRole(p: Player) {
    const role: Role = p.role === 'hunter' ? 'hunted' : 'hunter';
    await this.client().from('players').update({ role }).eq('session_code', p.session_code).eq('id', p.id);
  }

  async start() {
    const s = this.session();
    if (!s) return;
    const ids = this.sortedPlayers().map((p) => p.id);
    let hunters: string[];
    if (s.settings.roleMode === 'random') {
      const shuffled = [...ids].sort(() => Math.random() - 0.5);
      hunters = shuffled.slice(0, Math.min(Math.max(1, s.settings.hunters), ids.length - 1));
    } else {
      hunters = this.sortedPlayers().filter((p) => p.role === 'hunter').map((p) => p.id);
      if (!hunters.length) throw new Error('Choisis au moins un chasseur.');
      if (hunters.length === ids.length) throw new Error('Il faut au moins un chassé.');
    }
    const { error } = await this.client().rpc('start_game', { p_code: s.code, p_hunters: hunters });
    if (error) throw new Error(error.message);
  }

  async declareCaught(catchCode: string) {
    const { error } = await this.client().rpc('catch_player', {
      p_code: this.code(), p_victim: this.uid, p_catch_code: catchCode,
    });
    if (error) throw new Error(error.message);
    this.lastCircle = null;
  }

  async replay() {
    const { error } = await this.client().rpc('reset_game', { p_code: this.code() });
    if (error) throw new Error(error.message);
  }

  // =================================================================
  // Boucle de jeu & Zone autorisée & Trajectoire
  // =================================================================
  private tick() {
    const s = this.session();
    if (!s || !this.code()) return;

    if (s.status === 'lobby') return this.claimHostIfNeeded(s);
    if (s.status !== 'playing' || !this.me()) return;

    const { radius } = this.shrink();
    const inHead = this.inHeadStart();
    if (this.lastRadius != null && radius < this.lastRadius) {
      vibrate([150, 80, 150]);
      this.toast.show(`⭕ Les cercles rétrécissent : ${radius} m`);
    }
    if (this.wasHead === true && !inHead) {
      vibrate(400);
      this.toast.show('🔴 La chasse commence !');
    }
    this.lastRadius = radius;
    this.wasHead = inHead;

    this.checkZone(s);
    this.publishPosition();
    this.checkEnd(s);
  }

  /** Vérifie si le joueur est en dehors de la zone autorisée et applique le compte à rebours d'élimination. */
  private checkZone(s: Session) {
    const z = s.settings.zone;
    const pos = this.myPos();
    const m = this.me();
    if (!z || !pos || !m || m.role !== 'hunted') {
      if (this.outOfZoneSince() != null) this.outOfZoneSince.set(null);
      return;
    }
    const d = distance(pos, z);
    if (d <= z.r) {
      if (this.outOfZoneSince() != null) {
        this.outOfZoneSince.set(null);
        this.toast.show('✅ De retour dans la zone autorisée !');
      }
      return;
    }
    // Le joueur est hors de la zone
    let since = this.outOfZoneSince();
    if (since == null) {
      since = this.now();
      this.outOfZoneSince.set(since);
      vibrate([250, 100, 250]);
      this.toast.show(`⚠️ Hors zone ! Rentre vite (${s.settings.outGraceSec ?? 30} s)`);
    }
    const graceMs = (s.settings.outGraceSec ?? 30) * 1000;
    if (this.now() - since >= graceMs && !this.eliminatingZone) {
      this.eliminateOutOfZone();
    }
  }

  private async eliminateOutOfZone() {
    const code = this.code();
    const m = this.me();
    if (!code || !m || m.role !== 'hunted' || !this.sb) return;
    this.eliminatingZone = true;
    const t = this.serverNow();
    try {
      await this.sb.from('players').update({
        role: 'hunter',
        caught_by: 'ZONE',
        caught_at: t,
        circle: null,
      }).eq('session_code', code).eq('id', this.uid);
      await this.sb.from('events').insert({
        session_code: code,
        type: 'out_of_zone',
        t,
        data: { victim: this.uid, victimName: m.name },
      });
      this.outOfZoneSince.set(null);
      this.lastCircle = null;
    } finally {
      this.eliminatingZone = false;
    }
  }

  /** Si l'hôte est hors ligne, le premier joueur connecté devient hôte. */
  private claimHostIfNeeded(s: Session) {
    if (Date.now() - this.openedAt < 8000) return;
    const online = this.online();
    if (!online.has(this.uid) || online.has(s.host_id)) return;
    const first = this.sortedPlayers().find((p) => online.has(p.id));
    if (first?.id === this.uid) {
      this.sb?.from('sessions').update({ host_id: this.uid }).eq('code', s.code).then();
      this.openedAt = Date.now();
    }
  }

  private checkEnd(s: Session) {
    if (this.ending || s.end_at == null) return;
    if (this.now() < s.end_at && this.alive().length > 0) return;
    this.ending = true;
    this.sb?.rpc('end_game', { p_code: s.code }).then(() => setTimeout(() => (this.ending = false), 3000));
  }

  private startPlaying() {
    if (this.playing) return;
    this.playing = true;
    this.lastRadius = null;
    this.wasHead = null;
    this.lastCircle = null;
    this.lastPosWrite = 0;
    this.lastSeenWrite = 0;
    this.ending = false;
    this.eliminatingZone = false;
    this.outOfZoneSince.set(null);
    this.myTrack = this.loadLocalTrack();
    this.lastTrackSample = 0;
    this.trackFlushed = false;
    this.requestWakeLock();
    if (!('geolocation' in navigator)) {
      this.gpsError.set('GPS non disponible sur cet appareil');
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        this.gpsError.set(null);
        this.myPos.set({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) });
        this.sampleMyTrack();
        this.publishPosition();
      },
      (err) => this.gpsError.set(err.code === 1
        ? 'Localisation refusée – autorise-la dans les réglages'
        : 'Signal GPS faible…'),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 },
    );
  }

  private stopPlaying() {
    if (!this.playing) return;
    this.playing = false;
    this.outOfZoneSince.set(null);
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  /** Enregistre localement un point GPS toutes les 6 s (ou dès 8 m de déplacement) pour le récap de fin. */
  private sampleMyTrack() {
    const pos = this.myPos(), m = this.me();
    if (!pos || !m || this.session()?.status !== 'playing') return;
    const t = this.serverNow();
    const last = this.myTrack[this.myTrack.length - 1];
    if (last && t - this.lastTrackSample < 6000 && distance(pos, last) < 8) return;
    this.lastTrackSample = t;
    this.myTrack.push({
      lat: Number(pos.lat.toFixed(6)),
      lng: Number(pos.lng.toFixed(6)),
      t,
      role: m.role,
    });
    try {
      localStorage.setItem(`tm_track_${this.code()}_${this.session()?.start_at}`, JSON.stringify(this.myTrack));
    } catch { /* quota */ }
  }

  private loadLocalTrack(): Pos[] {
    try {
      const raw = localStorage.getItem(`tm_track_${this.code()}_${this.session()?.start_at}`);
      return raw ? (JSON.parse(raw) as Pos[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * À la fin de la partie seulement, chaque joueur envoie sa trajectoire complète dans `events`
   * pour que l'écran de fin puisse afficher le parcours exact de tout le monde (sans jamais
   * révéler la position exacte des chassés pendant la partie).
   */
  private async flushMyTrack() {
    if (this.trackFlushed || !this.sb) return;
    const code = this.code(), m = this.me();
    if (!code || !m) return;
    if (!this.myTrack.length) this.myTrack = this.loadLocalTrack();
    if (!this.myTrack.length) return;
    this.trackFlushed = true;
    // Évite les doublons si déjà envoyé
    if (this.events().some((e) => e.type === 'pos' && e.data.playerId === this.uid)) return;
    const rows = this.myTrack.map((pt) => ({
      session_code: code,
      type: 'pos',
      t: pt.t,
      data: { playerId: this.uid, playerName: m.name, lat: pt.lat, lng: pt.lng, role: pt.role },
    }));
    await this.sb.from('events').insert(rows);
    try { localStorage.removeItem(`tm_track_${code}_${this.session()?.start_at}`); } catch { /* ignore */ }
  }

  private updateMe(values: Partial<Player>) {
    const code = this.code();
    if (!code || !this.sb) return;
    this.sb.from('players').update(values).eq('session_code', code).eq('id', this.uid)
      .then(({ error }) => { if (error) console.error(error); });
  }

  private publishPosition() {
    const m = this.me(), pos = this.myPos();
    if (!m || !pos || this.session()?.status !== 'playing') return;
    this.sampleMyTrack();
    const t = this.serverNow();
    if (m.role === 'hunter') {
      if (t - this.lastPosWrite > 4000) {
        this.lastPosWrite = t;
        this.updateMe({ pos: { lat: pos.lat, lng: pos.lng, t }, seen: t });
      }
    } else {
      this.maybeUpdateCircle(pos);
      if (t - this.lastSeenWrite > 10000) {
        this.lastSeenWrite = t;
        this.updateMe({ seen: t });
      }
    }
  }

  /**
   * Cercle d'un chassé : son centre est décalé aléatoirement, la vraie position est toujours dedans.
   * Il est régénéré quand le chassé approche du bord ou quand le rayon rétrécit.
   * La position exacte d'un chassé n'est jamais envoyée pendant la partie.
   */
  private maybeUpdateCircle(pos: MyPos) {
    const m = this.me();
    if (!m || m.role !== 'hunted') return;
    const { radius } = this.shrink();
    const now = this.serverNow();
    const refreshSec = this.session()?.settings.circleRefreshSec;
    const c = this.lastCircle && this.lastCircle.t >= (m.circle?.t ?? 0) ? this.lastCircle : m.circle;
    const d = c ? distance(pos, c) : Infinity;
    const expired = !!(c && refreshSec && refreshSec > 0 && now - c.t >= refreshSec * 1000);
    if (!c || c.r !== radius || d > radius * 0.85 || expired) {
      const center = destPoint(pos, radius * (0.1 + Math.random() * 0.6), Math.random() * 360);
      const circle: Circle = { lat: center.lat, lng: center.lng, r: radius, t: now };
      this.lastCircle = circle;
      this.updateMe({ circle });
    }
  }

  private async requestWakeLock() {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl && this.playing) this.wakeLock = await wl.request('screen');
    } catch { /* non supporté */ }
  }
}
