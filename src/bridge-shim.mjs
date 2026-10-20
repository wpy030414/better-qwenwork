#!/usr/bin/env node
// bridge-shim.mjs — 千问办公 ↔ Claude Code 共存桥接层 v3
//
// 被 @qoder-ai/qoder-agent-sdk 的 ProcessTransport 当作 CLI spawn（QODER_CLI_PATH 指向本文件）。
//
// v3 方针（2026-10-20，对照 QwenWorkCN 1.3.2 / SDK 1.0.53 / qoderclicn 1.1.71 取证，
// 见 docs/researches/2026-10-20-*.md）——**默认透传，按需改道**：
//   1. 默认分支 = 「原样转发给官方原生 CLI」：argv 零改写、帧零改写、退出码零改写。
//      v2 在这里自答合成，实测吃掉了官方 --bare 内部查询（意图分类/标题生成/闲置建议）
//      的真实结果且换不来任何 Claude 价值 → 纯负收益，v3 归零。
//   2. 只有确认用户选中的是 Claude 档位，才改道 spawn claude 并做协议翻译。判据：
//        a. argv 带 --model ⇒ 必为官方档位（App 的 buildMainSessionRuntimeExtraArgs
//           对 BYOK 显式不下发 --model）⇒ 直接透传，省一次探测往返；
//        b. 否则向宿主发 get_model_policy 探测帧，读应答里 custom_model.provider 是否
//           等于我们写入 BYOK 条目的哨兵（官方档位的 provider 恒为 catalog 值）；
//        c. 探测超时/异常 ⇒ 保守透传（保住官方链路，Claude 侧降级为官方执行，日志可查）。
//   3. 共存的分工不由本文件承担：App 自身按 execution.harness 逐轮分流——
//      官方 flash/pro 走 ACP 引擎（根本不 spawn CLI），BYOK/Claude 档位被 App 硬编码
//      harness="qoder-cli"，只有它会进入 SDK→CLI 这条被我们劫持的链路。
//
// 结构约束（勿回退）：process.stdin 只允许**一个** readline 消费者（#dispatch 分发器），
// 决策换向靠替换 #sink，绝不二次 createInterface——两次消费会竞争读取消耗掉帧。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform, tmpdir } from 'node:os';
import { findNativeCli, passthroughEnv } from './native-cli.mjs';

// ---------- 配置 ----------
const DEFAULT_CLAUDE_BIN = (() => {
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  }
  for (const p of [
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
    join(homedir(), '.npm-global', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude'),
  ]) {
    if (existsSync(p)) return p;
  }
  return 'claude';
})();
const CLAUDE_BIN = process.env.QODER_BRIDGE_CLAUDE ?? DEFAULT_CLAUDE_BIN;
const FORCE_MODEL = process.env.QODER_BRIDGE_MODEL; // 可选：强制指定 claude 模型（覆盖探测结果）
// SDK 1.0.53 内置 protocol_version=1.5.0；major 必须一致，否则 SDK 拒绝握手
const PROTOCOL_VERSION = '1.5.0';
// BYOK 档位哨兵：由 `pnpm model add` 写进千问办公 byok_custom_models.provider 列。
// App 的 resolveModel 会把它经 get_model_policy 应答的 custom_model.provider 原样回传，
// 这是我们唯一零猜测的路由判据。
const BYOK_MARKER = process.env.QODER_BRIDGE_BYOK_PROVIDER ?? 'claude-bridge';
const PROBE_TIMEOUT_MS = Number(process.env.QODER_BRIDGE_PROBE_TIMEOUT_MS ?? 6000);

const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'logs');
const LEDGER_DIR = join(homedir(), '.qwenwork-bridge');
const LEDGER_FILE = join(LEDGER_DIR, 'ledger.jsonl');
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(LEDGER_DIR, { recursive: true });

const logFile = join(LOG_DIR, `bridge-${process.pid}-${Date.now()}.log`);
const log = (tag, data) => {
  try { appendFileSync(logFile, `${new Date().toISOString()} [${tag}] ${data}\n`); } catch {}
};
// 黑匣子：未捕获异常完整落盘（现场排查用，正常路径不受影响）
process.on('uncaughtException', (e) => {
  try { appendFileSync(logFile, `${new Date().toISOString()} [UNCAUGHT] ${e?.stack ?? String(e)}\n`); } catch {}
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (e) => {
  try { appendFileSync(logFile, `${new Date().toISOString()} [UNHANDLED-REJECTION] ${e?.stack ?? String(e)}\n`); } catch {}
});
const ledger = (entry) => {
  try { appendFileSync(LEDGER_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + '\n'); } catch {}
};

// ---------- 协议常量 ----------
const controlResponse = (requestId, response) =>
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n';

// initialize 应答需注入的 capabilities（claude 原生只报 3 项；SDK 用它做功能门控）
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1', 'session_rewind_v1', 'background_tasks_v1'];

// claude 原生支持的 control_request 子类型（2026-09-24 对 claude 实测）——转发
const FORWARD_NATIVE = new Set([
  'initialize', 'set_permission_mode', 'set_model', 'get_context_usage', 'interrupt',
  'stop_task', 'cancel_async_message', 'background_tasks', 'mcp_set_servers',
  'mcp_toggle', 'mcp_reconnect', 'mcp_authenticate', 'apply_flag_settings', 'seed_read_state',
]);

// claude 工具名 → qoder 工具名（UI 卡片渲染用；renderer 仅特判 Agent）
const TOOL_MAP = { Task: 'Agent' };
// qoder 工具名 → claude 工具名（翻译 app 下发的工具列表/权限规则用）
// qoderclicn 1.1.71 仍叫 TodoWrite（v2 按 1.2.1 建表时把它丢了，实伤见 researches 报告 §三）
const Q2C_TOOL = {
  Agent: 'Task', Task: 'Task', TaskCreate: 'Task', Bash: 'Bash', Edit: 'Edit',
  Glob: 'Glob', Grep: 'Grep', NotebookEdit: 'NotebookEdit', Read: 'Read', Write: 'Write',
  Skill: 'Skill', TodoWrite: 'TodoWrite', WebFetch: 'WebFetch', WebSearch: 'WebSearch',
  AskUserQuestion: 'AskUserQuestion',
};
// claude 已知工具集合（映射后仍不认识的名字丢弃，避免 --tools 传未知名报错）
const CLAUDE_TOOLS = new Set([
  'Task', 'TodoWrite', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit',
  'EnterWorktree', 'ExitWorktree', 'Glob', 'Grep', 'ListAgents', 'NotebookEdit', 'Read',
  'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill', 'TaskStop', 'WaitForMcpServers',
  'WebFetch', 'WebSearch', 'Workflow', 'Write', 'AskUserQuestion',
]);

// qoder permission-mode 词表 → claude 词表（camelCase）
const PM_MAP = {
  default: null,                    // claude 用主人自己的默认配置
  accept_edits: 'acceptEdits', acceptEdits: 'acceptEdits',
  dont_ask: 'dontAsk', dontAsk: 'dontAsk',
  bypassPermissions: 'bypassPermissions',
  auto: 'auto', plan: 'plan', manual: 'manual',
};

const INIT_RESPONSE_FALLBACK = () => ({
  commands: [], agents: [], skills: [], output_style: 'default', available_output_styles: [],
  models: [], account: {}, capabilities: CAPABILITIES, pid: process.pid,
});
const MODELS_FALLBACK = () => ({
  models: [{
    value: 'claude-bridge', displayName: 'Claude',
    description: '使用强大的 Claude Code 代理后端', modelId: 'claude-bridge',
    source: 'system', isDefault: true,
    // Claude 全系列支持 vision；千问办公前端按 is_vl / capabilities.vision 放行图片
    is_vl: true, capabilities: { vision: true },
  }],
});

// ---------- 参数解析 ----------
const VALUE_ARGS = new Set([
  '--output-format', '--input-format', '--session-id', '--resume', '--agent',
  '--system-prompt', '--append-system-prompt', '--max-budget-usd', '--max-turns',
  '--permission-mode', '--permission-prompt-tool', '--settings',
  '--resume-session-at', '--resume-drops-turn', '--tools',
  '--allowed-tools', '--disallowed-tools', '--mcp-config', '--add-dir', '--plugin-dir',
  // —— 以下仅用于识别与等效翻译，不直传给 claude ——
  '--workdir', '--proxy', '--model', '--context-window', '--max-output-tokens',
  '--images', '--include', '--caller-version', '--ide-type', '--org-id', '--email',
  '--extensions', '--storage-dir', '--setting-sources',
]);
const FLAG_ARGS = new Set([
  '--print', '--include-partial-messages', '--continue', '--fork-session',
  '--debug', '--no-session-persistence', '--session-mirror',
  '--yolo', '--bare', '--strict-mcp-config', '--disable-builtin-skills',
  '--porcelain', '--keep-data',
]);

function parseArgs(argv) {
  const values = new Map();   // name -> string[]（统一数组，规避重复覆盖）
  const flags = new Set();
  const push = (k, v) => { if (!values.has(k)) values.set(k, []); values.get(k).push(v); };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.includes('=')) {
      const name = a.slice(0, a.indexOf('='));
      if (VALUE_ARGS.has(name)) { push(name, a.slice(a.indexOf('=') + 1)); continue; }
      if (FLAG_ARGS.has(name)) { flags.add(name); continue; }
      log('DROP', a); continue;
    }
    if (VALUE_ARGS.has(a)) push(a, argv[++i]);
    else if (FLAG_ARGS.has(a)) flags.add(a);
    else log('DROP', a);
  }
  const first = (k) => values.get(k)?.[0];
  const all = (k) => values.get(k) ?? [];

  // 内部查询特征（1.1.71 实测：--bare + --disallowed-tools *；旧 SDK 形态 --tools ""）。
  // v3 不再自答——这类查询的正确答案只有官方服务知道，自答就是在破坏官方功能。
  const internal =
    all('--tools').includes('') ||
    all('--disallowed-tools').includes('*') ||
    flags.has('--bare');

  // ---- 等效翻译：workdir → spawn cwd；proxy → 子进程 env ----
  const wd = first('--workdir');
  const cwd = wd && isAbsolute(wd) && existsSync(wd) ? wd : process.cwd();
  const proxy = first('--proxy');
  const childEnv = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'qwenwork-bridge' };
  if (proxy) { childEnv.HTTPS_PROXY = proxy; childEnv.HTTP_PROXY = proxy; }

  // ---- 组装 claude 参数 ----
  const claudeArgs = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];
  for (const f of ['--include-partial-messages', '--continue', '--fork-session', '--debug', '--no-session-persistence', '--session-mirror']) {
    if (flags.has(f)) claudeArgs.push(f);
  }
  if (flags.has('--yolo')) claudeArgs.push('--dangerously-skip-permissions'); // claude 不认 --yolo

  for (const v of ['--agent', '--max-budget-usd', '--max-turns', '--resume-session-at', '--resume-drops-turn']) {
    for (const val of all(v)) claudeArgs.push(v, val);
  }
  // 会话语义适配（claude vs qoder 语义相反，见 DECISIONS D11）：
  //   qoder --session-id 幂等可重复；claude --session-id 仅新建（已存在 → 退出 1）
  //   app 对同一 chat 反复下发同一 session-id，第二轮起必崩 → 按会话文件存在性互转
  {
    const sid = first('--session-id');
    const rid = first('--resume');
    const sessionExists = (id) => {
      if (!id) return false;
      const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
      return existsSync(join(homedir(), '.claude', 'projects', slug, `${id}.jsonl`));
    };
    if (sid && sessionExists(sid)) { log('SESSION-ADAPT', `--session-id ${sid} → --resume`); claudeArgs.push('--resume', sid); }
    else if (sid) claudeArgs.push('--session-id', sid);
    if (rid && !sessionExists(rid)) { log('SESSION-ADAPT', `--resume ${rid} → --session-id`); claudeArgs.push('--session-id', rid); }
    else if (rid) claudeArgs.push('--resume', rid);
  }
  for (const v of ['--add-dir', '--plugin-dir']) {
    for (const val of all(v)) claudeArgs.push(v, val);
  }
  // app 注册 canUseTool 时 SDK 下发 --permission-prompt-tool stdio；claude 原生支持
  for (const val of all('--permission-prompt-tool')) claudeArgs.push('--permission-prompt-tool', val);

  // MCP：qw-builtin 网关必须透传。Windows CreateProcess 命令行总长 32767，
  // 内联 JSON 转义后易触发 ENAMETOOLONG → 超长落临时文件传路径（--mcp-config 支持文件）
  for (const val of all('--mcp-config')) {
    if (val.length > 100) {
      const tmpFile = join(tmpdir(), `qwenwork-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      writeFileSync(tmpFile, val, 'utf8');
      claudeArgs.push('--mcp-config', tmpFile);
      log('MCP-FILE', `wrote ${val.length} chars → ${tmpFile}`);
    } else claudeArgs.push('--mcp-config', val);
  }
  // （--strict-mcp-config 故意丢弃：让主人既有 MCP 与 qw-builtin 共存，见 DECISIONS D5）

  const pm = PM_MAP[first('--permission-mode') ?? 'default'];
  if (pm) claudeArgs.push('--permission-mode', pm);

  // 工具集翻译：claude 的 --tools 是变长参数，必须用 = 形式，否则会吞掉下一个参数
  // 多个 qoder 名可能映射到同一 claude 名（Agent/TaskCreate 都是 Task）→ 去重，避免重复项
  for (const raw of all('--tools')) {
    if (raw === '' || raw === 'default') { claudeArgs.push(`--tools=${raw}`); continue; }
    const mapped = [...new Set(raw.split(',').map((t) => mapToolToken(t.trim(), Q2C_TOOL)).filter(Boolean))];
    claudeArgs.push(`--tools=${mapped.length > 0 ? mapped.join(',') : 'default'}`);
  }
  for (const val of all('--allowed-tools')) {
    const mapped = mapToolToken(val, Q2C_TOOL);
    if (mapped) claudeArgs.push('--allowed-tools', mapped);
  }
  for (const val of all('--disallowed-tools')) {
    if (val === '*') continue; // 内部查询特征值，桥接路径不透传
    const mapped = mapToolToken(val, Q2C_TOOL);
    if (mapped) claudeArgs.push('--disallowed-tools', mapped);
  }

  const converted = convertSettings(first('--settings'));
  if (converted) claudeArgs.push('--settings', converted);

  // 模型：官方档位名对 claude 无意义，默认丢弃；探测到的 claude 模型 id / 显式覆盖在后面注入
  if (FORCE_MODEL) claudeArgs.push('--model', FORCE_MODEL);

  // claude 无对应旗标，透传即启动失败 → 丢弃并记日志
  for (const dropped of ['--images', '--include', '--context-window', '--max-output-tokens',
                         '--allowed-mcp-server-names', '--caller-version', '--ide-type',
                         '--org-id', '--email', '--porcelain', '--keep-data', '--extensions',
                         '--storage-dir', '--setting-sources', '--disable-builtin-skills', '--bare']) {
    if (values.has(dropped)) log('DROP-ARG', `${dropped}=${JSON.stringify(all(dropped))}`);
  }

  return {
    internal,
    hasModel: values.has('--model'),
    claudeArgs,
    childEnv,
    cwd,
    sessionId: first('--session-id') ?? null,
  };
}

// 工具名映射：支持 "Tool" 与 "Tool(rule)" 两种形态；映射后必须是 claude 已知工具，否则丢弃
function mapToolToken(token, map) {
  if (!token) return null;
  const paren = token.indexOf('(');
  const base = paren >= 0 ? token.slice(0, paren) : token;
  const rule = paren >= 0 ? token.slice(paren) : '';
  const mapped = map[base] ?? (CLAUDE_TOOLS.has(base) ? base : null);
  return mapped ? mapped + rule : null;
}

// qoder settings → claude settings：白名单键过滤（permissions 语法同源：mcp__server__tool）
function convertSettings(raw) {
  if (!raw) return null;
  let obj;
  try {
    obj = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(readFileSync(raw, 'utf8'));
  } catch (e) { log('SETTINGS-PARSE-FAIL', e.message); return null; }
  const out = {};
  let touched = false;
  for (const k of ['permissions', 'env', 'outputStyle', 'includeCoAuthoredBy', 'cleanupPeriodDays']) {
    if (obj[k] !== undefined) { out[k] = obj[k]; touched = true; }
  }
  return touched ? JSON.stringify(out) : null;
}

// ---------- 子进程启动辅助 ----------
// 官方 CLI 是 .exe 直接 spawn；测试替身/无二进制环境用 .mjs，须经 node 执行
function spawnTarget(target, args, opts) {
  const viaNode = /\.(mjs|cjs|js)$/i.test(target);
  return spawn(viaNode ? process.execPath : target, viaNode ? [target, ...args] : args, opts);
}

// ---------- 透传模式：零改写 ----------
// 返回 {write, end}：调用方（入口分发器）负责把决策前缓冲的帧按序补喂，
// 之后新到的帧继续走同一个 write——不存在第二个 stdin 消费者。
function runPassthrough(nativePath, argv) {
  log('PASSTHROUGH', `spawn ${nativePath}`);
  const child = spawnTarget(nativePath, argv, {
    cwd: process.cwd(),
    env: passthroughEnv(),      // 删 QODER_CLI_PATH / QODERCLI_PATH：防自我递归与孙进程回落
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let childExitCode = null;   // null = 尚未退出；退出后一律拒写 stdin
  child.on('error', (e) => { log('PASSTHROUGH-SPAWN-FAIL', e.message); childExitCode = childExitCode ?? 1; process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    log('PASSTHROUGH-EXIT', `code=${code} signal=${signal}`);
    childExitCode = code ?? 1;
    process.exitCode = code ?? 1;   // 41 = 认证过期，是协议不是错误，必须原样传播
    // 子进程已死 ⇒ 本 shim 没有任何理由继续存活。若不主动收尾，readline 会因宿主 stdin
    // 未关闭而把事件循环永久吊住，SDK 随后发来 SIGTERM，退出码就从 41 变成 143（信号）。
    detachStdin();
  });
  // SDK 关闭序列 closeGraceMs → endInput → SIGTERM → SIGKILL；不转接会把 41 变成 signal 终止，
  // App 就收不到「认证过期 → 重新登录」信号。
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { child.kill(sig); } catch {} });
  // stderr 既要转发（宿主可见）也要落盘：透传分支失败时这是唯一线索
  // （真机实测官方 CLI 会以退出码 1 静默失败，不留 stderr 就无从判因）
  child.stderr.on('data', (d) => {
    const s = d.toString();
    log('PASSTHROUGH-STDERR', s.trim().slice(0, 2000));
    try { process.stderr.write(d); } catch {}
  });
  child.stdout.on('data', (d) => { try { process.stdout.write(d); } catch {} });

  return {
    // 子进程已退出后再写 stdin 会抛 EPIPE；不接住就会让 shim 崩在非零码上，
    // 把官方真正的退出码（含 41 = 认证过期）吞掉——这是透传路径最不能犯的错。
    write(line) {
      if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded || childExitCode !== null) return;
      try { child.stdin.write(line.endsWith('\n') ? line : `${line}\n`); }
      catch (e) { log('PASSTHROUGH-WRITE-SKIP', `${e.code ?? ''} ${e.message}`); }
    },
    end() {
      try {
        if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      } catch {}
    },
  };
}

// ---------- 桥接模式：延迟 spawn claude + 双向控制桥接 ----------
function runSession(parsed, sinkRef) {
  log('MODE', `claude (bridge) sessionId=${parsed.sessionId}`);
  log('CLAUDE-ARGS', JSON.stringify(parsed.claudeArgs));
  log('CWD', parsed.cwd);

  let child = null;
  let childExited = false;
  let claudeReady = false;
  const pendingStdin = [];
  const forwardedIds = new Set();
  const claudePendingIds = new Set();
  const fwdTimers = new Map();
  const pendingFwdSubtypes = new Map();
  const pendingFwdReqs = new Map();
  let claudeModels = null;
  let lastUserText = '';

  const claudeCommand = /\.(mjs|js)$/i.test(CLAUDE_BIN) ? [process.execPath, CLAUDE_BIN] : [CLAUDE_BIN];

  function spawnClaude() {
    if (child) return;
    try {
      const cmdLineLen = parsed.claudeArgs.join(' ').length;
      if (cmdLineLen > 8000) {
        log('SPAWN-WARN', `命令行长度 ${cmdLineLen} 接近 Windows 限制`);
        parsed.claudeArgs.forEach((arg, i) => {
          if (arg.length > 100) log('SPAWN-DEBUG-ARG', `[${i}] ${arg.length} chars: ${arg.substring(0, 200)}...`);
        });
      }
      child = spawn(claudeCommand[0], [...claudeCommand.slice(1), ...parsed.claudeArgs], {
        cwd: parsed.cwd, env: parsed.childEnv, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      log('SPAWN-FAIL', `${e.message} | code=${e.code} | errno=${e.errno}`);
      process.stderr.write(`[qwenwork-bridge] spawn claude failed: ${e.message}\n`);
      process.exitCode = 1;
      try { process.stdin.destroy(); } catch {}
      return;
    }
    child.on('error', (e) => {
      log('ERROR', e.message);
      process.stderr.write(`[qwenwork-bridge] spawn claude failed: ${e.message}\n`);
      process.exitCode = 1;
      try { process.stdin.destroy(); } catch {}
    });
    child.on('exit', (code, signal) => {
      childExited = true;
      log('EXIT', `code=${code} signal=${signal}`);
      process.exitCode = code ?? 1;
      detachStdin();   // 同透传路径：claude 已退出就不该再吊着事件循环等宿主输入
    });
    child.stderr.on('data', (d) => { process.stderr.write(d); log('STDERR', d.toString().trim()); });
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { child?.kill(sig); } catch {} });
    child.on('spawn', () => { claudeReady = true; flush(); });
    pumpClaudeStdout();
  }

  const flush = () => {
    if (!claudeReady) return;
    for (const l of pendingStdin.splice(0)) toClaudeRaw(l);
  };
  const toClaudeRaw = (line) => {
    if (child && claudeReady && !childExited && !child.stdin?.destroyed && !child.stdin?.writableEnded) {
      log('TO-CLAUDE', `direct ${String(line).slice(0, 60)}`);
      // 同透传路径：claude 已退出时写 stdin 会抛 EPIPE，必须接住以免吞掉真退出码
      try { child.stdin.write(line + '\n'); } catch (e) { log('TO-CLAUDE-SKIP', `${e.code ?? ''} ${e.message}`); }
    } else {
      log('TO-CLAUDE', `buffered(pending=${pendingStdin.length + 1}) ${String(line).slice(0, 60)}`);
      pendingStdin.push(line);
    }
  };
  // 转发控制请求时登记子类型（兜底合成 / initialize 合并要用）
  const forwardToClaude = (line) => {
    try {
      const m = JSON.parse(line);
      if (m.type === 'control_request' && m.request_id) {
        pendingFwdSubtypes.set(m.request_id, m.request?.subtype ?? m.request?.type ?? 'unknown');
        pendingFwdReqs.set(m.request_id, m.request ?? {});
      }
    } catch {}
    toClaudeRaw(line);
  };

  // 本模式消费的帧：由入口分发器喂（单一 stdin 消费者，见文件末入口）
  sinkRef.handle = (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.type === 'control_request') {
      const req = msg.request ?? {};
      const subtype = req.subtype ?? req.type ?? 'unknown';

      if (subtype === 'initialize') {
        // 延迟 spawn 的意义：把 initialize 携带的宿主配置翻译成 CLI 旗标。
        // systemPrompt / appendSystemPrompt 实测 39KB+，Windows 命令行限 32767 → 超长落文件
        const longArg = (flag, val, fileFlag) => {
          if (val === undefined || parsed.claudeArgs.includes(flag) || parsed.claudeArgs.includes(fileFlag)) return;
          const s = String(val);
          if (s.length > 200) {
            const tmpFile = join(tmpdir(), `qwenwork-${flag.replace(/^-+/, '')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
            writeFileSync(tmpFile, s, 'utf8');
            parsed.claudeArgs.push(fileFlag, tmpFile);
            log('PROMPT-FILE', `${flag} ${s.length} chars → ${tmpFile}`);
          } else parsed.claudeArgs.push(flag, s);
        };
        longArg('--system-prompt', req.systemPrompt, '--system-prompt-file');
        longArg('--append-system-prompt', req.appendSystemPrompt, '--append-system-prompt-file');
        if (req.promptSuggestions === true) parsed.claudeArgs.push('--prompt-suggestions', 'true');
        if (req.hooks && Object.keys(req.hooks).length > 0) log('HOOKS-DECLINED', `app hooks 不经 claude 执行: ${Object.keys(req.hooks).join(',')}`);
        spawnClaude();
      } else if (!child) {
        spawnClaude(); // 非标准序列（initialize 未到先来别的请求）：防御性 spawn
      }

      if (FORWARD_NATIVE.has(subtype)) {
        forwardedIds.add(msg.request_id);
        forwardToClaude(line);
        log('CTRL-FWD', `${subtype} id=${msg.request_id}`);
        const timeoutMs = subtype === 'initialize' ? 8000 : subtype === 'interrupt' ? 5000 : 6000;
        const t = setTimeout(() => {
          if (!forwardedIds.has(msg.request_id)) return;
          forwardedIds.delete(msg.request_id);
          log('CTRL-FWD-TIMEOUT', `${subtype} id=${msg.request_id} → shim 合成兜底`);
          if (subtype === 'interrupt') { try { child?.kill('SIGTERM'); } catch {} }
          process.stdout.write(controlResponse(msg.request_id, synthFor(subtype, req)));
        }, timeoutMs);
        t.unref?.();
        fwdTimers.set(msg.request_id, t);
        return;
      }

      // claude 不支持的子类型 → shim 合成应答兜底
      log('CTRL-SYNTH', `${subtype} id=${msg.request_id}`);
      process.stdout.write(controlResponse(msg.request_id, synthFor(subtype, req)));
      return;
    }

    if (msg.type === 'control_response') {
      // SDK 应答 claude 上行的请求（can_use_tool 权限弹窗等）→ 回流 claude
      const rid = msg.response?.request_id;
      if (rid && claudePendingIds.has(rid)) {
        claudePendingIds.delete(rid);
        toClaudeRaw(line);
        log('CTRL-BACK', `id=${rid} → claude`);
      }
      return;
    }

    if (msg.type === 'user' && msg.message) {
      log('USER-IN', `child=${!!child} ready=${claudeReady} ${extractText(msg.message).slice(0, 30)}`);
      if (!child) spawnClaude(); // 防御：user 先于 initialize 到达
      const text = extractText(msg.message);
      if (text) lastUserText = text;
      toClaudeRaw(line); // 原帧透传（claude 容忍多余字段）
      flush();
    }
  };
  sinkRef.onClose = () => {
    if (child && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  };

  // 兜底：3 秒内没有任何触发 spawn 的帧（异常序列）也强制 spawn，避免 SDK initialize 超时
  setTimeout(() => { if (!child) { log('SPAWN-GUARD', 'timeout without trigger, force spawn'); spawnClaude(); } }, 3000).unref?.();

  // ---- 合成应答表（仅桥接路径；透传路径永不走到这里）----
  function synthFor(subtype, req) {
    switch (subtype) {
      case 'initialize': return INIT_RESPONSE_FALLBACK();
      case 'get_models':
        if (Array.isArray(claudeModels) && claudeModels.length > 0) {
          return { models: claudeModels.map((m, i) => ({
            value: m.value ?? m.id ?? String(m),
            displayName: m.displayName ?? m.value ?? m.id ?? String(m),
            description: m.description ?? 'Claude Code (bridge)',
            modelId: m.modelId ?? m.id ?? m.value ?? String(m),
            source: 'system', isDefault: m.isDefault ?? i === 0,
            is_vl: true, capabilities: { vision: true },
          })) };
        }
        return MODELS_FALLBACK();
      case 'generate_session_title':
        return { title: (String(req.description ?? lastUserText ?? '').trim() || '会话').slice(0, 20) };
      case 'account_info': return { account: {} };
      case 'get_usage_info': return { usage: null, session: null, usage_error: 'bridge: 用量请看 ~/.qwenwork-bridge/ledger.jsonl' };
      // 关键：未知子类型必须**放行**而非吞成 {}——否则 fetch_job_token 会被吃成空对象，
      // 官方 CLI 随即报 job_token_unavailable（透传路径不会走到这，桥接路径同理保守放行）
      default: return {};
    }
  }

  // ---- stdout（claude → SDK）：事件改写 + 控制帧回流 ----
  function pumpClaudeStdout() {
    const outRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    outRl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }

      // claude 对转发请求的应答：initialize 需合并注入，其余原样回传 SDK
      if (msg.type === 'control_response') {
        const rid = msg.response?.request_id;
        if (rid && forwardedIds.has(rid)) {
          forwardedIds.delete(rid);
          const t = fwdTimers.get(rid); if (t) { clearTimeout(t); fwdTimers.delete(rid); }
          if (msg.response.subtype === 'error') {
            const original = pendingFwdSubtypes.get(rid) ?? 'unknown';
            log('CTRL-FWD-ERROR', `${original}: ${String(msg.response.error).slice(0, 120)} → shim 合成兜底`);
            process.stdout.write(controlResponse(rid, synthFor(original, pendingFwdReqs.get(rid) ?? {})));
            return;
          }
          if (pendingFwdSubtypes.get(rid) === 'initialize' && msg.response.response && typeof msg.response.response === 'object') {
            const merged = mergeInitializeResponse(msg.response.response);
            claudeModels = merged.models ?? claudeModels;
            msg.response.response = merged;
          }
          process.stdout.write(JSON.stringify(msg) + '\n');
          return;
        }
        process.stdout.write(line + '\n');
        return;
      }

      // claude 上行请求（can_use_tool 权限弹窗等）→ 转给 SDK，应答经 stdin 回流
      if (msg.type === 'control_request') {
        claudePendingIds.add(msg.request_id);
        log('CTRL-UPSTREAM', `${msg.request?.subtype ?? msg.request?.type ?? '?'} id=${msg.request_id}`);
        process.stdout.write(line + '\n');
        return;
      }

      if (msg.type === 'system' && msg.subtype === 'init') {
        msg.protocol_version = PROTOCOL_VERSION;
        if (Array.isArray(msg.tools)) msg.tools = msg.tools.map((t) => TOOL_MAP[t] ?? t);
        if (msg.commands === undefined && Array.isArray(msg.slash_commands)) {
          msg.commands = msg.slash_commands.map((name) => ({ name, description: '' }));
        }
        process.stdout.write(JSON.stringify(msg) + '\n');
        return;
      }

      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use' && TOOL_MAP[block.name]) block.name = TOOL_MAP[block.name];
        }
        process.stdout.write(JSON.stringify(msg) + '\n');
        return;
      }

      if (msg.type === 'result') {
        ledger({
          sessionId: msg.session_id ?? parsed.sessionId,
          model: msg.model ?? null,
          total_cost_usd: msg.total_cost_usd ?? 0,
          num_turns: msg.num_turns ?? 0,
          duration_ms: msg.duration_ms ?? 0,
          is_error: msg.is_error ?? false,
          result_preview: String(msg.result ?? '').slice(0, 120),
        });
        process.stdout.write(JSON.stringify(msg) + '\n');
        return;
      }

      process.stdout.write(line + '\n');
    });
  }
}

// claude 的 initialize 应答 → SDK 期望形状：补 capabilities / skills / 视觉能力
function mergeInitializeResponse(resp) {
  const merged = { ...resp };
  if (!Array.isArray(merged.capabilities)) merged.capabilities = CAPABILITIES;
  if (!Array.isArray(merged.skills)) merged.skills = [];
  if (Array.isArray(merged.models)) {
    merged.models = merged.models.map((m) => {
      if (typeof m !== 'object' || m === null) return m;
      return { ...m, is_vl: m.is_vl ?? true, capabilities: { vision: true, ...(m.capabilities ?? {}) } };
    });
  }
  return merged;
}

function extractText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  return '';
}

// ---------- 入口：单一 stdin 分发器 + 三种模式 ----------
// 结构约束：process.stdin 全程只有下面这一个 readline 消费者。
// 模式切换靠替换 sink 的下游函数，绝不新建第二个 createInterface(stdin)——
// 两个消费者会竞争读取，直接丢帧（v3 初稿踩过，见 docs/researches 复核记录）。
const argv = process.argv.slice(2);
const parsed = parseArgs(argv);
// QODER_BRIDGE_QODERCLI 显式赋值（含空串）优先：空串 = 强制「无原生 CLI」，用于测试与纯桥接场景
const NATIVE_OVERRIDE = process.env.QODER_BRIDGE_QODERCLI;
const nativePath = NATIVE_OVERRIDE !== undefined ? (NATIVE_OVERRIDE.trim() || null) : findNativeCli();
log('ARGV', JSON.stringify(argv));
log('ENV', JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^QODER/i.test(k)))));
log('CLAUDE-BIN', CLAUDE_BIN);
log('NATIVE-CLI', nativePath ?? '(not found)');

// 决策落地前到达的宿主帧；决策后按序补喂给所选下游，保证 initialize/user 一帧不丢
const prelude = [];
const sink = { handle: null, writeRaw: null, onClose: null };
let stdinEnded = false;   // 关闭可能早于决策落地，此时补喂完必须立刻转发 close，否则子进程永久等输入

// get_model_policy 探测状态机
const probe = {
  pending: false,
  requestId: `bridge-policy-${process.pid}-${Date.now()}`,
  resolve: null,
  // 命中我们那条应答时返回 true（该帧只用于定路由，绝不下发给子进程）
  consider(line) {
    let m; try { m = JSON.parse(line); } catch { return false; }
    if (m?.type !== 'control_response' || m.response?.request_id !== this.requestId) return false;
    const resp = m.response?.response ?? {};
    const provider = resp.custom_model?.provider;
    this.resolve({ claude: provider === BYOK_MARKER, provider: provider ?? null, model: resp.model ?? null });
    return true;
  },
  start() {
    this.pending = true;
    process.stdout.write(JSON.stringify({
      type: 'control_request',
      request_id: this.requestId,
      // SDK 侧取 subtype ?? type；purpose/turnIndex 是宿主 resolveModel 回调的入参字段
      request: { type: 'get_model_policy', subtype: 'get_model_policy', purpose: 'main', turnIndex: 0 },
    }) + '\n');
    log('PROBE-SENT', this.requestId);
    return new Promise((res) => {
      this.resolve = (v) => {
        if (!this.pending) return;
        this.pending = false;
        clearTimeout(timer);
        res(v);
      };
      const timer = setTimeout(() => this.resolve({ timeout: true }), PROBE_TIMEOUT_MS);
      timer.unref?.();
    });
  },
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (probe.pending && probe.consider(line)) return;
  if (sink.writeRaw) return sink.writeRaw(line);
  if (sink.handle) return sink.handle(line);
  prelude.push(line);
});
rl.on('close', () => {
  stdinEnded = true;
  if (probe.pending) { log('PROBE-STDIN-CLOSED', 'resolve as timeout'); probe.resolve({ timeout: true }); return; }
  if (sink.onClose) sink.onClose();
});

// 子进程已经退出 ⇒ shim 无存活理由。销毁 stdin 让 readline 立刻收流，
// 事件循环随即自然结束，退出码保持子进程那一个（41 不会被后续 SIGTERM 换成 143）。
function detachStdin() {
  try { rl.close(); } catch {}
  try { process.stdin.destroy(); } catch {}
}

// 探测回来的模型名未必真是模型名：App 把 BYOK 的 model 列原样回传，而那一列可能被
// 本项目用作副标题文案（渲染层副标题 = `${Anthropic|OpenAI} · <model列>`，无独立字段）。
// 非 ASCII 或含空格的值喂给 claude 的 --model 会直接启动失败，故只接受模型名形态，
// 其余一律丢弃并回退到 FORCE_MODEL / claude 自身默认。
const CLAUDE_MODEL_RE = /^[A-Za-z0-9._[\]:\/-]{1,64}$/;
const safeClaudeModel = (name) => (typeof name === 'string' && CLAUDE_MODEL_RE.test(name) ? name : null);

function attachClaude(modelFromProbe) {
  const m = safeClaudeModel(modelFromProbe);
  if (m && !FORCE_MODEL) {
    parsed.claudeArgs.push('--model', m);
    log('PROBE-MODEL', `--model ${m}`);
  } else if (modelFromProbe && !m) {
    log('PROBE-MODEL-SKIP', `非常规模型名，丢弃：${JSON.stringify(String(modelFromProbe).slice(0, 40))}`);
  }
  runSession(parsed, sink);
  const fed = prelude.splice(0);
  log('PRELUDE', `claude 补喂 ${fed.length} 帧`);
  for (const l of fed) sink.handle(l);
  if (stdinEnded) sink.onClose?.();   // 关闭早于决策：补喂完立刻转发 EOF
}

function attachPassthrough() {
  const t = runPassthrough(nativePath, argv);
  // 先补喂决策前缓冲的帧，再接通实时转发：readline 事件只在事件循环里投递，
  // 同步段内不会插入新帧，因此这里的顺序即最终写入顺序（帧序不可乱）。
  const fed = prelude.splice(0);
  log('PRELUDE', `passthrough 补喂 ${fed.length} 帧`);
  for (const l of fed) t.write(l);
  sink.writeRaw = (line) => t.write(line);
  sink.onClose = () => t.end();
  if (stdinEnded) t.end();
}

async function main() {
  // 无原生 CLI 可透传 → 退回 v2 行为（全量桥接）。这是一次**降级**：
  // 官方内部查询会重新被自答吃掉，共存不再成立，所以必须让它在现场可见。
  if (!nativePath) {
    log('DECIDE', 'claude (no native CLI available)');
    process.stderr.write(
      '[qwenwork-bridge] 未能定位千问办公官方 qoderclicn，已退回全量桥接（官方内部查询将被自答）。\n'
      + '  请显式指定：QODER_BRIDGE_QODERCLI=<.../resources/bin/qoderclicn>'
      + `（macOS 常见路径 /Applications/QwenWorkCN.app/Contents/Resources/bin）\n`);
    return attachClaude(null);
  }
  if (parsed.internal) { log('DECIDE', 'passthrough (internal query)'); return attachPassthrough(); }
  if (parsed.hasModel) { log('DECIDE', 'passthrough (--model ⇒ official tier)'); return attachPassthrough(); }

  log('DECIDE', 'probe (no --model; ask host for model policy)');
  const r = await probe.start();
  if (r?.timeout) { log('DECIDE', 'passthrough (probe timeout → keep official path)'); return attachPassthrough(); }
  if (r?.claude) { log('DECIDE', `claude (provider=${r.provider})`); return attachClaude(r.model); }
  log('DECIDE', `passthrough (provider=${r?.provider ?? 'absent'} ⇒ official)`);
  return attachPassthrough();
}

main().catch((e) => {
  log('MAIN-FAIL', `${e?.stack ?? e} → conservative fallback`);
  if (nativePath) attachPassthrough(); else attachClaude(null);
});
