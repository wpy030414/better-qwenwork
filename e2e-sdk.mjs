// e2e-sdk.mjs — 用**真实厂商 SDK** 驱动 shim，验证共存契约（不打云端、不耗额度）
//
// 为什么这一层重要：前面的用例用手写帧模拟宿主，帧形状是我按取证推断的；
// 这里换成 @qoder-ai/qoder-agent-sdk 1.0.53 本体当宿主，
// 于是「get_model_policy 探测帧能否被 SDK 认下」「SDK 的 resolveModel 应答能否被 shim 正确判读」
// 「claude 侧事件能否经 SDK 解析成合法消息」这三件事都是真协议验证。
//
// claude 侧用 mock-claude 替身（QODER_BRIDGE_CLAUDE），避免真实调用与计费。
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadVendorSdk } from './vendor-sdk.mjs';

const ROOT = process.cwd();
const SHIM = join(ROOT, 'src', 'bridge-shim.mjs');
const MOCK_CLAUDE = join(ROOT, 'src', 'mock-claude.mjs');
const CFG = join(homedir(), '.qwenworkcn');

// 厂商 SDK 由 vendor-sdk.mjs 暂存到仓库内（其裸依赖只在我们 node_modules 里），可重建
const { query, jobToken } = await loadVendorSdk(ROOT);

let pass = 0, fail = 0;
const ok = (c, name) => { console.log(`${c ? 'PASS' : 'FAIL'} ${name}`); c ? pass++ : fail++; };

// 官方 CLI 定位（透传兜底用真 exe；本用例走桥接，不用它）
let nativeExe = null;
try {
  nativeExe = execSync('node -e "import(\'./src/native-cli.mjs\').then(m=>console.log(m.findNativeCli()||\'\'))"', {
    cwd: ROOT, encoding: 'utf8',
  }).trim() || null;
} catch {}
console.log('native CLI =', nativeExe);

const authDir = mkdtempSync(join(tmpdir(), 'sdk-e2e-auth-'));
const payloadFile = join(authDir, 'payload.json');
writeFileSync(payloadFile, JSON.stringify({ type: 'jobToken', jobTokenProvider: 'host' }), { mode: 0o600 });

// SDK 的 jobToken：真机由 App 的 AuthManagerV2 现场发 token；这里给一个够用的假凭据，
// 桥接分支不会用到它（claude 用主人自己的登录态）
const auth = jobToken(async () => ({ token: 'e2e-dummy-token', expiresAt: Date.now() + 3600000 }));

// 宿主侧 resolveModel：返回 App 对 BYOK 档位实际构造的描述符形状
// {model:{provider, api_key, model, url?, style}} —— provider 即路由哨兵
let resolveModelCalls = [];
const resolveModel = async (ctx) => {
  resolveModelCalls.push(ctx);
  return {
    model: { provider: 'claude-bridge', api_key: 'placeholder', model: 'opus', style: 'anthropic' },
  };
};

async function* promptStream() {
  yield {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'E2E：只回一句话，不要调用工具' }] },
    parent_tool_use_id: null,
    session_id: '',
  };
  // 保持输入流打开一小段时间，模拟 SDK 的常驻会话
  await new Promise((r) => setTimeout(r, 2500));
}

const q = query({
  prompt: promptStream(),
  options: {
    cwd: ROOT,
    pathToQoderCLIExecutable: SHIM,
    auth,
    resolveModel,
    resolveModelTimeoutMs: 5000,
    modelPolicyProvider: true,
    permissionMode: 'bypassPermissions',
    maxTurns: 1,
    env: {
      ...process.env,
      QODER_CLI_PATH: SHIM,
      QODERCLI_PATH: SHIM,
      QODER_AGENT_SDK_ENTRYPOINT: 'sdk-ts',
      QODER_AGENT_SDK_VERSION: '1.0.53',
      QODER_SDK_AUTH_PAYLOAD_FILE: payloadFile,
      QODER_SITE: 'cn', QODERWORK_IS_CN: 'true',
      QODER_SCENE: 'qwork', QODERCN_SCENE: 'qwork',
      QODER_CONFIG_DIR: CFG, QODERCN_CONFIG_DIR: CFG,
      // 桥接分支用 mock-claude；原生 CLI 仍指向真实 exe（若路由误判为透传会暴露出来）
      QODER_BRIDGE_CLAUDE: MOCK_CLAUDE,
      QODER_BRIDGE_QODERCLI: nativeExe ?? '',
      QODER_BRIDGE_PROBE_TIMEOUT_MS: '8000',
    },
    controlRequestTimeoutMs: 15000,
    stderr: () => {},
  },
});

const seen = { init: null, result: null, messages: 0, errors: [] };
try {
  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') seen.init = msg;
    else if (msg.type === 'assistant') seen.messages++;
    else if (msg.type === 'result') seen.result = msg;
  }
} catch (e) {
  seen.errors.push(String(e?.message ?? e));
}

console.log('\n--- SDK 侧观测 ---');
console.log('resolveModel 被调用次数 :', resolveModelCalls.length);
console.log('resolveModel 入参       :', JSON.stringify(resolveModelCalls[0] ?? null).slice(0, 260));
console.log('init 事件               :', JSON.stringify(seen.init ?? null).slice(0, 300));
console.log('result                  :', JSON.stringify(seen.result ?? null).slice(0, 260));
if (seen.errors.length) console.log('错误                    :', seen.errors.slice(0, 3));

console.log('\n--- 判定 ---');
ok(seen.errors.length === 0, `SDK 未报错（共存链路通畅）`);
ok(resolveModelCalls.length >= 1, 'shim 的 get_model_policy 探测帧被真实 SDK 认下并回调 resolveModel');
ok(!!seen.init, '收到 system:init（说明桥接后的握手通过了 SDK 校验）');
ok(seen.init?.protocol_version === '1.5.0', `protocol_version 合法（got ${seen.init?.protocol_version}）`);
ok(seen.messages > 0, '收到 assistant 消息');
ok(!!seen.result && seen.result.is_error === false, '轮次以非错误 result 收尾');
// 反证：路由必须是桥接（claude），绝不能被误判成透传
ok(seen.result?.result === 'MOCK_DONE' || String(seen.result?.result ?? '').includes('MOCK'),
    '应答来自 claude 桥接（而非官方 CLI 透传）');

console.log(`\n===== 结果: ${fail === 0 ? '全部通过' : fail + ' 项失败'}（共 ${pass + fail} 项）=====`);
process.exit(fail === 0 ? 0 : 1);
