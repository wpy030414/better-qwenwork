// bridge-shim.test.mjs — v3 共存契约的密闭测试（不消耗任何 API 额度）
// 运行：node src/bridge-shim.test.mjs
//
// v3 与 v2 的契约差异，本套用例逐条覆盖：
//   1. 默认分支 = **原样透传官方 CLI**：argv 一字不改、宿主帧一字不改、env 抹掉劫持变量、退出码原样传播
//   2. 只有 get_model_policy 应答里 custom_model.provider == 哨兵时，才改道 claude
//   3. --bare 内部查询不再自答（v2 在这里吃掉官方真实结果，是纯负收益）
//   4. TodoWrite 不再被丢弃（qoderclicn 1.1.71 仍叫 TodoWrite）
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, 'bridge-shim.mjs');
const MOCK_CLAUDE = join(HERE, 'mock-claude.mjs');
const MOCK_NATIVE = join(HERE, 'mock-native.mjs');

let failures = 0;
const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1.1.71 真实下发的内部查询 argv（现场取证原文，见 researches 报告 §2.1）
const INTERNAL_ARGV = [
  '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
  '--proxy', 'http://127.0.0.1:7897', '--permission-mode', 'bypassPermissions',
  '--disallowed-tools', '*',
  '--tools', 'Agent,AskUserQuestion,Bash,Edit,Glob,Grep,ImageGen,ImageSearch,NotebookEdit,Read,Skill,TodoWrite,UpdateGoal,WebFetch,WebSearch,Write',
  '--setting-sources', '', '--disable-builtin-skills', '--bare',
];
// 官方档位主对话 argv 特征：带 --model（App 对 BYOK 显式不下发）
const OFFICIAL_ARGV = [
  '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
  '--model', 'flash', '--session-id', 'aaaaaaaa-1111-2222-3333-444455556666',
  '--permission-mode', 'bypassPermissions',
  '--tools', 'Agent,Bash,TodoWrite,Write',
];
// Claude（BYOK）档位主对话 argv 特征：**无 --model**，需要探测才能定路由
const CLAUDE_ARGV_BASE = [
  '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
  '--session-id', 'bbbbbbbb-1111-2222-3333-444455556666',
  '--permission-mode', 'bypassPermissions', '--permission-prompt-tool', 'stdio',
];
const CLAUDE_ARGV = [...CLAUDE_ARGV_BASE, '--tools', 'Agent,Bash,TodoWrite,Write'];

// 起 shim，返回可读帧队列 + 收集到的原始 stdout 行
function startShim(argv, opts = {}) {
  const env = {
    ...process.env,
    QODER_BRIDGE_QODERCLI: opts.native ?? MOCK_NATIVE,
    QODER_BRIDGE_CLAUDE: opts.claude ?? MOCK_CLAUDE,
    QODER_BRIDGE_PROBE_TIMEOUT_MS: String(opts.probeTimeoutMs ?? 1500),
    QODER_AGENT_SDK_ENTRYPOINT: 'sdk-ts',
    QODER_AGENT_SDK_VERSION: '1.0.53',
    // 现场取证里这两个变量必然存在（正是它们把查询劫持到 shim）
    QODER_CLI_PATH: SHIM,
    QODERCLI_PATH: SHIM,
    ...opts.extraEnv,
  };
  // 密封性：QODER_BRIDGE_MODEL 会被 pnpm apply --claude-model 注册进注册表，
  // 一旦泄漏进测试进程，FORCE_MODEL 分支会往 claudeArgs 里加 --model，
  // 让「非法模型名被丢弃」这类断言假性通过或假性失败。需要它的用例自己经 extraEnv 给。
  if (opts.forceModel === undefined) delete env.QODER_BRIDGE_MODEL;
  else env.QODER_BRIDGE_MODEL = opts.forceModel;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const c = spawn(process.execPath, [SHIM, ...argv], {
    cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'], env,
  });
  const out = { child: c, lines: [], waiters: [] };
  const rl = createInterface({ input: c.stdout, crlfDelay: Infinity });
  rl.on('line', (l) => {
    out.lines.push(l);
    for (const w of out.waiters.splice(0)) w();
  });
  c.stderr.resume();
  out.next = async (pred, ms = 4000) => {
    const seen = new Set();
    const deadline = Date.now() + ms;
    for (;;) {
      for (let i = 0; i < out.lines.length; i++) {
        if (seen.has(i)) continue;
        seen.add(i);
        let m; try { m = JSON.parse(out.lines[i]); } catch { continue; }
        if (pred(m)) return m;
      }
      if (Date.now() > deadline) return null;
      await new Promise((r) => { out.waiters.push(r); setTimeout(r, Math.min(120, deadline - Date.now())); });
    }
  };
  out.exitCode = () => new Promise((res) => c.on('exit', (code) => res(code)));
  // 收尾：先关 stdin（shim 会把它转成子进程 EOF → 子进程退出 → shim 退出），再等退出码。
  // 顺序反了就是死锁；带超时兜底，挂死时暴露为可诊断的 TIMEOUT 而不是拖住整套。
  out.finish = async (ms = 8000) => {
    const exited = new Promise((res) => c.on('exit', (code) => res(code)));
    try { c.stdin.end(); } catch {}
    const winner = await Promise.race([exited, sleep(ms).then(() => 'TIMEOUT')]);
    if (winner === 'TIMEOUT') { try { c.kill('SIGKILL'); } catch {} }
    return winner;
  };
  return out;
}

const readMarker = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const ctrlReq = (id, request) => JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n';
const ctrlResp = (id, response) => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response } }) + '\n';
const userMsg = (sid, text) => JSON.stringify({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';

// ---------- T1 内部查询：必须透传，且 argv 零改写 ----------
async function t1_internal_passthrough() {
  console.log('\n===== 1. 内部查询(--bare) → 透传官方 CLI，argv 零改写 =====');
  const marker = join(tmpdir(), `mock-native-${Date.now()}-t1.json`);
  const s = startShim(INTERNAL_ARGV, { extraEnv: { MOCK_NATIVE_MARKER: marker } });
  const code = await s.finish();
  const rec = readMarker(marker) ?? {};
  ok(code === 0, `exit 0（got ${code}）`);
  ok(rec.argv && JSON.stringify(rec.argv) === JSON.stringify(INTERNAL_ARGV),
    'argv 与 SDK 下发完全一致（含 --bare / --disallowed-tools * / --setting-sources ""）');
  ok(rec.env?.QODER_CLI_PATH === null && rec.env?.QODERCLI_PATH === null,
    '透传前删除 QODER_CLI_PATH + QODERCLI_PATH（防递归）');
  ok(rec.env?.QODER_AGENT_SDK_ENTRYPOINT === 'sdk-ts' && rec.env?.QODER_SDK_AUTH_PAYLOAD_FILE !== undefined,
    '保留 QODER_AGENT_SDK_*（否则官方 CLI 报 sdk_invalid_args）');
  s.child.stdin.end();
  rmSync(marker, { force: true });
}

// ---------- T2 官方档位：带 --model ⇒ 免探测直接透传 ----------
async function t2_official_by_model() {
  console.log('\n===== 2. 官方档位(--model flash) → 免探测透传 =====');
  const marker = join(tmpdir(), `mock-native-${Date.now()}-t2.json`);
  const s = startShim(OFFICIAL_ARGV, { extraEnv: { MOCK_NATIVE_MARKER: marker } });
  // 关键：不得向宿主发 get_model_policy 探测（带 --model 已是充分判据，探测纯属多余往返）
  const probe = await s.next((m) => m.type === 'control_request' && (m.request?.subtype ?? m.request?.type) === 'get_model_policy', 800);
  ok(probe === null, '未发出 get_model_policy 探测');
  s.child.stdin.write(ctrlReq('h-init', { type: 'initialize', subtype: 'initialize' }));
  const reply = await s.next((m) => m.type === 'control_response' && m.response?.request_id === 'h-init');
  ok(reply !== null, '宿主 initialize 请求被转发给官方 CLI 并得到应答');
  const rec = readMarker(marker) ?? {};
  ok((rec.frames ?? []).some((l) => l.includes('"h-init"')), '官方 CLI 确实收到了该帧');
  ok(rec.argv?.includes('flash'), '官方 CLI 收到 --model flash（档位信息未丢）');
  s.child.stdin.end();
  rmSync(marker, { force: true });
}

// ---------- T3 Claude 档位：探测命中哨兵 ⇒ 改道 claude ----------
async function t3_claude_by_probe() {
  console.log('\n===== 3. Claude 档位 → 探测 custom_model.provider ⇒ 改道 claude =====');
  const s = startShim(CLAUDE_ARGV);
  const probe = await s.next((m) => m.type === 'control_request' && (m.request?.subtype ?? m.request?.type) === 'get_model_policy');
  ok(probe !== null, '无 --model 时发出 get_model_policy 探测');
  ok(typeof probe?.request_id === 'string' && probe.request_id.startsWith('bridge-policy-'),
    `探测帧带 request_id（got ${probe?.request_id}）`);

  // 宿主（本测试）应答：BYOK 档位的 provider 是我们写入的哨兵
  s.child.stdin.write(ctrlResp(probe.request_id, { model: 'claude-opus-4-5', custom_model: { provider: 'claude-bridge', model: 'claude-opus-4-5', style: 'anthropic' } }));
  // 探测期间到达的宿主帧必须一帧不丢地补喂给 claude
  s.child.stdin.write(ctrlReq('c-init', { type: 'initialize', subtype: 'initialize', systemPrompt: '你是千问办公的 mock 引导。' }));
  s.child.stdin.write(userMsg('bbbbbbbb-1111-2222-3333-444455556666', '请开始'));

  const initResp = await s.next((m) => m.type === 'control_response' && m.response?.request_id === 'c-init');
  ok(initResp?.response?.subtype === 'success', 'initialize 得到 success 应答（改道 claude 生效）');
  ok(Array.isArray(initResp?.response?.response?.capabilities) && initResp.response.response.capabilities.length >= 5,
    'claude 应答被合并注入 capabilities');
  const sysInit = await s.next((m) => m.type === 'system' && m.subtype === 'init');
  ok(sysInit?.protocol_version === '1.5.0', `init 事件 protocol_version 归一（got ${sysInit?.protocol_version}）`);
  ok(Array.isArray(sysInit?.tools) && sysInit.tools.includes('Agent') && !sysInit.tools.includes('Task'),
    `init tools Task→Agent 映射（got ${JSON.stringify(sysInit?.tools)}）`);
  const canUse = await s.next((m) => m.type === 'control_request' && m.request?.subtype === 'can_use_tool');
  ok(canUse?.request?.tool_name === 'Write', 'can_use_tool 上行到宿主（权限弹窗可用）');
  s.child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: canUse.request_id, response: { behavior: 'allow', updatedInput: canUse.request.input } } }) + '\n');
  const result = await s.next((m) => m.type === 'result');
  ok(result?.result === 'MOCK_DONE' && result?.is_error === false, 'claude 轮次跑通');
  s.child.stdin.end();
  await s.exitCode();
}

// ---------- T4 官方档位但无 --model：探测应答非哨兵 ⇒ 透传 ----------
async function t4_official_by_probe() {
  console.log('\n===== 4. 无 --model 但宿主答官方 provider → 透传（不误劫持官方）=====');
  const marker = join(tmpdir(), `mock-native-${Date.now()}-t4.json`);
  const s = startShim(CLAUDE_ARGV, { extraEnv: { MOCK_NATIVE_MARKER: marker } });
  const probe = await s.next((m) => m.type === 'control_request' && (m.request?.subtype ?? m.request?.type) === 'get_model_policy');
  ok(probe !== null, '发出探测');
  s.child.stdin.write(ctrlResp(probe.request_id, { model: 'flash', custom_model: { provider: 'qwenwork', model: 'flash', style: 'openai' } }));
  s.child.stdin.write(ctrlReq('h2', { type: 'initialize', subtype: 'initialize' }));
  const reply = await s.next((m) => m.type === 'control_response' && m.response?.request_id === 'h2');
  ok(reply !== null, 'initialize 由官方 CLI 应答（非 shim 合成）');
  ok(reply?.response?.response?.mocked === true, '应答来自替身官方 CLI（shim 未合成）');
  const rec = readMarker(marker) ?? {};
  ok((rec.frames ?? []).some((l) => l.includes('"h2"')), '宿主帧抵达官方 CLI');
  // 我们自己的探测帧绝不能污染透传流
  ok(!(rec.frames ?? []).some((l) => l.includes('get_model_policy')), '探测帧未被转发给官方 CLI');
  s.child.stdin.end();
  rmSync(marker, { force: true });
}

// ---------- T5 探测超时 ⇒ 保守透传（保住官方链路）----------
async function t5_probe_timeout() {
  console.log('\n===== 5. 宿主不应答探测 → 超时后保守透传 =====');
  const marker = join(tmpdir(), `mock-native-${Date.now()}-t5.json`);
  const s = startShim(CLAUDE_ARGV, { probeTimeoutMs: 400, extraEnv: { MOCK_NATIVE_MARKER: marker } });
  const code = await s.finish();
  const rec = readMarker(marker) ?? {};
  ok(code === 0, `exit 0（got ${code}）`);
  ok(rec.argv !== null, '超时后确实 spawn 了官方 CLI');
  ok(JSON.stringify(rec.argv) === JSON.stringify(CLAUDE_ARGV), '超时透传仍保持 argv 零改写');
  rmSync(marker, { force: true });
}

// ---------- T6 退出码 41（认证过期）原样传播 ----------
async function t6_exit_41() {
  console.log('\n===== 6. 官方 CLI 退出码 41 → 原样传播（认证过期是协议不是错误）=====');
  const marker = join(tmpdir(), `mock-native-${Date.now()}-t6.json`);
  const s = startShim(OFFICIAL_ARGV, { extraEnv: { MOCK_NATIVE_MARKER: marker, MOCK_NATIVE_EXIT: '41' } });
  s.child.stdin.write(userMsg('aaaaaaaa-1111-2222-3333-444455556666', 'hi'));
  const code = await s.exitCode();
  ok(code === 41, `shim exit=41（got ${code}）`);
  s.child.stdin.end();
  rmSync(marker, { force: true });
}

// ---------- T7 无原生 CLI ⇒ 全量桥接（v2 兼容路径）+ 翻译修正回归 ----------
async function t7_bridge_when_no_native() {
  console.log('\n===== 7. 无原生 CLI → 退回全量桥接；翻译回归（TodoWrite 保留 / --bare 丢弃 / --tools 去重）=====');
  const workdir = mkdtempSync(join(tmpdir(), 'bridge-wd-'));
  // 显式拼装（不复用 CLAUDE_ARGV）：本用例要单独断言 --permission-mode 的翻译，
  // 若与 base 里的同名旗标重复，parseArgs 的 first() 会取前者，断言就失真
  const s = startShim([
    '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--session-id', 'bbbbbbbb-1111-2222-3333-444455556666',
    '--permission-prompt-tool', 'stdio',
    '--tools', 'Agent,TaskCreate,Bash,TodoWrite,Write,UpdateGoal,ImageGen',
    '--workdir', workdir, '--proxy', 'http://proxy.test:3128',
    '--yolo', '--max-turns', '2', '--setting-sources', '', '--bare',
    '--allowed-tools', 'Skill', '--disallowed-tools', 'Bash(rm -rf *)',
    '--permission-mode', 'accept_edits',
    '--mcp-config', '{"mcpServers":{"qw-builtin":{"type":"http","url":"http://127.0.0.1:54365/x"}}}',
    '--settings', '{"permissions":{"allow":["Bash(echo *)"]},"aiCodeStatistics":true}',
  ], { native: '', claude: MOCK_CLAUDE });

  s.child.stdin.write(ctrlReq('b-init', { type: 'initialize', subtype: 'initialize', systemPrompt: 'mock 引导。', promptSuggestions: true }));
  const initResp = await s.next((m) => m.type === 'control_response' && m.response?.request_id === 'b-init');
  ok(initResp?.response?.subtype === 'success', '无原生 CLI 时 initialize 仍由 shim 桥接应答');
  s.child.stdin.write(ctrlReq('b-models', { type: 'get_models', subtype: 'get_models' }));
  const models = await s.next((m) => m.type === 'control_response' && m.response?.request_id === 'b-models');
  ok(models?.response?.subtype === 'success' && JSON.stringify(models.response.response).includes('claude-mock-1'),
    'get_models 由 claude initialize.models 映射（claude 不支持 → shim 兜底）');
  s.child.stdin.write(userMsg('bbbbbbbb-1111-2222-3333-444455556666', '第一轮'));

  const sysInit = await s.next((m) => m.type === 'system' && m.subtype === 'init');
  const a = sysInit?._argv ?? [];
  const has = (f) => a.includes(f);
  const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  const eq = a.filter((x) => String(x).startsWith('--tools='));
  ok(!has('--bare') && !has('--setting-sources') && !has('--model') && !has('--workdir') && !has('--proxy'),
    '炸弹/无意义旗标不喂给 claude（--bare 在桥接路径仍丢弃）');
  ok(eq.length === 1 && eq[0] === '--tools=Task,Bash,TodoWrite,Write',
    `--tools：TodoWrite 保留（1.1.71 仍叫此名）、Agent/TaskCreate 归一为 Task 且去重、UpdateGoal/ImageGen 丢弃（got ${JSON.stringify(eq)})`);
  ok(!has('--yolo') && has('--dangerously-skip-permissions'), '--yolo → --dangerously-skip-permissions');
  ok(val('--max-turns') === '2' && val('--allowed-tools') === 'Skill' && val('--disallowed-tools') === 'Bash(rm -rf *)',
    '--max-turns / --allowed-tools / --disallowed-tools 直传');
  ok(a[a.indexOf('--permission-mode') + 1] === 'acceptEdits', '--permission-mode accept_edits → acceptEdits');
  ok(val('--system-prompt') === 'mock 引导。' && has('--prompt-suggestions'), 'initialize 配置翻译为 CLI 旗标（延迟 spawn）');
  ok(sysInit?._env_HTTPS_PROXY === 'http://proxy.test:3128', '--proxy → HTTPS_PROXY');
  ok(sysInit?._env_ENTRYPOINT === 'qwenwork-bridge', 'CLAUDE_CODE_ENTRYPOINT 标记');
  ok(a.includes('--mcp-config'), '--mcp-config 透传（qw-builtin 网关不丢）');
  const canUse = await s.next((m) => m.type === 'control_request' && m.request?.subtype === 'can_use_tool');
  ok(canUse?.request?.tool_name === 'Write', 'can_use_tool 反向桥接可用');
  s.child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: canUse.request_id, response: { behavior: 'allow', updatedInput: canUse.request.input } } }) + '\n');
  const result = await s.next((m) => m.type === 'result');
  ok(result?.result === 'MOCK_DONE', 'claude 轮次跑通');
  s.child.stdin.end();
  await s.exitCode();
  rmSync(workdir, { recursive: true, force: true });
}

// ---------- T8 非常规模型名守卫（副标题借道 model 列的场景）----------
async function t8_model_name_guard() {
  console.log('\n===== 8. 探测回来非常规模型名（中文文案）→ 丢弃，不毁掉 claude 启动 =====');
  // 必须保留 native：否则走的是「无原生 CLI」直连桥接分支，根本不会探测
  const s = startShim(CLAUDE_ARGV, { claude: MOCK_CLAUDE });
  const probe = await s.next((m) => m.type === 'control_request' && (m.request?.subtype ?? m.request?.type) === 'get_model_policy');
  ok(probe !== null, '发出探测');
  // App 会把 BYOK 的 model 列原样回传；该列可能被用作副标题文案（含中文/空格），
  // 直接喂给 claude 的 --model 会启动失败
  s.child.stdin.write(ctrlResp(probe.request_id, {
    model: '最强模型，世界最强模型',
    custom_model: { provider: 'claude-bridge', model: '最强模型，世界最强模型', style: 'anthropic' },
  }));
  s.child.stdin.write(ctrlReq('g-init', { type: 'initialize', subtype: 'initialize' }));
  s.child.stdin.write(userMsg('bbbbbbbb-1111-2222-3333-444455556666', 'hi'));
  const sysInit = await s.next((m) => m.type === 'system' && m.subtype === 'init');
  ok(!!sysInit, 'claude 仍成功启动（非法模型名未导致启动失败）');
  const a = sysInit?._argv ?? [];
  const mIdx = a.indexOf('--model');
  ok(mIdx < 0, `非法模型名被丢弃，未写入 --model（got ${mIdx < 0 ? '(none)' : a[mIdx + 1]})`);
  // mock-claude 会先发 can_use_tool 等宿主应答；不应答它会走 15s 超时兜底，
  // 超出本用例等待窗口（那是测试时序，不是产品缺陷）
  const canUse = await s.next((m) => m.type === 'control_request' && m.request?.subtype === 'can_use_tool');
  if (canUse) {
    s.child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: canUse.request_id, response: { behavior: 'allow', updatedInput: canUse.request.input } } }) + '\n');
  }
  const result = await s.next((m) => m.type === 'result');
  ok(result?.result === 'MOCK_DONE', '轮次仍跑通');
  await s.finish();
}

for (const t of [t1_internal_passthrough, t2_official_by_model, t3_claude_by_probe, t4_official_by_probe, t5_probe_timeout, t6_exit_41, t7_bridge_when_no_native, t8_model_name_guard]) {
  await t();
}
console.log(`\n===== 结果: ${failures === 0 ? '全部通过' : failures + ' 项失败'} =====`);
process.exit(failures === 0 ? 0 : 1);
