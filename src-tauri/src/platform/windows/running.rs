//! Live running-application tracking, the way real taskbars do it:
//! a hidden window on its own thread registers for shell hook messages
//! (HSHELL_WINDOWCREATED / DESTROYED / ACTIVATED …) and keeps a snapshot
//! of alt-tab-eligible windows. Every change is pushed to the frontend
//! as a full `apps://running-changed` snapshot.

use std::collections::HashMap;
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, EnumWindows, GetClassNameW,
    GetForegroundWindow, GetMessageW, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsWindow, IsWindowVisible, KillTimer, RegisterClassW,
    RegisterShellHookWindow, RegisterWindowMessageW, SetTimer, TranslateMessage, EVENT_OBJECT_HIDE,
    EVENT_OBJECT_SHOW, EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_SWITCHEND, EVENT_SYSTEM_SWITCHSTART,
    GWL_EXSTYLE, GW_OWNER, MSG, OBJID_WINDOW, WINDOW_EX_STYLE, WINDOW_STYLE, WINEVENT_OUTOFCONTEXT,
    WM_TIMER, WNDCLASSW, WS_EX_TOOLWINDOW,
};

use super::dock_window;

pub const RUNNING_EVENT: &str = "apps://running-changed";

// Shell hook codes (winuser.h)
const HSHELL_WINDOWCREATED: usize = 1;
const HSHELL_WINDOWDESTROYED: usize = 2;
const HSHELL_WINDOWACTIVATED: usize = 4;
const HSHELL_REDRAW: usize = 6;
const HSHELL_RUDEAPPACTIVATED: usize = 0x8004;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    /// HWND as integer; opaque handle for activate/minimize/close calls.
    pub hwnd: isize,
    pub title: String,
    /// Full path of the owning process executable.
    pub exe: String,
    pub pid: u32,
    /// AppUserModelID for packaged (UWP/Store) windows, which are all
    /// hosted by ApplicationFrameHost.exe — the exe alone can't
    /// identify them, but the frame window carries the app's AUMID.
    pub aumid: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningSnapshot {
    pub windows: Vec<WindowInfo>,
    /// HWND of the foreground window (0 = none of ours).
    pub focused: isize,
}

struct TrackerState {
    app: AppHandle,
    windows: HashMap<isize, WindowInfo>,
    focused: isize,
}

static STATE: OnceLock<Mutex<TrackerState>> = OnceLock::new();
static SHELL_MSG: OnceLock<u32> = OnceLock::new();

/// Current snapshot for the initial frontend hydrate.
pub fn snapshot() -> RunningSnapshot {
    match STATE.get() {
        Some(state) => {
            let s = state.lock();
            let mut windows: Vec<_> = s.windows.values().cloned().collect();
            windows.sort_by_key(|w| w.hwnd);
            RunningSnapshot {
                windows,
                focused: s.focused,
            }
        }
        None => RunningSnapshot {
            windows: Vec::new(),
            focused: 0,
        },
    }
}

/// Spawn the tracker thread. Call once from app setup.
pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("aero-shell-hook".into())
        .spawn(move || run_message_loop(app))
        .expect("spawn shell hook thread");
}

fn run_message_loop(app: AppHandle) {
    let initial: HashMap<isize, WindowInfo> = enumerate_taskbar_windows()
        .into_iter()
        .map(|w| (w.hwnd, w))
        .collect();
    let _ = STATE.set(Mutex::new(TrackerState {
        app: app.clone(),
        windows: initial,
        focused: 0,
    }));
    emit_snapshot();

    unsafe {
        let class = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            lpszClassName: w!("AeroDockShellHook"),
            ..Default::default()
        };
        RegisterClassW(&class);

        // NOTE: must be a real (hidden) top-level window — message-only
        // windows (HWND_MESSAGE parent) never receive shell hook messages.
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("AeroDockShellHook"),
            w!("AeroDockShellHook"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        ) {
            Ok(h) => h,
            Err(e) => {
                log::error!("shell hook window creation failed: {e}");
                return;
            }
        };

        let _ = SHELL_MSG.set(RegisterWindowMessageW(w!("SHELLHOOK")));
        if !RegisterShellHookWindow(hwnd).as_bool() {
            log::error!("RegisterShellHookWindow failed; running apps won't be live");
        }

        // The Windows 11 task switcher can show without a foreground or switch event.
        let hooks = [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_SYSTEM_SWITCHSTART, EVENT_SYSTEM_SWITCHEND),
            (EVENT_OBJECT_SHOW, EVENT_OBJECT_HIDE),
        ]
        .map(|(first, last)| {
            SetWinEventHook(first, last, None, Some(visibility_event), 0, 0, WINEVENT_OUTOFCONTEXT)
        });
        if hooks.iter().any(|hook| hook.0.is_null()) {
            log::error!("Could not register all dock visibility events");
        }
        // Explorer can move the desktop above the dock after the Win+D focus
        // event has already arrived. Check the ordering while on the desktop.
        let timer = SetTimer(Some(hwnd), 1, 50, None);
        let mut foreground = GetForegroundWindow();
        let dock = app
            .get_webview_window("dock")
            .and_then(|window| window.hwnd().ok())
            .map(|hwnd| HWND(hwnd.0));
        dock_window::refresh_visibility(&app);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_TIMER && msg.hwnd == hwnd && msg.wParam.0 == timer {
                let current = GetForegroundWindow();
                if current != foreground
                    || dock.is_some_and(|dock| dock_window::needs_desktop_refresh(dock, current))
                {
                    foreground = current;
                    dock_window::refresh_visibility(&app);
                }
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if timer != 0 {
            let _ = KillTimer(Some(hwnd), timer);
        }
        for hook in hooks {
            if !hook.0.is_null() {
                let _ = UnhookWinEvent(hook);
            }
        }
    }
}

unsafe extern "system" fn visibility_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _thread: u32,
    _time: u32,
) {
    match event {
        EVENT_SYSTEM_SWITCHSTART => dock_window::set_switching_apps(true),
        EVENT_SYSTEM_SWITCHEND => dock_window::set_switching_apps(false),
        EVENT_OBJECT_SHOW | EVENT_OBJECT_HIDE
            if object != OBJID_WINDOW.0 || child != 0 || !dock_window::is_task_switcher(hwnd) =>
        {
            return;
        }
        _ => {}
    }
    if let Some(app) = with_state(|s| s.app.clone()) {
        dock_window::refresh_visibility(&app);
    }
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if Some(&msg) == SHELL_MSG.get() {
        let target = HWND(lparam.0 as *mut _);
        match wparam.0 {
            HSHELL_WINDOWCREATED | HSHELL_REDRAW => {
                if let Some(info) = unsafe { probe_window(target) } {
                    with_state(|s| {
                        s.windows.insert(info.hwnd, info);
                    });
                } else {
                    // REDRAW on a window that stopped qualifying (title gone)
                    with_state(|s| {
                        s.windows.remove(&(lparam.0));
                    });
                }
                prune_and_emit();
            }
            HSHELL_WINDOWDESTROYED => {
                with_state(|s| {
                    s.windows.remove(&(lparam.0));
                    if s.focused == lparam.0 {
                        s.focused = 0;
                    }
                });
                prune_and_emit();
            }
            HSHELL_WINDOWACTIVATED | HSHELL_RUDEAPPACTIVATED => {
                // activation can arrive before creation for fast-starting apps
                if let Some(info) = unsafe { probe_window(target) } {
                    with_state(|s| {
                        s.windows.insert(info.hwnd, info);
                        s.focused = lparam.0;
                    });
                } else {
                    with_state(|s| s.focused = lparam.0);
                }
                prune_and_emit();
            }
            _ => {}
        }
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn with_state<R>(f: impl FnOnce(&mut TrackerState) -> R) -> Option<R> {
    STATE.get().map(|state| f(&mut state.lock()))
}

/// Drop stale entries (windows that died without a DESTROYED hook) and
/// push the new snapshot to the frontend.
fn prune_and_emit() {
    with_state(|s| {
        s.windows
            .retain(|&hwnd, _| unsafe { IsWindow(Some(HWND(hwnd as *mut _))).as_bool() });
    });
    emit_snapshot();
}

fn emit_snapshot() {
    if let Some(state) = STATE.get() {
        let (app, snap) = {
            let s = state.lock();
            let mut windows: Vec<_> = s.windows.values().cloned().collect();
            windows.sort_by_key(|w| w.hwnd);
            (
                s.app.clone(),
                RunningSnapshot {
                    windows,
                    focused: s.focused,
                },
            )
        };
        if let Err(e) = app.emit(RUNNING_EVENT, &snap) {
            log::warn!("emit running snapshot failed: {e}");
        }
    }
}

/// Initial scan: everything currently alt-tab eligible.
fn enumerate_taskbar_windows() -> Vec<WindowInfo> {
    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        let out = unsafe { &mut *(lparam.0 as *mut Vec<WindowInfo>) };
        if let Some(info) = unsafe { probe_window(hwnd) } {
            out.push(info);
        }
        windows::core::BOOL(1)
    }
    let mut out: Vec<WindowInfo> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

/// Processes that own visible, titled, top-level windows without being
/// applications anyone wants in a dock. These are shell surfaces: the
/// search flyout, the Start menu, the IME candidate window and friends.
/// Windows Search is the one people actually notice, because it stays
/// alive in the background and its window is neither owned nor cloaked
/// often enough for the usual checks to catch it.
const SHELL_HOST_EXES: &[&str] = &[
    "searchhost.exe",
    "searchapp.exe",
    "searchui.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "textinputhost.exe",
    "peopleexperiencehost.exe",
    "lockapp.exe",
    "widgets.exe",
    "widgetboard.exe",
    "systemsettingsbroker.exe",
    "runtimebroker.exe",
    "dwm.exe",
];

/// Window classes belonging to the shell's own XAML and CoreWindow
/// surfaces. Matching on class catches shell UI even when it is hosted
/// by a process that also runs legitimate windows.
const SHELL_CLASSES: &[&str] = &[
    "windows.ui.core.corewindow",
    "xaml_windowedpopupclass",
    "multitaskingviewframe",
    "foregroundstaging",
    "windows.internal.shell.tabproxywindow",
    "progman",
    "workerw",
    "shell_traywnd",
    "shell_secondarytraywnd",
    "notifyiconoverflowwindow",
];

/// Packaged shell components, matched on the AppUserModelID prefix.
/// A real Store app never starts with one of these.
const SHELL_AUMID_PREFIXES: &[&str] = &[
    "microsoft.windows.search",
    "microsoft.windows.startmenuexperiencehost",
    "microsoft.windows.shellexperiencehost",
    "microsoft.windows.widgets",
    "microsoftwindows.client.cbs",
    "microsoftwindows.client.core",
    "windows.immersivecontrolpanel",
];

const APP_FRAME_HOST: &str = "applicationframehost.exe";

/// File name of a full executable path, lowercased. Shared with the
/// audio and workspace code so "the same app" means one thing everywhere.
use crate::core::names::exe_key as exe_basename;

/// True when a window belongs to the Windows shell rather than to an
/// application. Pure so the rules can be tested without a desktop.
fn is_shell_surface(exe_path: &str, class_name: &str) -> bool {
    let exe = exe_basename(exe_path);
    let class = class_name.to_ascii_lowercase();
    SHELL_HOST_EXES.contains(&exe.as_str()) || SHELL_CLASSES.contains(&class.as_str())
}

/// True when a packaged window is a shell component rather than a Store
/// app the user installed.
fn is_shell_aumid(aumid: &str) -> bool {
    let lower = aumid.to_ascii_lowercase();
    SHELL_AUMID_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

/// Packaged apps are all hosted by ApplicationFrameHost. Without an
/// AUMID there is nothing to identify or launch, so such a window is a
/// frame the shell is holding open rather than a running app.
fn is_orphan_app_frame(exe_path: &str, aumid: Option<&str>) -> bool {
    exe_basename(exe_path) == APP_FRAME_HOST && aumid.is_none()
}

/// Read a window's class name.
pub(super) unsafe fn window_class(hwnd: HWND) -> String {
    unsafe {
        let mut buf = [0u16; 256];
        let n = GetClassNameW(hwnd, &mut buf);
        if n <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..n as usize])
    }
}

/// Alt-tab eligibility + metadata. Returns None for windows a dock
/// should not show (owned popups, tool windows, cloaked UWP shells,
/// untitled windows, and shell surfaces such as Windows Search).
unsafe fn probe_window(hwnd: HWND) -> Option<WindowInfo> {
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() || !IsWindowVisible(hwnd).as_bool() {
            return None;
        }
        if GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.0.is_null()) {
            return None;
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 {
            return None;
        }
        // cloaked = UWP window that is suspended/on another virtual desktop shell state
        let mut cloaked: u32 = 0;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        );
        if cloaked != 0 {
            return None;
        }

        let len = GetWindowTextLengthW(hwnd);
        if len == 0 {
            return None;
        }
        let mut title_buf = vec![0u16; len as usize + 1];
        let read = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..read.max(0) as usize]);
        if title.trim().is_empty() {
            return None;
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || pid == std::process::id() {
            return None;
        }
        let exe = process_path(pid)?;

        // Shell surfaces look like ordinary windows to every check above:
        // visible, titled, unowned, not cloaked. They have to be named.
        if is_shell_surface(&exe, &window_class(hwnd)) {
            return None;
        }

        let aumid = if exe_basename(&exe) == APP_FRAME_HOST {
            window_aumid(hwnd)
        } else {
            None
        };
        if is_orphan_app_frame(&exe, aumid.as_deref()) {
            return None;
        }
        if aumid.as_deref().is_some_and(is_shell_aumid) {
            return None;
        }

        Some(WindowInfo {
            hwnd: hwnd.0 as isize,
            title,
            exe,
            pid,
            aumid,
        })
    }
}

/// Read PKEY_AppUserModel_ID from a window's property store.
fn window_aumid(hwnd: HWND) -> Option<String> {
    use windows::core::GUID;
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};

    const PKEY_APPUSERMODEL_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9F4C2855_9F79_4B39_A8D0_E1D42DE1D5F3),
        pid: 5,
    };

    unsafe {
        let store: IPropertyStore = SHGetPropertyStoreForWindow(hwnd).ok()?;
        let value = store.GetValue(&PKEY_APPUSERMODEL_ID).ok()?;
        let pw = PropVariantToStringAlloc(&value).ok()?;
        if pw.is_null() {
            return None;
        }
        let s = pw.to_string().ok()?;
        windows::Win32::System::Com::CoTaskMemFree(Some(pw.as_ptr() as *const _));
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

fn process_path(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        ok.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

// ---------------------------------------------------------------------
// window actions
// ---------------------------------------------------------------------

pub fn toggle_window(hwnd: isize) -> crate::core::AeroResult<()> {
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, IsIconic, GA_ROOTOWNER};
    unsafe {
        let target = HWND(hwnd as *mut _);
        let foreground = GetForegroundWindow();
        if !IsIconic(target).as_bool()
            && (foreground == target || GetAncestor(foreground, GA_ROOTOWNER) == target)
        {
            minimize_window(hwnd)
        } else {
            activate_window(hwnd)
        }
    }
}

/// Bring a window to the foreground, restoring it if minimized.
/// Uses the Alt-key trick so it works from a NOACTIVATE dock window.
pub fn activate_window(hwnd: isize) -> crate::core::AeroResult<()> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_MENU,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, SetForegroundWindow, ShowWindow, SwitchToThisWindow, SW_RESTORE,
    };
    unsafe {
        let h = HWND(hwnd as *mut _);
        if !IsWindow(Some(h)).as_bool() {
            return Ok(());
        }
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
            if IsIconic(h).as_bool() {
                // A normal restore can be refused for an elevated window.
                SwitchToThisWindow(h, true);
                return Ok(());
            }
        }
        if GetForegroundWindow() == h || SetForegroundWindow(h).as_bool() {
            return Ok(());
        }
        // Windows only lets the foreground process reassign foreground;
        // a synthetic Alt press makes the shell treat us as eligible.
        keybd_event(VK_MENU.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
        let activated = SetForegroundWindow(h).as_bool();
        keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        if !activated {
            return Err(crate::core::AeroError::other("Windows 拒绝切换到该窗口"));
        }
    }
    Ok(())
}

pub fn minimize_window(hwnd: isize) -> crate::core::AeroResult<()> {
    use windows::Win32::UI::WindowsAndMessaging::{IsIconic, ShowWindowAsync, SW_MINIMIZE};
    unsafe {
        let h = HWND(hwnd as *mut _);
        if !IsWindow(Some(h)).as_bool() || IsIconic(h).as_bool() {
            return Ok(());
        }
        if ShowWindowAsync(h, SW_MINIMIZE).as_bool() {
            for _ in 0..3 {
                std::thread::sleep(std::time::Duration::from_millis(30));
                if IsIconic(h).as_bool() {
                    return Ok(());
                }
            }
        }
    }
    // Run UI Automation outside the WebView host when the window refuses
    // the usual request. The helper runs with the dock's existing permissions.
    let status = std::process::Command::new(std::env::current_exe()?)
        .arg("--minimize-accessible-window")
        .arg(hwnd.to_string())
        .status()?;
    if !status.success() {
        return Err(crate::core::AeroError::other("Windows 未最小化该窗口"));
    }
    Ok(())
}

pub fn minimize_accessible_window(hwnd: isize) -> crate::core::AeroResult<()> {
    use windows::core::Interface;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        AccessibleObjectFromWindow, CUIAutomation8, IAccessible, IUIAutomation2,
        IUIAutomationWindowPattern, UIA_WindowPatternId, WindowVisualState_Minimized,
    };
    use windows::Win32::UI::WindowsAndMessaging::{IsIconic, OBJID_TITLEBAR, WS_MINIMIZEBOX, GWL_STYLE};
    unsafe {
        let h = HWND(hwnd as *mut _);
        if !IsWindow(Some(h)).as_bool() || IsIconic(h).as_bool() {
            return Ok(());
        }
        let _com = crate::platform::ComApartment::multithreaded();
        if GetWindowLongPtrW(h, GWL_STYLE) & WS_MINIMIZEBOX.0 as isize != 0 {
            let mut raw = std::ptr::null_mut();
            if AccessibleObjectFromWindow(h, OBJID_TITLEBAR.0 as u32, &IAccessible::IID, &mut raw)
                .is_ok() && !raw.is_null()
            {
                let title_bar = IAccessible::from_raw(raw);
                // Child 2 is the minimize button of the standard Windows title bar.
                if title_bar.accDoDefaultAction(&VARIANT::from(2i32)).is_ok() {
                    for _ in 0..5 {
                        if IsIconic(h).as_bool() {
                            return Ok(());
                        }
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                }
            }
        }
        let automation: IUIAutomation2 = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
        automation.SetConnectionTimeout(750)?;
        automation.SetTransactionTimeout(750)?;
        for _ in 0..2 {
            let element = automation.ElementFromHandle(h)?;
            let window: IUIAutomationWindowPattern =
                element.GetCurrentPatternAs(UIA_WindowPatternId)?;
            window.SetWindowVisualState(WindowVisualState_Minimized)?;
            for _ in 0..5 {
                if IsIconic(h).as_bool() {
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
        if !IsIconic(h).as_bool() {
            return Err(crate::core::AeroError::other("Windows 未最小化该窗口"));
        }
    }
    Ok(())
}

pub fn close_window(hwnd: isize) {
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
    unsafe {
        let h = HWND(hwnd as *mut _);
        if IsWindow(Some(h)).as_bool() {
            let _ = PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basename_is_lowercased_and_stripped() {
        assert_eq!(exe_basename(r"C:\Windows\Explorer.EXE"), "explorer.exe");
        assert_eq!(exe_basename("notepad.exe"), "notepad.exe");
    }

    #[test]
    fn windows_search_is_filtered_out() {
        let search = r"C:\Windows\SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\SearchHost.exe";
        assert!(is_shell_surface(search, "Windows.UI.Core.CoreWindow"));
        // and even if the class changes, the executable still catches it
        assert!(is_shell_surface(search, "SomethingElse"));
    }

    #[test]
    fn start_menu_and_input_host_are_filtered_out() {
        assert!(is_shell_surface(r"C:\W\StartMenuExperienceHost.exe", "X"));
        assert!(is_shell_surface(r"C:\W\TextInputHost.exe", "X"));
    }

    #[test]
    fn desktop_and_tray_classes_are_filtered_out() {
        assert!(is_shell_surface(r"C:\Windows\explorer.exe", "Progman"));
        assert!(is_shell_surface(r"C:\Windows\explorer.exe", "Shell_TrayWnd"));
    }

    #[test]
    fn ordinary_apps_survive() {
        assert!(!is_shell_surface(r"C:\Windows\explorer.exe", "CabinetWClass"));
        assert!(!is_shell_surface(r"C:\Program Files\Notepad++\notepad++.exe", "Notepad++"));
        assert!(!is_shell_surface(r"C:\Users\x\AppData\Local\Programs\Code\Code.exe", "Chrome_WidgetWin_1"));
    }

    #[test]
    fn shell_packages_are_filtered_but_store_apps_are_not() {
        assert!(is_shell_aumid("Microsoft.Windows.Search_cw5n1h2txyewy!App"));
        assert!(is_shell_aumid("MicrosoftWindows.Client.CBS_cw5n1h2txyewy!InputApp"));
        assert!(!is_shell_aumid("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"));
        assert!(!is_shell_aumid("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"));
    }

    #[test]
    fn app_frames_without_an_aumid_are_dropped() {
        let host = r"C:\Windows\System32\ApplicationFrameHost.exe";
        assert!(is_orphan_app_frame(host, None));
        assert!(!is_orphan_app_frame(host, Some("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App")));
        // a normal app with no AUMID is not an orphan frame
        assert!(!is_orphan_app_frame(r"C:\Windows\explorer.exe", None));
    }
}
