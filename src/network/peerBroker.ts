import { Peer, util, type DataConnection } from "peerjs";
import { buildIceConfig } from "./iceConfig";

const MAX_RECONNECT_ATTEMPTS = 6;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 15000;

export interface PeerBrokerHandlers {
  /** Входящее соединение (только у хоста — гость никого не принимает). */
  onConnection?(conn: DataConnection): void;
  /** Сокет сигналинга отвалился, идёт попытка восстановить его же id. */
  onReconnecting?(attempt: number): void;
  /** Сокет сигналинга восстановлен, существующие P2P-соединения это не затрагивало. */
  onReconnected?(): void;
  /** Восстановить не удалось (или пришла неисправимая ошибка) — сессия окончена. */
  onFatal?(reason: string): void;
}

function describePeerError(err: { type?: string }): string {
  switch (err.type) {
    case "unavailable-id":
      return "Этот код уже занят — попробуй ещё раз.";
    case "peer-unavailable":
      return "Комната не найдена — проверь код.";
    case "browser-incompatible":
      return "WebView не поддерживает нужные функции WebRTC.";
    default:
      return "Не удалось подключиться к серверу сигналинга.";
  }
}

/**
 * Жизненный цикл одного PeerJS `Peer`: открытие с таймаутом, разбор ошибок
 * брокера и, в отличие от голого PeerJS, авто-восстановление сокета
 * сигналинга с экспоненциальным backoff — вместо того чтобы сразу считать
 * сессию мёртвой при любом чихе сети. Уже установленные P2P-соединения
 * (DataConnection/RTCPeerConnection) от разрыва сокета не зависят — это
 * влияет только на способность открывать НОВЫЕ соединения.
 */
export class PeerBroker {
  private peer: Peer | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;

  constructor(private readonly handlers: PeerBrokerHandlers) {}

  get id(): string {
    return this.peer?.id ?? "";
  }

  /** Открывает Peer с заданным id (хост/стабильный гость) или анонимно, если id не передан. */
  open(id: string | undefined, timeoutMs: number): Promise<string> {
    this.closedByUs = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.destroy();
        reject(new Error(reason));
      };
      const timer = setTimeout(() => fail("Не удалось подключиться к серверу сигналинга."), timeoutMs);

      const config = buildIceConfig((util.defaultConfig.iceServers as RTCIceServer[]) ?? []);
      const peer = id ? new Peer(id, { config }) : new Peer({ config });
      this.peer = peer;

      peer.on("open", (myId) => {
        this.reconnectAttempts = 0;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(myId);
        } else {
          this.handlers.onReconnected?.();
        }
      });

      peer.on("connection", (conn) => this.handlers.onConnection?.(conn));

      peer.on("error", (err: any) => {
        const reason = describePeerError(err);
        if (!settled) {
          fail(reason);
          return;
        }
        // "id занят" после уже успешного open обычно означает, что наш же
        // старый сокет ещё не протух на брокере — реконнект тут не поможет.
        if (err?.type === "unavailable-id") this.handlers.onFatal?.(reason);
      });

      peer.on("disconnected", () => {
        if (!settled || this.closedByUs) return;
        this.scheduleReconnect();
      });

      peer.on("close", () => {
        if (!this.closedByUs) this.handlers.onFatal?.("Соединение с сервером сигналинга закрыто.");
      });
    });
  }

  /** Открывает исходящее DataConnection до другого пира (гость → хост). */
  connect(targetId: string): DataConnection | undefined {
    return this.peer?.connect(targetId, { reliable: true });
  }

  private scheduleReconnect(): void {
    if (this.closedByUs || !this.peer) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.handlers.onFatal?.("Не удалось восстановить соединение с сервером сигналинга.");
      return;
    }
    const attempt = this.reconnectAttempts++;
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
    this.handlers.onReconnecting?.(attempt + 1);
    this.reconnectTimer = setTimeout(() => {
      if (this.closedByUs || !this.peer) return;
      this.peer.reconnect();
    }, delay);
  }

  destroy(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.peer?.destroy();
    this.peer = null;
  }
}
