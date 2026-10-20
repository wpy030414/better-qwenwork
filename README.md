# clauded-qwenwork

让千问办公（QwenWorkCN）在保留官方模型的同时，多出一个可选的 Claude Code 档位（共存桥接）。

## 这个项目是什么？

千问办公（`QwenWorkCN`，阿里出品的 Electron 办公应用，`C:\Program Files\QwenWorkCN`）自带一套本地 Agent 引擎（`qoderclicn.exe` CLI + `@qoder-ai/qoder-agent-sdk` + worker runtime）。本项目的目标：**保留千问办公的 UI 与全部官方模型，额外提供一个「Claude」档位；选中它时任务执行与计费改道 Claude Code。**

> 早期版本（v2 及之前）的目标是「把任务执行全部改道 Claude Code」。该前提在千问办公 1.3.x 已被取证否定——主对话按 `execution.harness` 逐轮分流，官方档位走 ACP 引擎，`QODER_CLI_PATH` 只能接到内部查询，结果是「只破坏官方链路、换不来任何 Claude 价值」。v3 因此反转默认：**官方一律透传，只有 Claude 档位改道**。详见 `docs/researches/` 与 `docs/DECISIONS.md` D15。

## 为什么存在？

千问办公的 UI（文档 / 表格 / PPT / 技能卡片 / 任务展示）体验不错，但其 Agent harness 能力弱。Claude Code 的 harness（工具、技能、MCP、权限、会话管理）更强，且计费透明。两者协议同构（qoder CLI 是 Claude Code CLI 的 fork），让共存成为可能。

## 当前状态

- 2026-08-21：探索完成 + 首版实现（v1）。
- 2026-08-22：macOS 注入方式升级为 LaunchAgent（与 App 本体解耦）。
- 2026-09-24：v2——双向控制协议桥接、参数应翻译尽翻译、Windows 命令行长度规避、会话语义适配。
- **2026-10-20：v3——共存路由（当前实现态）**。
  - 取证推翻 v2 前提：官方档位走 ACP 引擎，不经 `QODER_CLI_PATH`（`docs/researches/2026-10-20-engine-harness-routing.md`）。
  - shim 改为三分支：`passthrough`（默认，原样交给官方 CLI）/ `probe`（问宿主 `get_model_policy`）/ `claude`（仅 Claude 档位）。
  - Claude 档位用 App 自己的 BYOK 机制供给（`byok_custom_models` 表 + `ALLOW_CUSTOM_BYOK` env 开门），不碰 `app.asar`、不碰 UI。
  - 验证：38 项自动化断言 + 三层 E2E（真实官方 CLI 差分、真实厂商 SDK、真实 claude.exe）全绿。
- 待人工闭环：在千问办公 UI 里点选「Claude」档位发一条消息（见下文「怎么确认生效」）。

## 如何安装和运行

### 前提

- 已安装千问办公（Windows: `C:\Program Files\QwenWorkCN`，macOS: `/Applications/QwenWorkCN.app`）并能正常登录使用。
- 已安装 Claude Code CLI 且 `claude` 命令在 `PATH` 中可用（或通过 `QODER_BRIDGE_CLAUDE` 环境变量指定路径）。
- Node.js 已安装（用于执行 shim 脚本）。
- pnpm 已安装。

### 步骤

```bash
# 1. 安装依赖
pnpm install

# 2. 注册环境变量
#    Windows: 写入 HKCU\Environment 注册表并广播变更
#    macOS:   写 ~/Library/LaunchAgents plist（登录时自动 setenv）+ launchctl setenv 即时生效
pnpm apply

# 3. 写入「Claude」档位（App 的 BYOK 自定义模型表，provider 哨兵 claude-bridge）
pnpm model add --model opus --api-key placeholder --name Claude

# 4. 重启千问办公
#    官方档位（flash/pro 等）继续走官方服务，行为与没装本项目时逐帧一致；
#    在模型下拉的「我的模型」分组里选「Claude」，那一轮才改道 Claude Code。
```

撤销（恢复原引擎 + 清掉档位）：

```bash
pnpm unapply          # 撤销 QODER_CLI_PATH / QODERCLI_PATH / ALLOW_CUSTOM_BYOK
pnpm model prune      # 只删本项目写入的哨兵条目，不碰用户自配的 BYOK
```

### 怎么确认生效

| 想看什么 | 去哪看 |
|---|---|
| shim 是否被调用 | `src/logs/bridge-<pid>-<ts>.log`（无新文件 = 挂点失效或 App 未重启干净） |
| 走了哪条分支 | 日志里的 `[DECIDE]`：`passthrough (internal query)` / `passthrough (--model ...)` / `probe` → `claude (provider=claude-bridge)` |
| Claude 档位是否被 App 认下 | `%APPDATA%\QwenWorkCN\logs\<会话>\main.log` 里 `getQoderWorkModels() completed {...customModelCount:1...}` 与 `allowCustomBYOK:true` |
| Claude 侧成本 | `~/.qwenwork-bridge/ledger.jsonl`（每条 `result` 一行） |
| 官方档位是否被动过 | `pnpm e2e:native`——差分证明「直连官方 CLI」与「经 shim 透传」逐帧同构、退出码一致 |

### 自动化验证

```bash
pnpm install        # 依赖走境内镜像（.npmrc 已钉 registry）
pnpm test           # 38 项断言：三条分支 + 共存不变式（argv 零改写 / env 增删 / 探测帧不外泄 / 退出码 41 / 翻译回归）
pnpm e2e:native     # 真实 qoderclicn.exe 差分：直连 vs 经 shim 透传逐帧同构（不耗额度）
pnpm e2e:sdk        # 真实厂商 SDK 驱动 shim（验证 get_model_policy 探测帧被 SDK 认下），7 项
pnpm e2e            # 上面三层一次跑完
pnpm e2e:real       # 真实 claude.exe + 真实官方 CLI 双分支，7 项（会产生约 $0.01~0.08 的 Claude 侧调用）

# e2e:sdk / e2e:real 需要千问办公自带的厂商 SDK；它只读复用，由 vendor-sdk.mjs 暂存到
# .analysis/vendor-sdk（可重建、已 gitignore），其裸依赖由本仓库 node_modules 解析。
```

### 环境变量（可选）

| 变量 | 说明 |
|---|---|
| `QODER_BRIDGE_CLAUDE` | 覆盖 `claude` 可执行文件路径（默认 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`，因千问办公进程的 `PATH` 通常不含 npm 全局目录） |
| `QODER_BRIDGE_QODERCLI` | 覆盖**官方原生 CLI** 路径（透传分支用）；设为**空串** = 强制无原生 CLI，退回 v2 式全量桥接（测试用） |
| `QODER_BRIDGE_BYOK_PROVIDER` | 路由哨兵值，默认 `claude-bridge`；必须与 `pnpm model add` 写入的 `provider` 一致 |
| `QODER_BRIDGE_PROBE_TIMEOUT_MS` | `get_model_policy` 探测超时（默认 6000）；超时保守走透传，宁可让这一轮走官方也不破坏官方链路 |
| `QODER_BRIDGE_MODEL` | 强制指定 claude 模型别名（默认用探测到的模型名） |
| `QODER_BRIDGE_NODE` | **macOS 专用**：覆盖 `node` 路径（默认 `/opt/homebrew/bin/node`） |
| `ALLOW_CUSTOM_BYOK` | 由 `pnpm apply` 注册；千问办公官方的 BYOK 开关，只影响自定义模型可见性，不改变官方档位行为 |

> **踩坑提示** 若 `pnpm apply` 后千问办公仍不显示「Claude」档位：
> 1. 必须**完全退出所有 `QwenWorkCN` 进程**再启动——App 有 `binaryPathComputed` 缓存，且注册表/launchd 变量只对之后启动的进程生效；从某些终端 `Start-Process` 拉起的进程会继承**旧**环境变量，此时用 `~/.qwenworkcn/.env` 写 `ALLOW_CUSTOM_BYOK=1` 更可靠（App 的 `loadQoderDotEnv()` 自己读）。
> 2. `src/logs/` 无新文件 = shim 从未被调用，核对 `reg query HKCU\Environment`（Windows）或 `launchctl getenv QODER_CLI_PATH`（macOS）。
>
> **关于千问办公升级**：LaunchAgent（macOS）/ 注册表（Windows）与 App 本体解耦，升级不会破坏注入链路；升级后若失效，原因是 App 不再读这两个挂点（与注入方式无关），跑一次 `pnpm apply` + 看 `src/logs/` 即可确认。另需注意 `byok_custom_models` 表结构与 `plainBase64` 编码分支是否仍在（本项目依赖它们供档位）。
>
> **macOS 平台特殊说明**：千问办公的 `PATH` 被限制为 `/usr/bin:/bin:/usr/sbin:/sbin`，不含 `/opt/homebrew/bin`，因此 shell wrapper（`src/bridge-shim-wrapper.sh`）会显式查找 node 和 claude 的完整路径。

## 核心技术

- Electron 应用逆向（asar 只读解包分析，见 `docs/researches/`）
- `@qoder-ai/qoder-agent-sdk`（1.0.53）JSONL 流协议 + `control_request` 控制协议（wire protocol 1.5.0）
- `get_model_policy` 拉取式模型策略协商（CLI → 宿主），及其 `custom_model.provider` 路由判据
- Claude Code CLI `--output-format stream-json` 协议
- Node.js 路由层（默认透传 / 按需改道 / 双向控制协议桥接 / 事件改写 / 成本台账）
- 千问办公 BYOK 自定义模型链路（`byok_custom_models` 表 + `allowCustomBYOK` 门 + `harness="qoder-cli"` 硬编码路由）
- **Windows**: 注册表 `HKCU\Environment` 用户级环境变量 + `WM_SETTINGCHANGE` 广播
- **macOS**: LaunchAgent（登录时 `launchctl setenv` 自动注入，重启不失效）+ shell wrapper 绕过 PATH 限制
