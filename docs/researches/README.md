# researches — 现场调研记录

存放带证据链的逆向/取证记录。与 `docs/ARCHITECTURE.md`（当前架构定论）和 `docs/DECISIONS.md`（设计决策）的区别：本目录只记录**某个时间点对真实系统的观测与推断**，允许包含未证实项和被推翻的结论，不追求与实现态一致。

每份记录标注观测所针对的版本与取证时间，复核时按文中的锚点（函数名 / 字符串常量 / 文件路径 / 命令）重新验证，不要直接引用为结论。

## 索引

| 记录 | 观测版本 | 一句话结论 | 状态 |
|---|---|---|---|
| [2026-10-20 引擎按 harness 分流与桥接失效取证](2026-10-20-engine-harness-routing.md) | QwenWorkCN 1.3.1 / 1.3.2 | 主对话自 1.3.x 起走 ACP 引擎（`opencode`/`qwencode`），不经过 `QODER_CLI_PATH`；纯 env 注入只能接到 `--bare` 内部查询，净效果为负收益 | 核心结论已确证；下拉框显示来源待验证 |
| [2026-10-20 原生 CLI 透传的硬约束](2026-10-20-native-cli-passthrough-constraints.md) | 1.3.2 / SDK 1.0.53 / CLI 1.1.71 | 协议层透传成立（argv 与帧可裸管），但认证走 `fetch_job_token` 控制帧、`system/init` 不得改写、两侧会话体系互不相通——现有 shim 的合成兜底会直接破坏认证 | 一手证据 + 二手待复核项已分别标注 |
| [2026-10-21 共存路由 shim 的行为契约](2026-10-21-shim-behavior-contract.md) | 1.3.2 / SDK 1.0.53 / CLI 1.1.71 | 9 组 45 项密闭观测 + 真 exe 差分 + 真 SDK 7 项 + 真机 4 条计费台账：官方链路零改写、只有哨兵档位被改道，逐条成立；复现工具在 `.analysis/legacy-verification/` | 全部成立（未覆盖项见其 §七） |
| [2026-10-21 BYOK 档位供给与本地文案表](2026-10-21-byok-tier-and-dynamic-text.md) | 1.3.2 | 档位写进 `byok_custom_models` 即进下拉并被硬路由到 `qoder-cli`；标题/副标题唯一自由通道是本地文案缓存，会被云端整体覆盖故需行内意图源重放；默认副标题四处出口统一取值；18 项观测成立 | 全部成立；`style/format` 词表仍是推断 |

## 当前悬置问题（两份记录共同指向）

> 2026-10-20 实现后复盘：以下三条**全部已有结论**，保留原文以便日后复核时对照。

1. ~~10/16 那次「联调成功」中，UI 下拉里的 `Claude` 选项由哪一层渲染~~
   **已定论**：与我们的注入无关。下拉 = 云端 `chat-modes`（官方档位）∪ 本地 `byok_custom_models`（自定义档位），渲染层由 `allowCustomBYOK` 单门控制显示。共存挂在 `QODER_CLI_PATH` 即可，**不需要** `ENGINE_LOCAL_MANIFEST`。
2. ~~当前账号（企业基础版）与 `qwork` scene 下，是否存在 `harness = cc/qo` 的可选档位~~
   **已定论（绕开该问题）**：本机账号确实没有 cc/qo 档位，但 BYOK 条目被 App 硬编码 `harness="qoder-cli"`，且 `isMissingCatalogModel()` 对 `byok-` 前缀豁免——不依赖云端是否给档位。真机实测 `modelCount:3, customModelCount:1` 并存，且把 `modelLevel` 直接设为 `byok-...` 后 App 无 `model_route_missing` / 无回退。
3. ~~桥接历史上是否**真的**接管过主对话~~
   **已定论（否定）**：`~/.claude/projects/` 无 app workspace 会话、`ledger.jsonl` 缺失、`agents.db` 路由记录 100% 是 `opencode`。当时看到的「Claude 可用」是 `get_models`/`initialize.models` 的旁路显示效果，不是执行接管。

## 一次能定死上述 1、3 的现场测试（已执行）

保持 `QODER_CLI_PATH` 已注册状态，在千问办公里发一条消息，然后：

```bash
# 是否出现非 bare 调用（带 --model / --session-id / USER-IN）
grep -l 'USER-IN\|--session-id' src/logs/*.log
```

命中 → 主对话仍在 CLI 链路上，透传方案（原目标）重新成立。
不命中 → 主对话彻底走 ACP，必须换挂点，原 `QODER_CLI_PATH` 方案的文档与决策需要整体重写。

**实测结果（2026-10-20，v3 实现后）**：不命中——`src/logs/` 里出现的都是
`--bare` 内部查询与被 `--model` 标记的档位解析，主对话文本从未进入 shim。
按原判据应走「换挂点」，但实际解法是**反向的**：主对话走 ACP 意味着官方模型
本来就完好共存，缺的只是一条可选的 Claude 通道，而 BYOK 表正是 App 自己提供的
那条 `qoder-cli` 通道。因此 `ENGINE_LOCAL_MANIFEST` + 自实现 ACP 服务端被否决（见
`docs/DECISIONS.md` D16 的替代方案清单）。
