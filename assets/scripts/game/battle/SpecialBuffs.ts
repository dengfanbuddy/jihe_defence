import { Modifier } from './Modifier';
import { AttributeStackMode, BattleEvents, DamageType, MODIFY_ATTR_TEMPLATE_ID } from './types';
import { AttributeType } from './core/Types';
import { HitShapeKind } from '../common/HitFeelConfig';
import { publishSkillShape } from './SkillShape';
import type { BattleContext } from './BattleContext';

/**
 * ============================================================
 * SpecialBuffs —— **机制型**效果的脚本实现（神器 4 条 + 掉落道具 1 条）
 * ============================================================
 *
 * 这是什么：两类"用属性列表达不出来"的效果 ——
 *   · **神器**（`kill_buffs.json`，`stat = special`）：天怒 / 波次补给 / 战地急救 / 滚雪球；
 *   · **掉落道具**（`battle_items.json`）：血包（本表唯一一条 `duration = 0` = 即刻生效的道具）。
 *
 * 为什么单独一个文件（不塞进 `RelicHooks.ts` / `ShopSkillModifiers.ts`）：
 *   那两个文件各自对应**一条配表管线**（遗物钩子 40 条 / 肉鸽技能 25 个），注册表、生成器、
 *   设计真源都是按它们写的。神器与掉落道具属于**第三条轨**（`docs/artifact-drop/README.md`）——
 *   混进去之后"改神器却必须动遗物文件"会变成常态，而且 5 个类的量级也不值得。
 *
 * ── 三条纪律（与 `RelicHooks.ts` 完全一致，每条都有具体的翻车原因）──
 *   ① **`bus.on` 必须配 `bus.off`**，在 `OnDestroy` 里摘干净，用 `subscribed` 布尔标志防重复注册。
 *      原因：只有 6 个事件会派发给 Modifier（`on_attack_start` / `on_attack_landed` /
 *      `on_block_damage` / `on_take_damage` / `on_deal_damage` / `on_evade`）；
 *      **`on_kill` / `on_phase_changed` / `on_gold_gained` 只发总线**，声明式配置永远不触发。
 *      实体走对象池复用，不摘订阅会把**已回收的实例**继续算进去。
 *   ② **不用 `modifiers.cd` / `Trigger()` / `OnTriggered()`** —— 全工程零调用方（死代码）。
 *      需要周期的自己在 `OnTick` 里计时。
 *   ③ **防递归** —— 脚本自己打出的伤害会再次派发 `on_kill` / `on_deal_damage`，用 `busy` 标志过滤。
 *
 * ── 神器的"层数"在这里怎么读（**与属性型神器不同，别抄错**）──
 *   属性型神器（狂怒 / 磐石…）走的是**每层一条独立 Modifier**（`origin = killbuff:{id}:{层}`），
 *   因为属性贡献天然可加。机制型效果**不能那样叠**：
 *   「每 10 杀炸一次」挂 3 份 = 每 10 杀炸 3 次，而设计口径是**炸 1 次、每次更狠**（每层 +50%）。
 *   所以 `BuffShop.applySpecial` 对这几条用**不带层号的 origin**（`killbuff:{id}`）+ 本文件的
 *   `modifiers.json` 行写 `stack_mode = refresh` ⇒ **重买只更新 kv，实例与内部计时都保留**。
 *   层数由施加方塞进 `kv.stack`，脚本侧一律用 `stackOf(this)` 读（`getStackCount()` 恒为 1）。
 *
 * ── 数值一律来自配表 ──
 *   文件里**一个数都不写死**：`kv` 从 `kill_buffs.modifiers[].kv` 来（`relics.modifiers_inner` 同款写法），
 *   改数值完全不用碰代码。只有"引擎口径"（伤害走管线、治疗走 `Entity.Heal`）才是本文件的常量。
 *
 * 注册入口在 `Scene_Game_Stage.initBattle`（与英雄脚本、`SHOP_SKILL_SCRIPT_CLASSES`、
 * `RELIC_HOOK_SCRIPT_CLASSES` 同一处）：漏注册会打印 `[ModifierSystem] script_id 未注册: xxx`
 * 并**静默降级成普通 Modifier**（玩家看到的是"买了但没效果"）。
 */

/* =====================================================================================
 * 一、公共小工具（无状态；与 RelicHooks 同款，那边不改，这里独立维护）
 * ===================================================================================== */

/** 实体是否可被继续结算（非空 + 未死） */
function alive(e: any): boolean {
    return !!e && !e.IsDead?.();
}

/** 宿主 → 战斗上下文（宿主被回收/reinit 后为 undefined，一切入口先过这一关） */
function hostCtx(host: any): BattleContext | undefined {
    return host?.ctxRef;
}

/**
 * 安全读 kv 数值。
 *
 * 为什么包一层：`kv` 来自配表，漏字段 / 写了 null 都很常见，而
 * `Number(undefined)` 是 NaN（一路污染伤害计算）、`Number(null)` 是 **0**（静默把效果变成 0）。
 */
function kvNum(kv: Record<string, any> | undefined, key: string, fallback: number): number {
    const raw = kv?.[key];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
}

/**
 * 本神器当前的**购买层数**（`kv.stack`，由 `BuffShop.applySpecial` 注入）。
 *
 * ⚠ 不要用 `this.getStackCount()`：那几行的 `stack_mode = refresh`，系统侧层数**恒为 1**
 *   （层数是我们自己在 kv 里传的，见文件头「层数在这里怎么读」）。
 */
function stackOf(self: Modifier): number {
    const s = Math.floor(Number(self.getKV()?.stack ?? 1));
    return s > 0 ? s : 1;
}

/** 攻击力 × 百分数（`pct = 200` → 攻击力 × 200%） */
function atkPct(host: any, pct: number): number {
    const atk = host?.getAttackDamage?.() ?? 0;
    if (!(atk > 0) || !(pct > 0)) return 0;
    return Math.max(1, Math.round(atk * pct / 100));
}

/** 「本档幅度 + 每层增量 × (层数 − 1)」—— 四条机制型神器统一用它读"随层数变强"的那个数 */
function perStackValue(kv: Record<string, any> | undefined, baseKey: string, stepKey: string, self: Modifier): number {
    return kvNum(kv, baseKey, 0) + kvNum(kv, stepKey, 0) * (stackOf(self) - 1);
}

/**
 * 重新施加「属性修改」共享模板（`MODIFY_ATTR_TEMPLATE_ID` = 1000）承载动态属性。
 *
 * 共享模板是 `stack_mode = none`、实例身份 = (模板 id, origin) ⇒ **同 origin 重放会替换旧实例**
 * （不会叠出多份贡献），正是"档位涨了重新算一遍"想要的语义。`duration = -1` = 本局永久。
 *
 * ⚠ 允许在 `OnRefresh` 里调它（滚雪球重买时要重算）：模板的 `stack_mode = none` 且没有脚本类，
 *   替换过程只会 `RemoveModifier` + 新建 + `recollect()`，**不会回头再进本类的 `OnRefresh`**，
 *   所以不存在递归。
 */
function reapplyAttrs(host: any, self: Modifier, attrs: any[], duration: number): void {
    if (!alive(host) || !host.modifiers) return;
    host.modifiers.AddModifier(MODIFY_ATTR_TEMPLATE_ID, host, duration, { attrs }, self.origin);
}

/**
 * 「击杀 / 阶段切换 / 金币入账」这类**只发总线**的钩子的公共基类。
 *
 * 为什么不写在 `events[].actions` 里：这些事件**只 `bus.publish`、从不派发给 Modifier**
 * （见 `DamagePipeline` 第 7/8 阶段与 `Scene_Game_Stage.checkStage`），声明式配置永远不触发。
 * 只能自己订阅 —— 代价是必须自己摘：`subscribed` 防重复注册，`OnDestroy` 按**同一个 handler
 * 引用 + 同一个 caller** 摘；子类覆写 `OnCreated`/`OnDestroy` 时**记得先 `super.xxx()`**。
 *
 * ⚠ 与 `RelicHooks.RelicBusHook` 是同一份实现的两份拷贝（那边是 `abstract` 且未导出）。
 *   没有提取成公共模块的原因：`platform/` 不接受战斗语义，而两个文件的纪律必须逐字一致 ——
 *   真出现第三份就该提取了。
 */
abstract class SpecialBusHook extends Modifier {
    private subscribed = false;

    /** 订阅的事件名（`BattleEvents.OnKill` / `OnPhaseChanged` / `OnGoldGained` …） */
    protected abstract getBusEventName(): string;

    /** 事件回调（子类实现具体行为；宿主不匹配时自行 return） */
    protected abstract handleBusEvent(event: any): void;

    /** 稳定的回调引用：`bus.off` 必须传同一个函数对象才能精确摘除 */
    private readonly boundHandler = (event: any): void => {
        this.handleBusEvent(event);
    };

    OnCreated(kv?: Record<string, any>): void {
        super.OnCreated(kv);
        const ctx = hostCtx(this.target);
        if (!ctx?.bus || this.subscribed) return;
        this.subscribed = true;
        ctx.bus.on(this.getBusEventName(), this.boundHandler, this);
    }

    OnDestroy(): void {
        const ctx = hostCtx(this.target);
        if (ctx?.bus && this.subscribed) {
            ctx.bus.off(this.getBusEventName(), this.boundHandler, this);
            this.subscribed = false;
        }
    }
}

/* =====================================================================================
 * 二、四条机制型**神器**（kill_buffs 16 / 18 / 19 / 20；modifiers.json 240~243）
 * ===================================================================================== */

// ---------------------------------------------------------------- 240 天怒

/**
 * 天怒（`kb_skyfall`）。`kv = { killsPer, boomPct, boomPctPerStack, radiusMul, halfAngleDeg }`
 * （10 / 200 / 50 / 1.2 / 45）
 *
 * 文案：`每 10 次击杀在面前喷出一道扇形，攻击力 ×200%（每层 +50%），半径 = 攻击距离 ×1.2`
 *
 * ── 2026-11 从"全屏爆炸"改成"正前方扇形"（用户口径）──
 *   原口径：「每 10 次击杀触发 1 次**全屏**爆炸」。用户明确否掉了这一类：
 *   **「最好不要有全屏范围技能，最好是攻击范围内；如果要大范围，可以是扇形，但也要有所表现」**。
 *   现在它落在**英雄自己的攻击距离内**（×1.2），朝向 = **刚被击杀那只怪的方向**，
 *   半角 45°（总共 90° 的扇面）—— 也就是"朝我打死的那个方向扫一片"，
 *   这是一句**有朝向、有范围、看得见**的话，而不是"全屏掉血"。
 *
 * ── 为什么要上报形态（`publishSkillShape`）──
 *   这个效果**没有任何普攻锚点**（它由 `OnKill` 触发），表现层的几何推断以前只能把它
 *   归成"全场"（那正是被否掉的那张图）。上报之后画的是扇形：从英雄脚下**快速向外扩散的扇面**。
 *
 * ── 保留的两条老坑 ──
 *   · **`busy` 必须留** —— 爆炸打死的怪会再发 `OnKill`，不清零计数就会"A 炸死 10 只 → 立刻再炸一次"
 *     的连锁（无尽模式后期能把一帧吃满）。口径因此是"**你亲手打死的才算进度**"。
 *     对照 `RelicHook_CritEcho` 的同一个标志。
 *   · 读的是 `event.killer`（不是 `victim`）：`OnKill` 派发时死者**已经被场景回收了**
 *     （`OnDeath` 先发、场景在那里 `recycleMonster`），`victim.position` 那时**已经是 (0,0)** ——
 *     所以方向只能从 `deathPos` 快照取（同 `RelicHooks.centerAt` 的理由）。
 *     ⚠ `RelicHook_KillBoom` 上还挂着同一条坑的另一半（它以 `victim.position` 为圆心，
 *     实际圆心是原点），见 `docs/artifact-drop/README.md` §13.6。
 */
export class KillBuff_Skyfall extends SpecialBusHook {
    /** 距离下一次爆炸还差几杀 */
    private kills = 0;
    /** 防递归：爆炸自己的击杀不计入进度 */
    private busy = false;

    protected getBusEventName(): string { return BattleEvents.OnKill; }

    /** 当前累计击杀（调试/断言用） */
    getKills(): number { return this.kills; }

    protected handleBusEvent(event: any): void {
        const host = this.target as any;
        if (this.busy) return;
        if (!host || event?.killer !== host || !alive(host)) return;

        const kv = this.getKV() ?? {};
        const killsPer = Math.floor(kvNum(kv, 'killsPer', 0));
        if (killsPer <= 0) return;

        this.kills++;
        if (this.kills < killsPer) return;

        const ctx = hostCtx(host);
        if (!ctx) return;
        const pct = perStackValue(kv, 'boomPct', 'boomPctPerStack', this);
        const dmg = atkPct(host, pct);
        if (!(dmg > 0)) return;

        // 半径 = **英雄自己的攻击距离 × radiusMul**（"落在攻击范围内"这条口径的唯一落点）
        const radiusMul = kvNum(kv, 'radiusMul', 1.2);
        const radius = Math.max(1, (host.getAttackRange?.() ?? 0) * radiusMul);
        const halfAngleDeg = Math.max(1, Math.min(180, kvNum(kv, 'halfAngleDeg', 45)));

        // 朝向 = 刚被击杀的那只怪（`deathPos` 是唯一可信的坐标快照，见类注释）
        const me = host.position ?? { x: 0, y: 0 };
        const dp = event?.deathPos ?? event?.victim?.position ?? null;
        const dir = normalizeDir((dp?.x ?? me.x) - me.x, (dp?.y ?? me.y) - me.y);
        const cosLimit = Math.cos((halfAngleDeg * Math.PI) / 180);

        this.kills -= killsPer;
        this.busy = true;
        try {
            // 先把形态报出去（**结算前**：这一圈里的怪随时可能被这次伤害打死并回收）
            publishSkillShape(ctx, {
                shape: HitShapeKind.Fan,
                source: host,
                target: event?.victim ?? null,
                cx: me.x,
                cy: me.y,
                radius,
                dirX: dir.x,
                dirY: dir.y,
                halfAngleDeg,
            });
            for (const e of ctx.findEntitiesInRadius(host, radius, 2) ?? []) {
                if (!alive(e)) continue;
                // 扇形判定：与朝向的夹角 ≤ 半角（贴在英雄身上的目标一律算命中）
                const dx = (e.position?.x ?? me.x) - me.x;
                const dy = (e.position?.y ?? me.y) - me.y;
                const len = Math.hypot(dx, dy);
                if (len > 1e-3 && (dx / len) * dir.x + (dy / len) * dir.y < cosLimit) continue;
                ctx.damagePipeline.ApplyDamage(e, host, dmg, DamageType.Magical);
            }
        } finally {
            this.busy = false;
        }
    }
}

/** 单位化（全零返回朝右：宁可朝一个固定方向画，也不画一个没有朝向的扇） */
function normalizeDir(x: number, y: number): { x: number; y: number } {
    const len = Math.hypot(x, y);
    if (!(len > 1e-6)) return { x: 1, y: 0 };
    return { x: x / len, y: y / len };
}

// ---------------------------------------------------------------- 241 波次补给

/**
 * 波次补给（`kb_waveheal`）。`kv = { healPct, healPctPerStack }`（50 / 50）
 *
 * 文案：`波次开始时回复 50% 缺失生命`（2 级 → 100% = 回满）。
 *
 * 实现：`bus.on(OnPhaseChanged)`（阶段切换只发总线）→ 按 `(healPct + healPctPerStack × (层数−1))%`
 * 回复**已损失生命**（不是最大生命 —— 满血时按了不回、也不会越界，`ChangeHp` 另有上限钳制）。
 *
 * 坑：场景层只在**阶段号真的变了**之后 publish，所以不用处理重复信号；换英雄不影响
 * （这条没有内部计数，只读 kv）。
 */
export class KillBuff_WaveHeal extends SpecialBusHook {
    protected getBusEventName(): string { return BattleEvents.OnPhaseChanged; }

    protected handleBusEvent(_event: any): void {
        const host = this.target as any;
        if (!alive(host)) return;

        const pct = perStackValue(this.getKV(), 'healPct', 'healPctPerStack', this);
        if (!(pct > 0)) return;

        const maxHp = host.getMaxHp?.() ?? 0;
        const missing = Math.max(0, maxHp - (host.hp ?? maxHp));
        const heal = Math.round(missing * pct / 100);
        if (!(heal > 0)) return;
        host.Heal?.(heal, host);
    }
}

// ---------------------------------------------------------------- 242 战地急救

/**
 * 战地急救（`kb_critheal`）。`kv = { healPct, healPctPerStack }`（5 / 3）
 *
 * 文案：`暴击时回复造成伤害 5% 的生命`（每层 +3%）。
 *
 * 实现：`on_deal_damage`（**派发给伤害来源的 Modifier**）→ `event.source === host && event.isCrit`
 * → 回复 `event.finalDamage × (healPct + healPctPerStack × (层数−1))%`。
 *
 * 坑：
 *   · **必须挂 `on_deal_damage`**：`on_attack_landed` 的载荷里**没有 `isCrit`**，
 *     只有 `DamagePipeline` 第 7 阶段的 `dmgEvent` 带（同 `RelicHook_CritEcho`）。
 *   · **不需要 `busy`**：治疗走 `Entity.Heal` → 发的是 `on_heal`（总线），
 *     不会回头派发 `on_deal_damage`，不存在自我递归。
 *   · 吃的是 `finalDamage`（本次实际打出的伤害，已过护甲/减免）—— 与文案"造成伤害"一致。
 */
export class KillBuff_CritHeal extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_deal_damage') return false;
        const host = this.target as any;
        if (!host || event?.source !== host) return false;
        if (!event?.isCrit || !alive(host)) return false;

        const pct = perStackValue(this.getKV(), 'healPct', 'healPctPerStack', this);
        const heal = Math.round(Number(event?.finalDamage ?? 0) * pct / 100);
        if (!(heal > 0)) return false;
        host.Heal?.(heal, host);
        return false;
    }
}

// ---------------------------------------------------------------- 243 滚雪球

/**
 * 滚雪球（`kb_snowball`）。`kv = { goldPer, atkPctPerTier, maxTiers }`（100 / 2 / 6）
 *
 * 文案：`每获取 100 金币，攻击力 +2%`，叠满（6 层）攻击力 +12%。
 *
 * 实现：`bus.on(OnGoldGained)` → 累计**本局获得过的**金币（不是当前余额 —— 抽遗物会把金币花掉，
 * 按余额算会"越花越弱"）→ 每满 `goldPer` 涨**一个内部档**（上限 `maxTiers`）→
 * 共享模板 1000 重放 `[3 攻击力, 档数 × atkPctPerTier × 购买层数, 'percent']`、本局永久。
 *
 * 层数口径（为什么文案说"叠满 +12%"）：**1 层时 6 档 × 2% = +12%**。
 * 再往上买只放大每档的幅度（N 层 → +12% × N，封顶 +72%），档数上限不变 —— 这样
 * "每 100 金币"这个节拍不会随层数变密，玩家读到的东西前后一致。
 *
 * 坑：
 *   · `event.target` 要判：`OnGoldGained` 是总线事件，别的实体（如召唤物）加金也会发。
 *   · **重买时要重算**：`BuffShop` 用不带层号的 origin + `stack_mode = refresh` 重放本行，
 *     系统会调 `OnRefresh` 更新 kv —— 但属性贡献不会自己变，所以这里覆写 `OnRefresh`
 *     再重放一次共享模板（`reapplyAttrs` 在该时机是安全的，见它的注释）。
 *   · 档数**只增不减**：金币花掉不回落（累计量，不是余额）。
 */
export class KillBuff_Snowball extends SpecialBusHook {
    /** 本局累计**获得过**的金币 */
    private gold = 0;
    /** 当前内部档（每 goldPer 一档，上限 maxTiers） */
    private tiers = 0;

    protected getBusEventName(): string { return BattleEvents.OnGoldGained; }

    /** 累计金币 / 当前档（调试/断言用） */
    getGold(): number { return this.gold; }
    getTiers(): number { return this.tiers; }

    /** 重买（层数变了）→ 同一帧把属性重算一遍（系统紧接着会 `recollect`） */
    OnRefresh(kv?: Record<string, any>): void {
        super.OnRefresh(kv);
        this.applyTiers();
    }

    protected handleBusEvent(event: any): void {
        const host = this.target as any;
        if (!host || event?.target !== host || !alive(host)) return;

        const kv = this.getKV() ?? {};
        const goldPer = Math.floor(kvNum(kv, 'goldPer', 0));
        const maxTiers = Math.floor(kvNum(kv, 'maxTiers', 0));
        if (goldPer <= 0 || maxTiers <= 0) return;

        this.gold += Math.max(0, Number(event?.amount ?? 0));
        const want = Math.min(maxTiers, Math.floor(this.gold / goldPer));
        if (want <= this.tiers) return;      // 只增不减（金币花掉不回落）
        this.tiers = want;
        this.applyTiers();
    }

    /** 把"档数 × 每档幅度 × 购买层数"重放给共享模板（0 档 / 0 层时不挂任何东西） */
    private applyTiers(): void {
        const host = this.target as any;
        if (!alive(host) || this.tiers <= 0) return;
        const perTier = kvNum(this.getKV(), 'atkPctPerTier', 0);
        const pct = this.tiers * perTier * stackOf(this);
        if (!(pct > 0)) return;
        reapplyAttrs(host, this, [[AttributeType.Atk, pct, AttributeStackMode.Percent]], -1);
    }
}

/* =====================================================================================
 * 三、一条**掉落道具**脚本（battle_items 15 血包；modifiers.json 250）
 * ===================================================================================== */

/**
 * 血包（`bi_blood_bag`）。`kv = { healPct }`（25）
 *
 * 文案：`立刻回复 25% 最大生命`。
 *
 * 实现：在 `OnCreated` 里就结算 —— 本行的 `duration = 0`（**即刻生效**，见
 * `Tb_BattleItemConfig.duration`），所以这个 Modifier 只活在"被施加的那一帧"，
 * 下一帧 `ModifierSystem.Tick` 就把它收走，**不留任何状态**（这正是它与本表其余 15 条限时道具的区别）。
 *
 * 坑：
 *   · **按最大生命算，不按已损失生命**：它是"血包"不是"急救"，满血按下去就是浪费 ——
 *     这个取舍本身就是 6 格背包那条"什么时候按"的操作决策。
 *   · `duration = 0` 的下游依赖：`ItemBag.applyItem` 只在 `duration < 0` 时才告警，
 *     且把这个 0 原样传给 `AddModifier`（**不能兜成 `-1`**，那会变成永久 Modifier）。
 */
export class BattleItem_BloodBag extends Modifier {
    OnCreated(kv?: Record<string, any>): void {
        super.OnCreated(kv);
        const host = this.target as any;
        if (!alive(host)) return;
        const pct = kvNum(this.getKV(), 'healPct', 0);
        const maxHp = host.getMaxHp?.() ?? 0;
        const heal = Math.round(maxHp * pct / 100);
        if (!(heal > 0)) return;
        host.Heal?.(heal, host);
    }
}

/* =====================================================================================
 * 三·b 另一条**掉落道具**脚本（battle_items 17 引爆器；modifiers.json 252）
 * ===================================================================================== */

/**
 * 引爆器（`bi_mine_trigger`）。`kv = { bonusPct }`（50）
 *
 * 文案：`立刻引爆场上全部骷髅地雷（每颗伤害 +50% 攻击力）`。
 *
 * 实现：`OnCreated` 里一次性结算（与血包同一条路：本行 `duration = 0` = **即刻生效**，
 * 下一帧 `ModifierSystem.Tick` 就把它收走，不留状态）。
 *
 * ── 为什么这件事必须是"按一下"而不是被动 ──
 *   地雷的默认节奏是**敌人踩一颗炸一颗**；而"攒满 5 颗再一起爆"收益高得多
 *   （同一片敌人被 5 发爆炸重叠打，且不必等它们自己走过来）。那个「什么时候按」的决策
 *   就是这件道具的全部价值 —— 做成被动等于把这个决策拿走。
 *
 * 坑：
 *   · **`ctx.mines` 可能拿不到**（体检环境 / 还没接线）：一律可选链，拿不到就什么都不做 ——
 *     抛出会把 `ItemBag.use` 整条链带崩（道具用不掉，格子还占着）；
 *   · **场上没雷时返回 0**：宿主据此决定要不要飘字，别飘一句"引爆 0 颗"；
 *   · 伤害在 `BattleMines.detonate` 里算（走伤害管线、各自吃护甲），这里只传"额外百分比"。
 */
export class BattleItem_MineTrigger extends Modifier {
    OnCreated(kv?: Record<string, any>): void {
        super.OnCreated(kv);
        const host = this.target as any;
        if (!alive(host)) return;
        const ctx: BattleContext | undefined = host.ctxRef;
        const mines: any = ctx?.mines;
        if (!mines?.detonateAll) return;
        const bonusPct = kvNum(this.getKV(), 'bonusPct', 0);
        const n = mines.detonateAll(bonusPct);
        if (n > 0) console.log(`[引爆器] 一次引爆 ${n} 颗骷髅地雷（每颗 +${bonusPct}% 攻击力）`);
    }
}

/* =====================================================================================
 * 四、脚本类清单 —— 供 Scene_Game_Stage.initBattle 一次性注册
 * ===================================================================================== */

/**
 * 全部**机制型**脚本类：`script_id` → 类（键名 = `modifiers.json` 里带 script_id 的那几行）。
 *
 * 注册入口在 `Scene_Game_Stage.initBattle`（与英雄脚本、`SHOP_SKILL_SCRIPT_CLASSES`、
 * `RELIC_HOOK_SCRIPT_CLASSES` 同一处）。漏注册会打印 `[ModifierSystem] script_id 未注册: xxx`
 * 并**静默降级成普通 Modifier**（那 4 条神器看起来就是"买了没效果"）。
 * `tools/artifact-audit` 有一条断言专门盯"配表里的 script_id ↔ 这张表"。
 */
export const SPECIAL_BUFF_SCRIPT_CLASSES: Record<string, any> = {
    KillBuff_Skyfall,
    KillBuff_WaveHeal,
    KillBuff_CritHeal,
    KillBuff_Snowball,
    BattleItem_BloodBag,
    BattleItem_MineTrigger,
};
