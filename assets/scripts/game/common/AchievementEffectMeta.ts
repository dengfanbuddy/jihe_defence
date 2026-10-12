import type { AchEffectCode } from '../excel_table/Tb_AchievementConfig';

/**
 * 成就特殊效果元数据（**唯一真源**）
 *
 * 一条效果 = 三个信息：**叫什么名（UI）** · **数值单位与封顶（数值/门禁）** · **作用在哪（代码落点）**。
 * 配表只写 `effect_code` + `effect_value`，其余全部在这里 —— 所以：
 *   · 加新效果：先在 `AchEffectCode`（`Tb_AchievementConfig.ts`）里加候选，再来这里补一条元数据，
 *     并在下表的「落点」写清消费方（**没有消费方的效果等于没做**，`npm run audit:achieve` 会盯它）；
 *   · 改封顶：只改这里的 `cap`（`AchievementData.getEffects()` 与配表门禁都读它）。
 *
 * 设计口径（`docs/成就系统设计.md` §5）：
 *   · **全是「局内开局参数 + 经济折扣」**，v1 不含属性类效果（局外属性链路尚未接线）；
 *   · **开局快照**：`Scene_Game_Stage.show()` 读一次 `AchievementData.getEffects()`，本局全程用它，
 *     局中领奖**不改变本局**数值（下一局生效）；
 *   · 百分比类效果配表填**百分数**（`10` = 10%），消费方换算时 `/ 100`。
 *
 * ⚠ **本表同时是「局内开局初始值」的 code 表与封顶表** —— 它有**三个来源**，共用同一套 code 与 `cap`：
 *   · ① **成就末档**（`achievements.effect_code`，`AchievementData.getEffects()` 已按 `cap` 收口）；
 *   · ② **局外增益券**（`bag_items` 的 `boost_<code>` 行，每张值多少见 `battle_constants.shopBoostTicketValues`）；
 *   · ③ **局外红件词缀**（`relics.effects_outer`，只有 27 件红档遗物有；汇总口 `EquipmentConfig.getOuterRunEffectTotals()`）。
 *   三者由 `Scene_Game_Stage.snapshotAchieveEffects()` 合并，**合并后统一再按 `cap` 封顶一次**——
 *   单看某一个来源永远碰不到 `cap`（成就那 10 条各只有一个来源），但"份数无上限"的红件叠起来会，
 *   所以这条 clamp 必须写在合并那一处（口径见 `docs/meta-growth/README.md` §1.5 / §1.7）。
 *   **加来源不加 clamp 的后果**：开局金币无限涨，一开局就能把肉鸽商店抽干。
 */
export interface AchEffectMeta {
    /** 效果展示名（UI 的效果明细行用） */
    name: string;
    /** 数值单位（展示用） */
    unit: string;
    /** 是否百分比（true 时配表填百分数，展示时补 `%`） */
    percent: boolean;
    /** **合计封顶**（`getEffects()` 里 clamp；配表门禁也用它校验 `effect_value`） */
    cap: number;
    /** 生效说明（一句话，UI 悬浮提示/文档用） */
    note: string;
    /** **作用点**（代码落点，供本文件与体检脚本对照，不在运行时消费） */
    hook: string;
}

/** 11 条效果（**顺序 = 展示顺序**） */
export const ACH_EFFECT_META: Record<AchEffectCode, AchEffectMeta> = {
    run_start_gold: {
        name: '局内初始金币', unit: '', percent: false, cap: 200,
        note: '每局开局额外获得的金币（本局立即生效）',
        hook: 'Scene_Game_Stage.selectHero —— hero.gold = BattleConstUtil.getInitialGold() + N',
    },
    run_start_kill_points: {
        // ⚠ `name` 是**给玩家看的**（成就奖励行 / 背包里增益券的那一行，`achEffectLabel`）。
        //   它不带"费用/价格"字样 ⇒ 走加成分支显示正号（`局内初始击杀 +10`），不要改成"折扣"读法。
        name: '局内初始击杀', unit: '', percent: false, cap: 100,
        note: '每局开局额外获得的击杀数（神器商店的货币，本局立即生效）',
        hook: 'Scene_Game_Stage.selectHero —— battleStore.addKillPoints(N)'
            + '（**只能播种在 selectHero**：`resetRun()` 里播种会被紧随其后的 `battleStore.reset()` 归 0，'
            + '而且那时开局快照还没读 —— 顺序是 resetRun → snapshotAchieveEffects → 选英雄）',
    },
    shop_option_plus: {
        name: '肉鸽商店选项', unit: '个', percent: false, cap: 1,
        note: '每次抽取多 1 个候选（5 选 1）',
        hook: 'RelicDraw 选项数（shop_constants.optionCount）',
    },
    shop_draw_discount: {
        name: '肉鸽抽取费用', unit: '%', percent: true, cap: 30,
        note: '肉鸽商店的抽取费用降低',
        hook: 'RelicShop 费用计算',
    },
    ad_free_draw: {
        name: '广告免费抽', unit: '次', percent: false, cap: 2,
        note: '每局多几次「看广告免费抽」',
        hook: 'shop_constants.adFreeDrawPerRun 叠加',
    },
    kill_buff_discount: {
        // ⚠ `name` 是**给玩家看的**（成就奖励行 / 背包里增益券的那一行，`achEffectLabel`），
        //   而且 `achEffectLabel` 靠 `/费用|价格/` 判"折扣显示负号"—— 改名时**必须留着"价格"两个字**，
        //   否则「神器价格 -20%」会变成「神器价格 +20%」（读起来是涨价）。
        name: '神器价格', unit: '%', percent: true, cap: 20,
        note: '神器的价格降低（击杀数商店，原名"击杀商店 Buff"）',
        hook: 'BuffShop 价格计算',
    },
    gold_gain_bonus: {
        name: '击杀金币', unit: '%', percent: true, cap: 25,
        note: '击杀获得的金币提高',
        hook: 'Scene_Game_Stage.grantKillReward —— 金币侧',
    },
    battle_exp_bonus: {
        name: '局内经验', unit: '%', percent: true, cap: 20,
        note: '局内英雄获得的经验提高',
        hook: 'Scene_Game_Stage.grantKillReward —— 经验侧',
    },
    hero_start_level: {
        name: '开局英雄等级', unit: '级', percent: false, cap: 2,
        note: '每局开局英雄多 1 级（直接解锁一个技能/属性点）',
        hook: 'Scene_Game_Stage.selectHero —— 创建英雄后补升级',
    },
    hero_select_free: {
        name: '选人免费刷新', unit: '次', percent: false, cap: 2,
        note: '选英雄阶段多几次免费刷新',
        hook: 'HeroSelect 的 adFreeLeft',
    },
    relic_start_gift: {
        name: '开局赠遗物', unit: '件', percent: false, cap: 1,
        note: '每局开局白送 1 件随机遗物',
        hook: 'RelicShop 开局发放（复用 RelicDraw 纯函数）',
    },
};

/** 全部效果 code（顺序 = ACH_EFFECT_META 的书写顺序） */
export const ACH_EFFECT_CODES: AchEffectCode[] = [
    'run_start_gold', 'run_start_kill_points', 'shop_option_plus', 'shop_draw_discount', 'ad_free_draw',
    'kill_buff_discount', 'gold_gain_bonus', 'battle_exp_bonus', 'hero_start_level', 'hero_select_free',
    'relic_start_gift',
];

/** 取效果元数据（未知 code 返回 null，不抛异常） */
export function achEffectMeta(code: string | undefined): AchEffectMeta | null {
    if (!code) return null;
    return ACH_EFFECT_META[code as AchEffectCode] ?? null;
}

/**
 * 效果的展示文本（UI 的效果明细行 / 日志）。
 * 例：`achEffectLabel('run_start_gold', 50)`   → `局内初始金币 +50`
 *     `achEffectLabel('shop_draw_discount', 10)` → `肉鸽抽取费用 -10%`
 *
 * 约定：**折扣类（percent + 名字里带"费用/价格"）显示负号**，加成类显示正号 ——
 * 不然「抽取费用 +10%」会被读成涨价（口径来自设计稿 §5.1）。
 */
export function achEffectLabel(code: string | undefined, value: number): string {
    const meta = achEffectMeta(code);
    if (!meta) return '';
    const negative = meta.percent && /费用|价格/.test(meta.name);
    const sign = negative ? '-' : '+';
    const num = meta.percent ? `${Math.abs(value)}%` : `${Math.abs(value)}${meta.unit}`;
    return `${meta.name} ${sign}${num}`;
}
