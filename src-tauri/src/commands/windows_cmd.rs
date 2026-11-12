//! Window management IPC: the frontend gets live snapshots via the
//! `apps://running-changed` event; these commands cover hydrate + actions.

use crate::platform::windows::running;
use crate::core::{AeroError, AeroResult};

#[tauri::command]
pub fn get_running() -> running::RunningSnapshot {
    running::snapshot()
}

#[tauri::command]
pub fn activate_window(hwnd: isize) -> AeroResult<()> {
    running::activate_window(hwnd)
}

#[tauri::command]
pub async fn toggle_window(hwnd: isize) -> AeroResult<()> {
    tauri::async_runtime::spawn_blocking(move || running::toggle_window(hwnd))
        .await
        .map_err(|e| AeroError::other(format!("无法切换窗口：{e}")))?
}

#[tauri::command]
pub async fn minimize_window(hwnd: isize) -> AeroResult<()> {
    tauri::async_runtime::spawn_blocking(move || running::minimize_window(hwnd))
        .await
        .map_err(|e| AeroError::other(format!("无法最小化窗口：{e}")))?
}

#[tauri::command]
pub fn close_window(hwnd: isize) {
    running::close_window(hwnd);
}

/// Show live DWM previews at the given client-area rects (physical px).
#[tauri::command]
pub fn show_window_previews(
    app: tauri::AppHandle,
    slots: Vec<crate::platform::windows::thumbnails::PreviewSlot>,
) -> crate::core::AeroResult<()> {
    use tauri::Manager;
    let window = app
        .get_webview_window("dock")
        .ok_or_else(|| crate::core::AeroError::other("dock window missing"))?;
    let hwnd = window.hwnd()?;
    crate::platform::windows::thumbnails::show(
        windows::Win32::Foundation::HWND(hwnd.0),
        &slots,
    )
}

#[tauri::command]
pub fn hide_window_previews() {
    crate::platform::windows::thumbnails::hide();
}
