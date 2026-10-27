// plugins/quick-launch/index.js
//
// 快捷启动 —— 把常用程序、网址与文件夹收在一处，一下打开。
//
// ============================================================
// 这个插件的核心是**一条容易写错、而且写错了会有明确症状**的规则
// ============================================================
//
// 「打开」这件事在宿主上有**两条完全不同的路径**，选错的那一条会以
// `os error 193` 的形式报出来（「%1 不是有效的 Win32 应用程序」）：
//
//   * `ctx.launcher.launch(program, args)` —— 走 `CreateProcess`，只认可执行映像。
//     传给它一个 `.lnk`、一个 `.url`、一个目录或一份文档，必然失败。
//   * `ctx.launcher.open(target)` —— 走 shell 的文件关联（`ShellExecuteExW`），
//     也就是资源管理器双击那一条路。快捷方式、网址、目录、文档都靠它。
//
// 因此本插件里**没有任何一处**直接决定调哪一个，全部经过
// `resolveLaunch()` 这一个判据（见那一节的说明与它上面的注释）。把判断收在
// 一处，是这条规则唯一不会随时间被写歪的形态。
//
// 用到的宿主能力（每一项都对应一条清单权限）：
//   * `ctx.storage`   —— 保存条目、分组与偏好          → storage
//   * `ctx.settings`  —— 读本插件在清单里声明的设置项   → storage
//   * `ctx.launcher`  —— 启动程序 / 打开文件与网址      → process-spawn
//   * `ctx.icons`     —— 提取程序图标                   → filesystem-read
//   * `ctx.shell`     —— 在文件管理器中定位             → filesystem-read
//   * `ctx.fileDrop`  —— 接收拖入的文件路径             → filesystem-read
//
// 三条必须遵守的约定（与是否用构建工具无关）：
//   1. **不要自己 import React** —— 用 `Modulith.React`，宿主与插件必须共用
//      同一份实例，否则 hooks 会报错。
//   2. **必须在加载期同步调用 `registerModule()`**（IIFE 顶层，不能放进回调）。
//   3. **不要用 `window.confirm` / `alert` / `prompt`。** 这个宿主里
//      `tauri-plugin-dialog` 注入的脚本把它们换成了走 IPC 的 async 版本，
//      于是 `!window.confirm(...)` 取反的是一个 Promise —— **永远是 false**，
//      「用户点了取消」根本拦不住。本文件里所有确认都是自己渲染的两步确认
//      （见 `ConfirmButton`），输入也都走自己渲染的对话框。
//
// 本插件以 MIT 许可提供。详见
// https://github.com/Rinntheor/modulith-desktop/blob/main/docs/07-法务/版权与授权.md

(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    console.error('[quick-launch] 未找到 window.Modulith，插件无法加载');
    return;
  }

  var React = Modulith.React;
  var h = React.createElement;

  // createContext() 只能在加载期调用，因此在这里取一次并长期持有。
  var ctx = Modulith.createContext();

  /** 条目与分组存在这个键下；图标另存，见 ICON_PREFIX */
  var STATE_KEY = 'shortcuts';
  /**
   * 每个条目的图标单独存一个键。
   *
   * 为什么不塞进 STATE_KEY 里：图标是几十 KB 的 PNG data URL，全部塞进一个
   * 数组会让「改个名字」也重写整份数据。分开存之后主状态始终很小。
   *
   * 注意键名字符集限制：后端只允许字母数字与 `.` `_` `-`（最长 128），
   * 因此这里用 `icon.<id>` 而不是 `icon:<id>` —— 冒号会被拒绝。
   */
  var ICON_PREFIX = 'icon.';

  /** 当前的状态结构版本。读的时候不会因为这个数字拒绝任何东西，它只用于写。 */
  var STATE_VERSION = 2;

  var VIEWS = [
    { id: 'grid', label: '网格' },
    { id: 'list', label: '列表' },
    { id: 'compact', label: '紧凑' },
  ];

  var ICON_SIZES = [
    { id: 'small', label: '小' },
    { id: 'medium', label: '中' },
    { id: 'large', label: '大' },
  ];

  var DENSITIES = [
    { id: 'cozy', label: '宽松' },
    { id: 'tight', label: '紧凑' },
  ];

  var SORTS = [
    { id: 'manual', label: '手动' },
    { id: 'recent', label: '最近使用' },
    { id: 'frequent', label: '最常使用' },
    { id: 'name', label: '按名称' },
  ];

  var LAUNCH_ON = [
    { id: 'double', label: '双击' },
    { id: 'single', label: '单击' },
  ];

  /** 两步确认的回退时间：超过它按钮自己变回「删除」。 */
  var CONFIRM_TIMEOUT_MS = 4000;

  /** 生成了多久的记录算「刚启动过」——用来做一次性的反馈，不参与排序。 */
  var FLASH_TIMEOUT_MS = 2400;

  /** 网址最多允许多长。超过它的输入几乎一定是粘贴错了，而不是真的要存。 */
  var MAX_URL_LENGTH = 2048;

  // ============================================================
  // 设置的缺省值
  // ============================================================
  //
  // 这些值同时写在清单的 `contributes.settings` 里 —— **两处必须一致**。
  // 清单里那份是用户在「设置 → 插件设置」里看到并修改的，这里这份是在读不到
  // 设置时的兜底（极旧的宿主、或没有 storage 权限）。
  //
  // `launchOn` 的缺省**必须是 `double`**：改成单键会让老用户误触 ——
  // 点一下想选中，结果启动了。

  var SETTING_IDS = {
    view: 'view',
    launchOn: 'launchOn',
    sortBy: 'sortBy',
    iconSize: 'iconSize',
    showLabels: 'showLabels',
    density: 'density',
  };

  var FALLBACK_SETTINGS = {
    view: 'grid',
    launchOn: 'double',
    sortBy: 'manual',
    iconSize: 'medium',
    showLabels: true,
    density: 'cozy',
  };

  var SETTING_ENUMS = {
    // `view` 是**会话状态**而不是用户在设置页里改的偏好，因此它不进清单的
    // `contributes.settings`；但它在结构上与其他设置项同源（都是"显示成什么样"），
    // 所以放在同一份归一化里，读旧数据时也接受顶层的 `view`。
    view: ['grid', 'list', 'compact'],
    launchOn: ['double', 'single'],
    sortBy: ['manual', 'recent', 'frequent', 'name'],
    iconSize: ['small', 'medium', 'large'],
    density: ['cozy', 'tight'],
    showLabels: [true, false],
  };

  // ============================================================
  // 小工具
  // ============================================================

  function newId(prefix) {
    return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /** 取路径最后一段（同时兼容 `/` 与 `\`） */
  function basename(path) {
    var parts = String(path).split(/[\\/]/);
    return parts[parts.length - 1] || String(path);
  }

  function stripExtension(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }

  /** 小写扩展名，带点。没有扩展名时返回空串。 */
  function extensionOf(path) {
    var base = basename(path);
    var i = base.lastIndexOf('.');
    if (i <= 0 || i === base.length - 1) return '';
    return base.slice(i).toLowerCase();
  }

  /** 去掉首尾空白。所有比较与存储都用它，避免同一份路径因为空格变成两个条目。 */
  function trimmed(value) {
    return String(value === null || value === undefined ? '' : value).replace(/^\s+|\s+$/g, '');
  }

  /**
   * 看起来像不像「可执行映像」。
   *
   * `.lnk` / `.url` 是 shell 的跳板，不是映像；目录没有扩展名。判据只用于
   * **选择宿主方法**（见 `resolveLaunch`），不用于校验存在性 —— 插件没有
   * 权限去 stat 文件，而猜错一个文件的类型后果只是多一条可读的错误。
   *
   * 把 `.bat` / `.cmd` / `.ps1` 也算进来是有意的：它们是命令行脚本，
   * `CreateProcess` 能直接跑 `.bat` / `.cmd`，而 `.ps1` 交给 `open` 会走
   * 文件关联（用户机器上通常是「用记事本打开」）——那显然不是用户想要的。
   */
  var EXEC_EXTENSIONS = ['.exe', '.com', '.bat', '.cmd', '.ps1', '.msc'];

  function looksExecutable(path) {
    var ext = extensionOf(path);
    for (var i = 0; i < EXEC_EXTENSIONS.length; i++) {
      if (EXEC_EXTENSIONS[i] === ext) return true;
    }
    return false;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function absoluteTime(ts) {
    if (!ts) return '';
    var date = new Date(ts);
    return (
      date.getFullYear() +
      '-' +
      pad2(date.getMonth() + 1) +
      '-' +
      pad2(date.getDate()) +
      ' ' +
      pad2(date.getHours()) +
      ':' +
      pad2(date.getMinutes())
    );
  }

  /** 相对时间，用于「最近使用」那一行。绝对时刻另给一份（`absoluteTime`）。 */
  function relativeTime(ts) {
    if (!ts) return '';
    var delta = Date.now() - ts;
    if (delta < 0) return '刚刚';
    var seconds = Math.round(delta / 1000);
    if (seconds < 45) return '刚刚';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + ' 分钟前';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + ' 小时前';
    var days = Math.round(hours / 24);
    if (days < 30) return days + ' 天前';
    var date = new Date(ts);
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /**
   * 解析「参数」输入框：按空白切分。
   *
   * **不支持引号**，因此带空格的参数没法写。参数是作为独立的 argv 项交给系统的
   * （不经过 shell，因此没有注入问题），缺的只是输入层的引号解析 —— 这是
   * README 里如实写下的已知限制，而不是看起来能用、实际上会被拆坏的那种。
   */
  function parseArgs(text) {
    return String(text || '')
      .split(/\s+/)
      .filter(function (s) {
        return s.length > 0;
      });
  }

  /**
   * 找到包裹本模块的滚动容器 —— 它的可见矩形就是「模块视图」的范围。
   *
   * 为什么需要它：`position: fixed` 是相对**窗口**定位的，直接 `inset: 0` 会让
   * 对话框盖住标题栏与二级标题栏。而模块真正的可见区域是那个滚动容器
   * （宿主为每个标签各建一个，以实现滚动位置保活），它的
   * `getBoundingClientRect()` 恰好等于屏幕上的可见范围。
   *
   * 这里刻意**按计算样式判断**（overflow-y 为 auto / scroll）而不是
   * `closest('.lc-tab-panel')`：插件不该依赖宿主的类名，那是内部实现；
   * 「最近的可滚动祖先」是通用的 CSS 语义。
   */
  function findScrollAncestor(node) {
    var el = node && node.parentElement;
    while (el && el !== document.body) {
      var style = window.getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') return el;
      if (el.getAttribute && el.getAttribute('data-modulith-scroll') === 'true') return el;
      el = el.parentElement;
    }
    return null;
  }

  // ============================================================
  // 网址  ← 「体贴，不是猜」
  // ============================================================
  //
  // 宿主的 `open()` 只放行三种 scheme：`http` / `https` / `mailto`。其余一律
  // 拒绝（这是对的：`file:`、`javascript:`、`ms-settings:` 这类东西要么能读本机
  // 文件、要么能执行脚本、要么能改系统设置，把它们交给 shell 关联就等于把
  // 这些能力交出去）。因此校验放在插件这一侧，**错误消息要说清为什么**。
  //
  // 用户只输入 `example.com` 时补成 `https://example.com`：这是体贴，不是猜 ——
  // 补完的结果必须**看得见**（对话框里回显补后的值，并且提交后存的是补后的值）。

  /** 输入看起来是「网址」而不是路径吗。用于提示与 `kind` 的粗判。 */
  function looksLikeUrlText(value) {
    var text = trimmed(value);
    if (!text) return false;
    if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(text)) return true;
    // 光秃秃的域名：没有盘符（`C:\`）、没有路径分隔符、有点、没有空格。
    if (/^[a-zA-Z]:[\\/]/.test(text)) return false;
    if (text.indexOf('\\') !== -1) return false;
    if (/\s/.test(text)) return false;
    if (text.indexOf('/') !== -1 && !/^[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}([/:?#].*)?$/.test(text)) {
      return false;
    }
    return /^[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}([/:?#].*)?$/.test(text);
  }

  /**
   * 从用户手填的一串文本推断条目类型。
   *
   * 用在「添加程序 / 文件」对话框上：用户把 `example.com` 填进路径框时，
   * **不直接拒绝**，而是提示"这看起来是一个网址"，并让提交按网址的规则走
   * （补 https 之后仍然要能看见补出来的结果）。判据只认确定的东西：
   * 有 scheme，或者是一个光秃秃的域名。
   */
  function guessKind(text) {
    return looksLikeUrlText(text) ? 'url' : 'app';
  }

  /** 从网址里取主机名；取不到时返回空串。 */
  function hostOf(url) {
    var text = trimmed(url);
    var match = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^/?#]*)/.exec(text);
    if (!match) return '';
    var host = match[2].replace(/^[^@]*@/, '');
    var colon = host.lastIndexOf(':');
    if (colon > 0) host = host.slice(0, colon);
    return host;
  }

  /** 网址条目的可读名字：github.com（没有主机名时退回整串，再截断）。 */
  function urlLabel(url) {
    var host = hostOf(url);
    if (host) {
      var httpHost = host.charAt(0).toLowerCase() === 'w' && host.slice(0, 4).toLowerCase() === 'www.'
        ? host.slice(4)
        : host;
      return httpHost || host;
    }
    var text = trimmed(url);
    return text.length > 32 ? text.slice(0, 31) + '…' : text;
  }

  /**
   * 校验并归一化一个网址。
   *
   * 返回 `{ ok: true, url, normalized, message }` 或
   * `{ ok: false, code, message }`。`message` 是**给用户看的中文**，说明了原因 ——
   * 「格式不对」四个字对着 `javascript:alert(1)` 是没法照做的。
   *
   * `normalized` 为真表示这次补了 scheme，调用方**必须把它回显出来**。
   */
  /**
   * URL 里**永远不该出现、但复制粘贴经常带上**的不可见字符。
   *
   *   * `\u00a0` 不换行空格 —— 从网页与聊天软件里复制时最常见的一大类；
   *   * `\u2000`–`\u200a` 各种宽度的空格、`\u202f` 窄不换行空格、`\u3000` 全角空格；
   *   * `\u200b`–`\u200f`、`\u2060`、`\ufeff` 零宽字符与方向标记。
   *
   * 它们在 URL 里没有任何合法用途（真要有空格必须写成 `%20`），因此直接**删掉**，
   * 而不是报一个用户无法照做的错。删掉这件事必须**看得见** —— 与补 `https://`
   * 是同一条规矩。
   */
  var INVISIBLE_IN_URL = /[\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]/g;

  /** 真正会破坏网址的字符：ASCII 空格、C0/C1 控制字符、DEL。 */
  var URL_BREAKING = /[\u0000-\u0020\u007f-\u009f]/;

  function validateUrl(value) {
    var text = trimmed(value);
    if (!text) {
      return { ok: false, code: 'empty', message: '请填写网址，例如 example.com 或 https://example.com' };
    }
    // 先去掉**看不见**的字符，再做空白判定。
    //
    // **顺序不能反。** 这些字符在输入框里看不出来，而 `\s` 会匹配其中一部分 ——
    // 反过来的结果是用户收到一句「网址里不能有空格」，可他在那个网址里怎么找都
    // 找不到空格，只能来报 bug（这正是收到的那条报告）。
    var stripped = 0;
    var withoutInvisible = text.replace(INVISIBLE_IN_URL, function () {
      stripped += 1;
      return '';
    });
    if (stripped > 0) {
      text = withoutInvisible;
      if (!text) {
        return {
          ok: false,
          code: 'invisible-only',
          message: '输入里只有看不见的字符（零宽字符或特殊空格），没有真正的网址。',
        };
      }
    }

    // 剩下**真的会破坏网址**的只有 ASCII 空格与控制字符。错误里必须给出位置 ——
    // 「不能有空格」这句话对着一个看不出空格的输入是没法照做的。
    var breaking = URL_BREAKING.exec(text);
    if (breaking) {
      var where = breaking.index + 1;
      var codePoint = ('0000' + breaking[0].charCodeAt(0).toString(16).toUpperCase()).slice(-4);
      var what = breaking[0] === ' ' ? '一个空格' : '一个控制字符（U+' + codePoint + '）';
      return {
        ok: false,
        code: 'space',
        message: '网址的第 ' + where + ' 个字符是' + what + '。网址里的空格要写成 %20。',
      };
    }

    if (text.length > MAX_URL_LENGTH) {
      return {
        ok: false,
        code: 'too-long',
        message: '网址太长了（' + text.length + ' 字符，上限 ' + MAX_URL_LENGTH + '）。',
      };
    }

    var schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(text);
    var url = text;
    // `normalized` 表示"我们改过用户输入"，去掉不可见字符也算改过。
    var normalized = stripped > 0;
    var schemeAdded = false;

    if (!schemeMatch) {
      // 只写了域名（或者域名加路径）时补 https。补完的结果必须回显。
      if (!/^[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}([/:?#].*)?$/.test(text)) {
        return {
          ok: false,
          code: 'shape',
          message: '这不是一个能识别的网址：既没有 http:// 或 https:// 开头，也不像一个域名。',
        };
      }
      url = 'https://' + text;
      normalized = true;
      schemeAdded = true;
      schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(url);
    }

    var scheme = schemeMatch[1].toLowerCase();

    /** 「我替你改了什么」的那句话。改了什么必须看得见。 */
    function noteFor(schemeAdded) {
      var parts = [];
      if (stripped > 0) {
        parts.push('输入里有 ' + stripped + ' 个看不见的字符（零宽字符或特殊空格），已经去掉');
      }
      if (schemeAdded) {
        parts.push('只输入域名时默认按 https 处理，已补成 ' + url);
      }
      return parts.length ? parts.join('；') + '。' : '';
    }

    if (scheme === 'mailto') {
      var address = url.slice(url.indexOf(':') + 1).replace(/^\/*/, '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
        return { ok: false, code: 'mailto', message: 'mailto: 后面要跟一个邮箱地址，例如 mailto:someone@example.com' };
      }
      return { ok: true, url: url, normalized: normalized, note: noteFor(schemeAdded), message: '' };
    }

    if (scheme !== 'http' && scheme !== 'https') {
      return {
        ok: false,
        code: 'scheme',
        message:
          '只支持 http:// 与 https:// 两种网址（以及 mailto:）。' +
          '「' +
          scheme +
          ':」这种写法宿主不会交给系统处理 —— 它能直接读本机文件、执行脚本或改系统设置，' +
          '因此被刻意拦在外面。',
      };
    }

    if (!hostOf(url)) {
      return { ok: false, code: 'host', message: '网址里没有主机名，例如 https://example.com' };
    }

    return { ok: true, url: url, normalized: normalized, note: noteFor(schemeAdded), message: '' };
  }

  // ============================================================
  // 「打开」到底该走哪一条宿主路径  ← 本插件最容易搞错的地方
  // ============================================================
  //
  // 判据只有下面这一个函数，理由逐条写在返回值旁边。它是**纯函数**：
  // 不读状态、不碰 DOM，因此可以被验证脚本直接调用（见文件末尾的 `__test__`）。

  /**
   * 这个条目的目标是不是「地址」，也就是不该去找所在文件夹的东西。
   * 网址条目与 `.url` 快捷方式都是地址。
   */
  function isAddressItem(item) {
    if (!item) return false;
    if (item.kind === 'url') return true;
    return extensionOf(item.target) === '.url';
  }

  function canOpen() {
    return !!(ctx && ctx.launcher && typeof ctx.launcher.open === 'function');
  }

  /**
   * 旧版本的宿主没有 `ctx.launcher.open`（它是 1.7.1 才加的）。那时**不要**
   * 直接调用而拿到一个 `TypeError: ctx.launcher.open is not a function` ——
   * 那句话对着用户没有任何指导意义。这里给一句能照做的中文。
   *
   * 因为存在这条降级路径，`manifest.json` 的 `engines.modulith` **保持
   * `>=1.6.0`**：装得上，只是打开快捷方式与网址时需要更新的宿主。
   */
  function openUnsupportedMessage(item) {
    var what = item && item.kind === 'url' ? '网址' : '快捷方式、目录与文档';
    return (
      '这个版本的应用还不支持打开' +
      what +
      '，请升级应用到 1.7.1 或更高。' +
      '（当前这个宿主没有提供 ctx.launcher.open，它只认可执行文件。）'
    );
  }

  /**
   * 决定怎么打开一个条目。返回 `{ method, target, args }` 或 `{ error }`。
   *
   *   * `kind === 'url'`                      → `open`：网址没有进程可启动。
   *   * `.lnk` / `.url` / 目录 / 其它文档      → `open`：`CreateProcess` 不认它们，
   *     交给 shell 的文件关联（等价于资源管理器里双击）。
   *   * 可执行文件**且带参数**                 → `launch(target, args)`：`open`
   *     不接受参数，用它会静默丢掉参数。
   *   * 可执行文件**且没有参数**               → `launch`：两条路都行，保持原有语义。
   *
   * 目标为空、或需要 `open` 而它不存在时返回 `{ error }`（可读中文，不是异常）。
   */
  function resolveLaunch(item) {
    if (!item) return { error: '这个条目已经不在列表里了。' };
    var target = trimmed(item.target);
    if (!target) {
      return { error: '这个条目没有目标路径或网址，请右键 →「编辑…」补上。' };
    }

    var args = Array.isArray(item.args) ? item.args : [];

    if (item.kind === 'url') {
      var checked = validateUrl(target);
      if (!checked.ok) return { error: '这个网址现在打不开：' + checked.message };
      target = checked.url;
    } else if (looksExecutable(target)) {
      // 可执行映像：有参数就走 launch（`open` 不接受参数，用它会把参数静默丢掉），
      // 没有参数也走 launch 以保持这个插件原有的语义（那条路不经过 shell 关联）。
      return { method: 'launch', target: target, args: args };
    }
    // 剩下的一切：网址、`.lnk`、`.url`、目录、`.txt` / `.pdf` 一类文档 ——
    // `CreateProcess` 一个都不认，必须交给 shell 的文件关联。

    if (!canOpen()) return { error: openUnsupportedMessage(item) };
    return { method: 'open', target: target, args: [] };
  }

  /** 排序用的人类可读标签：菜单里显示「打开」还是「打开网址」。 */
  function openVerb(item) {
    if (!item) return '打开';
    return item.kind === 'url' ? '打开网址' : '打开';
  }

  // ============================================================
  // 状态  ← 老数据必须能读进来
  // ============================================================
  //
  // 存储格式会随插件演进。用户的数据只有一份，**读的时候容错比写的时候谨慎更重要**：
  // 读失败就全丢了。
  //
  // 认识的三种历史形态：
  //   1. 最早那版：`shortcuts` 下直接是一个条目数组；
  //   2. v1：`{ version, items, groups, view, filter }` —— 没有 `kind`、没有
  //      `pinned`、没有启动统计，设置是散的；
  //   3. v2（当前）：`{ version, items, groups, settings }`。
  //
  // 归一化之后**条目一个都不会少**：缺失的字段给默认值，旧条目按 `app` 处理
  // （老结构里只可能是程序与文件，不可能是网址）。

  function emptyState() {
    return {
      version: STATE_VERSION,
      items: [],
      groups: [],
      // 走一次归一化而不是写一个字面量：`view` 也是设置项之一，写在两处
      // 迟早会分叉（其中一处忘了加 `view` 的症状是"切到列表视图之后重开又变回网格"）。
      settings: normalizeSettings(FALLBACK_SETTINGS),
      filter: 'all',
      collapsed: {},
    };
  }

  /**
   * 把任何来源的设置值整理成一份完整可用的设置。
   *
   * 只接受枚举里列出的取值：`sortBy` 读成 `'最近'` 这种没人认识的值时，
   * 排序会静默退回手动 —— 而「明明选了最近使用，顺序却一动不动」是一个
   * 很难查的症状，因此这里在读的时候就把不认识的值丢掉。
   */
  function normalizeSettings(raw) {
    var source = raw && typeof raw === 'object' ? raw : {};
    var out = {};
    Object.keys(SETTING_IDS).forEach(function (id) {
      var fallback = FALLBACK_SETTINGS[id];
      var value = source[id];
      var allowed = SETTING_ENUMS[id];
      var accepted = false;
      for (var i = 0; i < allowed.length; i++) {
        // 布尔值要显式比较：`'false'` 与 `false` 都是可能存回来的形状。
        if (allowed[i] === value) {
          accepted = true;
          break;
        }
        if (typeof allowed[i] === 'boolean' && typeof value === 'string') {
          if (String(allowed[i]) === value.toLowerCase()) {
            value = allowed[i];
            accepted = true;
            break;
          }
        }
      }
      out[id] = accepted ? value : fallback;
    });
    return out;
  }

  /** `settings` 对象深处取一个值，没有就返回 undefined。 */
  function pickSetting(source, id) {
    if (!source || typeof source !== 'object') return undefined;
    return Object.prototype.hasOwnProperty.call(source, id) ? source[id] : undefined;
  }

  /**
   * 清单里声明的设置项**优先于**插件自己存的（它们本来就是同一个值，
   * 而清单那一份是用户在设置页里改的，更权威）。
   */
  function mergeSettings(stored, authoritative) {
    var merged = normalizeSettings(stored);
    if (authoritative && typeof authoritative === 'object') {
      Object.keys(SETTING_IDS).forEach(function (id) {
        if (Object.prototype.hasOwnProperty.call(authoritative, id)) {
          merged[id] = authoritative[id];
        }
      });
    }
    return normalizeSettings(merged);
  }

  function normalizeItem(item, fallbackGroupId) {
    var source = item && typeof item === 'object' ? item : {};
    var target = trimmed(source.target);
    var kind = source.kind === 'url' ? 'url' : 'app';
    var name = trimmed(source.name);
    if (!name) {
      name = kind === 'url' ? urlLabel(target) : stripExtension(basename(target));
    }
    var launchCount = Number(source.launchCount);
    if (!isFinite(launchCount) || launchCount < 0) launchCount = 0;
    var lastLaunchedAt = Number(source.lastLaunchedAt);
    if (!isFinite(lastLaunchedAt) || lastLaunchedAt <= 0) lastLaunchedAt = 0;
    var iconError = source.iconError === true;
    return {
      id: typeof source.id === 'string' && source.id ? source.id : newId('sc-'),
      kind: kind,
      name: name,
      target: target,
      args: Array.isArray(source.args)
        ? source.args.filter(function (a) {
            return typeof a === 'string';
          })
        : [],
      groupId: typeof source.groupId === 'string' && source.groupId ? source.groupId : fallbackGroupId || null,
      note: typeof source.note === 'string' ? source.note : '',
      pinned: source.pinned === true,
      addedAt: Number(source.addedAt) > 0 ? Number(source.addedAt) : Date.now(),
      launchCount: Math.round(launchCount),
      lastLaunchedAt: lastLaunchedAt,
      // 上一次启动失败留下的标记：界面上显示「打不开」。下一次成功启动后清除。
      // 只在**显式为 true** 时恢复，避免旧数据里一个随便的字段把它点亮。
      broken: source.broken === true,
      brokenReason: typeof source.brokenReason === 'string' ? source.brokenReason : '',
      iconError: iconError,
      iconErrorReason: typeof source.iconErrorReason === 'string' ? source.iconErrorReason : '',
    };
  }

  function normalizeState(raw) {
    if (!raw) return emptyState();

    // 形态 1：直接是数组（最早那版）。
    if (Array.isArray(raw)) {
      var fromArray = emptyState();
      fromArray.items = raw.map(function (item) {
        return normalizeItem(item, null);
      });
      return fromArray;
    }

    var state = emptyState();
    state.items = (Array.isArray(raw.items) ? raw.items : []).map(function (item) {
      return normalizeItem(item, null);
    });
    state.groups = (Array.isArray(raw.groups) ? raw.groups : []).map(function (g) {
      var source = g && typeof g === 'object' ? g : {};
      return {
        id: typeof source.id === 'string' && source.id ? source.id : newId('g-'),
        name: trimmed(source.name) || '未命名分组',
      };
    });

    // 设置有三处可能的来源，优先级从低到高：旧结构的散字段 → `settings`。
    var stored = {};
    Object.keys(SETTING_IDS).forEach(function (id) {
      var legacy = pickSetting(raw, id);
      if (legacy !== undefined) stored[id] = legacy;
    });
    var nested = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    Object.keys(SETTING_IDS).forEach(function (id) {
      if (Object.prototype.hasOwnProperty.call(nested, id)) stored[id] = nested[id];
    });
    // v1 的 `view` 住在顶层；v2 把它挪进了 `settings.view`。两处都认。
    if (nested.view !== undefined) stored.view = nested.view;
    else if (raw.view !== undefined) stored.view = raw.view;
    state.settings = normalizeSettings(stored);

    // 筛选：v1 叫 `filter`，v2 沿用同名（它是"当前在看哪个分组"，属于会话状态）。
    state.filter = typeof raw.filter === 'string' && raw.filter ? raw.filter : 'all';

    // 折叠状态：只保留布尔值，`true` 表示折起来了。
    var collapsed = raw.collapsed && typeof raw.collapsed === 'object' ? raw.collapsed : {};
    Object.keys(collapsed).forEach(function (key) {
      if (collapsed[key] === true) state.collapsed[key] = true;
    });

    // 指向已删除分组的条目回落到「未分组」，否则它们会从任何筛选下消失
    var known = {};
    state.groups.forEach(function (g) {
      known[g.id] = true;
    });
    state.items.forEach(function (item) {
      if (item.groupId && !known[item.groupId]) item.groupId = null;
    });
    if (state.filter !== 'all' && state.filter !== 'none' && !known[state.filter]) {
      state.filter = 'all';
    }

    return state;
  }

  // ============================================================
  // 搜索 / 排序  ← 与界面无关的纯函数，验证脚本直接调它们
  // ============================================================

  /**
   * 按名称 / 备注 / 路径 / 网址过滤。
   *
   * 空串（或只有空格）表示不过滤。匹配是**大小写不敏感的子串**，不做分词 ——
   * 条目数通常只有几十条，而"搜 github 能搜到 GitHub"比任何高级匹配都实用。
   */
  function matchesQuery(item, query) {
    var q = trimmed(query).toLowerCase();
    if (!q) return true;
    var fields = [item.name, item.note, item.target];
    for (var i = 0; i < fields.length; i++) {
      var value = fields[i];
      if (typeof value === 'string' && value.toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  }

  function searchItems(items, query) {
    return items.filter(function (item) {
      return matchesQuery(item, query);
    });
  }

  /**
   * 排序。四个模式共有的两条规则：
   *
   *   1. **固定项永远在最前。** 用户按下「固定」就是在说"这一条别动"，
   *      因此它不受排序模式影响 —— 但固定项**内部**仍然按当前模式排。
   *   2. **平手时按原始顺序。** JS 的 `Array.sort` 在现代引擎里是稳定的，
   *      但这里显式带上下标，读代码的人不必去查这条保证。
   *
   * `manual` 就是原始顺序（用户没有别的表达顺序的方式）。`recent` / `frequent`
   * 里从没启动过的条目排在后面，它们之间按加入时间倒序 —— 新加的排在旧的前面。
   */
  function sortItems(items, mode) {
    var decorated = items.map(function (item, index) {
      return { item: item, index: index };
    });
    decorated.sort(function (a, b) {
      if (!!a.item.pinned !== !!b.item.pinned) return a.item.pinned ? -1 : 1;
      var diff = compareItems(a.item, b.item, mode);
      if (diff !== 0) return diff;
      return a.index - b.index;
    });
    return decorated.map(function (entry) {
      return entry.item;
    });
  }

  function compareItems(a, b, mode) {
    if (mode === 'name') {
      var an = String(a.name || '').toLowerCase();
      var bn = String(b.name || '').toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
    }
    if (mode === 'recent') {
      return (Number(b.lastLaunchedAt) || 0) - (Number(a.lastLaunchedAt) || 0) || b.addedAt - a.addedAt;
    }
    if (mode === 'frequent') {
      return (Number(b.launchCount) || 0) - (Number(a.launchCount) || 0) || b.addedAt - a.addedAt;
    }
    return 0;
  }

  /**
   * 从 `all` 里把要显示的内容算出来：先按分组筛选，再搜索，最后排序。
   *
   * 返回 `{ groups: [{ key, id, name, items }], total }`。`filter === 'all'`
   * 时按分组分节（这样长列表滚动时用户始终看得到"现在在哪个分组里"），
   * 否则只有一节。
   *
   * **没有分组的条目**在 `all` 视图下会单独成节（key 为 `none`），而不是被
   * 悄悄塞进第一个分组 —— 那会让用户以为自己的条目被挪走了。
   */
  function buildSections(state, query) {
    var items = state.items;
    var filter = state.filter || 'all';
    var mode = state.settings ? state.settings.sortBy : 'manual';

    var scoped = items.filter(function (item) {
      if (filter === 'all') return true;
      if (filter === 'none') return !item.groupId;
      return item.groupId === filter;
    });
    var matched = searchItems(scoped, query);

    if (filter !== 'all') {
      var only = null;
      if (filter !== 'none') only = findById(state.groups, filter);
      return {
        sections: [
          {
            key: filter,
            id: filter === 'none' ? null : filter,
            name: only ? only.name : '未分组',
            items: sortItems(matched, mode),
          },
        ],
        total: matched.length,
      };
    }

    var sections = [];
    state.groups.forEach(function (group) {
      var inGroup = matched.filter(function (item) {
        return item.groupId === group.id;
      });
      if (inGroup.length === 0) return;
      sections.push({ key: group.id, id: group.id, name: group.name, items: sortItems(inGroup, mode) });
    });
    var ungrouped = matched.filter(function (item) {
      return !item.groupId;
    });
    if (ungrouped.length > 0) {
      sections.push({
        key: 'none',
        id: null,
        name: state.groups.length > 0 ? '未分组' : '全部',
        items: sortItems(ungrouped, mode),
      });
    }
    return { sections: sections, total: matched.length };
  }

  // ============================================================
  // 去重  ← 同一个目标不该有第二条
  // ============================================================

  /** 目标的归一化形式：去首尾空白 + 小写。Windows 的路径大小写不敏感。 */
  function targetKey(value) {
    return trimmed(value).toLowerCase();
  }

  function findByTarget(items, target) {
    var key = targetKey(target);
    if (!key) return null;
    for (var i = 0; i < items.length; i++) {
      if (targetKey(items[i].target) === key) return items[i];
    }
    return null;
  }

  // ============================================================
  // 设置读取  ← 沙箱里这一节是**异步**的，与类型包上写着的不一样
  // ============================================================
  //
  // `types/modulith.d.ts` 的 `PluginSettingsAPI.get` 声明成同步返回，而**沙箱
  // 桥接层返回的是 Promise**。两处都是对的、也都不该改：类型包映射的是宿主
  // in-process 那份契约，而沙箱是另一个 realm，值只能经 RPC 拿。
  //
  // 因此这里不假定是哪种：一律用 `Promise.resolve` 收口。
  //
  // 另外两个由此而来的结论（照 `plugins/clipboard-history` 的做法）：
  //
  //   * **沙箱里没有 `ctx.settings.subscribe`。** 桥接层刻意没做它（没有那条
  //     推送通道）。因此：① 组件挂载时读一次；② 模块**重新可见**时（
  //     `Modulith.useModuleActive()` 从假变真）再读一次 —— 那是"用户刚在设置页
  //     改过"唯一能被发现的时机。
  //   * **改了值之后必须重新读，不能"以写代读"。** `ctx.settings.set` 是异步的，
  //     就地改缓存会让界面显示一个还没落盘的值；落盘失败时它看起来一切正常，
  //     直到用户重开应用。

  /** 设置缓存。`null` 表示还没读过。 */
  var settingsCache = null;

  var allReaderSupported = true;

  function readOne(id, fallback) {
    var value;
    try {
      value = ctx.settings.get(id, fallback);
    } catch (e) {
      // 未声明 storage 权限时 `get` 会抛。那种情况下整个插件已经退化了，
      // 这里只回落到清单里的缺省值。
      return Promise.resolve(fallback);
    }
    return Promise.resolve(value).then(function (resolved) {
      if (resolved === undefined || resolved === null) return fallback;
      return resolved;
    });
  }

  function readFallback() {
    return Promise.resolve()
      .then(function () {
        if (!ctx.settings || !allReaderSupported) {
          return refreshSettingsItemByItem();
        }
        return Promise.resolve(ctx.settings.getAll()).then(
          function (all) {
            settingsCache = normalizeSettings(all);
            return settingsCache;
          },
          function () {
            // `getAll` 不在（极旧的宿主）时退回逐项读。这个降级路径**只可能跑一次**。
            allReaderSupported = false;
            return refreshSettingsItemByItem();
          }
        );
      })
      .catch(function () {
        settingsCache = normalizeSettings(null);
        return settingsCache;
      });
  }

  function refreshSettingsItemByItem() {
    var ids = Object.keys(SETTING_IDS);
    return Promise.all(
      ids.map(function (id) {
        return readOne(id, FALLBACK_SETTINGS[id]);
      })
    ).then(function (values) {
      var collected = {};
      ids.forEach(function (id, index) {
        collected[id] = values[index];
      });
      settingsCache = normalizeSettings(collected);
      return settingsCache;
    });
  }

  function loadSettings() {
    return readFallback();
  }

  /** 把权威值合并进一处设置。优先级：权威 > 缓存 > 缺省。 */
  function resolveSettings(stored, authoritative) {
    return mergeSettings(mergeSettings(stored, settingsCache), authoritative);
  }

  // ============================================================
  // 图标
  // ============================================================

  /** 已解析的图标：id -> dataURL（空串表示提取失败，避免反复重试） */
  var iconCache = {};
  /** 正在解析中的 id，防止重复发起 */
  var iconPending = {};

  /**
   * 先看存储里有没有，没有再请宿主提取一次并写回存储。
   *
   * 网址条目**不走这里**：它没有本地图标，宿主也提取不到（那是网络资源，而本插件
   * 刻意不申请 `network` 权限去抓 favicon）。它用的是字母瓦片，见 `iconTile()`。
   */
  function resolveIcon(item) {
    if (item.kind === 'url') {
      return Promise.resolve({ url: '', failed: false });
    }
    var target = trimmed(item.target);
    if (!target) return Promise.resolve({ url: '', failed: true, reason: '没有目标路径' });
    return ctx.storage
      .get(ICON_PREFIX + item.id, null)
      .then(function (saved) {
        if (saved) return { url: saved, failed: false };
        return ctx.icons.extract(target).then(function (url) {
          // 写回存储，下次启动就不必再调宿主
          return ctx.storage.set(ICON_PREFIX + item.id, url).then(function () {
            return { url: url, failed: false };
          });
        });
      })
      .catch(function (e) {
        // 提取失败不是致命错误（文件可能已被删除、也可能是没有图标资源的文件），
        // 记一条日志并回退到字母瓦片。
        ctx.logger.warn('提取图标失败：' + target, e);
        return { url: '', failed: true, reason: String((e && e.message) || e) };
      });
  }

  /** 丢弃某个条目缓存的图标，下次渲染时重新提取 */
  function invalidateIcon(id) {
    delete iconCache[id];
    delete iconPending[id];
    return ctx.storage.delete(ICON_PREFIX + id).catch(function () {});
  }

  /**
   * 网址条目的「字母瓦片」。
   *
   * 取主机名的前两个字（`github.com` → `gi`，`例.中国` → 首字）。
   * 背景用宿主的设计令牌，因此深色模式下自动跟着走 —— 不申请 `network`
   * 权限去抓 favicon 是有意的：那个权限换来的是"每个网址的图标"，代价是
   * 让这个插件能往任意地址发请求。
   */
  function iconTile(item) {
    var source = item.kind === 'url' ? hostOf(item.target) || item.target : item.name || item.target || '';
    var text = trimmed(source);
    if (!text) return '?';
    // 去掉常见前缀，让瓦片上是真正有辨识度的那两个字
    text = text.replace(/^www\./i, '');
    var chars = Array.from ? Array.from(text) : text.split('');
    return chars.slice(0, 2).join('').toUpperCase();
  }

  // ============================================================
  // 两步确认按钮  ← 替代 window.confirm
  // ============================================================
  //
  // 为什么不用 `window.confirm`：这个宿主里 `tauri-plugin-dialog` 注入的脚本
  // 把它换成了走 IPC 的 async 版本，于是 `!window.confirm(...)` 取反的是一个
  // Promise —— **永远是 false**，"用户点了取消"根本拦不住。仓库里
  // clipboard-history / notes / kanban / pomodoro 都有过同一个问题的记录。
  //
  // 这里的做法：第一次点击**什么也不做，只是把按钮变成"确认删除？"**，几秒内
  // 再点一次才真的执行。它不是模态框，因此不会打断用户，也不会挡住别的东西。

  function ConfirmButton(props) {
    var armedPair = React.useState(false);
    var armed = armedPair[0];
    var setArmed = armedPair[1];
    var timerRef = React.useRef(null);

    React.useEffect(
      function () {
        return function () {
          if (timerRef.current) clearTimeout(timerRef.current);
        };
      },
      []
    );

    function disarm() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setArmed(false);
    }

    function onClick() {
      if (!armed) {
        setArmed(true);
        timerRef.current = setTimeout(function () {
          timerRef.current = null;
          setArmed(false);
        }, CONFIRM_TIMEOUT_MS);
        return;
      }
      disarm();
      props.onConfirm();
    }

    return h(
      'button',
      {
        className: props.className + (armed ? ' ql-btn-danger-armed' : ''),
        type: 'button',
        onClick: onClick,
        onBlur: disarm,
        'aria-label': armed ? (props.armedLabel || '确认执行这个不可撤销的操作') : props.label,
      },
      armed ? props.confirmLabel || '确认删除？' : props.label
    );
  }

  // ============================================================
  // 右键菜单
  // ============================================================

  /**
   * 一个最小的右键菜单。
   *
   * 插件**不能复用宿主的组件**（`Sidebar/ModuleContextMenu` 之类），因为插件是
   * 独立 bundle、只能拿到 `Modulith.React`。因此这里自己实现一份。
   *
   * 位置会按视口做钳制：贴着右下角右键时，菜单不该跑到屏幕外。
   */
  function ContextMenu(props) {
    var ref = React.useRef(null);
    var coords = React.useState({ x: props.x, y: props.y });
    var pos = coords[0];
    var setPos = coords[1];

    React.useEffect(
      function () {
        var node = ref.current;
        if (!node) return;
        var rect = node.getBoundingClientRect();

        // 限制在**模块可见区域**内，而不是整个窗口 —— 否则贴着顶部右键时，
        // 菜单会压到标题栏与二级标题栏上。拿不到矩形时退回窗口范围。
        var box = props.box;
        var left = box ? box.left : 0;
        var top = box ? box.top : 0;
        var right = box ? box.left + box.width : window.innerWidth;
        var bottom = box ? box.top + box.height : window.innerHeight;

        var margin = 8;
        var x = props.x;
        var y = props.y;
        if (x + rect.width + margin > right) x = right - rect.width - margin;
        if (y + rect.height + margin > bottom) y = bottom - rect.height - margin;
        setPos({ x: Math.max(left + margin, x), y: Math.max(top + margin, y) });
      },
      [props.x, props.y, props.box]
    );

    React.useEffect(
      function () {
        function onDown(event) {
          if (ref.current && ref.current.contains(event.target)) return;
          props.onClose();
        }
        function onKey(event) {
          if (event.key === 'Escape') props.onClose();
        }
        // 捕获阶段监听，保证在任何其它处理之前关闭
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', props.onClose);
        return function () {
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('keydown', onKey);
          window.removeEventListener('resize', props.onClose);
        };
      },
      [props]
    );

    return h(
      'div',
      {
        ref: ref,
        className: 'ql-menu',
        role: 'menu',
        style: { left: pos.x + 'px', top: pos.y + 'px' },
        onContextMenu: function (event) {
          event.preventDefault();
        },
      },
      props.items.map(function (item, index) {
        if (item.separator) {
          return h('div', { key: 'sep-' + index, className: 'ql-menu-sep' });
        }
        if (item.heading) {
          return h('div', { key: 'head-' + index, className: 'ql-menu-heading' }, item.label);
        }
        // 少数几项不是普通菜单项，而是插件自己渲染的元素（两步确认按钮）——
        // 那个按钮要自己管状态，因此不能包在 `<button>` 里（嵌套按钮是无效 HTML，
        // 点击行为也会分裂成两个目标）。
        if (item.node) {
          return h('div', { key: 'node-' + index, className: 'ql-menu-slot' }, item.node);
        }
        return h(
          'button',
          {
            key: item.label + '-' + index,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': item.checked ? 'true' : 'false',
            className:
              'ql-menu-item' +
              (item.danger ? ' ql-menu-item-danger' : '') +
              (item.checked ? ' ql-menu-item-checked' : ''),
            onClick: function () {
              props.onClose();
              item.onClick();
            },
          },
          h('span', { className: 'ql-menu-label' }, item.label),
          item.hint ? h('span', { className: 'ql-menu-hint' }, item.hint) : null,
          item.checked ? h('span', { className: 'ql-menu-mark' }, '✓') : null
        );
      })
    );
  }

  // ============================================================
  // 编辑 / 新增对话框
  // ============================================================

  function EditDialog(props) {
    var draftState = React.useState(props.draft);
    var draft = draftState[0];
    var setDraft = draftState[1];
    var targetRef = React.useRef(null);

    function patch(part) {
      setDraft(Object.assign({}, draft, part));
    }

    function isUrlMode() {
      return draft.kind === 'url';
    }

    /**
     * 提交前的校验。
     *
     * 网址与路径是两套完全不同的规则，因此这里分两条路走，而且**都在**
     * `submit()` 这一处收口 —— 只有一处能决定"能不能存"。
     */
    function submit() {
      var target = trimmed(draft.target);
      if (!target) {
        patch({ error: isUrlMode() ? '请填写网址' : '请填写程序路径或文件路径' });
        return;
      }
      if (isUrlMode()) {
        var checked = validateUrl(target);
        if (!checked.ok) {
          patch({ error: checked.message });
          return;
        }
        props.onSubmit(
          Object.assign({}, draft, {
            kind: 'url',
            target: checked.url,
            argsText: '',
            // 补出来的 scheme 要让用户看得见：回显进输入框，然后才提交。
            autoFixed: checked.normalized,
            autoFixNote: checked.note,
          })
        );
        return;
      }
      props.onSubmit(Object.assign({}, draft, { kind: 'app', target: target }));
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        props.onCancel();
      }
      // Ctrl/Cmd + Enter 提交，普通 Enter 留给多行备注
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit();
    }

    function field(label, hint, control) {
      return h(
        'label',
        { className: 'ql-field' },
        h('span', { className: 'ql-field-label' }, label),
        control,
        hint ? h('span', { className: 'ql-field-hint' }, hint) : null
      );
    }

    // 覆盖层要**只盖住模块的可见区域**，而不是整个窗口 —— 否则它会压住标题栏
    // 与二级标题栏。做法是固定定位 + 实测出来的可见矩形（见 props.box）。
    // 拿不到矩形时退回 CSS 的 `inset: 0`，至少不会不可用。
    var overlayStyle = props.box
      ? {
          top: props.box.top + 'px',
          left: props.box.left + 'px',
          width: props.box.width + 'px',
          height: props.box.height + 'px',
          right: 'auto',
          bottom: 'auto',
        }
      : undefined;

    var title = props.mode === 'new' ? (isUrlMode() ? '添加网址' : '添加快捷方式') : '编辑' + (isUrlMode() ? '网址' : '快捷方式');

    return h(
      'div',
      {
        className: 'ql-overlay',
        style: overlayStyle,
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) props.onCancel();
        },
      },
      h(
        'div',
        { className: 'ql-dialog', role: 'dialog', 'aria-label': title, onKeyDown: onKeyDown },
        h('h2', { className: 'ql-dialog-title' }, title),

        props.error || draft.error
          ? h('div', { className: 'ql-error', role: 'alert' }, h('span', { className: 'ql-error-text' }, props.error || draft.error))
          : null,

        draft.kindNote
          ? h('div', { className: 'ql-note' }, draft.kindNote)
          : null,

        draft.autoFixed
          ? h(
              'div',
              { className: 'ql-note' },
              // **文案来自校验函数**，不是写死的一句。它可能补了 scheme，
              // 也可能只是去掉了看不见的字符 —— 写死"已补全为 https"会在后一种
              // 情况下说假话（输入本来就是 `https://…`）。
              draft.autoFixNote || '已自动补全为 ' + draft.target + '。'
            )
          : null,

        field(
          '名称',
          '留空时取文件名或域名',
          h('input', {
            className: 'ql-input',
            type: 'text',
            value: draft.name,
            autoFocus: true,
            placeholder: isUrlMode() ? '例如 GitHub' : '例如 浏览器',
            'aria-label': '名称',
            onChange: function (e) {
              patch({ name: e.target.value, error: '' });
            },
          })
        ),

        field(
          isUrlMode() ? '网址' : '程序 / 文件路径',
          isUrlMode()
            ? 'http://、https:// 或 mailto:；只写 example.com 会自动补成 https://example.com'
            : '必须是绝对路径，例如 C:\\Program Files\\App\\app.exe。也可以填目录或 .lnk 快捷方式。',
          h('input', {
            ref: targetRef,
            className: 'ql-input ql-input-mono',
            type: 'text',
            value: draft.target,
            placeholder: isUrlMode() ? 'example.com' : 'C:\\Program Files\\App\\app.exe',
            'aria-label': isUrlMode() ? '网址' : '程序或文件路径',
            onChange: function (e) {
              // 用户手改了地址就撤销"自动补全"的提示
              patch({ target: e.target.value, error: '', autoFixed: false, autoFixNote: '' });
            },
            onBlur: function () {
              var value = trimmed(draft.target);
              if (!value) return;

              // 用户在「添加程序 / 文件」里填了一串明显是网址的东西时，
              // **不直接拒绝**，而是把这条目改成网址类型并说明。
              // 改类型之后下面那条"自动补全"的分支会立刻把它补成 https 并回显。
              if (!isUrlMode() && guessKind(value) === 'url') {
                if (!looksExecutable(value)) {
                  var guessed = validateUrl(value);
                  if (guessed.ok) {
                    patch({
                      kind: 'url',
                      target: guessed.url,
                      autoFixed: guessed.normalized,
                      autoFixNote: guessed.note,
                      kindNote: '这看起来是一个网址，已经按网址处理。',
                    });
                    return;
                  }
                }
              }

              // 失焦时把补全结果回显出来（只补不存，用户还能改）
              if (!isUrlMode()) return;
              if (draft.autoFixed) return;
              var checked = validateUrl(value);
              if (checked.ok && checked.normalized) {
                patch({ target: checked.url, autoFixed: true, autoFixNote: checked.note });
              }
            },
          })
        ),

        isUrlMode()
          ? null
          : field(
              '启动参数',
              '按空格分隔，不支持引号；只有可执行文件会用到这里',
              h('input', {
                className: 'ql-input ql-input-mono',
                type: 'text',
                value: draft.argsText,
                placeholder: '可选',
                'aria-label': '启动参数',
                onChange: function (e) {
                  patch({ argsText: e.target.value });
                },
              })
            ),

        field(
          '分组',
          null,
          h(
            'select',
            {
              className: 'ql-input',
              value: draft.groupId || '',
              'aria-label': '分组',
              onChange: function (e) {
                patch({ groupId: e.target.value || null });
              },
            },
            h('option', { value: '' }, '未分组'),
            props.groups.map(function (g) {
              return h('option', { key: g.id, value: g.id }, g.name);
            })
          )
        ),

        field(
          '备注',
          '鼠标悬浮在卡片上时显示；搜索也会匹配它',
          h('textarea', {
            className: 'ql-input ql-textarea',
            rows: 3,
            value: draft.note,
            placeholder: '可选',
            'aria-label': '备注',
            onChange: function (e) {
              patch({ note: e.target.value });
            },
          })
        ),

        h(
          'div',
          { className: 'ql-dialog-actions' },
          isUrlMode()
            ? null
            : h(
                'button',
                {
                  className: 'ql-btn ql-btn-ghost',
                  type: 'button',
                  onClick: function () {
                    props.onRefreshIcon();
                  },
                },
                '重新提取图标'
              ),
          h('span', { className: 'ql-dialog-spacer' }),
          h('button', { className: 'ql-btn ql-btn-ghost', type: 'button', onClick: props.onCancel }, '取消'),
          h('button', { className: 'ql-btn ql-btn-primary', type: 'button', onClick: submit }, '保存')
        )
      )
    );
  }

  // ============================================================
  // 导入 / 导出对话框  ← 不走剪贴板权限
  // ============================================================
  //
  // 用 `<textarea>` 而不是 `ctx.clipboard`：那要新增 `clipboard` 权限，而这个
  // 插件一行权限都不该改动。文本框还能让用户看清楚自己要导入/导出的是什么。
  // **不用 `innerHTML`** —— 所有文本都作为 React 子节点渲染。

  function TransferDialog(props) {
    var textState = React.useState(props.initialText || '');
    var text = textState[0];
    var setText = textState[1];
    var modeState = React.useState('merge');
    var mode = modeState[0];
    var setMode = modeState[1];
    var areaRef = React.useRef(null);

    React.useEffect(
      function () {
        var node = areaRef.current;
        if (node && node.select) node.select();
      },
      []
    );

    var overlayStyle = props.box
      ? {
          top: props.box.top + 'px',
          left: props.box.left + 'px',
          width: props.box.width + 'px',
          height: props.box.height + 'px',
          right: 'auto',
          bottom: 'auto',
        }
      : undefined;

    var exporting = props.mode === 'export';

    return h(
      'div',
      {
        className: 'ql-overlay',
        style: overlayStyle,
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) props.onCancel();
        },
      },
      h(
        'div',
        {
          className: 'ql-dialog',
          role: 'dialog',
          'aria-label': exporting ? '导出配置' : '导入配置',
          onKeyDown: function (event) {
            if (event.key === 'Escape') {
              event.stopPropagation();
              props.onCancel();
            }
          },
        },
        h('h2', { className: 'ql-dialog-title' }, exporting ? '导出配置' : '导入配置'),
        h(
          'p',
          { className: 'ql-dialog-hint' },
          exporting
            ? '下面是本插件当前的条目与分组（JSON）。全选复制走，换台机器粘回来即可。图标缓存不在里面。'
            : '把之前导出的 JSON 粘进来。'
        ),
        h('textarea', {
          ref: areaRef,
          className: 'ql-input ql-textarea ql-input-mono',
          rows: 12,
          value: text,
          spellCheck: false,
          'aria-label': exporting ? '导出的 JSON' : '要导入的 JSON',
          onChange: function (e) {
            setText(e.target.value);
          },
        }),
        props.error ? h('div', { className: 'ql-error', role: 'alert' }, h('span', { className: 'ql-error-text' }, props.error)) : null,
        exporting
          ? null
          : h(
              'div',
              { className: 'ql-mode', role: 'radiogroup', 'aria-label': '导入方式' },
              h(
                'label',
                { className: 'ql-mode-option' },
                h('input', {
                  type: 'radio',
                  name: 'qlImportMode',
                  checked: mode === 'merge',
                  onChange: function () {
                    setMode('merge');
                  },
                }),
                h('span', null, '合并（保留现有条目，跳过重复的）')
              ),
              h(
                'label',
                { className: 'ql-mode-option' },
                h('input', {
                  type: 'radio',
                  name: 'qlImportMode',
                  checked: mode === 'replace',
                  onChange: function () {
                    setMode('replace');
                  },
                }),
                h('span', null, '替换（清掉现有条目，只留导入的）')
              )
            ),
        h(
          'div',
          { className: 'ql-dialog-actions' },
          h('span', { className: 'ql-dialog-spacer' }),
          h('button', { className: 'ql-btn ql-btn-ghost', type: 'button', onClick: props.onCancel }, '取消'),
          exporting
            ? null
            : h('button', { className: 'ql-btn ql-btn-primary', type: 'button', onClick: function () { props.onImport(text, mode); } }, '导入')
        )
      )
    );
  }

  // ============================================================
  // 单个条目卡片
  // ============================================================

  function ItemCard(props) {
    var item = props.item;
    var icon = props.icon;
    var failed = props.iconFailed;
    var classes = ['ql-card'];
    if (item.pinned) classes.push('ql-card-pinned');
    if (item.broken) classes.push('ql-card-broken');
    if (props.focused) classes.push('ql-card-focused');
    if (props.flashing) classes.push('ql-card-flash');

    var iconClasses = 'ql-card-icon ql-icon-' + props.iconSize + (icon ? '' : ' ql-card-icon-tile');
    var stats = [];
    stats.push('已启动 ' + (item.launchCount || 0) + ' 次');
    if (item.lastLaunchedAt) stats.push('最近 ' + absoluteTime(item.lastLaunchedAt));
    else stats.push('还没启动过');

    // 网格视图上只显示名称 —— 完整路径很占地方，而且用户认的是软件名。
    // 列表与紧凑视图多一行副标题（备注优先，没有备注时是网址或路径）。
    var sub = item.note ? item.note : item.kind === 'url' ? item.target : item.target;

    var title = stats.join(' · ');
    if (item.broken) title = (item.brokenReason ? '打不开：' + item.brokenReason + '\n' : '打不开\n') + title;
    if (item.kind !== 'url') title = item.target + '\n' + title;
    if (item.note) title = title + '\n备注：' + item.note;

    return h(
      'div',
      {
        // 键盘移动焦点时靠它找到 DOM 节点（见组件里的 focusOffset）。
        'data-item-id': item.id,
        className: classes.join(' '),
        tabIndex: 0,
        role: 'button',
        'aria-label':
          item.name +
          '，' +
          (item.kind === 'url' ? '网址' : '快捷方式') +
          '，' +
          (item.pinned ? '已固定，' : '') +
          stats.join('，') +
          (item.broken ? '，打不开' : ''),
        title: title,
        onFocus: function () {
          props.onFocus(item.id);
        },
        onClick: function () {
          // 单击启动是设置项，默认关闭 —— 点一下想选中却启动了是很容易发生的误触。
          if (props.launchOn !== 'single') return;
          props.onActivate(item);
        },
        onDoubleClick: function () {
          props.onActivate(item);
        },
        onContextMenu: function (event) {
          props.onMenu(event, item);
        },
        onMouseEnter: function (event) {
          var rect = event.currentTarget.getBoundingClientRect();
          props.onHover(item, rect);
        },
        onMouseLeave: function () {
          props.onHoverEnd();
        },
        onKeyDown: function (event) {
          props.onKeyDown(event, item);
        },
      },
      h(
        'div',
        { className: iconClasses },
        icon
          ? h('img', { src: icon, alt: '', draggable: false })
          : h('div', { className: 'ql-card-icon-fallback', 'aria-hidden': 'true' }, iconTile(item))
      ),
      h(
        'div',
        { className: 'ql-card-text' },
        h('span', { className: 'ql-card-name' }, item.name),
        props.view === 'grid' ? null : h('span', { className: 'ql-card-sub' }, sub)
      ),
      item.pinned ? h('span', { className: 'ql-card-pin', title: '已固定', 'aria-label': '已固定' }, '★') : null,
      item.broken
        ? h(
            'span',
            { className: 'ql-card-broken-mark', title: '上次没能打开，右键「编辑…」重新定位', 'aria-label': '打不开' },
            '!'
          )
        : null
    );
  }

  // ============================================================
  // 主界面
  // ============================================================

  function QuickLaunch() {
    var statePair = React.useState(null);
    var state = statePair[0];
    var setState = statePair[1];

    var iconsPair = React.useState({});
    var icons = iconsPair[0];
    var setIcons = iconsPair[1];

    var iconFailPair = React.useState({});
    var iconFailed = iconFailPair[0];
    var setIconFailed = iconFailPair[1];

    var errorPair = React.useState('');
    var error = errorPair[0];
    var setError = errorPair[1];

    var menuPair = React.useState(null);
    var menu = menuPair[0];
    var setMenu = menuPair[1];

    var dialogPair = React.useState(null);
    var dialog = dialogPair[0];
    var setDialog = dialogPair[1];

    var droppingPair = React.useState(false);
    var dropping = droppingPair[0];
    var setDropping = droppingPair[1];

    var hoverPair = React.useState(null);
    var hover = hoverPair[0];
    var setHover = hoverPair[1];

    var queryPair = React.useState('');
    var query = queryPair[0];
    var setQuery = queryPair[1];

    var focusPair = React.useState(null);
    var focusId = focusPair[0];
    var setFocusId = focusPair[1];

    // 「刚刚高亮一下」的那一条。它同时承担两件事：把键盘焦点挪过去（无障碍与
    // 连续方向键都要它），以及给卡片加一段短暂的高亮（拖入重复项、刚添加成功）。
    // 带上 `key` 是**必须**的：连续两次高亮同一个 id 时，`id` 没变而 React
    // 不会重跑 effect，高亮就只有第一次出现。
    var highlightPair = React.useState(null);
    var highlight = highlightPair[0];
    var setHighlight = highlightPair[1];

    // 模块可见区域的实测矩形，供对话框把自己限制在二级标题栏之下
    var overlayPair = React.useState(null);
    var overlayBox = overlayPair[0];
    var setOverlayBox = overlayPair[1];
    var rootRef = React.useRef(null);

    var searchRef = React.useRef(null);
    var flashTimerRef = React.useRef(null);
    var gridRef = React.useRef(null);

    // 最新状态放进 ref，供拖放订阅者读取 —— 否则每次状态变化都要重建订阅
    var stateRef = React.useRef(null);
    React.useEffect(
      function () {
        stateRef.current = state;
      },
      [state]
    );

    // ---- 载入 ----
    React.useEffect(function () {
      var alive = true;
      Promise.all([ctx.storage.get(STATE_KEY, null), loadSettings()]).then(
        function (results) {
          if (!alive) return;
          var normalized = normalizeState(results[0]);
          // 权威设置（清单声明的那一份）覆盖掉存储里的旧值。
          normalized.settings = resolveSettings(normalized.settings, null);
          setState(normalized);
        },
        function (e) {
          if (!alive) return;
          setError('读取已保存的内容失败：' + ((e && e.message) || e));
          setState(emptyState());
        }
      );
      return function () {
        alive = false;
      };
    }, []);

    function persist(next) {
      setState(next);
      ctx.storage.set(STATE_KEY, next).catch(function (e) {
        setError('保存失败：' + ((e && e.message) || e));
      });
    }

    /** 只改一个设置项。写权威值是异步的，因此**写完必须重读**，不能以写代读。 */
    function patchSetting(id, value) {
      var next = Object.assign({}, state.settings);
      next[id] = value;
      persist(Object.assign({}, state, { settings: next }));

      if (!ctx.settings || !ctx.settings.set) return;
      Promise.resolve()
        .then(function () {
          return ctx.settings.set(id, value);
        })
        .then(function () {
          return loadSettings();
        })
        .then(function (authoritative) {
          var current = stateRef.current;
          if (!current) return;
          setState(
            Object.assign({}, current, {
              settings: resolveSettings(current.settings, authoritative),
            })
          );
        })
        .catch(function (e) {
          setError('保存设置失败：' + ((e && e.message) || e) + '（这次改动只在本次会话里生效）');
        });
    }

    // ---- 图标懒加载 ----
    React.useEffect(
      function () {
        if (!state) return;
        state.items.forEach(function (item) {
          if (icons[item.id] !== undefined || iconPending[item.id]) return;
          if (iconCache[item.id] !== undefined) {
            var cached = iconCache[item.id];
            setIcons(function (prev) {
              var next = Object.assign({}, prev);
              next[item.id] = cached;
              return next;
            });
            return;
          }
          iconPending[item.id] = true;
          resolveIcon(item).then(function (result) {
            iconPending[item.id] = false;
            iconCache[item.id] = result.url;
            setIcons(function (prev) {
              var next = Object.assign({}, prev);
              next[item.id] = result.url;
              return next;
            });
            setIconFailed(function (prev) {
              var next = Object.assign({}, prev);
              next[item.id] = result.failed === true;
              return next;
            });
          });
        });
      },
      [state, icons]
    );

    // ---- 拖放添加 ----
    // 只有在模块真正可见时才订阅：拖放事件是**窗口级**的，
    // 若在后台也保持订阅，就会抢走本该属于其它模块的拖入。
    var active = Modulith.useModuleActive();
    React.useEffect(
      function () {
        if (!active) return undefined;

        // 模块重新可见时重读一次权威设置 —— 沙箱里没有 `settings.subscribe`，
        // 这是"用户刚在设置页改过"唯一能被发现的时机（照 clipboard-history 的做法）。
        loadSettings().then(function (authoritative) {
          var current = stateRef.current;
          if (!current) return;
          setState(
            Object.assign({}, current, {
              settings: resolveSettings(current.settings, authoritative),
            })
          );
        });

        return ctx.fileDrop.subscribe(function (event) {
          if (event.type === 'enter' || event.type === 'over') {
            setDropping(true);
            return;
          }
          if (event.type === 'leave') {
            setDropping(false);
            return;
          }
          if (event.type !== 'drop') return;
          setDropping(false);
          handleDrop(event.paths || []);
        });
      },
      [active]
    );

    /**
     * 处理一次拖入。
     *
     * 与旧版的三点不同（都是真实反馈里最常撞上的）：
     *   1. **目录也收**：它是"打开某个文件夹"最自然的表达，而 `open` 支持它。
     *   2. **去掉 `.lnk` / `.url` 扩展名**：`Brave.lnk` 显示成 `Brave`。
     *   3. **同一个目标不静默加第二条**：提示"这个已经有了"并把已有那条高亮出来。
     *      旧行为是再加一条，用起来像是拖入没生效又被加了一遍。
     */
    function handleDrop(paths) {
      var current = stateRef.current;
      if (!current) return;

      var candidates = (paths || []).filter(function (path) {
        return !!trimmed(path);
      });
      if (candidates.length === 0) {
        setError('这次拖入没有带上任何可用的路径。');
        return;
      }

      var groupId = current.filter !== 'all' && current.filter !== 'none' ? current.filter : null;
      var added = [];
      var duplicates = [];
      var items = current.items.slice();

      candidates.forEach(function (path) {
        var target = trimmed(path);
        var existing = findByTarget(items, target);
        if (existing) {
          duplicates.push(existing.id);
          return;
        }
        // `.lnk` / `.url` 靠扩展名判断；没有扩展名的一律按目录处理（`open` 能开）。
        var base = basename(target);
        var name = stripExtension(base) || base;
        var kind = extensionOf(target) === '.url' ? 'url' : 'app';
        var item = normalizeItem(
          {
            id: newId('sc-'),
            kind: kind,
            name: name,
            target: target,
            args: [],
            groupId: groupId,
            note: '',
            addedAt: Date.now(),
          },
          null
        );
        items.push(item);
        added.push(item.id);
      });

      if (added.length === 0) {
        // 只重复了，什么也没加。**不静默**：把已有的那一条高亮出来，
        // 用户立刻知道"它已经在列表里了，只是我没找到"。
        setError(duplicates.length === 1 ? '这个已经有了，已经帮你高亮出来。' : '这几项都已经在列表里了。');
        highlightItem(duplicates[0]);
        return;
      }

      persist(Object.assign({}, current, { items: items, filter: groupId || current.filter }));
      setError(duplicates.length > 0 ? '有 ' + duplicates.length + ' 项已经在列表里了，已跳过。' : '');
      highlightItem(added[0]);
    }

    /** 高亮并聚焦某一条：拖入重复项、刚添加成功时用。 */
    function highlightItem(id) {
      setFocusId(id);
      setHighlight({ id: id, nonce: Date.now() + Math.random() });
    }

    React.useEffect(function () {
      return function () {
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      };
    }, []);

    // ---- 对话框的覆盖范围 ----
    // 只在对话框 / 菜单 / 提示打开时测量：平时不需要，也就不必让窗口尺寸变化
    // 触发重渲染。用 useLayoutEffect —— 要在浏览器绘制之前把矩形算好，
    // 否则它会先在错误的位置闪一帧再跳回正确位置。
    React.useLayoutEffect(
      function () {
        if (!dialog && !menu && !hover) return undefined;

        var viewport = findScrollAncestor(rootRef.current);
        if (!viewport) {
          // 找不到滚动祖先（例如模块被内嵌到别处）：退回 inset:0。
          setOverlayBox(null);
          return undefined;
        }

        function measure() {
          var rect = viewport.getBoundingClientRect();
          setOverlayBox(function (prev) {
            // 值没变就返回原对象，让 React 跳过这次更新。
            // 过渡期间 ResizeObserver 会连续回调，没有这道判断就会白白重渲染。
            if (
              prev &&
              prev.top === rect.top &&
              prev.left === rect.left &&
              prev.width === rect.width &&
              prev.height === rect.height
            ) {
              return prev;
            }
            return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
          });
        }

        measure();

        // **必须观察元素本身，不能只监听窗口 resize。**
        // 折叠侧边栏改的是 main 的 margin-left（256px → 0），窗口尺寸一点没变，
        // 所以 resize 不会触发，弹窗就会停在折叠前的位置上。
        var observer = null;
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(measure);
          observer.observe(viewport);
        }
        window.addEventListener('resize', measure);
        return function () {
          window.removeEventListener('resize', measure);
          if (observer) observer.disconnect();
        };
      },
      [dialog, menu, hover]
    );

    // ---- 高亮：短暂地把某一条显示出来 ----
    //
    // 用在两处：拖入的目标已经存在（告诉用户"它在这儿"），以及刚添加成功。
    // 高亮是**短暂的**，定时器到点就清掉，因此它不会变成常驻的视觉噪音。
    //
    // `highlight.nonce` 参与依赖是刻意的：连续两次高亮同一个 id 时 `id` 没变，
    // 靠 `nonce` 才能让 effect 重跑，高亮因此每次都能看见。
    React.useEffect(
      function () {
        if (!highlight) return undefined;
        var root = gridRef.current;
        if (root) {
          var node = root.querySelector('[data-item-id="' + highlight.id + '"]');
          if (node) {
            if (node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
            if (node.focus) node.focus();
          }
        }
        var timer = setTimeout(function () {
          setHighlight(null);
        }, FLASH_TIMEOUT_MS);
        return function () {
          clearTimeout(timer);
        };
      },
      [highlight]
    );

    // ---- 全局按键：`/` 聚焦搜索、`Esc` 清空 ----
    React.useEffect(
      function () {
        if (!active) return undefined;
        function onKeyDown(event) {
          var target = event.target;
          var inField =
            target &&
            (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
          if (event.key === '/' && !inField && !dialog && !menu) {
            if (!searchRef.current) return;
            event.preventDefault();
            searchRef.current.focus();
            return;
          }
          if (event.key === 'Escape' && !dialog && !menu) {
            if (query) {
              setQuery('');
              setError('');
            }
          }
        }
        document.addEventListener('keydown', onKeyDown);
        return function () {
          document.removeEventListener('keydown', onKeyDown);
        };
      },
      [active, dialog, menu, query]
    );

    if (!state) {
      return h('div', { className: 'ql-root' }, h('div', { className: 'ql-empty' }, '读取中…'));
    }

    // ---- 派生数据 ----
    var items = state.items;
    var groups = state.groups;
    var view = state.settings.view || 'grid';
    var settings = resolveSettings(state.settings, null);
    var sectionsInfo = buildSections(
      Object.assign({}, state, { settings: Object.assign({}, state.settings, { sortBy: settings.sortBy }) }),
      query
    );
    var sections = sectionsInfo.sections;
    var visibleIds = [];
    sections.forEach(function (section) {
      section.items.forEach(function (item) {
        visibleIds.push(item.id);
      });
    });
    var searching = !!trimmed(query);

    function countFor(id) {
      if (id === 'all') return items.length;
      if (id === 'none')
        return items.filter(function (i) {
          return !i.groupId;
        }).length;
      return items.filter(function (i) {
        return i.groupId === id;
      }).length;
    }

    // ---- 操作 ----
    function patchState(part) {
      persist(Object.assign({}, state, part));
    }

    /**
     * 启动一个条目。
     *
     * 三条路径全部由 `resolveLaunch()` 决定（见那个函数）。启动成功时清掉
     * 「打不开」标记并累计统计；失败时**不只是弹一句错误** —— 把标记落到条目上，
     * 用户下次回来还能看到是哪一条坏了（程序卸载、快捷方式被删是长期使用里
     * 最常见的一类问题）。
     */
    function launch(item) {
      setError('');
      var resolved = resolveLaunch(item);
      if (resolved.error) {
        markBroken(item, resolved.error);
        setError(resolved.error);
        return;
      }
      var runner =
        resolved.method === 'open' ? ctx.launcher.open(resolved.target) : ctx.launcher.launch(resolved.target, resolved.args);
      Promise.resolve(runner).then(
        function () {
          bumpStats(item);
        },
        function (e) {
          var message = String((e && e.message) || e);
          markBroken(item, message);
          setError('启动失败：' + message);
        }
      );
    }

    function markBroken(item, reason) {
      var current = stateRef.current;
      if (!current) return;
      persist(
        Object.assign({}, current, {
          items: current.items.map(function (i) {
            return i.id === item.id ? Object.assign({}, i, { broken: true, brokenReason: reason }) : i;
          }),
        })
      );
    }

    function bumpStats(item) {
      var current = stateRef.current;
      if (!current) return;
      persist(
        Object.assign({}, current, {
          items: current.items.map(function (i) {
            if (i.id !== item.id) {
              return i.broken ? Object.assign({}, i, { broken: false, brokenReason: '' }) : i;
            }
            return Object.assign({}, i, {
              launchCount: (Number(i.launchCount) || 0) + 1,
              lastLaunchedAt: Date.now(),
              broken: false,
              brokenReason: '',
            });
          }),
        })
      );
    }

    function reveal(item) {
      if (isAddressItem(item)) {
        setError('网址没有所在文件夹，右键菜单里也没有这一项。');
        return;
      }
      setError('');
      ctx.shell.revealInFolder(item.target).catch(function (e) {
        setError('无法打开所在文件夹：' + ((e && e.message) || e));
      });
    }

    function remove(item) {
      invalidateIcon(item.id);
      patchState({
        items: items.filter(function (i) {
          return i.id !== item.id;
        }),
      });
    }

    function removeGroup(group) {
      patchState({
        groups: groups.filter(function (g) {
          return g.id !== group.id;
        }),
        items: items.map(function (i) {
          return i.groupId === group.id ? Object.assign({}, i, { groupId: null }) : i;
        }),
        filter: state.filter === group.id ? 'all' : state.filter,
      });
    }

    function copyPath(item) {
      // 用浏览器的剪贴板 API，而不是宿主的剪贴板权限：这里不需要读剪贴板，
      // 只写一段用户自己填过的路径，风险与复杂度都更低。
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(item.target).catch(function () {
          setError('复制失败，浏览器拒绝了剪贴板访问');
        });
      } else {
        setError('当前环境不支持剪贴板');
      }
    }

    function togglePin(item) {
      var current = stateRef.current;
      if (!current) return;
      persist({
        items: current.items.map(function (i) {
          return i.id === item.id ? Object.assign({}, i, { pinned: !i.pinned }) : i;
        }),
      });
    }

    function refreshIcon(item) {
      invalidateIcon(item.id).then(function () {
        setIcons(function (prev) {
          var next = Object.assign({}, prev);
          delete next[item.id];
          return next;
        });
      });
    }

    function toggleGroup(group) {
      var collapsed = Object.assign({}, state.collapsed);
      if (collapsed[group.key]) delete collapsed[group.key];
      else collapsed[group.key] = true;
      patchState({ collapsed: collapsed });
    }

    function openNewDialog(kind) {
      setDialog({
        mode: 'new',
        draft: {
          id: newId('sc-'),
          kind: kind === 'url' ? 'url' : 'app',
          name: '',
          target: '',
          argsText: '',
          groupId: state.filter !== 'all' && state.filter !== 'none' ? state.filter : null,
          note: '',
          autoFixed: false,
          error: '',
        },
      });
    }

    function openEditDialog(item) {
      setDialog({
        mode: 'edit',
        itemId: item.id,
        draft: {
          id: item.id,
          kind: item.kind === 'url' ? 'url' : 'app',
          name: item.name,
          target: item.target,
          argsText: (item.args || []).join(' '),
          groupId: item.groupId,
          note: item.note || '',
          autoFixed: false,
          error: '',
        },
      });
    }

    function openNewGroupDialog() {
      setDialog({ mode: 'group', draft: { id: newId('g-'), name: '', error: '' } });
    }

    function submitDialog(draft) {
      if (draft.kind === 'group') {
        var groupName = trimmed(draft.name);
        if (!groupName) return;
        patchState({ groups: groups.concat([{ id: draft.id, name: groupName }]) });
        setDialog(null);
        return;
      }

      var kind = draft.kind === 'url' ? 'url' : 'app';
      var target = trimmed(draft.target);
      var name = trimmed(draft.name);
      if (!name) name = kind === 'url' ? urlLabel(target) : stripExtension(basename(target));

      // 去重：同一个目标不该有第二条。编辑时跳过自己。
      var duplicate = findByTarget(items, target);
      if (duplicate && duplicate.id !== draft.id) {
        setDialog(
          Object.assign({}, dialog, {
            draft: Object.assign({}, draft, { error: '「' + duplicate.name + '」已经是这个目标了（同一个路径或网址不能加两次）。' }),
          })
        );
        return;
      }

      var patch = {
        kind: kind,
        name: name,
        target: target,
        args: kind === 'url' ? [] : parseArgs(draft.argsText),
        groupId: draft.groupId || null,
        note: trimmed(draft.note),
        // 改了目标就把「打不开」标记清掉：那条标记说的是上一个目标
        broken: false,
        brokenReason: '',
      };

      if (dialog.mode === 'new') {
        patchState({
          items: items.concat([Object.assign({ id: draft.id, addedAt: Date.now() }, normalizeItem(patch, null))]),
        });
      } else {
        // 路径可能变了，图标缓存必须作废
        var previous = findById(items, dialog.itemId);
        if (previous && targetKey(previous.target) !== targetKey(patch.target)) {
          refreshIcon({ id: dialog.itemId });
        }
        patchState({
          items: items.map(function (i) {
            return i.id === dialog.itemId ? Object.assign({}, i, patch) : i;
          }),
        });
      }
      setDialog(null);
    }

    function renameGroup(group) {
      setDialog({ mode: 'group', groupId: group.id, draft: { id: group.id, name: group.name, error: '' } });
    }

    // ---- 导出 / 导入 ----
    function exportConfig() {
      var payload = {
        kind: 'modulith.quick-launch.export',
        version: STATE_VERSION,
        exportedAt: new Date().toISOString(),
        items: items,
        groups: groups,
      };
      var text;
      try {
        text = JSON.stringify(payload, null, 2);
      } catch (e) {
        setError('导出失败：' + ((e && e.message) || e));
        return;
      }
      setDialog({ mode: 'transfer', transferMode: 'export', text: text, error: '' });
    }

    function parseImport(text) {
      var parsed;
      try {
        parsed = JSON.parse(String(text || ''));
      } catch (e) {
        return { error: '这段文本不是合法的 JSON：' + ((e && e.message) || e) };
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'JSON 的最外层必须是一个对象（导出时就是这个形状）。' };
      }
      if (!Array.isArray(parsed.items)) {
        return { error: '这段 JSON 里没有 items 数组，看起来不是本插件导出的配置。' };
      }
      return { state: normalizeState(parsed) };
    }

    function applyImport(text, mode) {
      var parsed = parseImport(text);
      if (parsed.error) {
        setDialog({ mode: 'transfer', transferMode: 'import', text: text, error: parsed.error });
        return;
      }
      var incoming = parsed.state;
      if (incoming.items.length === 0) {
        setDialog({ mode: 'transfer', transferMode: 'import', text: text, error: '这段配置里一条条目都没有，导入它只会清空现有内容。' });
        return;
      }

      if (mode === 'replace') {
        // 替换会丢掉现有条目，因此走两步确认（见 transfer-replace 分支）。
        setDialog({ mode: 'transfer', transferMode: 'replace', text: text, error: '', pending: incoming });
        return;
      }

      var existingGroups = groups.slice();
      var knownGroupNames = {};
      existingGroups.forEach(function (g) {
        knownGroupNames[g.name.toLowerCase()] = g.id;
      });

      // 条目按目标去重；分组按名字复用（或者新建）。
      var idMap = {};
      var addedItems = [];
      incoming.items.forEach(function (item) {
        if (findByTarget(items.concat(addedItems), item.target)) return;
        var groupId = null;
        if (item.groupId) {
          var sourceGroup = findById(incoming.groups, item.groupId);
          var label = sourceGroup ? sourceGroup.name : '';
          if (label) {
            var key = label.toLowerCase();
            if (knownGroupNames[key]) {
              groupId = knownGroupNames[key];
            } else {
              var fresh = { id: newId('g-'), name: label };
              knownGroupNames[key] = fresh.id;
              existingGroups.push(fresh);
              groupId = fresh.id;
            }
          }
        }
        idMap[item.id] = newId('sc-');
        addedItems.push(
          normalizeItem(
            Object.assign({}, item, { id: idMap[item.id], groupId: groupId, addedAt: Date.now() }),
            null
          )
        );
      });

      var skipped = incoming.items.length - addedItems.length;
      patchState({ items: items.concat(addedItems), groups: existingGroups });
      setDialog(null);
      setError(skipped > 0 ? '已导入 ' + addedItems.length + ' 条，跳过 ' + skipped + ' 条重复的。' : '已导入 ' + addedItems.length + ' 条。');
    }

    function applyReplace(incoming) {
      patchState({ items: incoming.items, groups: incoming.groups, filter: 'all' });
      setDialog(null);
      setError('');
    }

    // ---- 菜单 ----
    function itemMenu(event, item) {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, item: item });
    }

    function backgroundMenu(event) {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, item: null });
    }

    function groupMenu(event, group) {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, group: group });
    }

    function viewMenu(event) {
      event.preventDefault();
      event.stopPropagation();
      var rect = event.currentTarget.getBoundingClientRect();
      setMenu({ x: rect.right - 190, y: rect.bottom + 4, settings: true });
    }

    function moveToGroup(item, groupId) {
      patchState({
        items: items.map(function (i) {
          return i.id === item.id ? Object.assign({}, i, { groupId: groupId }) : i;
        }),
      });
    }

    // ---- 键盘：卡片之间移动 ----
    //
    // 方向键要真的**移动 DOM 焦点**，否则按键事件会一直在原来那张卡片上打转，
    // 「连续按方向键」就只能在两条之间来回跳。做法是同时做两件事：更新
    // `focusId`（界面上的选中态）与在渲染之后把焦点给目标节点。
    //
    // 为什么不用一条 `useEffect([focusId])` 去同步焦点：那种写法会把焦点也
    // 搬到**用户手动点过的位置**以及每次状态更新之后，而"什么时候该动焦点"
    // 只有这里知道。
    function focusOffset(step) {
      if (visibleIds.length === 0) return;
      var index = visibleIds.indexOf(focusId);
      if (index === -1) index = step > 0 ? -1 : visibleIds.length;
      var next = Math.max(0, Math.min(visibleIds.length - 1, index + step));
      var id = visibleIds[next];
      setFocusId(id);
      // 渲染之后才把焦点交过去。`setTimeout(…, 0)` 排在 React 的这次提交之后。
      setTimeout(function () {
        var root = gridRef.current;
        if (!root) return;
        var node = root.querySelector('[data-item-id="' + id + '"]');
        if (node && node.focus) node.focus();
      }, 0);
    }

    function onCardKeyDown(event, item) {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        focusOffset(1);
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        focusOffset(-1);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        launch(item);
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        remove(item);
      }
    }

    function onSearchKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setQuery('');
        setError('');
        return;
      }
      // 搜索框里按 Enter 启动**第一条匹配**：这是"打开我常搜的那个东西"最快的路
      if (event.key === 'Enter') {
        event.preventDefault();
        var first = sections.length > 0 ? sections[0].items[0] : null;
        if (first) launch(first);
        else setError('没有匹配「' + query + '」的条目。');
      }
    }

    // ---- 菜单渲染 ----
    var menuNode = null;
    if (menu) {
      var entries;
      if (menu.settings) {
        entries = [{ heading: true, label: '视图' }];
        VIEWS.forEach(function (v) {
          entries.push({
            label: v.label,
            checked: view === v.id,
            onClick: function () {
              patchSetting('view', v.id);
            },
          });
        });
        entries.push({ separator: true });
        entries.push({ heading: true, label: '排序' });
        SORTS.forEach(function (s) {
          entries.push({
            label: s.label,
            checked: settings.sortBy === s.id,
            onClick: function () {
              patchSetting('sortBy', s.id);
            },
          });
        });
        entries.push({ separator: true });
        entries.push({ heading: true, label: '图标大小' });
        ICON_SIZES.forEach(function (s) {
          entries.push({
            label: s.label,
            checked: settings.iconSize === s.id,
            onClick: function () {
              patchSetting('iconSize', s.id);
            },
          });
        });
        entries.push({ separator: true });
        entries.push({ heading: true, label: '密度' });
        DENSITIES.forEach(function (s) {
          entries.push({
            label: s.label,
            checked: settings.density === s.id,
            onClick: function () {
              patchSetting('density', s.id);
            },
          });
        });
        entries.push({ separator: true });
        entries.push({
          label: '显示名称',
          checked: settings.showLabels === true,
          onClick: function () {
            patchSetting('showLabels', settings.showLabels !== true);
          },
        });
        entries.push({
          label: '单击启动',
          checked: settings.launchOn === 'single',
          onClick: function () {
            patchSetting('launchOn', settings.launchOn === 'single' ? 'double' : 'single');
          },
        });
      } else if (menu.group) {
        entries = [
          { heading: true, label: menu.group.name },
          { label: '重命名分组…', onClick: function () { renameGroup(menu.group); } },
          { label: '只看这个分组', onClick: function () { patchState({ filter: menu.group.id }); } },
          { separator: true },
        ];
        var groupDelete = h(ConfirmButton, {
          className: 'ql-menu-item ql-menu-item-danger',
          label: '删除分组',
          confirmLabel: countFor(menu.group.id) > 0 ? '确认删除？条目会移到「未分组」' : '确认删除？',
          onConfirm: function () {
            removeGroup(menu.group);
            // **`node` 型菜单项必须自己关菜单。** 普通项走的是 `ContextMenu` 里
            // 「先 `props.onClose()` 再执行」那条路（见那里的 `onClick`），而
            // `node` 走的是插槽分支，**没有任何人替它关** —— 不写这一行的表现是
            // "分组删掉了，菜单还悬在那里"，而它还挂着一个已经不存在分组的引用。
            setMenu(null);
          },
        });
        entries.push({ node: groupDelete });
      } else if (menu.item) {
        entries = [
          { label: openVerb(menu.item), onClick: function () { launch(menu.item); } },
          { label: menu.item.pinned ? '取消固定' : '固定到最前', onClick: function () { togglePin(menu.item); } },
          { label: '编辑…', onClick: function () { openEditDialog(menu.item); } },
          { label: '重新提取图标', onClick: function () { refreshIcon(menu.item); } },
        ];
        // 网址没有所在文件夹 —— 这一项对它毫无意义（`revealInFolder` 会拿到
        // 一个 https:// 开头的"路径"然后失败）。旧版对网址也会显示它。
        if (!isAddressItem(menu.item)) {
          entries.push({ label: '打开所在文件夹', onClick: function () { reveal(menu.item); } });
        }
        entries.push({ label: isAddressItem(menu.item) ? '复制网址' : '复制路径', onClick: function () { copyPath(menu.item); } });
        entries.push({ separator: true });
        entries.push({ heading: true, label: '移入分组' });
        entries.push({
          label: '未分组',
          checked: !menu.item.groupId,
          onClick: function () {
            moveToGroup(menu.item, null);
          },
        });
        groups.forEach(function (g) {
          entries.push({
            label: g.name,
            checked: menu.item.groupId === g.id,
            onClick: function () {
              moveToGroup(menu.item, g.id);
            },
          });
        });
        if (groups.length === 0) {
          entries.push({ label: '（还没有分组）', onClick: function () {} });
        }
        entries.push({ separator: true });
        entries.push({
          node: h(ConfirmButton, {
            className: 'ql-menu-item ql-menu-item-danger',
            label: '删除',
            onConfirm: function () {
              remove(menu.item);
              // 与分组那一条同一个理由：`node` 型菜单项没有人替它关菜单。
              // 不关的后果不只是难看 —— 菜单上其余动作（打开、编辑、移入分组）
              // 都还绑在这个**已经被删掉**的条目上。
              setMenu(null);
            },
          }),
        });
      } else {
        entries = [
          { label: '添加程序 / 文件…', onClick: function () { openNewDialog('app'); } },
          { label: '添加网址…', onClick: function () { openNewDialog('url'); } },
          { label: '新建分组…', onClick: openNewGroupDialog },
          { separator: true },
          { label: '导出配置…', onClick: exportConfig },
          { label: '导入配置…', onClick: function () { setDialog({ mode: 'transfer', transferMode: 'import', text: '', error: '' }); } },
          { separator: true },
          { heading: true, label: '视图' },
        ];
        VIEWS.forEach(function (v) {
          entries.push({
            label: v.label,
            checked: view === v.id,
            onClick: function () {
              patchSetting('view', v.id);
            },
          });
        });
      }

      menuNode = h(ContextMenu, {
        x: menu.x,
        y: menu.y,
        box: overlayBox,
        items: entries,
        onClose: function () {
          setMenu(null);
        },
      });
    }

    // ---- 工具栏 ----
    var toolbar = h(
      'div',
      { className: 'ql-toolbar' },
      h(
        'div',
        { className: 'ql-search' },
        h('span', { className: 'ql-search-icon', 'aria-hidden': 'true' }, '⌕'),
        h('input', {
          ref: searchRef,
          className: 'ql-search-input',
          type: 'search',
          value: query,
          placeholder: '搜索名称、备注、路径或网址（按 / 聚焦）',
          'aria-label': '搜索条目',
          onChange: function (e) {
            setQuery(e.target.value);
          },
          onKeyDown: onSearchKeyDown,
        }),
        query
          ? h(
              'button',
              {
                className: 'ql-search-clear',
                type: 'button',
                'aria-label': '清空搜索',
                onClick: function () {
                  setQuery('');
                  if (searchRef.current) searchRef.current.focus();
                },
              },
              '×'
            )
          : null
      ),
      h(
        'div',
        { className: 'ql-segmented', role: 'group', 'aria-label': '视图' },
        VIEWS.map(function (v) {
          return h(
            'button',
            {
              key: v.id,
              type: 'button',
              className: 'ql-seg' + (view === v.id ? ' ql-seg-active' : ''),
              'aria-pressed': view === v.id,
              title: v.label + '视图',
              onClick: function () {
                patchSetting('view', v.id);
              },
            },
            v.label
          );
        })
      ),
      h(
        'button',
        {
          className: 'ql-btn ql-btn-ghost',
          type: 'button',
          onClick: viewMenu,
          'aria-haspopup': 'true',
          'aria-label': '外观与排序设置',
          title: '外观与排序',
        },
        '外观'
      ),
      h(
        'div',
        { className: 'ql-actions' },
        h(
          'button',
          {
            className: 'ql-btn ql-btn-primary',
            type: 'button',
            onClick: function (event) {
              event.preventDefault();
              event.stopPropagation();
              var rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right - 190, y: rect.bottom + 4, add: true });
            },
            'aria-haspopup': 'true',
            'aria-label': '添加条目或分组',
          },
          '添加 ▾'
        )
      )
    );

    var chips = [{ id: 'all', name: '全部' }, { id: 'none', name: '未分组' }].concat(groups);

    var groupBar = h(
      'div',
      { className: 'ql-groups' },
      chips.map(function (chip) {
        var isGroup = chip.id !== 'all' && chip.id !== 'none';
        var group = isGroup ? findById(groups, chip.id) : null;
        return h(
          'button',
          {
            key: chip.id,
            type: 'button',
            className: 'ql-chip' + (state.filter === chip.id ? ' ql-chip-active' : ''),
            'aria-pressed': state.filter === chip.id,
            onClick: function () {
              patchState({ filter: chip.id });
            },
            onContextMenu: group
              ? function (event) {
                  groupMenu(event, group);
                }
              : undefined,
          },
          h('span', null, chip.name),
          h('span', { className: 'ql-chip-count' }, String(countFor(chip.id)))
        );
      }),
      h(
        'button',
        { className: 'ql-chip ql-chip-add', type: 'button', onClick: openNewGroupDialog },
        '+ 分组'
      )
    );

    var banner = error
      ? h(
          'div',
          { className: 'ql-error', role: 'alert' },
          h('span', { className: 'ql-error-text' }, error),
          h(
            'button',
            {
              className: 'ql-error-close',
              type: 'button',
              onClick: function () {
                setError('');
              },
              'aria-label': '关闭提示',
              title: '关闭',
            },
            '×'
          )
        )
      : null;

    // ---- 主体 ----
    var body;
    if (items.length === 0) {
      body = h(
        'div',
        { className: 'ql-empty ql-empty-rich' },
        h('div', { className: 'ql-empty-icon', 'aria-hidden': 'true' }, '⌘'),
        h('div', { className: 'ql-empty-title' }, '还没有任何条目'),
        h(
          'ul',
          { className: 'ql-empty-list' },
          h('li', null, '把程序、快捷方式（.lnk）、文件夹或文档**直接拖进这个窗口**。'),
          h('li', null, '或者点右上角「添加 ▾」→「添加程序 / 文件」手动填写路径。'),
          h('li', null, '常用网址用「添加网址」—— 只写 example.com 会自动补成 https://example.com。'),
          h('li', null, '条目多了之后可以用「+ 分组」归类，也可以把常用的固定到最前。')
        ),
        h(
          'div',
          { className: 'ql-empty-actions' },
          h('button', { className: 'ql-btn ql-btn-primary', type: 'button', onClick: function () { openNewDialog('app'); } }, '添加程序 / 文件'),
          h('button', { className: 'ql-btn ql-btn-ghost', type: 'button', onClick: function () { openNewDialog('url'); } }, '添加网址')
        )
      );
    } else if (sections.length === 0) {
      body = h(
        'div',
        { className: 'ql-empty' },
        searching
          ? '没有匹配「' + query + '」的条目。'
          : state.filter === 'all'
            ? '列表是空的。'
            : '这个分组下还没有条目 —— 右键条目 →「移入分组」可以把它放进来。'
      );
    } else {
      body = h(
        'div',
        { className: 'ql-sections ql-view-' + view + ' ql-density-' + settings.density + (settings.showLabels ? '' : ' ql-nolabels'), ref: gridRef },
        sections.map(function (section) {
          var collapsed = state.collapsed[section.key] === true && !searching;
          return h(
            'section',
            { className: 'ql-section', key: section.key },
            h(
              'div',
              { className: 'ql-section-head' },
              h(
                'button',
                {
                  className: 'ql-section-toggle',
                  type: 'button',
                  'aria-expanded': collapsed ? 'false' : 'true',
                  onClick: function () {
                    toggleGroup(section);
                  },
                },
                h('span', { className: 'ql-section-chevron', 'aria-hidden': 'true' }, collapsed ? '▸' : '▾'),
                h('span', { className: 'ql-section-name' }, section.name),
                h('span', { className: 'ql-section-count' }, String(section.items.length))
              ),
              section.id
                ? h(
                    'button',
                    {
                      className: 'ql-section-menu',
                      type: 'button',
                      'aria-label': section.name + '的分组操作',
                      onClick: function (event) {
                        groupMenu(event, findById(groups, section.id) || { id: section.id, name: section.name });
                      },
                    },
                    '⋯'
                  )
                : null
            ),
            collapsed
              ? null
              : h(
                  'div',
                  { className: 'ql-grid' },
                  section.items.map(function (item) {
                    return h(ItemCard, {
                      key: item.id,
                      item: item,
                      icon: icons[item.id],
                      iconFailed: iconFailed[item.id] === true,
                      iconSize: settings.iconSize,
                      launchOn: settings.launchOn,
                      focused: focusId === item.id,
                      flashing: !!highlight && highlight.id === item.id,
                      view: view,
                      onActivate: launch,
                      onMenu: itemMenu,
                      onFocus: function (id) {
                        setFocusId(id);
                      },
                      onHover: function (target, rect) {
                        // 悬浮只补两条，不污染主视觉：备注（没有就是网址/路径）
                        // 与使用统计。
                        var text = target.note || (target.kind === 'url' ? target.target : target.target);
                        setHover({
                          text: text,
                          stats:
                            '已启动 ' +
                            (target.launchCount || 0) +
                            ' 次' +
                            (target.lastLaunchedAt
                              ? ' · 最近 ' + relativeTime(target.lastLaunchedAt) + '（' + absoluteTime(target.lastLaunchedAt) + '）'
                              : ''),
                          x: rect.left + rect.width / 2,
                          y: rect.top,
                          bottom: rect.bottom,
                        });
                      },
                      onHoverEnd: function () {
                        setHover(null);
                      },
                      onKeyDown: onCardKeyDown,
                    });
                  })
                )
          );
        })
      );
    }

    var dialogNode = null;
    if (dialog && dialog.mode === 'group') {
      dialogNode = h(GroupDialog, {
        draft: dialog.draft,
        box: overlayBox,
        onCancel: function () {
          setDialog(null);
        },
        onSubmit: submitDialog,
      });
    } else if (dialog && dialog.mode === 'transfer' && dialog.transferMode === 'replace') {
      dialogNode = h(ReplaceDialog, {
        count: dialog.pending ? dialog.pending.items.length : 0,
        box: overlayBox,
        onCancel: function () {
          setDialog(null);
        },
        onConfirm: function () {
          applyReplace(dialog.pending);
        },
      });
    } else if (dialog && dialog.mode === 'transfer') {
      dialogNode = h(TransferDialog, {
        mode: dialog.transferMode,
        initialText: dialog.text,
        error: dialog.error,
        box: overlayBox,
        onCancel: function () {
          setDialog(null);
        },
        onImport: applyImport,
      });
    } else if (dialog) {
      dialogNode = h(EditDialog, {
        mode: dialog.mode,
        draft: dialog.draft,
        groups: groups,
        error: error,
        box: overlayBox,
        onCancel: function () {
          setDialog(null);
        },
        onSubmit: submitDialog,
        onRefreshIcon: function () {
          refreshIcon({ id: dialog.draft.id });
        },
      });
    }

    var hoverNode = null;
    if (hover && hover.text) {
      // 提示语默认在卡片上方。卡片贴着内容区顶部时改为放在下方 ——
      // 否则它同样会压到二级标题栏上（同一个根因）。
      var boundaryTop = overlayBox ? overlayBox.top : 0;
      var placeBelow = hover.y - 56 < boundaryTop;
      hoverNode = h(
        'div',
        {
          className: 'ql-tooltip' + (placeBelow ? ' ql-tooltip-below' : ''),
          role: 'tooltip',
          style: {
            left: hover.x + 'px',
            top: (placeBelow ? hover.bottom : hover.y) + 'px',
          },
        },
        h('div', { className: 'ql-tooltip-text' }, hover.text),
        hover.stats ? h('div', { className: 'ql-tooltip-stats' }, hover.stats) : null
      );
    }

    return h(
      'div',
      {
        ref: rootRef,
        className: 'ql-root' + (dropping ? ' ql-dropping' : ''),
        onContextMenu: backgroundMenu,
      },
      toolbar,
      groupBar,
      banner,
      body,
      dropping ? h('div', { className: 'ql-dropHint' }, '松开即可添加为快捷方式') : null,
      menuNode,
      dialogNode,
      hoverNode
    );
  }

  // ============================================================
  // 小组件：分组对话框 / 替换确认
  // ============================================================

  function overlayStyleFor(box) {
    return box
      ? {
          top: box.top + 'px',
          left: box.left + 'px',
          width: box.width + 'px',
          height: box.height + 'px',
          right: 'auto',
          bottom: 'auto',
        }
      : undefined;
  }

  function GroupDialog(props) {
    var nameState = React.useState(props.draft.name || '');
    var name = nameState[0];
    var setName = nameState[1];

    function submit() {
      var value = trimmed(name);
      if (!value) return;
      props.onSubmit(Object.assign({}, props.draft, { kind: 'group', name: value }));
    }

    return h(
      'div',
      {
        className: 'ql-overlay',
        style: overlayStyleFor(props.box),
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) props.onCancel();
        },
      },
      h(
        'div',
        {
          className: 'ql-dialog ql-dialog-small',
          role: 'dialog',
          'aria-label': props.draft.groupId ? '重命名分组' : '新建分组',
          onKeyDown: function (event) {
            if (event.key === 'Escape') {
              event.stopPropagation();
              props.onCancel();
            }
            if (event.key === 'Enter') submit();
          },
        },
        h('h2', { className: 'ql-dialog-title' }, props.draft.groupId ? '重命名分组' : '新建分组'),
        h('input', {
          className: 'ql-input',
          type: 'text',
          value: name,
          autoFocus: true,
          placeholder: '分组名称',
          'aria-label': '分组名称',
          onChange: function (e) {
            setName(e.target.value);
          },
        }),
        h(
          'div',
          { className: 'ql-dialog-actions' },
          h('span', { className: 'ql-dialog-spacer' }),
          h('button', { className: 'ql-btn ql-btn-ghost', type: 'button', onClick: props.onCancel }, '取消'),
          h('button', { className: 'ql-btn ql-btn-primary', type: 'button', onClick: submit }, '保存')
        )
      )
    );
  }

  /**
   * 「替换」之前的最后一道确认。
   *
   * 用自己渲染的对话框，而不是 `window.confirm` —— 见文件上方关于
   * `window.confirm` 被换成 async 版本的那段说明。
   */
  function ReplaceDialog(props) {
    return h(
      'div',
      {
        className: 'ql-overlay',
        style: overlayStyleFor(props.box),
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) props.onCancel();
        },
      },
      h(
        'div',
        { className: 'ql-dialog ql-dialog-small', role: 'dialog', 'aria-label': '确认替换' },
        h('h2', { className: 'ql-dialog-title' }, '确认替换'),
        h(
          'p',
          { className: 'ql-dialog-hint' },
          '替换会**清掉现在所有的条目与分组**，只留下导入的 ' + props.count + ' 条。这一步不可撤销。'
        ),
        h(
          'div',
          { className: 'ql-dialog-actions' },
          h('span', { className: 'ql-dialog-spacer' }),
          h('button', { className: 'ql-btn ql-btn-ghost', type: 'button', onClick: props.onCancel }, '取消'),
          h(
            'button',
            { className: 'ql-btn ql-btn-danger', type: 'button', onClick: props.onConfirm },
            '确认替换'
          )
        )
      )
    );
  }

  // ============================================================
  // 注册
  // ============================================================

  Modulith.registerModule({
    id: 'quick-launch',
    name: '快捷启动',
    description: '把常用程序与网址收在一处，点一下就打开',
    icon: 'icon.svg',
    priority: 80,
    component: QuickLaunch,
  });

  // ============================================================
  // 验证入口（**只在显式打开时才挂出去**）
  // ============================================================
  //
  // 这些是**纯函数**（除 `resolveLaunch` 会看一眼 `ctx.launcher.open` 是否存在），
  // 把它们挂出来是为了让仓库外的一份验证脚本能在 Node 里直接调用它们，而不是靠读
  // 代码猜行为。模块是 IIFE，内部函数靠闭包捕获，静态阅读看不到 `Array.sort` 的
  // 稳定性、字符串比较这类真实行为。
  //
  // `__QUICKLAUNCH_TEST__` 由验证脚手架在加载前设好；**正常运行时它是 undefined，
  // 这个全局根本不存在** —— 发布出去的插件不留测试钩子。宿主也不会读它。

  var testApi = {
    STATE_VERSION: STATE_VERSION,
    FALLBACK_SETTINGS: FALLBACK_SETTINGS,
    normalizeState: normalizeState,
    normalizeSettings: normalizeSettings,
    mergeSettings: mergeSettings,
    resolveSettings: resolveSettings,
    validateUrl: validateUrl,
    looksLikeUrlText: looksLikeUrlText,
    guessKind: guessKind,
    parseArgs: parseArgs,
    openVerb: openVerb,
    urlLabel: urlLabel,
    hostOf: hostOf,
    resolveLaunch: resolveLaunch,
    canOpen: canOpen,
    isAddressItem: isAddressItem,
    looksExecutable: looksExecutable,
    extensionOf: extensionOf,
    buildSections: buildSections,
    searchItems: searchItems,
    sortItems: sortItems,
    matchesQuery: matchesQuery,
    findByTarget: findByTarget,
    targetKey: targetKey,
    iconTile: iconTile,
    normalizeItem: normalizeItem,
    emptyState: emptyState,
  };

  if (window.__QUICKLAUNCH_TEST__) window.__quickLaunchTest__ = testApi;
})();
