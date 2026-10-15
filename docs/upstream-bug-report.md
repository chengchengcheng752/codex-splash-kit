# 可直接提交的上游 bug 报告草稿

> **状态：两份报告均已提交给上游。**
> - issue #59（快捷方式 / `E_INVALIDARG`）：https://github.com/Rice-dog/code-codex/issues/59
> - issue #60（`Add-Type` / `CC-START-CODEX-003`）：https://github.com/Rice-dog/code-codex/issues/60
>
> 提交前做过核对：上游 `main @ ff5ca11f7e`（v0.4.48 之后）里，
> `crates/launcher/src/bin/code-codex-shortcut.rs` 仍以 `WScript.Shell` 写快捷方式、
> `crates/launcher/src/gui_support.rs` 仍以 `Add-Type` 编译激活助手 —— 两条代码路径都还在，
> 且 issue 列表中没有同类报告。
>
> 下面的正文保留完整格式，可用于其他同类工具，或作为本项目的长期参考。

以下两份报告基于本仓库的实测证据。提交前请替换你自己机器上的版本号与最小必要信息，
**不要**附上包含个人路径的完整日志。

---

## 报告 1：非 ASCII 用户名下 `IShellLink` / `WScript.Shell` 快捷方式操作失败

**标题**
Installer rolls back on non-ASCII user profile paths — `IShellLink` shortcut operation fails with `E_INVALIDARG`

**环境**
- Windows 10.0.28000 x64，活动代码页 **437**
- 用户配置文件名含非 ASCII 字符（路径形如 `C:\Users\<非 ASCII>\...`）
- PowerShell 5.1（FullLanguage）

**现象**
安装器在 "Updating shortcuts" 阶段抛错并整体回滚，`versions\` 目录为空，入口 shim 退出码 1。
底层错误为：

```
Windows Shell shortcut operation failed: Value does not fall within the expected range.
```

**最小复现（PowerShell，三组对照）**

```powershell
$sh = New-Object -ComObject WScript.Shell

# A: ASCII 快捷方式路径 + ASCII 目标
$l = $sh.CreateShortcut('D:\tmp\a.lnk'); $l.TargetPath='C:\Windows\System32\notepad.exe'; $l.Save()   # ✅

# B: 快捷方式路径含非 ASCII
$l = $sh.CreateShortcut("$env:USERPROFILE\Desktop\b.lnk"); $l.TargetPath='C:\Windows\System32\notepad.exe'; $l.Save()  # ❌ 路径显示为 C:\Users\?\...

# C: 目标含非 ASCII
$l = $sh.CreateShortcut('D:\tmp\c.lnk'); $l.TargetPath="$env:LOCALAPPDATA\Some App\app.exe"; $l.Save()  # ❌ Value does not fall within the expected range
```

**期望**
- 使用宽字符 API（`IShellLinkW` / 正确设置 `StringBuilder` 的 CharSet，或直接调用 `...W` 系列），
  或在实现层统一走 UTF-16，不依赖进程 ANSI 代码页。
- 快捷方式创建失败时**不应导致整个安装回滚**；应降级为"在 ASCII 目录生成 + 复制"或提示用户手动创建。

**补充**
用 `WScript.Shell` 读取 MSIX（Store 应用）的桌面快捷方式会得到空的 `TargetPath`，这是正常现象
（打包应用快捷方式没有传统文件目标），**不是**本问题的原因；本问题在纯 ASCII 路径下可稳定复现。

---

## 报告 2：非 ASCII `%TEMP%` 导致 `Add-Type` 编译失败，启动器直接退出

**标题**
Launcher aborts with `CC-START-CODEX-003` on non-ASCII `%TEMP%` — `Add-Type` cannot write the compiled helper

**环境**
- 同上；`%TEMP%` = `C:\Users\<非 ASCII>\AppData\Local\Temp`

**现象**
启动器在"激活 Codex Desktop 包"阶段失败，输出：

```
CODE_CODEX_STARTUP_DIAGNOSTIC {"code":"CC-START-CODEX-003", ...}
Windows package activation failed: OS error None, kind Other
```

时间线中的关键条目：

```
compile package activation helper | failed
  AddTypeCommand: (0) : Could not write to output file
  'c:\Users\<非 ASCII>\AppData\Local\Temp\xxxxxxxx.dll' -- '目录名称无效。'
```

**原因**
包激活助手是运行时用 PowerShell `Add-Type` 编译的 C#；`Add-Type`（Windows PowerShell 5.1）
调用 `csc.exe` 并把输出写到 `%TEMP%`。非 ASCII 的 `%TEMP%` 在该路径上失效。

**最小复现**

```powershell
# 默认 TEMP（含非 ASCII）→ 失败
Add-Type -TypeDefinition 'public class A { public static int V(){return 1;} }'
# → Could not write to output file '...<非 ASCII>...\xxxx.dll' -- '目录名称无效。'

# 切到纯 ASCII TEMP → 成功
$env:TEMP='D:\ascii\tmp'; $env:TMP='D:\ascii\tmp'
Add-Type -TypeDefinition 'public class B { public static int V(){return 2;} }'   # ✅
```

**建议修复（任选其一，成本从低到高）**

1. 编译前把 `TEMP`/`TMP` 指向 ASCII 目录（例如 `%PUBLIC%` 或 `%SystemDrive%\CodexSplash\tmp`），
   或在子进程环境里覆盖；
2. `Add-Type -OutputAssembly <ASCII 路径>` 显式指定输出；
3. 不要在启动路径上编译 C#——把包激活助手预编译进发布产物。

**影响**
非 ASCII 用户名（中文/日文/韩文/带重音符号等）的用户完全无法通过启动器启动，且错误信息
（"OS error None, kind Other"）几乎无法指向真实原因。
