import { ref, type Ref } from '../../platform/reactivity';

/**
 * 本局「流派进度」的统计口径（纯 TS，**无 cc 依赖**）
 *
 * 解决的是一句判据：*若 268 件全为可替换的通用属性件，玩家永远感受不到"我这局玩的是什么流派"*
 * （`docs/调研_流派与强化件设计总表.md` §2.3）。标签本身 2026-11 已三面点亮（商店格 / 击杀商店摊位 /
 * 局外图鉴行），但那是**逐件**的信息 —— 玩家看不见"整局加起来我堆的是哪条线"。
 *
 * ── 计分口径（四条，都有理由）──
 *  ① **三张表合并**：遗物（`relics.tags`）+ 技能（`abilities.tags`）+ 神器（`kill_buffs.tags`）。
 *     口径来自 `docs/relic-redesign/relics-inner.md` §1.2b —— 薄流派（元素持续 7 / 经济成长 4）
 *     主要靠技能与神器交付，**只看遗物会系统性低估流派厚度**。
 *  ② **只认主标签 `tags[0]`**：与三处 UI 露出一致（格子上写的就是主标签）。
 *     不这么做的代价是可量化的：一件多标签件平均 1.19 个标签 ⇒ 全部计入会让总数**凭空多 19%**，
 *     而且会出现"格子上写着 A、计数把它算成 A+B"的对不上账。
 *  ③ **按件，不按层/级**：神器叠到 10 层仍只算 1 件、技能升到 3 级仍只算 1 个。
 *     层数与等级衡量的是"**投了多少资源**"，流派衡量的是"**选了哪条线**"—— 两件事不该混在一个数里。
 *  ④ **重算式，不是增量累加**（本文件最重要的一条）：`recount()` 每次从数据源**全量重算**，
 *     所以"重复抽到同一技能（升级）""同一件神器买第二层""重新选英雄"这些**天然不会重复计分**，
 *     不需要调用方在三个事件里各写一遍去重逻辑 —— 少一处状态、少一类"漏加/多加"的 bug。
 *
 * ── 消费方 ──
 *   `Scene_Game_Stage` 持有唯一实例，在「买到遗物 / 技能落槽 / 买到神器 / 重开一局」后调 `recount()`；
 *   HUD 组件（`Cmp_ArchetypeTally`）读 `top()` 画进度、读 `drainFormed()` 弹一次成型提示。
 */

/**
 * 词表顺序（= 配表真源 `RELIC_ARCHETYPES` 的顺序，同分时按它排，保证展示稳定不跳）
 *
 * 2026-11 从 8 个词扩到 **10 个**：补上用户定稿名册里最后两个英雄的流派
 * ——「背水血怒」= 哈斯卡（`units#1009`，血越少攻速越快）、
 *   「弹幕散射」= 卓尔游侠（`units#1006`，一发覆盖尽量多的敌人）。
 * ⚠ 改这里**必须同时改** `relic-inner-design.mjs` 的 `RELIC_ARCHETYPES`（两边顺序要一致，
 *   否则同分排序会在两处给出不同的结果），`npm run audit:archetype` 有一条断言盯着它们相等。
 */
export const ARCHETYPE_ORDER: readonly string[] = [
    '远程点杀', '坦克反伤', '物理暴击', '法术爆发', '召唤增殖', '元素持续', '经济成长', '控制减速',
    '背水血怒', '弹幕散射',
];/**
 * **成型线**：某流派集满这么多「件」就算成型。
 *
 * 为什么是 5：局内商店一轮 4 格**只能选 1 件**（`shop_constants.pickCount`），一局大致能拿 10~20 件，
 * 所以 5 件约等于"这条线占了你全局的 1/4~1/2"，是"有意识在堆"而不是"顺手捡到两个"。
 *
 * ⚠ **厚薄流派不可能完全公平**，但 2026-11 的**池配平**已经把它压到可接受区间（`docs/hero-archetype/README.md` §7.1）：
 * 主标签口径下 10 条线是 `法术爆发 55 / 坦克反伤 54 / 远程点杀 47 / 召唤增殖 21 / 背水血怒 18 /
 * 物理暴击 17 / 经济成长 15 / 弹幕散射 15 / 元素持续 13 / 控制减速 13`（**最厚/最薄 4.23×**，
 * 配平前是 `坦克反伤 93（35%）÷ 经济成长 4` = **23.2×**）。
 * 换算成"随机抽 15 件"：最厚那条期望 **3.2 件 < 成型线 5** ⇒ **没有任何一条线会"不想堆也成型"**；
 * 最薄那条期望 0.7 件 ⇒ 成型得靠玩家**主动选**（该判据由 `check:pool` 的 G 组与 `audit:archetype` 的 E 段盯着）。
 * 结构下限（白档 107 件只能推出 3 个词）与"要再往下走得动什么"见 §7.1.3。
 */
export const ARCHETYPE_FORM_THRESHOLD = 5;

/** 一条流派的进度 */
export interface ArchetypeCount {
    /** 流派名（`RELIC_ARCHETYPES` 里那 8 个词之一） */
    tag: string;
    /** 已获得的件数（遗物 + 技能 + 神器，按件） */
    count: number;
    /** 是否已达成型线 */
    formed: boolean;
}

/** 由一个 id 查它那条配表的 `tags`（调用方注入，所以本文件不认识 ShopConfig） */
export type TagLookup = (id: number) => readonly string[] | undefined;

/** `recount()` 的输入：三个 id 列表 + 各自的查表函数 */
export interface ArchetypeSources {
    /** 本局已获得的遗物 id（`BattleEquipSystem.getAll()` → `getId()`） */
    relicIds: readonly number[];
    relicTags: TagLookup;
    /** 本局已拥有的技能 id（技能槽里的，**去重**） */
    skillIds: readonly number[];
    skillTags: TagLookup;
    /** 本局已买过的神器 id（`BuffShop.stacks` 的键，**一件一次**，与层数无关） */
    buffIds: readonly number[];
    buffTags: TagLookup;
}

/**
 * **只读门面**（HUD `inject` 的是它，不是 `ArchetypeTally` 本体）。
 *
 * 写操作（`recount` / `reset`）只有宿主持有 —— HUD 拿不到，就不会出现"面板自己改统计"这种事。
 * `revision` 是唯一的刷新信号：`recount()` 末尾自增，HUD `watch` 它重画
 * （与 `BuffShop.slots` / `BuffShop.stacks` 同一套路，见 `StageScope.ts` 的「一个功能一个键」）。
 */
export interface ArchetypeTallyVM {
    /** 每次 `recount()` 自增；HUD 只 watch 它，不 watch 具体计数 */
    readonly revision: Ref<number>;
    /** 某流派当前件数（没拿过回 0） */
    countOf(tag: string): number;
    /** 是否已达成型线 */
    isFormed(tag: string): boolean;
    /** 全部有分的流派，件数降序 */
    list(): ArchetypeCount[];
    /** 前 n 名（HUD 常驻只画得下几个） */
    top(n: number): ArchetypeCount[];
    /** 本局一共拿到几件（三张表合计）—— 0 时 HUD 整块收起 */
    readonly totalCount: number;
    /** 取走"本次新成型"的流派（取一次清空，供一次性提示） */
    drainFormed(): string[];
}

/** 本局流派进度表 */
export class ArchetypeTally implements ArchetypeTallyVM {

    /** 刷新信号：每次 `recount()` / `reset()` 自增（HUD 只 watch 这一个值） */
    readonly revision: Ref<number> = ref(0);

    /** tag → 件数（只放 count > 0 的，避免 8 个词全占着零值） */
    private counts: Map<string, number> = new Map<string, number>();
    /** 已经**提示过**的成型流派（每局每条线只弹一次，不重复打扰） */
    private announced: Set<string> = new Set<string>();
    /** 本次 `recount()` 里**新**成型的流派，等 UI 取走（`drainFormed`） */
    private pending: string[] = [];

    /**
     * 从数据源**全量重算**（幂等：同样的输入算出的结果一定一样，调多少次都不重复计分）。
     *
     * 调用时机：买到遗物 / 技能落槽 / 买到神器 / 重开一局 —— 都是"玩家的拥有物变了"之后。
     * 不认识配表的 id 一律**跳过**（不抛异常）：比如 9 件仅局外版的 dota2 中立道具没有 `tags`，
     * 它们本来就不该进局内计数。
     */
    recount(src: ArchetypeSources): void {
        this.counts.clear();
        this.tally(src.relicIds, src.relicTags);
        this.tally(src.skillIds, src.skillTags);
        this.tally(src.buffIds, src.buffTags);
        this.collectNewlyFormed();
        this.revision.value++;
    }

    /** 累加一组 id 的主标签 */
    private tally(ids: readonly number[], lookup: TagLookup): void {
        for (const id of ids) {
            const tags = lookup(id);
            // 主标签（`tags[0]`）—— 与 UI 露出一致，理由见文件头 ②
            const tag = tags && tags.length > 0 ? tags[0] : '';
            if (!tag) continue;
            this.counts.set(tag, (this.counts.get(tag) ?? 0) + 1);
        }
    }

    /** 找出"这次刚够到成型线"的流派，记进 `pending`（已提示过的只标记不再入队） */
    private collectNewlyFormed(): void {
        for (const [tag, count] of this.counts) {
            if (count < ARCHETYPE_FORM_THRESHOLD) continue;
            if (this.announced.has(tag)) continue;
            this.announced.add(tag);
            this.pending.push(tag);
        }
    }

    /** 某流派当前件数（没拿过回 0） */
    countOf(tag: string): number {
        return this.counts.get(tag) ?? 0;
    }

    /** 是否已成型 */
    isFormed(tag: string): boolean {
        return this.countOf(tag) >= ARCHETYPE_FORM_THRESHOLD;
    }

    /** 全部有分的流派，按**件数降序**（同分按 `ARCHETYPE_ORDER` 的词表序，展示不会来回跳） */
    list(): ArchetypeCount[] {
        const all: ArchetypeCount[] = [];
        for (const [tag, count] of this.counts) {
            all.push({ tag, count, formed: count >= ARCHETYPE_FORM_THRESHOLD });
        }
        return all.sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return ARCHETYPE_ORDER.indexOf(a.tag) - ARCHETYPE_ORDER.indexOf(b.tag);
        });
    }

    /** 前 n 名（HUD 常驻只画得下几个，见 `Cmp_ArchetypeTally`） */
    top(n: number): ArchetypeCount[] {
        return this.list().slice(0, Math.max(0, n));
    }

    /** 本局一共拿到了几件（三张表合计）—— HUD 用来判断"一件都还没有"时整块收起 */
    get totalCount(): number {
        let sum = 0;
        for (const c of this.counts.values()) sum += c;
        return sum;
    }

    /**
     * 取走"本次新成型"的流派（**取一次就清空**）。
     * 之所以是"取走"而不是"读"：消费方是 HUD 的一次性提示，读式接口会让它每帧重弹。
     */
    drainFormed(): string[] {
        if (this.pending.length === 0) return [];
        const out = this.pending;
        this.pending = [];
        return out;
    }

    /** 重开一局：连"已提示过"一起复位（否则下一局同一条线成型时不会再提示） */
    reset(): void {
        this.counts.clear();
        this.announced.clear();
        this.pending.length = 0;
        this.revision.value++;
    }
}
