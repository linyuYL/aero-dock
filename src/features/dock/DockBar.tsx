/**
 * The dock bar: a row of app icons. Owns the cursor motion value the
 * icons magnify against, drag-reordering of the pinned section, and the
 * deterministic window-size report to Rust, with room for flyouts reserved
 * so opening a preview does not resize the transparent window.
 */

import { AnimatePresence, motion, Reorder, useMotionValue } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { springs } from "../../engine/animation/springs";
import { ipc } from "../../ipc/commands";
import { Toasts } from "../feedback/Toasts";
import { notify, useToasts } from "../feedback/toastStore";
import type { Settings } from "../../ipc/types";
import type { DockItemView } from "../../state/dockStore";
import { useAmbient } from "../../state/ambientStore";
import { useFileDrag } from "../../state/dragStore";
import { Welcome } from "../onboarding/Welcome";
import { ContextMenu } from "./ContextMenu";
import { DockIcon } from "./DockIcon";
import { FolderFlyout } from "./FolderFlyout";
import { StackFlyout } from "./StackFlyout";
import { WindowsFlyout } from "./WindowsFlyout";
import { anchorFor, useMenu } from "./menuStore";
import "./dock.css";

const GAP = 6;
const PAD_MAIN = 18; // dock padding along the axis
const PAD_CROSS = 10; // dock padding across the axis
const LABEL_SPACE = 44; // tooltip pill above icons (horizontal dock)
const LABEL_SPACE_SIDE = 150; // tooltip pill beside icons (vertical dock)
const EDGE_SLACK = 24; // window slack so magnified end-icons never clip
const MENU_SPACE = 460; // extra cross-axis room while a context menu is open
const TOAST_SPACE = 210; // extra cross-axis room while toasts are on screen
const REVEAL_STRIP = 8; // window height while auto-hidden (mouse sensor)
// fallback only; the real delay is settings.dock.autoHideDelayMs
const HIDE_ANIM_MS = 380;
// ambient animations (float, sweep) pause after this much no-interaction
// so an idle dock costs ~zero GPU; they wake the moment the cursor returns
const SLEEP_AFTER_MS = 45_000;

interface DockBarProps {
  settings: Settings;
  items: DockItemView[];
  onLaunch: (item: DockItemView) => void;
}

export function DockBar({ settings, items, onLaunch }: DockBarProps) {
  const { edge, iconSize, magnification, magnificationScale } = settings.dock;
  const vertical = edge === "left" || edge === "right";
  const mouseAxis = useMotionValue(Infinity);
  const menu = useMenu();
  const draggingRef = useRef(false);

  const pinnedItems = useMemo(() => items.filter((i) => i.pinned), [items]);
  const runningItems = useMemo(() => items.filter((i) => !i.pinned), [items]);

  // Local order during a drag; resynced from settings between drags.
  const [order, setOrder] = useState<string[]>(() => pinnedItems.map((i) => i.id));
  useEffect(() => {
    if (!draggingRef.current) setOrder(pinnedItems.map((i) => i.id));
  }, [pinnedItems]);

  const orderedPinned = useMemo(() => {
    const byId = new Map(pinnedItems.map((i) => [i.id, i]));
    const seq = order.map((id) => byId.get(id)).filter(Boolean) as DockItemView[];
    for (const item of pinnedItems) if (!order.includes(item.id)) seq.push(item);
    return seq;
  }, [order, pinnedItems]);

  const peak = magnification ? magnificationScale : 1;
  const welcomeOpen = !settings.onboardingComplete && pinnedItems.length === 0;
  const menuOpen = menu.item !== null || welcomeOpen;
  // toasts sit in the band above the dock, which is only tall enough for a
  // tooltip — without extra room the window would clip them
  const toastCount = useToasts((s) => s.items.length);

  // ---- auto-hide state machine ----
  // hidden=false + hover/menu keeps it visible; idle slides it out,
  // then the window shrinks to a reveal strip; any mouse contact with
  // the strip brings it back.
  const [hidden, setHidden] = useState(false);
  const [windowShrunk, setWindowShrunk] = useState(false);
  const [pointerInside, setPointerInside] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shrinkTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A file drag aimed at the dock must not make it slide away.
  const fileDragOver = useFileDrag((s) => s.overDock);

  // ambient-motion sleep: cheap idle, alive on approach
  const asleep = useAmbient((s) => s.asleep);
  const setAsleep = useAmbient((s) => s.setAsleep);
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(sleepTimer.current);
    if (pointerInside || menuOpen || fileDragOver) {
      setAsleep(false);
      return;
    }
    sleepTimer.current = setTimeout(() => setAsleep(true), SLEEP_AFTER_MS);
    return () => clearTimeout(sleepTimer.current);
  }, [pointerInside, menuOpen, fileDragOver, setAsleep]);

  // Asleep is also when the dock hands memory back. Chromium keeps its
  // raster caches until told otherwise; on a real desktop this took the
  // GPU process from about 125 MB to about 61 MB. Waking restores normal
  // behaviour before the cursor can notice.
  useEffect(() => {
    ipc.setMemorySaver(asleep).catch((e) => console.debug("memory saver unavailable", e));
  }, [asleep]);

  const autoHide = settings.dock.autoHide;
  const autoHideDelay = settings.dock.autoHideDelayMs;
  useEffect(() => {
    clearTimeout(hideTimer.current);
    clearTimeout(shrinkTimer.current);
    if (!autoHide) {
      setHidden(false);
      setWindowShrunk(false);
      return;
    }
    if (pointerInside || menuOpen || fileDragOver) {
      setHidden(false);
      setWindowShrunk(false);
      return;
    }
    hideTimer.current = setTimeout(() => {
      setHidden(true);
      // shrink the OS window only after the slide-out finishes
      shrinkTimer.current = setTimeout(() => setWindowShrunk(true), HIDE_ANIM_MS);
    }, autoHideDelay);
    return () => {
      clearTimeout(hideTimer.current);
      clearTimeout(shrinkTimer.current);
    };
  }, [autoHide, pointerInside, menuOpen, fileDragOver, autoHideDelay]);

  // Deterministic window size: no ResizeObserver, no feedback loops.
  const windowSize = useMemo(() => {
    const n = Math.max(items.length, 1);
    const dividers = runningItems.length > 0 ? 1 : 0;
    const mainBase = n * iconSize + (n - 1 + dividers) * GAP + dividers * 8 + PAD_MAIN * 2;
    // neighbors near the cursor grow too; ~2.5 icons' worth covers the worst case
    const mainGrowth = iconSize * (peak - 1) * 2.5;
    const main = Math.max(mainBase + mainGrowth + EDGE_SLACK, items.length === 0 ? 180 : 0);
    const label = vertical ? LABEL_SPACE_SIDE : LABEL_SPACE;
    const band = iconSize * peak + PAD_CROSS * 2 + label;
    const fullMain = Math.max(main, 460);
    const fullCross = band + MENU_SPACE;
    const visibleMain = menuOpen ? fullMain : main;
    const visibleCross = windowShrunk ? REVEAL_STRIP
      : menuOpen ? fullCross : band + (toastCount > 0 ? TOAST_SPACE : 0);
    return vertical
      ? { width: fullCross, height: fullMain, visibleWidth: visibleCross, visibleHeight: visibleMain }
      : { width: fullMain, height: fullCross, visibleWidth: visibleMain, visibleHeight: visibleCross };
  }, [
    items.length,
    runningItems.length,
    iconSize,
    peak,
    vertical,
    menuOpen,
    toastCount,
    windowShrunk,
  ]);

  const { width, height, visibleWidth, visibleHeight } = windowSize;
  useEffect(() => {
    ipc.resizeDock(width, height, visibleWidth, visibleHeight).catch((e) => {
      // geometry is re-sent on every layout change; a single miss is
      // self-healing, so log it rather than interrupting the user
      console.warn("resize_dock failed", e);
    });
  }, [width, height, visibleWidth, visibleHeight]);

  const handleMove = useCallback(
    (e: React.MouseEvent) => {
      if (!draggingRef.current) mouseAxis.set(vertical ? e.clientY : e.clientX);
    },
    [mouseAxis, vertical],
  );

  const handleLeave = useCallback(() => {
    mouseAxis.set(Infinity);
  }, [mouseAxis]);

  const openMenu = useCallback(
    (item: DockItemView, target: HTMLElement) => {
      menu.open("menu", item, anchorFor(target));
    },
    [menu],
  );

  const launchGuarded = useCallback(
    (item: DockItemView, target?: HTMLElement) => {
      if (draggingRef.current) return;
      if (item.kind === "folder" && target) {
        menu.open("folder", item, anchorFor(target));
        return;
      }
      if (item.kind === "stack" && target) {
        menu.open("stack", item, anchorFor(target));
        return;
      }
      onLaunch(item);
    },
    [onLaunch, menu],
  );

  const openPreview = useCallback(
    (item: DockItemView, target: HTMLElement) => {
      if (!draggingRef.current) menu.open("windows", item, anchorFor(target));
    },
    [menu],
  );

  const iconProps = {
    mouseAxis,
    iconSize,
    magnify: magnification,
    magScale: magnificationScale,
    vertical,
    edge,
    dragging,
    onLaunch: launchGuarded,
    onContext: openMenu,
    onHoverPreview: openPreview,
  };

  const slideOut = vertical
    ? { x: edge === "left" ? "-118%" : "118%", y: 0 }
    : { y: edge === "top" ? "-118%" : "118%", x: 0 };

  return (
    <div
      className="dock-viewport"
      data-edge={edge}
      style={{
        "--icon-size": iconSize + "px",
        "--reflection-strength": settings.appearance.reflectionStrength,
      } as React.CSSProperties}
      onMouseEnter={() => setPointerInside(true)}
      onMouseLeave={() => setPointerInside(false)}
    >
      <motion.div
        className="dock-bar"
        data-vertical={vertical}
        animate={hidden ? { ...slideOut, opacity: 0.6 } : { x: 0, y: 0, opacity: 1 }}
        transition={springs.slide}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
        <Reorder.Group
          as="div"
          className="dock-section"
          axis={vertical ? "y" : "x"}
          values={order}
          onReorder={setOrder}
        >
          {orderedPinned.map((item) => (
            <Reorder.Item
              as="div"
              key={item.id}
              value={item.id}
              /* Only the siblings animate. Momentum and elasticity both
                 make the dragged tile trail the cursor, which is what
                 read as lag, so the tile itself tracks 1:1. */
              transition={springs.reorder}
              dragMomentum={false}
              dragElastic={0.04}
              whileDrag={{ zIndex: 30 }}
              onDragStart={() => {
                draggingRef.current = true;
                setDragging(true);
                mouseAxis.set(Infinity);
              }}
              onDragEnd={() => {
                ipc.reorderPinned(order).catch(notify.on("无法保存新顺序"));
                setDragging(false);
                // let the trailing click event pass before re-enabling launch
                setTimeout(() => {
                  draggingRef.current = false;
                }, 50);
              }}
            >
              <DockIcon item={item} {...iconProps} />
            </Reorder.Item>
          ))}
        </Reorder.Group>
        {runningItems.length > 0 && <span className="dock-divider" aria-hidden />}
        {runningItems.map((item) => (
          <DockIcon key={item.id} item={item} {...iconProps} />
        ))}
        {items.length === 0 && !welcomeOpen && (
          <div className="dock-drop-target">拖入应用快捷方式</div>
        )}
      </motion.div>
      <ContextMenu settings={settings} edge={edge} />
      <FolderFlyout edge={edge} />
      <StackFlyout edge={edge} />
      <WindowsFlyout edge={edge} />
      <Toasts edge={edge} />
      <AnimatePresence>{welcomeOpen && <Welcome edge={edge} />}</AnimatePresence>
    </div>
  );
}
