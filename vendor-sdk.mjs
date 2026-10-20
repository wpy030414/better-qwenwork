// vendor-sdk.mjs — 把千问办公自带的厂商 SDK 暂存到本仓库内，供 E2E 直接 import
//
// 为什么需要暂存：厂商 SDK 是 app.asar.unpacked 下的普通 .js，但它的裸依赖
// （@modelcontextprotocol/sdk）只存在于**本仓库** node_modules；
// 直接 import 安装目录那份会解析失败。Node 的模块解析沿目录树向上找，
// 所以把 dist 复制进仓库内任意目录即可命中我们的 node_modules。
//
// 暂存目录在 .analysis/ 下（已 gitignore）：它是**可重建的本机产物**，
// 从 App 安装目录原样复制而来，不是下载物，也不纳入版本库。
import { existsSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const STAGE_REL = join('.analysis', 'vendor-sdk');

async function locateInstalledDist(root) {
  // 直接 import 定位器（比 shell 出去再解析 stdout 稳：无引号/路径转义问题）
  const { findNativeCli } = await import(pathToFileURL(join(root, 'src', 'native-cli.mjs')).href);
  const cli = findNativeCli();
  if (!cli) throw new Error('未找到官方 qoderclicn，无法定位厂商 SDK（请先安装千问办公）');
  // <安装>/resources/bin/qoderclicn.exe → <安装>/resources/app.asar.unpacked/node_modules/...
  const resDir = dirname(dirname(cli));
  const dist = join(resDir, 'app.asar.unpacked', 'node_modules', '@qoder-ai', 'qoder-agent-sdk', 'dist');
  if (!existsSync(join(dist, 'index.js'))) throw new Error(`厂商 SDK 不在预期位置：${dist}`);
  return dist;
}

// 返回已 import 的 SDK 模块
export async function loadVendorSdk(root = process.cwd()) {
  const stage = join(root, STAGE_REL);
  const staged = join(stage, 'index.js');
  if (!existsSync(staged)) {
    const dist = await locateInstalledDist(root);
    mkdirSync(stage, { recursive: true });
    cpSync(join(dist, 'index.js'), staged);
    if (existsSync(join(dist, 'protocol'))) cpSync(join(dist, 'protocol'), join(stage, 'protocol'), { recursive: true });
    // 让暂存副本以 ESM 解析（与厂商 package.json 的 type:module 等价）
    writeFileSync(join(stage, 'package.json'), '{"type":"module","private":true}\n');
    console.log(`已暂存厂商 SDK：${dist} → ${stage}`);
  }
  return import(pathToFileURL(staged).href);
}
