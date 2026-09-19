// plugins/regex-lab/index.js
//
// 正则实验场 —— 边写边看：匹配高亮、捕获组明细、替换预览。
//
// 手写 IIFE，不使用构建工具，因此不能写 JSX，全部用 `React.createElement`（简写为 h）。
//
// 只申请一项权限：
//   storage —— 表达式草稿、界面设置、以及用户自己保存的表达式片段
// 不申请 network（一切在本机算完）、不申请 filesystem-read（没有文件读写）、
// 不申请 notification（结果就地显示，不打断用户）。
//
// 四个决定写在最前面，免得被误认成疏忽：
//
// 1. **正则跑在 Worker 里，并且带真正的超时中断。**
//    灾难性回溯（`(a+)+$` 配一长串 a 是最常见的例子）会让一次匹配耗时以分钟计，
//    而 JS 是单线程的 —— 在主线程上跑它，整个应用会一起卡死，连「停止」按钮都点不动。
//    因此计算放在 Worker 中，超过 1.2 秒直接 terminate。这是本插件唯一能真正做到
//    「中断一条正则」的办法，也是它区别于网页版正则测试工具的地方。
//    Worker 用 Blob URL 现场创建 —— 插件不引入依赖，也就不可能有独立的 worker 文件。
//    若该环境不允许创建 Blob Worker，自动降级到主线程，并同时收紧可处理的文本长度
//    （主线程上跑长文本 = 界面卡住，这个代价必须说清而不是硬扛，见 README）。
//
// 2. **计算逻辑只有一份。** runJob() 同时供主线程与 Worker 使用 —— Worker 的源码是
//    把同一个函数 toString() 之后拼出来的。两份实现必然漂移，本仓库的文档里反复出现
//    这条教训，因此这里刻意不给 Worker 另写一份。
//
// 3. **结果永远标注它是由哪一份输入算出来的。** 从输入变化到结果回来有一段异步窗口。
//    若把结果直接画出来，用户会看到「基于旧表达式的匹配」配着「新表达式的输入框」——
//    正是最难发现的那类问题。因此结果里带着 pattern / flags / text 三个指纹，对不上就
//    只显示「正在重新计算」，绝不显示可能过期的匹配。
//
// 4. **内部给正则附一个 d 开关。** d 不改变匹配结果，只是让每个捕获组额外带上起止位置，
//    因此「第 2 组在第 14–18 个字符」这类信息可以一直显示，而界面上给用户的开关保持不变。

(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    // 宿主接口不存在时明确报错并退出，不要继续往下跑
    console.error('[regex-lab] 未找到 window.Modulith，插件无法加载');
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
  // 存储键。只允许字母数字与 . _ -，最长 128 字符
  // ============================================================

  var KEY_SETTINGS = 'settings';
  var KEY_DRAFT_PATTERN = 'draft.pattern';
  var KEY_DRAFT_FLAGS = 'draft.flags';
  var KEY_DRAFT_TEXT = 'draft.text';
  var KEY_DRAFT_REPLACE = 'draft.replace';
  var SAVED_PREFIX = 'saved.';
  var SAVED_LIMIT = 40;

  // ============================================================
  // 上限。这些数字不是随手定的，每条后面都写了理由。
  // ============================================================

  /** 一次最多收集多少个匹配。再多也没有展示价值，只会把内存吃光 */
  var LIMIT_MATCHES = 5000;
  /** 高亮层最多画多少个匹配。每个匹配至少两个节点，上千个之后重排会肉眼可见地变慢 */
  var LIMIT_RENDER_HITS = 800;
  /** 明细表最多画多少行 */
  var LIMIT_DETAIL_ROWS = 300;
  /** 超过这个长度就不再随输入自动计算，改为手动点「计算」 */
  var TEXT_AUTO_MAX = 100000;
  /** Worker 模式的文本硬上限 */
  var TEXT_WORKER_MAX = 2000000;
  /**
   * 主线程降级模式的文本硬上限。
   *
   * 主线程上无法中断一条正则 —— 超过这个长度就不执行，并明确告诉用户为什么。
   * 硬扛的后果是整个应用卡死，而用户不会把「应用卡死」和「我点了计算」联系起来。
   */
  var TEXT_MAIN_MAX = 20000;
  /** 输入停止多久之后开始计算 */
  var DEBOUNCE_MS = 160;
  /** 一次计算的超时。到点 terminate Worker，并给出可能是灾难性回溯的判断 */
  var JOB_TIMEOUT_MS = 1200;
  /** 草稿写盘的延迟。文档里存的是测试文本，可能很大，不必每次按键都落盘 */
  var DRAFT_SAVE_MS = 700;
  /** 保存的表达式的名字上限 */
  var NAME_MAX = 32;
  /** 保存的表达式最多多少条 */
  var SAVED_MAX = SAVED_LIMIT;

  var DISPLAY_TABS = [
    { id: 'match', label: '匹配高亮' },
    { id: 'detail', label: '捕获组明细' },
    { id: 'replace', label: '替换预览' },
    { id: 'library', label: '表达式库' },
  ];

  var FLAG_LIST = [
    { flag: 'g', name: '全局', hint: '找出全部匹配；关掉它只找第一个' },
    { flag: 'i', name: '忽略大小写', hint: 'A 与 a 视为同一个字符' },
    { flag: 'm', name: '多行', hint: '^ 与 $ 分别匹配每一行的开头与结尾' },
    { flag: 's', name: '点号含换行', hint: '. 也能匹配换行符' },
    { flag: 'u', name: 'Unicode', hint: '按完整码点解释，可使用 \\p{...}' },
    { flag: 'v', name: 'Unicode 集合', hint: 'u 的增强版，两者不能同时开启' },
    { flag: 'y', name: '粘连', hint: '只从上一处结束的位置继续匹配' },
    { flag: 'd', name: '记录组位置', hint: '额外记录每个捕获组的起止位置' },
  ];

  var DEFAULT_SETTINGS = {
    /** -1 表示高亮整个匹配，否则高亮该序号的捕获组 */
    highlightGroup: -1,
  };

  // ============================================================
  // 内置表达式库
  //
  // 每条都配了能看出效果的一小段示例文本，点「载入」会把表达式与示例一起填好 ——
  // 空手试正则最难的一步是「先得有一段能匹配的文本」。
  // ============================================================

  var BUILT_INS = [
    {
      id: 'email',
      group: '常见校验',
      name: '电子邮箱',
      note: '宽松匹配：不拒绝少见但合法的地址，因此也不会拦下不存在的域名。做严格校验应当靠发信确认。',
      pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
      flags: 'g',
      sample: '联系：zhang.san@example.com，备用 zs+work@mail.example.co.uk，无效的 a@b。',
    },
    {
      id: 'ipv4',
      group: '常见校验',
      name: 'IPv4 地址',
      note: '逐段限制在 0–255，因此 256.1.1.1 不会被误判为合法。',
      pattern: '\\b(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)){3}\\b',
      flags: 'g',
      sample: '网关 192.168.1.1，DNS 8.8.8.8 与 223.5.5.5，非法地址 256.1.1.1。',
    },
    {
      id: 'cn-mobile',
      group: '常见校验',
      name: '中国大陆手机号',
      note: '只判断号段与长度。归属地与在网状态查不到，那不是正则能回答的问题。',
      pattern: '\\b1[3-9]\\d{9}\\b',
      flags: 'g',
      sample: '客服 13812345678，座机 010-12345678，订单号 1234567890123。',
    },
    {
      id: 'date-iso',
      group: '常见校验',
      name: '日期（年-月-日）',
      note: '捕获组分别是年、月、日，便于在替换里用 $1、$2、$3 重排。',
      pattern: '\\b(\\d{4})-(\\d{2})-(\\d{2})\\b',
      flags: 'g',
      sample: '开始 2026-09-19，结束 2026-12-31，版本号 1-2-3。',
    },
    {
      id: 'time-hms',
      group: '常见校验',
      name: '时间（时:分[:秒]）',
      note: '小时限制在 00–23、分钟与秒限制在 00–59。',
      pattern: '\\b([01]\\d|2[0-3]):([0-5]\\d)(?::([0-5]\\d))?\\b',
      flags: 'g',
      sample: '上班 09:00，会议 14:30:15，结束 23:59，非法 25:61。',
    },
    {
      id: 'uuid',
      group: '常见校验',
      name: 'UUID',
      note: '常见为 8-4-4-4-12 的十六进制写法，不校验版本位。',
      pattern: '\\b[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\\b',
      flags: 'g',
      sample: '标识 550e8400-e29b-41d4-a716-446655440000 出现两次；\n另一个 550e8400e29b41d4a716446655440000 不是。',
    },
    {
      id: 'hex-color',
      group: '常见校验',
      name: '十六进制颜色',
      note: '三位的简写与六位的完整写法都算，不认 #abcd 这类四位写法（那是另一位一档的透明色）。',
      pattern: '#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\\b',
      flags: 'g',
      sample: '主色 #4f46e5，浅底 #eef2ff，描边 #e5e7eb，短写 #fff。',
    },
    {
      id: 'id-card',
      group: '常见校验',
      name: '身份证号（18 位）',
      note: '只校验位数与格式，**不校验校验位**，也不判断号码是否真实存在。',
      pattern: '\\b[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]\\b',
      flags: 'g',
      sample: '示例 11010119900307123X，位数不足 1101011990030712。',
    },
    {
      id: 'url',
      group: '提取',
      name: '网址链接',
      note: '从 http 或 https 开始，遇到空白或引号就结束。能在整段文字里把链接挑出来。',
      pattern: 'https?://[^\\s<>"\')]+',
      flags: 'g',
      sample: '文档 https://github.com/Rinntheor/modulith-desktop 与 http://127.0.0.1:43129/index.html 都在这里。',
    },
    {
      id: 'domain',
      group: '提取',
      name: '域名',
      note: '要求至少有一个点和一个 2 位以上的顶级域，因此不会把小数 3.14 当成域名。',
      pattern: '\\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,}\\b',
      flags: 'g',
      sample: '访问 example.com 与 sub.mail.example.co.uk，版本 3.14 不是域名。',
    },
    {
      id: 'han',
      group: '提取',
      name: '中文汉字',
      note: '只覆盖基本区汉字，不含生僻字扩展区与标点。',
      pattern: '[\\u4e00-\\u9fa5]+',
      flags: 'g',
      sample: '这是一段中文 mixed with English words 和 123 数字。',
    },
    {
      id: 'md-link',
      group: '提取',
      name: 'Markdown 链接',
      note: '第 1 组是链接文字，第 2 组是地址。',
      pattern: '\\[([^\\]]+)\\]\\(([^)]+)\\)',
      flags: 'g',
      sample: '见 [插件仓库](https://github.com/Rinntheor/modulith-plugins) 与 [宿主](https://github.com/Rinntheor/modulith-desktop)。',
    },
    {
      id: 'html-tag',
      group: '提取',
      name: 'HTML 标签',
      note: '第 1 组是标签名。不解析嵌套，也不是一个 HTML 解析器。',
      pattern: '<([a-zA-Z][\\w-]*)\\b[^>]*>',
      flags: 'g',
      sample: '<div class="card"><span>文字</span><img src="a.png" /></div>',
    },
    {
      id: 'dup-word',
      group: '查找',
      name: '重复的英文单词',
      note: '\\1 是反向引用，指「和刚才那个单词相同」。第 1 组是重复的那个词。',
      pattern: '\\b(\\w+)\\s+\\1\\b',
      flags: 'gi',
      sample: 'This is is a test of of the the repeated words.',
    },
    {
      id: 'key-value',
      group: '提取',
      name: '键值对',
      note: '第 1 组是键，第 2 组是值（可能带引号）。',
      pattern: '([A-Za-z_][\\w.-]*)\\s*=\\s*("[^"]*"|\'[^\']*\'|[^\\s;]+)',
      flags: 'g',
      sample: 'name="modulith" version=1.0.0 debug=true path=\'C:/app/data\'',
    },
    {
      id: 'trailing-space',
      group: '清理',
      name: '行尾空白',
      note: '开了 m，因此 $ 是每一行的结尾。替换留空即可去掉。',
      pattern: '[ \\t]+$',
      flags: 'gm',
      sample: '第一行行尾有三个空格   \n第二行行尾有制表符\t\n第三行干净',
    },
    {
      id: 'blank-lines',
      group: '清理',
      name: '连续空行',
      note: '把三段以上的换行收成两个换行（即一个空行），替换里填 \\n\\n。',
      pattern: '\\n{3,}',
      flags: 'g',
      replacement: '\n\n',
      sample: '第一段\n\n\n\n第二段\n\n\n第三段',
    },
    {
      id: 'spaces',
      group: '清理',
      name: '连续空格',
      note: '把两个以上的普通空格收成一个。不处理全角空格与制表符。',
      pattern: ' {2,}',
      flags: 'g',
      replacement: ' ',
      sample: '这段  文字里   有多处    多余空格。',
    },
    {
      id: 'trailing-comma',
      group: '清理',
      name: '多余的尾随逗号',
      note: '匹配逗号加后面的收尾括号，第 1 组是那个括号 —— 替换写成 $1 就把逗号去掉了。',
      pattern: ',([ \\t]*[\\]}])',
      flags: 'g',
      replacement: '$1',
      sample: '{\n  "a": 1,\n  "b": [1, 2, 3,],\n}',
    },
    {
      id: 'camel-to-snake',
      group: '开发',
      name: '小驼峰转下划线',
      note: '在替换里写 $1_$2，把 userName 变成 user_name。',
      pattern: '([a-z0-9])([A-Z])',
      flags: 'g',
      replacement: '$1_$2',
      sample: 'getUserNameById 与 parseHTTPResponse 与 version2Value',
    },
    {
      id: 'log-time',
      group: '开发',
      name: '日志里的时间戳',
      note: '第 1 组是时间部分，便于提取或按时间筛选。',
      pattern: '\\[(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2})\\]',
      flags: 'g',
      sample: '[2026-09-19 09:41:05] INFO 启动完成\n[2026-09-19T09:41:06] WARN 未找到配置',
    },
    {
      id: 'quoted',
      group: '开发',
      name: '双引号字符串',
      note: '第 1 组是引号内的内容，内部的反斜杠转义也已考虑。',
      pattern: '"((?:[^"\\\\]|\\\\.)*)"',
      flags: 'g',
      sample: 'name: "modulith", path: "C:\\\\app\\\\data", empty: ""',
    },
    {
      id: 'sql-named-param',
      group: '开发',
      name: '具名参数',
      note: '命名组写法示例：第 1 组名为 name。命名组会单独列在明细里。',
      pattern: ':(?<name>[A-Za-z_][A-Za-z0-9_]*)',
      flags: 'g',
      sample: 'SELECT * FROM t WHERE a = :userId AND b = :status_code',
    },
    {
      id: 'nested-quantifier',
      group: '反面教材',
      name: '灾难性回溯（先别急着点计算）',
      note:
        '这条是刻意放的例子：嵌套量词遇上长文本会指数级变慢。先开着超时试着算一次，' +
        '你会看到它被中断 —— 这正是本插件把正则放进 Worker 的原因。',
      pattern: '(a+)+$',
      flags: '',
      sample: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!',
    },
  ];

  // ============================================================
  // 纯函数工具
  // ============================================================

  /** 特性的可用性探测。缓存起来：它不会在运行期变化，而这里每次都要构造正则 */
  var flagSupport = {};
  function supportsFlag(flag) {
    if (Object.prototype.hasOwnProperty.call(flagSupport, flag)) return flagSupport[flag];
    var ok = true;
    try {
      // eslint-disable-next-line no-new
      new RegExp('', flag);
    } catch (err) {
      ok = false;
    }
    flagSupport[flag] = ok;
    return ok;
  }

  /**
   * 界面上给用户的开关 → 真正传给正则的开关。
   *
   * 这里额外附上 d（记录组位置）。d 不改变匹配结果，只是让每个捕获组带上起止位置，
   * 于是「第 2 组在第 14–18 个字符」始终可见，而界面上的开关保持不变。
   */
  function toExecFlags(flags) {
    var out = typeof flags === 'string' ? flags : '';
    if (out.indexOf('d') < 0 && supportsFlag('d')) out += 'd';
    return out;
  }

  /** `/pattern/flags` 形式，用于展示与复制 */
  function toSourceLiteral(pattern, flags) {
    return '/' + (pattern || '') + '/' + (flags || '');
  }

  /**
   * 把正则引擎给的英文报错翻译成「哪里写错了、下一步怎么办」。
   *
   * 直接抛英文原文对使用者没有帮助 —— 他要的是「第几个字符附近的括号没配对」。
   */
  function explainRegExpError(message) {
    var text = String(message || '');
    var lower = text.toLowerCase();

    if (lower.indexOf('unterminated group') >= 0) {
      return { reason: '有一个左括号 ( 没有配上右括号 )', hint: '检查分组括号是否成对；只想分组而不捕获时用 (?: ... )。' };
    }
    if (lower.indexOf('unmatched') >= 0 && lower.indexOf(')') >= 0) {
      return { reason: '多了一个没有对应左括号的右括号 )', hint: '删掉多余的右括号，或为它补上对应的左括号。' };
    }
    if (lower.indexOf('unterminated character class') >= 0) {
      return { reason: '字符类 [ 没有用 ] 收尾', hint: '补上右方括号；想在字符类里表示 ] 本身，要写成 \\]。' };
    }
    if (lower.indexOf('nothing to repeat') >= 0) {
      return { reason: '量词前面没有可重复的内容', hint: '量词（* + ? {n}）必须紧跟在一个字符、字符类或分组之后。' };
    }
    if (lower.indexOf('lone quantifier') >= 0) {
      return { reason: '量词的位置不对', hint: '花括号量词要写成 {1,3} 这种形式，不要单独出现 { 或 }。' };
    }
    if (lower.indexOf('invalid group') >= 0) {
      return { reason: '分组写法不合法', hint: '常见写法是普通组 (...) 、不捕获组 (?: ...) 、命名组 (?<名字> ...) 。' };
    }
    if (lower.indexOf('duplicate capture group name') >= 0) {
      return { reason: '有两个同名的捕获组', hint: '同一表达式里每个命名组的名字必须唯一。' };
    }
    if (lower.indexOf('invalid escape') >= 0 || lower.indexOf('invalid unicode escape') >= 0) {
      return { reason: '转义写法不合法', hint: '在开启 u 或 v 开关时，\\ 后面必须是合法的转义；只想匹配反斜杠本身要写 \\\\。' };
    }
    if (lower.indexOf('invalid property name') >= 0) {
      return { reason: 'Unicode 属性名不存在', hint: '\\p{...} 里的属性名要写对，例如 \\p{Script=Han}；并且需要开启 u 或 v。' };
    }
    if (lower.indexOf('invalid flags') >= 0 || lower.indexOf('invalid regular expression flags') >= 0) {
      return { reason: '开关的组合不合法', hint: 'u 与 v 不能同时开启，同一个开关也不能重复。' };
    }
    if (lower.indexOf('too much recursion') >= 0) {
      return { reason: '表达式嵌套太深，引擎处理不了', hint: '把一条复杂表达式拆成几条分别测试。' };
    }
    return { reason: '表达式写法不合法', hint: '把表达式拆短，逐段确认哪一段开始报错。' };
  }

  /**
   * 从引擎原文里取出「出错位置」信息（形如 /ab(/g 里的位置索引并不直接给出，
   * 但 V8 会给出 caret 标记）。这里保守地只取整句，不做额外猜测。
   */
  function shortenEngineMessage(message) {
    var text = String(message || '').replace(/\s+/g, ' ').trim();
    if (text.length > 200) text = text.slice(0, 200) + '…';
    return text;
  }

  /**
   * 扫描表达式，列出每个捕获组的序号与名字。
   *
   * 为什么需要它：正则引擎只告诉你有过 `(?<name>…)` 这个名字，不告诉你它是第几组。
   * 而替换时的 `$2` 与 `$<name>` 必须指向同一个组，用户要能对得上号，才敢写替换。
   *
   * 只做识别、不做解析：跳过转义与字符类，认出「( 后面不是 ?」的捕获组，
   * 以及 `(?<` 后不是 = 或 ! 的命名组（那两个是后行断言，不是捕获组）。
   */
  function scanCaptureGroups(pattern) {
    var source = typeof pattern === 'string' ? pattern : '';
    var groups = [];
    var index = 0;
    var inClass = false;

    for (var i = 0; i < source.length; i += 1) {
      var ch = source.charAt(i);

      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (inClass) {
        if (ch === ']') inClass = false;
        continue;
      }
      if (ch === '[') {
        inClass = true;
        continue;
      }
      if (ch !== '(') continue;

      var second = source.charAt(i + 1);
      if (second !== '?') {
        index += 1;
        groups.push({ index: index, name: null });
        continue;
      }

      var third = source.charAt(i + 2);
      if (third !== '<') continue; // (?: (?= (?! 等都不是捕获组

      var fourth = source.charAt(i + 3);
      if (fourth === '=' || fourth === '!') continue; // (?<= (?<! 是后行断言

      index += 1;
      var close = source.indexOf('>', i + 3);
      groups.push({
        index: index,
        name: close > 0 ? source.slice(i + 3, close) : null,
      });
    }

    return groups;
  }

  // ============================================================
  // 计算核心
  //
  // runJob 与 workerBootstrap **必须自包含** —— 它们会被 toString() 之后拼成
  // Worker 的源码，因此不能引用这个 IIFE 里的任何外部变量（包括上面的常量）。
  // ============================================================

  /**
   * 执行一次匹配与替换，返回可结构化克隆的普通对象。
   *
   * 入参 job：
   *   id           本次任务的序号，用于丢弃过期结果
   *   pattern      表达式
   *   execFlags    实际传给 RegExp 的开关（已含内部的 d）
   *   patternUsed  界面上显示的表达式（原样回传，供结果核对指纹）
   *   flagsUsed    界面上显示的开关
   *   text         测试文本
   *   replacement  替换字符串，null 表示不计算替换
   *   limit        最多收集多少个匹配
   */
  function runJob(job) {
    var now =
      typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
        ? function () { return performance.now(); }
        : function () { return Date.now(); };

    var started = now();
    var out = {
      id: job.id,
      ok: true,
      error: null,
      timeout: false,
      elapsed: 0,
      matches: [],
      truncated: false,
      groupCount: 0,
      replaced: null,
      replacedTruncated: false,
      patternUsed: job.patternUsed,
      flagsUsed: job.flagsUsed,
      textUsed: typeof job.text === 'string' ? job.text : '',
    };

    var text = typeof job.text === 'string' ? job.text : '';
    var limit = typeof job.limit === 'number' && job.limit > 0 ? job.limit : 5000;

    var re;
    try {
      re = new RegExp(job.pattern, job.execFlags);
    } catch (err) {
      out.ok = false;
      out.error = err && err.message ? String(err.message) : String(err);
      out.elapsed = now() - started;
      return out;
    }

    function pack(match) {
      var groups = [];
      var indices = match.indices || null;
      var i;
      for (i = 1; i < match.length; i += 1) {
        var value = match[i];
        if (value === undefined) {
          groups.push(null);
          continue;
        }
        var span = indices && indices[i] ? indices[i] : null;
        groups.push({
          value: String(value),
          start: span ? span[0] : null,
          end: span ? span[1] : null,
        });
      }

      var named = null;
      if (match.groups) {
        named = {};
        var keys = Object.keys(match.groups);
        for (var k = 0; k < keys.length; k += 1) {
          var name = keys[k];
          named[name] = match.groups[name] === undefined ? null : String(match.groups[name]);
        }
      }

      var overall = indices && indices[0] ? indices[0] : [match.index, match.index + match[0].length];
      return {
        start: overall[0],
        stop: overall[1],
        text: match[0],
        groups: groups,
        named: named,
      };
    }

    try {
      if (re.global || re.sticky) {
        re.lastIndex = 0;
        var m;
        while ((m = re.exec(text)) !== null) {
          out.matches.push(pack(m));
          if (m[0] === '') {
            // 空匹配不会自行推进 lastIndex。不手动前进就是死循环 ——
            // JS 是单线程的，一旦死循环，界面会一起卡住，超时也救不回来。
            if (re.lastIndex > text.length) break;
            re.lastIndex += 1;
          }
          if (out.matches.length >= limit) {
            out.truncated = true;
            break;
          }
        }
      } else {
        var single = re.exec(text);
        if (single) out.matches.push(pack(single));
      }
    } catch (err) {
      out.ok = false;
      out.error = err && err.message ? String(err.message) : String(err);
      out.elapsed = now() - started;
      return out;
    }

    // 捕获组数量：取第一个匹配的形状即可（同一条正则的组数是固定的）
    if (out.matches.length > 0) {
      out.groupCount = out.matches[0].groups.length;
    }

    if (typeof job.replacement === 'string') {
      try {
        // 替换与匹配用同一组开关：界面上没开 g 时，替换也只作用在第一处。
        // 这样「看到几处匹配」与「替换了几处」永远一致，不会让人以为全换了。
        var replaced = text.replace(new RegExp(job.pattern, job.execFlags), job.replacement);
        out.replaced = replaced;
        out.replacedTruncated = out.truncated;
      } catch (err) {
        out.ok = false;
        out.error = err && err.message ? String(err.message) : String(err);
      }
    }

    out.elapsed = now() - started;
    return out;
  }

  /**
   * Worker 的入口。同样必须自包含。
   *
   * 它引用 runJob —— 在拼出来的 Worker 源码里，两者位于同一个作用域，因此可见。
   */
  function workerBootstrap(scope) {
    scope.onmessage = function (event) {
      var job = event.data;
      var result;
      try {
        result = runJob(job);
      } catch (err) {
        // runJob 自己已经兜住了绝大部分异常，这里只是最后一道：
        // 宁可回一条错误，也不要让 Worker 静默死掉，那会让界面永远停在「计算中」。
        result = {
          id: job && job.id,
          ok: false,
          error: err && err.message ? String(err.message) : String(err),
          elapsed: 0,
          matches: [],
          truncated: false,
          groupCount: 0,
          namedGroups: [],
          replaced: null,
        };
      }
      scope.postMessage(result);
    };
  }

  /** Worker 源码 = 同一份 runJob + 同样的入口包装 */
  var WORKER_SOURCE =
    'var runJob = ' + runJob.toString() + ';\n' + '(' + workerBootstrap.toString() + ')(self);\n';

  // ============================================================
  // 计算引擎（Worker 优先，失败则降级到主线程）
  // ============================================================

  function createEngine() {
    var engine = {
      worker: null,
      workerUrl: null,
      workerTried: false,
      workerBroken: false,
      jobId: 0,
      timer: null,
      pending: null,
      disposed: false,
    };

    /**
     * 确保有一个可用的 Worker。返回 'worker' 或 'main'。
     *
     * 失败只提示一次，之后不再重试 —— 该环境不支持就是一直不支持，
     * 每次计算都重试只会把控制台刷满，反而掩盖真正的问题。
     */
    engine.ensure = function () {
      if (engine.worker) return 'worker';
      if (engine.workerBroken) return 'main';
      if (engine.workerTried) return engine.worker ? 'worker' : 'main';
      engine.workerTried = true;

      if (
        typeof Worker !== 'function' ||
        typeof Blob !== 'function' ||
        typeof URL === 'undefined' ||
        typeof URL.createObjectURL !== 'function'
      ) {
        engine.workerBroken = true;
        ctx.logger.warn('当前环境不提供后台计算线程，正则改在主线程执行，可处理的文本长度已相应收紧');
        return 'main';
      }

      try {
        var blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
        var url = URL.createObjectURL(blob);
        var worker = new Worker(url);
        engine.worker = worker;
        engine.workerUrl = url;
        return 'worker';
      } catch (err) {
        engine.workerBroken = true;
        ctx.logger.warn('创建后台计算线程失败，正则改在主线程执行', err);
        return 'main';
      }
    };

    engine.terminateWorker = function () {
      if (engine.timer) {
        clearTimeout(engine.timer);
        engine.timer = null;
      }
      if (engine.worker) {
        try {
          engine.worker.terminate();
        } catch (err) {
          /* terminate 失败没有补救手段，也不影响后续流程 */
        }
        engine.worker = null;
      }
      if (engine.workerUrl) {
        try {
          URL.revokeObjectURL(engine.workerUrl);
        } catch (err) {
          /* 同上 */
        }
        engine.workerUrl = null;
      }
      engine.pending = null;
    };

    /**
     * 跑一次计算。
     *
     * `done(result, mode)` 一定会被调用一次 —— 成功、语法错、超时、降级都算。
     * 少调一次会让界面永远停在「计算中」，那是最糟的失败方式。
     */
    engine.run = function (job, done, timeoutMs) {
      if (engine.disposed) return;

      engine.jobId += 1;
      job.id = engine.jobId;
      var jobId = job.id;

      var mode = engine.ensure();
      if (mode === 'main') {
        done(runJob(job), 'main');
        return;
      }

      var worker = engine.worker;
      engine.pending = done;

      worker.onmessage = function (event) {
        var result = event.data;
        if (engine.pending !== done) return; // 已经被更新的任务取代
        if (!result || result.id !== jobId) return; // 过期结果，直接丢弃
        engine.pending = null;
        if (engine.timer) {
          clearTimeout(engine.timer);
          engine.timer = null;
        }
        done(result, 'worker');
      };

      worker.onerror = function (event) {
        if (engine.pending !== done) return;
        engine.pending = null;
        if (engine.timer) {
          clearTimeout(engine.timer);
          engine.timer = null;
        }
        // Worker 自身出错（例如被环境拦截）时退回主线程，至少让用户拿到结果
        engine.workerBroken = true;
        ctx.logger.warn('后台计算线程出错，本次改为在主线程执行', event && event.message);
        engine.terminateWorker();
        done(runJob(job), 'main');
      };

      engine.timer = setTimeout(function () {
        engine.timer = null;
        var waiting = engine.pending;
        engine.pending = null;
        // 到点只能 terminate：正则本身没有「中断」接口，这是唯一真正能停下来的办法
        engine.terminateWorker();
        if (waiting) {
          waiting(
            {
              id: jobId,
              ok: false,
              timeout: true,
              error: '计算超时',
              elapsed: timeoutMs,
              matches: [],
              truncated: false,
              groupCount: 0,
              replaced: null,
              patternUsed: job.patternUsed,
              flagsUsed: job.flagsUsed,
              textUsed: job.text,
            },
            'worker'
          );
        }
      }, timeoutMs);

      try {
        worker.postMessage(job);
      } catch (err) {
        if (engine.timer) {
          clearTimeout(engine.timer);
          engine.timer = null;
        }
        if (engine.pending === done) engine.pending = null;
        engine.workerBroken = true;
        ctx.logger.warn('向后台计算线程投递任务失败，本次改在主线程执行', err);
        done(runJob(job), 'main');
      }
    };

    /** 只丢弃排队中的结果，不销毁 Worker（可见性变化时用） */
    engine.cancel = function () {
      if (engine.timer) {
        clearTimeout(engine.timer);
        engine.timer = null;
      }
      engine.pending = null;
    };

    engine.dispose = function () {
      engine.disposed = true;
      engine.terminateWorker();
    };

    return engine;
  }

  // ============================================================
  // 高亮区间
  // ============================================================

  /**
   * 把测试文本切成「命中 / 未命中」交替的片段。
   *
   * `groupIndex` 为 -1 时高亮整个匹配，否则高亮该序号的捕获组 ——
   * 这是排查「到底哪一段被那个组吃掉了」最直接的办法。
   */
  function buildSegments(text, matches, groupIndex, hitLimit) {
    var segments = [];
    var hitCount = 0;
    var cursor = 0;

    for (var i = 0; i < matches.length; i += 1) {
      var match = matches[i];
      var start = match.start;
      var stop = match.stop;

      if (groupIndex >= 0) {
        var group = match.groups[groupIndex];
        if (!group || group.start === null || group.start === undefined) continue;
        start = group.start;
        stop = group.end;
      }

      if (start < cursor || stop < start) continue; // 组区间可能与上一个匹配重叠，跳过即可
      if (hitCount >= hitLimit) break;

      if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false, index: -1 });
      segments.push({ text: text.slice(start, stop), hit: true, index: i, empty: stop === start });
      cursor = stop;
      hitCount += 1;
    }

    if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false, index: -1 });
    return { segments: segments, shown: hitCount };
  }

  /** 覆盖率：匹配覆盖了多少个字符（不重复计数） */
  function coveredChars(matches) {
    var covered = 0;
    var cursor = -1;
    for (var i = 0; i < matches.length; i += 1) {
      var start = matches[i].start;
      var stop = matches[i].stop;
      if (start >= cursor) {
        covered += stop - start;
        cursor = stop;
      } else if (stop > cursor) {
        covered += stop - cursor;
        cursor = stop;
      }
    }
    return covered;
  }

  // ============================================================
  // 小的展示工具
  // ============================================================

  function formatElapsed(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    if (ms < 1) return ms.toFixed(2) + ' 毫秒';
    if (ms < 1000) return ms.toFixed(1) + ' 毫秒';
    return (ms / 1000).toFixed(2) + ' 秒';
  }

  function formatCount(n) {
    return typeof n === 'number' ? n.toLocaleString('zh-CN') : '0';
  }

  /** 组的值可能很长，列表里只给一段摘要 */
  function summarize(value, max) {
    if (value === null || value === undefined) return '（未参与匹配）';
    var text = String(value);
    if (text.length <= max) return text;
    return text.slice(0, max) + '…';
  }

  function normalizeSettings(raw) {
    var out = { highlightGroup: DEFAULT_SETTINGS.highlightGroup };
    if (raw && typeof raw === 'object' && typeof raw.highlightGroup === 'number') {
      out.highlightGroup = raw.highlightGroup;
    }
    return out;
  }

  function normalizeSaved(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.pattern !== 'string') return null;
    return {
      name: typeof raw.name === 'string' && raw.name ? raw.name : '未命名表达式',
      pattern: raw.pattern,
      flags: typeof raw.flags === 'string' ? raw.flags : '',
      replacement: typeof raw.replacement === 'string' ? raw.replacement : '',
      at: typeof raw.at === 'string' ? raw.at : '',
    };
  }

  function makeSavedKey() {
    return SAVED_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ============================================================
  // 样式助手
  // ============================================================

  function classNames() {
    var out = [];
    for (var i = 0; i < arguments.length; i += 1) {
      if (arguments[i]) out.push(arguments[i]);
    }
    return out.join(' ');
  }

  // ============================================================
  // 主组件
  // ============================================================

  function RegexLab() {
    var active = Modulith.useModuleActive();

    var loadedState = useState(false);
    var loaded = loadedState[0];
    var setLoaded = loadedState[1];

    var patternState = useState('');
    var pattern = patternState[0];
    var setPattern = patternState[1];

    var flagsState = useState('g');
    var flags = flagsState[0];
    var setFlags = flagsState[1];

    var textState = useState('');
    var text = textState[0];
    var setText = textState[1];

    var replaceState = useState('');
    var replacement = replaceState[0];
    var setReplacement = replaceState[1];

    var settingsState = useState(DEFAULT_SETTINGS);
    var settings = settingsState[0];
    var setSettings = settingsState[1];

    var tabState = useState('match');
    var tab = tabState[0];
    var setTab = tabState[1];

    var resultState = useState({ status: 'idle' });
    var result = resultState[0];
    var setResult = resultState[1];

    var savedState = useState([]);
    var saved = savedState[0];
    var setSaved = savedState[1];

    var savedNameState = useState('');
    var savedName = savedNameState[0];
    var setSavedName = savedNameState[1];

    var libraryQueryState = useState('');
    var libraryQuery = libraryQueryState[0];
    var setLibraryQuery = libraryQueryState[1];

    var noticeState = useState(null);
    var notice = noticeState[0];
    var setNotice = noticeState[1];

    var saveErrorState = useState(null);
    var saveError = saveErrorState[0];
    var setSaveError = saveErrorState[1];

    /** 手动触发计算的计数器：改变它就绕过「文本过长不自动算」的限制 */
    var nonceState = useState(0);
    var nonce = nonceState[0];
    var setNonce = nonceState[1];
    var lastNonceRef = useRef(0);

    var engineRef = useRef(null);
    if (!engineRef.current) engineRef.current = createEngine();

    var detailRef = useRef(null);

    // ----------------------------------------------------------
    // 存储：读取
    // ----------------------------------------------------------

    useEffect(function () {
      var alive = true;

      function readSaved() {
        return ctx.storage
          .keys()
          .catch(function (err) {
            ctx.logger.warn('读取已保存的表达式清单失败', err);
            return [];
          })
          .then(function (keys) {
            var savedKeys = (keys || [])
              .filter(function (key) {
                return key.indexOf(SAVED_PREFIX) === 0;
              })
              .slice(0, SAVED_MAX);
            if (savedKeys.length === 0) return [];
            return Promise.all(
              savedKeys.map(function (key) {
                return ctx.storage
                  .get(key, null)
                  .then(function (value) {
                    var item = normalizeSaved(value);
                    return item ? { key: key, item: item } : null;
                  })
                  .catch(function (err) {
                    ctx.logger.warn('读取一条已保存的表达式失败', key, err);
                    return null;
                  });
              })
            ).then(function (rows) {
              return rows.filter(Boolean);
            });
          });
      }

      // 每一项都自带 catch：单个键读失败不该让整个插件停在「正在读取」
      Promise.all([
        ctx.storage.get(KEY_SETTINGS, null).catch(function (err) {
          ctx.logger.warn('读取设置失败', err);
          return null;
        }),
        ctx.storage.get(KEY_DRAFT_PATTERN, '').catch(function (err) {
          ctx.logger.warn('读取表达式草稿失败', err);
          return '';
        }),
        ctx.storage.get(KEY_DRAFT_FLAGS, 'g').catch(function (err) {
          ctx.logger.warn('读取开关草稿失败', err);
          return 'g';
        }),
        ctx.storage.get(KEY_DRAFT_TEXT, '').catch(function (err) {
          ctx.logger.warn('读取文本草稿失败', err);
          return '';
        }),
        ctx.storage.get(KEY_DRAFT_REPLACE, '').catch(function (err) {
          ctx.logger.warn('读取替换草稿失败', err);
          return '';
        }),
        readSaved(),
      ])
        .then(function (values) {
          if (!alive) return;
          setSettings(normalizeSettings(values[0]));
          setPattern(typeof values[1] === 'string' ? values[1] : '');
          setFlags(typeof values[2] === 'string' ? values[2] : 'g');
          setText(typeof values[3] === 'string' ? values[3] : '');
          setReplacement(typeof values[4] === 'string' ? values[4] : '');
          setSaved(values[5] || []);
          setLoaded(true);
        })
        .catch(function (err) {
          // 兜底。上面的每一项都各自兜过一次，这里防的是「整理数据时出错」。
          // 少了这一步，界面会永远停在「正在读取」—— 那是最糟的失败方式：
          // 用户看不出是坏了还是在读，也没有任何可操作的下一步。
          ctx.logger.error('读取插件数据时出错，已按空数据继续', err);
          if (alive) setLoaded(true);
        });

      return function () {
        alive = false;
      };
    }, []);

    // ----------------------------------------------------------
    // 存储：草稿写盘（延迟合并，避免每敲一个键写一次盘）
    // ----------------------------------------------------------

    useEffect(function () {
      if (!loaded) return undefined;
      var timer = setTimeout(function () {
        ctx.storage.set(KEY_DRAFT_PATTERN, pattern).catch(function (err) {
          ctx.logger.warn('保存表达式草稿失败', err);
        });
        ctx.storage.set(KEY_DRAFT_FLAGS, flags).catch(function (err) {
          ctx.logger.warn('保存开关草稿失败', err);
        });
        ctx.storage.set(KEY_DRAFT_TEXT, text).catch(function (err) {
          ctx.logger.warn('保存文本草稿失败', err);
        });
        ctx.storage.set(KEY_DRAFT_REPLACE, replacement).catch(function (err) {
          ctx.logger.warn('保存替换草稿失败', err);
        });
      }, DRAFT_SAVE_MS);
      return function () {
        clearTimeout(timer);
      };
    }, [loaded, pattern, flags, text, replacement]);

    useEffect(function () {
      if (!loaded) return undefined;
      var timer = setTimeout(function () {
        ctx.storage.set(KEY_SETTINGS, settings).catch(function (err) {
          ctx.logger.warn('保存设置失败', err);
        });
      }, DRAFT_SAVE_MS);
      return function () {
        clearTimeout(timer);
      };
    }, [loaded, settings]);

    // ----------------------------------------------------------
    // 计算调度
    //
    // 用 ref 持有「当前渲染的闭包」，effect 里只调用它。这样不必把每次渲染都会变化的
    // 函数放进依赖数组，也就不会出现「依赖对了但闭包是旧的」这类问题。
    // ----------------------------------------------------------

    var runRef = useRef(null);
    runRef.current = function () {
      var engine = engineRef.current;
      var mode = engine.ensure();
      var limit = mode === 'main' ? TEXT_MAIN_MAX : TEXT_WORKER_MAX;

      if (text.length > limit) {
        setResult({
          status: 'error',
          reason: mode === 'main' ? 'main-too-long' : 'too-long',
          text: text,
          pattern: pattern,
          flags: flags,
          error:
            mode === 'main'
              ? '当前环境无法在后台执行正则，为避免界面卡住，超过 ' +
                formatCount(TEXT_MAIN_MAX) +
                ' 个字符的文本不执行计算。可以先把文本裁短，或换一台支持后台执行的机器。'
              : '文本超过 ' + formatCount(TEXT_WORKER_MAX) + ' 个字符，超出本插件一次能处理的范围。建议先截取一段再试。',
        });
        return;
      }

      engine.run(
        {
          pattern: pattern,
          execFlags: toExecFlags(flags),
          patternUsed: pattern,
          flagsUsed: flags,
          text: text,
          replacement: replacement,
          limit: LIMIT_MATCHES,
        },
        function (out, usedMode) {
          if (engine.disposed) return;
          setResult({
            status: out.ok ? 'done' : 'error',
            text: text,
            pattern: pattern,
            flags: flags,
            matches: out.matches || [],
            truncated: !!out.truncated,
            groupCount: out.groupCount || 0,
            elapsed: out.elapsed,
            engine: usedMode,
            replaced: out.replaced,
            replacedTruncated: !!out.replacedTruncated,
            timeout: !!out.timeout,
            error: out.error || null,
          });
        },
        JOB_TIMEOUT_MS
      );
    };

    useEffect(function () {
      if (!loaded) return undefined;
      if (!active) {
        // 切走的标签页不做事：停掉排队中的计算，并销毁后台线程。
        // 宿主提供的是感知能力而不是强制暂停，定时器与 Worker 都得自己收。
        engineRef.current.cancel();
        engineRef.current.terminateWorker();
        return undefined;
      }
      if (!pattern) {
        setResult({ status: 'idle' });
        return undefined;
      }

      var isManual = nonce !== lastNonceRef.current;
      lastNonceRef.current = nonce;

      if (!isManual && text.length > TEXT_AUTO_MAX) {
        setResult({
          status: 'idle',
          reason: 'too-long',
          text: text,
          pattern: pattern,
          flags: flags,
        });
        return undefined;
      }

      setResult(function (prev) {
        if (prev.status === 'running') return prev;
        return {
          status: 'running',
          text: text,
          pattern: pattern,
          flags: flags,
        };
      });

      var timer = setTimeout(function () {
        runRef.current();
      }, isManual ? 0 : DEBOUNCE_MS);

      return function () {
        clearTimeout(timer);
      };
    }, [loaded, active, pattern, flags, text, replacement, nonce]);

    useEffect(function () {
      var engine = engineRef.current;
      return function () {
        engine.dispose();
      };
    }, []);

    // ----------------------------------------------------------
    // 操作
    // ----------------------------------------------------------

    function toggleFlag(flag) {
      var has = flags.indexOf(flag) >= 0;
      var next = has
        ? flags
            .split('')
            .filter(function (item) {
              return item !== flag;
            })
            .join('')
        : flags + flag;

      // u 与 v 互斥：同时开启一定报错，与其让用户撞一次错误，不如当场换掉
      if (!has && flag === 'u') next = next.split('').filter(function (item) { return item !== 'v'; }).join('');
      if (!has && flag === 'v') next = next.split('').filter(function (item) { return item !== 'u'; }).join('');

      setFlags(next);
    }

    function useBuiltIn(item) {
      setPattern(item.pattern);
      setFlags(typeof item.flags === 'string' ? item.flags : '');
      setReplacement(typeof item.replacement === 'string' ? item.replacement : '');
      if (item.sample) setText(item.sample);
      setNotice({ kind: 'info', text: '已载入「' + item.name + '」' + (item.sample ? '，并填入了一段示例文本' : '') });
      setTab(item.replacement === undefined ? 'match' : 'replace');
    }

    function clearPattern() {
      setPattern('');
      setResult({ status: 'idle' });
    }

    function saveCurrent() {
      var name = savedName.trim() || pattern.slice(0, NAME_MAX) || '未命名表达式';
      if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX);
      if (!pattern) {
        setSaveError('表达式还是空的，先写一条再保存。');
        return;
      }
      if (saved.length >= SAVED_MAX) {
        setSaveError('最多保存 ' + SAVED_MAX + ' 条。请先删掉一条不再需要的。');
        return;
      }

      var record = {
        name: name,
        pattern: pattern,
        flags: flags,
        replacement: replacement,
        at: new Date().toISOString(),
      };
      var key = makeSavedKey();

      setSaveError(null);
      ctx.storage
        .set(key, record)
        .then(function () {
          setSaved(function (prev) {
            return prev.concat([{ key: key, item: record }]);
          });
          setSavedName('');
          setNotice({ kind: 'success', text: '已保存「' + name + '」' });
        })
        .catch(function (err) {
          ctx.logger.error('保存表达式失败', err);
          setSaveError('保存没有成功，可能是磁盘空间或权限问题。可以再试一次，或先复制表达式留底。');
        });
    }

    function removeSaved(key, name) {
      ctx.storage
        .delete(key)
        .then(function () {
          setSaved(function (prev) {
            return prev.filter(function (row) {
              return row.key !== key;
            });
          });
          setNotice({ kind: 'info', text: '已删除「' + name + '」' });
        })
        .catch(function (err) {
          ctx.logger.error('删除已保存的表达式失败', err);
          setSaveError('删除没有成功。可以再试一次。');
        });
    }

    function copySource() {
      var literal = toSourceLiteral(pattern, flags);
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        setNotice({ kind: 'warn', text: '这个环境不允许直接写剪贴板。可以手动选中上面的表达式复制。' });
        return;
      }
      navigator.clipboard.writeText(literal).then(
        function () {
          setNotice({ kind: 'success', text: '已复制 ' + literal });
        },
        function (err) {
          ctx.logger.warn('写剪贴板失败', err);
          setNotice({ kind: 'warn', text: '复制没有成功，可以手动选中表达式复制。' });
        }
      );
    }

    // ----------------------------------------------------------
    // 派生数据
    // ----------------------------------------------------------

    var isFresh =
      result.text === text && result.pattern === pattern && result.flags === flags;

    var segments = useMemo(
      function () {
        if (!isFresh || result.status !== 'done' || !result.matches || result.matches.length === 0) {
          return { segments: null, shown: 0 };
        }
        return buildSegments(text, result.matches, settings.highlightGroup, LIMIT_RENDER_HITS);
      },
      [isFresh, result.status, result.matches, text, settings.highlightGroup]
    );

    var errorInfo = useMemo(
      function () {
        if (result.status !== 'error' || !result.error || result.reason) return null;
        return explainRegExpError(result.error);
      },
      [result.status, result.error, result.reason]
    );

    var lineCount = useMemo(
      function () {
        if (!text) return 0;
        return text.split('\n').length;
      },
      [text]
    );

    var builtInFiltered = useMemo(
      function () {
        var query = libraryQuery.trim().toLowerCase();
        if (!query) return BUILT_INS;
        return BUILT_INS.filter(function (item) {
          return (
            item.name.toLowerCase().indexOf(query) >= 0 ||
            item.group.toLowerCase().indexOf(query) >= 0 ||
            item.pattern.toLowerCase().indexOf(query) >= 0
          );
        });
      },
      [libraryQuery]
    );

    var builtInGroups = useMemo(
      function () {
        var groups = [];
        var seen = {};
        BUILT_INS.forEach(function (item) {
          if (!seen[item.group]) {
            seen[item.group] = true;
            groups.push(item.group);
          }
        });
        return groups;
      },
      []
    );

    /** 表达式里的命名组（含序号），用于把 $<名字> 与 $序号 对上号 */
    var namedGroupsInPattern = useMemo(
      function () {
        return scanCaptureGroups(pattern).filter(function (group) {
          return !!group.name;
        });
      },
      [pattern]
    );

    useEffect(function () {
      if (!notice) return undefined;
      if (notice.kind === 'warn') return undefined;
      if (!active) return undefined;
      var timer = setTimeout(function () {
        setNotice(null);
      }, 5000);
      return function () {
        clearTimeout(timer);
      };
    }, [notice, active]);

    // ----------------------------------------------------------
    // 渲染用的零件
    // ----------------------------------------------------------

    function renderNotice() {
      if (!notice) return null;
      return h(
        'div',
        {
          className: classNames('regexlab__notice', notice.kind === 'warn' && 'regexlab__notice--warn'),
          role: 'status',
        },
        h('span', { className: 'regexlab__notice-text' }, notice.text),
        h(
          'button',
          {
            type: 'button',
            className: 'regexlab__notice-close',
            'aria-label': '关闭这条提示',
            onClick: function () {
              setNotice(null);
            },
          },
          '关闭'
        )
      );
    }

    function renderStatus() {
      var source = toSourceLiteral(pattern, flags);

      return h(
        'div',
        { className: 'regexlab__status' },
        h('code', { className: 'regexlab__status-expr', title: source }, source),
        h(
          'div',
          { className: 'regexlab__status-meta' },
          !pattern
            ? h('span', { className: 'regexlab__muted' }, '还没有表达式')
            : isFresh && result.status === 'done'
              ? h(
                  'span',
                  null,
                  formatCount(result.matches.length) + ' 处匹配',
                  result.truncated ? '（只收集到上限）' : '',
                  ' · ' + formatElapsed(result.elapsed),
                  result.engine === 'main' ? ' · 主线程' : ' · 后台线程'
                )
              : isFresh && result.status === 'error'
                ? h('span', { className: 'regexlab__error-text' }, '表达式有错')
                : isFresh && (result.reason === 'too-long' || result.reason === 'main-too-long')
                  ? h('span', { className: 'regexlab__muted' }, '文本较长，等待手动计算')
                  : h('span', { className: 'regexlab__muted' }, result.status === 'running' || !isFresh ? '正在计算…' : '待计算')
        )
      );
    }

    function renderFlagButtons() {
      return h(
        'div',
        { className: 'regexlab__flags', role: 'group', 'aria-label': '表达式开关' },
        FLAG_LIST.map(function (item) {
          var supported = supportsFlag(item.flag);
          var on = flags.indexOf(item.flag) >= 0;
          return h(
            'button',
            {
              key: item.flag,
              type: 'button',
              className: classNames('regexlab__flag', on && 'regexlab__flag--on'),
              'aria-pressed': on,
              disabled: !supported,
              title: supported ? item.name + '：' + item.hint : '当前环境不支持这个开关',
              onClick: function () {
                toggleFlag(item.flag);
              },
            },
            item.label
          );
        })
      );
    }

    function renderPatternBar() {
      return h(
        'div',
        { className: 'regexlab__controls' },
        h(
          'div',
          { className: 'regexlab__pattern-row' },
          h(
            'div',
            { className: 'regexlab__pattern-field' },
            h('label', { className: 'regexlab__label', htmlFor: 'regexlab-pattern' }, '正则表达式'),
            h('input', {
              id: 'regexlab-pattern',
              className: 'regexlab__input regexlab__input--mono',
              type: 'text',
              spellCheck: false,
              autoComplete: 'off',
              autoCapitalize: 'off',
              value: pattern,
              placeholder: '例如 \\b\\d{4}-\\d{2}-\\d{2}\\b',
              'aria-describedby': 'regexlab-pattern-help',
              onChange: function (event) {
                setPattern(event.target.value);
              },
            })
          ),
          h(
            'div',
            { className: 'regexlab__actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'regexlab__button regexlab__button--primary',
                disabled: !pattern || (isFresh && result.status === 'running'),
                onClick: function () {
                  setNonce(function (value) { return value + 1; });
                },
              },
              isFresh && result.status === 'running' ? '计算中…' : '计算'
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'regexlab__button',
                disabled: !pattern,
                onClick: copySource,
              },
              '复制'
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'regexlab__button',
                disabled: !pattern,
                onClick: clearPattern,
              },
              '清空'
            )
          )
        ),
        h(
          'div',
          { className: 'regexlab__flags-row' },
          renderFlagButtons(),
          h(
            'p',
            { className: 'regexlab__hint', id: 'regexlab-pattern-help' },
            '开关影响匹配方式：g 找全部、i 忽略大小写、m 让 ^ 与 $ 作用于每一行、s 让点号也匹配换行。'
          )
        ),
        renderStatus(),
        renderErrorBlock()
      );
    }

    function renderErrorBlock() {
      if (result.reason === 'too-long' || result.reason === 'main-too-long') {
        return h(
          'div',
          { className: 'regexlab__alert regexlab__alert--warn' },
          h('p', { className: 'regexlab__alert-title' }, '文本比较长，没有自动计算'),
          h('p', { className: 'regexlab__alert-body' }, result.error),
          h(
            'button',
            {
              type: 'button',
              className: 'regexlab__button',
              onClick: function () {
                setNonce(function (value) { return value + 1; });
              },
            },
            '仍然计算一次'
          )
        );
      }

      if (result.status !== 'error' || !isFresh) return null;

      if (result.timeout) {
        return h(
          'div',
          { className: 'regexlab__alert regexlab__alert--error', role: 'alert' },
          h('p', { className: 'regexlab__alert-title' }, '这条表达式算不完，已经替你停下来了'),
          h(
            'p',
            { className: 'regexlab__alert-body' },
            '它在测试文本上超过了 ' +
              formatElapsed(JOB_TIMEOUT_MS) +
              ' 还没有结束，几乎可以肯定是「回溯爆炸」——' +
              '常见写法是量词套量词（例如 (a+)+、(\\w*)*），匹配失败时它会尝试的组合数随文本长度指数增长。'
          ),
          h(
            'p',
            { className: 'regexlab__alert-body' },
            '可以这样改：把嵌套量词摊平（(a+)+ 写成 a+）、用更具体的字符类代替点号、或者在两边加上边界限定，让失败尽早发生。'
          )
        );
      }

      if (!errorInfo) return null;

      return h(
        'div',
        { className: 'regexlab__alert regexlab__alert--error', role: 'alert' },
        h('p', { className: 'regexlab__alert-title' }, errorInfo.reason),
        h('p', { className: 'regexlab__alert-body' }, errorInfo.hint),
        h('p', { className: 'regexlab__alert-raw' }, '来自正则引擎的原文：' + shortenEngineMessage(result.error))
      );
    }

    function renderTextPane() {
      return h(
        'section',
        { className: 'regexlab__pane', 'aria-label': '测试文本' },
        h(
          'div',
          { className: 'regexlab__pane-head' },
          h('h2', { className: 'regexlab__pane-title' }, '测试文本'),
          h(
            'span',
            { className: 'regexlab__pane-meta' },
            formatCount(text.length) + ' 字符 · ' + formatCount(lineCount) + ' 行'
          )
        ),
        h('textarea', {
          className: 'regexlab__textarea',
          value: text,
          spellCheck: false,
          placeholder: '把要测试的文本粘贴到这里。也可以从右侧的「表达式库」里挑一条，示例文本会一起填好。',
          'aria-label': '测试文本',
          onChange: function (event) {
            setText(event.target.value);
          },
        }),
        text.length > TEXT_AUTO_MAX
          ? h(
              'p',
              { className: 'regexlab__hint regexlab__hint--tight' },
              '文本超过 ' + formatCount(TEXT_AUTO_MAX) + ' 个字符，不会再随输入自动计算。改完点上面的「计算」。'
            )
          : null
      );
    }

    function renderTabs() {
      return h(
        'div',
        { className: 'regexlab__tabs', role: 'tablist', 'aria-label': '结果视图' },
        DISPLAY_TABS.map(function (item) {
          var selected = tab === item.id;
          return h(
            'button',
            {
              key: item.id,
              type: 'button',
              role: 'tab',
              id: 'regexlab-tab-' + item.id,
              'aria-selected': selected,
              'aria-controls': 'regexlab-panel-' + item.id,
              tabIndex: selected ? 0 : -1,
              className: classNames('regexlab__tab', selected && 'regexlab__tab--on'),
              onClick: function () {
                setTab(item.id);
              },
              onKeyDown: function (event) {
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                event.preventDefault();
                var current = 0;
                for (var i = 0; i < DISPLAY_TABS.length; i += 1) {
                  if (DISPLAY_TABS[i].id === tab) current = i;
                }
                var delta = event.key === 'ArrowRight' ? 1 : -1;
                var next = (current + delta + DISPLAY_TABS.length) % DISPLAY_TABS.length;
                setTab(DISPLAY_TABS[next].id);
              },
            },
            item.label
          );
        })
      );
    }

    function renderEmpty(message, hint) {
      return h(
        'div',
        { className: 'regexlab__empty' },
        h('p', { className: 'regexlab__empty-title' }, message),
        hint ? h('p', { className: 'regexlab__empty-hint' }, hint) : null
      );
    }

    function renderMatchPane() {
      if (!pattern) {
        return renderEmpty(
          '还没有表达式',
          '在上面写一条正则，或者打开「表达式库」挑一条现成的 —— 会连示例文本一起载入。'
        );
      }
      if (!isFresh) {
        return renderEmpty('正在计算…', '结果只会在与当前输入一致时显示，避免看到过期的匹配。');
      }
      if (result.status === 'running') {
        return renderEmpty('正在计算…', '文本很长时这一步会稍慢，超过 1.2 秒会被自动中断。');
      }
      if (result.status === 'error') {
        return renderEmpty('这条表达式没有跑完', '上面有具体原因和修改方向。');
      }
      if (result.status === 'idle') {
        return renderEmpty('等待计算', '点上面的「计算」按钮，或改动表达式与文本。');
      }
      if (!result.matches || result.matches.length === 0) {
        return renderEmpty(
          '没有匹配到任何内容',
          '可能是表达式太严格，也可能是文本里确实没有。可以先放宽表达式，或换一段文本试试。'
        );
      }

      var covered = coveredChars(result.matches);
      var percent = text.length > 0 ? (covered / text.length) * 100 : 0;
      var hitSegments = segments.segments || [];

      return h(
        'div',
        { className: 'regexlab__matchpane' },
        h(
          'div',
          { className: 'regexlab__stats' },
          renderStat('匹配处数', formatCount(result.matches.length) + (result.truncated ? '+' : '')),
          renderStat('捕获组', result.groupCount > 0 ? formatCount(result.groupCount) : '无'),
          renderStat('覆盖字符', formatCount(covered) + '（' + percent.toFixed(1) + '%）'),
          renderStat('耗时', formatElapsed(result.elapsed))
        ),
        result.groupCount > 0
          ? h(
              'div',
              { className: 'regexlab__highlight-row' },
              h('label', { className: 'regexlab__label', htmlFor: 'regexlab-group' }, '高亮范围'),
              h(
                'select',
                {
                  id: 'regexlab-group',
                  className: 'regexlab__select',
                  value: String(settings.highlightGroup),
                  onChange: function (event) {
                    setSettings({ highlightGroup: Number(event.target.value) });
                  },
                },
                h('option', { value: '-1' }, '整个匹配'),
                (function () {
                  var options = [];
                  for (var i = 0; i < result.groupCount; i += 1) {
                    options.push(h('option', { key: i, value: String(i) }, groupLabel(i)));
                  }
                  return options;
                })()
              ),
              namedGroupsInPattern.length > 0
                ? h(
                    'span',
                    { className: 'regexlab__muted' },
                    '命名组：' +
                      namedGroupsInPattern
                        .map(function (group) {
                          return '$<' + group.name + '>（第 ' + group.index + ' 组）';
                        })
                        .join('、')
                  )
                : null
            )
          : null,
        h(
          'div',
          { className: 'regexlab__highlight' },
          h(
            'pre',
            { className: 'regexlab__highlight-text' },
            hitSegments.map(function (segment, index) {
              if (!segment.hit) return h('span', { key: index }, segment.text);
              return h(
                'mark',
                { key: index, className: 'regexlab__hit' },
                segment.empty ? h('span', { className: 'regexlab__hit-empty' }, '​') : segment.text
              );
            })
          )
        ),
        segments.shown < result.matches.length
          ? h(
              'p',
              { className: 'regexlab__hint' },
              '为保持流畅，高亮只画了前 ' + formatCount(LIMIT_RENDER_HITS) + ' 处。全部 ' + formatCount(result.matches.length) + ' 处可以在「捕获组明细」里逐条查看。'
            )
          : null
      );
    }

    /** 下拉里的组标签：有名字的组把名字一起写出来，替换时 $<名字> 与 $序号 才对得上 */
    function groupLabel(zeroBased) {
      var ordinal = zeroBased + 1;
      var named = null;
      for (var i = 0; i < namedGroupsInPattern.length; i += 1) {
        if (namedGroupsInPattern[i].index === ordinal) named = namedGroupsInPattern[i];
      }
      return named && named.name ? '第 ' + ordinal + ' 组（' + named.name + '）' : '第 ' + ordinal + ' 组';
    }

    function renderStat(label, value) {
      return h(
        'div',
        { className: 'regexlab__stat', key: label },
        h('span', { className: 'regexlab__stat-label' }, label),
        h('span', { className: 'regexlab__stat-value' }, value)
      );
    }

    function renderDetailPane() {
      if (!pattern) return renderEmpty('还没有表达式', '写一条正则，或者从「表达式库」里挑一条。');
      if (!isFresh || result.status === 'running') return renderEmpty('正在计算…', null);
      if (result.status === 'error') return renderEmpty('这条表达式没有跑完', '上面有具体原因。');
      if (!result.matches || result.matches.length === 0) {
        return renderEmpty('没有匹配到任何内容', '换一条表达式，或换一段文本。');
      }
      if (result.groupCount === 0) {
        return renderEmpty(
          '这条表达式里没有捕获组',
          '用圆括号把想单独取出来的部分包起来，例如 (\\d{4})-(\\d{2})-(\\d{2})，这里就会列出每组的内容与位置。'
        );
      }

      var rows = result.matches.slice(0, LIMIT_DETAIL_ROWS);

      return h(
        'div',
        { className: 'regexlab__detailpane' },
        h(
          'table',
          { className: 'regexlab__table' },
          h(
            'caption',
            { className: 'regexlab__table-caption' },
            '共 ' + formatCount(result.matches.length) + ' 处匹配' +
              (result.truncated ? '（达到收集上限）' : '') +
              (result.matches.length > LIMIT_DETAIL_ROWS ? '，下面列出前 ' + formatCount(LIMIT_DETAIL_ROWS) + ' 处' : '')
          ),
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { scope: 'col' }, '#'),
              h('th', { scope: 'col' }, '位置'),
              h('th', { scope: 'col' }, '匹配内容'),
              h('th', { scope: 'col' }, '各组')
            )
          ),
          h(
            'tbody',
            null,
            rows.map(function (match, index) {
              return h(
                'tr',
                { key: index },
                h('td', { className: 'regexlab__cell-num' }, String(index + 1)),
                h('td', { className: 'regexlab__cell-pos' }, match.start + '–' + match.stop),
                h('td', { className: 'regexlab__cell-text' }, summarize(match.text, 120)),
                h(
                  'td',
                  { className: 'regexlab__cell-groups' },
                  match.groups.map(function (group, groupIndex) {
                    return h(
                      'div',
                      { className: 'regexlab__group-row', key: groupIndex },
                      h('span', { className: 'regexlab__group-name' }, '第 ' + (groupIndex + 1) + ' 组'),
                      h('code', { className: 'regexlab__group-value' }, summarize(group ? group.value : null, 80)),
                      group && group.start !== null && group.start !== undefined
                        ? h('span', { className: 'regexlab__group-pos' }, group.start + '–' + group.end)
                        : null
                    );
                  })
                )
              );
            })
          )
        )
      );
    }

    function renderReplacePane() {
      return h(
        'div',
        { className: 'regexlab__replacepane' },
        h(
          'div',
          { className: 'regexlab__replace-field' },
          h('label', { className: 'regexlab__label', htmlFor: 'regexlab-replacement' }, '替换为'),
          h('input', {
            id: 'regexlab-replacement',
            className: 'regexlab__input regexlab__input--mono',
            type: 'text',
            spellCheck: false,
            value: replacement,
            placeholder: '可用 $1、$2 引用捕获组，$& 表示整个匹配，$$ 表示一个美元符号',
            onChange: function (event) {
              setReplacement(event.target.value);
            },
          })
        ),
        h(
          'p',
          { className: 'regexlab__hint' },
          flags.indexOf('g') >= 0
            ? '替换与匹配使用同一组开关：当前是全部替换。'
            : '替换与匹配使用同一组开关：当前没有开启 g，只会替换第一处。想看全部替换结果，请打开 g。'
        ),
        !pattern
          ? renderEmpty('还没有表达式', '先写一条正则或从「表达式库」载入。')
          : !isFresh || result.status === 'running'
            ? renderEmpty('正在计算…', null)
            : result.status === 'error'
              ? renderEmpty('这条表达式没有跑完', '上面有具体原因。')
              : !result.matches || result.matches.length === 0
                ? renderEmpty('没有可替换的内容', '这条表达式在当前文本上没有匹配。')
                : h(
                    'div',
                    { className: 'regexlab__replace-result' },
                    h(
                      'div',
                      { className: 'regexlab__replace-head' },
                      h(
                        'span',
                        { className: 'regexlab__muted' },
                        '替换了 ' + formatCount(result.matches.length) + ' 处' + (result.truncated ? '（达到收集上限，实际可能更多）' : '')
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'regexlab__button regexlab__button--small',
                          onClick: function () {
                            var value = result.replaced === null || result.replaced === undefined ? '' : result.replaced;
                            if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
                              setNotice({ kind: 'warn', text: '这个环境不允许直接写剪贴板，可以手动选中结果复制。' });
                              return;
                            }
                            navigator.clipboard.writeText(value).then(
                              function () {
                                setNotice({ kind: 'success', text: '已复制替换结果' });
                              },
                              function (err) {
                                ctx.logger.warn('写剪贴板失败', err);
                                setNotice({ kind: 'warn', text: '复制没有成功，可以手动选中结果复制。' });
                              }
                            );
                          },
                        },
                        '复制结果'
                      )
                    ),
                    h('pre', { className: 'regexlab__replace-text' }, result.replaced === null || result.replaced === undefined ? '' : result.replaced)
                  )
      );
    }

    function renderLibraryPane() {
      return h(
        'div',
        { className: 'regexlab__librarypane' },
        h(
          'div',
          { className: 'regexlab__save-box' },
          h('h3', { className: 'regexlab__subtitle' }, '保存当前表达式'),
          h(
            'div',
            { className: 'regexlab__save-row' },
            h('input', {
              className: 'regexlab__input',
              type: 'text',
              value: savedName,
              maxLength: NAME_MAX,
              placeholder: '给它起个名字，例如「日志时间戳」',
              'aria-label': '表达式名称',
              onChange: function (event) {
                setSavedName(event.target.value);
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'regexlab__button regexlab__button--primary',
                onClick: saveCurrent,
              },
              '保存'
            )
          ),
          saveError ? h('p', { className: 'regexlab__alert-body regexlab__error-text', role: 'alert' }, saveError) : null
        ),
        h('h3', { className: 'regexlab__subtitle' }, '我保存的（' + saved.length + ' / ' + SAVED_MAX + '）'),
        saved.length === 0
          ? h(
              'p',
              { className: 'regexlab__empty-hint' },
              '还没有保存过表达式。把当前这条起个名字存下来，下次可以直接取用。'
            )
          : h(
              'ul',
              { className: 'regexlab__saved-list' },
              saved.map(function (row) {
                return h(
                  'li',
                  { className: 'regexlab__saved-item', key: row.key },
                  h(
                    'div',
                    { className: 'regexlab__saved-main' },
                    h('span', { className: 'regexlab__saved-name' }, row.item.name),
                    h('code', { className: 'regexlab__saved-expr' }, toSourceLiteral(row.item.pattern, row.item.flags))
                  ),
                  h(
                    'div',
                    { className: 'regexlab__saved-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'regexlab__button regexlab__button--small',
                        onClick: function () {
                          setPattern(row.item.pattern);
                          setFlags(row.item.flags);
                          setReplacement(row.item.replacement);
                          setNotice({ kind: 'info', text: '已载入「' + row.item.name + '」' });
                        },
                      },
                      '载入'
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'regexlab__button regexlab__button--small regexlab__button--danger',
                        'aria-label': '删除 ' + row.item.name,
                        onClick: function () {
                          removeSaved(row.key, row.item.name);
                        },
                      },
                      '删除'
                    )
                  )
                );
              })
            ),
        h(
          'div',
          { className: 'regexlab__builtin-head' },
          h('h3', { className: 'regexlab__subtitle' }, '内置表达式'),
          h('input', {
            className: 'regexlab__input regexlab__input--search',
            type: 'search',
            value: libraryQuery,
            placeholder: '搜索名称、分组或表达式',
            'aria-label': '搜索内置表达式',
            onChange: function (event) {
              setLibraryQuery(event.target.value);
            },
          })
        ),
        builtInFiltered.length === 0
          ? h('p', { className: 'regexlab__empty-hint' }, '没有找到匹配「' + libraryQuery + '」的内置表达式。')
          : builtInGroups.map(function (group) {
              var items = builtInFiltered.filter(function (item) {
                return item.group === group;
              });
              if (items.length === 0) return null;
              return h(
                'section',
                { className: 'regexlab__builtin-group', key: group },
                h('h4', { className: 'regexlab__builtin-group-title' }, group),
                h(
                  'ul',
                  { className: 'regexlab__builtin-list' },
                  items.map(function (item) {
                    return h(
                      'li',
                      { className: 'regexlab__builtin-item', key: item.id },
                      h(
                        'div',
                        { className: 'regexlab__builtin-main' },
                        h('span', { className: 'regexlab__builtin-name' }, item.name),
                        h('code', { className: 'regexlab__builtin-expr' }, toSourceLiteral(item.pattern, item.flags)),
                        h('p', { className: 'regexlab__builtin-note' }, item.note)
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'regexlab__button regexlab__button--small',
                          onClick: function () {
                            useBuiltIn(item);
                          },
                        },
                        '载入'
                      )
                    );
                  })
                )
              );
            })
      );
    }

    function renderResultPane() {
      var panelId = 'regexlab-panel-' + tab;
      var content =
        tab === 'match'
          ? renderMatchPane()
          : tab === 'detail'
            ? renderDetailPane()
            : tab === 'replace'
              ? renderReplacePane()
              : renderLibraryPane();

      return h(
        'section',
        { className: 'regexlab__pane', 'aria-label': '结果' },
        h(
          'div',
          { className: 'regexlab__pane-head regexlab__pane-head--tabs' },
          h('h2', { className: 'regexlab__pane-title' }, '结果'),
          renderTabs()
        ),
        h(
          'div',
          {
            className: 'regexlab__panel',
            id: panelId,
            role: 'tabpanel',
            'aria-labelledby': 'regexlab-tab-' + tab,
            tabIndex: -1,
          },
          content
        )
      );
    }

    // ----------------------------------------------------------
    // 首帧：数据是从存储异步读出来的，这里明确显示读取中
    // ----------------------------------------------------------

    if (!loaded) {
      return h(
        'div',
        { className: 'regexlab' },
        h('p', { className: 'regexlab__muted' }, '正在读取上次的表达式与文本…')
      );
    }

    return h(
      'div',
      { className: 'regexlab' },
      h(
        'header',
        { className: 'regexlab__header' },
        h(
          'div',
          { className: 'regexlab__title-block' },
          h('h1', { className: 'regexlab__title' }, '正则实验场'),
          h(
            'p',
            { className: 'regexlab__subtitle' },
            '边写边看：匹配高亮、每个捕获组的内容与位置、替换后的结果。计算在后台线程里进行，遇到算不完的表达式会被自动中断，不会把界面拖死。'
          )
        )
      ),
      renderNotice(),
      renderPatternBar(),
      h('div', { className: 'regexlab__body' }, renderTextPane(), renderResultPane()),
      h(
        'footer',
        { className: 'regexlab__footer' },
        h(
          'span',
          { className: 'regexlab__muted' },
          '表达式只在你的电脑上计算，不会发送到任何地方。'
        ),
        h('span', { className: 'regexlab__muted' }, '内存中的文本不会写入日志。')
      )
    );
  }

  // ============================================================
  // 注册模块
  //
  // 必须在加载期**同步**调用：宿主在一次加载结束后立即检查注册结果，
  // 放进 Promise 或 setTimeout 里会被判定为「没有注册任何模块」。
  // ============================================================

  Modulith.registerModule({
    id: 'regexLab',
    name: '正则实验场',
    displayName: '正则实验场',
    description: '边写边看匹配、捕获组与替换结果',
    icon: 'icon.svg',
    priority: 86,
    component: RegexLab,
  });

  ctx.logger.info('正则实验场加载完成');
})();
