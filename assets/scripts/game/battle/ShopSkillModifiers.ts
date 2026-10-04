import { Modifier } from './Modifier';
import { BattleEvents, DamageType, DispelLevel, MODIFY_ATTR_TEMPLATE_ID } from './types';
import { AttributeType } from './core/Types';
import { BattleConstUtil } from './core/BattleConstUtil';
import type { BattleContext } from './BattleContext';

/**
 * ============================================================
 * ShopSkillModifiers —— 肉鸽商店技能（abilities.json scope='shop'，id 101~130）的脚本实现
 * ============================================================
 *
 * 为什么这 30 条技能里有一大半必须写脚本（审查结论见 `docs/skill-icons/README.md` §2/§4）：
 *   ① **伤害数值是绝对数** —— `damage` / `aoe_damage` / `tick_damage` 只有 `value:number`、
 *      **没有 `var` 绑定**（只有 `modify_attr` 的属性条目支持 var/attrs_var），
 *      而肉鸽里「造成 50% 攻击力」必须跟着攻击力成长 → 只能脚本按 `host.getAttackDamage()` 算；
 *   ② **声明式动作只有 `chance`、没有条件判断** —— 「目标满血？」「生命 <30%？」「满 5 层？」
 *      「护盾够不够？」全都要脚本；
 *   ③ **护盾是 `on_block_damage` 事件里的一个可变字段**（`DamagePipeline` 第 3 阶段），
 *      声明式动作写不了这个字段；
 *   ④ **只有 5 个事件会派发给 Modifier**（`on_attack_start` / `on_attack_landed` /
 *      `on_block_damage` / `on_take_damage` / `on_deal_damage`），`on_kill` 等**只发总线**
 *      → 要「击杀时」必须自己 `ctx.bus.on(...)`，并且**必须在 `OnDestroy` 里 `off`**
 *      （实体走对象池复用，不摘会把已回收的实例继续算进去）。
 *
 * 三条纪律（每一条都有具体原因，别省）：
 *   · `bus.on` 一定配 `bus.off`（`OnDestroy`），并用 `subscribed` 标志防重复注册；
 *   · **不要依赖 `modifiers.cd`** —— `Modifier.Trigger()/OnTriggered()` 全工程零调用方，
 *     `cd` 是死代码；周期性行为一律自己在 `OnTick(dt)` 里计时；
 *   · **防递归** —— 脚本自己打出的伤害会再次派发事件（126 暴击连锁尤其危险），用 busy 标志过滤。
 *
 * 数值**全部**由配表通过 `apply_modifier` 的 `kv` 传入（见 `modifiers.json` 的 40~67 行），
 * 改数值不用碰代码。
 *
 * 注册入口与英雄那套脚本同一个（`Scene_Game_Stage.initBattle`，见该文件 `registerClass` 段）。
 */

/** 本文件用到的 Modifier id（与 `modifiers.json` 逐行对应；落表脚本同源同号） */
export const SHOP_MOD = {
    SplitShot: 40,
    PiercingBolt: 41,
    IronShell: 42,
    FirstStrike: 43,
    GoldRush: 44,
    DivineShield: 45,
    Boomerang: 46,
    HomingShot: 47,
    Grenade: 48,
    FlameBlade: 49,
    Ignite: 50,
    VenomBlade: 51,
    Poison: 52,
    FrostSlow: 53,
    FrostBlade: 54,
    ChainLightning: 55,
    StaticStack: 56,
    StaticField: 57,
    ShadowCut: 58,
    KillEcho: 59,
    SentryTurret: 60,
    MirrorImage: 61,
    ElementalLegion: 62,
    CritChain: 63,
    EvadeCounter: 64,
    WarBanner: 65,
    ArmorBreak: 66,
    TimeRewind: 67,
} as const;

/** 公共 Modifier（`modifiers.json` 里既有的行，不新造） */
const MOD_INVULNERABLE = 6;   // 无敌（apply_state invulnerable）
const MOD_STUNNED = 7;        // 眩晕（apply_state stunned，默认 1.5 秒）
/** 链式弹射的默认索敌半径（像素）——与 `Modifier_ZeusThunder` 同一口径 */
const CHAIN_RANGE_PX = 260;

// ============================================================
// 公共小工具（全部无状态，避免每个类各写一份）
// ============================================================

/** 米 → 像素（唯一口径：`battle_constants.pxPerMeter`） */
function meters(m: number): number {
    return m * BattleConstUtil.getPxPerMeter();
}

/** 实体是否可被继续结算（非空 + 未死） */
function alive(e: any): boolean {
    return !!e && !e.IsDead?.();
}

/** 两个实体的平方距离（缺 position 时按 0 处理，与工程其它索敌代码一致） */
function dist2(a: any, b: any): number {
    const dx = (a?.position?.x ?? 0) - (b?.position?.x ?? 0);
    const dy = (a?.position?.y ?? 0) - (b?.position?.y ?? 0);
    return dx * dx + dy * dy;
}

/** 场上存活敌人（team=2），按离 `from` 的距离升序；`exclude` 排除自己人/已命中者 */
function enemies(ctx: BattleContext, from: any, exclude?: Set<number>): any[] {
    const out: any[] = [];
    for (const e of ctx.GetTeamEntities(2) ?? []) {
        if (!alive(e)) continue;
        if (exclude && exclude.has(e.uid)) continue;
        out.push(e);
    }
    out.sort((a, b) => dist2(a, from) - dist2(b, from));
    return out;
}

/**
 * 链式弹射：从 `start` 出发，每次找**当前落点附近**最近的未命中敌人，跳 `jumps` 次。
 *
 * 为什么不能声明式：`projectile` 动作只能一次性按策略选 N 个目标，做不出
 * 「上一跳的落点决定下一跳」（`Modifier_ZeusThunder` 的弹射也是同样的实现）。
 * `visited` 必须有 —— 否则两个敌人之间会来回弹。
 */
function chain(
    ctx: BattleContext, start: any, jumps: number, rangePx: number,
    deal: (target: any, index: number) => void,
): void {
    const visited = new Set<number>([start.uid]);
    const r2 = rangePx * rangePx;
    let cur = start;
    for (let i = 1; i <= jumps; i++) {
        let next: any = null;
        let best = Infinity;
        for (const e of ctx.GetTeamEntities(2) ?? []) {
            if (!alive(e) || visited.has(e.uid)) continue;
            const d = dist2(e, cur);
            if (d <= r2 && d < best) { best = d; next = e; }
        }
        if (!next) return;
        visited.add(next.uid);
        deal(next, i);
        cur = next;
    }
}

/** 以 `center` 为圆心对敌人打一圈（含圆心上的那个实体本身） */
function aoe(ctx: BattleContext, center: any, radiusPx: number, hit: (target: any) => void): void {
    for (const e of ctx.findEntitiesInRadius(center, radiusPx, 2)) {
        if (alive(e)) hit(e);
    }
}

// ============================================================
// 101 分裂弹 —— 普攻命中后对同一目标追加 N 段 atk×pct 的伤害
// ============================================================

/**
 * 分裂弹（101）。`kv = { count, pct }`
 *
 * 「额外射出 1/2/3 枚子弹」＝**分开结算的追加伤害段**（各自走一遍伤害管线，
 * 所以每段独立 roll 暴击、独立吃护甲与受伤倍率 —— 这正是「额外子弹」的语义）。
 * 文案里的「l3 可触发暴击」因此是**天然成立**的，不需要额外实现。
 */
export class Modifier_SplitShot extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim)) return false;

        const atk = host.getAttackDamage?.() ?? 0;
        if (atk <= 0) return false;
        const kv = this.getKV() ?? {};
        const count = Math.max(0, Math.floor(Number(kv.count ?? 1)));
        const pct = Number(kv.pct ?? 0.5);
        if (count <= 0 || pct <= 0) return false;

        const extra = Math.max(1, Math.round(atk * pct));
        for (let i = 0; i < count; i++) {
            if (!alive(victim)) break;
            ctx.damagePipeline.ApplyDamage(victim, host, extra, DamageType.Physical);
        }
        return false;
    }
}

// ============================================================
// 102 穿透弹 —— 沿「英雄 → 中弹者」方向，打中弹者身后的敌人
// ============================================================

/**
 * 穿透弹（102）。`kv = { count, pct, spread }`
 *
 * 方向按**实际站位**算：把敌人投影到「英雄→中弹者」这条射线上，
 * 只取比中弹者更远（`proj > victimProj`）且在锥角内（`perp <= proj × spread`）的，
 * 按投影距离从近到远取 `count` 个。
 * 声明式的 `projectile` 只能按 nearest/random 等策略选人，选不出「一条直线上更远的那些」。
 */
export class Modifier_PiercingBolt extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim)) return false;

        const atk = host.getAttackDamage?.() ?? 0;
        if (atk <= 0) return false;
        const kv = this.getKV() ?? {};
        const count = Math.max(0, Math.floor(Number(kv.count ?? 1)));
        const pct = Number(kv.pct ?? 0.6);
        const spread = Number(kv.spread ?? 0.6);
        if (count <= 0 || pct <= 0) return false;

        const me = host.position ?? { x: 0, y: 0 };
        const dx = (victim.position?.x ?? 0) - me.x;
        const dy = (victim.position?.y ?? 0) - me.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-3) return false;          // 与目标重合，没有可用方向
        const ux = dx / len;
        const uy = dy / len;

        const picked: { e: any; proj: number }[] = [];
        for (const e of ctx.GetTeamEntities(2) ?? []) {
            if (!alive(e) || e === victim) continue;
            const ex = (e.position?.x ?? 0) - me.x;
            const ey = (e.position?.y ?? 0) - me.y;
            const proj = ex * ux + ey * uy;
            const perp = Math.abs(-ex * uy + ey * ux);
            if (proj > len && perp <= proj * spread) picked.push({ e, proj });
        }
        picked.sort((a, b) => a.proj - b.proj);

        const dmg = Math.max(1, Math.round(atk * pct));
        for (const p of picked.slice(0, count)) {
            if (!alive(p.e)) continue;
            ctx.damagePipeline.ApplyDamage(p.e, host, dmg, DamageType.Physical);
        }
        return false;
    }
}

// ============================================================
// 108 铁壳（l3 的格挡半句）—— 往 on_block_damage 的 blocked 字段里写数
// ============================================================

/**
 * 铁壳（108）三阶的「受击 10% 几率格挡 50%」。
 *
 * 护甲那半句是**纯声明式**（`modify_attr [6, +2/+4/+7, add]`，见 abilities.json），
 * 只有格挡必须写脚本：本作的「格挡/护盾」不是实体字段，而是 `DamagePipeline` 第 3 阶段
 * 造一个带可变字段 `blocked` 的事件派发出去、再 `damage -= blocked`（见 `DamagePipeline:103-110`），
 * 声明式动作写不了这个字段。
 *
 * 注：护甲是**双曲减伤曲线**（`1 - 0.06a/(1+0.06|a|)`），+2/+4/+7 护甲 ≈ 10.7%/19.4%/29.6% 物理减伤，
 * 所以文案直接写护甲值而不是原稿的「减伤 +6%/+10%/+18%」。
 */
export class Modifier_IronShell extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_block_damage') return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;
        const kv = this.getKV() ?? {};
        const chance = Number(kv.chance ?? 0.1);
        const pct = Number(kv.pct ?? 0.5);
        if (chance <= 0 || pct <= 0) return false;
        if (Math.random() >= chance) return false;
        const dmg = Number(event?.damage ?? 0);
        if (dmg <= 0) return false;
        event.blocked = (event.blocked ?? 0) + dmg * pct;
        return false;
    }
}

// ============================================================
// 109 首击 —— 「目标满血？」要在掉血**之前**判定
// ============================================================

/**
 * 首击（109）。`kv = { pct, haste, hasteSec }`
 *
 * ⚠ **关键时序**：`on_attack_landed` 是在 `ApplyDamage` **之后**派发的
 * （`Entity.resolveAttackHit:395-399`），此时目标已经掉血了 ——
 * 「对满生命敌人」在那里判会**永远为假**。所以走两段：
 *   · `on_attack_start`（伤害之前）记下「这一发打的是满血目标」；
 *   · `on_attack_landed` 消费这个标记再追加伤害。
 *
 * l3 的「击杀后攻速 +15%（2 秒）」挂在总线上：`on_kill` **只 publish、不派发给 Modifier**，
 * 所以只能自己订阅 `ctx.bus`（并必须在 `OnDestroy` 里 off）。
 */
export class Modifier_FirstStrike extends Modifier {
    /** 「这一发打的是满血目标」的目标 uid 集合（按 uid 存，防对象池复用后认错实体） */
    private fullHpTargets = new Set<number>();
    private subscribed = false;

    OnCreated(kv?: Record<string, any>): void {
        super.OnCreated(kv);
        const host = this.target as any;
        const ctx: BattleContext | undefined = host?.ctxRef;
        if (!ctx?.bus || this.subscribed) return;
        this.subscribed = true;
        ctx.bus.on(BattleEvents.OnKill, this.onKill, this);
    }

    OnDestroy(): void {
        const host = this.target as any;
        const ctx: BattleContext | undefined = host?.ctxRef;
        if (ctx?.bus && this.subscribed) {
            ctx.bus.off(BattleEvents.OnKill, this.onKill, this);
            this.subscribed = false;
        }
        this.fullHpTargets.clear();
    }

    /** 击杀者是宿主 → 加一段临时攻速（走「属性修改」共享模板，到期自动摘） */
    private onKill = (event: any): void => {
        const host = this.target as any;
        if (!host || event?.killer !== host) return;
        const kv = this.getKV() ?? {};
        const haste = Number(kv.haste ?? 0);
        const sec = Number(kv.hasteSec ?? 0);
        if (haste <= 0 || sec <= 0) return;
        if (!alive(host)) return;
        host.modifiers?.AddModifier(
            MODIFY_ATTR_TEMPLATE_ID, host, sec,
            { attrs: [[AttributeType.AtkSpeed, haste, 'add']] }, this.origin,
        );
    };

    OnBattleEvent(eventName: string, event: any): boolean {
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;

        if (eventName === 'on_attack_start') {
            const t = event?.target as any;
            if (!t?.uid) return false;
            const max = t.getMaxHp?.() ?? 0;
            if (max > 0 && (t.hp ?? 0) >= max) this.fullHpTargets.add(t.uid);
            else this.fullHpTargets.delete(t.uid);
            return false;
        }
        if (eventName !== 'on_attack_landed') return false;

        const victim = event?.target as any;
        if (!victim?.uid || !this.fullHpTargets.has(victim.uid)) return false;
        this.fullHpTargets.delete(victim.uid);
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim)) return false;

        const atk = host.getAttackDamage?.() ?? 0;
        const pct = Number(this.getKV()?.pct ?? 0);
        if (atk <= 0 || pct <= 0) return false;
        ctx.damagePipeline.ApplyDamage(victim, host, Math.max(1, Math.round(atk * pct)), DamageType.Physical);
        return false;
    }
}

// ============================================================
// 111 淘金 —— 击杀奖励挂在总线上，不在 Modifier 事件里
// ============================================================

/**
 * 淘金（111）。`kv = { gold }`
 *
 * `on_kill` **只 `bus.publish`、从不派发给 Modifier**（`DamagePipeline:140`），
 * 所以声明式 `events[{event:'on_kill'}]` 永远不触发（静默失效，这类坑见 README §2.1）。
 * 脚本自己订阅总线即可 —— 代价是必须自己 `off`。
 *
 * 原稿 l2/l3 的「金币加成 +8%/+16%」与「波次利息 +5%」在本作**无处安放**
 * （属性表里没有「金币获取」，`goldGain` 是没有 `AttributeType` 的派生属性之一），
 * 已改成更大的固定额（+2 / +3），保留成长感。
 */
export class Modifier_GoldRush extends Modifier {
    private subscribed = false;

    OnCreated(kv?: Record<string, any>): void {
        super.OnCreated(kv);
        const ctx: BattleContext | undefined = (this.target as any)?.ctxRef;
        if (!ctx?.bus || this.subscribed) return;
        this.subscribed = true;
        ctx.bus.on(BattleEvents.OnKill, this.onKill, this);
    }

    OnDestroy(): void {
        const ctx: BattleContext | undefined = (this.target as any)?.ctxRef;
        if (ctx?.bus && this.subscribed) {
            ctx.bus.off(BattleEvents.OnKill, this.onKill, this);
            this.subscribed = false;
        }
    }

    private onKill = (event: any): void => {
        const host = this.target as any;
        if (!host || event?.killer !== host) return;
        const gold = Math.floor(Number(this.getKV()?.gold ?? 0));
        if (gold <= 0) return;
        addGold(host, gold, this);
    };
}

/**
 * 加局内金币 + 通知 UI。
 *
 * ⚠ 只改 `host.gold` 是**不够**的：HUD 的金币来自 `battleStore`，由
 * `Scene_Game_Stage.syncHeroToStore()` 投影，而那个方法原本只在「击杀奖励 / 受伤 / 治疗」
 * 三条既有事件里被调用。脚本加的金币必须自己发一条 `on_gold_gained`
 * （场景层已订阅它做投影），否则要等到下一次受伤才在界面上跳出来。
 */
function addGold(host: any, gold: number, self: Modifier): void {
    host.gold = (host.gold ?? 0) + gold;
    const ctx: BattleContext | undefined = host.ctxRef;
    ctx?.bus?.publish(BattleEvents.OnGoldGained, { target: host, amount: gold, source: self });
}

// ============================================================
// 112 圣盾 / 127 l3 借用的护盾池
// ============================================================

/**
 * 圣盾（112）。`kv = { pct, reflect, recharge }`
 *
 * 本作没有「护盾」实体字段 —— 护盾 = `on_block_damage` 事件里那个可变的 `blocked`
 * （见 `Modifier_IronShell` 的说明）。这里把它做成一个**带池子的拦截器**：
 *   · 池子 `pool` 初值 = `getMaxHp() × pct`，每次受击先扣池子、扣多少就往 `blocked` 写多少；
 *   · 池子见底 → 进入 `recharge` 秒充能，充能结束回满；
 *   · l3 的「破碎时反弹 60%」= 池子归零那一次，把**本次吸收量**的 `reflect` 倍用
 *     现成的伤害管线反弹回去（`DamagePipeline.ApplyDamage`，不再走反射标记以防叠加）。
 *
 * 充能计时**不能**用 `modifiers.cd` —— `Modifier.Trigger()/OnTriggered()` 全工程零调用方，
 * `cd` 列是死代码；所以自己 `OnTick` 计时（见 README §2.5）。
 */
export class Modifier_DivineShield extends Modifier {
    private pool = -1;
    private rechargeLeft = 0;

    OnCreated(kv?: Record<string, any>): void {
        super.OnCreated(kv);
        this.pool = this.maxPool();
    }

    /** 池子上限 = 当前最大生命 × pct（每次读取时重算，跟着最大生命的成长走） */
    private maxPool(): number {
        const host = this.target as any;
        const pct = Number(this.getKV()?.pct ?? 0.08);
        return Math.max(0, (host?.getMaxHp?.() ?? 0) * pct);
    }

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_block_damage') return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;
        const max = this.maxPool();
        if (max <= 0) return false;
        if (this.pool < 0) this.pool = max;
        if (this.pool <= 0) return false;              // 充能中，不拦截

        const dmg = Number(event?.damage ?? 0);
        if (dmg <= 0) return false;
        const blocked = Math.min(this.pool, dmg);
        this.pool -= blocked;
        event.blocked = (event.blocked ?? 0) + blocked;

        const broke = this.pool <= 1e-6;
        if (broke) {
            this.pool = 0;
            this.rechargeLeft = Number(this.getKV()?.recharge ?? 6);
            // l3：破碎时把本次吸收量的一部分反弹给伤害来源
            const reflect = Number(this.getKV()?.reflect ?? 0);
            const src = event?.source as any;
            const ctx: BattleContext | undefined = host.ctxRef;
            if (reflect > 0 && ctx && alive(src) && src !== host) {
                ctx.damagePipeline.ApplyDamage(src, host, blocked * reflect, DamageType.Magical, { isReflected: true });
            }
        }
        return false;
    }

    OnTick(dt: number): void {
        const max = this.maxPool();
        if (this.pool < 0) { this.pool = max; return; }
        if (this.pool >= max) return;
        if (this.rechargeLeft <= 0) { this.pool = max; return; }  // recharge=0 → 立即回满
        this.rechargeLeft -= dt;
        if (this.rechargeLeft <= 0) { this.rechargeLeft = 0; this.pool = max; }
    }

    /** 调试/断言用：当前护盾池 */
    getShieldPool(): number { return this.pool; }
}

// ============================================================
// 113 回旋镖 / 114 追踪弹 / 119 雷链 —— 三条「命中后再打一个」的技能
// ============================================================

/**
 * 回旋镖（113）。`kv = { pct }`
 *
 * 原稿要的是「弹道命中后返程、返程再打一次」。本作 `Projectile` 是**纯直线、一次性**的
 * （`tick` 到点 → `onHit` → 回收），没有「返程」这个概念，真要做得改弹道生命周期（引擎改动）。
 * 名字与图标保留，机制换成等价的一次弹射：**命中后弹向英雄最近的另一个敌人**。
 *
 * 与 114 的分工：**113 = 打第二下（次近的那只）**，**114 = 换目标链式（可跳多次）**。
 */
export class Modifier_Boomerang extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim)) return false;
        const atk = host.getAttackDamage?.() ?? 0;
        const pct = Number(this.getKV()?.pct ?? 0.6);
        if (atk <= 0 || pct <= 0) return false;

        const list = enemies(ctx, host, new Set<number>([victim.uid]));
        if (list.length === 0) return false;
        ctx.damagePipeline.ApplyDamage(list[0], host, Math.max(1, Math.round(atk * pct)), DamageType.Physical);
        return false;
    }
}

/**
 * 追踪弹（114）。`kv = { jumps, pct, range }`
 *
 * 从主目标开始，每次弹向**当前落点附近**最近的未命中敌人，弹 `jumps` 次、每跳 `atk × pct`。
 * 与 119 雷链的分工：**114 = 低衰减定值弹射（55% 每跳）**、**119 = 高衰减多跳（首跳 100% 起递减）**。
 */
export class Modifier_HomingShot extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim)) return false;
        const atk = host.getAttackDamage?.() ?? 0;
        const kv = this.getKV() ?? {};
        const jumps = Math.max(0, Math.floor(Number(kv.jumps ?? 1)));
        const pct = Number(kv.pct ?? 0.55);
        const range = Number(kv.range ?? CHAIN_RANGE_PX);
        if (atk <= 0 || pct <= 0 || jumps <= 0) return false;

        const dmg = Math.max(1, Math.round(atk * pct));
        chain(ctx, victim, jumps, range, (t) => {
            ctx.damagePipeline.ApplyDamage(t, host, dmg, DamageType.Physical);
        });
        return false;
    }
}

/**
 * 雷链（119）。`kv = { jumps, decay, endBurstPct, range }`
 *
 * 原稿挂在「**技能释放**时附加连锁闪电」上 —— 但**英雄永远不会施放技能**
 * （`AbilitySystem.getCastableSkills()` 全工程零调用方，`castAbility` 唯一调用方是 BossAI），
 * 这条技能会永远不触发。锚点改到 `on_attack_landed`（普攻命中）。
 *
 * 伤害曲线（写死在文案里，改 kv 即改数值）：
 *   · l1 跳 2 次、每跳在上一跳基础上 ×0.5  → 100% + 50%
 *   · l2 跳 3 次、×0.6                    → 100% + 60% + 36%
 *   · l3 跳 4 次、×0.7，且终点再爆一次 50% → 100% + 70% + 49% + 34% + 50%
 */
export class Modifier_ChainLightning extends Modifier {
    /** 防递归：本技能自己打出的伤害会再次派发 on_attack_landed/deal_damage */
    private busy = false;

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed' || this.busy) return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim)) return false;
        const atk = host.getAttackDamage?.() ?? 0;
        const kv = this.getKV() ?? {};
        const jumps = Math.max(0, Math.floor(Number(kv.jumps ?? 2)));
        const decay = Number(kv.decay ?? 0.5);
        const range = Number(kv.range ?? CHAIN_RANGE_PX);
        if (atk <= 0 || jumps <= 0) return false;

        this.busy = true;
        try {
            let dmg = atk;
            let last: any = victim;
            // `chain` 的回调带 index（1 起）：**第 1 跳就是 100% 攻击力**，之后每跳再乘 decay。
            // ⚠ 别写成"每跳都先乘一次 decay" —— 那样首跳会变成 decay×atk，与文案的
            //   「首跳 100% 攻击力，每跳衰减 N%」对不上（返工过一次）。
            chain(ctx, victim, jumps, range, (t, i) => {
                if (i > 1) dmg *= decay;
                ctx.damagePipeline.ApplyDamage(t, host, Math.max(1, Math.round(dmg)), DamageType.Magical);
                last = t;
            });
            // l3：弹跳终点再爆一次
            const burst = Number(kv.endBurstPct ?? 0);
            if (burst > 0 && last !== victim) {
                aoe(ctx, last, meters(1), (t) => {
                    ctx.damagePipeline.ApplyDamage(t, host, Math.max(1, Math.round(atk * burst)), DamageType.Magical);
                });
            }
        } finally {
            this.busy = false;
        }
        return false;
    }
}

// ============================================================
// 115 榴弹 —— 以中弹者为中心的范围伤害
// ============================================================

/**
 * 榴弹（115）。`kv = { radiusM, pct, burnPct }`
 *
 * 结构上本来是**纯声明式**（`on_attack_landed` 触发的 `aoe_damage`，圆心自然会落在事件目标上），
 * 但 `aoe_damage.value` 是绝对数值、不吃攻击力 → 在肉鸽里会迅速贬值，
 * 所以还是按攻击力算。l3 的「命中附加灼烧」直接复用 116 的灼烧 DoT。
 */
export class Modifier_Grenade extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim)) return false;
        const atk = host.getAttackDamage?.() ?? 0;
        const kv = this.getKV() ?? {};
        const pct = Number(kv.pct ?? 0.8);
        const radiusM = Number(kv.radiusM ?? 1.5);
        if (atk <= 0 || pct <= 0 || radiusM <= 0) return false;

        const dmg = Math.max(1, Math.round(atk * pct));
        aoe(ctx, victim, meters(radiusM), (t) => {
            ctx.damagePipeline.ApplyDamage(t, host, dmg, DamageType.Magical);
        });

        const burnPct = Number(kv.burnPct ?? 0);
        if (burnPct > 0 && alive(victim) && victim.modifiers) {
            victim.modifiers.AddModifier(
                SHOP_MOD.Ignite, host, Number(kv.burnSec ?? 4),
                { dps: Math.max(1, Math.round(atk * burnPct)), interval: 1, maxLayers: 1 },
                this.origin,
            );
        }
        return false;
    }
}

// ============================================================
// 116 燃刃 / 118 毒刃 —— 施加「按攻击力算」的可叠层 DoT
// ============================================================

/**
 * 灼烧 DoT（挂在中弹的**敌人**身上）。`kv = { dps, interval, maxLayers }`
 *
 * 为什么不用配表的 `tick_damage`：
 *   ① `tick_damage.value` 是**固定数值**、没有 `var` 绑定（只有 `modify_attr` 的属性条目支持），
 *      「每秒 15% 攻击力」表达不了；
 *   ② `tick_damage` **不随层数放大**（`processTickEffect` 用 `eff.value` 原值，
 *      只有属性条目在 `Modifier.resolveAttr` 里乘了 `stackCount`）——
 *      而文案写的是「叠 6 层」，层数必须真的放大伤害。
 *   脚本里两条都补上了（`dps × stackCount`）。
 *
 * 数值口径：`dps` 是**每层每秒**的伤害，在施加那一刻按当时的攻击力定格
 * （之后英雄攻击力变化不会追溯改已在燃烧的目标）—— 这是刻意选择，避免同一层数打出不同数字。
 */
export class Modifier_Ignite extends Modifier {
    private timer = 0;

    OnTick(dt: number): void {
        const victim = this.target as any;
        if (!alive(victim)) return;
        const ctx: BattleContext | undefined = victim.ctxRef;
        if (!ctx) return;
        const kv = this.getKV() ?? {};
        const interval = Number(kv.interval ?? 1);
        if (!(interval > 0)) return;
        const dps = Number(kv.dps ?? 0);
        if (dps <= 0) return;

        this.timer += dt;
        // 一帧可能跨多个间隔（掉帧/顿帧），while 补齐，且设个上限防卡死
        let guard = 0;
        while (this.timer >= interval && guard++ < 8) {
            this.timer -= interval;
            if (!alive(victim)) return;
            const dmg = Math.max(1, Math.round(dps * this.stackCount));
            ctx.damagePipeline.ApplyDamage(victim, this.source ?? victim, dmg, this.dotDamageType());
        }
    }

    /** 伤害类型（子类可覆盖） */
    protected dotDamageType(): DamageType { return DamageType.Magical; }
}

/**
 * 毒液 DoT（挂在中弹的**敌人**身上）。`kv = { dps, interval, maxLayers, spread, spreadRadiusM }`
 *
 * 与灼烧同一套实现，只多一件事：**l3 的「中毒目标死亡时传染」**——
 * 放在 `OnDestroy` 里做（`Entity.Die()` 会 `modifiers.Clear()`，所以死亡一定走到这里），
 * 判「宿主真的死了」再对周围敌人补一次毒。
 */
export class Modifier_Poison extends Modifier_Ignite {
    protected dotDamageType(): DamageType { return DamageType.Magical; }

    OnDestroy(): void {
        const victim = this.target as any;
        const ctx: BattleContext | undefined = victim?.ctxRef;
        const kv = this.getKV() ?? {};
        const spread = Number(kv.spread ?? 0);
        if (!ctx || spread <= 0) return;
        // 只在「宿主真的死了」时传染（技能被摘掉/被驱散时不传）
        if (!victim.IsDead?.()) return;
        const radius = meters(Number(kv.spreadRadiusM ?? 2));
        const dps = Number(kv.dps ?? 0);
        const maxLayers = Number(kv.maxLayers ?? 1);
        if (dps <= 0) return;
        for (const e of ctx.findEntitiesInRadius(victim, radius, 2)) {
            if (!alive(e) || e === victim) continue;
            e.modifiers?.AddModifier(SHOP_MOD.Poison, this.source ?? victim, Number(kv.interval ?? 1) * 4,
                { dps, interval: Number(kv.interval ?? 1), maxLayers }, this.origin);
        }
    }
}

/**
 * 燃刃（116）。`kv = { maxLayers, dpsPct, duration }` —— 命中时给目标上/叠灼烧。
 *
 * `maxLayers` 按等级 2/4/6：def 的 `max_stack` 取最高档 6（配表是硬上限），
 * 低档由这里钳住（到量就只刷时长、不再叠层）。
 */
export class Modifier_FlameBlade extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim) || !victim.modifiers) return false;

        const kv = this.getKV() ?? {};
        const atk = host.getAttackDamage?.() ?? 0;
        const dpsPct = Number(kv.dpsPct ?? 0.15);
        const maxLayers = Math.max(1, Math.floor(Number(kv.maxLayers ?? 2)));
        const duration = Number(kv.duration ?? 4);
        if (atk <= 0 || dpsPct <= 0) return false;

        const existing = victim.modifiers.findByOrigin(SHOP_MOD.Ignite, this.origin);
        const cur = existing?.getStackCount() ?? 0;
        if (cur >= maxLayers) {
            if (existing) existing.remainingTime = duration;   // 满层只续时，不再叠
            return false;
        }
        victim.modifiers.AddModifier(
            SHOP_MOD.Ignite, host, duration,
            { dps: Math.max(1, Math.round(atk * dpsPct)), interval: 1, maxLayers },
            this.origin,
        );
        return false;
    }
}

/** 毒刃（118）。`kv = { maxLayers, dpsPct, duration, spread }` */
export class Modifier_VenomBlade extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim) || !victim.modifiers) return false;

        const kv = this.getKV() ?? {};
        const atk = host.getAttackDamage?.() ?? 0;
        const dpsPct = Number(kv.dpsPct ?? 0.10);
        const maxLayers = Math.max(1, Math.floor(Number(kv.maxLayers ?? 2)));
        const duration = Number(kv.duration ?? 4);
        if (atk <= 0 || dpsPct <= 0) return false;

        const existing = victim.modifiers.findByOrigin(SHOP_MOD.Poison, this.origin);
        const cur = existing?.getStackCount() ?? 0;
        if (cur >= maxLayers) {
            if (existing) existing.remainingTime = duration;
            return false;
        }
        victim.modifiers.AddModifier(
            SHOP_MOD.Poison, host, duration,
            {
                dps: Math.max(1, Math.round(atk * dpsPct)),
                interval: 1, maxLayers,
                spread: Number(kv.spread ?? 0),
                spreadRadiusM: Number(kv.spreadRadiusM ?? 2),
            },
            this.origin,
        );
        return false;
    }
}

// ============================================================
// 117 寒刃 —— 减速那半句是纯声明式，只有「满层冻结」要脚本
// ============================================================

/**
 * 寒刃（117）。`kv = { maxLayers, slow, freeze, freezeSec }`
 *
 * 减速本身走**纯声明式**的 `Modifier 53 技能·冰冻`
 * （`modify_attr` 的属性条目支持 `var`，施加方 `kv:{slow:-60}` 传幅度 —— 移速 base=300，
 * 每层 -60 就是 -20%，`stack_mode:stack` 让层数真的把减速叠起来）。
 * 这里只多做一件声明式动作做不到的事：**「满 3 层冻结」是一个层数条件**。
 */
export class Modifier_FrostBlade extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim) || !victim.modifiers) return false;

        const kv = this.getKV() ?? {};
        const maxLayers = Math.max(1, Math.floor(Number(kv.maxLayers ?? 1)));
        const slow = Number(kv.slow ?? -60);
        const duration = Number(kv.duration ?? 3);

        const existing = victim.modifiers.findByOrigin(SHOP_MOD.FrostSlow, this.origin);
        const cur = existing?.getStackCount() ?? 0;
        if (cur >= maxLayers) {
            if (existing) existing.remainingTime = duration;
        } else {
            victim.modifiers.AddModifier(SHOP_MOD.FrostSlow, host, duration, { slow }, this.origin);
        }

        const freeze = Number(kv.freezeSec ?? 0);
        if (freeze <= 0) return false;
        const after = victim.modifiers.findByOrigin(SHOP_MOD.FrostSlow, this.origin);
        if ((after?.getStackCount() ?? 0) >= maxLayers) {
            victim.modifiers.AddModifier(MOD_STUNNED, host, freeze);
            victim.modifiers.RemoveModifier(after!);
        }
        return false;
    }
}

// ============================================================
// 120 静电磁场 —— 「满 5 层引爆」是层数条件
// ============================================================

/**
 * 静电磁场（120）。`kv = { threshold, burstPct, radiusM, chain }`
 *
 * 层数本身用一条**纯声明式**的标记 Modifier（`56 技能·静电层数`，`stack_mode:stack`
 * + `max_stack:5`）承载，脚本只负责「够了没有」这个条件判断与引爆。
 */
export class Modifier_StaticField extends Modifier {
    /** 防递归：引爆伤害会再次派发 on_attack_landed 链 */
    private busy = false;

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed' || this.busy) return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim) || !victim.modifiers) return false;

        const kv = this.getKV() ?? {};
        const threshold = Math.max(1, Math.floor(Number(kv.threshold ?? 5)));

        victim.modifiers.AddModifier(SHOP_MOD.StaticStack, host, Number(kv.stackSec ?? 10), undefined, this.origin);
        if (victim.modifiers.getStackCount(SHOP_MOD.StaticStack) < threshold) return false;

        const atk = host.getAttackDamage?.() ?? 0;
        const pct = Number(kv.burstPct ?? 1.5);
        victim.modifiers.RemoveModifierById(SHOP_MOD.StaticStack);
        if (atk <= 0 || pct <= 0) return false;

        this.busy = true;
        try {
            const dmg = Math.max(1, Math.round(atk * pct));
            aoe(ctx, victim, meters(Number(kv.radiusM ?? 1.5)), (t) => {
                ctx.damagePipeline.ApplyDamage(t, host, dmg, DamageType.Magical);
            });
            // l3：引爆再附带一次雷链（与 119 同一条曲线：首跳 100%，之后每跳 ×0.5）
            const chainJumps = Math.max(0, Math.floor(Number(kv.chain ?? 0)));
            if (chainJumps > 0 && alive(victim)) {
                let d = atk;
                chain(ctx, victim, chainJumps, CHAIN_RANGE_PX, (t, i) => {
                    if (i > 1) d *= 0.5;
                    ctx.damagePipeline.ApplyDamage(t, host, Math.max(1, Math.round(d)), DamageType.Magical);
                });
            }
        } finally {
            this.busy = false;
        }
        return false;
    }
}

// ============================================================
// 121 影剪 —— 「生命低于 N%」是条件
// ============================================================

/**
 * 影剪（121）。`kv = { threshold, pct, healPct }`
 *
 * 原稿写「伤害 ×1.3」，实现成**追加 `atk × 30%`** 而不是给普攻乘系数 ——
 * 乘系数要往伤害管线里塞一个「本次伤害 ×1.3」的钩子（管线里那是 `DamageOut` 乘区，
 * 与暴击/减伤是不同阶段，混在一起会把普攻本身也抬高）。追加伤害段更干净，
 * 而且阈值判定用的是**命中后**的血线（`on_attack_landed` 在扣血之后派发）。
 */
export class Modifier_ShadowCut extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim)) return false;

        const max = victim.getMaxHp?.() ?? 0;
        if (max <= 0) return false;
        const kv = this.getKV() ?? {};
        const threshold = Number(kv.threshold ?? 0.3);
        const pct = Number(kv.pct ?? 0.3);
        const atk = host.getAttackDamage?.() ?? 0;
        if (atk <= 0 || pct <= 0) return false;
        if ((victim.hp ?? 0) / max >= threshold) return false;

        ctx.damagePipeline.ApplyDamage(victim, host, Math.max(1, Math.round(atk * pct)), DamageType.Physical);

        // l3：斩杀成功后回复最大生命的一定比例
        const healPct = Number(kv.healPct ?? 0);
        if (healPct > 0 && victim.IsDead?.() && alive(host)) {
            host.Heal?.(host.getMaxHp?.() * healPct, host);
        }
        return false;
    }
}

// ============================================================
// 122 击杀回响 —— 同样挂在总线 on_kill 上
// ============================================================

/** 击杀回响（122）。`kv = { pct, radiusM, goldChance }` */
export class Modifier_KillEcho extends Modifier {
    private subscribed = false;

    OnCreated(kv?: Record<string, any>): void {
        super.OnCreated(kv);
        const ctx: BattleContext | undefined = (this.target as any)?.ctxRef;
        if (!ctx?.bus || this.subscribed) return;
        this.subscribed = true;
        ctx.bus.on(BattleEvents.OnKill, this.onKill, this);
    }

    OnDestroy(): void {
        const ctx: BattleContext | undefined = (this.target as any)?.ctxRef;
        if (ctx?.bus && this.subscribed) {
            ctx.bus.off(BattleEvents.OnKill, this.onKill, this);
            this.subscribed = false;
        }
    }

    private onKill = (event: any): void => {
        const host = this.target as any;
        if (!host || event?.killer !== host) return;
        const victim = event?.victim as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !victim?.position) return;

        const atk = host.getAttackDamage?.() ?? 0;
        const kv = this.getKV() ?? {};
        const pct = Number(kv.pct ?? 1.25);
        const radiusM = Number(kv.radiusM ?? 1.5);
        if (atk > 0 && pct > 0 && radiusM > 0) {
            const dmg = Math.max(1, Math.round(atk * pct));
            aoe(ctx, victim, meters(radiusM), (t) => {
                if (t === victim) return;                 // 死者已经被回收，别重复结算
                ctx.damagePipeline.ApplyDamage(t, host, dmg, DamageType.Magical);
            });
        }

        const goldChance = Number(kv.goldChance ?? 0);
        if (goldChance > 0 && Math.random() < goldChance) addGold(host, 1, this);
    };
}

// ============================================================
// 123 哨兵炮台 —— 「召唤物」改成「周期性自动开火」
// ============================================================

/**
 * 哨兵炮台（123）。`kv = { interval, pct, shots }`
 *
 * 原稿是**召唤一座实体炮台**。本作召唤基建整条不存在
 * （`MonsterPool` 把预制件硬编码成 `prefabs/unit/monsters/one`，team=1 的召唤物没有
 * 任何 EntityView 分支；`units.json` 也没有可召唤的单位行），
 * 而召唤流是一条独立的产品级功能线（AI + 生命周期 + 与英雄绑定），
 * 不该被一条肉鸽技能顺带带出来。这里保留**玩家感知**（多一路白嫖的自动火力）、
 * 换成自身周期性开火，零基建。（真要恢复实体版：把这条换成 `apply_modifier` 指向召唤逻辑，
 * 图集帧名与名字都不用动。）
 *
 * 计时自己 `OnTick` 做 —— `modifiers.cd` 是死代码。
 */
export class Modifier_SentryTurret extends Modifier {
    private timer = 0;

    OnTick(dt: number): void {
        const host = this.target as any;
        if (!alive(host)) return;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx) return;
        const kv = this.getKV() ?? {};
        const interval = Number(kv.interval ?? 1);
        if (!(interval > 0)) return;
        const atk = host.getAttackDamage?.() ?? 0;
        const pct = Number(kv.pct ?? 0.5);
        if (atk <= 0 || pct <= 0) return;

        this.timer += dt;
        if (this.timer < interval) return;
        this.timer = 0;

        const shots = Math.max(1, Math.floor(Number(kv.shots ?? 1)));
        const range = host.getAttackRange?.() ?? 0;
        const r2 = range * range;
        const dmg = Math.max(1, Math.round(atk * pct));
        for (let i = 0; i < shots; i++) {
            let pick: any = null;
            let best = Infinity;
            for (const e of ctx.GetTeamEntities(2) ?? []) {
                if (!alive(e)) continue;
                const d = dist2(e, host);
                if (d <= r2 && d < best) { best = d; pick = e; }
            }
            if (!pick) return;
            ctx.damagePipeline.ApplyDamage(pick, host, dmg, DamageType.Physical);
        }
    }
}

// ============================================================
// 124 镜像分身 —— 概率追加一击
// ============================================================

/**
 * 镜像分身（124）。`kv = { chance, pct }`
 *
 * 原稿「释放技能时召唤分身」双重不可达：召唤基建不存在，**且英雄永远不会施放技能**。
 * 换成「普攻有 N% 概率追加一次额外打击」—— 这正是「多一个自己在打」的玩家价值。
 * l3 的「技能冷却 -20%」一并砍掉（没有冷却缩减属性，也没有技能可冷却）。
 */
export class Modifier_MirrorImage extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim)) return false;
        const kv = this.getKV() ?? {};
        const chance = Number(kv.chance ?? 0.35);
        const pct = Number(kv.pct ?? 0.4);
        const atk = host.getAttackDamage?.() ?? 0;
        if (chance <= 0 || pct <= 0 || atk <= 0) return false;
        if (Math.random() >= chance) return false;
        ctx.damagePipeline.ApplyDamage(victim, host, Math.max(1, Math.round(atk * pct)), DamageType.Physical);
        return false;
    }
}

// ============================================================
// 125 元素军阵 —— 击杀攒层、普攻一次性倾泻
// ============================================================

/**
 * 元素军阵（125）。`kv = { perKill, maxStacks, pctPerStack }`
 *
 * 原稿「每击杀 3 个召唤 1 个小兵」同样撞在召唤基建上，而且把「元素」当成了本作拥有的体系
 * （**本作只有物理/法术两种伤害**，`element_effects.json` 2026-07 已删除）。
 * 换成零基建的等价机制：**每击杀 3 个攒 1 层（上限 3/5/8），普攻时把攒的层数一次性转化成追加伤害** ——
 * 「军阵越打越厚」的手感保留，且不再引用不存在的元素体系。名字保留（图标是军旗+长矛，与「军阵」一致）。
 */
export class Modifier_ElementalLegion extends Modifier {
    private kills = 0;
    private stacks = 0;
    private subscribed = false;

    OnCreated(kv?: Record<string, any>): void {
        super.OnCreated(kv);
        const ctx: BattleContext | undefined = (this.target as any)?.ctxRef;
        if (!ctx?.bus || this.subscribed) return;
        this.subscribed = true;
        ctx.bus.on(BattleEvents.OnKill, this.onKill, this);
    }

    OnDestroy(): void {
        const ctx: BattleContext | undefined = (this.target as any)?.ctxRef;
        if (ctx?.bus && this.subscribed) {
            ctx.bus.off(BattleEvents.OnKill, this.onKill, this);
            this.subscribed = false;
        }
        this.kills = 0;
        this.stacks = 0;
    }

    /** 当前攒了几层（调试/断言用） */
    getStacks(): number { return this.stacks; }

    private onKill = (event: any): void => {
        const host = this.target as any;
        if (!host || event?.killer !== host) return;
        const kv = this.getKV() ?? {};
        const perKill = Math.max(1, Math.floor(Number(kv.perKill ?? 3)));
        const maxStacks = Math.max(1, Math.floor(Number(kv.maxStacks ?? 3)));
        this.kills++;
        if (this.kills % perKill !== 0) return;
        this.stacks = Math.min(maxStacks, this.stacks + 1);
    };

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        if (this.stacks <= 0) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !alive(victim)) return false;

        const atk = host.getAttackDamage?.() ?? 0;
        const pct = Number(this.getKV()?.pctPerStack ?? 0.3);
        const stacks = this.stacks;
        this.stacks = 0;                       // 一次性倾泻
        if (atk <= 0 || pct <= 0) return false;
        ctx.damagePipeline.ApplyDamage(victim, host, Math.max(1, Math.round(atk * pct * stacks)), DamageType.Physical);
        return false;
    }
}

// ============================================================
// 126 暴击连锁 —— 必须挂 on_deal_damage（那个事件才带 isCrit）
// ============================================================

/**
 * 暴击连锁（126）。`kv = { mode, pct, radiusM, need }`
 *
 * ⚠ **关键口径**：`on_attack_landed` 的载荷里**没有 `isCrit`**
 * （`Entity.resolveAttackHit` 只发 `{attacker,target,damage,damageType}`），
 * 只有 `on_deal_damage` 的载荷带 `isCrit`（`DamagePipeline` 的 `dmgEvent`）→
 * 「暴击时」必须挂 `on_deal_damage`，而且它派发给的是**伤害来源**（正是英雄自己）。
 *
 * `on_deal_damage` 对**每一次**伤害都派发（含 DoT 与追加段）→ 本技能自己打出的范围伤害
 * 会再触发一次自己，**必须用 busy 标志防递归**。
 *
 * mode：`1` = 单体小爆炸（l1）/ `2` = 弹射相邻敌人（l2）/ `3` = 累计 N 次暴击后大爆炸（l3）。
 */
export class Modifier_CritChain extends Modifier {
    private busy = false;
    private critCount = 0;

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_deal_damage' || this.busy) return false;
        const host = this.target as any;
        if (!host || event?.source !== host) return false;
        if (!event?.isCrit) return false;
        const victim = event?.target as any;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !victim?.position) return false;

        const atk = host.getAttackDamage?.() ?? 0;
        if (atk <= 0) return false;
        const kv = this.getKV() ?? {};
        const mode = Math.floor(Number(kv.mode ?? 1));
        const pct = Number(kv.pct ?? 0.5);
        const radiusM = Number(kv.radiusM ?? 1);
        const need = Math.max(1, Math.floor(Number(kv.need ?? 3)));

        this.busy = true;
        try {
            if (mode === 2) {
                // l2：弹射至相邻敌人（不含被打中的那个）
                const list = enemies(ctx, victim, new Set<number>([victim.uid]));
                if (list.length > 0) {
                    ctx.damagePipeline.ApplyDamage(list[0], host, Math.max(1, Math.round(atk * pct)), DamageType.Magical);
                }
            } else if (mode === 3) {
                // l3：累计 need 次暴击 → 一次大范围爆炸
                this.critCount++;
                if (this.critCount >= need) {
                    this.critCount = 0;
                    const dmg = Math.max(1, Math.round(atk * pct));
                    aoe(ctx, victim, meters(radiusM), (t) => {
                        ctx.damagePipeline.ApplyDamage(t, host, dmg, DamageType.Magical);
                    });
                }
            } else {
                // l1：暴击处小爆炸
                const dmg = Math.max(1, Math.round(atk * pct));
                aoe(ctx, victim, meters(radiusM), (t) => {
                    ctx.damagePipeline.ApplyDamage(t, host, dmg, DamageType.Magical);
                });
            }
        } finally {
            this.busy = false;
        }
        return false;
    }
}

// ============================================================
// 127 闪避反击 —— 依赖引擎新派发的 on_evade
// ============================================================

/**
 * 闪避反击（127）。`kv = { pct, stunSec, shieldPct }`
 *
 * 闪避**原本什么都不发**：`Entity.resolveAttackHit` 里
 * `if (evasion > 0 && Math.random() < evasion) return 0;` 直接返回，近战连总线事件都没有；
 * 远程虽然会经 `Projectile` 发 `on_projectile_miss`，但那只发总线、且 `reason` 只有一个
 * `'evaded_or_blocked'`（**分不清是闪避还是格挡**）。
 * 本轮补了**一处引擎派发**：闪避分支里 `publish(OnEvade)` + `DispatchEvent('on_evade')`
 * 到**闪避者**身上（顺带把「闪避」与「格挡」彻底分开 —— 108 铁壳 l3 与 112 圣盾都要这个区分）。
 *
 * l3 的「获得 25% 护盾」直接复用 `Modifier_DivineShield`（护盾逻辑只有一份）。
 */
export class Modifier_EvadeCounter extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_evade') return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;
        if (!alive(host)) return false;
        const ctx: BattleContext | undefined = host.ctxRef;
        const attacker = (event?.attacker ?? event?.source) as any;
        if (!ctx || !alive(attacker)) return false;

        const kv = this.getKV() ?? {};
        const atk = host.getAttackDamage?.() ?? 0;
        const pct = Number(kv.pct ?? 1.5);

        // ① 反击
        if (atk > 0 && pct > 0) {
            ctx.damagePipeline.ApplyDamage(attacker, host, Math.max(1, Math.round(atk * pct)), DamageType.Physical);
        }
        // ② l2：反击附带眩晕
        const stunSec = Number(kv.stunSec ?? 0);
        if (stunSec > 0 && alive(attacker)) {
            attacker.modifiers?.AddModifier(MOD_STUNNED, host, stunSec);
        }
        // ③ l3：反击后获得一段护盾（复用圣盾的护盾池实现）
        const shieldPct = Number(kv.shieldPct ?? 0);
        if (shieldPct > 0) {
            host.modifiers?.AddModifier(
                SHOP_MOD.DivineShield, host, -1,
                { pct: shieldPct, reflect: 0, recharge: Number(kv.shieldRecharge ?? 6) },
                this.origin,
            );
        }
        return false;
    }
}

// ============================================================
// 128 战旗 —— 「给友军增伤」= 给自己；破甲做成真光环
// ============================================================

/**
 * 战旗（128）的破甲光环。`kv = { radiusM, armorBreak }`
 *
 * 「增伤」那半句是**纯声明式**（`modify_attr [11, +15/+22/+30, percent]`，见 abilities.json）：
 * 本作是**单英雄塔防**，场上 team=1 只有英雄自己（没有召唤物、没有其它友军），
 * 原稿「周围 3.5m **友军**增伤 15%」永远只可能作用于自己 —— 改成「给自己」后
 * 玩家收益不变，机制上才真的生效。旗子本来就是「我一个人插的旗」。
 *
 * 「降低敌人护甲」做成真光环（本脚本定期扫描）。⚠ 破甲**必须给固定值**：
 * 护甲 `base=0`（英雄收口后不再配护甲），`percent` 打在 base=0 上恒为 0。
 */
export class Modifier_WarBanner extends Modifier {
    private timer = 0;

    OnTick(dt: number): void {
        const host = this.target as any;
        if (!alive(host)) return;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx) return;
        const kv = this.getKV() ?? {};
        const armorBreak = Number(kv.armorBreak ?? 0);
        if (armorBreak === 0) return;
        const interval = Number(kv.interval ?? 1);
        if (!(interval > 0)) return;

        this.timer += dt;
        if (this.timer < interval) return;
        this.timer = 0;

        for (const e of ctx.findEntitiesInRadius(host, meters(Number(kv.radiusM ?? 3.5)), 2)) {
            if (!alive(e) || !e.modifiers) continue;
            e.modifiers.AddModifier(SHOP_MOD.ArmorBreak, host, Number(kv.duration ?? 2),
                { armorBreak }, this.origin);
        }
    }
}

// ============================================================
// 129 时间回廊 —— 唯一一条「能真的拦住死亡」的技能
// ============================================================

/**
 * 时间回廊（129）。`kv = { pct, cleanse, invulnSec, cdSec }`
 *
 * **整份设计里最巧的一条**：`DamagePipeline` 的顺序是
 * 「先扣血（第 6 阶段）→ 派发 `on_take_damage`（第 7 阶段）→ 检查死亡（第 8 阶段）」，
 * 所以挂在 `on_take_damage` 上的脚本只要在事件里把血补回来，
 * 第 8 阶段的 `IsDead()` 就不成立、`Die()` 不会被调用 —— **不需要改引擎**。
 *
 * ⚠ 两个必须处理的细节：
 *   ① `Entity.ChangeHp` 在 `hp <= 0` 时会把 `alive` 置 false，而 `IsDead()` 判的是
 *      `!alive || hp <= 0` → 补血之后**必须把 `alive` 也置回 true**，否则照样判死；
 *   ② 触发间隔不能依赖 `modifiers.cd`（死代码）→ 自己 `OnTick` 计时。
 *
 * 原稿写「每波 1 次」：本作**没有波次事件**（`BattleEvents` 里没有 wave 相关的键，
 * 关卡推进在场景层），所以改成**自计时冷却**，文案同步改成「每 N 秒最多 1 次」。
 */
export class Modifier_TimeRewind extends Modifier {
    private cdLeft = 0;

    OnTick(dt: number): void {
        if (this.cdLeft > 0) this.cdLeft = Math.max(0, this.cdLeft - dt);
    }

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_take_damage') return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;
        if (this.cdLeft > 0) return false;
        if ((host.hp ?? 0) > 0) return false;      // 还没死，不用逆转

        const kv = this.getKV() ?? {};
        const pct = Number(kv.pct ?? 0.3);
        const max = host.getMaxHp?.() ?? 0;
        if (pct <= 0 || max <= 0) return false;

        // ① 补血 + 把 alive 置回（ChangeHp 在归零那一下已经把它置 false 了）
        const amount = max * pct;
        host.hp = Math.min(max, Math.max(0, (host.hp ?? 0) + amount));
        if (host.hp > 0) host.alive = true;
        if (host.hp <= 0) return false;             // 补了还是 0（pct 配成 0），不拦

        this.cdLeft = Number(kv.cdSec ?? 45);

        const ctx: BattleContext | undefined = host.ctxRef;
        // ② l2：清除全部负面效果
        if (kv.cleanse) host.modifiers?.Purge?.(DispelLevel.Ultimate, true);
        // ③ l3：重生后短暂无敌
        const invulnSec = Number(kv.invulnSec ?? 0);
        if (invulnSec > 0) host.modifiers?.AddModifier(MOD_INVULNERABLE, host, invulnSec);
        ctx?.bus?.publish(BattleEvents.OnHeal, { target: host, source: host, amount });
        return false;
    }
}

// ============================================================
// 脚本类清单 —— 供 Scene_Game_Stage.initBattle 一次性注册
// ============================================================

/**
 * 全部肉鸽技能脚本类：`script_id` → 类。
 * 注册入口在 `Scene_Game_Stage.initBattle`（与英雄那套脚本同一个地方），
 * 漏注册会在运行时打印 `[ModifierSystem] script_id 未注册: xxx` 并**静默降级成普通 Modifier**
 * （技能看起来"抽到了但没效果"），所以 `npm run audit:skill` 有一条断言专门盯这个表。
 */
export const SHOP_SKILL_SCRIPT_CLASSES: Record<string, any> = {
    Modifier_SplitShot,
    Modifier_PiercingBolt,
    Modifier_IronShell,
    Modifier_FirstStrike,
    Modifier_GoldRush,
    Modifier_DivineShield,
    Modifier_Boomerang,
    Modifier_HomingShot,
    Modifier_Grenade,
    Modifier_FlameBlade,
    Modifier_Ignite,
    Modifier_VenomBlade,
    Modifier_Poison,
    Modifier_FrostBlade,
    Modifier_ChainLightning,
    Modifier_StaticField,
    Modifier_ShadowCut,
    Modifier_KillEcho,
    Modifier_SentryTurret,
    Modifier_MirrorImage,
    Modifier_ElementalLegion,
    Modifier_CritChain,
    Modifier_EvadeCounter,
    Modifier_WarBanner,
    Modifier_TimeRewind,
};
