// 藻类细胞分裂谱系复原核心（纯函数，零依赖，浏览器 / Node 共用）
//
// 模型：
//  - 帧按时刻排列；每帧若干斑点（唯一 id、整数坐标、整数亮度）。
//  - 连接只允许相邻帧（gap=1）或跨越恰好一帧漏检（gap=2）。
//  - 一个细胞要么保持为一个后代，要么分裂为恰两个后代；不允许消亡。
//  - 每个非起始斑点恰有一个祖先（入边），同一斑点不得被两支共用。
//  - 所有存活支必须从起始斑点出发到达末帧，且末帧存活数恰为目标数。
//  - 可选「终端后代平衡复核」：每次分裂的两名女儿各自追溯到末帧的完整后代
//    子树（嵌套分裂计入、跨帧漏检只延续原分支），两侧终帧后代数之差不得
//    超过限值；该约束在联合枚举内同步满足，而非事后过滤。
//  - 裁决顺序：总亮度最高 → 漏检段最少 → 输入顺序（逐帧采用斑点局部序号，
//    再逐斑点母本全局序号）字典序稳定裁决。
//
// 位掩码动态规划：帧内斑点以位掩码表示；边界转移在「已占用女儿掩码 +
// 新开漏检母本掩码」上做内层 DP，同一 (女儿集合, 漏检集合) 只保留字典序最小
// 的母本配对，不展开母亲排列；状态 (帧, 存活掩码, 漏检掩码, 剩余额度) 备忘。

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

  // 终端后代平衡复核：默认关闭；启用时限值为 0 至末帧目标数的非负整数
  // （两侧终帧后代数之和不超过末帧存活数，差值不可能超过 target-1）。
  const balanceEnabled = raw.balanceEnabled === true;
  let balanceLimit = 0;
  if (balanceEnabled) {
    const rawV = raw.balanceLimit;
    const v = Number(rawV);
    if (rawV === null || rawV === undefined || rawV === '' ||
        !Number.isInteger(v) || v < 0 || v > Math.max(0, lastSize - 1)) {
      field('balanceLimit', `终帧后代数最大差值必须为 0 至 ${Math.max(0, lastSize - 1)} 的整数`);
    } else {
      balanceLimit = v;
    }
  }

  if (errors.length) return { errors, spec: null };
  return {
    errors: [],
    spec: { frames, startIndex, maxDist, maxSkip, target, balanceEnabled, balanceLimit },
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

/**
 * 求解谱系。
 *
 * 终端后代平衡复核（spec.balanceEnabled）：后缀备忘除亮度/漏检/顺序外，还携带
 * 「边界上每条根支在末帧的后代叶数」。分裂母本的两名女儿同属转移后的森林之
 * 根，当场即可读出各自完整子树（含嵌套分裂；跨帧漏检仅延续同一根支）的终帧
 * 叶数并比较差值。同一状态不同后缀的叶数分配可能不同，故备忘按「根叶数签
 * 名」各保留裁决最优的一个候选，而不是只存全局最优——平衡约束因此在联合枚举
 * 内部同步生效，绝不事后过滤。
 *
 * @returns {object} 可行时 {feasible:true, ...}；不可行时
 *   {feasible:false, earliestBreak:{from:number,to:number}}
 */
export function solveLineage(spec) {
  const {
    frames, startIndex, maxDist, maxSkip, target,
    balanceEnabled: balOn = false,
    balanceLimit: balLimit = 0,
  } = spec;
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
   * 共同在帧 t+1 上安排女儿。
   * @returns {Map<number, Int8Array>} key = 女儿掩码*512 + 新开漏检母本掩码；
   *   value 为按女儿序号排列的母本全局序号向量（-1 表示该女儿未被采用）。
   *   同一 key 只保留字典序最小的母本向量。
   */
  const expandMemo = new Map();
  function expand(t, live, gaps) {
    const key = (t << 20) | (live << 10) | gaps;
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

    // 1) 待补获漏检母本（帧 t-1）：恰一个跨帧女儿
    const totalTracks = gapMoms.length + liveMoms.length;
    let processed = 0;
    for (const mi of gapMoms) {
      const gm = gi(t - 1, mi);
      const cap = near2[t - 1][mi];
      const rest = totalTracks - processed - 1; // 尚未处理的母本，至少再贡献 1 支
      const ndp = new Map();
      for (const [state, mom] of dp) {
        const used = Math.floor(state / 512);
        for (const b of bits(cap & ~used)) {
          const bit = 1 << b;
          if (popcnt(used | bit) + rest > target) continue;
          const mom2 = mom.slice();
          mom2[b] = gm;
          put(ndp, (used | bit) * 512, mom2);
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
      const rest = totalTracks - processed - 1;
      const ndp = new Map();
      for (const [state, mom] of dp) {
        const used = Math.floor(state / 512);
        const opened = state % 512;

        // 2a) 保持
        for (const bit of keepOpts[t][mi]) {
          if (used & bit) continue;
          const used2 = used | bit;
          if (popcnt(used2) + popcnt(opened) + rest > target) continue;
          const b = Math.log2(bit);
          const mom2 = mom.slice();
          mom2[b] = gm;
          put(ndp, used2 * 512 + opened, mom2);
        }
        // 2b) 分裂
        for (const pair of splitOpts[t][mi]) {
          if (used & pair) continue;
          const used2 = used | pair;
          if (popcnt(used2) + popcnt(opened) + rest > target) continue;
          const mom2 = mom.slice();
          for (const b of bits(pair)) mom2[b] = gm;
          put(ndp, used2 * 512 + opened, mom2);
        }
        // 2c) 本帧漏检（下一帧必须补获）
        if (canOpen) {
          const opened2 = opened | miBit;
          if (popcnt(used) + popcnt(opened2) + rest <= target) {
            put(ndp, used * 512 + opened2, mom);
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
  const stateKey = (t, live, gaps, left) => ((((t * 256 + live) * 256 + gaps) * 8) + left) * 31;

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

  // 返回从边界 t 到末帧的最优后缀，不可行返回 null
  function solve(t, live, gaps, left) {
    const key = stateKey(t, live, gaps, left);
    if (memo.has(key)) return memo.get(key);

    const count = popcnt(live) + popcnt(gaps);
    if (count > target || left < 0) {
      memo.set(key, null);
      return null;
    }
    if (t === F - 1) {
      const leaf = gaps === 0 && popcnt(live) === target
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
    for (const [state, mom] of expand(t, live, gaps)) {
      const used = Math.floor(state / 512);
      const opened = state % 512;
      const openCount = popcnt(opened);
      if (openCount > left) continue;

      const sub = solve(t + 1, used, opened, left - openCount);
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

  // ---- 终端后代平衡复核求解路径 ----
  // 仅当启用且限值确实可能被违反（差值上界为 target-1）时使用；否则原求解
  // 结果天然满足，直接走原路径以保持行为与性能完全一致。
  function createBalancedSolver() {
    const balMemo = new Map();

    // 叶数向量编/解码：每个根支的终帧叶数占 4 bit（根支数 ≤ target ≤ 8）。
    const encodeLeaves = (arr) => {
      let code = 0;
      for (let k = 0; k < arr.length; k++) code |= arr[k] << (4 * k);
      return code;
    };
    const decodeLeaves = (code, nRoots) => {
      const arr = new Array(nRoots);
      for (let p = 0; p < nRoots; p++) arr[p] = (code >>> (4 * p)) & 15;
      return arr;
    };

    // 固定边界 t 的 (live, gaps) 与本帧 (used, opened)、固定后缀候选 sub，
    // 在帧内做联合匹配 DP：逐条轨道（先补获漏检母本、后存活母本）决定女儿，
    // 分裂当场用 sub.leaves 复核两名女儿的终帧叶数差，漏检母本只延续原支。
    // DP 键含「已占用女儿掩码 + 已决定根的叶数前缀编码」——叶数前缀必须入
    // 键，因为同样的占用掩码在不同母本映射下会给后续分裂留下不同的待平衡叶
    // 数；同键只保留字典序最小的母本向量（与 expand 的 put 同理），不展开
    // 母亲排列。
    //
    // 返回 Map：输出根叶数编码（根序：先存活根、后漏检根）→ 最优母本向量。
    const localMemo = new Map();
    function localMatches(t, live, gaps, used, opened, sub) {
      const subCode = encodeLeaves(sub.leaves);
      const lk = `${t}|${live}|${gaps}|${used}|${opened}|${subCode}`;
      const cached = localMemo.get(lk);
      if (cached) return cached;

      const nChild = sizes[t + 1];
      const liveMoms = bits(live);
      const gapMoms = bits(gaps);
      const nRoots = liveMoms.length + gapMoms.length;
      // 女儿在后缀根序（先存活女儿、后新开漏检母本）中的位置
      const daughterPos = new Array(nChild);
      bits(used).forEach((j, p) => { daughterPos[j] = p; });
      const openedPos = new Map();
      bits(opened).forEach((j, p) => openedPos.set(j, p));

      // 轨道按 先漏检补获、后存活 处理；rootPos 为其根叶在根序中的位置
      const tracks = [
        ...gapMoms.map((mi, p) => ({ kind: 'g', mi, rootPos: liveMoms.length + p })),
        ...liveMoms.map((mi, p) => ({ kind: 'o', mi, rootPos: p })),
      ];

      // 键 = '占用掩码.前缀叶数编码'（前缀可达 32 bit，不能位打包）；值 = 母本向量
      let dp = new Map([['0.0', new Int8Array(nChild).fill(-1)]]);
      const keyOf = (claim, prefix) => `${claim}.${prefix}`;
      const parse = (state) => {
        const dot = state.indexOf('.');
        return { claim: Number(state.slice(0, dot)), prefix: Number(state.slice(dot + 1)) };
      };
      const put = (map, claim, prefix, mom) => {
        const k = keyOf(claim, prefix);
        const old = map.get(k);
        if (!old) { map.set(k, mom); return; }
        for (let j = 0; j < nChild; j++) {
          if (mom[j] !== old[j]) {
            if (mom[j] < old[j]) map.set(k, mom);
            return;
          }
        }
      };

      for (const tr of tracks) {
        const ndp = new Map();
        const gm = gi(tr.kind === 'g' ? t - 1 : t, tr.mi);
        const shift = 4 * tr.rootPos;
        const setRoot = (code, leaf) => code | (leaf << shift);

        if (tr.kind === 'g') {
          // 待补获漏检母本：恰一个跨帧女儿，且该女儿必须在本帧 used 内
          for (const [state, mom0] of dp) {
            const { claim, prefix } = parse(state);
            for (const b of bits(near2[t - 1][tr.mi] & used & ~claim)) {
              const mom = mom0.slice();
              mom[b] = gm;
              put(ndp, claim | (1 << b), setRoot(prefix, sub.leaves[daughterPos[b]]), mom);
            }
          }
        } else if (opened & (1 << tr.mi)) {
          // 本帧新开漏检：无女儿，只延续原根支
          const leaf = sub.leaves[bits(used).length + openedPos.get(tr.mi)];
          for (const [state, mom0] of dp) {
            const { claim, prefix } = parse(state);
            put(ndp, claim, setRoot(prefix, leaf), mom0);
          }
        } else {
          for (const [state, mom0] of dp) {
            const { claim, prefix } = parse(state);
            // 保持一女（必须落在 used 内）
            for (const bit of keepOpts[t][tr.mi]) {
              if (!(used & bit) || (claim & bit)) continue;
              const b = Math.log2(bit);
              const mom = mom0.slice();
              mom[b] = gm;
              put(ndp, claim | bit, setRoot(prefix, sub.leaves[daughterPos[b]]), mom);
            }
            // 分裂两女：当场复核两侧终帧叶数差
            for (const pair of splitOpts[t][tr.mi]) {
              if ((~used & pair) || (claim & pair)) continue;
              const [a, c] = bits(pair);
              const la = sub.leaves[daughterPos[a]];
              const lc = sub.leaves[daughterPos[c]];
              if (Math.abs(la - lc) > balLimit) continue;
              const mom = mom0.slice();
              mom[a] = gm;
              mom[c] = gm;
              put(ndp, claim | pair, setRoot(prefix, la + lc), mom);
            }
          }
        }
        dp = ndp;
      }

      const out = new Map();
      for (const [state, mom] of dp) {
        const { claim, prefix } = parse(state);
        if (claim !== used) continue;
        let ok = true;
        for (let p = 0; p < nRoots; p++) {
          if (((prefix >>> (4 * p)) & 15) === 0) { ok = false; break; }
        }
        if (ok) out.set(prefix, mom);
      }
      localMemo.set(lk, out);
      return out;
    }

    // 返回 叶数编码 → 最优候选 的映射；空映射表示该状态无平衡可行后缀。
    function candidates(t, live, gaps, left) {
      const key = stateKey(t, live, gaps, left);
      const cached = balMemo.get(key);
      if (cached) return cached;

      const res = new Map();
      const fail = () => { balMemo.set(key, res); return res; };
      if (left < 0 || popcnt(live) + popcnt(gaps) > target) return fail();
      if (t === F - 1) {
        if (gaps === 0 && popcnt(live) === target) {
          const leaf = {
            bright: 0, skips: 0, frames: [], leaves: bits(live).map(() => 1),
            pick: null, sub: null,
          };
          res.set(encodeLeaves(leaf.leaves), leaf);
        }
        balMemo.set(key, res);
        return res;
      }
      if (!canReachTarget(t, live, gaps)) return fail();

      const nRoots = popcnt(live) + popcnt(gaps);
      // (used, opened) 状态空间与原求解器完全一致；平衡只改变配对可行性。
      for (const state of expand(t, live, gaps).keys()) {
        const used = Math.floor(state / 512);
        const opened = state % 512;
        const openCount = popcnt(opened);
        if (openCount > left) continue;
        const subMap = candidates(t + 1, used, opened, left - openCount);
        if (subMap.size === 0) continue;
        const usedBits = bits(used);

        for (const sub of subMap.values()) {
          for (const [leafCode, mom] of localMatches(t, live, gaps, used, opened, sub)) {
            const sigFrame = { used: usedBits, mothers: usedBits.map((j) => mom[j]) };
            const cand = {
              bright: maskBright[t + 1][used] + sub.bright,
              skips: openCount + sub.skips,
              frames: [sigFrame, ...sub.frames],
              leaves: decodeLeaves(leafCode, nRoots),
              pick: { t, used, opened, mom },
              sub,
            };
            const old = res.get(leafCode);
            if (
              !old ||
              cand.bright > old.bright ||
              (cand.bright === old.bright &&
                (cand.skips < old.skips ||
                  (cand.skips === old.skips && betterSignature(cand.frames, old.frames))))
            ) {
              res.set(leafCode, cand);
            }
          }
        }
      }

      balMemo.set(key, res);
      return res;
    }

    // 从候选映射中按总亮度/漏检/输入顺序选出全局最优
    function bestOf(map) {
      let best = null;
      for (const cand of map.values()) {
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
      return best;
    }

    // 不可行时定位最早断开帧间：只沿「存在平衡完成后缀」的状态向末帧推进，
    // 首个无法跨到任何平衡可行后继状态的边界即为断点。
    function earliestBreak() {
      let reach = new Map([[(rootMask << 10) | 0,
        { live: rootMask, gaps: 0, left: maxSkip }]]);
      let earliest = 0;
      for (let t = 0; t < F - 1; t++) {
        const next = new Map();
        for (const st of reach.values()) {
          for (const state of expand(t, st.live, st.gaps).keys()) {
            const used = Math.floor(state / 512);
            const opened = state % 512;
            const nleft = st.left - popcnt(opened);
            if (candidates(t + 1, used, opened, nleft).size === 0) continue;
            const k = (used << 10) | opened;
            if (!next.has(k)) next.set(k, { live: used, gaps: opened, left: nleft });
          }
        }
        if (next.size === 0) { earliest = t; break; }
        earliest = t + 1;
        reach = next;
      }
      earliest = Math.min(earliest, F - 2);
      return { from: earliest, to: earliest + 1 };
    }

    return { candidates, bestOf, earliestBreak };
  }

  let root = null;
  let balancedMode = false;
  let balSolver = null;
  // 两名女儿各至少 1 片终帧叶，差值上界为 target-2；限值不小于 target-1 时
  // 约束不可能被违反（target=1 时根本不存在可行分裂），直接走原路径。
  if (balOn && target >= 2 && balLimit <= target - 2) {
    balancedMode = true;
    balSolver = createBalancedSolver();
    root = balSolver.bestOf(balSolver.candidates(0, rootMask, 0, maxSkip));
  } else {
    root = solve(0, rootMask, 0, maxSkip);
  }

  if (!root) {
    if (balancedMode) {
      // 平衡模式：沿「存在平衡完成后缀」的状态前向推进定位最早断帧；
      // 平衡是全局约束，无可平衡谱系时首帧间即为断点。
      const eb = balSolver.earliestBreak();
      return { feasible: false, earliestBreak: eb };
    }
    // 最早断开帧间：逐步前向展开可达状态，以局部必要存活条件（计数走廊、
    // 漏检必须在补获帧有可达斑点、末帧计数恰为目标）筛选，找出首个
    // 所有后继都无法存活的帧间。
    const viable = (t, live, gaps, left) => {
      if (left < 0) return false;
      if (popcnt(live) + popcnt(gaps) > target) return false;
      if (t === F - 1) return gaps === 0 && popcnt(live) === target;
      if (!canReachTarget(t, live, gaps)) return false;
      if (t >= 1) {
        for (const mi of bits(gaps)) {
          if (near2[t - 1][mi] === 0) return false;
        }
      }
      return true;
    };

    let reach = new Map();
    if (viable(0, rootMask, 0, maxSkip)) {
      reach.set(0, { live: rootMask, gaps: 0, left: maxSkip });
    }
    let earliest = 0;
    for (let t = 0; t < F - 1; t++) {
      const next = new Map();
      for (const st of reach.values()) {
        for (const state of expand(t, st.live, st.gaps).keys()) {
          const used = Math.floor(state / 512);
          const opened = state % 512;
          const nleft = st.left - popcnt(opened);
          if (!viable(t + 1, used, opened, nleft)) continue;
          const k = (used << 10) | opened;
          if (!next.has(k)) next.set(k, { live: used, gaps: opened, left: nleft });
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
  for (const e of edges) {
    const { t, i } = decode(e.to);
    usedPerFrame[t].add(i);
  }

  return {
    feasible: true,
    root: gi(0, startIndex),
    totalBrightness: frames[0][startIndex].b + root.bright,
    skips: root.skips,
    survivors: target,
    edges,
    usedPerFrame: usedPerFrame.map((s) => [...s].sort((a, b) => a - b)),
    _decode: decode,
    _gi: gi,
  };
}

/**
 * 将基于序号的解翻译成带 id 的 JSON 友好结构（页面与测试共用）。
 */
export function presentSolution(spec, result) {
  if (!result.feasible) {
    return {
      feasible: false,
      earliestBreak: result.earliestBreak,
      earliestBreakLabel:
        `第 ${result.earliestBreak.from + 1} 帧 → 第 ${result.earliestBreak.to + 1} 帧`,
      balanceEnabled: spec.balanceEnabled === true,
      balanceLimit: spec.balanceEnabled === true ? spec.balanceLimit : null,
    };
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

  // 每次分裂：两名女儿各自追溯到末帧的完整后代叶数（嵌套分裂计入其女儿
  // 子树；跨帧漏检只延续同一支）。按分裂帧、母本输入序号、女儿序号排列。
  const divisionDetails = [];
  if (divisions > 0) {
    const lastT = frames.length - 1;
    const childMap = new Map(); // '帧:编号' → 女儿键列表
    for (const e of edges) {
      const k = `${e.fromFrame}:${e.fromId}`;
      if (!childMap.has(k)) childMap.set(k, []);
      childMap.get(k).push(`${e.toFrame}:${e.toId}`);
    }
    const splitKey = (key) => {
      const p = key.indexOf(':');
      return { frame: Number(key.slice(0, p)), id: key.slice(p + 1) };
    };
    const leafMemo = new Map();
    const leafCount = (key) => {
      if (leafMemo.has(key)) return leafMemo.get(key);
      const { frame } = splitKey(key);
      const n = frame === lastT
        ? 1
        : (childMap.get(key) || []).reduce((acc, k2) => acc + leafCount(k2), 0);
      leafMemo.set(key, n);
      return n;
    };
    const seenMothers = new Set();
    for (const e of edges) {
      const k = `${e.fromFrame}:${e.fromId}`;
      const kids = childMap.get(k) || [];
      if (kids.length !== 2 || seenMothers.has(k)) continue;
      seenMothers.add(k);
      const daughterObjs = kids.map((dk) => ({ ...splitKey(dk), terminalLeaves: leafCount(dk) }))
        .sort((a, b) =>
          a.frame - b.frame ||
          frames[a.frame].findIndex((s) => s.id === a.id) -
            frames[b.frame].findIndex((s) => s.id === b.id) ||
          String(a.id).localeCompare(String(b.id)));
      divisionDetails.push({
        frame: e.fromFrame,
        motherId: e.fromId,
        daughters: daughterObjs,
        leafDiff: Math.abs(daughterObjs[0].terminalLeaves - daughterObjs[1].terminalLeaves),
      });
    }
    divisionDetails.sort((a, b) =>
      a.frame - b.frame ||
      frames[a.frame].findIndex((s) => s.id === a.motherId) -
        frames[b.frame].findIndex((s) => s.id === b.motherId) ||
      String(a.motherId).localeCompare(String(b.motherId)));
  }

  return {
    feasible: true,
    totalBrightness: result.totalBrightness,
    skips: result.skips,
    survivors: result.survivors,
    divisions,
    divisionDetails,
    balanceEnabled: spec.balanceEnabled === true,
    balanceLimit: spec.balanceEnabled === true ? spec.balanceLimit : null,
    counts: result.usedPerFrame.map((s) => s.length),
    used: result.usedPerFrame.map((list, t) => list.map((i) => frames[t][i].id)),
    edges,
  };
}
