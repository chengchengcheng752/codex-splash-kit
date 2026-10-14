# Windows 非 ASCII 用户名下的两个隐蔽缺陷

本文记录两个在本机 Windows 上**实测复现**的环境级缺陷。两者的共同根因是：
**系统中某个环节仍在用 ANSI（活动代码页 437）编组字符串**，而用户配置文件名含非 ASCII 字符
（例如中文用户名 → 配置文件路径 `C:\Users\<中文名>\...`）。

复现环境：Windows 10.0.28000、活动代码页 437、PowerShell 5.1 / 7、Electron 应用（Chrome 155）。

> 如果你不是非 ASCII 用户名，这两条基本不会遇到。判断方法：
> 打开 PowerShell 执行 `chcp` 与 `$env:USERPROFILE`，若后者含非 ASCII 且代码页不是 65001，则命中。

---

## 缺陷 A：非 ASCII 路径下 COM 快捷方式操作必定失败

### 现象

用 `WScript.Shell`（或任何基于 `IShellLink` 的实现）创建或改写快捷方式时抛：

```
Value does not fall within the expected range
```

以及中文错误：

```
无法保存快捷方式"C:\Users\?\Desktop\xxx.lnk"
```

注意错误信息里用户名被替换成了 `?` —— 这就是 ANSI 编组把非 ASCII 字符压掉的直接证据。

### 隔离实验

同一台机器、同一次运行内的三组对照：

| # | 快捷方式路径 | 目标路径 | 结果 |
|---|---|---|---|
| A | ASCII（`D:\tmp\t_a.lnk`） | ASCII（`C:\Windows\System32\notepad.exe`） | ✅ 成功 |
| B | **含非 ASCII**（`C:\Users\<中文名>\Desktop\t_b.lnk`） | ASCII | ❌ 失败，路径显示为 `C:\Users\?\...` |
| C | ASCII | **含非 ASCII** | ❌ 失败，`E_INVALIDARG` / "expected range" |

结论：**只要路径任一侧含非 ASCII 就失败**，与目标是否为 MSIX/UWP 应用无关。

> 一个容易走偏的判断：MSIX（Microsoft Store）应用的桌面快捷方式没有传统 `TargetPath`，
> 用 `WScript.Shell` 读它会得到空值。这**不是**失败原因——同一条 `.lnk` 用纯 ASCII 路径读写同样会
> 因为上面的规则而失败。读回为空 ≠ 文件损坏。

### 影响面

任何在启动/安装流程里用 COM 建快捷方式的工具，只要安装路径或桌面路径含非 ASCII 就会失败。
典型表现是安装器**中途抛错并整体回滚**，用户看到的是"装不上"，而不是"快捷方式没建"。

### 绕行方案（本仓库采用）

在**纯 ASCII 目录**生成 `.lnk`，再用**文件复制**放到非 ASCII 桌面：

```powershell
$sh = New-Object -ComObject WScript.Shell
$lnk = Join-Path 'C:\ASCII\dir' 'launcher.lnk'      # ASCII 路径
$l = $sh.CreateShortcut($lnk)
$l.TargetPath = "$env:SystemRoot\System32\cmd.exe"  # ASCII 目标
$l.Arguments  = '/c "C:\ASCII\dir\launch.cmd"'      # ASCII 参数
$l.Save()
Copy-Item $lnk "$([Environment]::GetFolderPath('Desktop'))\Launcher.lnk" -Force
```

关键点：

1. 目标、参数、图标路径**全部**必须是 ASCII。真实安装路径若含非 ASCII，用 `%LOCALAPPDATA%` 这类
   **环境变量**间接引用（批处理展开时不受影响）。
2. 快捷方式文件本身在 ASCII 目录生成，之后用文件系统复制搬走 —— 复制不经过 COM。
3. **验证 `.lnk` 不要相信 COM 读回**（它同样被 ANSI 编组破坏，会返回空值）。直接读文件字节里的
   UTF-16 字符串：

```powershell
$b = [IO.File]::ReadAllBytes($lnk)
$u = [Text.Encoding]::Unicode.GetString($b)
[regex]::Matches($u, '[\x20-\x7E]{5,}') | ForEach-Object { $_.Value }
```

---

## 缺陷 B：非 ASCII `%TEMP%` 让 `Add-Type` 编译失败

### 现象

工具在启动时用 PowerShell `Add-Type` 运行时编译一小段 C# 助手（常见于需要调用 Win32 API
或做包激活的场景），编译产物写不出去：

```
AddTypeCommand : (0) : Could not write to output file
  'c:\Users\<中文名>\AppData\Local\Temp\xxxxxxxx.dll' -- '目录名称无效。'
```

`Add-Type` 在 Windows PowerShell 5.1 下调用 `csc.exe` 编译，输出目录取自 `%TEMP%`。
非 ASCII 的 `%TEMP%` 会让编译器收到被破坏的路径，于是报"目录名称无效"。

### 隔离实验

同一台机器、同一次运行：

| `%TEMP%` | `Add-Type` |
|---|---|
| `C:\Users\<中文名>\AppData\Local\Temp`（默认） | ❌ `Could not write to output file … 目录名称无效。` |
| `D:\ascii\tmp` | ✅ 成功 |

### 影响面

比缺陷 A 更致命：失败发生在**进程启动路径**上，工具往往直接退出，用户看到的是
"程序打不开"，几乎没有线索指向用户名。

真实案例（本仓库的起因）：Code-Codex 启动器用 `Add-Type` 编译 MSIX 包激活助手，
在非 ASCII 用户名下必失败并报 `CC-START-CODEX-003`，Codex 完全无法通过它启动。

### 绕行方案（本仓库采用）

在启动子进程**之前**把 `TEMP` / `TMP` 指向纯 ASCII 目录。子进程继承环境变量，
于是 `Add-Type` 的编译产物落到 ASCII 路径下，编译成功。

批处理（`scripts/codex-splash-launch.cmd`）：

```bat
@echo off
setlocal
if not exist "C:\CodexSplash\tmp" mkdir "C:\CodexSplash\tmp" >nul 2>&1
set "TEMP=C:\CodexSplash\tmp"
set "TMP=C:\CodexSplash\tmp"
rem ... 然后再启动目标程序
```

PowerShell（临时生效，只影响当前进程及其子进程）：

```powershell
$env:TEMP = 'D:\ascii\tmp'; $env:TMP = 'D:\ascii\tmp'
```

选择 ASCII 临时目录的建议：优先 `%PUBLIC%`（通常为 `C:\Users\Public`，ASCII 且普通用户可写），
否则用 `%SystemDrive%\CodexSplash\tmp`。

> 注意：`Add-Type` 也可以显式指定 `-OutputAssembly`，但很多工具是第三方编译产物、无法改源码；
> 改环境变量是唯一不需要改对方代码的办法。

---

## 附：写这类脚本时的第三个坑（PowerShell 5.1 的脚本编码）

如果你在写**含非 ASCII 字符的 `.ps1`**（比如中文提示信息），Windows PowerShell 5.1 会
**按 ANSI 代码页读取脚本文件**，UTF-8 无 BOM 的文件会被读成乱码并直接抛语法错误：

```
Unexpected token '...' in expression or statement.
The string is missing the terminator: '.
```

解决办法：`.ps1` 保存为 **UTF-8 with BOM**（或 UTF-16 LE）。批量转换：

```powershell
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$utf8Bom   = [Text.UTF8Encoding]::new($true)
Get-ChildItem -Recurse -Filter *.ps1 | ForEach-Object {
    $txt = [IO.File]::ReadAllText($_.FullName, $utf8NoBom)
    [IO.File]::WriteAllText($_.FullName, $txt, $utf8Bom)
}
```

验证前三个字节应为 `ef bb bf`：

```powershell
(Get-ChildItem -Recurse -Filter *.ps1 | ForEach-Object {
    $b = [IO.File]::ReadAllBytes($_.FullName)[0..2]; "{0}: {1}" -f $_.Name, (($b | % { $_.ToString('x2') }) -join ' ')
})
```

PowerShell 7+ 默认按 UTF-8 读取，不受影响；但面向 Windows 用户分发的脚本必须兼容 5.1。
本仓库的 `scripts\*.ps1` 均已带 BOM。

---

## 这两个缺陷为什么不常被报告

它们都**只在非 ASCII 用户名下触发**，而这类路径在英文开发者的机器上不存在。
受影响用户的典型反应是"这个软件坏了"，很少能定位到用户名编码。
如果你在维护启动器/安装器，建议主动做一次防御：

- 建快捷方式：失败时降级为"在 ASCII 目录生成 + 复制"
- 编译辅助代码：启动前把 `TEMP`/`TMP` 指向 ASCII 目录
- 任何跨进程传递路径的地方，优先用 UTF-16 API（`...W`）而不是 ANSI（`...A`）
