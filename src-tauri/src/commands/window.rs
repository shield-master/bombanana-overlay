use std::sync::atomic::Ordering;
use tauri::{LogicalPosition, LogicalSize, WebviewWindow, State, Emitter};
use crate::state::AppState;

const LOBBY_W: f64 = 980.0;
const LOBBY_H: f64 = 680.0;
const OVERLAY_MARGIN: f64 = 24.0;
/// Минимальный размер оверлея при ручном растягивании — чтобы влезала хотя бы шапка
/// и один узнаваемый кадр камеры. По умолчанию оверлей вертикальный (столбик).
const OVERLAY_MIN_W: f64 = 200.0;
const OVERLAY_MIN_H: f64 = 260.0;

pub fn apply_clickthrough(
    window: &WebviewWindow,
    state: &AppState,
    on: bool,
) -> tauri::Result<()> {
    state.clickthrough.store(on, Ordering::Relaxed);
    window.set_ignore_cursor_events(on)?;
    if !on {
        let _ = window.set_focus();
    }
    let _ = window.emit("overlay:clickthrough", on);
    Ok(())
}

#[tauri::command]
pub fn set_overlay(
    on: bool,
    width: f64,
    height: f64,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let err = |e: tauri::Error| e.to_string();

    if on {
        // Резизабельно: юзер сам тянет края мышкой, а плитки внутри тянутся за ним (CSS).
        window.set_resizable(true).map_err(err)?;
        window
            .set_min_size(Some(LogicalSize::new(OVERLAY_MIN_W, OVERLAY_MIN_H)))
            .map_err(err)?;
        window.set_always_on_top(true).map_err(err)?;
        window.set_size(LogicalSize::new(width, height)).map_err(err)?;

        // По умолчанию — левый нижний угол: там реже перекрывает HUD самой игры.
        if let Ok(Some(monitor)) = window.current_monitor() {
            let scale = monitor.scale_factor();
            let size = monitor.size().to_logical::<f64>(scale);
            let origin = monitor.position().to_logical::<f64>(scale);
            window
                .set_position(LogicalPosition::new(
                    origin.x + OVERLAY_MARGIN,
                    origin.y + size.height - height - OVERLAY_MARGIN,
                ))
                .map_err(err)?;
        }
        state.overlay.store(true, Ordering::Relaxed);
    } else {
        state.overlay.store(false, Ordering::Relaxed);
        state.clickthrough.store(false, Ordering::Relaxed);
        window.show().map_err(err)?;
        window.set_ignore_cursor_events(false).map_err(err)?;
        window.set_always_on_top(false).map_err(err)?;
        window.set_resizable(true).map_err(err)?;
        window.set_min_size(None::<LogicalSize<f64>>).map_err(err)?;
        window.set_size(LogicalSize::new(LOBBY_W, LOBBY_H)).map_err(err)?;
        window.center().map_err(err)?;
        window.set_focus().map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_clickthrough(on: bool, window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    apply_clickthrough(&window, &state, on).map_err(|e| e.to_string())
}