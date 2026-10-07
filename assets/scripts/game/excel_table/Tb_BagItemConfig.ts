import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';
import type { AchEffectCode } from './Tb_AchievementConfig';

/**
 * 通用道具配置表（bag_items.json）
 *
 * **一行一件「玩家可能持有的道具」** —— 局外背包（`prefabs/ui/views/bag/View_Bag`）照着它铺格子：
 * 图标 / 名字 / 描述 / 品质底框色 / 堆叠上限**全部来自本表**，代码里不写死任何一件道具。
 *
 * ⚠ 本表是**道具字典**（长什么样、叫什么），**不是存量**：
 * 存量在存档模块 `game/data/funcs/BagData.ts`（按 `key` 记数量），两者靠 `key` 对上。
 * 表里删一行 = 背包里那一格立刻消失（存档里那份存量还在，只是没人认它了）。
 *
 * ⚠ 与 `relics`（遗物，id 1001~1302）**不是一回事**：遗物有自己的表与页面（主界面左侧「遗物」页），
 * 不进背包；背包装的是券 / 次数这类**可堆叠的持有物**。
 *
 * 口径真源：`docs/bag/README.md`；查询门面：`game/data/configs/BagConfig.ts`。
 */

/** 品质四档（与 `relics.rarity` / `abilities.rarity` 同一阶梯；界面上只决定格子底框色） */
export type BagItemRarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface BagItemCfg {
    id: number;
    /** 唯一标识（**代码与存档按它记账**）：`ad_ticket` / `outer_draw_ticket` / `boost_<成就效果code>` */
    key: string;
    /** 道具名（详情面板第一行；**≤ 8 个汉字**：详情面板的 name 框 200×38 / fs24 是 CLAMP，长了会裁字） */
    name: string;
    /** 一句话说明（详情面板正文第一行；**≤ 12 个汉字**，见 `use_hint` 的说明） */
    desc?: string;
    /**
     * 「为什么不能手动用 / 怎么生效」那一行（详情面板正文第二行；**≤ 12 个汉字**）。
     * ⚠ `effect_code` 非空的行（增益券）这一行会被**具体效果文案**顶掉（如「局内初始金币 +50」），
     * 那比一句"自动生效"有用得多 —— 见 `BagVM.buildDetailVM`。
     *
     * ⚠ 为什么卡 12 字：详情面板的 `desc` 是 `overflow=CLAMP`、`200×64`、`fs16/lh24` ⇒
     * **只放得下两行、每行约 12 个汉字**，第三行开始看不见。所以 `desc` / `use_hint` 都必须能一行放下，
     * 否则第一行折成两行、第二行就被裁掉（这一类"字被吃了"在编辑器里预览都看不出来，
     * 所以 `tools/bag-audit` 会按这个宽度**逐行估算**并拦下来）。
     */
    use_hint?: string;
    /** 图标资源路径（resources 相对、**不带扩展名**；留空 = 保留预制件占位图） */
    icon?: string;
    /** 品质（决定格子底框色；色值唯一真源 `game/common/RelicRarityColor.ts`） */
    rarity: BagItemRarity;
    /** 单格堆叠上限（**0 = 不限**） */
    stack_max: number;
    /** 能不能手动点「使用」（本期全部 false —— 这些道具都是入局 / 抽取时自动抵扣） */
    usable: boolean;
    /** 能不能「出售」（本期全部 false —— 金币是抽取燃料，不开回收口） */
    sellable: boolean;
    /** 出售单价（局外金币；`sellable=false` 时无意义） */
    sell_price?: number;
    /** 有效期（小时；**0 / 留空 = 永久** → 格子不显示倒计时） */
    expire_hours?: number;
    /** **增益券专用**：这张券对应哪条成就效果（`boost_*` 行必填，其它行留空） */
    effect_code?: AchEffectCode;
    /** 排序（升序；决定背包里格子的先后） */
    sort: number;
}

@tb_config(':tb/bag_items')
export class BagItemCfgContainer extends TbContainer<BagItemCfg> {
    getTbName(): string { return 'BagItemCfg'; }

    /** 按 `key` 取（`key` 列是语义标识，配置内唯一；代码与存档都认它） */
    getItemByKey(key: string): BagItemCfg | undefined {
        return this.cfgs.find(c => c.key === key);
    }

    /** 全部道具（按 `sort` 升序；`sort` 相同时按 id 兜底，保证顺序稳定） */
    getSortedItems(): BagItemCfg[] {
        return this.cfgs.slice().sort((a, b) => (a.sort ?? a.id) - (b.sort ?? b.id) || a.id - b.id);
    }

    /** 某条成就效果对应的增益券（`effect_code` 列反查；没有就返回 undefined） */
    getItemByEffectCode(code: AchEffectCode | string): BagItemCfg | undefined {
        return this.cfgs.find(c => c.effect_code === code);
    }

    /** 某个道具的单格堆叠上限（0 = 不限） */
    getStackMax(key: string): number {
        return Math.max(0, this.getItemByKey(key)?.stack_max ?? 0);
    }
}
