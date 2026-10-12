import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/**
 * 局内掉落 Buff 配置表（`battle_items.json`）
 *
 * **这不是击杀商店（神器）**：神器是「永久 + 可叠层 + 花击杀数买刷新次数」（`kill_buffs.json`），
 * 本表是「**限时 + 一次性消耗 + 打阶段 Boss 掉**」。两者是**两条轨**，别混（见 `docs/artifact-drop/README.md`）。
 * ⚠ 也不是 `bag_items`（**局外**背包 80 格、跨局、全屏页）。
 *
 * 设计：阶段 Boss 阵亡 → 从本表抽 1 件 → 进**局内 6 格小背包**（满了**直接拒收**，掉落作废）；
 *       玩家点格子**使用** → 按本行的 `duration` 施加 `modifiers` 到英雄身上 → 格子清空。
 *
 * ⚠ 本表**不是**「只有限时道具」：`duration = 0` 的那一条（血包）是**即刻生效**的，
 *   见下面 `duration` 字段的说明。
 *
 * 查询：`TbRoot.ins.getTbContainer(BattleItemCfgContainer).getCfgById(12)`
 * 业务门面：`ShopConfig.getBattleItems()` / `getBattleItem(id)`
 */

/** 掉落道具品质（与遗物/神器同一套 4 档；决定展示色，**掉落权重另由 `weight` 决定**） */
export type BattleItemRarity = 'common' | 'rare' | 'epic' | 'legendary';

/** 一条要施加到英雄身上的 Modifier（写法与 `relics.modifiers_inner` 完全一致） */
export interface BattleItemModifierEntry {
    /** 引用的 `ModifierCfg.id`（纯属性一律走共享模板 `MODIFY_ATTR_TEMPLATE_ID` = 1000） */
    modifier: number;
    /**
     * 施加参数。纯属性走 `{ attrs: [[属性id, 值, 叠加方式]] }`；
     * 状态类走空对象（如 mod 6「无敌」= `apply_state invulnerable`）。
     * ⚠ 这里**不写 duration** —— 时长由本行的 `duration` 统一注入（见 `ItemBag.use`）。
     */
    kv?: Record<string, any>;
}

export interface BattleItemCfg {
    id: number;
    /** 唯一英文代码（程序引用用） */
    code: string;
    name: string;
    /** 一句话效果（飘字 / 背包 tooltip 用） */
    desc: string;
    /**
     * 图标资源路径（`resources` 相对、不带扩展名）。
     *
     * 两个消费者：**HUD 掉落背包格子**（`ItemBagCell`）与**状态栏里"药水来源"的那一格**
     * （`battle/StatusBar.originInfo` 的 `item:<id>` 分支，2026-11 起）。
     * **2026-11 已配齐 17 行**（`textures/buffs/<code>`，图集 `textures/buffs/buffs` —— 与
     * `modifiers.icon` 那 4 条状态 Buff **共用同一张图集**，两族都是"局内 Buff"）。
     * 加载一律走 `common/AtlasIcon.loadIconFrame`（**别自己 `resources.load('<path>/spriteFrame')`**：
     * 图标只在图集里，碎图路径一律取不到；状态栏那侧取不到图不重试、留在色块画法上）。
     * ⚠ 不许填不存在的路径 —— 每次开格都会刷一条"图标加载失败"。
     */
    icon?: string;
    rarity: BattleItemRarity;
    /** 掉落权重（留空按 1）；同一池子里按权重随机 */
    weight?: number;
    /**
     * 效果时长（秒）。三种取值，语义完全不同：
     *   · `> 0` = **限时**道具（本表绝大多数）：进 6 格背包 → 点一下 → 效果持续这么多秒。
     *   · `= 0` = **即刻生效**：施加的那一帧就结算完，下一帧 `ModifierSystem.Tick` 把它收走，
     *     **不留任何状态**（现只有「血包」一条：立刻回血）。`ItemBag.applyItem` 会把 0 原样
     *     传给 `AddModifier` —— **绝不能兜成 -1**，那会变成永久 Modifier。
     *   · `< 0` = 非法（运行时会告警并按永久处理）—— 本表不该出现，永久效果属于**神器**那一侧。
     *
     * ⚠ 不要给「最大生命」这类**上限类属性**：上限回落而当前生命不回落会出现 `hp > maxHp` 的脏数据
     *   （项目既有铁律，见 `docs/agent-notes/配表与数值口径.md`）。
     */
    duration: number;
    /** 生效时施加到英雄身上的 Modifier 列表 */
    modifiers: BattleItemModifierEntry[];
    /** 流派标签（与 abilities / kill_buffs / relics 共用一套 8 个词） */
    tags?: string[];
    note?: string;
}

@tb_config(':tb/battle_items')
export class BattleItemCfgContainer extends TbContainer<BattleItemCfg> {
    getTbName(): string { return 'BattleItemCfg'; }

    /**
     * 掉落权重（`weight` 缺省 1，负数/非法值一律当 0 = **不参与掉落**）。
     * 用 `weight <= 0` 可以把一件道具**配出来但暂时不投放**（比删行安全：删了 id 就废了）。
     */
    weightOf(cfg: BattleItemCfg): number {
        const w = cfg?.weight ?? 1;
        return Number.isFinite(w) && w > 0 ? w : 0;
    }
}
