import { _decorator, Color, Label, Sprite } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { AtlasIcon } from '../../../../common/AtlasIcon';
import { NodeUtils } from '../../../../common/NodeUtils';
import { rarityColor } from '../../../../common/RelicRarityColor';
import { relicOuterDesc, type RelicCfg } from '../../../../excel_table/Tb_RelicConfig';

const { ccclass, property } = _decorator;

/**
 * 品质色的**两个落点**，都是「白模贴图 × 品质色」：
 *   · 本节点自己的 Sprite —— 卡片的 **2px 描边层**（`rect_rd_20` 染品质色，内衬白卡 `bg` 压出边）
 *   · `head` —— 图标底框（与局内商店 `ShopRiItem.frame` 同口径）
 *
 * ⚠ **不要用 `rect_board_rd_20` 当彩色描边**：那张图的主体是**烤进去的青绿** `#70B0B0`
 * （`probe` 实测 meanRGB 92/140/138、白像素占比 0），`Sprite.color` 乘上去只会得到脏色
 * （红 × 青绿 = `#6F4241` 暗褐）。`rect_board_*` 只能原色用（= 选中环）。
 */

/** 未获得的描边/图标框色（`c-disabled-pill`：全工程「这一颗现在不可用」的灰） */
const UNOWNED_COLOR = '#B9C1C1';
/** 「刚抽到」的描边/图标框色（`c-accent-action`：全工程「这里能点/可领取」的青绿）—— 只活到离开这一页 */
const FRESH_COLOR = '#3F9E9B';
/** 已获得的数量色（`c-accent-400`：与金币/经验条同族的青绿） */
const COUNT_OWNED_COLOR = '#70ACB3';
/** 未获得的数量色（`c-ink-400`） */
const COUNT_UNOWNED_COLOR = '#999999';

/**
 * 局外遗物图鉴的**一行**（`Scene_Menu` → 遗物 → 总览 里的一个格子）
 *
 * 一行显示四件事（与用户口径一一对应）：
 *   ① **图标** —— `relics.icon`，走 `AtlasIcon`（图集 → 帧子资源 → 旧碎图，三条都试）；
 *   ② **名字** —— 固定墨色 `c-ink-900`（**不按品质上色**：白档 `#DDDDDD` 在纸面底上读不出来，
 *      品质改由「卡片描边 + 图标框」两处表达，见下）；
 *   ③ **效果描述** —— `description_outer`（**局外版**，不是局内版）；
 *   ④ **数量** —— `equipCollection` 里这件遗物的**收集次数**（青绿 `×3`）；没收集过是灰色「未获得」。
 *
 * **未获得**有两条并行的表现，缺一不可：
 *   · **材质置灰** —— `NodeUtils.setGray`（内置 `ui-sprite-gray-material`）把整行（图标/文字/描边）
 *     一起压灰。它在编辑器里**看不到效果**（场景视图不吃 `customMaterial`，实测截出来仍是彩色），
 *     只能真机预览验；
 *   · **描边/图标框改成 `UNOWNED_COLOR` 灰** —— 这一条是**看得见**的那条，也让"未获得"不依赖材质。
 *     改色不会丢真源：`setInfo` 每次都会把颜色整体重写一遍（已获得写品质色），不像 `ShopRiItem` 那样
 *     需要自己缓存 `baseColors`。
 *
 * 内嵌 UI 小组件 → 继承 `UIWidget`，**不加 `@uiview`**。
 * 本组件不认识列表、不认识分页，只负责「给我一条配置 + 一个数量，我把自己画对」。
 */
@ccclass('OuterRelicItem')
export class OuterRelicItem extends UIWidget {

    /** 图标本体（预制件里 `head/inner` 那层） */
    @property(Sprite)
    icon: Sprite = null;

    /**
     * 图标**底框**：品质色的落点之一（另一处是卡片描边，见 `ensureBorder`）。
     * 与局内商店的 `ShopRiItem.frame` 同口径（白色圆角九宫格按品质染色），
     * 没在编辑器里拖也能按名字兜底找到。
     */
    @property(Sprite)
    frame: Sprite = null;

    /** 遗物名（固定 `c-ink-900`，**不按品质上色** —— 白档在纸面底上读不出来） */
    @property(Label)
    nameLabel: Label = null;

    /** 数量：`×3`；一件都没有时是「未获得」 */
    @property(Label)
    countLabel: Label = null;

    /** 效果描述（`description_outer`） */
    @property(Label)
    descLabel: Label = null;

    /** 当前显示的遗物 id（0 = 没内容；调试用） */
    relicId = 0;

    /** 底框节点名（预制件契约，与 `ShopRiItem` 一致） */
    private static readonly FRAME_NODE = 'head';

    /**
     * 填一行数据。
     * @param cfg   `relics.json` 里**有局外版**的那一行
     * @param count 已收集次数（0 = 未获得 → 描边转灰 + 整行材质置灰）
     * @param fresh 是不是**刚抽到**的（图鉴页抽完之后高亮一遍：描边/图标框改 `c-accent-action`）。
     *              它**只活到离开这一页**（`Cmp_OuterRelics.onShow` 重铺时就不带了），
     *              用来回答"我刚才抽到了哪几件"；不是一种持久状态，别拿它当"新获得"标记。
     */
    setInfo(cfg: RelicCfg, count: number, fresh = false): void {
        this.relicId = cfg?.id ?? 0;
        if (!cfg) return;

        const owned = count > 0;
        // 未获得时描边/图标框走灰（看得见的那条判据）；刚抽到的高亮成青绿；其余按品质
        // ⚠ 刚抽到的一定是"已获得"，所以这两条不会打架（fresh 优先级更高）
        const tint = fresh ? FRESH_COLOR : (owned ? rarityColor(cfg.rarity) : UNOWNED_COLOR);

        // 名字固定墨色（预制件里就是 c-ink-900），品质改由描边 + 图标框表达
        if (this.nameLabel) this.nameLabel.string = cfg.name ?? '';
        const frame = this.ensureFrame();
        if (frame) frame.color = new Color(tint);
        const border = this.ensureBorder();
        if (border) border.color = new Color(tint);
        if (this.descLabel) this.descLabel.string = relicOuterDesc(cfg);
        if (this.countLabel) {
            this.countLabel.string = owned ? `×${count}` : '未获得';
            this.countLabel.color = new Color(owned ? COUNT_OWNED_COLOR : COUNT_UNOWNED_COLOR);
        }

        this.loadIcon(cfg.icon);
        // 置灰放在最后：它按材质作用在**整行**（含图标、名字、描述、数量）上，与上面设的颜色互不干扰
        NodeUtils.setGray(this.node, !owned);
    }

    /**
     * 描边层 = **本节点自己的 Sprite**（预制件里 `rect_rd_20` 白色九宫格，内衬子节点 `bg` 白卡）。
     * 返回 null 说明预制件缺 Sprite —— 那时只是没有品质描边，不影响其余部分。
     */
    private ensureBorder(): Sprite {
        return this.node.getComponent(Sprite);
    }

    /** 底框 Sprite：优先用编辑器拖的引用，没拖就按名字找（同 `ShopRiItem.ensureFrame` 的套路） */
    private ensureFrame(): Sprite {
        if (this.frame?.isValid) return this.frame;
        const found = this.node.getChildByName(OuterRelicItem.FRAME_NODE);
        this.frame = found?.getComponent(Sprite) ?? null;
        return this.frame;
    }

    /**
     * 加载图标。`relics.json` 的 `icon` 对**有局外版的 37 件**全是本地路径
     * （远程 URL 只剩 7 件**仅局外**的中立道具…的旧记录；实测这 37 件的 `icon` 全是
     * `textures/relics/<key>`，所以这里只走本地分支）。
     * 没配图标 → 保持预制件里的占位图不动，不报错（图鉴里空格子比"坏了"更像坏了）。
     */
    private loadIcon(url: string): void {
        if (!this.icon || !url) return;
        AtlasIcon.loadIconFrame(url).then((sf) => {
            if (sf && this.icon?.isValid) this.icon.spriteFrame = sf;
        });
    }
}
