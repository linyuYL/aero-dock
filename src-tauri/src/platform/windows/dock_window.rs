//! Win32 visibility and focus rules for the dock and its settings window.

use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use tauri::{AppHandle, Manager};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMNCRP_DISABLED, DWMWA_NCRENDERING_POLICY,
};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, GetForegroundWindow, GetShellWindow, GetWindow, GetWindowLongPtrW,
    GetWindowThreadProcessId, IsWindowVisible, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    GWL_EXSTYLE, GWL_STYLE, GW_HWNDNEXT, GW_HWNDPREV, HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST,
    STYLESTRUCT, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    SWP_SHOWWINDOW, SW_HIDE, WM_NCACTIVATE, WM_NCCALCSIZE,
    WM_NCDESTROY, WM_NCPAINT, WM_STYLECHANGING, WS_CAPTION, WS_EX_APPWINDOW, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_WINDOWEDGE, WS_SYSMENU, WS_THICKFRAME,
};

use crate::core::{AeroError, AeroResult};

static SWITCHING_APPS: AtomicBool = AtomicBool::new(false);
const DOCK_FRAME_STYLES: u32 = WS_CAPTION.0 | WS_SYSMENU.0 | WS_THICKFRAME.0;

pub fn apply_tool_window_style(hwnd: HWND, is_dock: bool) -> AeroResult<()> {
    unsafe {
        if !SetWindowSubclass(hwnd, Some(keep_tool_window_style), 0, usize::from(is_dock)).as_bool() {
            return Err(AeroError::other("could not keep the window out of Alt+Tab"));
        }
        let mut ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) | WS_EX_TOOLWINDOW.0 as isize;
        ex &= !(WS_EX_APPWINDOW.0 as isize);
        if is_dock {
            ex |= WS_EX_NOACTIVATE.0 as isize;
            ex &= !(WS_EX_WINDOWEDGE.0 as isize);
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
        if is_dock {
            let policy = DWMNCRP_DISABLED;
            if let Err(error) = DwmSetWindowAttribute(
                hwnd,
                DWMWA_NCRENDERING_POLICY,
                std::ptr::from_ref(&policy).cast(),
                std::mem::size_of_val(&policy) as u32,
            ) {
                log::warn!("could not disable dock frame composition: {error}");
            }
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            SetWindowLongPtrW(hwnd, GWL_STYLE, style & !(DOCK_FRAME_STYLES as isize));
            SetWindowPos(
                hwnd, None, 0, 0, 0, 0,
                SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            )?;
        }
    }
    Ok(())
}

unsafe extern "system" fn keep_tool_window_style(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    is_dock: usize,
) -> LRESULT {
    if is_dock != 0 {
        match message {
            WM_NCCALCSIZE | WM_NCPAINT => return LRESULT(0),
            // Let the window runtime track focus without asking Windows to repaint a caption.
            WM_NCACTIVATE => return DefSubclassProc(hwnd, message, wparam, LPARAM(-1)),
            _ => {}
        }
    }
    if message == WM_STYLECHANGING {
        // The runtime can reapply caption bits while changing other window styles.
        let styles = &mut *(lparam.0 as *mut STYLESTRUCT);
        match wparam.0 as i32 {
            style if style == GWL_STYLE.0 && is_dock != 0 => {
                styles.styleNew &= !DOCK_FRAME_STYLES;
            }
            style if style == GWL_EXSTYLE.0 => {
                styles.styleNew = (styles.styleNew | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0;
                if is_dock != 0 {
                    styles.styleNew &= !WS_EX_WINDOWEDGE.0;
                }
            }
            _ => {}
        }
    } else if message == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(hwnd, Some(keep_tool_window_style), id);
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

pub fn set_switching_apps(switching: bool) {
    SWITCHING_APPS.store(switching, Relaxed);
}

pub fn refresh_visibility(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(hwnd) = handle.get_webview_window("dock").and_then(|w| w.hwnd().ok()) else {
            return;
        };
        let hwnd = HWND(hwnd.0);
        unsafe {
            let foreground = GetForegroundWindow();
            if !SWITCHING_APPS.load(Relaxed) && !is_task_switcher(foreground) {
                show_above_desktop(hwnd, foreground);
            } else if IsWindowVisible(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
    });
}

pub(super) unsafe fn is_task_switcher(hwnd: HWND) -> bool {
    matches!(
        super::running::window_class(hwnd).as_str(),
        "XamlExplorerHostIslandWindow" | "MultitaskingViewFrame" | "ForegroundStaging"
    )
}

pub(super) unsafe fn needs_desktop_refresh(dock: HWND, foreground: HWND) -> bool {
    if foreground.0.is_null() || SWITCHING_APPS.load(Relaxed) {
        return false;
    }
    let shell = GetShellWindow();
    if shell.0.is_null()
        || (foreground != shell && super::running::window_class(foreground) != "WorkerW")
    {
        return false;
    }
    let desktop = desktop_layer(shell);
    if foreground != shell && foreground != desktop {
        return false;
    }
    !IsWindowVisible(dock).as_bool() || !is_above_desktop(dock, desktop)
}

unsafe fn show_above_desktop(hwnd: HWND, foreground: HWND) {
    let shell = GetShellWindow();
    if shell.0.is_null() {
        return;
    }
    let desktop = desktop_layer(shell);
    let on_desktop = foreground == shell || foreground == desktop;
    let move_flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
    let flags = move_flags | SWP_SHOWWINDOW;
    if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST.0 as isize != 0 {
        if on_desktop {
            if !IsWindowVisible(hwnd).as_bool() || !is_above_desktop(hwnd, desktop) {
                let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
            }
            return;
        }
        if SetWindowPos(hwnd, Some(HWND_NOTOPMOST), 0, 0, 0, 0, move_flags).is_err() {
            let _ = ShowWindow(hwnd, SW_HIDE);
            return;
        }
    }
    let mut below = desktop;
    let mut result = loop {
        let insert_after = match desktop_anchor(below, hwnd) {
            Some(above) if above == hwnd => {
                if !IsWindowVisible(hwnd).as_bool() {
                    let _ = SetWindowPos(hwnd, None, 0, 0, 0, 0, flags | SWP_NOZORDER);
                }
                return;
            }
            Some(above) if GetWindowLongPtrW(above, GWL_EXSTYLE) & WS_EX_TOPMOST.0 as isize == 0 => above,
            _ => HWND_TOP,
        };
        let result = SetWindowPos(hwnd, Some(insert_after), 0, 0, 0, 0, flags);
        if result.is_ok() || insert_after == HWND_TOP {
            break result;
        }
        // Some system helper windows reject z-order changes. Continue above them.
        below = insert_after;
    };
    // Show Desktop can raise Explorer above the entire normal window layer.
    if on_desktop && !is_above_desktop(hwnd, desktop) && GetForegroundWindow() == foreground {
        result = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
    }
    if result.is_err() {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

unsafe fn is_above_desktop(dock: HWND, desktop: HWND) -> bool {
    let mut above = dock;
    while let Ok(below) = GetWindow(above, GW_HWNDNEXT) {
        if below == desktop {
            return true;
        }
        above = below;
    }
    false
}

unsafe fn desktop_anchor(desktop: HWND, dock: HWND) -> Option<HWND> {
    let mut below = desktop;
    // Hidden system windows, such as the IME, cannot serve as z-order anchors.
    while let Ok(above) = GetWindow(below, GW_HWNDPREV) {
        if above == dock || IsWindowVisible(above).as_bool() {
            return Some(above);
        }
        below = above;
    }
    None
}

unsafe fn desktop_layer(shell: HWND) -> HWND {
    let desktop_view = w!("SHELLDLL_DefView");
    if FindWindowExW(Some(shell), None, desktop_view, None).is_ok() {
        return shell;
    }
    let mut shell_pid = 0;
    GetWindowThreadProcessId(shell, Some(&mut shell_pid));
    let mut after = None;
    // Explorer can host the desktop view in a separate WorkerW window.
    while let Ok(worker) = FindWindowExW(None, after, w!("WorkerW"), None) {
        let mut pid = 0;
        GetWindowThreadProcessId(worker, Some(&mut pid));
        if pid == shell_pid && FindWindowExW(Some(worker), None, desktop_view, None).is_ok() {
            return worker;
        }
        after = Some(worker);
    }
    shell
}

/// Temporarily allow the dock to take keyboard focus (search overlay),
/// or give focus-immunity back when the overlay closes.
pub fn set_no_activate(hwnd: HWND, no_activate: bool) -> AeroResult<()> {
    unsafe {
        let mut ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as isize;
        if no_activate {
            ex |= WS_EX_NOACTIVATE.0 as isize;
        } else {
            ex &= !(WS_EX_NOACTIVATE.0 as isize);
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
    }
    Ok(())
}
