// native-cli.mjs — 定位千问办公捆绑的**原生** qoder CLI（供透传使用）
//
// 为什么需要它：共存方案的默认分支是「原样透传给官方 CLI」，因此 shim 必须能自己找到官方 exe。
// 不能照抄 App 的 getBundledQoderCliPath()——它的第一优先级就是 QODER_CLI_PATH，
// 照抄会拿到 shim 自己，形成自我递归（main.js 偏移约 587379 实测）：
//   const n=process.env.QODER_CLI_PATH; if(n){...cachedBinaryPath=n; return n}
//
// 复刻的官方判定（只读，均为存在性检查，不写任何文件）：
//   1. QODER_BRIDGE_QODERCLI 显式覆盖（测试与手工兜底用）
//   2. 当前进程 process.resourcesPath/bin（shim 若恰好跑在 Electron 资源树下）
//   3. Windows: %ProgramFiles%\QwenWorkCN\updater.cfg 的 currentVersion 指针 → <安装>\版本\resources\bin
//   4. 兜底：枚举安装目录下所有版本子目录，按目录名取最新
//   5. legacy 选择：官方规则 win32 && x64 && (build<17763 || 无 AVX2) 用 -legacy；
//      这里保守处理——现代版存在就用现代版，仅当现代版缺失且 legacy 存在时用 legacy。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { platform, release } from 'node:os';

const CLI_BASENAME = 'qoderclicn';           // 官方 getQoderCliBaseName()
const WINDOWS_BUN_MIN_BUILD = 17763;         // 官方 WINDOWS_BUN_MIN_BUILD
const EXE = platform() === 'win32' ? '.exe' : '';

const isWin = platform() === 'win32';
const PROGRAM_ROOTS = isWin
  ? ['C:\\Program Files', 'C:\\Program Files (x86)', process.env.ProgramFiles, process.env['ProgramW6432']]
      .filter(Boolean).map((p) => join(p, 'QwenWorkCN'))
  : ['/Applications/QwenWorkCN.app/Contents/Resources', join(process.env.HOME ?? '', 'Applications/QwenWorkCN.app/Contents/Resources')]
      .filter(Boolean);

// 版本目录名形如 1.3.2-26101704；按数字段降序比较，取最新
const versionKey = (name) => {
  const m = /^(\d+)\.(\d+)\.(\d+)-(\d+)$/.exec(name);
  if (!m) return [0, 0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
};
const cmpVersion = (a, b) => {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
};

function readUpdaterCurrentVersion(root) {
  try {
    const cfg = JSON.parse(readFileSync(join(root, 'updater.cfg'), 'utf8'));
    if (typeof cfg.currentVersion === 'string' && cfg.currentVersion.trim()) return cfg.currentVersion.trim();
  } catch { /* updater.cfg 缺失/非 JSON 时静默降级到枚举 */ }
  return null;
}

// 候选 bin 目录：按「最可能正确」排序
function candidateBinDirs() {
  const out = [];
  if (process.resourcesPath) out.push(join(process.resourcesPath, 'bin'));
  for (const root of PROGRAM_ROOTS) {
    // Windows: <root>\<version>\resources\bin ；macOS: <root>\bin（root 已是 Contents/Resources）
    const cur = readUpdaterCurrentVersion(root);
    if (cur) out.push(join(root, cur, 'resources', 'bin'));
    let names = [];
    try { names = readdirSync(root).filter((n) => /^\d+\.\d+\.\d+-\d+$/.test(n)).sort(cmpVersion); } catch { continue; }
    for (const n of names) out.push(join(root, n, 'resources', 'bin'));
    out.push(join(root, 'bin'));
  }
  // 去重，保持插入顺序（updater.cfg 指针与枚举结果常指向同一目录）
  return [...new Set(out.filter(Boolean))];
}

function pickCli(dir) {
  const modern = join(dir, `${CLI_BASENAME}${EXE}`);
  if (existsSync(modern) && statSync(modern).isFile()) return modern;
  const legacy = join(dir, `${CLI_BASENAME}-legacy${EXE}`);
  if (existsSync(legacy) && statSync(legacy).isFile()) return legacy;
  return null;
}

// 非 Windows 平台官方用的是无后缀的 bun 单文件（macOS 资源树内同名），保持一致
function findNativeCli() {
  for (const dir of candidateBinDirs()) {
    const hit = pickCli(dir);
    if (hit) return hit;
  }
  return null;
}

// 递归防护：透传前必须抹掉两个劫持变量，否则官方 CLI 的 SDK 解析或孙进程
// （codesec 安全扫描 runtime 由 CLI 自己写 QODERCLI_PATH）可能回落到 shim 造成递归。
function passthroughEnv(base = process.env) {
  const env = { ...base };
  delete env.QODER_CLI_PATH;
  delete env.QODERCLI_PATH;
  return env;
}

// Windows 旧系统/无 AVX2 时官方会选 legacy；本机走现代版即可，此处仅提供诊断信息
function windowsLegacyExpected() {
  if (!isWin) return false;
  const build = Number((release().match(/^(\d+)\.(\d+)\.(\d+)/) ?? [])[3] ?? NaN);
  return Number.isFinite(build) && build < WINDOWS_BUN_MIN_BUILD;
}

export { findNativeCli, passthroughEnv, windowsLegacyExpected, CLI_BASENAME };
