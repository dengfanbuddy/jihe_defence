import { ShopConfig } from '../data/configs/ShopConfig';
import type { BarState, Modifier } from './Modifier';
import type { Entity } from './Entity';

/**
 * ============================================================
 * StatusBar —— HUD 状态栏（英雄头像下方那一行）的**采集规则**（纯 TS，无 cc 依赖）
 * ============================================================
 *
 * ```
 *   英雄实体（Entity.modifiers）            HUD `buff_status` 下的 10 个格子
 *        │  Modifier 实例（真的挂在英雄身上）        ▲
 *        ▼                                        │ 每帧 read() → 逐格画「色块 + 短标 + 秒数/层数」
 *   StatusBar（本类）  白名单过滤 · 同键合并 · 排序
 * ```
 *
 * ── 为什么需要这一层（而不是让 UI 直接遍历 ModifierSystem）──
 *   ① **白名单**：英雄身上 89 条是永久 Modifier（遗物属性 / 技能载体 / 神器载体），
 *      全画出来就是十几格垃圾。只有配表标了 `bar_show` 的行才可能进栏。
 *   ② **同键合并**：共享模板 1000 的限时实例（药水 / 连击叠层 / 击杀回响临时攻速）
 *      定义名一律是「属性修改」，真正的名字在 `origin`（`item:3` / `relic:1021` / `ability:122`）；
 *      而「连击」的层数在**钩子实例**上、剩余时长在**模板实例**上 —— 两格并一格才对。
 *   ③ **排序**：格子只有 10 个（见 `docs/status-bar/README.md` §2），必须按
 *      「负面优先 → 有倒计时的优先 → 快没了的优先」排，不能靠遍历顺序。
 *   ④ **图标也由这一层取**（2026-11）：**来源的图标** —— 来源于遗物就取 `relics.icon`、
 *      技能就取 `abilities.icon`、药水就取 `battle_items.icon`，来源表没有才退到
 *      **这一行 Modifier 自己的 `icon`**（buff 图标）。理由：遗物 / 技能 / 药水本来就各有一套现成图标，
 *      状态栏没必要再为同一件事另画一套"状态图标"（见 `StatusBarEntry.icon`）。
 *      本层只**算路径**（纯字符串），不碰 `resources` / `cc` —— 加载由面板走共用的 `AtlasIcon`。
 *
 * ── 一条硬口径：**没内容就不占格子** ──
 *   限时效果看 `remainingTime > 0`；常驻载体看 `Modifier.GetBarState()` 是否非空。
 *   所以「蓄力没好 / 护盾在充能 / 不屈用完了」这些**不显示** —— 栏上出现的每一条都是此刻有意义的。
 */

/** 状态栏里的一条（UI 只读这份结构） */
export interface StatusBarEntry {
    /** 去重键：同键的多个 Modifier 实例合成一格（`item:3` / `relic:1021` / `mod:6` …） */
    key: string;
    /** 格子上那行短标（≤2 汉字） */
    label: string;
    /** 全名（tip / 飘字用；短标放不下的信息在这里） */
    name: string;
    /**
     * **来源图标**（2026-11 新增）：`resources` 相对路径、**不带扩展名**（`textures/relics/gloves`），
     * 空串 = 这一格没有图 → 面板回落「色块 + 短标 + 值」的画法（见 `docs/status-bar/README.md` §4.5）。
     *
     * 取数（`take` 里一行 `src?.icon || def.icon`）：
     *   ① **来源的图标** —— `origin = relic:<id>` → `relics.icon`（遗物）/ `ability:<id>` → `abilities.icon`（技能）
     *      / `item:<id>` → `battle_items.icon`（药水）；
     *   ② 来源表没有（或这行根本没有 `origin`）→ **这一行 Modifier 自己的 `icon`**（buff 图标）。
     *
     * 口径 = 用户 2026-11 定的「**状态来源于遗物就显示遗物图标、来源于 buff 就显示 buff 图标**」：
     * 这样 8 个遗物载体行 + 3 个技能行直接复用**已有的**遗物 / 技能图集，
     * **不必为状态栏另画一套状态图标**（还缺图的只剩药水与 4 个怪物 debuff，各补一行 `icon` 即可）。
     */
    icon: string;
    /**
     * **说明文案**（2026-11 新增）：点这一格时弹出的说明面板上写的那句话。
     *
     * 取数优先级（见 `originInfo`）：来源配表（药水 `desc` / 遗物 `description_inner` /
     * 技能 `lv1` / 神器 `per_desc`）→ Modifier 行的 `desc` → 通用兜底句（持续时长 + 正负）。
     * 空串 = 面板只画名字与时长，不画正文。
     */
    desc: string;
    /** 负面（决定底色：负面红 / 正面青绿） */
    isDebuff: boolean;
    /** 剩余秒数；**-1 = 没有倒计时**（就绪态 / 次数型） */
    seconds: number;
    /** 层数 / 剩余次数；1 = 不显示 */
    stacks: number;
    /** 进度 0~1（就绪 = 1；缺省由剩余时长算） */
    pct: number;
}

/**
 * StatusBar 向局内 UI 暴露的**只读面**（宿主 `provide` 的是实例本身）。
 *
 * ⚠ 没有"动作"：状态栏是**纯投影**，UI 改不了任何战斗状态（同其它 `XxxVM` 的口径）。
 *   点击弹说明面板（2026-11 新增）用的是 `StatusBarEntry.name` + `desc` ——
 *   文案由本层从配表取好（见 `originInfo`），控件只负责画，不自己去查表。
 */
export interface StatusBarVM {
    /**
     * 采一帧。**返回的数组与里面的对象都是复用的**（每帧原地改写）——
     * 调用方只许当帧读，不许缓存、不许 `push` 进去。
     */
    read(): readonly StatusBarEntry[];
}

export interface StatusBarDeps {
    /** 本局出战英雄（还没选英雄 / 已阵亡时返回 null） */
    getHero(): Entity | null;
}

/** 名字前缀（配表里为了分类加的，短标里要剥掉） */
const NAME_PREFIXES = ['遗物·', '技能·', '神器·', '道具·'];

/** 名字 → 短标（≤2 汉字）：剥前缀取前两字，如「遗物·濒死守护」→「濒死」 */
export function shortLabel(name: string): string {
    let s = String(name ?? '').trim();
    for (const p of NAME_PREFIXES) {
        if (s.startsWith(p)) { s = s.slice(p.length); break; }
    }
    return s.slice(0, 2) || '状态';
}

/**
 * 来源组标识 → 去重键 + 取名的配置表 + **说明文案** + **图标**（`origin` 的写法见 `Modifier.origin`）。
 *
 * ⚠ `icon` 一律是「**来源自己**的图标」（遗物 / 技能 / 药水各自配表里的那一列）——
 *   这就是「状态来源于遗物就显示遗物图标」那条口径的落点；取不到（来源表没这一列 / 这一行没配）
 *   由调用方退到 `modifiers.icon`（buff 图标）。
 */
function originInfo(origin?: string): { key: string; name: string; desc: string; icon: string } | null {
    if (!origin) return null;
    const parts = String(origin).split(':');
    const id = Number(parts[1]);
    if (!(id > 0)) return null;
    switch (parts[0]) {
        // ⚠ 键里**不带**序号：`item:3:17`（同一件药水用第二次）要合成一格，
        //   否则连喝两瓶同样的药会并排占两格
        case 'item': {
            const cfg = ShopConfig.getBattleItem(id);
            return { key: `item:${id}`, name: cfg?.name ?? '', desc: cfg?.desc ?? '', icon: cfg?.icon ?? '' };
        }
        case 'relic': {
            const cfg = ShopConfig.getRelic(id);
            return {
                key: `relic:${id}`,
                name: cfg?.name ?? '',
                // 遗物的局内说明（`description_inner`）——这是玩家在商店里看到的那句话
                desc: cfg ? ShopConfig.getRelicDesc(cfg) : '',
                // 遗物图标（`textures/relics/<stem>`，全表 277 件都有）
                icon: cfg?.icon ?? '',
            };
        }
        case 'ability': {
            const cfg = ShopConfig.getAbility(id);
            return { key: `ability:${id}`, name: cfg?.name ?? '', desc: cfg?.lv1 ?? '', icon: cfg?.icon ?? '' };
        }
        case 'killbuff': {
            const cfg = ShopConfig.getKillBuff(id);
            return {
                key: `killbuff:${id}`,
                name: cfg?.name ?? '',
                // 神器的 `per_desc` 就是"每层给什么"那句话；没有它时退回 `note`（策划备注）
                desc: cfg?.per_desc || cfg?.note || '',
                // 神器图标 = `kill_buffs.icon`（`textures/artifacts/<code>`，2026-11 补齐）。
                // 神器是**永久**属性（`duration = -1`）⇒ 永远过不了判据 2「有内容才占格」，
                // 所以这一格**平时根本不出栏**；补图是为了口径一致（同一个函数四处来源都答得出图标）
                icon: cfg?.icon ?? '',
            };
        }
        default: return null;
    }
}

/**
 * 通用兜底说明（来源查不到 / 配表没写 `desc` 时）。
 *
 * 为什么要有：状态栏上的行有一半是**脚本载体**（遗物·蓄力 / 不屈 / 法障…），
 * 它们的语义在代码里而不在文案列里。给一句"正面/负面 + 时长"至少回答得了
 * 玩家最基础的两个问题（这是好是坏、还要多久），比弹一个空面板强。
 */
function fallbackDesc(def: any, timed: boolean, seconds: number): string {
    const kind = def?.is_debuff === true ? '负面状态' : '增益状态';
    if (!timed) return `${kind}：只要还在生效就一直起作用。`;
    return `${kind}：还剩 ${Math.max(0, Math.ceil(seconds))} 秒。`;
}

function clamp01(v: number): number {
    if (!Number.isFinite(v)) return 1;
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 排序：**负面在前 → 有倒计时的在前 → 剩余时间少的在前 → 层数多的在前 → 键字典序兜底**。
 * 最后一条不是装饰：没有它同输入两次的次序可能不同（UI 会闪位置）。
 */
function compareEntries(a: StatusBarEntry, b: StatusBarEntry): number {
    if (a.isDebuff !== b.isDebuff) return a.isDebuff ? -1 : 1;
    const at = a.seconds >= 0;
    const bt = b.seconds >= 0;
    if (at !== bt) return at ? -1 : 1;
    if (at && a.seconds !== b.seconds) return a.seconds - b.seconds;
    if (a.stacks !== b.stacks) return b.stacks - a.stacks;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export class StatusBar implements StatusBarVM {

    private readonly deps: StatusBarDeps;

    /** 本帧的条目（复用；`read()` 开头清空） */
    private readonly out: StatusBarEntry[] = [];
    /** 条目对象的池子（与 `out` 同下标复用，避免每帧分配） */
    private readonly pool: StatusBarEntry[] = [];
    /** key → 在 `out` 里的下标（同一帧内合并同键实例） */
    private readonly index = new Map<string, number>();
    /** key → 短标的可信度（2 = 配表 / 脚本显式给的，1 = 名字兜底） */
    private readonly labelRank = new Map<string, number>();

    constructor(deps: StatusBarDeps) {
        this.deps = deps;
    }

    read(): readonly StatusBarEntry[] {
        this.out.length = 0;
        this.index.clear();
        this.labelRank.clear();

        const mods = this.deps.getHero()?.modifiers?.getAll?.() ?? [];
        for (const m of mods) this.take(m);
        this.out.sort(compareEntries);
        return this.out;
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    /** 一个 Modifier 实例 → 一格（同键则合并进已有那格） */
    private take(m: Modifier): void {
        const def = m?.def as any;
        if (!def?.bar_show) return;                   // 白名单：没标的一律不进栏
        if (m.paused) return;

        const timed = !m.isPermanent() && m.remainingTime > 0;
        const bar: BarState | null = m.GetBarState ? m.GetBarState() : null;
        if (!timed && !bar) return;                   // 本帧没内容 → 不占格子（就绪态的核心判据）

        const src = originInfo(m.origin);
        const key = src?.key ?? `mod:${def.id}`;
        const explicit = String(bar?.label ?? def.bar_text ?? '').trim();
        const name = explicit || src?.name || def.name || '';
        const label = shortLabel(explicit || src?.name || def.name);

        const seconds = timed ? Math.max(0, m.remainingTime) : -1;
        const pct = clamp01(bar?.pct ?? (timed ? seconds / Math.max(0.001, m.duration) : 1));
        const stacks = Math.max(1, Math.floor(bar?.stacks ?? m.getStackCount()));
        // 说明文案：来源配表 → Modifier 行自己的 `desc` → 通用兜底句。
        // ⚠ 共享模板 1000（「属性修改」）的 `desc` 永远是空的，它只是一个模板 ——
        //   限时实例的说明必须走 `origin` 那条路（药水/遗物/技能各自的描述）。
        const desc = src?.desc || String(def.desc ?? '').trim() || fallbackDesc(def, timed, seconds);
        // 图标：**来源的图标**（遗物 / 技能 / 药水）→ 这一行自己的 `icon`（buff 图标）→ 空（面板画色块 + 短标）。
        // ⚠ 顺序不能反：「来源于遗物就显示遗物图标」是用户定的口径，`modifiers.icon` 只是兜底。
        const icon = src?.icon || String(def.icon ?? '').trim();

        const at = this.index.get(key);
        if (at === undefined) {
            const e = this.entryAt(this.out.length);
            e.key = key;
            e.label = label;
            e.name = name;
            e.icon = icon;
            e.desc = desc;
            e.isDebuff = def.is_debuff === true;
            e.seconds = seconds;
            e.stacks = stacks;
            e.pct = pct;
            this.out.push(e);
            this.index.set(key, this.out.length - 1);
            this.labelRank.set(key, explicit ? 2 : 1);
            return;
        }

        // 同键合并（连击：时长来自共享模板实例、层数来自钩子实例）
        const cur = this.out[at];
        if (seconds > cur.seconds) cur.seconds = seconds;   // -1 = 没有，别把已有倒计时抹掉
        if (stacks > cur.stacks) cur.stacks = stacks;
        if (pct > cur.pct) cur.pct = pct;
        // 图标同理：同键的两个实例来源一致（都是同一个 `origin`），先到的**非空**图标说了算
        if (!cur.icon) cur.icon = icon;
        if ((explicit ? 2 : 1) > (this.labelRank.get(key) ?? 0)) {
            cur.label = label;
            cur.name = name;
            cur.desc = desc;
            this.labelRank.set(key, explicit ? 2 : 1);
        }
    }

    /** 取池子里的第 `i` 条（没有就造一条）—— `out` 与池子同下标复用 */
    private entryAt(i: number): StatusBarEntry {
        let e = this.pool[i];
        if (!e) {
            e = { key: '', label: '', name: '', icon: '', desc: '', isDebuff: false, seconds: -1, stacks: 1, pct: 1 };
            this.pool[i] = e;
        }
        return e;
    }
}
