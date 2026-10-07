// src/art-trace/ui/views/watermark.tsx
//
// 水印设计：可见水印的排版与隐形水印的载荷。
//
// ============================================================
// 为什么这里必须有一个真实的预览，而不是只给一排输入框
// ============================================================
//
// 水印是一类**只能看出来、看不出来就一定是错的**设置：
//
//   * 字号比例 0.026 在 1024 宽的图上看起来刚好，在 300 宽的小图上会糊成一团；
//   * "自动墨水"要测量水印底下那块区域的亮度 —— 那件事只有渲染出来才知道结果；
//   * 三行文案可能长到把画面下方的四分之一盖住。
//
// 因此这一页的预览不是装饰，它是唯一能回答"这组参数长什么样"的地方。预览走的是
// 与成品**完全同一条**渲染路径（同一份 `previewWatermark` 背后的排版与绘制代码），
// 只有"缩放"和"不写 LSB"两点不同。

import type { ReactNode } from 'react';
import { React, useMemo, useState } from '../../env';
import {
  Banner,
  Button,
  CodeBlock,
  Empty,
  Field,
  KeyValue,
  NumberInput,
  Panel,
  Scroll,
  Segmented,
  Select,
  Stat,
  Tag,
  TextArea,
  Toggle,
} from '../components';
import { IconEye, IconImage, IconRefresh } from '../icons';
import { ViewBar } from '../view-chrome';
import {
  copyText,
  previewTraceId,
  resolvedLines,
  resolvedPayload,
  updatePrefs,
  useStore,
} from '../store';
import { MAX_PAYLOAD_BYTES, PREVIEW_MAX_WIDTH, canAccessFiles, files } from '../../env';
import { formatBytes } from '../../codec/bytes';
import { channelCapacityBytes } from '../../watermark/invisible';
import { decodeToPixels } from '../../watermark/pixels';
import { previewWatermark } from '../../watermark/render';
import { createMeasurer, layoutWatermark } from '../../watermark/visible';
import {
  encodePayload,
  templatePlaceholders,
  unknownPlaceholders,
} from '../../trace/payload';
import type { VisibleWatermarkOptions } from '../../model/types';

/** 占位符的说明。界面上的可用变量列表就是它 */
const PLACEHOLDERS: Array<{ name: string; desc: string }> = [
  { name: 'author', desc: '作者名' },
  { name: 'platform', desc: '平台' },
  { name: 'profile', desc: '主页链接' },
  { name: 'contact', desc: '联系方式' },
  { name: 'license', desc: '授权协议' },
  { name: 'id', desc: '本次的追踪编号' },
  { name: 'date', desc: '日期 yyyyMMdd' },
  { name: 'buyer', desc: '买家 / 客户' },
  { name: 'order', desc: '订单号' },
  { name: 'extra', desc: '备注' },
];

interface PreviewState {
  dataUrl: string;
  lines: string[];
  ink: 'light' | 'dark' | 'none';
  width: number;
  height: number;
  /** 这张图的 LSB 信道总容量（字节） */
  capacityBytes: number;
  /** 这一次要写进去的字节数（含冗余份数） */
  payloadBytes: number;
  /** 占用率 0..1 */
  occupancy: number;
  /** 水印文案在这张图上实际占的画面高度比例 */
  textHeightRatio: number;
}

export function WatermarkView() {
  const state = useStore();
  const prefs = state.prefs;
  const visible = prefs.visible;
  const invisible = prefs.invisible;

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [nextId, setNextId] = useState<string>('');

  // 预览用的字段：真实编号拿不到时就先用一个占位编号 —— 预览的字号只跟文案长度有关，
  // 而占位符替换后的长度与真实编号几乎一致（编号长度是固定的）。
  const fields = useMemo(() => {
    const date = todayStampSafe();
    return {
      author: prefs.identity.author || '作者名',
      platform: prefs.identity.platform || '平台',
      profile: prefs.identity.profile,
      contact: prefs.identity.contact,
      license: prefs.identity.license,
      order: prefs.identity.order,
      buyer: prefs.identity.buyer,
      extra: prefs.identity.extra,
      id: nextId || 'AT-00000000-0001-0000',
      date,
    };
  }, [prefs.identity, nextId]);

  const lines = useMemo(() => resolvedLines(fields), [fields, visible.lines]);
  const payloadText = useMemo(() => resolvedPayload(fields), [fields, invisible.payloadTemplate]);

  const visiblePlaceholders = templatePlaceholders(visible.lines.join('\n'));
  const unknownVisible = unknownPlaceholders(visible.lines.join('\n'), PLACEHOLDERS.map((p) => p.name));
  const unknownPayload = unknownPlaceholders(invisible.payloadTemplate, PLACEHOLDERS.map((p) => p.name));

  const payloadBytes = useMemo(() => {
    try {
      return encodePayload(payloadText).length;
    } catch {
      return 0;
    }
  }, [payloadText]);

  const fetchNextId = (): void => {
    void previewTraceId()
      .then(setNextId)
      .catch(() => setNextId(''));
  };

  const runPreview = async (): Promise<void> => {
    const service = files;
    if (!service) return;
    setPreviewing(true);
    try {
      const picked = await service.pick({
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
        filterName: '用来做预览的图片',
      });
      if (picked.length === 0) return;

      const source = new Uint8Array(await service.read(picked[0].grant));

      // 容量必须按**原图**的像素数算，而不是按缩放后的预览图 —— 预览是为了看排版，
      // 而"这段话装不装得下"问的是成品。
      const pixels = await decodeToPixels(source);
      const capacityBytes = channelCapacityBytes(pixels.width * pixels.height);

      const total = payloadBytes * Math.max(1, Math.floor(invisible.redundancy));

      const rendered = await previewWatermark(
        source,
        { visible, invisible, fields },
        PREVIEW_MAX_WIDTH
      );

      // 文案占画面高度的比例：用它提醒"水印太大了"。
      let textHeightRatio = 0;
      try {
        const measure = createMeasurer();
        const layout = layoutWatermark(
          pixels.width,
          pixels.height,
          rendered.visibleLines,
          visible,
          measure
        );
        textHeightRatio = pixels.height > 0 ? layout.bounds.height / pixels.height : 0;
      } catch {
        textHeightRatio = 0;
      }

      setPreview({
        dataUrl: rendered.dataUrl,
        lines: rendered.visibleLines,
        ink: rendered.ink,
        width: pixels.width,
        height: pixels.height,
        capacityBytes,
        payloadBytes: total,
        occupancy: capacityBytes > 0 ? total / capacityBytes : 0,
        textHeightRatio,
      });

      // 这张授权只用来看一眼，用完还回去。
      await service.release(picked[0].grant).catch(() => {});
    } catch (error) {
      // 预览失败是常见事（图太大、格式怪），因此只说一句，不抛。
      setPreview(null);
      void error;
    } finally {
      setPreviewing(false);
    }
  };

  if (!canAccessFiles) {
    return (
      <>
        <ViewBar title="水印设计" subtitle="可见水印与隐形追踪水印" />
        <Banner tone="warn">
          当前宿主不提供 <code>ctx.files</code>，无法读取图片做预览与处理。
        </Banner>
      </>
    );
  }

  const setVisible = (patch: Partial<VisibleWatermarkOptions>): void => {
    updatePrefs({ visible: { ...visible, ...patch } });
  };

  return (
    <>
      <ViewBar
        title="水印设计"
        subtitle="可见水印负责署名与威慑，隐形水印负责取证"
        actions={
          <>
            <Button
              icon={<IconEye size={14} />}
              onClick={() => void runPreview()}
              disabled={previewing}
            >
              {previewing ? '渲染中…' : '用一张图预览'}
            </Button>
            <Button
              variant="subtle"
              size="sm"
              icon={<IconRefresh size={13} />}
              onClick={fetchNextId}
            >
              取下一个编号
            </Button>
          </>
        }
      />

      <div className="arttrace__split arttrace__split--wide-left">
        {/* ---- 左栏：参数 ---- */}
        <div className="arttrace__col">
          <Scroll className="arttrace__stack">
            <Panel
              title="可见水印"
              actions={
                <Toggle
                  checked={visible.enabled}
                  onChange={(value) => setVisible({ enabled: value })}
                  label={visible.enabled ? '已启用' : '已关闭'}
                />
              }
            >
              <Field
                label="水印文字（每行一条，第一行是主标题）"
                hint="可用占位符：{author} {platform} {profile} {contact} {license} {id} {date} {buyer} {order} {extra}。认不出的占位符会原样保留 —— 那是在提醒你名字打错了。"
                wide
              >
                <TextArea
                  value={visible.lines.join('\n')}
                  rows={4}
                  onChange={(value) => setVisible({ lines: value.split('\n').slice(0, 5) })}
                />
              </Field>

              {unknownVisible.length > 0 ? (
                <Banner tone="warn">
                  这些占位符不认识，会被原样画出来：{unknownVisible.map((n) => `{${n}}`).join('、')}
                </Banner>
              ) : null}

              <div className="arttrace__form-grid">
                <Field label="位置">
                  <Select
                    value={visible.layout}
                    onChange={(value) => setVisible({ layout: value })}
                    options={[
                      { value: 'bottom-right', label: '右下' },
                      { value: 'bottom-left', label: '左下' },
                      { value: 'bottom-center', label: '底部居中' },
                      { value: 'top-right', label: '右上' },
                      { value: 'top-left', label: '左上' },
                    ]}
                  />
                </Field>
                <Field label="样式">
                  <Segmented
                    value={visible.style}
                    onChange={(value) => setVisible({ style: value })}
                    options={[
                      { value: 'outline', label: '描边文字' },
                      { value: 'badge', label: '圆角底板' },
                    ]}
                  />
                </Field>
                <Field label="墨水颜色" hint="自动会测量水印底下那块区域的亮度">
                  <Segmented
                    value={visible.ink}
                    onChange={(value) => setVisible({ ink: value })}
                    options={[
                      { value: 'auto', label: '自动' },
                      { value: 'light', label: '浅色' },
                      { value: 'dark', label: '深色' },
                    ]}
                  />
                </Field>
                <Field label="主行字号" hint="图宽的倍数">
                  <NumberInput
                    value={visible.fontSizeRatio}
                    onChange={(value) => setVisible({ fontSizeRatio: value })}
                    min={0.008}
                    max={0.08}
                    step={0.002}
                  />
                </Field>
                <Field label="副行比例">
                  <NumberInput
                    value={visible.lineScale}
                    onChange={(value) => setVisible({ lineScale: value })}
                    min={0.4}
                    max={1}
                    step={0.02}
                  />
                </Field>
                <Field label="边距" hint="图宽的倍数">
                  <NumberInput
                    value={visible.marginRatio}
                    onChange={(value) => setVisible({ marginRatio: value })}
                    min={0.005}
                    max={0.12}
                    step={0.005}
                  />
                </Field>
                <Field label="不透明度" hint="0 = 全透明，255 = 不透明">
                  <NumberInput
                    value={visible.opacity}
                    onChange={(value) => setVisible({ opacity: value })}
                    min={16}
                    max={255}
                    step={5}
                  />
                </Field>
              </div>
            </Panel>

            <Panel
              title="隐形追踪水印"
              actions={
                <Toggle
                  checked={invisible.enabled}
                  onChange={(value) => updatePrefs({ invisible: { ...invisible, enabled: value } })}
                  label={invisible.enabled ? '已启用' : '已关闭'}
                />
              }
            >
              <Field
                label="载荷内容"
                hint={`写成 k=v|k=v 的形式最便于事后查阅。上限 ${MAX_PAYLOAD_BYTES} 字节（超出的部分会被按 UTF-8 边界截断）。`}
                wide
              >
                <TextArea
                  value={invisible.payloadTemplate}
                  rows={3}
                  mono
                  onChange={(value) =>
                    updatePrefs({ invisible: { ...invisible, payloadTemplate: value } })
                  }
                />
              </Field>

              {unknownPayload.length > 0 ? (
                <Banner tone="warn">
                  这些占位符不认识，会被原样写进载荷：{unknownPayload.map((n) => `{${n}}`).join('、')}
                </Banner>
              ) : null}

              <div className="arttrace__form-grid">
                <Field label="冗余份数" hint="整份载荷在像素里铺几遍。铺得越多越耐裁切，但改动面也越大。">
                  <NumberInput
                    value={invisible.redundancy}
                    onChange={(value) =>
                      updatePrefs({ invisible: { ...invisible, redundancy: value } })
                    }
                    min={1}
                    max={12}
                  />
                </Field>
              </div>

              <div className="arttrace__row arttrace__row--wrap">
                <Tag className="arttrace__tag--mono">载荷 {payloadBytes} 字节</Tag>
                <Tag className="arttrace__tag--mono">
                  本次写入 {payloadBytes * Math.max(1, Math.floor(invisible.redundancy))} 字节
                </Tag>
                {payloadBytes > MAX_PAYLOAD_BYTES ? (
                  <Tag className="arttrace__tag--bad">已超过单份上限</Tag>
                ) : null}
              </div>

              <div className="arttrace__stack arttrace__stack--tight">
                <span className="arttrace__label">渲染后的载荷</span>
                <CodeBlock text={payloadText} onCopy={(text) => void copyText(text, '载荷')} maxHeight={90} />
              </div>

              <Banner tone="info">
                隐形水印写在每个像素 RGB 的**最低位**，肉眼不可见（改动量 ≤ 1）。
                它只在**无损**链路里可靠：PNG 转存、复制都没问题，而转成 JPEG、缩放、
                截图会把它冲掉。因此**要把编号也放进可见水印里** —— 可见编号 + 台账
                才是可靠的追责链路。
              </Banner>
            </Panel>

            <Panel title="可用变量">
              <div className="arttrace__row arttrace__row--wrap">
                {PLACEHOLDERS.map((entry) => (
                  <Tag key={entry.name} className="arttrace__tag--mono" title={entry.desc}>
                    {`{${entry.name}}`}
                  </Tag>
                ))}
              </div>
              <p className="arttrace__hint">
                点一个变量不会自动插入 —— 直接在上面的文本框里输入即可。变量名区分大小写。
              </p>
            </Panel>
          </Scroll>
        </div>

        {/* ---- 右栏：预览与量化指标 ---- */}
        <div className="arttrace__col">
          <Panel
            className="arttrace__panel--fill"
            title="预览"
            actions={
              preview ? (
                <span className="arttrace__faint">
                  {preview.width} × {preview.height}
                </span>
              ) : null
            }
          >
            {preview ? (
              <div className="arttrace__canvas-wrap">
                <img src={preview.dataUrl} alt="水印预览" />
              </div>
            ) : (
              <Empty
                icon={<IconImage size={24} />}
                title="还没有预览"
                hint="点右上角「用一张图预览」选一张真实作品。预览走的是与成品完全相同的排版与绘制代码，只是缩小了尺寸、不写隐形水印。"
              />
            )}

            {preview ? (
              <div className="arttrace__stats">
                <Stat
                  value={preview.ink === 'none' ? '—' : preview.ink === 'light' ? '浅色' : '深色'}
                  label="墨水（自动判定）"
                />
                <Stat value={`${(preview.occupancy * 100).toFixed(1)}%`} label="LSB 信道占用" />
                <Stat
                  value={`${(preview.textHeightRatio * 100).toFixed(0)}%`}
                  label="文案占画面高度"
                  tone={preview.textHeightRatio > 0.2 ? 'warn' : 'default'}
                />
                <Stat value={formatBytes(preview.capacityBytes)} label="信道总容量" />
              </div>
            ) : null}

            {preview && preview.occupancy > 0.5 ? (
              <Banner tone="warn">
                载荷占了 {Math.round(preview.occupancy * 100)}% 的信道。占用过高时，
                失真会在纯色与渐变区域里积累成可见的噪点 —— 建议降低冗余份数或缩短载荷。
              </Banner>
            ) : null}

            {preview && preview.textHeightRatio > 0.2 ? (
              <Banner tone="warn">
                文案占了画面高度的 {Math.round(preview.textHeightRatio * 100)}%，
                可能会盖住主体。建议调小主行字号或删掉一行。
              </Banner>
            ) : null}

            {preview && preview.occupancy > 0 && preview.occupancy <= 0.15 ? (
              <Banner tone="info">
                载荷只占了 {Math.round(preview.occupancy * 100)}% 的信道。占用低意味着
                **裁掉一个角就可能把整份载荷一起裁掉** —— 抗裁切能力来自"载荷铺满图形"。
                想更耐裁切，就提高冗余份数。
              </Banner>
            ) : null}
          </Panel>

          <Panel title="这一组设置的实际效果">
            <div className="arttrace__stack arttrace__stack--tight">
              <span className="arttrace__label">可见水印渲染出来的文本</span>
              {lines.length > 0 ? (
                <div className="arttrace__stack arttrace__stack--tight">
                  {lines.map((line, index) => (
                    <div className="arttrace__row" key={`${line}-${index}`}>
                      <Tag className={index === 0 ? 'arttrace__tag--generator' : undefined}>
                        {index === 0 ? '主行' : `副行 ${index}`}
                      </Tag>
                      <span className="arttrace__grow">{line}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="arttrace__faint">
                  三行都是空的 —— 水印不会被画出来。检查上面的模板是不是只写了空行。
                </p>
              )}

              <div className="arttrace__sep" />

              <KeyValue label="追踪编号" mono value={nextId || '（点右上角取一个）'} />
              <KeyValue
                label="编号格式"
                value="<前缀>-<yyyyMMdd>-<序号4位>-<随机4位>"
              />
              <p className="arttrace__hint">
                序号会持久化，并在生成前查一遍台账 —— 因此**同一个编号不会发给两张不同的图**。
                那正是台账唯一要防的事。前缀在「设置」页修改。
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

/** `todayStamp` 的本地包装：仅用于预览里的 `{date}` */
function todayStampSafe(): string {
  const date = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}
