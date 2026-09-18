// plugins/hello/index.js
//
// 问候 —— 本仓库的参考插件，示范插件目录结构与宿主接口的最小用法。
//
// 它的用途不是提供功能，而是三件事：
//   1. 目录规范的**可执行形式** —— 照着复制、改掉名字与图标，就是一份合法插件。
//   2. 打包与发布流程的测试对象 —— 构建脚本以它为准。
//   3. 插件系统的冒烟测试 —— 装上它能点、能记住次数，说明宿主接口是通的。
//
// 刻意保持手写 IIFE、不使用构建工具：模板应当可以被完整读完，引入打包器会让「最小」
// 失去意义。代价是不能写 JSX，因此全部用 `React.createElement`（简写为 h）。

(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    console.error('[hello] 未找到 window.Modulith，插件无法加载');
    return;
  }

  var React = Modulith.React;
  var h = React.createElement;

  // createContext() 只能在加载期调用，因此在这里取一次并长期持有。
  var ctx = Modulith.createContext();

  /** 存储键。只允许字母数字与 . _ -，最长 128 字符 */
  var KEY_COUNT = 'count';

  function Hello() {
    // 首帧是 null 而不是 0：次数要从存储里异步读出来。
    // 用 0 作为初值会让每次打开都先闪一个错误的 0，再跳成真实值。
    var state = React.useState(null);
    var count = state[0];
    var setCount = state[1];

    React.useEffect(function () {
      // 组件可能在这一步完成前被卸载（用户切走标签页），
      // 因此用一个标志位避免对已卸载的组件 setState。
      var alive = true;

      ctx.storage
        .get(KEY_COUNT, 0)
        .then(function (saved) {
          if (!alive) return;
          setCount(typeof saved === 'number' && isFinite(saved) ? saved : 0);
        })
        .catch(function (err) {
          ctx.logger.warn('读取次数失败', err);
          if (alive) setCount(0);
        });

      return function () {
        alive = false;
      };
    }, []);

    function bump() {
      var next = (count || 0) + 1;
      // 先更新界面再落盘：存储写盘可能失败（磁盘满、权限），
      // 但那不该让按钮看起来没反应。失败只记一条日志。
      setCount(next);
      ctx.storage.set(KEY_COUNT, next).catch(function (err) {
        ctx.logger.warn('保存次数失败', err);
      });
    }

    if (count === null) {
      return h('div', { className: 'hello' }, h('p', { className: 'hello__muted' }, '正在读取…'));
    }

    return h(
      'div',
      { className: 'hello' },
      h('h1', { className: 'hello__title' }, '问候'),
      h(
        'p',
        { className: 'hello__muted' },
        '这是一个参考插件。它能做的事只有一件：记住你点了几次。'
      ),
      h('p', { className: 'hello__count' }, '你点击了 ' + count + ' 次'),
      h('button', { className: 'hello__button', onClick: bump }, '点我')
    );
  }

  // 必须在加载期**同步**调用：宿主在一次加载结束后立即检查注册结果，
  // 放进 Promise 或 setTimeout 里会被判定为「没有注册任何模块」。
  Modulith.registerModule({
    id: 'helloView',
    name: '问候',
    displayName: '问候',
    description: '最小可用的参考插件',
    priority: 90,
    component: Hello,
  });

  ctx.logger.info('参考插件加载完成');
})();
