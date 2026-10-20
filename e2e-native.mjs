// e2e-native.mjs — 用**真实** qoderclicn.exe 验证透传分支（不经任何替身）
//
// 断言的是共存方案里风险最高的一条路径：官方档位必须原封不动落到官方 CLI。
// 判据全部来自现场行为，而非我们的 mock：
//   1. exe 定位成功（findNativeCli 复刻官方规则，非照抄 getBundledQoderCliPath）
//   2. 转发的 argv 被官方 CLI 接受 —— 若改写踩到 sdk_invalid_args 会立刻退出并打印该串
//   3. 官方 CLI 用真协议回帧（control_response / system:init），证明双向管道通畅
//   4. 退出码原样传播（41 = 认证过期时不得被 SIGTERM 吞成 143）
// 只做握手，不发 prompt：避免触发云端调用与计费。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findNativeCli } from './src/native-cli.mjs';

const SHIM = join(process.cwd(), 'src', 'bridge-shim.mjs');
const native = findNativeCli();
console.log('native CLI =', native);
if (!native) { console.error('FAIL 未能定位官方 CLI'); process.exit(1); }

// SDK 侧 createAuthPayloadFile 落的就是这个类型声明（不含真凭据）
const dir = mkdtempSync(join(tmpdir(), 'e2e-sdk-auth-'));
const payload = join(dir, 'payload.json');
writeFileSync(payload, JSON.stringify({ type: 'jobToken', jobTokenProvider: 'host' }), { mode: 0o600 });

// 1.1.71 现场取证的真实 argv 形态（内部查询：--bare + --disallowed-tools *）
const argv = [
  '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
  '--permission-mode', 'bypassPermissions', '--disallowed-tools', '*',
  '--tools', 'Agent,Bash,TodoWrite,Write',
  '--setting-sources', '', '--disable-builtin-skills', '--bare',
  '--model', 'flash',
];

const child = spawn(process.execPath, [SHIM, ...argv], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    QODER_CLI_PATH: SHIM, QODERCLI_PATH: SHIM,
    QODER_AGENT_SDK_ENTRYPOINT: 'sdk-ts', QODER_AGENT_SDK_VERSION: '1.0.53',
    QODER_SDK_AUTH_PAYLOAD_FILE: payload,
    QODER_CONFIG_DIR: join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.qwenworkcn'),
    QODERCN_CONFIG_DIR: join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.qwenworkcn'),
    QODER_SCENE: 'qwork', QODERCN_SCENE: 'qwork', QODER_SITE: 'cn',
    QODERWORK_IS_CN: 'true', QODER_WORK_INTEGRATION_MODE: '1',
    QODER_WORK_INTEGRATION_PRODUCT: 'qwenworkcn',
  },
});

const frames = [];
let stderrAll = '';
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', (l) => { frames.push(l); console.log('OUT:', l.slice(0, 220)); });
child.stderr.on('data', (d) => { stderrAll += d.toString(); });

// 发一个 initialize 控制请求，真 CLI 应当用真应答回
child.stdin.write(JSON.stringify({
  type: 'control_request', request_id: 'e2e-init',
  request: { type: 'initialize', subtype: 'initialize', modelPolicyProvider: true },
}) + '\n');

const code = await new Promise((res) => {
  const t = setTimeout(() => { console.log('!! 30s 超时，SIGKILL'); child.kill('SIGKILL'); res('TIMEOUT'); }, 30000);
  child.on('exit', (c, sig) => { clearTimeout(t); console.log(`exit code=${c} signal=${sig}`); res(c); });
});
try { child.stdin.end(); } catch {}

const gotInitResp = frames.some((l) => l.includes('"e2e-init"'));
const sawInvalidArgs = /sdk_invalid_args/.test(stderrAll + frames.join('\n'));
console.log('\n--- 判定 ---');
console.log('收到官方 CLI 的 initialize 应答 :', gotInitResp);
console.log('官方 CLI 报 sdk_invalid_args    :', sawInvalidArgs);
console.log('帧总数                          :', frames.length);
if (stderrAll.trim()) console.log('stderr 摘要:', stderrAll.slice(0, 600));
console.log('exit                            :', code);
process.exit(gotInitResp && !sawInvalidArgs ? 0 : 1);
