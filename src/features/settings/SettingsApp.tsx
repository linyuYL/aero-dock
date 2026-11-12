/**
 * The settings window: a Frutiger Aero control panel. Every change goes
 * through the settings store → Rust → broadcast, so the dock restyles
 * live while you drag a slider.
 */

import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect, useRef, useState } from "react";
import { ipc } from "../../ipc/commands";
import type {
  DockEdge,
  MonitorInfoEx,
  Settings,
  StorageInfo,
} from "../../ipc/types";
import { useSettings } from "../../state/settingsStore";
import { KOFI_URL, REPO_URL } from "../../links";
import { AeroSegmented, AeroSlider, AeroToggle } from "./controls";
import { PinsCard } from "./PinsCard";
import "./settings.css";


const pctFmt = (v: number) => `${Math.round(v * 100)}%`;

/** One inline status line under the settings-file controls. The window
 * has room to say what happened, so nothing here needs a modal. */
interface Status {
  tone: "ok" | "error";
  text: string;
}

export function SettingsApp() {
  const { settings, hydrate, apply } = useSettings();
  const [status, setStatus] = useState<Status | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfoEx[]>([]);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const [hydrateFailed, setHydrateFailed] = useState(false);
  useEffect(() => {
    hydrate().catch((e) => {
      console.error("settings hydrate failed", e);
      setHydrateFailed(true);
    });
    ipc
      .listMonitors()
      .then(setMonitors)
      .catch((e) => console.warn("monitor list unavailable", e));
    ipc
      .storageInfo()
      .then(setStorage)
      .catch((e) => console.warn("storage info unavailable", e));
  }, [hydrate]);

  if (!settings) {
    return (
      <div className="settings-root settings-root-centered">
        {hydrateFailed ? (
          <div className="settings-splash">
            <span className="settings-orb" aria-hidden />
            <p>Aero Dock 无法读取设置。</p>
            <p className="settings-splash-hint">
              请关闭此窗口，再从系统托盘重启 Aero Dock。
            </p>
          </div>
        ) : (
          <div className="settings-splash">
            <span className="settings-orb settings-orb-pulse" aria-hidden />
            <p>正在加载桌面坞…</p>
          </div>
        )}
      </div>
    );
  }
  const { dock, appearance } = settings;

  const set = (fn: (draft: Settings) => void) => {
    apply(fn).catch((e) => {
      console.error("settings update failed", e);
      setStatus({ tone: "error", text: `无法保存更改：${e}` });
    });
  };

  const toggleStartup = async (on: boolean) => {
    try {
      if (on) await enable();
      else await disable();
      const actual = await isEnabled();
      set((d) => {
        d.launchAtStartup = actual;
      });
    } catch (e) {
      console.error("autostart toggle failed", e);
      setStatus({ tone: "error", text: `无法更改启动设置：${e}` });
    }
  };

  const doImport = async (file: File) => {
    try {
      const json = await file.text();
      await ipc.importSettings(json);
      setStatus({ tone: "ok", text: `已从 ${file.name} 导入设置。` });
    } catch (e) {
      console.error("import failed", e);
      setStatus({ tone: "error", text: `无法导入该文件：${e}` });
    }
  };

  const openLink = (url: string) =>
    ipc
      .launch(url)
      .catch((e) => setStatus({ tone: "error", text: `无法打开浏览器：${e}` }));

  return (
    <div className="settings-root">
      <header className="settings-header">
        <div>
          <p className="settings-kicker">AERO DOCK</p>
          <h1>设置</h1>
          <p>调整应用入口的位置、大小和交互。</p>
        </div>
        <button
          className="settings-support-chip"
          title="在 Ko-fi 上支持 Aero Dock"
          onClick={() => void openLink(KOFI_URL)}
        >
          <span aria-hidden>☕</span>
          支持项目
        </button>
      </header>

      <main className="settings-scroll">
        <PinsCard pins={settings.pinned} />
        {/* ---- dock ---- */}
        <section className="settings-card">
          <h2>桌面坞</h2>
          <AeroSegmented<DockEdge>
            label="位置"
            value={dock.edge}
            options={[
              { value: "bottom", label: "底部" },
              { value: "top", label: "顶部" },
              { value: "left", label: "左侧" },
              { value: "right", label: "右侧" },
            ]}
            onChange={(edge) => set((d) => void (d.dock.edge = edge))}
          />
          {monitors.length > 1 && (
            <AeroSegmented<string>
              label="显示器"
              value={dock.monitor ?? ""}
              options={monitors.map((m) => ({
                value: m.isPrimary ? "" : m.name,
                label: `${m.name.replace(/^\\\\\.\\/, "")}${m.isPrimary ? "（主显示器）" : ""}`,
              }))}
              onChange={(name) => set((d) => void (d.dock.monitor = name || null))}
            />
          )}
          <AeroSlider
            label="图标大小"
            value={dock.iconSize}
            min={32}
            max={80}
            step={2}
            format={(v) => `${v}px`}
            onChange={(v) => set((d) => void (d.dock.iconSize = v))}
          />
          <AeroToggle
            label="悬停放大"
            checked={dock.magnification}
            onChange={(v) => set((d) => void (d.dock.magnification = v))}
          />
          {dock.magnification && (
            <AeroSlider
              label="放大幅度"
              value={dock.magnificationScale}
              min={1.1}
              max={1.9}
              step={0.05}
              format={(v) => `${Math.round((v - 1) * 100)}%`}
              onChange={(v) => set((d) => void (d.dock.magnificationScale = v))}
            />
          )}
          <AeroSlider
            label="图标倒影"
            value={appearance.reflectionStrength}
            min={0}
            max={1}
            format={pctFmt}
            onChange={(v) => set((d) => void (d.appearance.reflectionStrength = v))}
          />
          <AeroToggle
            label="浮动（与屏幕边缘留出间距）"
            checked={dock.floating}
            onChange={(v) => set((d) => void (d.dock.floating = v))}
          />
          <AeroToggle
            label="显示运行中的应用"
            checked={dock.showRunningApps}
            onChange={(v) => set((d) => void (d.dock.showRunningApps = v))}
          />
          <AeroToggle
            label="自动隐藏桌面坞"
            checked={dock.autoHide}
            hint="将鼠标移到屏幕边缘即可唤回桌面坞"
            onChange={(v) => set((d) => void (d.dock.autoHide = v))}
          />
          {dock.autoHide && (
            <AeroSlider
              label="隐藏延迟"
              value={dock.autoHideDelayMs}
              min={200}
              max={5000}
              step={100}
              format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} 秒` : `${v} 毫秒`)}
              onChange={(v) => set((d) => void (d.dock.autoHideDelayMs = v))}
            />
          )}
        </section>

        {/* ---- behavior ---- */}
        <section className="settings-card">
          <h2>行为</h2>
          <AeroToggle
            label="登录 Windows 时启动 Aero Dock"
            checked={settings.launchAtStartup}
            onChange={toggleStartup}
          />
          <AeroToggle
            label="隐藏 Windows 任务栏"
            checked={settings.hideTaskbar}
            hint="将 Windows 任务栏设为自动隐藏，退出 Aero Dock 时恢复。"
            onChange={(v) => {
              ipc.setTaskbarHidden(v).catch((e) => {
                console.error("taskbar toggle failed", e);
                setStatus({ tone: "error", text: `无法更改任务栏设置：${e}` });
              });
              set((d) => void (d.hideTaskbar = v));
            }}
          />
          <div className="ctl-row">
            <span className="ctl-label">设置文件</span>
            <div className="ctl-actions">
              <button
                className="aero-button"
                onClick={() =>
                  ipc
                    .exportSettingsFile()
                    .then((path) => setStatus({ tone: "ok", text: `已保存到 ${path}` }))
                    .catch((e) => {
                      console.error("export failed", e);
                      setStatus({ tone: "error", text: `无法导出设置：${e}` });
                    })
                }
              >
                导出…
              </button>
              <button className="aero-button" onClick={() => importRef.current?.click()}>
                导入…
              </button>
              <input
                ref={importRef}
                type="file"
                accept=".json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) doImport(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
          <div className="ctl-row">
            <span className="ctl-label">退出 Aero Dock</span>
            <div className="ctl-actions">
              <button
                className="aero-button aero-button-danger"
                onClick={() =>
                  ipc
                    .quitApp()
                    .catch((e) =>
                      setStatus({ tone: "error", text: `无法退出：${e}` }),
                    )
                }
              >
                退出
              </button>
            </div>
          </div>
          <p className="settings-note">
            也可以通过右键点击 Aero Dock 托盘图标退出。
          </p>
          {status && (
            <p className="settings-note" data-tone={status.tone} role="status">
              {status.text}
            </p>
          )}
        </section>

        {/* ---- about ---- */}
        <section className="settings-card">
          <h2>关于</h2>
          <div className="ctl-row">
            <span className="ctl-label">版本</span>
            <span className="settings-about-value">Aero Dock {__APP_VERSION__}</span>
          </div>
          {storage && (
            <>
              <div className="ctl-row">
                <span className="ctl-label">存储方式</span>
                <span className="settings-about-value">
                  {storage.portable ? "便携版" : "安装版"}
                </span>
              </div>
              <p className="settings-note settings-path">{storage.dataDir}</p>
            </>
          )}
          <div className="ctl-row">
            <span className="ctl-label">项目</span>
            <div className="ctl-actions">
              <button className="aero-button" onClick={() => void openLink(REPO_URL)}>
                在 GitHub 上查看
              </button>
              <button className="aero-button" onClick={() => void openLink(KOFI_URL)}>
                在 Ko-fi 上支持
              </button>
            </div>
          </div>
        </section>

        <footer className="settings-footer">
          Aero Dock {__APP_VERSION__}
        </footer>
      </main>
    </div>
  );
}
