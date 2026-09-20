// 从 plugins/kanban/index.js 拆出 —— **逻辑原样搬运，未做任何改动**。
// 搬运是机械的：每块的位置与内容都没变，只是补上了 import / export。
import { addDays, nextMondayKey, nextWeekendKey, todayKey } from './dates';
import { h, useEffect, useRef, useState, useSyncExternalStore } from './env';
import { icon, icons } from './icons';
import { text } from './model';
import { reload, saveNow, store } from './store';

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

function IconButton(props) {
  return h(
    'button',
    {
      type: 'button',
      className:
        'kanban__icon-btn' +
        (props.tone === 'danger' ? ' kanban__icon-btn--danger' : '') +
        (props.active ? ' is-active' : '') +
        (props.grip ? ' kanban__icon-btn--grip' : ''),
      'aria-label': props.label,
      title: props.title || props.label,
      'aria-pressed': props.pressed,
      disabled: props.disabled,
      onClick: props.onClick,
      onPointerDown: props.onPointerDown,
    },
    props.children
  );
}

/**
 * 一个带「点外面关闭 / Esc 关闭」的小下拉菜单。
 * 抽出来是因为工具栏和每个列表都要用，手写三遍必然三份行为不一致。
 */
function Menu(props) {
  var openState = useState(false);
  var open = openState[0];
  var setOpen = openState[1];
  var wrapRef = useRef(null);

  useEffect(function () {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (wrapRef.current && wrapRef.current.contains(event.target)) return;
      setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    // 延后一帧再挂监听：否则触发菜单打开的那一次 pointerdown 会立刻把它关掉
    var timer = setTimeout(function () {
      window.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('keydown', onKeyDown);
    }, 0);
    return function () {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return h(
    'div',
    { className: 'kanban__menu-wrap', ref: wrapRef },
    h(
      'button',
      {
        type: 'button',
        className: props.triggerClass || 'kanban__icon-btn',
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-label': props.label,
        title: props.title || props.label,
        onClick: function () {
          setOpen(!open);
        },
      },
      props.trigger
    ),
    open
      ? h(
          'div',
          { className: 'kanban__menu', role: 'menu', 'aria-label': props.label },
          typeof props.children === 'function' ? props.children(function () { setOpen(false); }) : props.children
        )
      : null
  );
}

function MenuItem(props) {
  return h(
    'button',
    {
      type: 'button',
      role: 'menuitem',
      className: 'kanban__menu-item' + (props.danger ? ' kanban__menu-item--danger' : ''),
      disabled: props.disabled,
      onClick: props.onClick,
    },
    props.children
  );
}

function ErrorBanner() {
  var state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  if (state.status === 'error') {
    return h(
      'div',
      { className: 'kanban__banner kanban__banner--error', role: 'alert' },
      h('span', { className: 'kanban__banner-text' }, state.errorMessage),
      h('button', { type: 'button', className: 'kanban__btn kanban__btn--ghost', onClick: reload }, '重新读取')
    );
  }
  if (state.status === 'ready' && state.saveState === 'error') {
    return h(
      'div',
      { className: 'kanban__banner kanban__banner--error', role: 'alert' },
      h('span', { className: 'kanban__banner-text' }, state.saveError),
      h(
        'button',
        {
          type: 'button',
          className: 'kanban__btn kanban__btn--ghost',
          onClick: function () {
            saveNow('手动重试');
          },
        },
        '重试保存'
      )
    );
  }
  if (state.status === 'ready' && state.notes.length > 0) {
    return h(
      'div',
      { className: 'kanban__banner kanban__banner--warn', role: 'status' },
      h('span', { className: 'kanban__banner-text' }, state.notes.join(' '))
    );
  }
  return null;
}

/** 速记与看板各自有自己的保存节奏，这里把两者的状态合起来显示。 */
function SaveIndicator(props) {
  var state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (state.status !== 'ready') return null;

  var label = '自动保存';
  var tone = 'is-muted';
  if (props.draftState === 'error' || state.saveState === 'error') {
    label = '有改动没保存';
    tone = 'is-danger';
  } else if (props.draftState === 'saving' || state.saveState === 'saving') {
    label = '正在保存…';
  } else if (props.draftState === 'saved' || state.saveState === 'saved') {
    label = '已保存';
    tone = 'is-ok';
  }
  return h(
    'span',
    { className: 'kanban__save ' + tone, role: 'status', 'aria-live': 'polite' },
    tone === 'is-ok' ? icons.check() : null,
    label
  );
}

/**
 * 日期选择。原生日历本身好用，问题在「设截止日」这件事的默认路径太绕：
 * 先点开日历、再在月历里找今天。因此常用日期做成一步可达的按钮，
 * 真正需要翻月的情况仍然用原生日历。
 */
function DatePicker(props) {
  var quick = [
    { label: '今天', value: todayKey() },
    { label: '明天', value: addDays(todayKey(), 1) },
    { label: '本周末', value: nextWeekendKey() },
    { label: '下周一', value: nextMondayKey() },
  ];
  var current = props.value || '';

  return h(
    'div',
    { className: 'kanban__datepick' },
    h(
      'div',
      { className: 'kanban__quick' },
      quick.map(function (item) {
        return h(
          'button',
          {
            key: item.label,
            type: 'button',
            className: 'kanban__quick-btn' + (current === item.value ? ' is-active' : ''),
            'aria-pressed': current === item.value,
            onClick: function () {
              props.onChange(current === item.value ? null : item.value);
            },
          },
          item.label
        );
      }),
      h(
        'button',
        {
          type: 'button',
          className: 'kanban__quick-btn' + (props.value ? '' : ' is-active'),
          onClick: function () {
            props.onChange(null);
          },
        },
        '不设'
      )
    ),
    h(
      'div',
      { className: 'kanban__datepick-row' },
      h('span', { className: 'kanban__datepick-icon', 'aria-hidden': 'true' }, icons.calendar(14)),
      h('input', {
        type: 'date',
        className: 'kanban__input kanban__input--date',
        value: current,
        'aria-label': '自选截止日',
        onChange: function (event) {
          props.onChange(event.target.value || null);
        },
      }),
      current
        ? h(
            'button',
            {
              type: 'button',
              className: 'kanban__btn kanban__btn--ghost kanban__btn--tight',
              onClick: function () {
                props.onChange(addDays(current, 1));
              },
            },
            '顺延一天'
          )
        : null
    )
  );
}

function RecurrenceSelect(props) {
  return h(
    'select',
    {
      className: 'kanban__select',
      value: props.value || '',
      'aria-label': '重复',
      onChange: function (event) {
        props.onChange(event.target.value || null);
      },
    },
    h('option', { value: '' }, '不重复'),
    h('option', { value: 'daily' }, '每天'),
    h('option', { value: 'weekly' }, '每周'),
    h('option', { value: 'monthly' }, '每月')
  );
}

export { DatePicker, ErrorBanner, IconButton, Menu, MenuItem, RecurrenceSelect, SaveIndicator };
