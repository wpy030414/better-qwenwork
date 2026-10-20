// e2e-diff.mjs — 差分证明：经 shim 透传的输出 == 直连官方 CLI 的输出
//
// 这是共存方案最硬的验收判据：官方档位的行为必须与「没装我们」时逐字节一致。
// 用真实 qoderclicn.exe（216MB，非替身），对比两条路径：
//   A. 直连 exe（不设 QODER_CLI_PATH，即官方原生行为）
//   B. 经 shim 透传（设 QODER_CLI_PATH 指向 shim，shim 再原样转发给同一个 exe）
// 断言 B 的应答帧与 A 同构（剔除 pid 等进程自身字段后逐字节相等）——
// 若 shim 在任何一处改写 argv 或帧，这里必然暴露。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';

const SHIM = join(process.cwd(), 'src', 'bridge-shim.mjs');
const EXE = 'C:\\Program Files\\QwenWorkCN\\1.3.2-26101704\\resources\\bin\\qoderclicn.exe';
const CFG = join(homedir(), '.qwenworkcn');

// 认证载荷：**每一侧各自一份**。官方 CLI 在 transport close 时会删除该文件
// （.analysis/probe-authpayload.mjs 实测：run 后 payload 存在 = false），
// 两侧共用一份会让 B 必然拿到不存在的路径 → job_token_unavailable → 41，
// 那是测试构造缺陷而不是 shim 缺陷。真机场景每次 spawn 都由 SDK 新建
// %TEMP%\qoder-sdk-auth-XXXX\payload.json，天然不冲突。
function freshPayload() {
  const d = mkdtempSync(join(tmpdir(), 'e2e-sdk-auth-'));
  const p = join(d, 'payload.json');
  writeFileSync(p, JSON.stringify({ type: 'jobToken', jobTokenProvider: 'host' }), { mode: 0o600 });
  return p;
}

const argv = [
  '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
  '--permission-mode', 'bypassPermissions', '--disallowed-tools', '*',
  '--tools', 'Agent,Bash,TodoWrite,Write', '--bare', '--model', 'flash',
];

const baseEnv = {
  ...process.env,
  QODER_AGENT_SDK_ENTRYPOINT: 'sdk-ts',
  QODER_AGENT_SDK_VERSION: '1.0.53',
  QODER_SITE: 'cn', QODERWORK_IS_CN: 'true',
  QODER_SCENE: 'qwork', QODERCN_SCENE: 'qwork',
  QODER_CONFIG_DIR: CFG, QODERCN_CONFIG_DIR: CFG,
  QODER_WORK_INTEGRATION_MODE: '1', QODER_WORK_INTEGRATION_PRODUCT: 'qwenworkcn',
};

function run(cmd, args, env, killMs = 12000) {
  return new Promise((res) => {
    const c = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    const frames = [];
    let stderrAll = '';
    const rl = createInterface({ input: c.stdout, crlfDelay: Infinity });
    rl.on('line', (l) => frames.push(l));
    c.stderr.on('data', (d) => { stderrAll += d.toString(); });
    let exited = false;
    c.on('exit', (code, sig) => { exited = true; res({ frames, stderrAll, code, sig }); });
    c.stdin.write(JSON.stringify({
      type: 'control_request', request_id: 'diff-init',
      request: { type: 'initialize', subtype: 'initialize', modelPolicyProvider: true },
    }) + '\n');
    setTimeout(() => { if (!exited) { try { c.stdin.end(); } catch {} } }, 3000);
    setTimeout(() => { if (!exited) { try { c.kill('SIGKILL'); } catch {} } }, killMs);
  });
}

const A = await run(EXE, argv, { ...baseEnv, QODER_SDK_AUTH_PAYLOAD_FILE: freshPayload() });
const B = await run(process.execPath, [SHIM, ...argv], {
  ...baseEnv,
  QODER_SDK_AUTH_PAYLOAD_FILE: freshPayload(),   // 独立一份：shim 只删劫持变量，会原样保留此变量
  QODER_CLI_PATH: SHIM, QODERCLI_PATH: SHIM,
});

const firstInit = (r) => {
  for (const l of r.frames) {
    if (!l.includes('diff-init')) continue;
    try { return JSON.parse(l); } catch {}
  }
  return null;
};
// 剔除只属于「本进程自身」的字段：pid 必然不同，不代表行为差异
const normalize = (m) => {
  if (!m) return null;
  const c = structuredClone(m);
  if (c.response?.response && typeof c.response.response === 'object') {
    delete c.response.response.pid;
  }
  return JSON.stringify(c);
};

// 归一化整条帧流：剔除只属于本进程/本次时序的字段（pid、随机 id、耗时、token 计数）
// 真 CLI 一旦跑完整回合，duration_ms/usage 必然两次不同；共存不变式要证的是
// 「协议结构与语义一致」，不是「耗时一致」。
const VOLATILE = ['pid', 'session_id', 'request_id', 'uuid', 'duration_ms', 'duration_api_ms',
                  'total_cost_usd', 'total_credits', 'timestamp', 'ts', 'result'];
const scrub = (o) => {
  if (Array.isArray(o)) return o.map(scrub);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (VOLATILE.includes(k)) { out[k] = '<X>'; continue; }
      if (k === 'usage' || k === 'modelUsage') { out[k] = '<X>'; continue; }
      out[k] = scrub(v);
    }
    return out;
  }
  return o;
};
const shape = (r) => r.frames.map((l) => {
  try {
    const o = JSON.parse(l);
    return `${o.type}/${o.subtype ?? o.response?.subtype ?? '-'} ${JSON.stringify(scrub(o))}`;
  } catch { return `RAW:${l}`; }
}).join('\n');

const ma = firstInit(A);
const mb = firstInit(B);
const dump = (r, tag) => {
  console.log(`\n===== ${tag} =====`);
  console.log(`exit code=${r.code} signal=${r.sig} frames=${r.frames.length}`);
  r.frames.forEach((l, i) => console.log(`  frame[${i}]: ${l.slice(0, 300)}`));
  if (r.stderrAll.trim()) console.log(`  stderr: ${r.stderrAll.slice(0, 400)}`);
};
dump(A, 'A 直连官方 CLI');
dump(B, 'B 经 shim 透传');

const sameShape = shape(A) === shape(B);
const sameCode = A.code === B.code;
console.log('\n--- 判定 ---');
console.log('协议帧序列一致（含 scrub 后载荷）:', sameShape);
console.log('退出码一致                       :', sameCode, `A=${A.code} B=${B.code}`);
console.log('无 sdk_invalid_args              :', !/sdk_invalid_args/.test(A.stderrAll + B.stderrAll + A.frames.join('') + B.frames.join('')));
console.log('无 job_token_unavailable 差异     :',
  /job_token_unavailable/.test(A.frames.join('') + A.stderrAll) === /job_token_unavailable/.test(B.frames.join('') + B.stderrAll));
// 共存不变式的硬判据 = 装了 shim 之后的行为与没装时完全一致
process.exit(sameShape && sameCode ? 0 : 1);
