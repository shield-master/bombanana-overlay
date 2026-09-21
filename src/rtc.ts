/**
 * Полная сетка P2P-соединений: на троих это всего 3 канала, поэтому
 * трафик хоста ничем не отличается от остальных.
 */

const CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ],
};

type Peer = { pc: RTCPeerConnection; pending: RTCIceCandidateInit[] };

/** Кто кому шлёт offer. Решаем по номеру в id ("p2" -> 2), чтобы не столкнуться лбами. */
function rank(id: string): number {
  return Number.parseInt(id.slice(1), 10) || 0;
}

export interface MeshHandlers {
  signal(to: string, payload: unknown): void;
  onStream(from: string, stream: MediaStream): void;
  onState(from: string, state: RTCPeerConnectionState): void;
}

export class Mesh {
  private peers = new Map<string, Peer>();

  constructor(
    private readonly selfId: string,
    private readonly local: MediaStream,
    private readonly h: MeshHandlers,
  ) {}

  /** Приводит набор соединений в соответствие со списком участников. */
  async sync(ids: string[]) {
    for (const id of ids) {
      if (id === this.selfId || this.peers.has(id)) continue;
      const { pc } = this.open(id);
      if (rank(this.selfId) < rank(id)) {
        try {
          await pc.setLocalDescription(await pc.createOffer());
          this.h.signal(id, { kind: "sdp", sdp: pc.localDescription });
        } catch (e) {
          console.error("offer failed", id, e);
        }
      }
    }
    for (const id of [...this.peers.keys()]) {
      if (!ids.includes(id)) this.drop(id);
    }
  }

  async accept(from: string, msg: any) {
    const peer = this.open(from);
    const { pc } = peer;
    try {
      if (msg?.kind === "sdp") {
        await pc.setRemoteDescription(msg.sdp);
        for (const c of peer.pending.splice(0)) {
          await pc.addIceCandidate(c).catch(() => {});
        }
        if (msg.sdp.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());
          this.h.signal(from, { kind: "sdp", sdp: pc.localDescription });
        }
      } else if (msg?.kind === "ice" && msg.candidate) {
        // Кандидаты часто обгоняют offer — придерживаем их до remoteDescription.
        if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate).catch(() => {});
        else peer.pending.push(msg.candidate);
      }
    } catch (e) {
      console.error("rtc accept failed", from, e);
    }
  }

  /** Немая обезьяна перестаёт передавать картинку прямо в источнике. */
  setOutgoingVideo(enabled: boolean) {
    for (const track of this.local.getVideoTracks()) track.enabled = enabled;
  }

  /** Смена камеры на лету: подменяем трек у отправителей, без пересогласования. */
  async replaceVideo(track: MediaStreamTrack) {
    for (const { pc } of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(track).catch(() => {});
    }
  }

  close() {
    for (const id of [...this.peers.keys()]) this.drop(id);
  }

  private open(id: string): Peer {
    const existing = this.peers.get(id);
    if (existing) return existing;

    const pc = new RTCPeerConnection(CONFIG);
    for (const track of this.local.getTracks()) pc.addTrack(track, this.local);

    const inbound = new MediaStream();
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? inbound;
      if (stream === inbound) inbound.addTrack(ev.track);
      this.h.onStream(id, stream);
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.h.signal(id, { kind: "ice", candidate: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => this.h.onState(id, pc.connectionState);

    const peer: Peer = { pc, pending: [] };
    this.peers.set(id, peer);
    return peer;
  }

  private drop(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    this.peers.delete(id);
  }
}
