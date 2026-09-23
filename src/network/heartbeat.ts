import type { PingMessage, PongMessage } from "./protocol";

const INTERVAL_MS = 4000;
const MAX_MISSED = 3;

/**
 * Держит одно соединение «живым»: периодически шлёт ping и ждёт pong.
 * Нужен потому что браузер не всегда честно и быстро сообщает о разрыве
 * WebRTC-канала через событие close — зомби-соединение может висеть молча.
 * Побочный эффект — RTT, пригодится для индикатора качества связи в UI.
 */
export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private missed = 0;
  private lastRtt = 0;

  constructor(
    private readonly send: (msg: PingMessage) => void,
    private readonly onTimeout: () => void,
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      if (this.missed >= MAX_MISSED) {
        this.stop();
        this.onTimeout();
        return;
      }
      this.missed++;
      this.send({ __ping: Date.now() });
    }, INTERVAL_MS);
  }

  /** Вызывать при получении PongMessage от собеседника. */
  onPong(msg: PongMessage): void {
    this.missed = 0;
    this.lastRtt = Date.now() - msg.__pong;
  }

  get rtt(): number {
    return this.lastRtt;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
