// 从 plugins/kanban/index.js 拆出 —— **逻辑原样搬运，未做任何改动**。
// 搬运是机械的：每块的位置与内容都没变，只是补上了 import / export。
import { TaskCard } from './card';
import { CARD_TITLE_MAX, LANE_NAME_MAX, h, useEffect, useRef, useState } from './env';
import { icons } from './icons';
import { DatePicker, IconButton, Menu, MenuItem, RecurrenceSelect } from './ui';

// ---------------------------------------------------------------------------
// 列表（栏）
// ---------------------------------------------------------------------------

function Lane(props) {
  var lane = props.lane;
  var composerState = useState(false);
  var composing = composerState[0];
  var setComposing = composerState[1];

  var formState = useState({ title: '', priority: 'normal', due: null, recurrence: null });
  var form = formState[0];
  var setForm = formState[1];

  var renameState = useState(false);
  var renaming = renameState[0];
  var setRenaming = renameState[1];

  var confirmState = useState(false);
  var confirming = confirmState[0];
  var setConfirming = confirmState[1];

  var inputRef = useRef(null);

  useEffect(function () {
    if (composing && inputRef.current && inputRef.current.focus) inputRef.current.focus();
  }, [composing]);

  useEffect(function () {
    if (!confirming) return undefined;
    var timer = setTimeout(function () {
      setConfirming(false);
    }, 5000);
    return function () {
      clearTimeout(timer);
    };
  }, [confirming]);

  function resetComposer() {
    setForm({ title: '', priority: 'normal', due: null, recurrence: null });
    setComposing(false);
  }

  function submit(event) {
    if (event) event.preventDefault();
    var title = form.title.trim();
    if (!title) return;
    props.onAddCard(title.slice(0, CARD_TITLE_MAX), form.priority, form.due, form.recurrence);
    setForm({ title: '', priority: form.priority, due: null, recurrence: null });
    if (inputRef.current && inputRef.current.focus) inputRef.current.focus();
  }

  function onComposerKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      resetComposer();
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit(event);
    }
  }

  var cards = props.cards;
  var isDropLane = props.dragging && props.laneDropBeforeId === lane.id;
  var isDropLaneAfter = props.dragging && props.laneDropAfterId === lane.id;

  if (lane.collapsed) {
    return h(
      'section',
      {
        className:
          'kanban__lane kanban__lane--collapsed' +
          (isDropLane ? ' is-drop-before' : '') +
          (isDropLaneAfter ? ' is-drop-after' : ''),
        'data-lane-id': lane.id,
        'aria-label': lane.name + '列表，已折叠，共 ' + cards.length + ' 张卡片',
      },
      h(
        'button',
        {
          type: 'button',
          className: 'kanban__lane-collapsed-btn',
          'aria-label': '展开列表：' + lane.name,
          title: '展开列表',
          onClick: function () {
            props.onToggleCollapsed(lane.id);
          },
        },
        icons.arrowRight(),
        h('span', { className: 'kanban__lane-name' }, lane.name),
        h('span', { className: 'kanban__lane-count' }, String(cards.length))
      )
    );
  }

  return h(
    'section',
    {
      className:
        'kanban__lane' +
        (props.dropLaneId === lane.id && props.dragging === 'card' ? ' is-drop-target' : '') +
        (isDropLane ? ' is-drop-before' : '') +
        (isDropLaneAfter ? ' is-drop-after' : ''),
      'data-lane-id': lane.id,
      'aria-label': lane.name + '列表，共 ' + cards.length + ' 张卡片',
    },
    h(
      'header',
      { className: 'kanban__lane-head' },
      h(
        IconButton,
        {
          label: '拖动调整「' + lane.name + '」的位置',
          title: '按住拖动可调整列表顺序',
          grip: true,
          onPointerDown: function (event) {
            props.onLaneDragStart(lane.id, event);
          },
        },
        icons.grip()
      ),
      renaming
        ? h('input', {
            className: 'kanban__input kanban__input--inline',
            defaultValue: lane.name,
            autoFocus: true,
            maxLength: LANE_NAME_MAX,
            'aria-label': '列表名称',
            onBlur: function (event) {
              var value = event.target.value.trim();
              if (value && value !== lane.name) props.onRenameLane(lane.id, value.slice(0, LANE_NAME_MAX));
              setRenaming(false);
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.target.blur();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setRenaming(false);
              }
            },
          })
        : h('h2', { className: 'kanban__lane-name' }, lane.name),
      h('span', { className: 'kanban__lane-count' }, String(cards.length)),
      h('span', { className: 'kanban__card-spacer' }),
      h(
        Menu,
        {
          label: '列表「' + lane.name + '」的更多操作',
          title: '列表操作',
          trigger: icons.more(),
        },
        function (close) {
          return [
            h(
              MenuItem,
              {
                key: 'rename',
                onClick: function () {
                  close();
                  setRenaming(true);
                },
              },
              '重命名'
            ),
            h(
              MenuItem,
              {
                key: 'left',
                disabled: props.laneIndex === 0,
                onClick: function () {
                  close();
                  props.onMoveLane(lane.id, props.laneIndex - 1);
                },
              },
              '左移一栏'
            ),
            h(
              MenuItem,
              {
                key: 'right',
                disabled: props.laneIndex >= props.laneCount - 1,
                onClick: function () {
                  close();
                  props.onMoveLane(lane.id, props.laneIndex + 1);
                },
              },
              '右移一栏'
            ),
            h(
              MenuItem,
              {
                key: 'collapse',
                onClick: function () {
                  close();
                  props.onToggleCollapsed(lane.id);
                },
              },
              '折叠列表'
            ),
            h(
              MenuItem,
              {
                key: 'remove',
                danger: true,
                disabled: props.laneCount <= 1,
                onClick: function () {
                  close();
                  setConfirming(true);
                },
              },
              '删除列表…'
            ),
          ];
        }
      )
    ),
    confirming
      ? h(
          'p',
          { className: 'kanban__lane-warn', role: 'alert' },
          h('span', null, '删除「' + lane.name + '」，里面 ' + cards.length + ' 张卡片会一起移除。'),
          h(
            'button',
            {
              type: 'button',
              className: 'kanban__btn kanban__btn--danger kanban__btn--tight',
              onClick: function () {
                props.onRemoveLane(lane.id);
              },
            },
            '确认删除'
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'kanban__btn kanban__btn--ghost kanban__btn--tight',
              onClick: function () {
                setConfirming(false);
              },
            },
            '取消'
          )
        )
      : null,
    h(
      'div',
      { className: 'kanban__lane-body', 'data-lane-body': '1', 'data-lane-id': lane.id },
      cards.length === 0
        ? h(
            'p',
            { className: 'kanban__lane-empty' },
            props.hasQuery ? '这个列表里没有匹配的卡片。' : '这个列表还是空的。点下面的「添加卡片」写下第一件事。'
          )
        : null,
      cards.map(function (card, index) {
        // 落点指示线画在卡片会被插进去的那个位置上，而不是一律画在底部 ——
        // 只有跟着指针走的那条线才能说明松手之后卡片会去哪。
        var showLine = props.dragging === 'card' && props.dropLaneId === lane.id && props.dropIndex === index;
        return h(
          'div',
          { key: card.id, className: 'kanban__card-slot' },
          showLine ? h('div', { className: 'kanban__drop-hint', 'aria-hidden': 'true' }) : null,
          h(TaskCard, {
            card: card,
            board: props.board,
            laneIndex: props.laneIndex,
            laneCount: props.laneCount,
            dragging: !!props.dragging,
            justMoved: props.justMovedId === card.id,
            onDragStart: props.onDragStart,
            onEdit: props.onEdit,
            onDelete: props.onDelete,
            onToggleDone: props.onToggleDone,
            onSetPriority: props.onSetPriority,
            onSetDue: props.onSetDue,
            onShiftDue: props.onShiftDue,
            onMoveToLane: function (targetIndex) {
              props.onMoveCardToLane(card.id, targetIndex);
            },
          })
        );
      }),
      props.dragging === 'card' && props.dropLaneId === lane.id && props.dropIndex >= cards.length
        ? h('div', { className: 'kanban__drop-hint', 'aria-hidden': 'true' })
        : null
    ),
    composing
      ? h(
          'form',
          { className: 'kanban__composer', onSubmit: submit },
          h('input', {
            ref: inputRef,
            className: 'kanban__input',
            value: form.title,
            maxLength: CARD_TITLE_MAX,
            placeholder: '这张卡片要做什么？',
            'aria-label': '新卡片标题',
            onChange: function (event) {
              setForm(Object.assign({}, form, { title: event.target.value }));
            },
            onKeyDown: onComposerKeyDown,
          }),
          h(
            'div',
            { className: 'kanban__composer-row' },
            h(
              'select',
              {
                className: 'kanban__select',
                value: form.priority,
                'aria-label': '优先级',
                onChange: function (event) {
                  setForm(Object.assign({}, form, { priority: event.target.value }));
                },
              },
              h('option', { value: 'normal' }, '优先级：中'),
              h('option', { value: 'high' }, '优先级：高'),
              h('option', { value: 'low' }, '优先级：低')
            ),
            h(
              'span',
              { className: 'kanban__composer-recur' },
              h(RecurrenceSelect, {
                value: form.recurrence,
                onChange: function (value) {
                  setForm(Object.assign({}, form, { recurrence: value }));
                },
              })
            )
          ),
          h(DatePicker, {
            value: form.due,
            onChange: function (value) {
              setForm(Object.assign({}, form, { due: value }));
            },
          }),
          h(
            'div',
            { className: 'kanban__composer-row' },
            h(
              'button',
              {
                type: 'submit',
                className: 'kanban__btn kanban__btn--primary',
                disabled: form.title.trim().length === 0,
              },
              '添加卡片'
            ),
            h('button', { type: 'button', className: 'kanban__btn kanban__btn--ghost', onClick: resetComposer }, '取消'),
            h('span', { className: 'kanban__hint' }, 'Ctrl + Enter 也可以添加')
          )
        )
      : h(
          'button',
          {
            type: 'button',
            className: 'kanban__add',
            onClick: function () {
              setComposing(true);
            },
          },
          icons.plus(14),
          '添加卡片'
        )
  );
}

export { Lane };
