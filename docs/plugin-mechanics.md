# 启动动画的机制（逆向记录）

本文记录在 Code-Codex + Codex Desktop 上让启动动画工作需要知道的机制。全部为**黑盒观察**结果
（日志、CDP 求值、文件系统），不是上游源码分析。

版本基线：Code-Codex 0.4.25、Codex Desktop（OpenAI.Codex MSIX）26.1007.2314.0、Electron/Chrome 155。

---

## 1. 整体链路

```
桌面快捷方式 → 启动器（设 ASCII TEMP）→ code-codex.exe run
   → 发现 Codex 安装 → 预留回环调试端口 → 以 --remote-debugging-port 启动 Codex
   → 通过 CDP 连上渲染进程 → Page.addScriptToEvaluateOnNewDocument 注入启动动画脚本
   → 渲染进程在应用首屏就绪前显示全屏遮罩（播放视频或动态背景）
   → 应用就绪后遮罩淡出
```

要点：**动画不是 Codex 的功能**，是外部进程在 Codex 的渲染进程里注入的一层 DOM。
因此必须由该启动器拉起 Codex 才生效。

---

## 2. 启用需要**两处**同时为真

这是最容易踩的坑：只改一处不生效。

### ① 原生侧开关（决定启动时**是否加载**插件）

```
%LOCALAPPDATA%\Programs\Code-Codex\data\settings.json
{ "startupTransitionEnabled": true }
```

该文件由启动器/界面维护。**应用运行时会重写它**，所以不要在手改后立即期待生效；
界面里的 Enable 按钮会同步写这一项。

### ② 渲染进程侧参数（决定**怎么播**）

```
localStorage['code-codex:startup-transition:v1']
{
  "enabled": true,
  "source": "video",            // 或 "background"
  "backgroundId": "particle-image",
  "backgroundFadeSeconds": 3,
  "minimumVisiblePercent": 27,  // 最少展示时长 = 该百分比 × 片段时长
  "fadePercent": 3,             // 淡出时长 = 该百分比 × 片段时长
  "clipStart": 0,
  "clipEnd": 20.083333,
  "playbackRate": 1,            // 0.5–2
  "videoBrightness": 1.2,       // 0.4–1.4
  "videoFit": "cover"           // 或 "contain"
}
```

该 localStorage 会被镜像到磁盘：`data\renderer-settings.json`（键值均为字符串化的 JSON）。

> 有趣的行为：渲染进程加载插件后，会主动把 `enabled` **回写**到原生开关
> （`explorer.settings.set { startupTransitionEnabled }`）。所以手改开关为 `false` 只能让
> **当次**启动不播；等界面加载完，它又会被 localStorage 里的 `true` 同步回去。

---

## 3. 受管媒体存储（为什么不能直接拷视频进去）

```
data\media\startup\
├── <sha256>.json      ← 唯一记录
└── <jobid>\
    └── blob           ← 视频本体，无扩展名
```

记录文件内容形如：

```json
{
  "blobs": { "blob": { "lastModified": 1791941666833, "name": "clip.mp4",
                       "sha256": "…", "size": 1720614, "type": "video/mp4" } },
  "id": "selected",
  "job": "4b8c939c30345a23c0f16d1eedc35827",
  "record": { "duration": 20.083333, "id": "selected", "name": "clip.mp4",
              "size": 1720614, "type": "video/mp4" }
}
```

实测行为：

- **手动把 mp4 拷进该目录，下次应用启动会被删掉**（目录是受管的，未登记的条目会被清理）。
- 必须走应用的导入流程（插件面板的视频选择器）。
- **显示名取自导入时的文件名**。
- 导入中途应用退出 → 留下**截断的 blob** 且索引不更新。判断完整性：
  `blob` 大小 == 源文件大小，且 `<sha256>.json` 的 `job` 指向该目录。
- 未被记录的 `<jobid>` 目录是垃圾，可以删。
- 浏览器侧还会有一份 IndexedDB 作为播放缓存（与上面的磁盘存储是两回事）。

通过 CDP 走真实导入流程（本项目 `scripts/lib/import-startup-video.mjs` 的做法）：

```js
// 1) DOM.getDocument({depth:-1, pierce:true}) 让 shadow root 可见
// 2) DOM.querySelector → code-codex-v0-4-25
// 3) DOM.describeNode({pierce:true}).node.shadowRoots[0].nodeId
// 4) DOM.querySelector({nodeId: shadowRootNodeId, selector:'input.startupTransition-file'})
// 5) DOM.setFileInputFiles({files:[absPath], nodeId})
```

注意 `DOM.setFileInputFiles` 需要**真实节点 id**；`Runtime.evaluate` 拿到元素对象后
用 `DOM.requestNode` 映射会返回 `0`（shadow DOM 内不生效），必须走上面的扁平化文档路径。

---

## 4. 注入后的 UI 结构（做自动化时必须知道）

Code-Codex 的界面是一个**自定义元素 + shadow root**：

```
<code-codex-v0-4-25>            ← document 级
  #shadow-root (2000+ 节点)      ← 所有面板都在这里
```

因此 `document.querySelector('.startupTransition-*')` **永远查不到**，必须：
- 从 `document.querySelector('code-codex-v0-4-25').shadowRoot` 里查，或
- 用 CDP 的 `DOM.getDocument({pierce:true})` 走扁平化文档。

关键选择器：

| 选择器 | 用途 |
|---|---|
| `input.startupTransition-file` | 视频导入（`accept="video/*"`） |
| `button.startupTransition-enable` | 启用开关（`aria-pressed` 反映状态） |
| `section.startupTransition-settings-panel` | 参数面板（popover） |
| `video.startupTransition-video-still` | 时间轴预览用的静帧/预览 |
| `span.startupTransition-status` | 状态文本（Enabled / …） |

**启动遮罩本身**（注入进 Codex 页面的那一层，不在上面的 shadow root 里）：

```
.codex-startup.codex-startup--fullscreen.codex-startup--has-video
  └── .codex-startup__video
        └── <video muted autoplay playsinline>
```

- `--has-video` 表示视频已就绪；`--exiting` 表示正在淡出。
- 遮罩用 `popover` API，`position: fixed`。

---

## 5. 启动期的行为（从宿主日志读出）

宿主自己会记录一份结构化日志：`logs\runtime\*.jsonl`。关键事件：

| action | 含义 |
|---|---|
| `early entry` | 注入脚本在文档早期执行（`enabled` 反映开关） |
| `source` | `video` 或 `background` |
| `video lookup` | 找已登记的启动视频；失败时 `reason` 会写明（如 `no stored video`） |
| `source media` | 媒体就绪 |
| `first painted frame` / `early playback` | 遮罩首帧可见 / 开始播放 |
| `readiness monitor` | 周期性轮询应用是否就绪（会持续 `Runtime.evaluate`） |
| `fade` / `player finished` | 淡出开始 / 播放结束 |
| `startup diagnostic` | 启动失败时的诊断报告（含 `CC-START-*` 错误码） |

常见错误码：

- `CC-START-STATE-001` —— Codex 已在运行且不是本启动器拉起的，拒绝注入
- `CC-START-CODEX-003` —— 包激活失败（在非 ASCII `%TEMP%` 下必然出现，见另一个文档）

---

## 6. 不修改什么

本项目涉及的机制**不需要**改动：

- Codex Desktop 的 MSIX 安装文件、`app.asar`、签名
- 官方 Codex 桌面快捷方式（只新增独立快捷方式）
- Code-Codex 的插件校验（导入仍受其内置 SHA-256 目录约束）
