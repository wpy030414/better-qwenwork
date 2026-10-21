# 共存路由 shim 的行为契约（观测记录）

- 观测对象：`src/bridge-shim.mjs` 于 QwenWorkCN `1.3.2-26101704` / SDK `1.0.53` / `qoderclicn` `1.1.71` 现场
- 取证时间：2026-10-20 首发，2026-10-21 复跑（同一批观测，环境未变）
- 观测手段：密闭 harness——以替身进程分别扮演「官方 qoder CLI」与「claude」，用真帧驱动 shim，
  断言 shim 实际发出的 argv/env/帧与退出码
- 复现工具：`.analysis/legacy-verification/bridge-shim.test.mjs`（gitignore 的取证区，不在代码库内）
  复现命令：`node .analysis/legacy-verification/bridge-shim.test.mjs`
- 本文只记**观测到的行为**及其含义；架构定论见 `docs/ARCHITECTURE.md`，取舍理由见 `docs/DECISIONS.md`

## 结论速览

2026-10-21 复跑（含「默认文案统一源」改造后追加的第 9 组）：**9 组共 45 项观测全部成立**。
它们共同守护一条不变式：
**装了 shim 之后，官方链路必须与没装时一致；只有哨兵档位才被改道。**

| 组 | 场景 | 守护的不变式 |
|---|---|---|
| 1 | 内部查询（`--bare`） | 透传且 argv 零改写；env 抹掉劫持变量防递归 || 2 | 官方档位（带 `--model`） | 免探测直接透传，不多一次控制帧往返 |
| 3 | Claude 档位 | 探测命中哨兵 ⇒ 改道 claude，握手/事件/权限双向可用 |
| 4 | 无 `--model` 但宿主答官方 provider | 透传，且探测帧不得外泄进官方流 |
| 5 | 宿主不应答探测 | 超时 ⇒ 保守透传，argv 仍零改写 |
| 6 | 官方 CLI 退出码 41 | 原样传播，不被 SIGTERM 吞成 143 |
| 7 | 无原生 CLI | 退回全量桥接；参数翻译规则逐条成立 |
| 8 | 探测回来非常规模型名 | 丢弃该值，claude 仍能启动 |
| 9 | 默认文案统一源 | `get_models` 的两处合成兜底取同一句默认值（见 §二 组 9） |

## 一、测试构造（读结论前必须知道的边界）

三个替身/被测件的分工，决定了哪些结论是「协议层」的、哪些是「真机」的：

- **`mock-native.mjs`**：扮演官方 `qoderclicn`。它把**自己实际收到的 argv、关键 env、每一帧**
  落盘成 marker 文件供断言。之所以要它：真 exe 是 216MB 的 bun 单文件，不可控且会打云端，
  无法回答「shim 到底有没有改写字节」这种问题。
- **`mock-claude.mjs`**：扮演 claude `2.1.278`，形状对齐真实行为——`initialize` 应答
  **不含** `capabilities`/`skills`（逼 shim 合并注入）、不认识的子类型回
  `Unsupported control request subtype`（逼 shim 兜底）、工具调用前发 `can_use_tool` 并等宿主应答。
  它的 `system/init` 里带 `_argv`/`_env_*` 回显字段，shim 原样透传，因此**能直接读出 claude 被
  怎么启动的**——第 7 组的绝大多数断言靠这个回显，而不是靠推断。
- **宿主**：由 harness 手写 `control_request`/`control_response` 帧扮演。帧形状取自
  `2026-10-20-native-cli-passthrough-constraints.md` 的现场取证原文。

因此本文件的结论强度是「**协议层契约**」：它对真帧形状敏感、对真 exe 不敏感。真 exe 的一致性由
差分取证（§三）与真实 SDK 取证（§四）补。

一处易踩的密封性坑（观测时被排除过一次）：`QODER_BRIDGE_MODEL` 若从宿主 shell 泄漏进测试进程，
shim 的 `FORCE_MODEL` 分支会往 `claudeArgs` 里塞 `--model`，于是第 8 组「非法模型名被丢弃」
这类断言会**假性通过**。故 harness 默认删掉该变量，需要它的用例经 `extraEnv` 显式给。

## 二、逐组观测

### 组 1 内部查询 → 透传，argv 零改写

下发 1.1.71 现场取证的真实内部查询 argv（含 `--bare`、`--disallowed-tools *`、`--setting-sources ""`、
`--disable-builtin-skills`）。观测到：

- 退出码 `0`；
- 替身收到的 argv 与下发**逐字节相同**（含那三个看起来「无意义」的旗标）；
- 替身的 env 里 `QODER_CLI_PATH` 与 `QODERCLI_PATH` 均为 `null`——shim 在 spawn 前删掉了它们，
  否则官方 CLI 的 `getBundledQoderCliPath()` 会读回 shim 自己，形成无限递归；
- `QODER_AGENT_SDK_ENTRYPOINT`/`QODER_AGENT_SDK_VERSION`/`QODER_SDK_AUTH_PAYLOAD_FILE` **保留**。

最后一条是硬约束：官方 CLI 见到 SDK 入口点变量缺失会报 `sdk_invalid_args` 直接退出。
「删劫持变量」与「留 SDK 变量」必须同时成立，缺任一侧官方链路即断。

### 组 2 官方档位（带 `--model`）→ 免探测透传

带 `--model flash` 时，观测到 shim **没有**向宿主发 `get_model_policy` 探测帧（800ms 窗口内为零），
而宿主的 `initialize` 被原样转发给官方 CLI 并得到应答，替身记录到该帧、也记录到 `--model flash`。

含义：判据方向是「有 `--model` ⇒ 必为官方档位」（充分条件，App 对 BYOK 硬排除该旗标，
见 `2026-10-20-engine-harness-routing.md` §补记 3）。省掉探测不是优化，是**减少对官方链路的干预面**。

### 组 3 Claude 档位 → 探测命中哨兵 ⇒ 改道

无 `--model` 时观测到：

- shim 主动发出 `get_model_policy`，`request_id` 形如 `bridge-policy-<pid>-<ts>`（自定义前缀，便于与宿主自己的请求区分）；
- 宿主应答 `custom_model.provider == 'claude-bridge'` 后改道 claude；
- **探测期间到达的宿主帧一帧不丢**：`initialize` 得到 `success` 应答，且应答里
  `capabilities` 数组长度 ≥ 5（claude 自己不给，是 shim 合并注入的）；
- `system/init` 的 `protocol_version` 被归一为 `1.5.0`（SDK 的硬校验：major 不为 1 直接拒握手）；
- `tools` 里的 `Task` 被映射为 `Agent`（两侧同名工具不同叫法），实测 `[Agent, Bash, Write]`；
- claude 上行的 `can_use_tool`（`tool_name: Write`）到达宿主，宿主应答 `allow` 后轮次继续；
- 轮次以 `result` 收尾（`is_error: false`）。

这条链是「Claude 档位可用」的全部技术含义：握手、事件改写、反向权限弹窗，缺一即 UI 上表现为卡死或报错。

### 组 4 无 `--model` 但答官方 provider → 透传（不误劫持官方）

宿主答 `custom_model.provider == 'qwenwork'` 时观测到：应答由**替身官方 CLI**给出
（`response.response.mocked === true`，即不是 shim 合成的），宿主帧抵达官方 CLI；
且**shim 自己发的探测帧没有被转发给官方 CLI**。

最后一条很关键：探测帧是 shim 注入的私有协议动作。若它漏进透传流，官方 CLI 会收到一个
自己没发起的 `control_request`，轻则报错重则错乱——那等于我们污染了官方链路。

### 组 5 探测超时 → 保守透传

把 `QODER_BRIDGE_PROBE_TIMEOUT_MS` 压到 400ms、宿主不应答，观测到 shim 仍 spawn 了官方 CLI、
退出码 `0`、argv 仍逐字节相同。

判据的保守方向是「**宁可这一轮走官方，也不能破坏官方链路**」：探测失败的代价是 Claude 侧降级，
而不是官方模型坏掉。

### 组 6 退出码 41 原样传播

替身官方 CLI 以 `41`（认证过期）退出，shim 的退出码同为 `41`。

这条观测对应一个已修掉的缺陷：子进程退出后 shim 必须**主动收尾 stdin**（`detachStdin`）。
否则 readline 吊住事件循环、shim 不退出，SDK 的 SIGTERM 会把 `41` 覆盖成 `143`——
上层看到的就不是「认证过期」而是「进程被杀」，判因方向完全跑偏。

### 组 7 无原生 CLI → 退回全量桥接（参数翻译观测）

以 `QODER_BRIDGE_QODERCLI=""` 强制「定位不到官方 CLI」，走 v2 式全量桥接。
下面这批翻译规则全部由 `mock-claude` 回显的 `_argv`/`_env_*` **直接读出**：

| 下发 | 观测到的 claude 侧 |
|---|---|
| `--bare` / `--setting-sources` / `--proxy` / `--workdir` | 不进入 `--argv`（丢弃/转译）；`--proxy` 改为 `HTTPS_PROXY` |
| `--tools Agent,TaskCreate,Bash,TodoWrite,Write,UpdateGoal,ImageGen` | `--tools=Task,Bash,TodoWrite,Write`（Agent/TaskCreate 归一 Task 且**去重**，UpdateGoal/ImageGen 丢弃） |
| `--yolo` | `--dangerously-skip-permissions` |
| `--permission-mode accept_edits` | `--permission-mode acceptEdits`（下划线→驼峰） |
| `--max-turns 2` / `--allowed-tools Skill` / `--disallowed-tools 'Bash(rm -rf *)'` | 原样直传 |
| `initialize` 里的 `systemPrompt`、`promptSuggestions` | `--system-prompt '…'`、`--prompt-suggestions`（延迟 spawn 才拿得到宿主配置） |
| `--mcp-config {…qw-builtin…}` | 透传（本地工具网关不丢） |
| env | `CLAUDE_CODE_ENTRYPOINT=qwenwork-bridge` |

`TodoWrite` 被保留是 2026-10-20 的一次**回归修正**：v2 曾把它当 qoder 专有名丢掉，
但 1.1.71 里它仍叫 `TodoWrite`（不是 `UpdateGoal`），丢弃会让 claude 侧没有待办工具。

另观测到 `get_models` 由 claude 的 `initialize.models` 映射兜底（claude 不支持该子类型，
返回 `Unsupported`，shim 合成应答）——这是「claude 不支持 ⇒ shim 合成」的一般模式。

### 组 8 非常规模型名守卫

宿主答 `model: 'Anthropic 最新模型，世界最强模型'`，观测到：claude 仍成功启动，且 `--argv` 里
**没有** `--model`——非法值被丢弃（守卫是 `^[A-Za-z0-9._[\]:/-]{1,64}$`），
回退到 `QODER_BRIDGE_MODEL` 或 claude 默认。

为什么仍要这条守卫：D19 之后档位副标题走本地文案缓存，`model` 列回归**真实模型别名**
（现网那行是 `fable[1m]`）。但 App 的 `resolveModel` 会把 `model` 列**原样回传**，
而 BYOK 条目可能被用户或历史版本写成任何字符串——所以这个输入面天然不可信，
守卫是防御性的，不能因为「我们现在只写别名」就撤。
用它自己的默认副标题原文作输入，正是因为那串**带空格与全角逗号**，
恰是 `CLAUDE_MODEL_RE` 必须拒绝的形态。

### 组 9 默认文案的统一源（D19 追加）

要求是「无论在哪里兜底都显示同一句话」，所以 shim 合成 `get_models` 的两个出口分别实测：

- **A｜claude 回了 models 但条目自身无 `description`**（`MOCK_CLAUDE` 的 `initialize.models`
  正是 `[{id, displayName}]`）→ 落到 `synthFor('get_models')` 的 map 分支，
  观测 `description === DEFAULT_DESCRIPTION`；
- **B｜claude 完全不回 models**（临时桩 claude 应答 `models: []`）→ 落到 `MODELS_FALLBACK`，
  观测兜底条目的 `description` 与 `displayName` 分别是 `DEFAULT_DESCRIPTION` 与 `DEFAULT_TITLE`。

两项都以 `native: ''` 强制走全量桥接——合成应答**只在这条路径发生**，透传路径永不走到。

改造前 shim 里硬编码着两个**别的**串（`使用强大的 Claude Code 代理后端` / `Claude Code (bridge)`），
降级路径下的模型描述与正常档位不一致，这就是「兜底面不统一」的实例。
一处刻意的**不统一**保留在代码里：map 分支用 `m.description || DEFAULT_DESCRIPTION`——
claude 自己给了描述就用它（那是上游信息，不是兜底），只有「没有描述」才落到统一默认值。

同一真相源在另外三个出口的行为见 `2026-10-21-byok-tier-and-dynamic-text.md` §三·补。
注意别混淆：`generate_session_title` 应答里的 `req.description` 是**宿主入参**（用来拟会话标题），
与档位文案无关。

## 三、真 exe 差分（共存不变式的最硬判据）

手段：用**真实** `qoderclicn.exe` 跑两条路径并比对帧序列。

- A：直连 exe（不设 `QODER_CLI_PATH`，即「没装本项目」的原生行为）
- B：经 shim 透传（`QODER_CLI_PATH` 指向 shim，shim 原样转发给同一个 exe）

2026-10-21 复跑观测：

```
A 直连官方 CLI   ：exit code=0 frames=1
B 经 shim 透传   ：exit code=0 frames=1
协议帧序列一致（剔除 pid/session_id/request_id/duration_ms/usage 等本进程字段后）: true
退出码一致: true（A=0 B=0）
无 sdk_invalid_args: true
无 job_token_unavailable 差异: true
```

判据的性质要说清楚：归一化剔掉的是**只属于本进程/本次时序**的字段（pid、随机 id、耗时、token 计数）。
要证的是「协议结构与语义一致」，不是「耗时一致」——后者不可能两次相同，也不是共存关心的东西。

一条构造教训（曾导致假失败）：`QODER_SDK_AUTH_PAYLOAD_FILE` 指向的文件会被官方 CLI 在收尾时
**删除**（实测 run 后 payload 存在 = false）。A/B 共用一份，B 必然拿到不存在的路径 →
`job_token_unavailable` → 41。那是**测试构造缺陷**，不是 shim 缺陷；两侧各自新建一份才对。
真机场景每次 spawn 都由 SDK 新建 `%TEMP%\qoder-sdk-auth-XXXX\payload.json`，天然不冲突。

另一条同样重要的观测（来自只握手不发消息的那次）：真 CLI 拿到 `initialize` 应答后**不会自己退出**——
stdin 保持打开的 30s 内无任何后续帧，最终由脚本 SIGKILL 收尾（`exit=TIMEOUT`，帧总数 1）。
据此推断它是常驻等下一条输入，直到 stdin EOF；所以只握手的取证必须主动 `stdin.end()` 或设超时，
否则脚本会挂住。

**推断项（未单独证实）**：这条与 §五「SDK 把 `result` 扣到 CLI 进程退出才浮出」看着是同一件事的两面
——CLI 常驻 + result 延迟浮出，于是任何「固定时长后关流」的写法都会漏判。但 §五 那条是从
SDK 侧行为观测的，两者没有在一次实验里同时测过，此处仅作方向性解释。

## 三·补 官方 CLI 定位与递归防护

差分与握手两次观测都定位到同一个路径，规则与 App 侧一致且**不能照抄 App 的
`getBundledQoderCliPath()`**——它第一优先级就是 `QODER_CLI_PATH`，照抄会拿到 shim 自己：

```
native CLI = C:\Program Files\QwenWorkCN\1.3.2-26101704\resources\bin\qoderclicn.exe
```

定位顺序：`QODER_BRIDGE_QODERCLI` 覆盖 → `process.resourcesPath/bin` →
`updater.cfg:currentVersion` 指针 → 枚举版本目录按语义化降序取最新。
legacy 变体只在现代版缺失时才用（官方规则 `win32 && x64 && (build<17763 || 无 AVX2)` 仅作诊断）。

## 四、真实厂商 SDK 取证

用手写帧模拟宿主，帧形状终究是我们的推断。这一层换成 `@qoder-ai/qoder-agent-sdk` 1.0.53 本体当宿主
（claude 侧仍用替身，不产生调用与计费）。2026-10-21 复跑，7 项观测全部成立：

```
resolveModel 被调用次数 : 1
resolveModel 入参       : {"purpose":"main","turnIndex":0,"availableModels":[]}
protocol_version        : 1.5.0
result                  : {"type":"result","subtype":"success","result":"MOCK_DONE",...}
判定：SDK 未报错 / 探测帧被 SDK 认下并回调 resolveModel / init 通过 SDK 校验 /
      收到 assistant 消息 / 以非错误 result 收尾 / 应答来自 claude 桥接（非透传）
```

这层单独证明了两件事，是手写帧无法自证的：
**shim 自造的 `get_model_policy` 请求能被真 SDK 认下并回调宿主的 `resolveModel`**，
以及**桥接后 claude 侧的事件流能被真 SDK 解析成合法消息**。

厂商 SDK 属 App 安装目录下的只读产物，其裸依赖 `@modelcontextprotocol/sdk` 由本仓库 `node_modules`
解析（Node 沿目录树向上找），故复现前需把它暂存进仓库内（`.analysis/vendor-sdk`，可重建）。

## 五、真机端到端（历史观测，本轮未复跑）

`e2e-real.mjs` 用真实 claude.exe + 真实官方 CLI 跑双分支。它会产生 Claude 侧调用与计费，
所以 2026-10-21 的收尾复跑**没有**执行它；以下为 2026-10-20 的历史观测，
证据留在 `~/.qwenwork-bridge/ledger.jsonl`（可按 session_id 复核）：

| 时刻（UTC） | session_id | cost | num_turns | duration | is_error |
|---|---|---|---|---|---|
| 10:39:53 | `ad78cb15-…f0ad` | 0.059965 | 1 | 3007ms | false |
| 10:58:10 | `4adbfa06-…73cd` | 0.058835 | 1 | 2264ms | false |
| 11:00:47 | `9bce2182-…cd3c` | 0.009047 | 1 | 2435ms | false |
| 12:10:02 | `4fffb5c0-…da82` | 0.073495 | 1 | 6037ms | false |

四条的 `result_preview` 均为「共存成功」——即宿主提示词要求 claude 只回这四个字，
返回值与预期文本一致，证明文本**真的抵达了宿主**而不是断在半路。单次成本区间 $0.009~0.073。

同一脚本的 B 侧（官方档位透传）观测到应答形态为官方 CLI 原生 `result`
（含 `num_turns`/`usage`/`stop_reason`），而非 shim 兜底；本 harness 的 jobToken 是占位值，
故官方云端按自己的规则拒权——这恰好反证「是官方 CLI 在回话」。

一处时序构造教训：SDK 把 `result` 扣到 CLI 进程退出才浮出，而 claude 在 `stream-json`
输入模式下会一直等下一条消息。用固定时长的异步生成器提前关流会让迭代器先结束（上一版就这样漏判）。
必须像真宿主那样：收到本轮文本后再关闭输入流，走 SDK 的 `closeGraceMs → endInput` 收尾序列。

## 六、真机 UI 闭环（人工观测，2026-10-20）

以上都是进程级观测。App 内的观测结论（详见 `docs/ARCHITECTURE.md`「已知风险」小节）：

- 下拉同时列出官方三档与 `Claude`，共存形状正确（`modelListCount:4`）；
- 人工点选被 App 接受：`[ModelSelection] … "newModelKey":"byok-pQRamboR_hlK","origin":"user_selector"`，
  无 `model_route_missing`、无回落；
- 路由如取证预测：`harness":"qoder-cli"` + `catalogSource":"local-byok"`；
- 端到端一次跑通：`[DECIDE] probe` → `[DECIDE] claude (provider=claude-bridge)` → 真 claude 执行 →
  台账 `{total_cost_usd:0.172, num_turns:1, is_error:false}`，UI 正常显示回复；
  同期官方内部查询仍走 `[DECIDE] passthrough (internal query)` → 官方 CLI `code=0`。

## 七、已知未覆盖项

诚实地列出这套观测**没有**证明的东西：

1. 组 7 的「无原生 CLI」分支是人为构造（`QODER_BRIDGE_QODERCLI=""`）。真机上定位失败时会走它，
   但那条路径的后果（官方内部查询重新被自答吃掉）只在推断层，没有真机复现过。
2. `--tools` 词表映射覆盖的是现场见过的 token；qoder 若新增工具名，映射会静默丢弃。
3. 多轮常驻会话（同进程第二轮 `--resume` 命中同一 claude 会话）在 spec 的验收清单里仍是未勾选项。
4. 探测分支给每次 Claude 轮次多一次控制帧往返；其延迟影响未量化。
5. 替身的 `can_use_tool` 只覆盖 `Write`；`Bash`/`Edit` 的权限弹窗形态未单独观测。
