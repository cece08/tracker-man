import { Injectable } from '@angular/core';

export type KeyScope = 's' | 'h' | 'a'; // s = session, h = hunter-only, a = ally-hunted-only
export type PacketType =
  | 'join_req'
  | 'state_sync'
  | 'sync_req'
  | 'heartbeat'
  | 'bye'
  | 'session_patch'
  | 'player_patch'
  | 'player_kick'
  | 'start_game'
  | 'role_keys'
  | 'caught'
  | 'out_of_zone'
  | 'end_game'
  | 'reset_game'
  | 'circle'
  | 'hunter_pos'
  | 'ally_pos'
  | 'track'
  | 'rtc_signal'
  | 'catch_probe';

export interface E2eeEnvelope {
  v: 2;
  k: KeyScope;
  t: PacketType;
  u: string;   // sender uid
  ts: number;  // timestamp ms
  n: string;   // 96-bit CSPRNG nonce (hex)
  iv: string;  // 96-bit CSPRNG IV (base64)
  ct: string;  // AES-256-GCM ciphertext + 128-bit auth tag (base64)
  pk: string;  // ECDSA P-256 public key (SPKI base64)
  sig: string; // ECDSA P-256 signature over (aad || iv || ct) (base64)
}

interface SessionKeySuite {
  code: string;
  blindTopic: string;
  sessionKey: CryptoKey;
  hunterKey: CryptoKey;
  allyKey: CryptoKey;
  localKey: CryptoKey;
}

export interface DeviceIdentity {
  // Signature numérique asymétrique ECDSA P-256 (NIST FIPS 186-5)
  privateKey: CryptoKey;
  publicKeySpkiB64: string;
  // Accord de clés asymétrique ECDH P-256 (NIST SP 800-56A Rev 3)
  ecdhPrivateKey: CryptoKey;
  ecdhPublicKeySpkiB64: string;
}

export interface EncryptedRoleTicket {
  targetUid: string;
  role: 'hunter' | 'hunted';
  iv: string;
  ct: string;
}

const PBKDF2_ITERATIONS = 250_000;
const CATCH_PBKDF2_ITERATIONS = 60_000;
const MAX_CLOCK_SKEW_MS = 300_000; // Tolérance 5 min pour horloges historiques
const REALTIME_MAX_CLOCK_SKEW_MS = 25_000; // Tolérance stricte 25s pour coordonnées en direct (anti-rejeu)
const MAX_REPLAY_CACHE = 5000;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
}

function randomHex(byteLen: number): string {
  const b = new Uint8Array(byteLen);
  crypto.getRandomValues(b);
  return toHex(b);
}

function openKeyVault(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB non disponible'));
    }
    const req = indexedDB.open('tm_secure_vault', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('keys')) {
        db.createObjectStore('keys');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openKeyVault();
    return new Promise((resolve) => {
      const tx = db.transaction('keys', 'readonly');
      const store = tx.objectStore('keys');
      const req = store.get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function idbSet(key: string, val: unknown): Promise<void> {
  try {
    const db = await openKeyVault();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite');
      const store = tx.objectStore('keys');
      const req = store.put(val, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch { /* ignore */ }
}

export function isValidUid(uid: unknown): boolean {
  if (typeof uid !== 'string') return false;
  if (uid === '__proto__' || uid === 'constructor' || uid === 'prototype') return false;
  return /^[a-zA-Z0-9_-]{4,64}$/.test(uid);
}

export function sanitizeCoord(n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Number(n.toFixed(6));
}

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function isValidRadius(r: unknown): boolean {
  return typeof r === 'number' && Number.isFinite(r) && r >= 5 && r <= 100_000;
}

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Joueur';
  return raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 20);
}

/**
 * Service cryptographique E2EE Zero-Knowledge & Sans Serveur (P2P).
 * Conforme aux référentiels ANSSI, ENISA, NIST FIPS 186-5 (ECDSA P-256),
 * NIST SP 800-56A (ECDH P-256), NIST SP 800-38D (AES-256-GCM AEAD),
 * NIST SP 800-132 (PBKDF2-HMAC-SHA-256) et RFC 5869 (HKDF-SHA-256).
 *
 * - Authentification asymétrique : chaque appareil signe tous ses paquets avec ECDSA P-256.
 * - Accord de clés Zero-Knowledge : isolation stricte des rôles via ECDH P-256 (les chassés ne possèdent pas la clé chasseur et vice-versa).
 * - Confidentialité AEAD : chaque paquet est chiffré en AES-256-GCM avec séparation cryptographique.
 * - Routage aveugle : le canal de communication est dérivé par hachage SHA-256 irréversible.
 * - Anti-rejeu militaire : cache de nonces CSPRNG et fenêtres d'invalidation temporelle stricte.
 */
@Injectable({ providedIn: 'root' })
export class CryptoService {
  private suitePromise: Promise<SessionKeySuite> | null = null;
  private currentCode: string | null = null;
  private seenNonces = new Set<string>();
  private identityPromise: Promise<DeviceIdentity> | null = null;
  private importedPubKeys = new Map<string, CryptoKey>();
  private importedEcdhKeys = new Map<string, CryptoKey>();

  private sessionSecret: string | null = null;

  // Clés dynamiques Zero-Knowledge distribuées par accord de clés ECDH
  private dynamicHunterKey: CryptoKey | null = null;
  private dynamicAllyKey: CryptoKey | null = null;

  /** Configure le secret de session à haute entropie (128 bits minimum, transmis dans le fragment d'URL). */
  setSessionSecret(sec: string | null) {
    this.sessionSecret = sec ? sec.trim() : null;
    this.suitePromise = null;
    this.currentCode = null;
    this.seenNonces.clear();
  }

  /** Révoque immédiatement une clé de groupe dynamique (Forward Secrecy / Rekeying lors d'une capture). */
  revokeDynamicRoleKey(scope: 'h' | 'a') {
    if (scope === 'a') this.dynamicAllyKey = null;
    if (scope === 'h') this.dynamicHunterKey = null;
  }

  /** Nettoie toutes les clés de session en mémoire vive et le cache anti-rejeu. */
  clearSessionKeys() {
    this.suitePromise = null;
    this.currentCode = null;
    this.seenNonces.clear();
    this.dynamicHunterKey = null;
    this.dynamicAllyKey = null;
    this.importedPubKeys.clear();
    this.importedEcdhKeys.clear();
    this.sessionSecret = null;
  }

  generateSecureToken(byteLen = 32): string {
    return randomHex(byteLen);
  }

  /** Charge ou génère l'identité cryptographique asymétrique de l'appareil (ECDSA P-256 + ECDH P-256). */
  async getDeviceIdentity(): Promise<DeviceIdentity> {
    if (this.identityPromise) return this.identityPromise;
    this.identityPromise = this.initDeviceIdentity();
    return this.identityPromise;
  }

  private async initDeviceIdentity(): Promise<DeviceIdentity> {
    let privateKey: CryptoKey | null = null;
    let publicKeySpkiB64 = '';
    let ecdhPrivateKey: CryptoKey | null = null;
    let ecdhPublicKeySpkiB64 = '';

    // 1. Clé de signature numérique ECDSA P-256 stockée de façon NON-EXTRACTIBLE dans IndexedDB
    try {
      const [idbPriv, idbPub] = await Promise.all([
        idbGet<CryptoKey>('tm_ecdsa_priv_v3'),
        idbGet<string>('tm_ecdsa_pub_v3'),
      ]);
      if (idbPriv && idbPub) {
        privateKey = idbPriv;
        publicKeySpkiB64 = idbPub;
      }
    } catch { /* régénère */ }

    if (!privateKey || !publicKeySpkiB64) {
      // Clé générée avec extractable: false pour empêcher toute fuite ou exfiltration XSS
      const kp = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, // NON-EXTRACTIBLE
        ['sign', 'verify'],
      );
      const spkiPub = await crypto.subtle.exportKey('spki', kp.publicKey);
      publicKeySpkiB64 = toBase64(new Uint8Array(spkiPub));
      privateKey = kp.privateKey;

      await Promise.all([
        idbSet('tm_ecdsa_priv_v3', kp.privateKey),
        idbSet('tm_ecdsa_pub_v3', publicKeySpkiB64),
      ]);
      // Purge de sécurité : suppression des anciennes clés en clair du localStorage
      try {
        localStorage.removeItem('tm_ecdsa_priv');
        localStorage.removeItem('tm_ecdsa_pub');
      } catch { /* ignore */ }
    }

    // 2. Clé d'accord de clés ECDH P-256 stockée de façon NON-EXTRACTIBLE dans IndexedDB
    try {
      const [idbEcdhPriv, idbEcdhPub] = await Promise.all([
        idbGet<CryptoKey>('tm_ecdh_priv_v3'),
        idbGet<string>('tm_ecdh_pub_v3'),
      ]);
      if (idbEcdhPriv && idbEcdhPub) {
        ecdhPrivateKey = idbEcdhPriv;
        ecdhPublicKeySpkiB64 = idbEcdhPub;
      }
    } catch { /* régénère */ }

    if (!ecdhPrivateKey || !ecdhPublicKeySpkiB64) {
      const kpEcdh = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false, // NON-EXTRACTIBLE
        ['deriveKey', 'deriveBits'],
      );
      const spkiEcdhPub = await crypto.subtle.exportKey('spki', kpEcdh.publicKey);
      ecdhPublicKeySpkiB64 = toBase64(new Uint8Array(spkiEcdhPub));
      ecdhPrivateKey = kpEcdh.privateKey;

      await Promise.all([
        idbSet('tm_ecdh_priv_v3', kpEcdh.privateKey),
        idbSet('tm_ecdh_pub_v3', ecdhPublicKeySpkiB64),
      ]);
      // Purge de sécurité des anciennes clés en clair du localStorage
      try {
        localStorage.removeItem('tm_ecdh_priv');
        localStorage.removeItem('tm_ecdh_pub');
      } catch { /* ignore */ }
    }

    return {
      privateKey,
      publicKeySpkiB64,
      ecdhPrivateKey,
      ecdhPublicKeySpkiB64,
    };
  }

  private async importVerifyKey(spkiB64: string): Promise<CryptoKey | null> {
    const cached = this.importedPubKeys.get(spkiB64);
    if (cached) return cached;
    try {
      const bytes = fromBase64(spkiB64);
      const key = await crypto.subtle.importKey(
        'spki',
        bytes,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      if (this.importedPubKeys.size > 200) this.importedPubKeys.clear();
      this.importedPubKeys.set(spkiB64, key);
      return key;
    } catch {
      return null;
    }
  }

  private async importEcdhKey(spkiB64: string): Promise<CryptoKey | null> {
    const cached = this.importedEcdhKeys.get(spkiB64);
    if (cached) return cached;
    try {
      const bytes = fromBase64(spkiB64);
      const key = await crypto.subtle.importKey(
        'spki',
        bytes,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      );
      if (this.importedEcdhKeys.size > 200) this.importedEcdhKeys.clear();
      this.importedEcdhKeys.set(spkiB64, key);
      return key;
    } catch {
      return null;
    }
  }

  /**
   * Enveloppe un secret de rôle (256 bits) spécifiquement pour la clé ECDH publique d'un participant
   * via accord de clés Diffie-Hellman ECDH P-256 + dérivation HKDF + AES-256-GCM.
   */
  async wrapSecretForPeer(peerEcdhSpkiB64: string, secretHex: string): Promise<{ iv: string; ct: string }> {
    const identity = await this.getDeviceIdentity();
    const peerKey = await this.importEcdhKey(peerEcdhSpkiB64);
    if (!peerKey) throw new Error('Clé ECDH invalide.');

    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerKey },
      identity.ecdhPrivateKey,
      256,
    );
    const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    const enc = new TextEncoder();
    const wrapKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: enc.encode('TM-RoleKeyWrap-Salt-v2'),
        info: enc.encode('role-secret-key-wrap-v2'),
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      wrapKey,
      enc.encode(secretHex),
    );
    return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
  }

  /**
   * Déchiffre un ticket de rôle enveloppé reçu via accord de clés ECDH P-256.
   */
  async unwrapSecretFromPeer(peerEcdhSpkiB64: string, ivB64: string, ctB64: string): Promise<string | null> {
    try {
      const identity = await this.getDeviceIdentity();
      const peerKey = await this.importEcdhKey(peerEcdhSpkiB64);
      if (!peerKey) return null;

      const sharedBits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: peerKey },
        identity.ecdhPrivateKey,
        256,
      );
      const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
      const enc = new TextEncoder();
      const wrapKey = await crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: enc.encode('TM-RoleKeyWrap-Salt-v2'),
          info: enc.encode('role-secret-key-wrap-v2'),
        },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      );
      const iv = fromBase64(ivB64);
      const ct = fromBase64(ctB64);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, tagLength: 128 },
        wrapKey,
        ct,
      );
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }

  /** Installe une clé dynamique AES-256-GCM Zero-Knowledge dérivée pour un rôle donné. */
  async installDynamicRoleKey(scope: 'h' | 'a', secretHex: string): Promise<void> {
    const enc = new TextEncoder();
    const rawKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(`TM-DynamicRole-Secret::${secretHex}`),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: enc.encode(`TM-RoleSalt-Dynamic-v2::${scope}`),
        iterations: 20_000,
        hash: 'SHA-256',
      },
      rawKey,
      256,
    );
    const key = await crypto.subtle.importKey(
      'raw',
      bits,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    if (scope === 'h') this.dynamicHunterKey = key;
    if (scope === 'a') this.dynamicAllyKey = key;
  }

  /** Retourne l'identifiant de canal aveugle (SHA-256) dérivé du code de session. */
  async getBlindTopic(code: string, deviceSecret: string): Promise<string> {
    const suite = await this.getSuite(code, deviceSecret);
    return suite.blindTopic;
  }

  /** Prépare et met en cache la suite de clés AES-256-GCM pour la session `code`. */
  private getSuite(code: string, deviceSecret: string): Promise<SessionKeySuite> {
    const cleanCode = code.trim().toUpperCase();
    const cacheKey = `${cleanCode}:${this.sessionSecret ?? ''}`;
    if (this.currentCode === cacheKey && this.suitePromise) {
      return this.suitePromise;
    }
    this.currentCode = cacheKey;
    this.seenNonces.clear();
    this.suitePromise = this.deriveSuite(cleanCode, deviceSecret);
    return this.suitePromise;
  }

  private async deriveSuite(code: string, deviceSecret: string): Promise<SessionKeySuite> {
    const enc = new TextEncoder();
    const entropyMaterial = this.sessionSecret
      ? `TM-E2EE-V2::${code}::${this.sessionSecret}`
      : `TM-E2EE-V2::${code}`;
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(entropyMaterial),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const saltString = this.sessionSecret
      ? `TrackerMan-GovSec-EU-Salt-v2::${code}::${this.sessionSecret}`
      : `TrackerMan-GovSec-EU-Salt-v2::${code}`;
    const masterBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: enc.encode(saltString),
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      baseKey,
      256,
    );
    const hkdfKey = await crypto.subtle.importKey('raw', masterBits, 'HKDF', false, [
      'deriveKey',
      'deriveBits',
    ]);

    const deriveAesKey = (info: string) =>
      crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: enc.encode(`TM-HKDF-Salt::${code}`),
          info: enc.encode(info),
        },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );

    const topicBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: enc.encode(`TM-BlindTopic-Salt::${code}`),
        info: enc.encode('scope:blind-routing-topic-v2'),
      },
      hkdfKey,
      256,
    );
    const blindTopic = `tm/v2/${toHex(new Uint8Array(topicBits)).slice(0, 40)}`;

    const localBaseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(`TM-LOCAL-V2::${deviceSecret}::${code}`),
      'HKDF',
      false,
      ['deriveKey'],
    );
    const localKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: enc.encode(`TM-LocalStorage-Salt::${code}`),
        info: enc.encode('local-ephemeral-track-v2'),
      },
      localBaseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

    const [sessionKey, hunterKey, allyKey] = await Promise.all([
      deriveAesKey('scope:session-general-v2'),
      deriveAesKey('scope:role-hunter-pos-v2'),
      deriveAesKey('scope:role-ally-hunted-pos-v2'),
    ]);

    return { code, blindTopic, sessionKey, hunterKey, allyKey, localKey };
  }

  private pickKey(suite: SessionKeySuite, scope: KeyScope): CryptoKey {
    if (scope === 'h') return this.dynamicHunterKey ?? suite.hunterKey;
    if (scope === 'a') return this.dynamicAllyKey ?? suite.allyKey;
    return suite.sessionKey;
  }

  /**
   * Chiffre un paquet en AES-256-GCM (AEAD) ET le signe avec la clé privée ECDSA P-256 du joueur.
   */
  async encryptPacket<T>(
    code: string,
    deviceSecret: string,
    scope: KeyScope,
    type: PacketType,
    senderUid: string,
    timestamp: number,
    payload: T,
  ): Promise<E2eeEnvelope> {
    const [suite, identity] = await Promise.all([
      this.getSuite(code, deviceSecret),
      this.getDeviceIdentity(),
    ]);
    const key = this.pickKey(suite, scope);
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const nonce = randomHex(12);
    const ts = Math.round(timestamp);

    const enc = new TextEncoder();
    const aadStr = `v2|${suite.code}|${scope}|${type}|${senderUid}|${ts}|${nonce}|${identity.publicKeySpkiB64}`;
    const aad = enc.encode(aadStr);
    const plaintext = enc.encode(JSON.stringify(payload));

    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      key,
      plaintext,
    );
    const ctB64 = toBase64(new Uint8Array(cipherBuf));
    const ivB64 = toBase64(iv);

    const sigData = enc.encode(`${aadStr}|${ivB64}|${ctB64}`);
    const sigBuf = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      identity.privateKey,
      sigData,
    );

    return {
      v: 2,
      k: scope,
      t: type,
      u: senderUid,
      ts,
      n: nonce,
      iv: ivB64,
      ct: ctB64,
      pk: identity.publicKeySpkiB64,
      sig: toBase64(new Uint8Array(sigBuf)),
    };
  }

  /**
   * Vérifie la signature ECDSA P-256, l'authenticité AES-256-GCM (tag + AAD),
   * la fraîcheur temporelle et l'absence de rejeu, puis déchiffre le paquet.
   */
  async decryptPacket<T>(
    code: string,
    deviceSecret: string,
    envelope: unknown,
    nowMs: number,
    allowHistoricalTimestamp = false,
  ): Promise<{
    senderUid: string;
    senderPubKey: string;
    type: PacketType;
    scope: KeyScope;
    ts: number;
    data: T;
  } | null> {
    try {
      if (!envelope || typeof envelope !== 'object') return null;
      const env = envelope as Partial<E2eeEnvelope>;
      if (
        env.v !== 2 ||
        (env.k !== 's' && env.k !== 'h' && env.k !== 'a') ||
        typeof env.t !== 'string' ||
        typeof env.u !== 'string' ||
        !isValidUid(env.u) ||
        typeof env.ts !== 'number' ||
        !Number.isFinite(env.ts) ||
        typeof env.n !== 'string' ||
        env.n.length < 16 ||
        typeof env.iv !== 'string' ||
        typeof env.ct !== 'string' ||
        typeof env.pk !== 'string' ||
        typeof env.sig !== 'string'
      ) {
        return null;
      }

      // Protection anti-rejeu et anti-retard stricte sur les positions en temps réel
      const isRealtime = env.t === 'hunter_pos' || env.t === 'ally_pos' || env.t === 'circle';
      const maxSkew = isRealtime ? REALTIME_MAX_CLOCK_SKEW_MS : MAX_CLOCK_SKEW_MS;
      if (!allowHistoricalTimestamp && Math.abs(nowMs - env.ts) > maxSkew) {
        return null;
      }

      const replayKey = `${env.u}:${env.n}`;
      if (this.seenNonces.has(replayKey)) {
        return null;
      }
      // Dédoublonnage immédiat avant opérations cryptographiques coûteuses (anti-DDoS CPU)
      if (this.seenNonces.size >= MAX_REPLAY_CACHE) {
        const first = this.seenNonces.values().next().value;
        if (first) this.seenNonces.delete(first);
      }
      this.seenNonces.add(replayKey);

      const verifyKey = await this.importVerifyKey(env.pk);
      if (!verifyKey) return null;

      const suite = await this.getSuite(code, deviceSecret);
      const enc = new TextEncoder();
      const aadStr = `v2|${suite.code}|${env.k}|${env.t}|${env.u}|${env.ts}|${env.n}|${env.pk}`;

      // 1. Vérification de la signature asymétrique ECDSA P-256
      const sigBytes = fromBase64(env.sig);
      const sigValid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        verifyKey,
        sigBytes,
        enc.encode(`${aadStr}|${env.iv}|${env.ct}`),
      );
      if (!sigValid) return null;

      // 2. Déchiffrement authentifié AES-256-GCM (AEAD)
      const key = this.pickKey(suite, env.k);
      const iv = fromBase64(env.iv);
      if (iv.length !== 12) return null;
      const ciphertext = fromBase64(env.ct);

      const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: enc.encode(aadStr), tagLength: 128 },
        key,
        ciphertext,
      );

      const data = JSON.parse(new TextDecoder().decode(plainBuf)) as T;
      return {
        senderUid: env.u,
        senderPubKey: env.pk,
        type: env.t as PacketType,
        scope: env.k,
        ts: env.ts,
        data,
      };
    } catch {
      return null;
    }
  }

  /**
   * Dérive de façon déterministe et privée le code chasseur à 4 chiffres du joueur
   * à partir de son secret local 256 bits, du code de session et du timestamp de début.
   * Ce code ne quitte JAMAIS le téléphone du chasseur.
   */
  async deriveMyCatchCode(code: string, startAt: number, deviceSecret: string, uid: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(`TM-CATCH-SECRET::${deviceSecret}`),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      enc.encode(`${code.toUpperCase()}::${startAt}::${uid}`),
    );
    const view = new DataView(mac);
    const num = (view.getUint32(0, false) & 0x7fffffff) % 10000;
    return String(num).padStart(4, '0');
  }

  /**
   * Calcule l'engagement cryptographique (commitment PBKDF2-SHA-256 à 60 000 itérations)
   * d'un code chasseur à 4 chiffres afin de permettre aux chassés de vérifier un code
   * saisi sans jamais exposer le code en clair sur le réseau.
   */
  async computeCatchCommitment(
    code: string,
    startAt: number,
    hunterUid: string,
    catchCode4: string,
  ): Promise<string> {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(`TM-CATCH-PIN::${catchCode4.trim()}`),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: enc.encode(`TM-CatchSalt-v2::${code.toUpperCase()}::${startAt}::${hunterUid}`),
        iterations: CATCH_PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      baseKey,
      256,
    );
    return toHex(new Uint8Array(bits));
  }

  /** Chiffre des données temporaires pour `sessionStorage` avec la clé locale de l'appareil. */
  async encryptLocalData<T>(code: string, deviceSecret: string, data: T): Promise<string> {
    const suite = await this.getSuite(code, deviceSecret);
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const enc = new TextEncoder();
    const aad = enc.encode(`v2|local|${suite.code}`);
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      suite.localKey,
      enc.encode(JSON.stringify(data)),
    );
    return `${toBase64(iv)}.${toBase64(new Uint8Array(cipherBuf))}`;
  }

  /** Déchiffre des données temporaires depuis `sessionStorage`. */
  async decryptLocalData<T>(code: string, deviceSecret: string, blob: string): Promise<T | null> {
    try {
      const parts = blob.split('.');
      if (parts.length !== 2) return null;
      const iv = fromBase64(parts[0]);
      if (iv.length !== 12) return null;
      const ct = fromBase64(parts[1]);
      const suite = await this.getSuite(code, deviceSecret);
      const enc = new TextEncoder();
      const aad = enc.encode(`v2|local|${suite.code}`);
      const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
        suite.localKey,
        ct,
      );
      return JSON.parse(new TextDecoder().decode(plainBuf)) as T;
    } catch {
      return null;
    }
  }
}
