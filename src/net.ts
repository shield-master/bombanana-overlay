/** Клиент к релею из `src-tauri/src/signaling.rs`. */

export interface SignalHandlers {
  onHello(id: string, hostId: string): void;
  onPeers(peers: string[], hostId: string): void;
  onData(from: string, data: any): void;
  onClosed(reason: string): void;
}

export class Signal {
  private ws: WebSocket | null = null;
  private closedByUs = false;

  constructor(private readonly h: SignalHandlers) {}

  connect(url: string, timeoutMs = 6000): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(new Error(`Плохой адрес: ${url}`));
        return;
      }
      this.ws = ws;
      this.closedByUs = false;

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Хост не отвечает. Проверь адрес и брандмауэр."));
      }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Не удалось подключиться к хосту."));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (!this.closedByUs) this.h.onClosed("Соединение с хостом разорвано.");
      };
      ws.onmessage = (ev) => this.dispatch(ev.data);
    });
  }

  private dispatch(raw: unknown) {
    if (typeof raw !== "string") return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case "hello":
        this.h.onHello(msg.id, msg.hostId);
        break;
      case "peers":
        this.h.onPeers(msg.peers ?? [], msg.hostId ?? "");
        break;
      case "relay":
        this.h.onData(msg.from, msg.data);
        break;
    }
  }

  /** `to` не задан — уходит всем, кроме отправителя. */
  send(data: unknown, to?: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(to ? { t: "send", to, data } : { t: "send", data }));
  }

  close() {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }
}
