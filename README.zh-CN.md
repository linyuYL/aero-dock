# Aero Dock 简体中文版

本分支基于 [TheAgencyMGE/aero-dock](https://github.com/TheAgencyMGE/aero-dock) v1.3.2，原作者为 Ryan Panda.

发布版本为 `v1.3.2-zh.1`，下载入口见 [Releases](https://github.com/linyuYL/aero-dock/releases)。安装版文件以 `-setup.exe` 结尾；便携版文件以 `-portable.zip` 结尾，解压后运行 `Aero Dock.exe`，并将 `portable.txt` 与程序放在一起。两种发布包均附带 MIT 许可证。

对dock风格做出了一些改变,并将默认语言翻译为中文<img width="695" height="76" alt="image" src="https://github.com/user-attachments/assets/5e29daa8-99ad-4e06-bdc1-b678d7e4b814" />
<img width="399" height="292" alt="image" src="https://github.com/user-attachments/assets/fd2f85fb-04db-429f-a602-d955733a0c4b" />



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
