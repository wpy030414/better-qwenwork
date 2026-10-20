#!/usr/bin/env node
// byok-model.mjs — 往千问办公写入/查看/删除「Claude」档位（共存方案的 UI 入口）
//
// 原理（一手取证，见 docs/researches/2026-10-20-engine-harness-routing.md 与本报告）：
//   千问办公的模型目录 = 云端 chat-modes（官方 flash/pro 等） ∪ 本地 byok_custom_models 表。
//   App 对 BYOK 条目硬编码 harness = "qoder-cli"，因此选中它才会走 SDK→CLI 这条被我们
//   劫持的链路；官方档位继续走 ACP 引擎，**完全不受影响** —— 这就是共存的分工。
//   下拉显示条件：App 的 allowCustomBYOK = hasCustomByokEnvOverride() || (账号 allowBYOK>=2)，
//   本机账号 allow_byok=0，故需 ALLOW_CUSTOM_BYOK=1（写在 ~/.qwenworkcn/.env 或注册表）。
//
// provider 字段写死哨兵 'claude-bridge'：App 的 resolveModel 会把它经 get_model_policy
// 应答的 custom_model.provider 原样回传，shim 据此零猜测判定该轮属于 Claude。
//
// 不依赖任何第三方库：node 26 自带 node:sqlite；App 侧 decodeParameters 对
// {encoding:"plainBase64"} 是官方支持的分支（safeStorage 不可用时的落盘形态）。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setModelLabels, getModelLabels, reapplyFromDb, CACHE_FILE } from './dynamic-text.mjs';

const PROVIDER_MARKER = process.env.QODER_BRIDGE_BYOK_PROVIDER ?? 'claude-bridge';
// 默认标题（可被 --name 覆盖）。App 与渲染层都优先读 extraParams.displayName，
// 所以这个值必须同时写进 display_name 与 extra_params 两处。
const DEFAULT_TITLE = process.env.QODER_BRIDGE_BYOK_NAME ?? 'Fable 5.5';
const DB_PATH = join(
  process.platform === 'win32' ? process.env.APPDATA : join(homedir(), 'Library', 'Application Support'),
  'QwenWorkCN', 'data', 'agents.db',
);

// 与 App 的 createByokModelKey() 同构：byok- + 12 字符 base64url
const newKey = () => `byok-${randomBytes(9).toString('base64url')}`;
// 与 App 的 encodeParameter() 的 plainBase64 分支一致
const encodeParam = (v) => ({ encoding: 'plainBase64', value: Buffer.from(String(v), 'utf8').toString('base64') });

const openDb = () => {
  if (!existsSync(DB_PATH)) {
    throw new Error(`找不到千问办公数据库：${DB_PATH}\n请先启动过一次千问办公并完成登录。`);
  }
  return new DatabaseSync(DB_PATH);
};

function add({ displayName, model, apiKey, style, url, isVl, maxInputTokens, maxOutputTokens, subtitle }) {
  if (!model) throw new Error('缺少 --model（claude 侧真实模型别名，如 fable / opus）');
  if (!apiKey) throw new Error('缺少 --api-key（占位值亦可：桥接路径不用它，claude 用自己的登录态）');
  const title = displayName ?? DEFAULT_TITLE;
  // model 列必须放**真实模型别名**（shim 会校验形态后用作 claude --model）。
  // 显示文案走 src/dynamic-text.mjs 的本地文案表（`model.<key>.label/description`，
  // 渲染层优先级高于下面这个兜底模板）；--subtitle 只是兜底写法：
  // 渲染层在没有文案表键时会显示硬编码的 `${Anthropic|OpenAI} · ${model列}`。
  const modelColumn = subtitle ?? model;
  const db = openDb();
  try {
    const key = newKey();
    const now = Date.now();
    db.prepare(`
      INSERT INTO byok_custom_models
        (key, source, display_name, provider, type, url, style, model, format,
         is_vl, is_reasoning, max_input_tokens, max_output_tokens,
         encrypted_parameters, extra_params, created_at, updated_at)
      VALUES (?, 'byok', ?, ?, 'claude', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      key,
      title,
      PROVIDER_MARKER,
      url ?? null,
      style ?? 'anthropic',
      modelColumn,
      style ?? 'anthropic',
      isVl ? 1 : 0,
      maxInputTokens ?? 200000,
      maxOutputTokens ?? 32000,
      JSON.stringify({ api_key: encodeParam(apiKey) }),
      // displayName 被主进程 getDisplayName() 与渲染层 fj() 双向读取，必须与列一致
      JSON.stringify({ displayName: title, ...(subtitle ? { claudeModel: model } : {}) }),
      now, now,
    );
    console.log(`已写入档位`);
    console.log(`  key          = ${key}`);
    console.log(`  标题         = ${title}`);
    console.log(`  副标题       = ${style === 'openai' ? 'OpenAI' : 'Anthropic'} · ${modelColumn}`);
    console.log(`  provider     = ${PROVIDER_MARKER}   ← shim 的路由哨兵，勿改`);
    console.log(`  claude 模型  = ${model}`);
    if (subtitle) {
      console.log(`\nmodel 列已被用作副标题文案，真实模型须由环境变量指定：`);
      console.log(`  pnpm apply --claude-model ${model}`);
    }
    console.log(`\n重启千问办公后，下拉框的自定义分组里应出现该条目。`);
    return key;
  } finally { db.close(); }
}

function list() {
  const db = openDb();
  try {
    const rows = db.prepare(
      'select key, display_name, provider, style, model, is_vl, max_input_tokens, max_output_tokens from byok_custom_models order by created_at',
    ).all();
    if (rows.length === 0) { console.log('(byok_custom_models 为空)'); return rows; }
    for (const r of rows) {
      const ours = r.provider === PROVIDER_MARKER ? ' ← 本项目' : '';
      console.log(`${r.key}  ${r.display_name}  provider=${r.provider}  style=${r.style}  model=${r.model}${ours}`);
    }
    return rows;
  } finally { db.close(); }
}

function remove(key) {
  const db = openDb();
  try {
    const r = db.prepare('delete from byok_custom_models where key = ?').run(key);
    console.log(r.changes > 0 ? `已删除 ${key}` : `未找到 ${key}`);
    return r.changes;
  } finally { db.close(); }
}

// 只删我们写的哨兵条目，绝不碰用户自己配的 BYOK
function removeOurs() {
  const db = openDb();
  try {
    const r = db.prepare('delete from byok_custom_models where provider = ?').run(PROVIDER_MARKER);
    console.log(r.changes > 0 ? `已清除本项目写入的 ${r.changes} 个档位` : '本项目未写入过档位');
    return r.changes;
  } finally { db.close(); }
}

// 改现有行的显示字段：**不换 key**，这样 App 的 modelLevel（用户已选中的档位）继续有效。
function edit(key, { displayName, model, subtitle }) {
  if (!key) throw new Error('缺少 --key');
  const db = openDb();
  try {
    const row = db.prepare('select key, display_name, model, extra_params from byok_custom_models where key = ?').get(key);
    if (!row) throw new Error(`未找到 ${key}`);
    const title = displayName ?? row.display_name;
    // subtitle 给了就写进 model 列（渲染层副标题 = `${Anthropic|OpenAI} · <model列>`），
    // 真实模型改由 extra_params.claudeModel + QODER_BRIDGE_MODEL 提供
    const modelColumn = subtitle ?? model ?? row.model;
    let extra = {};
    try { extra = JSON.parse(row.extra_params || '{}'); } catch {}
    db.prepare('update byok_custom_models set display_name=?, model=?, extra_params=?, updated_at=? where key=?')
      .run(title, modelColumn,
        JSON.stringify({ ...extra, displayName: title, ...(subtitle ? { claudeModel: model ?? extra.claudeModel } : { claudeModel: undefined }) }),
        Date.now(), key);
    console.log(`已更新 ${key}`);
    console.log(`  标题   = ${title}`);
    console.log(`  副标题 = Anthropic · ${modelColumn}`);
    console.log(`  真实模型 = ${subtitle ? (model ?? extra.claudeModel ?? '(需 QODER_BRIDGE_MODEL)') : modelColumn}`);
  } finally { db.close(); }
}

// 把期望的显示文案记进 extra_params（App 只原样读出、不解释自定义键，安全）。
// 云端刷新会整体覆盖本地文案缓存，这份"意图源"用于 pnpm model labels --from-db 恢复。
function rememberIntent(key, { label, description }) {
  const db = openDb();
  try {
    const row = db.prepare('select extra_params from byok_custom_models where key = ?').get(key);
    if (!row) throw new Error(`未找到 ${key}（文案已写入缓存，但没有 DB 行可记意图）`);
    let extra = {};
    try { extra = JSON.parse(row.extra_params || '{}'); } catch {}
    if (label != null) extra.label = label;
    if (description != null) extra.description = description;
    db.prepare('update byok_custom_models set extra_params = ?, updated_at = ? where key = ?')
      .run(JSON.stringify(extra), Date.now(), key);
    return extra;
  } finally { db.close(); }
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

const [, , cmd, ...rest] = process.argv;
const f = parseFlags(rest);
try {
  if (cmd === 'add') {
    add({
      displayName: f.displayName ?? f.name,
      model: f.model,
      apiKey: f['api-key'] ?? f.apiKey,
      style: f.style,
      url: f.url,
      isVl: f.vl !== false,
      maxInputTokens: f['max-input'] ? Number(f['max-input']) : undefined,
      maxOutputTokens: f['max-output'] ? Number(f['max-output']) : undefined,
    });
  } else if (cmd === 'list') list();
  else if (cmd === 'edit') edit(f.key ?? rest[0], {
    displayName: f.displayName ?? f.name,
    model: f.model,
    subtitle: f.subtitle,
  });
  else if (cmd === 'labels') {
    // 期望文案写进本地文案缓存；同时记进 DB 行的 extra_params 作为**意图源**，
    // 因为 App 会周期性用云端数据整体覆盖该缓存文件（见 src/dynamic-text.mjs）。
    const key = f.key ?? rest[0];
    const label = f.label ?? f.name;
    const description = f.description ?? f.subtitle;
    if (f['from-db']) {
      const done = reapplyFromDb(DB_PATH);
      console.log(`从 DB 意图源重放 ${done.length} 条文案到 ${CACHE_FILE}`);
      for (const d of done) console.log(`  ${d.key} → 标题=${d.label} 副标题=${d.description}`);
    } else {
      if (!key) throw new Error('缺少 --key（或用 --from-db 重放全部）');
      if (label == null && description == null) throw new Error('至少给 --label 或 --description');
      const r = setModelLabels(key, { label, description });
      rememberIntent(key, { label, description });
      console.log(`已写入本地文案缓存 ${CACHE_FILE}`);
      console.log(`  键      = ${r.touched.join(', ')}`);
      console.log(`  version = ${r.version}（刷新前 updatedAt=${r.updatedAtBefore}）`);
      console.log(`  意图已记入 DB 行 extra_params，云端覆盖后用：pnpm model labels --from-db`);
    }
  } else if (cmd === 'show-labels') {
    console.log(JSON.stringify(getModelLabels(f.key ?? rest[0]), null, 2));
  } else if (cmd === 'rm') remove(f.key ?? rest[0]);
  else if (cmd === 'prune') removeOurs();
  else {
    console.log('用法:');
    console.log('  pnpm model add --model claude-opus-4-5 --api-key placeholder [--name Claude] [--style anthropic]');
    console.log('  pnpm model list');
    console.log('  pnpm model rm --key byok-xxxxxxxx');
    console.log('  pnpm model prune      仅清除本项目写入的哨兵条目');
    console.log(`\n数据库: ${DB_PATH}`);
    console.log(`哨兵 provider: ${PROVIDER_MARKER}`);
  }
} catch (e) {
  console.error(`失败: ${e.message}`);
  process.exit(1);
}
