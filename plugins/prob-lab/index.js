// plugins/prob-lab/index.js
//
// 概率实验室 —— 用可复现的随机试验核对直觉。
//
// 三个标签页：
//   1. 批量统计：分轮跑大量试验，看累积命中率如何收敛到设定概率；
//   2. 一发入魂：每次只抽 1 次、抽很多轮，看看「运气」到底有多离谱；
//   3. 理论分布：精确的二项分布计算，告诉你在同样的参数下「本来应该发生什么」。
//
// 手写 IIFE，不使用构建工具，因此不能写 JSX，全部用 `React.createElement`（简写为 h）。
//
// 只申请一项权限：
//   storage —— 记住三个标签页的输入、置信水平，以及自动生成的随机种子
// 不申请其它任何权限：模拟、统计、二项分布全部是纯数学，在本机内存里完成。
//
// ============================================================
// 六个决定写在最前面
// ============================================================
//
// 1. **随机数必须是可复现的，而且种子要看得见。** 用 crypto 生成一个种子、把它填回
//    种子框，再由 mulberry32 产生序列。留空种子时「结果不可复现」是实验室里最难受的
//    一件事：看到了一个反常的偏差，却没办法再看一遍。因此这里不用 Math.random。
//
// 2. **模拟必须分片执行。** 参考实现按 Rust 的速度允许 20 亿次试验，而 JS 在主线程上
//    跑 2000 万次已经能让人以为界面死了。这里把试验切成约 12ms 一片、用 setTimeout
//    让出主线程，配一条进度条与取消按钮；总次数上限 1 亿，超出时明确报错而不是偷偷截断。
//
// 3. **统计量按定义算，不用「看起来差不多」。** 标准误是 √(p(1−p)/n)，z 是
//    (命中率 − p)/SE，置信区间用正态近似。区间不是「猜一个范围」，它的大小完全由
//    样本量与置信水平决定 —— 界面上把这三个数一起写出来，读者才能判断区间为什么这么宽。
//
// 4. **正态近似有边界，就把它写出来。** 当 n 很小、或 p 贴近 0/1 时，95% 区间会越出
//    [0, 1]（这里做了截断），而「是否落在区间内」的判定会偏乐观。界面与 README 都
//    如实说明，而不是给一个看起来权威的数字。理论分布页的存在正是为了让这件事可查。
//
// 5. **每轮明细的抽样必须说出来。** 轮数可以到 100 万，全画进图里既慢也看不清。
//    超过 2000 轮时按固定步长取样，并在标题、图注与表格说明里写明「每 N 轮取一个点」——
//    抽样却不标注，等于让人把样本当成总体。
//
// 6. **输入错误要指出是哪一格、该怎么改。** 每个字段有自己的错误文案，而不是在底部
//    笼统地写一句「参数不合法」；概率可以带小数与百分号，计数允许千位分隔符。

(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    console.error('[prob-lab] 未找到 window.Modulith，插件无法加载');
    return;
  }

  var React = Modulith.React;
  var h = React.createElement;
  var useEffect = React.useEffect;
  var useMemo = React.useMemo;
  var useRef = React.useRef;
  var useState = React.useState;

  // createContext() 只能在加载期调用，因此在这里取一次并长期持有。
  var ctx = Modulith.createContext();

  // ============================================================
  // 常量
  // ============================================================

  var STORE_SETTINGS = 'settings';
  var STORE_BATCH = 'draft.batch';
  var STORE_SHOT = 'draft.shot';
  var STORE_THEORY = 'draft.theory';

  var SAVE_MS = 500;
  var NOTICE_MS = 5200;

  /** 单次模拟的试验次数上限。再大就该拆成几步跑，而不是让界面等半分钟。 */
  var MAX_TOTAL_TRIALS = 100000000;
  /** 轮数上限。它比总次数更宽松，因为「很多轮、每轮很少次」是看收敛的常用形态。 */
  var MAX_ROUNDS = 1000000;
  /** 理论分布页的 n 上限：精确计算要算 n+1 个概率，5000 已经足够快。 */
  var MAX_THEORY_N = 5000;
  /** 图上最多画多少个点。超过就按步长抽样，并在界面上写明。 */
  var MAX_RECORD_POINTS = 2000;
  /** 一发入魂页最多保留多少次逐次结果（只用于那条顺序带）。 */
  var MAX_OUTCOMES = 5000;
  /** 表格默认显示多少行。 */
  var VISIBLE_ROWS = 100;
  /** 每一片模拟允许占用主线程多久。 */
  var CHUNK_MS = 12;
  /** 内层循环每多少次看一眼时间。太小会拖慢模拟，太大则分片失准。 */
  var TRIALS_CHUNK = 8192;
  /** 种子上限：mulberry32 的状态是 32 位无符号整数。 */
  var SEED_LIMIT = 4294967295;

  var CONFIDENCE_LEVELS = [
    { id: 90, label: '90%', z: 1.6448536269514722 },
    { id: 95, label: '95%', z: 1.959963984540054 },
    { id: 99, label: '99%', z: 2.5758293035489004 },
  ];

  var PROBABILITY_PRESETS = [1, 5, 10, 30, 50, 80, 95];

  var DEFAULT_SETTINGS = { confidence: 95 };
  var DEFAULT_BATCH = { rounds: '10', trials: '1000', prob: '30', seed: '' };
  var DEFAULT_SHOT = { rounds: '1000', prob: '5', seed: '' };
  var DEFAULT_THEORY = { n: '100', k: '50', prob: '50' };

  var TAB_OPTIONS = [
    { id: 'batch', label: '批量统计' },
    { id: 'shot', label: '一发入魂' },
    { id: 'theory', label: '理论分布' },
  ];

  var CHART_VIEWS = [
    { id: 'cumulative', label: '累积命中率' },
    { id: 'perRound', label: '每轮命中率' },
  ];

  var CHART_HEIGHT = 300;
  var THEORY_CHART_HEIGHT = 240;
  var MAX_BARS = 100;

  // ============================================================
  // 数字格式化
  // ============================================================

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function clamp01(value) {
    return clamp(value, 0, 1);
  }

  function roundTo(value, digits) {
    var factor = Math.pow(10, digits);
    return Math.round(value * factor) / factor;
  }

  /** 千位分隔。不用 toLocaleString：它在不同环境下可能给出不同的分隔符。 */
  function groupDigits(text) {
    var parts = String(text).split('.');
    var whole = parts[0];
    var negative = whole.charAt(0) === '-';
    if (negative) whole = whole.slice(1);

    var grouped = '';
    for (var i = 0; i < whole.length; i += 1) {
      var fromEnd = whole.length - i;
      grouped += whole.charAt(i);
      if (fromEnd > 1 && fromEnd % 3 === 1) grouped += ',';
    }

    return (negative ? '-' : '') + grouped + (parts.length > 1 ? '.' + parts[1] : '');
  }

  function fmtInt(value) {
    if (!isFinite(value)) return '—';
    return groupDigits(String(Math.round(value)));
  }

  /** 带千位分隔的定点小数：3000.00 → 3,000.00 */
  function fmtDecimal(value, digits) {
    var places = digits === undefined ? 2 : digits;
    if (!isFinite(value)) return '—';
    return groupDigits(value.toFixed(places));
  }

  function fmtPct(ratio, digits) {
    var places = digits === undefined ? 2 : digits;
    return (ratio * 100).toFixed(places) + '%';
  }

  /** 带符号的小数。接近 0 时显示 0.00 而不是 -0.00。 */
  function fmtSigned(value, digits) {
    var places = digits === undefined ? 2 : digits;
    if (Math.abs(value) < Math.pow(10, -places) / 2) {
      return (0).toFixed(places);
    }
    var text = value.toFixed(places);
    return value > 0 ? '+' + text : text;
  }

  function fmtProb(probability) {
    var value = Number(probability);
    if (!isFinite(value)) return '—';
    if (value <= 0) return '0%';
    if (value >= 1) return '100%';
    if (value < 0.00001) return (value * 100).toExponential(2) + '%';
    if (value < 0.01) return (value * 100).toFixed(4) + '%';
    return (value * 100).toFixed(2) + '%';
  }

  function fmtDuration(ms) {
    if (!isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return Math.round(ms) + ' 毫秒';
    return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' 秒';
  }

  function confidenceLevel(id) {
    for (var i = 0; i < CONFIDENCE_LEVELS.length; i += 1) {
      if (CONFIDENCE_LEVELS[i].id === id) return CONFIDENCE_LEVELS[i];
    }
    return CONFIDENCE_LEVELS[1];
  }

  function confidenceZ(id) {
    return confidenceLevel(id).z;
  }

  function confidenceLabel(id) {
    return confidenceLevel(id).label;
  }

  // ============================================================
  // 输入解析
  //
  // 每个函数返回 { ok: true, value } 或 { ok: false, message }，message 是一句
  // 能照着改的话 —— 字段下面直接显示它。
  // ============================================================

  function readInteger(text, label, min, max) {
    var raw = String(text === undefined || text === null ? '' : text)
      .trim()
      .replace(/,/g, '');

    if (!raw) return { ok: false, message: label + '不能为空。' };
    if (!/^\d+$/.test(raw)) {
      return { ok: false, message: label + '必须是非负整数，只填数字（可以带千位分隔符）。' };
    }

    var value = Number(raw);
    if (!isFinite(value) || value < min) return { ok: false, message: label + '至少是 ' + fmtInt(min) + '。' };
    if (value > max) {
      return { ok: false, message: label + '最多 ' + fmtInt(max) + '（当前 ' + fmtInt(value) + '）。' };
    }

    return { ok: true, value: value };
  }

  function readCount(text, label, max) {
    return readInteger(text, label, 1, max);
  }

  function readProbability(text) {
    var raw = String(text === undefined || text === null ? '' : text)
      .trim()
      .replace(/%$/, '')
      .trim();

    if (!raw) return { ok: false, message: '概率不能为空。' };
    if (!/^\d+(?:\.\d+)?$/.test(raw)) {
      return { ok: false, message: '概率只接受 0 到 100 之间的数字，可以带小数，例如 2.5。' };
    }

    var percent = Number(raw);
    if (!isFinite(percent) || percent < 0 || percent > 100) {
      return { ok: false, message: '概率必须在 0 到 100 之间。' };
    }

    return { ok: true, value: percent / 100, percent: percent };
  }

  /** 种子留空表示「每次随机」，此时 value 为 null */
  function readSeed(text) {
    var raw = String(text === undefined || text === null ? '' : text).trim();
    if (!raw) return { ok: true, value: null };
    if (!/^\d+$/.test(raw)) {
      return { ok: false, message: '种子必须是 0 到 ' + fmtInt(SEED_LIMIT) + ' 之间的整数；留空则每次随机。' };
    }

    var value = Number(raw);
    if (!isFinite(value) || value > SEED_LIMIT) {
      return { ok: false, message: '种子必须是 0 到 ' + fmtInt(SEED_LIMIT) + ' 之间的整数。' };
    }

    return { ok: true, value: value };
  }

  function generateSeed() {
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        var buffer = new Uint32Array(1);
        window.crypto.getRandomValues(buffer);
        return buffer[0] >>> 0;
      }
    } catch (err) {
      // 拿不到 crypto 时退回时间戳 —— 它能用，只是可预测。
    }
    return (Date.now() % 4294967296) >>> 0;
  }

  // ============================================================
  // 随机数与模拟引擎
  //
  // mulberry32：32 位状态、无依赖、速度快、周期足够长（2^32）。它不是密码学安全的
  // 随机数，而这里要的是「可复现的实验」，不是密钥 —— README 里也这么写。
  // ============================================================

  function mulberry32(seed) {
    var state = seed >>> 0;
    return function next() {
      state = (state + 0x6d2b79f5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeStride(rounds) {
    if (rounds <= MAX_RECORD_POINTS) return 1;
    return Math.ceil(rounds / MAX_RECORD_POINTS);
  }

  /**
   * 批量统计的模拟引擎。
   *
   * `step(deadline)` 一直跑到超过 deadline 为止，返回 { done, progress, trialsDone }。
   * 分片在**内层**也成立：每轮次数本身可以是 1 亿，只按轮切会照样卡住 —— 因此内层
   * 每 8192 次就检查一次时间。
   */
  function createBatchEngine(spec) {
    var rng = mulberry32(spec.seed);
    var rounds = spec.rounds;
    var trials = spec.trials;
    var probability = spec.probability;
    var totalTrials = rounds * trials;
    var stride = makeStride(rounds);

    var round = 0;
    var trialInRound = 0;
    var hitsInRound = 0;
    var totalHits = 0;
    var totalMisses = 0;
    var trialsDone = 0;
    var records = [];

    return {
      totalTrials: totalTrials,
      step: function (deadline) {
        while (round < rounds) {
          var remaining = trials - trialInRound;
          var chunk = remaining < TRIALS_CHUNK ? remaining : TRIALS_CHUNK;

          for (var i = 0; i < chunk; i += 1) {
            if (rng() < probability) hitsInRound += 1;
          }

          trialInRound += chunk;
          trialsDone += chunk;

          if (trialInRound === trials) {
            round += 1;
            totalHits += hitsInRound;
            totalMisses += trials - hitsInRound;

            // 只有被抽中的轮次才进 records —— 图上与表上看到的就是这些点，
            // 界面会同时写出抽样步长。
            if (round % stride === 0 || round === rounds) {
              records.push({
                round: round,
                hits: hitsInRound,
                misses: trials - hitsInRound,
                rate: hitsInRound / trials,
                cumulative: totalHits / (round * trials),
              });
            }

            hitsInRound = 0;
            trialInRound = 0;
          }

          if (window.performance && performance.now() >= deadline) {
            return { done: false, progress: trialsDone / totalTrials, trialsDone: trialsDone };
          }
        }

        return { done: true, progress: 1, trialsDone: totalTrials };
      },
      snapshot: function () {
        return {
          totalHits: totalHits,
          totalMisses: totalMisses,
          records: records,
          stride: stride,
          sampled: stride > 1,
        };
      },
    };
  }

  /** 一发入魂：每次只抽 1 次，抽 rounds 轮 */
  function createShotEngine(spec) {
    var rng = mulberry32(spec.seed);
    var total = spec.rounds;
    var probability = spec.probability;
    var hits = 0;
    var trialsDone = 0;
    var keepOutcomes = total <= MAX_OUTCOMES;
    var outcomes = [];

    return {
      totalTrials: total,
      step: function (deadline) {
        while (trialsDone < total) {
          var chunk = total - trialsDone;
          if (chunk > TRIALS_CHUNK) chunk = TRIALS_CHUNK;

          for (var i = 0; i < chunk; i += 1) {
            var hit = rng() < probability;
            if (hit) hits += 1;
            if (keepOutcomes) outcomes.push(hit);
          }

          trialsDone += chunk;

          if (window.performance && performance.now() >= deadline) {
            return { done: false, progress: trialsDone / total, trialsDone: trialsDone };
          }
        }

        return { done: true, progress: 1, trialsDone: total };
      },
      snapshot: function () {
        return {
          hits: hits,
          misses: total - hits,
          outcomes: outcomes,
          outcomesTruncated: !keepOutcomes,
        };
      },
    };
  }

  // ============================================================
  // 统计量
  // ============================================================

  /**
   * 由命中数与设定概率算出全部汇总统计量。
   *
   * 注意 SE 与 z 在 p=0 或 p=1 时是 0：那时不存在「波动」，任何结果都完美符合期望。
   * 这是一种退化情形，不是错误 —— 因此 z 取 0 而不是 NaN，界面照常显示。
   */
  function summarize(n, hits, probability, zcrit) {
    var rate = n > 0 ? hits / n : 0;
    var expected = n * probability;
    var se = Math.sqrt((probability * (1 - probability)) / (n > 0 ? n : 1));
    var z = se > 0 ? (rate - probability) / se : 0;
    var margin = zcrit * se;
    var deviation = hits - expected;

    return {
      n: n,
      hits: hits,
      misses: n - hits,
      rate: rate,
      expected: expected,
      deviation: deviation,
      se: se,
      seHits: Math.sqrt(n * probability * (1 - probability)),
      z: z,
      margin: margin,
      ciLow: Math.max(0, rate - margin),
      ciHigh: Math.min(1, rate + margin),
      withinBand: Math.abs(z) <= zcrit,
    };
  }

  // ============================================================
  // 二项分布
  // ============================================================

  var LANCZOS = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  /** Lanczos 近似的 ln Γ(x)。用对数是为了让 C(5000, 2500) 这种数不溢出。 */
  function logGamma(x) {
    if (x < 0.5) {
      return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    }

    var value = x - 1;
    var series = LANCZOS[0];
    var t = value + 7.5;

    for (var i = 1; i < 9; i += 1) {
      series += LANCZOS[i] / (value + i);
    }

    return 0.5 * Math.log(2 * Math.PI) + (value + 0.5) * Math.log(t) - t + Math.log(series);
  }

  function logFactorial(n) {
    return logGamma(n + 1);
  }

  function binomialPmf(n, k, p) {
    if (k < 0 || k > n) return 0;
    if (p <= 0) return k === 0 ? 1 : 0;
    if (p >= 1) return k === n ? 1 : 0;

    var logPmf =
      logFactorial(n) -
      logFactorial(k) -
      logFactorial(n - k) +
      k * Math.log(p) +
      (n - k) * Math.log(1 - p);

    return Math.exp(logPmf);
  }

  function computeTheory(n, k, p) {
    var table = new Array(n + 1);
    var cumulative = new Array(n + 1);
    var running = 0;
    var maxPmf = 0;

    for (var i = 0; i <= n; i += 1) {
      var pmf = binomialPmf(n, i, p);
      table[i] = pmf;
      running += pmf;
      cumulative[i] = running;
      if (pmf > maxPmf) maxPmf = pmf;
    }

    var mean = n * p;
    var sd = Math.sqrt(n * p * (1 - p));
    var mode = clamp(Math.floor((n + 1) * p), 0, n);
    var atMost = clamp01(cumulative[k]);
    var atLeast = clamp01(k > 0 ? 1 - cumulative[k - 1] : 1);
    var bandLow = clamp(Math.ceil(mean - sd), 0, n);
    var bandHigh = clamp(Math.floor(mean + sd), 0, n);
    var bandProb = clamp01(cumulative[bandHigh] - (bandLow > 0 ? cumulative[bandLow - 1] : 0));

    return {
      n: n,
      k: k,
      p: p,
      table: table,
      cumulative: cumulative,
      maxPmf: maxPmf,
      exact: clamp01(table[k]),
      atMost: atMost,
      atLeast: atLeast,
      mean: mean,
      sd: sd,
      mode: mode,
      bandLow: bandLow,
      bandHigh: bandHigh,
      bandProb: bandProb,
    };
  }

  /**
   * 柱状图要画哪些取值。
   *
   * n 小的时候全画；n 大的时候只画均值附近 ±4σ（再宽就是一片地平线），并且把柱数
   * 压到 100 以内 —— 超过就合并成区间，柱高变成「这一段的总概率」，界面上会写明。
   */
  function theoryBars(theory) {
    var n = theory.n;
    var from;
    var to;

    if (n < MAX_BARS) {
      from = 0;
      to = n;
    } else {
      var half = Math.max(2, Math.ceil(theory.sd * 4));
      from = clamp(Math.floor(theory.mean) - half, 0, n);
      to = clamp(Math.floor(theory.mean) + half, 0, n);

      if (to - from + 1 < 12) {
        from = clamp(theory.mode - 6, 0, n);
        to = clamp(theory.mode + 6, 0, n);
      }
    }

    // k 要尽量落在图里：用户填的那个 k 才是这张图的锚点，把它排除在外，界面上
    // 会看起来像「这个取值没有概率」。但**不能无条件**扩大范围 —— k 离均值极远时
    // （n=5000、p=1% 却问 4000 次），扩到那里会把真正的分布压成左边一根细线，
    // 图就彻底没用了。因此只在「含 k 之后还能画得下」时扩，否则如实说明它不在图内。
    var kVisible = theory.k >= from && theory.k <= to;
    if (!kVisible) {
      var extendedFrom = Math.min(from, theory.k);
      var extendedTo = Math.max(to, theory.k);
      if (extendedTo - extendedFrom + 1 <= 220) {
        from = extendedFrom;
        to = extendedTo;
        kVisible = true;
      }
    }

    var count = to - from + 1;

    if (count <= MAX_BARS) {
      var singles = [];
      for (var k = from; k <= to; k += 1) {
        singles.push({ from: k, to: k, value: theory.table[k], isK: k === theory.k, label: String(k) });
      }
      return {
        from: from,
        to: to,
        bars: singles,
        grouped: false,
        bucket: 1,
        scale: theory.maxPmf,
        kVisible: kVisible,
      };
    }

    var bucket = Math.ceil(count / MAX_BARS);
    var grouped = [];
    var maxGroup = 0;

    for (var start = from; start <= to; start += bucket) {
      var end = Math.min(to, start + bucket - 1);
      var sum = 0;
      for (var j = start; j <= end; j += 1) sum += theory.table[j];
      if (sum > maxGroup) maxGroup = sum;
      grouped.push({
        from: start,
        to: end,
        value: sum,
        isK: theory.k >= start && theory.k <= end,
        label: start === end ? String(start) : start + '–' + end,
      });
    }

    return {
      from: from,
      to: to,
      bars: grouped,
      grouped: true,
      bucket: bucket,
      scale: maxGroup,
      kVisible: kVisible,
    };
  }

  /** 标准正态的双尾概率：P(|Z| > |z|)。用于把「有多罕见」说成一个数。 */
  function normalTwoSided(z) {
    var x = Math.abs(z) / Math.SQRT2;
    var t = 1 / (1 + 0.3275911 * x);
    var poly =
      t *
      (0.254829592 +
        t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    var erf = 1 - poly * Math.exp(-x * x);
    return clamp01(1 - erf);
  }

  // ============================================================
  // 结果构建
  // ============================================================

  function buildBatchResult(spec, snapshot, elapsedMs) {
    var stats = summarize(spec.rounds * spec.trials, snapshot.totalHits, spec.probability, spec.zcrit);
    return {
      spec: spec,
      stats: stats,
      records: snapshot.records,
      stride: snapshot.stride,
      sampled: snapshot.sampled,
      elapsedMs: elapsedMs,
    };
  }

  function buildShotResult(spec, snapshot, elapsedMs) {
    var stats = summarize(spec.rounds, snapshot.hits, spec.probability, spec.zcrit);
    return {
      spec: spec,
      stats: stats,
      outcomes: snapshot.outcomes,
      outcomesTruncated: snapshot.outcomesTruncated,
      elapsedMs: elapsedMs,
    };
  }

  // ============================================================
  // 文案：摘要、CSV、洞察
  // ============================================================

  function batchSummary(result) {
    var spec = result.spec;
    var stats = result.stats;
    var lines = [];

    lines.push('概率实验室 · 批量统计');
    lines.push(
      '参数：' +
        fmtInt(spec.rounds) +
        ' 轮 × 每轮 ' +
        fmtInt(spec.trials) +
        ' 次 = ' +
        fmtInt(stats.n) +
        ' 次，设定概率 ' +
        fmtPct(spec.probability, 2) +
        '，种子 ' +
        spec.seed
    );
    lines.push('结果：命中 ' + fmtInt(stats.hits) + ' 次，未命中 ' + fmtInt(stats.misses) + ' 次');
    lines.push(
      '实际命中率 ' +
        fmtPct(stats.rate, 4) +
        '（理论 ' +
        fmtPct(spec.probability, 2) +
        '，偏差 ' +
        fmtSigned(stats.deviation, 2) +
        ' 次）'
    );
    lines.push('标准误 ' + fmtPct(stats.se, 4) + '，z = ' + fmtSigned(stats.z, 3));
    lines.push(
      confidenceLabel(spec.confidence) +
        ' 置信区间 [' +
        fmtPct(stats.ciLow, 4) +
        ', ' +
        fmtPct(stats.ciHigh, 4) +
        ']'
    );
    lines.push(
      '判定：' +
        (stats.withinBand
          ? '落在正常波动范围内（|z| ≤ ' + spec.zcrit.toFixed(3) + '）'
          : '超出正常波动范围（|z| > ' + spec.zcrit.toFixed(3) + '，约 ' + (100 - spec.confidence) + '% 概率会发生）')
    );
    lines.push('用时 ' + fmtDuration(result.elapsedMs));
    if (result.sampled) {
      lines.push('注：图表与明细按每 ' + fmtInt(result.stride) + ' 轮抽样一次，汇总数字是全量结果。');
    }

    return lines.join('\n');
  }

  function batchCsv(result) {
    var lines = ['轮号,命中,未命中,本轮命中率,累积命中率'];
    for (var i = 0; i < result.records.length; i += 1) {
      var record = result.records[i];
      lines.push(
        [
          record.round,
          record.hits,
          record.misses,
          (record.rate * 100).toFixed(4) + '%',
          (record.cumulative * 100).toFixed(4) + '%',
        ].join(',')
      );
    }
    return lines.join('\n');
  }

  function shotSummary(result) {
    var spec = result.spec;
    var stats = result.stats;
    var lines = [];

    lines.push('概率实验室 · 一发入魂');
    lines.push(
      '参数：抽 ' +
        fmtInt(spec.rounds) +
        ' 次，设定概率 ' +
        fmtPct(spec.probability, 2) +
        '，种子 ' +
        spec.seed
    );
    lines.push('结果：命中 ' + fmtInt(stats.hits) + ' 次，未命中 ' + fmtInt(stats.misses) + ' 次');
    lines.push(
      '实际命中率 ' +
        fmtPct(stats.rate, 4) +
        '（理论 ' +
        fmtPct(spec.probability, 2) +
        '，理论命中 ' +
        fmtDecimal(stats.expected, 2) +
        ' 次）'
    );
    lines.push('标准误 ' + fmtPct(stats.se, 4) + '，z = ' + fmtSigned(stats.z, 3));
    lines.push(
      confidenceLabel(spec.confidence) +
        ' 置信区间 [' +
        fmtPct(stats.ciLow, 4) +
        ', ' +
        fmtPct(stats.ciHigh, 4) +
        ']'
    );
    if (Math.abs(stats.z) > spec.zcrit) {
      lines.push('双尾 p ≈ ' + fmtProb(normalTwoSided(stats.z)) + '：这个偏差在完全随机时也算罕见。');
    } else {
      lines.push('双尾 p ≈ ' + fmtProb(normalTwoSided(stats.z)) + '：仍在正常波动范围内。');
    }
    lines.push('用时 ' + fmtDuration(result.elapsedMs));

    return lines.join('\n');
  }

  function shotInsight(stats, spec) {
    var absolute = Math.abs(stats.z);
    var head;

    if (absolute <= 1) {
      head = '结果几乎压在期望值上，运气平稳得不像运气 —— 这正是大样本下最正常的样子。';
    } else if (absolute <= spec.zcrit) {
      head = '结果落在正常波动范围内，略有起伏，完全符合概率学规律。';
    } else if (stats.z > 0) {
      head = '这次显著高于期望值：小概率事件刚好被你撞上了。';
    } else {
      head = '这次显著低于期望值：运气确实有点背，但这也正是概率的一部分。';
    }

    var detail =
      '在 ' +
      fmtPct(spec.probability, 2) +
      ' 的概率下抽 ' +
      fmtInt(stats.n) +
      ' 次，理论应中 ' +
      fmtDecimal(stats.expected, 1) +
      ' 次，实际中了 ' +
      fmtInt(stats.hits) +
      ' 次。';

    var tail =
      absolute > spec.zcrit
        ? '在完全随机的假设下，出现这么偏（或更偏）的结果概率约为 ' +
          fmtProb(normalTwoSided(stats.z)) +
          '（双尾，正态近似）。'
        : '偏差 ' +
          fmtSigned(stats.deviation, 0) +
          ' 次，处于正常范围内 —— 单看一轮结果判断不了「机制被改过」。';

    return { head: head, detail: detail, tail: tail };
  }

  // ============================================================
  // 通用小工具（React）
  // ============================================================

  /**
   * 量一次容器的像素宽度。图表按真实像素画，而不是靠 viewBox 缩放 ——
   * 缩放会把轴上的小字一起拉变形，而这张图的重点恰好是读数。
   */
  function useElementWidth(initialWidth) {
    var ref = useRef(null);
    var state = useState(initialWidth || 640);
    var width = state[0];
    var setWidth = state[1];

    useEffect(function () {
      var node = ref.current;
      if (!node) return undefined;

      function update() {
        var next = node.clientWidth;
        if (next > 0) setWidth(next);
      }

      update();

      if (typeof window.ResizeObserver === 'function') {
        var observer = new window.ResizeObserver(update);
        observer.observe(node);
        return function () {
          observer.disconnect();
        };
      }

      window.addEventListener('resize', update);
      return function () {
        window.removeEventListener('resize', update);
      };
    }, []);

    return [ref, width];
  }

  function Field(props) {
    return h(
      'div',
      { className: 'problab__field' + (props.className ? ' ' + props.className : '') },
      h('label', { className: 'problab__label', htmlFor: props.htmlFor }, props.label),
      props.children,
      props.error
        ? h('p', { className: 'problab__error', role: 'alert' }, props.error)
        : props.hint
          ? h('p', { className: 'problab__hint' }, props.hint)
          : null
    );
  }

  function TextInput(props) {
    return h('input', {
      id: props.id,
      className:
        'problab__input' +
        (props.mono ? ' problab__input--mono' : '') +
        (props.short ? ' problab__input--short' : ''),
      type: 'text',
      inputMode: props.inputMode || 'numeric',
      autoComplete: 'off',
      spellCheck: false,
      value: props.value,
      placeholder: props.placeholder,
      disabled: props.disabled,
      'aria-invalid': props.invalid ? 'true' : 'false',
      'aria-describedby': props.describedBy,
      onChange: function (event) {
        props.onChange(event.target.value);
      },
    });
  }

  function Segmented(props) {
    return h(
      'div',
      { className: 'problab__segmented', role: 'group', 'aria-label': props.label },
      props.options.map(function (option) {
        var on = option.id === props.value;
        return h(
          'button',
          {
            key: option.id,
            type: 'button',
            className: 'problab__seg' + (on ? ' problab__seg--on' : ''),
            'aria-pressed': on,
            onClick: function () {
              props.onChange(option.id);
            },
          },
          option.label
        );
      })
    );
  }

  function StatGrid(props) {
    return h(
      'div',
      { className: 'problab__stat-grid' },
      props.items.map(function (item) {
        return h(
          'div',
          { className: 'problab__stat', key: item.label },
          h('span', { className: 'problab__stat-label' }, item.label),
          h(
            'span',
            {
              className:
                'problab__stat-value' + (item.tone ? ' problab__stat-value--' + item.tone : ''),
            },
            item.value
          ),
          item.hint ? h('span', { className: 'problab__stat-hint' }, item.hint) : null
        );
      })
    );
  }

  function EmptyState(props) {
    return h(
      'div',
      { className: 'problab__empty' },
      h(
        'svg',
        {
          className: 'problab__empty-icon',
          width: 44,
          height: 44,
          viewBox: '0 0 44 44',
          'aria-hidden': 'true',
        },
        h('circle', {
          cx: 22,
          cy: 22,
          r: 15,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeDasharray: '3 4',
          opacity: 0.55,
        }),
        h('path', {
          d: 'M12 25 L17.5 18 L22 23 L26.5 15 L32 20',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })
      ),
      h('p', { className: 'problab__empty-title' }, props.title),
      h('p', { className: 'problab__empty-hint' }, props.hint)
    );
  }

  function NoticeBar(props) {
    var notice = props.notice;
    var modifier =
      notice.kind === 'warn'
        ? ' problab__notice--warn'
        : notice.kind === 'info'
          ? ' problab__notice--info'
          : '';
    return h(
      'div',
      { className: 'problab__notice' + modifier, role: 'status' },
      h('span', { className: 'problab__notice-text' }, notice.text),
      h(
        'button',
        {
          type: 'button',
          className: 'problab__notice-close',
          'aria-label': '关闭这条提示',
          onClick: props.onClose,
        },
        '关闭'
      )
    );
  }

  function ProgressPanel(props) {
    var percent = clamp01(props.progress) * 100;
    return h(
      'section',
      { className: 'problab__card problab__progress-card', 'aria-live': 'polite' },
      h(
        'div',
        { className: 'problab__progress-head' },
        h(
          'div',
          { className: 'problab__progress-title' },
          h('span', { className: 'problab__pulse', 'aria-hidden': 'true' }),
          h('span', null, '正在模拟 ' + Math.round(percent) + '%')
        ),
        h(
          'button',
          { type: 'button', className: 'problab__button problab__button--small', onClick: props.onCancel },
          '取消'
        )
      ),
      h(
        'div',
        {
          className: 'problab__progress-track',
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': Math.round(percent),
          'aria-label': '模拟进度',
        },
        h('div', { className: 'problab__progress-fill', style: { width: percent.toFixed(1) + '%' } })
      ),
      h(
        'p',
        { className: 'problab__hint' },
        '已完成 ' +
          fmtInt(props.trialsDone) +
          ' / ' +
          fmtInt(props.totalTrials) +
          ' 次试验。模拟分片执行，界面不会卡住，也可以随时取消。'
      )
    );
  }

  // ============================================================
  // 折线图（累积命中率 / 每轮命中率）
  // ============================================================

  function buildLineGeometry(result, view, width) {
    var pad = { left: 50, right: 18, top: 20, bottom: 36 };
    var plotWidth = Math.max(80, width - pad.left - pad.right);
    var plotHeight = CHART_HEIGHT - pad.top - pad.bottom;

    var spec = result.spec;
    var records = result.records || [];
    var probability = spec.probability;
    var trials = spec.trials;
    var rounds = spec.rounds;
    var z = spec.zcrit;

    function seAt(round) {
      var n = round * trials;
      return n > 0 ? Math.sqrt((probability * (1 - probability)) / n) : 0;
    }

    function valueOf(record) {
      return view === 'perRound' ? record.rate : record.cumulative;
    }

    var candidates = [probability];
    for (var i = 0; i < records.length; i += 1) {
      candidates.push(valueOf(records[i]));
      candidates.push(probability - z * seAt(records[i].round));
      candidates.push(probability + z * seAt(records[i].round));
    }

    var min = 1;
    var max = 0;
    for (var c = 0; c < candidates.length; c += 1) {
      if (candidates[c] < min) min = candidates[c];
      if (candidates[c] > max) max = candidates[c];
    }

    var span = max - min;
    if (!isFinite(span) || span <= 0) span = 0.02;

    var yMin = Math.max(0, min - Math.max(span * 0.08, 0.004));
    var yMax = Math.min(1, max + Math.max(span * 0.08, 0.004));

    if (yMax - yMin < 0.01) {
      var middle = (yMin + yMax) / 2;
      yMin = Math.max(0, middle - 0.005);
      yMax = Math.min(1, middle + 0.005);
    }

    function xOf(round) {
      if (rounds <= 1) return pad.left + plotWidth / 2;
      return pad.left + ((round - 1) / (rounds - 1)) * plotWidth;
    }

    function yOf(value) {
      var ratio = (value - yMin) / (yMax - yMin);
      return pad.top + (1 - ratio) * plotHeight;
    }

    function pointText(x, y) {
      return x.toFixed(1) + ' ' + y.toFixed(1);
    }

    var points = [];
    for (var p = 0; p < records.length; p += 1) {
      var record = records[p];
      points.push({ x: xOf(record.round), y: yOf(valueOf(record)), record: record });
    }

    var linePath = '';
    for (var q = 0; q < points.length; q += 1) {
      linePath += (q === 0 ? 'M ' : ' L ') + pointText(points[q].x, points[q].y);
    }

    // 正常波动范围：每轮的标准误不同，因此它不是一条等宽的带子，而是越往后越窄。
    var top = [];
    var bottom = [];
    var samples = 64;
    for (var s = 0; s <= samples; s += 1) {
      var roundAt = rounds <= 1 ? 1 : 1 + (rounds - 1) * (s / samples);
      var margin = z * seAt(roundAt);
      top.push(pointText(xOf(roundAt), yOf(clamp01(probability + margin))));
      bottom.push(pointText(xOf(roundAt), yOf(clamp01(probability - margin))));
    }

    var bandPath = 'M ' + top.join(' L ');
    for (var b = bottom.length - 1; b >= 0; b -= 1) {
      bandPath += ' L ' + bottom[b];
    }
    bandPath += ' Z';

    var yTicks = [];
    var tickDigits = yMax - yMin < 0.02 ? 3 : 2;
    for (var t = 0; t <= 4; t += 1) {
      var tickValue = yMin + (yMax - yMin) * (t / 4);
      yTicks.push({ y: yOf(tickValue), label: fmtPct(tickValue, tickDigits) });
    }

    var xTicks = [];
    var previousLabel = null;
    for (var u = 0; u <= 4; u += 1) {
      var roundLabel = rounds <= 1 ? 1 : Math.round(1 + (rounds - 1) * (u / 4));
      var label = groupDigits(String(roundLabel));
      if (label === previousLabel) continue;
      previousLabel = label;
      xTicks.push({ x: xOf(roundLabel), label: label });
    }

    var lastPoint = points.length > 0 ? points[points.length - 1] : null;
    var finalValue = lastPoint
      ? view === 'perRound'
        ? lastPoint.record.rate
        : lastPoint.record.cumulative
      : probability;

    return {
      width: width,
      pad: pad,
      plotWidth: plotWidth,
      plotHeight: plotHeight,
      points: points,
      linePath: linePath,
      bandPath: bandPath,
      targetY: yOf(probability),
      yTicks: yTicks,
      xTicks: xTicks,
      lastPoint: lastPoint,
      finalValue: finalValue,
      sampled: result.sampled,
      ariaLabel:
        (view === 'perRound' ? '每轮命中率' : '累积命中率收敛图') +
        '：设定概率 ' +
        fmtPct(probability, 2) +
        '，共 ' +
        fmtInt(rounds) +
        ' 轮，最后一点 ' +
        fmtPct(finalValue, 4) +
        '。',
    };
  }

  function LineChart(props) {
    var result = props.result;
    var view = props.view;
    var widthHook = useElementWidth(680);
    var chartRef = widthHook[0];
    var width = widthHook[1];

    var hoverState = useState(-1);
    var hoverIndex = hoverState[0];
    var setHoverIndex = hoverState[1];

    var geometry = useMemo(
      function () {
        return buildLineGeometry(result, view, width);
      },
      [result, view, width]
    );

    function handleMove(event) {
      var rect = event.currentTarget.getBoundingClientRect();
      // 用比例换回 viewBox 坐标：窗口缩放或父级宽度变化时，元素的实际渲染宽度
      // 未必等于 geometry.width（例如首帧还没量到宽度）。
      var scale = rect.width > 0 ? geometry.width / rect.width : 1;
      var x = (event.clientX - rect.left) * scale;
      var best = -1;
      var bestDistance = Infinity;

      for (var i = 0; i < geometry.points.length; i += 1) {
        var distance = Math.abs(geometry.points[i].x - x);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = i;
        }
      }

      setHoverIndex(bestDistance <= 40 ? best : -1);
    }

    function handleLeave() {
      setHoverIndex(-1);
    }

    var children = [];
    children.push(
      h('rect', {
        key: 'plot-bg',
        x: 0,
        y: 0,
        width: geometry.width,
        height: CHART_HEIGHT,
        fill: 'transparent',
      })
    );

    for (var t = 0; t < geometry.yTicks.length; t += 1) {
      var tick = geometry.yTicks[t];
      children.push(
        h('line', {
          key: 'y-grid-' + t,
          className: 'problab__chart-grid',
          x1: geometry.pad.left,
          y1: tick.y,
          x2: geometry.pad.left + geometry.plotWidth,
          y2: tick.y,
        })
      );
      children.push(
        h(
          'text',
          {
            key: 'y-label-' + t,
            className: 'problab__chart-label',
            x: geometry.pad.left - 8,
            y: tick.y + 4,
            textAnchor: 'end',
          },
          tick.label
        )
      );
    }

    for (var v = 0; v < geometry.xTicks.length; v += 1) {
      var xTick = geometry.xTicks[v];
      children.push(
        h('line', {
          key: 'x-tick-' + v,
          className: 'problab__chart-tick',
          x1: xTick.x,
          y1: CHART_HEIGHT - geometry.pad.bottom,
          x2: xTick.x,
          y2: CHART_HEIGHT - geometry.pad.bottom + 4,
        })
      );
      children.push(
        h(
          'text',
          {
            key: 'x-label-' + v,
            className: 'problab__chart-label',
            x: xTick.x,
            y: CHART_HEIGHT - geometry.pad.bottom + 18,
            textAnchor: 'middle',
          },
          xTick.label
        )
      );
    }

    children.push(
      h('line', {
        key: 'x-axis',
        className: 'problab__chart-axis',
        x1: geometry.pad.left,
        y1: CHART_HEIGHT - geometry.pad.bottom,
        x2: geometry.pad.left + geometry.plotWidth,
        y2: CHART_HEIGHT - geometry.pad.bottom,
      })
    );
    children.push(
      h('line', {
        key: 'y-axis',
        className: 'problab__chart-axis',
        x1: geometry.pad.left,
        y1: geometry.pad.top,
        x2: geometry.pad.left,
        y2: CHART_HEIGHT - geometry.pad.bottom,
      })
    );
    children.push(h('path', { key: 'band', className: 'problab__chart-band', d: geometry.bandPath }));
    children.push(
      h('line', {
        key: 'target',
        className: 'problab__chart-target',
        x1: geometry.pad.left,
        y1: geometry.targetY,
        x2: geometry.pad.left + geometry.plotWidth,
        y2: geometry.targetY,
      })
    );

    if (geometry.linePath) {
      children.push(h('path', { key: 'line', className: 'problab__chart-line', d: geometry.linePath }));
    }

    if (geometry.points.length <= 80) {
      for (var d = 0; d < geometry.points.length; d += 1) {
        children.push(
          h('circle', {
            key: 'dot-' + d,
            className: 'problab__chart-dot',
            cx: geometry.points[d].x,
            cy: geometry.points[d].y,
            r: 2.6,
          })
        );
      }
    }

    if (hoverIndex >= 0 && geometry.points[hoverIndex]) {
      var hovered = geometry.points[hoverIndex];
      children.push(
        h('line', {
          key: 'hover-line',
          className: 'problab__chart-hover-line',
          x1: hovered.x,
          y1: geometry.pad.top,
          x2: hovered.x,
          y2: CHART_HEIGHT - geometry.pad.bottom,
        })
      );
      children.push(
        h('circle', {
          key: 'hover-dot',
          className: 'problab__chart-hover-dot',
          cx: hovered.x,
          cy: hovered.y,
          r: 4.2,
        })
      );
    }

    if (geometry.width > 380 && geometry.lastPoint) {
      var labelX = geometry.lastPoint.x + 8;
      var anchor = 'start';
      if (labelX + 62 > geometry.width - 6) {
        labelX = geometry.lastPoint.x - 8;
        anchor = 'end';
      }
      children.push(
        h(
          'text',
          {
            key: 'final-label',
            className: 'problab__chart-final',
            x: labelX,
            y: Math.max(geometry.pad.top + 10, geometry.lastPoint.y - 8),
            textAnchor: anchor,
          },
          fmtPct(geometry.finalValue, 3)
        )
      );
    }

    children.push(h('title', { key: 'title' }, geometry.ariaLabel));

    var tooltip = null;
    if (hoverIndex >= 0 && geometry.points[hoverIndex]) {
      var record = geometry.points[hoverIndex].record;
      var tooltipWidth = 208;
      var left = clamp(geometry.points[hoverIndex].x - tooltipWidth / 2, 6, Math.max(6, geometry.width - tooltipWidth - 6));
      var top = Math.max(6, geometry.points[hoverIndex].y - 118);

      tooltip = h(
        'div',
        {
          className: 'problab__tooltip',
          style: { left: left + 'px', top: top + 'px', width: tooltipWidth + 'px' },
          // 提示跟着鼠标走；无障碍信息由 svg 的 aria-label 与明细表提供，
          // 这里再挂 role="status" 会让屏幕阅读器在指针移动时不停播报。
          'aria-hidden': 'true',
        },
        h(
          'div',
          { className: 'problab__tooltip-title' },
          '第 ' + fmtInt(record.round) + ' 轮' + (result.sampled ? '（抽样）' : '')
        ),
        h(
          'div',
          { className: 'problab__tooltip-row' },
          h('span', null, '累积命中率'),
          h('strong', null, fmtPct(record.cumulative, 4))
        ),
        h(
          'div',
          { className: 'problab__tooltip-row' },
          h('span', null, '本轮命中率'),
          h('strong', null, fmtPct(record.rate, 4))
        ),
        h(
          'div',
          { className: 'problab__tooltip-row' },
          h('span', null, '本轮命中 / 未中'),
          h('strong', null, fmtInt(record.hits) + ' / ' + fmtInt(record.misses))
        ),
        h(
          'div',
          { className: 'problab__tooltip-row' },
          h('span', null, '累计试验'),
          h('strong', null, fmtInt(record.round * result.spec.trials))
        )
      );
    }

    return h(
      'section',
      { className: 'problab__card problab__chart-card' },
      h(
        'div',
        { className: 'problab__card-head' },
        h(
          'div',
          { className: 'problab__card-heading' },
          h('h3', { className: 'problab__card-title' }, view === 'perRound' ? '每轮命中率' : '累积命中率收敛'),
          h(
            'p',
            { className: 'problab__card-note' },
            view === 'perRound'
              ? '每一轮单独的命中率。单轮样本小，抖动本来就大 —— 和那条正常波动范围一起看，才知道「看起来的异常」有多少只是噪声。'
              : '把前面所有试验合起来算的命中率。样本越大越贴近设定概率，那条带状区域就是正常波动范围。'
          )
        ),
        h(Segmented, {
          label: '图表视图',
          options: CHART_VIEWS,
          value: view,
          onChange: props.onViewChange,
        })
      ),
      h(
        'div',
        { className: 'problab__plot', ref: chartRef },
        h(
          'svg',
          {
            className: 'problab__svg',
            width: geometry.width,
            height: CHART_HEIGHT,
            viewBox: '0 0 ' + geometry.width + ' ' + CHART_HEIGHT,
            role: 'img',
            'aria-label': geometry.ariaLabel,
            onPointerMove: handleMove,
            onPointerLeave: handleLeave,
            onClick: handleLeave,
          },
          children
        ),
        tooltip
      ),
      h(
        'div',
        { className: 'problab__legend' },
        h(
          'span',
          { className: 'problab__legend-item' },
          h('span', { className: 'problab__legend-line problab__legend-line--actual' }),
          '实际命中率'
        ),
        h(
          'span',
          { className: 'problab__legend-item' },
          h('span', { className: 'problab__legend-line problab__legend-line--target' }),
          '设定概率 ' + fmtPct(result.spec.probability, 2)
        ),
        h(
          'span',
          { className: 'problab__legend-item' },
          h('span', { className: 'problab__legend-band' }),
          confidenceLabel(result.spec.confidence) + ' 正常波动范围'
        ),
        h('span', { className: 'problab__legend-item problab__muted' }, result.sampled
          ? '每 ' + fmtInt(result.stride) + ' 轮取一个点（共 ' + fmtInt(result.records.length) + ' 个）'
          : '每一轮都画了出来（共 ' + fmtInt(result.records.length) + ' 个）')
      )
    );
  }

  // ============================================================
  // 理论分布柱状图
  // ============================================================

  function TheoryChart(props) {
    var theory = props.theory;
    var widthHook = useElementWidth(680);
    var chartRef = widthHook[0];
    var width = widthHook[1];

    var geometry = useMemo(
      function () {
        return buildTheoryGeometry(theory, width);
      },
      [theory, width]
    );

    var children = [];

    for (var t = 0; t < geometry.yTicks.length; t += 1) {
      var tick = geometry.yTicks[t];
      children.push(
        h('line', {
          key: 'y-grid-' + t,
          className: 'problab__chart-grid',
          x1: geometry.pad.left,
          y1: tick.y,
          x2: geometry.pad.left + geometry.plotWidth,
          y2: tick.y,
        })
      );
      children.push(
        h(
          'text',
          {
            key: 'y-label-' + t,
            className: 'problab__chart-label',
            x: geometry.pad.left - 8,
            y: tick.y + 4,
            textAnchor: 'end',
          },
          tick.label
        )
      );
    }

    for (var b = 0; b < geometry.bars.length; b += 1) {
      var bar = geometry.bars[b];
      children.push(
        h(
          'rect',
          {
            key: 'bar-' + b,
            className: 'problab__theory-bar' + (bar.isK ? ' problab__theory-bar--on' : ''),
            x: bar.x,
            y: bar.y,
            width: bar.width,
            height: bar.height,
          },
          h('title', null, bar.title)
        )
      );
    }

    children.push(
      h('line', {
        key: 'x-axis',
        className: 'problab__chart-axis',
        x1: geometry.pad.left,
        y1: THEORY_CHART_HEIGHT - geometry.pad.bottom,
        x2: geometry.pad.left + geometry.plotWidth,
        y2: THEORY_CHART_HEIGHT - geometry.pad.bottom,
      })
    );

    children.push(
      h(
        'text',
        {
          key: 'x-from',
          className: 'problab__chart-label',
          x: geometry.pad.left,
          y: THEORY_CHART_HEIGHT - geometry.pad.bottom + 18,
          textAnchor: 'start',
        },
        groupDigits(String(geometry.from))
      )
    );
    children.push(
      h(
        'text',
        {
          key: 'x-to',
          className: 'problab__chart-label',
          x: geometry.pad.left + geometry.plotWidth,
          y: THEORY_CHART_HEIGHT - geometry.pad.bottom + 18,
          textAnchor: 'end',
        },
        groupDigits(String(geometry.to))
      )
    );
    children.push(
      h(
        'text',
        {
          key: 'x-title',
          className: 'problab__chart-axis-title',
          x: geometry.pad.left + geometry.plotWidth,
          y: THEORY_CHART_HEIGHT - geometry.pad.bottom + 32,
          textAnchor: 'end',
        },
        '命中次数 k'
      )
    );

    children.push(h('title', { key: 'title' }, geometry.ariaLabel));

    return h(
      'section',
      { className: 'problab__card problab__chart-card' },
      h(
        'div',
        { className: 'problab__card-head' },
        h(
          'div',
          { className: 'problab__card-heading' },
          h('h3', { className: 'problab__card-title' }, '概率分布'),
          h(
            'p',
            { className: 'problab__card-note' },
            (geometry.grouped
              ? '柱高是每一段区间里的总概率（范围太宽，每 ' +
                fmtInt(geometry.bucket) +
                ' 个取值合并成一根柱）；深色那根包含你填的 k。'
              : '每根柱是「恰好命中这么多次」的概率；深色那根就是 k。') +
              (geometry.kVisible
                ? ''
                : ' k = ' +
                  fmtInt(theory.k) +
                  ' 离均值太远，没有画进这张图（P(X = k) = ' +
                  fmtProb(theory.exact) +
                  '）。')
          )
        )
      ),
      h('div', { className: 'problab__plot', ref: chartRef }, h(
        'svg',
        {
          className: 'problab__svg',
          width: geometry.width,
          height: THEORY_CHART_HEIGHT,
          viewBox: '0 0 ' + geometry.width + ' ' + THEORY_CHART_HEIGHT,
          role: 'img',
          'aria-label': geometry.ariaLabel,
        },
        children
      )),
      h(
        'div',
        { className: 'problab__legend' },
        h(
          'span',
          { className: 'problab__legend-item' },
          h('span', { className: 'problab__legend-swatch' }),
          '概率'
        ),
        geometry.kVisible
          ? h(
              'span',
              { className: 'problab__legend-item' },
              h('span', { className: 'problab__legend-swatch problab__legend-swatch--on' }),
              'k = ' + groupDigits(String(theory.k))
            )
          : null,
        h(
          'span',
          { className: 'problab__legend-item problab__muted' },
          '期望 ' + fmtDecimal(theory.mean, 1) + ' 次 · 标准差 ' + fmtDecimal(theory.sd, 2) + ' · 众数 ' + theory.mode
        )
      )
    );
  }

  function buildTheoryGeometry(theory, width) {
    var pad = { left: 54, right: 18, top: 18, bottom: 42 };
    var plotWidth = Math.max(80, width - pad.left - pad.right);
    var plotHeight = THEORY_CHART_HEIGHT - pad.top - pad.bottom;
    var barModel = theoryBars(theory);
    var count = barModel.bars.length;
    var slot = plotWidth / count;
    var gap = count > 60 ? 0.6 : count > 24 ? 1.4 : 2.4;
    var scale = barModel.scale > 0 ? barModel.scale : 1;
    var axisBottom = THEORY_CHART_HEIGHT - pad.bottom;

    var bars = [];
    for (var i = 0; i < count; i += 1) {
      var entry = barModel.bars[i];
      var height = (entry.value / scale) * plotHeight;
      var barWidth = Math.max(1, slot - gap);
      bars.push({
        x: pad.left + i * slot + gap / 2,
        y: axisBottom - height,
        width: barWidth,
        height: height,
        isK: entry.isK,
        title:
          (entry.from === entry.to ? 'k = ' + entry.from : 'k = ' + entry.from + '–' + entry.to) +
          '：' +
          fmtProb(entry.value),
      });
    }

    var yTicks = [];
    for (var t = 0; t <= 2; t += 1) {
      var value = (scale * t) / 2;
      yTicks.push({ y: axisBottom - (value / scale) * plotHeight, label: fmtProb(value) });
    }

    return {
      width: width,
      pad: pad,
      plotWidth: plotWidth,
      bars: bars,
      yTicks: yTicks,
      from: barModel.from,
      to: barModel.to,
      bucket: barModel.bucket,
      grouped: barModel.grouped,
      kVisible: barModel.kVisible,
      ariaLabel:
        '二项分布柱状图：' +
        fmtInt(theory.n) +
        ' 次试验、每次 ' +
        fmtPct(theory.p, 2) +
        '，画了 k 从 ' +
        fmtInt(barModel.from) +
        ' 到 ' +
        fmtInt(barModel.to) +
        ' 的概率。',
    };
  }

  // ============================================================
  // 排序结果带（一发入魂）
  // ============================================================

  function OutcomeStrip(props) {
    var outcomes = props.outcomes || [];

    if (props.outcomesTruncated || outcomes.length === 0) {
      return h(
        'p',
        { className: 'problab__hint' },
        '这次轮次太多，没有保留逐次结果 —— 只保留统计量。想看每一次的命中情况，把轮次降到 ' +
          fmtInt(MAX_OUTCOMES) +
          ' 以内。'
      );
    }

    var visible = outcomes.slice(0, 200);
    var cells = [];
    for (var i = 0; i < visible.length; i += 1) {
      cells.push(
        h('span', {
          key: i,
          className: 'problab__strip-cell' + (visible[i] ? ' problab__strip-cell--hit' : ''),
        })
      );
    }

    return h(
      'div',
      { className: 'problab__strip-wrap' },
      h('div', { className: 'problab__strip', 'aria-hidden': 'true' }, cells),
      h(
        'p',
        { className: 'problab__hint' },
        '按抽取顺序显示前 ' +
          fmtInt(visible.length) +
          ' 次' +
          (props.total > visible.length ? '（共 ' + fmtInt(props.total) + ' 次）' : '') +
          '：实心为命中，空心为未命中。'
      )
    );
  }

  // ============================================================
  // 主组件
  // ============================================================

  function emptyRun() {
    return {
      status: 'idle',
      progress: 0,
      trialsDone: 0,
      spec: null,
      result: null,
      errors: {},
      elapsedMs: 0,
    };
  }

  function coerceText(value, fallback) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && isFinite(value)) return String(value);
    return fallback;
  }

  function normalizeDraft(raw, defaults) {
    var out = {};
    var keys = Object.keys(defaults);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var value = raw && typeof raw === 'object' ? raw[key] : undefined;
      out[key] = coerceText(value, defaults[key]);
    }
    return out;
  }

  function normalizeSettings(raw) {
    var out = { confidence: DEFAULT_SETTINGS.confidence };
    if (raw && typeof raw === 'object') {
      var id = Number(raw.confidence);
      for (var i = 0; i < CONFIDENCE_LEVELS.length; i += 1) {
        if (CONFIDENCE_LEVELS[i].id === id) out.confidence = id;
      }
    }
    return out;
  }

  function ProbLab() {
    var active = Modulith.useModuleActive();

    var tabState = useState('batch');
    var tab = tabState[0];
    var setTab = tabState[1];

    var loadedState = useState(false);
    var loaded = loadedState[0];
    var setLoaded = loadedState[1];

    var batchDraftState = useState(DEFAULT_BATCH);
    var batchDraft = batchDraftState[0];
    var setBatchDraft = batchDraftState[1];

    var shotDraftState = useState(DEFAULT_SHOT);
    var shotDraft = shotDraftState[0];
    var setShotDraft = shotDraftState[1];

    var theoryDraftState = useState(DEFAULT_THEORY);
    var theoryDraft = theoryDraftState[0];
    var setTheoryDraft = theoryDraftState[1];

    var settingsState = useState(DEFAULT_SETTINGS);
    var settings = settingsState[0];
    var setSettings = settingsState[1];

    var noticeState = useState(null);
    var notice = noticeState[0];
    var setNotice = noticeState[1];

    var batchRunState = useState(emptyRun);
    var batchRun = batchRunState[0];
    var setBatchRun = batchRunState[1];

    var shotRunState = useState(emptyRun);
    var shotRun = shotRunState[0];
    var setShotRun = shotRunState[1];

    var chartViewState = useState('cumulative');
    var chartView = chartViewState[0];
    var setChartView = chartViewState[1];

    var tableExpandedState = useState(false);
    var tableExpanded = tableExpandedState[0];
    var setTableExpanded = tableExpandedState[1];

    var timerRef = useRef(0);
    var runningRef = useRef(false);
    var cancelRef = useRef(false);
    /**
     * 每次运行一个递增的编号。
     *
     * 取消之后用户可能立刻再点一次「开始」—— 而上一轮的分片回调可能还排在定时器
     * 队列里。只靠 `runningRef` / `cancelRef` 两个布尔值，旧回调会在新运行开始后
     * 醒来、把旧引擎的结果写进状态。编号对不上就直接退出，是这类竞态最省事的解法。
     */
    var runIdRef = useRef(0);

    // ----------------------------------------------------------
    // 理论分布：输入一改就重算，因此放在 useMemo 里跟随三个输入
    // ----------------------------------------------------------

    var theoryAnalysis = useMemo(
      function () {
        var nRead = readInteger(theoryDraft.n, '试验次数 n', 1, MAX_THEORY_N);
        var pRead = readProbability(theoryDraft.prob);
        var maxK = nRead.ok ? nRead.value : MAX_THEORY_N;
        var kRead = readInteger(theoryDraft.k, '命中次数 k', 0, maxK);

        var errors = {};
        if (!nRead.ok) errors.n = nRead.message;
        if (!pRead.ok) errors.prob = pRead.message;
        if (!kRead.ok) errors.k = kRead.message;

        if (!nRead.ok || !pRead.ok || !kRead.ok) {
          return { errors: errors, theory: null };
        }

        return { errors: {}, theory: computeTheory(nRead.value, kRead.value, pRead.value) };
      },
      [theoryDraft.n, theoryDraft.k, theoryDraft.prob]
    );

    // ----------------------------------------------------------
    // 加载与保存
    // ----------------------------------------------------------

    useEffect(function () {
      var alive = true;

      function fallback(label) {
        return function (err) {
          ctx.logger.warn('读取' + label + '失败', err);
          return null;
        };
      }

      Promise.all([
        ctx.storage.get(STORE_SETTINGS, null).catch(fallback('设置')),
        ctx.storage.get(STORE_BATCH, null).catch(fallback('批量统计参数')),
        ctx.storage.get(STORE_SHOT, null).catch(fallback('一发入魂参数')),
        ctx.storage.get(STORE_THEORY, null).catch(fallback('理论分布参数')),
      ])
        .then(function (values) {
          if (!alive) return;
          setSettings(normalizeSettings(values[0]));
          setBatchDraft(normalizeDraft(values[1], DEFAULT_BATCH));
          setShotDraft(normalizeDraft(values[2], DEFAULT_SHOT));
          setTheoryDraft(normalizeDraft(values[3], DEFAULT_THEORY));
          setLoaded(true);
        })
        .catch(function (err) {
          // 兜底：少了它界面会永远停在「正在准备」。上面每一项都已各自兜过一次，
          // 这里防的是整理数据时出错。
          ctx.logger.error('读取概率实验室的设置时出错，已按默认值继续', err);
          if (alive) setLoaded(true);
        });

      return function () {
        alive = false;
      };
    }, []);

    useEffect(function () {
      if (!loaded) return undefined;
      var timer = setTimeout(function () {
        ctx.storage.set(STORE_SETTINGS, settings).catch(function (err) {
          ctx.logger.warn('保存设置失败', err);
        });
      }, SAVE_MS);
      return function () {
        clearTimeout(timer);
      };
    }, [loaded, settings]);

    useEffect(function () {
      if (!loaded) return undefined;
      var timer = setTimeout(function () {
        ctx.storage.set(STORE_BATCH, batchDraft).catch(function (err) {
          ctx.logger.warn('保存批量统计参数失败', err);
        });
      }, SAVE_MS);
      return function () {
        clearTimeout(timer);
      };
    }, [loaded, batchDraft]);

    useEffect(function () {
      if (!loaded) return undefined;
      var timer = setTimeout(function () {
        ctx.storage.set(STORE_SHOT, shotDraft).catch(function (err) {
          ctx.logger.warn('保存一发入魂参数失败', err);
        });
      }, SAVE_MS);
      return function () {
        clearTimeout(timer);
      };
    }, [loaded, shotDraft]);

    useEffect(function () {
      if (!loaded) return undefined;
      var timer = setTimeout(function () {
        ctx.storage.set(STORE_THEORY, theoryDraft).catch(function (err) {
          ctx.logger.warn('保存理论分布参数失败', err);
        });
      }, SAVE_MS);
      return function () {
        clearTimeout(timer);
      };
    }, [loaded, theoryDraft]);

    // 输入一改就把上一次的字段错误清掉 —— 不然后面填对了，红字还挂着。
    useEffect(function () {
      setBatchRun(function (prev) {
        return Object.keys(prev.errors || {}).length > 0
          ? Object.assign({}, prev, { errors: {} })
          : prev;
      });
    }, [batchDraft]);

    useEffect(function () {
      setShotRun(function (prev) {
        return Object.keys(prev.errors || {}).length > 0
          ? Object.assign({}, prev, { errors: {} })
          : prev;
      });
    }, [shotDraft]);

    useEffect(function () {
      if (!notice) return undefined;
      if (notice.kind === 'warn') return undefined;
      if (!active) return undefined;
      var timer = setTimeout(function () {
        setNotice(null);
      }, NOTICE_MS);
      return function () {
        clearTimeout(timer);
      };
    }, [notice, active]);

    // 组件卸载（插件被禁用、模块被销毁）时停掉可能在跑的模拟。
    useEffect(function () {
      return function () {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = 0;
        runningRef.current = false;
        cancelRef.current = true;
        runIdRef.current += 1;
      };
    }, []);

    // ----------------------------------------------------------
    // 运行
    // ----------------------------------------------------------

    function cancelRun() {
      if (!runningRef.current) return;
      cancelRef.current = true;
      runningRef.current = false;
      runIdRef.current += 1;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = 0;
      }
      setBatchRun(function (prev) {
        return prev.status === 'running' ? emptyRun() : prev;
      });
      setShotRun(function (prev) {
        return prev.status === 'running' ? emptyRun() : prev;
      });
      setNotice({ kind: 'warn', text: '已取消本次模拟（不保留部分结果）。' });
    }

    function startBatch() {
      if (runningRef.current) return;

      var rounds = readCount(batchDraft.rounds, '轮数', MAX_ROUNDS);
      var trials = readCount(batchDraft.trials, '每轮次数', MAX_TOTAL_TRIALS);
      var probability = readProbability(batchDraft.prob);
      var seed = readSeed(batchDraft.seed);

      var errors = {};
      if (!rounds.ok) errors.rounds = rounds.message;
      if (!trials.ok) errors.trials = trials.message;
      if (!probability.ok) errors.prob = probability.message;
      if (!seed.ok) errors.seed = seed.message;

      if (rounds.ok && trials.ok) {
        var total = rounds.value * trials.value;
        if (total > MAX_TOTAL_TRIALS) {
          errors.trials =
            '总试验次数最多 ' +
            fmtInt(MAX_TOTAL_TRIALS) +
            ' 次（当前 ' +
            fmtInt(total) +
            ' 次）。请减少轮数或每轮次数。';
        }
      }

      if (Object.keys(errors).length > 0) {
        setBatchRun(function (prev) {
          return Object.assign({}, prev, { status: 'idle', errors: errors });
        });
        return;
      }

      var seedValue = seed.value;
      var seedWasRandom = seedValue === null;
      if (seedWasRandom) seedValue = generateSeed();

      var spec = {
        rounds: rounds.value,
        trials: trials.value,
        probability: probability.value,
        seed: seedValue,
        confidence: settings.confidence,
        zcrit: confidenceZ(settings.confidence),
      };

      var engine = createBatchEngine(spec);
      var startedAt = window.performance ? performance.now() : Date.now();
      var lastEmit = 0;
      var totalTrials = spec.rounds * spec.trials;

      runningRef.current = true;
      cancelRef.current = false;
      runIdRef.current += 1;
      var runId = runIdRef.current;
      setBatchRun({
        status: 'running',
        progress: 0,
        trialsDone: 0,
        spec: spec,
        result: null,
        errors: {},
        elapsedMs: 0,
      });
      setTableExpanded(false);

      if (seedWasRandom) {
        setBatchDraft(function (prev) {
          return Object.assign({}, prev, { seed: String(seedValue) });
        });
        setNotice({
          kind: 'info',
          text:
            '本次使用随机种子 ' +
            seedValue +
            '（已填回种子框：同一个种子能一字不差地复现这次结果）。',
        });
      }

      function tick() {
        if (runIdRef.current !== runId) return;

        var now = window.performance ? performance.now() : Date.now();
        var step = engine.step(now + CHUNK_MS);
        var after = window.performance ? performance.now() : Date.now();

        if (runIdRef.current !== runId) return;

        if (!step.done) {
          if (after - lastEmit >= 90) {
            lastEmit = after;
            setBatchRun(function (prev) {
              return Object.assign({}, prev, {
                progress: step.progress,
                trialsDone: step.trialsDone,
              });
            });
          }
          timerRef.current = setTimeout(tick, 0);
          return;
        }

        runningRef.current = false;
        timerRef.current = 0;
        var result = buildBatchResult(spec, engine.snapshot(), after - startedAt);
        setBatchRun({
          status: 'done',
          progress: 1,
          trialsDone: totalTrials,
          spec: spec,
          result: result,
          errors: {},
          elapsedMs: result.elapsedMs,
        });
      }

      timerRef.current = setTimeout(tick, 0);
    }

    function startShot() {
      if (runningRef.current) return;

      var rounds = readCount(shotDraft.rounds, '测试轮次', MAX_TOTAL_TRIALS);
      var probability = readProbability(shotDraft.prob);
      var seed = readSeed(shotDraft.seed);

      var errors = {};
      if (!rounds.ok) errors.rounds = rounds.message;
      if (!probability.ok) errors.prob = probability.message;
      if (!seed.ok) errors.seed = seed.message;

      if (Object.keys(errors).length > 0) {
        setShotRun(function (prev) {
          return Object.assign({}, prev, { status: 'idle', errors: errors });
        });
        return;
      }

      var seedValue = seed.value;
      var seedWasRandom = seedValue === null;
      if (seedWasRandom) seedValue = generateSeed();

      var spec = {
        rounds: rounds.value,
        probability: probability.value,
        seed: seedValue,
        confidence: settings.confidence,
        zcrit: confidenceZ(settings.confidence),
      };

      var engine = createShotEngine(spec);
      var startedAt = window.performance ? performance.now() : Date.now();
      var lastEmit = 0;

      runningRef.current = true;
      cancelRef.current = false;
      runIdRef.current += 1;
      var runId = runIdRef.current;
      setShotRun({
        status: 'running',
        progress: 0,
        trialsDone: 0,
        spec: spec,
        result: null,
        errors: {},
        elapsedMs: 0,
      });

      if (seedWasRandom) {
        setShotDraft(function (prev) {
          return Object.assign({}, prev, { seed: String(seedValue) });
        });
        setNotice({
          kind: 'info',
          text:
            '本次使用随机种子 ' +
            seedValue +
            '（已填回种子框：同一个种子能一字不差地复现这次结果）。',
        });
      }

      function tick() {
        if (runIdRef.current !== runId) return;

        var now = window.performance ? performance.now() : Date.now();
        var step = engine.step(now + CHUNK_MS);
        var after = window.performance ? performance.now() : Date.now();

        if (runIdRef.current !== runId) return;

        if (!step.done) {
          if (after - lastEmit >= 90) {
            lastEmit = after;
            setShotRun(function (prev) {
              return Object.assign({}, prev, {
                progress: step.progress,
                trialsDone: step.trialsDone,
              });
            });
          }
          timerRef.current = setTimeout(tick, 0);
          return;
        }

        runningRef.current = false;
        timerRef.current = 0;
        var result = buildShotResult(spec, engine.snapshot(), after - startedAt);
        setShotRun({
          status: 'done',
          progress: 1,
          trialsDone: spec.rounds,
          spec: spec,
          result: result,
          errors: {},
          elapsedMs: result.elapsedMs,
        });
      }

      timerRef.current = setTimeout(tick, 0);
    }

    // 快捷键只在模块可见时生效：窗口级监听器不知道用户此刻在看谁。
    useEffect(
      function () {
        if (!active) return undefined;

        function onKeyDown(event) {
          if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return;
          if (tab !== 'batch' && tab !== 'shot') return;
          event.preventDefault();
          if (tab === 'batch') startBatch();
          else startShot();
        }

        window.addEventListener('keydown', onKeyDown);
        return function () {
          window.removeEventListener('keydown', onKeyDown);
        };
      },
      // startBatch / startShot 是每次渲染重新创建的闭包，依赖里列出的正是它们读到的值
      [active, tab, batchDraft, shotDraft, settings]
    );

    // ----------------------------------------------------------
    // 动作
    // ----------------------------------------------------------

    function copyText(text, label) {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        setNotice({ kind: 'warn', text: '这个环境不允许直接写剪贴板，可以手动选中复制。' });
        return;
      }
      navigator.clipboard.writeText(text).then(
        function () {
          setNotice({ kind: 'success', text: '已复制' + label + '。' });
        },
        function (err) {
          ctx.logger.warn('写剪贴板失败', err);
          setNotice({ kind: 'warn', text: '复制没有成功，可以手动选中复制。' });
        }
      );
    }

    function resetBatch() {
      setBatchDraft(DEFAULT_BATCH);
      setBatchRun(emptyRun());
      setTableExpanded(false);
      setNotice({ kind: 'info', text: '已恢复批量统计的默认参数。' });
    }

    function resetShot() {
      setShotDraft(DEFAULT_SHOT);
      setShotRun(emptyRun());
      setNotice({ kind: 'info', text: '已恢复一发入魂的默认参数。' });
    }

    function resetTheory() {
      setTheoryDraft(DEFAULT_THEORY);
      setNotice({ kind: 'info', text: '已恢复理论分布的默认参数。' });
    }

    function useTheoryForSimulation() {
      var theory = theoryAnalysis.theory;
      if (!theory) return;

      var percentText = String(roundTo(theory.p * 100, 4));
      setBatchDraft(function (prev) {
        return Object.assign({}, prev, {
          rounds: '1',
          trials: String(theory.n),
          prob: percentText,
        });
      });
      setBatchRun(emptyRun());
      setTab('batch');
      setNotice({
        kind: 'info',
        text:
          '已把这组参数填进批量统计（1 轮 × ' +
          fmtInt(theory.n) +
          ' 次，概率 ' +
          percentText +
          '%）—— 点「开始批量实验」看模拟结果。',
      });
    }

    function updateBatch(field, value) {
      setBatchDraft(function (prev) {
        var next = Object.assign({}, prev);
        next[field] = value;
        return next;
      });
    }

    function updateShot(field, value) {
      setShotDraft(function (prev) {
        var next = Object.assign({}, prev);
        next[field] = value;
        return next;
      });
    }

    function updateTheory(field, value) {
      setTheoryDraft(function (prev) {
        var next = Object.assign({}, prev);
        next[field] = value;
        return next;
      });
    }

    function useRandomSeed(setter, field) {
      var seed = String(generateSeed());
      setter(function (prev) {
        var next = Object.assign({}, prev);
        next[field] = seed;
        return next;
      });
    }

    // ----------------------------------------------------------
    // 渲染零件：输入
    // ----------------------------------------------------------

    function renderProbabilityField(options) {
      var chips = PROBABILITY_PRESETS.map(function (preset) {
        var on = Number(options.text) === preset;
        return h(
          'button',
          {
            key: preset,
            type: 'button',
            className: 'problab__chip' + (on ? ' problab__chip--on' : ''),
            'aria-pressed': on,
            onClick: function () {
              options.onChange(String(preset));
            },
          },
          preset + '%'
        );
      });

      return h(
        Field,
        {
          htmlFor: options.id,
          label: options.label,
          hint: options.error ? null : options.hint,
          error: options.error,
          // 概率字段多一行预设 chip。给它两列宽度，七个 chip 才能排成一行 ——
          // 否则它会往高里长，把整条参数区撑得比别的标签页高一倍。
          className: 'problab__field--wide',
        },
        h(
          'div',
          { className: 'problab__input-row' },
          h(TextInput, {
            id: options.id,
            value: options.text,
            placeholder: '30',
            invalid: Boolean(options.error),
            onChange: options.onChange,
          })
        ),
        h('div', { className: 'problab__chips' }, chips)
      );
    }

    function renderSeedField(options) {
      return h(
        Field,
        {
          htmlFor: options.id,
          label: '随机种子',
          hint: options.error ? null : '留空则每次随机；同一种子结果完全一致',
          error: options.error,
        },
        h(
          'div',
          { className: 'problab__input-row' },
          h(TextInput, {
            id: options.id,
            value: options.text,
            placeholder: '留空 = 自动',
            mono: true,
            invalid: Boolean(options.error),
            onChange: options.onChange,
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'problab__button problab__button--icon',
              title: '生成一个随机种子并填入',
              'aria-label': '生成随机种子',
              onClick: options.onRandom,
            },
            h(
              'svg',
              {
                width: 14,
                height: 14,
                viewBox: '0 0 14 14',
                'aria-hidden': 'true',
                className: 'problab__icon',
              },
              h('path', {
                d: 'M2 5.5a4.5 4.5 0 0 1 7.8-2.2M12 8.5a4.5 4.5 0 0 1-7.8 2.2',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
              }),
              h('path', {
                d: 'M9.6 1.2v2.4H12M4.4 12.8v-2.4H2',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              })
            )
          )
        )
      );
    }

    function renderConfidenceField() {
      var options = CONFIDENCE_LEVELS.map(function (level) {
        return h('option', { key: level.id, value: String(level.id) }, level.label + ' 区间');
      });

      return h(
        Field,
        {
          htmlFor: 'problab-confidence',
          label: '置信水平',
          hint: '决定「正常波动」有多宽',
        },
        h(
          'select',
          {
            id: 'problab-confidence',
            className: 'problab__input problab__select',
            value: String(settings.confidence),
            onChange: function (event) {
              var next = Number(event.target.value);
              setSettings(function (prev) {
                return Object.assign({}, prev, { confidence: next });
              });
            },
          },
          options
        )
      );
    }

    function renderRunActions(options) {
      var busy = options.busy;
      return h(
        'div',
        { className: 'problab__actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'problab__button problab__button--primary',
            onClick: options.onStart,
            disabled: busy,
            title: 'Ctrl / Cmd + Enter 也可以运行',
          },
          h(
            'svg',
            {
              width: 13,
              height: 13,
              viewBox: '0 0 14 14',
              'aria-hidden': 'true',
              className: 'problab__icon',
            },
            h('path', { d: 'M3 1.6 12 7 3 12.4Z', fill: 'currentColor' })
          ),
          busy ? '运行中…' : options.label
        ),
        busy
          ? h(
              'button',
              { type: 'button', className: 'problab__button', onClick: cancelRun },
              '取消'
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            className: 'problab__button problab__button--ghost',
            onClick: options.onReset,
            disabled: busy,
          },
          '重置参数'
        )
      );
    }

    // ----------------------------------------------------------
    // 渲染零件：结果
    // ----------------------------------------------------------

    function renderResultHead(options) {
      return h(
        'div',
        { className: 'problab__result-head' },
        h(
          'div',
          null,
          h('h2', { className: 'problab__result-title' }, '本次结果'),
          h('p', { className: 'problab__muted' }, options.meta)
        ),
        h(
          'div',
          { className: 'problab__result-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'problab__button problab__button--small',
              onClick: function () {
                copyText(options.summary, '结果摘要');
              },
            },
            '复制摘要'
          ),
          options.onCopyCsv
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'problab__button problab__button--small',
                  onClick: options.onCopyCsv,
                },
                '复制 CSV'
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'problab__button problab__button--small problab__button--ghost',
              onClick: options.onClear,
            },
            '清空'
          )
        )
      );
    }

    function renderHero(stats, spec) {
      return h(
        'div',
        { className: 'problab__hero' },
        h(
          'div',
          { className: 'problab__hero-main' },
          h('span', { className: 'problab__hero-value' }, fmtPct(stats.rate, 4)),
          h('span', { className: 'problab__hero-label' }, '实际命中率')
        ),
        h(
          'div',
          { className: 'problab__hero-meta' },
          h(
            'div',
            { className: 'problab__hero-row' },
            h('span', { className: 'problab__muted' }, '设定概率'),
            h('strong', null, fmtPct(spec.probability, 2))
          ),
          h(
            'div',
            { className: 'problab__hero-row' },
            h('span', { className: 'problab__muted' }, confidenceLabel(spec.confidence) + ' 置信区间'),
            h(
              'strong',
              null,
              fmtPct(stats.ciLow, 4) + ' – ' + fmtPct(stats.ciHigh, 4)
            )
          ),
          h(
            'span',
            {
              className:
                'problab__pill ' + (stats.withinBand ? 'problab__pill--good' : 'problab__pill--bad'),
            },
            stats.withinBand ? '在正常波动内' : '超出正常波动'
          )
        )
      );
    }

    function renderBatchTable(result) {
      var records = result.records;
      var visible = tableExpanded ? records : records.slice(0, VISIBLE_ROWS);

      var rows = visible.map(function (record) {
        return h(
          'tr',
          { key: record.round },
          h('td', { className: 'problab__cell-num' }, fmtInt(record.round)),
          h('td', { className: 'problab__cell-num' }, fmtInt(record.hits)),
          h('td', { className: 'problab__cell-num' }, fmtInt(record.misses)),
          h('td', { className: 'problab__cell-num' }, fmtPct(record.rate, 4)),
          h('td', { className: 'problab__cell-num' }, fmtPct(record.cumulative, 4))
        );
      });

      var note = result.sampled
        ? '共 ' +
          fmtInt(result.spec.rounds) +
          ' 轮，每 ' +
          fmtInt(result.stride) +
          ' 轮取一条，' +
          fmtInt(result.records.length) +
          ' 条样本；汇总数字是全量结果。'
        : '共 ' + fmtInt(result.spec.rounds) + ' 轮。';

      return h(
        'section',
        { className: 'problab__card' },
        h(
          'div',
          { className: 'problab__card-head' },
          h(
            'div',
            { className: 'problab__card-heading' },
            h('h3', { className: 'problab__card-title' }, '每轮明细'),
            h('p', { className: 'problab__card-note' }, note)
          ),
          records.length > VISIBLE_ROWS
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'problab__button problab__button--small',
                  onClick: function () {
                    setTableExpanded(!tableExpanded);
                  },
                },
                tableExpanded ? '只看前 ' + VISIBLE_ROWS + ' 条' : '显示全部 ' + fmtInt(records.length) + ' 条'
              )
            : null
        ),
        h(
          'div',
          { className: 'problab__table-wrap' },
          h(
            'table',
            { className: 'problab__table' },
            h('caption', { className: 'problab__sr-only' }, '每轮命中、未命中与命中率明细'),
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, '轮号'),
                h('th', { scope: 'col' }, '命中'),
                h('th', { scope: 'col' }, '未命中'),
                h('th', { scope: 'col' }, '本轮命中率'),
                h('th', { scope: 'col' }, '累积命中率')
              )
            ),
            h('tbody', null, rows)
          )
        )
      );
    }

    function renderBatchResult(run) {
      var result = run.result;
      var stats = result.stats;
      var spec = result.spec;

      var meta =
        fmtInt(spec.rounds) +
        ' 轮 × 每轮 ' +
        fmtInt(spec.trials) +
        ' 次 · 设定 ' +
        fmtPct(spec.probability, 2) +
        ' · 种子 ' +
        spec.seed +
        ' · ' +
        confidenceLabel(spec.confidence) +
        ' · 用时 ' +
        fmtDuration(result.elapsedMs);

      var items = [
        {
          label: '总试验次数',
          value: fmtInt(stats.n),
          hint: fmtInt(spec.rounds) + ' 轮 × ' + fmtInt(spec.trials) + ' 次',
        },
        { label: '命中', value: fmtInt(stats.hits) },
        { label: '未命中', value: fmtInt(stats.misses) },
        { label: '理论命中', value: fmtDecimal(stats.expected, 2), hint: 'n × p' },
        {
          label: '偏差',
          value: fmtSigned(stats.deviation, 2) + ' 次',
          hint: '命中 − 理论',
          tone: Math.abs(stats.deviation) > spec.zcrit * stats.seHits ? 'warn' : undefined,
        },
        { label: '标准误 SE', value: fmtPct(stats.se, 4), hint: '√(p(1−p)/n)' },
        {
          label: 'z 分数',
          value: fmtSigned(stats.z, 3),
          hint: '|z| ≤ ' + spec.zcrit.toFixed(3) + ' 视为正常',
          tone: stats.withinBand ? 'good' : 'warn',
        },
        {
          label: '判定',
          value: stats.withinBand ? '正常波动' : '罕见偏差',
          hint: confidenceLabel(spec.confidence) + ' 置信水平',
          tone: stats.withinBand ? 'good' : 'warn',
        },
      ];

      return h(
        'section',
        { className: 'problab__results', 'aria-label': '批量统计结果' },
        renderResultHead({
          meta: meta,
          summary: batchSummary(result),
          onCopyCsv: function () {
            copyText(batchCsv(result), result.sampled ? '抽样明细 CSV' : '每轮明细 CSV');
          },
          onClear: function () {
            setBatchRun(emptyRun());
            setTableExpanded(false);
          },
        }),
        h(
          'div',
          { className: 'problab__card problab__summary' },
          renderHero(stats, spec),
          h(StatGrid, { items: items })
        ),
        h(LineChart, {
          result: result,
          view: chartView,
          onViewChange: setChartView,
        }),
        renderBatchTable(result),
        h(
          'p',
          { className: 'problab__sr-only', 'aria-live': 'polite' },
          '模拟完成：' +
            fmtInt(stats.n) +
            ' 次试验，命中率 ' +
            fmtPct(stats.rate, 4) +
            '，z 分数 ' +
            fmtSigned(stats.z, 3) +
            '。'
        )
      );
    }

    function renderShotResult(run) {
      var result = run.result;
      var stats = result.stats;
      var spec = result.spec;
      var insight = shotInsight(stats, spec);
      var hitRatio = stats.hits / stats.n;
      var missRatio = stats.misses / stats.n;

      var meta =
        '抽 ' +
        fmtInt(spec.rounds) +
        ' 次 · 设定 ' +
        fmtPct(spec.probability, 2) +
        ' · 种子 ' +
        spec.seed +
        ' · ' +
        confidenceLabel(spec.confidence) +
        ' · 用时 ' +
        fmtDuration(result.elapsedMs);

      var items = [
        { label: '测试轮次', value: fmtInt(stats.n), hint: '每次只抽 1 次' },
        { label: '命中次数', value: fmtInt(stats.hits), tone: 'good' },
        { label: '未命中次数', value: fmtInt(stats.misses) },
        { label: '理论命中', value: fmtDecimal(stats.expected, 2), hint: 'n × p' },
        { label: '偏差', value: fmtSigned(stats.deviation, 2) + ' 次', hint: '命中 − 理论' },
        { label: '标准误 SE', value: fmtPct(stats.se, 4), hint: '√(p(1−p)/n)' },
        {
          label: 'z 分数',
          value: fmtSigned(stats.z, 3),
          hint: '|z| ≤ ' + spec.zcrit.toFixed(3) + ' 视为正常',
          tone: stats.withinBand ? 'good' : 'warn',
        },
        {
          label: '双尾 p',
          value: fmtProb(normalTwoSided(stats.z)),
          hint: '正态近似',
        },
      ];

      return h(
        'section',
        { className: 'problab__results', 'aria-label': '一发入魂结果' },
        renderResultHead({
          meta: meta,
          summary: shotSummary(result),
          onClear: function () {
            setShotRun(emptyRun());
          },
        }),
        h(
          'div',
          { className: 'problab__card problab__summary' },
          renderHero(stats, spec),
          h(StatGrid, { items: items })
        ),
        h(
          'section',
          { className: 'problab__card problab__insight-card' },
          h(
            'div',
            { className: 'problab__card-head' },
            h(
              'div',
              { className: 'problab__card-heading' },
              h('h3', { className: 'problab__card-title' }, '这次的手气'),
              h('p', { className: 'problab__card-note' }, '结果本身没有好坏，它只是概率的一次采样。')
            )
          ),
          h('p', { className: 'problab__insight-head' }, insight.head),
          h('p', { className: 'problab__insight-detail' }, insight.detail),
          h('p', { className: 'problab__insight-tail' }, insight.tail)
        ),
        h(
          'section',
          { className: 'problab__card' },
          h(
            'div',
            { className: 'problab__card-head' },
            h(
              'div',
              { className: 'problab__card-heading' },
              h('h3', { className: 'problab__card-title' }, '命中分布'),
              h('p', { className: 'problab__card-note' }, '命中与未命中的占比，以及按顺序的逐次结果。')
            )
          ),
          h(
            'div',
            { className: 'problab__bars' },
            h(
              'div',
              { className: 'problab__bar-row' },
              h('span', { className: 'problab__bar-label' }, '命中'),
              h(
                'div',
                { className: 'problab__bar-track' },
                h('div', {
                  className: 'problab__bar-fill problab__bar-fill--hit',
                  style: { width: (hitRatio * 100).toFixed(2) + '%' },
                })
              ),
              h(
                'span',
                { className: 'problab__bar-value' },
                fmtInt(stats.hits) + ' · ' + fmtPct(hitRatio, 2)
              )
            ),
            h(
              'div',
              { className: 'problab__bar-row' },
              h('span', { className: 'problab__bar-label' }, '未中'),
              h(
                'div',
                { className: 'problab__bar-track' },
                h('div', {
                  className: 'problab__bar-fill problab__bar-fill--miss',
                  style: { width: (missRatio * 100).toFixed(2) + '%' },
                })
              ),
              h(
                'span',
                { className: 'problab__bar-value' },
                fmtInt(stats.misses) + ' · ' + fmtPct(missRatio, 2)
              )
            )
          ),
          h(OutcomeStrip, {
            outcomes: result.outcomes,
            outcomesTruncated: result.outcomesTruncated,
            total: stats.n,
          })
        ),
        h(
          'p',
          { className: 'problab__sr-only', 'aria-live': 'polite' },
          '模拟完成：' +
            fmtInt(stats.n) +
            ' 次抽签，命中 ' +
            fmtInt(stats.hits) +
            ' 次，命中率 ' +
            fmtPct(stats.rate, 4) +
            '。'
        )
      );
    }

    // ----------------------------------------------------------
    // 渲染：三个标签页
    // ----------------------------------------------------------

    function renderBatchTab() {
      var busy = batchRun.status === 'running';
      var errors = batchRun.errors || {};
      var totalTrials = batchRun.spec
        ? batchRun.spec.rounds * batchRun.spec.trials
        : 0;

      return h(
        'div',
        { className: 'problab__pane' },
        h(
          'section',
          { className: 'problab__runbar', 'aria-label': '批量统计参数' },
          h(
            'div',
            { className: 'problab__fields' },
            h(
              Field,
              { htmlFor: 'problab-batch-rounds', label: '轮数', hint: '1 – 1,000,000', error: errors.rounds },
              h(TextInput, {
                id: 'problab-batch-rounds',
                value: batchDraft.rounds,
                placeholder: '10',
                invalid: Boolean(errors.rounds),
                onChange: function (value) {
                  updateBatch('rounds', value);
                },
              })
            ),
            h(
              Field,
              {
                htmlFor: 'problab-batch-trials',
                label: '每轮次数',
                hint: '每轮独立试验的次数',
                error: errors.trials,
              },
              h(TextInput, {
                id: 'problab-batch-trials',
                value: batchDraft.trials,
                placeholder: '1000',
                invalid: Boolean(errors.trials),
                onChange: function (value) {
                  updateBatch('trials', value);
                },
              })
            ),
            renderProbabilityField({
              id: 'problab-batch-prob',
              label: '命中概率 (%)',
              text: batchDraft.prob,
              hint: '0 – 100，可带小数',
              error: errors.prob,
              onChange: function (value) {
                updateBatch('prob', value);
              },
            }),
            renderSeedField({
              id: 'problab-batch-seed',
              text: batchDraft.seed,
              error: errors.seed,
              onChange: function (value) {
                updateBatch('seed', value);
              },
              onRandom: function () {
                useRandomSeed(setBatchDraft, 'seed');
              },
            }),
            renderConfidenceField()
          ),
          renderRunActions({
            busy: busy,
            label: '开始批量实验',
            onStart: startBatch,
            onReset: resetBatch,
          })
        ),
        busy
          ? h(ProgressPanel, {
              progress: batchRun.progress,
              trialsDone: batchRun.trialsDone,
              totalTrials: totalTrials,
              onCancel: cancelRun,
            })
          : batchRun.status === 'done' && batchRun.result
            ? renderBatchResult(batchRun)
            : h(EmptyState, {
                title: '还没有结果',
                hint:
                  '填好参数后点「开始批量实验」（Ctrl / Cmd + Enter 也行）。默认的 10 轮 × 1000 次几毫秒就能跑完；把轮数加大会看到更清楚的收敛。',
              })
      );
    }

    function renderShotTab() {
      var busy = shotRun.status === 'running';
      var errors = shotRun.errors || {};
      var totalTrials = shotRun.spec ? shotRun.spec.rounds : 0;

      return h(
        'div',
        { className: 'problab__pane' },
        h(
          'section',
          { className: 'problab__runbar', 'aria-label': '一发入魂参数' },
          h(
            'div',
            { className: 'problab__fields' },
            h(
              Field,
              {
                htmlFor: 'problab-shot-rounds',
                label: '测试轮次',
                hint: '每次只抽 1 次；1 – 100,000,000',
                error: errors.rounds,
              },
              h(TextInput, {
                id: 'problab-shot-rounds',
                value: shotDraft.rounds,
                placeholder: '1000',
                invalid: Boolean(errors.rounds),
                onChange: function (value) {
                  updateShot('rounds', value);
                },
              })
            ),
            renderProbabilityField({
              id: 'problab-shot-prob',
              label: '命中概率 (%)',
              text: shotDraft.prob,
              hint: '0 – 100，可带小数',
              error: errors.prob,
              onChange: function (value) {
                updateShot('prob', value);
              },
            }),
            renderSeedField({
              id: 'problab-shot-seed',
              text: shotDraft.seed,
              error: errors.seed,
              onChange: function (value) {
                updateShot('seed', value);
              },
              onRandom: function () {
                useRandomSeed(setShotDraft, 'seed');
              },
            }),
            renderConfidenceField()
          ),
          renderRunActions({
            busy: busy,
            label: '一发入魂',
            onStart: startShot,
            onReset: resetShot,
          })
        ),
        busy
          ? h(ProgressPanel, {
              progress: shotRun.progress,
              trialsDone: shotRun.trialsDone,
              totalTrials: totalTrials,
              onCancel: cancelRun,
            })
          : shotRun.status === 'done' && shotRun.result
            ? renderShotResult(shotRun)
            : h(EmptyState, {
                title: '还没有结果',
                hint:
                  '点「一发入魂」开始（Ctrl / Cmd + Enter 也行）：每次只抽一次，抽多少轮由你定。它回答的不是「概率是多少」，而是「这次运气有多偏」。',
              })
      );
    }

    function renderTheoryTab() {
      var theory = theoryAnalysis.theory;
      var errors = theoryAnalysis.errors || {};

      return h(
        'div',
        { className: 'problab__pane' },
        h(
          'section',
          { className: 'problab__runbar', 'aria-label': '理论分布参数' },
          h(
            'div',
            { className: 'problab__fields' },
            h(
              Field,
              { htmlFor: 'problab-theory-n', label: '试验次数 n', hint: '1 – 5,000', error: errors.n },
              h(TextInput, {
                id: 'problab-theory-n',
                value: theoryDraft.n,
                placeholder: '100',
                invalid: Boolean(errors.n),
                onChange: function (value) {
                  updateTheory('n', value);
                },
              })
            ),
            renderProbabilityField({
              id: 'problab-theory-prob',
              label: '命中概率 (%)',
              text: theoryDraft.prob,
              hint: '每次试验的命中概率',
              error: errors.prob,
              onChange: function (value) {
                updateTheory('prob', value);
              },
            }),
            h(
              Field,
              {
                htmlFor: 'problab-theory-k',
                label: '命中次数 k',
                hint: '0 – n',
                error: errors.k,
              },
              h(TextInput, {
                id: 'problab-theory-k',
                value: theoryDraft.k,
                placeholder: '50',
                invalid: Boolean(errors.k),
                onChange: function (value) {
                  updateTheory('k', value);
                },
              })
            )
          ),
          h(
            'div',
            { className: 'problab__actions problab__actions--spread' },
            h(
              'p',
              { className: 'problab__hint problab__hint--inline' },
              '这一页是精确计算：改数字就出结果，不需要运行，也不会因样本大而变慢。'
            ),
            h(
              'div',
              { className: 'problab__actions-buttons' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'problab__button problab__button--primary',
                  onClick: useTheoryForSimulation,
                  disabled: !theory,
                  title: theory ? '把这组参数填进批量统计' : '先填好参数',
                },
                '用这组参数模拟',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'problab__button problab__button--ghost',
                  onClick: resetTheory,
                },
                '重置'
              )
            )
          )
        ),
        theory
          ? h(
              'section',
              { className: 'problab__results', 'aria-label': '理论分布结果' },
              h(
                'div',
                { className: 'problab__result-head' },
                h(
                  'div',
                  null,
                  h('h2', { className: 'problab__result-title' }, '精确计算'),
                  h(
                    'p',
                    { className: 'problab__muted' },
                    theoryMeta(theory)
                  )
                )
              ),
              h(
                'div',
                { className: 'problab__card problab__summary' },
                h(
                  'div',
                  { className: 'problab__hero' },
                  h(
                    'div',
                    { className: 'problab__hero-main' },
                    h('span', { className: 'problab__hero-value' }, fmtProb(theory.atLeast)),
                    h(
                      'span',
                      { className: 'problab__hero-label' },
                      '至少命中 ' + groupDigits(String(theory.k)) + ' 次的概率'
                    )
                  ),
                  h(
                    'div',
                    { className: 'problab__hero-meta' },
                    h(
                      'div',
                      { className: 'problab__hero-row' },
                      h('span', { className: 'problab__muted' }, '恰好 ' + groupDigits(String(theory.k)) + ' 次'),
                      h('strong', null, fmtProb(theory.exact))
                    ),
                    h(
                      'div',
                      { className: 'problab__hero-row' },
                      h('span', { className: 'problab__muted' }, '不超过 ' + groupDigits(String(theory.k)) + ' 次'),
                      h('strong', null, fmtProb(theory.atMost))
                    ),
                    h(
                      'span',
                      { className: 'problab__pill problab__pill--info' },
                      '二项分布 B(' + groupDigits(String(theory.n)) + ', ' + fmtPct(theory.p, 2) + ')'
                    )
                  )
                ),
                h(StatGrid, {
                  items: [
                    {
                      label: '恰好 k 次',
                      value: fmtProb(theory.exact),
                      hint: 'P(X = k)',
                    },
                    {
                      label: '不超过 k 次',
                      value: fmtProb(theory.atMost),
                      hint: 'P(X ≤ k)',
                    },
                    {
                      label: '至少 k 次',
                      value: fmtProb(theory.atLeast),
                      hint: 'P(X ≥ k)',
                    },
                    {
                      label: '期望次数',
                      value: fmtDecimal(theory.mean, 2),
                      hint: 'n × p',
                    },
                    {
                      label: '标准差',
                      value: fmtDecimal(theory.sd, 2),
                      hint: '√(n p (1−p))',
                    },
                    {
                      label: '众数',
                      value: groupDigits(String(theory.mode)),
                      hint: '最可能出现的次数',
                    },
                    {
                      label: '均值 ±1σ',
                      value:
                        groupDigits(String(theory.bandLow)) +
                        ' – ' +
                        groupDigits(String(theory.bandHigh)),
                      hint: '落在其中的概率 ' + fmtProb(theory.bandProb),
                    },
                    {
                      label: '命中率范围',
                      value:
                        fmtPct(theory.bandLow / theory.n, 2) +
                        ' – ' +
                        fmtPct(theory.bandHigh / theory.n, 2),
                      hint: '把次数换成比例',
                    },
                  ],
                })
              ),
              h(TheoryChart, { theory: theory }),
              h(
                'p',
                { className: 'problab__theory-note' },
                '二项分布假设每次试验相互独立、命中概率恒为 p。组合数用对数伽马函数计算，因此 n 到 5,000 也不会溢出；' +
                  '「均值 ±1σ」是整数次数的闭区间，实际覆盖的概率由左侧写明的那个数给出（通常略低于 68%）。'
              )
            )
          : h(EmptyState, {
              title: '参数还不完整',
              hint: '填好上面三格就会立刻算出结果 —— 这一页是精确计算，没有「运行」按钮，也不需要等。',
            })
      );
    }

    function theoryMeta(theory) {
      return (
        'B(' +
        fmtInt(theory.n) +
        ', ' +
        fmtPct(theory.p, 2) +
        ') · 期望 ' +
        fmtDecimal(theory.mean, 2) +
        ' ± ' +
        fmtDecimal(theory.sd, 2) +
        ' · 众数 ' +
        groupDigits(String(theory.mode))
      );
    }

    // ----------------------------------------------------------
    // 顶层渲染
    // ----------------------------------------------------------

    if (!loaded) {
      return h(
        'div',
        { className: 'problab' },
        h('p', { className: 'problab__muted' }, '正在准备概率实验室…')
      );
    }

    return h(
      'div',
      { className: 'problab' },
      h(
        'header',
        { className: 'problab__header' },
        h(
          'div',
          { className: 'problab__header-row' },
          h(
            'div',
            { className: 'problab__heading' },
            h('h1', { className: 'problab__title' }, '概率实验室'),
            h(
              'p',
              { className: 'problab__subtitle' },
              '用可复现的随机试验核对直觉：命中率怎么收敛到设定概率、一次抽签的运气能有多离谱，以及同样的参数下精确的二项分布是什么样。所有计算都在本机完成。'
            )
          ),
          h(Segmented, {
            label: '实验类型',
            options: TAB_OPTIONS,
            value: tab,
            onChange: setTab,
          })
        )
      ),
      notice ? h(NoticeBar, { notice: notice, onClose: function () { setNotice(null); } }) : null,
      h(
        'div',
        { className: 'problab__scroll' },
        tab === 'batch' ? renderBatchTab() : tab === 'shot' ? renderShotTab() : renderTheoryTab()
      ),
      h(
        'footer',
        { className: 'problab__footer' },
        h(
          'span',
          { className: 'problab__muted' },
          'SE = √(p(1−p)/n)；z = (实际命中率 − p) / SE；置信区间用正态近似。n 很小或 p 贴近 0/1 时它偏乐观，可用「理论分布」核对。'
        ),
        h(
          'span',
          { className: 'problab__muted' },
          '随机数来自内置 PRNG（mulberry32），同一种子逐位一致；它不是密码学安全的随机数，不要用它生成密钥。'
        )
      )
    );
  }

  // ============================================================
  // 注册模块
  //
  // 必须在加载期**同步**调用。
  // ============================================================

  Modulith.registerModule({
    id: 'probLab',
    name: '概率实验室',
    displayName: '概率实验室',
    description: '随机试验模拟、单发运气分析、二项分布计算',
    icon: 'icon.svg',
    priority: 88,
    component: ProbLab,
  });

  ctx.logger.info('概率实验室加载完成');
})();
