// plugins/encode-lab/index.js
//
// 编码与哈希工具箱 —— Base64 / URL / 十六进制 / HTML 实体 / Unicode 转义的互转，
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
//    除时间戳工具外，输入永远是纯文本。曾经考虑过「自动识别像 Base64 的输入并直接解码」，
//    放弃了：那会让「我想把一段 Base64 当普通文本再编码一次」这种操作无法完成，
//    而用户看不出为什么。猜测是替用户做决定，这里不做。
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
    { id: 'hex', name: '十六进制', twoWay: true, blurb: '文本与十六进制字节互转。解码时忽略空格、换行与 0x 前缀。' },
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
          placeholder:
            tool.id === 'timestamp'
              ? '输入一个时间戳（1790000000）或一个日期时间（2026-09-19 09:41:05）'
              : tool.id === 'jwt'
                ? '粘贴一个 JWT，形如 xxxxx.yyyyy.zzzzz'
                : '在这里输入或粘贴要处理的内容',
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
        )
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
          'Base64、URL、十六进制、HTML 实体、Unicode 转义的互转，SHA 系列与 HMAC 计算，JWT 解码，时间戳互转。全部在本机完成，内容不会发送到任何地方。'
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
    description: 'Base64 / URL / 十六进制 / 哈希 / JWT / 时间戳，全部在本机完成',
    icon: 'icon.svg',
    priority: 84,
    component: EncodeLab,
  });

  ctx.logger.info('编码与哈希工具箱加载完成');
})();
