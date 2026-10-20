// e2e-real.mjs — 真机端到端：真实厂商 SDK + 真实 claude + 真实官方 CLI
//
// 覆盖共存方案的两条分支，两侧都用真东西（无替身）：
//   A. Claude 档位（宿主 resolveModel 返回 BYOK 描述符）⇒ shim 改道真实 claude.exe
//   B. 官方档位（带 --model）⇒ shim 原样透传真实 qoderclicn.exe
//
// 输入流必须**保持打开直到 result 到达**：SDK 的 result 是在子进程收尾时才浮出的，
// 用固定时长的异步生成器提前关流会让迭代器先结束（上一版就是这样漏判的）。
// 计费走主人已有的 Claude Code 通道；提示词极短（实测 A 侧成本约 $0.06）。
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { loadVendorSdk } from './vendor-sdk.mjs';

const ROOT = process.cwd();
const SHIM = join(ROOT, 'src', 'bridge-shim.mjs');
const CFG = join(homedir(), '.qwenworkcn');
const LEDGER = join(homedir(), '.qwenwork-bridge', 'ledger.jsonl');
const { query, jobToken } = await loadVendorSdk(ROOT);

let pass = 0, fail = 0;
const ok = (c, name) => { console.log(`${c ? 'PASS' : 'FAIL'} ${name}`); c ? pass++ : fail++; };

const { findNativeCli } = await import(pathToFileURL(join(ROOT, 'src', 'native-cli.mjs')).href);
const nativeExe = findNativeCli();
console.log('官方 CLI =', nativeExe || '(未找到)');

const mkPayload = () => {
  const p = join(mkdtempSync(join(tmpdir(), 'real-e2e-auth-')), 'payload.json');
  writeFileSync(p, JSON.stringify({ type: 'jobToken', jobTokenProvider: 'host' }), { mode: 0o600 });
  return p;
};
const auth = jobToken(async () => ({ token: 'e2e-dummy-token', expiresAt: Date.now() + 3600000 }));
const bridgeEnv = {
  QODER_CLI_PATH: SHIM, QODERCLI_PATH: SHIM,
  QODER_AGENT_SDK_ENTRYPOINT: 'sdk-ts', QODER_AGENT_SDK_VERSION: '1.0.53',
  QODER_SITE: 'cn', QODERWORK_IS_CN: 'true',
  QODER_SCENE: 'qwork', QODERCN_SCENE: 'qwork',
  QODER_CONFIG_DIR: CFG, QODERCN_CONFIG_DIR: CFG,
  QODER_BRIDGE_QODERCLI: nativeExe,
  QODER_BRIDGE_PROBE_TIMEOUT_MS: '10000',
};

// 可控输入流：投递一条 user 后挂住 stdin，直到调用 end()
// （闭包捕获 msg，不依赖 generator 内的 this 绑定）
function makeInput(msg) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const iter = async function* () {
    yield msg;
    await gate;   // 保持 stdin 打开（宿主常驻会话的真实形态）
  };
  return { end: () => release(), [Symbol.asyncIterator]: iter };
}

const ledgerSize = () => (existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').trim().split('\n').length : 0);

// ---------- A. Claude 档位 ⇒ 改道真实 claude ----------
{
  const input = makeInput({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '只回复四个字：共存成功。不要调用工具。' }] },
    parent_tool_use_id: null, session_id: '',
  });
  const before = ledgerSize();
  const q = query({
    prompt: input,
    options: {
      cwd: ROOT, pathToQoderCLIExecutable: SHIM, auth,
      resolveModel: async () => ({ model: { provider: 'claude-bridge', api_key: 'placeholder', model: 'opus', style: 'anthropic' } }),
      resolveModelTimeoutMs: 5000, modelPolicyProvider: true,
      permissionMode: 'bypassPermissions', maxTurns: 1,
      env: { ...process.env, ...bridgeEnv, QODER_SDK_AUTH_PAYLOAD_FILE: mkPayload() },
      controlRequestTimeoutMs: 20000, stderr: () => {},
    },
  });
  let init = null, result = null, texts = [];
  const guard = setTimeout(() => { console.log('!! A 侧 90s 超时'); input.end(); }, 90000);
  guard.unref?.();
  // SDK 把 result 扣到 CLI 进程退出才浮出（其内部 resultMessage / pendingErrorResultExit），
  // 而 claude 在 stream-json 输入模式下会一直等下一条消息 —— 所以必须像真宿主那样
  // 走关闭序列：本轮收到文本后结束输入流，SDK 的 closeGraceMs → endInput 才会收尾。
  let closeTimer = null;
  try {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') init = m;
      else if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) if (b.type === 'text') texts.push(b.text);
        closeTimer ??= setTimeout(() => input.end(), 1500);
        closeTimer.unref?.();
      } else if (m.type === 'result') { result = m; input.end(); }
    }
  } catch (e) { console.log('SDK 抛错:', String(e?.message ?? e).slice(0, 200)); }
  clearTimeout(guard);
  const ledgerLines = ledgerSize() - before;
  console.log('\n--- A. Claude 档位（真 claude.exe）---');
  console.log('init.model :', init?.model, '| tools:', (init?.tools ?? []).length);
  console.log('回复文本   :', texts.join('').trim().slice(0, 60));
  console.log('result     :', JSON.stringify(result ?? null).slice(0, 200));
  console.log('新增台账   :', ledgerLines, '条');
  ok(!!init && init.protocol_version === '1.5.0', '真 claude 握手经 shim 通过 SDK 校验');
  ok(!!result && result.is_error === false, '真 claude 轮次以非错误 result 收尾');
  ok(texts.join('').includes('共存成功'), '回复内容正确抵达宿主');
  ok(ledgerLines >= 1, '成本台账入账（result 事件被 shim 记账）');
}

// ---------- B. 官方档位 ⇒ 原样透传真官方 CLI ----------
{
  const input = makeInput({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null, session_id: '' });
  const q = query({
    prompt: input,
    options: {
      cwd: ROOT, pathToQoderCLIExecutable: SHIM, auth,
      model: 'flash',   // 官方档位 ⇒ App 会下发 --model ⇒ shim 免探测透传
      resolveModel: async () => ({ model: 'flash' }),
      resolveModelTimeoutMs: 5000, modelPolicyProvider: true,
      permissionMode: 'bypassPermissions', maxTurns: 1,
      env: { ...process.env, ...bridgeEnv, QODER_SDK_AUTH_PAYLOAD_FILE: mkPayload() },
      controlRequestTimeoutMs: 20000, stderr: () => {},
    },
  });
  let init = null, result = null;
  const guard = setTimeout(() => { console.log('!! B 侧 60s 超时'); input.end(); }, 60000);
  guard.unref?.();
  try {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') init = m;
      else if (m.type === 'result') { result = m; input.end(); }
    }
  } catch (e) { console.log('SDK 抛错(B):', String(e?.message ?? e).slice(0, 200)); }
  clearTimeout(guard);
  const blob = JSON.stringify(result ?? init ?? '');
  console.log('\n--- B. 官方档位（真 qoderclicn.exe 透传）---');
  console.log('result:', blob.slice(0, 300));
  // 本 harness 的 jobToken 是占位值，官方云端必然拒权——这恰好证明**是官方 CLI 在回话**：
  // shim 的合成兜底永远不会产生 usage/num_turns 这种官方 result 形态，也不会报认证失败。
  ok(/num_turns|usage|stop_reason/.test(blob), '应答形态为官方 CLI 原生 result（非 shim 兜底）');
  ok(!/Unsupported control request subtype/.test(blob), '未出现 shim 兜底特征串');
  ok(/auth|token|unauthorized|401|forbidden/i.test(blob) || !!init,
     '官方链路按其自身规则处理凭据（本 harness 用占位 token，故预期鉴权失败）');
}

console.log(`\n===== 结果: ${fail === 0 ? '全部通过' : fail + ' 项失败'}（共 ${pass + fail} 项）=====`);
process.exit(fail === 0 ? 0 : 1);
