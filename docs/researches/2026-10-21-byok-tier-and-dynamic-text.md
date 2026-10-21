# BYOK 档位供给与本地文案表（观测记录）

- 观测对象：QwenWorkCN `1.3.2-26101704` 的 `agents.db.byok_custom_models` 表与
  `%APPDATA%\QwenWorkCN\data\dynamic-text\qwenwork.json`
- 取证时间：2026-10-20 首发，2026-10-21 随「档位供给并入 apply」重构复跑
- 观测手段：对真库/真缓存的读写观测 + 临时目录 fixture 复现（工具在
  `.analysis/legacy-verification/dynamic-text.test.mjs`，gitignore 取证区，
  复现：`node .analysis/legacy-verification/dynamic-text.test.mjs`）
- 本文记**观测到的字段行为与失效形态**；命令面设计见 `docs/ARCHITECTURE.md`，取舍见 `docs/DECISIONS.md` D16/D17

## 结论速览

2026-10-21 复跑：文案表 15 项观测全部成立。三条要点：

1. **档位条目写进这张表 = 出现在下拉里**，且被 App 硬编码路由到 `harness="qoder-cli"`；
2. **标题/副标题的唯一自由通道是本地文案缓存的 `model.<key>.label|description` 键**——
   App 对 BYOK 的副标题没有独立字段，是硬编码模板；
3. **该缓存会被云端整体覆盖**，所以期望文案必须另存一份意图源（记在行内 `extra_params`），
   覆盖后一条命令重放。

## 一、表字段的可观测行为

真库当前那一行（2026-10-21，本项目写入并被 App 接受）：

```json
{"display_name":"Fable5.5","provider":"claude-bridge","type":"claude",
 "style":"anthropic","format":"anthropic","model":"fable[1m]","is_vl":1,
 "max_input_tokens":200000,"max_output_tokens":32000,
 "extra_params":"{\"displayName\":\"Fable5.5\",\"label\":\"Fable5.5\",\"description\":\"最强模型，世界最强模型\"}"}
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

2026-10-21 fixture 观测到的读写行为（15 项）：

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

- `reapplyFromDb` **只重放显式记录过意图的行**；没自定义过文案的档位不会被凭空写键。
  否则会把「App 兜底显示」也固化成我们的值，从此掩盖真实的显示来源。

命令面（D17 后）：`pnpm apply` 每次顺手重放；单独重放用 `pnpm apply labels --from-db`。

## 四、重构当日实测踩到的两个坑（如实记录）

这两个都是**写库代码的缺陷**，由真库观测当场暴露，不是推断：

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
2. 意图源重放只在「行里有 `label`/`description`」时生效；若用户绕过本工具在 App 里改档位，
   意图源与显示会分叉，本模块不会去猜。
3. `agents.db` 的表结构随 App 版本变化即可能让写表失败（列名/约束），届时需重跑一次
   `pnpm apply` 观测其报错形态。
