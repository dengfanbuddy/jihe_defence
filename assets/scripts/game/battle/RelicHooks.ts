import { Modifier } from './Modifier';
import { BattleEvents, DamageType, MODIFY_ATTR_TEMPLATE_ID } from './types';
import { AttributeType } from './core/Types';
import type { BattleContext } from './BattleContext';

/**
 * ============================================================
 * RelicHooks —— 局内遗物（肉鸽商店道具）**钩子**的参数化脚本实现
 * ============================================================
 *
 * 这是什么：局内遗物重做（2026-10 定案，设计真源 `tools/excel_export/scripts/lib/relic-inner-design.mjs`
 * 的 `HOOKS` 数组）里那 **40 个「脚本 Modifier」**。每一条 `HOOKS[].impl` 形如 `S:RelicHook_HitPct`，
 * `S:` 后面的名字就是本文件里的类名，也是注册表 `RELIC_HOOK_SCRIPT_CLASSES` 的键。
 *
 * 为什么参数化（一条钩子一个类，数值不进代码）：
 *   同一个钩子在蓝/黄/红三档只是**数值不同**（如「重击」15% / 30% / 50%），
 *   所以代码里**一个数都不写死** —— 全部由遗物的 `modifiers_inner[].kv` 传入，
 *   运行期用 `this.getKV()` 读（配表改动完全不碰代码）。
 *   行为差异（层数上限、概率、半径、瞬时时长）同样走 kv；只有**引擎口径**（米→像素、
 *   链式弹射半径、DoT 上限层数）才是本文件的常量。
 *
 * 三条纪律（与 `ShopSkillModifiers.ts` 完全一致，每一条都有具体的翻车原因）：
 *   ① **`bus.on` 必须配 `bus.off`**，并在 `OnDestroy` 里摘干净，用 `subscribed` 布尔标志防重复注册。
 *      原因：只有 5+1 个事件会派发给 Modifier（`on_attack_start` / `on_attack_landed` /
 *      `on_block_damage` / `on_take_damage` / `on_deal_damage` / `on_evade`）；
 *      `on_kill` / `on_phase_changed` / `on_gold_gained` 等**只发总线**。
 *      实体走对象池复用，不摘订阅会把**已回收的实例**继续算进去（表现为"遗物多打了一份伤害"）。
 *   ② **不要依赖 `modifiers.cd` / `Trigger()` / `OnTriggered()`** —— 全工程零调用方（死代码）。
 *      一切周期性行为自己在 `OnTick(dt)` 里计时（每个类自己存 `private timer = 0`）。
 *   ③ **防递归** —— 脚本自己打出的伤害会再次派发事件（`on_deal_damage` 尤其危险），
 *      用 `busy` 标志过滤（`critEcho` / `thorns`）；命中类钩子不会自我递归
 *      （追加伤害**不会**再派发 `on_attack_landed`），但会派发 `on_deal_damage` → 仍需 busy。
 *
 * 与设计表文案的口径（**评审过的统一落地方式，别改**）：
 *   · 文案里的「伤害 ×N 倍 / +X% 伤害」在本工程**没有乘法改伤害的口子**
 *     （`DamagePipeline` 的乘区只有 `DamageOut` 属性与暴击，塞进去会把普攻本身一起抬高），
 *     统一落地为**追加一段独立结算的伤害**（`ctx.damagePipeline.ApplyDamage`）——
 *     各自过一遍管线、各自 roll 暴击、独立吃护甲与受伤减免；追加量 = `攻击力 × (N-1)`。
 *   · 「目标满血 / 生命低于 X%」必须在 `on_attack_start`（伤害**之前**）快照：
 *     `on_attack_landed` 派发时目标已经掉血了（`Entity.resolveAttackHit` 先 `ApplyDamage` 再发事件），
 *     在那里判会永远为假。快照**按 `target.uid` 存**（对象池复用会认错实体），不要存对象引用。
 *   · 「减少受到的伤害」一律写在 `on_block_damage` 里（唯一能改已到伤害的位置，把要挡掉的量
 *     加到 `event.blocked`），即使设计表那一行的 `trig` 写的是 `on_take_damage`。
 *   · 点燃/中毒是**周期伤害（DoT）**：钩子只负责**施加一次**（`AddModifier(kv.dotMod, ...)`），
 *     伤害由那条 DoT 行自己 tick —— 钩子里**不许**再补一段伤害（否则实际伤害翻倍）。
 *
 * 注册入口在 `Scene_Game_Stage.initBattle`（与英雄脚本、`SHOP_SKILL_SCRIPT_CLASSES` 同一处）：
 * 漏注册会在运行时打印 `[ModifierSystem] script_id 未注册: xxx` 并**静默降级成普通 Modifier**
 * （玩家看到的是"抽到了但没效果"）。
 */

/* =====================================================================================
 * 一、Modifier id 常量（与 `modifiers.json` 逐行对应；由配表侧负责加行，本文件只引用 id）
 * ===================================================================================== */

/** 既有行「无敌」：`apply_state invulnerable` */
const MOD_INVULNERABLE = 6;
/** 既有行「眩晕」：`apply_state stunned` */
const MOD_STUN = 7;
/** 遗物·减速：`modify_attr` 属性 5（移速），值由 `kv.slow` 传（**像素/秒，传负数**） */
const MOD_RELIC_SLOW = 300;
/** 遗物·沉默：`apply_state silenced` */
const MOD_RELIC_SILENCE = 301;
/** 遗物·妖术：`apply_state hexed` */
const MOD_RELIC_HEX = 302;
/** 遗物·破甲：`modify_attr` 属性 6，值由 `kv.armor` 传（**负数**），可叠 3 层、持续 2 秒 */
const MOD_RELIC_ARMOR_BREAK = 303;
/** 遗物·冰封：`apply_state stunned`（冻结语义，默认 1.5 秒） */
const MOD_RELIC_FREEZE = 304;
/* 305 留空（预留给后续控制类） */
/** 遗物·点燃（蓝/黄/红）：`tick_damage` 每秒 6 / 12 / 20，持续 3 秒，**refresh** */
const MOD_IGNITE_RARE = 306;
const MOD_IGNITE_EPIC = 307;
const MOD_IGNITE_LEGENDARY = 308;
/** 遗物·中毒（蓝/黄/红）：`tick_damage` 每秒 4 / 8 / 14，持续 4 秒，**renew**（每次命中一层） */
const MOD_POISON_RARE = 309;
const MOD_POISON_EPIC = 310;
const MOD_POISON_LEGENDARY = 311;

/** 点燃持续（秒）—— 与 306~308 三行的 duration 一致；显式传，免得依赖行的默认值 */
const IGNITE_SEC = 3;
/** 中毒持续（秒）—— 与 309~311 三行一致 */
const POISON_SEC = 4;
/** 中毒的层数上限（文案承诺：上限 5 层）—— 由钩子自己判，DoT 行只负责一跳一跳地打 */
const POISON_MAX_LAYERS = 5;

/** 链式弹射的默认索敌半径（像素）—— 与 `ShopSkillModifiers` / `Modifier_ZeusThunder` 同一口径 */
const CHAIN_RANGE_PX = 260;
/** 「穿透」的锥角系数（与 `Modifier_PiercingBolt` 同一口径）：`|perp| <= proj × 该值` */
const PIERCE_SPREAD = 0.6;
/** 「穿透」的固定伤害比例（文案写死 60%） */
const PIERCE_PCT = 60;

/** 命中叠层的有效期（秒）：文案「持续 3 秒」= 3 秒内没再命中就归零 */
const HIT_STACK_SEC = 3;
/** 冰霜减速的持续（秒）—— 文案「持续 2 秒」 */
const FROST_SEC = 2;
/** 破甲的持续（秒）—— 文案「持续 2 秒，可叠 3 层」（层数与上限由 303 行配置） */
const ARMOR_BREAK_SEC = 2;
/** 冰封的持续（秒）—— 文案「冻结目标 1.5 秒」 */
const FREEZE_SEC = 1.5;
/** 光环类的节拍间隔（秒）：灼烧光环 / 迟滞光环都是「每秒」 */
const AURA_INTERVAL = 1;
/** 迟滞光环的减速持续（秒）：比光环节拍略长，保证"在范围内就一直被减速" */
const AURA_SLOW_SEC = 1.2;
/** 濒死守护的触发血线（文案写死：生命低于 25%） */
const NEAR_DEATH_HP_PCT = 25;

/* =====================================================================================
 * 二、公共小工具（无状态；与 `ShopSkillModifiers.ts` 同款，故那里不加改动）
 *
 * ⚠ 本文件**没有** `meters()`：本组 40 条钩子的距离参数在设计表里**一律是像素**
 *   （140/160/200…），不需要米→像素换算。「米→像素」的唯一口径仍是
 *   `BattleConstUtil.getPxPerMeter()`（现 50），需要换算的调用方自己去取，
 *   这里不抄一份无调用方的死代码（与工程「零调用方 = 死代码」的纪律一致）。
 * ===================================================================================== */

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

/** 宿主 → 战斗上下文（宿主被回收/reinit 后为 undefined，一切入口先过这一关） */
function hostCtx(host: any): BattleContext | undefined {
    return host?.ctxRef;
}

/**
 * 安全读 kv 数值。
 *
 * 为什么要包一层：`kv` 来自 `relics.json` 的 `modifiers_inner[].kv`，漏字段/写了 null 都很常见，
 * `Number(undefined)` 是 NaN（会一路污染伤害计算），而 `Number(null)` 是 **0**（静默把效果变成 0）。
 * 两种都不该发生，所以显式判空 → 回落默认值。
 */
function kvNum(kv: Record<string, any> | undefined, key: string, fallback: number): number {
    const raw = kv?.[key];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
}

/** 百分比命中判定：`pct` 是**百分数**（30 = 30%） */
function rollPct(pct: number): boolean {
    if (!(pct > 0)) return false;
    if (pct >= 100) return true;
    return Math.random() * 100 < pct;
}

/** 点燃的三档 DoT 行 id（蓝/黄/红）—— 施加方用 `kv.dotMod` 指定用哪一行 */
const IGNITE_DOT_MODS = [MOD_IGNITE_RARE, MOD_IGNITE_EPIC, MOD_IGNITE_LEGENDARY];
/** 中毒的三档 DoT 行 id（蓝/黄/红） */
const POISON_DOT_MODS = [MOD_POISON_RARE, MOD_POISON_EPIC, MOD_POISON_LEGENDARY];

/**
 * 取「该用哪条 DoT 行」：`kv.dotMod` 指定，配错/漏配时兜底到蓝档那一行。
 *
 * 为什么要有这层校验：`AddModifier` 拿到不存在的 id 只会 `console.warn` 并返回 null
 * （静默失效，表现成"点燃抽到了但不掉血"）。兜到蓝档至少让钩子还在工作，
 * 而且三档的 id 都在这两张清单里被引用到（不会有"声明了却没人用"的常量）。
 * ⚠ 用 `indexOf` 而不是 `Array.includes`：工程 tsconfig 的 lib 只到 ES2015。
 */
function pickDotMod(kv: Record<string, any> | undefined, list: number[], fallback: number): number {
    const id = Math.floor(kvNum(kv, 'dotMod', fallback));
    return list.indexOf(id) >= 0 ? id : fallback;
}

/** 攻击力 × 倍率（追加伤害的统一算法；`factor = 0.3` = 30% 攻击力） */
function atkMul(host: any, factor: number): number {
    const atk = host?.getAttackDamage?.() ?? 0;
    if (!(atk > 0) || !(factor > 0)) return 0;
    return Math.max(1, Math.round(atk * factor));
}

/** 攻击力 × 百分数（`pct` 是百分数：30 → 攻击力 × 30%） */
function atkPct(host: any, pct: number): number {
    return atkMul(host, pct / 100);
}

/** 追加一段独立结算的伤害（≤0 / 目标已死直接跳过，避免无效的管线调用） */
function deal(ctx: BattleContext, source: any, target: any, amount: number, type: DamageType): void {
    if (!alive(target) || !(amount > 0)) return;
    ctx.damagePipeline.ApplyDamage(target, source, amount, type);
}

/** 所有存活敌人（team = 2），按离 `from` 的距离升序；`exclude` 排除自己人/已命中者 */
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

/** 以 `center` 为圆心、`radiusPx` 像素内的存活敌人（含圆心上的那个实体本身） */
function enemiesInRadius(ctx: BattleContext, center: any, radiusPx: number): any[] {
    return (ctx.findEntitiesInRadius(center, radiusPx, 2) ?? []).filter((e: any) => alive(e));
}

/** 以 `center` 为圆心打一圈（半径是**像素**）；`exclude` 用于排除圆心上的那个实体本身 */
function aoe(ctx: BattleContext, center: any, radiusPx: number, hit: (target: any) => void, exclude?: Set<number>): void {
    for (const e of enemiesInRadius(ctx, center, radiusPx)) {
        if (exclude && exclude.has(e.uid)) continue;
        hit(e);
    }
}

/**
 * 链式弹射：从 `start` 出发，每次找**当前落点附近**最近的未命中敌人，跳 `jumps` 次。
 *
 * 与 `ShopSkillModifiers.chain` 同一实现（那边不改，这里抄一份独立维护）：
 * `visited` 必须有 —— 否则两个敌人之间会来回弹；「上一跳的落点决定下一跳」也没有声明式写法。
 */
function chain(
    ctx: BattleContext, start: any, jumps: number, rangePx: number,
    dealHit: (target: any, index: number) => void,
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
        dealHit(next, i);
        cur = next;
    }
}

/**
 * 加局内金币 + 通知 HUD。
 *
 * ⚠ 只改 `host.gold` 是**不够**的：HUD 的金币由 `battleStore` 投影（`Scene_Game_Stage.syncHeroToStore`），
 * 必须自己发一条 `on_gold_gained`，否则要等到下一次受伤才在界面上跳出来。
 */
function addGold(host: any, gold: number, self: Modifier): void {
    const n = Math.floor(gold);
    if (!(n > 0)) return;
    host.gold = (host.gold ?? 0) + n;
    hostCtx(host)?.bus?.publish(BattleEvents.OnGoldGained, { target: host, amount: n, source: self });
}

/**
 * 加局内经验（只发事件）。
 *
 * 局内经验的唯一入口是 `Scene_Game_Stage.addBattleExp`（私有，且要处理升级/成长/HUD 投影），
 * 战斗层不能直接调 —— 所以由脚本 `publish`，场景层订阅后折算。**发事件即完成契约**。
 */
function gainExp(host: any, exp: number, self: Modifier): void {
    const n = Math.floor(exp);
    if (!(n > 0)) return;
    hostCtx(host)?.bus?.publish(BattleEvents.OnExpGained, { target: host, amount: n, source: self });
}

/**
 * 减速幅度（**像素/秒，负数**）：按目标**当前移速**的 `pct%` 换算。
 *
 * 移速属性 base = 300（`attributes.json`），所以 `pct = 30` → `-90` 像素/秒。
 * 传正数会把敌人加速，所以这里恒定取负；`pct <= 0` 时返回 0（调用方跳过）。
 */
function slowValue(target: any, pct: number): number {
    if (!(pct > 0)) return 0;
    const speed = target?.attrs?.get?.(AttributeType.MoveSpeed) ?? 300;
    return -Math.round(Math.max(0, speed) * pct / 100);
}

/**
 * 重新施加「属性修改」共享模板（`MODIFY_ATTR_TEMPLATE_ID` = 1000）承载叠层属性。
 *
 * 共享模板的 `stack_mode = none` 且实例身份 = (模板 id, origin)：
 * **同 origin 重放会替换旧实例**（不会叠出多份贡献），正是"层数涨了重新算一遍"想要的语义。
 * `duration = -1` = 本局永久（只有 `-1` 才是永久，别用 0/null）。
 */
function reapplyAttrs(host: any, self: Modifier, attrs: any[], duration: number): void {
    if (!alive(host) || !host.modifiers) return;
    host.modifiers.AddModifier(MODIFY_ATTR_TEMPLATE_ID, host, duration, { attrs }, self.origin);
}

/**
 * 「击杀 / 阶段切换」这类**只发总线**的钩子的公共基类。
 *
 * 为什么不写在 `events[].actions` 里：`on_kill` / `on_phase_changed` **只 `bus.publish`、
 * 从不派发给 Modifier**（见 `DamagePipeline` 第 7/8 阶段与 `Scene_Game_Stage.checkStage`），
 * 声明式配置永远不触发（静默失效）。所以只能自己订阅 —— 代价是必须自己摘。
 *
 * 纪律：`subscribed` 防重复注册；`OnDestroy` 里按**同一个 handler 引用 + 同一个 caller** 摘；
 * 子类若要覆写 `OnCreated`/`OnDestroy`，**记得先 `super.xxx()`**。
 */
abstract class RelicBusHook extends Modifier {
    private subscribed = false;

    /** 订阅的事件名（`BattleEvents.OnKill` / `BattleEvents.OnPhaseChanged` …） */
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
 * ============ A 组：攻击命中类（on_attack_landed / on_attack_start / on_deal_damage）============
 * ===================================================================================== */

// ---------------------------------------------------------------- hitFlat 追击

/**
 * 追击（`hitFlat`）。`kv = { value }`（蓝 20 / 黄 45 / 红 80）
 *
 * 文案：`普攻命中后追加 N 点魔法伤害`。
 *
 * 实现：`on_attack_landed` 且 `event.attacker === host` → 对 `event.target` 追加一段固定值魔法伤害。
 * 坑：追加伤害**不会**再派发 `on_attack_landed`（那个事件只由 `Entity.resolveAttackHit` 发），
 * 所以本类不需要 busy 标志；但它会派发 `on_deal_damage` → 那边的 `critEcho` 自己防递归。
 */
export class RelicHook_HitFlat extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim)) return false;

        const value = kvNum(this.getKV(), 'value', 0);
        deal(ctx, host, victim, value, DamageType.Magical);
        return false;
    }
}

// ---------------------------------------------------------------- hitPct 重击

/**
 * 重击（`hitPct`）。`kv = { pct }`（蓝 15 / 黄 30 / 红 50）
 *
 * 文案：`普攻命中后追加 攻击力 pct% 的魔法伤害`。
 *
 * 实现：追加伤害 = `攻击力 × pct / 100`（`pct` 是百分数，记得 `/100`）。
 * 坑：与 `hitFlat` 同源，一次命中只追加**一段**（不随段数叠加）。
 */
export class RelicHook_HitPct extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim)) return false;

        const dmg = atkPct(host, kvNum(this.getKV(), 'pct', 0));
        deal(ctx, host, victim, dmg, DamageType.Magical);
        return false;
    }
}

// ---------------------------------------------------------------- ignite 点燃

/**
 * 点燃（`ignite`）。`kv = { chance, dps, dotMod }`（蓝 20%/6、黄 35%/12、红 50%/20）
 *
 * 文案：`普攻有 chance% 概率点燃目标：每秒 dps 点魔法伤害，持续 3 秒`。
 *
 * 实现：概率命中 → 给目标施加 **`kv.dotMod` 指定的那条 DoT 行**（306/307/308，每秒伤害烘在行里），
 * 持续 3 秒。`dps` 本身**只用于文案与配表对齐，代码不消费** —— 伤害由 DoT 行自己 tick，
 * 钩子里再补一段就成双倍（见文件头口径）。
 *
 * 坑：`dotMod` 缺失时兜底到蓝档 306（不静默失效）；行的 `stack_mode = refresh`，
 * 所以**同一遗物**（同 origin）重复命中是刷新时长、不会叠出多个点燃。
 */
export class RelicHook_Ignite extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim) || !victim.modifiers) return false;

        const kv = this.getKV() ?? {};
        if (!rollPct(kvNum(kv, 'chance', 0))) return false;
        const dotMod = pickDotMod(kv, IGNITE_DOT_MODS, MOD_IGNITE_RARE);
        victim.modifiers.AddModifier(dotMod, host, IGNITE_SEC, undefined, this.origin);
        return false;
    }
}

// ---------------------------------------------------------------- poison 剧毒

/**
 * 剧毒（`poison`）。`kv = { dps, dotMod }`（蓝 4 / 黄 8 / 红 14）
 *
 * 文案：`普攻使目标中毒：每层每秒 dps 点魔法伤害（上限 5 层，持续 4 秒）`。
 *
 * 实现：**每次命中施加一层**（不掷概率）→ `AddModifier(kv.dotMod, host, 4)`。
 * 行的 `stack_mode = renew`，所以每次命中都是**独立实例**（各自计时、各自的每秒伤害）。
 * 层数上限由本钩子自己判（`getAll()` 按 id 数实例，`>= 5` 就不再施加）。
 *
 * 坑：**别用 `getStackCount()`** —— `renew` 型是 N 个实例，`getStackCount` 会把它们的
 * `stackCount`（各为 1）相加但 `getAll()` 才是"有几层"的准确口径（也与设计文案一致）。
 */
export class RelicHook_Poison extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim) || !victim.modifiers) return false;

        const dotMod = pickDotMod(this.getKV(), POISON_DOT_MODS, MOD_POISON_RARE);
        const layers = victim.modifiers.getAll().filter((m: Modifier) => m.getId() === dotMod).length;
        if (layers >= POISON_MAX_LAYERS) return false;

        victim.modifiers.AddModifier(dotMod, host, POISON_SEC, undefined, this.origin);
        return false;
    }
}

// ---------------------------------------------------------------- frost 冰霜

/**
 * 冰霜（`frost`）。`kv = { chance, slow }`（蓝 25%/25、黄 40%/35、红 55%/45）
 *
 * 文案：`普攻有 chance% 概率使目标减速 slow%，持续 2 秒`。
 *
 * 实现：概率命中 → 施加 `MOD_RELIC_SLOW`（300），`kv.slow` 传**负数像素/秒**：
 * `-目标当前移速 × slow% / 100`（移速 base = 300，所以 30% = -90）。
 * 坑：移速是**像素/秒**，不是百分比 —— 传 `-30` 那种"百分数"只会让敌人几乎不动不了。
 */
export class RelicHook_Frost extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim) || !victim.modifiers) return false;

        const kv = this.getKV() ?? {};
        if (!rollPct(kvNum(kv, 'chance', 0))) return false;
        const slow = slowValue(victim, kvNum(kv, 'slow', 0));
        if (slow === 0) return false;
        victim.modifiers.AddModifier(MOD_RELIC_SLOW, host, FROST_SEC, { slow }, this.origin);
        return false;
    }
}

// ---------------------------------------------------------------- armorBreak 破甲

/**
 * 破甲（`armorBreak`）。`kv = { armor }`（蓝 2 / 黄 3 / 红 5）
 *
 * 文案：`普攻使目标护甲 -armor（持续 2 秒，可叠 3 层）`。
 *
 * 实现：命中即施加 `MOD_RELIC_ARMOR_BREAK`（303），`kv.armor` 传**负值**（`-Math.abs(armor)`）。
 * 层数与上限（3 层）由 303 行的 `stack_mode = stack` + `max_stack = 3` 负责，代码不重复实现。
 * 坑：护甲 base = 0，所以减甲**必须用固定值**（`add`），`percent` 打在 base=0 上恒为 0。
 */
export class RelicHook_ArmorBreak extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim) || !victim.modifiers) return false;

        const armor = Math.abs(kvNum(this.getKV(), 'armor', 0));
        if (!(armor > 0)) return false;
        victim.modifiers.AddModifier(MOD_RELIC_ARMOR_BREAK, host, ARMOR_BREAK_SEC, { armor: -armor }, this.origin);
        return false;
    }
}

// ---------------------------------------------------------------- splash 溅射

/**
 * 溅射（`splash`）。`kv = { pct, radius }`（蓝 20%/120、黄 30%/140、红 45%/160）
 *
 * 文案：`普攻命中后，对目标 radius 像素内敌人造成 攻击力 pct% 的伤害`。
 *
 * 实现：以**命中目标**为圆心（不是英雄）、半径 `radius` **像素**，对范围内的敌人各追加
 * `攻击力 × pct/100` 物理伤害，**排除目标本身**（它已经被那一发普攻打过了，不重复）。
 * 坑：半径是像素（设计表里也是像素），不要再乘 `meters()`。
 */
export class RelicHook_Splash extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim) || !victim.position) return false;

        const kv = this.getKV() ?? {};
        const dmg = atkPct(host, kvNum(kv, 'pct', 0));
        const radius = kvNum(kv, 'radius', 0);
        if (!(dmg > 0) || !(radius > 0)) return false;

        const exclude = new Set<number>();
        if (victim.uid !== undefined) exclude.add(victim.uid);
        aoe(ctx, victim, radius, (t) => deal(ctx, host, t, dmg, DamageType.Physical), exclude);
        return false;
    }
}

// ---------------------------------------------------------------- chain 连锁

/**
 * 连锁（`chain`）。`kv = { jumps, pct }`（蓝 1/40、黄 2/50、红 3/60）
 *
 * 文案：`普攻命中后弹射 jumps 次，每次造成 攻击力 pct% 的伤害`。
 *
 * 实现：从命中目标出发，每次找**当前落点**附近（`CHAIN_RANGE_PX` = 260 像素，
 * 与 `ShopSkillModifiers` 的弹射同一口径）最近的未命中敌人，各追加一段魔法伤害。
 * 坑：`visited` 必须有（否则两个敌人之间来回弹）；每次弹射的伤害是**同一档定值**，
 * 不减衰（文案没写衰减）。
 */
export class RelicHook_Chain extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim)) return false;

        const kv = this.getKV() ?? {};
        const jumps = Math.floor(kvNum(kv, 'jumps', 0));
        const dmg = atkPct(host, kvNum(kv, 'pct', 0));
        if (jumps <= 0 || !(dmg > 0)) return false;

        chain(ctx, victim, jumps, CHAIN_RANGE_PX, (t) => deal(ctx, host, t, dmg, DamageType.Magical));
        return false;
    }
}

// ---------------------------------------------------------------- pierce 穿透

/**
 * 穿透（`pierce`）。`kv = { extra }`（蓝 1 / 黄 2 / 红 3）
 *
 * 文案：`普攻额外命中 extra 个敌人（各造成 60% 伤害）`。
 *
 * 实现：照抄 `ShopSkillModifiers.Modifier_PiercingBolt` 的几何算法 ——
 * 把敌人投影到「英雄 → 中弹者」这条射线上，只取**比中弹者更远**
 * （`proj > len`）且在锥角内（`|perp| <= proj × PIERCE_SPREAD`）的，按投影距离从近到远取 `extra` 个，
 * 各追加 `攻击力 × 60%` 物理伤害（文案固定 60%，不吃 kv）。
 * 坑：中弹者与英雄重合时没有可用方向 → 直接放弃（与模板一致）；`spread` 写死为模板口径。
 */
export class RelicHook_Pierce extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim)) return false;

        const extra = Math.floor(kvNum(this.getKV(), 'extra', 0));
        const dmg = atkPct(host, PIERCE_PCT);
        if (extra <= 0 || !(dmg > 0)) return false;

        const me = host.position ?? { x: 0, y: 0 };
        const dx = (victim.position?.x ?? 0) - me.x;
        const dy = (victim.position?.y ?? 0) - me.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-3) return false;                 // 与目标重合，没有可用方向
        const ux = dx / len;
        const uy = dy / len;

        const picked: { e: any; proj: number }[] = [];
        for (const e of enemies(ctx, host)) {
            if (e === victim) continue;
            const ex = (e.position?.x ?? 0) - me.x;
            const ey = (e.position?.y ?? 0) - me.y;
            const proj = ex * ux + ey * uy;
            const perp = Math.abs(-ex * uy + ey * ux);
            if (proj > len && perp <= proj * PIERCE_SPREAD) picked.push({ e, proj });
        }
        picked.sort((a, b) => a.proj - b.proj);

        for (const p of picked.slice(0, extra)) {
            deal(ctx, host, p.e, dmg, DamageType.Physical);
        }
        return false;
    }
}

// ---------------------------------------------------------------- execute 斩杀

/**
 * 斩杀（`execute`）。`kv = { threshold, mult }`（蓝 15%/1.2、黄 25%/1.3、红 35%/1.5）
 *
 * 文案：`目标生命低于 threshold% 时，普攻伤害 ×mult`。
 *
 * ⚠ **关键时序**（与 `Modifier_FirstStrike` 同一个坑）：
 * `on_attack_landed` 是在 `ApplyDamage` **之后**派发的（`Entity.resolveAttackHit`），
 * 那时目标已经掉血了 —— 在那里判「低于 threshold%」会把"本来就在血线下的目标"与
 * "被这一发打下去的残血目标"混在一起（明明不满足条件也触发）。
 * 所以走两段：`on_attack_start`（伤害之前）按 `target.uid` 记快照 → `on_attack_landed` 消费后删除。
 *
 * 「伤害 ×mult」= 追加 `攻击力 × (mult - 1)` 的**独立结算**伤害（物理），
 * 与普攻本身分开 roll 暴击、分开吃护甲（见文件头口径）。
 * 快照按 uid 存（对象池复用会认错实体，别存对象引用）。
 */
export class RelicHook_Execute extends Modifier {
    /** 「这一发打的是残血目标（< threshold%）」的目标 uid 集合 */
    private lowHpTargets = new Set<number>();

    OnBattleEvent(eventName: string, event: any): boolean {
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;

        if (eventName === 'on_attack_start') {
            const t = event?.target as any;
            if (t?.uid === undefined) return false;
            const max = t.getMaxHp?.() ?? 0;
            const threshold = kvNum(this.getKV(), 'threshold', 0);
            const hpPct = max > 0 ? (t.hp ?? 0) / max * 100 : 100;
            if (threshold > 0 && hpPct < threshold) this.lowHpTargets.add(t.uid);
            else this.lowHpTargets.delete(t.uid);
            return false;
        }
        if (eventName !== 'on_attack_landed') return false;

        const victim = event?.target as any;
        if (victim?.uid === undefined || !this.lowHpTargets.has(victim.uid)) return false;
        this.lowHpTargets.delete(victim.uid);
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim)) return false;

        const mult = kvNum(this.getKV(), 'mult', 1);
        const dmg = atkMul(host, mult - 1);
        deal(ctx, host, victim, dmg, DamageType.Physical);
        return false;
    }
}

// ---------------------------------------------------------------- firstStrike 首击

/**
 * 首击（`firstStrike`）。`kv = { pct }`（蓝 25 / 黄 40 / 红 60）
 *
 * 文案：`对满血敌人普攻伤害 +pct%`。
 *
 * ⚠ 与 `execute` 同一个时序坑：`on_attack_landed` 时目标已经掉血，
 * 「是满血吗」必须在该发伤害**之前**的 `on_attack_start` 里判，快照按 ud 存。
 * 命中后追加 `攻击力 × pct/100` 物理伤害。
 */
export class RelicHook_FirstStrike extends Modifier {
    /** 「这一发打的是满血目标」的目标 uid 集合 */
    private fullHpTargets = new Set<number>();

    OnBattleEvent(eventName: string, event: any): boolean {
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;

        if (eventName === 'on_attack_start') {
            const t = event?.target as any;
            if (t?.uid === undefined) return false;
            const max = t.getMaxHp?.() ?? 0;
            if (max > 0 && (t.hp ?? 0) >= max) this.fullHpTargets.add(t.uid);
            else this.fullHpTargets.delete(t.uid);
            return false;
        }
        if (eventName !== 'on_attack_landed') return false;

        const victim = event?.target as any;
        if (victim?.uid === undefined || !this.fullHpTargets.has(victim.uid)) return false;
        this.fullHpTargets.delete(victim.uid);
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim)) return false;

        const dmg = atkPct(host, kvNum(this.getKV(), 'pct', 0));
        deal(ctx, host, victim, dmg, DamageType.Physical);
        return false;
    }
}

// ---------------------------------------------------------------- critEcho 暴击回响

/**
 * 暴击回响（`critEcho`）。`kv = { pct, radius }`（蓝 30%/120、黄 50%/130、红 80%/140）
 *
 * 文案：`暴击时对目标 radius 像素内敌人造成 pct% 伤害`。
 *
 * ⚠ **必须挂 `on_deal_damage`**：`on_attack_landed` 的载荷里**没有 `isCrit`**
 * （`Entity.resolveAttackHit` 只发 `{attacker,target,damage,damageType}`），
 * 只有 `on_deal_damage`（`DamagePipeline` 第 7 阶段的 `dmgEvent`）带 `isCrit`；
 * 而且它派发给的是**伤害来源**（`source.modifiers`），所以判 `event.source === host`。
 *
 * 伤害量用 `event.finalDamage`（本次实际打出的伤害）× `pct/100`，圆心是**受击目标**（含它自己）。
 * 坑：`on_deal_damage` 对**每一次**伤害都派发（含 DoT、含本钩子自己打出的追加段）→
 * **必须用 busy 标志防递归**（回响伤害自己也可能 roll 出暴击）。
 */
export class RelicHook_CritEcho extends Modifier {
    /** 防递归：本钩子自己打出的范围伤害会再次派发 on_deal_damage */
    private busy = false;

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_deal_damage' || this.busy) return false;
        const host = this.target as any;
        if (!host || event?.source !== host) return false;
        if (!event?.isCrit) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !victim?.position) return false;

        const kv = this.getKV() ?? {};
        const pct = kvNum(kv, 'pct', 0);
        const radius = kvNum(kv, 'radius', 0);
        const dmg = Math.round(Number(event?.finalDamage ?? 0) * pct / 100);
        if (!(dmg > 0) || !(radius > 0)) return false;

        this.busy = true;
        try {
            aoe(ctx, victim, radius, (t) => deal(ctx, host, t, dmg, DamageType.Magical));
        } finally {
            this.busy = false;
        }
        return false;
    }
}

// ---------------------------------------------------------------- atkSpeedStack 连击

/**
 * 连击（`atkSpeedStack`）。`kv = { per, max }`（蓝 2%/6 层、黄 3%/10、红 4%/15）
 *
 * 文案：`普攻命中叠 1 层：攻击速度 +per%（上限 max 层，持续 3 秒）`。
 *
 * 实现：自己维护层数 + 一个自计时时钟（`OnTick` 累加，**不用** `modifiers.cd`，那是死代码）。
 * 每次命中：距上次命中超过 3 秒 → 层数先归零（"3 秒内没再命中就归零"），再 +1（上限 `max`）；
 * 然后用共享模板 1000 重放 `[4 攻速, 层数 × per, 'add']`、`duration = 3`——
 * 同 origin 重放会替换旧实例，所以永远只有一份贡献，到期自动摘掉（不需要自己清理）。
 * 攻速是**缩放型属性**（配置口径 100 = 1.0 次/秒），`per = 3` 就是 +0.03，用 `add`。
 */
export class RelicHook_AtkSpeedStack extends Modifier {
    private stacks = 0;
    /** 自计时时钟（秒）——用于判"3 秒内有没有再命中" */
    private clock = 0;
    private lastStackAt = -Infinity;

    OnTick(dt: number): void {
        this.clock += dt;
    }

    /** 当前层数（调试/断言用） */
    getStacks(): number { return this.stacks; }

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        if (!alive(host)) return false;

        const kv = this.getKV() ?? {};
        const per = kvNum(kv, 'per', 0);
        const max = Math.floor(kvNum(kv, 'max', 0));
        if (!(per > 0) || max <= 0) return false;

        if (this.clock - this.lastStackAt > HIT_STACK_SEC) this.stacks = 0;
        this.stacks = Math.min(max, this.stacks + 1);
        this.lastStackAt = this.clock;

        reapplyAttrs(host, this, [[AttributeType.AtkSpeed, this.stacks * per, 'add']], HIT_STACK_SEC);
        return false;
    }
}

// ---------------------------------------------------------------- charge 蓄力

/**
 * 蓄力（`charge`）。`kv = { interval, mult }`（蓝 8s/2.0、黄 6s/2.5、红 5s/3.0）
 *
 * 文案：`每 interval 秒，下一次普攻造成 mult 倍伤害`。
 *
 * 实现：`OnTick` 自己计时（`modifiers.cd` 是死代码），攒满 `interval` 秒进入"充能"态
 * （**上限 1 层**，充能期间不再累积）；`on_attack_landed` 时若处于充能态 →
 * 追加 `攻击力 × (mult - 1)` 物理伤害并清掉充能态。
 *
 * 设计表的 `trig` 写的是 `on_attack_start`：那只是"这一次普攻"的语义锚点，
 * 真正的落点在命中事件上（远程普攻要等弹道飞到），否则"打空了也吃掉充能"。
 */
export class RelicHook_Charge extends Modifier {
    private timer = 0;
    private charged = false;

    OnTick(dt: number): void {
        if (!alive(this.target)) return;
        if (this.charged) return;                       // 已充能：不再累积（上限 1 层）
        const interval = kvNum(this.getKV(), 'interval', 0);
        if (!(interval > 0)) return;
        this.timer += dt;
        if (this.timer >= interval) {
            this.timer = 0;
            this.charged = true;
        }
    }

    /** 是否处于充能态（调试/断言用） */
    isCharged(): boolean { return this.charged; }

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        if (!this.charged) return false;

        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim)) return false;

        this.charged = false;
        const mult = kvNum(this.getKV(), 'mult', 1);
        deal(ctx, host, victim, atkMul(host, mult - 1), DamageType.Physical);
        return false;
    }
}

/* =====================================================================================
 * ============ B 组：受击 / 生存类（on_take_damage / on_block_damage / on_tick）============
 * ===================================================================================== */

// ---------------------------------------------------------------- thorns 荆棘

/**
 * 荆棘（`thorns`）。`kv = { pct }`（蓝 15 / 黄 25 / 红 40）
 *
 * 文案：`受到伤害后，向攻击者反弹 pct% 伤害`。
 *
 * 实现：`on_take_damage`（宿主是受击者）→ 对攻击者（`event._attacker ?? event.source`）
 * 造成 `本次伤害(finalDamage) × pct/100` 魔法伤害。
 *
 * 坑（两道防互怼）：
 *   ① `event.reflected` 为真直接返回 —— 那本身就是一条反射伤害，再反射会两边无限弹；
 *   ② 自己打出的这段带 `{ isReflected: true }` 标记 —— 对面的荆棘看到标记也会跳过，
 *      这是"单边结束"的关键（只靠 ① 只能挡住一轮）。
 *   另外 busy 标志防本类的重入，攻击者是自己时直接跳过（自伤不反弹）。
 */
export class RelicHook_Thorns extends Modifier {
    private busy = false;

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_take_damage' || this.busy) return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;
        if (event?.reflected) return false;                    // 反射伤害不再反射（防互怼）
        const attacker = (event?._attacker ?? event?.source) as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(attacker) || attacker === host) return false;

        const pct = kvNum(this.getKV(), 'pct', 0);
        const dmg = Math.round(Number(event?.finalDamage ?? 0) * pct / 100);
        if (!(dmg > 0)) return false;

        this.busy = true;
        try {
            ctx.damagePipeline.ApplyDamage(attacker, host, dmg, DamageType.Magical, { isReflected: true });
        } finally {
            this.busy = false;
        }
        return false;
    }
}

// ---------------------------------------------------------------- block 格挡

/**
 * 格挡（`block`）。`kv = { value }`（蓝 10 / 黄 20 / 红 35）
 *
 * 文案：`每次受到攻击格挡 value 点伤害`。
 *
 * 实现：本作没有"格挡"字段 —— 格挡 = `DamagePipeline` 第 3 阶段那个可变的 `blocked`
 * （`damage -= event.blocked`）。所以在 `on_block_damage` 里：
 * `event.blocked += min(value, event.damage - event.blocked)`（不超额、不把伤害挡成负数）。
 *
 * 口径说明：`on_block_damage` 对**每一条**伤害实例都会派发（DoT 的一跳也算），
 * 事件里没有"这是不是普攻"的标记，所以本钩子对 DoT 同样生效（文案写的是"受到攻击"，
 * 落地到引擎能区分的最小单位 —— 这是刻意选择，不为它改管线）。
 */
export class RelicHook_Block extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_block_damage') return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;

        const value = kvNum(this.getKV(), 'value', 0);
        if (!(value > 0)) return false;
        const blocked = Number(event?.blocked ?? 0);
        const remain = Number(event?.damage ?? 0) - blocked;
        if (!(remain > 0)) return false;

        event.blocked = blocked + Math.min(value, remain);
        return false;
    }
}

// ---------------------------------------------------------------- shieldCharge 护盾充能

/**
 * 护盾充能（`shieldCharge`）。`kv = { cd, value }`（蓝 8s/20、黄 6s/35、红 5s/60）
 *
 * 文案：`每 cd 秒获得一次 value 点伤害格挡`。
 *
 * 实现：`OnTick` 自己计时（`modifiers.cd` 是死代码），攒满 `cd` 秒 → **1 层护盾**
 * （上限 1 层，已有护盾时不累积）；受击时（`on_block_damage`）把护盾按
 * `min(护盾值, 剩余伤害)` 挡掉并**清 0**。
 *
 * 坑：剩余伤害为 0（已被别的遗物挡光）时**不消耗**护盾 —— 文案承诺的是"获得一次格挡"，
 * 不该被一次已经为 0 的伤害吃掉。
 */
export class RelicHook_ShieldCharge extends Modifier {
    private timer = 0;
    private shield = 0;

    OnTick(dt: number): void {
        const host = this.target as any;
        if (!alive(host)) return;
        if (this.shield > 0) return;                 // 上限 1 层：已有护盾就不再累积
        const cd = kvNum(this.getKV(), 'cd', 0);
        if (!(cd > 0)) return;
        this.timer += dt;
        if (this.timer < cd) return;
        this.timer = 0;
        this.shield = Math.max(0, kvNum(this.getKV(), 'value', 0));
    }

    /** 当前护盾值（调试/断言用） */
    getShield(): number { return this.shield; }

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_block_damage') return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;

        const blocked = Number(event?.blocked ?? 0);
        const remain = Number(event?.damage ?? 0) - blocked;
        if (!(remain > 0) || this.shield <= 0) return false;

        const used = Math.min(this.shield, remain);
        event.blocked = blocked + used;
        this.shield = 0;
        return false;
    }
}

// ---------------------------------------------------------------- evadeCounter 闪避反击

/**
 * 闪避反击（`evadeCounter`）。`kv = { pct }`（蓝 100 / 黄 150 / 红 200）
 *
 * 文案：`闪避成功后对攻击者造成 攻击力 pct% 的伤害`。
 *
 * 实现：`on_evade`（2026-10 新派发的事件，载荷 `{attacker, target, dodger}`，
 * 派发给**闪避者**，与 `on_take_damage` 同口径）→ 对 `event.attacker` 追加
 * `攻击力 × pct/100` 物理伤害。
 * 坑：判 `dodger`（缺省回落 `target`），别判 `event.source`（那个字段在闪避事件里不存在）。
 */
export class RelicHook_EvadeCounter extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_evade') return false;
        const host = this.target as any;
        if (!host) return false;
        const dodger = (event?.dodger ?? event?.target) as any;
        if (dodger !== host) return false;

        const attacker = (event?.attacker ?? event?.source) as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(attacker) || attacker === host) return false;

        const dmg = atkPct(host, kvNum(this.getKV(), 'pct', 0));
        deal(ctx, host, attacker, dmg, DamageType.Physical);
        return false;
    }
}

// ---------------------------------------------------------------- lowHpGuard 背水

/**
 * 背水（`lowHpGuard`）。`kv = { threshold, pct }`（蓝 35%/15%、黄 35%/25%、红 40%/40%）
 *
 * 文案：`生命低于 threshold% 时，受到的伤害降低 pct%`。
 *
 * 实现：设计表的 `trig` 写的是 `on_take_damage`，但"减少已到伤害"**只有
 * `on_block_damage` 能写**（那是管线上唯一能改伤害的位置；`on_take_damage` 时血已经扣了）。
 * 所以落在 `on_block_damage`：血线满足 → `event.blocked += 剩余伤害 × pct/100`。
 * 坑：血线用**当前**生命（扣血前）判 —— 这正是"受到的伤害降低"该有的语义。
 */
export class RelicHook_LowHpGuard extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_block_damage') return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;

        const kv = this.getKV() ?? {};
        const threshold = kvNum(kv, 'threshold', 0);
        const pct = kvNum(kv, 'pct', 0);
        if (!(threshold > 0) || !(pct > 0)) return false;

        const max = host.getMaxHp?.() ?? 0;
        if (!(max > 0)) return false;
        if ((host.hp ?? 0) / max * 100 >= threshold) return false;

        const blocked = Number(event?.blocked ?? 0);
        const remain = Number(event?.damage ?? 0) - blocked;
        if (!(remain > 0)) return false;

        event.blocked = blocked + remain * pct / 100;
        return false;
    }
}

// ---------------------------------------------------------------- nearDeath 濒死守护

/**
 * 濒死守护（`nearDeath`）。`kv = { cd, dur }`（蓝 60s/1.5s、黄 45s/1.5s、红 30s/2s）
 *
 * 文案：`每 cd 秒一次：生命低于 25% 时获得 dur 秒无敌`。
 *
 * 实现：落在 `on_block_damage`（唯一能"救下这一击"的位置）：若
 * **这一击打完后生命会低于 25%**（`hp - 剩余伤害 < 最大生命 × 25%`）且自己的冷却已就绪
 * → 全量挡下这一击 + 施加 `MOD_INVULNERABLE`（持续 `dur` 秒）+ 进入 `cd` 秒冷却。
 *
 * 坑：冷却**自己 `OnTick` 计时**（`modifiers.cd` 是死代码）；无敌必须在"挡下之后"施加
 * （此时宿主还不是无敌状态，`AddModifier` 不会被免疫检查拦住）。
 */
export class RelicHook_NearDeath extends Modifier {
    private cdLeft = 0;

    OnTick(dt: number): void {
        if (this.cdLeft > 0) this.cdLeft = Math.max(0, this.cdLeft - dt);
    }

    /** 剩余冷却（秒，调试/断言用） */
    getCdLeft(): number { return this.cdLeft; }

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_block_damage') return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;
        if (this.cdLeft > 0) return false;

        const hp = host.hp ?? 0;
        const max = host.getMaxHp?.() ?? 0;
        if (!(hp > 0) || !(max > 0)) return false;

        const blocked = Number(event?.blocked ?? 0);
        const remain = Number(event?.damage ?? 0) - blocked;
        if (!(remain > 0)) return false;
        if (hp - remain >= max * NEAR_DEATH_HP_PCT / 100) return false;   // 打完后仍在 25% 之上

        event.blocked = blocked + remain;                 // 全量挡下这一击
        this.cdLeft = Math.max(0, kvNum(this.getKV(), 'cd', 0));
        const dur = kvNum(this.getKV(), 'dur', 0);
        if (dur > 0) host.modifiers?.AddModifier(MOD_INVULNERABLE, host, dur);
        return false;
    }
}

// ---------------------------------------------------------------- lastStand 不屈

/**
 * 不屈（`lastStand`）。`kv = { count }`（蓝 1 / 黄 1 / 红 2）
 *
 * 文案：`本局受到致命伤害时以 1 点生命存活（count 次）`。
 *
 * 实现：`on_block_damage` → 若**这一击会致死**（`剩余伤害 >= 当前生命`）且剩余次数 > 0
 * → 全量挡下 + 把生命设为 1（`host.ChangeHp(1 - hp)`）+ 次数 -1。
 * 次数存在**实例**上（`OnCreated` 从 kv 读初值）——遗物同一 origin 不会重建实例，所以"本局"成立。
 *
 * 口径取舍（写清楚免得被当成 bug）：挡下之后生命本来会**停在扣血前的值**，
 * 但文案承诺的是「以 **1 点**生命存活」，所以这里按要求把生命显式压到 1 ——
 * 语义上完全对齐文案，代价是"残血触发"比"满血触发"收益更小（满血时反而被压到 1）。
 * 若要改成"只保不死"，把 `ChangeHp(1 - hp)` 去掉即可（改口径只改这一行）。
 */
export class RelicHook_LastStand extends Modifier {
    /** 本局剩余次数（-1 = 还没初始化） */
    private remaining = -1;

    OnCreated(kv?: Record<string, any>): void {
        super.OnCreated(kv);
        if (this.remaining < 0) this.remaining = Math.max(0, Math.floor(kvNum(this.getKV(), 'count', 0)));
    }

    /** 本局剩余次数（调试/断言用） */
    getRemaining(): number { return Math.max(0, this.remaining); }

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_block_damage') return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;
        if (this.remaining <= 0) return false;

        const hp = host.hp ?? 0;
        if (!(hp > 0)) return false;
        const blocked = Number(event?.blocked ?? 0);
        const remain = Number(event?.damage ?? 0) - blocked;
        if (!(remain > 0)) return false;
        if (remain < hp) return false;                    // 打不死，不消耗次数

        event.blocked = blocked + remain;                 // 全量挡下
        this.remaining--;
        host.ChangeHp(1 - hp);                            // 文案：「以 1 点生命存活」
        return false;
    }
}

// ---------------------------------------------------------------- takeHeal 坚韧

/**
 * 坚韧（`takeHeal`）。`kv = { value }`（蓝 3 / 黄 6 / 红 12）
 *
 * 文案：`每次受到伤害后回复 value 点生命`。
 *
 * 实现：`on_take_damage`（宿主是受击者）→ `host.Heal(value, host)`。
 * 坑：这里**不能**用 `on_block_damage` 提前回血 —— 文案说的是"受到伤害**后**"；
 * 另外 `on_take_damage` 对 DoT 的每一跳也派发，所以"毒伤也会触发回血"是刻意的（文案即为每一次）。
 */
export class RelicHook_TakeHeal extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_take_damage') return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;
        if (!alive(host)) return false;

        const value = kvNum(this.getKV(), 'value', 0);
        if (!(value > 0)) return false;
        host.Heal?.(value, host);
        return false;
    }
}

// ---------------------------------------------------------------- immolate 灼烧光环

/**
 * 灼烧光环（`immolate`）。`kv = { value, radius }`（蓝 8/140、黄 16/150、红 30/160）
 *
 * 文案：`每秒对周围 radius 像素内的敌人造成 value 点魔法伤害`。
 *
 * 实现：`OnTick` 每秒扫一次 `radius` 像素（**像素**，不是米）内的敌人，各追加 `value` 点魔法伤害。
 * 坑：一帧可能跨多个间隔（掉帧/顿帧）→ `while` 补齐并设上限防卡死（与 `Modifier_Ignite` 同款）。
 */
export class RelicHook_Immolate extends Modifier {
    private timer = 0;

    OnTick(dt: number): void {
        const host = this.target as any;
        if (!alive(host)) return;
        const ctx = hostCtx(host);
        if (!ctx) return;

        const kv = this.getKV() ?? {};
        const value = kvNum(kv, 'value', 0);
        const radius = kvNum(kv, 'radius', 0);
        if (!(value > 0) || !(radius > 0)) return;

        this.timer += dt;
        let guard = 0;
        while (this.timer >= AURA_INTERVAL && guard++ < 8) {
            this.timer -= AURA_INTERVAL;
            if (!alive(host)) return;
            aoe(ctx, host, radius, (t) => deal(ctx, host, t, value, DamageType.Magical));
        }
    }
}

// ---------------------------------------------------------------- takeStackAtk 激怒

/**
 * 激怒（`takeStackAtk`）。`kv = { per, max }`（蓝 1%/10、黄 1.5%/20、红 2%/30）
 *
 * 文案：`每次受到伤害：攻击力 +per%（上限 max 层，本局永久）`。
 *
 * 实现：`on_take_damage` → 层数 +1（上限 `max`）→ 用共享模板 1000 重放
 * `[3 攻击力, 层数 × per, 'percent']`、`duration = -1`（**只有 -1 是永久**）。
 * 坑：叠加方式是 `percent`（对基础属性的百分比，配置值是**百分数**：`per = 1` → +1%/层），
 * 不要用 `multiply`（复利，全项目禁用）；同 origin 重放会替换旧实例，不会叠出多份。
 */
export class RelicHook_TakeStackAtk extends Modifier {
    private stacks = 0;

    /** 当前层数（调试/断言用） */
    getStacks(): number { return this.stacks; }

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_take_damage') return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;
        if (!alive(host)) return false;

        const kv = this.getKV() ?? {};
        const per = kvNum(kv, 'per', 0);
        const max = Math.floor(kvNum(kv, 'max', 0));
        if (!(per > 0) || max <= 0) return false;
        if (this.stacks >= max) return false;             // 满层：不再重放（贡献已在那里）

        this.stacks++;
        reapplyAttrs(host, this, [[AttributeType.Atk, this.stacks * per, 'percent']], -1);
        return false;
    }
}

// ---------------------------------------------------------------- magicBarrier 法术屏障

/**
 * 法术屏障（`magicBarrier`）。`kv = { cd, pct }`（蓝 25s/50%、黄 20s/100%、红 15s/100%）
 *
 * 文案：`每 cd 秒阻挡一次魔法伤害的 pct%`。
 *
 * 实现：`OnTick` 自计时攒"屏障"（上限 1 次）；`on_block_damage` 时若
 * `event.damageType !== DamageType.Physical`（法术/纯粹都算"非物理"）且屏障就绪
 * → `event.blocked += 剩余伤害 × pct/100`，消耗屏障。
 * 坑：那半句"每 cd 秒"只能自己计时（`modifiers.cd` 是死代码）；剩余伤害为 0 时不消耗屏障。
 */
export class RelicHook_MagicBarrier extends Modifier {
    private timer = 0;
    private barrier = false;

    OnTick(dt: number): void {
        if (!alive(this.target)) return;
        if (this.barrier) return;                         // 上限 1 次
        const cd = kvNum(this.getKV(), 'cd', 0);
        if (!(cd > 0)) return;
        this.timer += dt;
        if (this.timer < cd) return;
        this.timer = 0;
        this.barrier = true;
    }

    /** 屏障是否就绪（调试/断言用） */
    isReadyBarrier(): boolean { return this.barrier; }

    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_block_damage') return false;
        const host = this.target as any;
        if (!host || event?.target !== host) return false;
        if (!this.barrier) return false;
        if (event?.damageType === DamageType.Physical) return false;

        const blocked = Number(event?.blocked ?? 0);
        const remain = Number(event?.damage ?? 0) - blocked;
        if (!(remain > 0)) return false;

        const pct = kvNum(this.getKV(), 'pct', 0);
        if (!(pct > 0)) return false;
        event.blocked = blocked + remain * pct / 100;
        this.barrier = false;
        return false;
    }
}

// ---------------------------------------------------------------- regenTick 复苏

/**
 * 复苏（`regenTick`）。`kv = { interval, pct }`（蓝 10s/2%、黄 8s/3%、红 6s/5%）
 *
 * 文案：`每 interval 秒回复 pct% 最大生命`。
 *
 * 实现：`OnTick` 自己计时，攒满 `interval` 秒 → `host.Heal(最大生命 × pct/100)`。
 * 坑：`pct` 是百分数（5 → 5%），`/100` 别忘；治疗走 `Heal`（会发 `on_heal` 总线，HUD 才动）。
 */
export class RelicHook_RegenTick extends Modifier {
    private timer = 0;

    OnTick(dt: number): void {
        const host = this.target as any;
        if (!alive(host)) return;
        const kv = this.getKV() ?? {};
        const interval = kvNum(kv, 'interval', 0);
        const pct = kvNum(kv, 'pct', 0);
        if (!(interval > 0) || !(pct > 0)) return;

        this.timer += dt;
        if (this.timer < interval) return;
        this.timer = 0;

        const max = host.getMaxHp?.() ?? 0;
        if (!(max > 0)) return;
        host.Heal?.(max * pct / 100, host);
    }
}

/* =====================================================================================
 * ============ C 组：击杀类（`on_kill` **只发总线**，必须自行订阅并在 OnDestroy 里摘）============
 * ===================================================================================== */

// ---------------------------------------------------------------- killHeal 屠戮回血

/**
 * 屠戮回血（`killHeal`）。`kv = { value }`（蓝 8 / 黄 15 / 红 25）
 *
 * 文案：`击杀敌人回复 value 点生命`。挂在 `bus.on(OnKill)` 上（`event.killer === host`）。
 * 坑：`on_kill` 不派发给 Modifier，声明式配置永远不触发 → 必须订阅（基类负责摘订阅）。
 */
export class RelicHook_KillHeal extends RelicBusHook {
    protected getBusEventName(): string { return BattleEvents.OnKill; }

    protected handleBusEvent(event: any): void {
        const host = this.target as any;
        if (!host || event?.killer !== host) return;
        const value = kvNum(this.getKV(), 'value', 0);
        if (!(value > 0) || !alive(host)) return;
        host.Heal?.(value, host);
    }
}

// ---------------------------------------------------------------- killMana 汲取

/**
 * 汲取（`killMana`）。`kv = { value }`（蓝 5 / 黄 10 / 红 20）
 *
 * 文案：`击杀敌人回复 value 点魔法`。
 * 坑：魔法**必须钳在上限内**（`Math.min(getMaxMana(), mana + value)`）—— `mana` 是裸字段，
 * 直接加会超出上限，HUD 会出现 120/100 这种脏数据。
 */
export class RelicHook_KillMana extends RelicBusHook {
    protected getBusEventName(): string { return BattleEvents.OnKill; }

    protected handleBusEvent(event: any): void {
        const host = this.target as any;
        if (!host || event?.killer !== host) return;
        const value = kvNum(this.getKV(), 'value', 0);
        if (!(value > 0) || !alive(host)) return;
        host.mana = Math.min(host.getMaxMana?.() ?? 0, (host.mana ?? 0) + value);
    }
}

// ---------------------------------------------------------------- killGold 悬赏

/**
 * 悬赏（`killGold`）。`kv = { value }`（蓝 1 / 黄 2 / 红 4）
 *
 * 文案：`每击杀 1 名敌人额外获得 value 金币`。
 * 坑：金币必须走 `addGold`（改 `host.gold` **并且**发 `on_gold_gained`），
 * 只改字段 HUD 不会刷新（见 `addGold` 的说明）。
 */
export class RelicHook_KillGold extends RelicBusHook {
    protected getBusEventName(): string { return BattleEvents.OnKill; }

    protected handleBusEvent(event: any): void {
        const host = this.target as any;
        if (!host || event?.killer !== host) return;
        addGold(host, kvNum(this.getKV(), 'value', 0), this);
    }
}

// ---------------------------------------------------------------- killExpFlat 领悟

/**
 * 领悟（`killExpFlat`，类名 `RelicHook_KillExp`）。`kv = { exp }`（蓝 3 / 黄 6 / 红 12）
 *
 * 文案：`每击杀 1 名敌人额外获得 exp 点经验`。
 *
 * 实现：只 `publish(BattleEvents.OnExpGained, { target, amount, source })` ——
 * 局内经验由场景层折算（`Scene_Game_Stage.addBattleExp`），战斗层不直接改经验。
 */
export class RelicHook_KillExp extends RelicBusHook {
    protected getBusEventName(): string { return BattleEvents.OnKill; }

    protected handleBusEvent(event: any): void {
        const host = this.target as any;
        if (!host || event?.killer !== host) return;
        gainExp(host, kvNum(this.getKV(), 'exp', 0), this);
    }
}

// ---------------------------------------------------------------- killStackAtk 嗜杀

/**
 * 嗜杀（`killStackAtk`）。`kv = { per, max }`（蓝 0.5/40、黄 0.8/60、红 1.2/80）
 *
 * 文案：`每击杀 1 名敌人：攻击力 +per（上限 max，本局永久）`。
 *
 * 实现：`bus.on(OnKill)` → 层数 +1（上限 `max`）→ 共享模板 1000 重放
 * `[3 攻击力, 层数 × per, 'add']`、`duration = -1`。
 * 坑：这里是**固定值**（`add`），不是百分比 —— 与 `takeStackAtk` / `tickStackAtk` 的 `percent`
 * 不同（文案一个是「+0.5」、一个是「+1%」，别抄错）。
 */
export class RelicHook_KillStackAtk extends RelicBusHook {
    private stacks = 0;

    protected getBusEventName(): string { return BattleEvents.OnKill; }

    /** 当前层数（调试/断言用） */
    getStacks(): number { return this.stacks; }

    protected handleBusEvent(event: any): void {
        const host = this.target as any;
        if (!host || event?.killer !== host) return;
        if (!alive(host)) return;

        const kv = this.getKV() ?? {};
        const per = kvNum(kv, 'per', 0);
        const max = Math.floor(kvNum(kv, 'max', 0));
        if (!(per > 0) || max <= 0) return;
        if (this.stacks >= max) return;

        this.stacks++;
        reapplyAttrs(host, this, [[AttributeType.Atk, this.stacks * per, 'add']], -1);
    }
}

// ---------------------------------------------------------------- killBoom 死亡回响

/**
 * 死亡回响（`killBoom`）。`kv = { value, radius }`（蓝 40/120、黄 80/140、红 140/160）
 *
 * 文案：`击杀敌人时，对周围 radius 像素内敌人造成 value 点魔法伤害`。
 *
 * 实现：`bus.on(OnKill)` → 以**阵亡者的位置**为圆心，对 `radius` 像素内的敌人各追加 `value` 点魔法伤害。
 * 坑：`OnKill` 时死者已经 `Die()`（`modifiers.Clear()` 也跑完了），
 * `findEntitiesInRadius` 会自己滤掉死者；仍显式跳过 `t === victim`（防对象池复用后误伤）。
 */
export class RelicHook_KillBoom extends RelicBusHook {
    protected getBusEventName(): string { return BattleEvents.OnKill; }

    protected handleBusEvent(event: any): void {
        const host = this.target as any;
        if (!host || event?.killer !== host) return;
        const victim = event?.victim as any;
        const ctx = hostCtx(host);
        if (!ctx || !victim?.position) return;

        const kv = this.getKV() ?? {};
        const value = kvNum(kv, 'value', 0);
        const radius = kvNum(kv, 'radius', 0);
        if (!(value > 0) || !(radius > 0)) return;

        aoe(ctx, victim, radius, (t) => {
            if (t === victim) return;
            deal(ctx, host, t, value, DamageType.Magical);
        });
    }
}

// ---------------------------------------------------------------- killCdr 处决节律

/**
 * 处决节律（`killCdr`）。`kv = { value }`（蓝 0.5s / 黄 1s / 红 2s）
 *
 * 文案：`击杀敌人使所有技能冷却减少 value 秒`。
 *
 * 实现：`bus.on(OnKill)` → 遍历 `host.abilities.getAll()`，把每一项的
 * `cooldownRemaining` 减去 `value` 并钳到 0（不改成负数，否则下一次 `Cast` 判定会错）。
 * 坑：英雄技能在这个工程里都是**被动**，但冷却字段仍在（BossAI/后续主动技能会用），
 * 所以按"所有技能"统一处理；`abilities` 可能缺失 → 全部可选链兜住。
 */
export class RelicHook_KillCdr extends RelicBusHook {
    protected getBusEventName(): string { return BattleEvents.OnKill; }

    protected handleBusEvent(event: any): void {
        const host = this.target as any;
        if (!host || event?.killer !== host) return;

        const value = kvNum(this.getKV(), 'value', 0);
        if (!(value > 0)) return;
        const list = host.abilities?.getAll?.() ?? [];
        for (const a of list) {
            if (!a || !(a.cooldownRemaining > 0)) continue;
            a.cooldownRemaining = Math.max(0, a.cooldownRemaining - value);
        }
    }
}

/* =====================================================================================
 * ============ D 组：节奏 / 周期类（`OnTick` 自计时 或 `on_phase_changed` 总线）============
 * ===================================================================================== */

// ---------------------------------------------------------------- tickStackAtk 战意

/**
 * 战意（`tickStackAtk`）。`kv = { interval, per, max }`（蓝 5s/1%/20、黄 4s/1%/30、红 3s/1.5%/40）
 *
 * 文案：`每 interval 秒：攻击力 +per%（上限 max 层，本局永久）`。
 *
 * 实现：`OnTick` 自己计时，攒满 `interval` 秒叠 1 层（上限 `max`），再用共享模板 1000 重放
 * `[3 攻击力, 层数 × per, 'percent']`、`duration = -1`（**本局永久**）。
 * 坑：叠加方式是 `percent`（百分数配置）；满层后连计时都停（省一次无意义的 AddModifier）。
 */
export class RelicHook_TickStackAtk extends Modifier {
    private timer = 0;
    private stacks = 0;

    /** 当前层数（调试/断言用） */
    getStacks(): number { return this.stacks; }

    OnTick(dt: number): void {
        const host = this.target as any;
        if (!alive(host)) return;

        const kv = this.getKV() ?? {};
        const interval = kvNum(kv, 'interval', 0);
        const per = kvNum(kv, 'per', 0);
        const max = Math.floor(kvNum(kv, 'max', 0));
        if (!(interval > 0) || !(per > 0) || max <= 0) return;
        if (this.stacks >= max) return;

        this.timer += dt;
        if (this.timer < interval) return;
        this.timer = 0;

        this.stacks++;
        reapplyAttrs(host, this, [[AttributeType.Atk, this.stacks * per, 'percent']], -1);
    }
}

// ---------------------------------------------------------------- phaseBuff 阶段契约

/**
 * 阶段契约（`phaseBuff`）。`kv = { atkSpeed, max }`（蓝 4%/5、黄 6%/6、红 8%/8）
 *
 * 文案：`每进入新阶段：攻击速度 +atkSpeed%（上限 max 层，本局永久）`。
 *
 * 实现：`bus.on(BattleEvents.OnPhaseChanged)`（阶段切换只发总线，不派发给 Modifier）→
 * 层数 +1（上限 `max`）→ 共享模板 1000 重放 `[4 攻速, 层数 × atkSpeed, 'add']`、`duration = -1`。
 * 坑：攻速是**缩放型属性**（100 = 1.0 次/秒），且用 `add`（攻速 base 不为 0，但遗物口径统一用 add）；
 * 场景层只在**阶段号真的变了**之后发这个事件，所以不用处理重复信号。
 */
export class RelicHook_PhaseBuff extends RelicBusHook {
    private stacks = 0;

    protected getBusEventName(): string { return BattleEvents.OnPhaseChanged; }

    /** 当前层数（调试/断言用） */
    getStacks(): number { return this.stacks; }

    protected handleBusEvent(_event: any): void {
        const host = this.target as any;
        if (!alive(host)) return;

        const kv = this.getKV() ?? {};
        const atkSpeed = kvNum(kv, 'atkSpeed', 0);
        const max = Math.floor(kvNum(kv, 'max', 0));
        if (!(atkSpeed > 0) || max <= 0) return;
        if (this.stacks >= max) return;

        this.stacks++;
        reapplyAttrs(host, this, [[AttributeType.AtkSpeed, this.stacks * atkSpeed, 'add']], -1);
    }
}

/* =====================================================================================
 * ============ E 组：控制 / 光环类（命中概率触发 或 每秒扫描）============
 * ===================================================================================== */

// ---------------------------------------------------------------- slowAura 迟滞光环

/**
 * 迟滞光环（`slowAura`）。`kv = { pct, radius }`（蓝 20%/160、黄 30%/180、红 40%/200）
 *
 * 文案：`周围 radius 像素内敌人移动速度 -pct%`。
 *
 * 实现：`OnTick` 每秒扫一次 `radius` 像素内的敌人，各施加 `MOD_RELIC_SLOW`（持续 1.2 秒、
 * `kv.slow` = **该敌人当前移速的 -pct%**，像素/秒的负数）。
 * 坑：① 减速幅度按**每个敌人各自**的移速算（精英怪移速不同，比例才一致）；
 * ② 持续（1.2s）比光环节拍（1s）略长 —— 在范围内就一直被减速，离开后 1.2 秒内恢复正常（不会永久粘住）。
 */
export class RelicHook_SlowAura extends Modifier {
    private timer = 0;

    OnTick(dt: number): void {
        const host = this.target as any;
        if (!alive(host)) return;
        const ctx = hostCtx(host);
        if (!ctx) return;

        const kv = this.getKV() ?? {};
        const pct = kvNum(kv, 'pct', 0);
        const radius = kvNum(kv, 'radius', 0);
        if (!(pct > 0) || !(radius > 0)) return;

        this.timer += dt;
        let guard = 0;
        while (this.timer >= AURA_INTERVAL && guard++ < 8) {
            this.timer -= AURA_INTERVAL;
            if (!alive(host)) return;
            for (const e of enemiesInRadius(ctx, host, radius)) {
                if (!e.modifiers) continue;
                const slow = slowValue(e, pct);
                if (slow === 0) continue;
                e.modifiers.AddModifier(MOD_RELIC_SLOW, host, AURA_SLOW_SEC, { slow }, this.origin);
            }
        }
    }
}

// ---------------------------------------------------------------- stunProc 震荡

/**
 * 震荡（`stunProc`）。`kv = { chance, dur }`（蓝 10%/0.8s、黄 18%/1s、红 25%/1.2s）
 *
 * 文案：`普攻有 chance% 概率眩晕目标 dur 秒`。
 * 实现：命中后概率触发 → `MOD_STUN`（7，`apply_state stunned`），持续 `dur`。
 * 坑：`dur` 必须显式传（行自带 duration 是 1.5，三档都要覆盖）。
 */
export class RelicHook_StunProc extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim) || !victim.modifiers) return false;

        const kv = this.getKV() ?? {};
        if (!rollPct(kvNum(kv, 'chance', 0))) return false;
        const dur = kvNum(kv, 'dur', 0);
        if (!(dur > 0)) return false;
        victim.modifiers.AddModifier(MOD_STUN, host, dur, undefined, this.origin);
        return false;
    }
}

// ---------------------------------------------------------------- freezeProc 冰封

/**
 * 冰封（`freezeProc`）。`kv = { chance }`（蓝 12 / 黄 20 / 红 30）
 *
 * 文案：`普攻有 chance% 概率冻结目标 1.5 秒`。
 * 实现：命中后概率触发 → `MOD_RELIC_FREEZE`（304，冻结语义 = 眩晕），持续 1.5 秒（固定，文案写死）。
 */
export class RelicHook_FreezeProc extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim) || !victim.modifiers) return false;

        if (!rollPct(kvNum(this.getKV(), 'chance', 0))) return false;
        victim.modifiers.AddModifier(MOD_RELIC_FREEZE, host, FREEZE_SEC, undefined, this.origin);
        return false;
    }
}

// ---------------------------------------------------------------- hexProc 妖术

/**
 * 妖术（`hexProc`）。`kv = { chance, dur }`（蓝 6%/1.2s、黄 10%/1.5s、红 15%/2s）
 *
 * 文案：`普攻有 chance% 概率妖术目标 dur 秒`。
 * 实现：命中后概率触发 → `MOD_RELIC_HEX`（302，`apply_state hexed` = 沉默 + 缴械 + 缄默），持续 `dur`。
 */
export class RelicHook_HexProc extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim) || !victim.modifiers) return false;

        const kv = this.getKV() ?? {};
        if (!rollPct(kvNum(kv, 'chance', 0))) return false;
        const dur = kvNum(kv, 'dur', 0);
        if (!(dur > 0)) return false;
        victim.modifiers.AddModifier(MOD_RELIC_HEX, host, dur, undefined, this.origin);
        return false;
    }
}

// ---------------------------------------------------------------- silenceProc 静默

/**
 * 静默（`silenceProc`）。`kv = { chance, dur }`（蓝 15%/2s、黄 25%/2s、红 35%/2.5s）
 *
 * 文案：`普攻有 chance% 概率沉默目标 dur 秒`。
 * 实现：命中后概率触发 → `MOD_RELIC_SILENCE`（301，`apply_state silenced`），持续 `dur`。
 */
export class RelicHook_SilenceProc extends Modifier {
    OnBattleEvent(eventName: string, event: any): boolean {
        if (eventName !== 'on_attack_landed') return false;
        const host = this.target as any;
        if (!host || event?.attacker !== host) return false;
        const victim = event?.target as any;
        const ctx = hostCtx(host);
        if (!ctx || !alive(victim) || !victim.modifiers) return false;

        const kv = this.getKV() ?? {};
        if (!rollPct(kvNum(kv, 'chance', 0))) return false;
        const dur = kvNum(kv, 'dur', 0);
        if (!(dur > 0)) return false;
        victim.modifiers.AddModifier(MOD_RELIC_SILENCE, host, dur, undefined, this.origin);
        return false;
    }
}

/* =====================================================================================
 * 脚本类清单 —— 供 Scene_Game_Stage.initBattle 一次性注册
 * ===================================================================================== */

/**
 * 全部局内遗物钩子脚本类：`script_id` → 类（键名 = `HOOKS[].impl` 里 `S:` 后面的类名，共 40 个）。
 *
 * 注册入口在 `Scene_Game_Stage.initBattle`（与英雄脚本、`SHOP_SKILL_SCRIPT_CLASSES` 同一处）。
 * 漏注册会在运行时打印 `[ModifierSystem] script_id 未注册: xxx` 并**静默降级成普通 Modifier**
 * （遗物看起来"抽到了但没效果"）。
 */
export const RELIC_HOOK_SCRIPT_CLASSES: Record<string, any> = {
    RelicHook_HitFlat,
    RelicHook_HitPct,
    RelicHook_Ignite,
    RelicHook_Poison,
    RelicHook_Frost,
    RelicHook_ArmorBreak,
    RelicHook_Splash,
    RelicHook_Chain,
    RelicHook_Pierce,
    RelicHook_Execute,
    RelicHook_FirstStrike,
    RelicHook_CritEcho,
    RelicHook_AtkSpeedStack,
    RelicHook_Charge,
    RelicHook_Thorns,
    RelicHook_Block,
    RelicHook_ShieldCharge,
    RelicHook_EvadeCounter,
    RelicHook_LowHpGuard,
    RelicHook_NearDeath,
    RelicHook_LastStand,
    RelicHook_TakeHeal,
    RelicHook_Immolate,
    RelicHook_TakeStackAtk,
    RelicHook_MagicBarrier,
    RelicHook_RegenTick,
    RelicHook_KillHeal,
    RelicHook_KillMana,
    RelicHook_KillGold,
    RelicHook_KillExp,
    RelicHook_KillStackAtk,
    RelicHook_KillBoom,
    RelicHook_KillCdr,
    RelicHook_TickStackAtk,
    RelicHook_PhaseBuff,
    RelicHook_SlowAura,
    RelicHook_StunProc,
    RelicHook_FreezeProc,
    RelicHook_HexProc,
    RelicHook_SilenceProc,
};
