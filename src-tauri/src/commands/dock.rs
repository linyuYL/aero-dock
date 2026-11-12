//! Dock window geometry. The frontend measures its content (which changes
//! with icon count, size, and magnification headroom) and asks Rust to fit
//! the OS window; Rust owns edge/monitor math so the window always lands
//! inside the target monitor's work area.

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateRectRgnIndirect, DeleteObject, GetWindowRgnBox, SetWindowRgn, HGDIOBJ, SIMPLEREGION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
};

use crate::core::settings::{DockEdge, SettingsStore};
use crate::core::{AeroError, AeroResult};
use crate::platform::windows::monitors::{enumerate_monitors, pick_monitor, MonitorInfoEx};

/// Last window and interactive region sizes, in logical pixels.
pub struct DockGeometry {
    size: Mutex<DockSize>,
}

#[derive(Clone, Copy)]
struct DockSize {
    window: (f64, f64),
    visible: (f64, f64),
}

impl Default for DockGeometry {
    fn default() -> Self {
        Self {
            // sensible pre-first-measure footprint
            size: Mutex::new(DockSize { window: (720.0, 160.0), visible: (720.0, 160.0) }),
        }
    }
}

/// Frontend reports its content size; window is resized and repositioned.
#[tauri::command]
pub fn resize_dock(
    app: AppHandle,
    width: f64,
    height: f64,
    visible_width: f64,
    visible_height: f64,
) -> AeroResult<()> {
    let geometry = app.state::<DockGeometry>();
    *geometry.size.lock() = DockSize {
        window: (width, height),
        visible: (visible_width, visible_height),
    };
    position_dock(&app)
}

/// Recompute and apply the dock window's position from current settings.
/// Called on resize requests, settings changes, and WM_DISPLAYCHANGE.
pub fn position_dock(app: &AppHandle) -> AeroResult<()> {
    let settings = app.state::<SettingsStore>().get();
    let geometry = app.state::<DockGeometry>();
    let size = *geometry.size.lock();

    let monitors = enumerate_monitors()?;
    let monitor = pick_monitor(&monitors, settings.dock.monitor.as_deref());

    let scale = monitor.scale;
    let margin = if settings.dock.floating {
        (settings.dock.floating_margin as f64 * scale).round() as i32
    } else {
        0
    };

    let pixels = |value: f64| ((value * scale).round() as i32).max(1);
    let (w, h) = (pixels(size.window.0), pixels(size.window.1));
    let vw = pixels(size.visible.0).min(w);
    let vh = pixels(size.visible.1).min(h);
    let edge = settings.dock.edge;
    let (x, y) = place_on_edge(monitor, edge, w, h, margin);
    let (left, top) = match edge {
        DockEdge::Bottom => ((w - vw) / 2, h - vh),
        DockEdge::Top => ((w - vw) / 2, 0),
        DockEdge::Left => (0, (h - vh) / 2),
        DockEdge::Right => (w - vw, (h - vh) / 2),
    };
    let bounds = RECT { left: x, top: y, right: x + w, bottom: y + h };
    let visible = RECT { left, top, right: left + vw, bottom: top + vh };

    let window = app
        .get_webview_window("dock")
        .ok_or_else(|| AeroError::other("dock window missing"))?;
    let hwnd = window.hwnd()?.0 as isize;
    app.run_on_main_thread(move || {
        if let Err(error) = apply_dock_bounds(HWND(hwnd as *mut _), bounds, visible) {
            log::warn!("could not apply dock bounds: {error}");
        }
    })?;
    Ok(())
}

fn apply_dock_bounds(hwnd: HWND, bounds: RECT, visible: RECT) -> AeroResult<()> {
    unsafe {
        let mut current = RECT::default();
        GetWindowRect(hwnd, &mut current)?;
        if current != bounds {
            SetWindowPos(
                hwnd, None, bounds.left, bounds.top,
                bounds.right - bounds.left, bounds.bottom - bounds.top,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )?;
        }
        // Clip the unused preview space out of both drawing and hit testing.
        if GetWindowRgnBox(hwnd, &mut current) != SIMPLEREGION || current != visible {
            let region = CreateRectRgnIndirect(&visible);
            if region.0.is_null() {
                return Err(AeroError::other("could not allocate dock region"));
            }
            if SetWindowRgn(hwnd, Some(region), true) == 0 {
                let _ = DeleteObject(HGDIOBJ(region.0));
                return Err(AeroError::other("could not apply dock region"));
            }
        }
    }
    Ok(())
}

/// Pure placement math: center the dock along the chosen work-area edge.
fn place_on_edge(
    monitor: &MonitorInfoEx,
    edge: DockEdge,
    w: i32,
    h: i32,
    margin: i32,
) -> (i32, i32) {
    let wa = monitor.work_area;
    match edge {
        DockEdge::Bottom => (wa.x + (wa.width - w) / 2, wa.y + wa.height - h - margin),
        DockEdge::Top => (wa.x + (wa.width - w) / 2, wa.y + margin),
        DockEdge::Left => (wa.x + margin, wa.y + (wa.height - h) / 2),
        DockEdge::Right => (wa.x + wa.width - w - margin, wa.y + (wa.height - h) / 2),
    }
}

/// List monitors so the settings UI can offer a monitor picker.
#[tauri::command]
pub fn list_monitors() -> AeroResult<Vec<MonitorInfoEx>> {
    enumerate_monitors()
}

/// Auto-hide the Windows taskbar (Aero Dock becomes the bar) or restore
/// it. Repositions the dock afterwards because the work area changes.
#[tauri::command]
pub async fn set_taskbar_hidden(app: AppHandle, hidden: bool) -> AeroResult<()> {
    crate::platform::windows::taskbar::set_taskbar_autohide(hidden);
    // the shell animates the taskbar away; re-measure once it settles
    tokio_sleep(600).await;
    position_dock(&app)
}

async fn tokio_sleep(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms))
    })
    .await
    .ok();
}

/// Shut Aero Dock down for real, from anywhere in the UI.
///
/// The taskbar is restored here as well as in the exit handler. Quitting
/// is the one action where leaving the shell taskbar hidden would strand
/// someone with no way back, so it is worth doing twice.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    crate::platform::windows::taskbar::restore_taskbar();
    app.exit(0);
}

/// Let the dock take keyboard focus (search overlay) or give its
/// focus-immunity back when the overlay closes.
#[tauri::command]
pub fn set_dock_focusable(app: AppHandle, focusable: bool) -> AeroResult<()> {
    let window = app
        .get_webview_window("dock")
        .ok_or_else(|| AeroError::other("dock window missing"))?;
    let hwnd = window.hwnd()?;
    crate::platform::windows::dock_window::set_no_activate(
        windows::Win32::Foundation::HWND(hwnd.0),
        !focusable,
    )?;
    if focusable {
        window.set_focus()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::windows::monitors::Rect;

    fn monitor() -> MonitorInfoEx {
        MonitorInfoEx {
            name: r"\\.\DISPLAY1".into(),
            bounds: Rect { x: 0, y: 0, width: 2560, height: 1440 },
            work_area: Rect { x: 0, y: 0, width: 2560, height: 1392 }, // 48px taskbar
            scale: 1.25,
            is_primary: true,
        }
    }

    #[test]
    fn bottom_edge_sits_above_taskbar() {
        let (x, y) = place_on_edge(&monitor(), DockEdge::Bottom, 800, 200, 10);
        assert_eq!(x, (2560 - 800) / 2);
        assert_eq!(y, 1392 - 200 - 10);
    }

    #[test]
    fn left_edge_centers_vertically() {
        let (x, y) = place_on_edge(&monitor(), DockEdge::Left, 200, 800, 0);
        assert_eq!(x, 0);
        assert_eq!(y, (1392 - 800) / 2);
    }
}

/// Trim or restore the calling window's memory. The dock calls this with
/// `true` when it goes to sleep after a spell with no interaction, and
/// with `false` the moment the cursor comes back.
///
/// Best effort by design: an old WebView2 runtime without the API just
/// keeps its caches, which is what it did before this existed.
#[tauri::command]
pub fn set_memory_saver(webview: tauri::Webview, low: bool) {
    #[cfg(windows)]
    {
        let result = webview.with_webview(move |platform| {
            if let Err(e) =
                crate::platform::windows::memory::set_memory_target(&platform.controller(), low)
            {
                log::debug!("memory target not applied: {e}");
            }
        });
        if let Err(e) = result {
            log::debug!("could not reach the webview: {e}");
        }
    }
    #[cfg(not(windows))]
    let _ = (webview, low);
}
