// dynamic-text.mjs — 写千问办公本地文案缓存，自定义自定义档位的标题/副标题
//
// 为什么要它：渲染层 z9() 的三个函数都有「先查云端文案表，再回退」的顺序
//   getModelLabel(M)       : i18n → dynamicText[`model.${M}.label`] → 官方目录 displayName → extraParams.displayName
//   getModelDescription(M) : i18n → dynamicText[`model.${M}.description`] → 官方目录 description → **BYOK 兜底模板**
// BYOK 兜底模板是硬编码的 `${Anthropic|OpenAI} · ${model列}`，没有独立字段；
// 但 dynamicText 这条通路读的是**本地磁盘缓存**
//   %APPDATA%\QwenWorkCN\data\dynamic-text\qwenwork.json   {sourceKey,version,updatedAt,data:{zh:{},en:{}}}
// 写进 `model.<key>.label` / `model.<key>.description` 就能整行自由控制，
// 也能彻底去掉「Anthropic」前缀。
//
// 边界（务必知道）：
// - 这是 App 自己的缓存文件，不是 app.asar；改它属「外部数据供给」，仍在项目允许范围内。
// - App 会刷新该 namespace，但 refreshNamespace 里有一条短路：
//     if (l && l.version === a.version && l.sourceKey === i) { "Version unchanged, skipping update"; return }
//   即**只有云端版本号变化时**才整体覆盖落盘（自定义键随之丢失），平时重启不受影响。
//   因此期望文案另存一份于 byok_custom_models.extra_params 作为意图源，
//   丢失后 `pnpm apply labels --from-db` 一条命令即可重放；pnpm apply 本身也会顺手重放。
// - sourceKey 必须与运行时解析一致（["baseline","<gateway>"]），否则内存缓存会拒绝这份磁盘数据；
//   本模块只在已存在该文件时补写键值，不凭空造文件。
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const DATA_ROOT = join(
  process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin'
    ? join(process.env.HOME, 'Library', 'Application Support')
    : join(process.env.HOME ?? '', '.config'),
  'QwenWorkCN', 'data', 'dynamic-text',
);
// 可经 env 覆盖：便于测试指向临时 fixture，也便于非常规安装位置
const CACHE_FILE = process.env.QWENWORK_DYNAMIC_TEXT_CACHE ?? join(DATA_ROOT, 'qwenwork.json');

const readCache = () => {
  if (!existsSync(CACHE_FILE)) {
    // silent：App 还没从云端拉过该 namespace 属**预期内**缺失，
    // 由调用方决定是静默跳过（pnpm apply 的顺手重放）还是报警（用户显式要写文案）。
    const e = new Error('本地文案缓存不存在：' + CACHE_FILE
      + '\n（需先启动过一次千问办公，让它从云端拉下该 namespace）');
    e.silent = true;
    throw e;
  }
  const j = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  if (!j.data || !j.version) throw new Error(`本地文案缓存形状不符：缺 data/version`);
  return j;
};

/** 为某个档位 key 设置标题/副标题文案；只补写这两类键，其余原样保留 */
export function setModelLabels(key, { label, description }, langs = ['zh', 'en']) {
  const j = readCache();
  const touched = [];
  for (const lang of langs) {
    if (!j.data[lang] || typeof j.data[lang] !== 'object') continue;
    if (label != null) { j.data[lang][`model.${key}.label`] = label; touched.push(`${lang}.label`); }
    if (description != null) { j.data[lang][`model.${key}.description`] = description; touched.push(`${lang}.description`); }
  }
  if (!touched.length) throw new Error(`未写入任何键（语言包缺失？langs=${langs.join(',')}）`);
  // 原子写：先临时文件再 rename，避免 App 正好在读时截断
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(j), 'utf8');
  renameSync(tmp, CACHE_FILE);
  return { touched, version: j.version, updatedAtBefore: j.updatedAt };
}

export function getModelLabels(key) {
  const j = readCache();
  const out = {};
  for (const [lang, table] of Object.entries(j.data)) {
    if (!table || typeof table !== 'object') continue;
    const l = table[`model.${key}.label`];
    const d = table[`model.${key}.description`];
    if (l != null || d != null) out[lang] = { label: l ?? null, description: d ?? null };
  }
  return { found: Object.keys(out).length > 0, perLang: out, version: j.version, updatedAt: j.updatedAt, sourceKey: j.sourceKey };
}

// 期望文案存在 byok_custom_models.extra_params（App 只原样读出、不解释这些键，安全），
// 所以恢复只需一条命令：pnpm apply labels --from-db
// 开库交给 src/byok-store.mjs（唯一的数据层，含 node:sqlite 的动态引入与平台路径判定），
// 故本模块自身不静态依赖 sqlite：老版本 Node 上「写文案」这件事降级即可。
export async function reapplyFromDb(dbPath) {
  const { openDb } = await import('./byok-store.mjs');
  const db = await openDb(dbPath, { readOnly: true });
  let rows;
  try {
    rows = db.prepare('select key, display_name, extra_params from byok_custom_models').all();
  } finally { db.close(); }
  const done = [];
  for (const r of rows) {
    let extra = {};
    try { extra = JSON.parse(r.extra_params || '{}'); } catch {}
    // 只重放**显式记录过意图**的行：不给没自定义过文案的档位凭空写键，
    // 否则会把「App 兜底显示」也固化成我们的值，掩盖真实来源。
    const label = typeof extra.label === 'string' && extra.label ? extra.label : null;
    const description = typeof extra.description === 'string' && extra.description ? extra.description : null;
    if (label == null && description == null) continue;
    try {
      setModelLabels(r.key, { label, description });
      done.push({ key: r.key, label, description });
    } catch (e) {
      console.log(`  跳过 ${r.key}：${String(e.message ?? e).split('\n')[0]}`);
    }
  }
  return done;
}

export { CACHE_FILE };
