import { DamageType } from './types';
import { HitShapeKind } from '../common/HitFeelConfig';
import { publishSkillShape } from './SkillShape';
import { MINE_DEFAULTS, MINE_KV } from '../common/MineConfig';

/**
 * ============================================================
 * BattleMines —— 「骷髅地雷」的完整功能封装（**纯 TS，无 cc 依赖**）
 * ============================================================
 *
 * 一句话：**每隔几秒在英雄攻击范围内随机埋一颗雷，敌人踩上去就炸**（上限 5 颗）。
 *
 * ── 三条已定案口径（用户 2026-11，改之前先读）──
 *   ① **满上限就停手**：到 `cap`（默认 5）之后**既不布雷、也不替换最老的** ——
 *      "上限"是这条流派唯一的真约束，玩法是"提前把雷铺在敌人必经之路上"。
 *      所以计时器照常空转（`place()` 返回 false），**不做"攒着补偿"**：
 *      一颗被踩掉之后，下一颗仍然要等满一个间隔。
 *   ② **物理伤害**：走 `DamagePipeline.ApplyDamage` 独立结算（各自吃护甲与减免），
 *      **不塞进普攻乘区** —— 那是"把普攻本身一起抬高"的老坑。
 *      三条流派因此分得开：斧王 = 纯粹反伤 / 莉娜 = 法术持续 / 本类 = 物理爆炸。
 *   ③ **不会被摧毁、无时限**：地雷**不是实体** —— 不进 `ctx.entities`、没有 hp、不进对象池，
 *      所以不吃 AoE、不会被 AI 索敌、也不会过期。唯一让它消失的方式是被踩。
 *
 * ── 数值一个都不写死 ──
 *   · **基础参数**（间隔 / 上限 / 触发半径 / 爆炸半径 / 伤害%）= 英雄技能那条
 *     `apply_modifier` 的 `kv`（`abilities#28`）；
 *   · **遗物改造**（急造 / 雷区 / 重装 / 扩爆 / 燃烧雷 / 连锁雷）= 遗物钩子各自的 `kv`。
 *   两者都挂成 Modifier，本类每帧用 **重算式**（不是增量累加）从 `hero.modifiers.getAll()` 现读
 *   —— 与 `ArchetypeTally` 同一条口径：换英雄 / 买第二层 / 遗物被移除都天然正确，
 *   而且**不需要任何 add/remove 记账**（那种记账在对象池复用下最容易漏摘）。
 *
 * ── 性能与三条实现纪律 ──
 *   ① **触发判定自己算距离**（`getEnemies()` + 平方距离），**不要**每颗雷都调
 *      `ctx.findEntitiesInRadius` —— 那是全表扫描，而且会顺带再上报一次爆炸形态；
 *   ② **爆炸形态上报真实半径**（`reportBlast`）：表现层的爆炸环与音效因此免费复用
 *      （与遗物溅射/死亡回响同一条"路 B"，见 `battle/SkillShape.ts`）；
 *   ③ **每颗雷一帧最多炸一次**：引爆时立刻从表里摘掉，连锁按"同一实例只炸一次"判
 *      （`indexOf < 0` 即已炸过）⇒ 连锁不会递归、也不会把同一颗雷算两次。
 *
 * 宿主接线：`BattleContext` 持有实例（`ctx.mines`），每帧 `tick(dt)`、换局 `reset()`；
 * 遗物/技能只要把带 `MINE_KV.*` 的 Modifier 挂到英雄身上，效果自动生效。
 */

/** 本类需要英雄提供的最小面（用结构类型而不是 `Entity`，便于体检注入替身） */
export interface MineHero {
    position?: { x: number; y: number };
    getAttackDamage?(): number;
    getAttackRange?(): number;
    modifiers?: { getAll?(): any[] };
}

/** 敌人最小面 */
export interface MineEnemy {
    position?: { x: number; y: number };
    IsDead?(): boolean;
    alive?: boolean;
}

/** 注入依赖（宿主 = `BattleContext`；体检注入替身） */
export interface MineDeps {
    /** 本局英雄实体；还没选英雄 / 已阵亡时返回 null */
    getHero(): MineHero | null;
    /** 当前存活的全部敌人（team = 2） */
    getEnemies(): MineEnemy[];
    /** 独立结算一段伤害（不得塞进乘区） */
    applyDamage(target: any, source: any, amount: number, type: DamageType): void;
    /** 上报一次爆炸形态（表现层用；体检可空实现） */
    reportBlast(x: number, y: number, radius: number): void;
    /** 随机源（体检钉死结果为可复现） */
    random(): number;
}

/** 一颗地雷（逻辑记录：**不是实体**，只有坐标） */
export interface MineRecord {
    id: number;
    x: number;
    y: number;
    /**
     * 是不是「陷阱」（局内技能）在击杀点留下的那一颗。
     *
     * 为什么要记这一位：`mineOnKill` 是**陷阱自己的预算**（最多留几颗），不是全池上限 ——
     * 全池上限永远是 `cap`（骷髅王 5 颗）。两者都得出于同一条判据里，
     * 否则"陷阱 Lv.1（2 颗）"会把骷髅王的池子从 5 颗压到 2 颗（一个越描越黑的 bug）。
     */
    fromKill?: boolean;
}

/** 一片「燃烧雷」留下的地面火（`mineBurnPct > 0` 才有） */
export interface BurnField {
    x: number;
    y: number;
    radius: number;
    /** 每秒伤害（已经算好的绝对值，不是百分比） */
    dps: number;
    /** 剩余秒数 */
    left: number;
}

/** 当前生效的地雷参数（基础参数 + 遗物改造，全部由 `resolveMineRuntime` 重算） */
export interface MineRuntime {
    /** 有没有任何地雷行 —— false = 本局不布雷（非地雷英雄天然如此） */
    active: boolean;
    /** 布雷间隔（秒，已过「急造」与下限钳制） */
    interval: number;
    /** 地雷上限（颗） */
    cap: number;
    /** 触发半径（像素） */
    triggerRadius: number;
    /** 爆炸半径（像素） */
    blastRadius: number;
    /** 爆炸伤害（攻击力百分比） */
    damagePct: number;
    /** 燃烧地面每秒伤害（攻击力百分比；0 = 没有） */
    burnPct: number;
    /** 连锁：引爆时最多连带引爆几颗相邻地雷（0 = 没有） */
    chain: number;
    /** 局内技能「陷阱」：击杀时留雷的上限（0 = 没有这个技能） */
    onKill: number;
}

/** 取一个有限数（配表里 `null` / 字符串 / `NaN` 一律当 0，静默失效是最难查的一类错） */
function num(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** 读一条 Modifier 的 kv（真 `Modifier` 走 `getKV()`；体检替身可以直接给 `kv` 字段） */
function kvOf(m: any): Record<string, any> | null {
    if (!m) return null;
    const kv = typeof m.getKV === 'function' ? m.getKV() : m.kv;
    return kv && typeof kv === 'object' ? kv : null;
}

/**
 * **重算**当前地雷参数（导出成纯函数：体检不需要造整个战斗就能验）。
 *
 * 两类来源合并规则（写成一张表，免得以后再猜）：
 *   · **基础参数**（interval/cap/triggerRadius/blastRadius/damagePct）：**相加**（正常只有英雄技能给）
 *   · **遗物改造**：`interval × (1 − Σ急造%)`、`cap + Σ雷区`、`radius + Σ扩爆`、
 *     `damagePct + Σ重装`、`burnPct` 相加、`chain` 相加
 *   · 顺序无关（都是加法/一次乘法），所以"遗物先后抽到"不影响结果
 */
export function resolveMineRuntime(modifiers: any[] | undefined): MineRuntime {
    let baseInterval = 0;
    let baseCap = 0;
    let triggerRadius = 0;
    let blastRadius = 0;
    let damagePct = 0;
    let yieldPct = 0;
    let capAdd = 0;
    let blastPct = 0;
    let radiusAdd = 0;
    let burnPct = 0;
    let chain = 0;
    let onKill = 0;

    for (const m of modifiers ?? []) {
        const kv = kvOf(m);
        if (!kv) continue;
        baseInterval += num(kv[MINE_KV.interval]);
        baseCap += num(kv[MINE_KV.cap]);
        triggerRadius += num(kv[MINE_KV.triggerRadius]);
        blastRadius += num(kv[MINE_KV.blastRadius]);
        damagePct += num(kv[MINE_KV.damagePct]);
        yieldPct += num(kv[MINE_KV.yieldPct]);
        capAdd += num(kv[MINE_KV.capAdd]);
        blastPct += num(kv[MINE_KV.blastPct]);
        radiusAdd += num(kv[MINE_KV.radiusAdd]);
        burnPct += num(kv[MINE_KV.burnPct]);
        chain += num(kv[MINE_KV.chain]);
        onKill += num(kv[MINE_KV.onKill]);
    }

    const active = baseInterval > 0;
    /**
     * 间隔**四舍五入到 3 位小数**。
     *
     * 理由不是洁癖：`6 × (1 − 20/100)` 在浮点下是 `4.800000000000001`，
     * 配表里写着 20%、界面上算出来却是这个数 —— 体检对不上、日志看不懂，
     * 而且"两件急造叠起来到底几秒"这种问题会被浮点噪声掩盖。
     */
    const interval = active
        ? Math.max(MINE_DEFAULTS.intervalMin, baseInterval * (1 - yieldPct / 100))
        : 0;
    return {
        active,
        interval: Math.round(interval * 1000) / 1000,
        cap: Math.max(0, (baseCap > 0 ? baseCap : MINE_DEFAULTS.cap) + capAdd),
        triggerRadius: triggerRadius > 0 ? triggerRadius : MINE_DEFAULTS.triggerRadius,
        blastRadius: Math.max(0, (blastRadius > 0 ? blastRadius : MINE_DEFAULTS.blastRadius) + radiusAdd),
        damagePct: Math.max(0, (damagePct > 0 ? damagePct : MINE_DEFAULTS.damagePct) + blastPct),
        burnPct: Math.max(0, burnPct),
        chain: Math.max(0, Math.floor(chain)),
        onKill: Math.max(0, Math.floor(onKill)),
    };
}

/** 两点距离的平方（触发/半径判定一律用平方，避免开方） */
function dist2(ax: number, ay: number, bx: number, by: number): number {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}

/** 敌人是不是还活着（兼容 `IsDead()` 与 `alive` 两种写法 —— 体检替身只给后者） */
function enemyAlive(e: MineEnemy | null | undefined): boolean {
    if (!e) return false;
    if (typeof e.IsDead === 'function') return !e.IsDead();
    if (typeof e.alive === 'boolean') return e.alive;
    return true;
}

export class BattleMines {
    /** 场上待引爆的地雷（**顺序 = 布雷顺序**；表现层照它画） */
    private mines: MineRecord[] = [];
    /** 燃烧地面 */
    private fields: BurnField[] = [];
    private nextId = 1;
    /** 距下一颗雷的计时（秒） */
    private timer = 0;
    /** 统计（体检 / 调试用）：放下去过几颗、炸过几颗、因为满上限空转了几次 */
    private placedCount = 0;
    private detonatedCount = 0;
    private skippedFullCount = 0;

    constructor(private readonly deps: MineDeps) { }

    /* ------------------------------------------------------------------ 查询面 */

    /** 场上还剩几颗待引爆的雷 */
    get count(): number { return this.mines.length; }

    /** 地雷列表（只读；表现层用它画地上的雷） */
    list(): readonly MineRecord[] { return this.mines; }

    /** 燃烧地面列表（只读） */
    burnFields(): readonly BurnField[] { return this.fields; }

    /** 统计面（体检用） */
    get stats(): { placed: number; detonated: number; skippedFull: number } {
        return { placed: this.placedCount, detonated: this.detonatedCount, skippedFull: this.skippedFullCount };
    }

    /** 当前英雄身上的地雷参数（重算式，每帧现读） */
    runtime(hero?: MineHero | null): MineRuntime {
        const h = hero ?? this.deps.getHero();
        return resolveMineRuntime(h?.modifiers?.getAll?.());
    }

    /* ------------------------------------------------------------------ 动作面 */

    /**
     * 清空本局状态（换局 / 换英雄时由宿主调用）。
     *
     * ⚠ 换英雄必须调（`rebind` 那条路）：上一个英雄埋的雷不该留给下一个英雄，
     *   而且计时器要一起归零（否则新英雄上来先白得一颗）。
     */
    reset(): void {
        this.mines = [];
        this.fields = [];
        this.nextId = 1;
        this.timer = 0;
        this.placedCount = 0;
        this.detonatedCount = 0;
        this.skippedFullCount = 0;
    }

    /**
     * 放一颗雷（在英雄攻击范围内的随机点）。
     *
     * @returns 真的放下了 = true；**满上限 / 没有英雄 / 没有地雷行 / 攻击范围为 0** = false
     */
    place(rt?: MineRuntime, hero?: MineHero | null): boolean {
        const h = hero ?? this.deps.getHero();
        if (!h) return false;
        const cfg = rt ?? this.runtime(h);
        if (!cfg.active) return false;
        // 用户口径①：满上限就停手 —— 不替换最老的、也不排队补偿
        if (this.mines.length >= cfg.cap) {
            this.skippedFullCount++;
            return false;
        }

        const range = num(h.getAttackRange?.());
        const radius = range * MINE_DEFAULTS.placeRadiusMul;
        if (!(radius > 0)) return false;

        const hx = num(h.position?.x);
        const hy = num(h.position?.y);
        let x = hx;
        let y = hy;
        for (let i = 0; i < MINE_DEFAULTS.placeRetry; i++) {
            const angle = this.deps.random() * Math.PI * 2;
            // sqrt 让落点在圆内**面积均匀**（不 sqrt 会挤在圆心）
            const dist = radius * Math.sqrt(Math.max(0, Math.min(1, this.deps.random())));
            x = hx + Math.cos(angle) * dist;
            y = hy + Math.sin(angle) * dist;
            if (!this.tooClose(x, y)) break;
            // 重掷全失败 → 照放：宁可挨近一点，也不许"玩家看不见任何反应"（见方法注释）
        }

        this.mines.push({ id: this.nextId++, x, y });
        this.placedCount++;
        return true;
    }

    /**
     * **击杀时留雷**（局内技能「陷阱」的入口，由宿主在 `OnKill` 里调）。
     *
     * 两条判据**同时**成立才放：
     *   ① 全池上限 `cap` 还没满（骷髅王 5 颗；没有地雷技能时走 `MINE_DEFAULTS.cap`）；
     *   ② **陷阱自己的预算** `onKill` 还没用完（数的是"场上由陷阱留下的那几颗"，见 `MineRecord.fromKill`）。
     *
     * ⚠ **不要求英雄会布雷**（`rt.active`）：局内技能是"跨流派的通用碎片"，任何英雄抽到它都该能用 ——
     *   所以半径 / 伤害 / 上限在"没有地雷技能"时走 `MINE_DEFAULTS` 的兜底（`resolveMineRuntime` 已经兜好）。
     * ⚠ 用 `min(cap, onKill)` 是**错的**（曾经那么写）：那会让"陷阱 Lv.1 = 2 颗"把骷髅王的池子
     *   从 5 颗压到 2 颗 —— 抽到一个技能反而变弱。两个上限是**两件事**，必须分开数。
     * 满上限同样**直接放弃**（不替换）。
     */
    placeOnKill(x: number, y: number, hero?: MineHero | null): boolean {
        const h = hero ?? this.deps.getHero();
        const cfg = this.runtime(h);
        if (cfg.onKill <= 0) return false;
        if (this.mines.length >= cfg.cap) {
            this.skippedFullCount++;
            return false;
        }
        let trapCount = 0;
        for (const m of this.mines) if (m.fromKill) trapCount++;
        if (trapCount >= cfg.onKill) {
            this.skippedFullCount++;
            return false;
        }
        this.mines.push({ id: this.nextId++, x, y, fromKill: true });
        this.placedCount++;
        return true;
    }

    /**
     * **立刻引爆场上全部地雷**（掉落 Buff「引爆器」的入口）。
     *
     * 语义：这是**手动择时**的那一下 —— 玩家攒满 5 颗再按，收益远大于一颗颗被踩掉，
     * 所以它必须是一次性、由玩家按出来的（不是被动效果）。
     *
     * @param bonusPct 这一波额外的伤害加成（百分数，`50` = +50% 攻击力；0 = 不加）
     * @returns 真的炸了几颗（0 = 场上没雷，宿主据此决定要不要飘字/播音效）
     */
    detonateAll(bonusPct = 0): number {
        const hero = this.deps.getHero();
        if (!hero || !this.mines.length) return 0;
        const cfg = this.runtime(hero);
        const rt: MineRuntime = bonusPct > 0
            ? { ...cfg, damagePct: cfg.damagePct + bonusPct }
            : cfg;
        // 快照后再逐颗引爆：引爆会改表（连锁还会再删），边遍历边删是这类代码的经典翻车点
        const all = this.mines.slice();
        let n = 0;
        for (const m of all) if (this.detonate(m, rt, hero)) n++;
        return n;
    }

    /** 每帧推进（宿主排在 `ctx.Tick` 同一条链上） */
    tick(dt: number): void {
        if (!(dt > 0)) return;
        const hero = this.deps.getHero();
        if (!hero) return;
        const rt = this.runtime(hero);
        if (!rt.active) return;

        // ① 布雷（满上限就停手，且**不攒补偿** —— 见下）
        this.timer += dt;
        let guard = 0;
        while (this.timer >= rt.interval && guard++ < 8) {
            this.timer -= rt.interval;
            /**
             * ⚠ `place()` 返回 false 只有一种可能：**到了上限**（没有英雄/没有地雷行/范围 0
             *   在进循环之前就已经被挡掉了）。此时要把**整段积压的计时一起丢掉并跳出**。
             *
             * 为什么要丢：只"照常扣一个间隔"会让计时器在满雷期间越攒越多（大 dt 下尤其明显），
             * 等场上几颗被踩掉之后**一次性连补好几颗** —— 那就成了"满上限也在偷偷排产"，
             * 与用户口径「满 5 颗就不布雷」不是一回事，而且爆炸会挤在同一帧。
             */
            if (!this.place(rt, hero)) {
                this.timer = 0;
                break;
            }
        }

        // ② 燃烧地面（**排在引爆之前**：本帧新留下的火从下一帧才开始烧/倒计时，
        //    否则"持续 3 秒"会在出生的那一帧就被扣掉一个 dt）
        this.tickBurn(dt, hero);

        // ③ 触发：先收集、再逐颗引爆（引爆会改表，边遍历边删是这类代码的经典翻车点）
        const enemies = this.deps.getEnemies() ?? [];
        if (enemies.length) {
            const trig2 = rt.triggerRadius * rt.triggerRadius;
            const toBlow: MineRecord[] = [];
            for (const mine of this.mines) {
                for (const e of enemies) {
                    if (!enemyAlive(e)) continue;
                    if (dist2(num(e.position?.x), num(e.position?.y), mine.x, mine.y) <= trig2) {
                        toBlow.push(mine);
                        break;
                    }
                }
            }
            for (const mine of toBlow) this.detonate(mine, rt, hero);
        }
    }

    /* ------------------------------------------------------------------ 内部 */

    /** 与已有地雷挨得太近？（挨太近会被一次连环踩爆，"上限 5"就失去意义） */
    private tooClose(x: number, y: number): boolean {
        const g2 = MINE_DEFAULTS.minGap * MINE_DEFAULTS.minGap;
        for (const m of this.mines) {
            if (dist2(x, y, m.x, m.y) < g2) return true;
        }
        return false;
    }

    /** 爆炸伤害（攻击力 × 百分比，至少 1 点 —— 0 伤害的爆炸在表现上等于没炸） */
    private blastDamage(hero: MineHero, pct: number): number {
        const atk = num(hero.getAttackDamage?.());
        if (!(atk > 0) || !(pct > 0)) return 0;
        return Math.max(1, Math.round(atk * pct / 100));
    }

    /** 半径内的存活敌人（自己算距离，见文件头纪律①） */
    private enemiesInRadius(x: number, y: number, radius: number): MineEnemy[] {
        const r2 = radius * radius;
        const out: MineEnemy[] = [];
        for (const e of this.deps.getEnemies() ?? []) {
            if (!enemyAlive(e)) continue;
            if (dist2(num(e.position?.x), num(e.position?.y), x, y) <= r2) out.push(e);
        }
        return out;
    }

    /**
     * 引爆一颗雷。
     *
     * @param chainLeft 本颗还能连带引爆几颗邻居（0 = 不连锁）
     * @returns 真的炸了 = true；已经被同一帧的连锁炸过 = false
     */
    private detonate(mine: MineRecord, rt: MineRuntime, hero: MineHero, chainLeft = rt.chain): boolean {
        const idx = this.mines.indexOf(mine);
        if (idx < 0) return false;             // 已炸过（连锁里被别的雷带走的）
        this.mines.splice(idx, 1);
        this.detonatedCount++;

        // 表现：真实半径的爆炸形态 —— 打击反馈的爆炸环/音效免费复用
        this.deps.reportBlast(mine.x, mine.y, rt.blastRadius);

        const dmg = this.blastDamage(hero, rt.damagePct);
        if (dmg > 0) {
            for (const e of this.enemiesInRadius(mine.x, mine.y, rt.blastRadius)) {
                this.deps.applyDamage(e, hero, dmg, DamageType.Physical);
            }
        }

        // 燃烧雷：原地留一片火
        if (rt.burnPct > 0) {
            const dps = this.blastDamage(hero, rt.burnPct);
            if (dps > 0) {
                this.fields.push({
                    x: mine.x, y: mine.y, radius: rt.blastRadius,
                    dps, left: MINE_DEFAULTS.burnSeconds,
                });
            }
        }

        // 连锁雷：同一次引爆最多带 chain 颗邻居，邻居再连锁时额度 -1（防指数级扩散）
        if (chainLeft > 0) {
            const r2 = MINE_DEFAULTS.chainRadius * MINE_DEFAULTS.chainRadius;
            const neighbours = this.mines
                .filter((o) => dist2(o.x, o.y, mine.x, mine.y) <= r2)
                .slice(0, chainLeft);
            for (const n of neighbours) this.detonate(n, rt, hero, chainLeft - 1);
        }
        return true;
    }

    /** 燃烧地面：按 dt 结算伤害 + 倒计时 */
    private tickBurn(dt: number, hero: MineHero): void {
        if (!this.fields.length) return;
        const alive: BurnField[] = [];
        for (const f of this.fields) {
            const dmg = f.dps * dt;
            if (dmg > 0) {
                for (const e of this.enemiesInRadius(f.x, f.y, f.radius)) {
                    this.deps.applyDamage(e, hero, dmg, DamageType.Physical);
                }
            }
            f.left -= dt;
            if (f.left > 0) alive.push(f);
        }
        this.fields = alive;
    }
}

/**
 * 爆炸形态上报的**默认实现**（宿主接线用一行）。
 *
 * 单独导出是为了让宿主 / 体检都能复用同一条口径（半径一律**像素**，见 `SkillShape.ts`）。
 */
export function reportMineBlast(ctx: any, x: number, y: number, radius: number): void {
    publishSkillShape(ctx, {
        shape: HitShapeKind.Blast,
        cx: x,
        cy: y,
        radius,
    });
}
