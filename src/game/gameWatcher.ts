/**
 * Слушает события реального состояния BOMBANANA от Rust-бэкенда (game_log.rs,
 * живой тейл Player.log самой игры) и переводит их в "раунд начался"/"раунд
 * закончился" плюс — когда игра это раскрывает — роль, которую она назначила
 * ИМЕННО ЭТОМУ клиенту, и номер уровня кампании.
 *
 * Подтверждено вживую: игра логирует FMOD-снапшот локального игрока в момент
 * назначения роли — `[FmodSoundManager] Mute snapshot START (snapshot:/Mute)` —
 * тем же именем, что и роль (Blind/Deaf/Mute); и номер уровня отдельной строкой —
 * `[SteamCampaignProgress] Campaign level enter | UI=14 missionId=13 enterCount=1`.
 * Rust-сторона уже разбирает это (и параллельно — строку статуса лобби с её
 * GameState) в события `bombanana-round`/`bombanana-level`.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RoleId } from "../roles";

export interface RoundEvent {
  kind: "start" | "end";
  /** Известна только когда сигнал пришёл из FMOD-снапшота роли — иначе null. */
  role: string | null;
}

export interface LevelEvent {
  level: number;
}

/** Реальный Steam Lobby ID этого клиента — приходит до старта раунда, когда игра входит в лобби. */
export interface LobbyEvent {
  lobbyId: string;
  isHost: boolean;
}

const KNOWN_ROLES = new Set<string>(["blind", "mute", "deaf"]);

function asRoleId(role: string | null): RoleId | null {
  return role && KNOWN_ROLES.has(role) ? (role as RoleId) : null;
}

export interface GameWatcherHandlers {
  onRoundStart(role: RoleId | null): void;
  onRoundEnd(): void;
  onLevel(level: number): void;
  onLobby(lobbyId: string): void;
}

/** Возвращает функцию отписки — вызвать при полном выходе из приложения, если понадобится. */
export async function watchGameState(h: GameWatcherHandlers): Promise<UnlistenFn> {
  let roundActive = false;

  const unlistenRound = await listen<RoundEvent>("bombanana-round", (ev) => {
    const { kind, role } = ev.payload;
    if (kind === "start") {
      roundActive = true;
      h.onRoundStart(asRoleId(role));
    } else if (kind === "end") {
      if (!roundActive) return;
      roundActive = false;
      h.onRoundEnd();
    }
  });

  const unlistenLevel = await listen<LevelEvent>("bombanana-level", (ev) => {
    h.onLevel(ev.payload.level);
  });

  const unlistenLobby = await listen<LobbyEvent>("bombanana-lobby", (ev) => {
    h.onLobby(ev.payload.lobbyId);
  });

  return () => {
    unlistenRound();
    unlistenLevel();
    unlistenLobby();
  };
}
