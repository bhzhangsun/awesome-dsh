# PERMISSIONS — dsh-computer-use

本文件声明 `dsh-computer-use` 插件在运行时实际使用的权限面（DSH STORE 审查依据）。
本分支为**零配置分支（feat/zero-config-cua-driver）**，相比“纯手动”版本，新增了
一次性引导安装与常驻 daemon 自管理——因此**网络与文件写权限确实会被使用**，此处如实声明，
不再声称“零网络 / 零写”。

## 总览（运行时行为）

- 通过**宿主 `child_process.spawn` 以固定 argv** 调用 `cua-driver` 原生驱动（跨平台：macOS / Windows / Linux），驱动本地桌面：
  - 屏幕观测：`screen_observe` / `screen_zoom`（读取被观测应用的 Accessibility/AX 树与窗口快照）
  - 虚拟鼠标键盘模拟：`computer_click` / `computer_double_click` / `computer_right_click` / `computer_type` / `computer_key` / `computer_scroll` / `computer_drag` / `computer_wait`
  - 应用枚举与启动：`app_list` / `app_launch`
- **零配置生命周期**（本分支新增，全部在加载后**后台**执行，不阻塞插件注册）：
  1. `ensureDriver` —— 若 `cua-driver` 二进制缺失，按配置引导安装（见下“有界的引导”，仅此一次）；安装器带超时，并会先清理上一次中断留下的死锁。
  2. `ensureDaemon` —— 缺则起 `cua-driver serve`（机器级单例，detached + unref），运行期常驻。
  3. `ensurePermissions` —— 检测 macOS TCC 状态，必要时经 `permissions grant` 触发授权弹窗。
  4. `ensureVersion` —— 过期则委托 `update --apply` 自更新（网络，可关闭）。
- 卸载（插件销毁）时**只 `end_session` 清自己的 cua session**，**绝不 `stop` 共享 daemon**（其他会话可能还在用）。
- 内置安全护栏（所有工具统一走 `guard()` 包装）：**危险词审批**、**密码框保护**、**过期状态拒绝**、**作用域权限**。

## 有界的引导（唯一会联网 + 写文件的地方）

仅在 `cua-driver` 二进制缺失时发生，且受 `autoInstallDriver` 开关控制：

- **方式 A（默认，`driverInstallMethod: installer`）**：运行 `driverInstallCommand`
  （默认 `curl -fsSL https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/install.sh | sh`）。
  这是本插件**唯一使用 `shell: true` 的地方**（curl|sh 管道必需），只在此一次性引导触发。
  **Windows 上自动降级方式 B**：官方 install.sh 是 POSIX 脚本且默认命令依赖 `| sh` 管道，在 Windows（cmd.exe）不可行，
  引擎官方有 Windows 预编译资产，故 Windows 直接走 direct 直连下载。
- **方式 B（`direct`）**：`fetch` 直连 Release 下载平台/架构对应的预编译资产到缓存目录，
  SHA256 自动校验：`driverReleaseSha256` 显式配置优先，未配置时自动从官方 `checksums.txt`
  取该资产哈希（均不可得才跳过并告警）。`driverReleaseUrl` 未配置时按平台/架构自动推断
  （Windows zip / darwin universal tar.gz / linux tar.gz），下载后解压平铺落位
  （Windows 用系统自带 bsdtar，失败回退 PowerShell Expand-Archive；Unix 用 tar）。

写入落点（唯一写路径）：`~/.cache/dsh-computer-use/bin`（与代码 `cacheBinDir()` 一致，Windows/Linux 同布局）。
该目录同时参与 `cuaCall` 的二进制解析，引导后无需重启即可被找到。

> 若你不愿插件联网/写文件：设 `autoInstallDriver: false`，自行用官方安装器/brew/npm 装好
> `cua-driver` 并设 `CUA_DRIVER_BIN`，或在 PATH 中即可；此时本插件运行期**不联网、不写文件**。

## 明确不做（运行期，非引导阶段）

- ❌ 不在运行期（引导完成后）读本插件代码范围外的用户/项目文件
- ❌ 不访问凭据 / 环境变量中的敏感信息（仅读取 `CUA_DRIVER_BIN` / `PATH` 定位可执行文件）
- ❌ 无 `exec` / `eval`；所有 `spawn` 均为固定 argv 调用 `cua-driver`（除一次性引导的 curl|sh）
- ❌ 不触碰真实鼠标键盘焦点（独立虚拟光标，隔离运行，不抢占用户输入）
- ❌ 无 npm 生命周期脚本（install / postinstall 等一律没有）
- ❌ 不调用任何第三方 AI API / 遥测（视觉观察走宿主模型或 GLM 免费模型，由 DSH 上下文提供）

## 依赖（仅两个，均为官方/DSH 生态）

| 依赖 | 用途 |
|---|---|
| `@deepseek-ai/dsh-tools` | 注册 dsh 原生工具（`ctx.tools.register(defineTool(...))`） |
| `@deepseek-ai/schemastery` | 工具参数 schema 定义 |

## 权限信号对照（STORE 五信号）

| 信号 | 状态 | 说明 |
|---|---|---|
| 文件权限 | ⚠️ 命中 | 引导阶段向 `~/.cache/dsh-computer-use/bin` 写入 `cua-driver` 二进制及其同目录伴随库（一次性 + 可选自更新）；运行期无额外写 |
| 命令权限 | ⚠️ 命中 | `spawn` 固定 argv 调用 `cua-driver`（serve/call/status/stop/permissions/update）；一次性引导用 `shell:true` 跑官方安装脚本 |
| 网络权限 | ⚠️ 命中 | 引导下载 `cua-driver`（GitHub）与可选自更新（`update --apply`）；运行期桌面操作本身不经网络 |
| 凭据权限 | ✅ 未命中 | 不触碰 `process.env` 中的密钥/凭证（仅 `CUA_DRIVER_BIN`） |
| 生命周期脚本 | ✅ 无 | npm 元数据中无 install/postinstall/prepare |

完整安装/启动/卸载证据见 `docs/store-evidence.md`。
