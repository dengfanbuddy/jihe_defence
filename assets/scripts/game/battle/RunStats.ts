import { AttributeScaling } from './core/AttributeScaling';
import { AttributeTypeName } from './core/Types';
import { AttributeStackMode } from './types';
import { ShopConfig } from '../data/configs/ShopConfig';
import { TbRoot } from '../../platform/excel_table/TbRoot';
import { AttributeCfgContainer } from '../excel_table/Tb_AttributeConfig';
import { ModifierCfgContainer } from '../excel_table/Tb_ModifierConfig';
import { UnitCfgContainer } from '../excel_table/Tb_UnitConfig';

/**
 * RunStats —— **局内成长统计（一局的完整账本）**（纯 TS，无 cc 依赖）
 *
 * ## 它解决什么
 *
 * 「这一局玩家到底长了多少、长在哪、合不合理」这个问题，此前只能靠翻几十行零散 log 猜：
 * 遗物在 `RelicShop` 打一行、神器在 `BuffShop` 打一行、掉落道具在 `ItemBag` 打一行、
 * 金币/等级在场景里各处打一行 —— **没有一份汇总**，也没人把「属性加成是固定值还是百分比、
 * 分别来自哪条线」算清楚。
 *
 * 本类就是一个**只记账、不决策**的记账本：各系统在既有事件点上顺手喂它一条记录，
 * 一局结束时 `finishRun()` 现场读一次英雄实体（属性 + Modifier 实例），
 * 把整局压成一份 **可直接贴给 AI 分析的结构化报告 + 控制台文本**。
 *
 * ## 三条硬口径（改之前先读）
 *
 *   ① **本类绝不改任何战斗状态**。它只读（`attrs.get` / `modifiers.getAll()`）与累加自己的计数器；
 *      所有写入点都是宿主（`Scene_Game_Stage`）在**既有回调/事件**里转交过来的
 *      （OnDeath / OnRelicAdded / OnModifierAdded / spendGold …）—— 所以"统计开不开"不影响玩法。
 *   ② **属性分解的口径与 `AttributeSystem.combine` 一致，但只做「线性近似对账」**：
 *      `percent` 只对**基础值**乘算一次（多来源相加）、`add` 加在其后、`multiply` 复利；
 *      `complement / best` 两种叠加**不参与近似**（报告会标"不做线性近似"）。
 *      报告里的 `最终` 一律是 `attrs.get()` 的**真值**，近似值只用来暴露口径漂移。
 *   ③ **取值是「运行时口径」**（与 `describeOuterBonus` / `HeroPropertiesVM` 同一套）：
 *      倍率型属性（4/7/8/11/12/14/15/21~25）是小数（`1.4` = 140%、`0.25` = 25%），
 *      其余是原值；百分比加成单独成列，单位是**百分点**（`+14` = +14%）。
 *
 * ## 报告怎么用
 *
 *   · 控制台：一局结束（`endRun`）时打一整块纯文本，分节清楚、可直接复制给 AI；
 *   · 结构化：同一份数据挂在 `window.__runStats` 上
 *     （控制台执行 `copy(JSON.stringify(window.__runStats))` 即得 JSON）。
 *
 * ## 落点一览（谁喂它什么）
 *
 * ```
 *   Scene_Game_Stage             场景：开局/换阶段/击杀/伤害/金币/经验/复活/Boss 刷新
 *     ├── RelicShop.onRoll       → 抽取通道与花费、本轮候选（遗物/技能/品质）
 *     ├── RelicShop.onRelicGranted → 到手的是哪件遗物（含"开局赠礼"）
 *     ├── BuffShop 购买           → 神器种类/层数/单价
 *     ├── ItemBag  掉落/使用       → 掉落 Buff 道具
 *     ├── SkillSlots.onChanged    → 技能槽差异（学会/升级/顶替）
 *     └── ModifierSystem 事件     → 限时 Buff / 状态（OnModifierAdded 带 origin 与 duration）
 * ```
 *
 * @example
 * ```ts
 * // 宿主（Scene_Game_Stage）：onLoad 建一次、resetRun 复位、endRun 收尾打印
 * this.runStats = new RunStats({ getElapsed: () => this.elapsed, getStage: () => this.stage });
 * ...
 * this.runStats.finishRun({ result, reason, hero: this.hero, stage: this.stage, ... });
 * ```
 */

/* ===================================================================
 * 类型
 * =================================================================== */

/**
 * 属性加成的来源分类（报告里的列）——由 Modifier 的 `origin` 前缀解析。
 *
 * ⚠ 前缀真源在各施加方：`relic:<id>`（遗物 + 遗物钩子）· `killbuff:<id>[:<层>]`（神器）·
 *   `item:<id>:<序号>`（掉落 Buff）· `ability:<id>`（技能，含英雄专属技能与 Boss 技能）。
 *   认不出的（空 origin / 怪物挂上来的减益）一律归 `other`。
 */
export type AttrSourceKey = 'relic' | 'artifact' | 'battleItem' | 'skill' | 'other';

/** 来源分类的展示名（报告明细行用） */
export const ATTR_SOURCE_LABEL: Record<AttrSourceKey, string> = {
    relic: '遗物',
    artifact: '神器',
    battleItem: '掉落Buff',
    skill: '技能',
    other: '其他',
};

/** 报告里来源列的固定顺序 */
export const ATTR_SOURCE_ORDER: AttrSourceKey[] = ['relic', 'artifact', 'battleItem', 'skill', 'other'];

/** 一组属性加成（按叠加方式分桶；数值口径见文件头 ③） */
export interface AttrBonusBucket {
    /** 固定值合计（运行时 float） */
    add: number;
    /** 百分比合计（**百分点**：`14` = +14%） */
    percent: number;
    /**
     * 乘算合计（小数：`0.2` = ×1.2）。
     * ⚠ 多条 `multiply` 是**复利**（`Π(1+v)`），所以这里存的是**复合后的系数减一**
     *   （`(1+a)(1+b)-1`），不是各条数值之和 —— 与 `AttributeSystem.combine` 同口径。
     */
    multiply: number;
    /** 补数乘法合计（合成为 `1-Π(1-v)`，仅作展示） */
    complement: number;
    /** 优者生效里最大的那一条 */
    best: number;
    /** 贡献条数（Modifier 实例数） */
    count: number;
}

/** 一个属性的完整读数（报告「属性总览」的一行） */
export interface AttrStatRow {
    id: number;
    name: string;
    /** 配置基础值（`units.json.base_attributes`，运行时 float） */
    configBase: number;
    /** 局外遗物固定值（已落进 base） */
    outerFlat: number;
    /** 局外遗物百分比（比例：`0.2` = +20%，已落进 base） */
    outerPercent: number;
    /** 局外加成折算出的**绝对值**（`configBase × outerPercent + outerFlat`） */
    outerAbs: number;
    /** 局内等级成长累计（`growthValues` × 级数，已落进 base） */
    growth: number;
    /** 当前基础值（`attrs.getBase()`，≈ 配置 + 局外 + 成长） */
    base: number;
    /** 所有 Modifier 的总贡献 */
    mods: AttrBonusBucket;
    /** 按来源拆开的贡献 */
    bySource: Record<AttrSourceKey, AttrBonusBucket>;
    /** 最终值（`attrs.get()`，**真值**，已过钳制） */
    final: number;
    /**
     * 配表给这个属性设的**上下限**（`attributes.json` 的 `min` / `max`；未设 = `undefined`）。
     *
     * 为什么值得单独带上：`final` 与「线性近似」对不上时，**九成是撞了这两个数**
     * （攻速上限 5.0、受伤减免上限 3.0…）。撞上限意味着**这部分成长是白涨的** ——
     * 那正是"成长是否合理"这个问题最该看见的一件事，所以报告里会直接点名。
     */
    clampMin?: number;
    clampMax?: number;
    /** 最终值是不是被上限 / 下限卡住了（`0` = 没卡，`1` = 卡上限，`-1` = 卡下限） */
    clamped: 0 | 1 | -1;
    /** 线性近似值（只算 add/percent/multiply；含补数/优者时为 `null`） */
    approx: number | null;
    /** 近似值与真值的差（`approx - final`；`approx` 为 null 时也是 null） */
    approxDelta: number | null;
}

/** 一件到手遗物的记录 */
export interface RunRelicRecord {
    seq: number;
    id: number;
    name: string;
    rarity: string;
    category: string;
    tags: string[];
    /** 到手路径：商店抽取 / 成就「开局赠遗物」 */
    via: 'draw' | 'start_gift';
    /** 到手时刻（本局存活秒数） */
    at: number;
    /** 到手时的阶段 */
    stage: number;
    /** 声明式加成摘要（读 `relics.modifiers_inner`，与游戏内实际挂载同源） */
    bonuses: string;
    /** 到手后本局遗物总数 */
    ownedAfter: number;
}

/** 一次神器（击杀数商店）购买记录（**一层一条**） */
export interface RunArtifactRecord {
    seq: number;
    id: number;
    name: string;
    /** 属性型 = `atk/hp/range/...`；机制型 = `special` */
    stat: string;
    /** 每层数值（配表 `per`） */
    per: number;
    /** 叠加方式（`percent` = 相对基础值；`add` = 固定值） */
    mode: 'add' | 'percent';
    /** 买到第几层 */
    level: number;
    maxLevel: number;
    /** 这一层花掉的击杀数 */
    price: number;
    at: number;
    stage: number;
    /** 配表的效果说明（`per_desc`） */
    effect: string;
}

/** 掉落 Buff 道具的一条记录（掉落 / 使用 / 拒收） */
export interface RunBattleItemRecord {
    seq: number;
    id: number;
    name: string;
    action: 'drop' | 'use' | 'reject';
    /** 时长（秒；`0` = 即刻生效） */
    duration: number;
    at: number;
    stage: number;
}

/** 技能槽变化的一条记录（由槽位快照差异推出） */
export interface RunSkillRecord {
    seq: number;
    id: number;
    name: string;
    /** 变化后的等级 */
    level: number;
    kind: 'learn' | 'upgrade' | 'replace' | 'hero_evolve';
    /** 被顶掉的技能 id（`kind='replace'`） */
    replacedId?: number;
    /** 落槽下标（0 = 英雄专属槽） */
    slot: number;
    at: number;
    stage: number;
}

/** 限时 Buff / 状态获取的汇总（同 id + origin 合并计数） */
export interface RunBuffRecord {
    id: number;
    name: string;
    origin: string;
    source: AttrSourceKey;
    /** 获得次数（同 id + origin 重复施加会累加） */
    times: number;
    /** 首次获得时刻（秒） */
    firstAt: number;
    /** 时长（秒；`-1` 永久、`0` 即刻生效） */
    duration: number;
    /** 累计层数（每次施加时的 stackCount 之和） */
    stacks: number;
}

/** 一次遗物商店抽取（一轮 4~5 个候选） */
export interface RunRollRecord {
    seq: number;
    /** 花掉的金币（0 = 广告 / 券免费） */
    cost: number;
    /** 付费通道 */
    via: 'gold' | 'ad' | 'ticket';
    at: number;
    stage: number;
    heroLevel: number;
    /** 本轮候选 */
    options: Array<{ kind: string; id: number; name: string; rarity: string }>;
}

/** 阶段时间线的一段 */
export interface RunStageRecord {
    stage: number;
    from: number;
    to: number;
    /** 本段内的击杀数 */
    kills: number;
    /** 本段内的金币收入 */
    gold: number;
}

/** 一只 Boss 的刷新记录（场景刷的阶段 Boss / 最终 Boss） */
export interface RunBossRecord {
    kind: string;
    unitId: number;
    name: string;
    /** 刷出时的阶段 */
    stage: number;
    at: number;
    maxHp: number;
    atk: number;
    /** 强度倍率（HP / 攻击） */
    hpMul: number;
    atkMul: number;
}

/** 敌方击杀统计（按怪种） */
export interface RunKillByUnit {
    id: number;
    name: string;
    count: number;
    /** 这些击杀一共给了几点击杀数（按 `units.json.killReward` 加权） */
    points: number;
    gold: number;
    exp: number;
}

/** 一局结束时由宿主补进来的「终局读数」 */
export interface RunEndInfo {
    /**
     * 终局性质：
     *   · `victory` 打赢了 / `defeat` 打输了 —— `endRun()` 的两条正常收尾；
     *   · `abort` **中途退出**（HUD 退出按钮）或**手动催一份**（`__runStatsDump()`）。
     *
     * ⚠ `abort` 是**统计专用的第三种状态**，它**不是一次"对局结束"**：不上报任务进度、
     *   不写 `recordGameEnd`、不发结算奖励（那三样仍然只有 `endRun()` 会做）—— 它只是
     *   "这一局的账本到此为止"。有它才不用**非打到胜负**才能看成长情况（测试时最常走的
     *   就是"打一会儿 → 退出看看"这条路）。
     */
    result: 'victory' | 'defeat' | 'abort';
    /** 结束原因（`boss_killed` / `hero_dead` / `boss_timeout` / `exit` / `manual_dump` …） */
    reason: string;
    hero: RunStatsHero | null;
    stage: number;
    elapsed: number;
    level: number;
    exp: number;
    expToNext: number;
    /** 累计击杀（`battleStore.kills`，只增不减） */
    kills: number;
    /** 金币余额（`hero.gold`） */
    goldBalance: number;
    /** 击杀数余额（`battleStore.killPoints`） */
    killPointsBalance: number;
    /** 终盘技能槽（下标 = 槽位） */
    skillSlots: Array<{ skillId: number; level: number; locked: boolean }>;
}

/**
 * 报告要读的英雄实体（`Entity` 的**结构子集**）——结构类型是刻意的：
 * 体检脚本可以用一个 20 行的替身满足它，不必拉起整个 BattleContext（同 `OuterAttributeApply`）。
 */
export interface RunStatsHero {
    id: number;
    name?: string;
    hp: number;
    gold?: number;
    attrs: { get(id: number): number; getBase(id: number): number };
    modifiers: { getAll(): RunStatsModifier[] };
}

/** 报告要读的 Modifier（`Modifier` 的结构子集） */
export interface RunStatsModifier {
    getId(): number;
    origin?: string;
    duration?: number;
    GetAffectedAttributes(): number[];
    GetModifierProperty(attrId: number): { value: number; mode?: AttributeStackMode } | null;
}

/** 结构化报告（挂在 `window.__runStats` 上的就是它） */
export interface RunStatsReport {
    meta: {
        heroId: number;
        heroName: string;
        difficulty: number;
        mode: string;
        speedMul: number;
        result: string;
        reason: string;
        elapsed: number;
        stage: number;
        maxPhase: number;
        level: number;
        exp: number;
        expToNext: number;
        hp: number;
        maxHp: number;
        /** 成就开局快照（`{ code: value }`） */
        achieveSnapshot: Record<string, number>;
        /**
         * `attributes` 是不是**死前快照**（`true` = 英雄阵亡时 Modifier 已被 `Die()` 清空，
         * 属性那一节读的是最后一刻拍下来的那份）。分析时据此判断"终局属性"的时效性。
         */
        attributesFromSnapshot: boolean;
    };
    gold: {
        seed: number;
        fromKills: number;
        fromOther: number;
        incomeTotal: number;
        spentOnDraws: number;
        spentOnHeroSelect: number;
        spentTotal: number;
        balance: number;
    };
    killPoints: {
        seed: number;
        fromKills: number;
        spent: number;
        balance: number;
    };
    exp: {
        fromKills: number;
        fromOther: number;
        fromStartBonus: number;
        total: number;
        level: number;
        /** 升级时刻表 */
        levelUps: Array<{ level: number; at: number; stage: number }>;
    };
    combat: {
        kills: number;
        killsByUnit: RunKillByUnit[];
        damageDealt: number;
        damageTaken: number;
        crits: number;
        dps: number;
        killsPerMin: number;
        /** 复活记录（券 / 广告） */
        revives: Array<{ kind: string; at: number; stage: number }>;
    };
    attributes: AttrStatRow[];
    /** 属性基座的三个落点（配置基础 / 局外 / 成长），按属性 id 索引 */
    attrBase: {
        config: Record<string, number>;
        outerFlat: Record<string, number>;
        outerPercent: Record<string, number>;
        growth: Record<string, number>;
    };
    relics: {
        count: number;
        byRarity: Record<string, number>;
        list: RunRelicRecord[];
    };
    artifacts: {
        kinds: number;
        levels: number;
        spent: number;
        list: RunArtifactRecord[];
        /** 按神器聚合的层数 */
        byId: Record<string, { name: string; level: number; maxLevel: number }>;
    };
    battleItems: {
        dropped: number;
        used: number;
        rejected: number;
        list: RunBattleItemRecord[];
    };
    buffs: RunBuffRecord[];
    skills: RunSkillRecord[];
    /** 终盘技能槽（下标 = 槽位；`skillId=0` = 空槽） */
    finalSkillSlots: Array<{ slot: number; skillId: number; name: string; level: number; locked: boolean }>;
    rolls: RunRollRecord[];
    rollSummary: {
        total: number;
        paid: number;
        viaAd: number;
        viaTicket: number;
        goldSpent: number;
        optionsTotal: number;
        optionsRelic: number;
        optionsSkill: number;
        raritySeen: Record<string, number>;
    };
    stages: RunStageRecord[];
    bosses: RunBossRecord[];
    /** 每分钟指标（成长是否合理的粗判据） */
    rates: {
        goldPerMin: number;
        expPerMin: number;
        killsPerMin: number;
        levelsPerMin: number;
        relicsPerMin: number;
    };
}

/** RunStats 的注入依赖 */
export interface RunStatsDeps {
    /** 本局存活秒数（记录时间轴用） */
    getElapsed?(): number;
    /** 当前阶段（1 起；准备期为 0） */
    getStage?(): number;
    /** 控制台输出（缺省 `console.log`） */
    print?(text: string): void;
    /** 本局难度档位 */
    getDifficulty?(): number;
    /** 本局模式（展示用） */
    getMode?(): string;
    /** HUD 的阶段数分母（0 = 无尽） */
    getMaxPhase?(): number;
    /** 本局倍速 */
    getSpeedMul?(): number;
    /** 自定义结构化报告的发布口（缺省挂 `window.__runStats`；体检/回放可以拿它接住） */
    publish?(report: RunStatsReport): void;
}

/* ===================================================================
 * 文本工具（工程 lib 只到 ES2015：没有 padStart / Object.entries，这里自己写）
 * =================================================================== */

/** 显示宽度（CJK 记 2 列，用于对齐） */
function dispWidth(s: string): number {
    let w = 0;
    for (let i = 0; i < s.length; i++) w += s.charCodeAt(i) > 0x2e80 ? 2 : 1;
    return w;
}

/** 右侧补空格到显示宽度 */
function padEnd(s: string, width: number): string {
    let out = s;
    while (dispWidth(out) < width) out += ' ';
    return out;
}

/** 左侧补空格到显示宽度 */
function padStart(s: string, width: number): string {
    let out = s;
    while (dispWidth(out) < width) out = ' ' + out;
    return out;
}

/** 数字（默认 0 位小数；NaN/Infinity 原样输出，便于一眼看出脏数据） */
function num(v: number, digits = 0): string {
    if (!Number.isFinite(v)) return String(v);
    const p = Math.pow(10, digits);
    const r = Math.round(v * p) / p;
    return String(r === 0 ? 0 : r);   // 顺手消掉 -0
}

/** 带符号数值 */
function signed(v: number, digits = 2): string {
    return (v > 0 ? '+' : '') + num(v, digits);
}

/** 百分数文本（入参是**百分点**：`14` → `+14%`） */
function pctText(v: number, digits = 1): string {
    return (v > 0 ? '+' : '') + num(v, digits) + '%';
}

/**
 * 终局性质的**中文读数**（报告与裸账本都用它）。
 *
 * `abort` 是"中途退出 / 手动催一份"——刻意写成「中途退出」而不是「失败」：
 * 这一局的账**没打完**，跟"打不过"是两回事，读报告的人（或 AI）据此不该拿它去跟整局比。
 */
function resultText(result: any): string {
    switch (String(result ?? '')) {
        case 'victory': return '胜利';
        case 'defeat': return '失败';
        case 'abort': return '中途退出';
        default: return String(result ?? '?');
    }
}

/** 累计值 → 每分钟 */
function perMin(v: number, elapsed: number): number {
    return elapsed > 0 ? (v * 60) / elapsed : 0;
}

/** 空桶 */
function emptyBucket(): AttrBonusBucket {
    return { add: 0, percent: 0, multiply: 0, complement: 0, best: 0, count: 0 };
}

/** 空来源表（五个来源各一个空桶） */
function emptyBySource(): Record<AttrSourceKey, AttrBonusBucket> {
    const out = {} as Record<AttrSourceKey, AttrBonusBucket>;
    for (const k of ATTR_SOURCE_ORDER) out[k] = emptyBucket();
    return out;
}

/** 桶里有没有内容 */
function bucketEmpty(b: AttrBonusBucket): boolean {
    return b.count === 0
        && b.add === 0 && b.percent === 0 && b.multiply === 0 && b.complement === 0 && b.best === 0;
}

/* ===================================================================
 * RunStats
 * =================================================================== */

export class RunStats {

    private deps: RunStatsDeps;

    /* ===== 元信息（开局写入） ===== */
    private heroId = 0;
    private heroName = '';
    private achieveSnapshot: Record<string, number> = {};

    /* ===== 属性基座的三个落点（开局记一次，成长逐级累加） ===== */
    private attrConfigBase: Record<string, number> = {};
    private attrOuterFlat: Record<string, number> = {};
    private attrOuterPercent: Record<string, number> = {};
    private attrGrowth: Record<string, number> = {};

    /* ===== 经济 ===== */
    private goldSeed = 0;
    private goldFromKills = 0;
    private goldFromOther = 0;
    private goldSpentTotal = 0;
    private goldSpentOnDraws = 0;

    private killPointsSeed = 0;
    private killPointsFromKills = 0;
    private killPointsSpent = 0;

    private expFromKills = 0;
    private expFromOther = 0;
    private expFromStartBonus = 0;
    private levelUps: Array<{ level: number; at: number; stage: number }> = [];

    /* ===== 战斗 ===== */
    private damageDealt = 0;
    private damageTaken = 0;
    private crits = 0;
    private killByUnit: Record<string, RunKillByUnit> = {};
    private revives: Array<{ kind: string; at: number; stage: number }> = [];

    /* ===== 内容（遗物 / 神器 / 道具 / 技能 / Buff / 抽取） ===== */
    private relics: RunRelicRecord[] = [];
    private artifacts: RunArtifactRecord[] = [];
    private artifactStacks: Record<string, { name: string; level: number; maxLevel: number }> = {};
    private battleItems: RunBattleItemRecord[] = [];
    private buffs: RunBuffRecord[] = [];
    private buffIndex: Record<string, RunBuffRecord> = {};
    private skills: RunSkillRecord[] = [];
    private lastSlots: Array<{ skillId: number; level: number; locked: boolean }> = [];
    private rolls: RunRollRecord[] = [];
    private raritySeen: Record<string, number> = {};

    /* ===== 时间线（阶段增量靠这两个「起点快照」现算） ===== */
    private stages: RunStageRecord[] = [];
    private bosses: RunBossRecord[] = [];
    private stageKillMark = 0;
    private stageGoldMark = 0;

    /** 属性名缓存（配表名字按需取一次） */
    private attrNameCache: Record<string, string> = {};

    /**
     * **属性分解的"死前快照"**（`snapshotAttributes` 写入；`buildReport` 在英雄已经没了 Modifier 时回落到它）。
     *
     * ⚠ 为什么必须有它（这是本类唯一一个非平凡的设计点）：
     *   `DamagePipeline` 的死亡链是 **`target.Die()` → 再 `publish(OnDeath)`**，而 `Entity.Die()`
     *   会 `modifiers.Clear()`。于是"英雄阵亡 → endRun('defeat')"这条路上，等到 `finishRun()` 现场读
     *   `hero.modifiers.getAll()` 时**已经是一条空表** —— 报告会变成"这一局一点加成都没有，
     *   最终属性 == 基础属性"，而那恰恰是最需要看成长的一局（打不过的那一局）。
     *   所以在**致命一击的 `OnTakeDamage` 里**（Phase 7，早于 Phase 8 的 `Die()`）拍一张快照，
     *   收尾时若发现现场读不到任何贡献就回落到它。
     */
    private cachedAttrRows: AttrStatRow[] | null = null;

    /** 收尾时是否回落到「死前快照」（报告里如实标出来，免得读者以为属性是终局现场读的） */
    private usedAttrSnapshot = false;

    /**
     * 本局报告**是否已经打印过** —— `endRun()`（打完）与 `exit()`（中途退出）都会收尾，
     * 而"打完 → 点结算面板确定"会把这两条路各走一次。没有这道闸门，正常打完的那一局
     * 会看到**两份**报告（第二份还是 `abort` 的空壳）。
     */
    private reported = false;

    /** 最近一次打印出来的报告（重复收尾 / 外部回读时直接给回它） */
    private lastReport: RunStatsReport | null = null;

    constructor(deps: RunStatsDeps = {}) {
        this.deps = deps ?? {};
    }

    /* ===================================================================
     * 生命周期
     * =================================================================== */

    /**
     * 换局复位（宿主在 `resetRun()` 里调）。
     *
     * ⚠ **必须在 `resetRun` 里调**：本类随界面建一次（不是随一局），不复位的话第二局的报告会
     *   把上一局的遗物/金币一起算进来 —— 而且**第一局完全正确**，只有打到第二局才现形
     *   （与 `settleAdUsed` / `ArchetypeTally.reset` 是同一类坑）。
     */
    reset(): void {
        this.heroId = 0;
        this.heroName = '';
        this.achieveSnapshot = {};
        this.attrConfigBase = {};
        this.attrOuterFlat = {};
        this.attrOuterPercent = {};
        this.attrGrowth = {};
        this.goldSeed = 0;
        this.goldFromKills = 0;
        this.goldFromOther = 0;
        this.goldSpentTotal = 0;
        this.goldSpentOnDraws = 0;
        this.killPointsSeed = 0;
        this.killPointsFromKills = 0;
        this.killPointsSpent = 0;
        this.expFromKills = 0;
        this.expFromOther = 0;
        this.expFromStartBonus = 0;
        this.levelUps = [];
        this.damageDealt = 0;
        this.damageTaken = 0;
        this.crits = 0;
        this.killByUnit = {};
        this.revives = [];
        this.relics = [];
        this.artifacts = [];
        this.artifactStacks = {};
        this.battleItems = [];
        this.buffs = [];
        this.buffIndex = {};
        this.skills = [];
        this.lastSlots = [];
        this.rolls = [];
        this.raritySeen = {};
        this.stages = [];
        this.bosses = [];
        this.stageKillMark = 0;
        this.stageGoldMark = 0;
        this.cachedAttrRows = null;
        this.usedAttrSnapshot = false;
        this.reported = false;
        this.lastReport = null;

        // 开局一行「本局账本已开始记账」——
        //   本功能是"**结束时**才打印"的，没有这一行的话，中途**根本无从判断它到底有没有接上**
        //   （用户口径「现在没有打印呢」正是撞在这个盲区上：要么没接上、要么那一局没走到收尾，
        //     两种情况在中途看起来一模一样）。这一行把"活着"和"死的"当场分开。
        this.print('[统计] 本局账本已开始记账 —— 结束（胜利 / 阵亡 / 中途退出）时会打印完整报告；'
            + '中途想看现在这份可以执行 __runStatsDump()');
    }

    /* ===================================================================
     * 开局：元信息 / 属性基座 / 成就快照
     * =================================================================== */

    /**
     * 记下本局的英雄与它的**配置基础属性**（宿主在 `selectHero` 里调）。
     *
     * 为什么要专门记一份配置基础值：英雄实体的 `attrs.getBase()` 里已经混进了
     * **局外加成**（`applyOuterBonusesToEntity` 直接写 base）与**等级成长**（`addBase`），
     * 只看它就分不出「这一局的成长」有多少来自局外、多少来自局内升级。三份分开记，
     * 报告才能回答"我到底是靠遗物赢的还是靠局外堆赢的"。
     */
    setHero(heroId: number, heroName: string, configBase?: Array<[number, number]>): void {
        this.heroId = heroId;
        this.heroName = heroName ?? '';
        this.attrConfigBase = {};
        if (!configBase) return;
        for (const kv of configBase) {
            if (!kv) continue;
            this.attrConfigBase[String(kv[0])] = AttributeScaling.normalize(kv[0], kv[1]);
        }
    }

    /** 记下局外遗物落到英雄基础属性上的结果（宿主把 `applyOuterBonusesToEntity` 的返回值递进来） */
    setOuterBonus(rows: Array<{ attrId: number; flat: number; percent: number }>): void {
        this.attrOuterFlat = {};
        this.attrOuterPercent = {};
        if (!rows) return;
        for (const r of rows) {
            if (!r) continue;
            const key = String(r.attrId);
            this.attrOuterFlat[key] = (this.attrOuterFlat[key] ?? 0) + (Number(r.flat) || 0);
            this.attrOuterPercent[key] = (this.attrOuterPercent[key] ?? 0) + (Number(r.percent) || 0);
        }
    }

    /**
     * 记下一次等级成长（宿主在 `applyHeroGrowth` 里按属性逐条调）。
     * @param runtimeDelta 与 `AttributeSystem.getBase` 同口径的增量（已过 `AttributeScaling`）
     */
    noteLevelGrowth(attrId: number, runtimeDelta: number): void {
        const key = String(attrId);
        this.attrGrowth[key] = (this.attrGrowth[key] ?? 0) + (Number(runtimeDelta) || 0);
    }

    /** 记下本局的成就开局快照（`{ code: value }`，宿主在 `snapshotAchieveEffects` 之后递进来） */
    setAchieveSnapshot(effects: Record<string, number>): void {
        this.achieveSnapshot = {};
        if (!effects) return;
        for (const k of Object.keys(effects)) this.achieveSnapshot[k] = Number(effects[k]) || 0;
    }

    /* ===================================================================
     * 经济
     * =================================================================== */

    /** 开局播种的金币 */
    seedGold(amount: number): void {
        this.goldSeed += Math.max(0, Number(amount) || 0);
    }

    /** 击杀奖励里的金币（`grantKillReward` 的金币侧） */
    gainGoldFromKill(amount: number): void {
        this.goldFromKills += Number(amount) || 0;
    }

    /** 技能 / 遗物钩子等直接改 `hero.gold` 的金币（`OnGoldGained` 事件） */
    gainGoldFromOther(amount: number): void {
        this.goldFromOther += Number(amount) || 0;
    }

    /**
     * 花掉的金币（宿主在**唯一扣费口** `spendGold` 里调，只在真的扣成功时调）。
     * 遗物抽取那部分另外由 `onRoll` 记进 `goldSpentOnDraws` —— 两者不重不漏，
     * 差额就是「选英雄刷新」花掉的（局内只有这两个金币出口）。
     */
    spendGold(amount: number): void {
        this.goldSpentTotal += Math.max(0, Number(amount) || 0);
    }

    /** 开局播种的击杀数（成就 `run_start_kill_points`） */
    seedKillPoints(amount: number): void {
        this.killPointsSeed += Math.max(0, Math.floor(Number(amount) || 0));
    }

    /** 击杀获得的击杀数（按 `units.json.killReward` 加权后的点数） */
    gainKillPoints(amount: number): void {
        this.killPointsFromKills += Math.max(0, Math.floor(Number(amount) || 0));
    }

    /** 花掉的击杀数（宿主在 `spendKillPoints` 的包装里调，只在扣成功时调） */
    spendKillPoints(amount: number): void {
        this.killPointsSpent += Math.max(0, Math.floor(Number(amount) || 0));
    }

    /* ===================================================================
     * 经验 / 等级
     * =================================================================== */

    /** 击杀给的经验 */
    gainExpFromKill(amount: number): void {
        this.expFromKills += Math.max(0, Number(amount) || 0);
    }

    /** 遗物钩子 / 技能给的额外经验（`OnExpGained`） */
    gainExpFromOther(amount: number): void {
        this.expFromOther += Math.max(0, Number(amount) || 0);
    }

    /** 成就「开局英雄等级」补的经验（`hero_start_level`） */
    gainExpFromStartBonus(amount: number): void {
        this.expFromStartBonus += Math.max(0, Number(amount) || 0);
    }

    /** 升了一级（宿主在 `addBattleExp` 的升级循环里调） */
    noteLevelUp(level: number): void {
        this.levelUps.push({ level, at: this.elapsed(), stage: this.stage() });
    }

    /* ===================================================================
     * 战斗
     * =================================================================== */

    /**
     * 记一次敌方击杀（宿主在 `OnDeath` 里调）。
     *
     * ⚠ **必须在实体回对象池之前把读数取好**：`name` / `unitKind` 会被 `Entity.ResetForPool()`
     *   复位，`id` 不会（同 `killPointsOf` 的既有口径）。宿主负责传快照值进来；
     *   名字传空时这里按单位 id 现查一次配表兜底。
     */
    noteKill(unitId: number, unitName: string, points: number, gold: number, exp: number): void {
        const key = String(unitId);
        if (!this.killByUnit[key]) {
            this.killByUnit[key] = {
                id: unitId,
                name: unitName || this.unitName(unitId),
                count: 0, points: 0, gold: 0, exp: 0,
            };
        }
        const rec = this.killByUnit[key];
        rec.count++;
        rec.points += Math.max(0, Math.floor(Number(points) || 0));
        rec.gold += Number(gold) || 0;
        rec.exp += Number(exp) || 0;
    }

    /** 英雄造成的伤害 / 承受的伤害 / 是否暴击（宿主在 `OnTakeDamage` 里调） */
    noteDamage(dealt: number, taken: number, crit: boolean): void {
        if (dealt > 0) this.damageDealt += dealt;
        if (taken > 0) this.damageTaken += taken;
        if (crit) this.crits++;
    }

    /** 复活一次（`ticket` 用券 / `ad` 看广告） */
    noteRevive(kind: string): void {
        this.revives.push({ kind, at: this.elapsed(), stage: this.stage() });
    }

    /** 一只 Boss 刷出（只记场景按阶段刷的那两只；玩家自己从 Boss 槽放的不算 Boss 强度） */
    noteBoss(kind: string, unitId: number, name: string, maxHp: number, atk: number, hpMul: number, atkMul: number): void {
        this.bosses.push({
            kind,
            unitId,
            name: name ?? '',
            stage: this.stage(),
            at: this.elapsed(),
            maxHp: Math.round(Number(maxHp) || 0),
            atk: Math.round(Number(atk) || 0),
            hpMul: Number(hpMul) || 1,
            atkMul: Number(atkMul) || 1,
        });
    }

    /* ===================================================================
     * 内容：遗物 / 神器 / 掉落道具 / 技能 / Buff / 抽取
     * =================================================================== */

    /**
     * 一件遗物到手（宿主在 `RelicShop` 的 `onRelicGranted` 回调里调）。
     * 声明式加成直接读配表 `modifiers_inner`，与游戏内真正挂上去的是同一份数据。
     */
    onRelicGranted(relicId: number, via: 'draw' | 'start_gift' = 'draw'): void {
        const cfg = ShopConfig.getRelic(relicId);
        this.relics.push({
            seq: this.relics.length + 1,
            id: relicId,
            name: cfg?.name ?? String(relicId),
            rarity: String(cfg?.rarity ?? '?'),
            category: String(cfg?.category ?? ''),
            tags: (cfg?.tags ?? []).slice(),
            via,
            at: this.elapsed(),
            stage: this.stage(),
            bonuses: this.describeRelicBonuses(cfg),
            ownedAfter: this.relics.length + 1,
        });
    }

    /** 一次神器购买（宿主在 `onBuffBought` 里、**买成功之后**调；`price` 是这一层的实付价） */
    onArtifactBought(buffId: number, level: number, maxLevel: number, price: number): void {
        const cfg = ShopConfig.getKillBuff(buffId);
        this.artifacts.push({
            seq: this.artifacts.length + 1,
            id: buffId,
            name: cfg?.name ?? String(buffId),
            stat: String(cfg?.stat ?? ''),
            per: Number(cfg?.per ?? 0),
            mode: this.artifactMode(cfg),
            level,
            maxLevel,
            price: Math.max(0, Math.floor(Number(price) || 0)),
            at: this.elapsed(),
            stage: this.stage(),
            effect: String(cfg?.per_desc ?? ''),
        });
        this.artifactStacks[String(buffId)] = {
            name: cfg?.name ?? String(buffId),
            level,
            maxLevel,
        };
    }

    /**
     * 一件掉落 Buff 道具的流水（宿主在 `OnDeath` 的掉落分支 / `useBattleItem` 里调）。
     * `action` 三态：`drop` 进包 · `use` 用掉 · `reject` 满格被拒（**没有进包**）。
     */
    onBattleItem(itemId: number, action: 'drop' | 'use' | 'reject', duration = 0): void {
        const cfg = ShopConfig.getBattleItem(itemId);
        this.battleItems.push({
            seq: this.battleItems.length + 1,
            id: itemId,
            name: cfg?.name ?? String(itemId),
            action,
            duration: Number(duration) || 0,
            at: this.elapsed(),
            stage: this.stage(),
        });
    }

    /**
     * 一次遗物商店抽取（宿主在 `RelicShop` 的 `onRoll` 回调里调）。
     * 报告里的「抽取统计」与「抽卡花费」都出自这里。
     */
    onRoll(info: {
        cost: number;
        via: 'gold' | 'ad' | 'ticket';
        options: Array<{ kind: string; id: number; name: string; rarity: string }>;
        heroLevel: number;
    }): void {
        const cost = Math.max(0, Math.round(Number(info?.cost) || 0));
        const options: Array<{ kind: string; id: number; name: string; rarity: string }> = [];
        for (const o of (info?.options ?? [])) {
            options.push({ kind: String(o.kind), id: o.id, name: String(o.name), rarity: String(o.rarity) });
        }
        this.rolls.push({
            seq: this.rolls.length + 1,
            cost,
            via: info?.via ?? 'gold',
            at: this.elapsed(),
            stage: this.stage(),
            heroLevel: Number(info?.heroLevel) || 0,
            options,
        });
        if (cost > 0) this.goldSpentOnDraws += cost;
        for (const o of options) this.raritySeen[o.rarity] = (this.raritySeen[o.rarity] ?? 0) + 1;
    }

    /**
     * 技能槽整体状态（宿主在 `SkillSlots.onChanged` 与换英雄后调）。
     *
     * 用**差异**推「学会 / 升级 / 顶替」而不是在每个动作点各插一句：技能槽的变化路径有四条
     * （商店 `grant` 的填空 / 升级 / 顶替 + 英雄等级进化的 `syncHeroSkillLevels`），
     * 逐条插一定会漏；差异法从真源现读，四条天然都对（与 `ArchetypeTally` 的重算式同一理由）。
     *
     * @param heroEvolve 传 true 表示这次变化来自「英雄升到 Lv.15/30 的技能进化」——
     *                   槽位差异看不出是谁升的，所以由宿主点一下，用来把 `kind` 标成 `hero_evolve`
     */
    noteSkillSlots(slots: Array<{ skillId: number; level: number; locked: boolean }>, heroEvolve = false): void {
        if (!slots) return;
        const prev = this.lastSlots;
        const added: RunSkillRecord[] = [];
        for (let i = 0; i < slots.length; i++) {
            const s = slots[i];
            const before = prev[i];
            if (!s || s.skillId <= 0) continue;
            const sameSkill = !!before && before.skillId === s.skillId;
            if (sameSkill && s.level <= before.level) continue;
            added.push({
                seq: this.skills.length + added.length + 1,
                id: s.skillId,
                name: this.skillName(s.skillId),
                level: s.level,
                kind: sameSkill ? 'upgrade' : ((before && before.skillId > 0) ? 'replace' : 'learn'),
                replacedId: (!sameSkill && before && before.skillId > 0) ? before.skillId : undefined,
                slot: i,
                at: this.elapsed(),
                stage: this.stage(),
            });
        }
        if (heroEvolve && added.length) added[added.length - 1].kind = 'hero_evolve';
        for (const r of added) this.skills.push(r);
        this.lastSlots = slots.map((s) => ({ skillId: s.skillId, level: s.level, locked: !!s.locked }));
    }

    /**
     * 一条 Modifier 挂到了英雄身上（宿主订阅 `OnModifierAdded` 后调）。
     *
     * 只对**限时 / 即刻**（`duration >= 0`）的实例记账 —— 永久实例（`-1`）就是遗物 / 神器本身，
     * 那两条线各有自己的账本，再记一遍只会把同一件事数两遍。
     */
    onModifierAdded(modifierId: number, origin: string, duration: number, stackCount = 1): void {
        const d = Number(duration);
        if (!(d >= 0)) return;
        const key = `${modifierId}|${origin ?? ''}`;
        let rec = this.buffIndex[key];
        if (!rec) {
            rec = {
                id: modifierId,
                name: this.modifierName(modifierId),
                origin: String(origin ?? ''),
                source: this.sourceOf(String(origin ?? '')),
                times: 0,
                firstAt: this.elapsed(),
                duration: d,
                stacks: 0,
            };
            this.buffIndex[key] = rec;
            this.buffs.push(rec);
        }
        rec.times++;
        rec.stacks += Math.max(1, Math.floor(Number(stackCount) || 1));
    }

    /* ===================================================================
     * 阶段时间线
     * =================================================================== */

    /**
     * 进入新阶段（宿主在 `checkStage` 的阶段号真的变了之后调）。
     *
     * 收上一段（算出这段里的击杀与金币增量），再开一段新的 —— 于是报告能回答
     * 「第 3 阶段为什么突然打不动了」这类问题（那一段的金币 / 击杀 / 用时都摆在那儿）。
     */
    noteStage(stage: number, elapsed: number): void {
        const last = this.stages[this.stages.length - 1];
        if (last && last.stage === stage) return;
        if (last) {
            last.to = elapsed;
            last.kills = this.totalKills() - this.stageKillMark;
            last.gold = this.goldIncomeTotal() - this.stageGoldMark;
        }
        this.stageKillMark = this.totalKills();
        this.stageGoldMark = this.goldIncomeTotal();
        this.stages.push({ stage, from: elapsed, to: elapsed, kills: 0, gold: 0 });
    }

    /* ===================================================================
     * 收尾：报告
     * =================================================================== */

    /**
     * 一局结束：生成报告 → 打印 → 挂到全局。**一局只会真正打一份**（见 `reported`）。
     *
     * 两个调用点（都由宿主接）：
     *   · `endRun()` —— 打赢 / 打输的正常收尾；
     *   · `exit()` —— **中途退出**（HUD 退出按钮、没打完就回主界面）。
     *     后者不是一次"对局结束"（不碰任务进度 / 结算奖励），只是**账本到此为止**；
     *     宿主那侧带 `hasReported()` 判断，所以"打完 → 点确定 → exit"不会被重复收尾。
     *
     * ⚠ **这是"读真源"的唯一时机**：属性分解要走 `hero.modifiers.getAll()`，而英雄实体在
     *   `exit()` 里会被作废 —— 所以必须在 `endRun()` 里、`exit()` 的清理动作之前调。
     *
     * ⚠ 本方法**绝不抛**：它跑在 `endRun()`（可能来自 `DamagePipeline` 的 OnDeath 回放栈）
     *   与 `exit()`（正在切场景）里，抛出去最轻是"这一局的账没了"，最重是**打断结算 / 切场景**。
     *   失败时降级成「裸账本」并且一定在控制台留下**看得见的**一行 —— 静默无输出是最坏的失败模式。
     *
     * @returns 结构化报告；**连裸账本都拼不出来时返回 `null`**（此时控制台已经有报错与兜底文本）
     */
    finishRun(info: RunEndInfo): RunStatsReport | null {
        if (this.reported) {
            this.print(`[统计] 本局报告已经打印过，这次收尾已忽略（换局会自动复位）`
                + ` —— 本次调用：${String(info?.result ?? '?')}/${String(info?.reason ?? '')}`);
            return this.lastReport;
        }
        this.reported = true;

        const report = this.renderAndPrint(info);
        if (!report) return null;
        this.lastReport = report;

        try {
            if (this.deps.publish) {
                this.deps.publish(report);
            } else {
                // 挂全局而不是要求外部 import 本模块：控制台一句
                // `copy(JSON.stringify(window.__runStats))` 就能拿到整份 JSON。
                // ⚠ 不用 `globalThis`（工程 lib 只到 ES2015，没有这个声明），走 `window` + 兜底。
                const g: any = (typeof window !== 'undefined') ? window : undefined;
                if (g) g.__runStats = report;
            }
        } catch (e) {
            // 挂全局失败（某些平台没有 window）只是"拿不到结构化数据"，绝不能因此中断结算
            console.warn('[统计] 结构化报告挂载失败', e);
        }
        return report;
    }

    /**
     * **随时催一份当前账本**（控制台 `__runStatsDump()`）—— 边打边看，不必先打完这一局。
     *
     * 与 `finishRun` 的两个区别（都是刻意的）：
     *   · **不置「已打印」标记**：所以催过之后，本局真正结束那一次照样会打完整报告；
     *   · **不挂全局、不改任何状态**：它连 `lastReport` 都只是顺手更新，纯粹是"打印一下现在"。
     */
    dumpRun(info: RunEndInfo): RunStatsReport | null {
        const report = this.renderAndPrint(info);
        if (report) this.lastReport = report;
        return report;
    }

    /** 本局账本是否已经收尾打印过（宿主 `exit()` 靠它决定要不要补一份"中途退出"） */
    hasReported(): boolean {
        return this.reported;
    }

    /**
     * 生成 → 打印（唯一的口径在 `finishRun` / `dumpRun` 之间共用）。
     *
     * 两段 try 分开：`buildReport`（读配表 + 遍历 Modifier，最可能出事的一段）与
     * `formatReport`（纯文本拼装）哪一个失败，都降级到**只用账本里的原生数字**拼的「裸账本」——
     * 那份东西读不出"加成是谁给的"，但金币/击杀/等级/阶段这些"成长是否合理"的主干读数一个不少。
     */
    private renderAndPrint(info: RunEndInfo): RunStatsReport | null {
        let report: RunStatsReport | null = null;
        try {
            report = this.buildReport(info);
        } catch (err) {
            this.printFail('生成报告时出错（属性分解 / 读配表）', err);
            this.print(this.formatRawLedger(info));
            return null;
        }
        try {
            this.print(this.formatReport(report));
        } catch (err) {
            this.printFail('格式化报告文本时出错', err);
            this.print(this.formatRawLedger(info));
        }
        return report;
    }

    /** 把一行"出事了"写得足够显眼（`err.stack` 一并带上，省得还要去翻别处） */
    private printFail(what: string, err: any): void {
        const msg = (err && err.message) ? String(err.message) : String(err);
        const stack = (err && err.stack) ? String(err.stack) : '';
        this.print(`\n!!!!!! [统计] ${what} —— 本局完整报告生成失败 !!!!!!\n`
            + `  原因: ${msg}\n`
            + (stack ? `  栈  : ${stack.split('\n').slice(0, 4).join('\n        ')}\n` : '')
            + `  下面是**裸账本**（只用账本里的原生数字，读不出"加成是谁给的"，但主干读数都在）\n`);
    }

    /**
     * 兜底文本：**只碰本类自己攒的原生数字**（不读英雄实体、不读配表）——
     * 正因为完整报告失败的原因十有八九就在那两处。
     */
    private formatRawLedger(info: RunEndInfo): string {
        const L: string[] = [];
        const line = (s = '') => L.push(s);
        const kills = this.totalKills();
        const elapsed = Math.max(0, Number(info?.elapsed) || 0);
        const income = this.goldIncomeTotal();
        line('='.repeat(78));
        line(' [统计] 裸账本（RunStats · 完整报告生成失败时的兜底）');
        line('='.repeat(78));
        line(`  英雄     : ${this.heroName || '—'}(${this.heroId || '—'}) · 难度 ${this.difficulty()} · ${this.mode() || '—'}`);
        line(`  结果     : ${resultText(info?.result)}（${String(info?.reason ?? '')}）· 存活 ${num(elapsed, 1)}s · 到达阶段 ${Number(info?.stage) || 0}`);
        line(`  等级     : Lv.${Number(info?.level) || 1}（经验 ${Number(info?.exp) || 0}/${Number(info?.expToNext) || 0}）`);
        line(`  击杀     : ${kills} 只 · 造成伤害 ${Math.round(this.damageDealt)} · 承受伤害 ${Math.round(this.damageTaken)} · 暴击 ${this.crits}`);
        line(`  金币     : 收入 ${num(income)} = 开局 ${num(this.goldSeed)} + 击杀 ${num(this.goldFromKills)} + 其它 ${num(this.goldFromOther)}`
            + `；支出 ${num(this.goldSpentTotal)}（抽取 ${num(this.goldSpentOnDraws)} + 选人 ${num(Math.max(0, this.goldSpentTotal - this.goldSpentOnDraws))}）`
            + `；结余 ${Math.round(Number(info?.goldBalance) || 0)}`);
        line(`  击杀数   : 收入 ${num(this.killPointsSeed + this.killPointsFromKills)}；支出 ${num(this.killPointsSpent)}；结余 ${Math.round(Number(info?.killPointsBalance) || 0)}`);
        line(`  收获     : 遗物 ${this.relics.length} 件 · 神器 ${this.artifacts.length} 层 / ${Object.keys(this.artifactStacks).length} 种`
            + ` · 掉落 Buff ${this.battleItems.length} 次 · 技能变化 ${this.skills.length} 次 · 抽取 ${this.rolls.length} 轮`);
        line('='.repeat(78));
        return L.join('\n');
    }

    /** 组装结构化报告（不打印、不挂全局；体检脚本 / 回放也可以直接调它） */
    buildReport(info: RunEndInfo): RunStatsReport {
        const elapsed = Math.max(0, Number(info?.elapsed) || 0);
        const hero = info?.hero ?? null;
        const attributes = this.pickAttrRows(hero);
        const kills = this.totalKills();
        // 收尾：把最后一段阶段补完（它还在进行中，to === from）
        const lastStage = this.stages[this.stages.length - 1];
        if (lastStage && lastStage.to <= lastStage.from) {
            lastStage.to = elapsed;
            lastStage.kills = kills - this.stageKillMark;
            lastStage.gold = this.goldIncomeTotal() - this.stageGoldMark;
        }
        const goldIncome = this.goldIncomeTotal();
        const artifactLevels = this.artifactLevels();
        return {
            meta: {
                heroId: this.heroId,
                heroName: this.heroName,
                difficulty: this.difficulty(),
                mode: this.mode(),
                speedMul: this.speedMul(),
                result: String(info?.result ?? '?'),
                reason: String(info?.reason ?? ''),
                elapsed,
                stage: Number(info?.stage) || 0,
                maxPhase: this.maxPhase(),
                level: Number(info?.level) || 1,
                exp: Number(info?.exp) || 0,
                expToNext: Number(info?.expToNext) || 0,
                hp: hero ? Math.round(hero.hp) : 0,
                maxHp: hero ? Math.round(hero.attrs.get(1)) : 0,
                achieveSnapshot: this.cloneRecord(this.achieveSnapshot),
                attributesFromSnapshot: this.usedAttrSnapshot,
            },
            gold: {
                seed: this.goldSeed,
                fromKills: this.goldFromKills,
                fromOther: this.goldFromOther,
                incomeTotal: goldIncome,
                spentOnDraws: this.goldSpentOnDraws,
                spentOnHeroSelect: Math.max(0, this.goldSpentTotal - this.goldSpentOnDraws),
                spentTotal: this.goldSpentTotal,
                balance: Math.round(Number(info?.goldBalance) || 0),
            },
            killPoints: {
                seed: this.killPointsSeed,
                fromKills: this.killPointsFromKills,
                spent: this.killPointsSpent,
                balance: Math.round(Number(info?.killPointsBalance) || 0),
            },
            exp: {
                fromKills: this.expFromKills,
                fromOther: this.expFromOther,
                fromStartBonus: this.expFromStartBonus,
                total: this.expFromKills + this.expFromOther + this.expFromStartBonus,
                level: Number(info?.level) || 1,
                levelUps: this.levelUps.slice(),
            },
            combat: {
                kills,
                killsByUnit: this.killByUnitList(),
                damageDealt: Math.round(this.damageDealt),
                damageTaken: Math.round(this.damageTaken),
                crits: this.crits,
                dps: elapsed > 0 ? Math.round(this.damageDealt / elapsed) : 0,
                killsPerMin: perMin(kills, elapsed),
                revives: this.revives.slice(),
            },
            attributes,
            attrBase: {
                config: this.cloneRecord(this.attrConfigBase),
                outerFlat: this.cloneRecord(this.attrOuterFlat),
                outerPercent: this.cloneRecord(this.attrOuterPercent),
                growth: this.cloneRecord(this.attrGrowth),
            },
            relics: {
                count: this.relics.length,
                byRarity: this.relicRarityCount(),
                list: this.relics.slice(),
            },
            artifacts: {
                kinds: Object.keys(artifactLevels).length,
                levels: this.artifacts.length,
                spent: this.killPointsSpent,
                list: this.artifacts.slice(),
                byId: artifactLevels,
            },
            battleItems: {
                dropped: this.countItemAction('drop'),
                used: this.countItemAction('use'),
                rejected: this.countItemAction('reject'),
                list: this.battleItems.slice(),
            },
            buffs: this.buffs.slice(),
            skills: this.skills.slice(),
            finalSkillSlots: (info?.skillSlots ?? []).map((s, i) => ({
                slot: i,
                skillId: Number(s?.skillId) || 0,
                name: (Number(s?.skillId) || 0) > 0 ? this.skillName(s.skillId) : '',
                level: Number(s?.level) || 0,
                locked: !!s?.locked,
            })),
            rolls: this.rolls.slice(),
            rollSummary: this.rollSummary(),
            stages: this.stages.slice(),
            bosses: this.bosses.slice(),
            rates: {
                goldPerMin: perMin(goldIncome, elapsed),
                expPerMin: perMin(this.expFromKills + this.expFromOther, elapsed),
                killsPerMin: perMin(kills, elapsed),
                levelsPerMin: perMin(Math.max(0, (Number(info?.level) || 1) - 1), elapsed),
                relicsPerMin: perMin(this.relics.length, elapsed),
            },
        };
    }

    /* ===================================================================
     * 属性分解（报告的核心）
     * =================================================================== */

    /**
     * 拍一张**当前属性分解**的快照（宿主在"属性可能刚变过"或"英雄要死了"的时点调）。
     *
     * 目前两个调用点：
     *   ① `OnTakeDamage` 里发现这一击是**致命伤**（`hero.hp <= 0`）→ 趁 Modifier 还在赶紧拍一张
     *      （见 `cachedAttrRows` 的注释：`Die()` 会清空 Modifier，晚一步就什么都读不到了）；
     *   ② 每次遗物到手 / 神器买到之后 → 让快照始终接近最新（纯保险，代价是几十次只读遍历）。
     *
     * 幂等、无副作用：只是把 `buildAttrRows` 的结果存下来。
     */
    snapshotAttributes(hero: RunStatsHero | null): void {
        if (!hero || !hero.attrs) return;
        this.cachedAttrRows = this.buildAttrRows(hero);
    }

    /**
     * 收尾时该用哪一份属性分解：**现场读优先，读不到才回落死前快照**。
     *
     * 判据是"现场读到的贡献条数"而不是"英雄死没死"：`boss_timeout`（阶段超时判负）时英雄**还活着**、
     * Modifier 一个不少，现读就是最准的；只有英雄阵亡那条路上 Modifier 已被 `Die()` 清空，
     * 才会读到 0 条贡献 —— 那时才需要快照。
     */
    private pickAttrRows(hero: RunStatsHero | null): AttrStatRow[] {
        const live = this.buildAttrRows(hero);
        let contributions = 0;
        for (const row of live) contributions += row.mods.count;
        if (contributions > 0) {
            this.usedAttrSnapshot = false;
            return live;
        }
        if (this.cachedAttrRows && this.cachedAttrRows.length) {
            this.usedAttrSnapshot = true;
            return this.cachedAttrRows;
        }
        this.usedAttrSnapshot = false;
        return live;
    }

    /**
     * 现场读英雄实体，把每个属性拆成
     * `基础(配置 + 局外 + 成长) → ×(1+Σ百分比) + Σ固定值 → 最终`，并按来源分列。
     *
     * ⚠ 占比最大的那些数值来自 **Modifier 实例**（遗物 / 神器 / 掉落 Buff / 技能各持独立实例），
     *   所以这里遍历的是 `hero.modifiers.getAll()` 而**不是** `AttributeSystem` 的私有贡献表 ——
     *   后者只有合并后的总数，回答不了"这条加成是谁给的"。
     */
    buildAttrRows(hero: RunStatsHero | null): AttrStatRow[] {
        const rows: AttrStatRow[] = [];
        const mods = (hero && hero.modifiers && hero.modifiers.getAll) ? hero.modifiers.getAll() : [];
        for (const id of this.attrIds(mods)) {
            const bySource = emptyBySource();
            const total = emptyBucket();
            for (const m of mods) {
                let affected: number[] = [];
                try {
                    affected = m.GetAffectedAttributes() ?? [];
                } catch (e) {
                    affected = [];
                }
                if (affected.indexOf(id) < 0) continue;
                const c = m.GetModifierProperty(id);
                if (!c) continue;
                const mode = c.mode ?? this.defaultStackMode(id);
                // ⚠ 数值换算必须与 `AttributeSystem.combine` 里的 `toRuntime` 同一套：
                //   percent 是**百分数**（`14` = +14%，不走 AttributeScaling）；其余四种
                //   一律过 `AttributeScaling.normalize`（倍率型属性 int → float：攻速 20 → 0.2）。
                //   只在 add 那一支换算是个真 bug，`audit:stats` 的 A 段当场抓到：补数（魔抗 25）
                //   与优者（暴击倍率 180）会被记成 25 / 180 —— 一堆"看起来像绝对值"的脏数。
                const v = mode === AttributeStackMode.Percent
                    ? c.value
                    : AttributeScaling.normalize(id, c.value);
                this.addToBucket(bySource[this.sourceOf(String(m.origin ?? ''))], mode, v);
                this.addToBucket(total, mode, v);
            }
            const configBase = this.attrConfigBase[String(id)] ?? 0;
            const outerFlat = this.attrOuterFlat[String(id)] ?? 0;
            const outerPercent = this.attrOuterPercent[String(id)] ?? 0;
            const base = hero ? hero.attrs.getBase(id) : configBase;
            const final = hero ? hero.attrs.get(id) : base;

            // 线性近似：与 AttributeSystem.combine 的前三步同序（percent → add → multiply）
            let approx: number | null = base;
            if (total.percent) approx *= 1 + total.percent / 100;
            if (total.add) approx += total.add;
            if (total.multiply) approx *= 1 + total.multiply;
            // 补数乘法（`final = 1 - (1-base)·Π(1-v)`）与优者生效（取 max）都不是线性的，
            // 硬凑一个近似值只会制造假警报 —— 直接标 null，报告写"不做线性近似"
            if (total.complement || total.best) approx = null;

            rows.push({
                id,
                name: this.attrName(id),
                configBase,
                outerFlat,
                outerPercent,
                outerAbs: configBase * outerPercent + outerFlat,
                growth: this.attrGrowth[String(id)] ?? 0,
                base,
                mods: total,
                bySource,
                final,
                approx,
                approxDelta: approx === null ? null : approx - final,
                clampMin: this.attrClamp(id).min,
                clampMax: this.attrClamp(id).max,
                clamped: this.clampState(approx, final),
            });
        }
        return rows;
    }

    /** 把一条贡献按叠加方式累加进桶（数值口径见文件头 ③） */
    private addToBucket(b: AttrBonusBucket, mode: AttributeStackMode, rawValue: number): void {
        const v = Number(rawValue) || 0;
        b.count++;
        switch (mode) {
            case AttributeStackMode.Percent:
                // 配置值是百分数（14 = +14%）→ 按百分点累计（combine 里是 `v / 100`）
                b.percent += v;
                break;
            case AttributeStackMode.Multiply:
                // 配置值经 AttributeScaling 换算是运行时小数（20 → 0.2 = ×1.2）。
                // 多条乘算是复利（combine 里 `factor *= 1 + v`）→ 存「复合系数 − 1」
                b.multiply = (1 + b.multiply) * (1 + v) - 1;
                break;
            case AttributeStackMode.Complement:
                // 补数乘法也是复利：`survive *= 1 - v` → 存 `1 - Π(1-v)`
                b.complement = 1 - (1 - b.complement) * (1 - v);
                break;
            case AttributeStackMode.Best:
                b.best = Math.max(b.best, v);
                break;
            default:
                // add（含未标注 mode 时的默认叠加方式）：换成运行时单位，才与「最终值」可比
                b.add += v;
                break;
        }
    }

    /**
     * 参与统计的属性 id 全集 = `AttributeTypeName` 的键 ∪ 三个基座落点里的键 ∪ **Modifier 贡献里出现过的 id**。
     *
     * 取并集而不是只认代码里的枚举（`AttributeTypeName`）：表里新加了属性、但忘了往代码那张表里补一条时，
     * 报告**不会静默漏掉**它 —— 那正是"加了却看不见"这一类 bug 的温床。
     * Modifier 那一份尤其重要：漏了它，一条指向新属性的遗物会连一行都不出现（而 `attributes.json`
     * 里有名字、`final` 也读得到，唯独报告里查无此属性）。
     *
     * @param mods 英雄身上的 Modifier（`buildAttrRows` 传进来；不传时只枚举代码与基座）
     */
    private attrIds(mods: RunStatsModifier[] = []): number[] {
        const seen: Record<string, boolean> = {};
        const out: number[] = [];
        const push = (n: number) => {
            if (!Number.isFinite(n) || n <= 0) return;
            const k = String(n);
            if (seen[k]) return;
            seen[k] = true;
            out.push(n);
        };
        for (const k of Object.keys(AttributeTypeName)) push(Number(k));
        for (const k of Object.keys(this.attrConfigBase)) push(Number(k));
        for (const k of Object.keys(this.attrGrowth)) push(Number(k));
        for (const k of Object.keys(this.attrOuterFlat)) push(Number(k));
        for (const k of Object.keys(this.attrOuterPercent)) push(Number(k));
        for (const m of mods) {
            let list: number[] = [];
            try {
                list = m.GetAffectedAttributes() ?? [];
            } catch (e) {
                list = [];
            }
            for (const id of list) push(Number(id));
        }
        out.sort((a, b) => a - b);
        return out;
    }

    /**
     * 属性的**上下限**（`attributes.json` 的 `min` / `max`，都是**配置 int 口径**）。
     *
     * ⚠ 必须过 `AttributeScaling.normalize` 才能与 `final` / `approx` 比：
     *   表里攻速写的是 `max: 500`，而运行时口径是 `5.0` —— 拿 500 去比永远判不出"卡上限"。
     */
    private attrClamp(id: number): { min?: number; max?: number } {
        try {
            const cfg = TbRoot.ins.getTbContainer(AttributeCfgContainer).getCfgById(id);
            if (!cfg) return {};
            const out: { min?: number; max?: number } = {};
            if (typeof cfg.min === 'number') out.min = AttributeScaling.normalize(id, cfg.min);
            if (typeof cfg.max === 'number') out.max = AttributeScaling.normalize(id, cfg.max);
            return out;
        } catch (e) {
            return {};
        }
    }

    /**
     * 最终值是不是被上下限卡住了 —— **判据是"算出来的值被改过"**，不是"等于 min/max"。
     *
     * 为什么不能写成 `final === max`：大批属性的 `min` 就是 `0`，而"基础 0、没有加成"时
     * `final` 也正好是 `0` —— 那种写法会把**每一条没加成的属性**都标成"顶到下限"，
     * 报告立刻被 ⛔ 淹没（`audit:stats` 的 --print 预览当场暴露过这一条）。
     *
     * 正确的判据：线性近似值（= `AttributeSystem.combine` 未钳制时的结果）与 `final` 不同，
     * 就说明被钳制改过 —— 差的方向还顺带告诉我们撞的是上限还是下限。
     */
    private clampState(approx: number | null, final: number): 0 | 1 | -1 {
        // 含补数 / 优者叠加时近似值本就为 null（算不出来），这种情况不判钳制
        if (approx === null) return 0;
        const eps = Math.max(1e-6, Math.abs(approx) * 0.001);
        if (final < approx - eps) return 1;    // 被压下来了 → 撞上限
        if (final > approx + eps) return -1;   // 被抬上去了 → 撞下限
        return 0;
    }

    /** 属性显示名（优先配表 `attributes.json.name`，回落代码里的 `AttributeTypeName`） */
    private attrName(id: number): string {
        const key = String(id);
        if (this.attrNameCache[key]) return this.attrNameCache[key];
        let name = '';
        try {
            const cfg = TbRoot.ins.getTbContainer(AttributeCfgContainer).getCfgById(id);
            if (cfg && cfg.name) name = cfg.name;
        } catch (e) { /* 配表未加载：走下面的兜底 */ }
        if (!name) name = (AttributeTypeName as Record<number, string>)[id] ?? `属性${id}`;
        this.attrNameCache[key] = name;
        return name;
    }

    /**
     * 属性的**默认叠加方式**（`attributes.json.stack_mode`）。
     *
     * 只有当一条贡献**没标 mode** 时才用它 —— 标了 mode 的（遗物 / 神器 / 道具的
     * `kv.attrs` 第三项）一律以标注为准。配表读不到时回落 `add`
     * （现表 22 条里 16 条 add、3 条 multiply、2 条 complement、1 条 best）。
     */
    private defaultStackMode(id: number): AttributeStackMode {
        try {
            const cfg = TbRoot.ins.getTbContainer(AttributeCfgContainer).getCfgById(id);
            if (cfg && cfg.stack_mode) return cfg.stack_mode;
        } catch (e) { /* 配表未加载 */ }
        return AttributeStackMode.Add;
    }

    /** `origin` 前缀 → 来源分类（见 `AttrSourceKey` 的注释） */
    private sourceOf(origin: string): AttrSourceKey {
        const o = origin || '';
        if (o.indexOf('relic:') === 0) return 'relic';
        if (o.indexOf('killbuff:') === 0) return 'artifact';
        if (o.indexOf('item:') === 0) return 'battleItem';
        if (o.indexOf('ability:') === 0) return 'skill';
        return 'other';
    }

    /* ===================================================================
     * 名字查询（都带兜底：配表读不到就退回 id，绝不抛）
     * =================================================================== */

    /** 遗物 `modifiers_inner` → 可读加成摘要（与游戏内真正挂载的是同一份数据） */
    private describeRelicBonuses(cfg: any): string {
        const out: string[] = [];
        for (const e of (cfg?.modifiers_inner ?? [])) {
            const attrs = e?.kv?.attrs;
            if (!attrs || !attrs.length) {
                out.push('机制/脚本效果');
                continue;
            }
            for (const a of attrs) {
                if (!a) continue;
                const id = Number(a[0]);
                const raw = a[1];
                const mode = (a[2] as AttributeStackMode) ?? this.defaultStackMode(id);
                const name = this.attrName(id);
                if (typeof raw !== 'number') { out.push(`${name} 变量`); continue; }
                if (mode === AttributeStackMode.Percent) out.push(`${name} ${pctText(raw, 0)}`);
                else out.push(`${name} ${signed(AttributeScaling.normalize(id, raw), 2)}`);
            }
        }
        return out.length ? out.join(' / ') : '（无声明式属性加成：纯机制件或配表缺失）';
    }

    /**
     * 神器的叠加方式 —— 口径**必须与 `BuffShop.STAT_MODE` 一致**（那里是唯一真源）。
     * 这里按同样的规则复算一遍只为了在报告里标注 `add` / `percent`；
     * 两者漂移时的表现只是"报告上标错了一列"，不影响战斗（战斗侧读的是 `BuffShop` 那份）。
     */
    private artifactMode(cfg: any): 'add' | 'percent' {
        const stat = String(cfg?.stat ?? '');
        if (stat === 'regen' || stat === 'crit' || stat === 'dodge' || stat === 'def') return 'add';
        if (stat === 'special') return 'add';
        return 'percent';
    }

    private skillName(id: number): string {
        try {
            const cfg = ShopConfig.getAbility(id);
            if (cfg && cfg.name) return cfg.name;
        } catch (e) { /* 配表未加载 */ }
        return `技能${id}`;
    }

    private modifierName(id: number): string {
        try {
            const def = TbRoot.ins.getTbContainer(ModifierCfgContainer).getCfgById(id);
            if (def && def.name) return def.name;
        } catch (e) { /* 配表未加载 */ }
        return `Modifier#${id}`;
    }

    /** 单位名（击杀统计兜底用；宿主传空时才查配表） */
    private unitName(id: number): string {
        try {
            const cfg = TbRoot.ins.getTbContainer(UnitCfgContainer).getCfgById(id);
            if (cfg && cfg.name) return cfg.name;
        } catch (e) { /* 配表未加载 */ }
        return `单位${id}`;
    }

    /* ===================================================================
     * 内部小工具
     * =================================================================== */

    private elapsed(): number {
        const v = Number(this.deps.getElapsed?.() ?? 0);
        return Number.isFinite(v) ? v : 0;
    }

    private stage(): number {
        const v = Number(this.deps.getStage?.() ?? 0);
        return Number.isFinite(v) ? v : 0;
    }

    private difficulty(): number {
        const v = Number(this.deps.getDifficulty?.() ?? 1);
        return Number.isFinite(v) ? v : 1;
    }

    private mode(): string {
        return String(this.deps.getMode?.() ?? '');
    }

    private maxPhase(): number {
        const v = Number(this.deps.getMaxPhase?.() ?? 0);
        return Number.isFinite(v) ? v : 0;
    }

    private speedMul(): number {
        const v = Number(this.deps.getSpeedMul?.() ?? 1);
        return Number.isFinite(v) && v > 0 ? v : 1;
    }

    private print(text: string): void {
        if (this.deps.print) this.deps.print(text);
        else console.log(text);
    }

    private goldIncomeTotal(): number {
        return this.goldSeed + this.goldFromKills + this.goldFromOther;
    }

    /** 本局累计击杀（= 按怪种统计之和；阶段增量靠它现算） */
    private totalKills(): number {
        let n = 0;
        for (const k of Object.keys(this.killByUnit)) n += this.killByUnit[k].count;
        return n;
    }

    private killByUnitList(): RunKillByUnit[] {
        const list: RunKillByUnit[] = [];
        for (const k of Object.keys(this.killByUnit)) list.push(this.killByUnit[k]);
        list.sort((a, b) => b.count - a.count);
        return list;
    }

    private countItemAction(action: string): number {
        let n = 0;
        for (const r of this.battleItems) if (r.action === action) n++;
        return n;
    }

    private relicRarityCount(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const r of this.relics) out[r.rarity] = (out[r.rarity] ?? 0) + 1;
        return out;
    }

    private artifactLevels(): Record<string, { name: string; level: number; maxLevel: number }> {
        const out: Record<string, { name: string; level: number; maxLevel: number }> = {};
        for (const k of Object.keys(this.artifactStacks)) {
            const s = this.artifactStacks[k];
            out[k] = { name: s.name, level: s.level, maxLevel: s.maxLevel };
        }
        return out;
    }

    /** 抽取统计汇总（付费通道 / 候选种类 / 品质分布） */
    private rollSummary(): RunStatsReport['rollSummary'] {
        let paid = 0, viaAd = 0, viaTicket = 0, optionsRelic = 0, optionsSkill = 0;
        for (const r of this.rolls) {
            if (r.via === 'gold') paid++;
            else if (r.via === 'ad') viaAd++;
            else viaTicket++;
            for (const o of r.options) {
                if (o.kind === 'skill') optionsSkill++;
                else optionsRelic++;
            }
        }
        return {
            total: this.rolls.length,
            paid, viaAd, viaTicket,
            goldSpent: this.goldSpentOnDraws,
            optionsTotal: optionsRelic + optionsSkill,
            optionsRelic, optionsSkill,
            raritySeen: this.cloneRecord(this.raritySeen),
        };
    }

    private cloneRecord(src: Record<string, number>): Record<string, number> {
        const out: Record<string, number> = {};
        const s = src ?? {};
        for (const k of Object.keys(s)) out[k] = s[k];
        return out;
    }

    /* ===================================================================
     * 文本报告
     * =================================================================== */

    /**
     * 结构化报告 → **一整块纯文本**（一次 `console.log` 打出，方便整段复制给 AI）。
     *
     * 分节顺序是刻意的：先「我这一局是什么」（元信息），再「钱和等级」（经济），
     * 然后「属性到底长在哪」（属性），最后才是逐条流水（遗物 / 神器 / 道具 / 技能 / Buff）。
     * 分析成长合理性时通常只需要看前四节。
     */
    formatReport(rep: RunStatsReport): string {
        const L: string[] = [];
        const line = (s = '') => L.push(s);
        const bar = '='.repeat(78);

        line(bar);
        line(' 局内成长统计报告（RunStats）');
        line(bar);

        /* ── 1. 元信息 ── */
        const m = rep.meta;
        line('[1] 基本信息');
        line(`  英雄     : ${m.heroName}(${m.heroId})`);
        line(`  难度/模式: 难度 ${m.difficulty} · ${m.mode || '—'} · 倍速 ${m.speedMul}x`);
        line(`  结果     : ${resultText(m.result)}（${m.reason}）· 存活 ${num(m.elapsed, 1)}s · 到达阶段 ${m.stage}${m.maxPhase ? `/${m.maxPhase}` : '（无尽）'}`);
        if (m.result === 'abort') {
            line('  ⚠ 注意     : 这一局**没打完**（中途退出 / 手动催一份），下面的读数只到收尾那一刻 —— 别拿它跟整局比');
        }
        line(`  终局状态 : Lv.${m.level}（经验 ${num(m.exp)}/${num(m.expToNext)}）· 生命 ${m.hp}/${m.maxHp}`);
        const achKeys = Object.keys(m.achieveSnapshot);
        line(`  成就快照 : ${achKeys.length ? achKeys.map((k) => `${k}=${num(m.achieveSnapshot[k], 2)}`).join(' / ') : '（无）'}`);
        if (m.attributesFromSnapshot) {
            line('  ⚠ 注意     : 英雄阵亡时 Modifier 已被清空，下面的【属性总览】读的是**致命一击前一刻**的快照');
        }
        line('');

        /* ── 2. 经济 ── */
        const g = rep.gold;
        line('[2] 经济（金币 / 击杀数 / 经验）');
        line(`  金币收入 : 合计 ${num(g.incomeTotal)} = 开局 ${num(g.seed)} + 击杀 ${num(g.fromKills)} + 技能/遗物 ${num(g.fromOther)}`);
        line(`  金币支出 : 合计 ${num(g.spentTotal)} = 遗物抽取 ${num(g.spentOnDraws)} + 选人刷新 ${num(g.spentOnHeroSelect)}`);
        line(`  金币结余 : ${num(g.balance)}`);
        const kp = rep.killPoints;
        line(`  击杀数   : 收入 ${num(kp.seed + kp.fromKills)} = 开局 ${num(kp.seed)} + 击杀 ${num(kp.fromKills)}；支出 ${num(kp.spent)}；结余 ${num(kp.balance)}`);
        const e = rep.exp;
        line(`  局内经验 : 合计 ${num(e.total)} = 击杀 ${num(e.fromKills)} + 遗物/技能 ${num(e.fromOther)} + 成就开局 ${num(e.fromStartBonus)} → Lv.${e.level}`);
        if (e.levelUps.length) {
            line(`  升级时刻 : ${e.levelUps.map((u) => `Lv.${u.level}@${num(u.at, 0)}s(P${u.stage})`).join(' ')}`);
        }
        line('');

        /* ── 3. 战斗力与速率 ── */
        const c = rep.combat;
        const r = rep.rates;
        line('[3] 战斗与速率');
        line(`  击杀 ${num(c.kills)} 只 · 造成伤害 ${num(c.damageDealt)} · 承受伤害 ${num(c.damageTaken)} · 暴击 ${num(c.crits)} 次`);
        line(`  DPS ${num(c.dps)} · 击杀/分 ${num(c.killsPerMin, 1)} · 金币/分 ${num(r.goldPerMin, 0)} · 经验/分 ${num(r.expPerMin, 0)}`
            + ` · 升级/分 ${num(r.levelsPerMin, 2)} · 遗物/分 ${num(r.relicsPerMin, 2)}`);
        if (c.killsByUnit.length) {
            line('  按怪种   : ' + c.killsByUnit
                .map((k) => `${k.name}×${k.count}(+${k.points}点/+${Math.round(k.gold)}金/+${Math.round(k.exp)}经验)`)
                .join('  '));
        }
        if (c.revives.length) {
            line(`  复活     : ${c.revives.map((v) => `${v.kind}@${num(v.at, 0)}s`).join(' / ')}`);
        }
        line('');

        /* ── 4. 属性总览（核心） ── */
        line('[4] 属性总览');
        line('    口径：倍率型属性（4/7/8/11/12/14/15/21~25）是小数（1.4 = 140%）；「%总」列单位是百分点；');
        line('          「局外+ / 成长+ / Mod固定+」三列都是**运行时绝对量**，加到「基础」上就是「最终」（近似）；');
        line('          「最终」列带 ⛔ = 已经顶到配表上下限（这一项后面的成长全是白涨的，详见下面的明细行）。');
        line('  ' + padEnd('属性', 14) + padStart('配置基础', 9) + padStart('局外+', 9) + padStart('成长+', 9)
            + padStart('基础', 9) + padStart('Mod固定+', 10) + padStart('%总', 9) + padStart('最终', 11));
        for (const row of rep.attributes) {
            line('  ' + padEnd(`${row.id} ${row.name}`, 14)
                + padStart(num(row.configBase, 2), 9)
                + padStart(signed(row.outerAbs, 2), 9)
                + padStart(signed(row.growth, 2), 9)
                + padStart(num(row.base, 2), 9)
                + padStart(signed(row.mods.add, 2), 10)
                + padStart(pctText(row.mods.percent, 1), 9)
                + padStart(num(row.final, 2) + (row.clamped ? '⛔' : ''), 11));
        }
        line('');
        line('  逐属性来源明细（只列有加成的属性；「固定/百分比/乘算」都是 Modifier 贡献）：');
        let detailRows = 0;
        for (const row of rep.attributes) {
            if (bucketEmpty(row.mods) && !row.outerFlat && !row.outerPercent && !row.growth) continue;
            detailRows++;
            const approxNote = row.approx === null
                ? '  [含补数/优者叠加，不做线性近似]'
                : (Math.abs(row.approxDelta ?? 0) > Math.max(0.01, Math.abs(row.final) * 0.001)
                    ? `  ⚠ 线性近似 ${num(row.approx, 2)}（差 ${signed(row.approxDelta ?? 0, 2)}${row.clamped ? '；已撞' + (row.clamped > 0 ? '上限' : '下限') + '，超出部分是白涨的' : '；多为上下限钳制或未建模的叠加'}）`
                    : '');
            const clampNote = row.clamped
                ? `  ⛔ 已顶到配表${row.clamped > 0 ? '上限' : '下限'} ${num(row.clamped > 0 ? (row.clampMax as number) : (row.clampMin as number), 2)}（再涨也不生效）`
                : '';
            line(`  ▸ ${row.id} ${row.name}: 基础 ${num(row.base, 2)}（配置 ${num(row.configBase, 2)}`
                + ` + 局外 ${signed(row.outerAbs, 2)} + 成长 ${signed(row.growth, 2)}）`
                + ` → 最终 ${num(row.final, 2)}${clampNote}${approxNote}`);
            for (const key of ATTR_SOURCE_ORDER) {
                const b = row.bySource[key];
                if (bucketEmpty(b)) continue;
                const seg: string[] = [];
                if (b.add) seg.push(`固定 ${signed(b.add, 2)}`);
                if (b.percent) seg.push(`百分比 ${pctText(b.percent, 1)}`);
                if (b.multiply) seg.push(`乘算 ×${num(1 + b.multiply, 4)}`);
                if (b.complement) seg.push(`补数 ${num(b.complement, 4)}`);
                if (b.best) seg.push(`优者 ${num(b.best, 2)}`);
                line(`      ${padEnd(ATTR_SOURCE_LABEL[key], 12)} ${seg.join(' · ')}（${b.count} 条）`);
            }
        }
        if (!detailRows) line('      （本局没有任何属性加成）');
        line('');

        /* ── 5. 遗物 ── */
        line(`[5] 遗物：共 ${rep.relics.count} 件（${this.rarityText(rep.relics.byRarity)}）`);
        for (const rel of rep.relics.list) {
            const tag = rel.via === 'start_gift' ? '开局赠礼' : '商店抽取';
            line(`  ${padStart(String(rel.seq), 3)}. [t=${num(rel.at, 0)}s P${rel.stage}] ${padEnd(rel.rarity, 9)}`
                + ` ${padEnd(rel.name, 14)} ${tag}  ${rel.bonuses}`);
        }
        if (!rep.relics.list.length) line('  （本局一件遗物都没拿到）');
        line('');

        /* ── 6. 神器 ── */
        line(`[6] 神器（击杀数商店）：共 ${rep.artifacts.kinds} 种 / ${rep.artifacts.levels} 层 / 花掉 ${num(rep.artifacts.spent)} 击杀数`);
        for (const key of Object.keys(rep.artifacts.byId)) {
            const a = rep.artifacts.byId[key];
            line(`  ${padEnd(a.name, 16)} ${a.level}/${a.maxLevel} 层`);
        }
        for (const a of rep.artifacts.list) {
            line(`   ${padStart(String(a.seq), 3)}. [t=${num(a.at, 0)}s P${a.stage}] ${padEnd(a.name, 16)}`
                + ` Lv.${a.level}/${a.maxLevel} 每层 ${signed(a.per, 2)}${a.mode === 'percent' ? '%' : ''}`
                + `（${a.stat}） 价 ${a.price}  ${a.effect}`);
        }
        if (!rep.artifacts.list.length) line('  （本局一件神器都没买）');
        line('');

        /* ── 7. 掉落 Buff / 限时 Buff ── */
        const bi = rep.battleItems;
        line(`[7] 掉落 Buff（阶段 Boss 掉落）：进包 ${bi.dropped} / 用掉 ${bi.used} / 拒收 ${bi.rejected}`);
        for (const it of bi.list) {
            const act = it.action === 'drop' ? '掉落' : (it.action === 'use' ? '使用' : '拒收');
            line(`   [t=${num(it.at, 0)}s P${it.stage}] ${act} ${padEnd(it.name, 12)} 时长 ${it.duration > 0 ? `${num(it.duration)}s` : '即刻生效'}`);
        }
        line(`  限时状态（Modifier 汇总，共 ${rep.buffs.length} 种）：`);
        for (const b of rep.buffs) {
            const dur = b.duration > 0 ? `${num(b.duration)}s` : (b.duration === 0 ? '即刻' : '永久');
            line(`   ${padEnd(b.name, 18)} ×${b.times}（累计层 ${b.stacks}） 时长 ${dur}`
                + ` 来源 ${ATTR_SOURCE_LABEL[b.source]} origin=${b.origin || '—'}`);
        }
        if (!rep.buffs.length) line('   （本局没有限时效果）');
        line('');

        /* ── 8. 技能 ── */
        const slotText = rep.finalSkillSlots
            .filter((s) => s.skillId > 0)
            .map((s) => `${s.slot + 1}:${s.name}Lv.${s.level}${s.locked ? '(锁)' : ''}`)
            .join(' ');
        line(`[8] 技能变化（共 ${rep.skills.length} 条）· 终盘槽位 ${slotText || '（无）'}`);
        for (const s of rep.skills) {
            const kind = s.kind === 'learn' ? '学会'
                : (s.kind === 'upgrade' ? '升级'
                    : (s.kind === 'replace' ? `顶替(旧 ${s.replacedId})` : '英雄等级进化'));
            line(`   ${padStart(String(s.seq), 3)}. [t=${num(s.at, 0)}s P${s.stage}] ${kind}`
                + ` ${padEnd(s.name, 14)} → Lv.${s.level}（槽 ${s.slot + 1}）`);
        }
        line('');

        /* ── 9. 抽取统计 ── */
        const rs = rep.rollSummary;
        line(`[9] 遗物抽取：共 ${rs.total} 次（付费 ${rs.paid} / 广告 ${rs.viaAd} / 券 ${rs.viaTicket}）花掉 ${num(rs.goldSpent)} 金币`);
        line(`  候选共 ${rs.optionsTotal} 个（遗物 ${rs.optionsRelic} / 技能 ${rs.optionsSkill}）· 品质分布 ${this.rarityText(rs.raritySeen)}`);
        for (const roll of rep.rolls) {
            line(`   #${padStart(String(roll.seq), 3)} [t=${num(roll.at, 0)}s P${roll.stage} Lv.${roll.heroLevel}]`
                + ` ${padEnd(roll.via, 7)} 花费 ${padStart(num(roll.cost), 5)}  → `
                + roll.options.map((o) => `${o.kind === 'skill' ? '技' : '遗'}${o.name}[${o.rarity}]`).join(' / '));
        }
        line('');

        /* ── 10. 阶段时间线 / Boss ── */
        line('[10] 阶段时间线');
        for (const s of rep.stages) {
            line(`   P${padStart(String(s.stage), 2)}  ${padStart(num(s.from, 0), 5)}s → ${padStart(num(s.to, 0), 5)}s`
                + `  用时 ${padStart(num(s.to - s.from, 0), 4)}s  击杀 ${padStart(num(s.kills), 5)}  金币 +${num(s.gold)}`);
        }
        if (rep.bosses.length) {
            line('  Boss 刷新：');
            for (const b of rep.bosses) {
                line(`   [t=${num(b.at, 0)}s P${b.stage}] ${padEnd(b.kind, 10)} ${padEnd(b.name, 14)}`
                    + ` HP ${padStart(num(b.maxHp), 8)} 攻击 ${padStart(num(b.atk), 6)}`
                    + ` （强度 HP ×${num(b.hpMul, 2)} / 攻击 ×${num(b.atkMul, 2)}）`);
            }
        }
        line('');
        line('提示：完整结构化数据已挂到 window.__runStats —— 控制台执行');
        line('     copy(JSON.stringify(window.__runStats))  即可拿到 JSON。');
        line(bar);

        return L.join('\n');
    }

    /** `{ 品质: 件数 }` → `白12 · 蓝5`（空表给「无」） */
    private rarityText(rec: Record<string, number>): string {
        const keys = Object.keys(rec ?? {});
        if (!keys.length) return '无';
        return keys.map((k) => `${k}${rec[k]}`).join(' · ');
    }
}
