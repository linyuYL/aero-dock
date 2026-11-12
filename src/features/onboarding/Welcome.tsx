/**
 * First-launch welcome: a glass card blooming above the empty dock.
 * One choice, zero clutter: bring your apps over, or start clean.
 */

import { motion } from "motion/react";
import { useState } from "react";
import type { DockEdge } from "../../ipc/types";
import { bloomOffset, edgePanelStyle } from "../dock/menuStore";
import { springs } from "../../engine/animation/springs";
import { notify } from "../feedback/toastStore";
import { importStarterApps, startEmpty } from "./firstRun";
import "./welcome.css";

export function Welcome({ edge }: { edge: DockEdge }) {
  const [busy, setBusy] = useState(false);

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    action().catch((e) => {
      notify.error("初始化失败，仍可将应用拖到桌面坞。", e);
      setBusy(false);
    });
    // success needs no cleanup: the settings event flips
    // onboardingComplete and this card unmounts
  };

  return (
    <motion.div
      className="welcome-card glass"
      style={{
        ...edgePanelStyle(edge, "calc(var(--icon-size) * 1.2 + 52px)"),
        width: 380,
        zIndex: 90,
      }}
      initial={{ opacity: 0, scale: 0.85, ...bloomOffset(edge) }}
      animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
      exit={{ opacity: 0, scale: 0.94, filter: "blur(6px)", transition: { duration: 0.2 } }}
      transition={{ ...springs.bloom, delay: 0.25 }}
    >
      <h1>欢迎使用 Aero Dock</h1>
      <p>选择如何添加应用，开始使用桌面坞。</p>
      <div className="welcome-actions">
        <button className="welcome-primary" disabled={busy} onClick={() => run(importStarterApps)}>
          {busy ? "正在导入…" : "导入常用应用"}
        </button>
        <button className="welcome-secondary" disabled={busy} onClick={() => run(startEmpty)}>
          从空白开始
        </button>
      </div>
      <p className="welcome-hint">
        提示：将应用或文件夹从资源管理器拖到桌面坞即可固定。
      </p>
    </motion.div>
  );
}
