import { ROLES, PINGS } from "./roles";

/** Геометрия оверлея — по ней же считается размер окна. */
export const TILE_W = 150;
export const TILE_H = 112;
const OV_PAD = 10;
const OV_GAP = 8;
const OV_CHROME = 28 + 8 + 34; // шапка + отступ + панель сигналов

export function overlaySize(tiles: number) {
  const n = Math.max(1, tiles);
  return {
    width: Math.max(372, OV_PAD * 2 + n * TILE_W + (n - 1) * OV_GAP),
    height: OV_PAD * 2 + OV_CHROME + OV_GAP + TILE_H,
  };
}

const SHELL = `
<div class="shell" id="shell" data-screen="home">
  <div class="chrome">
    <div class="bar" data-tauri-drag-region>
      <span class="logo" data-tauri-drag-region>🍌</span>
      <span class="brand" data-tauri-drag-region>Bombanana <i>overlay</i></span>
      <span class="grow" data-tauri-drag-region></span>
      <button class="wbtn" id="btnMin" title="Свернуть">&#8211;</button>
      <button class="wbtn danger" id="btnClose" title="Закрыть">&#10005;</button>
    </div>

    <div class="body">
      <section class="page" data-page="home">
        <h1>Три обезьяны</h1>
        <p class="lead">Игра на троих по вебкамере. Без микрофона — только жесты и сигналы.</p>

        <label class="field">
          <span>Твоё имя</span>
          <input id="inName" maxlength="16" placeholder="Обезьяна" autocomplete="off" />
        </label>

        <div class="cards">
          <div class="card">
            <h2>Создать лобби</h2>
            <p>Ты становишься хостом: сервер поднимется прямо в приложении, остальные подключатся к тебе.</p>
            <label class="field inline">
              <span>Порт</span>
              <input id="inPort" value="47821" inputmode="numeric" />
            </label>
            <button class="primary" id="btnHost">Поднять лобби</button>
          </div>
          <div class="card">
            <h2>Подключиться</h2>
            <p>Введи адрес, который показал хост.</p>
            <label class="field inline">
              <span>Адрес</span>
              <input id="inAddr" placeholder="192.168.0.10:47821" autocomplete="off" />
            </label>
            <button class="primary ghost" id="btnJoin">Войти в лобби</button>
          </div>
        </div>

        <p class="err" id="homeErr" hidden></p>
      </section>

      <section class="page" data-page="lobby">
        <div class="lobby">
          <div class="col-left">
            <div class="preview">
              <video id="selfPreview" autoplay playsinline muted></video>
              <div class="preview-off" id="previewOff" hidden>камера выключена</div>
            </div>
            <select id="camSelect" class="select"></select>
            <p class="err" id="camErr" hidden></p>
          </div>

          <div class="col-right">
            <div class="addrbox">
              <div class="addrbox-text">
                <span class="addr-label" id="addrLabel">Адрес лобби</span>
                <code id="addrValue">—</code>
              </div>
              <button class="mini" id="btnCopy">Копировать</button>
            </div>

            <h3>Участники <span class="count" id="playerCount"></span></h3>
            <ul class="players" id="players"></ul>

            <h3>Выбери роль</h3>
            <div class="roles" id="roles"></div>

            <div class="lobby-actions">
              <button class="mini" id="btnShuffle" hidden>Раздать случайно</button>
              <span class="grow"></span>
              <span class="status" id="lobbyStatus"></span>
              <button class="primary" id="btnStart" hidden>Начать</button>
              <button class="mini danger" id="btnLeave">Выйти</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>

  <div class="overlay" id="overlay">
    <div class="ov-bar" data-tauri-drag-region>
      <span class="ov-badge" id="ovBadge" data-tauri-drag-region>—</span>
      <span class="grow" data-tauri-drag-region></span>
      <span class="ov-keys" data-tauri-drag-region>Ctrl+Shift+O</span>
      <button class="ov-btn" id="btnRound" hidden>Новый раунд</button>
      <button class="ov-btn" id="btnBack">Выйти</button>
    </div>
    <div class="tiles" id="tiles"></div>
    <div class="pingbar" id="pingbar"></div>
    <div class="toasts" id="toasts"></div>
  </div>
</div>
`;

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no #${id}`);
  return el as T;
}

export interface Refs {
  shell: HTMLDivElement;
  btnMin: HTMLButtonElement;
  btnClose: HTMLButtonElement;
  inName: HTMLInputElement;
  inPort: HTMLInputElement;
  inAddr: HTMLInputElement;
  btnHost: HTMLButtonElement;
  btnJoin: HTMLButtonElement;
  homeErr: HTMLElement;
  selfPreview: HTMLVideoElement;
  previewOff: HTMLElement;
  camSelect: HTMLSelectElement;
  camErr: HTMLElement;
  addrLabel: HTMLElement;
  addrValue: HTMLElement;
  btnCopy: HTMLButtonElement;
  players: HTMLElement;
  playerCount: HTMLElement;
  roles: HTMLElement;
  btnShuffle: HTMLButtonElement;
  btnStart: HTMLButtonElement;
  btnLeave: HTMLButtonElement;
  lobbyStatus: HTMLElement;
  overlay: HTMLElement;
  ovBadge: HTMLElement;
  btnRound: HTMLButtonElement;
  btnBack: HTMLButtonElement;
  tiles: HTMLElement;
  pingbar: HTMLElement;
  toasts: HTMLElement;
}

export function mount(root: HTMLElement): Refs {
  root.innerHTML = SHELL;
  // Единственный источник правды для размера плитки: и окно, и вёрстка берут его отсюда.
  document.documentElement.style.setProperty("--tile-w", `${TILE_W}px`);
  document.documentElement.style.setProperty("--tile-h", `${TILE_H}px`);
  document.documentElement.style.setProperty("--ov-pad", `${OV_PAD}px`);
  document.documentElement.style.setProperty("--ov-gap", `${OV_GAP}px`);

  const roles = must<HTMLElement>("roles");
  roles.innerHTML = ROLES.map(
    (r) => `
      <button class="role" data-role="${r.id}">
        <span class="role-emoji">${r.emoji}</span>
        <span class="role-title">${r.title}</span>
        <span class="role-rule">${r.rule}</span>
        <span class="role-taken"></span>
      </button>`,
  ).join("");

  const pingbar = must<HTMLElement>("pingbar");
  pingbar.innerHTML = PINGS.map(
    (p) => `<button class="ping" data-ping="${p}">${p}</button>`,
  ).join("");

  return {
    shell: must("shell"),
    btnMin: must("btnMin"),
    btnClose: must("btnClose"),
    inName: must("inName"),
    inPort: must("inPort"),
    inAddr: must("inAddr"),
    btnHost: must("btnHost"),
    btnJoin: must("btnJoin"),
    homeErr: must("homeErr"),
    selfPreview: must("selfPreview"),
    previewOff: must("previewOff"),
    camSelect: must("camSelect"),
    camErr: must("camErr"),
    addrLabel: must("addrLabel"),
    addrValue: must("addrValue"),
    btnCopy: must("btnCopy"),
    players: must("players"),
    playerCount: must("playerCount"),
    roles,
    btnShuffle: must("btnShuffle"),
    btnStart: must("btnStart"),
    btnLeave: must("btnLeave"),
    lobbyStatus: must("lobbyStatus"),
    overlay: must("overlay"),
    ovBadge: must("ovBadge"),
    btnRound: must("btnRound"),
    btnBack: must("btnBack"),
    tiles: must("tiles"),
    pingbar,
    toasts: must("toasts"),
  };
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

export function createTile(id: string): Tile {
  const root = document.createElement("div");
  root.className = "tile";
  root.dataset.id = id;
  root.innerHTML = `
    <video autoplay playsinline muted></video>
    <div class="tile-mask"><span></span></div>
    <span class="tile-label"></span>`;
  return {
    root,
    video: root.querySelector("video") as HTMLVideoElement,
    mask: root.querySelector(".tile-mask") as HTMLElement,
    label: root.querySelector(".tile-label") as HTMLElement,
  };
}

export function toast(host: HTMLElement, text: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  host.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}
