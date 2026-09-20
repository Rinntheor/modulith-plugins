// 从 plugins/kanban/index.js 拆出 —— **逻辑原样搬运，未做任何改动**。
// 搬运是机械的：每块的位置与内容都没变，只是补上了 import / export。
import { h } from './env';

// ---------------------------------------------------------------------------
// 图标：内联 SVG，不引入图标库
// ---------------------------------------------------------------------------

function icon(size, children) {
  return h(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    children
  );
}

var icons = {
  plus: function (size) {
    return icon(size || 16, [h('path', { key: 'a', d: 'M12 5v14' }), h('path', { key: 'b', d: 'M5 12h14' })]);
  },
  search: function () {
    return icon(15, [
      h('circle', { key: 'a', cx: 11, cy: 11, r: 7 }),
      h('path', { key: 'b', d: 'M20 20l-3.6-3.6' }),
    ]);
  },
  grip: function (size) {
    return icon(size || 14, [h('path', { key: 'a', d: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01' })]);
  },
  pencil: function () {
    return icon(14, [h('path', { key: 'a', d: 'M4 20h4L18 10l-4-4L4 16v4z' }), h('path', { key: 'b', d: 'M13.5 6.5l4 4' })]);
  },
  arrowRight: function () {
    return icon(14, [h('path', { key: 'a', d: 'M5 12h14' }), h('path', { key: 'b', d: 'M13 6l6 6-6 6' })]);
  },
  arrowLeft: function () {
    return icon(14, [h('path', { key: 'a', d: 'M19 12H5' }), h('path', { key: 'b', d: 'M11 6l-6 6 6 6' })]);
  },
  trash: function () {
    return icon(14, [
      h('path', { key: 'a', d: 'M4 7h16' }),
      h('path', { key: 'b', d: 'M7 7l1 13h8l1-13' }),
      h('path', { key: 'c', d: 'M9 7V4h6v3' }),
    ]);
  },
  check: function () {
    return icon(14, [h('path', { key: 'a', d: 'M5 13l4 4L19 7' })]);
  },
  undo: function () {
    return icon(14, [h('path', { key: 'a', d: 'M9 14L4 9l5-5' }), h('path', { key: 'b', d: 'M4 9h10a6 6 0 0 1 0 12h-3' })]);
  },
  calendar: function (size) {
    return icon(size || 13, [
      h('rect', { key: 'a', x: 3.5, y: 5, width: 17, height: 15, rx: 2 }),
      h('path', { key: 'b', d: 'M8 3v4M16 3v4M3.5 10h17' }),
    ]);
  },
  repeat: function (size) {
    return icon(size || 13, [
      h('path', { key: 'a', d: 'M4 9h11a4 4 0 0 1 0 8H7' }),
      h('path', { key: 'b', d: 'M7 5L3 9l4 4' }),
    ]);
  },
  note: function (size) {
    return icon(size || 13, [h('path', { key: 'a', d: 'M5 5h14M5 10h14M5 15h9' })]);
  },
  bell: function (size) {
    return icon(size || 14, [
      h('path', { key: 'a', d: 'M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z' }),
      h('path', { key: 'b', d: 'M10 19a2 2 0 0 0 4 0' }),
    ]);
  },
  bellOff: function (size) {
    return icon(size || 14, [
      h('path', { key: 'a', d: 'M8 6.3A6 6 0 0 1 18 9c0 1.6.3 2.8.7 3.7' }),
      h('path', { key: 'b', d: 'M6 9.6C5.8 12.4 4.6 14 4 15h11' }),
      h('path', { key: 'c', d: 'M4 4l16 16' }),
    ]);
  },
  close: function () {
    return icon(16, [h('path', { key: 'a', d: 'M6 6l12 12' }), h('path', { key: 'b', d: 'M18 6L6 18' })]);
  },
  inbox: function (size) {
    return icon(size || 14, [
      h('path', { key: 'a', d: 'M4 13l2-7h12l2 7v6H4z' }),
      h('path', { key: 'b', d: 'M4 13h5l1 2h4l1-2h5' }),
    ]);
  },
  columns: function (size) {
    return icon(size || 14, [
      h('rect', { key: 'a', x: 3, y: 5, width: 7, height: 14, rx: 1.6 }),
      h('rect', { key: 'b', x: 14, y: 5, width: 7, height: 14, rx: 1.6 }),
    ]);
  },
  more: function (size) {
    return icon(size || 14, [
      h('path', { key: 'a', d: 'M12 6h.01M12 12h.01M12 18h.01' }),
    ]);
  },
};

export { icon, icons };
