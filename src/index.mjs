#!/usr/bin/env node
// src/index.mjs — pnpm apply / pnpm unapply
// 注册或撤销用户级环境变量 QODER_CLI_PATH + QODERCLI_PATH，让千问办公走 Claude Code 桥接
// 跨平台：Windows（注册表 HKCU\Environment + WM_SETTINGCHANGE 广播）/
//         macOS（LaunchAgent：登录时 launchctl setenv 自动注入 + apply/unapply 时即时生效）
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';

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

// ---------- 命令 ----------

// 要注册的变量全集：shim 劫持点（值 = shim 路径）+ BYOK 显示门（值 = '1'）
const entries = () => [
  ...ENV_NAMES.map((name) => ({ name, value: SHIM_PATH })),
  { name: GATE_ENV.name, value: GATE_ENV.value },
];

const apply = () => {
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
  console.log(`\n已注册（${OS === 'win32' ? 'Windows 注册表' : 'macOS LaunchAgent'}）:`);
  for (const { name, value } of list) console.log(`  ${name}=${value}`);
  console.log(`\n${GATE_ENV.name} 是千问办公官方的 BYOK 开关（hasCustomByokEnvOverride），`);
  console.log('只影响「自定义模型」是否可见可选，不改变官方 flash/pro 档位的任何行为。');
  console.log('下一步：pnpm model add --model <claude 模型 id> --api-key placeholder');
  if (OS === 'win32') {
    console.log('重启千问办公即可生效。');
  } else {
    console.log('重启千问办公即可生效（当前会话已即时注入；重启电脑后登录时由 LaunchAgent 自动恢复）。');
  }
};

const unapply = () => {
  let removed = 0;
  const list = entries();
  if (OS === 'win32') {
    for (const { name } of list) {
      if (getCurrentValue(name)) {
        delEnv(name);
        removed++;
      }
    }
  } else {
    if (macDeletePlist()) removed++;
    for (const { name } of list) {
      if (macGetEnvValue(name)) {
        macUnsetEnvNow(name);
        removed++;
      }
    }
  }
  if (removed === 0) {
    console.log('未注册，无需撤销。');
    return;
  }
  broadcastChange();
  console.log(`已撤销 ${removed} 项注册，重启千问办公恢复原引擎。`);
};

const cmd = process.argv[2];
if (cmd === 'apply') apply();
else if (cmd === 'unapply') unapply();
else {
  console.log('用法:');
  console.log('  pnpm apply    注册 QODER_CLI_PATH + QODERCLI_PATH → 千问办公走 Claude Code');
  console.log('  pnpm unapply  撤销两个变量 → 恢复原引擎');
  console.log(`\n当前平台: ${OS}（${OS === 'win32' ? 'Windows 注册表' : 'macOS LaunchAgent'}）`);
}
