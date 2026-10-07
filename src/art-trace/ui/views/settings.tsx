// src/art-trace/ui/views/settings.tsx
//
// 设置：身份信息、追踪编号、输出命名、成品标注、性能与容量，以及**能力与限制**。
//
// ============================================================
// 为什么把「能力与限制」当成一块正经内容，而不是放到关于页
// ============================================================
//
// 这个插件的每一条边界都会在用户那里表现成"某个功能时好时坏"：
//
//   * 文件授权是**会话级**的 —— 关掉这块界面就失效，于是"插件坏了"；
//   * LSB 水印**只在不重编码的 PNG 上可靠** —— 发出去转一手就没了，于是"水印没用"；
//   * 宿主 `ctx.storage.clear()` 在当前版本会连带删掉插件数据目录 —— 用它等于删台账。
//
// 这三条都不会报错，只会让人在别处得出错误结论。因此它们写在这块界面上、用同一个
// 视觉层级，而不是藏在文档里。
//
// ============================================================
// 与「批量清理」页共用同一份身份信息
// ============================================================
//
// `prefs.identity` 同时驱动水印文案、追加信息与台账。两处各填一遍必然会不一致 ——
// 而那种不一致只有在收到一张标着别人名字的成片时才会被发现。

import { React, useEffect, useState } from '../../env';
import {
  Banner,
  Button,
  Field,
  KeyValue,
  NumberInput,
  Panel,
  Scroll,
  Tag,
  TextInput,
  Toggle,
} from '../components';
import { IconAlert, IconHash, IconInfo, IconRefresh, IconShield } from '../icons';
import { previewTraceId, setView, updatePrefs, useStore } from '../store';
import type { Identity } from '../store';
import { canAccessFiles, ctx, files } from '../../env';
import { todayStamp } from '../../trace/payload';

/** 身份信息的八个字段。与「批量清理」页是同一批，因此这里只声明一次表单布局 */
const IDENTITY_FIELDS: Array<{ key: keyof Identity; label: string; hint?: string }> = [
  { key: 'author', label: '作者 Author' },
  { key: 'platform', label: '平台 Platform' },
  { key: 'profile', label: '主页 Profile', hint: '作品页或店铺地址' },
  { key: 'contact', label: '联系方式 Contact' },
  { key: 'license', label: '授权 License' },
  { key: 'order', label: '订单号 Order', hint: '只进水印与台账，不写进元数据' },
  { key: 'buyer', label: '买家 Buyer', hint: '只进水印与台账，不写进元数据' },
  { key: 'extra', label: '备注 Extra', hint: '写进 Description' },
];

/** 把布尔值画成一行"能/不能"。`{false}` 在 JSX 里会渲染成空 —— 必须显式转成字符串 */
function yesNo(value: boolean): string {
  return value ? '是' : '否';
}

export function SettingsView() {
  const state = useStore();
  const prefs = state.prefs;
  const identity = prefs.identity;

  // ============================================================
  // 下一个编号的预览
  // ============================================================
  //
  // 预览要**真的去查一遍台账**（序号不能与已用的撞上），因此它是异步的。这里存的是
  // 一句可以直接显示的文本，而不是"编号对象" —— 界面需要的信息只有那一串。
  const [traceId, setTraceId] = useState('正在生成…');
  // 点「重新生成预览」时 +1，用来触发下面那个 effect 再跑一遍。
  const [regen, setRegen] = useState(0);

  useEffect(() => {
    let alive = true;
    // 防抖 300ms：前缀是一个字符一个字符敲进去的，每敲一下都去查一次台账会连着发出
    // 十几次查询，而且每次都会让序号往前试一段 —— 那种抖动看起来像"预览自己在跳"。
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const id = await previewTraceId();
          if (alive) setTraceId(id);
        } catch {
          // 预览失败**不是**严重问题：真正生成时还会再算一遍，而那时才有意义。
          // 但必须给一句话 —— 停在上一个编号上会让人以为它是新算出来的。
          if (alive) setTraceId('算不出来（检查台账是否可读）');
        }
      })();
    }, 300);
    return () => {
      // 卸载之后不能再 setState：宿主对"标签页保活"的实现意味着这个组件可能被切走
      // 而没被销毁，一个迟到的 setState 会让已卸载组件的树白白重渲染一次。
      alive = false;
      clearTimeout(timer);
    };
  }, [prefs.idPrefix, regen]);

  const notifyReady = ctx.notifications.isAvailable();

  return (
    <Scroll className="arttrace__col">
      <Panel
        title="身份信息"
        actions={<span className="arttrace__faint">水印文案与追加信息共用这一份</span>}
      >
        <span className="arttrace__hint">
          这八个字段同时驱动三样东西：水印文案里的占位符、成品里追加的文本块、以及台账记录。
          两处各填一遍必然会不一致，因此只有这一份。
        </span>
        <div className="arttrace__form-grid">
          {IDENTITY_FIELDS.map((field) => (
            <Field key={field.key} label={field.label} hint={field.hint}>
              <TextInput
                value={identity[field.key]}
                onChange={(value) =>
                  updatePrefs({ identity: { ...identity, [field.key]: value } })
                }
              />
            </Field>
          ))}
        </div>
        <span className="arttrace__hint">
          订单号与买家只进水印与台账，不写进成品元数据 —— 印在画面上的订单号会把
          「这一份发给了谁」变成所有人都看得见的信息。
        </span>
      </Panel>

      <Panel
        title="追踪编号"
        actions={
          <Button
            size="sm"
            variant="subtle"
            icon={<IconRefresh size={12} />}
            onClick={() => setRegen((value) => value + 1)}
          >
            重新生成预览
          </Button>
        }
      >
        <div className="arttrace__form-grid">
          <Field
            label="编号前缀"
            hint="只保留字母与数字并转成大写 —— 中划线是分隔符，前缀里再有中划线会让编号有歧义"
          >
            <TextInput
              mono
              value={prefs.idPrefix}
              onChange={(value) => updatePrefs({ idPrefix: value })}
            />
          </Field>
          <Field label="下一个编号" hint={`今天：${todayStamp()}`}>
            {/* 用 `Tag` 而不是一行等宽文本：编号在台账与批量页里都是这个形状，
                三处长得一样，用户扫一眼就能对上号。 */}
            <Tag
              className="arttrace__tag--mono"
              title="这是预览，正式编号在每一张开始处理时才落定"
            >
              {traceId}
            </Tag>
          </Field>
        </div>
        <span className="arttrace__hint">
          格式是 <code>&lt;前缀&gt;-&lt;yyyyMMdd&gt;-&lt;序号4位&gt;-&lt;随机4位十六进制&gt;</code>。
          序号会持久化，并且会在生成前先查一遍台账，避免与已经发出去的编号撞上。
          日期用本地时间：用户对"今天发的"有自己的理解，而 UTC 会在晚上差一天。
        </span>
        <Banner tone="warn">
          随机段只有 65536 种取值，它防的是「别人照着格式仿造一个编号」，不是防伪。
          真正能对上号的是台账里的两个 SHA-256 —— 它记的是这一份成品的字节指纹。
        </Banner>
      </Panel>

      <Panel title="输出命名" actions={<span className="arttrace__faint">在「批量清理」页生效</span>}>
        <div className="arttrace__form-grid">
          <Field label="文件名前缀" hint="留空则不前缀">
            <TextInput
              value={prefs.outputPrefix}
              onChange={(value) => updatePrefs({ outputPrefix: value })}
            />
          </Field>
          <Field label="文件名后缀" hint="留空时用追踪编号">
            <TextInput
              value={prefs.outputSuffix}
              onChange={(value) => updatePrefs({ outputSuffix: value })}
            />
          </Field>
        </div>
        <Toggle
          checked={prefs.confirmOverwrite}
          label="写出前提示会覆盖已有的同名文件"
          hint="关掉之后同名文件会被「直接覆盖且不提示」—— 输出目录里如果有别的工具生成的文件，建议留着这一条。"
          onChange={(value) => updatePrefs({ confirmOverwrite: value })}
        />
        <span className="arttrace__hint">
          后缀留空时用追踪编号，因此同一张图跑两次会得到两个不同的文件名 ——
          这也是"每一份副本都能单独追"的前提。
        </span>
      </Panel>

      <Panel title="成品标注" actions={<span className="arttrace__faint">写进元数据的 Software</span>}>
        <Toggle
          checked={prefs.writeSoftware}
          label="写入 Software 标签"
          hint="它是一句「这张图经过了什么工具处理」的说明。如果你的工作流要求成品看不出处理痕迹，就关掉它。"
          onChange={(value) => updatePrefs({ writeSoftware: value })}
        />
        <Field label="软件名" hint="写进 Software 那一行的文本">
          <TextInput
            value={prefs.softwareName}
            disabled={!prefs.writeSoftware}
            onChange={(value) => updatePrefs({ softwareName: value })}
          />
        </Field>
      </Panel>

      <Panel title="性能与容量" actions={<span className="arttrace__faint">只影响界面</span>}>
        <Field label="台账每页条数" hint="台账会一直长，分页让「翻到最早那一条」不需要把全部记录拉进内存">
          <NumberInput
            value={prefs.pageSize}
            min={10}
            max={500}
            suffix="条 / 页"
            onChange={(value) => updatePrefs({ pageSize: Math.round(value) })}
          />
        </Field>
        <span className="arttrace__hint">
          台账存在宿主的 SQLite 里（不是 `ctx.storage`）：那个一层是"一键一个 JSON"、
          单值上限 1 MB，装不下几千条记录，也没有查询 —— 而"按编号查出当初发给了谁"
          这件事必须由数据库来做。
        </span>
      </Panel>

      <Panel
        title="能力与限制"
        actions={
          <span className="arttrace__faint">
            <IconShield size={12} /> 由宿主决定，不是插件设置
          </span>
        }
      >
        <span className="arttrace__label">宿主能力</span>
        <KeyValue
          label="文件访问（ctx.files）"
          value={yesNo(canAccessFiles)}
          title="当前宿主有没有提供 ctx.files。没有它，这个插件的全部功能都用不了"
        />
        <KeyValue
          label="可以读用户选的文件"
          value={files ? yesNo(files.isAvailable()) : '不适用'}
          title="对应清单里的 filesystem-read 权限与宿主实现"
        />
        <KeyValue
          label="可以拿到可写目录"
          value={files ? yesNo(files.canWrite()) : '不适用'}
          title="对应清单里的 filesystem-scoped。为否时「选择输出目录」会拿不到可写授权"
        />
        <KeyValue
          label="应用内通知"
          value={yesNo(notifyReady)}
          title="对应清单里的 notification 权限。为否时批量完成只在插件的这一层提示"
        />

        <div className="arttrace__sep" />

        <Banner tone="warn">
          <strong>文件访问是会话级授权。</strong>
          授权绑在「这个插件 + 这块界面」上：关掉界面、停用插件、或者退出应用之后，
          之前拿到的目录授权全部作废。因此不要把授权句柄当长期权限用 ——
          它是"你刚刚在对话框里点了确定"这件事的凭据，不是"这个目录归我管"。
        </Banner>

        <Banner tone="info">
          <strong>隐形水印只在 PNG 上可靠。</strong>
          它藏在像素最低位里，任何有损重编码（JPEG / WebP 的常规保存、聊天软件转发时的
          压缩）都会把最低位冲掉。抗裁切的能力取决于载荷占了多少像素通道 ——
          冗余份数越多越耐裁切，也越容易被转码抹掉。
        </Banner>

        <Banner tone="error">
          <strong>本插件不使用 `ctx.storage.clear()`。</strong>
          宿主当前版本里，它会连带删除插件的数据目录 —— 那会把台账（SQLite 文件）一起删掉，
          而台账是这个工具唯一不可重建的数据。要清空记录请用「追踪台账」页的「清空台账」，
          它只删表里的行。
        </Banner>
      </Panel>

      <Panel title="危险区" actions={<span className="arttrace__faint">在台账页操作</span>}>
        <span className="arttrace__hint">
          清空台账的按钮不在这一页，它在「追踪台账」页的底部。理由是那个动作的对象
          （记录列表与它的条数）就在那一页上 —— 把"清空 1284 条记录"放在一个只有开关的
          设置页里，用户看不到自己将要删掉什么。
        </span>
        <div className="arttrace__row">
          <Button size="sm" variant="subtle" onClick={() => setView('ledger')}>
            去追踪台账
          </Button>
          <span className="arttrace__muted arttrace__row">
            <IconInfo size={12} />
            <span>那边还有「写入检查」，可以拿一张流出的图反查记录。</span>
          </span>
        </div>
        <span className="arttrace__row arttrace__muted">
          <IconHash size={12} />
          <span>
            这一页没有任何会立刻生效的破坏性动作：下面所有输入都只是偏好，改错了再改回来即可。
          </span>
        </span>
        <span className="arttrace__row arttrace__muted">
          <IconAlert size={12} />
          <span>唯一不可撤销的数据是台账，而它只在台账页被删。</span>
        </span>
      </Panel>
    </Scroll>
  );
}
