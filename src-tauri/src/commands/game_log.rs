/**
 * Живое слежение за Player.log самой игры BOMBANANA (Unity), чтобы синхронизировать
 * оверлей с реальным состоянием партии — без ручных кнопок "начать/закончить раунд"
 * и без ручного выбора роли.
 *
 * Два независимых сигнала в логе, оба ведут к одному событию `bombanana-round`:
 *
 * 1. FMOD-снапшоты локального игрока — подтверждено вживую (сольный быстрый старт,
 *    без настоящего Steam-лобби, роль=Немая):
 *      [FmodSoundManager] Mute snapshot START (snapshot:/Mute)
 *    идёт прямо перед стеком Bombanana.MissionVoiceGate:ApplyRole(PlayerRole) <-
 *    Bombanana.PlayerBase:ApplyLocalOwnerSetup() — то есть это МОМЕНТ применения
 *    роли локальному игроку, и снапшот называется точно как роль (Blind/Deaf/Mute).
 *    Возврат в лобби всегда лочит:
 *      [FmodSoundManager] Lobby snapshot START (snapshot:/Lobby)
 *    — воспроизведено дважды в одном логе (до и после раунда), надёжный маркер
 *    "раунда больше нет" независимо от того, как был начат заход (быстрый старт,
 *    честное Steam-лобби, QuickPlay).
 *
 * 2. Строка статуса лобби (видна только при хостинге через настоящее Steam-лобби,
 *    в сольном быстром старте не появляется вовсе — поэтому это не единственный
 *    источник):
 *      [Lobby] Lobby status published: InLobby (state=Lobby).
 *      [Lobby] Lobby status published: InGame (state=LeavingLobby).
 *    `state` — значение внутреннего enum GameState игры (снят статически из
 *    BOMBANANA_Data/il2cpp_data/Metadata/global-metadata.dat, нигде не
 *    документирован): Lobby, Launch, LeavingLobby, LoadingMap, LoadingMission,
 *    CleaningMission, LoadingReport, LeavingToMenu, LeavingToLobby.
 *    LoadingMission — раунд начинается; CleaningMission/LoadingReport — закончился.
 *
 * Отдельно — номер уровня кампании (1-30), тоже подтверждён вживую:
 *   [SteamCampaignProgress] Campaign level enter | UI=14 missionId=13 enterCount=1
 * `UI` — тот самый номер, что игра показывает игроку (missionId — тот же индекс,
 * но с нуля). Строка шлётся ClientRpc-broadcast'ом всем игрокам разом
 * (SteamCampaignProgress:OnLobbyMissionStartCommitted <- LobbyHandler:
 * NotifyMissionEnterAchievementsClientRpc), так что видна у каждого клиента.
 *
 * И отдельно — реальный Steam Lobby ID, подтверждён вживую (дважды, гость обоих
 * раз): [Lobby] Lobby entered (lobbyId=109775242341297566, isHost=False); proceeding
 * with connection flow. Нужен, чтобы отличить "все трое реально в одной Steam-катке"
 * от случая, когда двое договорились и зашли вместе, а третий по ошибке запустил
 * свою отдельную сессию — у каждого приложения будет свой Player.log с ЭТИМ клиентом
 * внутри, но lobbyId выдаст, что это разные катки. В captured логах видели только
 * isHost=False (играли по приглашению) — ветка isHost=True разобрана по тому же
 * формату строки, живьём пока не подтверждена.
 */
use notify::{Event, RecursiveMode, Watcher};
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Низкоуровневый passthrough сырых переходов GameState — пригодится для диагностики.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameStateEvent {
    pub state: String,
    pub status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RoundKind {
    Start,
    End,
}

/// Основной сигнал для фронтенда: раунд начался/закончился, и если начался —
/// по возможности роль, которую игра назначила ЭТОМУ клиенту.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundEvent {
    pub kind: RoundKind,
    pub role: Option<String>,
}

/// Номер уровня кампании (1-30), пришедший из "Campaign level enter | UI=<N> ...".
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelEvent {
    pub level: u32,
}

/// Реальный Steam Lobby ID из "Lobby entered (lobbyId=<N>, isHost=<bool>)".
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyEvent {
    pub lobby_id: String,
    pub is_host: bool,
}

const STATE_EVENT_NAME: &str = "bombanana-game-state";
const ROUND_EVENT_NAME: &str = "bombanana-round";
const LEVEL_EVENT_NAME: &str = "bombanana-level";
const LOBBY_EVENT_NAME: &str = "bombanana-lobby";
const STATUS_MARKER: &str = "Lobby status published: ";
const LEVEL_MARKER: &str = "Campaign level enter | UI=";
const LOBBY_MARKER: &str = "Lobby entered (lobbyId=";

fn player_log_path() -> Option<PathBuf> {
    let local_appdata = std::env::var_os("LOCALAPPDATA")?;
    let mut path = PathBuf::from(local_appdata);
    path.pop(); // .../AppData/Local -> .../AppData
    path.push("LocalLow");
    path.push("Lefto Studio");
    path.push("BOMBANANA");
    path.push("Player.log");
    Some(path)
}

/// "[Lobby] Lobby status published: InLobby (state=Lobby)." -> { status: "InLobby", state: "Lobby" }
fn parse_state_line(line: &str) -> Option<GameStateEvent> {
    let idx = line.find(STATUS_MARKER)?;
    let rest = &line[idx + STATUS_MARKER.len()..];
    let (status, rest) = rest.split_once(" (state=")?;
    let state = rest.strip_suffix(").")?;
    Some(GameStateEvent { state: state.to_string(), status: status.to_string() })
}

fn state_to_round_event(state: &str) -> Option<RoundEvent> {
    match state {
        "LoadingMission" => Some(RoundEvent { kind: RoundKind::Start, role: None }),
        "CleaningMission" | "LoadingReport" => Some(RoundEvent { kind: RoundKind::End, role: None }),
        _ => None,
    }
}

/// FMOD-снапшот локального игрока: "Blind"/"Deaf"/"Mute" snapshot START = роль
/// только что назначена; "Lobby" snapshot START = вернулись в меню, раунда нет.
fn parse_snapshot_line(line: &str) -> Option<RoundEvent> {
    if line.contains("] Lobby snapshot START") {
        return Some(RoundEvent { kind: RoundKind::End, role: None });
    }
    const ROLE_SNAPSHOTS: [(&str, &str); 3] = [
        ("] Blind snapshot START (snapshot:/Blind)", "blind"),
        ("] Deaf snapshot START (snapshot:/Deaf)", "deaf"),
        ("] Mute snapshot START (snapshot:/Mute)", "mute"),
    ];
    for (marker, role) in ROLE_SNAPSHOTS {
        if line.contains(marker) {
            return Some(RoundEvent { kind: RoundKind::Start, role: Some(role.to_string()) });
        }
    }
    None
}

/// "[SteamCampaignProgress] Campaign level enter | UI=14 missionId=13 enterCount=1" -> 14
fn parse_level_line(line: &str) -> Option<LevelEvent> {
    let idx = line.find(LEVEL_MARKER)?;
    let rest = &line[idx + LEVEL_MARKER.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let level: u32 = digits.parse().ok()?;
    Some(LevelEvent { level })
}

/// "[Lobby] Lobby entered (lobbyId=109775242341297566, isHost=False); ..." ->
/// { lobbyId: "109775242341297566", isHost: false }
fn parse_lobby_line(line: &str) -> Option<LobbyEvent> {
    let idx = line.find(LOBBY_MARKER)?;
    let rest = &line[idx + LOBBY_MARKER.len()..];
    let comma = rest.find(',')?;
    let lobby_id = rest[..comma].trim().to_string();
    if lobby_id.is_empty() || !lobby_id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let is_host = rest.contains("isHost=True");
    Some(LobbyEvent { lobby_id, is_host })
}

/// Ждёт появления каталога с логами — игра может быть ещё не запущена ни разу.
fn wait_for_watchable_dir(watcher: &mut notify::RecommendedWatcher, dir: &std::path::Path) {
    loop {
        if dir.exists() && watcher.watch(dir, RecursiveMode::NonRecursive).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn handle_line(app: &AppHandle, line: &str) {
    if let Some(ev) = parse_state_line(line) {
        let round_ev = state_to_round_event(&ev.state);
        let _ = app.emit(STATE_EVENT_NAME, ev);
        if let Some(round_ev) = round_ev {
            let _ = app.emit(ROUND_EVENT_NAME, round_ev);
        }
        return;
    }
    if let Some(round_ev) = parse_snapshot_line(line) {
        let _ = app.emit(ROUND_EVENT_NAME, round_ev);
        return;
    }
    if let Some(level_ev) = parse_level_line(line) {
        let _ = app.emit(LEVEL_EVENT_NAME, level_ev);
        return;
    }
    if let Some(lobby_ev) = parse_lobby_line(line) {
        let _ = app.emit(LOBBY_EVENT_NAME, lobby_ev);
    }
}

fn watch_loop(app: AppHandle, path: PathBuf) {
    let Some(dir) = path.parent().map(|p| p.to_path_buf()) else { return };

    let (tx, rx) = channel::<notify::Result<Event>>();
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[game_log] Не удалось создать наблюдатель за Player.log: {e}");
            return;
        }
    };
    wait_for_watchable_dir(&mut watcher, &dir);

    // Следим только за новыми строками с момента запуска нашего приложения —
    // старые раунды из прошлых сессий игры нас не интересуют.
    let mut offset: u64 = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut leftover = String::new();

    loop {
        // Таймаут или чужое событие каталога — на всякий случай тоже проверяем файл,
        // не полагаясь только на события ФС (у ReadDirectoryChangesW бывают пропуски).
        let _ = rx.recv_timeout(Duration::from_secs(2));

        let Ok(mut file) = std::fs::File::open(&path) else { continue };
        let Ok(meta) = file.metadata() else { continue };
        let len = meta.len();

        if len < offset {
            // Player.log пересоздан (новый запуск BOMBANANA) — читаем заново с начала.
            offset = 0;
            leftover.clear();
        }
        if len == offset {
            continue;
        }

        if file.seek(SeekFrom::Start(offset)).is_err() {
            continue;
        }
        let mut buf = Vec::new();
        if file.read_to_end(&mut buf).is_err() {
            continue;
        }
        offset = len;

        leftover.push_str(&String::from_utf8_lossy(&buf));
        while let Some(pos) = leftover.find('\n') {
            let line = leftover[..pos].trim_end_matches('\r').to_string();
            leftover.drain(..=pos);
            handle_line(&app, &line);
        }
    }
}

static WATCHER_STARTED: OnceLock<()> = OnceLock::new();

/// Запускает фоновый поток слежения ровно один раз за жизнь процесса.
pub fn spawn_game_watcher(app: AppHandle) {
    if WATCHER_STARTED.set(()).is_err() {
        return;
    }
    std::thread::spawn(move || {
        let Some(path) = player_log_path() else {
            eprintln!("[game_log] Не удалось определить путь к Player.log (нет LOCALAPPDATA)");
            return;
        };
        watch_loop(app, path);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_lobby_status_lines() {
        let ev = parse_state_line("[Lobby] Lobby status published: InLobby (state=Lobby).").unwrap();
        assert_eq!(ev.status, "InLobby");
        assert_eq!(ev.state, "Lobby");

        let ev = parse_state_line("[Lobby] Lobby status published: InGame (state=LeavingLobby).").unwrap();
        assert_eq!(ev.status, "InGame");
        assert_eq!(ev.state, "LeavingLobby");
    }

    #[test]
    fn maps_mission_states_to_round_events() {
        assert!(matches!(
            state_to_round_event("LoadingMission"),
            Some(RoundEvent { kind: RoundKind::Start, role: None })
        ));
        assert!(matches!(
            state_to_round_event("CleaningMission"),
            Some(RoundEvent { kind: RoundKind::End, role: None })
        ));
        assert!(matches!(
            state_to_round_event("LoadingReport"),
            Some(RoundEvent { kind: RoundKind::End, role: None })
        ));
        assert!(state_to_round_event("Lobby").is_none());
    }

    #[test]
    fn parses_real_role_snapshot_line() {
        // Реальная строка из живого лога — соло-заход, роль "Немая" (Mute).
        let ev = parse_snapshot_line("[FmodSoundManager] Mute snapshot START (snapshot:/Mute)").unwrap();
        assert!(matches!(ev.kind, RoundKind::Start));
        assert_eq!(ev.role.as_deref(), Some("mute"));
    }

    #[test]
    fn parses_all_role_snapshots() {
        let ev = parse_snapshot_line("[FmodSoundManager] Blind snapshot START (snapshot:/Blind)").unwrap();
        assert_eq!(ev.role.as_deref(), Some("blind"));

        let ev = parse_snapshot_line("[FmodSoundManager] Deaf snapshot START (snapshot:/Deaf)").unwrap();
        assert_eq!(ev.role.as_deref(), Some("deaf"));
    }

    #[test]
    fn parses_real_lobby_snapshot_as_round_end() {
        let ev = parse_snapshot_line("[FmodSoundManager] Lobby snapshot START (snapshot:/Lobby)").unwrap();
        assert!(matches!(ev.kind, RoundKind::End));
        assert!(ev.role.is_none());
    }

    #[test]
    fn parses_real_campaign_level_line() {
        // Реальная строка из живого лога — уровень 14 (missionId с нуля).
        let ev = parse_level_line("[SteamCampaignProgress] Campaign level enter | UI=14 missionId=13 enterCount=1").unwrap();
        assert_eq!(ev.level, 14);

        assert!(parse_level_line("[SteamCampaignProgress] Push (startup-sync) | levels=0").is_none());
    }

    #[test]
    fn ignores_unrelated_lines() {
        assert!(parse_state_line("[SteamManager] Steam Client has been initialized!").is_none());
        assert!(parse_snapshot_line("[FmodSoundManager] Mute snapshot STOP").is_none());
        assert!(parse_snapshot_line("1/3 игроков").is_none());
        assert!(parse_state_line("").is_none());
        assert!(parse_lobby_line("[Lobby] Steam invite received from 'Razz' (lobbyId=109775242340330340).").is_none());
    }

    #[test]
    fn parses_real_lobby_entered_line() {
        // Реальная строка из живого лога — гостевой вход по приглашению.
        let ev = parse_lobby_line(
            "[Lobby] Lobby entered (lobbyId=109775242341297566, isHost=False); proceeding with connection flow.",
        )
        .unwrap();
        assert_eq!(ev.lobby_id, "109775242341297566");
        assert!(!ev.is_host);
    }

    #[test]
    fn parses_host_lobby_entered_line() {
        // Тот же формат строки для хоста — живьём не захвачено, но парсер симметричен.
        let ev = parse_lobby_line(
            "[Lobby] Lobby entered (lobbyId=109775242340279905, isHost=True); proceeding with connection flow.",
        )
        .unwrap();
        assert_eq!(ev.lobby_id, "109775242340279905");
        assert!(ev.is_host);
    }

    #[test]
    fn builds_localrow_path() {
        // LOCALAPPDATA -> .../AppData/Local, LocalLow -> .../AppData/LocalLow
        std::env::set_var("LOCALAPPDATA", r"C:\Users\test\AppData\Local");
        let path = player_log_path().unwrap();
        assert_eq!(
            path,
            PathBuf::from(r"C:\Users\test\AppData\LocalLow\Lefto Studio\BOMBANANA\Player.log")
        );
    }
}
