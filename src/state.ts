import type { AppState, Player, Phase, Screen } from "./types";

type Listener = (state: AppState) => void;

const initialState: AppState = {
  screen: "home",
  phase: "lobby",
  round: 1,
  myId: "",
  hostId: "",
  name: "",
  players: [],
  interactive: true,
  roomCode: "",
  level: null,
  roomMode: "bombanana",
};

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor(init: Partial<AppState> = {}) {
    this.state = { ...initialState, ...init };
  }

  get current(): Readonly<AppState> {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // Вызываем сразу при подписке для первичной отрисовки
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  update(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  /** Форсирует перерисовку без изменения состояния — для внешних данных вроде видео-потоков. */
  touch() {
    this.notify();
  }

  setScreen(screen: Screen) {
    this.update({ screen });
  }

  setPhase(phase: Phase) {
    this.update({ phase });
  }

  setPlayers(players: Player[]) {
    this.update({ players });
  }

  setInteractive(interactive: boolean) {
    this.update({ interactive });
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}