/**
 * Choosing a mode's tile icon.
 *
 * The grid is laid out inline rather than in a popover. A floating panel
 * has to win a positioning fight with whatever is around it, and it lost
 * that fight once already; a plain wrapped grid cannot be covered, cannot
 * be clipped, and works the same at every window size.
 */

import { useState } from "react";

/** Emoji render as pictures; a letter has to be drawn as type. */
export function isPictorial(glyph: string): boolean {
  return /\p{Extended_Pictographic}/u.test(glyph);
}

/** What the tile shows: the chosen glyph, else the name's first letter. */
export function resolveGlyph(name: string, glyph: string): string {
  const trimmed = glyph.trim();
  if (trimmed) return trimmed;
  return name.trim().charAt(0).toUpperCase() || "M";
}

/** Ordered by theme so related icons sit together in the wrapped grid. */
const PRESETS: { glyph: string; label: string }[] = [
  { glyph: "💼", label: "公文包" },
  { glyph: "📊", label: "图表" },
  { glyph: "📝", label: "笔记" },
  { glyph: "🗂️", label: "文件" },
  { glyph: "📅", label: "日历" },
  { glyph: "🏢", label: "办公" },
  { glyph: "✉️", label: "邮件" },
  { glyph: "🎯", label: "专注" },
  { glyph: "💻", label: "编程" },
  { glyph: "🛠️", label: "工具" },
  { glyph: "🧩", label: "拼图" },
  { glyph: "⚙️", label: "设置" },
  { glyph: "🎨", label: "设计" },
  { glyph: "✏️", label: "绘画" },
  { glyph: "🧪", label: "实验" },
  { glyph: "🚀", label: "发射" },
  { glyph: "🎮", label: "游戏" },
  { glyph: "🕹️", label: "街机" },
  { glyph: "🎧", label: "耳机" },
  { glyph: "🎵", label: "音乐" },
  { glyph: "🎬", label: "电影" },
  { glyph: "📷", label: "照片" },
  { glyph: "📺", label: "观看" },
  { glyph: "🎲", label: "骰子" },
  { glyph: "🫧", label: "气泡" },
  { glyph: "🌊", label: "水滴" },
  { glyph: "🌿", label: "叶子" },
  { glyph: "☀️", label: "白天" },
  { glyph: "🌙", label: "夜晚" },
  { glyph: "⚡", label: "闪电" },
  { glyph: "⭐", label: "星星" },
  { glyph: "🏠", label: "主页" },
];

interface Props {
  /** The mode's name, used for the letter fallback. */
  name: string;
  glyph: string;
  onChange: (glyph: string) => void;
}

export function ModeIconPicker({ name, glyph, onChange }: Props) {
  const [custom, setCustom] = useState("");
  const chosen = glyph.trim();
  const letter = resolveGlyph(name, "");

  return (
    <div className="icon-picker">
      <div className="icon-picker-grid">
        {/* the letter fallback sits first, as one of the choices */}
        <button
          type="button"
          className="icon-picker-option"
          data-active={!chosen}
          title={`使用字母 ${letter}`}
          aria-label={`使用字母 ${letter}`}
          onClick={() => onChange("")}
        >
          {letter}
        </button>
        {PRESETS.map((preset) => (
          <button
            key={preset.glyph}
            type="button"
            className="icon-picker-option"
            data-emoji="true"
            data-active={chosen === preset.glyph}
            title={preset.label}
            aria-label={preset.label}
            onClick={() => onChange(preset.glyph)}
          >
            {preset.glyph}
          </button>
        ))}
      </div>

      <div className="icon-picker-custom">
        <input
          className="ctl-text ctl-text-short"
          value={custom}
          maxLength={4}
          placeholder="其他"
          aria-label="自定义图标"
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !custom.trim()) return;
            e.preventDefault();
            onChange(custom.trim());
            setCustom("");
          }}
        />
        <button
          type="button"
          className="aero-button"
          disabled={!custom.trim()}
          onClick={() => {
            onChange(custom.trim());
            setCustom("");
          }}
        >
          使用
        </button>
        {chosen && !PRESETS.some((p) => p.glyph === chosen) && (
          <span className="settings-note">当前 {chosen}</span>
        )}
      </div>
    </div>
  );
}
