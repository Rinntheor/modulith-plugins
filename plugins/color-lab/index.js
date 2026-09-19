// plugins/color-lab/index.js
//
// 颜色与对比度工具 —— 解析一种颜色、看清它的多种写法、生成整套色阶、
// 并按 WCAG 算出它和另一个颜色之间的对比度是否达标。
//
// 手写 IIFE，不使用构建工具，因此不能写 JSX，全部用 `React.createElement`（简写为 h）。
//
// 只申请一项权限：
//   storage —— 记住主色、背景色与导出偏好
// 不申请其它任何权限：所有计算都是纯数学，在本机内存里完成。
//
// 四个决定写在最前面：
//
// 1. **对比度按 WCAG 的定义算，不按「看起来差不多」。** 先把 sRGB 做线性化，
//    再取 0.2126R + 0.7152G + 0.0722B 作为相对亮度，最后用 (L亮+0.05)/(L暗+0.05)。
//    直接用亮度平均值是常见错误，它会把橙色这类颜色算得过于乐观。
//
// 2. **颜色解析失败时不沿用上一次的结果。** 输入半个颜色（例如刚删到 #4f）时，
//    如果继续拿上一次的颜色去画色阶与对比度，用户看到的是「输入框里的东西」
//    与「屏幕上的东西」不一致 —— 这正是最难发现的一类问题。这里解析不出来就显示空态。
//
// 3. **色阶由基色推导，锚点档精确等于基色。** 用户把基色填进 --color-600，
//    就应当在色阶里看到完全一样的那一格；靠固定明度表生成会让锚点偏色。
//
// 4. **色盲模拟在线性 RGB 上做。** 那几组矩阵是为线性光强设计的，直接套在
//    sRGB 数值上会让模拟结果整体偏亮，进而让「两种颜色在色盲眼里是否还分得开」
//    这个判断失准。

(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    console.error('[color-lab] 未找到 window.Modulith，插件无法加载');
    return;
  }

  var React = Modulith.React;
  var h = React.createElement;
  var useEffect = React.useEffect;
  var useMemo = React.useMemo;
  var useRef = React.useRef;
  var useState = React.useState;

  // createContext() 只能在加载期调用，因此在这里取一次并长期持有。
  var ctx = Modulith.createContext();

  // ============================================================
  // 存储键。只允许字母数字与 . _ -，最长 128 字符
  // ============================================================

  var KEY_SETTINGS = 'settings';
  var KEY_MAIN = 'draft.main';
  var KEY_BG = 'draft.bg';

  var DRAFT_SAVE_MS = 600;

  var SCALE_STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];

  var DEFAULT_SETTINGS = {
    /** 色阶里哪一档等于基色。宿主自己的 --accent-600 就是基色，因此默认 600 */
    anchor: 600,
    variablePrefix: '--color',
  };

  /**
   * 常见颜色名。
   *
   * 只收常用的一批，不做完整的 CSS 命名色表 —— 一张 148 项的对照表放在这里，
   * 既占地方，也让人以为「所有颜色名都支持」。界面上会如实说明这个范围。
   */
  var NAMED_COLORS = {
    black: '#000000',
    white: '#ffffff',
    red: '#ff0000',
    lime: '#00ff00',
    blue: '#0000ff',
    yellow: '#ffff00',
    cyan: '#00ffff',
    aqua: '#00ffff',
    magenta: '#ff00ff',
    fuchsia: '#ff00ff',
    silver: '#c0c0c0',
    gray: '#808080',
    grey: '#808080',
    maroon: '#800000',
    olive: '#808000',
    green: '#008000',
    purple: '#800080',
    teal: '#008080',
    navy: '#000080',
    orange: '#ffa500',
    pink: '#ffc0cb',
    brown: '#a52a2a',
    gold: '#ffd700',
    indigo: '#4b0082',
    violet: '#ee82ee',
    tomato: '#ff6347',
    coral: '#ff7f50',
    salmon: '#fa8072',
    khaki: '#f0e68c',
    crimson: '#dc143c',
    orchid: '#da70d6',
    plum: '#dda0dd',
    tan: '#d2b48c',
    beige: '#f5f5dc',
    ivory: '#fffff0',
    lavender: '#e6e6fa',
    skyblue: '#87ceeb',
    steelblue: '#4682b4',
    royalblue: '#4169e1',
    dodgerblue: '#1e90ff',
    seagreen: '#2e8b57',
    forestgreen: '#228b22',
    darkgreen: '#006400',
    darkred: '#8b0000',
    darkblue: '#00008b',
    darkgray: '#a9a9a9',
    darkgrey: '#a9a9a9',
    lightgray: '#d3d3d3',
    lightgrey: '#d3d3d3',
    slategray: '#708090',
    dimgray: '#696969',
    dimgrey: '#696969',
    whitesmoke: '#f5f5f5',
    gainsboro: '#dcdcdc',
    transparent: '#00000000',
  };

  var COLOR_BLIND_MODES = [
    { id: 'protanopia', name: '红色盲', note: '看不清红色，红与深绿容易混' },
    { id: 'deuteranopia', name: '绿色盲', note: '最常见的类型，红绿都受影响' },
    { id: 'tritanopia', name: '蓝色盲', note: '蓝与黄容易混，比较少见' },
  ];

  // ============================================================
  // 颜色解析
  // ============================================================

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  /** 十六进制字符串 → { r, g, b, a }（0–255 与 0–1），不认识返回 null */
  function parseHex(text) {
    var body = text.charAt(0) === '#' ? text.slice(1) : text;
    if (!/^[0-9a-f]+$/.test(body)) return null;
    if (body.length !== 3 && body.length !== 4 && body.length !== 6 && body.length !== 8) return null;

    if (body.length === 3 || body.length === 4) {
      var expanded = '';
      for (var i = 0; i < body.length; i += 1) expanded += body.charAt(i) + body.charAt(i);
      body = expanded;
    }

    var r = parseInt(body.slice(0, 2), 16);
    var g = parseInt(body.slice(2, 4), 16);
    var b = parseInt(body.slice(4, 6), 16);
    var a = body.length === 8 ? parseInt(body.slice(6, 8), 16) / 255 : 1;
    return { r: r, g: g, b: b, a: a };
  }

  /** 解析一个数字或百分比分量 */
  function parseComponent(token, max) {
    var text = String(token).trim();
    if (text.charAt(text.length - 1) === '%') {
      var percent = Number(text.slice(0, -1));
      if (!isFinite(percent)) return null;
      return clamp((percent / 100) * max, 0, max);
    }
    var value = Number(text);
    if (!isFinite(value)) return null;
    return clamp(value, 0, max);
  }

  function parseColor(input) {
    var text = String(input === undefined || input === null ? '' : input).trim().toLowerCase();
    if (!text) return null;

    if (text.charAt(0) === '#') return parseHex(text);
    if (NAMED_COLORS[text]) return parseHex(NAMED_COLORS[text]);

    var fn = text.match(/^(rgba?|hsla?)\(([^)]*)\)$/);
    if (fn) {
      var kind = fn[1];
      var parts = fn[2].split(/[\s,/]+/).filter(function (part) {
        return part.length > 0;
      });

      if (kind === 'rgb' || kind === 'rgba') {
        if (parts.length < 3) return null;
        var r = parseComponent(parts[0], 255);
        var g = parseComponent(parts[1], 255);
        var b = parseComponent(parts[2], 255);
        if (r === null || g === null || b === null) return null;
        var alpha = 1;
        if (parts.length >= 4) {
          var raw = parseComponent(parts[3], 1);
          if (raw === null) return null;
          alpha = raw;
        }
        return { r: r, g: g, b: b, a: alpha };
      }

      if (parts.length < 3) return null;
      var hue = Number(String(parts[0]).replace(/deg$/, ''));
      var sat = Number(String(parts[1]).replace('%', ''));
      var light = Number(String(parts[2]).replace('%', ''));
      if (!isFinite(hue) || !isFinite(sat) || !isFinite(light)) return null;
      var hslAlpha = 1;
      if (parts.length >= 4) {
        hslAlpha = parseComponent(parts[3], 1);
        if (hslAlpha === null) return null;
      }
      var converted = hslToRgb({ h: ((hue % 360) + 360) % 360, s: clamp(sat, 0, 100), l: clamp(light, 0, 100) });
      return { r: converted.r, g: converted.g, b: converted.b, a: hslAlpha };
    }

    // 不带 # 的纯十六进制也接受，这是从各种地方复制颜色时最常见的样子
    if (/^[0-9a-f]{3,8}$/.test(text)) return parseHex('#' + text);

    return null;
  }

  function colorError(input) {
    var text = String(input || '').trim();
    if (!text) return null;
    if (parseColor(text)) return null;

    if (text.charAt(0) === '#' || /^[0-9a-f]+$/i.test(text)) {
      return {
        error: '这不是一个能读出来的颜色值。',
        hint: '十六进制颜色需要 3、4、6 或 8 位字符，例如 #4f46e5、#fff、#4f46e580（末两位是透明度）。',
      };
    }
    if (/^(rgba?|hsla?)\(/.test(text)) {
      return {
        error: '括号里的内容读不出来。',
        hint: 'rgb 需要三个 0–255 的数字（或百分比），hsl 需要色相、饱和度%、明度%，透明度可选，例如 rgba(79,70,229,0.8)。',
      };
    }
    return {
      error: '无法识别这个颜色写法。',
      hint: '可以试试 #4f46e5、rgb(79,70,229)、hsl(243,75%,59%)，或者常见颜色名（如 tomato、steelblue）。本工具只收常用颜色名，不是完整的 CSS 颜色名表。',
    };
  }

  // ============================================================
  // 颜色换算
  // ============================================================

  function toHexByte(value) {
    var rounded = clamp(Math.round(value), 0, 255);
    var text = rounded.toString(16);
    return text.length < 2 ? '0' + text : text;
  }

  function toHex6(color) {
    return '#' + toHexByte(color.r) + toHexByte(color.g) + toHexByte(color.b);
  }

  function toHex8(color) {
    return toHex6(color) + toHexByte(color.a * 255);
  }

  function toRgbText(color) {
    return 'rgb(' + Math.round(color.r) + ', ' + Math.round(color.g) + ', ' + Math.round(color.b) + ')';
  }

  function toRgbaText(color) {
    return (
      'rgba(' +
      Math.round(color.r) +
      ', ' +
      Math.round(color.g) +
      ', ' +
      Math.round(color.b) +
      ', ' +
      round(color.a, 2) +
      ')'
    );
  }

  function round(value, digits) {
    var factor = Math.pow(10, digits);
    return Math.round(value * factor) / factor;
  }

  function rgbToHsl(color) {
    var r = color.r / 255;
    var g = color.g / 255;
    var b = color.b / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var light = (max + min) / 2;
    var hue = 0;
    var sat = 0;

    if (max !== min) {
      var delta = max - min;
      sat = light > 0.5 ? delta / (2 - max - min) : delta / (max + min);
      if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
      else if (max === g) hue = ((b - r) / delta + 2) / 6;
      else hue = ((r - g) / delta + 4) / 6;
    }

    return { h: hue * 360, s: sat * 100, l: light * 100 };
  }

  function hslToRgb(hsl) {
    var h = (((hsl.h % 360) + 360) % 360) / 360;
    var s = clamp(hsl.s, 0, 100) / 100;
    var l = clamp(hsl.l, 0, 100) / 100;

    if (s === 0) {
      var gray = l * 255;
      return { r: gray, g: gray, b: gray, a: 1 };
    }

    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;

    function channel(t) {
      var value = t;
      if (value < 0) value += 1;
      if (value > 1) value -= 1;
      if (value < 1 / 6) return p + (q - p) * 6 * value;
      if (value < 1 / 2) return q;
      if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
      return p;
    }

    return {
      r: channel(h + 1 / 3) * 255,
      g: channel(h) * 255,
      b: channel(h - 1 / 3) * 255,
      a: 1,
    };
  }

  function toHslText(color) {
    var hsl = rgbToHsl(color);
    return 'hsl(' + Math.round(hsl.h) + ', ' + Math.round(hsl.s) + '%, ' + Math.round(hsl.l) + '%)';
  }

  function toHslaText(color) {
    var hsl = rgbToHsl(color);
    return (
      'hsla(' +
      Math.round(hsl.h) +
      ', ' +
      Math.round(hsl.s) +
      '%, ' +
      Math.round(hsl.l) +
      '%, ' +
      round(color.a, 2) +
      ')'
    );
  }

  // ---- OKLCH：现代 CSS 里越来越常用，但它不是普通的 HSL 变体 ----

  function srgbToLinear(channel) {
    var c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function toOklch(color) {
    var r = srgbToLinear(color.r);
    var g = srgbToLinear(color.g);
    var b = srgbToLinear(color.b);

    var l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    var m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    var s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

    var lRoot = Math.cbrt(l);
    var mRoot = Math.cbrt(m);
    var sRoot = Math.cbrt(s);

    var lightness = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot;
    var aAxis = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
    var bAxis = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;

    var chroma = Math.sqrt(aAxis * aAxis + bAxis * bAxis);
    var hue = Math.atan2(bAxis, aAxis) * (180 / Math.PI);
    if (hue < 0) hue += 360;

    return { l: lightness, c: chroma, h: hue };
  }

  function toOklchText(color) {
    var oklch = toOklch(color);
    return (
      'oklch(' +
      round(oklch.l * 100, 1) +
      '% ' +
      round(oklch.c, 4) +
      ' ' +
      round(oklch.h, 1) +
      ')'
    );
  }

  // ---- 相对亮度与对比度（WCAG 2.x 的定义） ----

  function relativeLuminance(color) {
    return (
      0.2126 * srgbToLinear(color.r) + 0.7152 * srgbToLinear(color.g) + 0.0722 * srgbToLinear(color.b)
    );
  }

  function contrastRatio(a, b) {
    var la = relativeLuminance(a);
    var lb = relativeLuminance(b);
    var lighter = Math.max(la, lb);
    var darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /** 把半透明的颜色压到不透明底色上，得到实际呈现出来的颜色 */
  function compositeOver(color, background) {
    if (color.a >= 1) return { r: color.r, g: color.g, b: color.b, a: 1 };
    return {
      r: color.r * color.a + background.r * (1 - color.a),
      g: color.g * color.a + background.g * (1 - color.a),
      b: color.b * color.a + background.b * (1 - color.a),
      a: 1,
    };
  }

  /**
   * 对比度。
   *
   * **必须先合成再比较。** 半透明的文字压在背景上，眼睛看到的是合成后的颜色；
   * 直接拿通道值比较会把 rgba(0,0,0,0.6) 这种「看着还行」的文字算得过暗或过亮，
   * 得出的达标结论于是不可信。半透明的背景再叠到白底上算 —— 假定页面底色是白的，
   * 这一点在界面上说明。
   */
  function contrastOn(foreground, background) {
    var base = compositeOver(background, { r: 255, g: 255, b: 255, a: 1 });
    var front = compositeOver(foreground, base);
    return contrastRatio(front, base);
  }

  /** 在给定背景上，白字与黑字哪个更清楚 */
  function bestTextColor(background) {
    var white = { r: 255, g: 255, b: 255, a: 1 };
    var black = { r: 0, g: 0, b: 0, a: 1 };
    return contrastOn(white, background) >= contrastOn(black, background) ? white : black;
  }

  /**
   * 沿明度方向调整文字色，直到与背景的对比度达标。
   *
   * 为什么不直接返回黑或白：品牌色被调成纯黑往往会毁掉设计意图。
   * 这里优先在同一个色相上加深或提亮，实在达不到才退到黑/白。
   */
  function adjustUntilContrast(foreground, background, target) {
    if (contrastOn(foreground, background) >= target) return foreground;

    var backgroundIsLight = relativeLuminance(compositeOver(background, { r: 255, g: 255, b: 255, a: 1 })) > 0.5;
    var base = rgbToHsl(foreground);

    for (var step = 1; step <= 100; step += 1) {
      var lightness = backgroundIsLight ? base.l - step : base.l + step;
      if (lightness < 0 || lightness > 100) break;
      var candidate = hslToRgb({ h: base.h, s: base.s, l: lightness });
      if (contrastOn(candidate, background) >= target) return candidate;
    }

    return backgroundIsLight ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  }

  // ---- 色阶 ----

  /**
   * 由基色推导整套色阶。
   *
   * 锚点档**精确等于基色** —— 用户把基色当作 --color-600 用时，
   * 色阶里那一格必须就是他填的那个颜色，差一点都会让人怀疑取错了色。
   * 其余档以锚点为界，向近白与近黑两端插值。
   */
  function buildScale(baseColor, anchor) {
    var base = rgbToHsl(baseColor);
    var anchorIndex = SCALE_STOPS.indexOf(anchor);
    if (anchorIndex < 0) anchorIndex = 6;

    return SCALE_STOPS.map(function (stop, index) {
      if (index === anchorIndex) {
        return { stop: stop, color: { r: baseColor.r, g: baseColor.g, b: baseColor.b, a: 1 }, isAnchor: true };
      }

      var lightness;
      if (index < anchorIndex) {
        // 向近白插值：50 档落在 97%
        lightness = 97 + (base.l - 97) * (index / anchorIndex);
      } else {
        // 向近黑插值：900 档落在 12%
        lightness = base.l + (12 - base.l) * ((index - anchorIndex) / (SCALE_STOPS.length - 1 - anchorIndex));
      }

      // 浅色档略降饱和度：否则浅色会显得发脏；深色档略提，避免糊成一团黑
      var saturation = base.s;
      if (index < anchorIndex) saturation = base.s * (0.55 + 0.45 * (index / Math.max(anchorIndex, 1)));
      else saturation = Math.min(100, base.s * 1.05);

      var color = hslToRgb({ h: base.h, s: saturation, l: clamp(lightness, 0, 100) });
      return { stop: stop, color: { r: color.r, g: color.g, b: color.b, a: 1 }, isAnchor: false };
    });
  }

  // ---- 色盲模拟 ----

  var COLOR_BLIND_MATRICES = {
    protanopia: [0.567, 0.433, 0, 0.558, 0.442, 0, 0, 0.242, 0.758],
    deuteranopia: [0.625, 0.375, 0, 0.7, 0.3, 0, 0, 0.3, 0.7],
    tritanopia: [0.95, 0.05, 0, 0, 0.433, 0.567, 0, 0.475, 0.525],
  };

  function linearToSrgb(channel) {
    var c = clamp(channel, 0, 1);
    return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  function simulateColorBlindness(color, mode) {
    var matrix = COLOR_BLIND_MATRICES[mode];
    if (!matrix) return color;

    var r = srgbToLinear(color.r);
    var g = srgbToLinear(color.g);
    var b = srgbToLinear(color.b);

    var nr = matrix[0] * r + matrix[1] * g + matrix[2] * b;
    var ng = matrix[3] * r + matrix[4] * g + matrix[5] * b;
    var nb = matrix[6] * r + matrix[7] * g + matrix[8] * b;

    return {
      r: linearToSrgb(nr) * 255,
      g: linearToSrgb(ng) * 255,
      b: linearToSrgb(nb) * 255,
      a: color.a,
    };
  }

  // ============================================================
  // 判定与文案
  // ============================================================

  function ratioText(ratio) {
    return round(ratio, 2).toFixed(2) + ':1';
  }

  function levelText(ratio) {
    if (ratio >= 7) return '很高';
    if (ratio >= 4.5) return '达到正文标准';
    if (ratio >= 3) return '只够大字与界面元素';
    if (ratio >= 2) return '偏低';
    return '几乎看不清';
  }

  var WCAG_CHECKS = [
    { id: 'body-aa', label: '正文 AA', target: 4.5, note: '小于 18.66px 的常规文字' },
    { id: 'body-aaa', label: '正文 AAA', target: 7, note: '更严格的正文标准' },
    { id: 'large-aa', label: '大字 AA', target: 3, note: '18.66px 以上的粗体，或 24px 以上' },
    { id: 'large-aaa', label: '大字 AAA', target: 4.5, note: '更严格的大字标准' },
    { id: 'ui', label: '界面元素', target: 3, note: '图标、输入框描边、图表这类非文字内容' },
  ];

  function normalizeSettings(raw) {
    var out = {
      anchor: DEFAULT_SETTINGS.anchor,
      variablePrefix: DEFAULT_SETTINGS.variablePrefix,
    };
    if (raw && typeof raw === 'object') {
      if (SCALE_STOPS.indexOf(raw.anchor) >= 0) out.anchor = raw.anchor;
      if (typeof raw.variablePrefix === 'string' && /^[A-Za-z][A-Za-z0-9-]*$/.test(raw.variablePrefix)) {
        out.variablePrefix = raw.variablePrefix;
      }
    }
    return out;
  }

  function classNames() {
    var out = [];
    for (var i = 0; i < arguments.length; i += 1) {
      if (arguments[i]) out.push(arguments[i]);
    }
    return out.join(' ');
  }

  function buildCssVariables(scale, prefix) {
    return scale
      .map(function (entry) {
        return '  ' + prefix + '-' + entry.stop + ': ' + toHex6(entry.color) + ';';
      })
      .join('\n');
  }

  // ============================================================
  // 主组件
  // ============================================================

  function ColorLab() {
    var active = Modulith.useModuleActive();

    var loadedState = useState(false);
    var loaded = loadedState[0];
    var setLoaded = loadedState[1];

    var mainState = useState('#4f46e5');
    var mainText = mainState[0];
    var setMainText = mainState[1];

    var bgState = useState('#ffffff');
    var bgText = bgState[0];
    var setBgText = bgState[1];

    var settingsState = useState(DEFAULT_SETTINGS);
    var settings = settingsState[0];
    var setSettings = settingsState[1];

    var noticeState = useState(null);
    var notice = noticeState[0];
    var setNotice = noticeState[1];

    var mainColor = useMemo(
      function () {
        return parseColor(mainText);
      },
      [mainText]
    );

    var bgColor = useMemo(
      function () {
        return parseColor(bgText);
      },
      [bgText]
    );

    var mainProblem = useMemo(
      function () {
        return colorError(mainText);
      },
      [mainText]
    );

    var bgProblem = useMemo(
      function () {
        return colorError(bgText);
      },
      [bgText]
    );

    var scale = useMemo(
      function () {
        if (!mainColor) return null;
        return buildScale(mainColor, settings.anchor);
      },
      [mainColor, settings.anchor]
    );

    var cssVariables = useMemo(
      function () {
        if (!scale) return '';
        return buildCssVariables(scale, settings.variablePrefix);
      },
      [scale, settings.variablePrefix]
    );

    // ----------------------------------------------------------
    // 存储
    // ----------------------------------------------------------

    useEffect(function () {
      var alive = true;
      Promise.all([
        ctx.storage.get(KEY_SETTINGS, null).catch(function (err) {
          ctx.logger.warn('读取设置失败', err);
          return null;
        }),
        ctx.storage.get(KEY_MAIN, '').catch(function (err) {
          ctx.logger.warn('读取主色失败', err);
          return '';
        }),
        ctx.storage.get(KEY_BG, '').catch(function (err) {
          ctx.logger.warn('读取背景色失败', err);
          return '';
        }),
      ])
        .then(function (values) {
          if (!alive) return;
          setSettings(normalizeSettings(values[0]));
          if (typeof values[1] === 'string' && values[1]) setMainText(values[1]);
          if (typeof values[2] === 'string' && values[2]) setBgText(values[2]);
          setLoaded(true);
        })
        .catch(function (err) {
          // 兜底：少了它界面会永远停在「正在准备」。上面每一项都已各自兜过一次，
          // 这里防的是整理数据时出错。
          ctx.logger.error('读取颜色设置时出错，已按默认值继续', err);
          if (alive) setLoaded(true);
        });
      return function () {
        alive = false;
      };
    }, []);

    useEffect(function () {
      if (!loaded) return undefined;
      var timer = setTimeout(function () {
        ctx.storage.set(KEY_MAIN, mainText).catch(function (err) {
          ctx.logger.warn('保存主色失败', err);
        });
      }, DRAFT_SAVE_MS);
      return function () {
        clearTimeout(timer);
      };
    }, [loaded, mainText]);

    useEffect(function () {
      if (!loaded) return undefined;
      var timer = setTimeout(function () {
        ctx.storage.set(KEY_BG, bgText).catch(function (err) {
          ctx.logger.warn('保存背景色失败', err);
        });
      }, DRAFT_SAVE_MS);
      return function () {
        clearTimeout(timer);
      };
    }, [loaded, bgText]);

    useEffect(function () {
      if (!loaded) return undefined;
      var timer = setTimeout(function () {
        ctx.storage.set(KEY_SETTINGS, settings).catch(function (err) {
          ctx.logger.warn('保存设置失败', err);
        });
      }, DRAFT_SAVE_MS);
      return function () {
        clearTimeout(timer);
      };
    }, [loaded, settings]);

    useEffect(function () {
      if (!notice) return undefined;
      if (notice.kind === 'warn') return undefined;
      if (!active) return undefined;
      var timer = setTimeout(function () {
        setNotice(null);
      }, 5000);
      return function () {
        clearTimeout(timer);
      };
    }, [notice, active]);

    // ----------------------------------------------------------
    // 操作
    // ----------------------------------------------------------

    function copy(value, label) {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        setNotice({ kind: 'warn', text: '这个环境不允许直接写剪贴板，可以手动选中复制。' });
        return;
      }
      navigator.clipboard.writeText(value).then(
        function () {
          setNotice({ kind: 'success', text: '已复制：' + label });
        },
        function (err) {
          ctx.logger.warn('写剪贴板失败', err);
          setNotice({ kind: 'warn', text: '复制没有成功，可以手动选中复制。' });
        }
      );
    }

    function swapColors() {
      setMainText(bgText);
      setBgText(mainText);
    }

    function applyContrastFix(target) {
      if (!mainColor || !bgColor) return;
      var fixed = adjustUntilContrast(mainColor, bgColor, target);
      setMainText(toHex6(fixed));
      setNotice({
        kind: 'info',
        text: '已把颜色调整到与背景达到 ' + target + ':1（当前 ' + ratioText(contrastOn(fixed, bgColor)) + '）。',
      });
    }

    // ----------------------------------------------------------
    // 渲染零件
    // ----------------------------------------------------------

    function renderNotice() {
      if (!notice) return null;
      return h(
        'div',
        {
          className: classNames('colorlab__notice', notice.kind === 'warn' && 'colorlab__notice--warn'),
          role: 'status',
        },
        h('span', { className: 'colorlab__notice-text' }, notice.text),
        h(
          'button',
          {
            type: 'button',
            className: 'colorlab__notice-close',
            'aria-label': '关闭这条提示',
            onClick: function () {
              setNotice(null);
            },
          },
          '关闭'
        )
      );
    }

    function renderColorField(options) {
      var id = options.id;
      var label = options.label;
      var value = options.value;
      var parsed = options.parsed;
      var problem = options.problem;
      var onChange = options.onChange;

      return h(
        'div',
        { className: 'colorlab__field' },
        h('label', { className: 'colorlab__label', htmlFor: id }, label),
        h(
          'div',
          { className: 'colorlab__field-row' },
          h('span', {
            className: 'colorlab__swatch',
            style: { background: parsed ? toHex8(parsed) : 'transparent' },
            'aria-hidden': 'true',
          }),
          h('input', {
            id: id,
            className: 'colorlab__input colorlab__input--mono',
            type: 'text',
            spellCheck: false,
            autoComplete: 'off',
            value: value,
            placeholder: '#4f46e5',
            'aria-invalid': problem ? 'true' : 'false',
            onChange: function (event) {
              onChange(event.target.value);
            },
          }),
          h('input', {
            className: 'colorlab__picker',
            type: 'color',
            value: parsed ? toHex6(parsed) : '#000000',
            'aria-label': label + '的取色器',
            onChange: function (event) {
              onChange(event.target.value);
            },
          })
        ),
        problem
          ? h(
              'p',
              { className: 'colorlab__field-error', role: 'alert' },
              problem.error + ' ' + problem.hint
            )
          : null
      );
    }

    function renderFormatRow(label, value, copyLabel) {
      return h(
        'div',
        { className: 'colorlab__format-row', key: label },
        h('span', { className: 'colorlab__format-label' }, label),
        h('code', { className: 'colorlab__format-value' }, value),
        h(
          'button',
          {
            type: 'button',
            className: 'colorlab__button colorlab__button--small',
            'aria-label': '复制' + label,
            onClick: function () {
              copy(value, copyLabel || label);
            },
          },
          '复制'
        )
      );
    }

    function renderFormats() {
      if (!mainColor) {
        return h(
          'div',
          { className: 'colorlab__empty' },
          h('p', { className: 'colorlab__empty-title' }, '还没有可用的颜色'),
          h('p', { className: 'colorlab__empty-hint' }, '在上面填一个能读出来的颜色，这里会列出它的各种写法。')
        );
      }
      var rows = [
        { label: '十六进制', value: toHex6(mainColor) },
        { label: '十六进制（含透明度）', value: toHex8(mainColor) },
        { label: 'RGB', value: toRgbText(mainColor) },
        { label: 'RGBA', value: toRgbaText(mainColor) },
        { label: 'HSL', value: toHslText(mainColor) },
        { label: 'HSLA', value: toHslaText(mainColor) },
        { label: 'OKLCH（现代写法）', value: toOklchText(mainColor) },
        { label: '相对亮度', value: round(relativeLuminance(mainColor), 4) + '（按不透明计算，用于算对比度）' },
      ];
      return h(
        'div',
        { className: 'colorlab__formats' },
        rows.map(function (row) {
          return renderFormatRow(row.label, row.value);
        })
      );
    }

    function renderScale() {
      if (!scale) {
        return h(
          'div',
          { className: 'colorlab__empty' },
          h('p', { className: 'colorlab__empty-title' }, '色阶需要一个有效的颜色'),
          h('p', { className: 'colorlab__empty-hint' }, '填好主色之后，这里会给出以它为锚点的十档色阶。')
        );
      }

      return h(
        'div',
        { className: 'colorlab__scale' },
        h(
          'div',
          { className: 'colorlab__scale-bar' },
          scale.map(function (entry) {
            var textColor = bestTextColor(entry.color);
            return h(
              'button',
              {
                key: entry.stop,
                type: 'button',
                className: classNames('colorlab__scale-step', entry.isAnchor && 'colorlab__scale-step--anchor'),
                style: { background: toHex6(entry.color), color: toHex6(textColor) },
                title: '把 ' + entry.stop + ' 档（' + toHex6(entry.color) + '）设为主色',
                'aria-label': entry.stop + ' 档 ' + toHex6(entry.color) + '，点击设为主色',
                onClick: function () {
                  setMainText(toHex6(entry.color));
                },
              },
              h('span', { className: 'colorlab__scale-stop' }, String(entry.stop)),
              h('span', { className: 'colorlab__scale-hex' }, toHex6(entry.color).slice(1))
            );
          })
        ),
        h(
          'div',
          { className: 'colorlab__scale-meta' },
          h(
            'span',
            { className: 'colorlab__muted' },
            '锚点档是 ' + settings.anchor + '：这一格与主色完全相同，其余档由它向两端推导。'
          ),
          h(
            'div',
            { className: 'colorlab__option-group', role: 'group', 'aria-label': '锚点档' },
            SCALE_STOPS.map(function (stop) {
              var on = settings.anchor === stop;
              return h(
                'button',
                {
                  key: stop,
                  type: 'button',
                  className: classNames('colorlab__option', on && 'colorlab__option--on'),
                  'aria-pressed': on,
                  onClick: function () {
                    setSettings(function (prev) {
                      return Object.assign({}, prev, { anchor: stop });
                    });
                  },
                },
                String(stop)
              );
            })
          )
        )
      );
    }

    function renderColorBlind() {
      if (!mainColor) return null;
      return h(
        'div',
        { className: 'colorlab__blind' },
        COLOR_BLIND_MODES.map(function (mode) {
          var simulated = simulateColorBlindness(mainColor, mode.id);
          return h(
            'div',
            { className: 'colorlab__blind-item', key: mode.id },
            h('span', { className: 'colorlab__blind-swatch', style: { background: toHex6(simulated) } }),
            h(
              'div',
              { className: 'colorlab__blind-text' },
              h('span', { className: 'colorlab__blind-name' }, mode.name),
              h('code', { className: 'colorlab__blind-hex' }, toHex6(simulated)),
              h('span', { className: 'colorlab__muted' }, mode.note)
            )
          );
        })
      );
    }

    function renderContrast() {
      if (!mainColor || !bgColor) {
        return h(
          'div',
          { className: 'colorlab__empty' },
          h('p', { className: 'colorlab__empty-title' }, '需要两个有效的颜色'),
          h(
            'p',
            { className: 'colorlab__empty-hint' },
            '上面是文字色，下面是背景色。两者都能读出来时，这里会给出对比度与达标情况。'
          )
        );
      }

      var ratio = contrastOn(mainColor, bgColor);
      var white = { r: 255, g: 255, b: 255, a: 1 };
      var black = { r: 0, g: 0, b: 0, a: 1 };
      var onWhite = contrastOn(mainColor, white);
      var onBlack = contrastOn(mainColor, black);

      return h(
        'div',
        { className: 'colorlab__contrast' },
        h(
          'div',
          { className: 'colorlab__preview', style: { background: toHex6(bgColor), color: toHex6(mainColor) } },
          h('p', { className: 'colorlab__preview-large' }, '大号文字效果'),
          h('p', { className: 'colorlab__preview-body' }, '这一段是用来实际看效果的正文。对比度算出来是 ' + ratioText(ratio) + '。')
        ),
        h(
          'div',
          { className: 'colorlab__ratio' },
          h('span', { className: 'colorlab__ratio-value' }, ratioText(ratio)),
          h('span', { className: 'colorlab__ratio-level' }, levelText(ratio))
        ),
        h(
          'table',
          { className: 'colorlab__table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { scope: 'col' }, '场景'),
              h('th', { scope: 'col' }, '要求'),
              h('th', { scope: 'col' }, '结果')
            )
          ),
          h(
            'tbody',
            null,
            WCAG_CHECKS.map(function (check) {
              var passed = ratio >= check.target;
              return h(
                'tr',
                { key: check.id },
                h(
                  'td',
                  null,
                  h('span', { className: 'colorlab__check-label' }, check.label),
                  h('span', { className: 'colorlab__check-note' }, check.note)
                ),
                h('td', { className: 'colorlab__cell-num' }, check.target + ':1'),
                h(
                  'td',
                  { className: classNames('colorlab__cell-num', passed ? 'colorlab__pass' : 'colorlab__fail') },
                  passed ? '通过' : '不通过'
                )
              );
            })
          )
        ),
        h(
          'div',
          { className: 'colorlab__fix' },
          h('span', { className: 'colorlab__label' }, '文字色候选'),
          h(
            'div',
            { className: 'colorlab__fix-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'colorlab__button colorlab__button--small',
                onClick: function () {
                  setMainText('#ffffff');
                },
              },
              '白字 ' + ratioText(onWhite)
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'colorlab__button colorlab__button--small',
                onClick: function () {
                  setMainText('#000000');
                },
              },
              '黑字 ' + ratioText(onBlack)
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'colorlab__button colorlab__button--small',
                disabled: ratio >= 4.5,
                onClick: function () {
                  applyContrastFix(4.5);
                },
              },
              '自动调到 4.5:1'
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'colorlab__button colorlab__button--small',
                disabled: ratio >= 7,
                onClick: function () {
                  applyContrastFix(7);
                },
              },
              '自动调到 7:1'
            )
          )
        )
      );
    }

    function renderExport() {
      if (!scale) return null;
      return h(
        'div',
        { className: 'colorlab__export' },
        h(
          'div',
          { className: 'colorlab__export-head' },
          h('span', { className: 'colorlab__label' }, '变量名前缀'),
          h('input', {
            className: 'colorlab__input colorlab__input--mono colorlab__input--short',
            type: 'text',
            value: settings.variablePrefix,
            spellCheck: false,
            'aria-label': 'CSS 变量名前缀',
            onChange: function (event) {
              setSettings(function (prev) {
                return Object.assign({}, prev, { variablePrefix: event.target.value });
              });
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'colorlab__button colorlab__button--small',
              onClick: function () {
                copy(cssVariables, 'CSS 变量');
              },
            },
            '复制这段变量'
          )
        ),
        h('pre', { className: 'colorlab__export-text' }, cssVariables)
      );
    }

    if (!loaded) {
      return h('div', { className: 'colorlab' }, h('p', { className: 'colorlab__muted' }, '正在准备颜色工具…'));
    }

    return h(
      'div',
      { className: 'colorlab' },
      h(
        'header',
        { className: 'colorlab__header' },
        h('h1', { className: 'colorlab__title' }, '颜色与对比度'),
        h(
          'p',
          { className: 'colorlab__subtitle' },
          '看清一种颜色的各种写法，由它推出一整套色阶，并按 WCAG 标准算出它与背景的对比度是否达标。所有计算都是本机完成的纯数学。'
        )
      ),
      renderNotice(),
      h(
        'div',
        { className: 'colorlab__fields' },
        renderColorField({
          id: 'colorlab-main',
          label: '主色（文字色）',
          value: mainText,
          parsed: mainColor,
          problem: mainProblem,
          onChange: setMainText,
        }),
        h(
          'div',
          { className: 'colorlab__fields-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'colorlab__button',
              onClick: swapColors,
              title: '把主色与背景色对调',
            },
            '对调'
          )
        ),
        renderColorField({
          id: 'colorlab-bg',
          label: '背景色',
          value: bgText,
          parsed: bgColor,
          problem: bgProblem,
          onChange: setBgText,
        })
      ),
      h(
        'div',
        { className: 'colorlab__body' },
        h(
          'section',
          { className: 'colorlab__pane', 'aria-label': '颜色的各种写法与色阶' },
          h('h2', { className: 'colorlab__pane-title' }, '这种颜色的写法'),
          h('div', { className: 'colorlab__panel' }, renderFormats()),
          h('h2', { className: 'colorlab__pane-title' }, '色阶'),
          h('div', { className: 'colorlab__panel' }, renderScale()),
          h('h2', { className: 'colorlab__pane-title' }, '色盲模拟'),
          h('div', { className: 'colorlab__panel' }, renderColorBlind())
        ),
        h(
          'section',
          { className: 'colorlab__pane', 'aria-label': '对比度检查' },
          h('h2', { className: 'colorlab__pane-title' }, '对比度检查'),
          h('div', { className: 'colorlab__panel' }, renderContrast()),
          h('h2', { className: 'colorlab__pane-title' }, '导出为 CSS 变量'),
          h('div', { className: 'colorlab__panel' }, renderExport())
        )
      ),
      h(
        'footer',
        { className: 'colorlab__footer' },
        h(
          'span',
          { className: 'colorlab__muted' },
          '对比度按 WCAG 的定义计算：先对每个通道做线性化，再取相对亮度，最后比较。'
        ),
        h('span', { className: 'colorlab__muted' }, '色盲模拟是近似算法，用于自查而非诊断。')
      )
    );
  }

  // ============================================================
  // 注册模块
  //
  // 必须在加载期**同步**调用。
  // ============================================================

  Modulith.registerModule({
    id: 'colorLab',
    name: '颜色与对比度',
    displayName: '颜色与对比度',
    description: '看清颜色的各种写法、推出一整套色阶、按 WCAG 算对比度',
    icon: 'icon.svg',
    priority: 82,
    component: ColorLab,
  });

  ctx.logger.info('颜色与对比度工具加载完成');
})();
