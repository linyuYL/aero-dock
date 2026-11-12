/**
 * The widget catalogue.
 *
 * Adding a kind means adding a component and one line here. Nothing else
 * in the desktop layer knows what kinds exist: the frame, the dragging,
 * the materials and the settings list all read from this table.
 */

import type { ComponentType } from "react";
import type { WidgetInstance, WidgetKind } from "../../ipc/types";
import { CalendarWidget } from "./widgets/CalendarWidget";
import { ClockWidget } from "./widgets/ClockWidget";
import { MusicWidget } from "./widgets/MusicWidget";
import { StatsWidget } from "./widgets/StatsWidget";
import { WeatherWidget } from "./widgets/WeatherWidget";

/** Every widget component gets the instance it is rendering. */
export interface WidgetProps {
  widget: WidgetInstance;
  /** Whether the user has allowed the one widget that goes online to do
   *  so. Passed to every widget rather than read globally, so a kind that
   *  needs the network cannot forget to ask. */
  allowNetwork: boolean;
}

export interface WidgetDefinition {
  kind: WidgetKind;
  label: string;
  /** One line for the settings list. */
  description: string;
  component: ComponentType<WidgetProps>;
  /** Smallest size that still reads, in CSS pixels. */
  minWidth: number;
  minHeight: number;
  /** True for anything that leaves the machine. Only weather does. */
  network?: boolean;
}

export const WIDGETS: WidgetDefinition[] = [
  {
    kind: "clock",
    label: "时钟",
    description: "指针或数字时钟，支持流畅走秒",
    component: ClockWidget,
    minWidth: 140,
    minHeight: 140,
  },
  {
    kind: "calendar",
    label: "日历",
    description: "查看本月日期并标出今天",
    component: CalendarWidget,
    minWidth: 210,
    minHeight: 210,
  },
  {
    kind: "weather",
    label: "天气",
    description: "查看指定地点的当前天气",
    component: WeatherWidget,
    minWidth: 200,
    minHeight: 150,
    network: true,
  },
  {
    kind: "systemStats",
    label: "系统状态",
    description: "处理器、内存和运行时间",
    component: StatsWidget,
    minWidth: 190,
    minHeight: 160,
  },
  {
    kind: "music",
    label: "音乐",
    description: "查看 Windows 正在播放的内容并控制播放",
    component: MusicWidget,
    minWidth: 240,
    minHeight: 120,
  },
];

const BY_KIND = new Map(WIDGETS.map((w) => [w.kind, w]));

export function definitionFor(kind: WidgetKind): WidgetDefinition | undefined {
  return BY_KIND.get(kind);
}
