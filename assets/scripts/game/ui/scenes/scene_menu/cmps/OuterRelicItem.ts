import { _decorator, Color, Label, Sprite } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { AtlasIcon } from '../../../../common/AtlasIcon';
import { NodeUtils } from '../../../../common/NodeUtils';
import { rarityColor } from '../../../../common/RelicRarityColor';
import { relicOuterDesc, type RelicCfg } from '../../../../excel_table/Tb_RelicConfig';

const { ccclass, property } = _decorator;

/**
 * 局外遗物图鉴的**一行**（`Scene_Menu` → 遗物 → 总览 里的一个格子）
 *
 * 一行显示四件事（与用户口径一一对应）：
 *   ① **图标** —— `relics.icon`，走 `AtlasIcon`（图集 → 帧子资源 → 旧碎图，三条都试）；
 *   ② **名字** —— 按**品质色**上色（品质不进出图，只在 UI 里表现，见 `RelicRarityColor`）；
 *   ③ **效果描述** —— `description_outer`（**局外版**，不是局内版）；
 *   ④ **数量** —— `equipCollection` 里这件遗物的**收集次数**；没收集过显示「未获得」。
 *
 * **未获得 = 整行置灰**：用 `NodeUtils.setGray`（内置 `ui-sprite-gray-material` 材质）而不是
 * 逐个把 `color` 调灰 —— 材质方案对 Sprite 与 Label 一视同仁，也不会把"品质色"这个真源改掉
 * （`setGray(false)` 只是把 `customMaterial` 复位，品质色原样还在）。
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
     * 图标**底框**：品质色的唯一落点。
     * 与局内商店的 `ShopRiItem.frame` 同口径（白色圆角九宫格按品质染色），
     * 没在编辑器里拖也能按名字兜底找到。
     */
    @property(Sprite)
    frame: Sprite = null;

    /** 遗物名（按品质上色） */
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
     * @param count 已收集次数（0 = 未获得 → 整行置灰）
     */
    setInfo(cfg: RelicCfg, count: number): void {
        this.relicId = cfg?.id ?? 0;
        if (!cfg) return;

        const owned = count > 0;
        const tint = rarityColor(cfg.rarity);

        if (this.nameLabel) {
            this.nameLabel.string = cfg.name ?? '';
            this.nameLabel.color = new Color(tint);
        }
        const frame = this.ensureFrame();
        if (frame) frame.color = new Color(tint);
        if (this.descLabel) this.descLabel.string = relicOuterDesc(cfg);
        if (this.countLabel) {
            this.countLabel.string = owned ? `×${count}` : '未获得';
        }

        this.loadIcon(cfg.icon);
        // 置灰放在最后：它按材质作用在**整行**（含图标、名字、描述、数量）上，与上面设的颜色互不干扰
        NodeUtils.setGray(this.node, !owned);
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
