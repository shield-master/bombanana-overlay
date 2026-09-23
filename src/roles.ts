export type RoleId = "blind" | "mute" | "deaf";

export interface Role {
  id: RoleId;
  emoji: string;
  /** Имя обезьяны, как в лобби: «Слепая», «Немая», «Глухая». */
  title: string;
  /** Кто она по смыслу партии — то, чем занята в раунде. */
  job: string;
  rule: string;
}

export const ROLES: Role[] = [
  {
    id: "blind",
    emoji: "🙈",
    title: "Слепая",
    job: "обезвреживает бомбу",
    rule: "Видит себя и Глухую — но контурным чёрно-белым зрением. Немую не видит. Саму её не видит никто.",
  },
  {
    id: "mute",
    emoji: "🙊",
    title: "Немая",
    job: "читает инструкцию",
    rule: "Видит всех: себя, Глухую и Слепую. Саму её не видит никто.",
  },
  {
    id: "deaf",
    emoji: "🙉",
    title: "Глухая",
    job: "переводчица",
    rule: "Видит только себя. Её видят обе остальные — и Немая, и Слепая (той — контурным зрением).",
  },
];

/**
 * Направленная видимость: может ли viewer видеть камеру target.
 * Несимметрично — Немая видит и Глухую, и Слепую, а её саму не видит никто.
 * Себя видят все, поэтому эта таблица про чужие камеры.
 */
const VISIBILITY: Record<RoleId, Partial<Record<RoleId, boolean>>> = {
  blind: { deaf: true, mute: false },
  mute: { deaf: true, blind: true },
  deaf: { blind: false, mute: false },
};

/** Слепая видит контурным чёрно-белым зрением — и себя саму, и Глухую. */
const HIGH_CONTRAST_FROM: RoleId = "blind";
const HIGH_CONTRAST_TO: RoleId = "deaf";

export function canSee(viewer: RoleId | null, target: RoleId | null, isSelf: boolean): boolean {
  if (isSelf) return true; // все видят себя
  if (!viewer || !target) return true; // роль ещё не выбрана — эффектов нет
  return VISIBILITY[viewer]?.[target] ?? true;
}

export function isHighContrast(viewer: RoleId | null, target: RoleId | null, isSelf: boolean): boolean {
  if (viewer !== HIGH_CONTRAST_FROM) return false;
  if (isSelf) return true; // Слепая видит контурным зрением и себя саму
  return target === HIGH_CONTRAST_TO;
}

/** Есть ли хоть кто-то, кому видна камера этой роли — чтобы решить, транслировать ли её вообще. */
export function isSeenByAnyone(role: RoleId | null): boolean {
  if (!role) return true;
  return (Object.keys(VISIBILITY) as RoleId[]).some(
    (viewer) => viewer !== role && (VISIBILITY[viewer]?.[role] ?? true),
  );
}

export function role(id: RoleId | null | undefined): Role | null {
  return ROLES.find((r) => r.id === id) ?? null;
}
