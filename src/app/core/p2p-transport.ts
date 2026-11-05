import { E2eeEnvelope } from './crypto.service';

const WSS_RELAYS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.services.mozilla.com'] },
];

function encodeVarInt(len: number): number[] {
  const out: number[] = [];
  do {
    let byte = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) byte |= 0x80;
    out.push(byte);
  } while (len > 0);
  return out;
}

function encodeMqttUtf8(str: string): Uint8Array {
  const utf8 = new TextEncoder().encode(str);
  const out = new Uint8Array(2 + utf8.length);
  out[0] = (utf8.length >> 8) & 0xff;
  out[1] = utf8.length & 0xff;
  out.set(utf8, 2);
  return out;
}

function buildMqttConnect(clientId: string): Uint8Array<ArrayBuffer> {
  const cid = encodeMqttUtf8(clientId);
  // Variable header: "MQTT" (00 04 4D 51 54 54), Level 4 (04), Flags CleanSession (02), KeepAlive 25s (00 19)
  const varHeader = [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x19];
  const remLen = varHeader.length + cid.length;
  const remBytes = encodeVarInt(remLen);
  const pkt = new Uint8Array(new ArrayBuffer(1 + remBytes.length + remLen));
  pkt[0] = 0x10; // CONNECT
  pkt.set(remBytes, 1);
  pkt.set(varHeader, 1 + remBytes.length);
  pkt.set(cid, 1 + remBytes.length + varHeader.length);
  return pkt;
}

function buildMqttSubscribe(topic: string): Uint8Array<ArrayBuffer> {
  const top = encodeMqttUtf8(topic);
  const remLen = 2 + top.length + 1;
  const remBytes = encodeVarInt(remLen);
  const pkt = new Uint8Array(new ArrayBuffer(1 + remBytes.length + remLen));
  pkt[0] = 0x82; // SUBSCRIBE (QoS 1 header bit required by MQTT 3.1.1 spec)
  pkt.set(remBytes, 1);
  let off = 1 + remBytes.length;
  pkt[off++] = 0x00;
  pkt[off++] = 0x01; // Packet ID 1
  pkt.set(top, off);
  off += top.length;
  pkt[off] = 0x00; // Requested QoS 0 (pure RAM, no storage)
  return pkt;
}

function buildMqttPublish(topic: string, jsonPayload: string): Uint8Array<ArrayBuffer> {
  const top = encodeMqttUtf8(topic);
  const data = new TextEncoder().encode(jsonPayload);
  const remLen = top.length + data.length;
  const remBytes = encodeVarInt(remLen);
  const pkt = new Uint8Array(new ArrayBuffer(1 + remBytes.length + remLen));
  pkt[0] = 0x30; // PUBLISH: DUP=0, QoS=0, RETAIN=0 (strictly ephemeral)
  pkt.set(remBytes, 1);
  pkt.set(top, 1 + remBytes.length);
  pkt.set(data, 1 + remBytes.length + top.length);
  return pkt;
}

export interface RtcSignalPayload {
  targetUid: string;
  sdp?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit;
}

/**
 * Transport P2P Hybride Sans Serveur & Zéro Base de Données :
 * 1. `BroadcastChannel` local (0 ms entre onglets d'un même appareil)
 * 2. `RTCPeerConnection` + `RTCDataChannel` (tunnel P2P direct chiffré DTLS entre téléphones)
 * 3. Maillage multi-relais WSS éphémères (`QoS 0`, `Retain 0`, routage par topic aveugle SHA-256)
 *    garantissant la traversée des NAT mobiles 4G/5G symétriques sans aucun stockage.
 */
export class P2pSessionMesh {
  private closed = false;
  private bc: BroadcastChannel | null = null;
  private sockets: WebSocket[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimers: ReturnType<typeof setTimeout>[] = [];
  private connectedOnce = false;
  private activeTopics: Set<string> = new Set();
  private primaryTopic: string;

  // Protection anti-DDoS CPU (filtrage de taux de paquets avant calculs cryptographiques)
  private peerPacketRate = new Map<string, { count: number; windowStart: number }>();

  // Maillage WebRTC P2P direct (uid -> RTCPeerConnection / RTCDataChannel)
  private peers = new Map<string, RTCPeerConnection>();
  private dataChannels = new Map<string, RTCDataChannel>();

  constructor(
    private readonly myUid: string,
    topicOrTopics: string | string[],
    private readonly onEnvelope: (env: E2eeEnvelope) => void,
    private readonly onConnected: () => void,
    private readonly sendRtcSignalEnvelope: (signal: RtcSignalPayload) => void,
  ) {
    const list = Array.isArray(topicOrTopics) ? topicOrTopics : [topicOrTopics];
    this.primaryTopic = list[0] ?? '';
    list.forEach((t) => { if (t) this.activeTopics.add(t); });
    this.initBroadcastChannel();
    this.initWssMesh();
    this.pingTimer = setInterval(() => this.sendPing(), 18_000);
  }

  subscribeTopic(topic: string) {
    if (!topic || this.activeTopics.has(topic)) return;
    this.activeTopics.add(topic);
    for (const ws of this.sockets) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(buildMqttSubscribe(topic)); } catch { /* ignore */ }
      }
    }
  }

  setPrimaryTopic(topic: string) {
    if (!topic) return;
    this.primaryTopic = topic;
    this.subscribeTopic(topic);
  }

  private initBroadcastChannel() {
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.bc = new BroadcastChannel(`tm_p2p_${this.primaryTopic}`);
        this.bc.onmessage = (ev) => {
          if (this.closed || !ev.data) return;
          this.handleRawString(typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data));
        };
      }
    } catch { /* non supporté */ }
  }

  private initWssMesh() {
    WSS_RELAYS.forEach((url, idx) => this.connectRelay(url, idx, 0));
  }

  private connectRelay(url: string, idx: number, attempt: number) {
    if (this.closed) return;
    try {
      const ws = new WebSocket(url, 'mqtt');
      ws.binaryType = 'arraybuffer';
      this.sockets[idx] = ws;

      const randSuffix = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      const clientId = `tm_${randSuffix}`;

      ws.onopen = () => {
        if (this.closed) {
          ws.close();
          return;
        }
        try {
          ws.send(buildMqttConnect(clientId));
        } catch { /* ignore */ }
      };

      ws.onmessage = (ev) => {
        if (this.closed || !(ev.data instanceof ArrayBuffer)) return;
        this.parseMqttFrames(ws, new Uint8Array(ev.data));
      };

      ws.onclose = () => {
        if (this.closed) return;
        const delay = Math.min(8000, 1000 * Math.pow(1.6, Math.min(attempt, 5)));
        const t = setTimeout(() => this.connectRelay(url, idx, attempt + 1), delay);
        this.reconnectTimers.push(t);
      };

      ws.onerror = () => {
        try { ws.close(); } catch { /* ignore */ }
      };
    } catch { /* ignore */ }
  }

  private parseMqttFrames(ws: WebSocket, buf: Uint8Array) {
    let pos = 0;
    while (pos < buf.length) {
      const header = buf[pos++];
      let mult = 1;
      let remLen = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        remLen += (b & 0x7f) * mult;
        mult *= 128;
        if ((b & 0x80) === 0) break;
      }
      const frameEnd = pos + remLen;
      if (frameEnd > buf.length) break;

      const pktType = header & 0xf0;
      if (pktType === 0x20) {
        // CONNACK -> SUBSCRIBE immédiatement à tous les topics actifs (blind + rendezvous)
        try {
          for (const top of this.activeTopics) {
            ws.send(buildMqttSubscribe(top));
          }
        } catch { /* ignore */ }
      } else if (pktType === 0x90) {
        // SUBACK -> canal prêt
        if (!this.connectedOnce) {
          this.connectedOnce = true;
          this.onConnected();
        }
      } else if (pktType === 0x30 && remLen >= 2) {
        // PUBLISH
        const topLen = (buf[pos] << 8) | buf[pos + 1];
        let payloadStart = pos + 2 + topLen;
        const qos = (header >> 1) & 0x03;
        if (qos > 0) payloadStart += 2;
        if (payloadStart <= frameEnd) {
          const rawJson = new TextDecoder().decode(buf.subarray(payloadStart, frameEnd));
          this.handleRawString(rawJson);
        }
      }
      pos = frameEnd;
    }
  }

  private handleRawString(raw: string) {
    if (raw.length > 65536) return; // Rejet immédiat des trames disproportionnées
    try {
      const parsed = JSON.parse(raw) as E2eeEnvelope;
      if (parsed && parsed.v === 2 && parsed.u && parsed.u !== this.myUid) {
        // Anti-DDoS CPU : limitation stricte de fréquence par UID émetteur avant toute opération WebCrypto
        const now = Date.now();
        const rate = this.peerPacketRate.get(parsed.u) ?? { count: 0, windowStart: now };
        if (now - rate.windowStart > 1000) {
          rate.count = 0;
          rate.windowStart = now;
        }
        rate.count++;
        this.peerPacketRate.set(parsed.u, rate);
        if (rate.count > 12) {
          return; // Dépassement de quota de messages (anti-flood CPU)
        }
        this.onEnvelope(parsed);
      }
    } catch { /* paquet invalide ignoré */ }
  }

  private sendPing() {
    if (this.closed) return;
    const ping = new Uint8Array([0xc0, 0x00]);
    for (const ws of this.sockets) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(ping); } catch { /* ignore */ }
      }
    }
  }

  /** Diffuse une enveloppe chiffrée E2EE sur tous les canaux P2P (WebRTC DataChannels + BroadcastChannel + WSS Mesh). */
  broadcast(env: E2eeEnvelope, targetTopic?: string) {
    if (this.closed) return;
    const raw = JSON.stringify(env);

    // 1. BroadcastChannel local
    try { this.bc?.postMessage(raw); } catch { /* ignore */ }

    // 2. Canaux directs WebRTC P2P (RTCDataChannel)
    for (const dc of this.dataChannels.values()) {
      if (dc.readyState === 'open') {
        try { dc.send(raw); } catch { /* ignore */ }
      }
    }

    // 3. Relais WSS éphémères (QoS 0, Retain 0)
    const topicToUse = targetTopic || this.primaryTopic;
    const frame = buildMqttPublish(topicToUse, raw);
    for (const ws of this.sockets) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(frame); } catch { /* ignore */ }
      }
    }
  }

  // =================================================================
  // Négociation automatique WebRTC DataChannel P2P entre joueurs
  // =================================================================
  ensurePeerConnection(peerUid: string) {
    if (this.closed || peerUid === this.myUid || this.peers.has(peerUid)) return;
    // Seul le pair ayant l'UID lexicographiquement inférieur initie l'offre WebRTC (évite le glare)
    if (this.myUid < peerUid) {
      void this.initiateRtcOffer(peerUid);
    }
  }

  private createPc(peerUid: string): RTCPeerConnection | null {
    if (typeof RTCPeerConnection === 'undefined') return null;
    try {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      this.peers.set(peerUid, pc);

      pc.onicecandidate = (ev) => {
        if (ev.candidate && !this.closed) {
          this.sendRtcSignalEnvelope({
            targetUid: peerUid,
            ice: ev.candidate.toJSON(),
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
          this.cleanupPeer(peerUid);
        }
      };

      pc.ondatachannel = (ev) => {
        this.bindDataChannel(peerUid, ev.channel);
      };

      return pc;
    } catch {
      return null;
    }
  }

  private bindDataChannel(peerUid: string, dc: RTCDataChannel) {
    this.dataChannels.set(peerUid, dc);
    dc.onmessage = (ev) => {
      if (this.closed || typeof ev.data !== 'string') return;
      this.handleRawString(ev.data);
    };
    dc.onclose = () => {
      this.dataChannels.delete(peerUid);
    };
  }

  private async initiateRtcOffer(peerUid: string) {
    const pc = this.createPc(peerUid);
    if (!pc) return;
    try {
      const dc = pc.createDataChannel('tm-e2ee-p2p', { ordered: false, maxRetransmits: 2 });
      this.bindDataChannel(peerUid, dc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendRtcSignalEnvelope({
        targetUid: peerUid,
        sdp: pc.localDescription ?? offer,
      });
    } catch {
      this.cleanupPeer(peerUid);
    }
  }

  async handleRtcSignal(senderUid: string, sig: RtcSignalPayload) {
    if (this.closed || sig.targetUid !== this.myUid) return;
    try {
      let pc = this.peers.get(senderUid) ?? null;
      if (sig.sdp) {
        if (sig.sdp.type === 'offer') {
          if (pc) this.cleanupPeer(senderUid);
          pc = this.createPc(senderUid);
          if (!pc) return;
          await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.sendRtcSignalEnvelope({
            targetUid: senderUid,
            sdp: pc.localDescription ?? answer,
          });
        } else if (sig.sdp.type === 'answer' && pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
        }
      } else if (sig.ice && pc && pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(sig.ice));
      }
    } catch { /* ignore erreurs ICE transitoires */ }
  }

  removePeer(peerUid: string) {
    this.cleanupPeer(peerUid);
  }

  private cleanupPeer(peerUid: string) {
    try { this.dataChannels.get(peerUid)?.close(); } catch { /* ignore */ }
    this.dataChannels.delete(peerUid);
    try { this.peers.get(peerUid)?.close(); } catch { /* ignore */ }
    this.peers.delete(peerUid);
  }

  close() {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const t of this.reconnectTimers) clearTimeout(t);
    this.reconnectTimers = [];
    try { this.bc?.close(); } catch { /* ignore */ }
    this.bc = null;
    for (const ws of this.sockets) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.sockets = [];
    for (const uid of [...this.peers.keys()]) {
      this.cleanupPeer(uid);
    }
  }
}
