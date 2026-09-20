// 从 plugins/kanban/index.js 拆出 —— **逻辑原样搬运，未做任何改动**。
// 搬运是机械的：每块的位置与内容都没变，只是补上了 import / export。
import { KanbanBoard } from './board';
import { Modulith, React, ctx } from './env';
import { icon } from './icons';
import { internal } from './store';

// ---------------------------------------------------------------------------
// 注册：必须在 IIFE 顶层**同步**完成
// ---------------------------------------------------------------------------

Modulith.registerModule({
  id: 'kanbanBoard',
  name: '看板',
  displayName: '看板',
  description: '把活儿按列表摆开，拖动或按键盘移动卡片',
  icon: 'SquareKanban',
  priority: 70,
  category: '效率',
  component: KanbanBoard,
});

Modulith.registerCommand({
  id: 'new-card',
  title: '看板：新建一张卡片',
  keywords: ['kanban', 'todo', 'task'],
  run: function () {
    // 命令可以从任何模块触发，此时看板很可能还没挂载（模块未打开），
    // 因此先尝试点开第一栏的新建按钮，点不到就明确说清原因 —— 静默不动作最让人困惑。
    var board = internal.lastGood;
    if (!board || !board.lanes.length) {
      ctx.logger.warn('看板数据还没读取完成，请先打开看板模块再试');
      return;
    }
    var first = board.lanes[0];
    var trigger = document.querySelector('[data-lane-id="' + first.id + '"] .kanban__add');
    if (trigger) {
      trigger.click();
      // 展开新建表单是 React 的异步更新，输入框要到下一帧才存在
      requestAnimationFrame(function () {
        var input = document.querySelector('[data-lane-id="' + first.id + '"] .kanban__composer input');
        if (input && input.focus) input.focus();
      });
      return;
    }
    var openInput = document.querySelector('[data-lane-id="' + first.id + '"] .kanban__composer input');
    if (openInput && openInput.focus) {
      openInput.focus();
      return;
    }
    ctx.logger.warn('看板模块当前没有打开，请先切到看板再使用这个命令');
  },
});

ctx.logger.info('看板插件加载完成', {
  host: Modulith.version,
  notifications: ctx.notifications.isAvailable ? ctx.notifications.isAvailable() : false,
  events: ctx.events.isAvailable(),
});

