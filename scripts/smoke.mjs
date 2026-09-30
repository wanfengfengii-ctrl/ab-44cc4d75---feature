// 烟测：
//  1) 等待 /healthz 通过（服务由外部提供 BASE_URL，或本脚本临时拉起一个）；
//  2) 抓取页面与脚本资源，确认站点可服务；
//  3) 在同一求解器内核上跑「含一次分裂 + 一次漏检」的谱系场景并校验结果；
// 以退出码报告：0 通过，非 0 失败。
'use strict';

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { normalizeSpec, solveLineage, presentSolution } from '../public/js/lineage.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.WEB_HOST || 'web';
const PORT = process.env.WEB_PORT || '8080';
const BASE_URL = process.env.BASE_URL ||
  ((HOST === 'web' || HOST === '0.0.0.0') ? `http://web:${PORT}` : `http://127.0.0.1:${PORT}`);

let ownServer = null;
let portFile = null;

function log(msg) { console.log(`[smoke] ${msg}`); }
function fail(msg) { console.error(`[smoke] 失败: ${msg}`); process.exitCode = 1; throw new Error(msg); }

async function waitHealthy(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) {
        const j = await jsonOrText(r);
        log(`健康检查通过 ${base}/healthz -> ${JSON.stringify(j)}`);
        return;
      }
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 300));
  }
  fail(`健康检查超时: ${lastErr?.message || 'no response'}`);
}

async function jsonOrText(r) {
  try { return await r.json(); } catch { return await r.text(); }
}

async function startOwnServer() {
  portFile = join(tmpdir(), `algal-port-${process.pid}.txt`);
  if (existsSync(portFile)) rmSync(portFile);
  const child = spawn(process.execPath, [join(ROOT, 'server.cjs')], {
    env: { ...process.env, WEB_HOST: '127.0.0.1', WEB_PORT: '0', PORT_FILE: portFile },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  ownServer = child;
  return await new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (existsSync(portFile)) {
        const port = Number(readFileSync(portFile, 'utf8').trim());
        if (Number.isInteger(port) && port > 0) {
          res(`http://127.0.0.1:${port}`);
          return;
        }
      }
      if (Date.now() - t0 > 10000) return rej(new Error('服务器未在 10s 内监听'));
      setTimeout(tick, 100);
    };
    tick();
  });
}
async function checkStatic(base) {
  const pages = ['/', '/index.html', '/js/lineage.js', '/js/app.js', '/css/style.css'];
  for (const p of pages) {
    const r = await fetch(`${base}${p}`);
    if (r.status !== 200) fail(`GET ${p} 状态码 ${r.status}`);
    const body = await r.text();
    if (!body.length) fail(`GET ${p} 返回空内容`);
  }
  log('静态资源全部可访问');
  const r404 = await fetch(`${base}/no-such-file`);
  if (r404.status !== 404) fail(`缺失资源应返回 404，实际 ${r404.status}`);
  log('404 行为正常');
}

// 同时含分裂与漏检的场景：
// 帧0 a → 帧1 b →（帧2 漏检）→ 帧3 c → 帧4 分裂为 e1/e2；
// 各帧还放置更亮的杂质 z*，验证不会被逐帧贪心串入。
function scenario() {
  return {
    frames: [
      [
        { id: 'a', x: 5, y: 50, b: 40 },
        { id: 'z0', x: 90, y: 90, b: 200 },
      ],
      [
        { id: 'b', x: 15, y: 50, b: 42 },
        { id: 'z1', x: 88, y: 90, b: 200 },
      ],
      [
        { id: 'z2a', x: 86, y: 90, b: 200 },
        { id: 'z2b', x: 86, y: 80, b: 190 },
      ],
      [
        { id: 'c', x: 35, y: 50, b: 44 },
        { id: 'z3', x: 84, y: 85, b: 200 },
      ],
      [
        { id: 'e1', x: 45, y: 42, b: 46 },
        { id: 'e2', x: 45, y: 58, b: 48 },
        { id: 'z4', x: 82, y: 82, b: 200 },
      ],
    ],
    startId: 'a',
    maxDist: 14,
    maxSkip: 1,
    target: 2,
  };
}

function checkScenario() {
  const input = scenario();
  const { errors, spec } = normalizeSpec(input);
  if (errors.length) fail(`场景输入校验失败: ${JSON.stringify(errors)}`);
  const raw = solveLineage(spec);
  if (!raw.feasible) fail(`含分裂与漏检的场景被误判不可行: ${JSON.stringify(raw.earliestBreak)}`);
  const sol = presentSolution(spec, raw);

  const assert = (cond, msg) => { if (!cond) fail(msg); };
  assert(sol.skips === 1, `漏检段应为 1，实际 ${sol.skips}`);
  assert(sol.divisions === 1, `分裂次数应为 1，实际 ${sol.divisions}`);
  assert(sol.survivors === 2, `终帧存活应为 2，实际 ${sol.survivors}`);
  assert(JSON.stringify(sol.used[2]) === '[]', `第 3 帧应整帧漏检，实际 ${JSON.stringify(sol.used[2])}`);
  assert(sol.used[3][0] === 'c', `第 4 帧应补获 c，实际 ${JSON.stringify(sol.used[3])}`);
  assert(JSON.stringify(sol.used[4].sort()) === JSON.stringify(['e1', 'e2']),
    `末帧应为 e1/e2，实际 ${JSON.stringify(sol.used[4])}`);
  const gap = sol.edges.find((e) => e.gap === 2);
  assert(gap && gap.fromId === 'b' && gap.toId === 'c', '漏检段应为 b→c');
  const div = sol.edges.filter((e) => e.fromFrame === 3 && e.fromId === 'c');
  assert(div.length === 2 && div.every((e) => ['e1', 'e2'].includes(e.toId)), 'c 应分裂为 e1、e2');
  assert(sol.edges.every((e) => !e.toId.startsWith('z') && !e.fromId.startsWith('z')),
    '亮杂质 z* 不得进入谱系');
  const expectedBright = 40 + 42 + 44 + 46 + 48;
  assert(sol.totalBrightness === expectedBright,
    `总亮度应为 ${expectedBright}，实际 ${sol.totalBrightness}`);
  log(`谱系烟测通过：a→b →漏检→ c →(e1,e2)，总亮度 ${sol.totalBrightness}，位移表 ${sol.edges.length} 行`);

  // 不可行场景：收紧位移使首帧间彻底断开，应报告最早断开为 帧1→帧2
  const tight = structuredClone(input);
  tight.maxDist = 2;
  const spec2 = normalizeSpec(tight).spec;
  const raw2 = solveLineage(spec2);
  assert(raw2.feasible === false, '位移收紧后应不可行');
  assert(raw2.earliestBreak.from === 0 && raw2.earliestBreak.to === 1,
    `最早断开帧间应为 1→2，实际 ${raw2.earliestBreak.from + 1}→${raw2.earliestBreak.to + 1}`);
  log('不可行报告正确：最早断开 第 1 帧 → 第 2 帧');
}

// 终端后代平衡复核（含嵌套分裂 + 跨帧漏检）：
// 帧0 a → 帧1 m → 帧2 分裂为 c1/c2；c1→帧3 d1→帧4 分裂 e1/e2（嵌套 2 叶）；
// c2 在帧3 整帧漏检，帧4 补获为 e3（跨帧漏检只延续原支，1 叶）。
// 顶层分裂两侧终帧叶数为 2|1：限值 0 不可行，限值 1 可行。
function balanceScenario() {
  return {
    frames: [
      [
        { id: 'a', x: 0, y: 0, b: 10 },
        { id: 'za', x: 9, y: 9, b: 0 },
      ],
      [
        { id: 'm', x: 1, y: 0, b: 10 },
        { id: 'zm', x: 9, y: 9, b: 0 },
      ],
      [
        { id: 'c1', x: 2, y: -1, b: 10 },
        { id: 'c2', x: 2, y: 1, b: 10 },
      ],
      [
        { id: 'd1', x: 3, y: -1, b: 10 },
        { id: 'zz', x: 9, y: 9, b: 99 },
      ],
      [
        { id: 'e1', x: 4, y: -2, b: 10 },
        { id: 'e2', x: 4, y: 0, b: 10 },
        { id: 'e3', x: 4, y: 1, b: 10 },
      ],
    ],
    startId: 'a',
    maxDist: 2,
    maxSkip: 1,
    target: 3,
  };
}

function checkBalanceScenario() {
  const assert = (cond, msg) => { if (!cond) fail(msg); };
  const input = balanceScenario();

  const tight = normalizeSpec({ ...input, balanceEnabled: true, balanceLimit: 0 });
  if (tight.errors.length) fail(`平衡场景输入校验失败: ${JSON.stringify(tight.errors)}`);
  const rawTight = solveLineage(tight.spec);
  assert(rawTight.feasible === false, '嵌套 2|1 分裂在限值 0 下应不可行（约束须在枚举内同步）');
  const solTight = presentSolution(tight.spec, rawTight);
  assert(solTight.balanceEnabled === true && solTight.balanceLimit === 0,
    '不可行结果应保留平衡开关与限值');
  log(`平衡限值 0 正确判不可行：最早断开 ${solTight.earliestBreakLabel}`);

  const loose = normalizeSpec({ ...input, balanceEnabled: true, balanceLimit: 1 });
  const raw = solveLineage(loose.spec);
  if (!raw.feasible) fail(`平衡限值 1 场景被误判不可行: ${JSON.stringify(raw.earliestBreak)}`);
  const sol = presentSolution(loose.spec, raw);
  assert(sol.skips === 1, `应有一次跨帧漏检，实际 ${sol.skips}`);
  assert(sol.divisions === 2, `应有两次分裂（含嵌套），实际 ${sol.divisions}`);
  assert(sol.divisionDetails.length === 2, '分裂明细应逐次列出两次');

  const byMother = new Map(sol.divisionDetails.map((d) => [d.motherId, d]));
  const top = byMother.get('m');
  assert(top, '明细应包含帧2 母本 m 的分裂');
  const leaves = top.daughters.map((x) => x.terminalLeaves).sort((a, b) => a - b);
  assert(JSON.stringify(leaves) === '[1,2]',
    `m 两侧终帧后代应为 1 与 2（嵌套+漏检），实际 ${JSON.stringify(leaves)}`);
  assert(top.leafDiff === 1, `m 两侧差值应为 1，实际 ${top.leafDiff}`);
  const nested = byMother.get('d1');
  assert(nested && nested.leafDiff === 0, '嵌套分裂 d1 两侧应各 1 叶、差值 0');
  for (const d of sol.divisionDetails) assert(d.leafDiff <= 1, '所有分裂差值不得越限');
  log(`平衡烟测通过：m 分裂两侧终帧后代 ${leaves[0]}|${leaves[1]}，` +
    `嵌套 d1 为 1|1，漏检 ${sol.skips} 段`);

  // 关闭复核时同输入同样可行，且结果不携带限值
  const off = normalizeSpec(input);
  const solOff = presentSolution(off.spec, solveLineage(off.spec));
  assert(solOff.feasible === true && solOff.balanceEnabled === false,
    '关闭复核时结果应可行且不带平衡标记');
  assert(solOff.divisionDetails.length === 2, '关闭时仍应列出分裂叶数明细');
  log('关闭复核时格式与求解兼容，分裂明细照常给出');
}

async function main() {
  let base = BASE_URL;
  if (process.env.BASE_URL) {
    log(`使用外部服务 ${base}`);
  } else {
    // Compose 的 verify 服务通过主机名 web 访问；本地直跑时自己拉起服务器
    try {
      await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(800) });
    } catch {
      log(`无法连接 ${base}，改为本地临时启动服务器`);
      base = await startOwnServer();
      log(`临时服务器监听于 ${base}`);
    }
  }
  await waitHealthy(base);
  await checkStatic(base);
  checkScenario();
  checkBalanceScenario();
  log('全部烟测通过 ✔');
  if (ownServer) ownServer.kill('SIGTERM');
  if (portFile && existsSync(portFile)) rmSync(portFile);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  if (ownServer) ownServer.kill('SIGTERM');
  process.exit(1);
});
