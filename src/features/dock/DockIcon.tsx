/**
 * A single dock icon: cursor-distance magnification, hover label,
 * launch bounce, idle float. All motion is springs on transform.
 */

import {
  animate,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { springs } from "../../engine/animation/springs";
import type { DockEdge } from "../../ipc/types";
import type { DockItemView } from "../../state/dockStore";
import { useMenu } from "./menuStore";
import { IconImage } from "./IconImage";

interface DockIconProps {
  item: DockItemView;
  /** Cursor position along the dock axis; Infinity = cursor away. */
  mouseAxis: MotionValue<number>;
  iconSize: number;
  magnify: boolean;
  magScale: number;
  vertical: boolean;
  edge: DockEdge;
  /** A reorder drag is in progress somewhere in the dock. */
  dragging: boolean;
  onLaunch: (item: DockItemView, target?: HTMLElement) => void;
  onContext: (item: DockItemView, target: HTMLElement) => void;
  /** Fired after dwelling on an icon that has open windows. */
  onHoverPreview: (item: DockItemView, target: HTMLElement) => void;
}

const PREVIEW_DWELL_MS = 550;
/** How long a scroll keeps the window previews away. Matches the volume
 *  indicator's own lifetime so the two never overlap. */

function labelFrom(edge: DockEdge): { x: number; y: number } {
  switch (edge) {
    case "bottom":
      return { x: 0, y: 6 };
    case "top":
      return { x: 0, y: -6 };
    case "left":
      return { x: -6, y: 0 };
    case "right":
      return { x: 6, y: 0 };
  }
}

export function DockIcon({
  item,
  mouseAxis,
  iconSize,
  magnify,
  magScale,
  vertical,
  edge,
  dragging,
  onLaunch,
  onContext,
  onHoverPreview,
}: DockIconProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  // a flyout already names what you're pointing at, and the pill would
  // otherwise float over its bottom edge
  const flyoutOpen = useMenu((m) => m.item !== null);
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // distance from cursor to this icon's center along the dock axis
  const distance = useTransform(mouseAxis, (cursor) => {
    const el = ref.current;
    if (!el || !Number.isFinite(cursor)) return Infinity;
    const rect = el.getBoundingClientRect();
    const center = vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
    return cursor - center;
  });

  const reach = iconSize * 2.6;
  const peak = magnify ? magScale : 1;
  const targetWidth = useTransform(distance, [-reach, 0, reach], [
    iconSize,
    iconSize * peak,
    iconSize,
  ]);
  const width = useSpring(targetWidth, springs.magnify);

  // When a drag starts, every icon springs back to its base size. Letting
  // that animate resizes tiles under the cursor mid-drag, which is a big
  // part of what felt like lag, so jump straight to the end value.
  useEffect(() => {
    if (dragging) width.jump(iconSize);
  }, [dragging, iconSize, width]);

  // Launch feedback moves inward from the selected edge.
  const bounce = useMotionValue(0);
  const y = useTransform(bounce, (b) => (vertical ? 0 : b));
  const x = useTransform(bounce, (b) => (vertical ? b : 0));

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (item.windows.length > 1) return;
      clearTimeout(dwellTimer.current);
      animate(bounce, edge === "top" || edge === "left" ? 8 : -8, springs.bounce).then(() =>
        animate(bounce, 0, springs.bounce),
      );
      onLaunch(item, e.currentTarget);
    },
    [bounce, edge, item, onLaunch],
  );

  const initial = item.name.trim().charAt(0).toUpperCase() || "?";

  return (
    <motion.button
      ref={ref}
      className="dock-icon"
      data-multiple-windows={item.windows.length > 1 || undefined}
      style={{ width, height: width, x, y }}
      onClick={handleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(item, e.currentTarget);
      }}
      onMouseEnter={(e) => {
        setHovered(true);
        const m = useMenu.getState();
        if (m.kind === "windows" && m.item?.id === item.id) {
          // back onto the icon that owns the open preview: keep it
          m.cancelScheduledClose();
        } else if (item.windows.length > 0) {
          const el = e.currentTarget;
          dwellTimer.current = setTimeout(() => {
            onHoverPreview(item, el);
          }, PREVIEW_DWELL_MS);
        }
      }}
      onMouseLeave={() => {
        setHovered(false);
        clearTimeout(dwellTimer.current);
        // leaving the icon that owns the open preview: dismiss it soon
        // unless the cursor lands on the flyout itself
        const m = useMenu.getState();
        if (m.kind === "windows" && m.item?.id === item.id) {
          m.scheduleClose(450);
        }
      }}
      aria-label={item.name}
    >
      {hovered &&
        !flyoutOpen &&
        !dragging && (
          <motion.span
            className="dock-label"
            data-edge={edge}
            initial={{ opacity: 0, scale: 0.9, ...labelFrom(edge) }}
            animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
            transition={springs.bloom}
          >
            {item.name}
          </motion.span>
        )}
      <span className="dock-icon-art">
        {item.kind === "stack" && !item.iconSrc ? (
          <span className="dock-stack">
            {item.children.slice(0, 4).map((child, i) =>
              <IconImage key={child.id} src={item.childIcons[i]} fallback={<span className="dock-stack-slot" />} />,
            )}
          </span>
        ) : (
          <IconImage src={item.iconSrc} fallback={<span className="dock-icon-glyph">{initial}</span>} />
        )}
      </span>
      {item.windows.length > 0 && (
        <span className="dock-indicator" data-focused={item.focused} aria-hidden>
          {item.windows.length > 1 ? item.windows.length : ""}
        </span>
      )}
    </motion.button>
  );
}
