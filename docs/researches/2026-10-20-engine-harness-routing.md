# 引擎按 harness 分流与桥接失效取证

- 观测对象：QwenWorkCN `1.3.1-26101419`、`1.3.2-26101704`（本机 Windows）
- 配套版本：`@qoder-ai/qoder-agent-sdk` = SDK 1.0.53（`QODER_AGENT_SDK_VERSION` 实测值）、`qoderclicn` = 1.1.71、协议 `protocol_version = 1.5.0`
- 取证时间：2026-10-20
- 触发缘由：核查「让官方模型与 Claude 共存、选官方模型时透传」这一诉求的可行性

## 结论速览

| 命题 | 判定 | 强度 |
|---|---|---|
| 主对话不再经过 `QODER_CLI_PATH`，改由 ACP 引擎执行 | 成立 | 确证（多源交叉） |
| `QODER_CLI_PATH` 挂点本身仍然生效 | 成立 | 确证（现场日志） |
| 桥接开启时，shim 只收到 `--bare` 内部查询并以合成应答吃掉 | 成立 | 确证（现场日志） |
| 这不是 1.3.2 的回归，1.3.1 已同构 | 成立 | 较强（静态标志比对，方法学有局限） |
| 共存 + 官方透传的正确挂点是 `ENGINE_LOCAL_MANIFEST` | **已被推翻** | 见 §五：BYOK 档位 + 现有 `QODER_CLI_PATH` 即可，无需 ACP |
| UI 下拉里的 `Claude` 来自 `initialize.models` 旁路显示 | **已定论** | 与注入无关；官方档位来自云端 chat-modes，自定义档位来自 `byok_custom_models` 表 |

## 补记（同日实现验证后追加）

本轮 §五 的两个悬置问题在实现 E2E 中一并定死，并推翻两处原结论：

1. **「BYOK 路径已排除」是错的**。原判定只看账号 `allow_byok=0`，漏了 App 自己的 env 短路：
   `hasCustomByokEnvOverride()` 读 `process.env` 或 `~/.qwenworkcn/.env` 的
   `ALLOW_CUSTOM_BYOK` / `ALLOW_BYOK`（值 ∈ 1/true/yes/on）。真机实测：写入 `.env` 并重启后
   `main.log` 由 `envAllowsCustomByok:false, allowCustomBYOK:false` 变为
   `allowBYOK:0, envAllowsCustomByok:true, allowCustomBYOK:true`——账号权限位被绕过且不改官方行为。
2. **共存不需要 ACP 挂点**。App 的 `resolveLocalByokModelRoute()` 对 BYOK 条目硬编码
   `harness:"qoder-cli"`，且 `isMissingCatalogModel()` 显式豁免 `byok-` 前缀的目录校验；
   同时 `resolveNewSessionModelRoute()` 的 BYOK 分支在 `multiCliEnabled` 判定**之前**。
   因此 Claude 档位必然落进 SDK→CLI 链路（正是 `QODER_CLI_PATH` 劫持的那条），
   而官方 flash/pro 继续走 ACP 引擎——**分流由 App 自身完成，共存是既有架构的自然结果**。
   实测目录读取：`getQoderWorkModels() completed {modelCount:3, customModelCount:1, fetchStatus:"success"}`。
3. **`--model` 只能作单向充分判据，不能作必要判据**。`buildMainSessionRuntimeExtraArgs` 的条件是
   `model && !omitModel && !hasByokCustomModel(model)`，其中 `omitModel = modelId !== modeKey`
   对官方档位也可能成立 ⇒
   - 「有 `--model`」⇒ **必为官方档位**（BYOK 被 `hasByokCustomModel` 硬排除），可直接透传，省一次往返；
   - 「无 `--model`」⇒ **歧义**（可能是 BYOK，也可能是 modelId≠modeKey 的官方档位），
     必须靠 `get_model_policy` 应答的 `custom_model.provider` 定路由（BYOK 时由我们写入哨兵）。

## 一、1.3.x 的执行体分流（核心发现）

主进程按**每个模型的 `execution.harness` 字段逐轮分流**，两条完全不同的执行体：

```
renderer 选模型（tRPC auth.getModels, scene:"qwork"）
   └─ 主进程 ModelCatalogService → execution.harness
        ├─ oc → opencode   ┐  ACP 引擎：childProcess.spawn(process.execPath,
        ├─ qc → qwencode   ┘    [manifest.entrypoint, ...manifest.args])
        │                       env ELECTRON_RUN_AS_NODE=1
        │                       ← 完全不读 QODER_CLI_PATH
        └─ cc / qo / null → qoder-cli   → SDK query() → transport → CLI 子进程
                                           ← 只有这条被 QODER_CLI_PATH 劫持
```

分流点（`out/main/main.js`，字节偏移约 7049416）：

```js
const fn = buildEngineModeFromExecutionRoute(pn, ...)   // harness==="qoder-cli" → undefined
function buildEngineModeFromExecutionRoute(n,e){ if(n.harness==="qoder-cli")return; ... }
if(!fn){ /* qoder-cli 路径 */ Gn=buildMainSessionRuntimeExtraArgs({model:Wn,...}); pathToQoderCLIExecutable:Na }
else   { /* ACP 路径 */ en=await startEngineTurn({engineId:l.engineId, sessionConfig:Un, promptText:xn, ...}) }
```

harness 码表（偏移约 1419448）：

```js
HOST_HARNESS_BY_CODE = Object.freeze({oc:"opencode", qc:"qwencode", cc:"qoder-cli", qo:"qoder-cli"}),
FALLBACK_HARNESS = "opencode"
function resolveHarness(n,e,r){ if(n===null) return "qoder-cli"; ... }
```

引擎清单 `resources/agent-sdk/engine-runtime-manifest.json`（version 1）声明两个引擎：`opencode`（`components/flash-cli/.../runtime/flash-cli-acp.mjs`）与 `qwencode`（`components/qwencode/.../runtime/qwen-code/cli.js --acp`）。

**`--model` 只在 qoder-cli 分支拼装**（偏移约 2991586）：

```js
function buildMainSessionRuntimeExtraArgs(n){ const e={};
  return n.model && !n.omitModel && !hasByokCustomModel(n.model) && (e.model = n.model), ... }
```

ACP 分支下发模型改用引擎侧 provider 配置（`buildEngineModeRuntimeConfig` / `buildHostModelConnection`，凭据来自 in-process `InProcessLocalModelProxy` 或 MaaS accessKey），不用 `--model`。

### 现场证据

`%APPDATA%\QwenWorkCN\data\agents.db` 中历史会话的模型路由记录（明文段可 grep）：

```
{"modeKey":"flash","harnessId":"opencode","modelId":"flash"}   ×4
{"modeKey":"pro","harnessId":"opencode","modelId":"pro"}       ×1
```

`"qoder-cli"` 在该库中出现 **0 次**。即本机可选档位全部是 ACP 引擎，用户实际用的 `flash`/`pro` 是**档位（modeKey）**而非具体模型名。

## 二、桥接失效取证

### 2.1 挂点仍生效，但只接到内部查询

14:44 / 14:45 / 14:49 三次真实调用（`src/logs/bridge-*.log`），argv 完全一致：

```
--print --output-format stream-json --input-format stream-json
--proxy http://127.0.0.1:7897 --permission-mode bypassPermissions
--disallowed-tools *
--tools Agent,AskUserQuestion,Bash,Edit,Glob,Grep,ImageGen,ImageSearch,
        NotebookEdit,Read,Skill,TodoWrite,UpdateGoal,WebFetch,WebSearch,Write
--setting-sources "" --disable-builtin-skills --bare
→ [MODE] internal (self-answered, no claude spawn)
→ [EXIT] code=0 (internal)
```

ENV 快照证明劫持机制本身健康（`QODER_AGENT_SDK_ENTRYPOINT=sdk-ts`、`QODER_AGENT_SDK_VERSION=1.0.53`、`QODER_CLI_PATH` / `QODERCLI_PATH` 双双命中、`QODER_SDK_AUTH_PAYLOAD_FILE` 已落盘）。

三次都命中 `parseArgs()` 的 internal 判据（`--disallowed-tools *` 与 `--bare` 同时成立），于是走 `runInternal()` 合成 `initialize` / `get_models` 应答后退出——**没有任何一帧被翻译给 claude**。

### 2.2 主对话确实没走到 shim

三条独立旁证：

1. `~/.qwenworkcn/logs/runs/` 共 **151 次** CLI 调用（时间跨度 2026-10-16T14:29 → 2026-10-20T14:22，覆盖成功联调窗口），argv 特征 **151/151 全部**是 `bare + disallowed-tools * + tools`，`--model` 与 `--session-id` 各 **0** 次。
2. `~/.qwenwork-bridge/ledger.jsonl` 不存在（`result` 事件记账通道从未产生数据）。
3. `~/.claude/projects/` 14 个目录全部对应本机开发目录，**无任何** app workspace（`~/.qwenworkcn/workspace/<chatId>`）会话；桥接标记 `qwenwork-bridge` 在 `~/.claude/projects/` 下命中 3 个文件，逐一核对为本次取证会话自身（1 份主记录 + 2 份 subagent 记录，内容是把 shim 源码读进上下文的痕迹），非历史桥接产物。

反向对照：**桥接关闭时**（本机注册表在 14:22 前为空）那批 `--bare` 请求走的是进程内 WorkerTransport，argv[1] 直接是 `qoder-worker-runtime.obf.mjs`，由 `QwenWorkCN.exe` 自身以 node 方式执行，不 spawn 外部进程。可见 `QODER_CLI_PATH` 的作用恰恰是把这批请求从「进程内 worker」强推给「外部 shim」。

### 2.3 净效果评估

当前注入是**反向起作用**的：

- 未获得任何 Claude 主对话（收益 0）；
- 但吃掉了官方 `--bare` 内部查询的真实结果（意图分类、会话标题生成、闲置建议）——官方合成的 `get_models` 返回 `claude-bridge` 单元素，`account_info`/`get_usage_info`/`generate_session_title` 返回空壳；
- 附带 `--setting-sources=[""]` 触发 `[DROP-ARG]` 日志（丢弃本身无害）。

## 三、既有 shim 在 1.3.x argv 形态下的实伤

即便主对话回到 CLI 链路，下列翻译也需要修（`src/bridge-shim.mjs`）：

| 入参 | 现状 | 影响 |
|---|---|---|
| `--bare` | `FLAG_ARGS` 认识但不推送，且被用作 internal 判据之一；v2 注释断言「claude 的 `--bare` 是严格 API-key 模式，透传会破坏 OAuth」 | 该断言在 1.1.71 CLI 上已不成立——`--bare` 是内部查询的**常规**旗标而非炸弹；误判导致整类请求被自答吞掉 |
| `TodoWrite` | `Q2C_TOOL` 无此键、`CLAUDE_TOOLS` 不含 → 丢弃 | 1.1.71 仍叫 `TodoWrite`，v2 的 `Task↔Agent` 映射表按 1.2.1 建的，档位工具集被削弱 |
| `UpdateGoal` / `ImageGen` / `ImageSearch` | 丢弃 | 前两者是 qoder 云端专属（已知降级，可接受），但 `UpdateGoal` 关系到目标态语义 |
| `--model flash` | 无条件丢弃 | 官方档位信息丢失，透传路径必须保留 |
| `--permission-mode bypassPermissions` | `PM_MAP` 透传 | 正确，无问题 |

## 四、1.3.1 是否同构（非回归判定）

方法：对两个版本的 `app.asar` 做二进制字符串存在性比对。

| 标志 | 1.3.1 | 1.3.2 |
|---|---|---|
| `chat-modes-v2` | 2 | 2 |
| `/api/desktop/chat-modes` | 1 | 1 |
| `ENGINE_LOCAL_MANIFEST` | 4 | 5 |
| `engine-runtime-manifest.json` | 2 | 2 |
| `HOST_HARNESS_BY_CODE` | 1 | 1 |
| `modelCatalogSource` | 3 | 3 |
| `QODER_CLI_PATH` | 2 | 2 |
| manifest engines | opencode, qwencode | opencode, qwencode |

判定：分流架构在 1.3.1 已存在。**方法学局限必须声明**——`grep -c` 在二进制上统计的是匹配行数而非出现次数，asar 内单文件常被压成极少行，因此数值只可用于「存在/不存在」判断，不可用于「规模变化」推断。要确认 10/16 那次联调当时的真实行为，只能靠 §五 的现场复现。

## 五、悬置与下一步

### 待验证

1. **下拉框 `Claude` 的渲染来源**（本轮调查被中断，无结论）。两种可能各自指向完全不同的方案：
   - 若只是 `initialize.models` 的旁路显示 → 注入从未真正接管主对话，必须换挂点。
   - 若当时 `cc`/`qo` 档位可选、之后被 App 或服务端撤走 → 挂点没变，是目录供给变了，透传方案重新成立。
2. **当前账号在 `qwork` scene 下有无 `cc`/`qo` 档位**。模型目录缓存 `%APPDATA%\QwenWorkCN\data\model-catalog\chat-modes-v2\*.lkg` 与 `~/.qwenworkcn/.models/<uid>/catalog-v6` 均为加密 blob（魔数 `UU1D…`，`safeStorage` + 机器 ID 绑定），静态不可判读。
3. **BYOK 路径已排除**：`~/.qwenworkcn/.status.json` 实测 `allow_byok = 0`（`user_type: enterprise`，`plan: 企业基础版`）。把 Claude 注册成自定义模型条目这条零 shim 捷径被账号权限关死。

### 一次定死 1 与 3 的测试

见 `README.md` 的 grep 判据。补充一点：测试时 `--proxy http://127.0.0.1:7897` 会随 argv 进入 shim，本机代理可用性会影响官方模型侧的观测，判读时注意区分。

### 候选方案挂点（按侵入度排序）

| 挂点 | 覆盖 | 代价 | 备注 |
|---|---|---|---|
| `ENGINE_LOCAL_MANIFEST`（env，指向自制 manifest） | ACP 引擎（当前真正跑主对话的那条） | 需实现 ACP 服务端（JSON-RPC over stdio） | 唯一能接到现状主对话的纯 env 路径；`resolveEngineRuntimeManifestPath()` 中 env 优先级最高 |
| `QODER_CLI_PATH`（现有） | 仅 `cc`/`qo` 档位 + 内部查询 | 已实现 | 在现状下接不到主对话 |
| BYOK 自定义模型条目 | 视 App 支持 | 零 shim | 本机 `allow_byok=0`，不可用 |
| 改 `app.asar` | 全部 | — | 项目硬约束禁止（见 AGENTS.md Non-Goals） |

### 对既有文档的冲击

`AGENTS.md` 与 `docs/DECISIONS.md` 中 D1（env 挂点全接管）、D5（内部查询自答省 token）、D11（会话语义适配）、D12（命令行长度规避）、D13（双向控制桥接）均以「主对话走 qoder-cli harness」为隐含前提。该前提已被本轮取证否定，**在方案定型前不应就地改写这些决策条目**（它们描述的是当时为什么那么做，仍然成立），但需要在 D 序列追加一条记录「前提失效」的事实条目，并在 ARCHITECTURE 的「换芯后架构（当前实现态 v2）」上方加失效告示。等 §五 测试出结果再动笔。

## 附：本次取证用到的锚点

- `out/main/main.js`（1.3.2，12.5MB，13967 行，未混淆）：`buildEngineModeFromExecutionRoute`、`HOST_HARNESS_BY_CODE`、`resolveHarness`、`buildMainSessionRuntimeExtraArgs`、`resolveEngineRuntimeManifestPath`、`loadLocalEngineLaunchConfigs`、`getLocalLaunchConfigs`、`resolveLaunchConfig`、`createWorkerFallbackTransport`、`HAS_CUSTOM_QODER_CLI_PATH`、`getBundledQoderCliPath`、`DesktopChatModesV2CatalogProvider`、`QoderCliModelCatalogProvider`、`ModelCatalogService`、`normalizeCatalogModel`、`projectCatalogModel`、`createMainSessionResolveModel`
- 策略扩展点：`models.policy.catalogSource`（`chat-modes-v2` / `qodercli`，默认前者）、`agent.policy.runtimeServices`（`managed-maas` / `qodercli`）
- IPC：`models:catalog-refreshed`、`models:refresh-requested`；tRPC：`auth.getModels`、`setModelLevel`、`setCurrentSessionModel`
- 本机数据：`%APPDATA%\QwenWorkCN\data\agents.db`、`%APPDATA%\QwenWorkCN\data\model-catalog\chat-modes-v2\`、`~/.qwenworkcn/{logs/runs,projects,.models,.status.json,workspace}`、`~/.claude/projects/`、`src/logs/`、`~/.qwenwork-bridge/`
- 解包方式：自备只读 asar 解析脚本（`.analysis/asar.cjs`，未纳入 git），未修改 App 任何文件
