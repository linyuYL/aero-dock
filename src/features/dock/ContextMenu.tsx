/**
 * Aero context menu: a glass sheet that blooms open above the icon and
 * dissolves closed. Window list on top (for running apps), then actions.
 */

import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { springs } from "../../engine/animation/springs";
import { ipc } from "../../ipc/commands";
import { notify } from "../feedback/toastStore";
import type { Settings } from "../../ipc/types";
import type { DockItemView } from "../../state/dockStore";
import { bloomOffset, flyoutStyle, useMenu } from "./menuStore";
import "./contextmenu.css";

const MENU_WIDTH = 240;

interface ContextMenuProps {
  settings: Settings;
  edge: Settings["dock"]["edge"];
}

interface Action {
  label: string;
  danger?: boolean;
  separatorAbove?: boolean;
  run: () => void | Promise<unknown>;
}

/** Merge a pinned item into (or onto) its left neighbor as a stack. */
async function stackWithPrevious(settings: Settings, itemId: string): Promise<unknown> {
  const pinned = structuredClone(settings.pinned);
  const idx = pinned.findIndex((p) => p.id === itemId);
  if (idx < 1) return;
  const current = pinned[idx];
  const prev = pinned[idx - 1];
  if (prev.kind === "stack") {
    prev.children.push(current);
  } else {
    pinned[idx - 1] = {
      id: `pin-${crypto.randomUUID()}`,
      kind: "stack",
      path: "",
      name: `${prev.name} 等`,
      icon: null,
      children: [prev, current],
    };
  }
  pinned.splice(idx, 1);
  const next = structuredClone(settings);
  next.pinned = pinned;
  return ipc.setSettings(next);
}

/** Explode a stack back into its pinned children. */
async function unstack(settings: Settings, stackId: string): Promise<unknown> {
  const pinned = structuredClone(settings.pinned);
  const idx = pinned.findIndex((p) => p.id === stackId);
  if (idx === -1) return;
  const stack = pinned[idx];
  pinned.splice(idx, 1, ...stack.children);
  const next = structuredClone(settings);
  next.pinned = pinned;
  return ipc.setSettings(next);
}

function buildActions(item: DockItemView, settings: Settings): Action[] {
  const actions: Action[] = [];

  // stacks have their own compact menu
  if (item.kind === "stack") {
    actions.push({ label: "取消分组", run: () => unstack(settings, item.id) });
    actions.push({
      label: "从桌面坞取消固定",
      run: () => ipc.unpinItem(item.id),
    });
    actions.push({
      label: "桌面坞设置…",
      separatorAbove: true,
      run: () => ipc.openSettings(),
    });
    return actions;
  }

  actions.push({
    label: item.windows.length > 0 ? "新建窗口" : "打开",
    run: () => ipc.launch(item.target, item.args),
  });
  if (!/^https?:\/\//i.test(item.target)) {
    actions.push({
      label: "以管理员身份运行",
      run: () => ipc.launchAsAdmin(item.target, item.args),
    });
    actions.push({
      label: "打开文件所在位置",
      run: () => ipc.openFileLocation(item.target),
    });
  }

  if (item.pinned) {
    actions.push({
      label: "从桌面坞取消固定",
      separatorAbove: true,
      run: () => ipc.unpinItem(item.id),
    });
    const idx = settings.pinned.findIndex((p) => p.id === item.id);
    if (idx > 0) {
      actions.push({
        label:
          settings.pinned[idx - 1].kind === "stack"
            ? "添加到左侧分组"
            : "与左侧项目分组",
        run: () => stackWithPrevious(settings, item.id),
      });
    }
  } else {
    actions.push({
      label: "固定到桌面坞",
      separatorAbove: true,
      run: () =>
        ipc.pinItem(
          {
            id: `pin-${crypto.randomUUID()}`,
            kind: "app",
            path: item.target,
            name: item.name,
            icon: null,
            children: [],
          },
          settings.pinned.length,
        ),
    });
  }

  actions.push({
    label: "桌面坞设置…",
    separatorAbove: true,
    run: () => ipc.openSettings(),
  });

  if (item.windows.length === 1) {
    actions.push({
      label: "最小化",
      separatorAbove: true,
      run: () => ipc.minimizeWindow(item.windows[0].hwnd),
    });
    actions.push({
      label: "关闭窗口",
      danger: true,
      run: () => ipc.closeWindow(item.windows[0].hwnd),
    });
  } else if (item.windows.length > 1) {
    actions.push({
      label: `关闭全部（${item.windows.length}）`,
      danger: true,
      separatorAbove: true,
      run: () => Promise.all(item.windows.map((w) => ipc.closeWindow(w.hwnd))),
    });
  }

  return actions;
}

export function ContextMenu({ settings, edge }: ContextMenuProps) {
  const { kind, item: openItem, anchor, close } = useMenu();
  const item = kind === "menu" ? openItem : null;

  // close on any click outside / Escape
  useEffect(() => {
    if (!item) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".aero-menu")) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // clicks outside the OS window never reach us, so also dismiss when
    // the cursor leaves the window and doesn't come back promptly
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    const onLeave = () => {
      leaveTimer = setTimeout(close, 450);
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
  }, [item, close]);

  const style = anchor ? flyoutStyle(edge, anchor, MENU_WIDTH, 12, 360) : {};
  const bloomFrom = bloomOffset(edge);

  return (
    <AnimatePresence>
      {item && anchor && (
        <motion.div
          className="aero-menu glass"
          style={style}
          initial={{ opacity: 0, scale: 0.82, ...bloomFrom }}
          animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
          exit={{ opacity: 0, scale: 0.94, filter: "blur(6px)", transition: { duration: 0.18 } }}
          transition={springs.bloom}
        >
          {item.windows.length > 1 && (
            <div className="aero-menu-windows">
              {item.windows.slice(0, 6).map((w) => (
                <button
                  key={w.hwnd}
                  className="aero-menu-item aero-menu-window"
                  onClick={() => {
                    ipc.activateWindow(w.hwnd).catch(notify.on("无法激活该窗口"));
                    close();
                  }}
                >
                  <span className="aero-menu-window-title">{w.title}</span>
                </button>
              ))}
              <div className="aero-menu-separator" />
            </div>
          )}
          {buildActions(item, settings).map((action) => (
            <div key={action.label}>
              {action.separatorAbove && <div className="aero-menu-separator" />}
              <button
                className="aero-menu-item"
                data-danger={action.danger}
                onClick={() => {
                  Promise.resolve(action.run()).catch(
                    notify.on(`“${action.label}”执行失败`),
                  );
                  close();
                }}
              >
                {action.label}
              </button>
            </div>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
