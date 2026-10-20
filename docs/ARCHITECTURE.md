# ARCHITECTURE — 千问办公内部结构解剖与换芯架构

回答「系统整体是如何组织的」。

## 一、现状解剖（2026-08-21 实测）

### 1. 安装布局

```
C:\Program Files\QwenWorkCN\
├── Launcher.exe          # 启动器（多版本管理）
├── Updater.exe           # 更新器（Squirrel 风格）
├── updater.cfg           # 当前版本 0.1.8-26081406
└── 0.1.8-26081406\       # 版本目录（历史版本保留：0.1.6/0.1.7）
    ├── QwenWorkCN.exe    # Electron 主程序（204MB）
    ├── resources\
    │   ├── app.asar      # 154MB 应用代码（已解包分析）
    │   ├── app.asar.unpacked\node_modules\   # 原生模块（117MB）
    │   ├── bin\          # qoderclicn.exe / qoderclicn-legacy.exe / qwenwork.exe / 辅助 exe
    │   ├── skills\       # 内置技能：create-skill docx find-skills media-generation pdf
    │   │                 #   plugin-creator pptx qw-pages qw-pages-supabase
    │   │                 #   qwenwork-guidance xlsx（均为 SKILL.md + toolkit）
    │   ├── commands\     # create-command.md（slash 命令）
    │   ├── legokits\     # 插件体系（plugin-market-data.json）
    │   ├── vm-boot\      # 沙箱引导
    │   └── ...
```

用户数据：`%APPDATA%\QwenWorkCN\`、`~/.qoder-cn\`（CLI 配置目录，等价 `~/.claude`）、`~/.qwenworkcn\`。

### 2. Agent 引擎三层结构（替换目标）

```
out/main/index.js（Electron 主进程，打包为 out/main/main.js）
   └─ @qoder-ai/qoder-agent-sdk（asar 内 node_modules，npm:@ali/qoder-agent-sdk-next@1.0.20）
        ├─ 默认：WorkerFallbackTransport → 加载 worker runtime 到 worker_threads 进程内执行
        └─ 设置 QODER_CLI_PATH 后：ProcessTransport → spawn 外部 CLI 二进制，JSONL 流通信
             └─ qoderclicn.exe v1.1.18（resources\bin，bun 编译，Claude Code CLI 的 fork）
                  └─ qoder-worker-runtime.obf.mjs（36MB 混淆：agent 循环/工具/skills/MCP/hooks）
```

### 3. 协议面（SDK ↔ CLI）

- 启动参数：`--print --output-format stream-json --input-format stream-json [--include-partial-messages]`，
  叠加 `--model --resume/--continue/--session-id --fork-session --permission-mode --yolo/--dangerously-skip-permissions --allowed-tools --disallowed-tools --tools --mcp-config --strict-mcp-config --allowed-mcp-server-names --settings --setting-sources --plugin-dir --add-dir --max-turns --agent --debug --no-session-persistence --extensions --permission-prompt-tool` 等。
- 双向 JSONL：stdin = control_request 帧 + 用户消息；stdout = `system/init`（握手）、`assistant`、`user`、`result`、`control_response` 等事件。
- 握手：`system/init.protocol_version`（SDK 1.0.46 内置 1.5.0，major 必须为 1；缺省仅警告）；`capabilities` 数组（如 `background_tasks_v1`）。
- 控制协议（control_request/control_response，qoder 特有，claude 原生支持部分子类型）：
  - **claude 原生支持**（v2 直接转发）：`initialize`、`set_permission_mode`、`set_model`、`get_context_usage`、`interrupt`、`stop_task`、`cancel_async_message`、`background_tasks`、`mcp_set_servers`、`mcp_toggle`、`mcp_reconnect`、`mcp_authenticate`、`apply_flag_settings`、`seed_read_state`。
  - **shim 合成应答**：`get_models`、`generate_session_title`、`account_info`、`get_usage_info`、`can_use_tool`（claude 不发，SDK 侧自动放行）等。
  - **双向桥接**：claude 发出的 `control_request`（如 `can_use_tool` 权限弹窗）→ 转给 SDK，SDK 应答经 stdin 回流 claude。
- 退出码语义：41 = 认证过期（触发 app 重新登录），0 = 正常。

### 4. App 实际使用面（main.js 中确认）

- 三类查询：主对话（query-runtime）、闲置建议生成（`disallowedTools:["*"]`）、内部意图分类（tool-budget / command-intent，`tools:[]`、`maxTurns:1`）——全部经同一 transport 工厂，`QODER_CLI_PATH` 一设全接管。
- 使用的 SDK 能力：`resolveModel`(14)、`stopTask`(12)、`getContextUsage`(5)、`getAvailableModels`(4)、`setPermissionMode`(3)、`generateSessionTitle`(3)、`canUseTool`(1)。
- app 对 result 事件消费：`duration_ms`(59)、`is_error`(17)、`num_turns`(2)；不读 `total_cost_usd`（成本展示来自 qoder 云端用量接口）。
- renderer 按 qoder 工具名渲染卡片：`Agent`(260)、`ImageGen`(5)、`TaskCreate`(3)、`ImageSearch`(2)。

### 5. qoder CLI 与 Claude CLI 差异清单（shim 必读）

| 类别 | 说明 |
|---|---|
| 必加参数 | claude 2.x 要求 `--output-format stream-json` 必须配 `--verbose`（qoder 不需要） |
| qoder 特有参数（需过滤） | `--caller-version --ide-type --session-mirror --porcelain --keep-data --workdir --org-id --email --extensions --disable-builtin-skills --permission-prompt-tool --yolo --max-turns --tools`（空串形式） |
| 直接兼容参数 | `--print --output-format --input-format --include-partial-messages --resume --continue --fork-session --session-id --permission-mode --dangerously-skip-permissions --allowed-tools --disallowed-tools --mcp-config --strict-mcp-config --allowed-mcp-server-names --settings --plugin-dir --add-dir --model --agent --debug --no-session-persistence --bare` |
| 参数值翻译 | `--permission-mode bypassPermissions` ↔ `bypassPermissions`（claude 同词）；app 传 `--setting-sources ""`（空）→ shim 应丢弃，让 claude 加载用户/项目设置；model 名 qwen-* → claude 别名 |
| 工具名映射 | claude `Task`（子代理）→ qoder `Agent`；claude `TodoWrite` → qoder `TaskCreate`；qoder `ImageGen/ImageSearch` 无对应（缺失） |
| 事件差异 | claude `system/init` 无 `protocol_version` → shim 注入 `protocol_version:"1.5.0"`；`capabilities` claude 自带 |
| 控制协议 | claude 原生支持部分 control_request（initialize/set_permission_mode/set_model/get_context_usage/interrupt 等）→ v2 直接转发；其余由 shim 合成应答 |
| 输入格式 | SDK 的 stdin 消息含 `uuid/session_id` 等附加字段，claude 容忍多余字段 |
| 会话语义 | qoder `--session-id` 幂等、`--resume` 容错；claude 语义相反 → shim 按 cwd 查会话文件互转（D11） |
| 命令行长度 | Windows CreateProcess 限制 32767 字符 → 超长 systemPrompt/mcp-config 写入临时文件用 `--*-file` 语法传入（D12） |

## 二、换芯后架构（当前实现态 v3，2026-10-20：共存路由）

> v2 的前提「shim 接管一切」在 1.3.x 已失效（取证见 `docs/researches/`）。v3 反转默认：
> **官方模型一律原样透传官方 CLI，只有用户主动选中「Claude」档位时才改道。**

```
千问办公 UI（不变，asar 不动）
   └─ Electron 主进程（不变）
        ├─ execution.harness = oc/qc（官方 flash/pro 等）
        │    └─ ACP 引擎：spawn(process.execPath, [flash-cli-acp.mjs | qwen-code/cli.js --acp])
        │        ← **完全不经过本仓库任何代码**，官方链路零影响
        └─ execution.harness = cc/qo/null 与 BYOK 档位（本项目 Claude 档位）
             └─ qoder-agent-sdk 1.0.53 ProcessTransport
                （QODER_CLI_PATH + QODERCLI_PATH 双注册触发；App 壳层读前者作为
                 options.pathToQoderCLIExecutable 传 SDK，优先级最高；SDK 内核备用读后者）
                └─ node src/bridge-shim.mjs  ← 三分支路由
                     ├─ passthrough（默认，零改写）
                     │   ├─ spawn 官方 qoderclicn.exe（src/native-cli.mjs 定位，不照抄
                     │   │   App 的 getBundledQoderCliPath——它首选 QODER_CLI_PATH 会拿到 shim 自己）
                     │   ├─ env：删 QODER_CLI_PATH/QODERCLI_PATH（防递归），保留三个
                     │   │   QODER_AGENT_SDK_*（否则官方 CLI 报 sdk_invalid_args）
                     │   ├─ argv 原样、帧原样字节泵、SIGTERM/SIGINT 转接、退出码原样传播
                     │   │  （41=认证过期是协议；子进程退出即 detachStdin，否则 SDK 的 SIGTERM
                     │   │   会把 41 吞成 143）
                     │   └─ 触发条件：内部查询（--bare/--disallowed-tools */--tools ""）
                     │       或 argv 带 --model（App 对 BYOK 硬排除 --model ⇒ 官方档位充分判据）
                     ├─ probe（无 --model 且非内部查询 ⇒ 有歧义，必须问宿主）
                     │   └─ 主动发 control_request{get_model_policy} → 读应答
                     │       custom_model.provider == 'claude-bridge'（BYOK 哨兵）？
                     │       是 → claude；否/超时/异常 → passthrough（保守，先保官方链路）
                     │       探测期间宿主帧全部缓冲，决策后按序补喂，一帧不丢
                     └─ claude（仅 Claude 档位）
                         ├─ 参数翻译/过滤 → spawn claude.exe（QODER_BRIDGE_CLAUDE 可覆盖）
                         ├─ stdin：双向控制协议桥接（v2 成果保留）
                         │   ├─ FORWARD_NATIVE 命中的 control_request 直接转发 claude
                         │   ├─ claude 不支持的由 shim 合成兜底；未知子类型放行（不得吞
                         │   │   fetch_job_token，否则官方鉴权链断）
                         │   └─ claude 上行 control_request（can_use_tool 权限弹窗）→ 转 SDK，
                         │       SDK 应答经 stdin 回流 claude
                         ├─ stdout：事件改写（init 注入 protocol_version 1.5.0、Task→Agent）
                         ├─ 会话语义适配（D11）、Windows 命令行长度规避（D12）
                         ├─ 成本台账：result.total_cost_usd → ~/.qwenwork-bridge/ledger.jsonl
                         └─ 黑匣子（D14）：uncaughtException/unhandledRejection/stderr 落盘
```

路由判据的方向性（易错点）：**有 `--model` ⇒ 必为官方档位**（充分条件，可省一次探测往返）；
**无 `--model` ⇒ 歧义**（可能是 BYOK，也可能是 `modelId !== modeKey` 的官方档位，
因为 App 的 `omitModel` 会一并省略），必须靠 `get_model_policy` 应答定夺。

### Claude 档位怎么来（共存的另一半）

```
src/byok-model.mjs（pnpm model add/list/rm/prune）
   └─ 写 %APPDATA%\QwenWorkCN\data\agents.db 的 byok_custom_models 表
        ├─ provider = 'claude-bridge'  ← shim 的路由哨兵，勿改
        ├─ style/format = anthropic，model = opus（别名，任何 Claude 登录态都吃）
        ├─ encrypted_parameters = {"api_key":{"encoding":"plainBase64","value":"..."}}
        │   （App 官方支持该分支；safeStorage 不可用时的落盘形态，零第三方依赖）
        └─ key = byok-<base64url>（与 App 的 createByokModelKey() 同构，前缀必须保留）

App 侧读取链（无需改 App）：
   listByokCustomModels() → ModelCatalogService({loadCustomModels}) → auth.getModels
     → {models: 云端 chat-modes, customModels: 本表} → 下拉「我的模型」分组
   可见性单一门：allowCustomBYOK = hasCustomByokEnvOverride() || 账号 allowBYOK >= 2
     前者读 process.env / ~/.qwenworkcn/.env 的 ALLOW_CUSTOM_BYOK|ALLOW_BYOK（1/true/yes/on）
   路由：isMissingCatalogModel() 对 byok- 前缀显式豁免；resolveLocalByokModelRoute()
     硬编码 harness="qoder-cli" ⇒ 必然落进上面那条被劫持的链路
   ⇒ 分流由 App 自身完成：官方档位走 ACP、Claude 档位走 SDK→CLI，互不干扰
```

### 辅助工具

```
src/index.mjs（pnpm apply / pnpm unapply，跨平台）
   ├─ 注册三项：QODER_CLI_PATH + QODERCLI_PATH → shim 绝对路径
   │            ALLOW_CUSTOM_BYOK=1 → BYOK 显示门（D16）
   ├─ Windows: reg add HKCU\Environment + WM_SETTINGCHANGE 广播；unapply 反删除
   └─ macOS:   LaunchAgent plist（RunAtLoad setenv）+ 即时 setenv；unapply unsetenv + 删 plist
   注意：注册表/launchd 只对**之后启动**的进程生效；已运行的千问办公需重启。

src/native-cli.mjs（官方 CLI 定位，供 passthrough 使用）
   ├─ QODER_BRIDGE_QODERCLI 显式覆盖（空串 = 强制无原生 CLI，退回全量桥接）
   ├─ process.resourcesPath/bin → updater.cfg:currentVersion → 枚举版本目录取最新
   └─ legacy 判定仅作诊断（官方规则 win32 && x64 && (build<17763 || 无 AVX2)）

src/bridge-shim-wrapper.sh（macOS 专用）
   ├─ 被 QODER_CLI_PATH 指向（替代 .mjs，因 SDK spawn 时 PATH 不含 homebrew）
   └─ 探测 node 绝对路径后 exec node bridge-shim.mjs
```

### 数据流（一次任务，v3）

1. 用户选官方档位（flash/pro）发消息 → App 按 harness 走 **ACP 引擎**，本仓库代码全程不参与。
2. 用户选「Claude」档位发消息 → App 走 SDK→CLI：`spawn node src/bridge-shim.mjs --print ...`
   （BYOK 档位不下发 `--model`）。
3. shim 判分支：内部查询/带 `--model` → 透传；否则发 `get_model_policy` 探测。
4. 探测应答 `custom_model.provider == claude-bridge` → 改道 claude；宿主在探测期间发来的帧
   按序补喂，`initialize` 的 `systemPrompt` 等在延迟 spawn 时翻译成 CLI 旗标（D12 规避长度）。
5. 双向控制桥接 + 事件改写 → SDK → main.js → renderer 渲染。
6. `result` → shim 记台账 → 退出码原样传播（含 41）。

### 验证面

```
pnpm test          src/bridge-shim.test.mjs  38 项断言/7 组：三条分支 + 共存不变式
                            （argv 零改写、env 增删、探测帧不外泄、退出码 41 传播、翻译回归）
pnpm e2e:native    e2e-diff.mjs  真实 qoderclicn.exe 差分：直连 vs 经 shim 透传
                            归一化帧序列同构 + 退出码一致 + 无 sdk_invalid_args
pnpm e2e:sdk       e2e-sdk.mjs  真实厂商 SDK 1.0.53 驱动 shim（get_model_policy 探测帧
                            被 SDK 认下并回调宿主 resolveModel、握手过校验）7 项
pnpm e2e           上面三层一次跑完（不产生 Claude 侧调用）
pnpm e2e:real      e2e-real.mjs  真实 claude.exe + 真实官方 CLI 双分支 7 项
                            （实测回复「共存成功」，$0.009~0.073/次，走主人既有 Claude 计费）

厂商 SDK 由 vendor-sdk.mjs 从 App 安装目录只读复制并暂存到 .analysis/vendor-sdk
（可重建、已 gitignore）；其裸依赖 @modelcontextprotocol/sdk 由本仓库 node_modules 提供。
```

### 已知风险（未在真机 UI 闭环的部分）

> 2026-10-20 20:00 更新：UI 链路**已真机闭环**（CDP 只读检查 + 主人实机点选），
> 下面是实测结论与仍需盯的点。

**已证实**：

- 下拉同时列出官方三档与 Claude，共存形状正确：
  `标准 0.1X` / `高级 1X` / `Qwen3.8-Max 1.8X` / **`Claude Anthropic · opus`**（`modelListCount:4`）。
- 主人实机点选被 App 接受：`[ModelSelection] Global default model updated
  {"oldModelKey":"flash","newModelKey":"byok-pQRamboR_hlK","origin":"user_selector"}`，
  无 `model_route_missing`、无「回落到目录默认」。
- 路由如取证预测：`harness":"qoder-cli"` + `catalogSource":"local-byok"`
  + `routeSource":"desktop-catalog"`。
- 端到端跑通（注入生效的一次启动）：shim `[DECIDE] probe` →
  `[DECIDE] claude (provider=claude-bridge)` → 真 `claude.exe` 执行 →
  台账 `{total_cost_usd:0.172, num_turns:1, is_error:false}`，UI 正常显示回复；
  同期官方内部查询仍走 `[DECIDE] passthrough (internal query)` → 官方 CLI `code=0`。

**关键运维陷阱（真机踩过一次，务必保留）**：

若在**未携带注入变量的环境**里启动千问办公（例如从终端 `Start-Process` 而注册表变量
还没广播到该进程），则 `QODER_CLI_PATH` 不生效、shim 不参与，但 **BYOK 档位仍在下拉里
且仍可被选中**。此时 App 会走它自己的 `local-byok` 路径：官方 CLI 拿着我们表里的占位
`api_key` 直连 MaaS，被账号权限拒绝，UI 表现为——

```
「你当前的账号没有使用该模型或能力的权限。请在输入区切换模型后重试。」
main.log: Engine failure projected to API error
          {"decoderId":"qodercli-result","sourceCode":403,"failureKind":"permission-denied"}
```

这是**注入没生效**的诊断信号，不是官方服务出问题，也不是档位写坏了。
判据：`src/logs/bridge-*.log` 有无对应时刻的新文件（无 = 注入未生效）。
解法：`pnpm apply` 后**完全退出所有 QwenWorkCN 进程**再启动；或确认
`~/.qwenworkcn/.env` 有 `ALLOW_CUSTOM_BYOK=1`，并从继承不到旧环境变量的途径启动（Explorer）。
官方档位不受影响——它走 ACP 引擎，与注入是否生效无关。

**仍需盯的点**：

- `style/format` 词表与 `custom_model` 的校验规则（`get_model_policy model must use the
  outerProvider key prefix` 等）来自二进制字符串与推断；目前 `provider=claude-bridge` +
  `style=anthropic` + `model=opus` 在真机可用，若 App/CLI 收紧校验需回退为别名直发 `--model`。
- 探测分支给每次 Claude 轮次多一次控制帧往返（官方档位走 `--model` 快路，不受影响）。
- BYOK 表属用户级配置：升级后需复查表结构、`plainBase64` 分支、`hasCustomByokEnvOverride()`
  的 env 名是否仍在。

### 外部系统

- Claude API / 主人已有的 Claude 登录态（计费通道，不变）。
- 千问办公云端（登录、账号、office 能力）仍走原通道，仅 Agent 执行改道。
- 主人已有的 claude 配置（`~/.claude/settings.json`、MCP、skills、hooks、permissions）在 claude 侧自动生效。
- qw-builtin MCP 网关（千问办公本地工具，127.0.0.1 端口）经 `--mcp-config` 透传给 claude。
