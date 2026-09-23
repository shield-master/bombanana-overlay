/**
 * Сигналинг и топология "звезда через хоста" поверх PeerJS: вместо своего
 * сервера, который нужно пробрасывать в интернет, хост и гости выходят
 * наружу на бесплатный публичный брокер (0.peerjs.com) — исходящее
 * соединение почти всегда разрешено, даже за CGNAT/строгим NAT/файрволом.
 * Брокер знает только код комнаты (id хоста), реальный трафик идёт P2P или
 * через TURN-релей, если напрямую не вышло.
 *
 * Хост держит прямое DataConnection с каждым гостем и ретранслирует
 * сообщения между ними; гость знает только хоста. Хост — тот же relay,
 * который раньше жил в src-tauri/src/signaling.rs, теперь в его браузере.
 *
 * Поверх этого — Photon-подобная надёжность:
 *  - heartbeat.ts ловит зомби-соединения, которые браузер не закрывает честно;
 *  - peerBroker.ts сам восстанавливает сокет сигналинга при кратковременном разрыве;
 *  - гость при потере канала до хоста пытается тихо переподключиться под тем
 *    же стабильным id (identity.ts), не теряя место в комнате;
 *  - хост не выкидывает гостя мгновенно при обрыве — даёт grace-период на
 *    возврат, чтобы бытовой сетевой лаг не стоил игроку роли и раунда.
 */
import type { DataConnection } from "peerjs";
import { Heartbeat } from "./heartbeat";
import { getClientId } from "./identity";
import { PeerBroker } from "./peerBroker";
import {
  isEnvelope,
  isFull,
  isLeave,
  isPing,
  isPong,
  isRosterMessage,
  type FullMessage,
  type LeaveMessage,
  type PongMessage,
  type RosterMessage,
  type WireEnvelope,
} from "./protocol";

const CONNECT_TIMEOUT_MS = 15000;
const GUEST_RECONNECT_ATTEMPTS = 5;
const GUEST_RECONNECT_BASE_MS = 1500;
const GUEST_RECONNECT_MAX_MS = 10000;
const HOST_GRACE_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Slot {
  conn: DataConnection;
  heartbeat: Heartbeat;
}

export interface SignalHandlers {
  onHello(id: string, hostId: string): void;
  onPeers(peers: string[], hostId: string): void;
  onData(from: string, data: unknown): void;
  /** Сессия окончательно завершена — восстановить нечего, возвращаемся домой. */
  onClosed(reason: string): void;
  /** Необязательные хуки для UX восстановления связи (тосты, индикаторы). */
  onReconnecting?(attempt: number): void;
  onReconnected?(): void;
  onPeerReconnecting?(peerId: string): void;
  onPeerReconnected?(peerId: string): void;
}

export class Signal {
  private readonly broker: PeerBroker;
  private readonly slots = new Map<string, Slot>();
  /** Персональный состав комнаты (хост в него не входит) — не путать с `slots`: */
  /** тут остаются игроки на grace-паузе, у которых сейчас нет живого соединения. */
  private readonly members = new Set<string>();
  private readonly pendingGrace = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly intentionalLeaves = new Set<string>();
  private amHost = false;
  private hostId = "";
  private closedByUs = false;

  constructor(private readonly h: SignalHandlers) {
    this.broker = new PeerBroker({
      onConnection: (conn) => this.acceptIncoming(conn),
      onReconnecting: (attempt) => this.h.onReconnecting?.(attempt),
      onReconnected: () => this.h.onReconnected?.(),
      onFatal: (reason) => this.h.onClosed(reason),
    });
  }

  /** Поднимает комнату с этим кодом — мы становимся хостом и узлом-ретранслятором. */
  async host(roomCode: string): Promise<void> {
    this.amHost = true;
    this.hostId = roomCode;
    this.members.clear();
    const myId = await this.broker.open(roomCode, CONNECT_TIMEOUT_MS);
    this.h.onHello(myId, roomCode);
  }

  /** Подключается к существующей комнате по коду. */
  async join(roomCode: string): Promise<void> {
    this.amHost = false;
    this.hostId = roomCode;
    const myId = await this.broker.open(getClientId(), CONNECT_TIMEOUT_MS);
    try {
      await this.dialHost(roomCode);
    } catch (err) {
      // Сокет до брокера уже открыт под нашим стабильным id — если не убить
      // его тут, следующая попытка входа получит "id занят" от брокера,
      // потому что старая (неудачная) регистрация ещё не протухла сама.
      this.broker.destroy();
      throw err;
    }
    this.h.onHello(myId, roomCode);
  }

  /** `to` не задан — уходит всем, кроме отправителя. */
  send(data: unknown, to?: string): void {
    const from = this.broker.id;
    if (!from) return;

    if (this.amHost) {
      if (to) this.slots.get(to)?.conn.send({ from, to, data } satisfies WireEnvelope);
      else for (const slot of this.slots.values()) slot.conn.send({ from, to: undefined, data } satisfies WireEnvelope);
      return;
    }

    // Гость знает только хоста — тот сам разберётся с маршрутизацией.
    this.slots.get(this.hostId)?.conn.send({ from, to, data } satisfies WireEnvelope);
  }

  /** Хост разрывает связь с конкретным гостем — например, комната переполнена (лимит участников). */
  kick(id: string, reason: string): void {
    if (!this.amHost) return;
    const slot = this.slots.get(id);
    if (!slot) return;
    const full: FullMessage = { __full: true, reason };
    try {
      slot.conn.send(full);
    } catch {
      /* всё равно рвём соединение ниже */
    }
    slot.heartbeat.stop();
    slot.conn.close();
    this.slots.delete(id);
    this.members.delete(id);
    this.clearGrace(id);
    this.broadcastRoster();
  }

  close(): void {
    this.closedByUs = true;
    for (const timer of this.pendingGrace.values()) clearTimeout(timer);
    this.pendingGrace.clear();

    const leave: LeaveMessage = { __leave: true };
    for (const slot of this.slots.values()) {
      slot.heartbeat.stop();
      try {
        slot.conn.send(leave);
      } catch {
        /* уходим в любом случае */
      }
      slot.conn.close();
    }
    this.slots.clear();
    this.members.clear();
    this.broker.destroy();
  }

  // -------------------------------------------------------------- гость

  private dialHost(hostId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = this.broker.connect(hostId);
      if (!conn) {
        reject(new Error("Хост не отвечает. Проверь код комнаты."));
        return;
      }
      this.attachIceDiagnostics(conn, hostId);
      const timer = setTimeout(() => {
        conn.close();
        reject(new Error("Хост не отвечает. Проверь код комнаты."));
      }, CONNECT_TIMEOUT_MS);

      conn.on("open", () => {
        clearTimeout(timer);
        this.wireConn(conn, hostId);
        resolve();
      });
      conn.on("error", () => {
        clearTimeout(timer);
        reject(new Error("Не удалось подключиться к хосту."));
      });
    });
  }

  /** Канал до хоста молча пропал — пробуем вернуться под тем же id, не сообщая о выходе. */
  private async rejoinHost(): Promise<void> {
    for (let attempt = 0; attempt < GUEST_RECONNECT_ATTEMPTS; attempt++) {
      if (this.closedByUs) return;
      this.h.onReconnecting?.(attempt + 1);
      try {
        await this.dialHost(this.hostId);
        this.h.onReconnected?.();
        return;
      } catch {
        await sleep(Math.min(GUEST_RECONNECT_BASE_MS * 2 ** attempt, GUEST_RECONNECT_MAX_MS));
      }
    }
    if (!this.closedByUs) this.h.onClosed("Не удалось переподключиться к хосту.");
  }

  // -------------------------------------------------------------- хост

  private acceptIncoming(conn: DataConnection): void {
    const id = conn.peer;
    this.attachIceDiagnostics(conn, id);
    conn.on("open", () => {
      const wasReconnect = this.clearGrace(id);
      this.members.add(id);
      this.wireConn(conn, id);
      this.broadcastRoster();
      if (wasReconnect) this.h.onPeerReconnected?.(id);
    });
  }

  private beginGuestGrace(id: string): void {
    this.h.onPeerReconnecting?.(id);
    const timer = setTimeout(() => {
      this.pendingGrace.delete(id);
      this.members.delete(id);
      this.broadcastRoster();
    }, HOST_GRACE_MS);
    this.pendingGrace.set(id, timer);
  }

  private clearGrace(id: string): boolean {
    const timer = this.pendingGrace.get(id);
    if (!timer) return false;
    clearTimeout(timer);
    this.pendingGrace.delete(id);
    return true;
  }

  private broadcastRoster(): void {
    const peers = [this.hostId, ...this.members];
    this.h.onPeers(peers, this.hostId);
    const msg: RosterMessage = { roster: { peers, hostId: this.hostId } };
    for (const slot of this.slots.values()) slot.conn.send(msg);
  }

  // -------------------------------------------------------------- общее

  private wireConn(conn: DataConnection, id: string): void {
    const heartbeat = new Heartbeat(
      (msg) => conn.send(msg),
      () => this.handleConnLoss(conn, id),
    );
    this.slots.set(id, { conn, heartbeat });
    heartbeat.start();

    conn.on("data", (raw) => this.handleIncoming(id, raw));
    conn.on("close", () => this.handleConnLoss(conn, id));
    conn.on("error", () => this.handleConnLoss(conn, id));
  }

  /** Видно в devtools-консоли, на чём именно стопорится ICE — гатеринг, тип кандидата, connectivity checks. */
  private attachIceDiagnostics(conn: DataConnection, id: string): void {
    const pc = (conn as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
    if (!pc) return;
    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) console.log(`[ice-candidate] ${id}: type=${e.candidate.type} proto=${e.candidate.protocol}`);
    });
    pc.addEventListener("icegatheringstatechange", () => console.log(`[ice-gathering] ${id}: ${pc.iceGatheringState}`));
    pc.addEventListener("iceconnectionstatechange", () => console.log(`[ice-state] ${id}: ${pc.iceConnectionState}`));
  }

  /**
   * Канал пропал — либо по-настоящему (heartbeat.timeout / close / error), либо
   * потому что тот конец только что явно попрощался (__leave, см. handleIncoming).
   * У хоста это решает, эвиктить гостя сразу или дать ему grace-период; у гостя —
   * пробовать тихий rejoin или, если хост попрощался сам, просто выйти.
   */
  private handleConnLoss(conn: DataConnection, id: string): void {
    const slot = this.slots.get(id);
    if (!slot || slot.conn !== conn) return; // уже заменено новым соединением
    slot.heartbeat.stop();
    this.slots.delete(id);
    // Heartbeat-таймаут не закрывает канал сам — досылаем close явно, иначе
    // канал технически жив и может ещё что-то доставить мимо нашего учёта.
    conn.close();
    if (this.closedByUs) return;

    const wasIntentional = this.intentionalLeaves.delete(id);

    if (this.amHost) {
      if (wasIntentional) {
        this.members.delete(id);
        this.broadcastRoster();
      } else {
        this.beginGuestGrace(id);
      }
    } else if (!wasIntentional) {
      void this.rejoinHost();
    }
  }

  private handleIncoming(viaConnId: string, raw: unknown): void {
    if (isPing(raw)) {
      this.slots.get(viaConnId)?.conn.send({ __pong: raw.__ping } satisfies PongMessage);
      return;
    }
    if (isPong(raw)) {
      this.slots.get(viaConnId)?.heartbeat.onPong(raw);
      return;
    }
    if (isLeave(raw)) {
      this.intentionalLeaves.add(viaConnId);
      if (!this.amHost) this.h.onClosed("Хост закрыл лобби.");
      return;
    }
    if (isFull(raw)) {
      if (!this.amHost) this.h.onClosed(raw.reason);
      return;
    }
    if (isRosterMessage(raw)) {
      this.h.onPeers(raw.roster.peers ?? [], raw.roster.hostId ?? "");
      return;
    }
    if (!isEnvelope(raw)) return;
    const { from, to, data } = raw as WireEnvelope;

    if (!this.amHost) {
      this.h.onData(from, data);
      return;
    }

    // Хост — узел-ретранслятор для всех остальных (см. заголовок файла).
    if (!to || to === this.hostId) this.h.onData(from, data);
    if (!to) {
      for (const [pid, slot] of this.slots) if (pid !== viaConnId) slot.conn.send({ from, to, data } satisfies WireEnvelope);
    } else if (to !== this.hostId) {
      this.slots.get(to)?.conn.send({ from, to, data } satisfies WireEnvelope);
    }
  }
}
