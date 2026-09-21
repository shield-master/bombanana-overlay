import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Signal, type SignalHandlers } from "./net";
import { Mesh, type MeshHandlers } from "./rtc";
import { EFFECTS, ROLES, role, type RoleId } from "./roles";
import { createTile, mount, overlaySize, toast, type Refs, type Tile } from "./ui";

type Screen = "home" | "lobby" | "game";
type Phase = "lobby" | "game";

interface Player {
  id: string;
  name: string;
  role: RoleId | null;
}

const state = {
  screen: "home" as Screen,
  phase: "lobby" as Phase,
  round: 1,
  myId: "",
  hostId: "",
  name: "Обезьяна",
  players: [] as Player[],
  /** false — клики проваливаются в игру под оверлеем. */
  interactive: true,
};

let refs: Refs;
let signal: Signal | null = null;
let mesh: Mesh | null = null;
let hosting = false;
let lobbyAddr = "";
let peerOrder: string[] = [];
let overlayWidth = 0;

/** То, что реально уходит в сеть. Живёт весь сеанс, трек внутри подменяется. */
const outStream = new MediaStream();
const tiles = new Map<string, Tile>();
const streams = new Map<string, MediaStream>();
const conn = new Map<string, RTCPeerConnectionState>();

/** Только у хоста: он один решает, кому какая роль досталась. */
const roster = new Map<string, { name: string; role: RoleId | null }>();

const inTauri = "__TAURI_INTERNALS__" in window;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!inTauri) return null; // чтобы UI открывался и в обычном браузере
  return await invoke<T>(cmd, args);
}

const isHost = () => state.myId !== "" && state.myId === state.hostId;
const me = () => state.players.find((p) => p.id === state.myId) ?? null;
const myRole = () => me()?.role ?? null;
const myEffects = () => {
  const r = myRole();
  return r ? EFFECTS[r] : null;
};

// ---------------------------------------------------------------- камера

async function setCameraTrack(track: MediaStreamTrack) {
  for (const old of outStream.getVideoTracks()) {
    outStream.removeTrack(old);
    old.stop();
  }
  outStream.addTrack(track);
  refs.selfPreview.srcObject = outStream;
  void refs.selfPreview.play().catch(() => {});
  await mesh?.replaceVideo(track);
}

async function ensureCamera(deviceId?: string): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24 },
      },
      audio: false, // микрофона в этой игре нет принципиально
    });
    await setCameraTrack(stream.getVideoTracks()[0]);
    refs.camErr.hidden = true;
    await listCameras();
    // Свежий трек приходит с enabled = true — прогоняем эффекты роли заново,
    // иначе немая обезьяна заговорит, просто переключив камеру.
    render();
    return true;
  } catch (e) {
    const msg = `Камера недоступна: ${errText(e)}`;
    refs.camErr.hidden = false;
    refs.camErr.textContent = msg;
    refs.homeErr.hidden = false;
    refs.homeErr.textContent = msg;
    return false;
  }
}

async function listCameras() {
  // Имена устройств приходят только после выдачи доступа.
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  const current = outStream.getVideoTracks()[0]?.getSettings().deviceId ?? "";
  refs.camSelect.innerHTML = cams
    .map(
      (c, i) =>
        `<option value="${c.deviceId}"${c.deviceId === current ? " selected" : ""}>${
          c.label || `Камера ${i + 1}`
        }</option>`,
    )
    .join("");
  refs.camSelect.hidden = cams.length < 2;
}

function stopCamera() {
  for (const track of outStream.getVideoTracks()) {
    outStream.removeTrack(track);
    track.stop();
  }
}

// ---------------------------------------------------------------- сеть

const meshHandlers: MeshHandlers = {
  signal: (to, payload) => signal?.send({ k: "rtc", payload }, to),
  onStream: (from, stream) => {
    streams.set(from, stream);
    render();
  },
  onState: (from, st) => {
    conn.set(from, st);
    render();
  },
};

const handlers: SignalHandlers = {
  onHello(id, hostId) {
    state.myId = id;
    state.hostId = hostId;
    mesh = new Mesh(id, outStream, meshHandlers);
    if (isHost()) roster.set(id, { name: state.name, role: null });
    signal?.send({ k: "profile", name: state.name });
    render();
  },

  onPeers(peers, hostId) {
    state.hostId = hostId;
    peerOrder = peers;

    if (isHost()) {
      for (const id of peers) {
        if (!roster.has(id)) roster.set(id, { name: "Обезьяна", role: null });
      }
      for (const id of [...roster.keys()]) {
        if (!peers.includes(id)) roster.delete(id);
      }
      hostBroadcast();
    }

    void mesh?.sync(peers);
    for (const id of [...streams.keys()]) if (!peers.includes(id)) streams.delete(id);
    render();
  },

  onData(from, data) {
    if (!data || typeof data !== "object") return;
    switch (data.k) {
      case "profile":
        if (isHost()) {
          const entry = roster.get(from);
          if (entry) {
            entry.name = String(data.name ?? "Обезьяна").slice(0, 16);
            hostBroadcast();
          }
        }
        break;
      case "pick":
        if (isHost()) hostAssign(from, data.role ?? null);
        break;
      case "state":
        if (from !== state.hostId) return; // состояние принимаем только от хоста
        applyState(data);
        break;
      case "ping":
        if (myEffects()?.receivesPings === false) return; // глухая обезьяна
        showPing(from, String(data.emoji ?? "❓"));
        break;
      case "rtc":
        void mesh?.accept(from, data.payload);
        break;
    }
  },

  onClosed(reason) {
    void leave(reason);
  },
};

// ------------------------------------------------------- логика хоста

function hostBroadcast() {
  const players: Player[] = peerOrder
    .filter((id) => roster.has(id))
    .map((id) => ({ id, name: roster.get(id)!.name, role: roster.get(id)!.role }));

  const msg = { k: "state", phase: state.phase, round: state.round, players };
  signal?.send(msg);
  applyState(msg);
}

function hostAssign(id: string, wanted: RoleId | null) {
  const entry = roster.get(id);
  if (!entry) return;
  if (wanted !== null) {
    if (!ROLES.some((r) => r.id === wanted)) return;
    // Роль эксклюзивна: кто первый кликнул, того и тапки.
    for (const [otherId, other] of roster) {
      if (otherId !== id && other.role === wanted) return;
    }
  }
  entry.role = wanted;
  hostBroadcast();
}

function hostShuffle() {
  const ids = peerOrder.filter((id) => roster.has(id));
  const pool: (RoleId | null)[] = ROLES.map((r) => r.id);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  ids.forEach((id, i) => {
    roster.get(id)!.role = pool[i] ?? null;
  });
  hostBroadcast();
}

function canStart() {
  return state.players.length >= 2 && state.players.every((p) => p.role !== null);
}

function hostStart() {
  if (!isHost() || !canStart()) return;
  state.phase = "game";
  hostBroadcast();
}

function hostNewRound() {
  if (!isHost()) return;
  state.phase = "lobby";
  state.round += 1;
  for (const entry of roster.values()) entry.role = null;
  hostBroadcast();
}

// ---------------------------------------------------------------- экраны

function applyState(msg: any) {
  const wasPhase = state.phase;
  state.players = Array.isArray(msg.players) ? (msg.players as Player[]) : [];
  state.phase = msg.phase === "game" ? "game" : "lobby";
  state.round = Number(msg.round) || 1;

  const target: Screen = state.phase === "game" ? "game" : "lobby";
  if (state.screen !== target || wasPhase !== state.phase) void setScreen(target);
  render();
}

async function setScreen(next: Screen) {
  if (state.screen === next) return;
  state.screen = next;
  refs.shell.dataset.screen = next;

  if (next === "game") {
    const size = overlaySize(state.players.length);
    overlayWidth = size.width;
    await call("set_overlay", { on: true, ...size });
    // Как в Discord: по умолчанию мышь принадлежит игре, не оверлею.
    await call("set_clickthrough", { on: true }).catch(() => null);
  } else {
    overlayWidth = 0;
    await call("set_overlay", { on: false, width: 0, height: 0 }).catch(() => null);
    state.interactive = true;
    refs.shell.dataset.interactive = "true";
  }
  render();
}

async function startSession(mode: "host" | "join") {
  refs.homeErr.hidden = true;
  state.name = (refs.inName.value.trim() || "Обезьяна").slice(0, 16);
  localStorage.setItem("bombanana.name", state.name);

  if (!(await ensureCamera())) return;

  try {
    let url: string;
    if (mode === "host") {
      const port = Number(refs.inPort.value) || 47821;
      const info = await call<{ port: number; ip: string }>("host_start", { port });
      if (!info) throw new Error("Хост доступен только внутри приложения.");
      hosting = true;
      lobbyAddr = `${info.ip}:${info.port}`;
      url = `ws://127.0.0.1:${info.port}`;
    } else {
      const addr = refs.inAddr.value.trim();
      if (!addr) throw new Error("Введи адрес хоста, например 192.168.0.10:47821");
      lobbyAddr = addr.includes(":") ? addr : `${addr}:47821`;
      localStorage.setItem("bombanana.addr", lobbyAddr);
      url = `ws://${lobbyAddr}`;
    }

    signal = new Signal(handlers);
    await signal.connect(url);
    await setScreen("lobby");
  } catch (e) {
    await leave(errText(e));
  }
}

async function leave(reason?: string) {
  mesh?.close();
  mesh = null;
  signal?.close();
  signal = null;
  if (hosting) {
    await call("host_stop").catch(() => null);
    hosting = false;
  }
  stopCamera();

  for (const tile of tiles.values()) tile.root.remove();
  tiles.clear();
  streams.clear();
  conn.clear();
  roster.clear();
  peerOrder = [];
  state.players = [];
  state.phase = "lobby";
  state.myId = "";
  state.hostId = "";

  await setScreen("home");
  if (reason) {
    refs.homeErr.hidden = false;
    refs.homeErr.textContent = reason;
  }
  render();
}

// ---------------------------------------------------------------- действия

function pickRole(wanted: RoleId) {
  const next = myRole() === wanted ? null : wanted; // повторный клик снимает роль
  if (isHost()) hostAssign(state.myId, next);
  else signal?.send({ k: "pick", role: next }, state.hostId);
}

function sendPing(emoji: string) {
  signal?.send({ k: "ping", emoji });
  showPing(state.myId, emoji); // себе — как подтверждение отправки
}

function showPing(from: string, emoji: string) {
  const who = state.players.find((p) => p.id === from);
  toast(refs.toasts, `${emoji} ${who?.name ?? "?"}`);
}

// ---------------------------------------------------------------- отрисовка

function render() {
  renderLobby();
  renderRoles();
  renderOverlay();
  renderTiles();
  applyRoleEffects();
}

function renderLobby() {
  refs.addrLabel.textContent = hosting ? "Твой адрес — раздай его друзьям" : "Подключён к";
  refs.addrValue.textContent = lobbyAddr || "—";
  refs.playerCount.textContent = `${state.players.length}/3`;

  refs.players.innerHTML = state.players
    .map((p) => {
      const r = role(p.role);
      return `<li${p.id === state.myId ? ' class="mine"' : ""}>
        <span class="pname">${escapeHtml(p.name)}</span>
        ${p.id === state.hostId ? '<span class="ptag">хост</span>' : ""}
        <span class="grow"></span>
        <span class="prole">${r ? `${r.emoji} ${r.title}` : "выбирает…"}</span>
      </li>`;
    })
    .join("");

  const missing = 3 - state.players.length;
  refs.lobbyStatus.textContent = !canStart()
    ? missing > 0
      ? `Ждём ещё ${missing}, и чтобы все выбрали роль`
      : "Ждём, пока все выберут роль"
    : `Раунд ${state.round} — можно начинать`;

  refs.btnStart.hidden = !isHost();
  refs.btnStart.disabled = !canStart();
  refs.btnShuffle.hidden = !isHost();
}

function renderRoles() {
  const taken = new Map<RoleId, Player>();
  for (const p of state.players) if (p.role) taken.set(p.role, p);

  for (const el of refs.roles.querySelectorAll<HTMLElement>(".role")) {
    const id = el.dataset.role as RoleId;
    const holder = taken.get(id);
    const mine = holder?.id === state.myId;
    el.dataset.state = mine ? "mine" : holder ? "taken" : "free";
    (el.querySelector(".role-taken") as HTMLElement).textContent = mine
      ? "это ты"
      : (holder?.name ?? "свободна");
  }
}

function renderOverlay() {
  const r = role(myRole());
  refs.ovBadge.textContent = r ? `${r.emoji} ${r.title}` : `Раунд ${state.round}`;
  refs.btnRound.hidden = !isHost();
  refs.shell.dataset.interactive = String(state.interactive);

  const keys = refs.overlay.querySelector(".ov-keys") as HTMLElement;
  keys.textContent = state.interactive
    ? "Ctrl+Shift+O — отдать мышь игре"
    : "Ctrl+Shift+O — взять мышь";
}

function renderTiles() {
  if (state.screen !== "game") return;
  const eff = myEffects();

  for (const player of state.players) {
    let tile = tiles.get(player.id);
    if (!tile) {
      tile = createTile(player.id);
      tiles.set(player.id, tile);
      refs.tiles.appendChild(tile.root);
    }

    const mine = player.id === state.myId;
    const stream = mine ? outStream : (streams.get(player.id) ?? null);
    if (stream && tile.video.srcObject !== stream) {
      tile.video.srcObject = stream;
      void tile.video.play().catch(() => {});
    }

    // Меня ослепили -> гаснет всё. Его заткнули -> гаснет только он.
    const blinded = eff ? (mine ? !eff.seesSelf : !eff.seesOthers) : false;
    const silenced = player.role ? !EFFECTS[player.role].isSeen : false;
    const maskEmoji = blinded ? "🙈" : silenced && !mine ? "🙊" : "";
    tile.mask.hidden = maskEmoji === "";
    (tile.mask.firstElementChild as HTMLElement).textContent = maskEmoji;
    // Немая видит себя, но приглушённо — чтобы помнила, что наружу ничего не идёт.
    tile.root.dataset.self = String(mine);
    tile.root.dataset.selfMuted = String(silenced && mine && !blinded);

    const r = role(player.role);
    tile.label.textContent = `${r ? `${r.emoji} ` : ""}${player.name}${mine ? " · ты" : ""}`;
    tile.root.dataset.conn = mine ? "connected" : (conn.get(player.id) ?? "new");
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

  const size = overlaySize(state.players.length);
  if (size.width !== overlayWidth) {
    overlayWidth = size.width;
    void call("resize_overlay", size).catch(() => null);
  }
}

function applyRoleEffects() {
  const eff = myEffects();
  // Камеры «включаются» только с началом партии — до этого превью локальное.
  const broadcasting = state.phase === "game" && (!eff || eff.isSeen);
  mesh?.setOutgoingVideo(broadcasting);
  refs.previewOff.hidden = outStream.getVideoTracks().length > 0;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// ---------------------------------------------------------------- запуск

function wire() {
  const win = inTauri ? getCurrentWindow() : null;
  refs.btnMin.onclick = () => void win?.minimize();
  refs.btnClose.onclick = () => void win?.close();

  refs.btnHost.onclick = () => void startSession("host");
  refs.btnJoin.onclick = () => void startSession("join");
  refs.inAddr.onkeydown = (e) => {
    if (e.key === "Enter") void startSession("join");
  };

  refs.btnCopy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(lobbyAddr);
      refs.btnCopy.textContent = "Скопировано";
      setTimeout(() => (refs.btnCopy.textContent = "Копировать"), 1200);
    } catch {
      /* буфер недоступен — адрес и так на экране */
    }
  };

  refs.camSelect.onchange = () => void ensureCamera(refs.camSelect.value);
  refs.btnLeave.onclick = () => void leave();
  refs.btnBack.onclick = () => void leave();
  refs.btnStart.onclick = () => hostStart();
  refs.btnShuffle.onclick = () => hostShuffle();
  refs.btnRound.onclick = () => hostNewRound();

  refs.roles.onclick = (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".role");
    if (btn?.dataset.role) pickRole(btn.dataset.role as RoleId);
  };
  refs.pingbar.onclick = (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".ping");
    if (btn?.dataset.ping) sendPing(btn.dataset.ping);
  };

  // В оверлее контекстное меню вебвью только мешает.
  document.addEventListener("contextmenu", (e) => e.preventDefault());
}

async function boot() {
  refs = mount(document.getElementById("app")!);
  refs.inName.value = localStorage.getItem("bombanana.name") ?? "";
  refs.inAddr.value = localStorage.getItem("bombanana.addr") ?? "";
  wire();
  render();

  if (inTauri) {
    await listen<boolean>("overlay:clickthrough", (ev) => {
      state.interactive = !ev.payload;
      renderOverlay();
    });
  }
}

void boot();
