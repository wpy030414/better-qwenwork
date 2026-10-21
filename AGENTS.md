# AGENTS.md

## 项目是什么

本仓库是「千问办公（QwenWorkCN）与 Claude Code 共存」工程的文档与实现。千问办公是阿里出品的 Electron 应用，内置本地 Agent 引擎（qoder CLI 体系）；本项目的目标是：**保留千问办公 UI 与全部官方模型，额外提供一个可选的「Claude」档位——用户选官方模型时原样走官方服务，选 Claude 时任务执行改道 Claude Code，UI 保持原样。**

> 注意前提变化：1.3.x 之前本项目的表述是「让该引擎的任务执行全部改道 Claude Code」。该前提已被 2026-10-20 的取证否定（App 按 `execution.harness` 逐轮分流，官方档位走 ACP 引擎，`QODER_CLI_PATH` 只能接到内部查询），详见 `docs/researches/`。当前实现态是 v3 共存路由（决策见 `docs/DECISIONS.md` D15/D16）。

## Agent 如何理解这个项目

- 核心挂点：**`QODER_CLI_PATH` + `QODERCLI_PATH` 两个环境变量**（用户级）+ **`ALLOW_CUSTOM_BYOK`**（BYOK 显示门）。前两者必须同时注册——App 壳层 `main.js` 的 `getBundledQoderCliPath()` 读前者，SDK 内核的 `resolveExecutable()` 读后者；若该路径以 `.js/.mjs` 结尾，SDK 会用 `node <path>` 执行——因此 shim 是一个 Node 脚本，无需编译。**重要：这只劫持 `harness=qoder-cli` 的那条链路（含官方内部查询与本项目提供的 Claude 档位），官方档位（flash/pro）走 ACP 引擎，完全不读这些变量。** Windows 写入 `HKCU\Environment`；macOS 写 `~/Library/LaunchAgents/com.clauded.qwenwork-bridge.plist`（登录时 `launchctl setenv` 自动注入，重启不失效）。
- Claude 档位怎么来：`pnpm apply` 往 App 自己的 `byok_custom_models` 表写一条 `provider=claude-bridge` 的记录；App 对 BYOK 条目硬编码 `harness="qoder-cli"`，下拉显示由 `allowCustomBYOK = hasCustomByokEnvOverride() || 账号 allowBYOK>=2` 控制（本机账号 `allow_byok=0`，故靠 env 开门）。
- shim 三分支（v3）：默认 `passthrough`（原样交给官方 `qoderclicn.exe`，argv/帧/退出码零改写）；`probe`（无 `--model` 且非内部查询时向宿主发 `get_model_policy` 问路由）；`claude`（仅当应答 `custom_model.provider` 等于哨兵）。探测失败一律保守透传。
- 安装/卸载：**只有两个命令**——`pnpm apply` 一条做完（注册环境变量 + BYOK 开关 + 写/更新档位 + 落文案），`pnpm unapply` 对称撤销（默认一并清掉本项目档位）。档位查看/文案/清理是 `pnpm apply list|labels|prune` 子命令。详见 `src/index.mjs`（命令面）与 `src/byok-store.mjs`（数据层）。
- 协议面：SDK ↔ CLI 走 JSONL 流（`--output-format stream-json`），其上叠加了 qoder 特有的 `control_request`/`control_response` 控制协议与 `system/init` 握手（`protocol_version`，major 必须为 1）。CLI 是 Claude Code CLI 的 fork，参数与事件结构同构，但存在差异清单（见 `docs/ARCHITECTURE.md` 与 spec）。
- 原始素材：本机 `C:\Program Files\QwenWorkCN\1.3.2-26101704\`（Windows）和 `/Applications/QwenWorkCN.app`（macOS）均可解包分析；只读取证产物放 `.analysis/`（已 gitignore）。

## 代码结构

```
src/
├── bridge-shim.mjs          # 共存路由层（被 SDK spawn 为 "qoder CLI"）：透传 / 探测 / 改道
├── native-cli.mjs           # 定位官方 qoderclicn.exe（供透传）+ 递归防护 env 清理
├── index.mjs                # pnpm apply / unapply：挂点 + 开关 + 档位 + 文案（唯一命令面，跨平台）
├── byok-store.mjs           # byok_custom_models 数据层（无命令面；node:sqlite 开库时动态引入）
├── dynamic-text.mjs         # 档位标题/副标题：本地文案缓存读写 + 云端覆盖后从意图源重放
├── bridge-shim-wrapper.sh   # macOS shell wrapper（绕过 PATH 限制）
└── logs/                    # 运行时日志（.gitignore 已排除）

docs/researches/             # 带证据链的逆向取证记录（允许含被推翻的结论）
```

**代码库里没有测试与 e2e 脚本**（决策见 DECISIONS.md D18）：它们的产出是「某时间点对真系统的观测」，
已全部转写为 `docs/researches/2026-10-21-*.md`；复现用的驱动脚本与替身放在
`.analysis/legacy-verification/`（gitignore，与产品代码物理隔离）。改动 shim 时按那些记录的
「判据」逐条自查，不要往 `src/` 里加 `*.test.mjs` 或 `mock-*.mjs`。

## 项目边界（In Scope）

- 编写共存路由 shim（默认透传、按需改道、参数翻译、控制协议应答、事件改写、成本台账）。
- 编写安装工具（`index.mjs` 一条命令注册挂点、开关与档位；`byok-store.mjs` 是唯一的表读写层）。
- 维护验证的**结论**：把真机/密闭观测写成 `docs/researches/` 记录（差分证明官方档位零影响、
  真实 SDK 认下探测帧、真实 claude 双分支与计费台账），并保留可复现工具于 `.analysis/`。
- 复用千问办公内置 skills（`resources/skills/*/SKILL.md`，格式与 Claude Code 同构）到 `~/.claude/skills/`。
- 编写/维护本项目文档（README / PRD / ARCHITECTURE / DECISIONS / specs / researches）。

## 明确不属于范围（Non-Goals）

- **不改 app.asar**：所有改动通过环境变量挂点、App 自身的 BYOK 数据表与外部 shim 实现；asar 内代码只读分析。
- **不改官方模型的行为**：官方档位必须由官方服务执行，与未安装本项目逐帧一致（这条是 v3 的第一原则，由真 exe 差分观测守护，见 `docs/researches/2026-10-21-shim-behavior-contract.md` §三）。
- 不修改千问办公的 UI、登录、云端账号体系（登录仍走千问账号，Claude 侧用主人已有的 Claude 登录态）。
- 不绕过任何付费墙；计费完全走主人已有的 Claude Code 计费通道。
- 不重新实现 Office 能力（docx/pptx/xlsx/pdf 等）：优先复用其 skills 或 Claude 生态技能。
- 不做多用户、不做分发包、不做协议逆向之外的任何灰产用途。
- 图像生成等 qoder 云端专属能力（ImageGen/ImageSearch）不移植，属已知降级。

## 全局规则

- 千问办公每次更新后需重新核对（**升级本身不会破坏注入链路**：macOS LaunchAgent 与 App 本体解耦，Windows 注册表也不随 App 更新被清除）：
  1. **挂点是否仍被读**：跑一次 `pnpm apply` + 在 App 里发条消息，看 `src/logs/` 是否有新日志。
  2. **分流格局是否变化**：App 若改了 `execution.harness` 路由（例如把官方档位也挪到 SDK→CLI），shim 的判据要重新核对——判据方向是「有 `--model` ⇒ 官方档位（充分）」、「无 `--model` ⇒ 歧义，必须探测」。
  3. **BYOK 供给链是否还在**：`byok_custom_models` 表结构、`hasCustomByokEnvOverride()` 的 env 名、`plainBase64` 编码分支、以及 `custom_model.provider` 的校验规则（CLI 侧有 `get_model_policy model must use the outerProvider key prefix` 之类的硬约束），任一变动都可能让档位消失或改道失效。
  4. 注意 v3 的默认分支是**透传**：即使挂点被劫持，官方档位的实际行为仍与原生一致（差分观测是这条不变式的守护判据，见 researches/2026-10-21-shim-behavior-contract.md §三）。挂点失效的后果是「Claude 档位消失」，而不是「官方模型坏掉」。
- `claude` 可执行文件路径：
  - **Windows**: `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`（千问办公进程的 PATH 通常不含 npm 全局目录）
  - **macOS**: 自动探测 `/opt/homebrew/bin/node`、`/usr/local/bin/node` 等常见路径；也可通过 `QODER_BRIDGE_CLAUDE` 显式指定
- 官方 `qoderclicn.exe` 路径由 `src/native-cli.mjs` 定位（`updater.cfg:currentVersion` → 版本目录 → 枚举兜底）；**不可照抄 App 的 `getBundledQoderCliPath()`**，它第一优先级就是 `QODER_CLI_PATH`，照抄会拿到 shim 自己造成递归。
- macOS 平台特殊：SDK spawn 时 PATH 被限制为系统路径，需用 shell wrapper 探测 node 绝对路径。
- 排查 shim 是否被调用：看 `src/logs/bridge-*.log`，其中 `[DECIDE]` 行给出本轮走了哪条分支。
- **真机验证过的判因**：UI 报「你当前的账号没有使用该模型或能力的权限」（main.log 里
  `decoderId:"qodercli-result"` + `sourceCode:403`）**几乎总是注入未生效**，而非官方服务或
  档位写坏——因为 BYOK 档位在下拉里始终可见可选，但只有 shim 参与时才会改道 claude；
  没有 shim 时 App 会拿表里的占位 api_key 直连 MaaS 而被账号权限拒绝。
  典型成因是从**继承不到新环境变量**的终端里 `Start-Process` 启动了 App。
  判据就是这条：该时刻 `src/logs/` 有无新文件。官方档位不受影响（走 ACP，与注入无关）。
- 两个易踩的协议坑（都已在实现里修掉，改动时勿回退）：
  - `QODER_SDK_AUTH_PAYLOAD_FILE` 指向的文件会被官方 CLI 在收尾时**删除**，任何「跑两次」的测试必须各自新建一份。
  - 子进程退出后 shim 必须主动收尾 stdin（`detachStdin`），否则 readline 吊住事件循环、SDK 的 SIGTERM 会把退出码 41（认证过期）吞成 143。
- 所有文档遵循本仓库结构与 CLAUDE.md 的全局文档规范。
