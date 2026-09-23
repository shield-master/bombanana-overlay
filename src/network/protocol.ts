/**
 * Формат сообщений поверх PeerJS DataConnection. Три уровня:
 *  - служебные (ping/pong/leave) — для heartbeat и graceful-выхода,
 *  - roster — снимок состава комнаты, шлёт только хост,
 *  - envelope — прикладные сообщения игры (profile/role_pick/state_sync и т.д.),
 *    адресованные конкретному узлу или всем (`to` не задан).
 */

export interface WireEnvelope {
  from: string;
  to?: string;
  data: unknown;
}

export interface RosterMessage {
  roster: { peers: string[]; hostId: string };
}

export interface PingMessage {
  __ping: number;
}

export interface PongMessage {
  __pong: number;
}

export interface LeaveMessage {
  __leave: true;
}

/** Хост разрывает связь с конкретным гостем (например, комната переполнена). */
export interface FullMessage {
  __full: true;
  reason: string;
}

export type WireMessage = WireEnvelope | RosterMessage | PingMessage | PongMessage | LeaveMessage | FullMessage;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

export function isRosterMessage(msg: unknown): msg is RosterMessage {
  return isObject(msg) && isObject(msg.roster);
}

export function isEnvelope(msg: unknown): msg is WireEnvelope {
  return isObject(msg) && "data" in msg && typeof msg.from === "string";
}

export function isPing(msg: unknown): msg is PingMessage {
  return isObject(msg) && typeof msg.__ping === "number";
}

export function isPong(msg: unknown): msg is PongMessage {
  return isObject(msg) && typeof msg.__pong === "number";
}

export function isLeave(msg: unknown): msg is LeaveMessage {
  return isObject(msg) && msg.__leave === true;
}

export function isFull(msg: unknown): msg is FullMessage {
  return isObject(msg) && msg.__full === true;
}
