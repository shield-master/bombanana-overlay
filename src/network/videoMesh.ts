import { buildIceConfig } from "./iceConfig";

const CONFIG: RTCConfiguration = buildIceConfig();
const MAX_ICE_RESTARTS = 3;

interface PeerLink {
  pc: RTCPeerConnection;
  pending: RTCIceCandidateInit[];
  restarts: number;
}

/**
 * Кто кому шлёт offer — id произвольные строки от PeerJS (код комнаты у
 * хоста, стабильный клиентский id у гостя), поэтому сравниваем
 * лексикографически: не важно, что именно сравнивать, важно, чтобы оба узла
 * посчитали одинаково и ровно один из них решил, что он меньше. Та же
 * функция решает, кто инициирует ICE restart при обрыве — иначе оба узла
 * одновременно выставят restart-offer и словят glare.
 */
function shouldOffer(selfId: string, otherId: string): boolean {
  return selfId < otherId;
}

export interface MeshHandlers {
  signal(to: string, payload: unknown): void;
  onStream(from: string, stream: MediaStream): void;
  onState(from: string, state: RTCPeerConnectionState): void;
}

/**
 * Full-mesh видео поверх WebRTC: у каждого узла — прямой RTCPeerConnection
 * с каждым остальным. Для комнаты на 3 игроков это не бутылочное горлышко
 * (максимум 2 исходящих потока на узел), а самих данных мало — по новым
 * правилам видимости транслирует камеру только та роль, которую хоть
 * кто-то видит (см. roles.ts, isSeenByAnyone).
 *
 * При обрыве конкретной связи (iceConnectionState = "failed") сторона,
 * которая изначально слала offer, сама поднимает ICE restart — обычная
 * временная сетевая рябь чинится без пересоздания PeerConnection и без
 * потери остальных соединений в mesh.
 */
export class VideoMesh {
  private peers = new Map<string, PeerLink>();

  constructor(
    private readonly selfId: string,
    private readonly local: MediaStream,
    private readonly h: MeshHandlers,
  ) {}

  /** Рассылает данные всем подключенным участникам сети. */
  broadcast(payload: unknown) {
    for (const id of this.peers.keys()) {
      this.h.signal(id, payload);
    }
  }

  /** Приводит набор соединений в соответствие со списком участников. */
  async sync(ids: string[]) {
    for (const id of ids) {
      if (id === this.selfId || this.peers.has(id)) continue;
      const { pc } = this.open(id);
      if (shouldOffer(this.selfId, id)) await this.offer(id, pc);
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
          this.h.signal(from, { kind: "sdp", sdp: pc.localDescription?.toJSON() });
        }
      } else if (msg?.kind === "ice" && msg.candidate) {
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

  destroy() {
    this.close();
  }

  close() {
    for (const id of [...this.peers.keys()]) this.drop(id);
  }

  private async offer(id: string, pc: RTCPeerConnection, iceRestart = false) {
    try {
      await pc.setLocalDescription(await pc.createOffer({ iceRestart }));
      // pc.localDescription — нативный RTCSessionDescription, PeerJS-сериализатор
      // (BinaryPack) не умеет его паковать как есть ("Type ... not yet supported").
      // .toJSON() даёт обычный {type, sdp} — то же самое уже делаем для ICE-кандидатов.
      this.h.signal(id, { kind: "sdp", sdp: pc.localDescription?.toJSON() });
    } catch (e) {
      console.error("offer failed", id, e);
    }
  }

  private open(id: string): PeerLink {
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
      if (ev.candidate) {
        console.log(`[video-ice-candidate] ${id}: type=${ev.candidate.type} proto=${ev.candidate.protocol}`);
        this.h.signal(id, { kind: "ice", candidate: ev.candidate.toJSON() });
      }
    };
    pc.onicegatheringstatechange = () => console.log(`[video-ice-gathering] ${id}: ${pc.iceGatheringState}`);
    pc.onconnectionstatechange = () => {
      console.log(`[video-conn-state] ${id}: ${pc.connectionState}`);
      this.h.onState(id, pc.connectionState);
    };
    pc.oniceconnectionstatechange = () => {
      console.log(`[video-ice-state] ${id}: ${pc.iceConnectionState}`);
      this.handleIceState(id, pc);
    };

    const peer: PeerLink = { pc, pending: [], restarts: 0 };
    this.peers.set(id, peer);
    return peer;
  }

  /** ICE отвалился (не путать с полным connectionState="failed") — пробуем восстановить без пересоздания PC. */
  private handleIceState(id: string, pc: RTCPeerConnection) {
    if (pc.iceConnectionState !== "failed") return;
    const peer = this.peers.get(id);
    if (!peer || !shouldOffer(this.selfId, id)) return; // рестарт поднимает только та сторона, что и обычный offer
    if (peer.restarts >= MAX_ICE_RESTARTS) return; // сдаёмся — onState уже отразил "failed" в UI
    peer.restarts++;
    void this.offer(id, pc, true);
  }

  private drop(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.oniceconnectionstatechange = null;
    peer.pc.close();
    this.peers.delete(id);
  }
}
