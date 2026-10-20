// dynamic-text.test.mjs — 本地文案表读写与「云端覆盖后恢复」的密闭测试
// 运行：node src/dynamic-text.test.mjs
// 全部在临时目录里跑，绝不碰真实的 %APPDATA%\QwenWorkCN 数据。
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'dyn-text-test-'));
const CACHE = join(tmp, 'qwenwork.json');
const DB = join(tmp, 'agents.db');

// 必须在 import 前设好：模块在加载时读一次 env 决定缓存路径
process.env.QWENWORK_DYNAMIC_TEXT_CACHE = CACHE;

const seedCache = (obj) => writeFileSync(CACHE, JSON.stringify(obj), 'utf8');

// 与真实文件同构：{sourceKey,version,updatedAt,data:{zh:{},en:{}}}
const fixtureCache = (extra = {}) => ({
  sourceKey: '["baseline","https://gateway.qwenwork.cn"]',
  version: '1.0.14',
  updatedAt: '2026-10-20T05:12:33.297Z',
  data: {
    zh: { 'model.flash.label': '标准', 'model.flash.description': '极速全能', ...extra.zh },
    en: { 'model.flash.label': 'Standard', 'model.flash.description': 'fast', ...extra.en },
  },
});

const makeDb = (rows) => {
  const db = new DatabaseSync(DB);
  db.exec(`create table byok_custom_models (
    key text primary key, display_name text not null, model text not null,
    provider text, style text, format text, is_vl integer default 0, is_reasoning integer default 0,
    max_input_tokens integer default 0, max_output_tokens integer default 0,
    encrypted_parameters text default '{}', extra_params text default '', source text default 'byok',
    url text, type text, legacy_key text, migrated_from text, created_at integer, updated_at integer)`);
  for (const r of rows) {
    db.prepare('insert into byok_custom_models (key, display_name, model, provider, extra_params) values (?,?,?,?,?)')
      .run(r.key, r.display_name, r.model, r.provider, r.extra_params ?? '{}');
  }
  db.close();
};

let pass = 0, fail = 0;
const ok = (c, name) => { console.log(`${c ? 'PASS' : 'FAIL'} ${name}`); c ? pass++ : fail++; };

const { setModelLabels, getModelLabels, reapplyFromDb, CACHE_FILE } = await import('./dynamic-text.mjs');
ok(CACHE_FILE === CACHE, '缓存路径受 env 覆盖（测试不碰真实数据）');

// ---------- 1. 写入与回读 ----------
{
  seedCache(fixtureCache());
  const r = setModelLabels('byok-abc', { label: 'Fable5.5', description: '最强模型，世界最强模型' });
  ok(r.touched.length === 4, `zh/en 各写 label+description（got ${r.touched.length}）`);
  const back = getModelLabels('byok-abc');
  ok(back.found && back.perLang.zh.label === 'Fable5.5', '回读 zh 标题正确');
  ok(back.perLang.zh.description === '最强模型，世界最强模型', '回读 zh 副标题正确');
  ok(back.perLang.en.description === '最强模型，世界最强模型', 'en 同步写入（缺语言环境时仍可显示）');
  const j = JSON.parse(readFileSync(CACHE, 'utf8'));
  ok(j.data.zh['model.flash.label'] === '标准', '原有官方文案未被破坏');
  ok(j.sourceKey === fixtureCache().sourceKey && j.version === '1.0.14', 'sourceKey/version 保留（否则缓存校验会拒绝）');
}

// ---------- 2. 只写其一不覆盖另一 ----------
{
  seedCache(fixtureCache({ zh: { 'model.byok-abc.label': '旧标题', 'model.byok-abc.description': '旧副标题' },
                           en: { 'model.byok-abc.label': '旧标题', 'model.byok-abc.description': '旧副标题' } }));
  setModelLabels('byok-abc', { description: '新副标题' });
  const b = getModelLabels('byok-abc');
  ok(b.perLang.zh.label === '旧标题' && b.perLang.zh.description === '新副标题', '只给 description 时 label 保持不变');
}

// ---------- 3. 文件不存在时明确报错，不凭空造 ----------
{
  rmSync(CACHE, { force: true });
  let err = null;
  try { setModelLabels('byok-x', { label: 'x' }); } catch (e) { err = e; }
  ok(!!err && /缓存不存在/.test(err.message), '缓存缺失时报错提示（需 App 先拉过一次云端）');
}

// ---------- 4. 云端整体覆盖后，从 DB 意图源恢复 ----------
{
  seedCache(fixtureCache());
  makeDb([
    { key: 'byok-keep', display_name: 'Fable5.5', model: 'fable[1m]', provider: 'claude-bridge',
      extra_params: JSON.stringify({ displayName: 'Fable5.5', label: 'Fable5.5', description: '最强模型，世界最强模型' }) },
    { key: 'byok-nointent', display_name: 'Claude', model: 'opus', provider: 'claude-bridge',
      extra_params: JSON.stringify({ displayName: 'Claude' }) },
  ]);
  // 模拟云端刷新：整体替换 data，自定义键消失
  seedCache({ sourceKey: '["baseline","https://gateway.qwenwork.cn"]', version: '1.0.15',
              updatedAt: new Date().toISOString(), data: { zh: { 'model.flash.label': '标准' }, en: {} } });
  ok(!getModelLabels('byok-keep').found, '覆盖后自定义键确实丢失（这就是风险本身）');

  const done = reapplyFromDb(DB);
  ok(done.length === 1, `只重放有意图记录的行（got ${done.length}）`);
  ok(done[0].label === 'Fable5.5' && done[0].description === '最强模型，世界最强模型', '重放内容取自 extra_params');
  const b = getModelLabels('byok-keep');
  ok(b.found && b.perLang.zh.description === '最强模型，世界最强模型', '恢复后文案回到缓存');
  ok(JSON.parse(readFileSync(CACHE, 'utf8')).version === '1.0.15', '重放不改动 version（不影响缓存有效性判断）');
}

// ---------- 5. 无 DB / 空表时的行为 ----------
{
  seedCache(fixtureCache());
  rmSync(DB, { force: true });
  let err = null;
  try { reapplyFromDb(DB); } catch (e) { err = e; }
  ok(!!err && /数据库不存在/.test(err.message), 'DB 缺失时报错而非静默');
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n===== 结果: ${fail === 0 ? '全部通过' : fail + ' 项失败'}（共 ${pass + fail} 项）=====`);
process.exit(fail === 0 ? 0 : 1);
