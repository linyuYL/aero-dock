pub mod commands;
pub mod core;
pub mod platform;

use tauri::Manager;

use crate::commands::dock::DockGeometry;
use crate::core::settings::SettingsStore;
use crate::platform::windows::dock_window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A portable copy takes WebView2's profile with it. Left alone, WebView2
    // writes one under %LOCALAPPDATA% on whatever machine it was plugged into.
    #[cfg(windows)]
    if let Some(dir) = core::paths::webview_dir() {
        let _ = std::fs::create_dir_all(&dir);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            dock_window::refresh_visibility(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(DockGeometry::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let icons = core::paths::icon_cache_dir(&handle)?;
            std::fs::create_dir_all(&icons)?;
            app.asset_protocol_scope().allow_directory(&icons, false)?;
            let store = SettingsStore::load(&handle)?;
            app.manage(store);

            let window = app
                .get_webview_window("dock")
                .expect("dock window declared in tauri.conf.json");

            #[cfg(windows)]
            {
                let hwnd = window.hwnd()?;
                dock_window::apply_tool_window_style(windows::Win32::Foundation::HWND(hwnd.0), true)?;
            }

            commands::dock::position_dock(&handle)?;

            #[cfg(windows)]
            platform::windows::running::start(handle.clone());
            setup_tray(app)?;

            // honor the taskbar preference from the last session, and if it
            // is off, force the taskbar back: a previous crash while hidden
            // must not leave the user without one
            if app.state::<SettingsStore>().get().hide_taskbar {
                platform::windows::taskbar::set_taskbar_autohide(true);
            } else {
                platform::windows::taskbar::restore_taskbar();
            }
            commands::apps::warm_app_cache();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::set_settings,
            commands::settings::pin_item,
            commands::settings::import_pin,
            commands::settings::rename_pin,
            commands::settings::set_pin_icon,
            commands::settings::unpin_item,
            commands::settings::reorder_pinned,
            commands::settings::first_run_import,
            commands::settings::export_settings,
            commands::settings::export_settings_file,
            commands::settings::import_settings,
            commands::settings::open_settings,
            commands::settings::storage_info,
            commands::apps::list_apps,
            commands::apps::resolve_icons,
            commands::apps::launch,
            commands::apps::launch_as_admin,
            commands::apps::open_file_location,
            commands::apps::resolve_drop,
            commands::apps::pick_pin_path,
            commands::apps::list_folder,
            commands::apps::list_recent_files,
            commands::dock::resize_dock,
            commands::dock::list_monitors,
            commands::dock::set_dock_focusable,
            commands::dock::set_taskbar_hidden,
            commands::dock::quit_app,
            commands::dock::set_memory_saver,
            commands::windows_cmd::get_running,
            commands::windows_cmd::activate_window,
            commands::windows_cmd::toggle_window,
            commands::windows_cmd::minimize_window,
            commands::windows_cmd::close_window,
            commands::windows_cmd::show_window_previews,
            commands::windows_cmd::hide_window_previews,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Aero Dock")
        .run(|_app, event| {
            // leaving? give the user their taskbar back
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // always restore, not only when the pref is on: the user may
                // have toggled it off mid-session without the bar coming back
                platform::windows::taskbar::restore_taskbar();
            }
        });
}

/// Tray icon: the dock's home base. Left-click toggles dock visibility;
/// the menu covers show/hide, settings, and quit.
/// Where the support link points. Kept in step with `KOFI_URL` in
/// `src/links.ts`, which is what the windows themselves use.
const KOFI_URL: &str = "https://ko-fi.com/theagencymge";

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示桌面坞", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let support = MenuItem::with_id(app, "support", "支持 Aero Dock ☕", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Aero Dock", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &settings, &support, &separator, &quit])?;

    TrayIconBuilder::with_id("aero-dock-tray")
        .icon(
            app.default_window_icon()
                .expect("bundle has a default icon")
                .clone(),
        )
        .tooltip("Aero Dock（右键打开菜单）")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => dock_window::refresh_visibility(app),
            "settings" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = commands::settings::open_settings(app).await {
                        log::error!("open settings from tray failed: {e}");
                    }
                });
            }
            "support" => {
                // the shell opens it in whatever browser the user uses;
                // nothing external is ever loaded into our own windows
                if let Err(e) = commands::apps::launch_target(KOFI_URL) {
                    log::warn!("could not open the support page: {e}");
                }
            }
            "quit" => commands::dock::quit_app(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                dock_window::refresh_visibility(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
