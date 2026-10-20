# researches — 现场调研记录

存放带证据链的逆向/取证记录。与 `docs/ARCHITECTURE.md`（当前架构定论）和 `docs/DECISIONS.md`（设计决策）的区别：本目录只记录**某个时间点对真实系统的观测与推断**，允许包含未证实项和被推翻的结论，不追求与实现态一致。

每份记录标注观测所针对的版本与取证时间，复核时按文中的锚点（函数名 / 字符串常量 / 文件路径 / 命令）重新验证，不要直接引用为结论。

## 索引

| 记录 | 观测版本 | 一句话结论 | 状态 |
|---|---|---|---|
| [2026-10-20 引擎按 harness 分流与桥接失效取证](2026-10-20-engine-harness-routing.md) | QwenWorkCN 1.3.1 / 1.3.2 | 主对话自 1.3.x 起走 ACP 引擎（`opencode`/`qwencode`），不经过 `QODER_CLI_PATH`；纯 env 注入只能接到 `--bare` 内部查询，净效果为负收益 | 核心结论已确证；下拉框显示来源待验证 |
| [2026-10-20 原生 CLI 透传的硬约束](2026-10-20-native-cli-passthrough-constraints.md) | 1.3.2 / SDK 1.0.53 / CLI 1.1.71 | 协议层透传成立（argv 与帧可裸管），但认证走 `fetch_job_token` 控制帧、`system/init` 不得改写、两侧会话体系互不相通——现有 shim 的合成兜底会直接破坏认证 | 一手证据 + 二手待复核项已分别标注 |

## 当前悬置问题（两份记录共同指向）

1. 10/16 那次「联调成功」中，UI 下拉里的 `Claude` 选项由哪一层渲染：`get_models` 应答、`initialize.models`，还是会话级旁路显示。决定共存方案挂在 `QODER_CLI_PATH` 还是 `ENGINE_LOCAL_MANIFEST`。
2. 当前账号（企业基础版）与 `qwork` scene 下，是否存在 `harness = cc/qo` 的可选档位。模型目录缓存为加密 blob，无法静态判读，只能实测。
3. 桥接历史上是否**真的**接管过主对话：`~/.qwenwork-bridge/ledger.jsonl` 不存在、`~/.claude/projects/` 无 app workspace 会话，两条间接证据都指向否定，缺一次干净的端到端复现。

## 一次能定死上述 1、3 的现场测试

保持 `QODER_CLI_PATH` 已注册状态，在千问办公里发一条消息，然后：

```bash
# 是否出现非 bare 调用（带 --model / --session-id / USER-IN）
grep -l 'USER-IN\|--session-id' src/logs/*.log
```

命中 → 主对话仍在 CLI 链路上，透传方案（原目标）重新成立。
不命中 → 主对话彻底走 ACP，必须换挂点，原 `QODER_CLI_PATH` 方案的文档与决策需要整体重写。
