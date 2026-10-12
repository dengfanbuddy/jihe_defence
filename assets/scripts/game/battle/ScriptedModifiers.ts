import { Modifier } from './Modifier';
import { BattleEvents, DamageType, MODIFY_ATTR_TEMPLATE_ID } from './types';
import { AttributeType } from './core/Types';
import { BattleConstUtil } from './core/BattleConstUtil';
import type { BattleContext } from './BattleContext';

/**
 * 加局内金币 + 通知 HUD（与 `RelicHooks.addGold` 同一口径，那边不导出所以这里各持一份）。
 *
 * ⚠ 只改 `host.gold` 是**不够**的：HUD 的金币由 `battleStore` 投影
 * （`Scene_Game_Stage.syncHeroToStore`，唯一触发点是总线 `on_gold_gained`），
 * 少发这一条事件，钱要等到英雄下一次受伤/治疗才在界面上跳出来。
 */
function addGold(host: any, gold: number, self: Modifier): void {
    const n = Math.floor(gold);
    if (!(n > 0)) return;
    host.gold = (host.gold ?? 0) + n;
    (host.ctxRef as BattleContext | undefined)?.bus?.publish(
        BattleEvents.OnGoldGained, { target: host, amount: n, source: self },
    );
}

/**
 * Modifier_EagleEye —— 火枪「鹰眼瞄准」的命中叠层脚本（modifiers.json 20/21）
 *
 * 挂载在英雄自身（施放技能时 apply_modifier 到 self）：
 *  - 鹰眼期间英雄每次攻击命中（on_attack_landed）→ 对自身重放本 Modifier。
 *    同 (id, origin) 重放走 stack_mode=stack 的叠层逻辑：层数 +1 并刷新时长，
 *    达到 def.max_stack 后系统自动不再续时（窗口按最后满层时刻 + 持续时长自然结束）。
 *  - 携带 kv.finisher=true（四阶技能施加）时：本 Modifier 自然到期（OnDestroy）
 *    会对攻击范围内存活 Boss（rewardType='boss' 或 ai.type='boss'）追加一次
 *    200% 攻击力的物理伤害（设计：四阶"结束时对 Boss 追加一次 200% 伤害"）。
 *
 * 注册（与 Ability_LightningChain 同一入口，见 Scene_Game_Stage.initBattle）：
 *   ctx.scriptRegistry.registerClass('Modifier_EagleEye', Modifier_EagleEye);
 *
 * 数值全部在配表（modifiers.json 的 duration/max_stack/properties），此处只写行为。
 */
export class Modifier_EagleEye extends Modifier {
    /** 每帧不做事（叠层/终结都由事件与生命周期驱动） */
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;

        const attacker = event?.attacker as any;
        if (!attacker || attacker !== this.target) return false;

        const host = this.target as any;
        if (!host?.modifiers || host.IsDead?.()) return false;

        // 命中即续时：用创建时的持续时长（技能 effect 的 duration 覆盖值）重放同源 Modifier
        host.modifiers.AddModifier(this.def.id, this.source, this.duration, this.getKV(), this.origin);
        return false;
    }

    /** 到期/被移除时调用（此处只做四阶 Boss 终结，其它档无 finisher 标记直接返回） */
    OnDestroy(): void {
        const kv = this.getKV();
        if (!kv || !kv.finisher) return;

        const owner = (this.source ?? this.target) as any;
        if (!owner || !owner.alive || owner.IsDead?.()) return;
        const ctx: BattleContext | undefined = owner.ctxRef;
        if (!ctx) return;

        const atk = owner.getAttackDamage?.() ?? 0;
        if (atk <= 0) return;
        const range = owner.getAttackRange?.() ?? 0;
        const me = owner.position ?? { x: 0, y: 0 };

        // Boss 判定对齐 units.json：rewardType='boss'（关底）或 ai.type='boss'（Boss 模式）
        let boss: any = null;
        let best = Infinity;
        for (const e of ctx.GetTeamEntities(2) ?? []) {
            if (!e || e.IsDead?.()) continue;
            const def = ctx.getUnitDef?.(e.id);
            const isBoss = def?.rewardType === 'boss' || def?.ai?.type === 'boss';
            if (!isBoss) continue;
            const dx = e.position.x - me.x;
            const dy = e.position.y - me.y;
            const d = dx * dx + dy * dy;
            if (d <= range * range && d < best) {
                best = d;
                boss = e;
            }
        }

        if (boss) {
            ctx.damagePipeline.ApplyDamage(boss, owner, atk * 2, DamageType.Physical);
        }
    }
}

/**
 * Modifier_CounterStorm —— 斧王「反击风暴」被动（modifiers.json 24）
 *
 * **英雄的唯一技能**（`units.json#1004` 的 `abilities` 只有 17）。机制：
 * **被敌人的普攻命中**累计够 `need` 次 ⇒ 对「自身攻击距离 × radiusFactor」内的所有敌人
 * 各造成一次「自身**当前**生命 × pct」的**纯粹**伤害，随后计数清零重新累计。
 *
 * 参数全部来自施加方（ability 17 各档 effect 的 `kv`，逐级不同 ⇒ 换级即换档）：
 *   · Lv.1 `{ need: 5, pct: 0.05 }` —— 挨 5 下炸一次，5% 当前生命
 *   · Lv.2 `{ need: 4, pct: 0.06 }` —— 英雄 Lv.15 升级
 *   · Lv.3 `{ need: 3, pct: 0.07 }` —— 英雄 Lv.30 升级
 *   改数值只动 `abilities.json`，这个类一行都不用碰。
 *
 * ── 四条实现口径 ──
 *   ① **必须自己订阅总线**：`on_attack_landed` 由 `Entity.resolveAttackHit` 派发给
 *      **攻击者自己**的 Modifier（`this.modifiers.DispatchEvent(...)`），斧王在这里是
 *      **受击方**，它的 Modifier 从来收不到这一条 ⇒ 只能 `ctx.bus.on`。
 *      （同 `Modifier_KillBounty` 订阅 `on_kill` 的理由；`on_take_damage` 反倒是派发给受击方的，
 *      但用它会把 DoT 跳伤、Boss 技能也算成"被攻击"，见第 ③ 条。）
 *   ② **`OnDestroy` 必须 `off`**：实体走对象池复用，不摘会重复计数。
 *   ③ **只数普攻命中**：判据是 `event.target === host && event.attacker?.team === 2`。
 *      `on_attack_landed` 只有普攻会发（近战即时命中与普攻弹道都收敛到 `resolveAttackHit`；
 *      **技能弹道 `isAttack=false` 直接走 `ApplyDamage`，不发这条事件**），而 DoT 跳伤
 *      只发 `on_take_damage` ⇒ 落在这一条之外。**被闪避掉的那一下也不算**（闪避分支在发事件之前 return）。
 *   ④ **伤害 = 当下的当前生命 × pct**：它是 `host.hp` 而不是 `getMaxHp()` —— 血越少反击越轻，
 *      这与设计稿「堆生命值 ⇒ 反击更痛」同向（满血时最痛）。类型是**纯粹**：不吃护甲/魔抗
 *      （`DamagePipeline.applyResistance` 对 Pure 直接返回原值）。
 *      ⚠ 但**受伤减免（属性 12）仍然生效** —— 管线第 4 阶段对三种伤害类型一视同仁，
 *      所以"纯粹"的准确口径是"无视抗性"，不是"无视一切减免"。
 *
 * ⚠ **换级会重挂本 Modifier ⇒ 计数清零**（`Ability.setLevel` 对被动是"摘旧的挂新的"），
 *   两次升级各丢 ≤ need−1 次揍（同 `Modifier_KillBounty` 的取舍）。
 *
 * 注册（见 `Scene_Game_Stage.initBattle`）：
 *   ctx.scriptRegistry.registerClass('Modifier_CounterStorm', Modifier_CounterStorm);
 */
export class Modifier_CounterStorm extends Modifier {
    /** 距下一次反击还差几次普攻命中（余数累积；换级会重挂 ⇒ 见类注释末条） */
    private counter = 0;
    private subscribed = false;

    OnCreated(kv?: Record<string, any>): void {
        super.OnCreated(kv);
        const ctx: BattleContext | undefined = (this.target as any)?.ctxRef;
        if (!ctx?.bus || this.subscribed) return;
        this.subscribed = true;
        ctx.bus.on(BattleEvents.OnAttackLanded, this.onAttackLanded, this);
    }

    OnDestroy(): void {
        const ctx: BattleContext | undefined = (this.target as any)?.ctxRef;
        if (ctx?.bus && this.subscribed) {
            ctx.bus.off(BattleEvents.OnAttackLanded, this.onAttackLanded, this);
            this.subscribed = false;
        }
    }

    /** 当前累计的挨打次数（调试/体检断言用；不含已经换成反击的那些） */
    getCounter(): number { return this.counter; }

    /** 敌人的普攻命中宿主 → 计数；够 `need` 次就炸一圈并扣掉这一轮 */
    private onAttackLanded = (event: any): void => {
        const host = this.target as any;
        if (!host || event?.target !== host) return;
        if (event?.attacker?.team !== 2) return; // 只数敌人的普攻（队友/自伤不算）
        if (!((event?.damage ?? 0) > 0)) return; // 被完全格挡/抵消的那一下不算挨打
        if (host.IsDead?.()) return;

        const kv = this.getKV() ?? {};
        const need = Math.max(1, Math.floor(Number(kv.need ?? 5)));
        this.counter += 1;
        if (this.counter < need) return;
        // 余数留着：need=5 时第 6 下是"下一轮的 1/5"，不是从头再来
        this.counter -= need;
        this.counterStrike(host);
    };

    /**
     * 触发反击：对「攻击距离 × radiusFactor」（缺省 1 = **整个攻击范围**）内所有敌人
     * 各造成一次「当前生命 × pct」的纯粹伤害。
     */
    private counterStrike(host: any): void {
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!host.alive || host.IsDead?.() || !ctx) return;
        const kv = this.getKV() ?? {};
        const pct = Number(kv.pct ?? 0.05);
        if (!(pct > 0)) return;
        const dmg = Math.max(1, Math.round((host.hp ?? 0) * pct));
        if (!(dmg > 0)) return;

        const radiusFactor = Number(kv.radiusFactor ?? 1);
        const radius = (host.getAttackRange?.() ?? 0) * radiusFactor;
        const me = host.position ?? { x: 0, y: 0 };
        for (const e of ctx.GetTeamEntities(2) ?? []) {
            if (!e || e.IsDead?.()) continue;
            const dx = e.position.x - me.x;
            const dy = e.position.y - me.y;
            if (dx * dx + dy * dy <= radius * radius) {
                ctx.damagePipeline.ApplyDamage(e, host, dmg, DamageType.Pure);
            }
        }
    }
}

/** 宙斯闪电链的弹射索敌半径（像素） */
const ZEUS_BOUNCE_RANGE = 260;

/**
 * Modifier_ZeusThunder —— 宙斯「雷霆之核」被动（modifiers.json 26）
 * 攻击命中主目标后：
 *   1) 追加一次「目标当前生命 × pct」的魔法雷伤（随当前血量递减）；
 *   2) 向主目标附近至多 chain 个敌人链式弹射，各造成 攻击 × decay 的魔法雷伤；
 * 四阶（kv.autoT>0）时：每 autoT 秒对攻击范围内随机敌人造成 攻击 × autoPct 雷击。
 * chain / pct / autoT / autoPct 由雷霆之核三档被动（ability 19 的 `effects` / `effects_lv2` / `effects_lv3`，
 * 随英雄 Lv.15 / Lv.30 升级）effect 的 kv 注入。三档 = 原一阶 / 原三阶 / 原四阶（2026-11 收敛）。
 * modifier 采用 strongest_only：升阶时旧实例会被整体替换为新档位 kv。
 */
export class Modifier_ZeusThunder extends Modifier {
    private autoTimer = 0;

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !host.alive || host.IsDead?.()) return false;
        const kv = this.getKV() ?? {};

        const atk = host.getAttackDamage?.() ?? 0;
        const mainTarget = event?.target as any;

        // 1) 被动百分比：追加「当前生命 × pct」雷伤
        const pct = Number(kv.pct ?? 0.035);
        if (mainTarget && !mainTarget.IsDead?.() && pct > 0) {
            const extra = Math.max(1, Math.round((mainTarget.hp ?? 0) * pct));
            if (extra > 0) ctx.damagePipeline.ApplyDamage(mainTarget, host, extra, DamageType.Magical);
        }

        // 2) 链式弹射：主目标附近至多 chain 个敌人，各吃 攻击×decay 雷伤
        const chainN = Number(kv.chain ?? 0);
        const decay = Number(kv.decay ?? 0.6);
        if (chainN > 0 && atk > 0 && mainTarget && !mainTarget.IsDead?.()) {
            const picks: any[] = [];
            for (const e of ctx.GetTeamEntities(2) ?? []) {
                if (!e || e.IsDead?.() || e === mainTarget) continue;
                const dx = e.position.x - mainTarget.position.x;
                const dy = e.position.y - mainTarget.position.y;
                if (dx * dx + dy * dy <= ZEUS_BOUNCE_RANGE * ZEUS_BOUNCE_RANGE) picks.push(e);
                if (picks.length >= chainN) break;
            }
            for (const e of picks) {
                ctx.damagePipeline.ApplyDamage(e, host, Math.round(atk * decay), DamageType.Magical);
            }
        }
        return false;
    }

    /** 四阶：周期性自动对随机敌人落雷 */
    OnTick(dt: number): void {
        const host = this.target as any;
        const kv = this.getKV() ?? {};
        const autoT = Number(kv.autoT ?? 0);
        if (autoT <= 0 || !host || !host.alive || host.IsDead?.()) return;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx) return;

        this.autoTimer += dt;
        if (this.autoTimer < autoT) return;
        this.autoTimer = 0;

        const atk = host.getAttackDamage?.() ?? 0;
        const autoPct = Number(kv.autoPct ?? 1.5);
        if (atk <= 0) return;
        const range = host.getAttackRange?.() ?? 0;
        const me = host.position ?? { x: 0, y: 0 };
        const inRange = (ctx.GetTeamEntities(2) ?? []).filter((e: any) => {
            if (!e || e.IsDead?.()) return false;
            const dx = e.position.x - me.x;
            const dy = e.position.y - me.y;
            return dx * dx + dy * dy <= range * range;
        });
        if (inRange.length === 0) return;
        const pick = inRange[Math.floor(Math.random() * inRange.length)];
        ctx.damagePipeline.ApplyDamage(pick, host, Math.round(atk * autoPct), DamageType.Magical);
    }
}

/**
 * Modifier_MusketHeadshot —— 火枪「爆头冲击」被动（modifiers.json 23）
 *
 * **英雄的「唯一技能」**（2026-09 定案：每个英雄默认只有普攻 + 一个技能；
 * 火枪的那个就是它，units.json 1001 的 `abilities` 只剩 16）。两件事都挂在
 * **普攻命中**上（`on_attack_landed`，远程普攻在弹道命中时才触发，所以飞镖落地才算账）：
 *
 *   1. **附带额外伤害**：追加一次「当前攻击力 × pct」的物理伤害（与普攻分开结算的第二段伤害，
 *      同源同类型，因此也走暴击/减伤管线）。按攻速 1.2 次/秒、攻击力 40 算 ≈ +2 伤害/次；
 *      它是**攻击力乘法**，所以跟着攻击力成长一起涨（这是它作为唯一技能的价值所在）。
 *   2. **概率击退**：`chance` 概率把目标沿「火枪 → 目标」方向推开 `knockback` **米**
 *      （× `BattleConstUtil.getPxPerMeter()` 换成像素，见 Entity.ApplyKnockback；
 *      锚点（英雄/防守点）不被推动，所以这条对怪生效、对英雄无效）。
 *
 * 参数全部来自施加方（ability 16 的 effect `kv`），改数值不用碰代码：
 *   `{ pct: 0.05, chance: 0.15, knockback: 1 }` = 5% 额外伤害 / 15% 概率 / 击退 1m。
 *
 * 注册（与 Ability_LightningChain 同一入口，见 Scene_Game_Stage.initBattle）：
 *   ctx.scriptRegistry.registerClass('Modifier_MusketHeadshot', Modifier_MusketHeadshot);
 */
export class Modifier_MusketHeadshot extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        // 只认"自己打出去的那一下"（事件是广播给双方实体的：命中者与被命中者都会收到）
        if (!host || event?.attacker !== host) return false;

        const victim = event?.target as any;
        if (!victim || victim.IsDead?.()) return false;
        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !host.alive) return false;

        const kv = this.getKV() ?? {};

        // ① 附带「攻击力 × pct」的额外伤害
        const pct = Number(kv.pct ?? 0);
        const atk = host.getAttackDamage?.() ?? 0;
        if (pct > 0 && atk > 0) {
            const extra = Math.max(1, Math.round(atk * pct));
            ctx.damagePipeline.ApplyDamage(victim, host, extra, DamageType.Physical);
        }

        // ② 概率击退（米 → 像素）
        const chance = Number(kv.chance ?? 0);
        const meters = Number(kv.knockback ?? 0);
        if (chance > 0 && meters > 0 && Math.random() < chance) {
            victim.ApplyKnockback?.(host, meters * BattleConstUtil.getPxPerMeter());
        }
        return false;
    }
}

/**
 * Modifier_KillBounty —— 赏金猎人「悬赏」被动（modifiers.json 13）
 *
 * **英雄的唯一技能**（`units.json#1002` 的 `abilities` 只有 7）。机制：
 * **累计击杀**够 `per` 次就发 `gold` 枚金币，余数留到下次（不是"每杀满一整轮才清零"）。
 *
 * 参数全部来自施加方（ability 7 的 effect `kv`，逐级不同 ⇒ 换级即换难度）：
 *   · Lv.1 `{ per: 8, gold: 1 }` —— 每 8 杀 1 金
 *   · Lv.2 `{ per: 5, gold: 1 }` —— 每 5 杀 1 金（英雄 Lv.15 升级）
 *   · Lv.3 `{ per: 3, gold: 1 }` —— 每 3 杀 1 金（英雄 Lv.30 升级）
 * 改数值只动 `abilities.json`，这个类一行都不用碰。
 *
 * ── 三条实现口径 ──
 *   ① **必须自己订阅总线**：`on_kill` **只 `bus.publish`、从不派发给 Modifier**
 *      （`DamagePipeline` 第 8 阶段），所以声明式 `events[{event:'on_kill'}]` 永远不触发
 *      （静默失效）。基类里没有这一半，代价是 `OnDestroy` 必须自己 `off` ——
 *      实体走对象池复用，不摘会重复计数（同 `Modifier_GoldRush` / `RelicBusHook`）。
 *   ② **只认 `event.killer === host`**：击杀是"谁打死的算谁的"，与遗物「悬赏(`killGold`)」
 *      「屠戮回血(`killHeal`)」同一条判据；别人打死的怪不给钱。
 *   ③ **金币走 `addGold`**（改字段 + 发 `on_gold_gained`），否则 HUD 不刷新。
 *
 * ⚠ **换级会重挂本 Modifier**（`Ability.setLevel` 对被动是"摘旧的挂新的"，见那里的注释），
 *   于是 `kills` 计数在两次升级处各清零一次 —— 丢的是"还没凑满一轮的余数"（≤ per−1 次击杀），
 *   保留它需要把计数放到 Modifier 之外（实体字段会被对象池复用带脏），不值得。
 *
 * 注册（见 `Scene_Game_Stage.initBattle`）：
 *   ctx.scriptRegistry.registerClass('Modifier_KillBounty', Modifier_KillBounty);
 */
export class Modifier_KillBounty extends Modifier {
    /** 距下一枚金币还差几次击杀（余数累积；换级会重挂 ⇒ 见类注释的第三条） */
    private kills = 0;
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

    /** 当前累计的击杀数（调试/体检断言用；不含已换成金币的那些） */
    getKills(): number { return this.kills; }

    /** 击杀者是宿主 → 计数；够 `per` 次就发 `gold` 金币并扣掉这一轮 */
    private onKill = (event: any): void => {
        const host = this.target as any;
        if (!host || event?.killer !== host) return;

        const kv = this.getKV() ?? {};
        const per = Math.floor(Number(kv.per ?? 0));
        const gold = Math.floor(Number(kv.gold ?? 1));
        if (!(per > 0) || !(gold > 0)) return;

        this.kills += 1;
        if (this.kills < per) return;
        // 余数留着：per=8 时第 9 次击杀是"下一轮的 1/8"，不是从头再来
        this.kills -= per;
        if (host.IsDead?.()) return;
        addGold(host, gold, this);
    };
}

/* =====================================================================================
 * 哈斯卡「血怒」（2026-11）—— 本文件里**唯一一条按帧重算属性**的英雄技能
 * ===================================================================================== */

/**
 * 血怒写进属性系统的那个「属性修改」实例的**来源组标识**。
 *
 * 为什么要自带一个：共享模板的实例身份 = `(1000, origin)`，同 (id, origin) 重放是**替换**、
 * 不同 origin 是**并存**。用缺省空 origin 会与"同样用空 origin 的共享模板实例"撞在一起
 * （谁后写谁覆盖），所以这条通路必须自己占一个组。
 */
const BLOOD_RAGE_ORIGIN = 'ability:27:bloodRage';

/**
 * 血怒写入属性系统的**量化步长**（攻击速度，配置口径的 int）。
 *
 * 为什么必须量化：本技能每帧都在算"已损失生命 → 攻速"，而**写属性是要钱的** ——
 * `AddModifier` 会触发 `ModifierSystem.recollect()`（遍历自己身上全部 Modifier × 全部受影响属性
 * 重算贡献）。逐帧写等于每帧全量重算一遍，而玩家在屏幕上根本看不出 0.01 的差别。
 * 量化到 0.5 之后：自伤的 1%/秒大约**每秒触发一次**重算，吃到一发大伤害则是**立刻一次**。
 */
const BLOOD_RAGE_STEP = 0.5;

/**
 * Modifier_BloodRage —— 哈斯卡「血怒」被动（modifiers.json 69）
 *
 * **英雄的唯一技能**（`units.json#1009` 的 `abilities` 只有 27）。机制两件事：
 *
 *   1. **每 1% 已损失生命 → 攻击速度 +`perAtkSpeed`**（缩放型属性，写 `add`）。
 *      血越少攻速越快 —— 这是哈斯卡的**身份**，也是遗物那几条「背水血怒」钩子的放大对象。
 *   2. **生命高于 `drainFloorPct`% 时，每秒流失 `drainPct`% 最大生命**。
 *      它是**代价**不是收益：把哈斯卡按在血线下方，免得"满血站着也一样强"。
 *      到线即停（不会再往下掉），所以它不是自杀机制、也不会把自己打死（见第 ③ 条）。
 *
 * 参数全部来自施加方（ability 27 三档 effect 的 `kv`，逐级不同 ⇒ 换级即换档）：
 *   · Lv.1 `{ perAtkSpeed: 0.5 }` —— 每 1% 缺血流 +0.5% 攻速（掉到 60% 血 = +20% 攻速）
 *   · Lv.2 `{ perAtkSpeed: 0.75 }` —— 英雄 Lv.15 升级
 *   · Lv.3 `{ perAtkSpeed: 1 }` —— 英雄 Lv.30 升级
 *   `drainPct` / `drainFloorPct` 三档**都一样**（1% / 60%）—— 代价不随等级变，
 *   否则"升级 = 扣血更快"，玩家会觉得技能在变弱。
 *
 * ── 三条实现口径（都是踩过的地方）──
 *   ① **重算式，不是增量记账**：每帧从 `host.hp / getMaxHp()` **现算**目标攻速，
 *      与"上次写进去的值"比，变了才写。不维护任何"当前层数"，
 *      所以治疗、升级抬上限、遗物改上限、敌人偷血…都不需要额外接线。
 *   ② **写属性走共享模板 1000**（`MODIFY_ATTR_TEMPLATE_ID`）：工程禁止为每个数值组合新增
 *      Modifier 行；同名 origin 重放 = 替换旧贡献，不会叠出多份。
 *   ③ **自伤只 `ChangeHp`，不走伤害管线**：管线会给它算护甲/魔抗（自伤吃自己的魔抗很荒唐）、
 *      还会派发 `on_take_damage`（于是"每秒自伤"会被荆棘/激怒当成挨打，白送反击）。
 *      `ChangeHp` 只改字段 —— 顺带它也是"不会被自己打死"的结构性保证：
 *      钳在血线之上（`drainFloorPct`%），而不是钳在 1 点。
 *
 * ⚠ **换级会重挂本 Modifier**（`Ability.setLevel` 对被动是"摘旧的挂新的"），
 *   于是自伤计时器清零 —— 丢的是不到 1 秒的累积，可忽略。
 *
 * 注册（见 `Scene_Game_Stage.initBattle`）：
 *   ctx.scriptRegistry.registerClass('Modifier_BloodRage', Modifier_BloodRage);
 */
export class Modifier_BloodRage extends Modifier {
    /** 上次真正写进属性系统的攻速值（`NaN` = 还没写过；量化后比较，见 `BLOOD_RAGE_STEP`） */
    private appliedAtkSpeed = NaN;
    /** 自伤计时器（秒）—— 自己累加，**不用** `modifiers.cd`（全工程零调用方的死代码） */
    private drainAcc = 0;

    /** 每 1% 已损失生命换算的攻速（配置口径的 int：1 → +1% 攻速） */
    getPerAtkSpeed(): number {
        const v = Number((this.getKV() ?? {}).perAtkSpeed ?? 0);
        return Number.isFinite(v) && v > 0 ? v : 0;
    }

    /** 每秒流失的最大生命百分比 */
    getDrainPct(): number {
        const v = Number((this.getKV() ?? {}).drainPct ?? 1);
        return Number.isFinite(v) && v > 0 ? v : 0;
    }

    /** 自伤的血线（百分比）：生命高于它才流失 */
    getDrainFloorPct(): number {
        const v = Number((this.getKV() ?? {}).drainFloorPct ?? 60);
        return Number.isFinite(v) && v >= 0 ? v : 60;
    }

    /** 已损失生命的百分比（0~100；上限异常时回 0） */
    getMissingHpPct(): number {
        const host = this.target as any;
        const max = host?.getMaxHp?.() ?? 0;
        if (!(max > 0)) return 0;
        const hp = Math.max(0, Math.min(max, host.hp ?? 0));
        return (max - hp) / max * 100;
    }

    /** 当前**应该**写进属性系统的攻速值（量化前的原始值，调试/断言用） */
    getAtkSpeedBonus(): number {
        return this.getMissingHpPct() * this.getPerAtkSpeed();
    }

    /** 上次写进属性系统的那个量化值（`NaN` = 还没写过；调试/断言用） */
    getAppliedAtkSpeed(): number { return this.appliedAtkSpeed; }

    /** 自伤累积的秒数（调试/体检断言用） */
    getDrainAcc(): number { return this.drainAcc; }

    OnTick(dt: number): void {
        const host = this.target as any;
        if (!host || !host.alive || host.IsDead?.()) return;
        this.drainSelf(host, dt);
        this.syncAtkSpeed(host);
    }

    /**
     * 把「已损失生命 → 攻速」写进属性系统（**变了才写**，见 `BLOOD_RAGE_STEP`）。
     *
     * 量化用 `Math.round(v / STEP) * STEP`：步长 0.5 时 20.24 与 20.26 都落到 20.0，
     * 于是自伤的每一秒才写一次、挨一大下则立刻写一次。
     */
    private syncAtkSpeed(host: any): void {
        const quantized = Math.round(this.getAtkSpeedBonus() / BLOOD_RAGE_STEP) * BLOOD_RAGE_STEP;
        if (quantized === this.appliedAtkSpeed) return;
        this.appliedAtkSpeed = quantized;
        if (!host.modifiers) return;
        // 量化到 0 时**也要写**（不是 return）：那是"血被治满了 ⇒ 加成归零"这一格，
        // 漏掉它会让攻速永远停在上一档（治疗类效果越多越明显）。
        host.modifiers.AddModifier(
            MODIFY_ATTR_TEMPLATE_ID, host, -1,
            { attrs: [[AttributeType.AtkSpeed, quantized, 'add']] },
            BLOOD_RAGE_ORIGIN,
        );
    }

    /**
     * 自伤：生命高于血线时按秒流失，**钳在血线上**（不钳 1 点 —— 见类注释第 ③ 条）。
     *
     * ⚠ 逐帧按 `dt` 扣而不是"整秒扣 1% 最大生命"：整秒跳变会让血线在刻度上来回抖，
     *   量化后的攻速跟着抖，且 HUD 血条会一格格地跳。
     */
    private drainSelf(host: any, dt: number): void {
        const pct = this.getDrainPct();
        if (!(pct > 0) || !(dt > 0)) return;
        const max = host.getMaxHp?.() ?? 0;
        if (!(max > 0)) return;

        const floor = max * this.getDrainFloorPct() / 100;
        const hp = host.hp ?? 0;
        if (hp <= floor) { this.drainAcc = 0; return; }

        this.drainAcc += dt;
        // 这一帧最多掉到血线上（不够掉就只掉这一点）
        const next = Math.max(floor, hp - max * pct / 100 * dt);
        if (next < hp) host.ChangeHp(next - hp, this);
    }
}

/**
 * Modifier_Barrage —— 卓尔游侠「弹幕散射」被动（modifiers.json 70）
 *
 * **英雄的唯一技能**（`units.json#1006` 的 `abilities` 只有 24）。机制一句话：
 * **一发普攻打到尽量多的敌人** —— 普攻命中主目标后，向**攻击范围内**另外最近
 * `extra` 个敌人各射一箭，每箭造成 `攻击力 × pct%` 的**物理**伤害（独立走管线，
 * 所以每箭**各自 roll 暴击、各自吃护甲与破甲**）。
 *
 * 参数全部来自施加方（ability 24 三档 effect 的 `kv`，逐级不同 ⇒ 换级即换档）：
 *   · Lv.1 `{ extra: 1, pct: 60 }` —— 额外 1 箭、每箭 60% 攻击力
 *   · Lv.2 `{ extra: 2, pct: 60 }` —— 英雄 Lv.15 升级
 *   · Lv.3 `{ extra: 3, pct: 80 }` —— 英雄 Lv.30 升级
 * 改数值只动 `abilities.json`，这个类一行都不用碰。
 *
 * ── 四条实现口径 ──
 *   ① **空技能**（`extra` / `pct` 缺省 0）直接 `return`：配表漏了 kv 时是"没有效果"，
 *      不是"每箭 0 伤害也要打一遍管线"（那会给每个敌人各留一条 0 伤害的战斗日志）。
 *   ② **排除主目标**：主目标已经吃过这一发普攻了。不排除的话"额外 N 箭"会退化成
 *      "同一发伤害打 N+1 次" —— 那是「分裂弹(skill 101)」的语义（单目标多段），
 *      与「散射」（多目标各一段）是两条不同的设计，别混。
 *   ③ **只在攻击范围内选人**（半径 = `getAttackRange()`）：射程外的不打。
 *      这也是"远程点杀"与"弹幕散射"在几何上的分界 —— 前者把一发做大，后者把一发摊开。
 *   ④ **不单独上报技能形态**（`publishSkillShape`）：打的是 N 个各不相同的敌人、
 *      N 段独立结算的伤害，表现层本来就会为每一段各画一个印痕 —— 那才是"好多支箭飞出去"。
 *      上报一个扇形反而会**顶掉**这些个体印痕（收到显式形态就直接画那一个形态）。
 *      同一条口径的完整理由写在 `RelicHooks` 的 I 段那一段注释里。
 *
 * 注册（见 `Scene_Game_Stage.initBattle`）：
 *   ctx.scriptRegistry.registerClass('Modifier_Barrage', Modifier_Barrage);
 */
export class Modifier_Barrage extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;

        const kv = this.getKV() ?? {};
        const extra = Math.floor(Number(kv.extra ?? 0));
        const pct = Number(kv.pct ?? 0);
        if (extra <= 0 || !(pct > 0)) return false;

        const ctx: BattleContext | undefined = host.ctxRef;
        if (!ctx || !host.alive || host.IsDead?.()) return false;

        const atk = host.getAttackDamage?.() ?? 0;
        const range = host.getAttackRange?.() ?? 0;
        if (!(atk > 0) || !(range > 0)) return false;
        const dmg = Math.max(1, Math.round(atk * pct / 100));

        const victim = event?.target as any;
        const me = host.position ?? { x: 0, y: 0 };
        const r2 = range * range;
        const candidates: any[] = [];
        for (const e of ctx.GetTeamEntities(2) ?? []) {
            if (!e || e.IsDead?.()) continue;
            if (victim && e.uid === victim.uid) continue;           // 见口径 ②
            const dx = (e.position?.x ?? 0) - me.x;
            const dy = (e.position?.y ?? 0) - me.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > r2) continue;                                   // 见口径 ③
            candidates.push({ e, d2 });
        }
        candidates.sort((a, b) => a.d2 - b.d2);                      // 最近优先（可预测 > 随机）
        const n = Math.min(extra, candidates.length);
        for (let i = 0; i < n; i++) {
            ctx.damagePipeline.ApplyDamage(candidates[i].e, host, dmg, DamageType.Physical);
        }
        return false;
    }
}
