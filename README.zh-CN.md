# Aero Dock 简体中文版

本分支基于 [TheAgencyMGE/aero-dock](https://github.com/TheAgencyMGE/aero-dock) v1.3.2，原作者为 Ryan Panda，由 [linyuYL](https://github.com/linyuYL) 维护简体中文桌面坞版本，遵循 [MIT 许可证](LICENSE)。

无底板桌面坞只显示固定的入口和运行中的应用，支持悬停放大、图标倒影和窗口预览。设置可从托盘或应用右键菜单打开。

固定项目支持导入应用、网页、快捷方式、文件和文件夹，并可重命名及更换图标。运行中的单窗口应用可点击切换前台与最小化，多窗口应用可通过预览选择窗口。

如果目录中有 `便携版`，双击其中的 `Aero Dock.exe` 即可运行。旁边的 `portable.txt` 启用便携模式，应用设置和图标缓存保存在同目录的 `data` 中。

首次使用时，桌面坞默认位于顶部。已有配置会保留停靠位置。把程序快捷方式拖到桌面坞即可固定。

也可以通过「设置 → 固定项目 → 导入项目」添加应用、网页、快捷方式、文件或文件夹。已有入口可在同一区域重命名。

如需从源码重新构建，请准备 Node.js、pnpm 10、Rust MSVC 工具链和 Windows C++ 生成工具，在仓库根目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm tauri build --no-bundle
```

可执行文件位于 `src-tauri/target/release/aero-dock.exe`。Windows 需要提供 WebView2 运行时。原项目说明见 [README.md](README.md)。
