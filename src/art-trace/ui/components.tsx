// src/art-trace/ui/components.tsx
//
// 基础控件层。**插件里所有界面都只用这里的控件** —— 这是"风格统一"唯一可靠的实现
// 方式：靠人记住"按钮该多高"是不可能的，靠"只有一个按钮实现"才是可能的。
//
// ============================================================
// 四条与宿主适配有关的硬约束（写在这里，因为这里是唯一需要遵守它们的地方）
// ============================================================
//
// 1. **不能用 Tailwind 工具类。** 插件的样式来自它自己的 `index.css`（宿主只外链
//    这一个文件），而 Tailwind 的产物是在构建宿主时扫描宿主源码生成的 ——
//    插件里写的 `bg-white` 不在那次扫描范围内，**类名存在但没有任何规则**。
//    症状是"在开发机上正常、在用户那里完全走样"。
//
// 2. **没有 preflight。** 插件文档只有 `html, body { margin: 0; padding: 0 }` 与
//    `#modulith-root { min-height: 100% }`。没有 `box-sizing: border-box`，
//    `h1` 是 2em 粗体，`button` 有 UA 边框，`p` 有外边距。全部要自己重置。
//    （`index.css` 的第一段做这件事。）
//
// 3. **z-index 被困在这个 iframe 里。** 插件写 `z-index: 99999` 也盖不住宿主的标题栏
//    （z-50）与通知浮层（z-70）。需要跨出这块面板的对话框要用 `ctx.ui.dialog`
//    （由宿主渲染）。这里因此**不提供 Modal 组件** —— 提供一个半成品只会诱使别人用它。
//
// 4. **画布底色不是应用底。** iframe 带宿主的 `bg-white`：浅色实际是 `#ffffff`
//    （不是 gray-50），深色是 `#1a1e2b`。因此"面板"要比画布**亮**（浅色模式）或
//    比画布**暗**（深色模式），而这两个方向是相反的 —— 写死一个方向就会有一半坏掉。

import type { CSSProperties, ReactNode, ChangeEvent } from 'react';
import { React } from '../env';
import { IconAlert, IconCheck, IconInfo, IconX } from './icons';

/** 拼类名。`undefined` / `false` 会被丢掉 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(' ');
}

// ============================================================
// 按钮
// ============================================================

export type ButtonVariant = 'primary' | 'default' | 'subtle' | 'danger';
export type ButtonSize = 'sm' | 'md';

interface ButtonProps {
  children?: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  /** 前置图标 */
  icon?: ReactNode;
  title?: string;
  active?: boolean;
  /** 撑满宽度 */
  block?: boolean;
  className?: string;
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  disabled = false,
  icon,
  title,
  active = false,
  block = false,
  className,
}: ButtonProps) {
  return (
    <button
      // `type="button"`：默认是 `submit`，而宿主给插件文档开了 `allow-forms`。
      // 一个没写 type 的按钮如果恰好落在一个 form 里，点它会触发表单提交，
      // 而 CSP 的 `form-action 'none'` 会把导航挡掉 —— 界面还在，但那次点击
      // 什么都没发生。写明 type 就没有这个可能。
      type="button"
      className={cx(
        'arttrace__btn',
        `arttrace__btn--${variant}`,
        size === 'sm' && 'arttrace__btn--sm',
        active && 'is-active',
        block && 'arttrace__btn--block',
        className
      )}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active || undefined}
    >
      {icon ? <span className="arttrace__btn-icon">{icon}</span> : null}
      {children ? <span className="arttrace__btn-label">{children}</span> : null}
    </button>
  );
}

// ============================================================
// 面板与分区
// ============================================================

interface PanelProps {
  title?: ReactNode;
  /** 标题右侧的操作区 */
  actions?: ReactNode;
  children?: ReactNode;
  /** 去掉内边距（表格类内容自己管） */
  flush?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Panel({ title, actions, children, flush, className, style }: PanelProps) {
  return (
    <section className={cx('arttrace__panel', className)} style={style}>
      {title || actions ? (
        <header className="arttrace__panel-head">
          {title ? <h3 className="arttrace__panel-title">{title}</h3> : <span />}
          {actions ? <div className="arttrace__panel-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('arttrace__panel-body', flush && 'arttrace__panel-body--flush')}>
        {children}
      </div>
    </section>
  );
}

/** 一行"标签 + 值"，用于参数展示 */
export function KeyValue({
  label,
  value,
  mono,
  title,
}: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="arttrace__kv" title={title}>
      <span className="arttrace__kv-key">{label}</span>
      <span className={cx('arttrace__kv-value', mono && 'is-mono')}>{value}</span>
    </div>
  );
}

/** 一个统计数字 */
export function Stat({
  value,
  label,
  tone,
}: {
  value: ReactNode;
  label: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  return (
    <div className={cx('arttrace__stat', tone && `arttrace__stat--${tone}`)}>
      <span className="arttrace__stat-value">{value}</span>
      <span className="arttrace__stat-label">{label}</span>
    </div>
  );
}

// ============================================================
// 表单
// ============================================================

export function Field({
  label,
  hint,
  children,
  wide,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  /** 让这一项独占整行 */
  wide?: boolean;
}) {
  return (
    <label className={cx('arttrace__field', wide && 'arttrace__field--wide')}>
      <span className="arttrace__label">{label}</span>
      {children}
      {hint ? <span className="arttrace__hint">{hint}</span> : null}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  disabled,
  maxLength,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  maxLength?: number;
}) {
  return (
    <input
      type="text"
      className={cx('arttrace__input', mono && 'is-mono')}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={maxLength}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 5,
  mono,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <textarea
      className={cx('arttrace__textarea', mono && 'is-mono')}
      value={value}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  disabled?: boolean;
}) {
  return (
    <div className="arttrace__select-wrap">
      <select
        className="arttrace__select"
        value={value}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLSelectElement>) =>
          onChange(event.target.value as T)
        }
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="arttrace__select-caret" aria-hidden="true" />
    </div>
  );
}

/** 开关。用 `role="switch"` 而不是 `<input type="checkbox">` 的视觉替身 */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={cx('arttrace__toggle', disabled && 'is-disabled')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={cx('arttrace__switch', checked && 'is-on')}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
        disabled={disabled}
      >
        <span className="arttrace__switch-knob" />
      </button>
      <span className="arttrace__toggle-text">
        <span className="arttrace__toggle-label">{label}</span>
        {hint ? <span className="arttrace__hint">{hint}</span> : null}
      </span>
    </div>
  );
}

/** 分段选择器。选项少（2~4 个）时比下拉更省一次点击 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="arttrace__seg" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={cx('arttrace__seg-item', value === option.value && 'is-active')}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** 数值输入（带范围约束）。它只接受有限数，非法输入回落为上一次的有效值 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  return (
    <span className="arttrace__number">
      <input
        type="number"
        className="arttrace__input"
        value={String(value)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const next = Number(event.target.value);
          // `NaN` 直接忽略：输入框清空时 `Number('')` 是 0，而 `Number('abc')` 是 NaN。
          // 后者写进状态会让整块界面显示出 `NaN`，那比"值没变"糟得多。
          if (!Number.isFinite(next)) return;
          onChange(Math.min(max, Math.max(min, next)));
        }}
      />
      {suffix ? <span className="arttrace__number-suffix">{suffix}</span> : null}
    </span>
  );
}

// ============================================================
// 展示
// ============================================================

export function Tag({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span className={cx('arttrace__tag', className)} title={title}>
      {children}
    </span>
  );
}

export function Banner({
  tone = 'info',
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  children: ReactNode;
  action?: ReactNode;
}) {
  const glyph =
    tone === 'success' ? (
      <IconCheck size={15} />
    ) : tone === 'error' || tone === 'warn' ? (
      <IconAlert size={15} />
    ) : (
      <IconInfo size={15} />
    );
  return (
    <div className={cx('arttrace__banner', `arttrace__banner--${tone}`)} role="status">
      <span className="arttrace__banner-icon">{glyph}</span>
      <div className="arttrace__banner-text">{children}</div>
      {action ? <div className="arttrace__banner-action">{action}</div> : null}
    </div>
  );
}

/** 空状态。宿主的实测样式是"图标 gray-300 + 文字 gray-500 + 大内边距" */
export function Empty({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="arttrace__empty">
      {icon ? <span className="arttrace__empty-icon">{icon}</span> : null}
      <p className="arttrace__empty-title">{title}</p>
      {hint ? <p className="arttrace__empty-hint">{hint}</p> : null}
      {action ? <div className="arttrace__empty-action">{action}</div> : null}
    </div>
  );
}

/**
 * 加载态。
 *
 * 用四条脉冲竖条而不是转圈的大 spinner —— 与宿主一致（宿主的占位就是这样）。
 * 大小与语气都刻意压到最低：它是"等待"，不是内容。
 */
export function Loading({ text }: { text?: ReactNode }) {
  return (
    <div className="arttrace__loading" role="status" aria-live="polite">
      <span className="arttrace__loading-bars" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      {text ? <span className="arttrace__loading-text">{text}</span> : null}
    </div>
  );
}

/** 定量进度条。`value` 是 0..1 */
export function Progress({ value, label }: { value: number; label?: ReactNode }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className="arttrace__progress" role="progressbar" aria-valuenow={Math.round(clamped * 100)}>
      <div className="arttrace__progress-track">
        <div
          className="arttrace__progress-bar"
          style={{ width: `${Math.round(clamped * 100)}%` }}
        />
      </div>
      {label ? <span className="arttrace__progress-label">{label}</span> : null}
    </div>
  );
}

/** 标签页 */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: Array<{ value: T; label: string; badge?: number }>;
}) {
  return (
    <div className="arttrace__tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          className={cx('arttrace__tab', value === tab.value && 'is-active')}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
          {tab.badge !== undefined ? (
            <span className="arttrace__tab-badge">{tab.badge}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** 代码块：等宽、可滚动、带复制按钮 */
export function CodeBlock({
  text,
  onCopy,
  maxHeight = 220,
  empty = '（空）',
}: {
  text: string;
  onCopy?: (text: string) => void;
  maxHeight?: number;
  empty?: string;
}) {
  const value = text ?? '';
  return (
    <div className="arttrace__code">
      <div className="arttrace__code-head">
        <span className="arttrace__code-size">
          {value.length > 0 ? `${value.length} 字符` : empty}
        </span>
        {value.length > 0 && onCopy ? (
          <Button size="sm" variant="subtle" onClick={() => onCopy(value)}>
            复制
          </Button>
        ) : null}
      </div>
      <pre className="arttrace__code-body" style={{ maxHeight }}>
        {value.length > 0 ? value : empty}
      </pre>
    </div>
  );
}

/** 一个可关闭的提示条（插件自己画的，不依赖宿主浮层） */
export function Notice({
  tone = 'info',
  message,
  onDismiss,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  message: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={cx('arttrace__notice', `arttrace__notice--${tone}`)}>
      <span className="arttrace__notice-text">{message}</span>
      {onDismiss ? (
        <button
          type="button"
          className="arttrace__notice-close"
          onClick={onDismiss}
          aria-label="关闭"
        >
          <IconX size={13} />
        </button>
      ) : null}
    </div>
  );
}

/** 表格外壳。列宽由调用方用 `<col>` 或样式控制 */
export function Table({
  head,
  children,
  empty,
  dense,
}: {
  head: ReactNode;
  children: ReactNode;
  empty?: ReactNode;
  dense?: boolean;
}) {
  return (
    <div className="arttrace__table-wrap">
      <table className={cx('arttrace__table', dense && 'is-dense')}>
        <thead>{head}</thead>
        <tbody>{children}</tbody>
      </table>
      {empty ? <div className="arttrace__table-empty">{empty}</div> : null}
    </div>
  );
}

/** 可滚动的区域。插件里几乎每一块内容都需要它 */
export function Scroll({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={cx('arttrace__scroll', className)} style={style}>
      {children}
    </div>
  );
}
