/**
 * Managing Dock Modes from the settings window.
 *
 * A mode owns its pins, its saved window layout and its per-app volumes.
 * Everything here goes through a Rust command and comes back as the full
 * settings struct on `settings://changed`, so nothing is mirrored twice.
 */

import { useState } from "react";
import { ipc } from "../../ipc/commands";
import type { DockMode, Settings } from "../../ipc/types";
import { ModeIconPicker, isPictorial, resolveGlyph } from "./ModeIconPicker";
import { AeroToggle } from "./controls";

interface Props {
  settings: Settings;
  onStatus: (tone: "ok" | "error", text: string) => void;
}

/** "just now", "12 minutes ago", "3 days ago". */
function savedAgo(capturedAt: number): string {
  if (capturedAt === 0) return "尚未保存";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - capturedAt);
  if (seconds < 60) return "刚刚保存";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前保存`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前保存`;
  const days = Math.floor(hours / 24);
  return `${days} 天前保存`;
}

function ModeRow({
  mode,
  active,
  onStatus,
}: {
  mode: DockMode;
  active: boolean;
  onStatus: Props["onStatus"];
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(mode.name);
  const [glyph, setGlyph] = useState(mode.glyph);
  const [apps, setApps] = useState(mode.autoSwitchApps.join(", "));

  const fail = (what: string) => (e: unknown) => onStatus("error", `${what}：${e}`);

  return (
    <div className="mode-card" data-active={active}>
      <div className="mode-card-head">
        <span
          className="mode-card-glyph"
          data-emoji={isPictorial(resolveGlyph(mode.name, mode.glyph))}
        >
          {resolveGlyph(mode.name, mode.glyph)}
        </span>
        <div className="mode-card-title">
          <strong>{mode.name}</strong>
          <span className="mode-card-meta">
            {mode.pinned.length} 个固定项目 · {mode.workspace.windows.length} 个窗口 ·{" "}
            {mode.audio.length} volumes
          </span>
        </div>
        {active ? (
          <span className="mode-card-badge">使用中</span>
        ) : (
          <button
            className="aero-button"
            onClick={() =>
              ipc
                .switchMode(mode.id)
                .then((r) => onStatus("ok", `已切换到“${r.modeName}”。`))
                .catch(fail("无法切换模式"))
            }
          >
            切换到此模式
          </button>
        )}
      </div>

      <p className="settings-note">Workspace: {savedAgo(mode.workspace.capturedAt)}</p>

      <div className="mode-card-actions">
        <button
          className="aero-button"
          onClick={() =>
            ipc
              .captureWorkspace(mode.id)
              .then(() => onStatus("ok", `已将打开的窗口保存到“${mode.name}”。`))
              .catch(fail("无法保存工作区"))
          }
        >
          保存窗口
        </button>
        <button
          className="aero-button"
          disabled={mode.workspace.windows.length === 0}
          onClick={() =>
            ipc
              .restoreWorkspace(mode.id)
              .then((r) =>
                onStatus(
                  "ok",
                  `已摆放 ${r.moved} 个窗口` +
                    (r.launched > 0 ? `，已打开 ${r.launched} 个应用` : "") +
                    (r.missing > 0 ? `，${r.missing} 个窗口无法恢复` : "") +
                    ".",
                ),
              )
              .catch(fail("无法恢复工作区"))
          }
        >
          恢复窗口
        </button>
        <button
          className="aero-button"
          disabled={mode.workspace.windows.length === 0}
          onClick={() =>
            ipc
              .clearWorkspace(mode.id)
              .then(() => onStatus("ok", `已清除“${mode.name}”保存的窗口。`))
              .catch(fail("无法清除工作区"))
          }
        >
          清除
        </button>
        <button className="aero-button" onClick={() => setEditing((v) => !v)}>
          {editing ? "完成" : "编辑"}
        </button>
      </div>

      {editing && (
        <div className="mode-card-edit">
          <label className="ctl-row">
            <span className="ctl-label">名称</span>
            <input
              className="ctl-text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() =>
                ipc
                  .renameMode(mode.id, name, glyph)
                  .catch(fail("无法重命名"))
              }
            />
          </label>
          <div className="mode-icon-field">
            <span className="ctl-label">磁贴图标</span>
            <ModeIconPicker
              name={name}
              glyph={glyph}
              onChange={(next) => {
                setGlyph(next);
                ipc.renameMode(mode.id, name, next).catch(fail("无法保存图标"));
              }}
            />
          </div>
          <label className="ctl-row ctl-row-stacked">
            <span className="ctl-label">为这些应用切换到此模式</span>
            <input
              className="ctl-text"
              value={apps}
              placeholder="code.exe, slack.exe"
              onChange={(e) => setApps(e.target.value)}
              onBlur={() =>
                ipc
                  .setModeApps(
                    mode.id,
                    apps
                      .split(",")
                      .map((a) => a.trim())
                      .filter(Boolean),
                  )
                  .catch(fail("无法保存应用列表"))
              }
            />
          </label>
          <p className="settings-note">
            用逗号分隔可执行文件名。开启自动切换后，将其中一个应用切到前台就会切换到此模式。
          </p>
          <div className="mode-card-actions">
            <button
              className="aero-button aero-button-danger"
              onClick={() =>
                ipc
                  .deleteMode(mode.id)
                  .then(() => onStatus("ok", `已删除“${mode.name}”。`))
                  .catch(fail("无法删除模式"))
              }
            >
              删除模式
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ModesCard({ settings, onStatus }: Props) {
  const [newName, setNewName] = useState("");
  const modes = settings.modes;

  return (
    <section className="settings-card glass">
      <h2>模式</h2>
      <AeroToggle
        label="使用模式"
        checked={modes.enabled}
        hint="每个模式分别保存固定应用、窗口布局和应用音量"
        onChange={(v) =>
          ipc
            .enableModes(v)
            .then(() =>
              onStatus(
                "ok",
                v
                  ? "已启用模式，当前桌面坞已保存为第一个模式。"
                  : "已关闭模式，桌面坞保留当前显示的固定项目。",
              ),
            )
            .catch((e) => onStatus("error", `无法更改模式设置：${e}`))
        }
      />

      {modes.enabled && (
        <>
          <AeroToggle
            label="切换时也恢复窗口布局"
            checked={modes.restoreWorkspaceOnSwitch}
            hint="移动现有窗口并重新打开已关闭的应用，以恢复该模式的布局"
            onChange={(v) =>
              ipc
                .setRestoreWorkspaceOnSwitch(v)
                .catch((e) => onStatus("error", `无法更改设置：${e}`))
            }
          />
          <AeroToggle
            label="按应用自动切换"
            checked={modes.autoSwitch}
            hint="将应用切到前台时，自动切换到为该应用指定的模式"
            onChange={(v) =>
              ipc
                .setAutoSwitch(v)
                .catch((e) => onStatus("error", `无法更改设置：${e}`))
            }
          />
          {modes.autoSwitch && (
            <p className="settings-note">
              自动切换只会更改固定项目和音量。当前窗口位置保持不变。
            </p>
          )}

          <div className="mode-list">
            {modes.modes.map((mode) => (
              <ModeRow
                key={mode.id}
                mode={mode}
                active={mode.id === modes.activeId}
                onStatus={onStatus}
              />
            ))}
          </div>

          <div className="ctl-row">
            <span className="ctl-label">新建模式</span>
            <div className="ctl-actions">
              <input
                className="ctl-text ctl-text-mid"
                value={newName}
                placeholder="游戏"
                onChange={(e) => setNewName(e.target.value)}
              />
              <button
                className="aero-button"
                disabled={!newName.trim()}
                onClick={() =>
                  ipc
                    .createMode(newName.trim(), null, false)
                    .then(() => {
                      onStatus("ok", `已添加“${newName.trim()}”。`);
                      setNewName("");
                    })
                    .catch((e) => onStatus("error", `无法添加模式：${e}`))
                }
              >
                添加空白模式
              </button>
              <button
                className="aero-button"
                disabled={!newName.trim()}
                onClick={() =>
                  ipc
                    .createMode(newName.trim(), null, true)
                    .then(() => {
                      onStatus("ok", `已用当前固定项目创建“${newName.trim()}”。`);
                      setNewName("");
                    })
                    .catch((e) => onStatus("error", `无法添加模式：${e}`))
                }
              >
                复制当前模式
              </button>
            </div>
          </div>
          <p className="settings-note">
            新模式默认使用名称的首字作为图标。点击 <strong>编辑</strong> 即可更换图标。
          </p>
        </>
      )}
    </section>
  );
}
