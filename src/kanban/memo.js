// 从 plugins/kanban/index.js 拆出 —— **逻辑原样搬运，未做任何改动**。
// 搬运是机械的：每块的位置与内容都没变，只是补上了 import / export。
import { CARD_TITLE_MAX, DRAFT_MAX, h, useEffect, useMemo, useState } from './env';
import { icons } from './icons';
import { text } from './model';

// ---------------------------------------------------------------------------
// 速记
// ---------------------------------------------------------------------------

/** 把一行文字变成一个可加入看板的条目。每一行都能单独送去某个列表。 */
function Memo(props) {
  var text = props.text;
  var sendState = useState(false);
  var sending = sendState[0];
  var setSending = sendState[1];

  var laneState = useState(props.lanes[0] ? props.lanes[0].id : '');
  var laneId = laneState[0];
  var setLaneId = laneState[1];

  var draftText = text.trim();
  if (draftText.length === 0) return h('div', { className: 'kanban__preview-gap' });

  // 去掉常见的列表前缀（- 、* 、1. 、[ ]），标题里不该带着它
  var clean = draftText.replace(/^([-*+•]|\d+[.)]|\[\s?\]|\[x\])\s*/i, '').slice(0, CARD_TITLE_MAX);

  return h(
    'div',
    { className: 'kanban__memo' + (sending ? ' is-sending' : '') },
    h('p', { className: 'kanban__preview-line' }, text),
    h(
      'div',
      { className: 'kanban__memo-actions' },
      h(
        'button',
        {
          type: 'button',
          className: 'kanban__mini',
          'aria-label': '把这一行加入看板：' + clean,
          title: '加入看板',
          onClick: function () {
            setSending(!sending);
          },
        },
        icons.inbox()
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'kanban__mini',
          'aria-label': '把这一行复制到剪贴板',
          title: '复制这一行',
          onClick: function () {
            props.onCopyLine(clean);
          },
        },
        icons.note(13)
      )
    ),
    sending
      ? h(
          'div',
          { className: 'kanban__memo-send' },
          h(
            'select',
            {
              className: 'kanban__select',
              value: laneId,
              'aria-label': '选择要加入的列表',
              onChange: function (event) {
                setLaneId(event.target.value);
              },
            },
            props.lanes.map(function (item) {
              return h('option', { key: item.id, value: item.id }, item.name);
            })
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'kanban__btn kanban__btn--primary kanban__btn--tight',
              onClick: function () {
                props.onSendToBoard(laneId, clean);
                setSending(false);
              },
            },
            '加入'
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'kanban__btn kanban__btn--ghost kanban__btn--tight',
              onClick: function () {
                setSending(false);
              },
            },
            '取消'
          )
        )
      : null
  );
}

function DraftView(props) {
  var draft = props.draft;
  var moreState = useState(false);
  var showMore = moreState[0];
  var setShowMore = moreState[1];

  var toastState = useState(null);
  var toast = toastState[0];
  var setToast = toastState[1];

  var preview = draft.length > 1200 && !showMore ? draft.slice(0, 1200) : draft;
  var hidden = draft.length - preview.length;

  var lines = useMemo(
    function () {
      return preview.split('\n');
    },
    [preview]
  );

  useEffect(function () {
    if (!toast) return undefined;
    var timer = setTimeout(function () {
      setToast(null);
    }, 2500);
    return function () {
      clearTimeout(timer);
    };
  }, [toast]);

  function copyText(value, label) {
    function failed() {
      setToast('浏览器没有允许写入剪贴板，请手动选中文字复制。');
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(function () {
          setToast(label + '已复制');
        }, failed);
      } else {
        failed();
      }
    } catch (err) {
      failed();
    }
  }

  var itemCount = draft
    .split('\n')
    .filter(function (line) {
      return line.trim().length > 0;
    }).length;

  return h(
    'div',
    { className: 'kanban__draft' },
    h(
      'div',
      { className: 'kanban__draft-main' },
      h(
        'label',
        { className: 'kanban__field' },
        h(
          'span',
          { className: 'kanban__label' },
          '随手记',
          h('span', { className: 'kanban__label-hint' }, '一行一件事，右边可以逐条加入看板')
        ),
        h('textarea', {
          className: 'kanban__textarea kanban__textarea--draft',
          value: draft,
          maxLength: DRAFT_MAX,
          placeholder: '想到什么先写在这里。\n一行一件事，写完去右边把有用的几条加进看板。',
          'aria-label': '随手记草稿',
          onChange: function (event) {
            props.onChange(event.target.value.slice(0, DRAFT_MAX));
          },
        })
      ),
      h(
        'div',
        { className: 'kanban__draft-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'kanban__btn kanban__btn--ghost',
            disabled: draft.length === 0,
            onClick: function () {
              copyText(draft, '全部文字');
            },
          },
          '复制全部'
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'kanban__btn kanban__btn--ghost',
            disabled: draft.length === 0,
            onClick: function () {
              props.onChange('');
            },
          },
          '清空'
        ),
        h(
          'span',
          { className: 'kanban__hint' },
          draft.length + ' / ' + DRAFT_MAX + '，共 ' + itemCount + ' 条，边写边保存'
        ),
        toast ? h('span', { className: 'kanban__draft-toast', role: 'status' }, toast) : null
      )
    ),
    h(
      'aside',
      { className: 'kanban__preview' },
      h(
        'div',
        { className: 'kanban__preview-head' },
        h('h3', { className: 'kanban__preview-title' }, '整理'),
        itemCount > 0 ? h('span', { className: 'kanban__hint' }, itemCount + ' 条') : null
      ),
      draft.length === 0
        ? h(
            'p',
            { className: 'kanban__lane-empty' },
            '左边写点什么，这里会把每一行列出来。每行右侧的按钮可以把它直接加进某个列表 —— 不必再复制一遍。'
          )
        : h(
            'div',
            { className: 'kanban__preview-body' },
            lines.map(function (line, index) {
              return h(Memo, {
                key: 'line-' + index,
                text: line,
                lanes: props.lanes,
                onSendToBoard: props.onSendToBoard,
                onCopyLine: function (value) {
                  copyText(value, '这一行');
                },
              });
            }),
            hidden > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'kanban__btn kanban__btn--ghost',
                    onClick: function () {
                      setShowMore(true);
                    },
                  },
                  '还有 ' + hidden + ' 个字，展开查看'
                )
              : null
          )
    )
  );
}

export { DraftView, Memo };
