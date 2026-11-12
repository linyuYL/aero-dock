//! Live window previews via DWM thumbnails: the compositor renders a
//! real, live miniature of a source window directly into a rectangle of
//! our dock window — zero copies, zero polling. The frontend draws the
//! glass frame; we place the living picture inside it.

use std::collections::BTreeMap;

use parking_lot::Mutex;
use serde::Deserialize;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmRegisterThumbnail, DwmUnregisterThumbnail, DwmUpdateThumbnailProperties,
    DWM_THUMBNAIL_PROPERTIES, DWM_TNP_RECTDESTINATION, DWM_TNP_SOURCECLIENTAREAONLY,
    DWM_TNP_VISIBLE,
};

use crate::core::AeroResult;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSlot {
    /// Source window handle.
    pub hwnd: isize,
    /// Destination rect in the dock window's client area, physical px.
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Source window to registered thumbnail and its last destination rectangle.
static ACTIVE: Mutex<BTreeMap<isize, (isize, RECT)>> = Mutex::new(BTreeMap::new());

/// Keep existing thumbnails mounted when a window or its bounds stays the same.
pub fn show(dest: HWND, slots: &[PreviewSlot]) -> AeroResult<()> {
    let mut active = ACTIVE.lock();
    active.retain(|source, (thumb, _)| {
        if slots.iter().any(|slot| slot.hwnd == *source) {
            return true;
        }
        let _ = unsafe { DwmUnregisterThumbnail(*thumb) };
        false
    });
    for slot in slots {
        let rect = RECT {
            left: slot.x,
            top: slot.y,
            right: slot.x + slot.w,
            bottom: slot.y + slot.h,
        };
        if active.get(&slot.hwnd).is_some_and(|(_, current)| *current == rect) {
            continue;
        }
        let thumb = match active.get(&slot.hwnd).map(|(thumb, _)| *thumb).map_or_else(
            || unsafe { DwmRegisterThumbnail(dest, HWND(slot.hwnd as *mut _)) },
            Ok,
        ) {
            Ok(t) => t,
            Err(e) => {
                log::debug!("thumbnail register failed for {}: {e}", slot.hwnd);
                continue;
            }
        };
        let props = DWM_THUMBNAIL_PROPERTIES {
            dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_VISIBLE | DWM_TNP_SOURCECLIENTAREAONLY,
            rcDestination: rect,
            fVisible: true.into(),
            fSourceClientAreaOnly: false.into(),
            ..Default::default()
        };
        if unsafe { DwmUpdateThumbnailProperties(thumb, &props) }.is_err() {
            let _ = unsafe { DwmUnregisterThumbnail(thumb) };
            active.remove(&slot.hwnd);
            continue;
        }
        active.insert(slot.hwnd, (thumb, rect));
    }
    Ok(())
}

/// Tear down all live previews.
pub fn hide() {
    for (_, (id, _)) in std::mem::take(&mut *ACTIVE.lock()) {
        let _ = unsafe { DwmUnregisterThumbnail(id) };
    }
}
