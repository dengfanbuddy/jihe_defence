import { ref, type Ref } from '../../platform/reactivity';
import type { AbilitySystem } from './AbilitySystem';

/**
 * SkillSlots —— **技能槽（4 格）的完整功能封装**（纯 TS，无 cc 依赖）
 *
 * 规则真源：`docs/prd/阶段模式_局内规则详解.md` §7.1「武器栏位」——
 *   ```
 *   Slot 1（索引 0）：英雄专属技能 —— **永久锁定，不可替换**
 *   Slot 2~4（索引 1~3）：可锁定 / 解锁，默认未锁定
 *   锁定(🔒) = 该槽不会被新技能替换     未锁定(🔓) = 获得新技能时可被替换
 *   ```
 *
 * ── 新技能落槽口径（宿主问卷定案，2026-09）──
 *   ① 已经拥有这个技能 → **原地升 1 级**（`max_level` 封顶，满级后商店不再出）；
 *   ② 否则 **优先填「索引最小的未锁定空槽」**；
 *   ③ 未锁定的槽都满了 → **替换「索引最小的未锁定槽」**（被换掉的技能从英雄身上摘掉，
 *      于是它会重新回到商店抽取池）；
 *   ④ **一个未锁定的槽都没有** → 发放失败，返回 `all_locked`（UI 飘字提示玩家去解锁）。
 *
 * ── 与「英雄自带的技能」的关系 ──
 *   英雄自带技能（units.json 的 `abilities`，不含普攻）按顺序占**最低的几个索引**（槽 0 一定是它，
 *   所以槽 0 天然就是「英雄专属技能」）；商店抽到的肉鸽技能占据其余槽位。
 *   换英雄（`attachHero`）时：自带技能重新按新英雄排布，**已抽到的肉鸽技能尽量保留在原槽**，
 *   装不下的（新英雄自带技能把位置占了）会丢，并打日志 —— 与「换英雄后等级/遗物/Buff 不变」同一口径。
 *
 * ── 状态（`ref`，由宿主 `Scene_Game_Stage` provide 给 UI 子树，键见 `StageScope`）──
 *   `slots`      4 个槽位的完整状态（技能 id / 等级 / 是否锁定）
 *   `cooldowns`  4 个槽位的**冷却进度 0~1**（1 = 刚进冷却、0 = 冷却结束），由宿主每帧 `tick()` 投影
 *   两者都由 `SkillSlotsVM`（只读面）暴露给 `SkillSlot` 组件，宿主 provide 的是**本类实例**。
 *
 * @example
 * ```ts
 * // 宿主（Scene_Game_Stage）
 * this.skillSlots = new SkillSlots({
 *     getHero: () => this.hero,
 *     getMaxLevel: (id) => ShopConfig.getSkillMaxLevel(ShopConfig.getAbility(id)),
 * })
 * this.scope.provide(StageScopeKeys.SkillSlots, this.skillSlots)   // 整个门面，不是逐条 ref
 * // 每帧：this.skillSlots.tick()
 * ```
 */

/** 技能槽数量（与预制件 `skills` 节点下的 4 个槽位一一对应） */
export const SKILL_SLOT_COUNT = 4;
/** 英雄专属技能槽的索引（永久锁定） */
export const HERO_SLOT_INDEX = 0;
/**
 * 槽 0 是否允许玩家解锁。
 * 设计稿口径是「永久锁定，不可替换」→ false；想让英雄专属技能也能被顶掉就改成 true。
 */
export const HERO_SLOT_UNLOCKABLE = false;

/** 一个技能槽的运行时状态 */
export interface SkillSlotState {
    /** 槽内的技能 id（0 = 空槽） */
    skillId: number;
    /** 技能等级（1~max_level；空槽为 0） */
    level: number;
    /** 是否锁定（锁定的槽不会被新技能替换） */
    locked: boolean;
}

/** 落槽方式（成功时） */
export type SkillGrantKind = 'filled' | 'replaced' | 'upgraded';

/** 失败原因 */
export type SkillGrantFailReason =
    /** 一个未锁定的槽都没有（UI 应飘字提示玩家去解锁） */
    | 'all_locked'
    /** 已拥有且已满级 */
    | 'max_level'
    /** 配置里没这个技能 */
    | 'unknown_skill'
    /** 还没选英雄 */
    | 'not_ready';

/**
 * 发放技能的结果。
 *
 * ⚠ 刻意写成**一个带可选字段的接口**，而不是 `{ok:true,...} | {ok:false,...}` 的判别联合：
 *   本项目的 `tsconfig` 是 `strict: false`（= `strictNullChecks: false`），
 *   那种联合在 `if (result.ok)` 之后**不会**收窄，调用方读 `result.reason` 会报
 *   「Property 'reason' does not exist」，只能到处写 as 断言，反而更脏。
 */
export interface SkillGrantResult {
    /** 是否发放成功 */
    ok: boolean;
    /** 成功时的落槽方式 */
    kind?: SkillGrantKind;
    /** 目标槽下标（成功时一定有） */
    index?: number;
    /** 被顶掉的技能 id（`kind='replaced'`） */
    replacedId?: number;
    /** 升级后的等级（`kind='upgraded'`） */
    level?: number;
    /** 失败原因（`ok=false`） */
    reason?: SkillGrantFailReason;
}

/** 切槽/换英雄时需要对英雄实体做的事（抽成接口，便于 Node 侧单测） */
export interface SkillOwner {
    abilities: AbilitySystem;
}

export interface SkillSlotsDeps {
    /** 本局英雄实体（未选英雄时为 null，本类内部一律空判） */
    getHero(): SkillOwner | null;
    /** 技能的最高等级（查 abilities.json 的 max_level；单位技能为 1） */
    getMaxLevel(skillId: number): number;
    /** 技能是否存在（配置校验用；缺省视为存在） */
    hasSkill?(skillId: number): boolean;
    /**
     * 槽位内容真的变了之后回调（升级 / 填槽 / 替换）。
     * 宿主用它把英雄技能列表重新投影到 store（`battleStore.heroSkills`）——
     * 本类不认识 store，也不该认识（它只管槽位规则）。
     */
    onChanged?(): void;
}

/**
 * SkillSlots 向局内 UI 暴露的**只读面**（宿主 `provide` 的是实例本身，用这个接口约束格子组件能碰什么）。
 *
 * ⚠ **动作不在只读面上**（`grant / toggleLock / setLocked / attachHero / reset` 都不声明）：
 *   格子组件点锁只 `scope.emit(SkillLockToggled, index)`，改状态的是宿主（真源在本类）。
 */
export interface SkillSlotsVM {
    /** 4 个槽位的完整状态（技能 id / 等级 / 是否锁定） */
    readonly slots: Ref<SkillSlotState[]>;
    /** 4 个槽位的冷却进度 0~1（1 = 刚进冷却、0 = 冷却结束） */
    readonly cooldowns: Ref<number[]>;
    /** 某个格子的状态（越界返回空槽对象，UI 不必自己判边界） */
    slotAt(index: number): SkillSlotState;
    /** 某个格子的冷却进度（越界返回 0） */
    cooldownAt(index: number): number;
}

export class SkillSlots {

    /* ===== 页面级状态（宿主 provide 给 UI 子树，槽位组件只读） ===== */

    /** 4 个槽位的完整状态（技能 id / 等级 / 是否锁定） */
    readonly slots: Ref<SkillSlotState[]> = ref<SkillSlotState[]>(SkillSlots.emptySlots());
    /** 4 个槽位的冷却进度 0~1（由 `tick()` 每帧投影；与 slots 同序） */
    readonly cooldowns: Ref<number[]> = ref<number[]>([0, 0, 0, 0]);

    private deps: SkillSlotsDeps;
    /**
     * **本局通过商店抽到（`grant`）的技能 id**，用来与「英雄自带技能」区分开。
     *
     * 为什么不能靠"当前不在 unitSkillIds 里"来判断：换英雄时新英雄的自带技能列表变了，
     * 上一任英雄的自带技能（比如火枪的 12）在新列表里就"不认识"了，
     * 会被误当成肉鸽技能一路带着走 —— 实测踩过（换英雄后槽位被旧英雄的技能占满、
     * 真正的肉鸽技能反而被挤掉）。所以归属要**记下来**，不靠反推。
     */
    private granted = new Set<number>();

    constructor(deps: SkillSlotsDeps) {
        this.deps = deps;
    }

    /* ===================================================================
     * 构造 / 复位
     * =================================================================== */

    /** 4 个空槽（槽 0 锁定，其余未锁定） */
    private static emptySlots(): SkillSlotState[] {
        const out: SkillSlotState[] = [];
        for (let i = 0; i < SKILL_SLOT_COUNT; i++) {
            out.push({ skillId: 0, level: 0, locked: i === HERO_SLOT_INDEX });
        }
        return out;
    }

    /** 换局：整体复位（清空技能、回到「只有槽 0 锁定」的初始态） */
    reset(): void {
        this.granted.clear();
        this.slots.value = SkillSlots.emptySlots();
        this.cooldowns.value = [0, 0, 0, 0];
    }

    /* ===================================================================
     * 英雄接线
     * =================================================================== */

    /**
     * 英雄就位 / 换英雄：按「英雄自带技能占最低索引 + 已抽到的肉鸽技能尽量留在原槽」重排，
     * 并把槽里的肉鸽技能重新挂到英雄实体上（换英雄时实体是新建的，技能得重新 AddAbility）。
     *
     * @param hero 新英雄实体
     * @param unitSkillIds 英雄**自带**的技能 id（units.json 的 abilities，去掉普攻；顺序即落槽顺序）
     */
    attachHero(hero: SkillOwner, unitSkillIds: number[]): void {
        const unit = (unitSkillIds ?? []).slice(0, SKILL_SLOT_COUNT);
        const unitSet = new Set(unit);

        // ① 先把「上一任英雄身上抽到的肉鸽技能」捞出来（保留原槽位与等级）
        //    ⚠ 认 `granted`（商店发过的），不是"不在 unitSet 里的" —— 后者会把上一任英雄的
        //      自带技能误当肉鸽技能带走（见 granted 字段的注释）
        const previous = this.slots.value;
        const carried: Array<{ skillId: number; level: number; prefer: number }> = [];
        for (let i = 0; i < previous.length; i++) {
            const s = previous[i];
            if (s.skillId > 0 && this.granted.has(s.skillId) && !unitSet.has(s.skillId)) {
                carried.push({ skillId: s.skillId, level: s.level, prefer: i });
            }
        }

        // ② 英雄自带技能占最低索引（槽 0 = 英雄专属技能，永久锁定）
        const next = SkillSlots.emptySlots();
        const taken = new Array<boolean>(SKILL_SLOT_COUNT).fill(false);
        for (let i = 0; i < unit.length; i++) {
            next[i].skillId = unit[i];
            next[i].level = 1;
            taken[i] = true;
        }
        // ③ 肉鸽技能：优先回到原槽，原槽被占则找下一个空槽；都满了就丢（打日志，不静默）
        const dropped: number[] = [];
        for (const c of carried) {
            if (c.prefer < SKILL_SLOT_COUNT && !taken[c.prefer]) {
                next[c.prefer].skillId = c.skillId;
                next[c.prefer].level = c.level;
                taken[c.prefer] = true;
                continue;
            }
            const free = taken.findIndex((t, i) => !t && i !== HERO_SLOT_INDEX);
            if (free >= 0) {
                next[free].skillId = c.skillId;
                next[free].level = c.level;
                taken[free] = true;
                continue;
            }
            dropped.push(c.skillId);
        }

        // ④ 锁状态按索引沿用玩家之前的设置（槽 0 永远锁定）
        for (let i = 0; i < SKILL_SLOT_COUNT; i++) {
            next[i].locked = i === HERO_SLOT_INDEX
                ? true
                : (previous[i]?.locked ?? false);
        }
        if (!HERO_SLOT_UNLOCKABLE) next[HERO_SLOT_INDEX].locked = true;

        this.slots.value = next;

        // ⑤ 把槽里的**肉鸽技能**重新挂到英雄实体上（英雄自带技能由 CreateEntityFromDef 已挂好）
        for (const s of next) {
            if (s.skillId <= 0 || unitSet.has(s.skillId)) continue;
            this.attachToHero(hero, s.skillId, s.level);
        }

        if (dropped.length) {
            // 放不下的肉鸽技能真的没了 → 归属表也要一起清（否则下次换英雄还会"记得"它）
            for (const id of dropped) this.granted.delete(id);
            console.warn(`[技能槽] 换英雄后放不下的肉鸽技能被丢弃：${dropped.join(', ')}`);
        }
        this.tick();
    }

    /** 把一个技能挂到英雄实体上并设好等级（已存在则只同步等级） */
    private attachToHero(hero: SkillOwner, skillId: number, level: number): void {
        const ability = hero.abilities.getAbility(skillId) ?? hero.abilities.AddAbility(skillId);
        if (!ability) {
            console.warn(`[技能槽] 技能挂载失败（配置缺失？）：${skillId}`);
            return;
        }
        ability.setLevel(Math.max(1, Math.floor(level) || 1));
    }

    /* ===================================================================
     * 锁定 / 解锁
     * =================================================================== */

    /**
     * 点击锁定图标：切换该槽的锁定状态。
     *
     * @returns true = 状态翻了；false = 拒绝（槽 0 永久锁定 / 索引越界）
     */
    toggleLock(index: number): boolean {
        if (!this.isValidIndex(index)) return false;
        if (!this.canToggleLock(index)) return false;
        const next = this.copySlots();
        next[index].locked = !next[index].locked;
        this.slots.value = next;
        return true;
    }

    /** 该槽能不能被玩家解锁（槽 0 按设计稿永久锁定 → false） */
    canToggleLock(index: number): boolean {
        if (!this.isValidIndex(index)) return false;
        return !(index === HERO_SLOT_INDEX && !HERO_SLOT_UNLOCKABLE);
    }

    /** 显式设置锁定状态（同上；越界 / 槽 0 永久锁定时返回 false） */
    setLocked(index: number, locked: boolean): boolean {
        if (!this.isValidIndex(index)) return false;
        if (index === HERO_SLOT_INDEX && !HERO_SLOT_UNLOCKABLE) return false;
        const next = this.copySlots();
        next[index].locked = !!locked;
        this.slots.value = next;
        return true;
    }

    /* ===================================================================
     * 发放技能（商店选中技能 → 落槽）
     * =================================================================== */

    /**
     * 发放一个技能：见类头「新技能落槽口径」。
     *
     * 幂等/可重复调用：已拥有 → 升级；否则填空槽；否则替换最低索引未锁定槽。
     */
    grant(skillId: number): SkillGrantResult {
        if (!skillId || skillId <= 0) return { ok: false, reason: 'unknown_skill' };
        if (this.deps.hasSkill && !this.deps.hasSkill(skillId)) {
            console.warn(`[技能槽] 配置里没有这个技能：${skillId}`);
            return { ok: false, reason: 'unknown_skill' };
        }
        const hero = this.deps.getHero();
        if (!hero) return { ok: false, reason: 'not_ready' };

        const maxLevel = Math.max(1, this.deps.getMaxLevel(skillId) || 1);

        // ① 已拥有 → 原地升级
        const owned = this.indexOf(skillId);
        if (owned >= 0) {
            const next = this.copySlots();
            const slot = next[owned];
            if (slot.level >= maxLevel) return { ok: false, reason: 'max_level' };
            slot.level = Math.min(maxLevel, slot.level + 1);
            this.slots.value = next;
            hero.abilities.getAbility(skillId)?.setLevel(slot.level);
            this.deps.onChanged?.();
            return { ok: true, kind: 'upgraded', index: owned, level: slot.level };
        }

        // ② 目标槽：优先「索引最小的未锁定空槽」，否则「索引最小的未锁定槽」
        const target = this.findFillTarget();
        if (target < 0) return { ok: false, reason: 'all_locked' };

        const next = this.copySlots();
        const replacedId = next[target].skillId;
        // 被顶掉的技能从英雄身上摘掉 → 它会重新回到商店抽取池
        if (replacedId > 0) {
            hero.abilities.RemoveAbility(replacedId);
            this.granted.delete(replacedId);
        }

        if (!hero.abilities.AddAbility(skillId)) {
            // 挂载失败（配置缺失）：把槽位回滚，避免 UI 显示一个不存在的技能
            console.warn(`[技能槽] 技能挂载失败，槽位未变更：${skillId}`);
            return { ok: false, reason: 'unknown_skill' };
        }
        next[target].skillId = skillId;
        next[target].level = 1;
        this.granted.add(skillId);
        this.slots.value = next;
        this.deps.onChanged?.();

        return replacedId > 0
            ? { ok: true, kind: 'replaced', index: target, replacedId }
            : { ok: true, kind: 'filled', index: target };
    }

    /** 落槽目标：优先空着的未锁定槽，其次任意未锁定槽；一个都没有返回 -1 */
    private findFillTarget(): number {
        const slots = this.slots.value;
        let firstUnlocked = -1;
        for (let i = 0; i < slots.length; i++) {
            const s = slots[i];
            if (s.locked) continue;
            if (s.skillId <= 0) return i;      // 空着的未锁定槽优先
            if (firstUnlocked < 0) firstUnlocked = i;
        }
        return firstUnlocked;                   // 都满了 → 替换索引最小的未锁定槽
    }

    /* ===================================================================
     * 查询
     * =================================================================== */

    /** 技能在哪个槽（-1 = 没拥有） */
    indexOf(skillId: number): number {
        return this.slots.value.findIndex((s) => s.skillId === skillId);
    }

    /** 已拥有该技能的等级（0 = 没拥有）——商店用它判「重复抽到可升级 / 满级不再出」 */
    getLevel(skillId: number): number {
        const i = this.indexOf(skillId);
        return i >= 0 ? this.slots.value[i].level : 0;
    }

    /** 商店抽取用的「已拥有技能 → 等级」表 */
    ownedLevels(): Map<number, number> {
        const out = new Map<number, number>();
        for (const s of this.slots.value) {
            if (s.skillId > 0) out.set(s.skillId, s.level);
        }
        return out;
    }

    /** 槽里的技能 id 列表（0 = 空槽；与槽位下标一一对应） */
    getSkillIds(): number[] {
        return this.slots.value.map((s) => s.skillId);
    }

    /**
     * 某个格子的状态 —— **越界返回一个空槽对象**（而不是 undefined）：
     * 格子组件（`SkillSlot`）拿到的一律是"有值的空槽"，不必自己判边界、也不会把 undefined 往表现层漏。
     */
    slotAt(index: number): SkillSlotState {
        return this.slots.value[index] ?? { skillId: 0, level: 0, locked: index === HERO_SLOT_INDEX };
    }

    /** 某个格子的冷却进度（越界返回 0） */
    cooldownAt(index: number): number {
        return this.cooldowns.value[index] ?? 0;
    }

    /** 还有没有可替换的槽（全锁 → false；商店选中技能前可以据此提前提示） */
    hasReplaceableSlot(): boolean {
        return this.slots.value.some((s) => !s.locked);
    }

    /* ===================================================================
     * 冷却投影
     * =================================================================== */

    /**
     * 每帧由宿主调用：把 4 个槽的**冷却进度**（1 = 刚进冷却、0 = 冷却结束）投影给 UI。
     *
     * 只有真的变了才写 ref —— 写 `ref` 会触发 UI 的 watcher，冷却期间本来就要每帧刷新，
     * 但**冷却结束后的静止期**不该继续无意义地唤醒 watcher。
     */
    tick(): void {
        const hero = this.deps.getHero();
        const slots = this.slots.value;
        const prev = this.cooldowns.value;
        const next: number[] = [];
        let changed = false;

        for (let i = 0; i < SKILL_SLOT_COUNT; i++) {
            const skillId = slots[i]?.skillId ?? 0;
            const ability = hero && skillId > 0 ? hero.abilities.getAbility(skillId) : undefined;
            const ratio = ability ? ability.getCooldownRatio() : 0;
            next.push(ratio);
            if (prev[i] !== ratio) changed = true;
        }
        if (changed) this.cooldowns.value = next;
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    private isValidIndex(index: number): boolean {
        return Number.isInteger(index) && index >= 0 && index < SKILL_SLOT_COUNT;
    }

    private copySlots(): SkillSlotState[] {
        return this.slots.value.map((s) => ({ ...s }));
    }
}
