/**
 * ============================================================
 * GameRulesConfig —— 「游戏规则说明」面板的**文案真源**（纯 TS，无 cc 依赖）
 * ============================================================
 *
 * 一件事：把**局内规则**写成一份可渲染的章节表（`{title, lines}`）。
 * 它不认识节点、不读存档、不发事件 —— 面板（`HelpPanel`）只负责把这些行画出来。
 *
 * ── 三条口径（改这个文件前先看）──
 *   ① **数值一律现读**，不在这里写死：抽卡费用读 `ShopConfig`、召唤 Boss 读 `BOSS_SLOTS`、
 *      阶段时长读 `StageTimingConfig`、难度倍率读 `DifficultyConfig`。
 *      理由是这份文案会直接给玩家看：写死一次，改配表之后界面就开始撒谎，而且没人会发现。
 *   ② **只写"真的生效"的规则**：描述以代码与配表里的现值为准，`docs/prd/阶段模式_局内规则详解.md`
 *      里**没有落地**的部分（武器栏位/升星、临时背包与道具、攻击策略勾选面板、精英词缀…）
 *      一律不写 —— 规则说明里出现一个做不到的承诺，比没有说明更糟。
 *   ③ 一行一句话，**不要在 `lines` 里塞 `\n`**：面板一行一个 Label（换行由 Label 自己折），
 *      在这里拼多行会同时毁掉行距与滚动高度。
 *
 * @example
 * ```ts
 * import { buildGameRules } from '../../common/GameRulesConfig';
 * const sections = buildGameRules({ difficulty: 3 });   // 难度段会按档位现算倍率
 * ```
 */

import { BattleConstUtil } from '../battle/core/BattleConstUtil';
import { BOSS_SLOTS } from '../battle/BossScheduler';
import type { BossSlotDef, BossSlotKey } from '../battle/BossScheduler';
import { SKILL_SLOT_COUNT } from '../battle/SkillSlots';
import { ShopConfig } from '../data/configs/ShopConfig';
import { BATTLE_SPEED_STEPS, BATTLE_SPEED_UNLOCK_ACCOUNT_LEVEL } from './BattleSpeedConfig';
import { bossHpMul, enemyAtkMul, enemyHpMul, levelLabel, rewardMul, spawnGapMul } from './DifficultyConfig';
import { describeBossStrength } from './BossStrengthConfig';
import { BATTLE_ITEM_DROP_PER_BOSS, ITEM_BAG_SLOT_COUNT } from './ItemBagConfig';
import { BOSS_TIME_SEC, PREPARE_TIME_SEC, RUN_TOTAL_SEC, STAGE_COUNT, STAGE_TIME_SEC, formatDuration } from './StageTimingConfig';

/** 一章规则（面板里 = 一个小标题 + 若干行正文） */
export interface GameRuleSection {
    /** 小标题（面板里一行，字号/字色与正文不同） */
    title: string;
    /** 正文行（**一行一句**，面板一行一个 Label） */
    lines: string[];
}

/** 构建规则文案时的上下文 */
export interface GameRulesContext {
    /** 本局难度档位（`battleStore.difficulty`）；缺省/非法值按档 1 算 */
    difficulty?: number;
}

/**
 * 三个召唤 Boss 的「杀了给什么」文案。
 *
 * ⚠ 奖励口径来自 `units.json` + `Scene_Game_Stage.grantKillReward`（`rewardType` 决定额外倍率），
 *   不是设计稿里的旧口径 —— 键与 `BOSS_SLOTS[].key` 一一对应，漏一个会当场报出来（见下面的兜底）。
 */
const BOSS_REWARD_TEXT: Record<BossSlotKey, string> = {
    gold: '击杀掉一大笔金币（金币怪有专门的奖励倍率）',
    kill: '击杀掉一笔金币与大量局内经验',
    guard: '击杀后本局刷怪加码：每批同时数量 +1、批间隔 ×0.95，最多吃 2 只',
};
/**
 * 组装规则说明的全部章节。
 *
 * 只读配置、纯函数（同样的 `difficulty` 一定得到同样的文案），所以在体检脚本里可以直接跑。
 */
export function buildGameRules(ctx: GameRulesContext = {}): GameRuleSection[] {
    const difficulty = ctx.difficulty > 0 ? Math.floor(ctx.difficulty) : 1;
    return [
        objectiveSection(),
        stageSection(),
        goldSection(),
        killPointSection(),
        dropBuffSection(),
        skillSlotSection(),
        summonBossSection(),
        controlSection(),
        difficultySection(difficulty),
    ];
}

/* ===================================================================
 * 各章
 * =================================================================== */

function objectiveSection(): GameRuleSection {
    return {
        title: '目标',
        lines: [
            `守住英雄（炮塔）打满 ${STAGE_COUNT} 个阶段，再击败最终 Boss 即通关。`,
            '英雄生命归零 = 本局失败；有复活券或广告复活名额时可以救回来。',
            `一局约 ${formatDuration(RUN_TOTAL_SEC)}（1× 速度，不含最终 Boss 战的额外耗时）。`,
            '遗物、技能、神器、金币与击杀数都只在本局生效，换局全部重置。',
        ],
    };
}

function stageSection(): GameRuleSection {
    return {
        title: '阶段与刷怪',
        lines: [
            `准备期 ${formatDuration(PREPARE_TIME_SEC)}：选完英雄后开始倒计时，期间不刷怪。`,
            `阶段 1~${STAGE_COUNT} 各 ${formatDuration(STAGE_TIME_SEC)}；时间一到立刻刷出阶段 Boss，并进入下一阶段。`,
            '阶段 Boss 不会自己离场：没杀掉就留在场上，拖得越久同时在场的 Boss 越多。',
            '常规刷怪每 60 秒升一档：每批 1 → 6 只，同时每只怪更厚、掉落更多。',
            '同屏存活怪 ≥ 40 只时刷怪变慢，到 50 只暂停刷新（腾出位置就继续，不会丢这一批）。',
            `打完阶段 ${STAGE_COUNT} 进入 Boss 阶段：最终 Boss 登场，${formatDuration(BOSS_TIME_SEC)}内没有击杀即本局失败。`,
        ],
    };
}

function goldSection(): GameRuleSection {
    const optionCount = ShopConfig.getOptionCount();
    const pickCount = ShopConfig.getPickCount();
    const base = ShopConfig.getDrawCost(0);
    const step = Math.max(0, ShopConfig.getNumber('drawCostStep', 25));
    const cap = ShopConfig.getDrawCostCap();
    const heroRefresh = Math.max(0, ShopConfig.getNumber('heroSelectRefreshCost', 100));
    const adFree = ShopConfig.getBool('adFreeDrawEnabled', true) ? ShopConfig.getNumber('adFreeDrawPerRun', 3) : 0;
    const adExtra = ShopConfig.getBool('adExtraPickEnabled', true) ? ShopConfig.getNumber('adExtraPickCount', 1) : 0;
    const skillChance = Math.max(0, Math.min(100, ShopConfig.getNumber('skillDrawChance', 20)));
    const skillMax = Math.max(0, ShopConfig.getNumber('skillMaxPerDraw', 2));

    const lines = [
        '来源：击杀掉落 + 击杀奖励，随阶段、时间与难度一起放大。',
        `用途一：刷新候选英雄（${heroRefresh} 金币 / 次）。`,
        // 候选池口径（2026-11 用户口径「局内英雄也只能随机解锁的英雄」）：这里**不写数字**
        //   —— 默认解锁几位、解锁价多少都在局外（`HeroData.DEFAULT_UNLOCKED_HERO_IDS` /
        //   `HeroConfig.getUnlockCost`），写进文案就会在改表之后开始撒谎。
        '候选英雄只从「已解锁」的英雄里随机 —— 没有解锁的英雄不会出现在这里（去主界面「英雄」页解锁）。',
        `用途二：抽遗物 —— 一轮出 ${optionCount} 个候选、选 ${pickCount} 个；首抽 ${base} 金币，`
            + `每抽 +${step}，单次费用封顶 ${cap > 0 ? cap : '不封顶'}（换局重置）。`,
        `候选池 = 遗物 + 技能：一轮最多出 ${skillMax} 个技能，约 ${skillChance}% 的轮次会出技能。`,
    ];
    if (adFree > 0) lines.push(`金币不够时可以看广告免费抽（每局 ${adFree} 次），名额用完就只能攒钱。`);
    else lines.push('金币不够时抽不了，只能先攒钱（广告免费抽当前是关闭的）。');
    if (adExtra > 0) lines.push(`已经抽完一轮时，还可以看广告再补选 ${adExtra} 个候选。`);
    lines.push('背包里有「局内广告券」时，这两种广告可以直接用券顶掉，不用看视频。');
    return { title: '金币 · 遗物抽取', lines };
}

function killPointSection(): GameRuleSection {
    const base = Math.max(0, ShopConfig.getNumber('killBuffRefreshCost', 50));
    const step = Math.max(0, ShopConfig.getNumber('killBuffRefreshCostStep', 25));
    const cap = Math.max(0, ShopConfig.getNumber('killBuffRefreshCostCap', 200));
    const free = ShopConfig.getKillBuffFreeRefreshPerRun();
    const growth = ShopConfig.getNumber('killBuffPriceGrowth', 1.35);
    const adFree = Math.max(0, ShopConfig.getNumber('killBuffRefreshAdFreePerRun', 1));

    const lines = [
        '每击杀 1 只怪 +1 点击杀数，跨阶段保留、花掉才减少（与金币是两条独立的经济线）。',
        '买到的神器永久生效，同一件可以反复买到层数上限 —— 想走哪个流派就盯着哪几件买。',
        '神器分两种：属性型直接加属性；机制型是「每 10 次击杀朝面前喷出扇形」「暴击回血」「金币转攻击力」这类特殊效果，同样按层数变强。',
    ];
    // 开局白送：与「首次打开摊位不收费」是两件事（前者是重抽机会，后者是第一次一定有 4 个候选）
    lines.push(free > 0
        ? `开局白送 ${free} 次免费刷新摊位（第一次打开摊位本身也不收费）${
            adFree > 0 ? `，另外每局还有 ${adFree} 次看广告免费刷新` : ''}。`
        : `第一次打开摊位不收费${adFree > 0 ? `，每局还有 ${adFree} 次看广告免费刷新` : ''}。`);
    lines.push(`之后花击杀数刷新：首次 ${base}，每刷一次 +${step}，单次封顶 ${cap > 0 ? cap : '不封顶'} ——`
        + '封的只是价格，刷新次数本身没有上限。');
    lines.push(`同一件神器的第 N 层价格 = 首层价 ×${fmt(growth)}^(N−1)，到达层数上限后不能再买（换局重置）。`);
    return { title: '击杀数 · 神器', lines };
}

/**
 * 掉落 Buff 章 —— **与神器是两条轨**（口径见 `docs/artifact-drop/README.md`）。
 *
 * 为什么补这一章：这一整套（阶段 Boss 掉落 → 6 格小背包 → 双击使用）**原先在规则说明里一个字都没有**，
 *   而它是玩家每一局都会遇到的界面（HUD 左下角那颗收纳按钮）；神器表里的「血包」2026-11 又整条
 *   搬到了这条轨上，不写一句"它是打 Boss 掉的、不是花击杀数买的"，玩家只会把它当成一件失踪的神器。
 * 行数不写死：格数与每次掉落件数都读 `ItemBagConfig`（改配表 → 文案跟着变）。
 */
function dropBuffSection(): GameRuleSection {
    const slots = ITEM_BAG_SLOT_COUNT;
    const perBoss = BATTLE_ITEM_DROP_PER_BOSS;
    return {
        title: `掉落 Buff（${slots} 格背包）`,
        lines: [
            `每个阶段 Boss 阵亡掉 ${perBoss} 件 Buff 道具，进 HUD 左下角的 ${slots} 格小背包（收纳按钮默认收起）。`,
            '捡到不生效：点格子看说明，双击才用掉，用掉后格子空出来。',
            `背包只有 ${slots} 格 —— 满格时再掉就直接丢弃（会提示丢的是哪一件），所以该用的时候别一直攒着。`,
            '它与神器是两条轨：神器是永久的构筑件（花击杀数买刷新与层数），道具是一次性的（打 Boss 掉，用完就没）。',
        ],
    };
}

function skillSlotSection(): GameRuleSection {
    return {
        title: `技能槽（${SKILL_SLOT_COUNT} 格）`,
        lines: [
            `第 1 格是英雄专属技能：永久锁定，不会被新技能顶掉。`,
            `其余 ${SKILL_SLOT_COUNT - 1} 格开局就是空的，抽到技能自动落槽。`,
            '新技能：已拥有 → 原地升 1 级（到该技能上限为止）；没有 → 填最靠前的未锁定空格；'
                + '格子都满 → 顶掉最靠前的未锁定格（被顶掉的技能回到池子）。',
            '一个未锁定的格子都没有时技能发不下来，界面会飘字提示 —— 点格子上的锁图标可以锁定 / 解锁。',
            '长按格子看技能详情（一行一级，当前等级高亮）。',
        ],
    };
}

function summonBossSection(): GameRuleSection {
    const lines = [
        'HUD 左侧三格可以随时点击召唤（不用等刷怪上限），每格有自己的充能与库存上限。',
    ];
    for (const def of BOSS_SLOTS) lines.push(describeSummonBoss(def));
    return { title: '召唤 Boss', lines };
}

/** 一个召唤 Boss 的一行说明（充能 / 库存 / 限时 / 击杀收益全从 `BOSS_SLOTS` 现读） */
function describeSummonBoss(def: BossSlotDef): string {
    const cd = def.cd > 0 ? `${formatDuration(def.cd)}充能` : '无冷却（开局直接满库存）';
    const stock = `最多同时 ${def.maxStock} 只`;
    const reward = BOSS_REWARD_TEXT[def.key] ?? '击杀后给一笔奖励';
    const timeout = def.recoverOnTimeout
        ? '限时到会撤离：不算击杀、不给奖励，库存还回来'
        : '限时到会撤离，不给奖励';
    return `${def.label}：${cd}，${stock}，场上限时 ${formatDuration(def.timeLimit)} —— ${reward}；${timeout}。`;
}

function controlSection(): GameRuleSection {
    const speedLabels = BATTLE_SPEED_STEPS.map((s) => s.label).join(' / ');
    return {
        title: '操作',
        lines: [
            '点战场上的怪 = 手动锁定集火；点同一只保持，点空地取消并回到自动索敌。',
            '目标死亡 / 撤离 / 变得不可选中时，手动锁定会自动解除。',
            '点左上角头像看英雄当前属性（等级、攻击、攻速、射程…）。',
            '右上角三个按钮：选英雄 / 遗物抽取 / 神器（花击杀数买的那一个）—— 打开这些面板时战斗自动暂停。',
            `左下角：暂停 / 退出战斗；解锁后还能切 ${speedLabels} 倍速（账号 ${BATTLE_SPEED_UNLOCK_ACCOUNT_LEVEL} 级解锁，`
                + '倍速只压缩现实时间，不改变一局的收益）。',
            '点这个问号随时打开本说明 —— 打开期间战斗同样暂停。',
        ],
    };
}

function difficultySection(difficulty: number): GameRuleSection {
    const reviveAd = BattleConstUtil.getReviveAdPerRun();
    const lines = [
        `本局难度：${levelLabel(difficulty)} —— 怪 HP ×${fmt(enemyHpMul(difficulty))}、`
            + `怪攻击 ×${fmt(enemyAtkMul(difficulty))}、Boss HP ×${fmt(bossHpMul(difficulty))}、`
            + `金币经验收益 ×${fmt(rewardMul(difficulty))}、刷怪间隔 ×${fmt(spawnGapMul(difficulty))}。`,
        // Boss 曲线的数值真源是 `common/BossStrengthConfig`（与上面那行同源：改常量文案跟着变），
        // 让玩家知道"越靠后的 Boss 越肉"不是错觉。
        `${describeBossStrength()}（与上面的难度倍率相乘）。`,
        '难度只改怪与收益，不改任何玩法规则。',
        `阵亡时：背包里有复活券就能用（有几张用几次），否则还有每局 ${reviveAd} 次的广告复活名额。`,
        '中途退出不算一次对局结束，不做结算；击败最终 Boss 通关会发放英雄经验。',
    ];
    return { title: '难度与结算', lines };
}

/** 倍率文案：与 `DifficultyConfig.describeLevel` 同一套精度，界面之间不会互相打架 */
function fmt(v: number): string {
    if (!Number.isFinite(v)) return '1.00';
    if (v >= 1000) return v.toFixed(0);
    if (v >= 100) return v.toFixed(1);
    return v.toFixed(2);
}
