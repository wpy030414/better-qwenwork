// src/byok-store.mjs — 千问办公 BYOK 自定义模型表（byok_custom_models）的数据层
//
// 它只是**库**，不是命令：命令面统一在 src/index.mjs 的 apply/unapply 之下
// （DECISIONS.md D17）。原先独立的 `pnpm model` 入口已取消。
//
// 这张表为什么是共存方案的 UI 入口（一手取证见 docs/researches/2026-10-20-engine-harness-routing.md）：
//   模型目录 = 云端 chat-modes（官方 flash/pro）∪ 本地 byok_custom_models（自定义档位）。
//   App 的 resolveLocalByokModelRoute() 对 BYOK 条目**硬编码** harness="qoder-cli"，且
//   isMissingCatalogModel() 对 `byok-` 前缀豁免目录校验 ⇒ 选中它必然落进 SDK→CLI 那条链路
//   （正是 QODER_CLI_PATH 劫持的链路）；官方档位继续走 ACP 引擎，分流由 App 自身完成。
//   下拉可见性只由一个布尔控制：allowCustomBYOK = hasCustomByokEnvOverride() || 账号 allowBYOK>=2，
//   前者读 ALLOW_CUSTOM_BYOK/ALLOW_BYOK（由 pnpm apply 注册）。
//
// 字段约定（真机可用形态，勿随意改动）：
//   provider  = 哨兵 'claude-bridge' → App 的 resolveModel 会经 get_model_policy 应答的
//               custom_model.provider 原样回传，shim 据此**零猜测**判定该轮属于 Claude。
//   key       = 'byok-' + 12 字符 base64url，与 App 的 createByokModelKey() 同构（前缀必须保留）
//   type/style/format = 'claude'/'anthropic'
//   encrypted_parameters = {"api_key":{"encoding":"plainBase64","value":"<base64>"}}
//               —— App 官方支持的分支（safeStorage 不可用时的落盘形态），值只是占位：
//                  桥接路径不用它，claude 用自己的登录态。
//   extra_params = {displayName, label?, description?}：displayName 被主进程与渲染层双向读取，
//               必须与列一致；label/description 是「档位文案意图源」，见 src/dynamic-text.mjs。
//
// 零第三方依赖：node:sqlite 是 Node 22+ 内置；它只在**真要开库时**动态引入，
// 于是老版本 Node 上挂点注册（apply 的主流程）不会被档位/文案这件事一起带崩。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomBytes } from 'node:crypto';

export const PROVIDER_MARKER = process.env.QODER_BRIDGE_BYOK_PROVIDER ?? 'claude-bridge';
// 新建档位的默认值：别名 opus 任何 Claude 登录态都吃；标题可被 --name 覆盖
export const DEFAULT_TITLE = process.env.QODER_BRIDGE_BYOK_NAME ?? 'Claude';
export const DEFAULT_ALIAS = 'opus';

// App 的 userData 根：Windows %APPDATA%\QwenWorkCN / macOS ~/Library/Application Support/QwenWorkCN
// Linux 下 Electron 默认 ~/.config/<app name>，根目录已含 QwenWorkCN，故不再拼接。
const APP_ROOT = platform() === 'win32'
  ? join(process.env.APPDATA ?? '', 'QwenWorkCN')
  : platform() === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'QwenWorkCN')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'QwenWorkCN');

export const DB_PATH = join(APP_ROOT, 'data', 'agents.db');

const newKey = () => `byok-${randomBytes(9).toString('base64url')}`;
const encodeParam = (v) => ({ encoding: 'plainBase64', value: Buffer.from(String(v), 'utf8').toString('base64') });

// 抛出的错误带 silent 标记时，调用方（pnpm apply）把它当作「预期内的缺失」静默跳过，
// 而不是当故障报警。判据用标记而不是匹配错误文本——文本会随措辞变化而误判。
export async function openDb(path = DB_PATH, { readOnly = false } = {}) {
  if (!existsSync(path)) {
    const e = new Error('找不到千问办公数据库：' + path
      + '\n（请先启动过一次千问办公并完成登录）');
    e.silent = true;   // 首次安装：App 数据目录还没建
    throw e;
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (cause) {
    const e = new Error('node:sqlite 不可用（需 Node ≥ 22）：' + String(cause?.message ?? cause));
    e.silent = true;   // 老版本 Node：档位/文案这件事降级，不拖垮挂点注册那条主流程
    throw e;
  }
  return readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
}

const readExtra = (row) => { try { return JSON.parse(row?.extra_params || '{}'); } catch { return {}; } };

export function listTiers(db) {
  return db.prepare(`select key, display_name, provider, style, model, url, is_vl,
    max_input_tokens, max_output_tokens, extra_params from byok_custom_models order by created_at`).all();
}

// 本项目写入的哨兵行（绝不含用户自己配的 BYOK）
export function ourTiers(db) {
  return listTiers(db).filter((r) => r.provider === PROVIDER_MARKER);
}

/** 新建一条档位；返回 key */
export function createTier(db, { alias, title, apiKey, style, url, isVl, maxInput, maxOutput }) {
  const key = newKey();
  const now = Date.now();
  const st = style ?? 'anthropic';
  db.prepare(`
    INSERT INTO byok_custom_models
      (key, source, display_name, provider, type, url, style, model, format,
       is_vl, is_reasoning, max_input_tokens, max_output_tokens,
       encrypted_parameters, extra_params, created_at, updated_at)
    VALUES (?, 'byok', ?, ?, 'claude', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
  `).run(
    key, title ?? DEFAULT_TITLE, PROVIDER_MARKER, url ?? null, st,
    alias ?? DEFAULT_ALIAS, st, isVl ? 1 : 0,
    maxInput ?? 200000, maxOutput ?? 32000,
    JSON.stringify({ api_key: encodeParam(apiKey ?? 'placeholder') }),
    JSON.stringify({ displayName: title ?? DEFAULT_TITLE }),
    now, now,
  );
  return key;
}

/**
 * 只改显示字段与真实模型别名，**不换 key**——App 把用户已选中的档位记在 modelLevel 里，
 * 换 key 会让选中状态失效并回落到默认档位。
 * 语义是「部分更新」：给了哪个字段才改哪个，未给的一律取**当前行**的原值。
 * （故 SELECT 必须覆盖所有被回读的列——早先漏了 style，把部分更新变成了把 style 写成 null。）
 */
export function updateTier(db, key, { title, alias, label, description, style } = {}) {
  const row = db.prepare(`select key, display_name, provider, style, model, url, is_vl,
    max_input_tokens, max_output_tokens, extra_params from byok_custom_models where key = ?`).get(key);
  if (!row) throw new Error(`未找到档位 ${key}`);
  const nextTitle = title ?? row.display_name;
  const nextAlias = alias ?? row.model;
  const extra = readExtra(row);
  extra.displayName = nextTitle;
  if (label != null) extra.label = label;
  if (description != null) extra.description = description;
  db.prepare(`update byok_custom_models
    set display_name=?, model=?, style=?, format=?, extra_params=?, updated_at=? where key=?`)
    .run(
      nextTitle, nextAlias,
      style ?? row.style ?? 'anthropic',
      style ?? row.style ?? 'anthropic',
      JSON.stringify(extra), Date.now(), key,
    );
  return { key, title: nextTitle, alias: nextAlias, style: style ?? row.style, extra };
}

/** 把「期望文案」记进行内 extra_params（App 只原样读出、不解释这些自定义键，安全）。 */
export function rememberIntent(db, key, { label, description }) {
  const row = db.prepare('select extra_params from byok_custom_models where key = ?').get(key);
  if (!row) throw new Error(`未找到 ${key}（文案已写入缓存，但没有 DB 行可记意图）`);
  const extra = readExtra(row);
  if (label != null) extra.label = label;
  if (description != null) extra.description = description;
  db.prepare('update byok_custom_models set extra_params = ?, updated_at = ? where key = ?')
    .run(JSON.stringify(extra), Date.now(), key);
  return extra;
}

export function removeTier(db, key) {
  return db.prepare('delete from byok_custom_models where key = ?').run(key).changes;
}

// 只删我们写的哨兵行，绝不碰用户自己配的 BYOK
export function removeOurs(db) {
  return db.prepare('delete from byok_custom_models where provider = ?').run(PROVIDER_MARKER).changes;
}

export { readExtra };
