mod commands;
mod state;

use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use commands::game_log::spawn_game_watcher;
use commands::window::*;
use state::AppState;

/// Во время матча в фокусе сама игра — Windows (в т.ч. Game Mode) считает наш
/// процесс фоновым и урезает ему приоритет/такты через EcoQoS, из-за чего
/// картинки с камер подтормаживают. Явно просим систему не троттлить нас же
/// механизмом, которым сами браузеры отключают Efficiency Mode для себя.
#[cfg(windows)]
fn disable_power_throttling() {
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, ProcessPowerThrottling, SetProcessInformation,
        PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_STATE,
    };

    let state = PROCESS_POWER_THROTTLING_STATE {
        Version: 1, // PROCESS_POWER_THROTTLING_CURRENT_VERSION
        ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        StateMask: 0, // 0 в StateMask при выставленном ControlMask = троттлинг выключен
    };

    unsafe {
        SetProcessInformation(
            GetCurrentProcess(),
            ProcessPowerThrottling,
            &state as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        );
    }
}

fn on_hotkey(app: &AppHandle, code: Code) {
    let Some(window) = app.get_webview_window("main") else { return };
    let state = app.state::<AppState>();

    match code {
        Code::KeyO => {
            if !state.overlay.load(Ordering::Relaxed) {
                return;
            }
            let next = !state.clickthrough.load(Ordering::Relaxed);
            let _ = apply_clickthrough(&window, &state, next);
        }
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            #[cfg(windows)]
            disable_power_throttling();

            let gs = app.global_shortcut();
            if let Err(e) = gs.register(toggle) {
                eprintln!("Ctrl+Shift+O не зарегистрирован: {e}");
            }
            if let Err(e) = gs.register(hide) {
                eprintln!("Ctrl+Shift+H не зарегистрирован: {e}");
            }
            spawn_game_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_overlay, set_clickthrough])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}