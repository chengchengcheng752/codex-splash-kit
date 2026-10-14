# NOTICE

## 第三方组件

本仓库**不打包**任何第三方代码。脚本在运行时会与你机器上已安装的第三方软件交互，或在你的指示下
下载第三方资产。

### Code-Codex

- 项目：https://github.com/Rice-dog/code-codex
- 作者：Rice-dog 及贡献者
- 许可证：MIT
- 用途：本项目依赖其提供的 CDP 注入框架与 `codex-startup-transition` 插件来实现启动动画。
- **其代码、插件资产与二进制均由使用者自行获取，本仓库不重新分发。**

如果你把本仓库的脚本与本项目一起再分发，请一并保留 Code-Codex 的版权与许可证声明。

### Codex Desktop / OpenAI

- Codex Desktop 是 OpenAI 的产品，以 Microsoft Store（MSIX）包形式分发。
- 本项目**不修改**其安装文件、`app.asar` 或签名。
- 本项目的脚本会以 `--remote-debugging-port` 参数启动 Codex Desktop —— 这是 Code-Codex 注入 UI 的
  既有机制。是否接受该机制由使用者自行判断。

### 视频与图像素材

- 本仓库**不包含**任何视频或图像素材。
- 启动动画的视频由使用者自备。请确认你拥有所使用素材的相应权利；本仓库不对使用者导入的内容承担
  任何责任。

## 商标

"Codex"、"ChatGPT"、"OpenAI" 是其各自所有者的商标。本项目为非官方的社区工具，与上述主体无隶属、
赞助或背书关系。
