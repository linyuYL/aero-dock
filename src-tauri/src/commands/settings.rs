//! Settings IPC surface. The frontend reads the full struct, sends whole-
//! struct updates, and listens for `settings://changed` to re-render.

use tauri::{AppHandle, State};

use crate::core::settings::{PinKind, PinnedItem, Settings, SettingsStore};
use crate::core::{AeroError, AeroResult};

#[tauri::command]
pub fn get_settings(store: State<'_, SettingsStore>) -> Settings {
    store.get()
}

/// Replace the settings with a new struct (the frontend always sends the
/// complete state; sanitization clamps anything out of range).
#[tauri::command]
pub fn set_settings(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    settings: Settings,
) -> AeroResult<Settings> {
    let result = store.replace(&app, settings)?;
    // edge/monitor/floating changes must move the window even when its
    // size is unchanged (bottom<->top keeps identical dimensions, so the
    // frontend's resize path never fires)
    if let Err(e) = crate::commands::dock::position_dock(&app) {
        log::warn!("reposition after settings change failed: {e}");
    }
    Ok(result)
}

#[tauri::command]
pub fn pin_item(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    item: PinnedItem,
    index: Option<usize>,
) -> AeroResult<Settings> {
    store.update(&app, |s| {
        s.pinned.retain(|p| p.id != item.id);
        let at = index.unwrap_or(s.pinned.len()).min(s.pinned.len());
        s.pinned.insert(at, item);
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportKind {
    App,
    Website,
    Shortcut,
    File,
    Folder,
}

#[tauri::command]
pub async fn import_pin(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    id: String,
    kind: ImportKind,
    target: String,
    name: String,
) -> AeroResult<Settings> {
    let item = tauri::async_runtime::spawn_blocking(move || {
        let target = target.trim().trim_matches('"');
        let (path, kind, fallback) = if matches!(kind, ImportKind::Website) {
            let url = tauri::Url::parse(target)
                .map_err(|_| AeroError::other("请输入完整的 http:// 或 https:// 网址。"))?;
            let host = url
                .host_str()
                .filter(|_| matches!(url.scheme(), "https" | "http"))
                .ok_or_else(|| AeroError::other("网址只支持 HTTP 和 HTTPS。"))?;
            (url.to_string(), PinKind::File, host.to_string())
        } else {
            let path = std::path::Path::new(target);
            if !path.is_absolute() {
                return Err(AeroError::other("请输入完整的文件或文件夹路径。"));
            }
            let metadata = path
                .metadata()
                .map_err(|_| AeroError::other("找不到所选文件或文件夹。"))?;
            let ext = path.extension().and_then(|s| s.to_str()).unwrap_or_default();
            let kind = match kind {
                ImportKind::App if metadata.is_file() && ext.eq_ignore_ascii_case("exe") => PinKind::App,
                ImportKind::Shortcut if metadata.is_file()
                    && (ext.eq_ignore_ascii_case("lnk") || ext.eq_ignore_ascii_case("url")) => PinKind::File,
                ImportKind::Folder if metadata.is_dir() => PinKind::Folder,
                ImportKind::File if metadata.is_file() => PinKind::File,
                _ => return Err(AeroError::other("所选项目和类型不匹配。")),
            };
            let fallback = path.file_stem().and_then(|s| s.to_str()).unwrap_or(target);
            (target.to_string(), kind, fallback.to_string())
        };
        let name = name.trim();
        Ok(PinnedItem {
            id,
            name: if name.is_empty() { fallback } else { name.to_string() },
            kind,
            path,
            icon: None,
            children: Vec::new(),
        })
    })
    .await
    .map_err(|e| AeroError::other(format!("无法读取导入项目：{e}")))??;
    pin_item(app, store, item, None)
}

#[tauri::command]
pub fn rename_pin(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    id: String,
    name: String,
) -> AeroResult<Settings> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AeroError::other("请输入显示名称。"));
    }
    update_pin(&app, &store, &id, |item| item.name = name.to_string())
}

#[tauri::command]
pub async fn set_pin_icon(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    id: String,
    path: Option<String>,
) -> AeroResult<Settings> {
    let icon = if let Some(path) = path {
        let cache_dir = crate::core::paths::icon_cache_dir(&app)?;
        Some(tauri::async_runtime::spawn_blocking(move || {
            crate::platform::windows::icons::save_custom_icon(std::path::Path::new(&path), &cache_dir)
        })
        .await
        .map_err(|e| AeroError::other(format!("无法读取图标：{e}")))??)
    } else {
        None
    };
    update_pin(&app, &store, &id, |item| item.icon = icon)
}

fn update_pin(
    app: &AppHandle,
    store: &SettingsStore,
    id: &str,
    update: impl FnOnce(&mut PinnedItem),
) -> AeroResult<Settings> {
    let mut found = false;
    let result = store.update(app, |s| {
        for pin in &mut s.pinned {
            let item = if pin.id == id {
                Some(&mut *pin)
            } else {
                pin.children.iter_mut().find(|child| child.id == id)
            };
            if let Some(item) = item {
                update(item);
                found = true;
                break;
            }
        }
    })?;
    if found {
        Ok(result)
    } else {
        Err(AeroError::other("该项目已不在桌面坞上。"))
    }
}

#[tauri::command]
pub fn unpin_item(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    id: String,
) -> AeroResult<Settings> {
    store.update(&app, |s| {
        s.pinned.retain(|p| p.id != id);
        for p in &mut s.pinned {
            p.children.retain(|c| c.id != id);
        }
    })
}

/// Reorder pinned items to match the given id sequence (drag-and-drop).
#[tauri::command]
pub fn reorder_pinned(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    ids: Vec<String>,
) -> AeroResult<Settings> {
    store.update(&app, |s| {
        s.pinned.sort_by_key(|p| {
            ids.iter().position(|id| *id == p.id).unwrap_or(usize::MAX)
        });
    })
}

/// Atomic first-run import: pins the starter set and marks onboarding
/// complete in one settings transaction. Safe to call any number of
/// times (React StrictMode double-fires effects in dev) — only the
/// first call through the lock does anything.
#[tauri::command]
pub fn first_run_import(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    items: Vec<PinnedItem>,
) -> AeroResult<Settings> {
    store.update(&app, |s| {
        if !s.onboarding_complete && s.pinned.is_empty() {
            s.pinned = items;
            s.onboarding_complete = true;
        }
    })
}

#[tauri::command]
pub fn export_settings(store: State<'_, SettingsStore>) -> AeroResult<String> {
    store.export_json()
}

/// Write settings JSON to the user's Downloads folder; returns the path.
#[tauri::command]
pub fn export_settings_file(app: AppHandle, store: State<'_, SettingsStore>) -> AeroResult<String> {
    use tauri::Manager;
    let dir = app.path().download_dir()?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("aero-dock-settings-{stamp}.json"));
    std::fs::write(&path, store.export_json()?)?;
    Ok(path.to_string_lossy().to_string())
}

/// Where this copy keeps its files, and whether it is running portable.
/// Settings shows it so nobody has to guess which folder to back up.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub portable: bool,
    pub data_dir: String,
}

#[tauri::command]
pub fn storage_info(app: AppHandle) -> AeroResult<StorageInfo> {
    Ok(StorageInfo {
        portable: crate::core::paths::is_portable(),
        data_dir: crate::core::paths::config_dir(&app)?
            .to_string_lossy()
            .to_string(),
    })
}

/// Open (or focus) the settings window. Async on purpose: building a
/// WebView2 inside a sync command deadlocks on Windows (the command
/// blocks the main thread the webview needs for creation).
#[tauri::command]
pub async fn open_settings(app: AppHandle) -> AeroResult<()> {
    use crate::platform::windows::dock_window;
    use tauri::Manager;
    let window = if let Some(window) = app.get_webview_window("settings") {
        window
    } else {
        let builder = tauri::WebviewWindowBuilder::new(
            &app,
            "settings",
            tauri::WebviewUrl::App("index.html?window=settings".into()),
        )
        .title("Aero Dock 设置")
        .inner_size(820.0, 640.0)
        .min_inner_size(660.0, 500.0)
        .visible(false)
        .skip_taskbar(true);

        // WebView2 windows that share a profile also share browser arguments.
        let builder = match dock_browser_args(&app) {
            Some(args) => builder.additional_browser_args(&args),
            None => builder,
        };
        builder.build()?
    };

    let handle = app.clone();
    app.run_on_main_thread(move || {
        let show = || -> AeroResult<()> {
            let hwnd = window.hwnd()?;
            dock_window::apply_tool_window_style(windows::Win32::Foundation::HWND(hwnd.0), false)?;
            if window.is_minimized()? {
                window.unminimize()?;
            }
            window.show()?;
            window.set_focus()?;
            dock_window::refresh_visibility(&handle);
            Ok(())
        };
        if let Err(error) = show() {
            log::error!("could not show settings: {error}");
        }
    })?;
    Ok(())
}

#[tauri::command]
pub fn import_settings(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    json: String,
) -> AeroResult<Settings> {
    let result = store.import_json(&app, &json)?;
    if let Err(e) = crate::commands::dock::position_dock(&app) {
        log::warn!("reposition after import failed: {e}");
    }
    Ok(result)
}

/// The browser arguments the dock window was configured with.
#[cfg(windows)]
pub(crate) fn dock_browser_args(app: &AppHandle) -> Option<String> {
    app.config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "dock")
        .and_then(|w| w.additional_browser_args.clone())
}

#[cfg(test)]
mod tests {
    /// The browser arguments live in tauri.conf.json. Setting them there
    /// replaces Tauri's own defaults rather than adding to them, so those
    /// have to be repeated, and the GPU flag is what saves the memory.
    #[test]
    fn the_dock_keeps_tauris_defaults_and_renders_in_software() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let args = conf["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["label"] == "dock")
            .and_then(|w| w["additionalBrowserArgs"].as_str())
            .expect("the dock sets its browser arguments explicitly");
        assert!(args.contains("msWebOOUI,msPdfOOUI,msSmartScreenProtection"), "{args}");
        assert!(args.contains("--disable-gpu"), "{args}");
        // a debugging port left in a shipped build lets any local process
        // run script with the app's permissions
        assert!(!args.contains("remote-debugging"), "{args}");
    }
}
