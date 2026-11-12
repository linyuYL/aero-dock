/**
 * Managing desktop widgets from the settings window.
 *
 * Every control here goes through a Rust command and comes back as the
 * whole settings struct on `settings://changed`, so nothing is mirrored
 * twice and the overlay redraws itself.
 */

import { useState } from "react";
import { WIDGETS } from "../desktop/registry";
import { ipc } from "../../ipc/commands";
import type { Settings, SurfaceStyle, WidgetInstance, WidgetKind } from "../../ipc/types";
import { AeroSegmented, AeroSlider, AeroToggle } from "./controls";

interface Props {
  settings: Settings;
  onStatus: (tone: "ok" | "error", text: string) => void;
}

const DEFAULT_ACCENT = "#2f9de3";

function WidgetRow({
  widget,
  allowWeather,
  onStatus,
}: {
  widget: WidgetInstance;
  allowWeather: boolean;
  onStatus: Props["onStatus"];
}) {
  const [open, setOpen] = useState(false);
  const def = WIDGETS.find((w) => w.kind === widget.kind);
  const fail = (what: string) => (e: unknown) => onStatus("error", `${what}：${e}`);
  const style = (patch: Parameters<typeof ipc.styleWidget>[1]) =>
    ipc.styleWidget(widget.id, patch).catch(fail("无法更改小组件"));

  const opts = widget.options;

  return (
    <div className="mode-card">
      <div className="mode-card-head">
        <span className="mode-card-glyph">{(def?.label ?? "?").charAt(0)}</span>
        <div className="mode-card-title">
          <strong>{def?.label ?? widget.kind}</strong>
          <span className="mode-card-meta">
            {Math.round(widget.width)} × {Math.round(widget.height)} ·{" "}
            {widget.surface === "liquid" ? "液态玻璃" : "经典玻璃"}
            {widget.locked && "· 已锁定"}
          </span>
        </div>
        <button className="aero-button" onClick={() => setOpen((v) => !v)}>
          {open ? "完成" : "编辑"}
        </button>
      </div>

      {open && (
        <div className="mode-card-edit">
          <AeroSegmented<SurfaceStyle>
            label="材质"
            value={widget.surface}
            options={[
              { value: "aero", label: "经典玻璃" },
              { value: "liquid", label: "液态玻璃" },
            ]}
            onChange={(v) => void style({ surface: v })}
          />
          <AeroSlider
            label="不透明度"
            value={widget.opacity}
            min={0.3}
            max={1}
            step={0.02}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => void style({ opacity: v })}
          />
          <div className="ctl-row">
            <span className="ctl-label">色调</span>
            <div className="ctl-actions">
              <input
                type="color"
                className="ctl-colour"
                aria-label="小组件色调"
                value={widget.accent ?? DEFAULT_ACCENT}
                onChange={(e) => void style({ accent: e.target.value })}
              />
              <button className="aero-button" onClick={() => void style({ accent: null })}>
                使用主题色
              </button>
            </div>
          </div>
          <AeroToggle
            label="气泡效果"
            checked={widget.ambient}
            hint="液态玻璃会折射这些气泡，因为它无法直接采样后方桌面。"
            onChange={(v) => void style({ ambient: v })}
          />
          <AeroToggle
            label="锁定位置"
            checked={widget.locked}
            onChange={(v) => void style({ locked: v })}
          />

          {widget.kind === "clock" && (
            <>
              <AeroSegmented<string>
                label="表盘"
                value={opts.analog ? "analog" : "digital"}
                options={[
                  { value: "analog", label: "指针" },
                  { value: "digital", label: "数字" },
                ]}
                onChange={(v) => void style({ options: { ...opts, analog: v === "analog" } })}
              />
              <AeroToggle
                label="显示秒数"
                checked={opts.seconds}
                onChange={(v) => void style({ options: { ...opts, seconds: v } })}
              />
              <AeroToggle
                label="24 小时制"
                checked={opts.twentyFourHour}
                onChange={(v) => void style({ options: { ...opts, twentyFourHour: v } })}
              />
            </>
          )}

          {widget.kind === "weather" && (
            <>
              <AeroSegmented<string>
                label="单位"
                value={opts.celsius ? "c" : "f"}
                options={[
                  { value: "c", label: "摄氏度" },
                  { value: "f", label: "华氏度" },
                ]}
                onChange={(v) => void style({ options: { ...opts, celsius: v === "c" } })}
              />
              <label className="ctl-row">
                <span className="ctl-label">地点名称</span>
                <input
                  className="ctl-text"
                  defaultValue={opts.place ?? ""}
                  placeholder="显示在温度下方"
                  onBlur={(e) => void style({ options: { ...opts, place: e.target.value || null } })}
                />
              </label>
              <div className="ctl-row">
                <span className="ctl-label">纬度、经度</span>
                <div className="ctl-actions">
                  <input
                    className="ctl-text ctl-text-short"
                    defaultValue={opts.latitude ?? ""}
                    placeholder="51.5"
                    aria-label="纬度"
                    onBlur={(e) =>
                      void style({
                        options: {
                          ...opts,
                          latitude: e.target.value.trim() === "" ? null : Number(e.target.value),
                        },
                      })
                    }
                  />
                  <input
                    className="ctl-text ctl-text-short"
                    defaultValue={opts.longitude ?? ""}
                    placeholder="-0.13"
                    aria-label="经度"
                    onBlur={(e) =>
                      void style({
                        options: {
                          ...opts,
                          longitude: e.target.value.trim() === "" ? null : Number(e.target.value),
                        },
                      })
                    }
                  />
                </div>
              </div>
              {!allowWeather && (
                <p className="settings-note">
                  允许联网之前，天气小组件不会发送请求。
                </p>
              )}
            </>
          )}

          <div className="mode-card-actions">
            <button
              className="aero-button aero-button-danger"
              onClick={() =>
                ipc
                  .removeWidget(widget.id)
                  .then(() => onStatus("ok", `已移除${def?.label ?? "小组件"}。`))
                  .catch(fail("无法移除小组件"))
              }
            >
              移除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function WidgetsCard({ settings, onStatus }: Props) {
  const w = settings.widgets;
  const fail = (what: string) => (e: unknown) => onStatus("error", `${what}：${e}`);
  const hasWeather = w.widgets.some((x) => x.kind === "weather");

  return (
    <section className="settings-card glass">
      <h2>桌面小组件</h2>
      <AeroToggle
        label="在桌面上显示小组件"
        checked={w.enabled}
        hint="在壁纸上显示可拖动的玻璃小组件"
        onChange={(v) =>
          ipc
            .enableWidgets(v)
            .then(() =>
              onStatus("ok", v ? "已显示桌面小组件。" : "已关闭桌面小组件。"),
            )
            .catch(fail("无法更改小组件设置"))
        }
      />

      {w.enabled && (
        <>
          <p className="settings-note">
            拖动小组件可移动位置，拖动右下角可调整大小。桌面的其他区域可以照常使用。
          </p>

          <div className="mode-list">
            {w.widgets.map((widget) => (
              <WidgetRow
                key={widget.id}
                widget={widget}
                allowWeather={w.allowWeatherNetwork}
                onStatus={onStatus}
              />
            ))}
          </div>

          <div className="ctl-row ctl-row-stacked">
            <span className="ctl-label">添加小组件</span>
            <div className="widget-add">
              {WIDGETS.map((def) => (
                <button
                  key={def.kind}
                  className="aero-button"
                  title={def.description}
                  onClick={() =>
                    ipc
                      .addWidget(def.kind as WidgetKind)
                      .then(() => onStatus("ok", `已添加${def.label}。`))
                      .catch(fail("无法添加小组件"))
                  }
                >
                  {def.label}
                </button>
              ))}
            </div>
          </div>

          <AeroToggle
            label="允许天气小组件联网"
            checked={w.allowWeatherNetwork}
            hint="Aero Dock 的其他功能不会发送网络请求"
            onChange={(v) =>
              ipc
                .allowWeatherNetwork(v)
                .then(() =>
                  onStatus(
                    "ok",
                    v ? "天气小组件现在可以获取天气信息。" : "天气小组件已停止联网。",
                  ),
                )
                .catch(fail("无法更改设置"))
            }
          />
          <p className="settings-note">
            开启后，天气小组件会把你设置的坐标发送给 Open-Meteo 查询天气。它不会发送其他信息，也无需账户或密钥。其余功能均可离线使用
            {hasWeather ? "." : "，目前桌面上还没有天气小组件。"}
          </p>
        </>
      )}
    </section>
  );
}
