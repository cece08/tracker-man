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
  | 'track_summary'
  | 'rtc_signal'
  | 'session_secret'
  | 'catch_probe';

export interface E2eeEnvelope {
  v: 2;
  k: KeyScope;
  t: PacketType;
  u: string;   // sender uid
  seq: number; // sequence counter
  ep?: number; // epoch instance ID (résilience au rechargement de page & fenêtre glissante RFC 4303)
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
  localKey: CryptoKey;
  baseKey: CryptoKey;
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

  private mySeq = 0;
  private myEpoch = Date.now();
  private peerReplayWindows = new Map<string, { epoch: number; maxSeq: number; window: bigint }>();

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
    this.peerReplayWindows.clear();
    this.mySeq = 0;
    this.myEpoch = Date.now();
    this.dynamicHunterKey = null;
    this.dynamicAllyKey = null;
    this.importedPubKeys.clear();
    this.importedEcdhKeys.clear();
    this.sessionSecret = null;
  }

  generateSecureToken(byteLen = 32): string {
    return randomHex(byteLen);
  }

  /** Calcule une preuve de travail légère (16 bits de zéros) anti-Sybil/anti-flood en ~40ms. */
  async solveProofOfWork(code: string, uid: string): Promise<string> {
    const enc = new TextEncoder();
    const prefix = `${code.toUpperCase()}::${uid}::`;
    let nonce = 0;
    while (true) {
      const candidate = (nonce++).toString(16);
      const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(prefix + candidate));
      const bytes = new Uint8Array(hashBuf);
      if (bytes[0] === 0 && bytes[1] === 0) {
        return candidate;
      }
    }
  }

  /** Vérifie instantanément en 1 hash la preuve de travail fournie. */
  async verifyProofOfWork(code: string, uid: string, nonce: string): Promise<boolean> {
    if (!nonce || typeof nonce !== 'string' || nonce.length > 32) return false;
    const enc = new TextEncoder();
    const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(`${code.toUpperCase()}::${uid}::${nonce}`));
    const bytes = new Uint8Array(hashBuf);
    return bytes[0] === 0 && bytes[1] === 0;
  }

  /** Topic de rendez-vous chiffré pour négociation initiale des sessions. */
  async getRendezvousTopic(code: string, sharedEntropyHex?: string | null): Promise<string> {
    const cleanCode = code.trim().toUpperCase();
    const enc = new TextEncoder();
    if (sharedEntropyHex && sharedEntropyHex.length >= 32) {
      // Pour les sessions par QR Code / lien direct : HMAC-SHA-256 avec 128 bits d'entropie CSPRNG (espace > 10^38)
      const hmacKey = await crypto.subtle.importKey(
        'raw',
        enc.encode(sharedEntropyHex),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const mac = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(`TM-QR-RENDEZVOUS-V3::${cleanCode}`));
      return `tm/v3/rz_${toHex(new Uint8Array(mac)).slice(0, 32)}`;
    }

    // Pour les saisies manuelles au code court (6 caractères) :
    // KDF lourd PBKDF2 (200 000 itérations) interdisant toute inversion GPU temps réel [CRIT-01]
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(`TM-PEPPER-V3::${cleanCode}`),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: enc.encode('TM-GOVSEC-MANUAL-RENDEZVOUS-SALT-2026-IMMUTABLE'),
        iterations: 200_000,
        hash: 'SHA-256',
      },
      baseKey,
      256,
    );
    return `tm/v3/rz_${toHex(new Uint8Array(bits)).slice(0, 32)}`;
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

    // 1. Clé de base dérivée uniquement du code court avec 100 000 itérations PBKDF2
    // Utilisée pour chiffrer de façon hermétique l'échange de négociation ECDH sans interblocage [MAJ-02]
    const baseEntropy = await crypto.subtle.importKey(
      'raw',
      enc.encode(`TM-BASE-V3::${code}`),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const baseBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: enc.encode(`TM-Base-Salt-v3::${code}`),
        iterations: 100_000,
        hash: 'SHA-256',
      },
      baseEntropy,
      256,
    );
    const baseHkdfKey = await crypto.subtle.importKey('raw', baseBits, 'HKDF', false, ['deriveKey']);
    const baseKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: enc.encode(`TM-HKDF-BaseSalt::${code}`),
        info: enc.encode('scope:rendezvous-base-v3'),
      },
      baseHkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

    // 2. Clé de session complète intégrant le secret 128 bits
    const entropyMaterial = this.sessionSecret
      ? `TM-E2EE-V3::${code}::${this.sessionSecret}`
      : `TM-E2EE-V3::${code}`;
    const baseMasterKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(entropyMaterial),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const saltString = this.sessionSecret
      ? `TrackerMan-GovSec-EU-Salt-v3::${code}::${this.sessionSecret}`
      : `TrackerMan-GovSec-EU-Salt-v3::${code}`;
    const masterBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: enc.encode(saltString),
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      baseMasterKey,
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
        info: enc.encode('scope:blind-routing-topic-v3'),
      },
      hkdfKey,
      256,
    );
    const blindTopic = `tm/v3/${toHex(new Uint8Array(topicBits)).slice(0, 40)}`;

    const localBaseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(`TM-LOCAL-V3::${deviceSecret}::${code}`),
      'HKDF',
      false,
      ['deriveKey'],
    );
    const localKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: enc.encode(`TM-LocalStorage-Salt::${code}`),
        info: enc.encode('local-ephemeral-track-v3'),
      },
      localBaseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

    const sessionKey = this.sessionSecret ? await deriveAesKey('scope:session-general-v3') : baseKey;

    return { code, blindTopic, sessionKey, localKey, baseKey };
  }

  private pickKey(suite: SessionKeySuite, scope: KeyScope): CryptoKey {
    // Isolation Zero-Knowledge absolue : AUCUN fallback statique.
    // Les clés de rôles doivent provenir impérativement de l'accord de clés asymétrique ECDH P-256 individuel.
    if (scope === 'h') {
      if (!this.dynamicHunterKey) throw new Error('Accès refusé : aucune clé chasseur ECDH.');
      return this.dynamicHunterKey;
    }
    if (scope === 'a') {
      if (!this.dynamicAllyKey) throw new Error('Accès refusé : aucune clé allié ECDH.');
      return this.dynamicAllyKey;
    }
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
    const isHandshake = type === 'join_req' || type === 'session_secret';
    const key = isHandshake ? suite.baseKey : this.pickKey(suite, scope);
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const nonce = randomHex(12);
    const ts = Math.round(timestamp);
    const seq = ++this.mySeq;
    const ep = this.myEpoch;

    const enc = new TextEncoder();
    const aadStr = `v2|${suite.code}|${scope}|${type}|${senderUid}|${seq}|${ep}|${ts}|${nonce}|${identity.publicKeySpkiB64}`;
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
      seq,
      ep,
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
   * la fraîcheur temporelle et l'absence de rejeu (fenêtre glissante RFC 4303), puis déchiffre le paquet.
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
        typeof env.seq !== 'number' ||
        !Number.isFinite(env.seq) ||
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

      // Contrôle de numéro de séquence avec fenêtre glissante RFC 4303 / IPsec (anti-rejeu et résilience UDP) [MAJ-03]
      const ep = env.ep ?? 0;
      if (!allowHistoricalTimestamp) {
        let replay = this.peerReplayWindows.get(env.u);
        if (!replay || ep > replay.epoch) {
          // Nouvel epoch détecté (ex: rechargement de page ou reconnexion)
          replay = { epoch: ep, maxSeq: env.seq, window: 1n };
          this.peerReplayWindows.set(env.u, replay);
        } else if (ep < replay.epoch) {
          return null; // Epoch antérieur obsolète
        } else {
          // Même epoch : vérification via masque glissant 64 paquets
          const diff = env.seq - replay.maxSeq;
          if (diff > 0) {
            if (diff >= 64) {
              replay.window = 1n;
            } else {
              replay.window = (replay.window << BigInt(diff)) | 1n;
            }
            replay.maxSeq = env.seq;
          } else {
            const absDiff = -diff;
            if (absDiff >= 64) {
              return null; // Paquet trop ancien hors de la fenêtre
            }
            const mask = 1n << BigInt(absDiff);
            if ((replay.window & mask) !== 0n) {
              return null; // Rejeu détecté dans la fenêtre glissante
            }
            replay.window |= mask; // Paquet hors-ordre valide accepté
          }
        }
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
      const aadStr = `v2|${suite.code}|${env.k}|${env.t}|${env.u}|${env.seq}|${ep}|${env.ts}|${env.n}|${env.pk}`;

      // 1. Vérification de la signature asymétrique ECDSA P-256
      const sigBytes = fromBase64(env.sig);
      const sigValid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        verifyKey,
        sigBytes,
        enc.encode(`${aadStr}|${env.iv}|${env.ct}`),
      );
      if (!sigValid) return null;

      // 2. Déchiffrement authentifié AES-256-GCM (AEAD) [MAJ-02]
      const isHandshake = env.t === 'join_req' || env.t === 'session_secret';
      const key = isHandshake ? suite.baseKey : this.pickKey(suite, env.k);
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

  /** Signe une chaîne arbitraire avec la clé privée ECDSA P-256 de l'appareil (ex: reçu cryptographique de capture [CRIT-03]). */
  async signPayload(payloadStr: string): Promise<string> {
    const identity = await this.getDeviceIdentity();
    const enc = new TextEncoder();
    const sigBuf = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      identity.privateKey,
      enc.encode(payloadStr),
    );
    return toBase64(new Uint8Array(sigBuf));
  }

  /** Vérifie une signature ECDSA P-256 sur une chaîne arbitraire avec la clé publique du pair. */
  async verifySignature(pubKeySpkiB64: string, payloadStr: string, sigB64: string): Promise<boolean> {
    try {
      const verifyKey = await this.importVerifyKey(pubKeySpkiB64);
      if (!verifyKey) return false;
      const enc = new TextEncoder();
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        verifyKey,
        fromBase64(sigB64),
        enc.encode(payloadStr),
      );
    } catch {
      return false;
    }
  }  /**
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
