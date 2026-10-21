// src/tier-text.mjs — 档位显示文案的唯一真相源
//
// 为什么要单独立一个文件：这条文案会出现在**四个**地方，任一处各写一遍必然漂移：
//   1. byok_custom_models.extra_params.description —— 行内「意图源」
//   2. 本地文案缓存 dynamicText["model.<key>.description"] —— App 渲染层真正读的那份
//   3. shim 合成 get_models 应答的 description —— claude 侧模型条目没描述时的兜底
//   4. App 自己的 BYOK 兜底模板 `${Anthropic|OpenAI} · <model列>` —— 硬编码在 App 里，我们改不了
// 第 4 条改不了，所以策略是**绝不让它有机会生效**：只要是我们写的哨兵档位，
// description 一律非空（缺失即补默认值），于是 dynamicText 这条通路永远命中第 2 项。
//
// 语义边界（重要）：
// - 默认值只用来**填空**，不用来覆盖：训练员显式写过的自定义文案永远优先。
// - 只对 `provider === claude-bridge` 的哨兵行生效，**绝不碰用户自己配的 BYOK**
//   （那些档位的显示归用户和它的上游 provider 管）。
// - 可用 QODER_BRIDGE_BYOK_DESCRIPTION 覆盖，便于不改代码就换文案。
export const DEFAULT_DESCRIPTION = process.env.QODER_BRIDGE_BYOK_DESCRIPTION
  ?? 'Anthropic 最新模型，世界最强模型';

// 标题的默认值：与描述同处一地定义，避免「副标题在这、标题在那」
export const DEFAULT_TITLE = process.env.QODER_BRIDGE_BYOK_NAME ?? 'Fable5.5';
