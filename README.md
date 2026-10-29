# dsh-quick-restart

> **自用插件**（personal use）。按需取用，不保证适配所有 DSH 版本；出问题以你的环境为准。

在 DSH 桌面版的标题栏右侧、系统「关闭」按钮左边加一个**重启**按钮：点一下，所有
`DeepSeek Harness.exe` 进程被关闭并等它们全部退出，然后重新打开应用。

当前版本 **1.2.0**。1.0.0（首版，能跑但慢 20 秒、会多弹一个控制台窗口）存档在
`plugins/_archive/dsh-desktop-restart-1.0.0/`（本仓库外）。1.1.0 → 1.2.0 只是改名与整理，
行为没有变化。

## 安装

```sh
dsh plugin --profile <profile> add https://github.com/2522669008-zcy/dsh-quick-restart
```

或用本地路径：`dsh plugin --profile <profile> add <本仓库绝对路径>`。

装好后刷新页面，标题栏右上角、最小化按钮左边会出现「⟳ 重启」。

## 为什么不用 `child_process.detached`

本机实测（2026-10-27，Win11 / Electron 44.7.0）：

- 桌面版的 7 个进程**全部处在一个 Job 对象里**（`IsProcessInJob = true`）。Job 会被子进程
  继承，而 kill-on-close 的 Job 在浏览器进程退出的瞬间就把成员一起杀掉——普通子进程会
  跟着它本该重启的应用一起死，结果是「关了没再开」。
- 用 WMI `Win32_Process.Create` 创建的进程是 `WmiPrvSE.exe` 的子进程：`inJob = false`、
  `session = 1`（交互会话）、无父控制台可继承。

所以链路是三段：

```
client.js  --POST /dsh-quick-restart-->  index.js（宿主，在 Job 内）
                                            └─ launch.ps1（在 Job 内，只做一件事）
                                                 └─ WMI Create ─> restart.ps1（在 Job 外）
                                                                    ├─ 等 1 秒（先让 HTTP 回应发出去）
                                                                    ├─ CloseMainWindow，最多等 1.5 秒
                                                                    ├─ 仍在的进程一次性 Stop-Process -Force
                                                                    ├─ 等全部退出
                                                                    └─ WMI Create 重新打开（不用 Start-Process）
```

`restart.ps1` 与 DSH 进程没有任何父子/Job 关系，因此关掉 DSH 不会打断它自己。

### 重新拉起为什么也用 WMI

1.0.0 用 `Start-Process` 拉起应用，结果是应用成了脚本的子进程，Electron 接上了脚本那个
（隐藏的）控制台并把宿主 stdout 灌进去 —— 每次重启都多出一个 Windows Terminal 窗口，
里面是 `Checking for update` / `dsh web: http://127.0.0.1:PORT/?token=...` /
`[llm-deepseek-account] ...`。

WMI 创建的进程没有父控制台可接，和从开始菜单启动的起始条件一致。实测重启后不再出现
控制台窗口。

## 时间预算（实测）

| 阶段 | 1.0.0 | 1.1.0 / 1.2.0 |
| --- | --- | --- |
| 等 HTTP 回应 | 2.0s | 1.0s |
| 优雅关闭 | **固定等满 20s**（应用根本不响应 WM_CLOSE） | 1.5s 无变化就强杀 |
| 强杀 + 等退出 | 1.8s | 1.7s（7 个进程一次杀） |
| 拉起 | — | ~0.2s |
| **应用起来之前合计** | **~24s** | **~4s** |

### 关于「检查更新」

`Checking for update` 是主进程里 `electron-updater` 的后台请求，**不在关键路径上**，也不会
阻塞窗口 —— 它每次启动都会跑一次（`DesktopUpdateSchedule` 的 `nextCheck` 初始为
`-Infinity`，所以第一次调用必定触发）。它能调的只有环境变量
`DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS` / `..._MAX_BACKOFF_MS` / `..._JITTER`，都只影响
**后续周期**，关不掉启动那次；`enabled()` 的唯一开关是 `resources/app-update.yml` 是否
存在，改它等于废掉应用自身的更新功能。所以这一版没有动它，真正的 20 秒浪费在上面那张表里。

## 安全边界

- 只按**可执行文件绝对路径**匹配进程（`process.execPath`），不按进程名杀。
- 宿主不是桌面版时（例如 `dsh web` 跑在 `node.exe` 上）插件报 `available: false`，
  按钮点了也只会返回 409，绝不触碰 node 进程。
- 若强制结束后仍有目标进程存活，脚本**不会**再启动第二个副本（避免两个实例抢同一个
  profile），而是记一条 `ERROR ... survived` 后退出。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 插件：注册 `POST /dsh-quick-restart` 路由，调用 `launch.ps1` |
| `client.js` | 浏览器半：在 `shell.overlay` 席位渲染按钮，用 Window Controls Overlay API 定位 |
| `launch.ps1` | 通过 WMI 把 `restart.ps1` 创建到 Job 之外 |
| `restart.ps1` | 关进程 + 等退出 + 通过 WMI 重新启动 |
| `cordis.patch.yml` | bundle patch，插入一行 Host 插件 |

## 用它

- 单击：立刻重启（当前正在跑的回合会被中断；会话记录已落盘，重开后在侧边栏里还在）。
- 失败时按钮变「重试」，鼠标悬停可看原因。
- 日志：`%TEMP%\dsh-quick-restart.log`，每行带毫秒时间戳和脚本 pid，`+x.xs` 是相对开始
  的累计耗时。

手动验证宿主侧（端口换成当前 GUI 的端口）：

```powershell
# 状态（不重启）
Invoke-WebRequest 'http://127.0.0.1:<port>/dsh-quick-restart' -UseBasicParsing | Select -Expand Content
# 空跑一次（只写日志，不杀进程）
Invoke-WebRequest 'http://127.0.0.1:<port>/dsh-quick-restart?dry=1' -Method Post -UseBasicParsing | Select -Expand Content
```

## 限制与已知事实

- 只在 Windows 桌面版有意义：定位依赖 `titleBarOverlay` + Window Controls Overlay API，
  重启依赖 `launch.ps1` / `restart.ps1` 与 WMI。浏览器打开同一个 Web GUI 时按钮会出现，
  但一点就 409。
- **桌面版本身就是个 Web 应用**：Electron 窗口加载 `dsh-app://app/`，由它内部的 Node 宿主
  （就是控制台里那句 `dsh web: http://127.0.0.1:PORT/`）提供服务。那个端口每次启动随机，
  属于正常行为；`3306` 是 MySQL，不是 DSH。
- profile 里的 `@deepseek-ai/dsh-web-app` 是**界面本体**（webserver + 前端 + API），
  关掉它桌面窗口会变成空白，不是「关掉一个多余的 web 进程」。
