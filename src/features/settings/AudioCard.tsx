/**
 * The volume mixer, mirroring what scrolling a dock icon does.
 *
 * Only apps that currently hold an audio session appear, which is the
 * same rule the Windows mixer follows: an app that is not making sound
 * has no volume to set.
 */

import { useEffect } from "react";
import { ipc } from "../../ipc/commands";
import type { Settings } from "../../ipc/types";
import { useAppAudio } from "../../state/audioStore";
import { AeroSlider } from "./controls";

interface Props {
  settings: Settings;
  onStatus: (tone: "ok" | "error", text: string) => void;
}

export function AudioCard({ settings, onStatus }: Props) {
  const levels = useAppAudio((a) => a.levels);
  const refresh = useAppAudio((a) => a.refresh);
  const setLevel = useAppAudio((a) => a.setLevel);
  const toggleMute = useAppAudio((a) => a.toggleMute);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apps = Object.values(levels).sort((a, b) => a.name.localeCompare(b.name));
  const activeMode = settings.modes.modes.find((m) => m.id === settings.modes.activeId);

  return (
    <section className="settings-card glass">
      <h2>应用音量</h2>
      <p className="settings-note">
        在桌面坞的应用图标上滚动鼠标滚轮可调整音量，按中键可静音，右键可选择输出设备。
      </p>

      {apps.length === 0 ? (
        <p className="settings-note">
          当前没有应用在播放声音。{" "}
          <button className="aero-button-link" onClick={() => void refresh()}>
            重新检查
          </button>
        </p>
      ) : (
        <>
          {apps.map((app) => (
            <div key={app.exe} className="audio-row">
              <AeroSlider
                label={app.name}
                value={app.muted ? 0 : app.volume}
                min={0}
                max={100}
                step={1}
                format={(v) => (app.muted ? "muted" : `${Math.round(v)}%`)}
                onChange={(v) => void setLevel(app.exe, Math.round(v))}
              />
              <button
                className="aero-button"
                onClick={() => void toggleMute(app.exe)}
              >
                {app.muted ? "取消静音" : "静音"}
              </button>
            </div>
          ))}
          <button className="aero-button" onClick={() => void refresh()}>
            刷新
          </button>
        </>
      )}

      {activeMode && (
        <p className="settings-note">
          {activeMode.audio.length === 0
            ? `“${activeMode.name}”尚未保存任何音量设置。调整应用音量后会自动保存。`
            : `“${activeMode.name}”记录了 ${activeMode.audio.length} 个应用的音量，切换到此模式时会恢复。`}
        </p>
      )}

      {!settings.modes.enabled && (
        <p className="settings-note">
          启用模式后可自动恢复这些音量设置。{" "}
          <button
            className="aero-button-link"
            onClick={() =>
              ipc
                .enableModes(true)
                .then(() => onStatus("ok", "已启用模式。"))
                .catch((e) => onStatus("error", `无法启用模式：${e}`))
            }
          >
            启用模式
          </button>
        </p>
      )}
    </section>
  );
}
