import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { mount, toast } from "./ui/dom";
import { renderUI } from "./ui/render";
import { Store } from "./state";
import { WindowManager } from "./window";
import { LocalCamera } from "./media/camera";
import { Signal, VideoMesh, generateRoomCode, normalizeRoomCode } from "./network";
import { watchGameState } from "./game/gameWatcher";
import type { MediaProvider, Player, RoomMode, Screen, Tile } from "./types";
import { isSeenByAnyone, type RoleId } from "./roles";

/** bombanana — обычная комната на троих; free — просто видеозвонок до 8 человек. */
const ROOM_CAPACITY: Record<RoomMode, number> = { bombanana: 3, free: 8 };

async function bootstrap() {
  const root = document.getElementById("app");
  if (!root) throw new Error("Root element #app not found");

  const refs = mount(root);
  const store = new Store();
  const win = new WindowManager();
  const camera = new LocalCamera();
  const tiles = new Map<string, Tile>();

  let signal: Signal | null = null;
  let mesh: VideoMesh | null = null;
  // На гостевой стороне ростер/sdp-ice могут прийти раньше, чем setupMesh()
  // успеет создать mesh (сеть/микрозадачи не гарантируют порядок onHello
  // относительно первого onPeers/onData) — без буфера такой сигнал молча
  // терялся бы без повтора, и у гостя навсегда не открывалась бы связь с кем-то.
  let pendingPeers: string[] | null = null;
  const pendingSignals: Array<{ from: string; data: any }> = [];

  // Видео реальных пиров и их состояние соединения — вне Store, это не сериализуемые данные.
  const remoteStreams = new Map<string, MediaStream>();
  const conn = new Map<string, RTCPeerConnectionState>();

  const media: MediaProvider = {
    streamFor(id) {
      if (id === store.current.myId) return camera.stream;
      return remoteStreams.get(id) ?? null;
    },
    connFor(id) {
      return conn.get(id);
    },
  };

  const isHost = () => store.current.myId !== "" && store.current.myId === store.current.hostId;

  // 2. Реактивное обновление UI
  let currentScreen: Screen | null = null;
  let overlayTileCount = 0;
  store.subscribe((state) => {
    renderUI(refs, state, tiles, media);
    applyRoleEffects();
    renderCode();

    if (state.screen !== currentScreen) {
      const enteringGame = state.screen === "game";
      const leavingGame = currentScreen === "game";
      currentScreen = state.screen;
      if (enteringGame) {
        overlayTileCount = state.players.length;
        void win.enterOverlay(overlayTileCount);
      } else if (leavingGame) {
        void win.exitOverlay();
      }
    } else if (state.screen === "game" && state.players.length !== overlayTileCount) {
      // Третий игрок подключился, пока оверлей уже открыт — подгоняем ширину под него.
      overlayTileCount = state.players.length;
      void win.fitOverlay(overlayTileCount);
    }
  });

  function applyRoleEffects() {
    const state = store.current;
    const me = state.players.find((p) => p.id === state.myId);
    // Камера транслируется всё время, пока мы в комнате. Роль могла
    // подставиться локально раньше, чем групповой раунд прошёл проверку
    // синхронизации (tryStartRound) — пока phase не "game", это ещё не
    // подтверждённый раунд, и роль (например "немая", которую по правилам
    // не видит вообще никто) не должна гасить трансляцию раньше времени.
    // В свободном лобби роли и раунды не применяются вообще никогда.
    const roundActive = state.roomMode === "bombanana" && state.phase === "game";
    const broadcasting = state.screen !== "home" && (!roundActive || isSeenByAnyone(me?.role ?? null));
    mesh?.setOutgoingVideo(broadcasting);
  }

  // 3. Системные кнопки окна Tauri
  refs.btnMin.onclick = () => win.minimize();
  refs.btnClose.onclick = () => win.close();

  // Отражаем переключение прокликов по хоткею Ctrl+Shift+O из Rust.
  await listen<boolean>("overlay:clickthrough", (ev) => {
    store.update({ interactive: !ev.payload });
  });

  // Живая синхронизация с самой игрой (Rust читает Player.log BOMBANANA) —
  // раунд стартует/заканчивается в оверлее сам, без ручных кнопок, а роль,
  // которую игра реально назначила этому клиенту, подставляется вместо
  // ручного клика по карточке. Сам момент старта не запускает фазу напрямую —
  // сначала репортим хосту (см. "Синхронизация старта раунда" ниже), чтобы
  // не поймать рассинхрон (двое в одной катке, третий — в другой).
  // Игра может быть запущена в фоне и во время свободного лобби (друзья просто
  // общаются, кто-то параллельно играет соло) — сигналы от неё тогда игнорируем,
  // роли/раунды не имеют смысла вне обычной комнаты BOMBANANA.
  let myGameLobbyId: string | null = null;
  const inBombanana = () => store.current.roomMode === "bombanana";

  void watchGameState({
    onRoundStart: (role) => {
      if (!inBombanana()) return;
      if (role) applyDetectedRole(role);
      reportRoundStart();
    },
    onRoundEnd: () => {
      if (!inBombanana()) return;
      endRound();
    },
    onLevel: (level) => {
      if (!inBombanana()) return;
      store.update({ level });
    },
    onLobby: (lobbyId) => {
      myGameLobbyId = lobbyId;
    },
  });

  // 4. Список камер — только для выбора, без превью и без раннего захвата потока.
  // Подписи устройств браузер отдаёт только после разрешения — если списка
  // ещё нет, коротко трогаем getUserMedia и сразу останавливаем трек.
  async function loadCameraList() {
    try {
      let devices = await camera.listDevices();
      if (devices.length > 0 && !devices[0].label) {
        try {
          const probe = await navigator.mediaDevices.getUserMedia({ video: true });
          probe.getTracks().forEach((t) => t.stop());
          devices = await camera.listDevices();
        } catch {
          // Разрешение не дали сейчас — покажем список без подписей, попробуем ещё раз при хосте/входе.
        }
      }
      refs.camSelect.innerHTML = devices
        .map((d, i) => `<option value="${d.deviceId}">${d.label || `Камера ${i + 1}`}</option>`)
        .join("");
      if (devices.length === 0) {
        refs.camErr.textContent = "Камеры не найдены";
        refs.camErr.hidden = false;
      }
    } catch {
      refs.camErr.textContent = "Не удалось получить список камер";
      refs.camErr.hidden = false;
    }
  }
  void loadCameraList();

  // Реальный захват камеры откладывается до клика по «Поднять лобби»/«Войти».
  async function initCamera() {
    if (camera.stream) return camera.stream;
    try {
      return await camera.start(refs.camSelect.value || undefined);
    } catch (e) {
      refs.camErr.textContent = "Ошибка доступа к камере";
      refs.camErr.hidden = false;
      return null;
    }
  }

  // Пиры получают КЛОН трека, а не сам трек камеры: если его приглушить (роль
  // «немая» или пауза до старта партии), это не должно чернить собственный превью.
  let outboundStream: MediaStream | null = null;
  let outboundTrack: MediaStreamTrack | null = null;

  // 5. Настройка WebRTC Mesh
  function setupMesh(selfId: string, stream: MediaStream) {
    outboundStream = new MediaStream();
    const track = stream.getVideoTracks()[0];
    if (track) {
      outboundTrack = track.clone();
      outboundStream.addTrack(outboundTrack);
    }

    mesh = new VideoMesh(selfId, outboundStream, {
      signal: (to, payload) => signal?.send(payload, to),
      onStream: (from, remoteStream) => {
        remoteStreams.set(from, remoteStream);
        store.touch();
      },
      onState: (from, state) => {
        const prev = conn.get(from);
        conn.set(from, state);
        store.touch();
        if (state === "failed" && prev !== "failed") {
          const name = store.current.players.find((p) => p.id === from)?.name ?? "Игрок";
          toast(refs.toasts, `${name}: не удалось соединить видео`);
        }
      },
    });

    // Догоняем то, что пришло раньше, чем mesh был готов принимать.
    if (pendingPeers) {
      void mesh.sync(pendingPeers);
      pendingPeers = null;
    }
    for (const { from, data } of pendingSignals.splice(0)) {
      void mesh.accept(from, data);
    }
  }

  // ---------------------------------------------------------- состояние хоста

  /** Только хост зовёт: рассылает всем актуальный снимок состояния. */
  function hostSync() {
    if (!isHost()) return;
    const s = store.current;
    signal?.send({
      type: "state_sync",
      phase: s.phase,
      round: s.round,
      players: s.players,
      roomMode: s.roomMode,
    });
  }

  /** Применяет снимок состояния, присланный хостом. Экран (screen) сюда не входит —
   * каждый клиент сам переходит в "game" сразу при подключении (см. onHello). */
  function applyStateSync(data: any) {
    const players: Player[] = Array.isArray(data.players) ? data.players : [];
    const phase = data.phase === "game" ? "game" : "lobby";
    const round = Number(data.round) || 1;
    const roomMode: RoomMode = data.roomMode === "free" ? "free" : "bombanana";
    store.update({ players, phase, round, roomMode });
  }

  /** Хост эксклюзивно назначает роль: кто первый выбрал — тому и досталась. */
  function applyRolePick(id: string, wanted: RoleId | null) {
    if (!isHost()) return;
    const current = store.current.players;
    if (wanted !== null) {
      const conflict = current.some((p) => p.id !== id && p.role === wanted);
      if (conflict) return;
    }
    const updated = current.map((p) => (p.id === id ? { ...p, role: wanted } : p));
    store.update({ players: updated });
    hostSync();
  }

  /** Просит выставить роль "мне" — сам решает, применить локально (хост) или послать хосту (гость). */
  function requestRolePick(wanted: RoleId | null) {
    const s = store.current;
    if (isHost()) applyRolePick(s.myId, wanted);
    else signal?.send({ type: "role_pick", role: wanted }, s.hostId);
  }

  /** Роль, которую реальная игра назначила этому клиенту — приходит из watchGameState. */
  function applyDetectedRole(role: RoleId) {
    const mine = store.current.players.find((p) => p.id === store.current.myId);
    if (mine?.role === role) return;
    requestRolePick(role);
  }

  // Вспомогательная функция выхода из лобби
  function leaveLobby() {
    if (signal) {
      signal.close();
      signal = null;
    }
    if (mesh) {
      mesh.destroy();
      mesh = null;
    }
    camera.stop();
    outboundTrack?.stop();
    outboundTrack = null;
    outboundStream = null;
    for (const tile of tiles.values()) tile.root.remove();
    tiles.clear();
    remoteStreams.clear();
    conn.clear();

    store.update({
      screen: "home",
      phase: "lobby",
      players: [],
      myId: "",
      hostId: "",
      round: 1,
      roomCode: "",
      level: null,
      roomMode: "bombanana",
    });
    codeRevealed = false;
    codeClicks = 0;
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    roundReports.clear();
    myGameLobbyId = null;
    pendingPeers = null;
    pendingSignals.length = 0;
  }

  function handlePeers(peers: string[], hostId: string) {
    if (mesh) void mesh.sync(peers);
    else pendingPeers = peers;
    store.update({ hostId });

    if (isHost()) {
      const capacity = ROOM_CAPACITY[store.current.roomMode];
      const current = store.current.players;
      const keep = current.filter((p) => peers.includes(p.id));
      const newcomers = peers.filter((pid) => !current.some((p) => p.id === pid));
      const room = Math.max(0, capacity - keep.length);
      const admitted = newcomers.slice(0, room);
      const rejected = newcomers.slice(room);

      const added = admitted.map((pid) => ({
        id: pid,
        name: pid === store.current.myId ? store.current.name : `Игрок ${pid}`,
        role: null,
      }));
      store.update({ players: [...keep, ...added] });
      hostSync();

      for (const pid of rejected) {
        signal?.kick(pid, `Лобби заполнено (макс. ${capacity} чел.)`);
      }
    }

    for (const id of [...remoteStreams.keys()]) if (!peers.includes(id)) remoteStreams.delete(id);
  }

  function handleData(from: string, data: any) {
    // mesh.accept() сам open()-ит запись о P2P-соединении при первом вызове —
    // нельзя звать его для ЛЮБОГО сообщения (profile/role_pick/round_ready/
    // state_sync тоже сюда прилетают), иначе это создаёт "пустую" запись в
    // VideoMesh.peers ДО настоящего SDP-оффера, и mesh.sync() потом решает,
    // что соединение уже есть, и не шлёт оффер вообще — камера так и не подключается.
    if (data?.kind === "sdp" || data?.kind === "ice") {
      if (mesh) void mesh.accept(from, data);
      else pendingSignals.push({ from, data });
    }
    if (!data || typeof data !== "object") return;

    switch (data.type) {
      case "profile": {
        if (!isHost()) break;
        const current = store.current.players;
        const name = String(data.name ?? "Обезьяна").slice(0, 16);
        const exists = current.some((p) => p.id === from);
        const updated = exists
          ? current.map((p) => (p.id === from ? { ...p, name } : p))
          : [...current, { id: from, name, role: null }];
        store.update({ players: updated });
        hostSync();
        break;
      }
      case "role_pick":
        if (isHost()) applyRolePick(from, data.role ?? null);
        break;
      case "round_ready":
        if (isHost()) reportRoundReady(from, data.lobbyId ?? null);
        break;
      case "state_sync":
        if (from === store.current.hostId) applyStateSync(data);
        break;
    }
  }

  // ---------------------------------------------------------- надёжность соединения

  /** Общие для host()/join() колбэки восстановления связи — просто тосты, без обрыва сессии. */
  function reconnectionHandlers() {
    return {
      onReconnecting: () => toast(refs.toasts, "Связь прервалась — переподключаюсь…"),
      onReconnected: () => toast(refs.toasts, "Связь восстановлена"),
      onPeerReconnecting: (peerId: string) => {
        const name = store.current.players.find((p) => p.id === peerId)?.name ?? "Игрок";
        toast(refs.toasts, `${name}: связь прервалась, ждём…`);
      },
      onPeerReconnected: (peerId: string) => {
        const name = store.current.players.find((p) => p.id === peerId)?.name ?? "Игрок";
        toast(refs.toasts, `${name} вернулся`);
      },
    };
  }

  // ---------------------------------------------------------- код комнаты

  // По умолчанию код спрятан звёздочками (кто-то может подглядывать в стрим),
  // но скопировать его можно кликом в любом виде. Полностью показать — 5 кликов
  // подряд с анимацией "треска льда", и через 5 секунд он сам снова прячется.
  let codeRevealed = false;
  let codeClicks = 0;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function maskCode(code: string): string {
    return code.replace(/[^-]/g, "*");
  }

  function renderCode() {
    const code = store.current.roomCode;
    refs.ovBadge.disabled = !code;
    refs.ovBadge.textContent = !code ? "—" : codeRevealed ? code : maskCode(code);
  }

  function rehideCode() {
    codeRevealed = false;
    codeClicks = 0;
    hideTimer = null;
    renderCode();
  }

  refs.ovBadge.onclick = () => {
    const code = store.current.roomCode;
    if (!code) return;

    navigator.clipboard.writeText(code);
    toast(refs.toasts, "Код скопирован!");

    if (codeRevealed) return;

    codeClicks++;
    if (codeClicks >= 5) {
      refs.ovBadge.classList.add("cracking");
      setTimeout(() => {
        refs.ovBadge.classList.remove("cracking");
        codeRevealed = true;
        renderCode();
        if (hideTimer !== null) clearTimeout(hideTimer);
        hideTimer = setTimeout(rehideCode, 5000);
      }, 360);
    }
  };

  // 6. Создать лобби (Хост) — общий флоу и для обычной комнаты BOMBANANA,
  // и для свободного лобби (кнопка-сабкарточка на главном экране).
  async function hostFlow(mode: RoomMode) {
    refs.homeErr.hidden = true;
    const name = (refs.inName.value.trim() || "Обезьяна").slice(0, 16);
    // Повторный клик после неудачи не должен плодить зомби-Peer'ов на брокере.
    signal?.close();
    signal = null;

    try {
      const stream = await initCamera();
      if (!stream) return;

      // Код мог случайно совпасть с чужой активной комнатой на брокере — пробуем ещё раз.
      let code = generateRoomCode();
      for (let attempt = 0; ; attempt++) {
        signal = new Signal({
          onHello: (id) => {
            store.update({
              myId: id,
              hostId: id,
              name,
              screen: "game",
              roomCode: code,
              roomMode: mode,
              players: [{ id, name, role: null }],
            });
            setupMesh(id, stream);
          },
          onPeers: handlePeers,
          onData: handleData,
          onClosed: (reason) => {
            toast(refs.toasts, reason);
            leaveLobby();
          },
          ...reconnectionHandlers(),
        });

        try {
          await signal.host(code);
          break;
        } catch (err: any) {
          const takenAgain = String(err?.message ?? "").includes("занят");
          if (takenAgain && attempt < 3) {
            code = generateRoomCode();
            continue;
          }
          throw err;
        }
      }
    } catch (err: any) {
      console.error("Failed to host:", err);
      refs.homeErr.textContent = typeof err === "string" ? err : err.message || "Не удалось создать лобби";
      refs.homeErr.hidden = false;
    }
  }

  refs.btnHost.onclick = () => void hostFlow("bombanana");
  refs.btnHostFree.onclick = () => void hostFlow("free");

  // 7. Подключиться к лобби (Клиент)
  refs.btnJoin.onclick = async () => {
    refs.homeErr.hidden = true;
    const codeInput = refs.inAddr.value.trim();
    const name = (refs.inName.value.trim() || "Обезьяна").slice(0, 16);

    const code = normalizeRoomCode(codeInput);
    if (!code) {
      refs.homeErr.textContent = "Укажи код комнаты";
      refs.homeErr.hidden = false;
      return;
    }
    signal?.close();
    signal = null;

    try {
      const stream = await initCamera();
      if (!stream) return;

      signal = new Signal({
        onHello: (id, hostId) => {
          store.update({
            myId: id,
            hostId,
            name,
            screen: "game",
            roomCode: code,
            players: [{ id, name, role: null }],
          });
          setupMesh(id, stream);
          signal?.send({ type: "profile", name }, hostId);
        },
        onPeers: handlePeers,
        onData: handleData,
        onClosed: (reason) => {
          toast(refs.toasts, reason);
          leaveLobby();
        },
        ...reconnectionHandlers(),
      });

      await signal.join(code);
    } catch (err: any) {
      console.error("Failed to join:", err);
      refs.homeErr.textContent = typeof err === "string" ? err : err.message || "Не удалось подключиться";
      refs.homeErr.hidden = false;
    }
  };

  // ---------------------------------------------------------- синхронизация старта раунда
  //
  // Раунд не может начаться вдвоём/одному — нужно ровно трое в комнате.
  // Мало этого: каждый клиент видит СВОЙ локальный Player.log, и теоретически
  // двое могут договориться и зайти в свою катку, а третий по ошибке запустить
  // отдельную сессию — тогда у всех троих локально "раунд начался", но не в
  // одной игре. Поэтому старт не триггерится напрямую из watchGameState —
  // каждый клиент репортит хосту детект старта (+ свой Steam lobbyId, если
  // игра его раскрыла), а хост стартует раунд, только когда отчиталось ровно
  // столько игроков, сколько сейчас в комнате, все отчёты пришли плотно по
  // времени, и если у кого-то есть настоящий lobbyId — они все совпадают.
  const ROUND_SYNC_WINDOW_MS = 8000;
  const roundReports = new Map<string, { at: number; lobbyId: string | null }>();

  function reportRoundStart() {
    const s = store.current;
    if (isHost()) reportRoundReady(s.myId, myGameLobbyId);
    else signal?.send({ type: "round_ready", lobbyId: myGameLobbyId }, s.hostId);
  }

  function reportRoundReady(playerId: string, lobbyId: string | null) {
    if (!isHost()) return;
    roundReports.set(playerId, { at: Date.now(), lobbyId });
    tryStartRound();
  }

  function tryStartRound() {
    if (!isHost() || store.current.phase === "game") return;
    const players = store.current.players;
    if (players.length < 3) return; // нельзя начать вдвоём/одному

    const reports = players.map((p) => roundReports.get(p.id));
    if (reports.some((r) => !r)) return; // ещё не все отчитались

    const times = reports.map((r) => r!.at);
    if (Math.max(...times) - Math.min(...times) > ROUND_SYNC_WINDOW_MS) return; // разнесены по времени — не похоже на общий старт

    const lobbyIds = reports.map((r) => r!.lobbyId).filter((id): id is string => id !== null);
    if (lobbyIds.length >= 2 && !lobbyIds.every((id) => id === lobbyIds[0])) {
      toast(refs.toasts, "Похоже, вы не в одной катке BOMBANANA — раунд не запущен");
      roundReports.clear();
      return;
    }

    startRound();
  }

  // 10. Начать раунд — хост-only, вызывается только из tryStartRound() после
  // проверки, что все трое реально стартовали вместе. Оверлей уже открыт с
  // момента входа в комнату — тут только фаза, которая включает ролевую
  // фильтрацию у всех.
  function startRound() {
    if (!isHost()) return;
    store.update({ phase: "game" });
    hostSync();
  }

  // 11. Раунд закончился — хост-only, триггерится автоматически на
  // CleaningMission/LoadingReport из watchGameState. Оверлей не закрываем —
  // сбрасываем роли в null и все снова видят всех без фильтров, как в
  // обычном видеозвонке, пока не начнётся следующий раунд.
  function endRound() {
    if (!isHost()) return;
    const resetPlayers = store.current.players.map((p) => ({ ...p, role: null }));
    store.update({
      players: resetPlayers,
      phase: "lobby",
      round: store.current.round + 1,
      level: null,
    });
    roundReports.clear();
    hostSync();
  }

  // 12. Выйти из комнаты
  refs.btnBack.onclick = () => void leaveLobby();

  // В оверлее контекстное меню вебвью только мешает, а вот в текстовых полях
  // (имя, код комнаты) оно нужно — иначе вставить код можно только Ctrl+V.
  document.addEventListener("contextmenu", (e) => {
    const el = e.target as HTMLElement | null;
    const editable = el?.closest("input, textarea, [contenteditable='true']");
    if (!editable) e.preventDefault();
  });
}

bootstrap().catch(console.error);
