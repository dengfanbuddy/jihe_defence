/**
 * HeroConfig.ts — 「英雄」页（`Scene_Menu` → 左侧「英雄」→ `content/right/heros`）的**配置门面**
 *
 * 只做「读配置 + 换算展示口径」，**不认识金币、不认识界面、不认识存档**：
 *   · 英雄清单   → `units.json` 里 `category='hero'` 的条目（id 升序）
 *   · 解锁 / 升级价 → `battle_constants.json` 的 4 个键（`BattleConstUtil` 读），公式见下面两个 get*
 *   · 卡片上的属性 → `units.base_attributes`（基础） + `units.growthValues`（每级成长） × 等级
 *   · 技能图标   → `units.abilities` → `abilities.json.icon`
 *
 * 金币扣减与存档写入在 `DataCenter.unlockHero / levelUpHero`（本项目唯一的金币出口），
 * 界面只调那两个入口，本文件**不碰** `DataCenter`（避免循环依赖）。
 *
 * 容错：配表未加载完成（`TbRoot` 还没 loadTbs）时一律返回空结果/0，不抛异常 ——
 * 抛进 `onLoad` 会连带弄坏整个 `Scene_Menu`（同 `Cmp_Achievement` 的兜底口径）。
 */

import { TbRoot } from '../../../platform/excel_table/TbRoot';
// 容器必须以「值导入」引入：@tb_config 装饰器靠模块求值完成 TbRoot 注册
import { UnitCfgContainer, type UnitCfg } from '../../excel_table/Tb_UnitConfig';
import { AbilityCfgContainer } from '../../excel_table/Tb_AbilityConfig';
import { AttributeCfgContainer } from '../../excel_table/Tb_AttributeConfig';
import { AttributeType } from '../../battle/core/Types';
import { AttributeScaling } from '../../battle/core/AttributeScaling';
import { BattleConstUtil } from '../../battle/core/BattleConstUtil';

/**
 * 卡片上固定展示的 4 行属性（顺序即行序 `property` / `property-001` / `property-002` / `property-003`）。
 *
 * ⚠ 这 4 项**不是随便选的**：预制件里作者给这 4 行摆的图标依次是
 *   `common/heart`（生命）、`property/atk`（攻击）、`property/defence`（护甲）、`property/atk_range`（范围）——
 *   与本表一一对应。想换展示项就改这一行，同时保证 `ATTR_ICON` 里有对应图标（没有就保留预制件占位图）。
 *
 * 为什么没有「攻击速度」：英雄确实配了攻速（attr 4），但 `textures/property/` 下没有它的图标，
 *   加了只会让第 4 行显示成别的图。要加就先补图标。
 */
const HERO_ATTR_ROWS: AttributeType[] = [
    AttributeType.MaxHp,
    AttributeType.Atk,
    AttributeType.Def,
    AttributeType.AtkRange,
];

/**
 * **英雄详情弹窗**铺的 5 行 = 英雄**真配了的那 5 项**（`units.base_attributes` 里允许出现的全部
 * 五项，见《数值配置参考手册》的"英雄只允许 5 项基础属性 + 3 项成长"），顺序即行序 `attr_1` ~ `attr_5`。
 *
 * 为什么不复用上面的 `HERO_ATTR_ROWS`：那 4 行里的第 3 行「护甲」对**任何**英雄都恒为 0
 * （英雄条目不配护甲 6，`getAttrRows` 回落到 `attributes.json.base`，而护甲的 base = 0）——
 * 那是"表里没配所以回落默认值"，把这一行画进详情页就是给玩家看一个假数据。
 */
export const HERO_DETAIL_ATTR_ROWS: AttributeType[] = [
    AttributeType.MaxHp,
    AttributeType.MaxMana,
    AttributeType.Atk,
    AttributeType.AtkSpeed,
    AttributeType.AtkRange,
];

/**
 * 属性图标（`resources` 相对路径、**不带扩展名**；空 = 保留预制件里的占位图）。
 * 三个 `property/*` 与 `common/heart` 都是**碎图**（不是图集），所以走 `resources.load(路径/spriteFrame)`。
 *
 * ⚠ 空的两项是**待补的美术资产**（`docs/hero-detail/README.md` §5 的 `hero_attr_mana` /
 *   `hero_attr_atk_speed`）：现在返回空串 = 保留预制件里作者摆的占位图，
 *   **不返回一个不存在的路径** —— 那会让每次打开弹窗都刷一条"图标加载失败"的报错。
 */
const ATTR_ICON: Partial<Record<AttributeType, string>> = {
    [AttributeType.MaxHp]: 'textures/common/heart',
    [AttributeType.MaxMana]: '',                  // TODO 美术：hero_attr_mana
    [AttributeType.Atk]: 'textures/property/atk',
    [AttributeType.AtkSpeed]: '',                 // TODO 美术：hero_attr_atk_speed
    [AttributeType.Def]: 'textures/property/defence',
    [AttributeType.AtkRange]: 'textures/property/atk_range',
};

/** 卡片上的一行属性（**已经换算成展示口径**，界面只往上写字符串） */
export interface HeroAttrRow {
    attrId: AttributeType;
    /** 属性中文名（`attributes.json.name`，取不到回落 `属性 N`） */
    name: string;
    /** 当前等级下的值（**运行时口径**：与 `AttributeSystem` 一致，比例型属性是小数如 1.2） */
    value: number;
    /** 每级成长（运行时口径；0 = 该英雄这项不成长） */
    growth: number;
    /** 当前值的展示文案（如 `320` / `120%`） */
    valueText: string;
    /** 每级成长的展示文案（如 `+12/级`；不成长时是 `—`） */
    growthText: string;
    /** 图标路径（可空） */
    icon: string;
}

/**
 * 英雄详情弹窗「技能」块要显示的三件套（`HeroSkillInfo`）。
 * 名字里的「(被动)」尾缀由本文件剥掉、改由 `tag` 单独表达（否则弹窗上会出现两遍「被动」）。
 */
export interface HeroSkillInfo {
    /** 技能图标（`abilities.icon`，`resources` 相对、不带扩展名；空 = 保留预制件占位图） */
    icon: string;
    /** 技能名（已剥掉尾缀「(被动)」） */
    name: string;
    /** 一级效果文案（`abilities.lv1`） */
    desc: string;
    /** 角标文案（被动技能 = `（被动）`，其余为空串） */
    tag: string;
}

export class HeroConfig {

    /* ===================================================================
     * 英雄清单
     * =================================================================== */

    /** 配表是否就绪（未就绪时下面所有查询都退化成空结果） */
    static isReady(): boolean {
        return !!HeroConfig._units();
    }

    /** 全部英雄（`units.json` 里 `category='hero'`，**按 id 升序** —— 序号就是解锁价的涨价档位） */
    static getHeroes(): UnitCfg[] {
        const c = HeroConfig._units();
        if (!c) return [];
        return c.cfgs
            .filter((cfg) => cfg.category === 'hero')
            .slice()
            .sort((a, b) => a.id - b.id);
    }

    /** 按 id 取英雄条目（没有/表未就绪返回 undefined） */
    static getHero(heroId: number): UnitCfg | undefined {
        const cfg = HeroConfig._units()?.getCfgById(heroId);
        return cfg && cfg.category === 'hero' ? cfg : undefined;
    }

    /**
     * 英雄在英雄列表里的**下标**（0 起；找不到返回 -1）。
     * 解锁价按它涨价 —— 见 `getUnlockCost`。
     */
    static getHeroRank(heroId: number): number {
        return HeroConfig.getHeroes().findIndex((cfg) => cfg.id === heroId);
    }

    /* ===================================================================
     * 价格（唯一落点：`battle_constants.json`，改表即改价）
     * =================================================================== */

    /**
     * **解锁**该英雄所需金币 = `heroUnlockCostBase × heroUnlockCostGrowth ^ 序号`（四舍五入）。
     *
     * 口径说明：
     *   · 序号 = 该英雄在英雄列表（id 升序）里的下标，所以列表越靠后越贵；
     *   · 基准为 0（或涨价系数 ≤ 0）时返回 0 = 免费（`DataCenter` 会直接放行）；
     *   · **默认解锁的那位（1001）也会算出一个价**，但数据层发现"已解锁"就不会收费，界面也不会显示它。
     *   · 想逐个英雄单独定价：在 `units` 表加一列 `unlock_cost`，把这里改成优先读它（改一行）。
     */
    static getUnlockCost(heroId: number): number {
        const base = BattleConstUtil.getHeroUnlockCostBase();
        if (base <= 0) return 0;
        const rank = HeroConfig.getHeroRank(heroId);
        if (rank < 0) return 0;                       // 不是英雄条目（表未就绪）→ 不收费
        const growth = BattleConstUtil.getHeroUnlockCostGrowth();
        return Math.max(0, Math.round(base * Math.pow(growth > 0 ? growth : 1, rank)));
    }

    /**
     * **升级**（`level` → `level + 1`）所需金币 = `heroLevelUpGoldBase × heroLevelUpGoldRatio ^ (level - 1)`。
     *
     * ⚠ **口径已废弃（2026-11）：升级改为花"通用英雄经验"**（`HeroData.getExpForNextLevel`，见
     * `docs/hero-detail/README.md` §4）—— 本方法与 `battle_constants` 的两个
     * `heroLevelUpGold*` 键**都没有消费者了**，保留只为「以后可能加金币加速/重置」时有个读法。
     * **界面不要再调它**（英雄页/详情弹窗的价格一律取 `HeroVM` 给的那份）。
     * @param level 当前等级（≥ 1；传 0/负数按 1 处理）
     */
    static getLevelUpCost(level: number): number {
        const base = BattleConstUtil.getHeroLevelUpGoldBase();
        if (base <= 0) return 0;
        const ratio = BattleConstUtil.getHeroLevelUpGoldRatio();
        const lv = Math.max(1, Math.floor(level || 1));
        return Math.max(0, Math.round(base * Math.pow(ratio > 0 ? ratio : 1, lv - 1)));
    }

    /* ===================================================================
     * 卡片内容
     * =================================================================== */

    /** 该英雄的技能图标路径（`units.abilities` → `abilities.json.icon`；没配图标的技能不占位） */
    static getSkillIcons(heroId: number): string[] {
        const cfg = HeroConfig.getHero(heroId);
        if (!cfg) return [];
        const abilityTb = HeroConfig._abilities();
        if (!abilityTb) return [];
        const out: string[] = [];
        for (const abilityId of cfg.abilities ?? []) {
            const icon = abilityTb.getCfgById(abilityId)?.icon;
            if (icon) out.push(icon);
        }
        return out;
    }

    /**
     * 该英雄**第一个有图标的技能**的展示三件套（英雄详情弹窗的「技能」块用）。
     *
     * 口径（与 `getSkillIcons` 同源，只是多带了名字与文案）：
     *   · 优先取第 1 个配了 `icon` 的技能（没配图标的技能在弹窗里没法占位）；
     *   · 名字里的尾缀「(被动)」**剥掉**，改由 `tag` 表达 —— `abilities.json` 里
     *     `id=16` 的名字就叫「爆头冲击(被动)」，不剥的话弹窗上会连着出现两遍"被动"；
     *   · `passive` 的判据是 `behavior === 'passive'`（**不是**看名字里有没有"被动"），
     *     名字里带了尾缀但行为不是 passive 的（或反之）也能正确显示角标。
     *
     * @returns 没有技能/表未就绪 → null（弹窗收起技能块）
     */
    static getSkill(heroId: number): HeroSkillInfo | null {
        const cfg = HeroConfig.getHero(heroId);
        const abilityTb = HeroConfig._abilities();
        if (!cfg || !abilityTb) return null;

        const list = (cfg.abilities ?? []).map((id) => abilityTb.getCfgById(id)).filter((a) => !!a);
        const pick = list.find((a) => !!a.icon) ?? list[0];
        if (!pick) return null;

        const passive = pick.behavior === 'passive';
        const rawName = pick.name || '';
        const name = rawName.replace(/[（(]\s*被动\s*[)）]\s*$/, '');
        return {
            icon: pick.icon ?? '',
            name: name || rawName,
            desc: pick.lv1 ?? '',
            tag: passive ? '（被动）' : '',
        };
    }

    /**
     * 卡片上 4 行属性的**当前值 / 每级成长**（`HERO_ATTR_ROWS` 的顺序）。
     *
     * 计算口径与局内**完全一致**（`Scene_Game_Stage.applyHeroGrowth` + `AttributeSystem`）：
     *   · 基础值 = `units.base_attributes` 里那一项；英雄没配的属性（如护甲 6）回落 `attributes.json.base`；
     *   · 两者都是**配置 int**（比例型属性 100 = 100%），所以先经 `AttributeScaling.normalize` 换成运行时值；
     *   · 每级成长 = `units.growthValues` 的**原值**（float 语义：0.05 = 每级 +5%）——
     *     `applyHeroGrowth` 里 `configInt = 值 × scale` 再交给 `addBase`，而 `addBase` 又 `normalize` 除回去，
     *     一乘一除正好抵消，所以**运行时成长值就是表里的原值**；
     *   · 等级 1 时成长一次都不加（只有 2 级起才有）。
     *
     * ⚠ **不含局外遗物加成**：那条链路（`OuterAttributeCalculator`）目前还没有运行时消费点
     *   （见《数值配置参考手册》§3.3.2），玩家在局内也吃不到 —— 本页要是先叠上，
     *   就成了「英雄页写着 20 护甲、进游戏是 0」。接线之后在这里加一层即可。
     *
     * @param level 英雄等级（`HeroData` 里的等级；< 1 按 1 处理）
     * @param attrIds 要铺哪几行（默认卡片那 4 行；**详情弹窗传 `HERO_DETAIL_ATTR_ROWS`**）
     */
    static getAttrRows(heroId: number, level: number, attrIds: AttributeType[] = HERO_ATTR_ROWS): HeroAttrRow[] {
        const cfg = HeroConfig.getHero(heroId);
        if (!cfg) return [];

        const lv = Math.max(1, Math.floor(level || 1));
        const levels = lv - 1;                        // 等级 1 = 一次成长都不加
        const attrTb = HeroConfig._attributes();

        return attrIds.map((attrId) => {
            const baseInt = HeroConfig._baseConfigOf(cfg, attrId, attrTb);
            const growth = HeroConfig._growthOf(cfg, attrId);
            const base = AttributeScaling.normalize(attrId, baseInt);
            const value = base + growth * levels;

            const row: HeroAttrRow = {
                attrId,
                name: HeroConfig._attrNameOf(attrId, attrTb),
                value,
                growth,
                valueText: HeroConfig.formatAttrValue(attrId, value),
                growthText: growth ? `+${HeroConfig.formatAttrValue(attrId, growth)}/级` : '—',
                icon: ATTR_ICON[attrId] ?? '',
            };
            return row;
        });
    }

    /**
     * 属性值的展示文案：比例型属性（攻速/魔抗/闪避/暴击…，见 `AttributeScaling.SCALE`）显示成百分数
     * （运行时 `1.2` → `120%`），其余取整（`320`）。
     */
    static formatAttrValue(attrId: number, value: number): string {
        if (AttributeScaling.isScaled(attrId)) {
            return `${HeroConfig._trim2(value * 100)}%`;
        }
        return `${Math.round(value)}`;
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    /** `units` 容器（未加载完成时返回 null，不抛） */
    private static _units(): UnitCfgContainer | null {
        try {
            return TbRoot.ins.getTbContainer(UnitCfgContainer) ?? null;
        } catch {
            return null;
        }
    }

    private static _abilities(): AbilityCfgContainer | null {
        try {
            return TbRoot.ins.getTbContainer(AbilityCfgContainer) ?? null;
        } catch {
            return null;
        }
    }

    private static _attributes(): AttributeCfgContainer | null {
        try {
            return TbRoot.ins.getTbContainer(AttributeCfgContainer) ?? null;
        } catch {
            return null;
        }
    }

    /** 基础值的**配置 int**：优先 `units.base_attributes`，英雄没配则回落 `attributes.json.base` */
    private static _baseConfigOf(cfg: UnitCfg, attrId: number, attrTb: AttributeCfgContainer | null): number {
        const entry = (cfg.base_attributes ?? []).find((kv) => kv[0] === attrId);
        if (entry) return Number(entry[1]) || 0;
        return attrTb?.getCfgById(attrId)?.base ?? 0;
    }

    /** 每级成长（**float 语义**，见 `getAttrRows` 的口径说明）；没配 = 0 */
    private static _growthOf(cfg: UnitCfg, attrId: number): number {
        const entry = (cfg.growthValues ?? []).find((kv) => kv[0] === attrId);
        return entry ? Number(entry[1]) || 0 : 0;
    }

    /** 属性中文名（取不到回落 `属性 N`，绝不返回空串） */
    private static _attrNameOf(attrId: number, attrTb: AttributeCfgContainer | null): string {
        return attrTb?.getCfgById(attrId)?.name || `属性 ${attrId}`;
    }

    /** 保留两位小数、去掉多余的 0（浮点噪声不该显示成 0.30000000000000004） */
    private static _trim2(v: number): number {
        return Math.round(v * 100) / 100;
    }
}
