import { _decorator, Color, Label, Sprite } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { AtlasIcon } from '../../../../common/AtlasIcon';
import { NodeUtils } from '../../../../common/NodeUtils';
import { rarityColor } from '../../../../common/RelicRarityColor';
import { formatTags } from '../../../../common/RelicTags';
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

    /**
     * **流派标签**（`relics.tags` 全部，`·` 连接，见 `common/RelicTags`）。
     *
     * 与局内商店格 `ShopRiItem.tagsLabel` 的分工：那一格只有 70px 宽 → 只放**主标签**；
     * 这里第一行 `name` 右侧空着约 260px → **放得下全部**（2026-11 局外池扩到 268 件之后
     * 最坏情况仍是 3 个标签：3×4 汉字 @14px ≈ 199px，框宽 260px 以内）。
     *
     * ⚠ 标签来自 `relics.tags`（由内层设计推出来，全表 268 件都有）；`gen-relics-inner-from-design`
     * 会拦"一件没有任何标签"，所以这一行**不该**出现空串 —— 真出现就是那条红线被绕过了。
     * （历史：以前有 9 件"只有局外版"的中立道具没标签，2026-11 那 9 件已整行删除。）
     *
     * 预制件里是 `templates/OuterRelicItem/tags`（fs14 / `#999999` / 左对齐）；
     * 没在编辑器里拖也能跑：`ensureTags()` 按名字兜底。
     */
    @property(Label)
    tagsLabel: Label = null;

    /** 当前显示的遗物 id（0 = 没内容；调试用） */
    relicId = 0;

    /** 底框节点名（预制件契约，与 `ShopRiItem` 一致） */
    private static readonly FRAME_NODE = 'head';

    /** 流派标签节点名（预制件契约：本节点的直接子节点 `tags`，与 `name` 同一行） */
    private static readonly TAGS_NODE = 'tags';

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
        // 流派标签：全部铺上（这一行放得下），9 件仅局外版的中立道具没有 → 空串留白
        const tags = this.ensureTags();
        if (tags) tags.string = formatTags(cfg.tags);
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

    /** 标签 Label：同上，没拖引用就按名字 `tags` 兜底 */
    private ensureTags(): Label {
        if (this.tagsLabel?.isValid) return this.tagsLabel;
        const found = this.node.getChildByName(OuterRelicItem.TAGS_NODE);
        this.tagsLabel = found?.getComponent(Label) ?? null;
        return this.tagsLabel;
    }

    /**
     * 加载图标。`relics.json` 的 `icon` 对**全表 268 件**全是本地路径
     * （`textures/relics/<key>`），所以这里只走本地分支 —— 原来那 9 件"只有局外版"的中立道具
     * 有远程 URL 记录，2026-11 已整行删除（`ShopRelicsItem` 里保留着远程那一支做兼容）。
     * 没配图标 → 保持预制件里的占位图不动，不报错（图鉴里空格子比"坏了"更像坏了）。
     *
     * ⚠ **异步回来时必须认人**（`relicId` 而不是 `this.icon.isValid` 就算数）：
     * 总览列表 2026-11 改成虚拟列表后，格子是**对象池里复用**的 —— 同一个节点这一帧画 A、下一帧可能画 B，
     * 而 `AtlasIcon` 是按路径缓存的 promise（解析快慢不一）。不校验的话，A 那张图晚一步解析完
     * 会盖到正在显示 B 的格子上，**而且会一直错到那一格再次被重画**（名字写着 B、图标是 A）。
     * `ItemBagCell.applyIcon` 是同一条口径的先例（那里比的是 `iconPath`）。
     */
    private loadIcon(url: string): void {
        if (!this.icon || !url) return;
        const expectId = this.relicId;
        AtlasIcon.loadIconFrame(url).then((sf) => {
            if (sf && this.icon?.isValid && this.relicId === expectId) this.icon.spriteFrame = sf;
        });
    }
}
