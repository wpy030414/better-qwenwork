#!/usr/bin/env node
// src/index.mjs — 唯一的安装/撤销入口（pnpm apply / pnpm unapply）
//
// apply 一条命令做完「共存」需要落在系统里的全部三件事：
//   1. 注册挂点：用户级环境变量 QODER_CLI_PATH + QODERCLI_PATH → shim 绝对路径
//      （App 壳层 getBundledQoderCliPath() 读前者，SDK 内核 resolveExecutable() 读后者，
//        缺一个 shim 就不会被调用）。
//   2. 注册开关：ALLOW_CUSTOM_BYOK=1 → 千问办公官方 BYOK 显示门（D16）。
//   3. 供给档位：往 App 的 byok_custom_models 表写/更新一条 provider=claude-bridge 的记录，
//      并落档位文案（D17：原独立入口已合并到此）。
// unapply 对称撤销：撤销全部变量 + 清掉本项目写入的档位 → 恢复原引擎。
//
// 跨平台：Windows（注册表 HKCU\Environment + WM_SETTINGCHANGE 广播）/
//         macOS（LaunchAgent：登录时 launchctl setenv 自动注入 + apply/unapply 时即时生效）
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import {
  DB_PATH, PROVIDER_MARKER, DEFAULT_ALIAS,
  openDb, listTiers, ourTiers, createTier, updateTier, rememberIntent,
  removeTier, removeOurs, readExtra,
} from './byok-store.mjs';
// 默认标题/副标题只在这一个模块里定义（src/tier-text.mjs）。
// apply 把它当作「兜底也显示同一句话」的源头：新建即写入意图源，重放时缺失即补值。
import { DEFAULT_TITLE, DEFAULT_DESCRIPTION } from './tier-text.mjs';

const OS = platform();
// Windows 用 .mjs 文件（SDK 自动识别并调用 node）
// macOS 用 shell wrapper（因为 SDK spawn 时 PATH 不包含 /opt/homebrew/bin，找不到 node）
const SHIM_PATH = OS === 'win32'
  ? join(dirname(fileURLToPath(import.meta.url)), 'bridge-shim.mjs')
  : join(dirname(fileURLToPath(import.meta.url)), 'bridge-shim-wrapper.sh');
// App 壳层 (main.js getBundledQoderCliPath) 读 QODER_CLI_PATH；
// SDK 内核 (resolveExecutable) 读 QODERCLI_PATH（无下划线）。
// 两者必须同时注册，否则 shim 不会被调用。
const ENV_NAMES = ['QODER_CLI_PATH', 'QODERCLI_PATH'];
// 共存方案的第二个挂点：千问办公下拉框要显示「Claude」档位，需要 allowCustomBYOK 为真。
// App 判定（main.js hasCustomByokEnvOverride）：
//   isTruthyEnv(process.env.ALLOW_CUSTOM_BYOK) || isTruthyEnv(process.env.ALLOW_BYOK)
//     || isTruthyEnv(loadQoderDotEnv().ALLOW_CUSTOM_BYOK) || …
//     || 账号 allowBYOK >= 2
// 本机账号 allow_byok=0（企业基础版），故必须靠 env 短路。值接受 1/true/yes/on。
// 它只打开「显示/允许 BYOK」这一道门，不改变官方档位（flash/pro）的任何行为。
const GATE_ENV = { name: 'ALLOW_CUSTOM_BYOK', value: '1' };
// 可选追加项：apply --claude-model <别名> 时注册 QODER_BRIDGE_MODEL。
// 它管的是 **claude 侧真实模型**（shim 的 FORCE_MODEL，覆盖探测结果）；
// --model 管的是 BYOK 表 model 列（下拉副标题的兜底来源）。两个别混用。
const EXTRA_ENV = [];

// ---------- Windows 实现 ----------

const winGetCurrentValue = (name) => {
  try {
    const out = execSync(`reg query "HKCU\\Environment" /v ${name}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.*)/);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
};

const winSetReg = (name, value) =>
  execSync(`reg add "HKCU\\Environment" /v ${name} /t REG_SZ /d "${value}" /f`, { stdio: 'inherit' });

const winDelReg = (name) =>
  execSync(`reg delete "HKCU\\Environment" /v ${name} /f 2>nul`, { stdio: 'ignore' });

const winBroadcast = () => {
  try {
    execSync(
      'powershell -NoProfile -Command "'
      + "Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition '"
      + '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]'
      + 'public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
      + "';"
      + '$result = [UIntPtr]::Zero;'
      + '[Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xFFFF, 0x001A, [UIntPtr]::Zero, \"Environment\", 2, 5000, [ref]$result)'
      + '"',
      { stdio: 'ignore' },
    );
  } catch {
    // 广播失败不阻塞主操作
  }
};

// ---------- macOS 实现 ----------
// 方案：LaunchAgent（DECISIONS.md D10）
//   apply：写 ~/Library/LaunchAgents/com.clauded.qwenwork-bridge.plist（RunAtLoad），
//          登录时 launchd 自动执行 launchctl setenv ×2 → 重启电脑/重新登录后自动注入；
//          同时立即 launchctl setenv ×2，当前会话即时生效。
//   unapply：launchctl unsetenv ×2 + 删除 plist。
//   相比旧版 LSEnvironment（写 App 偏好域，依赖 bundle id + LaunchServices 注入），
//   launchd 用户域环境由 GUI 会话进程继承（Dock/Finder 启动的 App 都生效），不碰 shell profile。

const MAC_LABEL = 'com.clauded.qwenwork-bridge';
const macPlistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);

// XML 转义（plist 内嵌 shim 绝对路径，防 & < > 破坏 XML）
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const macGetEnvValue = (name) => {
  try {
    return execSync(`launchctl getenv ${name} 2>&1`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
};

// 即时生效：launchctl setenv 只对之后启动的进程生效（已运行的千问办公需重启）
const macSetEnvNow = (name, value) => {
  // 值用单引号包裹防 shell 转义（路径与 '1' 均不含单引号）
  execSync(`launchctl setenv ${name} '${value}'`, { stdio: 'inherit' });
};

const macUnsetEnvNow = (name) => {
  try {
    execSync(`launchctl unsetenv ${name}`, { stdio: 'ignore' });
  } catch {
    // 变量不存在时 launchctl 报错，忽略
  }
};

// 登录时自动注入：plist RunAtLoad 执行 /bin/launchctl setenv，支持一次传多对 key value
const macWritePlist = () => {
  mkdirSync(dirname(macPlistPath()), { recursive: true });
  // entries() 在 macWritePlist 之后定义，运行时已初始化（const 声明顺序只影响 TDZ，不影响调用期）
  const args = ['setenv', ...entries().flatMap(({ name, value }) => [name, value])]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/launchctl</string>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;
  writeFileSync(macPlistPath(), xml, { mode: 0o644 });
  console.log(`  已写入 ${macPlistPath()}`);
};

const macDeletePlist = () => {
  if (!existsSync(macPlistPath())) return false;
  rmSync(macPlistPath());
  return true;
};

// ---------- 平台抽象层 ----------

const getCurrentValue = (name) =>
  OS === 'win32' ? winGetCurrentValue(name) : macGetEnvValue(name);

const setEnv = (name, value) => {
  if (OS === 'win32') winSetReg(name, value);
  // macOS：立即 setenv + 写 plist 在 apply() 统一处理
};

const delEnv = (name) => {
  if (OS === 'win32') winDelReg(name);
  // macOS：unsetenv + 删 plist 在 unapply() 统一处理
};

const broadcastChange = () => {
  if (OS === 'win32') winBroadcast();
  // macOS launchctl setenv 由 launchd 即时分发给其后启动的进程，无需广播
};

// ---------- 环境变量注册 ----------

// 要注册的变量全集：shim 劫持点（值 = shim 路径）+ BYOK 显示门（值 = '1'）+ 本次可选项
const entries = () => [
  ...ENV_NAMES.map((name) => ({ name, value: SHIM_PATH })),
  { name: GATE_ENV.name, value: GATE_ENV.value },
  ...EXTRA_ENV,
];

// 撤销全集：还要扫掉**历史**注册过的可选项。新进程里 EXTRA_ENV 恒为空，
// 不显式列出就会漏删上次 apply 写进去的 QODER_BRIDGE_MODEL。
const OPTIONAL_ENV_NAMES = ['QODER_BRIDGE_MODEL'];
const removalEntries = () => [
  ...entries(),
  ...OPTIONAL_ENV_NAMES
    .filter((name) => !entries().some((e) => e.name === name))
    .map((name) => ({ name })),
];

const registerEnv = () => {
  const list = entries();
  if (OS === 'win32') {
    for (const { name, value } of list) {
      const existing = getCurrentValue(name);
      if (existing === value) {
        console.log(`值未变，覆盖写入: ${name}=${value}`);
      } else if (existing) {
        console.log(`替换旧值: ${name}\n  旧: ${existing}\n  新: ${value}`);
      }
      setEnv(name, value);
    }
  } else {
    const existing = macGetEnvValue(ENV_NAMES[0]) || macGetEnvValue(ENV_NAMES[1]);
    if (existing && existing !== SHIM_PATH) {
      console.log(`替换旧值: ${existing}\n  新: ${SHIM_PATH}`);
    }
    macWritePlist();
    for (const { name, value } of list) macSetEnvNow(name, value);
  }
  broadcastChange();
  console.log(`已注册（${OS === 'win32' ? 'Windows 注册表' : 'macOS LaunchAgent'}）:`);
  for (const { name, value } of list) console.log(`  ${name}=${value}`);
};

// 自定义标题/副标题存在千问办公的本地文案缓存里，而 App 会周期性用云端数据整体覆盖
// 那个文件。期望文案记在 byok_custom_models.extra_params，所以每次 apply 顺手重放一次。
// 动态 import + try 包住全部失败面：dynamic-text.mjs 依赖 node:sqlite（Node 22+），
// 若静态引入，老版本 Node 会让**整个 pnpm apply 崩掉**——而 apply 的本职只是注册环境变量，
// 文案重放只是锦上添花，绝不能拖垮主流程。首次安装时缓存文件还不存在，同属正常跳过。
async function reapplyLabels() {
  try {
    const { reapplyFromDb } = await import('./dynamic-text.mjs');
    const done = await reapplyFromDb(DB_PATH);
    if (done.length) {
      console.log(`已重放档位文案 ${done.length} 条：`);
      for (const d of done) {
        console.log(`  ${d.key} → ${d.label ?? DEFAULT_TITLE} / ${d.description ?? DEFAULT_DESCRIPTION}`
          + `${d.defaulted ? '（副标题取默认值）' : ''}`);
      }
    } else {
      // 新语义下这只可能是「表里没有本项目的哨兵行」：
      // 有哨兵行就一定有副标题（缺失即补默认值），不会再落回 App 的硬编码模板。
      console.log('（没有本项目写入的档位可重放；pnpm apply 不带子命令时会新建一条）');
    }
  } catch (e) {
    const first = String(e?.message ?? e).split('\n')[0];
    // 只有「预期内的缺失」才静默跳过（由抛出方打 e.silent 标记）：
    //   · 缓存不存在 —— App 还没从云端拉过该 namespace
    //   · 数据库不存在 —— 首次安装，App 数据目录还没建
    //   · node:sqlite 不可用 —— Node < 22
    // 其余（EBUSY/EACCES/表结构变更等）是**真故障**，必须出声；
    // 早期用 /数据库不存在/ 匹配错误文本，会把「找不到千问办公数据库」这类
    // 形状变化误判成故障、或把真故障误判成静默，故改为显式标记。
    if (e?.silent) console.log(`（档位文案未重放：${first}）`);
    else console.warn(`警告：档位文案重放失败 —— ${first}`);
  }
}

// ---------- 档位供给（原独立入口合并至此） ----------

// 幂等：表里已有本项目的哨兵行 → 更新它（**不换 key**，否则 App 记在 modelLevel 里的
// 选中状态会失效并回落默认档位）；没有 → 新建一条。
// 更新时**只改被点名的字段**：裸跑 pnpm apply 的语义是「补上缺失的挂点/档位」，
// 不是「把档位重置成默认值」——若在这里回落 DEFAULT_ALIAS，会把训练员手选的
// model 列（例如 fable[1m]）静默改回 opus，那是破坏性改写而不是安装。
// 多条哨兵行只更新最早那条并提示，不擅自删用户手动建的同源档位。
async function supplyTier(f) {
  const alias = f.model;
  const title = f.name ?? f.displayName;
  const db = await openDb();
  try {
    const ours = ourTiers(db);
    let key;
    if (ours.length === 0) {
      key = createTier(db, {
        alias: alias ?? DEFAULT_ALIAS,
        title: title ?? DEFAULT_TITLE,
        apiKey: f['api-key'] ?? 'placeholder',
        style: f.style,
        url: f.url,
        isVl: f.vl !== false,
        maxInput: f['max-input'] ? Number(f['max-input']) : undefined,
        maxOutput: f['max-output'] ? Number(f['max-output']) : undefined,
      });
      console.log(`已新建档位 ${key}`);
    } else {
      key = updateTier(db, ours[0].key, { title, alias, style: f.style }).key;
      console.log(`已确认档位 ${key}（沿用原 key；未点名的字段保持原值）`);
      if (ours.length > 1) {
        console.log(`  注意：表里还有 ${ours.length - 1} 条本项目档位未被本次改动，`
          + `用 pnpm apply list 查看，pnpm apply prune 一次清空。`);
      }
    }
    reportTier(key, db);
    return key;
  } finally { db.close(); }
}

// 文案 = 本地文案缓存的键值 + 行内「意图源」（云端覆盖后可重放），两处一起写。
// dynamic-text.mjs 只在需要文案时动态引入：它经 byok-store 用 node:sqlite（Node 22+），
// 老版本 Node 上「写文案」这件事可以降级，不该拖垮挂点注册那条主流程。
// strict 区分两种失败面：
//   · 顺手补写（apply 的一部分）→ 只警告，档位与环境变量已经装好，文案是锦上添花；
//   · 显式请求（apply labels）→ 抛给上层报错退出，否则用户以为文案改了其实没改。
async function writeLabelsFor(key, { label, description }, { strict = false } = {}) {
  if (label == null && description == null) return;
  try {
    // 先记「意图源」再写缓存：rememberIntent 要求 key 在表里真实存在，
    // 于是传错 key 时立刻失败，不会在 App 缓存里留下永远没人重放的孤儿键。
    // （反过来先写缓存，缓存的 model.<错key>.* 会一直显示，而 --from-db 无从恢复。）
    const db = await openDb();
    try { rememberIntent(db, key, { label, description }); } finally { db.close(); }
    const { setModelLabels } = await import('./dynamic-text.mjs');
    const r = setModelLabels(key, { label, description });
    console.log(`  副标题：${description ?? DEFAULT_DESCRIPTION}`
      + `（缓存键 ${r.touched.join(', ')}，version=${r.version}）`);
  } catch (e) {
    if (strict) throw e;
    // 预期内的缺失（App 还没拉过文案缓存 / Node < 22 / 首次安装没 DB）：提示就好
    if (e?.silent) {
      console.log(`  （档位文案未写入：${String(e.message).split('\n')[0]}）`);
      console.log('  档位本身已就绪；启动过千问办公后再跑一次 pnpm apply 即可补上。');
      return;
    }
    // 真故障（缓存形状不符、DB 被锁、写盘失败）必须大声报警：
    // 静默吞掉会让用户以为文案改了，而缓存里仍是旧值——App 下次读出来还是旧的，无从排查
    console.warn(`警告：档位文案写入失败 —— ${String(e?.message ?? e).split('\n')[0]}`);
    console.warn('档位已就绪，但下拉文案可能与预期不符；可用 pnpm apply labels --key … 单独重试。');
  }
}

const reportTier = (key, db) => {
  const row = listTiers(db).find((r) => r.key === key);
  if (!row) return;
  const extra = readExtra(row);
  const desc = extra.description || DEFAULT_DESCRIPTION;
  console.log(`  标题            = ${extra.label ?? row.display_name}`);
  console.log(`  副标题          = ${desc}${extra.description ? '' : '（默认值，tier-text.mjs）'}`);
  console.log(`  model 列        = ${row.model}（真实别名；App 兜底模板才读它，我们不让它生效）`);
  console.log(`  provider        = ${row.provider}   ← shim 的路由哨兵，勿改`);
};

async function showTiers() {
  const db = await openDb();
  try {
    const rows = listTiers(db);
    if (rows.length === 0) { console.log(`(byok_custom_models 为空)\n数据库: ${DB_PATH}`); return; }
    console.log(`数据库 ${DB_PATH}`);
    for (const r of rows) {
      const ours = r.provider === PROVIDER_MARKER;
      const extra = readExtra(r);
      console.log(`${r.key}  ${extra.label ?? r.display_name}  model=${r.model}  style=${r.style}`
        + `  provider=${r.provider}${ours ? '  ← 本项目' : ''}`);
      // 本项目档位：副标题永不为空（缺失即默认值），显示时要标明来源，
      // 否则「它到底是意图源里的还是我们补的」这个问题在现场无法回答
      if (ours) {
        console.log(`    副标题文案: ${extra.description || DEFAULT_DESCRIPTION}`
          + `${extra.description ? '' : '（取 tier-text 默认值）'}`);
      } else if (extra.description) {
        console.log(`    副标题文案: ${extra.description}`);
      }
    }
  } finally { db.close(); }
}

async function pruneTiers() {
  const db = await openDb();
  try {
    const n = removeOurs(db);
    console.log(n > 0 ? `已清除本项目写入的 ${n} 个档位` : '本项目未写入过档位');
  } finally { db.close(); }
}

// ---------- 命令 ----------

const cmdApply = async (f) => {
  registerEnv();
  // 档位是「共存」的另一半：只注册 env 不写档位，下拉里永远等不到 Claude 条目。
  // 数据库不存在（还没启动过千问办公）时不能让整个 apply 崩掉——变量已注册成功，
  // 下次 apply 补档位即可，所以这里降级为显式警告。
  let key = null;
  try {
    key = await supplyTier(f);
  } catch (e) {
    console.warn(`\n档位未写入：${String(e?.message ?? e).split('\n')[0]}`);
    console.warn('环境变量已注册。启动过一次千问办公后，再跑一次 pnpm apply 即可补上档位。');
  }
  if (key) await writeLabelsFor(key, { label: f.label, description: f.description ?? f.subtitle });
  console.log(`\n${GATE_ENV.name} 是千问办公官方的 BYOK 开关（hasCustomByokEnvOverride），`);
  console.log('只影响「自定义模型」是否可见可选，不改变官方 flash/pro 档位的任何行为。');
  await reapplyLabels();
  console.log('\n重启千问办公即可生效（必须完全退出所有 QwenWorkCN 进程）。');
  if (OS === 'darwin') console.log('重启电脑后由 LaunchAgent 在登录时自动恢复注入。');
};

const cmdLabels = async (f) => {
  const { getModelLabels, reapplyFromDb, CACHE_FILE } = await import('./dynamic-text.mjs');
  if (f['from-db']) {
    const done = await reapplyFromDb(DB_PATH);
    console.log(`从 DB 意图源重放 ${done.length} 条文案到 ${CACHE_FILE}`);
      for (const d of done) {
        console.log(`  ${d.key} → 标题=${d.label ?? DEFAULT_TITLE}`
          + ` 副标题=${d.description ?? DEFAULT_DESCRIPTION}${d.defaulted ? '（取默认值）' : ''}`);
      }
    return;
  }
  const key = f.key;
  const label = f.label ?? f.name;
  const description = f.description ?? f.subtitle;
  // 只查不写：`pnpm apply labels --key <k>` 或 `--key <k> --show`
  if (label == null && description == null) {
    if (!key) throw new Error('缺少 --key（写文案要给 --label/--description；或用 --from-db 重放全部）');
    console.log(JSON.stringify(await showLabels(key), null, 2));
    return;
  }
  if (!key) throw new Error('缺少 --key（查 key 用 pnpm apply list）');
  // strict：显式请求写文案，失败就要报错退出，不能只打个警告宣称「已写入」
  await writeLabelsFor(key, { label, description }, { strict: true });
  console.log('  意图已记入 DB 行 extra_params，云端覆盖后可用 pnpm apply labels --from-db 重放');
  if (f.show) console.log(JSON.stringify(await showLabels(key), null, 2));
};

// 读文案：缓存文件还不存在时不报错，回一个 found:false 的形状
// （「查一下现在显示什么」是安全操作，不该因为 App 没拉过云端而失败）
const showLabels = async (key) => {
  try {
    const { getModelLabels } = await import('./dynamic-text.mjs');
    return getModelLabels(key);
  } catch (e) {
    if (e?.silent) return { found: false, perLang: {}, reason: String(e.message).split('\n')[0] };
    throw e;
  }
};

const cmdUnapply = async (f) => {
  let removed = 0;
  const list = removalEntries();
  if (OS === 'win32') {
    for (const { name } of list) {
      if (getCurrentValue(name)) { delEnv(name); removed++; }
    }
  } else {
    if (macDeletePlist()) removed++;
    for (const { name } of list) {
      if (macGetEnvValue(name)) { macUnsetEnvNow(name); removed++; }
    }
  }
  // 档位默认一并清掉：留着它，下拉里仍可被选中，而 App 会拿占位 api_key 直连 MaaS
  // 被账号权限拒绝（UI 报「没有使用该模型或能力的权限」）。这是真机踩过的坑，
  // 所以「撤销」必须是干净的——除非训练员明确要留着档位只撤注入。
  if (!f['keep-tier']) {
    try {
      const db = await openDb();
      try {
        const n = removeOurs(db);
        if (n > 0) { console.log(`已清除本项目写入的 ${n} 个档位`); removed += n; }
      } finally { db.close(); }
    } catch (e) {
      console.log(`（档位未清除：${String(e?.message ?? e).split('\n')[0]}）`);
    }
  } else {
    console.log('已保留 byok 档位（--keep-tier）；若之后不撤注入又留着它，选中它会走官方占位 key 而被拒权。');
  }
  if (removed === 0) { console.log('未注册，无需撤销。'); return; }
  broadcastChange();
  console.log(`已撤销 ${removed} 项，重启千问办公恢复原引擎。`);
};

// 旗标表：显式区分「取值」与「开关」，否则解析只能靠猜——猜错的代价是静默改坏数据。
// 真机实测踩过：`--description Anthropic 最新模型，世界最强模型`（忘了引号）被 shell 切成三个
// argv，旧解析器取走 "Anthropic" 当值、把剩下两个词**无声丢掉**，命令还报告写入成功。
// 文案含空格是常态（本项目默认副标题就带逗号空格），所以这里必须报错而不是兜出半个值。
const VALUE_FLAGS = new Set([
  'model', 'name', 'displayName', 'label', 'description', 'subtitle', 'api-key',
  'style', 'url', 'key', 'max-input', 'max-output', 'claude-model',
]);
const BOOL_FLAGS = new Set(['from-db', 'vl', 'show', 'keep-tier']);

const parseFlags = (argv, { firstPositionalIsSub = false } = {}) => {
  const out = {};
  const orphans = [];   // 既不是旗标、也没被任何旗标吃掉的裸词
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      if (firstPositionalIsSub && Object.keys(out).length === 0 && orphans.length === 0) {
        out.__sub = a;   // 只有最前面的裸词才是子命令
        continue;
      }
      orphans.push(a);
      continue;
    }
    const k = a.slice(2);
    const next = argv[i + 1];
    const nextIsBare = next != null && !next.startsWith('--');
    if (BOOL_FLAGS.has(k)) { out[k] = true; continue; }
    if (VALUE_FLAGS.has(k)) {
      if (!nextIsBare) throw new Error(`--${k} 需要一个值（给了旗标却没跟上内容）`);
      out[k] = next;
      i++;
      // 值后面若还跟着裸词，交给主循环的裸词分支收进 orphans：
      // 99% 是「值里有空格却没加引号」被 shell 切开的残段，这里不做前瞻（前瞻会重复登记同一个词）。
      continue;
    }
    // 未知旗标：不猜它的值，直接拒绝——拼错的旗标静默生效比报错危险得多
    throw new Error(`未知旗标 --${k}（可用：${[...VALUE_FLAGS].join(' / ')}；开关：${[...BOOL_FLAGS].join(' / ')}）`);
  }
  if (orphans.length) {
    throw new Error(`无法理解的参数：${orphans.map((o) => JSON.stringify(o)).join(' ')}\n`
      + '（多半是值里有空格却忘了引号——如 --description "Anthropic 最新模型，世界最强模型"；'
      + '子命令要写在旗标之前，如 pnpm apply list）');
  }
  return out;
};

const usage = () => {
  console.log(`用法:
  pnpm apply [--model <claude 别名>] [--name <标题>] [--label <文案标题>] [--description <文案副标题>] [--api-key <占位>]
      一条命令装完：注册挂点 + BYOK 开关，并写入/更新「Claude」档位（幂等，沿用原 key）
  pnpm apply list            查看 App 的自定义档位（含本项目写入的哨兵行）
  pnpm apply labels --key <byok-..>            查该档位当前文案
  pnpm apply labels --key <byok-..> [--label ..] [--description ..]   改档位文案
  pnpm apply labels --from-db 云端覆盖文案缓存后，从 DB 意图源重放
  pnpm apply prune           仅清除本项目写入的档位，不碰用户自配的 BYOK
  pnpm unapply [--keep-tier] 撤销全部环境变量（默认一并清掉本项目档位）→ 恢复原引擎

当前平台: ${OS}（${OS === 'win32' ? 'Windows 注册表' : OS === 'darwin' ? 'macOS LaunchAgent' : 'Linux 注册表等价'}）
数据库: ${DB_PATH}
路由哨兵 provider: ${PROVIDER_MARKER}`);
};

// 解析整体放进 try：parseFlags 现在会主动抛错（未知旗标/缺值/被空格切开的值），
// 必须走统一的「失败: …」出口并 exit 1，而不是抛裸栈。
let cmd, rest, sub, flags;
try {
// npm/pnpm 的老式参数分隔符 `--` 会原样留在 argv 里：`pnpm apply -- list` → ['--','list']。
// 不剔掉它，'--'.startsWith('--') 会让子命令判定失败 ⇒ 一次「查询」被当成完整 apply 执行
// （写注册表 + 改档位）。命令面绝不能因为包管理器的传参习惯而升格成写操作。
  cmd = process.argv[2];
  // npm/pnpm 的老式参数分隔符 `--` 会原样留在 argv 里：`pnpm apply -- list` → ['--','list']。
  // 不剔掉它，'--'.startsWith('--') 会让子命令判定失败 ⇒ 一次「查询」被当成完整 apply 执行
  // （写注册表 + 改档位）。命令面绝不能因为包管理器的传参习惯而升格成写操作。
  rest = process.argv.slice(3).filter((a) => a !== '--');
  flags = parseFlags(rest, { firstPositionalIsSub: true });
  sub = flags.__sub ?? null;
  if (cmd === 'apply') {
    // --claude-model 是「强制 claude 侧模型」的历史挂点，与档位 model 列**不是一回事**：
    // 它注册 QODER_BRIDGE_MODEL，shim 会用它覆盖探测到的模型名（见 bridge-shim.mjs FORCE_MODEL）。
    if (flags['claude-model']) EXTRA_ENV.push({ name: 'QODER_BRIDGE_MODEL', value: flags['claude-model'] });
    if (sub === 'list') await showTiers();
    else if (sub === 'labels') await cmdLabels(flags);
    else if (sub === 'prune') await pruneTiers();
    else if (sub) throw new Error(`未知子命令 ${sub}（可用：list / labels / prune）`);
    else await cmdApply(flags);
  } else if (cmd === 'unapply') {
    await cmdUnapply(flags);
  } else {
    usage();
  }
} catch (e) {
  console.error(`失败: ${e.message}`);
  process.exit(1);
}
