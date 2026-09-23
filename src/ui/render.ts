import type { AppState, MediaProvider, Player, Tile } from "../types";
import type { RoleId } from "../roles";
import { createTile, type Refs } from "./dom";
import { canSee, isHighContrast } from "../roles";
import { GRID_FROM } from "../config";
import { t } from "../i18n";

export function renderUI(refs: Refs, state: AppState, tiles: Map<string, Tile>, media: MediaProvider) {
  refs.shell.dataset.screen = state.screen;
  refs.shell.dataset.interactive = String(state.interactive);

  if (state.screen === "game") {
    renderOverlay(refs, state);
    renderTiles(refs, state, tiles, media);
  }
}

function renderOverlay(refs: Refs, state: AppState) {
  refs.ovStatus.textContent =
    state.roomMode === "free"
      ? t("overlay.statusFree")
      : state.level !== null
        ? t("overlay.statusGame")
        : t("overlay.statusLobby");
  refs.ovHint.textContent = state.interactive ? t("overlay.hintLock") : t("overlay.hintUnlock");
}

function renderTiles(refs: Refs, state: AppState, tiles: Map<string, Tile>, media: MediaProvider) {
  // Роль конкретному игроку могла подставиться раньше, чем групповой раунд
  // прошёл проверку синхронизации (см. tryStartRound в main.ts) — пока
  // phase не "game", это ещё не подтверждённый раунд, и скрытия/цветокоррекция
  // применяться не должны: все видят всех как в обычном видеозвонке. В
  // свободном лобби скрытий/фильтров нет вообще никогда, ни при каком phase.
  const roundActive = state.roomMode === "bombanana" && state.phase === "game";
  const me = state.players.find((p) => p.id === state.myId);
  const myRole = (roundActive ? me?.role ?? null : null) as RoleId | null;

  refs.tiles.dataset.grid = String(state.players.length >= GRID_FROM);

  for (const player of state.players) {
    let tile = tiles.get(player.id);
    if (!tile) {
      tile = createTile(player.id);
      tiles.set(player.id, tile);
      refs.tiles.appendChild(tile.root);
    }

    const mine = player.id === state.myId;
    const stream = media.streamFor(player.id);
    if (stream && tile.video.srcObject !== stream) {
      tile.video.srcObject = stream;
      void tile.video.play().catch(() => {});
    }

    const targetRole = roundActive ? player.role : null;
    const visible = canSee(myRole, targetRole, mine);
    const filtered = visible && isHighContrast(myRole, targetRole, mine);

    tile.mask.hidden = visible;
    const maskSpan = tile.mask.firstElementChild as HTMLElement | null;
    if (maskSpan) maskSpan.textContent = visible ? "" : "🙈";

    tile.root.dataset.self = String(mine);
    tile.root.dataset.filtered = String(filtered);

    tile.label.innerHTML = tileLabelHtml(player, state, mine, visible && roundActive);
    tile.root.dataset.conn = mine ? "connected" : (media.connFor(player.id) ?? "new");
  }

  for (const [id, tile] of [...tiles]) {
    if (!state.players.some((p) => p.id === id)) {
      tile.root.remove();
      tiles.delete(id);
    }
  }

  // Порядок плиток одинаков у всех. Двигаем DOM только если он реально разъехался.
  const want = state.players.map((p) => tiles.get(p.id)!.root);
  const have = [...refs.tiles.children];
  if (want.length !== have.length || want.some((el, i) => el !== have[i])) {
    for (const el of want) refs.tiles.appendChild(el);
  }
}

/** [Хост] Имя [ты] [Роль обезьяна] — роль в бейдже только если раунд подтверждён и она видна этому зрителю. */
function tileLabelHtml(player: Player, state: AppState, mine: boolean, visible: boolean): string {
  const parts: string[] = [];
  if (player.id === state.hostId) parts.push(`<span class="tile-tag host">${escapeHtml(t("overlay.tagHost"))}</span>`);
  parts.push(escapeHtml(player.name));
  if (mine) parts.push(`<span class="tile-tag">${escapeHtml(t("overlay.tagYou"))}</span>`);
  if (player.role && visible) {
    const roleName = t(`role.${player.role}`);
    const label = t("overlay.roleSuffix", { role: roleName });
    parts.push(`<span class="tile-tag role">${escapeHtml(label)}</span>`);
  }
  return parts.join(" ");
}

/** Имя игрока приходит по сети от других пиров — экранируем перед вставкой как HTML. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
