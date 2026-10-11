// plugins/encode-lab/index.js
//
// 编码与哈希工具箱 —— Base64 / URL / 十六进制 / 数值进制 / HTML 实体 / Unicode 转义的互转，
// SHA 系列与 HMAC 计算，JWT 解码，时间戳互转。
//
// 手写 IIFE，不使用构建工具，因此不能写 JSX，全部用 `React.createElement`（简写为 h）。
//
// 只申请一项权限：
//   storage —— 记住当前工具、输入草稿与界面设置
// 不申请 network（一切在本机算完，一个字节都不出这台机器）、
// 不申请 filesystem-read（没有文件读写）、不申请 clipboard（见下）。
//
// 四个决定写在最前面：
//
// 1. **输入框里的东西原样就是"待处理的内容"，不做自动类型猜测。**
//    除了时间戳与数值进制这两个「输入本身就是数字」的工具，输入永远是纯文本。
//    曾经考虑过「自动识别像 Base64 的输入并直接解码」，放弃了：那会让
//    「我想把一段 Base64 当普通文本再编码一次」这种操作无法完成，而用户看不出为什么。
//    猜测是替用户做决定，这里不做 —— 也正因如此，数值进制是**单独一个工具**，
//    而不是让「十六进制（文本字节）」工具看到纯数字就改按整数解释：那样它的语义
//    会随输入变来变去，而"1 得到 31"恰恰是它那条 blurb 反复要解释清楚的东西。
//    为什么"自动判断"根本做不到，写在 TOOLS 里 hex 那一条的注释中（111111 既是
//    合法的十进制数、也是合法的十六进制字面量；而 abc 没有数值含义却必须能转字节）。
//
// 2. **所有编码都按 UTF-8 处理，base64 走字节而不是字符。**
//    浏览器自带的 btoa/atob 只认 Latin-1，直接把中文丢进去会抛错 ——
//    这是「本地跑得好好的、别人一用就报错」的典型来源。这里一律先转 UTF-8 字节。
//
// 3. **哈希与 HMAC 是异步的，且必须丢弃过期结果。** 它们由 WebCrypto 提供，
//    返回 Promise；输入变化比计算快时，旧结果会晚于新结果返回。因此每次计算带一个序号，
//    只有序号最新的一次才允许写回界面 —— 否则用户会看到「新输入的旧哈希」。
//
// 4. **复制用的是界面自带的剪贴板接口，不走宿主的剪贴板服务。** 因此清单里没有
//    clipboard 权限 —— 权限列表是给用户看风险用的，虚报和漏报同样有害。这一点在
//    README 里也写明了。

(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    console.error('[encode-lab] 未找到 window.Modulith，插件无法加载');
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
  var KEY_DRAFT_INPUT = 'draft.input';
  // 注意这里**没有**密钥的存储键：HMAC 的密钥不落盘，只留在本次使用的内存里。
  // 一个「验证消息来源」用的密钥被写进磁盘，等于把它变成了一份长期凭证。

  /** 输入长度的硬上限。超过之后不再实时计算，必须手动点「计算」 */
  var INPUT_AUTO_MAX = 200000;

  var DRAFT_SAVE_MS = 700;

  // ============================================================
  // 工具定义
  // ============================================================

  var TOOLS = [
    { id: 'base64', name: 'Base64', twoWay: true, blurb: '把文本转成 Base64，或把 Base64 还原成文本。按 UTF-8 字节处理，中文不会出问题。' },
    { id: 'url', name: 'URL 编码', twoWay: true, blurb: '百分号转义。编码方向同时给出「严格」与「保留结构字符」两种结果，解码方向按标准还原。' },
    // 这条 blurb 在 1.0.4 补了一个**具体例子**。
    //
    // 起因是一次真实反馈："我给一个 1 让他编码，它怎么给我一个 31？"
    // `31` 是对的：0x31 是字符 `1` 的 UTF-8 字节，而**同屏的 Base64 完全是同一套
    // 规则**（`1` → `MQ==`，还是那个 0x31）。问题不在算法，而在这条规则没有出现在
    // 用户看得到的地方 —— "1 既是字符、也是数字"，光说"文本与字节互转"很容易读过去，
    // 而读过去之后的第一反应就是"这工具算错了"。
    //
    // **这里没有改成"纯数字就按整数解释"**：本文件第 1 条设计原则写明了
    // "输入永远是纯文本，不做自动类型猜测"，而且"猜测是替用户做决定，这里不做"。
    // 时间戳那一条是显式开的口子。把例子摆出来，比再开一个口子更符合那条原则。
    //
    // 光靠 blurb 举例还不够，名字本身也在误导：1.0.4 之后仍然有人把「十六进制」
    // 当成数值转换来用，输入 111111 看到 313131313131 就认定是 bug。因此名字改成
    // **「十六进制（文本字节）」**，并在 blurb 末尾直接把它与「数值进制」的分工点明。
    //
    // 为什么必须是两个工具，而不是让一个工具看着输入自己判断 —— 两头都堵死：
    //   · `111111` 既是合法的十进制数、**也是合法的十六进制字面量**（= 0x111111）。
    //     同一个输入有两个都成立的解释，工具没有任何依据可以替用户挑一个；
    //     挑错了不会报错，只会安静地给出另一个数，那比报错更糟。
    //   · `abc` 反过来：它没有十进制的数值含义，可它在字节世界里是三个字节，
    //     必须能转。按数值那套规则它会直接被判成非法字符。
    // 两个方向各自都有对方无法表达的输入，就只能分成两个名字明确的工具，
    // 让"我要的是哪一个"由用户自己说，而不是由工具猜。
    { id: 'hex', name: '十六进制（文本字节）', twoWay: true, blurb: '把文本按 UTF-8 逐字节转成十六进制，或把十六进制还原成文本。输入 1 会得到 31（字符 1 的字节是 0x31），与同屏的 Base64 是同一套规则：1 → MQ==。解码时忽略空格、换行与 0x 前缀。这是文本 → 字节，不是数值转换：要把 111111 当成数值换成 1b207，用「数值进制」。' },
    // 数值进制与上面的 hex 只差一个字，但做的事完全不同，所以两边都写清楚了。
    // 这条 blurb 与 hex 那条互相点名，用户从哪一边进来都能看到区别在哪。
    { id: 'number-base', name: '数值进制', twoWay: true, blurb: '把数值本身按进制互转：十进制 111111 就是十六进制 0x1b207、二进制 0b11011001000000111。用任意精度整数计算，超过 2^53 的大数也不会丢位。这是数值换算，不是字节转换：要把文本 111111 转成字节，用「十六进制（文本字节）」。' },
    { id: 'html', name: 'HTML 实体', twoWay: true, blurb: '把 & < > " \' 转成实体，避免插入 HTML 时破坏结构；反方向还原实体。' },
    { id: 'unicode', name: 'Unicode 转义', twoWay: true, blurb: '文本与 \\uXXXX 转义互转。也支持 \\u{XXXXX} 形式的码点写法。' },
    { id: 'hash', name: '哈希', twoWay: false, blurb: 'SHA-1 / SHA-256 / SHA-384 / SHA-512。计算在本机完成，输入不会离开这台机器。' },
    { id: 'hmac', name: 'HMAC', twoWay: false, needsKey: true, blurb: '带密钥的消息认证码，用来验证「这段内容确实来自持有密钥的一方」。' },
    { id: 'jwt', name: 'JWT', twoWay: false, blurb: '拆开一个令牌，看到头部与载荷的原文，以及有效期。这里只解码不验签。' },
    { id: 'timestamp', name: '时间戳', twoWay: false, blurb: '时间戳与日期时间互转。输入纯数字按时间戳解释，否则按日期时间解释。' },
  ];

  var HASH_ALGOS = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];
  var HMAC_ALGOS = ['SHA-256', 'SHA-512'];

  var HMAC_ALGO_NOTES = {
    'SHA-256': '32 字节，最常用',
    'SHA-512': '64 字节，强度更高、略慢',
  };

  var HASH_ALGO_NOTES = {
    'SHA-1': '160 位。已被证明可以人为制造碰撞，只用来校验完整性，不要用于签名',
    'SHA-256': '256 位。当前通用选择',
    'SHA-384': '384 位',
    'SHA-512': '512 位',
  };

  var DEFAULT_SETTINGS = {
    tool: 'base64',
    direction: 'encode',
    hashFormat: 'hex-lower',
    hmacAlgo: 'SHA-256',
  };

  // ============================================================
  // UTF-8 与字节
  // ============================================================

  function utf8Bytes(text) {
    // 少见的运行环境里可能没有这个能力。给一句能读懂的话，
    // 而不是让 ReferenceError 冒到界面上变成一片空白。
    if (typeof TextEncoder !== 'function') {
      throw new Error('当前环境缺少按 UTF-8 处理文本的能力，无法完成这次转换。');
    }
    return new TextEncoder().encode(String(text));
  }

  function textFromBytes(bytes) {
    if (typeof TextDecoder !== 'function') {
      throw new Error('当前环境缺少文本解码能力，无法还原这段内容。');
    }
    // fatal 让「这不是合法的 UTF-8」变成一个能报出来的错误，
    // 而不是悄悄替换成一串 U+FFFD —— 后者看起来像成功了，实际内容已经毁了。
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  function bytesToHex(bytes, upper) {
    var out = [];
    for (var i = 0; i < bytes.length; i += 1) {
      var part = bytes[i].toString(16);
      if (part.length < 2) part = '0' + part;
      out.push(upper ? part.toUpperCase() : part);
    }
    return out.join('');
  }

  function bytesToBase64(bytes) {
    var binary = '';
    var chunk = 0x8000; // 一次 32KB：太大容易撞上参数个数上限
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    var normalized = normalizeBase64(value);
    var binary = atob(normalized);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /** 去掉空白、把 URL 安全的 -_ 换回 +/、补上被省略的等号 */
  function normalizeBase64(value) {
    var text = String(value).replace(/\s+/g, '');
    text = text.replace(/-/g, '+').replace(/_/g, '/');
    var remainder = text.length % 4;
    if (remainder === 1) {
      throw new Error('长度不是 4 的倍数，末尾可能被截断或漏掉了几个字符');
    }
    if (remainder > 0) {
      for (var i = 0; i < 4 - remainder; i += 1) text += '=';
    }
    return text;
  }

  function toBase64Url(base64) {
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ============================================================
  // 各工具的纯计算
  // ============================================================

  function escapeHtml(text) {
    var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(text).replace(/[&<>"']/g, function (ch) {
      return map[ch];
    });
  }

  function unescapeHtml(text) {
    var named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (whole, body) {
      if (body.charAt(0) === '#') {
        var isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
        var code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!isFinite(code) || code < 0 || code > 0x10ffff) return whole;
        try {
          return String.fromCodePoint(code);
        } catch (err) {
          return whole;
        }
      }
      var found = named[body.toLowerCase()];
      return found === undefined ? whole : found;
    });
  }

  function toUnicodeEscapes(text, style) {
    var out = [];
    var chars = Array.from(String(text));
    chars.forEach(function (ch) {
      var code = ch.codePointAt(0);
      if (style === 'brace') {
        out.push('\\u{' + code.toString(16).toUpperCase() + '}');
        return;
      }
      if (code > 0xffff) {
        // 基本平面之外的字符在 \uXXXX 形式下必须写成代理对，否则还原不回来
        var offset = code - 0x10000;
        var high = Math.floor(offset / 0x400) + 0xd800;
        var low = (offset % 0x400) + 0xdc00;
        out.push('\\u' + high.toString(16).padStart(4, '0') + '\\u' + low.toString(16).padStart(4, '0'));
        return;
      }
      out.push('\\u' + code.toString(16).padStart(4, '0'));
    });
    return out.join('');
  }

  function fromUnicodeEscapes(text) {
    return String(text)
      .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, function (whole, hex) {
        var code = parseInt(hex, 16);
        if (!isFinite(code) || code > 0x10ffff) return whole;
        try {
          return String.fromCodePoint(code);
        } catch (err) {
          return whole;
        }
      })
      .replace(/\\u([0-9a-fA-F]{4})/g, function (whole, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      })
      .replace(/\\x([0-9a-fA-F]{2})/g, function (whole, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      });
  }

  function hexToBytes(value) {
    var cleaned = String(value)
      .replace(/0[xX]/g, ' ')
      .replace(/[^0-9a-fA-F]/g, '');
    if (cleaned.length === 0) {
      throw new Error('没有找到任何十六进制字符');
    }
    if (cleaned.length % 2 !== 0) {
      throw new Error('十六进制字符个数是奇数（' + cleaned.length + ' 个），少了半个字节');
    }
    var bytes = new Uint8Array(cleaned.length / 2);
    for (var i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(cleaned.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  // ============================================================
  // 数值进制（number-base）
  //
  // 与上面的「十六进制（文本字节）」**不是一回事**：那个转的是"文本的 UTF-8 字节"，
  // 输入 1 会得到 31；这里转的是"数值本身"，输入 111111 会得到 0x1b207。
  // 两个工具都留在界面上，正是为了让这个区别看得见。
  //
  // 为什么不能合成一个"聪明的"工具（也写在 TOOLS 里 hex 那一条的注释中）：
  // 111111 既可以是十进制数、也可以是十六进制字面量，工具没有依据替用户挑；
  // 而 abc 没有数值含义，却必须能按字节转出来。两边都有对方表达不了的输入。
  //
  // 一律用 BigInt：Number 只能精确表示到 2^53-1，再往上会悄悄进位
  // （9007199254740993 会变成 9007199254740992）。而"我拿到了一个雪花 ID / 一个
  // 链上数值，想知道它的十六进制"恰恰是这类工具最真实的用途。
  // ============================================================

  // ==== 数值进制：纯计算区域开始（离线验证脚本按这一行截取，勿删）====

  /** 每种进制的写法与报错用词，集中一处：解析、格式化、报错三处不必各写一遍 */
  var RADIX_INFO = {
    2: { name: '二进制', prefix: '0b', allowed: '0 与 1' },
    8: { name: '八进制', prefix: '0o', allowed: '0 到 7' },
    10: { name: '十进制', prefix: '', allowed: '0 到 9' },
    16: { name: '十六进制', prefix: '0x', allowed: '0-9 与 a-f（大小写都可以）' },
  };

  var DIGIT_CHARS = '0123456789abcdef';

  /**
   * 把出错的字符写得看得见。
   *
   * 直接用「」括起来的话，输入 1 000 时用户看到的是「」里什么都没有 ——
   * 空格是不可见字符，说"空白"才说得清是哪一个。
   */
  function describeChar(ch) {
    if (/\s/.test(ch)) return '空白字符';
    return '「' + ch + '」';
  }

  /**
   * 读一个数值字面量，返回它到底是多少。
   *
   * 「这是几进制」只在这里判断一次，结果与报错因此永远是同一套规则，
   * 不会出现「按十六进制识别、又按十进制算」这种前后不一致。
   *
   * 认得的写法：111111、1_000_000、0x1b207、0X1B207、#1b207、
   * 0b11011001000000111、0o657007、-0xff。前后空白随意，前缀大小写随意。
   * 读不出来就抛 Error，由上层统一呈现 —— 不猜、也不返回一个错的数。
   */
  function parseNumberLiteral(raw) {
    // 少见的运行环境里可能没有 BigInt。给一句能读懂的话，
    // 而不是让 ReferenceError 冒到界面上变成一片空白（与 utf8Bytes 同一个理由）。
    if (typeof BigInt !== 'function') {
      throw new Error('当前环境不提供任意精度整数（BigInt），这个工具没法在不丢位的前提下换算');
    }

    var text = String(raw == null ? '' : raw).trim();
    if (!text) {
      throw new Error('没有输入任何内容，读不出数值');
    }

    var rest = text;
    var negative = false;
    var sign = rest.charAt(0);
    if (sign === '-' || sign === '+') {
      negative = sign === '-';
      rest = rest.slice(1);
      if (!rest) {
        throw new Error('只有一个符号「' + sign + '」，后面没有数字');
      }
    }

    // 前缀决定进制。这里只看最前面一两个字符，不猜内容的"样子"：
    // 111111 既可以当十进制也可以当十六进制，凭长相挑一个是替用户做决定。
    var radix = 10;
    var prefix = '';
    var body = rest;
    if (rest.charAt(0) === '#') {
      radix = 16;
      prefix = '#';
      body = rest.slice(1);
    } else if (rest.charAt(0) === '0') {
      var marker = rest.charAt(1);
      if (marker === 'x' || marker === 'X') {
        radix = 16;
        prefix = rest.substr(0, 2);
        body = rest.slice(2);
      } else if (marker === 'b' || marker === 'B') {
        radix = 2;
        prefix = rest.substr(0, 2);
        body = rest.slice(2);
      } else if (marker === 'o' || marker === 'O') {
        radix = 8;
        prefix = rest.substr(0, 2);
        body = rest.slice(2);
      }
    }

    var info = RADIX_INFO[radix];

    if (!body) {
      if (prefix) {
        throw new Error('只有前缀「' + prefix + '」（' + info.name + '），后面没有数字');
      }
      throw new Error('没有找到数字：' + info.name + '需要由 ' + info.allowed + ' 组成');
    }

    // 下划线只是给人看的千位分隔，位置单独查：它不能连着写，也不能顶在两头
    if (body.charAt(0) === '_') {
      throw new Error('下划线位置不对：它只能夹在两位数字中间，「' + text + '」却以下划线开头');
    }
    if (body.charAt(body.length - 1) === '_') {
      throw new Error('下划线位置不对：它只能夹在两位数字中间，「' + text + '」却以下划线结尾');
    }
    if (body.indexOf('__') >= 0) {
      throw new Error('下划线位置不对：「' + text + '」里有两个下划线挨在一起，分隔符写一个就够（例如 1_000_000）');
    }

    // offset 是"符号 + 前缀"的长度。报错说的是原输入里的第几个字符，
    // 这样用户拿着自己贴进去的那串就能直接数出来是哪一个。
    var offset = text.length - body.length;
    var digits = '';
    for (var i = 0; i < body.length; i += 1) {
      var ch = body.charAt(i);
      if (ch === '_') continue;
      var digit = DIGIT_CHARS.indexOf(ch.toLowerCase());
      if (digit < 0 || digit >= radix) {
        throw new Error(
          describeChar(ch) + '不是合法的' + info.name + '数字：' + info.name + '只允许 ' + info.allowed +
            '。它在「' + text + '」的第 ' + (offset + i + 1) + ' 个字符处'
        );
      }
      digits += ch.toLowerCase();
    }

    if (!digits) {
      throw new Error('没有找到数字：下划线不能代替数字');
    }

    // 交给 BigInt 从字符串读，而不是自己一位一位乘加：
    // 上万位时逐位乘加是 O(n²)，会把界面卡住；这里的转换是原生实现。
    var value;
    if (radix === 16) value = BigInt('0x' + digits);
    else if (radix === 8) value = BigInt('0o' + digits);
    else if (radix === 2) value = BigInt('0b' + digits);
    else value = BigInt(digits);

    // -0 与 0 是同一个数，别在结果里留下一个负号
    if (value === BigInt(0)) negative = false;

    return { text: text, radix: radix, prefix: prefix, digits: digits, value: value, negative: negative };
  }

  /** 规范写法：负数带 -，非十进制带前缀，十进制不带（可以直接粘走） */
  function formatNumberValue(parsed, radix, upper) {
    var digits = parsed.value.toString(radix);
    if (upper) digits = digits.toUpperCase();
    return (parsed.negative ? '-' : '') + RADIX_INFO[radix].prefix + digits;
  }

  function decimalText(parsed) {
    return (parsed.negative ? '-' : '') + parsed.value.toString(10);
  }

  /** 结果区顶部那一句：说清这一次是按什么读进去的 */
  function describeNumberLiteral(parsed) {
    var info = RADIX_INFO[parsed.radix];
    return (
      '识别为' +
      (parsed.prefix ? '带「' + parsed.prefix + '」前缀的' : '不带前缀的') +
      info.name +
      (parsed.negative ? '（负数）' : '') +
      '，共 ' + parsed.digits.length + ' 位数字'
    );
  }

  /**
   * 数值进制工具。
   *
   * 编码方向：数值 → 二进制 / 八进制 / 十进制 / 十六进制（大、小写）各一条。
   * 解码方向：任意一种写法 → 规范十进制，并在 note 里写清识别到的是几进制。
   */
  function computeNumberBase(input, direction) {
    var parsed = parseNumberLiteral(input);

    if (direction === 'decode') {
      return {
        results: [
          {
            label: '十进制',
            value: decimalText(parsed),
            mono: true,
            note:
              '识别到的是 ' + parsed.radix + ' 进制（' + RADIX_INFO[parsed.radix].name + '）' +
              (parsed.prefix ? '，用了「' + parsed.prefix + '」前缀' : '，没有前缀'),
          },
        ],
        note: describeNumberLiteral(parsed),
      };
    }

    return {
      results: [
        {
          label: '二进制',
          value: formatNumberValue(parsed, 2, false),
          mono: true,
          note: parsed.value.toString(2).length + ' 位',
        },
        {
          label: '八进制',
          value: formatNumberValue(parsed, 8, false),
          mono: true,
          note: parsed.value.toString(8).length + ' 位八进制数字',
        },
        {
          label: '十进制',
          value: decimalText(parsed),
          mono: true,
          note: '不带前缀，可以直接粘进代码或计算器',
        },
        {
          label: '十六进制（小写）',
          value: formatNumberValue(parsed, 16, false),
          mono: true,
          note: parsed.value.toString(16).length + ' 位十六进制数字',
        },
        {
          label: '十六进制（大写）',
          value: formatNumberValue(parsed, 16, true),
          mono: true,
          note: '与上面是同一个值，只是字母大写',
        },
      ],
      note: describeNumberLiteral(parsed),
    };
  }

  // ==== 数值进制：纯计算区域结束 ====

  function shiftTimeText(date) {
    var diff = date.getTime() - Date.now();
    var abs = Math.abs(diff);
    var table = [
      { limit: 60000, unit: 1000, label: '秒' },
      { limit: 3600000, unit: 60000, label: '分钟' },
      { limit: 86400000, unit: 3600000, label: '小时' },
      { limit: 2592000000, unit: 86400000, label: '天' },
      { limit: 31536000000, unit: 2592000000, label: '个月' },
    ];
    for (var i = 0; i < table.length; i += 1) {
      if (abs < table[i].limit) {
        var amount = Math.round(abs / table[i].unit);
        return diff >= 0 ? amount + ' ' + table[i].label + '后' : amount + ' ' + table[i].label + '前';
      }
    }
    var years = Math.round(abs / 31536000000);
    return diff >= 0 ? years + ' 年后' : years + ' 年前';
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatLocal(date) {
    return (
      date.getFullYear() +
      '-' +
      pad2(date.getMonth() + 1) +
      '-' +
      pad2(date.getDate()) +
      ' ' +
      pad2(date.getHours()) +
      ':' +
      pad2(date.getMinutes()) +
      ':' +
      pad2(date.getSeconds())
    );
  }

  var WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  /**
   * 时间戳工具：同一个输入框既接受时间戳也接受日期时间。
   *
   * 判定规则写在这里而不是藏在界面里：纯数字按时间戳解释，其余按日期时间解释。
   * 数字超过 1e11 视为毫秒（1970 年起的毫秒数在 1973 年就超过这个量级），否则视为秒。
   */
  function computeTimestamp(input) {
    var text = String(input).trim();
    if (!text) return { results: [] };

    if (/^-?\d+$/.test(text)) {
      var raw = Number(text);
      if (!isFinite(raw)) {
        return { error: '这个数字太大了，超出了一般时间戳的范围。', hint: '时间戳通常不超过 13 位。' };
      }
      var isMillis = Math.abs(raw) > 1e11;
      var millis = isMillis ? raw : raw * 1000;
      var fromStamp = new Date(millis);
      if (isNaN(fromStamp.getTime())) {
        return { error: '这个数字换算不成有效的日期。', hint: '检查一下位数：10 位是秒，13 位是毫秒。' };
      }
      return {
        results: [
          { label: '本地时间', value: formatLocal(fromStamp) + '（' + WEEKDAYS[fromStamp.getDay()] + '）', mono: true },
          { label: 'UTC 时间', value: fromStamp.toISOString(), mono: true },
          { label: '相对现在', value: shiftTimeText(fromStamp) },
          { label: '按秒', value: String(Math.floor(millis / 1000)), mono: true, note: '这是常见的「Unix 时间戳」' },
          { label: '按毫秒', value: String(Math.floor(millis)), mono: true, note: 'JavaScript 的 Date 用毫秒' },
        ],
        note: isMillis ? '按毫秒解释（数字大于 1e11）' : '按秒解释（数字不大于 1e11）',
      };
    }

    var parsed = Date.parse(text);
    if (isNaN(parsed)) {
      return {
        error: '既不是时间戳，也不是能识别的日期时间。',
        hint: '时间戳可以试试 1790000000 或 1790000000000；日期可以试试 2026-09-19 09:41:05。',
      };
    }
    var date = new Date(parsed);
    return {
      results: [
        { label: '本地时间', value: formatLocal(date) + '（' + WEEKDAYS[date.getDay()] + '）', mono: true },
        { label: 'UTC 时间', value: date.toISOString(), mono: true },
        { label: '相对现在', value: shiftTimeText(date) },
        { label: '按秒', value: String(Math.floor(parsed / 1000)), mono: true },
        { label: '按毫秒', value: String(parsed), mono: true },
      ],
    };
  }

  /** JWT：只解码，不验签。这一点在界面上也要说清楚 */
  function computeJwt(input) {
    var text = String(input).trim();
    if (!text) return { results: [] };

    var parts = text.split('.');
    if (parts.length < 2) {
      return {
        error: '这不像是一个 JWT：它至少要有两段，用点分隔。',
        hint: '完整的令牌形如 xxxxx.yyyyy.zzzzz。只有一段通常说明复制时被截断了。',
      };
    }

    function decodePart(part, label) {
      var bytes = base64ToBytes(part);
      var json = textFromBytes(bytes);
      var value = JSON.parse(json);
      return { raw: json, value: value, label: label };
    }

    var header;
    var payload;
    try {
      header = decodePart(parts[0], '头部');
    } catch (err) {
      return {
        error: '第一段（头部）解不开：' + (err && err.message ? err.message : String(err)),
        hint: '确认复制完整，并且这段是 Base64URL 编码的 JSON。',
      };
    }
    try {
      payload = decodePart(parts[1], '载荷');
    } catch (err) {
      return {
        error: '第二段（载荷）解不开：' + (err && err.message ? err.message : String(err)),
        hint: '确认复制完整，并且这段是 Base64URL 编码的 JSON。',
      };
    }

    var results = [
      { label: '头部（算法与类型）', value: JSON.stringify(header.value, null, 2), mono: true },
      { label: '载荷（内容）', value: JSON.stringify(payload.value, null, 2), mono: true },
    ];

    var timeClaims = [];
    var claimNames = ['iat', 'nbf', 'exp'];
    var claimLabels = { iat: '签发时间', nbf: '生效时间', exp: '过期时间' };
    claimNames.forEach(function (name) {
      var raw = payload.value ? payload.value[name] : undefined;
      if (typeof raw !== 'number') return;
      var when = new Date(raw * 1000);
      if (isNaN(when.getTime())) return;
      var suffix = '';
      if (name === 'exp') suffix = when.getTime() < Date.now() ? ' · 已经过期' : ' · 仍然有效';
      if (name === 'nbf' && when.getTime() > Date.now()) suffix = ' · 还没生效';
      timeClaims.push({ name: name, text: claimLabels[name] + '：' + formatLocal(when) + suffix });
    });

    results.push({
      label: '时间声明',
      value: timeClaims.length ? timeClaims.map(function (row) { return row.text; }).join('\n') : '令牌里没有 iat / nbf / exp 这几项时间声明。',
      mono: false,
    });

    results.push({
      label: '签名段',
      value: parts[2] ? parts[2] + '\n\n（' + Math.floor((parts[2].length * 3) / 4) + ' 字节左右）' : '令牌只有两段，末尾没有签名段。',
      mono: true,
      note: '本工具只解码不验签：它不会、也无法确认这个令牌是不是被篡改过或由谁签发。',
    });

    return { results: results };
  }

  /** 同步工具的统一入口 */
  function computeSync(tool, direction, input, settings) {
    var text = String(input);
    if (!text) return { results: [] };

    if (tool === 'base64') {
      if (direction === 'encode') {
        var base64 = bytesToBase64(utf8Bytes(text));
        return {
          results: [
            { label: 'Base64', value: base64, mono: true, note: base64.length + ' 字符' },
            { label: 'Base64URL', value: toBase64Url(base64), mono: true, note: '把 + / 换成 - _ 并去掉末尾等号，可以放进网址与文件名' },
          ],
        };
      }
      try {
        var decoded = textFromBytes(base64ToBytes(text));
        return { results: [{ label: '解码结果', value: decoded, mono: false }] };
      } catch (err) {
        return {
          error: '解码失败：' + (err && err.message ? err.message : String(err)),
          hint:
            '确认这段内容是完整、没有缺字符的 Base64。另外：如果原文是二进制内容（图片、压缩包、加密数据），' +
            '解出来本来就不是文字，这里会明确报错而不是给你一堆乱码。',
        };
      }
    }

    if (tool === 'url') {
      if (direction === 'encode') {
        return {
          results: [
            { label: '严格编码', value: encodeURIComponent(text), mono: true, note: '除字母数字与 - _ . ! ~ * \' ( ) 之外全部转义，适合放进查询参数的值' },
            { label: '保留结构字符', value: encodeURI(text), mono: true, note: '保留 : / ? # & = 等结构字符，适合整条网址' },
          ],
        };
      }
      try {
        return {
          results: [
            { label: '解码结果', value: decodeURIComponent(text), mono: false },
            { label: '保留结构字符的解码', value: decodeURI(text), mono: false, note: '与上面不同：%3F 这类编码出来的结构字符不会被还原' },
          ],
        };
      } catch (err) {
        return {
          error: '解码失败：遇到了不完整的百分号转义。',
          hint: '每个 % 后面必须紧跟两位十六进制数字，例如 %E4%B8%AD。这通常说明内容被截断了。',
        };
      }
    }

    if (tool === 'hex') {
      if (direction === 'encode') {
        var bytes = utf8Bytes(text);
        return {
          results: [
            { label: '连续写法', value: bytesToHex(bytes, false), mono: true, note: bytes.length + ' 字节' },
            { label: '大写', value: bytesToHex(bytes, true), mono: true },
            { label: '带空格', value: (function () {
                var hex = bytesToHex(bytes, false);
                var out = [];
                for (var i = 0; i < hex.length; i += 2) out.push(hex.substr(i, 2));
                return out.join(' ');
              })(), mono: true, note: '便于人眼核对' },
            { label: '0x 前缀', value: (function () {
                var hex = bytesToHex(bytes, false);
                var out = [];
                for (var i = 0; i < hex.length; i += 2) out.push('0x' + hex.substr(i, 2));
                return out.join(' ');
              })(), mono: true },
          ],
        };
      }
      try {
        return { results: [{ label: '解码结果', value: textFromBytes(hexToBytes(text)), mono: false }] };
      } catch (err) {
        return {
          error: '解码失败：' + (err && err.message ? err.message : String(err)),
          hint: '输入里只允许出现 0-9 a-f，空格与换行会被忽略。',
        };
      }
    }

    if (tool === 'number-base') {
      try {
        return computeNumberBase(text, direction);
      } catch (err) {
        // 与 hex 分支同一套写法：本地接住，换成「说清哪个字符不对」的一句话，
        // 绝不静默返回一个看起来像结果的错值。
        return {
          error:
            (direction === 'decode' ? '解码失败：' : '编码失败：') +
            (err && err.message ? err.message : String(err)),
          hint:
            '认得的写法：十进制 111111、十六进制 0x1b207 或 #1b207、二进制 0b11011001000000111、' +
            '八进制 0o657007；可以带前后空白、下划线（1_000_000）与负号（-0xff）。' +
            '只接受整数，小数与科学计数法（1.5、1e10）不支持。' +
            '另外：这个工具换算的是数值本身 —— 想把文本按字节转成十六进制，请用「十六进制（文本字节）」工具。',
        };
      }
    }

    if (tool === 'html') {
      if (direction === 'encode') {
        var escaped = escapeHtml(text);
        return {
          results: [
            { label: '转义结果', value: escaped, mono: false },
            { label: '变化', value: escaped === text ? '这段文本里没有需要转义的字符。' : '把 & < > " \' 换成了实体写法。' },
          ],
        };
      }
      return { results: [{ label: '还原结果', value: unescapeHtml(text), mono: false }] };
    }

    if (tool === 'unicode') {
      if (direction === 'encode') {
        return {
          results: [
            { label: '\\uXXXX 形式', value: toUnicodeEscapes(text, 'u'), mono: true, note: '基本平面之外的字符会写成代理对（两个 \\uXXXX）' },
            { label: '\\u{XXXXX} 形式', value: toUnicodeEscapes(text, 'brace'), mono: true, note: '按码点写，更短也更直观' },
          ],
        };
      }
      return { results: [{ label: '还原结果', value: fromUnicodeEscapes(text), mono: false }] };
    }

    if (tool === 'jwt') {
      return computeJwt(text);
    }

    if (tool === 'timestamp') {
      return computeTimestamp(text);
    }

    return { results: [] };
  }

  // ============================================================
  // 异步：哈希与 HMAC
  // ============================================================

  function subtleAvailable() {
    return !!(window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function');
  }

  function formatDigest(bytes, format) {
    if (format === 'base64') return bytesToBase64(bytes);
    return bytesToHex(bytes, format === 'hex-upper');
  }

  function computeHashes(text, format) {
    if (!subtleAvailable()) {
      return Promise.reject(
        new Error('当前环境不提供本机的哈希计算能力，无法计算。这通常是因为界面运行在不被浏览器视为安全的环境里。')
      );
    }
    var bytes = utf8Bytes(text);
    return Promise.all(
      HASH_ALGOS.map(function (algo) {
        return window.crypto.subtle.digest(algo, bytes).then(function (buffer) {
          return {
            label: algo,
            value: formatDigest(new Uint8Array(buffer), format),
            mono: true,
            note: HASH_ALGO_NOTES[algo],
          };
        });
      })
    );
  }

  function computeHmac(text, key, algo, format) {
    if (!subtleAvailable()) {
      return Promise.reject(
        new Error('当前环境不提供本机的密钥计算能力，无法计算 HMAC。')
      );
    }
    var encoder = new TextEncoder();
    var keyBytes = encoder.encode(key);
    if (keyBytes.length === 0) {
      return Promise.reject(new Error('密钥是空的。HMAC 需要一段只有你和对方知道的密钥，请先填写。'));
    }
    return window.crypto.subtle
      .importKey('raw', keyBytes, { name: 'HMAC', hash: algo }, false, ['sign'])
      .then(function (cryptoKey) {
        return window.crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(text));
      })
      .then(function (buffer) {
        var bytes = new Uint8Array(buffer);
        return [
          {
            label: 'HMAC-' + algo,
            value: formatDigest(bytes, format),
            mono: true,
            note: HMAC_ALGO_NOTES[algo] + ' · 密钥长度 ' + keyBytes.length + ' 字节',
          },
          {
            label: '同一结果的其他写法',
            value:
              format === 'base64'
                ? bytesToHex(bytes, false)
                : bytesToBase64(bytes),
            mono: true,
            note: format === 'base64' ? '十六进制写法' : 'Base64 写法',
          },
        ];
      });
  }

  // ============================================================
  // 小工具
  // ============================================================

  function normalizeSettings(raw) {
    var out = {
      tool: DEFAULT_SETTINGS.tool,
      direction: DEFAULT_SETTINGS.direction,
      hashFormat: DEFAULT_SETTINGS.hashFormat,
      hmacAlgo: DEFAULT_SETTINGS.hmacAlgo,
    };
    if (raw && typeof raw === 'object') {
      if (TOOLS.some(function (item) { return item.id === raw.tool; })) out.tool = raw.tool;
      if (raw.direction === 'encode' || raw.direction === 'decode') out.direction = raw.direction;
      if (raw.hashFormat === 'hex-lower' || raw.hashFormat === 'hex-upper' || raw.hashFormat === 'base64') {
        out.hashFormat = raw.hashFormat;
      }
      if (HMAC_ALGOS.indexOf(raw.hmacAlgo) >= 0) out.hmacAlgo = raw.hmacAlgo;
    }
    return out;
  }

  function findTool(id) {
    for (var i = 0; i < TOOLS.length; i += 1) {
      if (TOOLS[i].id === id) return TOOLS[i];
    }
    return TOOLS[0];
  }

  function classNames() {
    var out = [];
    for (var i = 0; i < arguments.length; i += 1) {
      if (arguments[i]) out.push(arguments[i]);
    }
    return out.join(' ');
  }

  function formatCount(value) {
    return typeof value === 'number' ? value.toLocaleString('zh-CN') : '0';
  }

  /**
   * 数值进制工具下面那排示例。
   *
   * 摆这些不是装饰：这个工具的输入格式比其他工具宽（前缀、下划线、负号），
   * 光靠 blurb 一句话说不全，而"点一下就能看到结果"比读五行说明快得多。
   * 最后那条 2^53+1 是刻意的 —— 用 Number 算会变成 …992，这里不会。
   */
  var NUMBER_BASE_EXAMPLES = [
    { text: '111111', title: '十进制' },
    { text: '0x1b207', title: '十六进制（0x 前缀）' },
    { text: '#1b207', title: '十六进制（# 前缀，网页与设计稿里常见的写法）' },
    { text: '0b11011001000000111', title: '二进制' },
    { text: '0o657007', title: '八进制' },
    { text: '1_000_000', title: '用下划线分隔的十进制' },
    { text: '-0xff', title: '负数' },
    { text: '9007199254740993', title: '2^53+1：用 Number 会变成 9007199254740992，这里不会' },
  ];

  /** 输入框的提示语。集中一处，省得在渲染里套四层三元表达式 */
  function inputPlaceholder(tool, direction) {
    if (tool.id === 'timestamp') {
      return '输入一个时间戳（1790000000）或一个日期时间（2026-09-19 09:41:05）';
    }
    if (tool.id === 'jwt') {
      return '粘贴一个 JWT，形如 xxxxx.yyyyy.zzzzz';
    }
    if (tool.id === 'number-base') {
      return direction === 'decode'
        ? '输入任意一种写法（0x1b207、0b11011001000000111、0o657007…），这里会还原成十进制'
        : '输入一个整数（111111、1_000_000、-0xff…），这里会给出各进制的写法';
    }
    return '在这里输入或粘贴要处理的内容';
  }

  // ============================================================
  // 主组件
  // ============================================================

  function EncodeLab() {
    var active = Modulith.useModuleActive();

    var loadedState = useState(false);
    var loaded = loadedState[0];
    var setLoaded = loadedState[1];

    var settingsState = useState(DEFAULT_SETTINGS);
    var settings = settingsState[0];
    var setSettings = settingsState[1];

    var inputState = useState('');
    var input = inputState[0];
    var setInput = inputState[1];

    var keyState = useState('');
    var key = keyState[0];
    var setKey = keyState[1];

    var asyncState = useState({ status: 'idle' });
    var asyncResult = asyncState[0];
    var setAsyncResult = asyncState[1];

    var noticeState = useState(null);
    var notice = noticeState[0];
    var setNotice = noticeState[1];

    /**
     * 是否允许对「超长输入」做一次计算。
     *
     * 超长文本不随输入自动计算（那会让每敲一个键都跑一遍全量转换）；
     * 点一次「立即计算」把它打开，输入一变就自动关回去。
     */
    var allowOnceState = useState(false);
    var allowOnce = allowOnceState[0];
    var setAllowOnce = allowOnceState[1];

    var hashSeqRef = useRef(0);

    var tool = findTool(settings.tool);
    var direction = settings.direction;
    var isAsyncTool = tool.id === 'hash' || tool.id === 'hmac';

    // ----------------------------------------------------------
    // 读取存储
    // ----------------------------------------------------------

    useEffect(function () {
      var alive = true;
      Promise.all([
        ctx.storage.get(KEY_SETTINGS, null).catch(function (err) {
          ctx.logger.warn('读取设置失败', err);
          return null;
        }),
        ctx.storage.get(KEY_DRAFT_INPUT, '').catch(function (err) {
          ctx.logger.warn('读取输入草稿失败', err);
          return '';
        }),
      ])
        .then(function (values) {
          if (!alive) return;
          setSettings(normalizeSettings(values[0]));
          setInput(typeof values[1] === 'string' ? values[1] : '');
          setLoaded(true);
        })
        .catch(function (err) {
          // 兜底。上面每一项都各自兜过一次，这里防的是「整理数据时出错」。
          // 少了它，界面会永远停在「正在准备」——用户分不清是坏了还是在读。
          ctx.logger.error('读取工具箱数据时出错，已按空数据继续', err);
          if (alive) setLoaded(true);
        });

      return function () {
        alive = false;
      };
    }, []);

    // ----------------------------------------------------------
    // 写草稿
    // ----------------------------------------------------------

    useEffect(function () {
      if (!loaded) return undefined;
      var timer = setTimeout(function () {
        ctx.storage.set(KEY_DRAFT_INPUT, input).catch(function (err) {
          ctx.logger.warn('保存输入草稿失败', err);
        });
      }, DRAFT_SAVE_MS);
      return function () {
        clearTimeout(timer);
      };
    }, [loaded, input]);

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
    // 哈希 / HMAC
    // ----------------------------------------------------------

    useEffect(function () {
      if (!loaded) return undefined;
      if (!isAsyncTool) {
        setAsyncResult({ status: 'idle' });
        return undefined;
      }
      if (!active) {
        // 切走的标签页不做事。宿主给的是感知能力，不是强制暂停。
        return undefined;
      }
      if (!input) {
        setAsyncResult({ status: 'idle' });
        return undefined;
      }
      if (input.length > INPUT_AUTO_MAX && !allowOnce) {
        setAsyncResult({
          status: 'idle',
          reason: 'too-long',
          forInput: input,
          forTool: tool.id,
        });
        return undefined;
      }

      var seq = hashSeqRef.current + 1;
      hashSeqRef.current = seq;
      setAsyncResult({ status: 'running', forInput: input, forTool: tool.id });

      var work =
        tool.id === 'hash'
          ? computeHashes(input, settings.hashFormat)
          : computeHmac(input, key, settings.hmacAlgo, settings.hashFormat);

      work.then(
        function (results) {
          // 序号对不上说明输入已经变了：这份结果已经过期，直接丢弃。
          // 不丢的话，用户会看到「新输入配旧哈希」—— 看起来像算错了。
          if (hashSeqRef.current !== seq) return;
          setAsyncResult({
            status: 'done',
            results: results,
            forInput: input,
            forTool: tool.id,
            at: Date.now(),
          });
        },
        function (err) {
          if (hashSeqRef.current !== seq) return;
          ctx.logger.warn('计算失败', err);
          setAsyncResult({
            status: 'error',
            error: err && err.message ? err.message : String(err),
            forInput: input,
            forTool: tool.id,
          });
        }
      );

      return undefined;
    }, [loaded, active, isAsyncTool, tool.id, input, key, settings.hashFormat, settings.hmacAlgo, allowOnce]);

    // ----------------------------------------------------------
    // 同步工具的计算结果（不需要异步，直接算）
    // ----------------------------------------------------------

    var syncResult = useMemo(
      function () {
        if (isAsyncTool) return { results: [] };
        if (input.length > INPUT_AUTO_MAX && !allowOnce) {
          return { results: [], deferred: true };
        }
        try {
          return computeSync(tool.id, direction, input, settings);
        } catch (err) {
          return {
            error: err && err.message ? err.message : String(err),
            hint: '换一种输入试试，或切换到另一个工具。',
          };
        }
      },
      [isAsyncTool, tool.id, direction, input, settings, allowOnce]
    );

    // ----------------------------------------------------------
    // 派生数据
    // ----------------------------------------------------------

    var byteCount = useMemo(
      function () {
        try {
          return utf8Bytes(input).length;
        } catch (err) {
          return input.length;
        }
      },
      [input]
    );

    var activeResult = isAsyncTool
      ? {
          status: asyncResult.status,
          results: asyncResult.results || [],
          error: asyncResult.error || null,
          reason: asyncResult.reason || null,
          stale: asyncResult.forInput !== input || asyncResult.forTool !== tool.id,
        }
      : {
          status: syncResult.error ? 'error' : syncResult.deferred ? 'idle' : 'done',
          results: syncResult.results || [],
          error: syncResult.error || null,
          hint: syncResult.hint || null,
          note: syncResult.note || null,
          reason: syncResult.deferred ? 'too-long' : null,
          stale: false,
        };

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
    // 操作
    // ----------------------------------------------------------

    function copy(value, label) {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        setNotice({ kind: 'warn', text: '这个环境不允许直接写剪贴板。可以手动选中内容复制。' });
        return;
      }
      navigator.clipboard.writeText(value).then(
        function () {
          setNotice({ kind: 'success', text: '已复制：' + (label || '结果') });
        },
        function (err) {
          ctx.logger.warn('写剪贴板失败', err);
          setNotice({ kind: 'warn', text: '复制没有成功，可以手动选中内容复制。' });
        }
      );
    }

    function useAsInput(value) {
      setInput(value);
      setAllowOnce(false);
      setNotice({ kind: 'info', text: '已把这个结果填回输入框。' });
    }

    // ----------------------------------------------------------
    // 渲染
    // ----------------------------------------------------------

    function renderNotice() {
      if (!notice) return null;
      return h(
        'div',
        {
          className: classNames('encodelab__notice', notice.kind === 'warn' && 'encodelab__notice--warn'),
          role: 'status',
        },
        h('span', { className: 'encodelab__notice-text' }, notice.text),
        h(
          'button',
          {
            type: 'button',
            className: 'encodelab__notice-close',
            'aria-label': '关闭这条提示',
            onClick: function () {
              setNotice(null);
            },
          },
          '关闭'
        )
      );
    }

    function renderToolTabs() {
      return h(
        'div',
        { className: 'encodelab__tools', role: 'tablist', 'aria-label': '选择工具' },
        TOOLS.map(function (item) {
          var selected = item.id === tool.id;
          return h(
            'button',
            {
              key: item.id,
              type: 'button',
              role: 'tab',
              'aria-selected': selected,
              className: classNames('encodelab__tool', selected && 'encodelab__tool--on'),
              onClick: function () {
                setSettings(function (prev) {
                  var next = Object.assign({}, prev, { tool: item.id });
                  // 单向工具没有方向可言，但保留用户上一次选择，切回来时不用重设
                  return next;
                });
              },
            },
            item.name
          );
        })
      );
    }

    function renderDirectionSwitch() {
      if (!tool.twoWay) return null;
      return h(
        'div',
        { className: 'encodelab__direction', role: 'group', 'aria-label': '转换方向' },
        h(
          'button',
          {
            type: 'button',
            className: classNames('encodelab__direction-button', direction === 'encode' && 'encodelab__direction-button--on'),
            'aria-pressed': direction === 'encode',
            onClick: function () {
              setSettings(function (prev) {
                return Object.assign({}, prev, { direction: 'encode' });
              });
            },
          },
          '编码'
        ),
        h(
          'button',
          {
            type: 'button',
            className: classNames('encodelab__direction-button', direction === 'decode' && 'encodelab__direction-button--on'),
            'aria-pressed': direction === 'decode',
            onClick: function () {
              setSettings(function (prev) {
                return Object.assign({}, prev, { direction: 'decode' });
              });
            },
          },
          '解码'
        )
      );
    }

    function renderOptions() {
      if (tool.id === 'hash') {
        return h(
          'div',
          { className: 'encodelab__options' },
          h('span', { className: 'encodelab__label' }, '结果写法'),
          h(
            'div',
            { className: 'encodelab__option-group', role: 'group', 'aria-label': '哈希结果写法' },
            [
              { id: 'hex-lower', label: '小写十六进制' },
              { id: 'hex-upper', label: '大写十六进制' },
              { id: 'base64', label: 'Base64' },
            ].map(function (option) {
              var on = settings.hashFormat === option.id;
              return h(
                'button',
                {
                  key: option.id,
                  type: 'button',
                  className: classNames('encodelab__option', on && 'encodelab__option--on'),
                  'aria-pressed': on,
                  onClick: function () {
                    setSettings(function (prev) {
                      return Object.assign({}, prev, { hashFormat: option.id });
                    });
                  },
                },
                option.label
              );
            })
          )
        );
      }

      if (tool.id === 'hmac') {
        return h(
          'div',
          { className: 'encodelab__options' },
          h('span', { className: 'encodelab__label' }, '算法'),
          h(
            'div',
            { className: 'encodelab__option-group', role: 'group', 'aria-label': 'HMAC 算法' },
            HMAC_ALGOS.map(function (algo) {
              var on = settings.hmacAlgo === algo;
              return h(
                'button',
                {
                  key: algo,
                  type: 'button',
                  className: classNames('encodelab__option', on && 'encodelab__option--on'),
                  'aria-pressed': on,
                  title: HMAC_ALGO_NOTES[algo],
                  onClick: function () {
                    setSettings(function (prev) {
                      return Object.assign({}, prev, { hmacAlgo: algo });
                    });
                  },
                },
                algo
              );
            })
          ),
          h(
            'div',
            { className: 'encodelab__option-group', role: 'group', 'aria-label': '结果写法' },
            [
              { id: 'hex-lower', label: '小写十六进制' },
              { id: 'hex-upper', label: '大写十六进制' },
              { id: 'base64', label: 'Base64' },
            ].map(function (option) {
              var on = settings.hashFormat === option.id;
              return h(
                'button',
                {
                  key: option.id,
                  type: 'button',
                  className: classNames('encodelab__option', on && 'encodelab__option--on'),
                  'aria-pressed': on,
                  onClick: function () {
                    setSettings(function (prev) {
                      return Object.assign({}, prev, { hashFormat: option.id });
                    });
                  },
                },
                option.label
              );
            })
          )
        );
      }

      return null;
    }

    function renderInputPane() {
      return h(
        'section',
        { className: 'encodelab__pane', 'aria-label': '输入' },
        h(
          'div',
          { className: 'encodelab__pane-head' },
          h('h2', { className: 'encodelab__pane-title' }, '输入'),
          h(
            'span',
            { className: 'encodelab__pane-meta' },
            formatCount(input.length) + ' 字符 · ' + formatCount(byteCount) + ' 字节（UTF-8）'
          )
        ),
        h('textarea', {
          className: 'encodelab__textarea',
          value: input,
          spellCheck: false,
          'aria-label': '输入内容',
          placeholder: inputPlaceholder(tool, direction),
          onChange: function (event) {
            setInput(event.target.value);
            // 输入一变就收回「允许超长计算」的许可，免得每敲一个键都跑一遍全量转换
            setAllowOnce(false);
          },
        }),
        tool.needsKey
          ? h(
              'div',
              { className: 'encodelab__key-field' },
              h('label', { className: 'encodelab__label', htmlFor: 'encodelab-key' }, '密钥'),
              h('input', {
                id: 'encodelab-key',
                className: 'encodelab__input encodelab__input--mono',
                type: 'text',
                spellCheck: false,
                autoComplete: 'off',
                value: key,
                placeholder: '只有你和对方知道的这段文字',
                onChange: function (event) {
                  setKey(event.target.value);
                },
              }),
              h(
                'p',
                { className: 'encodelab__hint' },
                '密钥只在本次使用期间留在内存里：不写磁盘、不进日志。关掉这一页或重启应用后需要重新填写。'
              )
            )
          : null,
        h(
          'div',
          { className: 'encodelab__input-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'encodelab__button',
              disabled: !input,
              onClick: function () {
                setInput('');
              },
            },
            '清空输入'
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'encodelab__button',
              disabled: !input,
              onClick: function () {
                setAllowOnce(true);
              },
            },
            '立即计算'
          ),
          input.length > INPUT_AUTO_MAX
            ? h(
                'span',
                { className: 'encodelab__hint' },
                '文本很长，已停止自动计算：改完点「立即计算」。'
              )
            : null
        ),
        // 只有数值进制需要这排示例：它的输入格式最多（前缀、下划线、负号），
        // 点一下就能看到结果，比读一长串说明快。
        tool.id === 'number-base'
          ? h(
              'div',
              { className: 'encodelab__examples' },
              h('span', { className: 'encodelab__examples-label' }, '试试这些写法'),
              h(
                'div',
                { className: 'encodelab__examples-list' },
                NUMBER_BASE_EXAMPLES.map(function (example) {
                  return h(
                    'button',
                    {
                      key: example.text,
                      type: 'button',
                      className: 'encodelab__example',
                      title: example.title,
                      onClick: function () {
                        setInput(example.text);
                        setAllowOnce(false);
                      },
                    },
                    example.text
                  );
                })
              )
            )
          : null
      );
    }

    function renderResultCard(item, index) {
      return h(
        'article',
        { className: 'encodelab__card', key: item.label + index },
        h(
          'div',
          { className: 'encodelab__card-head' },
          h('h3', { className: 'encodelab__card-title' }, item.label),
          h(
            'div',
            { className: 'encodelab__card-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'encodelab__button encodelab__button--small',
                onClick: function () {
                  useAsInput(item.value);
                },
                title: '把这个结果填回输入框，可以接着做下一步',
              },
              '用作输入'
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'encodelab__button encodelab__button--small',
                'aria-label': '复制' + item.label,
                onClick: function () {
                  copy(item.value, item.label);
                },
              },
              '复制'
            )
          )
        ),
        h(
          'pre',
          { className: classNames('encodelab__card-value', item.mono && 'encodelab__card-value--mono') },
          item.value
        ),
        item.note ? h('p', { className: 'encodelab__card-note' }, item.note) : null
      );
    }

    function renderEmpty(title, hint) {
      return h(
        'div',
        { className: 'encodelab__empty' },
        h('p', { className: 'encodelab__empty-title' }, title),
        hint ? h('p', { className: 'encodelab__empty-hint' }, hint) : null
      );
    }

    function renderResults() {
      if (activeResult.stale) {
        return renderEmpty('正在计算…', null);
      }
      if (activeResult.status === 'running') {
        return renderEmpty('正在计算…', '哈希与密钥计算由系统提供，通常瞬间完成。');
      }
      if (activeResult.status === 'error') {
        return h(
          'div',
          { className: 'encodelab__alert', role: 'alert' },
          h('p', { className: 'encodelab__alert-title' }, activeResult.error),
          activeResult.hint ? h('p', { className: 'encodelab__alert-body' }, activeResult.hint) : null
        );
      }
      if (activeResult.reason === 'too-long') {
        return renderEmpty(
          '文本比较长，没有自动计算',
          '点左侧的「立即计算」，或者把内容截短一些。'
        );
      }
      if (!input) {
        return renderEmpty(
          '还没有输入',
          tool.id === 'timestamp'
            ? '在左边填一个时间戳或日期，这里会立刻给出两种写法。'
            : '在左边输入或粘贴内容，结果会出现在这里。每个结果都能一键复制，或者填回去接着处理。'
        );
      }
      if (!activeResult.results || activeResult.results.length === 0) {
        return renderEmpty('没有可以显示的结果', '换一个工具或换一段输入试试。');
      }

      return h(
        'div',
        { className: 'encodelab__cards' },
        activeResult.note ? h('p', { className: 'encodelab__result-note' }, activeResult.note) : null,
        activeResult.results.map(renderResultCard)
      );
    }

    if (!loaded) {
      return h(
        'div',
        { className: 'encodelab' },
        h('p', { className: 'encodelab__muted' }, '正在准备工具箱…')
      );
    }

    return h(
      'div',
      { className: 'encodelab' },
      h(
        'header',
        { className: 'encodelab__header' },
        h('h1', { className: 'encodelab__title' }, '编码与哈希工具箱'),
        h(
          'p',
          { className: 'encodelab__subtitle' },
          'Base64、URL、十六进制（文本字节）、数值进制、HTML 实体、Unicode 转义的互转，SHA 系列与 HMAC 计算，JWT 解码，时间戳互转。全部在本机完成，内容不会发送到任何地方。'
        )
      ),
      renderNotice(),
      h(
        'div',
        { className: 'encodelab__toolbar' },
        renderToolTabs(),
        h(
          'div',
          { className: 'encodelab__toolbar-row' },
          h('p', { className: 'encodelab__blurb' }, tool.blurb),
          renderDirectionSwitch()
        ),
        renderOptions()
      ),
      h('div', { className: 'encodelab__body' }, renderInputPane(), h(
        'section',
        { className: 'encodelab__pane', 'aria-label': '结果' },
        h(
          'div',
          { className: 'encodelab__pane-head' },
          h('h2', { className: 'encodelab__pane-title' }, '结果'),
          h(
            'span',
            { className: 'encodelab__pane-meta' },
            activeResult.results && activeResult.results.length > 0
              ? activeResult.results.length + ' 项'
              : ''
          )
        ),
        h('div', { className: 'encodelab__panel' }, renderResults())
      )),
      h(
        'footer',
        { className: 'encodelab__footer' },
        h('span', { className: 'encodelab__muted' }, '所有转换与计算都在本机完成，没有网络请求。'),
        h('span', { className: 'encodelab__muted' }, '输入内容不会写入日志。')
      )
    );
  }

  // ============================================================
  // 注册模块
  //
  // 必须在加载期**同步**调用。
  // ============================================================

  Modulith.registerModule({
    id: 'encodeLab',
    name: '编码与哈希工具箱',
    displayName: '编码与哈希工具箱',
    description: 'Base64 / URL / 十六进制（文本字节）/ 数值进制 / 哈希 / JWT / 时间戳，全部在本机完成',
    icon: 'icon.svg',
    priority: 84,
    component: EncodeLab,
  });

  ctx.logger.info('编码与哈希工具箱加载完成');
})();
