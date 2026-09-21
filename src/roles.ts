export type RoleId = "blind" | "mute" | "deaf";

export interface Role {
  id: RoleId;
  emoji: string;
  title: string;
  rule: string;
}

export const ROLES: Role[] = [
  {
    id: "blind",
    emoji: "🙈",
    title: "Слепая",
    rule: "Не видит ничего: ни чужие камеры, ни своё превью. Её видят все.",
  },
  {
    id: "mute",
    emoji: "🙊",
    title: "Немая",
    rule: "Её камера гаснет для остальных — жестом ничего не показать. Сама видит всех.",
  },
  {
    id: "deaf",
    emoji: "🙉",
    title: "Глухая",
    rule: "Видит всех, но до неё не доходят сигналы-эмодзи.",
  },
];

/**
 * Единственное место, где записано, чего лишает роль.
 * Микрофона в игре нет, поэтому «канала связи» ровно два:
 * видео (жесты) и быстрые сигналы-эмодзи. Меняешь таблицу — меняется механика.
 */
export interface Effects {
  /** Видит ли игрок чужие камеры. */
  seesOthers: boolean;
  /** Видит ли игрок собственное превью. */
  seesSelf: boolean;
  /** Транслируется ли его камера остальным. */
  isSeen: boolean;
  /** Доходят ли до него сигналы-эмодзи. */
  receivesPings: boolean;
}

export const EFFECTS: Record<RoleId, Effects> = {
  blind: { seesOthers: false, seesSelf: false, isSeen: true, receivesPings: true },
  mute: { seesOthers: true, seesSelf: true, isSeen: false, receivesPings: true },
  deaf: { seesOthers: true, seesSelf: true, isSeen: true, receivesPings: false },
};

export const PINGS = ["🍌", "💣", "👍", "👎", "❓", "⏰"];

export function role(id: RoleId | null | undefined): Role | null {
  return ROLES.find((r) => r.id === id) ?? null;
}
