mod signaling;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const LOBBY_W: f64 = 980.0;
const LOBBY_H: f64 = 680.0;
const OVERLAY_MARGIN: f64 = 24.0;

#[derive(Default)]
struct AppState {
    server: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// True once the window has been turned into the in-game overlay.
    overlay: AtomicBool,
    /// True while clicks pass straight through to the game underneath.
    clickthrough: AtomicBool,
}

#[derive(Serialize)]
struct HostInfo {
    port: u16,
    ip: String,
}

/// Picks the address the OS would use to reach the outside world, which is the
/// one the other two players need. No packet is sent; connecting a UDP socket
/// only selects a route.
fn detect_lan_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|sock| {
            sock.connect("8.8.8.8:80")?;
            sock.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

#[tauri::command]
fn lan_ip() -> String {
    detect_lan_ip()
}

#[tauri::command]
async fn host_start(port: u16, state: State<'_, AppState>) -> Result<HostInfo, String> {
    if state.server.lock().unwrap().is_some() {
        return Err("Лобби уже запущено".into());
    }
    let (bound, task) = signaling::serve(port)
        .await
        .map_err(|e| format!("Не удалось занять порт {port}: {e}"))?;
    *state.server.lock().unwrap() = Some(task);
    Ok(HostInfo { port: bound, ip: detect_lan_ip() })
}

#[tauri::command]
fn host_stop(state: State<'_, AppState>) {
    if let Some(task) = state.server.lock().unwrap().take() {
        task.abort();
    }
}

#[tauri::command]
fn set_overlay(
    on: bool,
    width: f64,
    height: f64,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let err = |e: tauri::Error| e.to_string();

    if on {
        window.set_resizable(false).map_err(err)?;
        window.set_always_on_top(true).map_err(err)?;
        window.set_size(LogicalSize::new(width, height)).map_err(err)?;
        // Park it in the top-right corner of whatever monitor we are on.
        if let Ok(Some(monitor)) = window.current_monitor() {
            let scale = monitor.scale_factor();
            let size = monitor.size().to_logical::<f64>(scale);
            let origin = monitor.position().to_logical::<f64>(scale);
            window
                .set_position(LogicalPosition::new(
                    origin.x + size.width - width - OVERLAY_MARGIN,
                    origin.y + OVERLAY_MARGIN * 2.0,
                ))
                .map_err(err)?;
        }
        state.overlay.store(true, Ordering::Relaxed);
    } else {
        state.overlay.store(false, Ordering::Relaxed);
        state.clickthrough.store(false, Ordering::Relaxed);
        // Окно могли спрятать по Ctrl+Shift+H — иначе лобби вернётся в никуда.
        window.show().map_err(err)?;
        window.set_ignore_cursor_events(false).map_err(err)?;
        window.set_always_on_top(false).map_err(err)?;
        window.set_resizable(true).map_err(err)?;
        window.set_size(LogicalSize::new(LOBBY_W, LOBBY_H)).map_err(err)?;
        window.center().map_err(err)?;
        window.set_focus().map_err(err)?;
    }
    Ok(())
}

/// Resizes the overlay in place (tile count changes when a player joins or leaves).
#[tauri::command]
fn resize_overlay(width: f64, height: f64, window: WebviewWindow) -> Result<(), String> {
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_clickthrough(on: bool, window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    apply_clickthrough(&window, &state, on).map_err(|e| e.to_string())
}

fn apply_clickthrough(
    window: &WebviewWindow,
    state: &AppState,
    on: bool,
) -> tauri::Result<()> {
    state.clickthrough.store(on, Ordering::Relaxed);
    window.set_ignore_cursor_events(on)?;
    if !on {
        let _ = window.set_focus();
    }
    // Let the UI grey itself out while clicks are passing through.
    let _ = window.emit("overlay:clickthrough", on);
    Ok(())
}

fn on_hotkey(app: &AppHandle, code: Code) {
    let Some(window) = app.get_webview_window("main") else { return };
    let state = app.state::<AppState>();

    match code {
        // Ctrl+Shift+O: grab the overlay to move it / click it, or hand control back to the game.
        Code::KeyO => {
            if !state.overlay.load(Ordering::Relaxed) {
                return;
            }
            let next = !state.clickthrough.load(Ordering::Relaxed);
            let _ = apply_clickthrough(&window, &state, next);
        }
        // Ctrl+Shift+H: hide the overlay entirely without dropping the call.
        Code::KeyH => {
            if !state.overlay.load(Ordering::Relaxed) {
                return;
            }
            match window.is_visible() {
                Ok(true) => {
                    let _ = window.hide();
                }
                _ => {
                    let _ = window.show();
                    let _ = window.set_always_on_top(true);
                }
            }
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyO);
    let hide = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyH);

    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    on_hotkey(app, shortcut.key);
                })
                .build(),
        )
        .setup(move |app| {
            // Failing to grab a hotkey must not stop the app from starting.
            let gs = app.global_shortcut();
            if let Err(e) = gs.register(toggle) {
                eprintln!("Ctrl+Shift+O не зарегистрирован: {e}");
            }
            if let Err(e) = gs.register(hide) {
                eprintln!("Ctrl+Shift+H не зарегистрирован: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lan_ip,
            host_start,
            host_stop,
            set_overlay,
            resize_overlay,
            set_clickthrough
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
