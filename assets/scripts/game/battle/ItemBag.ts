import { ref, type Ref } from '../../platform/reactivity';
import { ShopConfig } from '../data/configs/ShopConfig';
import type { BattleItemCfg } from '../excel_table/Tb_BattleItemConfig';
import { BATTLE_ITEM_DROP_PER_BOSS, EMPTY_SLOT, ITEM_BAG_SLOT_COUNT } from '../common/ItemBagConfig';
import type { Entity } from './Entity';

/**
 * ItemBag —— **局内掉落 Buff 小背包（6 格）的完整功能封装**（纯 TS，无 cc 依赖）
 *
 * 数据源：`battle_items.json`（15 件道具：**14 件限时 + 1 件即刻生效**（血包，`duration = 0`））。
 *
 * ```
 *   Scene_Game_Stage（宿主）                HUD 背包组件（将来的事）
 *        │ spawnBoss / OnDeath 里调 drop()      ▲ provide 状态   │ emit(使用第 N 格)
 *        ▼                                      │                ▼
 *   ItemBag（本类）  空格判定、掉落抽取、**使用**、效果施加
 *        │
 *        ▼  hero.modifiers.AddModifier(mod, hero, cfg.duration, kv, origin)
 *   ModifierSystem / AttributeSystem  统一结算（本类不做任何属性计算）
 * ```
 *
 * ── 与「神器」（`kill_buffs` / `BuffShop`）的分工（**两条轨，别混**）──
 *   · **神器** = 永久 + 可叠层 + 花击杀数买刷新次数 → `BuffShop`
 *   · **本类** = **一次性消耗 + 打阶段 Boss 掉**（绝大多数**限时**、一件**即刻生效**）→
 *     捡到**不生效**，玩家点格子才生效
 *   决策类型不同：神器问"抽到什么"（构筑），本类问"**什么时候按**"（操作）。
 *   口径见 `docs/artifact-drop/README.md`。
 *   ⚠ 「血包」（id 15）原本是**神器**表里的 id 17，2026-11 拆轨时整条移到这里 ——
 *     它是一件**道具**（用完就没了），不是构筑件。所以本表现在 15 条。
 *
 * ── 三条硬口径 ──
 *   ① **满了直接拒收**（用户 2026-11 定案）：6 格满了又掉 → **掉落作废**，不弹窗、不折算。
 *      所以 `drop()` 返回 `ok:false` + `reason:'full'`，宿主负责飘一行"背包已满"。
 *   ② **不套 `ApplyWithMaxHpCarry`**：那是给**永久**上限变化用的口。本表**禁止**配置「最大生命」
 *      这类上限类属性（见 `Tb_BattleItemConfig.duration` 注释）—— 临时上限到期回落而当前生命不回落
 *      会出现 `hp > maxHp` 的脏数据。所以这里直接 `AddModifier`，不绕那个包装器。
 *   ③ **换英雄不重放已用掉的效果**：道具是**消耗品**（限时或即刻），已消耗的就是消耗掉了
 *      （与 `BuffShop.rebind` 重放**永久**层数是两回事）。**背包里没用掉的**照旧保留
 *      —— 它们在 `slots` 里，不在实体上。
 */

/** 掉落结果（宿主拿它飘字/播音效） */
export interface DropResult {
    /** 有没有真的进包（`false` = 拒收，见 `reason`） */
    ok: boolean;
    /** 掉的是哪件（`0` = 没掉成） */
    itemId: number;
    /** 落进了第几格（`-1` = 没落进去） */
    slot: number;
    /** 拒收原因：`full` = 6 格满了 / `no_pool` = 掉落池是空的 */
    reason?: 'full' | 'no_pool';
    /**
     * 掉落物的配置（给飘字用）。
     * ⚠ **拒收（`full`）时也有值** —— 用户口径的满格提示是「背包已满，xxx 已自动丢弃」，
     *   报不出是哪一件的话玩家只会看到"打到了但什么都没发生"。
     */
    cfg?: BattleItemCfg;
}

export interface ItemBagDeps {
    /** 本局英雄实体（效果的施加目标）；还没选英雄时为 null */
    getHero(): Entity | null;
    /**
     * 抽一个掉落 id（可选注入）。
     * 宿主不注入时走内置的**按 `weight` 加权随机**；注入是为了让体检/回放能钉死结果
     * （同 `Scene_Game_Stage` 的其他 deps 口径：本类不自己认识随机源）。
     */
    rollItemId?(pool: BattleItemCfg[]): number;
}

/** 时长的人话（日志/飘字用）：`> 0` 是秒数，`0` 是即刻生效 —— `0 秒` 会被读成"没效果" */
export function durationText(cfg: BattleItemCfg): string {
    return cfg.duration > 0 ? `${cfg.duration} 秒` : '即刻生效';
}

/**
 * ItemBag 向局内 UI 暴露的**只读面**（宿主 `provide` 的是实例本身，用这个接口约束组件能碰什么）。
 *
 * ⚠ **动作不在只读面上**（`drop` / `use` / `reset` / `rebind` 都不声明）：
 *   UI 只 `scope.emit` 向上，由宿主转交（同 `BuffShopVM` / `BossSchedulerVM` 的口径）。
 */
export interface ItemBagVM {
    /** 6 个格子装的掉落 id（`0` = 空格） */
    readonly slots: Ref<number[]>;
    /** 格子总数（**读 `ItemBagConfig`，组件不许自己写 6**） */
    slotCount(): number;
    /** 第 `slot` 格的配置（空格/越界返回 undefined） */
    cfgAt(slot: number): BattleItemCfg | undefined;
    /** 第 `slot` 格现在能不能用（有道具 且 英雄在场） */
    canUse(slot: number): boolean;
    /** 还有几个空格 */
    freeCount(): number;
    /** 本局累计掉进来几件 */
    readonly droppedCount: Ref<number>;
    /** 本局累计被拒收几件（满了） */
    readonly rejectedCount: Ref<number>;
}

export class ItemBag {

    /* ===== 状态（宿主 provide 给 UI 子树） ===== */

    /** 6 个格子（`0` = 空格） */
    readonly slots: Ref<number[]> = ref<number[]>(new Array(ITEM_BAG_SLOT_COUNT).fill(EMPTY_SLOT));
    /** 本局累计掉进来几件 */
    readonly droppedCount: Ref<number> = ref(0);
    /** 本局累计被拒收几件（满了） */
    readonly rejectedCount: Ref<number> = ref(0);

    private deps: ItemBagDeps;
    /**
     * 使用序号 —— 只用来给 Modifier 的 `origin` 去重。
     * **必须单调递增**：同一种道具用两次，若 origin 相同会被 `ModifierSystem` 判成"同一个效果再来一次"
     * 而**刷新**而不是**叠加/并存**（`BuffShop` 用层号达到同样目的）。
     */
    private useSeq = 0;

    constructor(deps: ItemBagDeps) {
        this.deps = deps;
    }

    /* ===================================================================
     * 掉落
     * =================================================================== */

    /**
     * 掉一件进背包（宿主在**阶段 Boss 阵亡**时调 `BATTLE_ITEM_DROP_PER_BOSS` 次）。
     *
     * ⚠ **满了直接拒收**（`ok:false / reason:'full'`）—— 不弹窗、不折算，由宿主飘字告知。
     * ⚠ **先抽再判满格**：满格时也要把抽到的那件带回去（`cfg`），否则飘不出"xxx 已自动丢弃"。
     *   `rollCfg` 是纯函数、没有副作用，所以"先抽"不会让被拒收的那次占掉任何东西。
     * @param itemId 指定掉落物（不传 = 按 `weight` 加权随机抽）
     */
    drop(itemId?: number): DropResult {
        const cfg = itemId !== undefined ? ShopConfig.getBattleItem(itemId) : this.rollCfg();
        if (!cfg) {
            console.warn(`[道具背包] 掉落物配置找不到（itemId=${itemId ?? '随机'}）`);
            return { ok: false, itemId: 0, slot: -1, reason: 'no_pool' };
        }

        const slot = this.firstFreeSlot();
        if (slot < 0) {
            this.rejectedCount.value++;
            console.log(`[道具背包] 6 格已满，掉落「${cfg.name}」被拒收（掉落作废）`);
            return { ok: false, itemId: cfg.id, slot: -1, reason: 'full', cfg };
        }

        const next = this.slots.value.slice();
        next[slot] = cfg.id;
        this.slots.value = next;                     // 换新数组：UI 靠 watch(slots) 刷新
        this.droppedCount.value++;

        console.log(`[道具背包] 掉落「${cfg.name}」→ 第 ${slot + 1} 格（${cfg.desc}，${durationText(cfg)}）`);
        return { ok: true, itemId: cfg.id, slot, cfg };
    }

    /** 一次掉 `BATTLE_ITEM_DROP_PER_BOSS` 件（阶段 Boss 阵亡的调用口），返回本批结果 */
    dropForStageBoss(): DropResult[] {
        const out: DropResult[] = [];
        for (let i = 0; i < BATTLE_ITEM_DROP_PER_BOSS; i++) out.push(this.drop());
        return out;
    }

    /* ===================================================================
     * 使用
     * =================================================================== */

    /**
     * 使用第 `slot` 格的道具 —— 施加效果、**清空格子**。
     *
     * 校验顺序：格号合法 → 格里有道具 → 英雄在场 → 施加 `cfg.modifiers`（时长 = `cfg.duration`）→ 清格。
     * @returns 用掉的那件配置；失败返回 null
     */
    use(slot: number): BattleItemCfg | null {
        const hero = this.deps.getHero();
        if (!hero) {
            console.warn('[道具背包] 还没选英雄，无法使用道具');
            return null;
        }
        if (!Number.isInteger(slot) || slot < 0 || slot >= ITEM_BAG_SLOT_COUNT) {
            console.warn(`[道具背包] 格号越界：${slot}`);
            return null;
        }
        const id = this.slots.value[slot] ?? EMPTY_SLOT;
        if (id === EMPTY_SLOT) {
            console.warn(`[道具背包] 第 ${slot + 1} 格是空的`);
            return null;
        }
        const cfg = ShopConfig.getBattleItem(id);
        if (!cfg) {
            console.warn(`[道具背包] 第 ${slot + 1} 格的配置找不到（id=${id}）—— 清掉这个死格子`);
            this.clearSlot(slot);
            return null;
        }

        this.applyItem(cfg, hero);

        this.clearSlot(slot);
        console.log(`[道具背包] 使用「${cfg.name}」（第 ${slot + 1} 格 → 空）：${cfg.desc}`);
        return cfg;
    }

    /* ===================================================================
     * 生命周期
     * =================================================================== */

    /**
     * 换英雄：**不重放**已用掉的效果（道具是限时消耗品，消耗掉就是消耗掉了）。
     * 背包里**没用掉的**照旧保留 —— 它们在 `slots` 里，不在实体上，天然不受换实体影响。
     */
    rebind(): void {
        const left = this.slots.value.filter((id) => id !== EMPTY_SLOT).length;
        if (left) console.log(`[道具背包] 换英雄：背包里还有 ${left} 件未使用的道具，原样保留`);
    }

    /** 换局复位：格子清空、统计归零（**已生效的效果随旧实体一起作废**） */
    reset(): void {
        this.slots.value = new Array(ITEM_BAG_SLOT_COUNT).fill(EMPTY_SLOT);
        this.droppedCount.value = 0;
        this.rejectedCount.value = 0;
        this.useSeq = 0;
    }

    /* ===================================================================
     * 查询
     * =================================================================== */

    slotCount(): number { return ITEM_BAG_SLOT_COUNT; }

    cfgAt(slot: number): BattleItemCfg | undefined {
        const id = this.slots.value[slot] ?? EMPTY_SLOT;
        return id === EMPTY_SLOT ? undefined : ShopConfig.getBattleItem(id);
    }

    /** 第 `slot` 格现在能不能用（有道具 且 英雄在场） */
    canUse(slot: number): boolean {
        if (!Number.isInteger(slot) || slot < 0 || slot >= ITEM_BAG_SLOT_COUNT) return false;
        if ((this.slots.value[slot] ?? EMPTY_SLOT) === EMPTY_SLOT) return false;
        return !!this.deps.getHero();
    }

    /** 还有几个空格 */
    freeCount(): number {
        return this.slots.value.filter((id) => id === EMPTY_SLOT).length;
    }

    /** 背包里有没有东西 */
    isEmpty(): boolean {
        return this.slots.value.every((id) => id === EMPTY_SLOT);
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    /** 第一个空格的下标；没有空格返回 -1 */
    private firstFreeSlot(): number {
        return this.slots.value.findIndex((id) => id === EMPTY_SLOT);
    }

    private clearSlot(slot: number): void {
        const next = this.slots.value.slice();
        next[slot] = EMPTY_SLOT;
        this.slots.value = next;
    }

    /**
     * 掉落池 = 表里所有权重大于 0 的道具。
     * `weight <= 0` 表示"配出来了但暂时不投放"（比删行安全：删了 id 就废了）。
     */
    private pool(): BattleItemCfg[] {
        return ShopConfig.getBattleItems().filter((cfg) => ShopConfig.getBattleItemWeight(cfg) > 0);
    }

    /** 加权随机抽一件；宿主注入了 `rollItemId` 就以它为准（体检/回放靠这个钉死结果） */
    private rollCfg(): BattleItemCfg | undefined {
        const pool = this.pool();
        if (!pool.length) return undefined;
        if (this.deps.rollItemId) {
            const id = this.deps.rollItemId(pool);
            return pool.find((c) => c.id === id) ?? pool[0];
        }
        let total = 0;
        for (const cfg of pool) total += ShopConfig.getBattleItemWeight(cfg);
        if (!(total > 0)) return pool[0];
        let r = Math.random() * total;
        for (const cfg of pool) {
            r -= ShopConfig.getBattleItemWeight(cfg);
            if (r < 0) return cfg;
        }
        return pool[pool.length - 1];
    }

    /**
     * 把一件道具的效果施加到英雄身上 —— 走**与遗物/神器同一条路**：`ModifierSystem.AddModifier`。
     *
     * `origin` 带**使用序号**：同一种道具用两次若 origin 相同，会被判成"同一个效果再来一次"
     * 而刷新而不是并存（这是 `BuffShop` 用层号解决的同一个坑）。
     *
     * 时长取 `cfg.duration`（**`> 0` 限时 / `= 0` 即刻生效**，见 `Tb_BattleItemConfig.duration`）。
     * 若某条 Modifier 有自己的默认时长（如 mod 6 无敌默认 5 秒），这里传的值会**覆盖**它 ——
     * 配置里不用也不该重复写时长。
     *
     * ⚠ **`0` 必须原样传下去，不能兜成 `-1`**：`-1` 是"永久"，即刻生效的道具会变成
     *   挂一个永久 Modifier 在英雄身上（血包这种"用掉就完了"的东西会一直留着）。
     *   本表口径是"`< 0` 才算配错"。
     */
    private applyItem(cfg: BattleItemCfg, hero: Entity): void {
        const entries = cfg.modifiers ?? [];
        if (!entries.length) {
            console.warn(`[道具背包] ${cfg.name} 没有任何 modifiers，用了没效果`);
            return;
        }
        if (!hero.modifiers) {
            console.warn('[道具背包] 英雄实体上没有 ModifierSystem，道具无法生效');
            return;
        }
        const duration = cfg.duration >= 0 ? cfg.duration : -1;
        if (!(cfg.duration >= 0)) {
            console.warn(`[道具背包] ${cfg.name} 的 duration=${cfg.duration} 是负数（本表只允许 > 0 限时 / 0 即刻生效）`);
        }
        for (const entry of entries) {
            const origin = `item:${cfg.id}:${this.useSeq++}`;
            hero.modifiers.AddModifier(entry.modifier, hero, duration, entry.kv ?? {}, origin);
        }
    }
}
