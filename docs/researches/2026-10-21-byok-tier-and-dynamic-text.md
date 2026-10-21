# BYOK 档位供给与本地文案表（观测记录）

- 观测对象：QwenWorkCN `1.3.2-26101704` 的 `agents.db.byok_custom_models` 表与
  `%APPDATA%\QwenWorkCN\data\dynamic-text\qwenwork.json`
- 取证时间：2026-10-20 首发，2026-10-21 随「档位供给并入 apply」重构复跑
- 观测手段：对真库/真缓存的读写观测 + 临时目录 fixture 复现（工具在
  `.analysis/legacy-verification/dynamic-text.test.mjs`，gitignore 取证区，
  复现：`node .analysis/legacy-verification/dynamic-text.test.mjs`）
- 本文记**观测到的字段行为与失效形态**；命令面设计见 `docs/ARCHITECTURE.md`，取舍见 `docs/DECISIONS.md` D16/D17/D19

## 结论速览

2026-10-21 复跑（含「统一默认副标题」改造后）：文案表 **18 项**观测全部成立。四条要点：

1. **档位条目写进这张表 = 出现在下拉里**，且被 App 硬编码路由到 `harness="qoder-cli"`；
2. **标题/副标题的唯一自由通道是本地文案缓存的 `model.<key>.label|description` 键**——
   App 对 BYOK 的副标题没有独立字段，是硬编码模板；
3. **该缓存会被云端整体覆盖**，所以期望文案必须另存一份意图源（记在行内 `extra_params`），
   覆盖后一条命令重放；
4. **默认副标题只有一个源（`src/tier-text.mjs`），四个出口同值**：新建档位的意图源、
   重放时缺失的填补、shim 合成 `get_models` 的两处兜底——
   策略是让 App 那句改不了的硬编码模板**永远没有生效机会**（详见 §三·补）。

## 一、表字段的可观测行为

真库当前那一行（2026-10-21，本项目写入并被 App 接受）：

```json
{"display_name":"Fable5.5","provider":"claude-bridge","type":"claude",
 "style":"anthropic","format":"anthropic","model":"fable[1m]","is_vl":1,
 "max_input_tokens":200000,"max_output_tokens":32000,
 "extra_params":"{\"displayName\":\"Fable5.5\",\"label\":\"Fable5.5\",\"description\":\"Anthropic 最新模型，世界最强模型\"}"}
```

逐列说明哪些是**观测出来的约束**，哪些是我们的选择：

| 列 | 观测到的行为 |
|---|---|
| `key` | 必须 `byok-` 前缀：App 的 `isMissingCatalogModel()` 显式豁免该前缀的目录校验，否则选中即被判「目录里不存在」并回落默认档位 |
| `provider` | 路由哨兵。App 的 `resolveModel` 会把它经 `get_model_policy` 应答的 `custom_model.provider` **原样回传**，故 shim 能零猜测判定本轮属于 Claude |
| `display_name` | 主进程 `getDisplayName()` 与渲染层双向读取；必须与 `extra_params.displayName` 一致，否则两处显示分叉 |
| `model` | App 原样回传，同时是副标题兜底模板的输入。**它承担显示职责时，值就不是模型名**（见 §三） |
| `encrypted_parameters` | `{api_key:{encoding:"plainBase64",value:"<base64>"}}` 是 App 官方支持的分支（safeStorage 不可用时的落盘形态）；值只是占位，桥接路径不用它 |
| `style` / `format` | 观测到的可用值是 `anthropic`。**二者需同时存在且一致**（见 §四的两个坑） |
| `extra_params` | App 只**原样读出**、不解释自定义键 ⇒ 可以安全地往里塞我们的意图源 |

## 二、标题/副标题为什么只能走本地文案缓存

渲染层三个函数的取值顺序（一手解包）：

```
getModelLabel(M)       : i18n → dynamicText["model.<M>.label"] → 官方目录 displayName → extraParams.displayName
getModelDescription(M) : i18n → dynamicText["model.<M>.description"] → 官方目录 description → BYOK 兜底模板
```

BYOK 的兜底模板是**硬编码**的 `${Anthropic|OpenAI} · <model列>`，没有独立字段。
所以想自由控制这两行文案、或去掉「Anthropic」前缀，只有 `dynamicText` 这一条通路——
它读的是本地磁盘缓存：

```
%APPDATA%\QwenWorkCN\data\dynamic-text\qwenwork.json
形状：{sourceKey, version, updatedAt, data:{zh:{...}, en:{...}}}
```

2026-10-21 fixture 观测到的读写行为（含 D19 追加的三条，共 18 项）：

- 写一个档位 = `zh`/`en` 各写 `label` + `description`，共 **4 个键**（缺语言环境时仍能显示）；
- 只给 `description` 时 `label` **保持不变**（部分更新，不是整体覆盖）；
- **原有官方文案不被破坏**（`model.flash.label` 仍是「标准」）：本模块只在已存在的文件上补写键值；
- `sourceKey`/`version` 必须**保留原值**：`refreshNamespace` 的短路判据是
  `l.version === a.version && l.sourceKey === i` ⇒ 一旦改动，内存缓存会拒绝这份磁盘数据；
- 写重放**不改动 `version`**（否则会被误判为需要向云端刷新）；
- 缓存文件**不存在时报错**，不凭空造（App 没拉过该 namespace 时，凭空造的文件会被拒绝）；
- 落盘走「临时文件 + rename」原子写，避免 App 正在读时被截断。

## 三、缓存被云端整体覆盖后的恢复路径

风险本身也是观测出来的一行：「模拟云端刷新（整体替换 `data`）后，`model.<key>.*` 自定义键**确实丢失**」。
丢失的条件是**云端版本号变化**（`refreshNamespace` 的版本短路），所以平时重启 App 不受影响，
但一次 App 升级或云端发新文案就会把自定义档位打回兜底显示。

恢复靠「意图源」：期望文案同时记进 `byok_custom_models.extra_params.label/description`，
重放即从行里取。观测到的关键行为是——

- `reapplyFromDb` **按 `provider` 划界**：只处理本项目写入的哨兵行，
  `provider ≠ claude-bridge` 的行（用户自己配的 BYOK）整行跳过、绝不凭空写键——
  替别人的档位决定显示文案是越界。
- 哨兵行内部再分两种：**显式写过的自定义文案优先，缺失才补默认值**（`defaulted: true` 标记）。
  > 这条是 2026-10-21 「统一默认副标题」改造**推翻的旧不变式**。原文是
  > 「只重放显式记录过意图的行，否则会把 App 兜底显示固化成我们的值」。
  > 新前提主人直接指定：默认副标题必须是那一句、且任何兜底面都要显示它。
  > 于是「掩盖真实来源」不再是要保护的性质，**「显示与默认值一致」才是要保护的**。
  > 旧断言 `只重放有意图记录的行（got 1）` 在改造后当场变红（got 2），
  > 已按新语义重写为三条：哨兵行补默认 / 显式文案不被覆盖 / 非哨兵行不写入。

命令面（D17 后）：`pnpm apply` 每次顺手重放；单独重放用 `pnpm apply labels --from-db`。

## 三·补 默认副标题的统一源（改造实测）

要求是「无论在哪里兜底都显示同一句话」，所以把四个出口逐一实测，而不是只改一处常量：

| 出口 | 位置 | 实测方式 | 结果 |
|---|---|---|---|
| 新建档位的意图源 | `byok-store.createTier` 写 `extra_params.description` | DB 副本上建一条 | `displayName` + 默认副标题同时落盘 |
| 更新时填补空值 | `byok-store.updateTier` | 副本上抹掉 description 再更新 | 补回默认值，非哨兵行不动 |
| 云端覆盖后的重放 | `dynamic-text.reapplyFromDb` | 临时缓存 + DB 副本端到端 | 缓存描述 = 默认值，`defaulted: true` |
| shim 合成模型列表 | `bridge-shim` 的 `synthFor('get_models')` map 分支与 `MODELS_FALLBACK` | 起两个桩 claude（一个有 models 无描述、一个无 models）跑真 shim，读回 `control_response` | 两口的 `description` 均 = 默认值 |

第 4 项的动机要说清：`bridge-shim.mjs` 里原本硬编码着两个**别的**串
（`使用强大的 Claude Code 代理后端` 与 `Claude Code (bridge)`），它们出现在「无原生 CLI ⇒ 全量桥接」
的降级路径上。降级时用户看到的模型描述与正常档位描述不一致，就是「兜底面不统一」的实例，
故一并换成真相源常量。改动后 shim 密闭 42 项无回归，并追加第 9 组三项（两处 get_models 兜底 + 兜底条目标题）——现为 45 项。

一处刻意的**不统一**：`synthFor('get_models')` 用 `m.description || DEFAULT_DESCRIPTION`
而不是无条件覆盖——claude 自己给了描述就用它（那是上游信息，不是兜底）。
只有「没有描述」这件事才落到统一默认值上。
另注意 `generate_session_title` 应答里的 `req.description` 是**宿主的入参**（用来生成会话标题），
与档位文案无关，不要混同。

App 那句硬编码模板 `${Anthropic|OpenAI} · <model列>` 在 app.asar 里，属项目禁止改动面，
所以对抗方式是**让 `dynamicText` 通路永远有值**：描述非空的哨兵行在渲染层一定命中第 2 优先级，
轮不到模板。这也是为什么 `updateTier`/`createTier` 都要保证 `description` 非空。

## 四、实测踩到的三个坑（如实记录）

这三个都是**我们自己的代码缺陷**，由真库/真缓存观测当场暴露，不是推断：

1. **部分更新把 `style` 写成 `null`。** 更新语句回读行时 `SELECT` 漏了 `style` 列，
   于是 `style ?? row.style` 恒为 `undefined` ⇒ 一次「什么都没点名」的 `pnpm apply`
   把真库里那行的 `style: "anthropic"` 打成了 `null`。
   修法：`SELECT` 覆盖所有被回读的列，并让 `style`/`format` 落到 `'anthropic'` 兜底。
   教训：任何「读-改-写」的部分更新，回读列集合必须与被写列集合一致——
   这类缺陷不会让命令报错，只会**静默改坏数据**，所以必须逐列比对既有可用行。
2. **默认值回落是破坏性改写。** `--model` 缺省时若回落 `DEFAULT_ALIAS`（`opus`），
   会把训练员手选档位从 `fable[1m]` 静默改回 `opus`。裸跑 `pnpm apply` 的语义是
   「补上缺失的挂点/档位」，不是「把档位重置成默认值」⇒ 新建路径才用默认值，
   更新路径只改被点名的字段。

两条共同指向一条设计约束：**命令面可以幂等，但幂等不等于「重写为默认」**。
（注意它与 D19 的边界：这条约束针对**已有值**的字段——未点名不得改写；
而**空值**必须被默认值填上，否则就落回 App 的硬编码模板。二者不矛盾。）

3. **含空格的旗标值被静默截断。** 为验证默认副标题而执行
   `apply labels --description Anthropic 最新模型，世界最强模型`（忘了引号）时，
   旧解析器取走第一个词 `"Anthropic"` 当值、把残段**无声丢掉**，并报告「写入成功」。
   真库那行与本地缓存双双被写成 `"Anthropic"`。
   复现命令（现在会拒绝）：`node src/index.mjs apply labels --key k --description A B`
   ⇒ `失败: 无法理解的参数："B"`，exit 1。
   这不是本次才有的缺陷，是它一直在那里、只是恰好被一次带空格的测试触发：
   **本项目默认副标题本身就含空格与逗号**，所以「值里带空格」是常态而非边角。
   修法是把旗标分成「取值 / 开关」两类显式声明：未知旗标拒绝、缺值报错、
   残段（孤儿裸词）报错，三类都 exit 1。
   顺带修正一处顺序缺陷：写文案原先「先写缓存、后记意图源」，key 打错时会在 App 缓存里
   留下**永远没人重放的孤儿键**（意图源里没有那行）。现改为先记意图源再写缓存——
   `rememberIntent` 要求 key 真实存在，于是传错 key 立刻失败且不污染缓存。

## 五、撤销必须连档位一起撤

留档位、只撤注入的后果（2026-10-20 真机踩过，现象记录在 `docs/ARCHITECTURE.md`）：
BYOK 条目在下拉里**始终可见可选**（显示由表驱动），但没有 shim 参与时 App 会走自己的
`local-byok` 路径，拿表里的**占位 api_key 直连 MaaS**，被账号权限拒绝——

```
UI：「你当前的账号没有使用该模型或能力的权限。请在输入区切换模型后重试。」
main.log：{"decoderId":"qodercli-result","sourceCode":403,"failureKind":"permission-denied"}
```

这是「注入未生效」的诊断信号，不是官方服务出问题，也不是档位写坏。
所以 `pnpm unapply` 默认一并清除本项目写入的哨兵行（可用 `--keep-tier` 显式保留），
撤销才是干净的。判据始终是那一条：该时刻 `src/logs/` 有无新文件。

## 六、未覆盖 / 待复核

1. `style`/`format` 的词表与 `custom_model` 的校验规则（CLI 侧有
   `get_model_policy model must use the outerProvider key prefix` 之类硬约束）来自
   二进制字符串与推断，**UI 实测是唯一权威判据**。
2. 意图源重放现按 `provider` 划界（哨兵行必然拿到描述，缺失补默认）；
   但若用户绕过本工具在 App 里改了档位标题，`display_name` 与 `extra_params.displayName`
   会分叉，本模块不会去猜哪个是真的——只显示缓存里现有的键值。
3. **默认副标题只覆盖「我们写的哨兵行」**。用户自配的 BYOK 若没有描述，
   仍会显示 App 的 `Anthropic · <model列>` 模板——那是边界外的东西（D19 明确不越界），
   不是遗漏。
4. 默认值在 `src/tier-text.mjs` 一处定义，但 **App 端 `model.<key>.label` 的 i18n 优先级
   高于 dynamicText**（`getModelLabel` 第一级是 i18n）；本机未见官方占用 `model.byok-*` 命名空间，
   若某天官方开始下发同名键，我们的默认值会被 i18n 覆盖——届时需实测确认优先级。
3. `agents.db` 的表结构随 App 版本变化即可能让写表失败（列名/约束），届时需重跑一次
   `pnpm apply` 观测其报错形态。
