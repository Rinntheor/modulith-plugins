// plugins/hello/index.js
//
// 问候 —— 本仓库的参考插件（**沙箱版**）。
//
// 它是插件的**最小可读形态**：照着复制、改掉名字与图标，就是一份合法插件。
// 刻意保持手写 IIFE、不使用构建工具 —— 模板应当可以被完整读完。
//
// ============================================================
// 它与"旧式插件"差在哪
// ============================================================
//
// 这个插件的清单里写着 `"runtime": "sandboxed"`，于是它跑在**自己的 webview** 里，
// 而不是宿主那个页面里。三件事因此变了：
//
//   1. **没有 React，也没有宿主 CSS。** 它是独立文档，宿主那套 `--accent-*` 变量与
//      `.dark` 类在这里都不存在。界面自己写，颜色自己带（见 index.css）。
//      这不是缺陷 —— 它意味着插件可以自带框架、自带样式，与宿主的版本解耦。
//   2. **不能调宿主命令。** 它的 webview 不匹配任何 capability，因此
//      `invoke(...)` 一律被拒（连传输本身都会被 CSP 挡住一半）。
//      要做事只能通过下面的 `Modulith`。
//   3. **不能直接联网。** 文档的 CSP 里 `connect-src` 只留了插件自己的来源，
//      所以 `fetch('https://…')` 由浏览器引擎挡下。
//
// ============================================================
// 宿主给的是什么
// ============================================================
//
// `window.Modulith` 由**宿主**提供（`/<插件 id>/bridge.js`），插件改不了它，
// 也无法抢在它前面执行 —— 入口文档由宿主合成，脚本顺序是桥接层在前。
//
//   Modulith.plugin      身份：{ id, name, version, permissions }
//   Modulith.has(name)   声明了某个权限没有（用它做特性探测，别比较版本号）
//   Modulith.log.*       写进宿主的日志，带插件 id
//   Modulith.storage.*   键值存储（需要清单里声明 "storage"）
//
// 全部方法都是**异步**的：它们是对宿主的 RPC，不是本地调用。

(function () {
  'use strict';

  var M = window.Modulith;

  // 桥接层缺失时说一句人话。这里刻意不抛异常：那种报错是
  // "Cannot read properties of undefined"，看起来像插件自己的 bug。
  if (!M) {
    document.body.textContent = '宿主桥接层没有加载 —— 这个插件的入口文档不是由宿主合成的？';
    return;
  }

  /** 存储键。只允许字母数字与 . _ -，最长 128 字符 */
  var KEY_COUNT = 'count';

  var root = document.getElementById('modulith-root') || document.body;

  /** 首帧用 null 而不是 0：次数要从存储里异步读出来，先显示 0 会闪一下假值 */
  var count = null;

  function render() {
    // 用 DOM API 而不是拼 HTML 字符串。这个插件没有第三方内容，
    // 拼接本身不危险；但模板应当示范**不需要消毒**的写法。
    root.textContent = '';

    var box = document.createElement('div');
    box.className = 'hello';

    var title = document.createElement('h1');
    title.className = 'hello__title';
    title.textContent = '问候';
    box.appendChild(title);

    var note = document.createElement('p');
    note.className = 'hello__muted';
    note.textContent = '这是一个参考插件。它能做的事只有一件：记住你点了几次。';
    box.appendChild(note);

    var line = document.createElement('p');
    line.className = 'hello__count';
    line.textContent = count === null ? '正在读取…' : '你点击了 ' + count + ' 次';
    box.appendChild(line);

    var button = document.createElement('button');
    button.className = 'hello__button';
    button.type = 'button';
    button.textContent = '点我';
    button.disabled = count === null;
    button.addEventListener('click', bump);
    box.appendChild(button);

    root.appendChild(box);
  }

  function bump() {
    var next = (count || 0) + 1;

    // 先更新界面再落盘：写盘可能失败（磁盘满、超配额），
    // 但那不该让按钮看起来没反应。失败只记一条日志 ——
    // 宿主给的失败原因里带着"哪一档、上限多少、已用多少、本次多少"四个数字，
    // 原样交给日志，不要自己改写它。
    count = next;
    render();

    M.storage.set(KEY_COUNT, next).catch(function (error) {
      M.log.warn('保存次数失败：' + (error && error.message ? error.message : error));
    });
  }

  // 没有 storage 权限时不要装作能存 —— 直接说清楚，而不是让 set 每次都失败。
  if (!M.has('storage')) {
    root.textContent = '这个插件没有声明 storage 权限，因此记不住次数。';
    M.log.warn('缺少 storage 权限');
    return;
  }

  render();

  M.storage
    .get(KEY_COUNT, 0)
    .then(function (saved) {
      count = typeof saved === 'number' && isFinite(saved) ? saved : 0;
      render();
    })
    .catch(function (error) {
      count = 0;
      render();
      M.log.warn('读取次数失败：' + (error && error.message ? error.message : error));
    });

  M.log.info('参考插件（沙箱版）加载完成：' + M.plugin.id + ' v' + M.plugin.version);
})();
