# codex-splash-kit

> 给 **Codex Desktop** 装上开机启动动画，并解决 Windows 中文用户名下的两个隐蔽坑。
> 顺带一套可以量化的启动卡顿诊断工具。

**Unofficial.** 本项目与 OpenAI、Code-Codex 均无隶属关系。启动动画能力来自第三方项目
[Code-Codex](https://github.com/Rice-dog/code-codex)（MIT），本项目**不打包**其代码，只提供安装工具、
非 ASCII 环境绕行方案与诊断脚本。

---

## 它解决什么问题

在中文（或任何非 ASCII）Windows 用户名下，`C:\Users\橙\...` 这类路径会让两个常见机制静默失效：

| 缺陷 | 现象 | 影响 |
|---|---|---|
| 活动代码页 437 + COM 快捷方式 | `IShellLink` / `WScript.Shell` 按 ANSI 编组，用户名被压成 `?`，抛 `E_INVALIDARG` | 任何在非 ASCII 路径下建/改 `.lnk` 的工具都会失败 |
| 非 ASCII `%TEMP%` | `Add-Type` 运行时编译 C# 时 `csc.exe` 写不进 `C:\Users\橙\...\Temp`，报「目录名称无效」 | 任何**启动时用 `Add-Type` 编译助手**的工具会直接启动失败 |

第二类缺陷会让 Code-Codex 报 `CC-START-CODEX-003` 并拒绝启动 Codex —— 这是本仓库存在的主要原因。

详细实测记录见 [`docs/windows-non-ascii-pitfalls.md`](docs/windows-non-ascii-pitfalls.md)。

---

## 快速开始

前置条件：已安装
1. **Codex Desktop**（Microsoft Store / MSIX 版）
2. **[Code-Codex](https://github.com/Rice-dog/code-codex)** 0.4.2x —— 并提供启动动画插件包
   `CodeCodex-plugin-codex-startup-transition-*.js`（来自其 GitHub Release 的插件资产）

```powershell
# 1) 检查环境并给出确切诊断（不修改 Codex / Code-Codex 的任何状态）
.\scripts\install-startup-animation.ps1 -Diagnose

# 2) 装好启动动画：导入插件 + 写开关 + 生成 ASCII-safe 启动器
.\scripts\install-startup-animation.ps1 `
    -PluginAsset "D:\path\to\CodeCodex-plugin-codex-startup-transition-1.0.0.js"

# 3) 启动 Codex（必须完全退出后再用这个入口，否则注入会被拒绝）
.\scripts\codex-splash-launch.cmd

# 4) 导入你自己的启动视频（Codex 正在运行时执行）
.\scripts\import-startup-video.ps1 -Video "D:\path\to\your-clip.mp4"
```

然后：完全退出 Codex → 双击生成的 `Codex (Code-Codex)` 快捷方式 → 在 Code-Codex 菜单里
`Preview Market → Appearance → Codex Startup Transition → Enable`。

---

## 本仓库有什么

```
scripts/
  install-startup-animation.ps1   环境诊断 + 插件导入 + 开关写入 + 启动器生成
  codex-splash-launch.cmd         模板：ASCII-safe 启动器（由上一脚本实例化）
  import-startup-video.ps1        自动找 CDP 端口后调用下面的 mjs
  lib/import-startup-video.mjs    走应用自己的媒体导入流程（打进 shadow DOM 的 file input）
tools/
  cdp-eval.mjs                    对注入后的渲染进程求值（穿透 shadow DOM）
  watch-startup.mjs               抓启动遮罩 + 连拍截图，用于目视验证
  diag-startup.mjs                量化启动卡顿：rAF 帧间隔 / longtask / 视频丢帧
docs/
  windows-non-ascii-pitfalls.md   两个环境缺陷的完整实测证据
  plugin-mechanics.md             插件机制：双开关、受管媒体存储格式、shadow DOM 结构
  startup-jank-measurements.md    启动卡顿 A/B 实测方法与结论
  upstream-bug-report.md          可直接提交给上游的 bug 报告草稿
```

**不含**任何视频素材——启动画面请自备（这也是它更通用的原因）。

---

## 换启动视频

`import-startup-video.ps1` 走的是应用**自己的导入流程**，因为 `data\media\startup\` 是受管存储：
直接拷进去的 mp4 会在下次启动被删掉。导入后存储结构为：

```
data\media\startup\
├── <hash>.json        { id:"selected", job:"<目录名>", blobs, record }
└── <jobid>\blob       视频本体（无扩展名）
```

判断导入是否成功：`blob` 大小 == 源文件大小，且 `<hash>.json` 的 `job` 指向该目录。
导入中途应用退出会留下**截断的 blob 且索引不更新**，重导即可。

---

## 启动卡顿？先别怪动画

本仓库的实测结论：**遮罩动画不是启动卡顿的原因，而是受害者。**
A/B 对照（开/关动画）下，宿主自身的帧间隔与主线程长任务几乎一致；
动画的视频流在应用启动中期被抢掉解码管线（`readyState` 4→2、丢帧上升，但 `playbackRate` 始终为 1）。

数据与方法见 [`docs/startup-jank-measurements.md`](docs/startup-jank-measurements.md)。
用 `tools/diag-startup.mjs` 可在你自己的机器上复现这套测量。

---

## 它不做什么

- 不修改 Codex Desktop 本体（MSIX 包不动，`app.asar` 不动）
- 不修改官方 Codex 桌面快捷方式（只新增一个独立快捷方式）
- 不打包、不再分发第三方代码或视频素材
- 不绕过 Code-Codex 的校验（插件导入仍受其内置目录的 SHA-256 校验）

## 已知限制

- 仅 Windows（两项缺陷都是 Windows 特有）
- 必须**通过 Code-Codex 启动** Codex 才会有动画；若 Codex 已在运行，注入器会拒绝并报
  `CC-START-STATE-001`，那一次启动没有动画
- Code-Codex 官方安装器在非 ASCII 用户名下**必然**在 `Updating shortcuts` 阶段回滚，
  需要手工补齐安装目录（见 `docs/windows-non-ascii-pitfalls.md` 的绕过章节）

## License

MIT —— 见 [LICENSE](LICENSE)。第三方组件的声明见 [NOTICE.md](NOTICE.md)。

---

## English (short)

A tiny toolkit that makes a **Codex Desktop startup animation** actually work on Windows machines whose
user profile path contains non-ASCII characters — plus a scriptable way to import the splash video and a
measured diagnostic suite for startup jank.

Two Windows pitfalls are documented with reproduction evidence: `IShellLink`/`WScript.Shell` failing with
`E_INVALIDARG` on non-ASCII paths (code page 437), and `Add-Type` failing because `csc.exe` cannot write
into a non-ASCII `%TEMP%` (which makes Code-Codex abort with `CC-START-CODEX-003`).

The animation capability itself belongs to the third-party MIT project
[Code-Codex](https://github.com/Rice-dog/code-codex); this repo ships only tooling, workarounds and
diagnostics — no third-party code and no video assets.
