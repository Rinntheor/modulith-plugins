// 从 plugins/kanban/index.js 拆出 —— **逻辑原样搬运，未做任何改动**。
// 搬运是机械的：每块的位置与内容都没变，只是补上了 import / export。
import { dueInfo, isOverdue, todayKey } from './dates';
import { DUE_CLASS, PRIORITY_CLASS, PRIORITY_LABEL, RECURRENCE_LABEL, h, useRef } from './env';
import { icons } from './icons';
import { laneNameOf, text } from './model';

// ---------------------------------------------------------------------------
// 卡片
// ---------------------------------------------------------------------------

/**
 * 卡片的布局：标题独占一行（可以换行，不被角标挤成一列字），
 * 其余信息全部收进下面一行元信息，操作按钮右对齐。
 * 这样窄窗口下也只是换行，不会出现「标题被压成三行、日期飘在中间」那种别扭感。
 */
function TaskCard(props) {
  var card = props.card;
  var due = dueInfo(card.due, card.done);
  var nodeRef = useRef(null);

  function isEditingText() {
    var node = nodeRef.current;
    if (!node || !node.tagName) return false;
    var tag = node.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  function onKeyDown(event) {
    if (isEditingText()) return;

    var forward = (event.altKey && event.key === 'ArrowRight') || (event.ctrlKey && event.key === 'ArrowDown');
    var backward = (event.altKey && event.key === 'ArrowLeft') || (event.ctrlKey && event.key === 'ArrowUp');
    if (forward || backward) {
      event.preventDefault();
      var next = forward ? props.laneIndex + 1 : props.laneIndex - 1;
      if (next < 0 || next >= props.laneCount) return;
      props.onMoveToLane(next);
      return;
    }
    if (event.key === 'Enter') {
      // 卡片本身是有焦点的按钮：回车必须能打开编辑器，
      // 否则「Tab 走过来之后能干什么」就是一件只能猜的事。
      event.preventDefault();
      props.onEdit(card.id);
      return;
    }
    if (event.key === 'm' || event.key === 'M') {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      props.onShiftDue(card.id, 1);
    }
  }

  function onPointerDown(event) {
    if (props.dragging) return; // 拖动进行中不再发起第二次
    if (event.button !== 0) return; // 只接管主键
    var target = event.target;
    var interactive = target && target.closest ? target.closest('button, input, textarea, select, a, summary') : null;
    if (interactive) return; // 卡片上的小按钮、输入框自己处理点击
    props.onDragStart(card.id, event);
  }

  return h(
    'article',
    {
      ref: nodeRef,
      className:
        'kanban__card' +
        (card.done ? ' is-done' : '') +
        (isOverdue(card, todayKey()) ? ' is-overdue' : '') +
        (props.justMoved ? ' is-just-moved' : ''),
      tabIndex: 0,
      role: 'group',
      'aria-label':
        card.title + '，位于「' + laneNameOf(props.board, card.laneId) + '」列表' +
        (card.done ? '，已完成' : '') +
        (due ? '，' + due.text : '') +
        '。按回车打开编辑器，按 Alt 加左右方向键移动到相邻列表，按 M 顺延一天。',
      'data-card-id': card.id,
      'data-lane-id': card.laneId,
      onPointerDown: onPointerDown,
      onKeyDown: onKeyDown,
      onDoubleClick: function () {
        props.onEdit(card.id);
      },
    },
    h('h3', { className: 'kanban__card-title' }, card.title),
    card.note ? h('p', { className: 'kanban__card-note' }, card.note) : null,
    h(
      'div',
      { className: 'kanban__card-meta' },
      h(
        'button',
        {
          type: 'button',
          className: 'kanban__pill ' + PRIORITY_CLASS[card.priority],
          title: '优先级：' + PRIORITY_LABEL[card.priority] + '（点击切换）',
          'aria-label': '优先级：' + PRIORITY_LABEL[card.priority] + '，点击切换',
          onClick: function () {
            var order = ['normal', 'high', 'low'];
            props.onSetPriority(card.id, order[(order.indexOf(card.priority) + 1) % order.length]);
          },
        },
        PRIORITY_LABEL[card.priority]
      ),
      due
        ? h(
            'button',
            {
              type: 'button',
              className: 'kanban__due ' + DUE_CLASS[due.tone],
              title: '截止日：' + (card.due || '无') + '（点击顺延一天）',
              'aria-label': '截止日 ' + (card.due || '未设置') + '，点击顺延一天',
              onClick: function () {
                props.onShiftDue(card.id, 1);
              },
            },
            icons.calendar(12),
            due.text
          )
        : h(
            'button',
            {
              type: 'button',
              className: 'kanban__due kanban__due--empty',
              title: '设置截止日：今天',
              'aria-label': '未设截止日，点击设为今天',
              onClick: function () {
                props.onSetDue(card.id, todayKey());
              },
            },
            icons.calendar(12),
            '未设日期'
          ),
      card.recurrence
        ? h(
            'span',
            { className: 'kanban__tag kanban__tag--repeat', title: '重复：' + RECURRENCE_LABEL[card.recurrence] },
            icons.repeat(12),
            RECURRENCE_LABEL[card.recurrence]
          )
        : null,
      card.note ? h('span', { className: 'kanban__tag', title: card.note }, icons.note(12)) : null,
      h('span', { className: 'kanban__card-spacer' }),
      h(
        'div',
        { className: 'kanban__card-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'kanban__mini' + (card.done ? ' is-active' : ''),
            'aria-label': card.done ? '标记为未完成：' + card.title : '标记为已完成：' + card.title,
            'aria-pressed': card.done,
            title: card.done ? '标记为未完成' : '标记为已完成',
            onClick: function () {
              props.onToggleDone(card.id, !card.done);
            },
          },
          icons.check()
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'kanban__mini',
            'aria-label': '编辑：' + card.title,
            title: '编辑',
            onClick: function () {
              props.onEdit(card.id);
            },
          },
          icons.pencil()
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'kanban__mini',
            'aria-label': '把「' + card.title + '」移到下一个列表',
            title: '移到下一个列表（Alt + →）',
            disabled: props.laneIndex >= props.laneCount - 1,
            onClick: function () {
              props.onMoveToLane(props.laneIndex + 1);
            },
          },
          icons.arrowRight()
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'kanban__mini kanban__mini--danger',
            'aria-label': '删除：' + card.title,
            title: '删除',
            onClick: function () {
              props.onDelete(card.id);
            },
          },
          icons.trash()
        )
      )
    )
  );
}

export { TaskCard };
