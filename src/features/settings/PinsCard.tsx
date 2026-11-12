import { useState } from "react";
import type { FormEvent } from "react";
import { ipc } from "../../ipc/commands";
import type { PinnedItem } from "../../ipc/types";
import { customIconKey } from "../../state/dockStore";

const kinds = {
  app: "应用程序（.exe）",
  website: "网页",
  shortcut: "快捷方式（.lnk / .url）",
  folder: "文件夹",
  file: "文件",
};

type Kind = keyof typeof kinds;
const newItem = { kind: "app" as Kind, target: "", name: "" };

export function PinsCard({ pins }: { pins: PinnedItem[] }) {
  const [draft, setDraft] = useState<typeof newItem | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const entries = pins.flatMap((pin) => [pin, ...pin.children]);

  async function run(operation: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await operation();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy) return;
    void run(async () => {
      await ipc.importPin(crypto.randomUUID(), draft.kind, draft.target, draft.name);
      setDraft(null);
    });
  }

  function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renaming || busy) return;
    void run(async () => {
      await ipc.renamePin(renaming.id, renaming.name);
      setRenaming(null);
    });
  }

  return (
    <section className="settings-card">
      <header className="pins-header">
        <h2>固定项目</h2>
        {!draft && (
          <button className="aero-button pins-primary" disabled={busy} onClick={() => {
            setError("");
            setDraft(newItem);
          }}>
            导入项目
          </button>
        )}
      </header>
      {draft && (
        <form className="pins-form" onSubmit={add}>
          <label htmlFor="pin-kind">项目类型</label>
          <select id="pin-kind" value={draft.kind} disabled={busy} onChange={(event) => {
            setDraft({ ...draft, kind: event.currentTarget.value as Kind, target: "" });
            setError("");
          }}>
            {Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <label htmlFor="pin-target">{draft.kind === "website" ? "网址" : "路径"}</label>
          <div className="pins-target">
            <input id="pin-target" value={draft.target} required disabled={busy}
              placeholder={draft.kind === "website" ? "https://example.com" : "选择项目或粘贴完整路径"}
              onChange={(event) => setDraft({ ...draft, target: event.currentTarget.value })} />
            {draft.kind !== "website" && (
              <button type="button" className="aero-button" disabled={busy} onClick={() => void run(async () => {
                const target = await ipc.pickPinPath(draft.kind === "folder");
                if (target) setDraft({ ...draft, target });
              })}>
                浏览…
              </button>
            )}
          </div>
          <label htmlFor="pin-name">显示名称</label>
          <input id="pin-name" value={draft.name} disabled={busy} maxLength={100} placeholder="留空则使用原名称"
            onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} />
          <div className="pins-form-actions">
            <button type="button" className="aero-button" disabled={busy} onClick={() => {
              setDraft(null);
              setError("");
            }}>取消</button>
            <button className="aero-button pins-primary" disabled={busy}>添加到桌面坞</button>
          </div>
        </form>
      )}
      {error && <p className="settings-note" data-tone="error" role="alert">{error}</p>}
      {entries.length === 0 && <p className="settings-note">还没有固定项目。</p>}
      {entries.map((item) => (
        <div className="pins-row" key={item.id}>
          {renaming?.id === item.id ? (
            <form className="pins-rename" onSubmit={rename}>
              <input aria-label="新的显示名称" autoFocus required maxLength={100} disabled={busy}
                value={renaming.name} onChange={(event) => setRenaming({ ...renaming, name: event.currentTarget.value })} />
              <button type="button" className="aero-button" disabled={busy} onClick={() => {
                setRenaming(null);
                setError("");
              }}>取消</button>
              <button className="aero-button pins-primary" disabled={busy || !renaming.name.trim()}>保存</button>
            </form>
          ) : (
            <>
              <div className="pins-entry">
                <strong>{item.name}</strong>
                {item.path && <small title={item.path}>{item.path}</small>}
              </div>
              <button className="aero-button" disabled={busy} onClick={() => {
                setError("");
                setRenaming({ id: item.id, name: item.name });
              }}>重命名</button>
              <button className="aero-button" disabled={busy} onClick={() => void run(async () => {
                const path = await ipc.pickPinPath(false, true);
                if (path) await ipc.setPinIcon(item.id, path);
              })}>更改图标…</button>
              {customIconKey(item) && (
                <button className="aero-button" disabled={busy} onClick={() => void run(async () => {
                  await ipc.setPinIcon(item.id, null);
                })}>恢复默认图标</button>
              )}
            </>
          )}
        </div>
      ))}
    </section>
  );
}
