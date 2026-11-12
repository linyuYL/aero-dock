/**
 * Window previews: hover over an app with open windows and a
 * glass shelf rises with LIVE miniatures of each window — real DWM
 * thumbnails composited by Windows into our dock window, zero-copy.
 * Click a preview to focus that window; ✕ closes it.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ipc } from "../../ipc/commands";
import { notify } from "../feedback/toastStore";
import type { Settings } from "../../ipc/types";
import { targetKey, useRunning, windowKey } from "../../state/runningStore";
import { flyoutStyle, useMenu } from "./menuStore";
import "./windowsflyout.css";

const SLOT_W = 200;
const SLOT_H = 120;
const COLS_MAX = 2;

interface WindowsFlyoutProps {
  edge: Settings["dock"]["edge"];
}

export function WindowsFlyout({ edge }: WindowsFlyoutProps) {
  const { kind, item, anchor, close } = useMenu();
  const allWindows = useRunning((s) => s.windows);
  const focused = useRunning((s) => s.focused);
  const slotRefs = useRef(new Map<number, HTMLButtonElement>());

  const active = kind === "windows" && item !== null && anchor !== null;

  // live view of this app's windows; flyout dissolves when they're gone
  const windows = useMemo(() => {
    if (!item) return [];
    const key = targetKey(item.target);
    return allWindows.filter((w) => windowKey(w) === key);
  }, [item, allWindows]);

  useEffect(() => {
    if (active && windows.length === 0) close();
  }, [active, windows.length, close]);

  useLayoutEffect(() => {
    if (!active) {
      ipc.hideWindowPreviews().catch(() => undefined);
      return;
    }
    // The native thumbnails use the settled slot positions in physical pixels.
    const placeThumbnails = () => {
      const scale = window.devicePixelRatio;
      const slots = windows.flatMap(({ hwnd }) => {
        const el = slotRefs.current.get(hwnd);
        if (!el) return [];
        const rect = el.getBoundingClientRect();
        return [{
          hwnd,
          x: Math.round(rect.left * scale),
          y: Math.round(rect.top * scale),
          w: Math.round(rect.width * scale),
          h: Math.round(rect.height * scale),
        }];
      });
      ipc.showWindowPreviews(slots).catch((e) => console.error("previews failed", e));
    };
    placeThumbnails();
    window.addEventListener("resize", placeThumbnails);
    return () => window.removeEventListener("resize", placeThumbnails);
  }, [active, anchor, edge, windows]);

  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".windows-flyout, .dock-icon[data-multiple-windows]")) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    const onLeave = () => {
      leaveTimer = setTimeout(close, 500);
    };
    const onEnter = () => clearTimeout(leaveTimer);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    document.documentElement.addEventListener("mouseleave", onLeave);
    document.documentElement.addEventListener("mouseenter", onEnter);
    return () => {
      clearTimeout(leaveTimer);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      document.documentElement.removeEventListener("mouseenter", onEnter);
    };
  }, [active, close]);

  const cols = Math.min(windows.length, COLS_MAX);
  const flyoutWidth = cols * (SLOT_W + 10) + 18;

  // rows of previews, capped by COLS_MAX -> approximate height for clamping
  const rows = Math.ceil(windows.length / COLS_MAX);
  const style = anchor
    ? flyoutStyle(edge, anchor, flyoutWidth, 14, rows * (SLOT_H + 26) + 30)
    : {};
  if (!active || !item) return null;
  return (
    <div
      className="windows-flyout glass"
      style={style}
      onMouseEnter={() => useMenu.getState().cancelScheduledClose()}
      onMouseLeave={() => useMenu.getState().scheduleClose(350)}
    >
      <div className="windows-flyout-title">{item.name}</div>
      <div
        className="windows-flyout-grid"
        style={{ gridTemplateColumns: `repeat(${cols}, ${SLOT_W}px)` }}
      >
        {windows.map((w) => (
          <div
            key={w.hwnd}
            className="windows-preview"
            data-focused={w.hwnd === focused}
            onClick={() => {
              ipc.activateWindow(w.hwnd).catch(notify.on("无法激活该窗口"));
              close();
            }}
          >
            <button
              type="button"
              className="windows-preview-frame"
              style={{ height: SLOT_H }}
              ref={(el) => {
                if (el) slotRefs.current.set(w.hwnd, el);
                else slotRefs.current.delete(w.hwnd);
              }}
              aria-label={w.title}
              title={w.title}
            />
            <div className="windows-preview-caption">
              <span className="windows-preview-title">{w.title}</span>
              <button
                className="windows-flyout-close"
                title="关闭窗口"
                onClick={(event) => {
                  event.stopPropagation();
                  ipc.closeWindow(w.hwnd).catch(notify.on("无法关闭该窗口"));
                }}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
