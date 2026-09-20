// 从 plugins/kanban/index.js 拆出 —— **逻辑原样搬运，未做任何改动**。
// 搬运是机械的：每块的位置与内容都没变，只是补上了 import / export。
import { dueInfo, formatDateTime } from './dates';
import { CARD_NOTE_MAX, CARD_TITLE_MAX, DUE_CLASS, RECURRENCE_LABEL, h, useEffect, useRef, useState } from './env';
import { icons } from './icons';
import { text } from './model';
import { DatePicker, IconButton, RecurrenceSelect } from './ui';

// ---------------------------------------------------------------------------
// 卡片编辑器
// ---------------------------------------------------------------------------

function CardEditor(props) {
  var card = props.card;
  var titleState = useState(card.title);
  var title = titleState[0];
  var setTitle = titleState[1];

  var noteState = useState(card.note);
  var note = noteState[0];
  var setNote = noteState[1];

  var priorityState = useState(card.priority);
  var priority = priorityState[0];
  var setPriority = priorityState[1];

  var dueState = useState(card.due || null);
  var due = dueState[0];
  var setDue = dueState[1];

  var recurrenceState = useState(card.recurrence || null);
  var recurrence = recurrenceState[0];
  var setRecurrence = recurrenceState[1];

  var laneState = useState(card.laneId);
  var laneId = laneState[0];
  var setLaneId = laneState[1];

  var confirmState = useState(false);
  var confirming = confirmState[0];
  var setConfirming = confirmState[1];

  var panelRef = useRef(null);

  useEffect(function () {
    if (panelRef.current && panelRef.current.focus) panelRef.current.focus();
  }, []);

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      props.onClose();
    }
  }

  function submit(event) {
    if (event) event.preventDefault();
    var value = title.trim();
    props.onSave({
      title: value.length > 0 ? value.slice(0, CARD_TITLE_MAX) : card.title,
      note: note.slice(0, CARD_NOTE_MAX),
      priority: priority,
      due: due || null,
      recurrence: recurrence,
      laneId: laneId,
    });
  }

  var dueHint = dueInfo(due, false);

  return h(
    'div',
    {
      className: 'kanban__overlay',
      onPointerDown: function (event) {
        if (event.target === event.currentTarget) props.onClose();
      },
    },
    h(
      'form',
      {
        ref: panelRef,
        className: 'kanban__dialog',
        tabIndex: -1,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '编辑卡片',
        onSubmit: submit,
        onKeyDown: onKeyDown,
      },
      h(
        'div',
        { className: 'kanban__dialog-head' },
        h('h3', { className: 'kanban__dialog-title' }, '编辑卡片'),
        dueHint ? h('span', { className: 'kanban__due ' + DUE_CLASS[dueHint.tone] }, dueHint.text) : null,
        h('span', { className: 'kanban__card-spacer' }),
        h(IconButton, { label: '关闭编辑器', title: '关闭（Esc）', onClick: props.onClose }, icons.close())
      ),
      h(
        'label',
        { className: 'kanban__field' },
        h('span', { className: 'kanban__label' }, '要做什么'),
        h('input', {
          className: 'kanban__input',
          value: title,
          maxLength: CARD_TITLE_MAX,
          autoFocus: true,
          onChange: function (event) {
            setTitle(event.target.value);
          },
        })
      ),
      h(
        'label',
        { className: 'kanban__field' },
        h('span', { className: 'kanban__label' }, '补充说明（可留空）'),
        h('textarea', {
          className: 'kanban__textarea',
          value: note,
          maxLength: CARD_NOTE_MAX,
          rows: 3,
          placeholder: '细节、链接、下一步……',
          onChange: function (event) {
            setNote(event.target.value);
          },
        }),
        h('span', { className: 'kanban__hint' }, note.length + ' / ' + CARD_NOTE_MAX)
      ),
      h(
        'div',
        { className: 'kanban__field' },
        h('span', { className: 'kanban__label' }, '截止日'),
        h(DatePicker, { value: due, onChange: setDue })
      ),
      h(
        'div',
        { className: 'kanban__field-row' },
        h(
          'label',
          { className: 'kanban__field' },
          h('span', { className: 'kanban__label' }, '优先级'),
          h(
            'select',
            {
              className: 'kanban__select',
              value: priority,
              onChange: function (event) {
                setPriority(event.target.value);
              },
            },
            h('option', { value: 'low' }, '低'),
            h('option', { value: 'normal' }, '中'),
            h('option', { value: 'high' }, '高')
          )
        ),
        h(
          'label',
          { className: 'kanban__field' },
          h('span', { className: 'kanban__label' }, '重复'),
          h(RecurrenceSelect, { value: recurrence, onChange: setRecurrence })
        ),
        h(
          'label',
          { className: 'kanban__field' },
          h('span', { className: 'kanban__label' }, '所在列表'),
          h(
            'select',
            {
              className: 'kanban__select',
              value: laneId,
              onChange: function (event) {
                setLaneId(event.target.value);
              },
            },
            props.lanes.map(function (item) {
              return h('option', { key: item.id, value: item.id }, item.name);
            })
          )
        )
      ),
      recurrence
        ? h(
            'p',
            { className: 'kanban__hint' },
            '勾选完成时这张卡片不会停在这里，而是自动把截止日推到下一次（' + RECURRENCE_LABEL[recurrence] + '）。'
          )
        : null,
      h(
        'div',
        { className: 'kanban__dialog-foot' },
        h('button', { type: 'submit', className: 'kanban__btn kanban__btn--primary' }, '保存'),
        h('button', { type: 'button', className: 'kanban__btn kanban__btn--ghost', onClick: props.onClose }, '取消'),
        h('span', { className: 'kanban__card-spacer' }),
        h('span', { className: 'kanban__hint kanban__hint--meta' }, '创建于 ' + formatDateTime(card.createdAt)),
        confirming
          ? h('button', { type: 'button', className: 'kanban__btn kanban__btn--danger', onClick: props.onDelete }, '确认删除')
          : h(
              'button',
              {
                type: 'button',
                className: 'kanban__btn kanban__btn--danger-ghost',
                onClick: function () {
                  setConfirming(true);
                },
              },
              '删除卡片'
            )
      )
    )
  );
}

export { CardEditor };
