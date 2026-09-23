import { OV_PAD, OV_GAP } from "../config";
import type { Tile } from "../types";

/**
 * Контурное чёрно-белое зрение Слепой: ч/б -> лёгкое размытие (убирает шумную
 * рябь на текстурах вроде волос) -> лапласиан (края) -> линейный разгон
 * контраста. Referenced via CSS filter: url(#tile-contour) на <video>.
 */
const CONTOUR_FILTER = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <filter id="tile-contour" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0.3 0.3 0.3 0 0  0.3 0.3 0.3 0 0  0.3 0.3 0.3 0 0  0 0 0 1 0" result="gray"/>
      <feGaussianBlur in="gray" stdDeviation="0.6" result="blurred"/>
      <feConvolveMatrix in="blurred" order="3" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1" divisor="1" bias="0" preserveAlpha="true" result="edges"/>
      <feComponentTransfer in="edges">
        <feFuncR type="linear" slope="5" intercept="-0.15"/>
        <feFuncG type="linear" slope="5" intercept="-0.15"/>
        <feFuncB type="linear" slope="5" intercept="-0.15"/>
      </feComponentTransfer>
    </filter>
  </defs>
</svg>
`;

const SHELL = `
${CONTOUR_FILTER}
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
        <p class="lead">Игра на троих по вебкамере. Без микрофона — только то, что видно в камеру.</p>

        <div class="cards">
          <div class="card card-host">
            <span class="card-icon">🎬</span>
            <h2>Создать лобби</h2>
            <p>Ты становишься хостом — получишь код комнаты и дашь его друзьям, из любой сети.</p>
            <button class="primary" id="btnHost">Поднять лобби</button>
          </div>
          <button class="card-sub" id="btnHostFree" type="button">
            <span class="card-sub-icon">💬</span>
            <span class="card-sub-text">
              <span class="card-sub-title">Свободное лобби</span>
              <span class="card-sub-desc">До 8 человек · просто видеозвонок, без привязки к игре</span>
            </span>
          </button>
          <div class="card card-join">
            <span class="card-icon">🔑</span>
            <h2>Подключиться</h2>
            <p>Введи код комнаты, который показал хост.</p>
            <label class="field inline">
              <span>Код</span>
              <input id="inAddr" placeholder="U5AF-B67C" autocomplete="off" />
            </label>
            <button class="primary ghost" id="btnJoin">Войти в лобби</button>
          </div>
        </div>

        <p class="err" id="homeErr" hidden></p>

        <div class="setup">
          <label class="field">
            <span>Твоё имя</span>
            <input id="inName" maxlength="16" placeholder="Обезьяна" autocomplete="off" />
          </label>
          <label class="field">
            <span>Выбранная камера</span>
            <select id="camSelect" class="select"></select>
          </label>
          <p class="err" id="camErr" hidden></p>
        </div>
      </section>
    </div>
  </div>

  <div class="overlay" id="overlay">
    <div class="ov-bar" data-tauri-drag-region>
      <button class="ov-code" id="ovBadge" title="Клик — скопировать. 5 кликов — показать код.">****-****</button>
      <span class="ov-status" id="ovStatus" data-tauri-drag-region>В лобби</span>
      <span class="grow" data-tauri-drag-region></span>
      <button class="ov-btn danger" id="btnBack" title="Выйти">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <polyline points="16 17 21 12 16 7"></polyline>
          <line x1="21" y1="12" x2="9" y2="12"></line>
        </svg>
      </button>
    </div>
    <div class="ov-hint" id="ovHint" data-tauri-drag-region></div>
    <div class="tiles" id="tiles"></div>
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
  inAddr: HTMLInputElement;
  btnHost: HTMLButtonElement;
  btnHostFree: HTMLButtonElement;
  btnJoin: HTMLButtonElement;
  homeErr: HTMLElement;
  camSelect: HTMLSelectElement;
  camErr: HTMLElement;
  overlay: HTMLElement;
  ovBadge: HTMLButtonElement;
  ovStatus: HTMLElement;
  ovHint: HTMLElement;
  btnBack: HTMLButtonElement;
  tiles: HTMLElement;
  toasts: HTMLElement;
}

export function mount(root: HTMLElement): Refs {
  root.innerHTML = SHELL;
  document.documentElement.style.setProperty("--ov-pad", `${OV_PAD}px`);
  document.documentElement.style.setProperty("--ov-gap", `${OV_GAP}px`);

  return {
    shell: must("shell"),
    btnMin: must("btnMin"),
    btnClose: must("btnClose"),
    inName: must("inName"),
    inAddr: must("inAddr"),
    btnHost: must("btnHost"),
    btnHostFree: must("btnHostFree"),
    btnJoin: must("btnJoin"),
    homeErr: must("homeErr"),
    camSelect: must("camSelect"),
    camErr: must("camErr"),
    overlay: must("overlay"),
    ovBadge: must("ovBadge"),
    ovStatus: must("ovStatus"),
    ovHint: must("ovHint"),
    btnBack: must("btnBack"),
    tiles: must("tiles"),
    toasts: must("toasts"),
  };
}

export function createTile(id: string): Tile {
  const root = document.createElement("div");
  root.className = "tile";
  root.dataset.id = id;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;

  const mask = document.createElement("div");
  mask.className = "tile-mask";
  mask.innerHTML = "<span></span>";

  const info = document.createElement("div");
  info.className = "tile-info";
  const label = document.createElement("span");
  label.className = "tile-label";
  info.appendChild(label);

  root.appendChild(video);
  root.appendChild(mask);
  root.appendChild(info);

  return { root, video, mask, label };
}

export function toast(host: HTMLElement, text: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  host.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}
