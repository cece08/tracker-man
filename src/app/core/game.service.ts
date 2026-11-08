import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AllyShareMode, Circle, GameEvent, Player, Pos, Role, Session, Settings } from './models';
import { LatLng, destPoint, distance, randomCode, secureRandomUnit, secureShuffle, vibrate } from './utils';
import { CryptoService, E2eeEnvelope, EncryptedRoleTicket, isValidLatLng, isValidRadius, isValidUid, sanitizeCoord, sanitizeName } from './crypto.service';
import { P2pSessionMesh, RtcSignalPayload } from './p2p-transport';
import { ToastService } from './toast.service';

export interface MyPos { lat: number; lng: number; acc: number; t: number; }

/**
 * Délais de connexion à une session. Les dérivations PBKDF2 + la connexion aux relais WSS
 * peuvent prendre plusieurs secondes sur un téléphone d'entrée de gamme en 4G :
 * des délais trop courts provoquaient de faux « Session introuvable ».
 */
const JOIN_TIMEOUT_MS = 25_000;
const OPEN_TIMEOUT_MS = 25_000;

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

/** Identifiant technique 128 bits généré par CSPRNG (Web Crypto API). */
function getUid(): string {
  let uid = localStorage.getItem('tm_uid');
  if (!uid || !/^p[a-z0-9]{12,40}$/.test(uid)) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    uid = 'p' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('tm_uid', uid); } catch { /* ignore */ }
  }
  return uid;
}

/** Jeton secret 256 bits (CSPRNG) éphémère : stocké uniquement en mémoire vive (sessionStorage). */
function getSecret(): string {
  let sec = sessionStorage.getItem('tm_secret');
  if (!sec || !/^[0-9a-f]{64}$/.test(sec)) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    sec = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      sessionStorage.setItem('tm_secret', sec);
      localStorage.removeItem('tm_secret'); // Purge de sécurité de l'ancien localStorage
    } catch { /* ignore */ }
  }
  return sec;
}

interface EncryptedSnapshot {
  session: Session;
  players: Record<string, Player>;
  events: GameEvent[];
  myTrack: Pos[];
  lastCircle: Circle | null;
}

@Injectable({ providedIn: 'root' })
export class GameService {
  private toast = inject(ToastService);
  private crypto = inject(CryptoService);

  /** Mode 100 % autonome P2P (aucune base de données ni serveur requis). */
  readonly configured = true;
  readonly uid = getUid();
  private readonly secret = getSecret();

  // ---- État réactif (100 % en mémoire vive RAM) ----
  readonly code = signal<string | null>(null);
  readonly sessionKey = signal<string | null>(null);
  readonly session = signal<Session | null>(null);
  readonly players = signal<Record<string, Player>>({});
  readonly events = signal<GameEvent[]>([]);
  readonly online = signal<Set<string>>(new Set());
  readonly loaded = signal(false);
  readonly gone = signal<string | null>(null);
  readonly now = signal(Date.now());
  readonly myPos = signal<MyPos | null>(null);
  readonly gpsError = signal<string | null>(null);
  readonly gpsRevoked = signal<boolean>(localStorage.getItem('tm_gps_revoked') === '1');
  readonly myCatchCode = signal<string>('----');

  // Partage de position entre chassés (activable/modifiable en direct pendant la partie)
  readonly allyShareMode = signal<AllyShareMode>('off');
  readonly allyExactPos = signal<Record<string, Pos>>({});

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
  readonly logEvents = computed(() => this.events().filter((e) => e.type !== 'pos' && e.type !== 'track'));
  readonly headStartEnd = computed(() => {
    const s = this.session();
    return s?.start_at != null ? s.start_at + s.settings.headStart * 60000 : 0;
  });
  readonly inHeadStart = computed(() => this.now() < this.headStartEnd());
  readonly shrink = computed(() => shrinkInfo(this.session(), this.now()));
  readonly remaining = computed(() => (this.session()?.end_at ?? 0) - this.now());

  // ---- Interne P2P & Anti-Bruteforce ----
  private offset = 0;
  private mesh: P2pSessionMesh | null = null;
  private peerLastSeen = new Map<string, number>();
  private peerVerifiedRate = new Map<string, { count: number; windowStart: number }>();
  private openedAt = 0;
  private playing = false;
  private watchId: number | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private lastPosWrite = 0;
  private lastCircleBroadcast = 0;
  private lastHeartbeatAt = 0;
  private lastCircle: Circle | null = null;
  private lastRadius: number | null = null;
  private wasHead: boolean | null = null;
  private ending = false;
  private eliminatingZone = false;
  private myTrack: Pos[] = [];
  private lastTrackSample = 0;
  private trackFlushed = false;
  private lastValidGps: { lat: number; lng: number; t: number } | null = null;
  private lastAllyBroadcast = 0;
  readonly myTrackShared = signal(false);
  myTrackLength(): number { return this.myTrack.length; }
  private pendingCatchResolver: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private hunterProbeCounts = new Map<string, { count: number; windowStart: number }>();
  private failedCatchAttempts = 0;
  private catchLockedUntil = 0;
  private currentHunterSecret: string | null = null;
  private currentAllySecret: string | null = null;
  private peerLastPos = new Map<string, { lat: number; lng: number; t: number }>();
  private peerLastCircle = new Map<string, { lat: number; lng: number; r: number; t: number }>();
  private joinResolvers: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private openTimeout: ReturnType<typeof setTimeout> | null = null;

  huntedLeaderId(): string | null {
    const aliveHunted = this.sortedPlayers().filter((p) => p.role === 'hunted');
    return aliveHunted[0]?.id ?? null;
  }

  hunterLeaderId(): string | null {
    const hunters = this.sortedPlayers().filter((p) => p.role === 'hunter');
    return hunters[0]?.id ?? null;
  }

  isHuntedLeader(): boolean {
    return this.huntedLeaderId() === this.uid;
  }

  isHunterLeader(): boolean {
    return this.hunterLeaderId() === this.uid;
  }

  constructor() {
    this.purgeLegacyStorage();
    setInterval(() => this.now.set(this.serverNow()), 1000);

    // Démarre / arrête le GPS selon l'état de la partie
    effect(() => {
      const status = this.session()?.status;
      const hasMe = !!this.me();
      untracked(() => {
        if (status === 'playing' && hasMe) this.startPlaying();
        else {
          if (status === 'ended' && hasMe) void this.flushMyTrack();
          this.stopPlaying();
        }
      });
    });

    // Boucle de jeu et présence P2P (chaque seconde)
    effect(() => {
      this.now();
      untracked(() => this.tick());
    });

    window.addEventListener('beforeunload', () => {
      if (this.code() && this.mesh) {
        void this.sendP2p('s', 'bye', { id: this.uid });
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.playing) {
        vibrate([300, 100, 300]);
        this.notifyBackgroundWarning();
      } else if (document.visibilityState === 'visible' && this.code()) {
        this.mesh?.reviveStaleRelays();
        this.refresh();
        if (this.playing) {
          this.requestWakeLock();
          this.toast.show('⚠️ Garde l’écran allumé (ou utilise le 🌙 Mode poche) pour ne pas couper le GPS !', 4500);
        }
      }
    });
  }

  private purgeLegacyStorage() {
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('tm_track_')) localStorage.removeItem(k);
      }
    } catch { /* ignore */ }
  }

  private notifyBackgroundWarning() {
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('⚠️ Tracker Man : GPS en pause !', {
          body: 'Rallume l’écran et utilise le 🌙 Mode poche avant de ranger ton téléphone.',
          tag: 'tm-bg-warn',
        });
      }
    } catch { /* non supporté */ }
  }

  serverNow() { return Date.now() + this.offset; }

  /** Validation de plausibilité physique distribuée contre le spoofing GPS et la téléportation. */
  private validatePeerVelocity(peerId: string, newPos: Pos): boolean {
    const localNow = this.serverNow();
    const prev = this.peerLastPos.get(peerId);
    if (!prev) {
      this.peerLastPos.set(peerId, { ...newPos, t: localNow });
      return true;
    }
    // Calcul basé sur l'horloge locale de réception pour interdire les faux timestamps émetteur
    const dtSec = Math.max(0.5, (localNow - prev.t) / 1000);
    const dist = distance(prev, newPos);
    const speed = dist / dtSec;

    // Vitesse max plausible : 12 m/s (~43 km/h en course/vélo urbain).
    // Rejet strict dès 15 mètres sans seuil de bypass permissif.
    if (dist > 15 && speed > 12) {
      return false;
    }

    // Vérification des limites de zone de jeu
    const zone = this.session()?.settings.zone;
    if (zone && distance(newPos, zone) > zone.r * 1.5) {
      return false;
    }

    this.peerLastPos.set(peerId, { ...newPos, t: localNow });
    return true;
  }

  // =================================================================
  // Connexion au maillage P2P E2EE (Zéro Serveur / Zéro Base de Données)
  // =================================================================
  open(code: string, explicitKey?: string) {
    const cleanCode = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleanCode.length !== 6) return;

    let secretKey = explicitKey;
    if (!secretKey && typeof window !== 'undefined') {
      const hashParams = new URLSearchParams(window.location.hash.replace(/^[#/?]+/, '?'));
      secretKey = hashParams.get('k') || sessionStorage.getItem(`tm_sk_${cleanCode}`) || undefined;
    }
    if (secretKey) {
      try { sessionStorage.setItem(`tm_sk_${cleanCode}`, secretKey); } catch { /* ignore */ }
      this.sessionKey.set(secretKey);
      this.crypto.setSessionSecret(secretKey);
    }

    if (this.code() === cleanCode && this.mesh) return;

    const existingSession = this.session()?.code === cleanCode ? this.session() : null;
    const existingPlayers = existingSession ? this.players() : {};
    const existingEvents = existingSession ? this.events() : [];

    this.close();
    this.code.set(cleanCode);
    this.gone.set(null);
    this.openedAt = Date.now();
    this.peerLastSeen.set(this.uid, Date.now());
    this.online.set(new Set([this.uid]));
    try { localStorage.setItem('tm_code', cleanCode); } catch { /* ignore */ }

    if (existingSession) {
      this.session.set(existingSession);
      this.players.set(existingPlayers);
      this.events.set(existingEvents);
      this.loaded.set(true);
    }

    void this.initP2pMesh(cleanCode, !!existingSession);
  }

  private async initP2pMesh(cleanCode: string, alreadyLoaded: boolean) {
    if (!alreadyLoaded) {
      const restored = await this.restoreEncryptedSnapshot(cleanCode);
      if (restored && this.code() === cleanCode) {
        this.loaded.set(true);
      }
    }

    await this.refreshMyCatchCode(cleanCode, this.session()?.start_at ?? 0);
    const hasKey = !!this.sessionKey();

    // Dérivations PBKDF2 lancées en parallèle (et mises en cache) pour réduire le délai de connexion sur mobile.
    const [blindTopic, qrRendezvousTopic, manualRendezvousTopic] = await Promise.all([
      this.crypto.getBlindTopic(cleanCode, this.secret),
      this.crypto.getRendezvousTopic(cleanCode, this.sessionKey()),
      this.crypto.getRendezvousTopic(cleanCode, null),
    ]);
    if (this.code() !== cleanCode) return;

    // Si le secret 128 bits est connu (hôte ou scan QR), on écoute blindTopic ET les topics de rendez-vous.
    // Sinon (saisie manuelle du code 6 lettres), on démarre sur le topic de rendez-vous manuel avec KDF lourd [CRIT-01]
    const topicsToListen = hasKey
      ? [blindTopic, qrRendezvousTopic, manualRendezvousTopic]
      : [manualRendezvousTopic];
    const primaryTopic = hasKey ? blindTopic : manualRendezvousTopic;

    this.mesh = new P2pSessionMesh(
      this.uid,
      topicsToListen,
      (env) => void this.onP2pEnvelope(env),
      () => {
        void this.broadcastPresenceAndSync();
      },
      (rtcSig) => {
        void this.sendP2p('s', 'rtc_signal', rtcSig);
      },
    );

    // Envoie immédiatement une requête de synchronisation / présence sur le maillage
    void this.broadcastPresenceAndSync();

    if (this.openTimeout) clearTimeout(this.openTimeout);
    this.openTimeout = setTimeout(() => {
      if (this.code() === cleanCode && !this.loaded()) {
        this.handleGone('Session introuvable ou tous les participants ont quitté.');
      }
    }, OPEN_TIMEOUT_MS);
  }

  private async refreshMyCatchCode(code: string, startAt: number) {
    const c = await this.crypto.deriveMyCatchCode(code, startAt, this.secret, this.uid);
    this.myCatchCode.set(c);
  }

  private async broadcastPresenceAndSync() {
    const code = this.code();
    if (!code || !this.mesh) return;
    const identity = await this.crypto.getDeviceIdentity();
    const myName = sanitizeName(this.me()?.name ?? localStorage.getItem('tm_name') ?? 'Joueur');

    if (!this.session() || !this.me()) {
      const powNonce = await this.crypto.solveProofOfWork(code, this.uid);
      await this.sendP2p('s', 'join_req', {
        name: myName,
        pubKey: identity.publicKeySpkiB64,
        ecdhKey: identity.ecdhPublicKeySpkiB64,
        powNonce,
      });
    } else {
      await this.sendP2p('s', 'sync_req', { at: this.serverNow() });
      await this.sendHeartbeat();
      if (this.isHost()) {
        await this.broadcastFullStateSync();
      }
    }
  }

  close() {
    if (this.openTimeout) clearTimeout(this.openTimeout);
    this.openTimeout = null;
    const c = this.code();
    if (c) this.removeEncryptedSnapshot(c);
    this.clearLocalTracks();
    if (this.mesh) this.mesh.close();
    this.mesh = null;
    this.peerLastSeen.clear();
    this.peerLastPos.clear();
    this.code.set(null);
    this.sessionKey.set(null);
    this.session.set(null);
    this.players.set({});
    this.events.set([]);
    this.online.set(new Set());
    this.allyExactPos.set({});
    this.currentHunterSecret = null;
    this.currentAllySecret = null;
    this.myTrackShared.set(false);
    this.pendingCatchResolver = null;
    this.hunterProbeCounts.clear();
    this.peerVerifiedRate.clear();
    this.crypto.clearSessionKeys();
    this.loaded.set(false);
    this.stopPlaying();
  }

  /** Synchronise l'état avec les pairs connectés en mémoire vive. */
  async refresh() {
    const code = this.code();
    if (!code || !this.mesh) return;
    await this.sendP2p('s', 'sync_req', { at: this.serverNow() });
    await this.sendHeartbeat();
  }

  private handleGone(msg: string) {
    const resolvers = [...this.joinResolvers];
    this.joinResolvers = [];
    for (const r of resolvers) r.reject(new Error(msg));
    const c = this.code();
    if (c) this.removeEncryptedSnapshot(c);
    this.close();
    try { localStorage.removeItem('tm_code'); } catch { /* ignore */ }
    this.gone.set(msg);
    this.toast.show(msg);
  }

  // =================================================================
  // Protocole de messagerie P2P E2EE (AES-256-GCM + ECDSA P-256)
  // =================================================================
  private async sendP2p<T>(
    scope: 's' | 'h' | 'a',
    type: E2eeEnvelope['t'],
    payload: T,
  ) {
    const code = this.code();
    if (!code || !this.mesh) return;
    try {
      const env = await this.crypto.encryptPacket(
        code,
        this.secret,
        scope,
        type,
        this.uid,
        this.serverNow(),
        payload,
      );
      this.mesh.broadcast(env);
    } catch { /* ignore */ }
  }

  private async broadcastFullStateSync() {
    const s = this.session();
    if (!s) return;
    // Nettoie les positions exactes de chasseurs dans le snapshot général (elles passent sur la clé 'h')
    const sanitizedPlayers: Record<string, Player> = {};
    for (const [id, pl] of Object.entries(this.players())) {
      sanitizedPlayers[id] = {
        ...pl,
        catch_code: '****',
        pos: null,
      };
    }
    await this.sendP2p('s', 'state_sync', {
      session: s,
      players: sanitizedPlayers,
      events: this.events().filter((e) => e.type !== 'pos' && e.type !== 'track'),
    });
  }

  private async sendHeartbeat() {
    const m = this.me();
    if (!m) return;
    await this.sendP2p('s', 'heartbeat', {
      role: m.role,
      seen: this.serverNow(),
    });
  }

  private markPeerSeen(peerUid: string) {
    this.peerLastSeen.set(peerUid, Date.now());
    this.peerLastSeen.set(this.uid, Date.now());
    this.updateOnlineSet();
    this.mesh?.ensurePeerConnection(peerUid);
  }

  private updateOnlineSet() {
    const now = Date.now();
    const active = new Set<string>([this.uid]);
    for (const [id, ts] of this.peerLastSeen.entries()) {
      if (now - ts < 13_000) active.add(id);
    }
    this.online.set(active);
  }

  private async onP2pEnvelope(rawEnv: E2eeEnvelope) {
    const code = this.code();
    if (!code) return;

    if (!isValidUid(rawEnv.u)) return;

    const myRole = this.me()?.role;
    if (rawEnv.k === 'h' && myRole && myRole !== 'hunter') return;
    if (rawEnv.k === 'a' && myRole && myRole !== 'hunted') return;

    const allowHist = rawEnv.t === 'track' || rawEnv.t === 'state_sync';
    const pkt = await this.crypto.decryptPacket<unknown>(
      code,
      this.secret,
      rawEnv,
      this.serverNow(),
      allowHist,
    );
    if (!pkt || pkt.senderUid === this.uid || !isValidUid(pkt.senderUid)) return;

    this.markPeerSeen(pkt.senderUid);

    // Rate Limiting post-authentification cryptographique ECDSA P-256 certifiée [MAJ-01]
    const nowRate = Date.now();
    const rate = this.peerVerifiedRate.get(pkt.senderUid) ?? { count: 0, windowStart: nowRate };
    if (nowRate - rate.windowStart > 1000) {
      rate.count = 0;
      rate.windowStart = nowRate;
    }
    rate.count++;
    this.peerVerifiedRate.set(pkt.senderUid, rate);
    if (rate.count > 20) {
      return; // Dépassement de quota par cet émetteur authentifié
    }

    // Vérifie qu'un pair existant utilise toujours la même clé publique ECDSA P-256 (anti-usurpation)
    const knownPlayer = this.players()[pkt.senderUid];
    if (knownPlayer?.pub_key && knownPlayer.pub_key !== pkt.senderPubKey) {
      return; // Rejet immédiat : tentative d'usurpation d'identité bloquée par ECDSA P-256
    }

    switch (pkt.type) {
      case 'rtc_signal': {
        await this.mesh?.handleRtcSignal(pkt.senderUid, pkt.data as RtcSignalPayload);
        return;
      }

      case 'heartbeat': {
        const d = pkt.data as { seen?: number } | null;
        if (knownPlayer && d) {
          this.players.update((m) => ({
            ...m,
            [pkt.senderUid]: {
              ...m[pkt.senderUid],
              seen: d.seen ?? pkt.ts,
            },
          }));
        }
        return;
      }

      case 'bye': {
        this.peerLastSeen.delete(pkt.senderUid);
        this.mesh?.removePeer(pkt.senderUid);
        this.updateOnlineSet();
        return;
      }

      case 'join_req': {
        const d = pkt.data as { name?: string; pubKey?: string; ecdhKey?: string; powNonce?: string } | null;
        const s = this.session();
        if (!d || !s) return;

        // Protection anti-Sybil par preuve de travail cryptographique
        if (d.powNonce) {
          const validPow = await this.crypto.verifyProofOfWork(code, pkt.senderUid, d.powNonce);
          if (!validPow) return; // Rejet : challenge PoW invalide
        }

        const existing = this.players()[pkt.senderUid];
        if (existing) {
          const cleanName = sanitizeName(d.name ?? existing.name);
          this.players.update((m) => ({
            ...m,
            [pkt.senderUid]: {
              ...existing,
              name: cleanName,
              pub_key: existing.pub_key ?? pkt.senderPubKey,
              ecdh_key: d.ecdhKey || existing.ecdh_key,
            },
          }));
          if (this.isHost() || !this.online().has(s.host_id)) {
            void this.broadcastFullStateSync();
            if (this.isHost() && d.ecdhKey && this.sessionKey()) {
              void this.dispatchSessionSecretToPeer(pkt.senderUid, d.ecdhKey);
            }
            if (s.status === 'playing') {
              void this.dispatchRoleKeyToPlayer(pkt.senderUid);
            }
          }
          void this.persistEncryptedSnapshot();
          return;
        }
        if (s.status !== 'lobby') {
          if (this.isHost()) {
            void this.sendP2p('s', 'player_kick', {
              targetId: pkt.senderUid,
              reason: 'La partie a déjà commencé.',
            });
          }
          return;
        }
        if (Object.keys(this.players()).length >= 60) return;
        const newPlayer: Player = {
          session_code: code,
          id: pkt.senderUid,
          name: sanitizeName(d.name),
          role: 'hunted',
          initial_role: null,
          catch_code: '****',
          catch_commitment: '',
          pub_key: pkt.senderPubKey,
          ecdh_key: d.ecdhKey ?? '',
          joined_at: pkt.ts,
          caught_by: null,
          caught_at: null,
          circle: null,
          pos: null,
          seen: pkt.ts,
        };
        this.players.update((m) => ({ ...m, [pkt.senderUid]: newPlayer }));
        if (this.isHost() || !this.online().has(s.host_id)) {
          void this.broadcastFullStateSync();
          if (this.isHost() && d.ecdhKey && this.sessionKey()) {
            void this.dispatchSessionSecretToPeer(pkt.senderUid, d.ecdhKey);
          }
        }
        void this.persistEncryptedSnapshot();
        return;
      }

      case 'session_secret': {
        const s = this.session();
        const d = pkt.data as { targetUid?: string; iv?: string; ct?: string } | null;
        if (!d || d.targetUid !== this.uid || !d.iv || !d.ct) return;
        const hostId = s?.host_id ?? pkt.senderUid;
        const hostPlayer = this.players()[hostId];
        const ecdhKey = hostPlayer?.ecdh_key || pkt.senderPubKey;
        try {
          const secret = await this.crypto.unwrapSecretFromPeer(ecdhKey, d.iv, d.ct);
          if (secret && /^[0-9a-f]{32,64}$/i.test(secret)) {
            this.sessionKey.set(secret);
            this.crypto.setSessionSecret(secret);
            try { sessionStorage.setItem(`tm_sk_${code}`, secret); } catch { /* ignore */ }
            const blindTopic = await this.crypto.getBlindTopic(code, this.secret);
            this.mesh?.setPrimaryTopic(blindTopic);
          }
        } catch { /* ignore */ }
        return;
      }

      case 'sync_req': {
        const s = this.session();
        if (s) {
          if (this.isHost() || !this.online().has(s.host_id)) {
            void this.broadcastFullStateSync();
            if (this.isHost() && s.status === 'playing') {
              void this.dispatchRoleKeyToPlayer(pkt.senderUid);
            }
          }
          this.respondRealtimeState();
        }
        return;
      }

      case 'state_sync': {
        const d = pkt.data as {
          session?: Session;
          players?: Record<string, Player>;
          events?: GameEvent[];
        } | null;
        if (!d?.session || !d.players || d.session.code !== code) return;

        const curSession = this.session();
        // N'accepte une synchronisation d'état que si nous n'avons pas encore chargé la session,
        // ou si elle provient de l'hôte authentifié par sa clé ECDSA P-256
        const hostPlayer = this.players()[curSession?.host_id ?? d.session.host_id] ?? d.players[d.session.host_id];
        const isFromHost = pkt.senderUid === (curSession?.host_id ?? d.session.host_id) &&
          (!hostPlayer?.pub_key || hostPlayer.pub_key === pkt.senderPubKey);
        if (curSession && !isFromHost) return;

        // Synchronise l'horloge avec l'hôte pour que les chronos soient identiques à la milliseconde près
        if (isFromHost && pkt.ts) {
          this.offset = pkt.ts - Date.now();
        }

        const mergedPlayers: Record<string, Player> = {};
        const prevPlayers = this.players();
        for (const [id, rawPl] of Object.entries(d.players)) {
          const prev = prevPlayers[id];
          mergedPlayers[id] = {
            ...rawPl,
            name: sanitizeName(rawPl.name),
            catch_code: '****',
            pos: rawPl.role === 'hunter' ? (prev?.pos ?? null) : null,
            circle: rawPl.role === 'hunted' ? (prev?.circle ?? rawPl.circle ?? null) : null,
            seen: prev?.seen ?? rawPl.seen ?? null,
          };
        }

        if (!mergedPlayers[this.uid]) return;

        const prevStatus = curSession?.status;
        this.session.set(d.session);
        this.players.set(mergedPlayers);

        if (Array.isArray(d.events)) {
          const tracks = this.events().filter((e) => e.type === 'track');
          const incomingLogs = d.events.filter((e) => e.type !== 'pos' && e.type !== 'track');
          for (const ev of incomingLogs) this.notifyIfNewEvent(ev);
          this.events.set([...incomingLogs, ...tracks]);
        }

        this.loaded.set(true);
        if (d.session.start_at && prevStatus !== d.session.status) {
          void this.refreshMyCatchCode(code, d.session.start_at);
        }
        const resolvers = [...this.joinResolvers];
        this.joinResolvers = [];
        for (const r of resolvers) r.resolve();
        void this.persistEncryptedSnapshot();
        return;
      }

      case 'session_patch': {
        const s = this.session();
        if (!s) return;
        const d = pkt.data as Partial<Session> & { claimHost?: boolean } | null;
        if (!d) return;
        const isCurrentHost = pkt.senderUid === s.host_id;
        const lastHostSeen = this.peerLastSeen.get(s.host_id) ?? 0;
        const isHostDead = Date.now() - lastHostSeen >= 45000;
        const eligible = this.sortedPlayers().filter((p) => this.online().has(p.id));
        const isOldestEligible = eligible[0]?.id === pkt.senderUid;
        const canClaimHost = d.claimHost && s.status === 'lobby' && isHostDead && isOldestEligible;
        if (!isCurrentHost && !canClaimHost) return;

        const cleanPatch = d.settings ? { ...d, settings: this.sanitizeSettings(d.settings) } : d;
        this.session.update((cur) => (cur ? { ...cur, ...cleanPatch } : cur));
        void this.persistEncryptedSnapshot();
        return;
      }

      case 'player_patch': {
        const s = this.session();
        if (!s) return;
        const d = pkt.data as { targetId?: string; patch?: Partial<Player> } | null;
        if (!d?.targetId || !d.patch) return;
        const isSelf = pkt.senderUid === d.targetId;
        const isHost = pkt.senderUid === s.host_id;
        if (!isSelf && !isHost) return;

        const target = this.players()[d.targetId];
        if (!target) return;

        const updated: Player = {
          ...target,
          name: d.patch.name ? sanitizeName(d.patch.name) : target.name,
          role: isHost && (d.patch.role === 'hunter' || d.patch.role === 'hunted') ? d.patch.role : target.role,
        };
        this.players.update((m) => ({ ...m, [d.targetId!]: updated }));
        void this.persistEncryptedSnapshot();
        return;
      }

      case 'player_kick': {
        const s = this.session();
        const d = pkt.data as { targetId?: string; reason?: string; voluntaryLeave?: boolean } | null;
        if (!d?.targetId) return;
        const isHost = s && pkt.senderUid === s.host_id;
        const isSelfLeave = pkt.senderUid === d.targetId && d.voluntaryLeave;
        if (!isHost && !isSelfLeave) return;

        if (d.targetId === this.uid) {
          this.handleGone(d.reason ?? "Tu as été exclu de la session par l'hôte.");
          return;
        }
        this.players.update((m) => {
          const { [d.targetId!]: _r, ...rest } = m;
          return rest;
        });
        this.peerLastSeen.delete(d.targetId);
        this.mesh?.removePeer(d.targetId);
        this.updateOnlineSet();
        if (s && d.targetId === s.host_id) {
          const nextHost = this.sortedPlayers()[0]?.id;
          if (nextHost) this.session.update((cur) => (cur ? { ...cur, host_id: nextHost } : cur));
        }
        void this.persistEncryptedSnapshot();
        return;
      }

      case 'start_game': {
        const s = this.session();
        if (!s || pkt.senderUid !== s.host_id) return;
        const d = pkt.data as { startAt: number; endAt: number; hunters: string[]; event: GameEvent } | null;
        if (!d || !Array.isArray(d.hunters)) return;

        this.offset = pkt.ts - Date.now();
        await this.applyStartGame(d.startAt, d.endAt, d.hunters, d.event);
        return;
      }

      case 'role_keys': {
        const s = this.session();
        if (!s) return;
        const d = pkt.data as { tickets?: EncryptedRoleTicket[] } | null;
        if (!d || !Array.isArray(d.tickets)) return;
        const myTicket = d.tickets.find((t) => t.targetUid === this.uid);
        if (!myTicket) return;
        const senderPlayer = this.players()[pkt.senderUid];
        if (!senderPlayer?.ecdh_key) return;
        // Validation d'intégrité de rôle : un chasseur ne peut distribuer que la clé chasseur, un chassé que la clé chassé
        if (myTicket.role === 'hunter' && senderPlayer.role !== 'hunter' && pkt.senderUid !== s.host_id) return;
        if (myTicket.role === 'hunted' && senderPlayer.role !== 'hunted' && pkt.senderUid !== s.host_id) return;
        const secret = await this.crypto.unwrapSecretFromPeer(senderPlayer.ecdh_key, myTicket.iv, myTicket.ct);
        if (secret) {
          const scope = myTicket.role === 'hunter' ? 'h' : 'a';
          await this.crypto.installDynamicRoleKey(scope, secret);
        }
        return;
      }

      case 'caught': {
        const s = this.session();
        if (!s || s.status !== 'playing') return;
        const d = pkt.data as {
          victimId: string;
          hunterId: string;
          caughtAt: number;
          receiptSig?: string;
          event: GameEvent;
        } | null;
        if (!d || !d.victimId || !d.hunterId) return;

        // Validation d'intégrité et preuve cryptographique de capture [CRIT-03]
        const hunterPlayer = this.players()[d.hunterId];
        const isVictimSelf = pkt.senderUid === d.victimId;
        const isHunterSender = pkt.senderUid === d.hunterId && (hunterPlayer?.role === 'hunter' || d.hunterId === s.host_id);

        if (!isVictimSelf && !isHunterSender) return;

        // Si le paquet est émis par le chasseur, il doit impérativement fournir le reçu signé par sa clé ECDSA P-256
        if (isHunterSender) {
          if (!d.receiptSig || !hunterPlayer?.pub_key) return;
          const receiptPayload = `CATCH_RECEIPT::${code}::${d.victimId}::${d.hunterId}::${d.caughtAt}`;
          const validSig = await this.crypto.verifySignature(hunterPlayer.pub_key, receiptPayload, d.receiptSig);
          if (!validSig) return; // Rejet : tentative d'élimination arbitraire sans signature de reçu
        }

        this.applyPlayerCaught(d.victimId, d.hunterId, d.caughtAt, d.event);
        if (this.isHost()) {
          void this.dispatchRoleKeyToPlayer(d.victimId);
        }
        if (this.isHuntedLeader()) {
          void this.rotateAllyKeyOnCapture(d.victimId);
        }
        return;
      }

      case 'out_of_zone': {
        const s = this.session();
        if (!s || s.status !== 'playing') return;
        const d = pkt.data as { victimId: string; caughtAt: number; event: GameEvent } | null;
        if (!d || pkt.senderUid !== d.victimId) return;
        this.applyPlayerCaught(d.victimId, 'ZONE', d.caughtAt, d.event);
        if (this.isHost()) {
          void this.dispatchRoleKeyToPlayer(d.victimId);
        }
        if (this.isHuntedLeader()) {
          void this.rotateAllyKeyOnCapture(d.victimId);
        }
        return;
      }

      case 'end_game': {
        const s = this.session();
        if (!s || s.status !== 'playing') return;
        const d = pkt.data as { endedAt: number; winner: 'hunted' | 'hunters' } | null;
        if (!d) return;
        const isFromHost = pkt.senderUid === s.host_id;
        const timeUp = s.end_at != null && this.now() >= s.end_at - 10000;
        const allCaught = this.alive().length === 0;
        if (!isFromHost && !timeUp && !allCaught) return;
        this.applyEndGame(d.endedAt, d.winner);
        return;
      }

      case 'reset_game': {
        const s = this.session();
        if (!s || pkt.senderUid !== s.host_id) return;
        this.applyResetGame();
        return;
      }

      case 'hunter_pos': {
        if (pkt.scope !== 'h' || !knownPlayer || knownPlayer.role !== 'hunter') return;
        const d = pkt.data as { lat?: number; lng?: number; t?: number; off?: boolean } | null;
        if (d?.off) {
          this.players.update((m) =>
            m[pkt.senderUid] ? { ...m, [pkt.senderUid]: { ...m[pkt.senderUid], pos: null } } : m,
          );
          return;
        }
        if (!d || !isValidLatLng(d.lat, d.lng)) return;
        const pos: Pos = { lat: sanitizeCoord(d.lat!), lng: sanitizeCoord(d.lng!), t: pkt.ts };
        if (!this.validatePeerVelocity(pkt.senderUid, pos)) return;
        this.players.update((m) =>
          m[pkt.senderUid] ? { ...m, [pkt.senderUid]: { ...m[pkt.senderUid], pos, seen: pkt.ts } } : m,
        );
        return;
      }

      case 'circle': {
        if (pkt.scope !== 's' || !knownPlayer || knownPlayer.role !== 'hunted') return;
        const d = pkt.data as { circle?: Circle | null } | null;
        if (!d || d.circle === null) {
          this.players.update((m) =>
            m[pkt.senderUid] ? { ...m, [pkt.senderUid]: { ...m[pkt.senderUid], circle: null } } : m,
          );
          return;
        }
        const c = d.circle;
        if (!c || !isValidLatLng(c.lat, c.lng) || !isValidRadius(c.r)) return;
        if (c.r < 10 || c.r > 10000) return;

        const validCircle: Circle = {
          lat: sanitizeCoord(c.lat),
          lng: sanitizeCoord(c.lng),
          r: Math.round(c.r),
          t: typeof c.t === 'number' && Number.isFinite(c.t) ? c.t : pkt.ts,
          allyShare: !!c.allyShare,
        };

        const zone = this.session()?.settings.zone;
        if (zone && distance(validCircle, zone) > zone.r * 1.5) return;

        const now = this.serverNow();
        const prevCircle = this.peerLastCircle.get(pkt.senderUid) ?? knownPlayer.circle;
        if (prevCircle) {
          const isRadiusStepChange = prevCircle.r !== validCircle.r;
          const refreshSec = this.session()?.settings.circleRefreshSec ?? 60;
          const isExpiredStep = (now - prevCircle.t) >= (refreshSec * 1000 * 0.9);
          // Le contrôle physique de vitesse n'est appliqué qu'au sein d'une même étape stable sans rétrécissement [MAJ-04]
          if (!isRadiusStepChange && !isExpiredStep) {
            const dtSec = Math.max(0.5, (now - prevCircle.t) / 1000);
            const distCenter = distance(prevCircle, validCircle);
            const speed = distCenter / dtSec;
            if (distCenter > 50 && speed > 20) {
              return; // Rejet : tentative de téléportation de cercle impossible
            }
          }
        }
        this.peerLastCircle.set(pkt.senderUid, { ...validCircle, t: now });

        this.players.update((m) =>
          m[pkt.senderUid]
            ? { ...m, [pkt.senderUid]: { ...m[pkt.senderUid], circle: validCircle, seen: pkt.ts } }
            : m,
        );
        return;
      }

      case 'ally_pos': {
        if (pkt.scope !== 'a' || this.me()?.role !== 'hunted' || !knownPlayer || knownPlayer.role !== 'hunted') return;
        const d = pkt.data as { lat?: number; lng?: number; t?: number; off?: boolean } | null;
        if (!d || d.off || !isValidLatLng(d.lat, d.lng)) {
          this.allyExactPos.update((m) => {
            const { [pkt.senderUid]: _r, ...rest } = m;
            return rest;
          });
          return;
        }
        const pos: Pos = { lat: sanitizeCoord(d.lat!), lng: sanitizeCoord(d.lng!), t: pkt.ts };
        if (!this.validatePeerVelocity(pkt.senderUid, pos)) return;
        this.allyExactPos.update((m) => ({
          ...m,
          [pkt.senderUid]: pos,
        }));
        return;
      }

      case 'catch_probe': {
        const s = this.session();
        if (!s || s.status !== 'playing' || this.me()?.role !== 'hunter') return;
        const d = pkt.data as { targetHunter?: string; iv?: string; ct?: string } | null;
        if (!d || d.targetHunter !== this.uid || !d.iv || !d.ct) return;

        const now = this.serverNow();

        // Protection anti-DDoS CPU sur le déballage ECDH (max 5 sondes par 10s par joueur)
        const probeStat = this.hunterProbeCounts.get(pkt.senderUid) ?? { count: 0, windowStart: now };
        if (now - probeStat.windowStart > 10000) {
          probeStat.count = 0;
          probeStat.windowStart = now;
        }
        probeStat.count++;
        this.hunterProbeCounts.set(pkt.senderUid, probeStat);
        if (probeStat.count > 5) return;

        const sender = this.players()[pkt.senderUid];
        if (!sender?.ecdh_key) return;

        try {
          const raw = await this.crypto.unwrapSecretFromPeer(sender.ecdh_key, d.iv, d.ct);
          if (!raw) return;
          const probe = JSON.parse(raw) as { pin?: string; victimId?: string; ts?: number; lat?: number; lng?: number; acc?: number };
          if (probe.pin === this.myCatchCode() && probe.victimId === pkt.senderUid) {
            // Génération d'un reçu cryptographique de capture signé par la clé privée ECDSA P-256 du chasseur [CRIT-03]
            const receiptPayload = `CATCH_RECEIPT::${code}::${probe.victimId}::${this.uid}::${now}`;
            const receiptSig = await this.crypto.signPayload(receiptPayload);

            const ev: GameEvent = {
              id: now + Math.floor(secureRandomUnit() * 1000),
              session_code: code,
              type: 'caught',
              t: now,
              data: {
                victim: probe.victimId,
                victimName: sender.name,
                hunter: this.uid,
                hunterName: this.me()!.name,
              },
            };
            this.applyPlayerCaught(probe.victimId, this.uid, now, ev);
            await this.sendP2p('s', 'caught', {
              victimId: probe.victimId,
              hunterId: this.uid,
              caughtAt: now,
              receiptSig,
              event: ev,
            });
            if (this.isHost()) {
              void this.dispatchRoleKeyToPlayer(probe.victimId);
            }
          }
        } catch { /* ignore */ }
        return;
      }

      case 'track_summary': {
        if (!knownPlayer) return;
        const d = pkt.data as {
          playerId?: string;
          playerName?: string;
          distanceMeters?: number;
          survivedMs?: number;
          capturesCount?: number;
        } | null;
        if (!d?.playerId) return;
        const syntheticId = -Math.abs(this.hashString(d.playerId));
        const ev: GameEvent = {
          id: syntheticId,
          session_code: code,
          type: 'track_summary',
          t: pkt.ts,
          data: {
            playerId: d.playerId,
            playerName: sanitizeName(d.playerName ?? knownPlayer.name),
            distanceMeters: typeof d.distanceMeters === 'number' ? Math.max(0, Math.round(d.distanceMeters)) : 0,
            survivedMs: typeof d.survivedMs === 'number' ? Math.max(0, Math.round(d.survivedMs)) : 0,
            capturesCount: typeof d.capturesCount === 'number' ? Math.max(0, Math.round(d.capturesCount)) : 0,
          },
        };
        this.events.update((list) => {
          const filtered = list.filter((x) => !(x.type === 'track_summary' && x.data.playerId === d.playerId));
          return [...filtered, ev];
        });
        return;
      }

      case 'track': {
        if (!knownPlayer) return;
        const d = pkt.data as { playerName?: string; points?: Pos[] } | null;
        if (!d || !Array.isArray(d.points) || d.points.length === 0 || d.points.length > 5000) return;
        const validPoints: Pos[] = [];
        for (const pt of d.points) {
          if (pt && isValidLatLng(pt.lat, pt.lng) && typeof pt.t === 'number' && Number.isFinite(pt.t)) {
            validPoints.push({
              lat: Number(pt.lat.toFixed(5)),
              lng: Number(pt.lng.toFixed(5)),
              t: pt.t,
              role: pt.role === 'hunter' ? 'hunter' : 'hunted',
            });
          }
        }
        if (!validPoints.length) return;
        this.recordTrackEvent(pkt.senderUid, sanitizeName(d.playerName ?? knownPlayer.name), validPoints, pkt.ts);
        return;
      }
    }
  }

  private respondRealtimeState() {
    const s = this.session();
    const m = this.me();
    if (!s || !m) return;
    if (s.status === 'playing') {
      const pos = this.myPos();
      if (m.role === 'hunter' && pos) {
        void this.sendP2p('h', 'hunter_pos', {
          lat: sanitizeCoord(pos.lat),
          lng: sanitizeCoord(pos.lng),
          t: this.serverNow(),
        });
      } else if (m.role === 'hunted' && this.lastCircle) {
        void this.sendP2p('s', 'circle', { circle: this.lastCircle });
        if (this.allyShareMode() === 'exact' && pos) {
          void this.sendP2p('a', 'ally_pos', {
            lat: sanitizeCoord(pos.lat),
            lng: sanitizeCoord(pos.lng),
            t: this.serverNow(),
          });
        }
      }
    } else if (s.status === 'ended' && this.myTrack.length > 0) {
      void this.sendP2p('s', 'track', {
        playerName: m.name,
        points: this.myTrack,
      });
    }
  }

  private recordTrackEvent(playerId: string, playerName: string, points: Pos[], t: number) {
    const code = this.code();
    if (!code) return;
    const syntheticId = -Math.abs(this.hashString(playerId));
    const ev: GameEvent = {
      id: syntheticId,
      session_code: code,
      type: 'track',
      t,
      data: { playerId, playerName, points },
    };
    this.events.update((list) => {
      const filtered = list.filter((x) => !(x.type === 'track' && x.data.playerId === playerId));
      return [...filtered, ev];
    });
  }

  private hashString(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h | 1;
  }

  private notifyIfNewEvent(e: GameEvent) {
    if (this.events().some((x) => x.id === e.id)) return;
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

  /** Change en direct le mode de partage de localisation avec les autres chassés ('off' | 'relative' | 'exact'). */
  setAllyShareMode(mode: AllyShareMode) {
    const prev = this.allyShareMode();
    if (prev === mode) return;
    this.allyShareMode.set(mode);
    if (prev === 'exact' && mode !== 'exact') {
      void this.sendP2p('a', 'ally_pos', { off: true });
    }
    const pos = this.myPos();
    if (pos && this.me()?.role === 'hunted') {
      this.maybeUpdateCircle(pos, true);
      if (mode === 'exact') {
        this.lastAllyBroadcast = 0;
        this.broadcastExactToAllies(pos);
      }
    }
  }

  private broadcastExactToAllies(pos: MyPos) {
    if (this.allyShareMode() !== 'exact' || this.me()?.role !== 'hunted' || !this.mesh) return;
    const t = this.serverNow();
    if (t - this.lastAllyBroadcast < 3000) return;
    this.lastAllyBroadcast = t;
    void this.sendP2p('a', 'ally_pos', {
      lat: sanitizeCoord(pos.lat),
      lng: sanitizeCoord(pos.lng),
      t,
    });
  }

  // =================================================================
  // Actions de session 100 % P2P (Zéro Base de Données)
  // =================================================================
  async createSession(name: string, settings: Settings): Promise<string> {
    const cleanName = sanitizeName(name);
    this.clearLocalTracks();
    const code = randomCode();
    const sessionKey = this.crypto.generateSecureToken(16); // 128 bits d'entropie cryptographique
    try { sessionStorage.setItem(`tm_sk_${code}`, sessionKey); } catch { /* ignore */ }
    this.sessionKey.set(sessionKey);
    this.crypto.setSessionSecret(sessionKey);
    const identity = await this.crypto.getDeviceIdentity();
    const now = Date.now();
    await this.refreshMyCatchCode(code, 0);

    const newSession: Session = {
      code,
      host_id: this.uid,
      status: 'lobby',
      settings: this.sanitizeSettings(settings),
      start_at: null,
      end_at: null,
      winner: null,
      ended_at: null,
    };

    const hostPlayer: Player = {
      session_code: code,
      id: this.uid,
      name: cleanName,
      role: 'hunted',
      initial_role: null,
      catch_code: '****',
      catch_commitment: '',
      pub_key: identity.publicKeySpkiB64,
      ecdh_key: identity.ecdhPublicKeySpkiB64,
      joined_at: now,
      caught_by: null,
      caught_at: null,
      circle: null,
      pos: null,
      seen: now,
    };

    this.code.set(code);
    this.session.set(newSession);
    this.players.set({ [this.uid]: hostPlayer });
    this.events.set([]);
    this.loaded.set(true);
    await this.persistEncryptedSnapshot();
    this.open(code);
    return code;
  }

  async join(code: string, name: string): Promise<void> {
    const cleanCode = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cleanName = sanitizeName(name);
    if (cleanCode.length !== 6) throw new Error('Le code fait 6 caractères.');

    // Si on est déjà connecté à cette session sur cet appareil
    if (this.session()?.code === cleanCode && this.players()[this.uid]) {
      await this.renamePlayer(this.uid, cleanName);
      return;
    }

    const restored = await this.restoreEncryptedSnapshot(cleanCode);
    if (restored && this.players()[this.uid]) {
      this.open(cleanCode);
      await this.renamePlayer(this.uid, cleanName);
      return;
    }

    this.open(cleanCode);
    const identity = await this.crypto.getDeviceIdentity();
    await this.refreshMyCatchCode(cleanCode, 0);

    return new Promise<void>((resolve, reject) => {
      this.joinResolvers.push({ resolve, reject });
      let powNonce: string | null = null;
      void this.crypto.solveProofOfWork(cleanCode, this.uid).then((p) => (powNonce = p));

      const retryInterval = setInterval(() => {
        if (this.session()?.code === cleanCode && this.players()[this.uid]) {
          clearInterval(retryInterval);
          return;
        }
        void this.sendP2p('s', 'join_req', {
          name: cleanName,
          pubKey: identity.publicKeySpkiB64,
          ecdhKey: identity.ecdhPublicKeySpkiB64,
          powNonce: powNonce ?? undefined,
        });
      }, 1200);

      setTimeout(() => {
        clearInterval(retryInterval);
        const idx = this.joinResolvers.findIndex((r) => r.resolve === resolve);
        if (idx !== -1) {
          this.joinResolvers.splice(idx, 1);
          this.close();
          reject(new Error("Session introuvable : vérifie le code et que l'hôte a bien l'appli ouverte au premier plan."));
        }
      }, JOIN_TIMEOUT_MS);
    });
  }

  async leave() {
    const code = this.code();
    if (code && this.mesh) {
      await this.sendP2p('s', 'player_kick', {
        targetId: this.uid,
        voluntaryLeave: true,
      });
      await this.sendP2p('s', 'bye', { id: this.uid });
      this.removeEncryptedSnapshot(code);
    }
    this.clearLocalTracks();
    this.close();
    try { localStorage.removeItem('tm_code'); } catch { /* ignore */ }
  }

  private clearLocalTracks() {
    this.myTrack = [];
    this.lastCircle = null;
    this.allyExactPos.set({});
    this.lastValidGps = null;
    this.peerLastPos.clear();
    this.peerLastCircle.clear();
    this.purgeLegacyStorage();
    try {
      for (const k of Object.keys(sessionStorage)) {
        if (k.startsWith('tm_e2ee_') || k.startsWith('tm_snap_') || k.startsWith('tm_track_')) {
          sessionStorage.removeItem(k);
        }
      }
    } catch { /* ignore */ }
  }

  async toggleRole(p: Player) {
    if (!this.isHost()) return;
    const role: Role = p.role === 'hunter' ? 'hunted' : 'hunter';
    this.players.update((m) => (m[p.id] ? { ...m, [p.id]: { ...m[p.id], role } } : m));
    await this.sendP2p('s', 'player_patch', { targetId: p.id, patch: { role } });
    await this.persistEncryptedSnapshot();
  }

  private sanitizeSettings(raw: Settings): Settings {
    const total = Math.min(720, Math.max(1, Math.round(Number(raw.total) || 60)));
    const headStart = Math.min(60, Math.max(0, Math.round(Number(raw.headStart) || 0)));
    const radiusStart = Math.min(100_000, Math.max(10, Math.round(Number(raw.radiusStart) || 500)));
    const radiusEnd = Math.min(50_000, Math.max(5, Math.round(Number(raw.radiusEnd) || 50)));
    const shrinkEvery = Math.min(60, Math.max(1, Math.round(Number(raw.shrinkEvery) || 10)));
    const hunters = Math.min(50, Math.max(1, Math.round(Number(raw.hunters) || 1)));
    const roleMode = raw.roleMode === 'manual' ? 'manual' : 'random';
    const outGraceSec = Math.min(600, Math.max(5, Math.round(Number(raw.outGraceSec) || 30)));
    const circleRefreshSec = raw.circleRefreshSec ? Math.min(300, Math.max(5, Math.round(Number(raw.circleRefreshSec)))) : null;
    let zone = null;
    if (raw.zone && isValidLatLng(raw.zone.lat, raw.zone.lng) && isValidRadius(raw.zone.r)) {
      zone = {
        lat: sanitizeCoord(raw.zone.lat),
        lng: sanitizeCoord(raw.zone.lng),
        r: Math.round(raw.zone.r),
      };
    }
    return {
      total,
      headStart,
      radiusStart,
      radiusEnd,
      shrinkEvery,
      hunters,
      roleMode,
      outGraceSec,
      circleRefreshSec,
      zone,
    };
  }

  async updateSettings(settings: Settings) {
    if (!this.isHost()) return;
    const cleanSettings = this.sanitizeSettings(settings);
    this.session.update((s) => (s ? { ...s, settings: { ...cleanSettings } } : s));
    await this.sendP2p('s', 'session_patch', { settings: { ...cleanSettings } });
    await this.broadcastFullStateSync();
    await this.persistEncryptedSnapshot();
  }

  async renamePlayer(playerId: string, newName: string) {
    const code = this.code();
    const name = sanitizeName(newName);
    if (!code || !name) throw new Error('Le pseudo ne peut pas être vide.');
    if (playerId !== this.uid && !this.isHost()) return;

    this.players.update((m) => (m[playerId] ? { ...m, [playerId]: { ...m[playerId], name } } : m));
    if (playerId === this.uid) {
      try { localStorage.setItem('tm_name', name); } catch { /* ignore */ }
    }
    await this.sendP2p('s', 'player_patch', { targetId: playerId, patch: { name } });
    await this.persistEncryptedSnapshot();
  }

  async kickPlayer(playerId: string) {
    if (!this.isHost() || playerId === this.uid) return;
    this.players.update((m) => {
      const { [playerId]: _r, ...rest } = m;
      return rest;
    });
    this.peerLastSeen.delete(playerId);
    this.mesh?.removePeer(playerId);
    this.updateOnlineSet();
    await this.sendP2p('s', 'player_kick', {
      targetId: playerId,
      reason: "Tu as été exclu de la session par l'hôte.",
    });
    await this.persistEncryptedSnapshot();
  }

  async start() {
    const s = this.session();
    if (!s || !this.isHost()) return;
    const ids = this.sortedPlayers().map((p) => p.id);
    let hunters: string[];
    if (s.settings.roleMode === 'random') {
      const shuffled = secureShuffle(ids);
      hunters = shuffled.slice(0, Math.min(Math.max(1, s.settings.hunters), ids.length - 1));
    } else {
      hunters = this.sortedPlayers().filter((p) => p.role === 'hunter').map((p) => p.id);
      if (!hunters.length) throw new Error('Choisis au moins un chasseur.');
      if (hunters.length === ids.length) throw new Error('Il faut au moins un chassé.');
    }

    const startAt = this.serverNow();
    const endAt = startAt + s.settings.total * 60000;
    const startEvent: GameEvent = {
      id: startAt,
      session_code: s.code,
      type: 'start',
      t: startAt,
      data: {},
    };

    // Isolation Zero-Knowledge stricte : l'Hôte NE GÉNÈRE QUE la clé de son PROPRE rôle !
    const hostRole: Role = hunters.includes(this.uid) ? 'hunter' : 'hunted';
    const tickets: EncryptedRoleTicket[] = [];

    if (hostRole === 'hunter') {
      const hunterSecret = this.crypto.generateSecureToken(32);
      this.currentHunterSecret = hunterSecret;
      this.currentAllySecret = null; // Zero-Knowledge : l'hôte chasseur ignore totalement allySecret
      await this.crypto.installDynamicRoleKey('h', hunterSecret);
      for (const p of this.sortedPlayers()) {
        if (p.id === this.uid || !p.ecdh_key || !hunters.includes(p.id)) continue;
        try {
          const wrap = await this.crypto.wrapSecretForPeer(p.ecdh_key, hunterSecret);
          tickets.push({ targetUid: p.id, role: 'hunter', iv: wrap.iv, ct: wrap.ct });
        } catch { /* ignore */ }
      }
    } else {
      const allySecret = this.crypto.generateSecureToken(32);
      this.currentAllySecret = allySecret;
      this.currentHunterSecret = null; // Zero-Knowledge : l'hôte chassé ignore totalement hunterSecret
      await this.crypto.installDynamicRoleKey('a', allySecret);
      for (const p of this.sortedPlayers()) {
        if (p.id === this.uid || !p.ecdh_key || hunters.includes(p.id)) continue;
        try {
          const wrap = await this.crypto.wrapSecretForPeer(p.ecdh_key, allySecret);
          tickets.push({ targetUid: p.id, role: 'hunted', iv: wrap.iv, ct: wrap.ct });
        } catch { /* ignore */ }
      }
    }

    await this.applyStartGame(startAt, endAt, hunters, startEvent);
    await this.sendP2p('s', 'start_game', { startAt, endAt, hunters, event: startEvent });
    if (tickets.length > 0) {
      await this.sendP2p('s', 'role_keys', { tickets });
    }
    await this.broadcastFullStateSync();
  }

  private async generateAndDistributeHunterSecret(hunters: string[]) {
    const hunterSecret = this.crypto.generateSecureToken(32);
    this.currentHunterSecret = hunterSecret;
    await this.crypto.installDynamicRoleKey('h', hunterSecret);
    const tickets: EncryptedRoleTicket[] = [];
    for (const p of this.sortedPlayers()) {
      if (p.id === this.uid || !p.ecdh_key || !hunters.includes(p.id)) continue;
      try {
        const wrap = await this.crypto.wrapSecretForPeer(p.ecdh_key, hunterSecret);
        tickets.push({ targetUid: p.id, role: 'hunter', iv: wrap.iv, ct: wrap.ct });
      } catch { /* ignore */ }
    }
    if (tickets.length > 0) {
      await this.sendP2p('s', 'role_keys', { tickets });
    }
  }

  private async generateAndDistributeAllySecret(hunters: string[]) {
    const allySecret = this.crypto.generateSecureToken(32);
    this.currentAllySecret = allySecret;
    await this.crypto.installDynamicRoleKey('a', allySecret);
    const tickets: EncryptedRoleTicket[] = [];
    for (const p of this.sortedPlayers()) {
      if (p.id === this.uid || !p.ecdh_key || hunters.includes(p.id)) continue;
      try {
        const wrap = await this.crypto.wrapSecretForPeer(p.ecdh_key, allySecret);
        tickets.push({ targetUid: p.id, role: 'hunted', iv: wrap.iv, ct: wrap.ct });
      } catch { /* ignore */ }
    }
    if (tickets.length > 0) {
      await this.sendP2p('s', 'role_keys', { tickets });
    }
  }

  private async dispatchRoleKeyToPlayer(targetUid: string) {
    const targetPlayer = this.players()[targetUid];
    if (!targetPlayer || !targetPlayer.ecdh_key) return;
    const targetRole = targetPlayer.role;

    // Zero-Knowledge : seul le leader de CE rôle transmet le secret à son pair
    if (targetRole === 'hunter' && this.currentHunterSecret && (this.isHost() || this.isHunterLeader())) {
      try {
        const wrap = await this.crypto.wrapSecretForPeer(targetPlayer.ecdh_key, this.currentHunterSecret);
        await this.sendP2p('s', 'role_keys', {
          tickets: [{ targetUid, role: 'hunter', iv: wrap.iv, ct: wrap.ct }],
        });
      } catch { /* ignore */ }
    } else if (targetRole === 'hunted' && this.currentAllySecret && this.isHuntedLeader()) {
      try {
        const wrap = await this.crypto.wrapSecretForPeer(targetPlayer.ecdh_key, this.currentAllySecret);
        await this.sendP2p('s', 'role_keys', {
          tickets: [{ targetUid, role: 'hunted', iv: wrap.iv, ct: wrap.ct }],
        });
      } catch { /* ignore */ }
    }
  }

  private async dispatchSessionSecretToPeer(targetUid: string, peerEcdhKey: string) {
    const k = this.sessionKey();
    const code = this.code();
    if (!k || !code) return;
    try {
      const wrap = await this.crypto.wrapSecretForPeer(peerEcdhKey, k);
      const manualRendezvousTopic = await this.crypto.getRendezvousTopic(code, null);
      const qrRendezvousTopic = await this.crypto.getRendezvousTopic(code, k);
      // Envoie sur le canal courant
      await this.sendP2p('s', 'session_secret', {
        targetUid,
        iv: wrap.iv,
        ct: wrap.ct,
      });
      // Et envoie également sur les topics de rendez-vous pour les pairs en attente de synchronisation [MAJ-02]
      const env = await this.crypto.encryptPacket(code, this.secret, 's', 'session_secret', this.uid, this.serverNow(), {
        targetUid,
        iv: wrap.iv,
        ct: wrap.ct,
      });
      this.mesh?.broadcast(env, manualRendezvousTopic);
      this.mesh?.broadcast(env, qrRendezvousTopic);
    } catch { /* ignore */ }
  }

  private async applyStartGame(startAt: number, endAt: number, hunters: string[], startEvent: GameEvent) {
    const code = this.code();
    if (!code) return;
    this.failedCatchAttempts = 0;
    this.catchLockedUntil = 0;

    await this.refreshMyCatchCode(code, startAt);

    this.players.update((map) => {
      const next: Record<string, Player> = {};
      for (const [id, pl] of Object.entries(map)) {
        const r: Role = hunters.includes(id) ? 'hunter' : 'hunted';
        next[id] = {
          ...pl,
          role: r,
          initial_role: r,
          catch_code: '****',
          caught_by: null,
          caught_at: null,
          circle: null,
          pos: null,
          seen: startAt,
        };
      }
      return next;
    });

    this.events.set([startEvent]);
    this.session.update((cur) =>
      cur
        ? { ...cur, status: 'playing', start_at: startAt, end_at: endAt, winner: null, ended_at: null }
        : cur,
    );
    vibrate(300);
    await this.persistEncryptedSnapshot();

    // Rôle Leader décentralisé :
    const s = this.session();
    if (s && !this.isHost()) {
      const isHostHunter = hunters.includes(s.host_id);
      if (isHostHunter) {
        // L'hôte est chasseur -> Le premier chassé génère et distribue allySecret de façon autonome
        const livingHunted = this.sortedPlayers().filter((p) => !hunters.includes(p.id));
        if (livingHunted[0]?.id === this.uid) {
          void this.generateAndDistributeAllySecret(hunters);
        }
      } else {
        // L'hôte est chassé -> Le premier chasseur génère et distribue hunterSecret de façon autonome
        const livingHunters = this.sortedPlayers().filter((p) => hunters.includes(p.id));
        if (livingHunters[0]?.id === this.uid) {
          void this.generateAndDistributeHunterSecret(hunters);
        }
      }
    }
  }

  async declareCaught(catchCode: string) {
    const s = this.session();
    const me = this.me();
    const code = this.code();
    if (!s || !me || !code || s.status !== 'playing') throw new Error("La partie n'est pas en cours.");
    if (me.role !== 'hunted') throw new Error("Tu n'es pas chassé.");

    const now = this.serverNow();
    if (this.catchLockedUntil > now) {
      const waitSec = Math.ceil((this.catchLockedUntil - now) / 1000);
      throw new Error(`Trop de tentatives erronées — patiente ${waitSec} s.`);
    }

    const cleanCatchCode = catchCode.replace(/\D/g, '').slice(0, 4);
    if (cleanCatchCode.length !== 4) throw new Error('Le code fait 4 chiffres.');

    const hunters = this.sortedPlayers().filter((p) => p.role === 'hunter' && p.id !== this.uid && p.ecdh_key);
    if (!hunters.length) throw new Error('Aucun chasseur en ligne avec accord de clés.');

    // Émet une sonde de capture chiffrée en accord de clés ECDH direct vers les chasseurs
    const myPos = this.myPos();
    for (const h of hunters) {
      try {
        const wrap = await this.crypto.wrapSecretForPeer(
          h.ecdh_key!,
          JSON.stringify({
            pin: cleanCatchCode,
            victimId: this.uid,
            ts: now,
            lat: myPos ? sanitizeCoord(myPos.lat) : null,
            lng: myPos ? sanitizeCoord(myPos.lng) : null,
            acc: myPos ? myPos.acc : null,
          }),
        );
        void this.sendP2p('s', 'catch_probe', { targetHunter: h.id, iv: wrap.iv, ct: wrap.ct });
      } catch { /* ignore */ }
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingCatchResolver?.resolve === resolve) {
          this.pendingCatchResolver = null;
          this.failedCatchAttempts++;
          if (this.failedCatchAttempts >= 5) {
            this.failedCatchAttempts = 0;
            this.catchLockedUntil = this.serverNow() + 60_000;
            reject(new Error('5 codes erronés : verrouillage de sécurité pendant 60 secondes.'));
            return;
          }
          reject(new Error('Code chasseur invalide ou non reconnu.'));
        }
      }, 4500);

      this.pendingCatchResolver = {
        resolve: () => {
          clearTimeout(timer);
          this.failedCatchAttempts = 0;
          this.catchLockedUntil = 0;
          this.pendingCatchResolver = null;
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          this.pendingCatchResolver = null;
          reject(err);
        },
      };
    });
  }

  private async rotateAllyKeyOnCapture(capturedUid: string) {
    if (!this.isHuntedLeader()) return;
    const newAllySecret = this.crypto.generateSecureToken(32);
    this.currentAllySecret = newAllySecret;

    if (this.me()?.role === 'hunted' && this.uid !== capturedUid) {
      await this.crypto.installDynamicRoleKey('a', newAllySecret);
    }

    const survivingHunted = this.sortedPlayers().filter(
      (p) => p.role === 'hunted' && p.id !== capturedUid && p.id !== this.uid && p.ecdh_key
    );

    const tickets: EncryptedRoleTicket[] = [];
    for (const p of survivingHunted) {
      try {
        const wrap = await this.crypto.wrapSecretForPeer(p.ecdh_key!, newAllySecret);
        tickets.push({ targetUid: p.id, role: 'hunted', iv: wrap.iv, ct: wrap.ct });
      } catch { /* ignore */ }
    }

    if (tickets.length > 0) {
      await this.sendP2p('s', 'role_keys', { tickets });
    }
  }

  private applyPlayerCaught(victimId: string, hunterIdOrZone: string, caughtAt: number, ev: GameEvent) {
    if (victimId === this.uid) {
      // Révocation immédiate et purge de la clé secrète des chassés de la RAM (Forward Secrecy)
      this.crypto.revokeDynamicRoleKey('a');
      this.allyExactPos.set({});
      if (this.pendingCatchResolver) {
        this.pendingCatchResolver.resolve();
        this.pendingCatchResolver = null;
      }
    }

    this.players.update((m) =>
      m[victimId]
        ? {
            ...m,
            [victimId]: {
              ...m[victimId],
              role: 'hunter',
              caught_by: hunterIdOrZone,
              caught_at: caughtAt,
              circle: null,
            },
          }
        : m,
    );
    this.allyExactPos.update((m) => {
      const { [victimId]: _r, ...rest } = m;
      return rest;
    });
    this.notifyIfNewEvent(ev);
    if (!this.events().some((x) => x.id === ev.id)) {
      this.events.update((l) => [...l, ev]);
    }
    void this.persistEncryptedSnapshot();
  }

  private clearMyCircleState() {
    this.lastCircle = null;
    this.players.update((m) => (m[this.uid] ? { ...m, [this.uid]: { ...m[this.uid], circle: null } } : m));
    void this.sendP2p('s', 'circle', { circle: null });
  }

  async replay() {
    if (!this.isHost()) return;
    this.applyResetGame();
    await this.sendP2p('s', 'reset_game', { at: this.serverNow() });
    await this.broadcastFullStateSync();
  }

  private applyResetGame() {
    const s = this.session();
    if (!s) return;
    const manual = s.settings.roleMode === 'manual';
    this.clearLocalTracks();
    this.players.update((map) => {
      const next: Record<string, Player> = {};
      for (const [id, pl] of Object.entries(map)) {
        next[id] = {
          ...pl,
          role: manual ? (pl.initial_role ?? 'hunted') : 'hunted',
          caught_by: null,
          caught_at: null,
          circle: null,
          pos: null,
          seen: null,
        };
      }
      return next;
    });
    this.events.set([]);
    this.session.update((cur) =>
      cur ? { ...cur, status: 'lobby', start_at: null, end_at: null, winner: null, ended_at: null } : cur,
    );
    void this.persistEncryptedSnapshot();
  }

  // =================================================================
  // Boucle de jeu, Présence P2P, Zone autorisée & Trajectoire E2EE
  // =================================================================
  private tick() {
    const s = this.session();
    if (!s || !this.code()) return;

    const nowMs = Date.now();
    if (nowMs - this.lastHeartbeatAt > 3500) {
      this.lastHeartbeatAt = nowMs;
      this.updateOnlineSet();
      void this.sendHeartbeat();
    }

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
    let since = this.outOfZoneSince();
    if (since == null) {
      since = this.now();
      this.outOfZoneSince.set(since);
      vibrate([250, 100, 250]);
      this.toast.show(`⚠️ Hors zone ! Rentre vite (${s.settings.outGraceSec ?? 30} s)`);
    }
    const graceMs = (s.settings.outGraceSec ?? 30) * 1000;
    if (this.now() - since >= graceMs && !this.eliminatingZone) {
      void this.eliminateOutOfZone();
    }
  }

  private async eliminateOutOfZone() {
    const code = this.code();
    const m = this.me();
    if (!code || !m || m.role !== 'hunted') return;
    this.eliminatingZone = true;
    const t = this.serverNow();
    try {
      const ev: GameEvent = {
        id: t + Math.floor(secureRandomUnit() * 1000),
        session_code: code,
        type: 'out_of_zone',
        t,
        data: { victim: this.uid, victimName: m.name },
      };
      this.applyPlayerCaught(this.uid, 'ZONE', t, ev);
      this.outOfZoneSince.set(null);
      this.clearMyCircleState();
      await this.sendP2p('s', 'out_of_zone', {
        victimId: this.uid,
        caughtAt: t,
        event: ev,
      });
    } finally {
      this.eliminatingZone = false;
    }
  }

  private claimHostIfNeeded(s: Session) {
    if (Date.now() - this.openedAt < 45000) return; // Tolérance 45s stricte
    const online = this.online();
    if (!online.has(this.uid) || online.has(s.host_id)) return;
    const lastHostSeen = this.peerLastSeen.get(s.host_id) ?? 0;
    if (Date.now() - lastHostSeen < 45000) return;
    const eligible = this.sortedPlayers().filter((p) => online.has(p.id));
    if (eligible[0]?.id === this.uid) {
      this.session.update((cur) => (cur ? { ...cur, host_id: this.uid } : cur));
      void this.sendP2p('s', 'session_patch', { host_id: this.uid, claimHost: true });
      this.openedAt = Date.now();
    }
  }

  private checkEnd(s: Session) {
    if (this.ending || s.end_at == null) return;
    const timeUp = this.now() >= s.end_at;
    const allCaught = this.alive().length === 0;
    if (!timeUp && !allCaught) return;
    this.ending = true;
    const endedAt = this.serverNow();
    const winner: 'hunted' | 'hunters' = allCaught ? 'hunters' : 'hunted';
    this.applyEndGame(endedAt, winner);
    void this.sendP2p('s', 'end_game', { endedAt, winner });
    setTimeout(() => (this.ending = false), 3000);
  }

  private applyEndGame(endedAt: number, winner: 'hunted' | 'hunters') {
    this.session.update((cur) =>
      cur && cur.status === 'playing' ? { ...cur, status: 'ended', ended_at: endedAt, winner } : cur,
    );
    void this.flushMyTrack();
    void this.persistEncryptedSnapshot();
  }

  private startPlaying() {
    if (this.playing) return;
    this.playing = true;
    this.lastRadius = null;
    this.wasHead = null;
    this.lastPosWrite = 0;
    this.lastCircleBroadcast = 0;
    this.ending = false;
    this.eliminatingZone = false;
    this.outOfZoneSince.set(null);
    this.lastTrackSample = 0;
    this.trackFlushed = false;
    this.lastValidGps = null;
    this.requestWakeLock();
    try {
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    } catch { /* ignore */ }
    if (this.gpsRevoked()) {
      this.gpsError.set('Accès GPS retiré — réactive-le pour cette partie');
      return;
    }
    this.startGpsWatcher();
  }

  private startGpsWatcher() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    if (!('geolocation' in navigator)) {
      this.gpsError.set('GPS non disponible sur cet appareil');
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        if (!isValidLatLng(p.coords.latitude, p.coords.longitude)) return;
        const now = this.serverNow();
        const candidate: MyPos = {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          acc: Math.max(1, Math.round(p.coords.accuracy || 10)),
          t: now,
        };
        // Filtre anti-spoofing / téléportation GPS (> 45 m/s ≈ 162 km/h)
        if (this.lastValidGps) {
          const dtSec = Math.max(1, (now - this.lastValidGps.t) / 1000);
          const dist = distance(this.lastValidGps, candidate);
          if (dist > 150 && dist / dtSec > 45) {
            this.gpsError.set('Déplacement GPS anormal ignoré');
            return;
          }
        }
        this.lastValidGps = { lat: candidate.lat, lng: candidate.lng, t: now };
        this.gpsError.set(null);
        this.myPos.set(candidate);
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
    this.myPos.set(null);
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  /** Coupe immédiatement le GPS, efface la position en mémoire vive et bloque l'accès jusqu'à réactivation explicite. */
  async revokeGpsAccess() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.myPos.set(null);
    this.clearMyCircleState();
    void this.sendP2p('h', 'hunter_pos', { off: true });
    void this.sendP2p('a', 'ally_pos', { off: true });
    this.clearLocalTracks();
    this.gpsRevoked.set(true);
    try { localStorage.setItem('tm_gps_revoked', '1'); } catch { /* ignore */ }
    this.toast.show('🔒 Droits GPS retirés & position effacée');
  }

  /** Réactive l'accès GPS pour une nouvelle partie après un verrouillage de sécurité. */
  restoreGpsAccess() {
    this.gpsRevoked.set(false);
    try { localStorage.removeItem('tm_gps_revoked'); } catch { /* ignore */ }
    this.gpsError.set(null);
    if (this.playing) this.startGpsWatcher();
    this.toast.show('📍 Accès GPS réactivé pour cette partie');
  }

  private sampleMyTrack() {
    const pos = this.myPos(), m = this.me();
    if (!pos || !m || this.session()?.status !== 'playing') return;
    const t = this.serverNow();
    const last = this.myTrack[this.myTrack.length - 1];
    if (last && t - this.lastTrackSample < 6000 && distance(pos, last) < 8) return;
    this.lastTrackSample = t;
    this.myTrack.push({
      lat: sanitizeCoord(pos.lat),
      lng: sanitizeCoord(pos.lng),
      t,
      role: m.role,
    });
    if (this.myTrack.length > 400) {
      this.myTrack = this.myTrack.filter((_, i, arr) => i === 0 || i === arr.length - 1 || i % 2 === 0);
    }
    void this.persistEncryptedSnapshot();
  }

  private async persistEncryptedSnapshot() {
    const code = this.code();
    const s = this.session();
    if (!code || !s) return;
    try {
      const snap: EncryptedSnapshot = {
        session: s,
        players: this.players(),
        events: this.events(),
        myTrack: this.myTrack,
        lastCircle: this.lastCircle,
      };
      const blob = await this.crypto.encryptLocalData(code, this.secret, snap);
      sessionStorage.setItem(`tm_snap_${code}`, blob);
    } catch { /* ignore */ }
  }

  private async restoreEncryptedSnapshot(code: string): Promise<boolean> {
    try {
      const blob = sessionStorage.getItem(`tm_snap_${code}`);
      if (!blob) return false;
      const dec = await this.crypto.decryptLocalData<EncryptedSnapshot>(code, this.secret, blob);
      if (!dec?.session || dec.session.code !== code) return false;
      this.session.set(dec.session);
      this.players.set(dec.players ?? {});
      this.events.set(dec.events ?? []);
      this.myTrack = Array.isArray(dec.myTrack) ? dec.myTrack : [];
      this.lastCircle = dec.lastCircle ?? null;
      return true;
    } catch {
      return false;
    }
  }

  private removeEncryptedSnapshot(code: string) {
    try { sessionStorage.removeItem(`tm_snap_${code}`); } catch { /* ignore */ }
  }

  private async flushMyTrack() {
    if (this.trackFlushed) return;
    const code = this.code(), m = this.me();
    if (!code || !m) return;
    this.trackFlushed = true;

    const now = this.serverNow();
    let totalDist = 0;
    for (let i = 1; i < this.myTrack.length; i++) {
      totalDist += distance(this.myTrack[i - 1], this.myTrack[i]);
    }
    const s = this.session();
    const startAt = s?.start_at ?? now;
    const survivedMs = m.initial_role === 'hunter' ? 0 : (m.caught_at ?? (s?.ended_at ?? now)) - startAt;
    const capturesCount = this.events().filter((e) => e.type === 'caught' && e.data.hunter === this.uid).length;

    const summaryData = {
      playerId: this.uid,
      playerName: m.name,
      distanceMeters: Math.round(totalDist),
      survivedMs: Math.max(0, survivedMs),
      capturesCount,
    };

    const syntheticId = -Math.abs(this.hashString(this.uid));
    const summaryEvent: GameEvent = {
      id: syntheticId,
      session_code: code,
      type: 'track_summary',
      t: now,
      data: summaryData,
    };

    this.events.update((list) => {
      const filtered = list.filter((x) => !(x.type === 'track_summary' && x.data.playerId === this.uid));
      return [...filtered, summaryEvent];
    });

    // RGPD Art. 5.1.c (Minimisation) : Seules les métriques scalaires sont diffusées par défaut
    await this.sendP2p('s', 'track_summary', summaryData);
  }

  /** Partage volontaire et explicite de la trace GPS complète sur la carte post-partie (Consentement RGPD Art. 6). */
  async shareMyTrackOnMap() {
    if (this.myTrackShared()) return;
    const code = this.code(), m = this.me();
    if (!code || !m || !this.myTrack.length) return;
    this.myTrackShared.set(true);

    const now = this.serverNow();
    const sanitizedPoints: Pos[] = this.myTrack.map((pt) => ({
      lat: Number(pt.lat.toFixed(4)),
      lng: Number(pt.lng.toFixed(4)),
      t: pt.t,
      role: pt.role,
    }));
    this.recordTrackEvent(this.uid, m.name, sanitizedPoints, now);
    await this.sendP2p('s', 'track', {
      playerName: m.name,
      points: sanitizedPoints,
    });
    this.toast.show('📍 Trajectoire partagée sur la carte du débriefing');
  }

  private setMyCircleInRam(circle: Circle | null) {
    const now = this.serverNow();
    this.players.update((m) =>
      m[this.uid] ? { ...m, [this.uid]: { ...m[this.uid], circle, seen: now } } : m,
    );
  }

  private publishPosition() {
    const m = this.me(), pos = this.myPos();
    if (!m || !pos || this.session()?.status !== 'playing') return;
    this.sampleMyTrack();
    const t = this.serverNow();
    if (m.role === 'hunter') {
      if (t - this.lastPosWrite > 4000) {
        this.lastPosWrite = t;
        const p: Pos = { lat: sanitizeCoord(pos.lat), lng: sanitizeCoord(pos.lng), t };
        this.players.update((map) =>
          map[this.uid] ? { ...map, [this.uid]: { ...map[this.uid], pos: p, seen: t } } : map,
        );
        void this.sendP2p('h', 'hunter_pos', p);
      }
    } else {
      this.maybeUpdateCircle(pos);
      if (this.allyShareMode() === 'exact') this.broadcastExactToAllies(pos);
      if (this.lastCircle && t - this.lastCircleBroadcast > 5000) {
        this.lastCircleBroadcast = t;
        void this.sendP2p('s', 'circle', { circle: this.lastCircle });
      }
    }
  }

  private getDeterministicCircleCenter(pos: MyPos, radius: number): LatLng {
    // Offset aléatoire cryptographique uniforme dans le disque [0.25 * r, 0.65 * r]
    // Utilise des octets CSPRNG sécurisés pour garantir mathématiquement l'impossibilité absolue d'inversion par un tiers [CRIT-02]
    // Le joueur est garanti d'être à l'intérieur du cercle (ratio maximal 0.65 < 0.85).
    const randBytes = new Uint32Array(2);
    crypto.getRandomValues(randBytes);
    const pseudoAngle = (randBytes[0] / 0xffffffff) * 360;
    const pseudoDistRatio = 0.25 + (randBytes[1] / 0xffffffff) * 0.40; // [0.25, 0.65]
    return destPoint(pos, radius * pseudoDistRatio, pseudoAngle);
  }

  private maybeUpdateCircle(pos: MyPos, forceFlagUpdate = false) {
    const m = this.me();
    if (!m || m.role !== 'hunted') return;
    const { radius } = this.shrink();
    const now = this.serverNow();
    const refreshSec = this.session()?.settings.circleRefreshSec;
    const allyShare = this.allyShareMode() !== 'off';
    const c = this.lastCircle && this.lastCircle.t >= (m.circle?.t ?? 0) ? this.lastCircle : m.circle;
    const d = c ? distance(pos, c) : Infinity;
    const expired = !!(c && refreshSec && refreshSec > 0 && now - c.t >= refreshSec * 1000);
    if (!c || c.r !== radius || d > radius * 0.85 || expired) {
      // Centre cryptographiquement imprévisible et stable tant que le joueur est dans le cercle
      const center = this.getDeterministicCircleCenter(pos, radius);
      const circle: Circle = { lat: sanitizeCoord(center.lat), lng: sanitizeCoord(center.lng), r: radius, t: now, allyShare };
      this.lastCircle = circle;
      this.lastCircleBroadcast = now;
      this.setMyCircleInRam(circle);
      void this.sendP2p('s', 'circle', { circle });
      void this.persistEncryptedSnapshot();
    } else if (forceFlagUpdate && c.allyShare !== allyShare) {
      const circle: Circle = { ...c, allyShare };
      this.lastCircle = circle;
      this.lastCircleBroadcast = now;
      this.setMyCircleInRam(circle);
      void this.sendP2p('s', 'circle', { circle });
      void this.persistEncryptedSnapshot();
    }
  }

  private async requestWakeLock() {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl && this.playing) this.wakeLock = await wl.request('screen');
    } catch { /* non supporté */ }
  }
}
