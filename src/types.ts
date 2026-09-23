import type { RoleId } from "./roles";

export type Screen = "home" | "game";
export type Phase = "lobby" | "game";
/**
 * "bombanana" — обычная комната на троих, синхронная с реальной игрой (роли,
 * раунды, скрытия). "free" — просто видеозвонок до 8 человек без всякой
 * привязки к BOMBANANA: роли/раунды/фильтры не применяются никогда.
 */
export type RoomMode = "bombanana" | "free";

export interface Player {
  id: string;
  name: string;
  role: RoleId | null;
}

export interface AppState {
  screen: Screen;
  phase: Phase;
  round: number;
  myId: string;
  hostId: string;
  name: string;
  players: Player[];
  /** false — клики проваливаются в игру под оверлеем. */
  interactive: boolean;
  /** Код комнаты — показывается в шапке оверлея, пока раунд не идёт. */
  roomCode: string;
  /** Номер уровня кампании (1-30) от самой игры — известен только во время раунда. */
  level: number | null;
  roomMode: RoomMode;
}

/**
 * Плитка участника. Переживает перерисовки: пересоздавать <video> нельзя,
 * иначе у него отвалится поток.
 */
export interface Tile {
  root: HTMLElement;
  video: HTMLVideoElement;
  mask: HTMLElement;
  label: HTMLElement;
}

/** Источник видео для плиток: своя камера, реальный пир по WebRTC или бот-заглушка. */
export interface MediaProvider {
  streamFor(id: string): MediaStream | null;
  connFor(id: string): RTCPeerConnectionState | undefined;
}