#!/usr/bin/env node
// mock-native.mjs — 测试专用「官方 qoder CLI」替身
//
// 为什么需要它：v3 的默认分支是**原样透传**给官方 exe，必须能验证「透传路径零改写」——
// 包括 argv 一字不动、宿主帧一字不动、env 抹掉劫持变量、退出码原样传播。
// 真 exe（216MB bun 单文件）不可控且会打云端，故用本替身记录它实际收到了什么。
//
// 由 bridge-shim.test.mjs 通过 QODER_BRIDGE_QODERCLI 指向本文件。
// 行为约定（对齐 qoderclicn 1.1.71 的 SDK 路由）：
//   - 启动即把 argv / 关键 env 落盘到 MOCK_NATIVE_MARKER（JSON），供断言；
//   - 收到的每一行原样记入 marker 的 frames 数组；
//   - 收到 control_request 一律回 success 空应答（真 CLI 会应答 initialize/get_models 等）；
//   - 收到 user 消息后回一条 result 并以 MOCK_NATIVE_EXIT 指定码退出（默认 0；测 41 用 41）。
// stdout 管道在 Windows 上是异步的：process.exit 可能截掉未刷出的帧。
// 协议替身必须同步写，故直接走 fd 1 的同步 writeSync。
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync, writeSync } from 'node:fs';

const MARKER = process.env.MOCK_NATIVE_MARKER;
const EXIT_CODE = Number(process.env.MOCK_NATIVE_EXIT ?? 0);
const send = (o) => { try { writeSync(1, JSON.stringify(o) + '\n'); } catch {} };

const state = {
  argv: process.argv.slice(2),
  env: {
    QODER_CLI_PATH: process.env.QODER_CLI_PATH ?? null,
    QODERCLI_PATH: process.env.QODERCLI_PATH ?? null,
    QODER_AGENT_SDK_ENTRYPOINT: process.env.QODER_AGENT_SDK_ENTRYPOINT ?? null,
    QODER_SDK_AUTH_PAYLOAD_FILE: process.env.QODER_SDK_AUTH_PAYLOAD_FILE ?? null,
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
  },
  frames: [],
};
const dump = () => { try { writeFileSync(MARKER, JSON.stringify(state, null, 2), 'utf8'); } catch {} };
dump();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  state.frames.push(line);
  dump();
  let msg; try { msg = JSON.parse(line); } catch { return; }

  if (msg.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mocked: true, subtype: msg.request?.subtype ?? msg.request?.type ?? null } } });
    return;
  }
  if (msg.type === 'user') {
    send({ type: 'system', subtype: 'init', session_id: msg.session_id ?? null, mock_native: true });
    send({ type: 'result', subtype: 'success', is_error: false, result: 'NATIVE_DONE', session_id: msg.session_id ?? null });
    // 真 CLI 收到 result 即结束本轮并保持会话待命；替身直接按指定退出码收尾，
    // 以便断言 shim 的退出码传播（41 = 认证过期）。setImmediate 留出 stdout flush 窗口。
    setImmediate(() => process.exit(EXIT_CODE));
  }
});
// stdin EOF ⇒ 宿主关闭输入流（SDK 的 endInput）。真 CLI 此时退出，替身必须同样退出，
// 否则 shim 的透传分支会永久等待子进程。
rl.on('close', () => { setImmediate(() => process.exit(process.exitCode ?? 0)); });
