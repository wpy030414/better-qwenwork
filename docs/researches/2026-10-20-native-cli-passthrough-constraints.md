# 原生 CLI 透传的硬约束

- 观测对象：QwenWorkCN `1.3.2-26101704` / `qoderclicn.exe` 1.1.71 / SDK 1.0.53
- 取证时间：2026-10-20
- 前置阅读：[引擎按 harness 分流与桥接失效取证](2026-10-20-engine-harness-routing.md)——本文回答的是「若主对话仍在 CLI 链路上，透传该怎么做」，而那份回答的是「主对话还在不在 CLI 链路上」

## 结论速览

**协议层透传成立**：shim 收到的 argv 本来就是 SDK 用同一份 `buildArgs()` 生成、原打算喂给 `qoderclicn.exe` 的，因此 argv 可原样转发、帧可裸管双向 pipe。

**但现有 shim 的架构取向与透传根本不兼容**：我们现在做的是「中介 + 改写」（白名单转发、合成兜底、事件改写）。透传要求的是「隐形管道」——任何一个动作（代答认证帧、覆写 `system/init`、注入假 capability、清洗 argv）都会破坏官方链路。若要做共存路由，必须是**两条完全独立的代码路径**，不能共享改写逻辑。

下表的证据强度已区分：`一手`=本次会话直接用 grep/读文件验证；`二手`=子代理调查结论，本次未复核。

## 一、认证：走控制帧，不走环境变量（一手）

```
CLI 主动发起 fetch_job_token  →  SDK  →  App 的 auth jobToken 回调
                                 （现场向 AuthManagerV2 取 access token）
                              ←  {token, expiresAt?}
```

CLI 二进制内的原文证据（`qoderclicn.exe`，5 处命中 `fetch_job_token`）：

```
[sdk-job-token-provider] Requesting job token: reason=
job_token_unavailable: Host did not provide a token
job_token_unavailable: expires_at must be ...
job_token_unavailable: fetch_job_token request timed out
job_token_cancelled: fetch_job_token request cancelled
```

`AUTH_PAYLOAD_MISSING`（2 处）对应的不是凭据本身：SDK 侧 `createAuthPayloadFile` 只落盘一个**类型声明** `{type:"jobToken", jobTokenProvider:"host"}` 到 `%TEMP%\qoder-sdk-auth-XXXX\payload.json`（0600，transport close 时删除），经 `QODER_SDK_AUTH_PAYLOAD_FILE` 传给 CLI。真正的 token 不落 env 也不落盘，每次由 CLI 现场请求。

**对 shim 的硬约束**：`synthFor()` 的 `default: return {}` 分支会把 `fetch_job_token` 吃成空对象，原生 CLI 随即报 `job_token_unavailable` 失败。透传路径必须放行全部未知子类型，白名单/合成逻辑只能作用于 Claude 路由。

env 侧凭据入口（`QODERCN_PERSONAL_ACCESS_TOKEN` / `QODERCN_SERVICE_ACCOUNT_KEY` / `QODERCN_JOB_TOKEN`）在 CLI 中存在，但本路径不使用。`keytar` 虽在 `app.asar.unpacked/node_modules` 里，`main.js` 中 0 引用。

本机凭据文件（**只记结构，不记内容**）：`%APPDATA%\QwenWorkCN\auth.dat`(527B)、`auth-v2.dat`(2004B)、`~/.qwenworkcn/engine-maas-key.dat`(330B)，均为 `safeStorage` 加密块；`~/.qwenworkcn/.auth/` 下只有 `machine_id` 与零字节事务标记。

## 二、递归安全：CLI 不读 QODER_CLI_PATH（一手）

`qoderclicn.exe` / `qoderclicn-legacy.exe` 字符串扫描：`QODER_CLI_PATH` **0 命中**。它是 App 侧专用变量（`getBundledQoderCliPath()`、`HAS_CUSTOM_QODER_CLI_PATH`）。所以 shim 直接 spawn 原生 exe 不会自我递归。

但 `QODERCLI_PATH`（2 命中）方向相反——CLI 是**写**它，写给孙进程（codesec 安全扫描 runtime）：

```js
function Cw(e,t={}){ let r=..., n=t.environment??process.env,
  o={ [nD]:e, QODERCLI_PATH: t.qoderCliPath ?? Sw() }, ... }   // Sw() 由 argv/execPath 反推自身
```

**硬约束**：spawn 原生 CLI 前 `delete env.QODER_CLI_PATH; delete env.QODERCLI_PATH;`。删后者尤其关键——若 CLI 内部某处回落到 SDK 的 env 解析，留着会把孙进程指回我们的 shim，那才是真递归。

同时**必须保留** `QODER_AGENT_SDK_ENTRYPOINT` / `QODER_AGENT_SDK_VERSION` / `QODER_SDK_AUTH_PAYLOAD_FILE`，见下条。

## 三、argv 与 system/init 一律不得改写（一手）

CLI 有一条硬校验（`sdk_invalid_args`，2 命中；**注意 legacy 版 0 命中**）：

```
sdk_invalid_args: Agent SDK entrypoint env is set but required flags are missing.
Expected --print --input-format stream-json --output-format stream-json
```

即 `QODER_AGENT_SDK_ENTRYPOINT` 存在 ⇒ 这三个旗标必须齐。原样转发天然满足；**任何"翻译式清洗"都会踩这条**——这正是我们现在对 Claude 做的事（丢弃/改名），不能套到官方路由上。

`protocol_version`：CLI 内 `"1.5.0"` 存在（4 命中），与 SDK 内置 `en="1.5.0"`、与我们 shim 硬编码值一致。SDK 的 `validateProtocolHandshake` 在 `system/init` 帧上取该字段做 major 校验。

**硬约束**：路由到原生时必须跳过现有 `msg.protocol_version = PROTOCOL_VERSION` 覆写（`bridge-shim.mjs` 约 610 行），并**去掉 `CAPABILITIES` 假注入**——SDK 用 `init.capabilities` 建 `cliCapabilities` 做功能门控，注入假 capability 会诱导 SDK 发出 CLI 不支持的请求。

## 四、退出码 41 是协议不是错误

SDK 侧 `Re=41`，`observeProcess` 中 `t===Re && this.fireAuthExpired()`，且 `createProcessExitError` 对 41 **不**构造异常；其余非 0 才抛 `QoderCLIProcessError`。

关闭序列：`closeGraceMs`（默认 2000ms）→ `endInput()` → SIGTERM → 5s 后 SIGKILL。shim 必须把 SIGTERM/SIGKILL 转给原生子进程，否则关闭路径被拖到 SIGKILL，41 会被 signal 终止掉，App 收不到「认证过期→重新登录」信号。

现有 `process.exitCode = code ?? 1` 的传播是对的。

## 五、env 要补差集，不是重建（二手）

> 本节为子代理调查结论，本次未独立复核；实施前建议按 `main.js` 中 `buildQoderAgentSdkRuntimeEnv` / `composeQoderAgentSdkRuntimeEnv` 重新核对一遍取值。

CLI 二进制 0 引用 `QODER_CLI_PATH`、0 引用 `QWENWORK_*`，因此 shim 作为 Electron 孙进程 `process.env` 大致同源（本次日志的 ENV 快照已印证：`QODERCN_CONFIG_DIR`、`QODER_SCENE`、`QODER_WORK_INTEGRATION_MODE` 等都完好继承）。需要补的是少量自研变量与 PATH 前缀，需要删的是代理变量与 `OPENAI_API_KEY`（代理改由 `--proxy` 旗标走）。

本次实测的 ENV 快照（1.3.2 真实下发，可直接当基线）：

```
QODERCLI_PATH, QODER_CLI_PATH            ← 透传前删除
QODER_CONFIG_DIR / QODERCN_CONFIG_DIR = ~/.qwenworkcn
QODER_SITE=cn  QODERWORK_IS_CN=true  QODER_SCENE / QODERCN_SCENE = qwork
QODER_WORK_INTEGRATION_MODE=1  QODER_WORK_INTEGRATION_PRODUCT=qwenworkcn
QODER_ENABLE_AGENT_SESSIONS=0  QODERCN_ENABLE_AGENT_SESSIONS=0
QODER_FEATURE_TASKS=0  QODERCN_FEATURE_TASKS=0  QODER_FEATURE_WORKFLOWS_DISABLE=true
QODER_REPEATED_TOOL_CALL_THRESHOLD=100  QODERCN_…=100
QODER_HTTPDNS=1  QODERCN_HTTPDNS=1  QODER_NETWORK_OPENAPI_CONNECT_TIMEOUT_MS=8000
QODER_SERVER_ENDPOINT=https://gateway.qwenwork.cn
QODER_AGENT_SDK_ENTRYPOINT=sdk-ts  QODER_AGENT_SDK_VERSION=1.0.53   ← 必须保留
QODER_SDK_AUTH_PAYLOAD_FILE=%TEMP%\qoder-sdk-auth-XXXX\payload.json ← 必须保留
```

## 六、原生 CLI 路径定位

官方逻辑：`resources/bin/qoderclicn.exe`；`-legacy` 仅在 `win32 && x64 && (build<17763 || 无 AVX2)` 时选用。本机（build 26300，有 AVX2）走现代版（217MB vs legacy 146MB）。

版本目录**不在注册表**：`HKLM/HKCU\Software\QwenWorkCN` 只有 `InstallLocation=C:\Program Files\QwenWorkCN`（无版本号）。版本指针在 `C:\Program Files\QwenWorkCN\updater.cfg` 的 `currentVersion`。

shim 定位策略（按优先级，全只读）：

1. `QODER_BRIDGE_QODERCLI` 显式覆盖；
2. `updater.cfg:currentVersion` → `<InstallLocation>\<currentVersion>\resources\bin\qoderclicn.exe`；
3. 兜底枚举 `C:\Program Files\QwenWorkCN\*\resources\bin\`，按目录名版本取最新存在者；
4. 复刻 legacy 判定（`os.release()` 第三段 + AVX2）。

不可照抄官方 `getBundledQoderCliPath()`——它第一优先级就是 `QODER_CLI_PATH`，照抄会拿到 shim 自己。

## 七、会话体系不互通（确证）

| 侧 | transcript 根 | 本机实测 |
|---|---|---|
| 原生 CLI | `~/.qwenworkcn/projects/<cwd-slug>/<sessionId>.jsonl`（经 `QODERCN_CONFIG_DIR` 重定向） | 目录存在、**0 文件** |
| Claude | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | 14 目录，全为开发目录，无 app workspace 会话 |

App 对每个 subChat 只持**一个** `sessionId`（`crypto.randomUUID()`），换 harness 不换 id。`HARNESS_SET` 只有 `qoder-cli / opencode / qwencode`——**Claude 在 App 视角仍算 `qoder-cli`**。

后果（本次会话独立推导，与 §一 的现场证据一致）：同一 chat 内切换官方档位与 Claude 会造成会话分裂。

- 官方 → Claude：Claude 侧无同名 transcript，shim 现有的 `SESSION-ADAPT` 会当新建处理，**历史从零开始**；
- Claude → 官方：原生 CLI 找不到自己的 transcript，App 走 `rebuildTranscriptFromProjection()`——它**只朝 `~/.qwenworkcn/projects` 写**，无等价路径写 `~/.claude/projects`，且可能重新分配 sessionId。

要历史衔接只有两条路：(a) shim 在切换前做 transcript 投影复制（两侧格式同源，均为 claude 风格 jsonl，字段 `type/user|assistant,uuid,timestamp,parentUuid,isSidechain,cwd,sessionId`，理论可搬）；(b) 路由粒度锁死在 per-chat，禁止同 chat 混用两个引擎。**建议 (b)**——(a) 会引入双向格式漂移风险，收益不匹配。

## 八、其他实现细节

- **超大帧**：SDK 帧上限 64MiB。逐行 `JSON.parse/stringify` 重排在含 base64 图片的帧上有内存放大风险，原生路由建议走 raw byte pump，只在需要判路由时做嗅探而非重写。
- **延迟 spawn 必须改立即 spawn**：现有「等 `initialize` 到达再 spawn」是为了把 `systemPrompt` 翻成 CLI 旗标；原生 CLI 需要立刻进入 sdk 路由，且改写旗标本身已被 §三 禁止。
- **`internal sign-request` 快路**：App 还有一条不经 SDK 的直接 spawn 通道 `["internal","sign-request","--url",…,"--storage-dir",…]` + `QODERCLI_INTERNAL_ACCESS=true`，**没有** `--print/stream-json`。需识别 `argv[0]==="internal"` 并无条件原样转发。风险：当前捆绑的 1.1.71 里 `sign-request` / `--storage-dir` / `QODERCLI_INTERNAL_ACCESS` 三种字符串 0 命中（同 binary `--print` 有 39 命中以证扫描有效），该通道可能本就 inert——照抄转发即可，不要自己实现。

## 落地判据（若决定实现共存路由）

| 位置 | 约束 |
|---|---|
| 入口 | 先判路由，再决定用哪套逻辑；判据只能是 `--model` 值或 internal 特征，不能依赖会话内状态 |
| 路由决策粒度 | per-process（每次 spawn 重读 `--model`）——App 换模型是**销毁重建 query runtime**，不是发 `set_model`；main.js 中 `.setModel()` 无任何调用点 |
| 原生分支 | 零改写：argv 原样、`system/init` 原样、未知 control 帧全放行、SIGTERM/SIGKILL 转接、退出码原样传播 |
| Claude 分支 | 保留现有翻译逻辑，但 `--bare` / `TodoWrite` / `--model` 的处理需按 §一 那份文档的表格修正 |
| env | 删 `QODER_CLI_PATH` / `QODERCLI_PATH` / `NODE_OPTIONS` / 6 个代理变量 / `OPENAI_API_KEY`；保留三个 `QODER_AGENT_SDK_*` 与 `QODER_SDK_AUTH_PAYLOAD_FILE` |
| 会话 | 锁 per-chat 单引擎，禁止同 chat 混用 |

## 尚未验证的风险点

1. §五 的 env 差集取值未独立复核（二手）。
2. `fetch_service_account_token`、`resolve_session_artifacts`、`host_action`、`elicitation_requested`、`memory_*`、`skill_evolution_*` 等帧在透传下是否真能裸管通过——只验证了它们存在于 CLI 字符串中。
3. 共存后 App 侧 `sessionModelRouteService` 是否会拒绝一个它目录里没有的 `modeKey`（Claude 条目要能被选中，得先过目录校验）。这决定了共存方案最终是否必须同时给目录供一个条目——与主文档 §五 的「下拉来源」待验证项是同一个问题。
4. daemon 通道另有一套版本空间（`daemon_protocol_version` 必须是整数 `2`），与 stream-json 的 `"1.5.0"` 无关；若日后复用 daemon 别混淆。
