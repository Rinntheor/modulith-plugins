// plugins/typing-practice/index.js
//
// 打字练习 —— 逐字符判定的练习器：中英文语料可选，实时速度与准确率，历史走势、错字分析，
// 以及可选的合成音效。
//
// 手写 IIFE，不使用构建工具，因此不能写 JSX，全部用 `React.createElement`（简写为 h）。
//
// 只申请一项权限：
//   storage —— 练习记录、统计摘要、自定义文本与设置都写在插件自己的私有存储里
// 不申请 network（语料内置，自定义文本由用户粘贴或从本机文本文件导入）、
// 不申请 filesystem-read（导入走浏览器自己的文件选择框）、不申请 notification（结果就地显示）。
//
// 实现上的几点说明，写在最前面免得被误认成疏忽：
//
// 1. 输入由 <textarea> 承载，**不是**自己监听全局 keydown 拼字符串。那样会丢掉输入法、
//    粘贴、退格与选区替换，中文语料直接无法练习。练习文本画在 textarea 底下的一层里，
//    textarea 自身的文字保持完全透明 —— 于是「光标、选区、滚轮、输入法候选框」全都由
//    浏览器原生处理，我们只负责给下面那层上色。两层共用同一套字体与行高，因此位置严格对齐。
//
// 2. **显示与判定必须用同一份文本。** 语料里的换行在排版时被当作词间空格（见 toWords），
//    因此判定也必须拿「换行已折成空格」的那一份去比。曾经拿原始文本（含 \n）去比，
//    结果是：打空格判错、段落末尾永远打不完。这是本插件最容易犯的错，所以只留一个来源。
//
// 3. 打字过程中**不重算整篇文本的排版**：字符层按行 memo 过，只有发生变化的行重渲染；
//    计时用 100ms 的低频 tick，且计时与统计条各自订阅状态，不牵动打字区。
//
// 4. 音效是 WebAudio 现场合成的短促脉冲，**不打包任何音频文件**，默认音量为 0（静音）。

(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    console.error('[typing-practice] 未找到 window.Modulith，插件无法加载');
    return;
  }

  var React = Modulith.React;
  var h = React.createElement;
  var memo = React.memo;
  var useEffect = React.useEffect;
  var useMemo = React.useMemo;
  var useRef = React.useRef;
  var useState = React.useState;
  var useSyncExternalStore = React.useSyncExternalStore;

  // createContext() 只能在加载期调用，因此在这里取一次并长期持有。
  var ctx = Modulith.createContext();

  /** 存储键。只允许字母数字与 . _ -，最长 128 字符 */
  var KEY_SETTINGS = 'settings';
  var KEY_STATS = 'stats';
  var KEY_ANALYSIS = 'analysis';
  var KEY_CUSTOM_ACTIVE = 'custom.text'; // 当前使用中的自定义文本
  var KEY_CUSTOM_INDEX = 'custom.list'; // 自定义文本索引（名字、字数、时间）
  var RECORD_PREFIX = 'record.';
  var CUSTOM_PREFIX = 'custom.text.';
  var RECORD_LIMIT = 50;

  var WEAK_KEY_MAX = 24;
  var CONFUSION_MAX = 120;
  var KEY_ERRORS_MAX = 60;
  var CUSTOM_TEXT_MIN = 20;
  var CUSTOM_TEXT_MAX = 20000;
  var CUSTOM_NAME_MAX = 24;
  var CUSTOM_INDEX_MAX = 30;
  var IMPORT_MAX_BYTES = 400 * 1024;
  var TICK_MS = 100;
  var SEEK_MARGIN = 48;

  var DEFAULT_SETTINGS = {
    language: 'all', // all | zh | en
    showLiveWpm: true,
    strict: false,
    soundVolume: 100, // 0–100，默认满音量（WebAudio 合成，不打包音频文件）
    lastSource: 'builtin', // builtin | custom
  };

  // ---------------------------------------------------------------------------
  // 内置语料
  // ---------------------------------------------------------------------------

  var BUILT_IN = [
    {
      id: 'zh-short-1',
      lang: 'zh',
      label: '短句 · 一',
      text:
        '今天的天气很好，适合把窗户打开透透气。\n' +
        '先把最重要的一件事做完，再去看别的。\n' +
        '写下来比记在脑子里更可靠，也更轻松。',
    },
    {
      id: 'zh-short-2',
      lang: 'zh',
      label: '短句 · 二',
      text:
        '把复杂的事拆成几个小步骤，一次只做一步。\n' +
        '慢一点没关系，方向对了就行。\n' +
        '每天进步一点点，一年之后就是很大的差别。',
    },
    {
      id: 'zh-short-3',
      lang: 'zh',
      label: '短句 · 三',
      text:
        '桌面上只留下正在用的东西，注意力会好很多。\n' +
        '喝水、起身、看看远处，都是效率的一部分。\n' +
        '工具应该服务于人，而不是反过来。',
    },
    {
      id: 'zh-mid-1',
      lang: 'zh',
      label: '段落 · 一',
      text:
        '写代码的时候，最容易出问题的地方往往不是难的那部分，而是看起来很简单的那部分。\n' +
        '所以真正省时间的做法，是把边界情况一条一条列出来，先想清楚如果这里不对会怎样。\n' +
        '想清楚了再写，往往比先写出来再调试要快得多。',
    },
    {
      id: 'zh-mid-2',
      lang: 'zh',
      label: '段落 · 二',
      text:
        '一个人每天的注意力是有限的，把它花在哪里，日子就会长成什么样子。\n' +
        '与其同时推进五件事，不如把其中一件真正做完，做完的那件事会带来确定感，\n' +
        '而五件半成品只会带来持续的牵挂。',
    },
    {
      id: 'zh-mid-3',
      lang: 'zh',
      label: '段落 · 三',
      text:
        '整理文档的意义不在于写给人看，而在于写的过程中你会发现自己其实没想清楚。\n' +
        '凡是讲不明白的地方，通常是理解还停留在印象上。\n' +
        '把它写成句子，含糊的地方就会自己浮出来。',
    },
    {
      id: 'zh-long-1',
      lang: 'zh',
      label: '长文 · 一',
      text:
        '很多人以为效率来自更快，其实大部分时候效率来自更少。\n' +
        '少做几件事，把留下的那几件做扎实；少开几个会，把时间还给需要连续思考的工作；\n' +
        '少堆一些工具，把手上的这一个用熟。\n\n' +
        '这不是懒惰，而是承认一个事实：注意力的总量是有限的，切换本身就要付费。\n' +
        '每一次从一件事跳到另一件事，都要重新把上下文装回脑子里，\n' +
        '而这份成本从来不会出现在任何一张日程表上。',
    },
    {
      id: 'zh-long-2',
      lang: 'zh',
      label: '长文 · 二',
      text:
        '好的工具有一个共同点：它让你更快地回到正在做的那件事上。\n' +
        '打开就能用，用完就能走，不需要先做一堆准备工作，也不需要记住一套复杂的快捷键。\n\n' +
        '判断一个工具值不值得留下来，可以问自己一个问题：\n' +
        '过去一个月里，它替我省下的时间，是否大于我学习与维护它的时间？\n' +
        '如果答案是否定的，那它再漂亮也应该删掉。',
    },
    {
      id: 'en-short-1',
      lang: 'en',
      label: 'Short · 1',
      text:
        'The quick brown fox jumps over the lazy dog.\n' +
        'Pack my box with five dozen liquor jugs.\n' +
        'How vexingly quick daft zebras jump!',
    },
    {
      id: 'en-short-2',
      lang: 'en',
      label: 'Short · 2',
      text:
        'Small steps every day add up to a long journey.\n' +
        'Write it down before you try to remember it.\n' +
        'Slow is smooth, and smooth is fast.',
    },
    {
      id: 'en-mid-1',
      lang: 'en',
      label: 'Paragraph · 1',
      text:
        'The best way to learn a keyboard is to stop looking at it. Your fingers will be slow for a few ' +
        'days, and then they will be faster than your eyes ever were. Accuracy comes first; speed is ' +
        'what is left over after the mistakes are gone.',
    },
    {
      id: 'en-mid-2',
      lang: 'en',
      label: 'Paragraph · 2',
      text:
        'Typing well is mostly about rhythm. When you find a steady pace you can hold, your hands stop ' +
        'waiting for your thoughts and start keeping up with them. Try to keep the same beat through ' +
        'the whole paragraph instead of racing and then stalling.',
    },
    {
      id: 'en-long-1',
      lang: 'en',
      label: 'Long · 1',
      text:
        'Practice is not the same thing as repetition. Repeating a mistake a thousand times will make ' +
        'the mistake permanent, which is why speed drills done carelessly make people worse. The useful ' +
        'loop is smaller: type a short passage, notice exactly which characters you missed, and then ' +
        'type it again slowly enough that you do not miss them.\n\n' +
        'Most people find that their speed improves on its own once the errors stop, because the pause ' +
        'after every mistake costs far more time than the mistake itself.',
    },
    {
      id: 'en-long-2',
      lang: 'en',
      label: 'Long · 2',
      text:
        'A good desk is boring. Everything you need is within reach, nothing else is on it, and the light ' +
        'comes from the side rather than from behind the screen. There is nothing to admire and nothing ' +
        'to tidy up before you start working.\n\n' +
        'The same principle applies to software. The tools that last are the ones that disappear while ' +
        'you use them: no setup, no ceremony, no decisions about how to begin.',
    },
  ];

  function lessonById(id) {
    for (var i = 0; i < BUILT_IN.length; i += 1) {
      if (BUILT_IN[i].id === id) return BUILT_IN[i];
    }
    return null;
  }

  function resolveSourceName(source) {
    var lesson = lessonById(source);
    if (lesson) return lesson.label;
    if (source === 'custom') return '自定义文本';
    return '未知来源';
  }

  // ---------------------------------------------------------------------------
  // 纯工具
  // ---------------------------------------------------------------------------

  function nowIso() {
    return new Date().toISOString();
  }

  function pad2(value) {
    return (value < 10 ? '0' : '') + value;
  }

  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /**
   * 把文本折成「空格分隔」的单一形式。
   *
   * **这是显示与判定的唯一来源。** 语料里的换行在排版时会被当作词间空格，
   * 因此判定也必须用这一份 —— 否则打空格会判错（用户看到的确实是空格，
   * 而原始文本里是 \n），段落末尾也永远打不完。
   */
  function normalizeText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 把归一化后的文本拆成词，每个词后固定跟一个空格。
   *
   * 每个词尾都补空格，折行点就只会落在空格上；行尾空格在 HTML 里被折叠，
   * 于是不会出现「行尾空一格」的观感，同时每个字符的索引与文本一一对应。
   */
  function toWords(text) {
    var normalized = normalizeText(text);
    if (normalized.length === 0) return [];
    var parts = normalized.split(' ');
    var words = [];
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i].length === 0) continue;
      words.push({ text: parts[i], count: parts[i].length + 1 }); // +1 是尾随空格
    }
    return words;
  }

  /**
   * 按容器宽度自己折行，并切成若干块。
   *
   * 自己折行而不是交给浏览器：光标位置必须与视觉行严格一致，而浏览器在哪个位置折行
   * 不可预测（还会受字体回退影响）。块是 memo 的边界 —— 打错一个字只让那一块重渲染。
   *
   * 字符宽度按 1em 估算（中文字符正好 1em，等宽西文约 0.6em）。宁可估宽一点：
   * 估窄了会让中文行溢出容器，而溢出的位置恰好是光标最容易跑丢的地方。
   * 单个词本身超过预算时不强行拆词（拆词会让索引与文本脱节），那一行就让它超一点。
   */
  function buildLayout(text, width, fontSize) {
    var words = toWords(text);
    var unit = fontSize;
    var budget = Math.max(4, Math.floor(width / unit) - 1);
    var lines = [];
    var current = [];
    var used = 0;
    var index = 0;
    var chunks = [];
    var chunkStart = 0;

    function flushLine() {
      if (current.length === 0) return;
      lines.push({ words: current, startIndex: index - used });
      current = [];
      used = 0;
    }

    for (var i = 0; i < words.length; i += 1) {
      var word = words[i];
      if (used > 0 && used + word.count > budget) flushLine();
      if (current.length === 0) current.startIndex = index;
      current.push(word);
      used += word.count;
      index += word.count;
    }
    flushLine();

    for (var j = 0; j < lines.length; j += 1) {
      var lineWords = lines[j].words;
      for (var k = 0; k < lineWords.length; k += 1) {
        if (lineWords[k] === lineWords[0]) chunkStart = lines[j].startIndex;
      }
      chunks.push({ words: lineWords, startIndex: lines[j].startIndex });
    }
    return { words: words, lines: lines, chunks: chunks };
  }

  /**
   * 用户粘贴 / 导入的文本：清掉控制字符、统一换行、收起多余空行。
   * 段落结构保留（单个换行留着），每行首尾的空白去掉 —— 练习时会重新排版，缩进没有意义。
   */
  function cleanCustomText(raw) {
    var value = String(raw || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map(function (line) {
        return line.replace(/[ \t\u3000]+$/g, '').replace(/^[ \t\u3000]+/g, '');
      })
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
    if (value.length < CUSTOM_TEXT_MIN) {
      return { ok: false, reason: '太短了：至少 ' + CUSTOM_TEXT_MIN + ' 个字才能用来练习。' };
    }
    if (value.length > CUSTOM_TEXT_MAX) {
      return { ok: false, reason: '太长了：请控制在 ' + CUSTOM_TEXT_MAX + ' 字以内。' };
    }
    return { ok: true, text: value };
  }

  /** 从文件导入时先粗判是不是文本：二进制文件会在 UTF-8 解码时留下 U+FFFD。 */
  function looksLikeText(value) {
    if (!value) return false;
    if (value.indexOf('\u0000') >= 0) return false;
    var replacement = (value.match(/\ufffd/g) || []).length;
    return replacement / value.length < 0.02;
  }

  function formatDuration(ms) {
    var total = Math.max(0, ms) / 1000;
    var minutes = Math.floor(total / 60);
    var seconds = total - minutes * 60;
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds.toFixed(1);
  }

  function formatWhen(iso) {
    var value = new Date(iso);
    if (isNaN(value.getTime())) return '';
    var now = new Date();
    var sameDay =
      value.getFullYear() === now.getFullYear() &&
      value.getMonth() === now.getMonth() &&
      value.getDate() === now.getDate();
    var time = pad2(value.getHours()) + ':' + pad2(value.getMinutes());
    if (sameDay) return '今天 ' + time;
    return value.getFullYear() + '-' + pad2(value.getMonth() + 1) + '-' + pad2(value.getDate()) + ' ' + time;
  }

  /**
   * 「打完了」的判定。
   *
   * 两侧都先去掉尾部空格，因此：段落末尾那些看不见的尾随空格不要求用户去数，
   * 但文本**中间**的空格照常要求（去掉尾部之后必须逐字符相等）。
   *
   * 传进来的两个文本都必须是 normalizeText 之后的形式（见文件头第 2 点）。
   */
  function isFinished(target, typed) {
    return String(typed).replace(/ +$/, '') === String(target).replace(/ +$/, '');
  }

  /**
   * 判定一次输入，并把结果写回调用方传入的 wrong 集合与计数器。
   *
   * 抽成纯函数是为了能单独测「音效该响哪一种」这类容易写错的规则。
   * 它只读字符、只改传入的两个对象，不碰 DOM、不碰 React。
   *
   * 两个返回值的区别很重要，别混用：
   *
   *   introduced  这一次判定里**新进入错误状态**的位置数。它也会因为「删掉一个字符、
   *               后面的字符挪到错误位置上」而大于 0，所以它**不是**「用户按错了键」。
   *   addedChars  这次比上次多输入的字符数。只有它大于 0 才说明用户往前打了一个键。
   *
   * 音效必须同时看这两个（见 evaluate）：只看 introduced，退格与删改也会响错误音；
   * 只看「当前有几个位置是错的」，前面留着一个错字就会让后面每一键都响错误音。
   */
  function applyTyped(target, typed, wrong, counters, strict) {
    var value = String(typed);
    var previous = typeof counters.typed === 'string' ? counters.typed : '';

    // 严格模式：光标停在第一个错误处，用户必须改对才能继续
    if (strict) {
      for (var i = 0; i < value.length; i += 1) {
        if (value.charAt(i) !== target.charAt(i)) {
          return { blocked: { at: i, value: value.slice(0, i) } };
        }
      }
    }

    var status = new Array(target.length);
    var correct = 0;
    var introduced = 0;
    for (var j = 0; j < target.length; j += 1) {
      if (j >= value.length) {
        status[j] = '.';
        continue;
      }
      // `target.charAt(j)` 在越界时返回空串，空串与任何字符都不相等 ——
      // 因此这里先挡一下，别把「多出来的字符」算成打错（那会让 marks 与音效都失真）。
      var expected = target.charAt(j);
      if (!expected) {
        status[j] = '.';
        continue;
      }
      if (value.charAt(j) === expected) {
        status[j] = 'c';
        correct += 1;
        if (wrong.has(j)) wrong.delete(j); // 改对了：错误标记消失
        continue;
      }
      status[j] = 'w';
      var actual = value.charAt(j);
      // 同一个位置连续错着不放，marks 不再增加 —— marks 是准确率的分母与「错按次数」
      // 的唯一口径，所以它和 introduced 必须挂在同一个判断上，不能各处自己再数一遍。
      if (!wrong.has(j)) {
        wrong.add(j);
        counters.marks += 1;
        introduced += 1;
        if (expected && /\S/.test(expected)) counters.wrongChars.push(expected);
      }
      // 误触对照按次累计（「想打 A 实际按了 B」出现几次），与 marks 是两个口径
      if (expected && /\S/.test(expected)) counters.pairs.push(expected + '<' + (actual || '?'));
      if (actual && /\S/.test(actual)) counters.keyErrors.push(actual);
    }

    counters.correct = correct;
    counters.typed = value;
    var joined = status.join('');
    return {
      blocked: null,
      correct: correct,
      introduced: introduced,
      addedChars: Math.max(0, value.length - previous.length),
      cursor: Math.min(value.length, target.length),
      status: joined,
      finished: isFinished(target, value),
    };
  }

  /** 标准定义：正确字符数 ÷ 5 ÷ 分钟数。界面上也会写明用的是这个定义。 */
  function computeWpm(correct, ms) {
    if (!ms || ms <= 0) return 0;
    return (correct / 5) * (60000 / ms);
  }

  function computeAccuracy(correct, mistakes) {
    var total = correct + mistakes;
    if (total <= 0) return 100;
    return (correct / total) * 100;
  }

  function clampNumber(value, min, max, fallback) {
    if (typeof value !== 'number' || !isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  /** 有界地合并一个「字符 → 次数」表：超过上限时只留计数最高的若干个。 */
  function mergeCountMap(base, additions, maxKeys) {
    var next = Object.assign({}, base);
    for (var i = 0; i < additions.length; i += 1) {
      var key = additions[i];
      if (!key) continue;
      next[key] = (next[key] || 0) + 1;
    }
    var names = Object.keys(next);
    if (names.length > maxKeys) {
      names.sort(function (a, b) {
        return next[b] - next[a];
      });
      var trimmed = {};
      for (var j = 0; j < maxKeys; j += 1) trimmed[names[j]] = next[names[j]];
      next = trimmed;
    }
    return next;
  }

  // ---------------------------------------------------------------------------
  // 音效：WebAudio 现场合成，不打包任何音频文件
  //
  // 默认音量为 0（静音）。浏览器的自动播放策略要求音频在用户手势里解锁，
  // 因此 AudioContext 在第一次按键（或第一次调整音量）时才创建并 resume()。
  // ---------------------------------------------------------------------------

  var audio = { context: null, master: null, unlocked: false };

  function audioReady() {
    return !!(audio.context && audio.master);
  }

  function unlockAudio() {
    if (audioReady()) {
      if (audio.context.state === 'suspended' && audio.context.resume) {
        audio.context.resume().catch(function () {
          /* 拿不到焦点就算了，音效不是功能的一部分 */
        });
      }
      return;
    }
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      audio.context = new Ctor();
      audio.master = audio.context.createGain();
      audio.master.gain.value = 1;
      audio.master.connect(audio.context.destination);
      audio.unlocked = true;
      if (audio.context.state === 'suspended' && audio.context.resume) {
        audio.context.resume().catch(function () {
          /* 同上 */
        });
      }
    } catch (err) {
      ctx.logger.warn('这台设备上没能建立音频通道，音效将不会有声音', err);
      audio.context = null;
      audio.master = null;
    }
  }

  /**
   * 一声很短的合成脉冲，用来模仿机械键盘的敲击声。
   *
   * 为什么不是「一段滤过的噪声」：那种做法听起来是闷闷的「噗」，像敲在毛巾上。
   * 清脆的敲击声由两部分叠成 ——
   *   1. 高频噪声做的尖锐起音（咔），用 highpass 把低频压掉才够「亮」；
   *   2. 一个衰减很快的方波音（嗒），给按键一个明确的音高落点。
   * 两者都很短（几十毫秒），叠起来才是「嗒」而不是「咚」。
   *
   * 音量说明：`level` 是这一声的峰值增益，再乘以滑块的百分比。
   * 起音用极短的 attack（1ms）而不是 2ms，attack 越陡听起来越响 ——
   * 人耳对瞬态的敏感度远高于稳态音量，这也是「加大音量」最有效的做法。
   */
  function playClick(options) {
    var volume = store.getSnapshot().settings.soundVolume;
    if (!volume || volume <= 0) return;
    if (!audioReady()) return;
    var context = audio.context;
    var now = context.currentTime;
    try {
      var duration = options.duration || 0.03;
      var level = (volume / 100) * (options.level || 0.5);

      var gain = context.createGain();
      // 单声峰值控制在 0.5 附近：三方（噪声 + 方波 + 包络）叠加时若逼近 1.0 会削波，
      // 听感是「破音」而不是「响」。音量靠默认的 100% 与更陡的起音来给，不靠拉高峰值。
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(level, now + 0.001);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + duration);
      gain.connect(audio.master);

      if (options.noise !== false) {
        var frames = Math.max(1, Math.floor(context.sampleRate * Math.min(duration, 0.02)));
        var buffer = context.createBuffer(1, frames, context.sampleRate);
        var data = buffer.getChannelData(0);
        for (var i = 0; i < frames; i += 1) {
          var decay = 1 - i / frames;
          data[i] = (Math.random() * 2 - 1) * decay * decay;
        }
        var source = context.createBufferSource();
        source.buffer = buffer;
        var filter = context.createBiquadFilter();
        // highpass 而不是 lowpass：把低频闷响切掉，留下的才是清脆的「咔」
        filter.type = 'highpass';
        filter.frequency.value = options.cutoff || 1800;
        source.connect(filter);
        filter.connect(gain);
        source.start(now);
      }

      if (options.tone) {
        var osc = context.createOscillator();
        osc.type = options.type || 'square';
        osc.frequency.setValueAtTime(options.tone, now);
        if (options.bend) osc.frequency.exponentialRampToValueAtTime(options.bend, now + duration);
        var oscGain = context.createGain();
        oscGain.gain.value = options.toneLevel === void 0 ? 0.5 : options.toneLevel;
        osc.connect(oscGain);
        oscGain.connect(gain);
        osc.start(now);
        osc.stop(now + duration + 0.02);
      }
    } catch (err) {
      // 音效永远不该让打字中断
      ctx.logger.debug('播放音效失败', err);
    }
  }

  /**
   * 三种音效。
   *
   * 按对的一声是主角，出现最频繁，因此刻意做得又短又亮（约 22ms）；
   * 按错的一声压低音高、拉长一点，与敲击声区分得开，但不刺耳。
   */
  var sound = {
    key: function () {
      playClick({ duration: 0.022, level: 0.5, cutoff: 2200, tone: 2400, type: 'square', toneLevel: 0.32, bend: 1200 });
    },
    wrong: function () {
      playClick({ duration: 0.075, level: 0.5, cutoff: 900, tone: 165, type: 'triangle', toneLevel: 0.5 });
    },
    finish: function () {
      playClick({ duration: 0.05, level: 0.46, cutoff: 2000, tone: 880, type: 'square', toneLevel: 0.38, bend: 1320 });
    },
  };

  // ---------------------------------------------------------------------------
  // 存储
  // ---------------------------------------------------------------------------

  function recordKey(at) {
    var stamp = String(at).replace(/[^0-9A-Za-z]/g, '').slice(0, 20);
    return RECORD_PREFIX + stamp + '.' + Math.random().toString(36).slice(2, 6);
  }

  function normalizeRecord(raw, key) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      key: key,
      at: typeof raw.at === 'string' ? raw.at : '',
      source: typeof raw.source === 'string' ? raw.source : 'unknown',
      durationMs: clampNumber(raw.durationMs, 0, 24 * 3600 * 1000, 0),
      correct: clampNumber(raw.correct, 0, 100000, 0),
      wpm: clampNumber(raw.wpm, 0, 1000, 0),
      accuracy: clampNumber(raw.accuracy, 0, 100, 0),
      marks: clampNumber(raw.marks, 0, 100000, 0),
      partial: raw.partial === true,
    };
  }

  function normalizeStats(raw) {
    var base = { recent: [], best: {}, weakKeys: {}, total: 0 };
    if (!raw || typeof raw !== 'object') return base;
    if (Array.isArray(raw.recent)) {
      base.recent = raw.recent
        .filter(function (item) {
          return item && typeof item === 'object';
        })
        .map(function (item) {
          return {
            at: typeof item.at === 'string' ? item.at : '',
            wpm: clampNumber(item.wpm, 0, 1000, 0),
            accuracy: clampNumber(item.accuracy, 0, 100, 0),
            durationMs: clampNumber(item.durationMs, 0, 24 * 3600 * 1000, 0),
            source: typeof item.source === 'string' ? item.source : 'unknown',
            partial: item.partial === true,
          };
        })
        .slice(-50);
    }
    if (raw.best && typeof raw.best === 'object') {
      var bestKeys = Object.keys(raw.best).slice(0, 80);
      for (var i = 0; i < bestKeys.length; i += 1) {
        var entry = raw.best[bestKeys[i]];
        if (!entry || typeof entry !== 'object') continue;
        base.best[bestKeys[i]] = {
          wpm: clampNumber(entry.wpm, 0, 1000, 0),
          accuracy: clampNumber(entry.accuracy, 0, 100, 0),
          at: typeof entry.at === 'string' ? entry.at : '',
        };
      }
    }
    if (raw.weakKeys && typeof raw.weakKeys === 'object') {
      var weakNames = Object.keys(raw.weakKeys).slice(0, WEAK_KEY_MAX * 3);
      for (var j = 0; j < weakNames.length; j += 1) {
        var count = clampNumber(raw.weakKeys[weakNames[j]], 0, 1000000, 0);
        if (count > 0) base.weakKeys[weakNames[j].slice(0, 4)] = count;
      }
    }
    base.total = clampNumber(raw.total, 0, 1000000, 0);
    return base;
  }

  /** 分析数据：总按键数、按错的键、以及「想打 A 实际按了 B」的对照。 */
  function normalizeAnalysis(raw) {
    var base = { keystrokes: 0, mistakes: 0, keyErrors: {}, pairs: {} };
    if (!raw || typeof raw !== 'object') return base;
    base.keystrokes = clampNumber(raw.keystrokes, 0, 100000000, 0);
    base.mistakes = clampNumber(raw.mistakes, 0, 100000000, 0);
    if (raw.keyErrors && typeof raw.keyErrors === 'object') {
      var keys = Object.keys(raw.keyErrors).slice(0, KEY_ERRORS_MAX * 2);
      for (var i = 0; i < keys.length; i += 1) {
        var n = clampNumber(raw.keyErrors[keys[i]], 0, 1000000, 0);
        if (n > 0) base.keyErrors[keys[i].slice(0, 4)] = n;
      }
    }
    if (raw.pairs && typeof raw.pairs === 'object') {
      var pairs = Object.keys(raw.pairs).slice(0, CONFUSION_MAX * 2);
      for (var j = 0; j < pairs.length; j += 1) {
        var m = clampNumber(raw.pairs[pairs[j]], 0, 1000000, 0);
        if (m > 0) base.pairs[pairs[j].slice(0, 8)] = m;
      }
    }
    return base;
  }

  function mergeStats(stats, record, wrongChars) {
    var next = {
      recent: stats.recent.concat([
        {
          at: record.at,
          wpm: record.wpm,
          accuracy: record.accuracy,
          durationMs: record.durationMs,
          source: record.source,
          partial: record.partial,
        },
      ]),
      best: Object.assign({}, stats.best),
      weakKeys: Object.assign({}, stats.weakKeys),
      total: stats.total + 1,
    };
    if (next.recent.length > 50) next.recent = next.recent.slice(-50);

    var bestKey = record.source === 'custom' ? 'custom' : record.source;
    var currentBest = next.best[bestKey];
    if (!record.partial && (!currentBest || record.wpm > currentBest.wpm)) {
      next.best[bestKey] = { wpm: record.wpm, accuracy: record.accuracy, at: record.at };
    }
    next.weakKeys = mergeCountMap(next.weakKeys, wrongChars || [], WEAK_KEY_MAX);
    return next;
  }

  function mergeAnalysis(analysis, delta) {
    var next = {
      keystrokes: analysis.keystrokes + (delta.keystrokes || 0),
      mistakes: analysis.mistakes + (delta.mistakes || 0),
      keyErrors: mergeCountMap(analysis.keyErrors, delta.keyErrors || [], KEY_ERRORS_MAX),
      pairs: Object.assign({}, analysis.pairs),
    };
    var pairKeys = delta.pairs || [];
    for (var i = 0; i < pairKeys.length; i += 1) {
      var key = pairKeys[i];
      if (!key) continue;
      next.pairs[key] = (next.pairs[key] || 0) + 1;
    }
    var names = Object.keys(next.pairs);
    if (names.length > CONFUSION_MAX) {
      names.sort(function (a, b) {
        return next.pairs[b] - next.pairs[a];
      });
      var trimmed = {};
      for (var j = 0; j < CONFUSION_MAX; j += 1) trimmed[names[j]] = next.pairs[names[j]];
      next.pairs = trimmed;
    }
    return next;
  }

  function listRecordKeys(keys) {
    return keys
      .filter(function (key) {
        return key.indexOf(RECORD_PREFIX) === 0;
      })
      .sort()
      .reverse();
  }

  /** 保存记录 → 更新统计与分析 → 清理超出上限的旧记录。 */
  function saveRecord(record, wrongChars, analysisDelta) {
    var stamp = {
      at: record.at,
      source: record.source,
      durationMs: Math.round(record.durationMs),
      correct: Math.round(record.correct),
      wpm: Math.round(record.wpm * 10) / 10,
      accuracy: Math.round(record.accuracy * 10) / 10,
      marks: Math.round(record.marks),
      partial: record.partial === true,
    };

    return ctx.storage
      .set(recordKey(stamp.at), stamp)
      .then(function () {
        var current = store.getSnapshot().stats || normalizeStats(null);
        var merged = mergeStats(current, stamp, wrongChars);
        return ctx.storage.set(KEY_STATS, merged).then(function () {
          store.set({ stats: merged });
        });
      })
      .then(function () {
        var current = store.getSnapshot().analysis || normalizeAnalysis(null);
        var merged = mergeAnalysis(current, analysisDelta);
        return ctx.storage.set(KEY_ANALYSIS, merged).then(function () {
          store.set({ analysis: merged });
        });
      })
      .then(function () {
        return ctx.storage.keys();
      })
      .then(function (keys) {
        var recordKeys = listRecordKeys(keys);
        if (recordKeys.length <= RECORD_LIMIT) return null;
        var extra = recordKeys.slice(RECORD_LIMIT);
        return Promise.all(
          extra.map(function (oldKey) {
            return ctx.storage.delete(oldKey).catch(function (err) {
              ctx.logger.warn('清理旧记录失败：' + oldKey, err);
            });
          })
        );
      })
      .catch(function (err) {
        ctx.logger.error('保存练习记录失败', err);
        store.set({
          saveError:
            '这次的结果没能写进存储：' + ((err && err.message) || '未知原因') +
            '。成绩还在屏幕上，可以先看一眼；稍后重练一次即可。',
        });
      });
  }

  function loadRecords() {
    return ctx.storage
      .keys()
      .then(function (keys) {
        var recordKeys = listRecordKeys(keys).slice(0, RECORD_LIMIT);
        return Promise.all(
          recordKeys.map(function (key) {
            return ctx.storage
              .get(key, null)
              .then(function (raw) {
                return normalizeRecord(raw, key);
              })
              .catch(function () {
                return null;
              });
          })
        );
      })
      .then(function (list) {
        return list.filter(Boolean);
      });
  }

  function normalizeCustomIndex(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length && out.length < CUSTOM_INDEX_MAX; i += 1) {
      var item = raw[i];
      if (!item || typeof item !== 'object') continue;
      var id = typeof item.id === 'string' ? item.id : '';
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
      out.push({
        id: id,
        name: (typeof item.name === 'string' ? item.name : '未命名').slice(0, CUSTOM_NAME_MAX) || '未命名',
        chars: clampNumber(item.chars, 0, CUSTOM_TEXT_MAX, 0),
        at: typeof item.at === 'string' ? item.at : '',
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 状态容器
  // ---------------------------------------------------------------------------

  function createStore(initial) {
    var state = initial;
    var listeners = new Set();
    return {
      subscribe: function (listener) {
        listeners.add(listener);
        return function () {
          listeners.delete(listener);
        };
      },
      getSnapshot: function () {
        return state;
      },
      set: function (patch) {
        state = Object.assign({}, state, patch);
        listeners.forEach(function (listener) {
          listener();
        });
      },
    };
  }

  var store = createStore({
    status: 'loading',
    errorMessage: null,
    view: 'practice', // practice | analysis | history
    settings: DEFAULT_SETTINGS,
    stats: normalizeStats(null),
    analysis: normalizeAnalysis(null),
    records: [],
    recordsLoaded: false,
    saveError: null,
    timer: { running: false, elapsedMs: 0, startedAt: 0 },
    lastResult: null,
    progress: { cursor: 0, correct: 0, marks: 0, total: 0 },
    customIndex: [],
    activeCustomText: '',
    activeCustomId: '',
  });

  var ticker = { handle: null };

  function startTimer() {
    if (ticker.handle !== null) return;
    var startedAt = Date.now();
    store.set({ timer: { running: true, elapsedMs: 0, startedAt: startedAt } });
    ticker.handle = setInterval(function () {
      var timer = store.getSnapshot().timer;
      if (!timer.running) return;
      store.set({ timer: { running: true, elapsedMs: Date.now() - timer.startedAt, startedAt: timer.startedAt } });
    }, TICK_MS);
  }

  function stopTimer() {
    if (ticker.handle !== null) {
      clearInterval(ticker.handle);
      ticker.handle = null;
    }
    var timer = store.getSnapshot().timer;
    var elapsed = timer.running ? Date.now() - timer.startedAt : timer.elapsedMs;
    store.set({ timer: { running: false, elapsedMs: elapsed, startedAt: timer.startedAt } });
    return elapsed;
  }

  function resetTimer() {
    if (ticker.handle !== null) {
      clearInterval(ticker.handle);
      ticker.handle = null;
    }
    store.set({ timer: { running: false, elapsedMs: 0, startedAt: 0 } });
  }

  function loadSettings() {
    return ctx.storage
      .get(KEY_SETTINGS, null)
      .then(function (raw) {
        var value = raw && typeof raw === 'object' ? raw : {};
        store.set({
          settings: {
            language: value.language === 'zh' || value.language === 'en' ? value.language : 'all',
            showLiveWpm: value.showLiveWpm !== false,
            strict: value.strict === true,
            soundVolume: clampNumber(value.soundVolume, 0, 100, 100),
            lastSource: value.lastSource === 'custom' ? 'custom' : 'builtin',
          },
        });
      })
      .catch(function (err) {
        ctx.logger.warn('读取设置失败，按默认值继续', err);
      });
  }

  function saveSettings(patch) {
    var next = Object.assign({}, store.getSnapshot().settings, patch);
    store.set({ settings: next });
    ctx.storage.set(KEY_SETTINGS, next).catch(function (err) {
      ctx.logger.warn('保存设置失败', err);
      store.set({
        saveError: '设置没能保存：' + ((err && err.message) || '未知原因') + '。本次仍然按你选的方式生效。',
      });
    });
  }

  function loadStats() {
    return ctx.storage
      .get(KEY_STATS, null)
      .then(function (raw) {
        store.set({ stats: normalizeStats(raw) });
      })
      .catch(function (err) {
        ctx.logger.warn('读取统计摘要失败', err);
      });
  }

  function loadAnalysis() {
    return ctx.storage
      .get(KEY_ANALYSIS, null)
      .then(function (raw) {
        store.set({ analysis: normalizeAnalysis(raw) });
      })
      .catch(function (err) {
        ctx.logger.warn('读取分析数据失败，分析页会暂时空着', err);
      });
  }

  /** 自定义文本：索引 + 当前使用中的那一份。旧的单键格式会被迁移进索引。 */
  function loadCustomTexts() {
    return Promise.all([
      ctx.storage.get(KEY_CUSTOM_INDEX, null).catch(function () {
        return null;
      }),
      ctx.storage.get(KEY_CUSTOM_ACTIVE, '').catch(function () {
        return '';
      }),
    ]).then(function (results) {
      var index = normalizeCustomIndex(results[0]);
      var active = typeof results[1] === 'string' ? results[1] : '';

      if (index.length === 0 && active.length >= CUSTOM_TEXT_MIN) {
        // 从旧版本升上来：把那份文本收进索引，名字给一个默认值
        var migrated = [{ id: uid(), name: '我粘贴的文本', chars: active.length, at: nowIso() }];
        return ctx.storage
          .set(CUSTOM_PREFIX + migrated[0].id, active)
          .then(function () {
            return ctx.storage.set(KEY_CUSTOM_INDEX, migrated);
          })
          .then(function () {
            store.set({ customIndex: migrated, activeCustomText: active, activeCustomId: migrated[0].id });
          })
          .catch(function (err) {
            ctx.logger.warn('迁移自定义文本失败，本次先直接使用它', err);
            store.set({ customIndex: [], activeCustomText: active, activeCustomId: '' });
          });
      }

      store.set({ customIndex: index, activeCustomText: active, activeCustomId: index.length > 0 ? index[0].id : '' });
      return null;
    });
  }

  function loadAll() {
    store.set({ status: 'loading', errorMessage: null });
    return Promise.all([loadSettings(), loadStats(), loadAnalysis(), loadCustomTexts()])
      .then(function () {
        store.set({ status: 'ready' });
      })
      .catch(function (err) {
        ctx.logger.error('读取插件数据失败', err);
        store.set({
          status: 'error',
          errorMessage:
            '读取数据失败：' + ((err && err.message) || '未知原因') + '。磁盘上的数据没有被改动，可以点「重新读取」再试。',
        });
      });
  }

  function loadHistory() {
    return loadRecords().then(function (records) {
      store.set({ records: records, recordsLoaded: true });
    });
  }

  function clearHistory() {
    return ctx.storage
      .keys()
      .then(function (keys) {
        var recordKeys = listRecordKeys(keys);
        return Promise.all(
          recordKeys.map(function (key) {
            return ctx.storage.delete(key).catch(function (err) {
              ctx.logger.warn('删除记录失败：' + key, err);
            });
          })
        );
      })
      .then(function () {
        return ctx.storage.set(KEY_STATS, normalizeStats(null));
      })
      .then(function () {
        store.set({ records: [], stats: normalizeStats(null), lastResult: null });
      })
      .catch(function (err) {
        ctx.logger.error('清空历史失败', err);
        store.set({ saveError: '清空历史失败：' + ((err && err.message) || '未知原因') + '。可以稍后再试。' });
      });
  }

  function resetAnalysis() {
    var empty = normalizeAnalysis(null);
    return ctx.storage
      .set(KEY_ANALYSIS, empty)
      .then(function () {
        store.set({ analysis: empty });
      })
      .catch(function (err) {
        ctx.logger.error('清空分析数据失败', err);
        store.set({ saveError: '清空分析数据失败：' + ((err && err.message) || '未知原因') + '。可以稍后再试。' });
      });
  }

  /** 保存一份自定义文本（粘贴或导入）。 */
  function saveCustomText(text, name) {
    var cleaned = cleanCustomText(text);
    if (!cleaned.ok) return Promise.resolve(cleaned);
    var id = uid();
    var entry = {
      id: id,
      name: (name || '未命名文本').slice(0, CUSTOM_NAME_MAX) || '未命名文本',
      chars: cleaned.text.length,
      at: nowIso(),
    };
    var index = store.getSnapshot().customIndex.concat([entry]).slice(-CUSTOM_INDEX_MAX);
    return ctx.storage
      .set(CUSTOM_PREFIX + id, cleaned.text)
      .then(function () {
        return ctx.storage.set(KEY_CUSTOM_INDEX, index);
      })
      .then(function () {
        return ctx.storage.set(KEY_CUSTOM_ACTIVE, cleaned.text);
      })
      .then(function () {
        store.set({ customIndex: index, activeCustomText: cleaned.text, activeCustomId: id });
        return { ok: true, entry: entry };
      })
      .catch(function (err) {
        ctx.logger.warn('保存自定义文本失败', err);
        return { ok: false, reason: '没能写进存储：' + ((err && err.message) || '未知原因') + '。请稍后再试。' };
      });
  }

  /** 切换到索引里的某一份自定义文本。 */
  function useCustomText(id) {
    return ctx.storage
      .get(CUSTOM_PREFIX + id, '')
      .then(function (value) {
        var text = typeof value === 'string' ? value : '';
        if (text.length < CUSTOM_TEXT_MIN) {
          return { ok: false, reason: '这份文本读不出来了（可能已被删除）。请重新导入。' };
        }
        return ctx.storage.set(KEY_CUSTOM_ACTIVE, text).then(function () {
          store.set({ activeCustomText: text, activeCustomId: id });
          return { ok: true };
        });
      })
      .catch(function (err) {
        ctx.logger.warn('读取自定义文本失败', err);
        return { ok: false, reason: '读取失败：' + ((err && err.message) || '未知原因') + '。' };
      });
  }

  function deleteCustomText(id) {
    var index = store.getSnapshot().customIndex.filter(function (item) {
      return item.id !== id;
    });
    return ctx.storage
      .delete(CUSTOM_PREFIX + id)
      .catch(function (err) {
        ctx.logger.warn('删除自定义文本失败：' + id, err);
      })
      .then(function () {
        return ctx.storage.set(KEY_CUSTOM_INDEX, index);
      })
      .then(function () {
        var next = index.length > 0 ? index[index.length - 1] : null;
        if (!next) {
          return ctx.storage.set(KEY_CUSTOM_ACTIVE, '').then(function () {
            store.set({ customIndex: [], activeCustomText: '', activeCustomId: '' });
          });
        }
        return useCustomText(next.id).then(function () {
          store.set({ customIndex: index });
        });
      })
      .catch(function (err) {
        ctx.logger.error('删除自定义文本失败', err);
        store.set({ saveError: '删除失败：' + ((err && err.message) || '未知原因') + '。可以稍后再试。' });
      });
  }

  // ---------------------------------------------------------------------------
  // 图标
  // ---------------------------------------------------------------------------

  function icon(size, children) {
    return h(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      children
    );
  }

  var icons = {
    play: function (size) {
      return icon(size || 14, [h('path', { key: 'a', d: 'M7 5l12 7-12 7z' })]);
    },
    refresh: function (size) {
      return icon(size || 14, [
        h('path', { key: 'a', d: 'M20 11a8 8 0 1 0-2.3 5.7' }),
        h('path', { key: 'b', d: 'M20 5v6h-6' }),
      ]);
    },
    close: function (size) {
      return icon(size || 16, [
        h('path', { key: 'a', d: 'M6 6l12 12' }),
        h('path', { key: 'b', d: 'M18 6L6 18' }),
      ]);
    },
    flag: function (size) {
      return icon(size || 14, [
        h('path', { key: 'a', d: 'M6 4v16' }),
        h('path', { key: 'b', d: 'M6 5h11l-2 4 2 4H6z' }),
      ]);
    },
    chart: function (size) {
      return icon(size || 14, [h('path', { key: 'a', d: 'M4 20V10M10 20V4M16 20v-7M2 20h20' })]);
    },
    list: function (size) {
      return icon(size || 14, [
        h('path', { key: 'a', d: 'M8 6h12M8 12h12M8 18h12' }),
        h('path', { key: 'b', d: 'M4 6h.01M4 12h.01M4 18h.01' }),
      ]);
    },
    trash: function (size) {
      return icon(size || 13, [
        h('path', { key: 'a', d: 'M4 7h16' }),
        h('path', { key: 'b', d: 'M7 7l1 13h8l1-13' }),
        h('path', { key: 'c', d: 'M9 7V4h6v3' }),
      ]);
    },
    upload: function (size) {
      return icon(size || 13, [
        h('path', { key: 'a', d: 'M12 16V4' }),
        h('path', { key: 'b', d: 'M7 9l5-5 5 5' }),
        h('path', { key: 'c', d: 'M4 20h16' }),
      ]);
    },
    volume: function (size) {
      return icon(size || 14, [
        h('path', { key: 'a', d: 'M5 9h3l4-4v14l-4-4H5z' }),
        h('path', { key: 'b', d: 'M16 9a4 4 0 0 1 0 6' }),
      ]);
    },
    volumeOff: function (size) {
      return icon(size || 14, [
        h('path', { key: 'a', d: 'M5 9h3l4-4v14l-4-4H5z' }),
        h('path', { key: 'b', d: 'M16 9l5 6M21 9l-5 6' }),
      ]);
    },
  };

  // ---------------------------------------------------------------------------
  // 打字区
  // ---------------------------------------------------------------------------

  function charNode(ch, index, status, cursor, isSpace) {
    var state = status.charAt(index);
    return h(
      'span',
      {
        key: index,
        className:
          'tp__char' +
          (isSpace ? ' tp__char--space' : '') +
          (state === 'c' ? ' is-correct' : state === 'w' ? ' is-wrong' : '') +
          (index === cursor ? ' is-cursor' : ''),
      },
      ch
    );
  }

  /** 一个词（含尾随空格）单独 memo：只有它这一段的状态变了才重渲染。 */
  var Word = memo(function Word(props) {
    var text = props.text;
    var start = props.start;
    var status = props.status;
    var cursor = props.cursor;
    var nodes = [];
    for (var i = 0; i < text.length; i += 1) {
      nodes.push(charNode(text.charAt(i), start + i, status, cursor, false));
    }
    nodes.push(charNode(' ', start + text.length, status, cursor, true));
    return h('span', { className: 'tp__word' }, nodes);
  });

  /**
   * 一行文本一个块。块是 memo 的边界：打错一个字只让所在行重渲染，而不是整篇。
   */
  var LineChunk = memo(function LineChunk(props) {
    var words = props.words;
    var startIndex = props.startIndex;
    var status = props.status;
    var cursor = props.cursor;
    var nodes = [];
    var index = startIndex;
    for (var i = 0; i < words.length; i += 1) {
      nodes.push(h(Word, { key: index, text: words[i].text, start: index, status: status, cursor: cursor }));
      index += words[i].count;
    }
    return h('span', { className: 'tp__line' }, nodes);
  });

  var TextLayer = memo(function TextLayer(props) {
    var layout = props.layout;
    return h(
      'div',
      { className: 'tp__text', 'aria-hidden': 'true', ref: props.layerRef },
      layout.chunks.map(function (chunk) {
        return h(LineChunk, {
          key: chunk.startIndex,
          words: chunk.words,
          startIndex: chunk.startIndex,
          status: props.status,
          cursor: props.cursor,
        });
      })
    );
  });

  function PracticeArea(props) {
    // 判定与显示都必须用这一份（换行已折成空格）
    var target = useMemo(
      function () {
        return normalizeText(props.text);
      },
      [props.text]
    );

    var panelRef = useRef(null);
    var layerRef = useRef(null);
    var inputRef = useRef(null);
    var composingRef = useRef(false);
    var finishedRef = useRef(false);
    var startedRef = useRef(false);
    var wrongRef = useRef(new Set());
    var countersRef = useRef({ correct: 0, marks: 0, wrongChars: [], keyErrors: [], pairs: [] });

    var progressState = useState({ status: '', cursor: 0 });
    var progress = progressState[0];
    var setProgress = progressState[1];

    var boxState = useState({ width: 0, fontSize: 21 });
    var box = boxState[0];
    var setBox = boxState[1];

    // 容器宽度决定折行，因此跟着容器变，而不是跟着窗口变（全屏 / 分屏 / 拉侧边栏都要跟上）
    useEffect(function () {
      var node = panelRef.current;
      if (!node || typeof ResizeObserver === 'undefined') return undefined;
      var measure = function () {
        var style = window.getComputedStyle(node);
        var fontSize = parseFloat(style.fontSize) || 21;
        var paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        var width = node.clientWidth - paddingX;
        setBox(function (prev) {
          if (Math.abs(prev.width - width) < 2 && prev.fontSize === fontSize) return prev;
          return { width: width, fontSize: fontSize };
        });
      };
      measure();
      var observer = new ResizeObserver(measure);
      observer.observe(node);
      return function () {
        observer.disconnect();
      };
    }, []);

    var layout = useMemo(
      function () {
        if (box.width <= 0) return null;
        return buildLayout(target, box.width, box.fontSize);
      },
      [target, box.width, box.fontSize]
    );

    var statsState = useState({ correct: 0, marks: 0 });
    var stats = statsState[0];
    var setStats = statsState[1];

    var running = useSyncExternalStore(
      store.subscribe,
      function () {
        return store.getSnapshot().timer.running;
      },
      function () {
        return store.getSnapshot().timer.running;
      }
    );

    /**
     * 判定核心。只看 textarea 当前的值，因此退格、选区替换、一次多字、
     * 输入法上屏都走同一条路径。
     *
     * 错误语义：`marks` 是「按错键的次数」，只增不减 —— 准确率的口径是
     * 正确字符 ÷（正确字符 + 按错次数）。改对之后红色标记消失，但那次失误仍然计入。
     */
    function evaluate(typed) {
      if (finishedRef.current) return;
      var value = typed;
      if (value.length > target.length) {
        value = value.slice(0, target.length);
        if (inputRef.current) inputRef.current.value = value;
      }

      var result = applyTyped(target, value, wrongRef.current, countersRef.current, store.getSnapshot().settings.strict);
      var blockedByStrict = false;
      if (result.blocked) {
        blockedByStrict = true;
        value = result.blocked.value;
        if (inputRef.current) inputRef.current.value = value;
        // 再用非严格模式判一次，好让界面状态与累计数据一致
        result = applyTyped(target, value, wrongRef.current, countersRef.current, false);
      }

      var counters = countersRef.current;
      setProgress({ status: result.status, cursor: result.cursor });
      setStats({ correct: result.correct, marks: counters.marks });

      /**
       * 音效只看两件事：
       *   addedChars > 0  这一次真的往前打了一个字符（不是退格、不是删改、不是被严格模式挡回）
       *   introduced > 0  这一下确实打错了
       *
       * 缺任何一个都会出错：
       * - 只看「当前有几个位置是错的」→ 前面留着一个错字，后面每一键都响错误音；
       * - 只看 introduced → 退格删改也会让后面的字符挪进错误位置，同样响错误音。
       */
      var advanced = result.addedChars > 0;
      if (advanced && result.introduced > 0) sound.wrong();
      else if (advanced) sound.key();
      if (blockedByStrict) props.onStrictBlocked();

      if (result.finished) {
        finishedRef.current = true;
        var elapsed = stopTimer();
        sound.finish();
        props.onFinished({
          at: nowIso(),
          source: props.lessonId,
          durationMs: elapsed > 0 ? elapsed : 1,
          correct: result.correct,
          marks: counters.marks,
          wrongChars: counters.wrongChars.slice(),
          keyErrors: counters.keyErrors.slice(),
          pairs: counters.pairs.slice(),
          partial: false,
        });
      }
    }

    function onInput(event) {
      var typed = event.target.value;
      // 组合输入（中文 / 日文输入法）期间不判定：候选还没上屏，这时判错全是误报
      if (composingRef.current) return;
      if (!startedRef.current) {
        startedRef.current = true;
        unlockAudio();
        startTimer();
      }
      evaluate(typed);
    }

    function onCompositionStart() {
      composingRef.current = true;
      // 输入法的第一次按键也是一次用户手势，趁这时把音频通道解锁 ——
      // 否则第一声「咔」会因为没有运行中的 AudioContext 而被丢掉。
      if (!startedRef.current) unlockAudio();
    }

    function onCompositionEnd(event) {
      composingRef.current = false;
      if (!startedRef.current) {
        startedRef.current = true;
        unlockAudio();
        startTimer();
      }
      evaluate(event.target.value);
    }

    function onPaste(event) {
      var pasted = '';
      try {
        pasted = event.clipboardData ? event.clipboardData.getData('text') : '';
      } catch (err) {
        pasted = '';
      }
      if (pasted.length <= 1) return;
      event.preventDefault();
      props.onNotice('不接受整段粘贴 —— 一次最多粘一个字符。练习请用手打，否则成绩没有意义。');
    }

    function syncScroll() {
      var input = inputRef.current;
      var panel = panelRef.current;
      if (!input || !panel) return;
      panel.scrollTop = input.scrollTop;
    }

    // 光标跟随：当前字符跑出可视区域时把面板滚到能看见它
    useEffect(function () {
      var input = inputRef.current;
      var panel = panelRef.current;
      if (!input || !panel || !layerRef.current) return;
      var node = layerRef.current.querySelector('.is-cursor');
      if (!node) return;
      var nodeBox = node.getBoundingClientRect();
      var panelBox = panel.getBoundingClientRect();
      if (nodeBox.bottom > panelBox.bottom - SEEK_MARGIN) {
        panel.scrollTop += nodeBox.bottom - panelBox.bottom + SEEK_MARGIN;
      } else if (nodeBox.top < panelBox.top + SEEK_MARGIN) {
        panel.scrollTop -= panelBox.top + SEEK_MARGIN - nodeBox.top;
      }
      input.scrollTop = panel.scrollTop;
    }, [progress.cursor]);

    // 打字进度推到 store：统计条读它，「结束本轮」也从这里取当前进度结算。
    // 最后一项是布尔值而不是毫秒数 —— 每秒十次的计时刷新不会让这里变化，打字区因此不会跟着重渲染。
    useEffect(function () {
      var counters = countersRef.current;
      store.set({
        progress: {
          cursor: progress.cursor,
          correct: stats.correct,
          marks: stats.marks,
          total: target.length,
          wrongChars: counters.wrongChars.slice(-200),
          keyErrors: counters.keyErrors.slice(-200),
          pairs: counters.pairs.slice(-200),
        },
      });
    }, [progress, stats, target.length]);

    useEffect(function () {
      return function () {
        if (store.getSnapshot().timer.running) stopTimer();
      };
    }, []);

    return h(
      'div',
      { className: 'tp__stage' },
      h(
        'div',
        {
          className: 'tp__panel',
          ref: panelRef,
          onClick: function () {
            if (inputRef.current && inputRef.current.focus) inputRef.current.focus();
          },
        },
        layout
          ? h(TextLayer, { layout: layout, status: progress.status, cursor: progress.cursor, layerRef: layerRef })
          : h('span', { className: 'tp__text' }, target),
        h('textarea', {
          ref: inputRef,
          className: 'tp__input',
          defaultValue: '',
          spellCheck: false,
          autoCorrect: 'off',
          autoCapitalize: 'off',
          autoComplete: 'off',
          wrap: 'soft',
          'aria-label': '在这里打字。练习文本会逐字显示对错，当前要打的位置有光标。',
          onInput: onInput,
          onScroll: syncScroll,
          onPaste: onPaste,
          onCompositionStart: onCompositionStart,
          onCompositionEnd: onCompositionEnd,
        })
      )
    );
  }

  // ---------------------------------------------------------------------------
  // 统计条与结果
  // ---------------------------------------------------------------------------

  function StatsBar() {
    var state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    var progress = state.progress || { cursor: 0, correct: 0, marks: 0, total: 0 };
    var elapsed = state.timer.elapsedMs;
    var wpm = computeWpm(progress.correct, elapsed);
    var accuracy = computeAccuracy(progress.correct, progress.marks);
    var total = Math.max(1, progress.total || 1);

    return h(
      'div',
      { className: 'tp__stats', role: 'group', 'aria-label': '本次练习的实时数据' },
      h(
        'div',
        { className: 'tp__stat' },
        h('span', { className: 'tp__stat-label' }, '速度'),
        state.settings.showLiveWpm && elapsed > 0
          ? h('span', { className: 'tp__stat-value' }, wpm.toFixed(0), h('span', { className: 'tp__stat-unit' }, 'WPM'))
          : h('span', { className: 'tp__stat-value tp__stat-value--muted' }, state.settings.showLiveWpm ? '—' : '已隐藏')
      ),
      h(
        'div',
        { className: 'tp__stat' },
        h('span', { className: 'tp__stat-label' }, '准确率'),
        h(
          'span',
          { className: 'tp__stat-value' },
          progress.correct + progress.marks > 0 ? accuracy.toFixed(1) : '—',
          h('span', { className: 'tp__stat-unit' }, '%')
        )
      ),
      h(
        'div',
        { className: 'tp__stat' },
        h('span', { className: 'tp__stat-label' }, '用时'),
        h('span', { className: 'tp__stat-value' }, formatDuration(elapsed))
      ),
      h(
        'div',
        { className: 'tp__stat' },
        h('span', { className: 'tp__stat-label' }, '进度'),
        h(
          'span',
          { className: 'tp__stat-value' },
          Math.round((Math.min(progress.cursor, total) / total) * 100),
          h('span', { className: 'tp__stat-unit' }, '%')
        )
      ),
      h(
        'div',
        { className: 'tp__stat' },
        h('span', { className: 'tp__stat-label' }, '错按'),
        h('span', { className: 'tp__stat-value' }, String(progress.marks))
      )
    );
  }

  function ResultPanel(props) {
    var result = props.result;
    var best = props.best;

    return h(
      'div',
      { className: 'tp__result' },
      h(
        'div',
        { className: 'tp__result-head' },
        h('h2', { className: 'tp__result-title' }, result.partial ? '这一轮结束了' : '这一段完成了'),
        result.partial ? h('span', { className: 'tp__badge tp__badge--muted' }, '中途结束 · 不计入最好成绩') : null,
        !result.partial && best && best.wpm === result.wpm
          ? h('span', { className: 'tp__badge' }, '这段的最好成绩')
          : null
      ),
      h(
        'div',
        { className: 'tp__result-grid' },
        h(
          'div',
          { className: 'tp__result-cell' },
          h('span', { className: 'tp__stat-label' }, '速度'),
          h('strong', { className: 'tp__result-value' }, result.wpm.toFixed(1), h('span', { className: 'tp__stat-unit' }, 'WPM')),
          h('span', { className: 'tp__hint' }, '正确字符 ÷ 5 ÷ 分钟')
        ),
        h(
          'div',
          { className: 'tp__result-cell' },
          h('span', { className: 'tp__stat-label' }, '准确率'),
          h('strong', { className: 'tp__result-value' }, result.accuracy.toFixed(1), h('span', { className: 'tp__stat-unit' }, '%')),
          h('span', { className: 'tp__hint' }, '正确字符 ÷ 全部输入')
        ),
        h(
          'div',
          { className: 'tp__result-cell' },
          h('span', { className: 'tp__stat-label' }, '用时'),
          h('strong', { className: 'tp__result-value' }, formatDuration(result.durationMs))
        ),
        h(
          'div',
          { className: 'tp__result-cell' },
          h('span', { className: 'tp__stat-label' }, '错按'),
          h('strong', { className: 'tp__result-value' }, String(result.marks)),
          h('span', { className: 'tp__hint' }, '按错键的次数，含已改对的')
        )
      ),
      !result.partial && best && best.wpm > result.wpm
        ? h(
            'p',
            { className: 'tp__hint' },
            '这段的最好成绩是 ' + best.wpm.toFixed(1) + ' WPM（' + formatWhen(best.at) + '），差 ' +
              (best.wpm - result.wpm).toFixed(1) + '。'
          )
        : null,
      h(
        'div',
        { className: 'tp__result-actions' },
        h('button', { type: 'button', className: 'tp__btn tp__btn--primary', onClick: props.onRetry }, icons.refresh(14), '再来一次'),
        h('button', { type: 'button', className: 'tp__btn tp__btn--ghost', onClick: props.onPickAnother }, icons.list(14), '换一段'),
        h('button', { type: 'button', className: 'tp__btn tp__btn--ghost', onClick: props.onOpenAnalysis }, icons.chart(14), '看分析')
      )
    );
  }

  // ---------------------------------------------------------------------------
  // 历史与走势
  // ---------------------------------------------------------------------------

  function TrendChart(props) {
    var recent = props.recent || [];
    if (recent.length === 0) return null;
    var slice = recent.slice(-10);
    var max = 1;
    for (var i = 0; i < slice.length; i += 1) max = Math.max(max, slice[i].wpm);

    return h(
      'div',
      { className: 'tp__card' },
      h('h3', { className: 'tp__section-title' }, '速度走势'),
      h(
        'div',
        { className: 'tp__trend', role: 'img', 'aria-label': '最近 ' + slice.length + ' 次练习的速度走势' },
        slice.map(function (item, index) {
          var height = Math.max(4, Math.round((item.wpm / max) * 72));
          return h(
            'div',
            { key: String(item.at) + '-' + index, className: 'tp__trend-col', title: item.wpm.toFixed(1) + ' WPM' },
            h('span', { className: 'tp__trend-value' }, item.wpm.toFixed(0)),
            h('span', {
              className: 'tp__trend-bar' + (item.partial ? ' is-partial' : ''),
              style: { height: height + 'px' },
            }),
            h('span', { className: 'tp__trend-label' }, String(index + 1))
          );
        })
      ),
      h(
        'p',
        { className: 'tp__hint' },
        '最近 ' + slice.length + ' 次的速度，柱越高越快（本次最高 ' + max.toFixed(0) + ' WPM）。' +
          (slice.some(function (item) { return item.partial; }) ? '淡色的柱是中途结束的那几次。' : '')
      )
    );
  }

  function WeakKeys(props) {
    var weakKeys = props.weakKeys || {};
    var entries = Object.keys(weakKeys).map(function (key) {
      return { key: key, count: weakKeys[key] };
    });
    if (entries.length === 0) return null;
    entries.sort(function (a, b) {
      return b.count - a.count;
    });
    var top = entries.slice(0, 8);

    return h(
      'div',
      { className: 'tp__card' },
      h('h3', { className: 'tp__section-title' }, '你常打错的字符'),
      h(
        'ul',
        { className: 'tp__weak-list' },
        top.map(function (item) {
          return h(
            'li',
            { key: item.key, className: 'tp__weak-item' },
            h('code', { className: 'tp__weak-key' }, item.key === ' ' ? '空格' : item.key),
            h('span', { className: 'tp__weak-count' }, item.count + ' 次')
          );
        })
      )
    );
  }

  function HistoryList(props) {
    var records = props.records;
    var confirmState = useState(false);
    var confirming = confirmState[0];
    var setConfirming = confirmState[1];

    useEffect(function () {
      if (!confirming) return undefined;
      var timer = setTimeout(function () {
        setConfirming(false);
      }, 6000);
      return function () {
        clearTimeout(timer);
      };
    }, [confirming]);

    if (!props.loaded) {
      return h('p', { className: 'tp__placeholder' }, '正在读取练习记录…');
    }

    if (records.length === 0) {
      return h(
        'div',
        { className: 'tp__empty' },
        h('h2', { className: 'tp__empty-title' }, '还没有练习记录'),
        h(
          'p',
          { className: 'tp__empty-text' },
          '完整打完一段之后，这里会出现它的速度、准确率与用时。多打几次还能看到走势。'
        ),
        h('button', { type: 'button', className: 'tp__btn tp__btn--primary', onClick: props.onStart }, icons.play(14), '去练一段')
      );
    }

    return h(
      'div',
      { className: 'tp__history' },
      h(
        'div',
        { className: 'tp__history-cards' },
        h(TrendChart, { recent: props.recent }),
        h(WeakKeys, { weakKeys: props.weakKeys })
      ),
      h(
        'div',
        { className: 'tp__card' },
        h(
          'div',
          { className: 'tp__section-head' },
          h('h3', { className: 'tp__section-title' }, '最近 ' + records.length + ' 次'),
          h('span', { className: 'tp__hint' }, '最多保留 ' + RECORD_LIMIT + ' 条，超出后自动丢掉最旧的')
        ),
        h(
          'div',
          { className: 'tp__table-wrap' },
          h(
            'table',
            { className: 'tp__table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, '时间'),
                h('th', { scope: 'col' }, '练习的段落'),
                h('th', { scope: 'col' }, '速度'),
                h('th', { scope: 'col' }, '准确率'),
                h('th', { scope: 'col' }, '用时'),
                h('th', { scope: 'col' }, '错按')
              )
            ),
            h(
              'tbody',
              null,
              records.map(function (record) {
                return h(
                  'tr',
                  { key: record.key },
                  h('td', null, formatWhen(record.at)),
                  h('td', null, resolveSourceName(record.source) + (record.partial ? '（中途结束）' : '')),
                  h('td', { className: 'tp__num' }, record.wpm.toFixed(1)),
                  h('td', { className: 'tp__num' }, record.accuracy.toFixed(1) + '%'),
                  h('td', { className: 'tp__num' }, formatDuration(record.durationMs)),
                  h('td', { className: 'tp__num' }, String(record.marks))
                );
              })
            )
          )
        ),
        h(
          'div',
          { className: 'tp__history-actions' },
          confirming
            ? h(
                'span',
                { className: 'tp__confirm' },
                h('span', null, '确定清空全部 ' + records.length + ' 条记录？清空后无法恢复。'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'tp__btn tp__btn--danger',
                    onClick: function () {
                      setConfirming(false);
                      props.onClear();
                    },
                  },
                  '确认清空'
                ),
                h(
                  'button',
                  { type: 'button', className: 'tp__btn tp__btn--ghost', onClick: function () { setConfirming(false); } },
                  '取消'
                )
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'tp__btn tp__btn--danger-ghost',
                  onClick: function () {
                    setConfirming(true);
                  },
                },
                '清空历史'
              )
        )
      )
    );
  }

  // ---------------------------------------------------------------------------
  // 分析
  // ---------------------------------------------------------------------------

  /** 三排键位，按美式布局。中文输入法打拼音时用的也是这些键。 */
  var KEY_ROWS = [
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
  ];

  function KeyHeatmap(props) {
    var keyErrors = props.keyErrors || {};
    var upper = {};
    var max = 0;
    Object.keys(keyErrors).forEach(function (key) {
      var letter = key.toUpperCase();
      if (letter.length !== 1 || letter < 'A' || letter > 'Z') return;
      upper[letter] = (upper[letter] || 0) + keyErrors[key];
      max = Math.max(max, upper[letter]);
    });

    if (max === 0) {
      return h(
        'p',
        { className: 'tp__hint' },
        '还没有按错字母的记录。多打几次，这里会标出你最常按错的那几个键。'
      );
    }

    return h(
      'div',
      { className: 'tp__keyboard', role: 'img', 'aria-label': '美式键盘布局的按键出错热度' },
      KEY_ROWS.map(function (row, rowIndex) {
        return h(
          'div',
          { key: 'row-' + rowIndex, className: 'tp__keyboard-row' },
          row.map(function (letter) {
            var count = upper[letter] || 0;
            var ratio = max > 0 ? count / max : 0;
            return h(
              'span',
              {
                key: letter,
                className: 'tp__key' + (count > 0 ? ' has-errors' : ''),
                style: count > 0 ? { '--tp-heat': String(0.15 + ratio * 0.85) } : undefined,
                title: letter + '：按错 ' + count + ' 次',
              },
              h('span', { className: 'tp__key-letter' }, letter),
              count > 0 ? h('span', { className: 'tp__key-count' }, String(count)) : null
            );
          })
        );
      }),
      h(
        'p',
        { className: 'tp__hint' },
        '颜色越深表示这个键按错得越多。中文输入法打拼音时，字母按错同样会记在这里。'
      )
    );
  }

  function ConfusionTable(props) {
    var pairs = props.pairs || {};
    var entries = Object.keys(pairs).map(function (key) {
      var parts = key.split('<');
      return { expected: parts[0] || '?', actual: parts[1] || '?', count: pairs[key] };
    });
    if (entries.length === 0) return null;
    entries.sort(function (a, b) {
      return b.count - a.count;
    });
    var top = entries.slice(0, 10);

    return h(
      'div',
      { className: 'tp__card' },
      h('h3', { className: 'tp__section-title' }, '想打的和实际按下的'),
      h(
        'ul',
        { className: 'tp__confusion' },
        top.map(function (item, index) {
          return h(
            'li',
            { key: item.expected + '-' + item.actual + '-' + index, className: 'tp__confusion-item' },
            h('code', { className: 'tp__confusion-want' }, item.expected === ' ' ? '空格' : item.expected),
            h('span', { className: 'tp__confusion-arrow' }, '←'),
            h('code', { className: 'tp__confusion-got' }, item.actual === ' ' ? '空格' : item.actual === '?' ? '未输入' : item.actual),
            h('span', { className: 'tp__weak-count' }, item.count + ' 次')
          );
        })
      ),
      h('p', { className: 'tp__hint' }, '这一对一对的错法往往比「错得最多的字符」更能说明问题：它指向的是手指的固定误触。')
    );
  }

  function AnalysisView(props) {
    var analysis = props.analysis || { keystrokes: 0, mistakes: 0, keyErrors: {}, pairs: {} };
    var stats = props.stats || { recent: [], total: 0 };
    var recent = stats.recent || [];

    var confirmState = useState(false);
    var confirming = confirmState[0];
    var setConfirming = confirmState[1];

    useEffect(function () {
      if (!confirming) return undefined;
      var timer = setTimeout(function () {
        setConfirming(false);
      }, 6000);
      return function () {
        clearTimeout(timer);
      };
    }, [confirming]);

    var avgWpm = 0;
    var avgAccuracy = 0;
    var counted = 0;
    for (var i = 0; i < recent.length; i += 1) {
      avgWpm += recent[i].wpm;
      avgAccuracy += recent[i].accuracy;
      counted += 1;
    }
    if (counted > 0) {
      avgWpm /= counted;
      avgAccuracy /= counted;
    }
    var errorRate = analysis.keystrokes > 0 ? (analysis.mistakes / analysis.keystrokes) * 100 : 0;

    if (analysis.keystrokes === 0 && stats.total === 0) {
      return h(
        'div',
        { className: 'tp__empty' },
        h('h2', { className: 'tp__empty-title' }, '还没有可分析的数据'),
        h(
          'p',
          { className: 'tp__empty-text' },
          '打完一段之后，这里会告诉你：平均速度、平均准确率、哪个键最容易按错，' +
            '以及「想打某个字符却按了哪个键」这种固定误触。'
        ),
        h('button', { type: 'button', className: 'tp__btn tp__btn--primary', onClick: props.onStart }, icons.play(14), '去练一段')
      );
    }

    return h(
      'div',
      { className: 'tp__history' },
      h(
        'div',
        { className: 'tp__history-cards' },
        h(
          'div',
          { className: 'tp__card' },
          h('h3', { className: 'tp__section-title' }, '总体'),
          h(
            'div',
            { className: 'tp__summary' },
            h(
              'div',
              { className: 'tp__summary-cell' },
              h('span', { className: 'tp__stat-label' }, '累计练习'),
              h('strong', { className: 'tp__result-value' }, String(stats.total), h('span', { className: 'tp__stat-unit' }, '次'))
            ),
            h(
              'div',
              { className: 'tp__summary-cell' },
              h('span', { className: 'tp__stat-label' }, '平均速度'),
              h('strong', { className: 'tp__result-value' }, avgWpm.toFixed(1), h('span', { className: 'tp__stat-unit' }, 'WPM'))
            ),
            h(
              'div',
              { className: 'tp__summary-cell' },
              h('span', { className: 'tp__stat-label' }, '平均准确率'),
              h('strong', { className: 'tp__result-value' }, avgAccuracy.toFixed(1), h('span', { className: 'tp__stat-unit' }, '%'))
            ),
            h(
              'div',
              { className: 'tp__summary-cell' },
              h('span', { className: 'tp__stat-label' }, '按键出错率'),
              h('strong', { className: 'tp__result-value' }, errorRate.toFixed(2), h('span', { className: 'tp__stat-unit' }, '%')),
              h('span', { className: 'tp__hint' }, analysis.mistakes + ' / ' + analysis.keystrokes + ' 次按键')
            )
          ),
          h(
            'p',
            { className: 'tp__hint' },
            '「平均」取的是最近 ' + counted + ' 次记录。按键出错率是「按错的次数 ÷ 实际按键次数」，' +
              '它和准确率不同：准确率看的是最终打对了多少。'
          )
        ),
        h(ConfusionTable, { pairs: analysis.pairs }),
        h(TrendChart, { recent: recent }),
        h(WeakKeys, { weakKeys: stats.weakKeys })
      ),
      h(
        'div',
        { className: 'tp__card' },
        h(
          'div',
          { className: 'tp__section-head' },
          h('h3', { className: 'tp__section-title' }, '你最常按错的键'),
          h('span', { className: 'tp__hint' }, '统计的是你实际按下的键')
        ),
        h(KeyHeatmap, { keyErrors: analysis.keyErrors })
      ),
      h(
        'div',
        { className: 'tp__history-actions' },
        confirming
          ? h(
              'span',
              { className: 'tp__confirm' },
              h('span', null, '确定清空分析数据？累计的按键统计与误触对照会被清掉，历史记录不受影响。'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tp__btn tp__btn--danger',
                  onClick: function () {
                    setConfirming(false);
                    props.onClearAnalysis();
                  },
                },
                '确认清空'
              ),
              h(
                'button',
                { type: 'button', className: 'tp__btn tp__btn--ghost', onClick: function () { setConfirming(false); } },
                '取消'
              )
            )
          : h(
              'button',
              {
                type: 'button',
                className: 'tp__btn tp__btn--danger-ghost',
                onClick: function () {
                  setConfirming(true);
                },
              },
              '清空分析数据'
            )
      )
    );
  }

  // ---------------------------------------------------------------------------
  // 选段、导入与设置
  // ---------------------------------------------------------------------------

  function LessonPicker(props) {
    var settings = props.settings;
    var langs = [
      { id: 'all', label: '全部' },
      { id: 'zh', label: '中文' },
      { id: 'en', label: '英文' },
    ];
    var list = BUILT_IN.filter(function (lesson) {
      return settings.language === 'all' || lesson.lang === settings.language;
    });

    var editorState = useState(false);
    var editorOpen = editorState[0];
    var setEditorOpen = editorState[1];

    var textState = useState('');
    var customDraft = textState[0];
    var setCustomDraft = textState[1];

    var nameState = useState('');
    var customName = nameState[0];
    var setCustomName = nameState[1];

    var errorState = useState(null);
    var error = errorState[0];
    var setError = errorState[1];

    var busyState = useState(false);
    var busy = busyState[0];
    var setBusy = busyState[1];

    var fileRef = useRef(null);

    function submit() {
      setBusy(true);
      setError(null);
      saveCustomText(customDraft, customName.trim() || '我导入的文本').then(function (result) {
        setBusy(false);
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        setCustomDraft('');
        setCustomName('');
        setEditorOpen(false);
        props.onSavedText(result.entry.id);
      });
    }

    function onFile(event) {
      var file = event.target.files && event.target.files[0];
      event.target.value = ''; // 允许连续导入同一个文件
      if (!file) return;
      if (file.size > IMPORT_MAX_BYTES) {
        setError('这个文件太大了（' + Math.round(file.size / 1024) + ' KB），请选一个 400 KB 以内的纯文本文件。');
        return;
      }
      file
        .text()
        .then(function (value) {
          if (!looksLikeText(value)) {
            setError('这看起来不是纯文本文件（可能是 Word / PDF 之类的格式）。请另存为 .txt 后再导入。');
            return;
          }
          setCustomDraft(value);
          if (!customName) {
            setCustomName(file.name.replace(/\.[^.]+$/, '').slice(0, CUSTOM_NAME_MAX));
          }
          setError(null);
          setEditorOpen(true);
        })
        .catch(function (err) {
          ctx.logger.warn('读取导入的文件失败', err);
          setError('没能读取这个文件：' + ((err && err.message) || '未知原因') + '。');
        });
    }

    return h(
      'div',
      { className: 'tp__picker' },
      h(
        'div',
        { className: 'tp__picker-row' },
        h(
          'div',
          { className: 'tp__segment', role: 'group', 'aria-label': '语料语言' },
          langs.map(function (item) {
            return h(
              'button',
              {
                key: item.id,
                type: 'button',
                className: 'tp__segment-btn' + (settings.language === item.id ? ' is-active' : ''),
                'aria-pressed': settings.language === item.id,
                onClick: function () {
                  props.onChangeSettings({ language: item.id });
                },
              },
              item.label
            );
          })
        ),
        h('span', { className: 'tp__card-spacer' }),
        h(
          'button',
          {
            type: 'button',
            className: 'tp__btn tp__btn--ghost tp__btn--tight',
            'aria-expanded': editorOpen,
            onClick: function () {
              setEditorOpen(!editorOpen);
              setError(null);
            },
          },
          icons.upload(13),
          editorOpen ? '收起' : '添加 / 导入练习文本'
        ),
        h('input', {
          ref: fileRef,
          type: 'file',
          className: 'tp__file',
          accept: '.txt,.md,.markdown,.csv,.log,text/plain',
          tabIndex: -1,
          'aria-hidden': 'true',
          onChange: onFile,
        })
      ),
      editorOpen
        ? h(
            'div',
            { className: 'tp__custom' },
            h(
              'div',
              { className: 'tp__custom-row' },
              h('input', {
                className: 'tp__input tp__input--name',
                value: customName,
                maxLength: CUSTOM_NAME_MAX,
                placeholder: '给它起个名字（可留空）',
                'aria-label': '这份练习文本的名字',
                onChange: function (event) {
                  setCustomName(event.target.value);
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tp__btn tp__btn--ghost tp__btn--tight',
                  onClick: function () {
                    if (fileRef.current) fileRef.current.click();
                  },
                },
                icons.upload(13),
                '从文本文件导入'
              ),
              h('span', { className: 'tp__hint' }, '支持 .txt / .md 等纯文本，400 KB 以内')
            ),
            h('textarea', {
              className: 'tp__textarea',
              value: customDraft,
              rows: 5,
              placeholder:
                '把想练的文本粘到这里，或点上面的「从文本文件导入」。' +
                CUSTOM_TEXT_MIN + '–' + CUSTOM_TEXT_MAX + ' 字，原文里怎么换行都行。',
              'aria-label': '自定义练习文本',
              onChange: function (event) {
                setCustomDraft(event.target.value);
                setError(null);
              },
            }),
            h(
              'div',
              { className: 'tp__custom-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'tp__btn tp__btn--primary tp__btn--tight',
                  disabled: busy || customDraft.trim().length === 0,
                  onClick: submit,
                },
                busy ? '正在保存…' : '保存并开始练'
              ),
              h('span', { className: 'tp__hint' }, customDraft.length + ' / ' + CUSTOM_TEXT_MAX),
              error ? h('span', { className: 'tp__form-error', role: 'alert' }, error) : null
            )
          )
        : null,
      props.customIndex.length > 0
        ? h(
            'div',
            { className: 'tp__custom-list' },
            props.customIndex.map(function (item) {
              return h(
                'span',
                { key: item.id, className: 'tp__chip tp__chip--with-action' + (props.activeCustomId === item.id ? ' is-active' : '') },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'tp__chip-main',
                    'aria-pressed': props.activeCustomId === item.id,
                    onClick: function () {
                      props.onPickCustom(item.id);
                    },
                  },
                  item.name,
                  h('span', { className: 'tp__chip-meta' }, item.chars + ' 字')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'tp__chip-remove',
                    'aria-label': '删除这份文本：' + item.name,
                    title: '删除这份文本',
                    onClick: function () {
                      props.onDeleteCustom(item.id);
                    },
                  },
                  icons.trash(12)
                )
              );
            })
          )
        : null,
      h(
        'div',
        { className: 'tp__chips' },
        list.map(function (lesson) {
          return h(
            'button',
            {
              key: lesson.id,
              type: 'button',
              className: 'tp__chip' + (props.currentId === lesson.id ? ' is-active' : ''),
              'aria-pressed': props.currentId === lesson.id,
              onClick: function () {
                props.onPick(lesson.id);
              },
            },
            lesson.label,
            h('span', { className: 'tp__chip-meta' }, lesson.text.replace(/\s+/g, '').length + ' 字')
          );
        })
      )
    );
  }

  function SettingsRow(props) {
    var settings = props.settings;
    return h(
      'div',
      { className: 'tp__settings' },
      h(
        'label',
        { className: 'tp__setting' },
        h('input', {
          type: 'checkbox',
          checked: settings.showLiveWpm,
          onChange: function (event) {
            props.onChangeSettings({ showLiveWpm: event.target.checked });
          },
        }),
        h('span', null, '显示实时速度')
      ),
      h(
        'label',
        { className: 'tp__setting' },
        h('input', {
          type: 'checkbox',
          checked: settings.strict,
          onChange: function (event) {
            props.onChangeSettings({ strict: event.target.checked });
          },
        }),
        h('span', null, '严格模式'),
        h('span', { className: 'tp__hint' }, '打错了必须先退格改对，光标才会继续前进')
      ),
      h(
        'label',
        { className: 'tp__setting tp__setting--sound' },
        h('span', { className: 'tp__setting-icon', 'aria-hidden': 'true' }, settings.soundVolume > 0 ? icons.volume(14) : icons.volumeOff(14)),
        h('span', null, '打字音效'),
        h('input', {
          type: 'range',
          className: 'tp__range',
          min: 0,
          max: 100,
          step: 5,
          value: settings.soundVolume,
          'aria-label': '打字音效音量',
          onChange: function (event) {
            var volume = Number(event.target.value);
            if (volume > 0) unlockAudio();
            props.onChangeSettings({ soundVolume: volume });
            if (volume > 0) sound.key();
          },
        }),
        h('span', { className: 'tp__range-value' }, settings.soundVolume === 0 ? '静音' : settings.soundVolume + '%')
      )
    );
  }

  // ---------------------------------------------------------------------------
  // 主组件
  // ---------------------------------------------------------------------------

  function TypingPractice() {
    var state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    var active = Modulith.useModuleActive();

    var currentState = useState(BUILT_IN[0].id);
    var currentId = currentState[0];
    var setCurrentId = currentState[1];

    var runState = useState(0);
    var runId = runState[0];
    var setRunId = runState[1];

    var noticeState = useState(null);
    var notice = noticeState[0];
    var setNotice = noticeState[1];

    var endConfirmState = useState(false);
    var endConfirm = endConfirmState[0];
    var setEndConfirm = endConfirmState[1];

    // 首次进入
    useEffect(function () {
      loadAll().then(function () {
        if (store.getSnapshot().activeCustomText.length >= CUSTOM_TEXT_MIN && store.getSnapshot().settings.lastSource === 'custom') {
          setCurrentId('custom');
        }
      });
    }, []);

    // 只有看历史时才去读记录文件
    useEffect(function () {
      if (state.view !== 'history' || state.recordsLoaded) return undefined;
      loadHistory();
      return undefined;
    }, [state.view, state.recordsLoaded]);

    useEffect(function () {
      if (!notice) return undefined;
      var timer = setTimeout(function () {
        setNotice(null);
      }, 4000);
      return function () {
        clearTimeout(timer);
      };
    }, [notice]);

    useEffect(function () {
      if (!endConfirm) return undefined;
      var timer = setTimeout(function () {
        setEndConfirm(false);
      }, 5000);
      return function () {
        clearTimeout(timer);
      };
    }, [endConfirm]);

    // 重新可见时补读一次累计数据（分屏另一半可能刚练过）
    useEffect(function () {
      if (!active) return undefined;
      loadStats();
      loadAnalysis();
      return undefined;
    }, [active]);

    var lesson = useMemo(
      function () {
        if (currentId === 'custom') {
          return { id: 'custom', lang: 'custom', label: '自定义文本', text: state.activeCustomText };
        }
        return lessonById(currentId) || BUILT_IN[0];
      },
      [currentId, state.activeCustomText]
    );

    var best = useMemo(
      function () {
        var bestMap = state.stats.best || {};
        return bestMap[lesson.id] || null;
      },
      [state.stats, lesson.id]
    );

    function startRun(id) {
      setCurrentId(id);
      setRunId(runId + 1);
      resetTimer();
      store.set({ lastResult: null, view: 'practice', saveError: null });
    }

    function pick(id) {
      if (id === 'custom' && state.activeCustomText.length < CUSTOM_TEXT_MIN) {
        setNotice('还没有可用的自定义文本 —— 先点「添加 / 导入练习文本」。');
        return;
      }
      startRun(id);
      saveSettings({ lastSource: id === 'custom' ? 'custom' : 'builtin' });
    }

    /** 把一轮的结果落到界面、记录与分析里。中途结束的轮次会被标成 partial。 */
    function commitResult(raw, partial) {
      var wpm = computeWpm(raw.correct, raw.durationMs);
      var accuracy = computeAccuracy(raw.correct, raw.marks);
      var result = {
        at: raw.at,
        source: raw.source,
        sourceName: resolveSourceName(raw.source),
        durationMs: raw.durationMs,
        correct: raw.correct,
        marks: raw.marks,
        wpm: Math.round(wpm * 10) / 10,
        accuracy: Math.round(accuracy * 10) / 10,
        partial: !!partial,
      };
      store.set({ lastResult: result, saveError: null });
      if (raw.correct + raw.marks === 0) return; // 一个字都没打，不写记录
      saveRecord(
        {
          at: raw.at,
          source: raw.source,
          durationMs: raw.durationMs,
          correct: raw.correct,
          wpm: wpm,
          accuracy: accuracy,
          marks: raw.marks,
          partial: !!partial,
        },
        raw.wrongChars || [],
        {
          keystrokes: raw.correct + raw.marks,
          mistakes: raw.marks,
          keyErrors: raw.keyErrors || [],
          pairs: raw.pairs || [],
        }
      );
    }

    /**
     * 中途结束：把当前进度结算成一轮结果（标记为 partial，不计入「最好成绩」）。
     * 一个字都没打就不结算 —— 那只会往历史里塞一条没有意义的记录。
     */
    function endRun() {
      var timer = store.getSnapshot().timer;
      var progress = store.getSnapshot().progress || {};
      if (!timer.running && timer.elapsedMs === 0) {
        setNotice('还没有开始打字，先把光标放到打字区，敲下第一个键。');
        return;
      }
      if (!progress.correct && !progress.marks) {
        setNotice('这一轮还没有任何输入，没有可结算的成绩。');
        return;
      }
      stopTimer();
      commitResult(
        {
          at: nowIso(),
          source: lesson.id,
          durationMs: store.getSnapshot().timer.elapsedMs || 1,
          correct: progress.correct || 0,
          marks: progress.marks || 0,
          wrongChars: progress.wrongChars || [],
          keyErrors: progress.keyErrors || [],
          pairs: progress.pairs || [],
        },
        true
      );
      setRunId(runId + 1);
    }

    var header = h(
      'header',
      { className: 'tp__header' },
      h(
        'div',
        { className: 'tp__header-top' },
        h(
          'div',
          { className: 'tp__title-block' },
          h('h1', { className: 'tp__title' }, '打字练习'),
          h(
            'p',
            { className: 'tp__subtitle' },
            '速度按「正确字符 ÷ 5 ÷ 分钟」算，准确率是正确字符占全部输入的比例。' +
              (state.stats.total > 0 ? '已经练过 ' + state.stats.total + ' 次。' : '')
          )
        ),
        h(
          'div',
          { className: 'tp__tabs', role: 'tablist', 'aria-label': '视图切换' },
          [
            { id: 'practice', label: '练习' },
            { id: 'analysis', label: '分析' },
            { id: 'history', label: '历史' },
          ].map(function (item) {
            return h(
              'button',
              {
                key: item.id,
                type: 'button',
                role: 'tab',
                className: 'tp__tab' + (state.view === item.id ? ' is-active' : ''),
                'aria-selected': state.view === item.id,
                onClick: function () {
                  store.set({ view: item.id });
                },
              },
              item.label
            );
          })
        )
      )
    );

    var body;
    if (state.status === 'loading') {
      body = h('p', { className: 'tp__placeholder' }, '正在准备练习环境…');
    } else if (state.status === 'error') {
      body = h(
        'div',
        { className: 'tp__banner tp__banner--error', role: 'alert' },
        h('span', { className: 'tp__banner-text' }, state.errorMessage),
        h('button', { type: 'button', className: 'tp__btn tp__btn--ghost', onClick: loadAll }, '重新读取')
      );
    } else if (state.view === 'analysis') {
      body = h(AnalysisView, {
        analysis: state.analysis,
        stats: state.stats,
        onStart: function () {
          store.set({ view: 'practice' });
        },
        onClearAnalysis: resetAnalysis,
      });
    } else if (state.view === 'history') {
      body = h(HistoryList, {
        loaded: state.recordsLoaded,
        records: state.records,
        recent: state.stats.recent,
        weakKeys: state.stats.weakKeys,
        onStart: function () {
          store.set({ view: 'practice' });
        },
        onClear: clearHistory,
      });
    } else if (state.lastResult) {
      body = h(
        'div',
        { className: 'tp__practice tp__practice--result' },
        h(ResultPanel, {
          result: state.lastResult,
          best: best,
          onRetry: function () {
            startRun(lesson.id);
          },
          onPickAnother: function () {
            store.set({ lastResult: null });
          },
          onOpenAnalysis: function () {
            store.set({ view: 'analysis' });
          },
        })
      );
    } else {
      body = h(
        'div',
        { className: 'tp__practice' },
        h(
          'div',
          { className: 'tp__practice-head' },
          h(
            'div',
            { className: 'tp__lesson-name' },
            h('strong', null, lesson.label),
            h('span', { className: 'tp__hint' }, normalizeText(lesson.text).length + ' 字 · 打完自动结束')
          ),
          h('span', { className: 'tp__card-spacer' }),
          h(StatsBar),
          h(
            'button',
            {
              type: 'button',
              className: 'tp__btn tp__btn--ghost tp__btn--tight',
              onClick: function () {
                endRun();
              },
            },
            icons.flag(13),
            '结束本轮'
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'tp__btn tp__btn--ghost tp__btn--tight',
              onClick: function () {
                startRun(lesson.id);
              },
            },
            icons.refresh(13),
            '重来'
          )
        ),
        h(PracticeArea, {
          key: lesson.id + ':' + runId,
          text: lesson.text,
          lessonId: lesson.id,
          onFinished: function (raw) {
            commitResult(raw, false);
          },
          onNotice: setNotice,
          onStrictBlocked: function () {
            setNotice('严格模式：先把打错的那个字符改对，才能继续往下打。');
          },
        }),
        h(LessonPicker, {
          settings: state.settings,
          currentId: lesson.id,
          customIndex: state.customIndex,
          activeCustomId: state.activeCustomId,
          onPick: pick,
          onPickCustom: function (id) {
            useCustomText(id).then(function (result) {
              if (!result.ok) {
                setNotice(result.reason);
                return;
              }
              startRun('custom');
              saveSettings({ lastSource: 'custom' });
            });
          },
          onSavedText: function () {
            startRun('custom');
            saveSettings({ lastSource: 'custom' });
          },
          onDeleteCustom: function (id) {
            deleteCustomText(id);
          },
          onChangeSettings: saveSettings,
        }),
        h(SettingsRow, { settings: state.settings, onChangeSettings: saveSettings })
      );
    }

    return h(
      'div',
      { className: 'tp' },
      header,
      notice
        ? h(
            'div',
            { className: 'tp__banner tp__banner--notice', role: 'status' },
            h('span', { className: 'tp__banner-text' }, notice),
            h(
              'button',
              { type: 'button', className: 'tp__icon-btn', 'aria-label': '关闭提示', onClick: function () { setNotice(null); } },
              icons.close(14)
            )
          )
        : null,
      state.saveError
        ? h(
            'div',
            { className: 'tp__banner tp__banner--error', role: 'alert' },
            h('span', { className: 'tp__banner-text' }, state.saveError),
            h(
              'button',
              {
                type: 'button',
                className: 'tp__icon-btn',
                'aria-label': '关闭提示',
                onClick: function () {
                  store.set({ saveError: null });
                },
              },
              icons.close(14)
            )
          )
        : null,
      body
    );
  }

  // ---------------------------------------------------------------------------
  // 注册：必须在 IIFE 顶层**同步**完成
  // ---------------------------------------------------------------------------

  Modulith.registerModule({
    id: 'typingPractice',
    name: '打字练习',
    displayName: '打字练习',
    description: '逐字符判定的打字练习，带速度、准确率、错字分析与历史走势',
    icon: 'Keyboard',
    priority: 75,
    category: '效率',
    component: TypingPractice,
  });

  ctx.logger.info('打字练习插件加载完成', { host: Modulith.version });
})();
