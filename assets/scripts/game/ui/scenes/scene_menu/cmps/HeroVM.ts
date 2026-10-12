/**
 * HeroVM.ts — 「英雄页卡片」与「英雄详情弹窗」的**整包数据构建器**（唯一判据落点）
 *
 * 为什么单独一个文件（这是这次接线里最容易做错的一件事）：
 *   · 同一份判据（`解没解锁` / `这一步花什么` / `花多少` / **能不能点**）现在有**两个消费方** ——
 *     列表里的卡片（`Cmp_Heroes` → `HeroCard`）和整屏的详情弹窗（`Scene_Menu` → `Cmp_HeroDetail`）；
 *   · 如果两边各写一份，迟早会出现「卡片说能点、弹窗说不能点」或价格不一致 ——
 *     这类 bug 在界面上极难发现，因为两部分从来不并排显示。
 *   所以：**判据在这里算一次**，两个消费方都只拿结果去画。
 *
 * 纯逻辑（不 import `cc`、不认识节点）：本项目里"能读数据、能算口径"的模块都可以这样独立跑，
 * 因此本文件也能被 `tools/` 下的体检脚本直接编译执行。
 *
 * 两种资源两种用途（`docs/hero-detail/README.md` §4，**不要在别处再判一遍**）：
 *   | 态 | 花什么 | 价格 | 能不能点 | 价格数字的颜色 |
 *   |---|---|---|---|---|
 *   | 未解锁 | **金币** | `HeroConfig.getUnlockCost(id)` | `价 ≤ 0`（配表把解锁价配成 0 = 免费英雄）或 `持有金币 ≥ 价` | 恒为常态色（这一侧不判红） |
 *   | 已解锁 | **通用英雄经验** | `HeroData.getExpForNextLevel(level)` | `价 > 0` 且 `经验池 ≥ 价` | **经验不够 → 红**（`expLack`，`c-warn` `#FF0000`） |
 *
 * ⚠ 升级侧比解锁侧多一条 `价 > 0`：解锁是**一次性**的（免费解锁最多白送一个英雄），
 *   升级是**无上限**的 —— 配表没给经验口径时放行就是"点一下升一级"的无限白送
 *   （判据与 `HeroData.tryLevelUp` 一致，那边也会拒）。
 *
 * ⚠ **判据只有一份，表现有三态**（2026-11 用户口径「英雄升级按钮那里，如果经验不足，文字应该是红色」）：
 *   `expLack` 与 `enabled` / `cost` / `costKind` 一起在这里算好下发 —— 卡片（`HeroCard`）与
 *   弹窗（`Cmp_HeroDetail`）都**只拿结果去画**（各写一份 `经验 < 价` 迟早会出现"卡片红、弹窗不红"）。
 */

import { CurrencyType, DataCenter } from '../../../../data';
import { HeroConfig, HERO_DETAIL_ATTR_ROWS } from '../../../../data/configs/HeroConfig';
import { getAllEquipmentBonuses } from '../../../../data/configs/EquipmentConfig';
import type { OuterBonusGroup } from '../../../../battle/core/Types';
import type { HeroCardVM, HeroCostKind, HeroDetailVM } from './HeroScope';
import type { UnitCfg } from '../../../../excel_table/Tb_UnitConfig';

/**
 * 本局的**局外加成组**（图鉴里收集到的遗物总和）。
 *
 * 为什么在 `HeroVM` 里读、而不是让 `HeroConfig.getAttrRows` 自己读：`HeroConfig` 刻意不 import
 * `EquipmentConfig`（后者 import `DataCenter`，而 `DataCenter` import `HeroConfig` —— 拉进去就是循环依赖）。
 * 于是"我有哪些加成"由**调用方**递进去，判据仍然只有一份（`getAllEquipmentBonuses`）。
 *
 * 读不到（配表未加载 / 图鉴为空）时返回 `null` = 不加那一层，与"没有局外遗物"是同一个表现。
 */
function outerBonusGroup(): OuterBonusGroup | null {
    try {
        return getAllEquipmentBonuses();
    } catch {
        return null;
    }
}

/** 这一步要花的资源与持有量（判据的输入） */
interface CostInput {
    /** 持有金币 */
    gold: number;
    /** 持有通用英雄经验 */
    exp: number;
}

/**
 * **能不能点这个按钮**（全项目唯一判据，卡片与弹窗共用）。
 *
 * @param kind 花什么（`gold` = 解锁；`exp` = 升级）
 * @param cost 花多少（≤ 0 = 配表没给价）
 * @param have 持有量
 */
export function isHeroActionEnabled(kind: HeroCostKind, cost: number, have: CostInput): boolean {
    if (kind === 'gold') return cost <= 0 || have.gold >= cost;
    return cost > 0 && have.exp >= cost;
}

/**
 * **升级这一步的经验够不够** —— 卡片与弹窗的**价格数字**据此决定红不红（唯一判据，同上一函数）。
 *
 * ⚠ 它不是 `!isHeroActionEnabled(...)` 的简写：那一位还包含"配表没给经验口径"（`cost <= 0`，
 *   花 0 经验=不许白送升级）。那种情况**不画红** —— 红字的语义是"这就是你要攒的经验"，
 *   而不是"这一格现在算不出数"（同 `IOuterDrawPreview.costLack` 的口径）。
 * ⚠ 只有升级侧（`kind = 'exp'`）会成立：解锁花的是金币，那一侧的价格今天不判红。
 */
export function isExpLack(kind: HeroCostKind, cost: number, exp: number): boolean {
    return kind === 'exp' && cost > 0 && exp < cost;
}

/**
 * 一张英雄卡的整包数据。
 *
 * 经验条口径：分子 = **通用经验池**（所有英雄共用一份，不是每个英雄各存一份），
 * 分母 = `getExpForNextLevel(level)` —— 与升级按钮的价格、扣费**同一把尺**。
 * 未解锁没有档案 → `expMax = 0`，卡片据此收起进度条（不画一条永远空的条）。
 */
export function buildCardVM(cfg: UnitCfg): HeroCardVM {
    const heroData = DataCenter.ins.heroData;
    const info = heroData.getHeroInfo(cfg.id);
    const unlocked = !!info;
    const level = info?.level ?? 0;
    const levelForShow = Math.max(1, level);

    const exp = heroData.getSharedExp();
    const gold = DataCenter.ins.itemData.getCurrency(CurrencyType.Gold);
    const expMax = unlocked ? heroData.getExpForNextLevel(levelForShow) : 0;
    const costKind: HeroCostKind = unlocked ? 'exp' : 'gold';
    const cost = unlocked ? expMax : HeroConfig.getUnlockCost(cfg.id);
    const expLack = isExpLack(costKind, cost, exp);

    return {
        heroId: cfg.id,
        name: cfg.name,
        headIcon: cfg.head_icon,
        skillIcon: HeroConfig.getSkillIcons(cfg.id)[0] ?? '',
        unlocked,
        level,
        exp,
        expMax,
        costKind,
        cost,
        enabled: isHeroActionEnabled(costKind, cost, { gold, exp }),
        expLack,
        // 未解锁时按 1 级展示（卡片会把 `lv` 收起，属性行显示的仍是"他 1 级时的样子"）
        // **带上局外加成**：英雄页显示的必须就是玩家进游戏后拿到的那个数
        // （`getAllEquipmentBonuses()` 是图鉴收集份数的总和，与 `Scene_Game_Stage.selectHero` 同一份判据）
        attrs: HeroConfig.getAttrRows(cfg.id, levelForShow, undefined, outerBonusGroup()),
    };
}

/**
 * 英雄详情弹窗的整包数据（在卡片那份的基础上补全量字段）。
 *
 * 复用 `buildCardVM` 是**故意的**：价格、能不能点、经验口径一个字都不重算 ——
 * 弹窗与卡片因此永远说同一套话（`attrs` 换成详情页那 5 行，其余逐字相同）。
 *
 * @returns 配表里没有这个英雄 → null（宿主据此收起弹窗，而不是画一个空壳）
 */
export function buildDetailVM(heroId: number): HeroDetailVM | null {
    const cfg = HeroConfig.getHero(heroId);
    if (!cfg) return null;

    const card = buildCardVM(cfg);
    return {
        heroId: card.heroId,
        name: card.name,
        headIcon: card.headIcon,
        unlocked: card.unlocked,
        level: card.level,
        exp: card.exp,
        expMax: card.expMax,
        costKind: card.costKind,
        cost: card.cost,
        enabled: card.enabled,
        expLack: card.expLack,
        gold: DataCenter.ins.itemData.getCurrency(CurrencyType.Gold),
        // 未解锁 → 按 1 级画（"头像下面没有档案"，等级那套一律按最初的样子展示）
        attrs: HeroConfig.getAttrRows(card.heroId, Math.max(1, card.level), HERO_DETAIL_ATTR_ROWS, outerBonusGroup()),
        skill: HeroConfig.getSkill(card.heroId),
    };
}

/**
 * 数据指纹 —— watcher 的订阅源：**只要它变了就重铺界面**。
 *
 * 用「金币 + 通用经验池 + 已解锁集合（id:等级）」拼串而不是 deep watch：读到的字段就是真实依赖，
 * 改动一处也只刷一次（与 `Cmp_Achievement.fingerprint` 同套路）。
 *
 * ⚠ 三个都必须在里面：解锁只动 `records`、升级只动 `records` 的等级、
 *   一局通关发经验**只动经验池**（金币与等级都不变）—— 漏掉任何一个，界面就会停在旧值。
 *
 * ⚠ **局外遗物收集（id × 份数）也必须在里面**（2026-11 加）：属性行现在包含局外加成那一层
 *   （`outerBonusGroup()`），在「遗物」页抽到一件之后切回英雄页 —— 属性必须跟着涨。
 *   漏掉它，英雄页会停在旧值，与进游戏后的真实属性对不上（这正是"两个口径"最典型的形态）。
 */
export function heroFingerprint(): string {
    const gold = DataCenter.ins.itemData.getCurrency(CurrencyType.Gold);
    const exp = DataCenter.ins.heroData.getSharedExp();
    const records = DataCenter.ins.heroData.getUnlocked()
        .map((r) => `${r.id}:${r.level}`)
        .join(',');
    const collection = DataCenter.ins.equipCollection;
    const relics = collection.getAllCollectedIds()
        .map((id) => `${id}x${collection.getCollectedCount(id)}`)
        .join(',');
    return `${gold}|${exp}|${records}|${relics}`;
}
