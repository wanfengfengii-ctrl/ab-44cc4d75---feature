// 藻类细胞分裂谱系复原核心（纯函数，零依赖，浏览器 / Node 共用）
//
// 模型：
//  - 帧按时刻排列；每帧若干斑点（唯一 id、整数坐标、整数亮度）。
//  - 连接只允许相邻帧（gap=1）或跨越恰好一帧漏检（gap=2）。
//  - 一个细胞要么保持为一个后代，要么分裂为恰两个后代；不允许消亡。
//  - 每个非起始斑点恰有一个祖先（入边），同一斑点不得被两支共用。
//  - 所有存活支必须从起始斑点出发到达末帧，且末帧存活数恰为目标数。
//  - 裁决顺序：总亮度最高 → 漏检段最少 → 输入顺序（逐帧采用斑点局部序号，
//    再逐斑点母本全局序号）字典序稳定裁决。
//
// 终端后代平衡复核（可选，spec.balance.enabled）：
//  - 每个分裂母本的两名女儿各自追溯到末帧的后代数 n1、n2 必须满足
//    |n1 - n2| ≤ maxDiff；跨帧漏检只延续原分支（配额原样单传），
//    嵌套分裂计入对应女儿的完整后代子树。
//  - 做法：把「该支最终须占有的末帧后代数」作为下行配额随状态传播。
//    根配额为终帧目标数；保持 / 漏检补获继承母本配额；分裂枚举满足
//    n1 + n2 = 母本配额且差值不越限的有序整数对 (n1,n2)。斑点、连接与
//    分裂拓扑在同一联合枚举内同步满足平衡约束，而非事后过滤最优解。
//  - 关闭时配额一律为通配值 0，状态空间退化为原 (帧, 存活掩码, 漏检掩码,
//    剩余额度)，草稿格式、求解结果与无解定位保持兼容。
//
// 位掩码动态规划：帧内斑点以位掩码表示；边界转移在「已占用女儿掩码 +
// 新开漏检母本掩码 + 各女儿配额码」上做内层 DP，同一
// (女儿集合, 漏检集合, 女儿配额) 只保留字典序最小的母本配对；状态
// (帧, 存活掩码, 漏检掩码, 剩余额度, 存活配额码, 漏检配额码) 备忘。

'use strict';

/**
 * 校验并规范化输入。
 * @returns {{errors:Array<{field:string,message:string}>, spec:object|null}}
 */
export function normalizeSpec(raw) {
  const errors = [];
  const field = (name, message) => errors.push({ field: name, message });

  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.frames)) {
    return { errors: [{ field: 'frames', message: '缺少帧数据' }], spec: null };
  }
  const F = raw.frames.length;
  if (F < 4 || F > 7) {
    field('frames', `帧数必须在 4 至 7 之间（当前 ${F}）`);
  }

  const frames = [];
  raw.frames.forEach((fr, t) => {
    const out = [];
    if (!Array.isArray(fr) || fr.length < 2 || fr.length > 8) {
      field(`frame${t}`, `第 ${t + 1} 帧斑点数必须在 2 至 8 之间（当前 ${Array.isArray(fr) ? fr.length : 0}）`);
      return;
    }
    const seen = new Set();
    fr.forEach((s, j) => {
      const label = `第 ${t + 1} 帧斑点 ${j + 1}`;
      if (!s || typeof s.id !== 'string' || s.id.trim() === '') {
        field(`frame${t}`, `${label} 缺少唯一编号`);
        return;
      }
      const id = s.id.trim();
      if (seen.has(id)) {
        field(`frame${t}`, `第 ${t + 1} 帧内斑点编号重复：${id}`);
        return;
      }
      seen.add(id);
      const x = Number(s.x);
      const y = Number(s.y);
      const b = Number(s.b);
      if (!Number.isInteger(x) || !Number.isInteger(y)) {
        field(`frame${t}`, `${label}（${id}）坐标必须为整数`);
        return;
      }
      if (!Number.isInteger(b) || b < 0) {
        field(`frame${t}`, `${label}（${id}）亮度必须为非负整数`);
        return;
      }
      out.push({ id, x, y, b });
    });
    frames.push(out);
  });

  if (errors.length) return { errors, spec: null };

  const startId = typeof raw.startId === 'string' ? raw.startId.trim() : '';
  const startIndex = frames[0] ? frames[0].findIndex((s) => s.id === startId) : -1;
  if (startIndex < 0) {
    field('startId', `起始斑点必须是第 1 帧中存在的编号（当前“${raw.startId}”）`);
  }

  const maxDist = Number(raw.maxDist);
  if (!Number.isFinite(maxDist) || maxDist < 0) {
    field('maxDist', '相邻帧最大位移必须为非负数');
  }

  const maxSkip = Number(raw.maxSkip);
  if (!Number.isInteger(maxSkip) || maxSkip < 0 || maxSkip > F - 2) {
    field('maxSkip', `允许漏检帧数必须为 0 至 ${Math.max(0, F - 2)} 的整数`);
  }

  const lastSize = frames[F - 1] ? frames[F - 1].length : 0;
  const target = Number(raw.target);
  if (!Number.isInteger(target) || target < 1 || target > lastSize) {
    field('target', `终帧存活细胞数必须为 1 至末帧斑点数（${lastSize}）的整数`);
  }

  // 终端后代平衡复核：默认关闭（兼容旧草稿）；启用时限值为非负整数。
  const balanceEnabled = raw.balanceEnabled === true;
  let balanceDiff = 0;
  if (balanceEnabled) {
    const d = raw.balanceDiff;
    balanceDiff = Number(d);
    if (d === '' || d === null || d === undefined ||
        !Number.isInteger(balanceDiff) || balanceDiff < 0) {
      field('balanceDiff', '启用终端后代平衡复核后，两侧终帧后代数最大差值必须为非负整数');
    }
  }

  if (errors.length) return { errors, spec: null };
  return {
    errors: [],
    spec: {
      frames, startIndex, maxDist, maxSkip, target,
      balance: { enabled: balanceEnabled, maxDiff: balanceDiff },
    },
  };
}

function compareTuple(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

// 比较两个裁决签名：逐帧比较（采用斑点局部序号元组，再母本全局序号元组）。
function betterSignature(a, b) {
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n; k++) {
    const c = compareTuple(a[k].used, b[k].used);
    if (c !== 0) return c < 0;
    const cm = compareTuple(a[k].mothers, b[k].mothers);
    if (cm !== 0) return cm < 0;
  }
  return false;
}

// 配额以 4 位为单位编入整数码（末帧目标数 ≤ 8，每支配额 1..8）；
// 0 为通配：平衡复核关闭时所有码位皆 0，行为与无配额模型完全一致。
const WILD = 0;
const nibAt = (code, pos) => (code >>> (4 * pos)) & 15;
const withNib = (code, pos, n) => code | (n << (4 * pos));

/**
 * 求解谱系。
 * @returns {object} 可行时 {feasible:true, ...}；不可行时
 *   {feasible:false, earliestBreak:{from:number,to:number}}
 */
export function solveLineage(spec) {
  const { frames, startIndex, maxDist, maxSkip, target } = spec;
  const balance = spec.balance || { enabled: false, maxDiff: 0 };
  const balOn = balance.enabled === true;
  const maxDiff = balOn ? balance.maxDiff : 0;
  const F = frames.length;
  const sizes = frames.map((fr) => fr.length);

  const offset = [0];
  for (let t = 1; t <= F; t++) offset[t] = offset[t - 1] + sizes[t - 1];
  const gi = (t, i) => offset[t] + i;
  const decode = (g) => {
    let t = 0;
    while (t + 1 < F && g >= offset[t + 1]) t++;
    return { t, i: g - offset[t] };
  };

  const d2 = (a, b) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  };

  const popcnt = (m) => {
    let c = 0;
    while (m) { m &= m - 1; c++; }
    return c;
  };
  const bits = (m) => {
    const out = [];
    for (let i = 0; m; i++, m >>>= 1) if (m & 1) out.push(i);
    return out;
  };

  // 邻接位掩码：near1[t][i] 为帧 t 斑点 i 在帧 t+1 内可达的女儿掩码；
  // near2[t][i] 为跨一帧漏检后在帧 t+2 内可达的女儿掩码。
  const D2 = maxDist * maxDist;
  const G2 = 4 * D2;
  const near1 = [];
  const near2 = [];
  for (let t = 0; t < F - 1; t++) {
    near1[t] = frames[t].map((s) => {
      let mask = 0;
      frames[t + 1].forEach((q, j) => { if (d2(s, q) <= D2) mask |= 1 << j; });
      return mask;
    });
    if (t < F - 2) {
      near2[t] = frames[t].map((s) => {
        let mask = 0;
        frames[t + 2].forEach((q, j) => { if (d2(s, q) <= G2) mask |= 1 << j; });
        return mask;
      });
    }
  }

  // 各帧「掩码 → 亮度和」预计算
  const maskBright = frames.map((fr) => {
    const arr = new Array(1 << fr.length).fill(0);
    for (let m = 1; m < arr.length; m++) {
      const lsb = m & -m;
      arr[m] = arr[m ^ lsb] + fr[Math.log2(lsb)].b;
    }
    return arr;
  });

  // 每对 (t, 母本) 的保持单女儿掩码列表与分裂双女儿掩码列表
  const keepOpts = [];
  const splitOpts = [];
  for (let t = 0; t < F - 1; t++) {
    keepOpts[t] = near1[t].map((mask) => bits(mask).map((j) => 1 << j));
    splitOpts[t] = near1[t].map((mask) => {
      const js = bits(mask);
      const out = [];
      for (let a = 0; a < js.length; a++) {
        for (let b = a + 1; b < js.length; b++) out.push((1 << js[a]) | (1 << js[b]));
      }
      return out;
    });
  }

  /**
   * 边界 t 的联合转移：存活母本（帧 t）与待补获漏检母本（帧 t-1）
   * 共同在帧 t+1 上安排女儿，并向下传递各支的终帧后代配额。
   * @param {number} liveCode 存活母本配额码（nibAt(liveCode,mi) 为其配额）
   * @param {number} gapCode 待补获漏检母本配额码
   * @returns {Map<number, Int8Array>} key =
   *   ((女儿配额码 * 512 + 女儿掩码) * 512 + 新开漏检母本掩码)；
   *   value 为按女儿序号排列的母本全局序号向量（-1 表示该女儿未被采用）。
   *   同一 key 只保留字典序最小的母本向量。
   */
  const expandMemo = new Map();
  function expand(t, live, gaps, liveCode, gapCode) {
    const key = `${t}|${live}|${gaps}|${liveCode}|${gapCode}`;
    const cached = expandMemo.get(key);
    if (cached) return cached;

    const nChild = sizes[t + 1];
    const liveMoms = bits(live);
    const gapMoms = bits(gaps);
    // dp：转移中间状态键 -> 母本向量
    let dp = new Map([[0, new Int8Array(nChild).fill(-1)]]);

    const put = (map, k, mom) => {
      const old = map.get(k);
      if (old === undefined) { map.set(k, mom); return; }
      for (let j = 0; j < nChild; j++) {
        if (mom[j] !== old[j]) {
          if (mom[j] < old[j]) map.set(k, mom);
          return;
        }
      }
    };
    const decodeKey = (k) => ({
      opened: k % 512,
      used: Math.floor(k / 512) % 512,
      childCode: Math.floor(k / 262144),
    });

    // 1) 待补获漏检母本（帧 t-1）：恰一个跨帧女儿，配额原样单传
    const totalTracks = gapMoms.length + liveMoms.length;
    let processed = 0;
    for (const mi of gapMoms) {
      const gm = gi(t - 1, mi);
      const cap = near2[t - 1][mi];
      const quota = nibAt(gapCode, mi) || WILD;
      const rest = totalTracks - processed - 1; // 尚未处理的母本，至少再贡献 1 支
      const ndp = new Map();
      for (const [state, mom] of dp) {
        const { used, opened, childCode } = decodeKey(state);
        for (const b of bits(cap & ~used)) {
          const bit = 1 << b;
          if (popcnt(used | bit) + popcnt(opened) + rest > target) continue;
          const mom2 = mom.slice();
          mom2[b] = gm;
          put(ndp, (withNib(childCode, b, quota) * 512 + (used | bit)) * 512 + opened, mom2);
        }
      }
      dp = ndp;
      processed++;
    }

    // 2) 存活母本（帧 t）：保持一女 / 分裂两女 / 本帧漏检
    const canOpen = t + 2 <= F - 1;
    for (const mi of liveMoms) {
      const gm = gi(t, mi);
      const miBit = 1 << mi;
      const quota = nibAt(liveCode, mi) || WILD;
      const rest = totalTracks - processed - 1;
      const ndp = new Map();
      for (const [state, mom] of dp) {
        const { used, opened, childCode } = decodeKey(state);

        // 2a) 保持：女儿继承母本配额
        for (const bit of keepOpts[t][mi]) {
          if (used & bit) continue;
          const used2 = used | bit;
          if (popcnt(used2) + popcnt(opened) + rest > target) continue;
          const b = Math.log2(bit);
          const mom2 = mom.slice();
          mom2[b] = gm;
          put(ndp, (withNib(childCode, b, quota) * 512 + used2) * 512 + opened, mom2);
        }
        // 2b) 分裂：两名女儿配额 n1/n2 为正整数、和为母本配额，
        //     差值不得越过平衡限值（关闭复核时仅通配一种分法）。
        for (const pair of splitOpts[t][mi]) {
          if (used & pair) continue;
          const used2 = used | pair;
          if (popcnt(used2) + popcnt(opened) + rest > target) continue;
          const [ba, bb] = bits(pair);
          const mom2 = mom.slice();
          mom2[ba] = gm;
          mom2[bb] = gm;
          if (!balOn) {
            put(ndp, (childCode * 512 + used2) * 512 + opened, mom2);
          } else if (quota >= 2) {
            for (let n1 = 1; n1 < quota; n1++) {
              const n2 = quota - n1;
              if (Math.abs(n1 - n2) > maxDiff) continue;
              const code2 = withNib(withNib(childCode, ba, n1), bb, n2);
              put(ndp, (code2 * 512 + used2) * 512 + opened, mom2);
            }
          }
        }
        // 2c) 本帧漏检（下一帧必须补获）：配额随母本挂到 opened 上
        if (canOpen) {
          const opened2 = opened | miBit;
          if (popcnt(used) + popcnt(opened2) + rest <= target) {
            put(ndp, (childCode * 512 + used) * 512 + opened2, mom);
          }
        }
      }
      dp = ndp;
      processed++;
    }

    expandMemo.set(key, dp);
    return dp;
  }

  const memo = new Map();
  const stateKey = (t, live, gaps, left, liveCode, gapCode) =>
    `${t}|${live}|${gaps}|${left}|${liveCode}|${gapCode}`;

  // 计数增长走廊：从 (live, gaps) 起，每步至多翻倍，漏检补获只能单传，
  // 判断末帧存活数能否达到目标。
  function canReachTarget(t, live, gaps) {
    let co = popcnt(live);
    let cg = popcnt(gaps);
    for (let s = 1; s <= F - 1 - t; s++) {
      co = Math.min(sizes[t + s], 2 * co + cg);
      cg = 0;
    }
    return co >= target;
  }

  // 配额增长上界：帧 t 的存活支还剩 R 次边界转移，至多 2^R 个末帧后代；
  // 待补获漏检支首次转移只能单传，至多 2^(R-1) 个。
  function quotasFeasible(t, liveCode, gapCode, liveCount, gapCount) {
    if (!balOn) return true;
    const R = F - 1 - t;
    const liveMax = 1 << R;
    for (let m = liveCount; m; m &= m - 1) {
      const p = Math.log2(m & -m);
      if (nibAt(liveCode, p) > liveMax) return false;
    }
    if (R >= 1) {
      const gapMax = 1 << (R - 1);
      for (let m = gapCount; m; m &= m - 1) {
        const p = Math.log2(m & -m);
        if (nibAt(gapCode, p) > gapMax) return false;
      }
    }
    return true;
  }

  // 新开漏检母本在次状态中的漏检配额码：配额随母本原样延续
  function openedGapCode(liveCode, opened) {
    let code = 0;
    for (const mi of bits(opened)) code = withNib(code, mi, nibAt(liveCode, mi) || WILD);
    return code;
  }

  // 返回从边界 t 到末帧的最优后缀，不可行返回 null
  function solve(t, live, gaps, left, liveCode, gapCode) {
    const key = stateKey(t, live, gaps, left, liveCode, gapCode);
    if (memo.has(key)) return memo.get(key);

    const count = popcnt(live) + popcnt(gaps);
    if (count > target || left < 0 ||
        !quotasFeasible(t, liveCode, gapCode, live, gaps)) {
      memo.set(key, null);
      return null;
    }
    if (t === F - 1) {
      let okLeaf = gaps === 0 && popcnt(live) === target;
      if (okLeaf && balOn) {
        // 末帧每条存活支恰占 1 个后代；配额和不变 ⇒ 配额必皆为 1
        for (const i of bits(live)) if (nibAt(liveCode, i) !== 1) okLeaf = false;
      }
      const leaf = okLeaf
        ? { bright: 0, skips: 0, frames: [], pick: null, sub: null }
        : null;
      memo.set(key, leaf);
      return leaf;
    }
    if (!canReachTarget(t, live, gaps)) {
      memo.set(key, null);
      return null;
    }

    let best = null;
    for (const [state, mom] of expand(t, live, gaps, liveCode, gapCode)) {
      const opened = state % 512;
      const used = Math.floor(state / 512) % 512;
      const childCode = Math.floor(state / 262144);
      const openCount = popcnt(opened);
      if (openCount > left) continue;

      const sub = solve(t + 1, used, opened, left - openCount,
        childCode, openedGapCode(liveCode, opened));
      if (!sub) continue;

      const usedBits = bits(used);
      const sigFrame = {
        used: usedBits,
        mothers: usedBits.map((j) => mom[j]),
      };
      const cand = {
        bright: maskBright[t + 1][used] + sub.bright,
        skips: openCount + sub.skips,
        frames: [sigFrame, ...sub.frames],
        pick: { t, used, mom },
        sub,
      };
      if (
        !best ||
        cand.bright > best.bright ||
        (cand.bright === best.bright &&
          (cand.skips < best.skips ||
            (cand.skips === best.skips && betterSignature(cand.frames, best.frames))))
      ) {
        best = cand;
      }
    }
    memo.set(key, best);
    return best;
  }

  const rootMask = 1 << startIndex;
  const rootCode = withNib(0, startIndex, balOn ? target : WILD);
  const root = solve(0, rootMask, 0, maxSkip, rootCode, 0);

  if (!root) {
    // 最早断开帧间：逐步前向展开可达状态（含配额传播），以局部必要存活
    // 条件（计数走廊、配额翻倍上界、漏检可达、末帧配额恰为 1）筛选，
    // 找出首个所有后继都无法存活的帧间。
    const viable = (t, live, gaps, left, liveCode, gapCode) => {
      if (left < 0) return false;
      if (popcnt(live) + popcnt(gaps) > target) return false;
      if (!quotasFeasible(t, liveCode, gapCode, live, gaps)) return false;
      if (t === F - 1) {
        if (gaps !== 0 || popcnt(live) !== target) return false;
        if (balOn) {
          for (const i of bits(live)) if (nibAt(liveCode, i) !== 1) return false;
        }
        return true;
      }
      if (!canReachTarget(t, live, gaps)) return false;
      for (const mi of bits(gaps)) {
        if (near2[t - 1][mi] === 0) return false;
      }
      return true;
    };

    let reach = new Map();
    if (viable(0, rootMask, 0, maxSkip, rootCode, 0)) {
      reach.set(`${rootMask}|0|${rootCode}|0`,
        { live: rootMask, gaps: 0, left: maxSkip, liveCode: rootCode, gapCode: 0 });
    }
    let earliest = 0;
    for (let t = 0; t < F - 1; t++) {
      const next = new Map();
      for (const st of reach.values()) {
        for (const state of expand(t, st.live, st.gaps, st.liveCode, st.gapCode).keys()) {
          const opened = state % 512;
          const used = Math.floor(state / 512) % 512;
          const childCode = Math.floor(state / 262144);
          const nleft = st.left - popcnt(opened);
          const gcode = openedGapCode(st.liveCode, opened);
          if (!viable(t + 1, used, opened, nleft, childCode, gcode)) continue;
          const k = `${used}|${opened}|${childCode}|${gcode}`;
          if (!next.has(k)) {
            next.set(k, { live: used, gaps: opened, left: nleft, liveCode: childCode, gapCode: gcode });
          }
        }
      }
      if (next.size === 0) {
        earliest = t;
        break;
      }
      earliest = t + 1;
      reach = next;
    }
    earliest = Math.min(earliest, F - 2);
    return { feasible: false, earliestBreak: { from: earliest, to: earliest + 1 } };
  }

  // 沿最优链重建母女边
  const edges = [];
  let node = root;
  while (node && node.pick) {
    const { t, used, mom } = node.pick;
    for (const j of bits(used)) {
      const g = mom[j];
      const { t: mf, i: mi } = decode(g);
      const gap = mf === t - 1 ? 2 : 1;
      edges.push({
        from: g,
        to: gi(t + 1, j),
        gap,
        dist: Math.sqrt(d2(frames[mf][mi], frames[t + 1][j])),
      });
    }
    node = node.sub;
  }

  const usedPerFrame = Array.from({ length: F }, () => new Set());
  usedPerFrame[0].add(startIndex);
  const childrenOf = new Map();
  for (const e of edges) {
    const { t, i } = decode(e.to);
    usedPerFrame[t].add(i);
    if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
    childrenOf.get(e.from).push(e.to);
  }

  // 终帧后代数：沿完整后代子树（含嵌套分裂与跨帧漏检延续）递归计数
  const leafCache = new Map();
  function leavesOf(g) {
    if (leafCache.has(g)) return leafCache.get(g);
    const { t } = decode(g);
    const kids = childrenOf.get(g) || [];
    const n = t === F - 1 ? 1 : kids.reduce((s, c) => s + leavesOf(c), 0);
    leafCache.set(g, n);
    return n;
  }

  let balanceReport = null;
  if (balOn) {
    const splits = [];
    for (const [g, kids] of childrenOf) {
      if (kids.length !== 2) continue;
      const { t } = decode(g);
      const ns = kids.map(leavesOf);
      splits.push({
        frame: t,
        mother: g,
        daughters: kids
          .map((c, k) => ({ spot: c, leaves: ns[k] }))
          .sort((a, b) => a.spot - b.spot),
        diff: Math.abs(ns[0] - ns[1]),
      });
    }
    splits.sort((a, b) => a.frame - b.frame || a.mother - b.mother);
    balanceReport = { enabled: true, maxDiff, splits };
  }

  return {
    feasible: true,
    root: gi(0, startIndex),
    totalBrightness: frames[0][startIndex].b + root.bright,
    skips: root.skips,
    survivors: target,
    edges,
    usedPerFrame: usedPerFrame.map((s) => [...s].sort((a, b) => a - b)),
    balance: balanceReport,
    _decode: decode,
    _gi: gi,
  };
}

/**
 * 将基于序号的解翻译成带 id 的 JSON 友好结构（页面与测试共用）。
 */
export function presentSolution(spec, result) {
  if (!result.feasible) {
    const out = {
      feasible: false,
      earliestBreak: result.earliestBreak,
      earliestBreakLabel:
        `第 ${result.earliestBreak.from + 1} 帧 → 第 ${result.earliestBreak.to + 1} 帧`,
    };
    if (spec.balance && spec.balance.enabled) {
      out.balance = { enabled: true, maxDiff: spec.balance.maxDiff, splits: [] };
    }
    return out;
  }
  const { frames } = spec;
  const dec = result._decode;
  const childrenOf = new Map();
  const edges = result.edges.map((e) => {
    const mf = dec(e.from);
    const cf = dec(e.to);
    if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
    childrenOf.get(e.from).push(e.to);
    return {
      fromFrame: mf.t,
      fromId: frames[mf.t][mf.i].id,
      toFrame: cf.t,
      toId: frames[cf.t][cf.i].id,
      gap: e.gap,
      dist: Math.round(e.dist * 100) / 100,
    };
  });
  edges.sort((a, b) =>
    a.fromFrame - b.fromFrame ||
    a.toFrame - b.toFrame ||
    String(a.fromId).localeCompare(String(b.fromId)) ||
    String(a.toId).localeCompare(String(b.toId)));

  let divisions = 0;
  for (const list of childrenOf.values()) if (list.length === 2) divisions++;

  const out = {
    feasible: true,
    totalBrightness: result.totalBrightness,
    skips: result.skips,
    survivors: result.survivors,
    divisions,
    counts: result.usedPerFrame.map((s) => s.length),
    used: result.usedPerFrame.map((list, t) => list.map((i) => frames[t][i].id)),
    edges,
  };
  if (result.balance) {
    const nameOf = (g) => {
      const { t, i } = dec(g);
      return frames[t][i].id;
    };
    out.balance = {
      enabled: true,
      maxDiff: result.balance.maxDiff,
      splits: result.balance.splits.map((r) => ({
        frame: r.frame,
        motherId: nameOf(r.mother),
        diff: r.diff,
        daughters: r.daughters.map((d) => {
          const { t, i } = dec(d.spot);
          return { frame: t, id: frames[t][i].id, leaves: d.leaves };
        }),
      })),
    };
  }
  return out;
}
