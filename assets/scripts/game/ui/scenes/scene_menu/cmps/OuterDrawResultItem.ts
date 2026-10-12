import { _decorator, Color, Component, Label, Sprite } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { AtlasIcon } from '../../../../common/AtlasIcon';
import { rarityColor } from '../../../../common/RelicRarityColor';

const { ccclass, property } = _decorator;

/** 「第一次收集到」的角标色（`c-accent-action`：全工程「这里能点 / 可领取」的青绿） */
const NEW_COLOR = '#3F9E9B';
/** 重复抽到时报份数的颜色（`c-accent-400`：与进度条同族的青绿） */
const COUNT_COLOR = '#70ACB3';

/** 节点契约（预制件 `ui_draw_result/templates/DrawResultItem`；没拖引用也能按名字兜底） */
const NODE = {
    /** 图标**底框**（品质色的落点之一，与 `OuterRelicItem.frame` 同口径） */
    frame: 'head',
    /** 图标本体 */
    icon: 'head/inner',
    name: 'name',
    sub: 'sub',
} as const;

/**
 * 抽取结果弹窗里的**一张卡**（`ui_draw_result/templates/DrawResultItem`，运行时克隆）
 *
 * 画四件事：
 *   ① **图标** —— `relics.icon`，走 `AtlasIcon`（图集 → 帧子资源 → 旧碎图，三条都试，同 `OuterRelicItem`）；
 *   ② **品质** —— 卡片描边（本节点自己的 Sprite）+ 图标底框两处染 `rarityColor`，**不写文字**；
 *   ③ **名字** —— `c-ink-900`（固定墨色，品质由描边表达，白档 `#DDDDDD` 在纸面底上读不出来）；
 *   ④ **一行小字** —— 「新获得」（第一次收集到）/ `×N`（重复抽到，N = 抽完之后的**总份数**）/ 空。
 *
 * ⚠ 这里**不显示"这次抽到了几件"** —— 那是本次操作的总数，写在按钮上会把"下一抽多少钱"挤掉
 *   （用户口径见 `docs/meta-growth/README.md` §1.6）。一张卡只说它自己这一件。
 *
 * 本组件**不认识 `DataCenter`、不认识配表**：名字 / 品质 / 图标路径 / 份数全部由面板算好下发
 * （与 `OuterRelicItem.setInfo` 的分工差别：那一行的数量是**图鉴存量**，这一张的份数是**抽完之后的存量**）。
 *
 * 内嵌 UI 小组件 → 继承 `UIWidget`，**不加 `@uiview`**。
 */
@ccclass('OuterDrawResultItem')
export class OuterDrawResultItem extends UIWidget {

    /** 图标本体（`head/inner`） */
    @property(Sprite)
    icon: Sprite = null;

    /** 图标底框：品质色的落点之一（另一处是卡片描边，见 `applyBorder`） */
    @property(Sprite)
    frame: Sprite = null;

    /** 遗物名（固定 `c-ink-900`） */
    @property(Label)
    nameLabel: Label = null;

    /** 名字下面那行小字：「新获得」/ `×N` / 空（空 = 收起节点） */
    @property(Label)
    subLabel: Label = null;

    /** 当前显示的遗物 id（0 = 没内容；调试用） */
    relicId = 0;

    /** 已加载过的图标路径（同一张卡复用时不重复解析） */
    private loadedIcon: string | null = null;

    /**
     * 填一张卡。
     *
     * @param id     遗物 id（`relics.json`）
     * @param name   遗物名
     * @param rarity 品质（`common` / `rare` / `epic` / `legendary`）
     * @param icon   图标路径（`textures/relics/<key>`；空 = 保留预制件里的占位图）
     * @param count  抽完之后的**总份数**（≥1；>1 时卡上写 `×N`）
     * @param isNew  这一件是不是**第一次**收集到（true 时优先写「新获得」）
     */
    setInfo(id: number, name: string, rarity: string, icon: string, count: number, isNew: boolean): void {
        this.relicId = id || 0;

        const tint = rarityColor(rarity);
        const frame = this.pick(this.frame, NODE.frame, Sprite);
        this.frame = frame;
        if (frame) frame.color = new Color(tint);
        const border = this.node.getComponent(Sprite);
        if (border) border.color = new Color(tint);

        const nameLabel = this.pick(this.nameLabel, NODE.name, Label);
        this.nameLabel = nameLabel;
        if (nameLabel) nameLabel.string = name ?? '';

        const sub = this.pick(this.subLabel, NODE.sub, Label);
        this.subLabel = sub;
        if (sub) {
            const total = Math.max(1, Math.floor(count) || 1);
            // 三态：新获得 ＞ 有份数 ＞ 空（收起节点，免得留一条空行把卡撑高）
            if (isNew) {
                sub.string = '新获得';
                sub.color = new Color(NEW_COLOR);
            } else if (total > 1) {
                sub.string = `×${total}`;
                sub.color = new Color(COUNT_COLOR);
            } else {
                sub.string = '';
            }
            sub.node.active = sub.string.length > 0;
        }

        if (icon && this.loadedIcon !== icon) {
            this.loadedIcon = icon;
            const target = this.pick(this.icon, NODE.icon, Sprite);
            this.icon = target;
            AtlasIcon.loadIconFrame(icon).then((sf) => {
                if (sf && target?.isValid) target.spriteFrame = sf;
            });
        }
    }

    /**
     * 取一个子节点上的组件：**先校验编辑器拖进来的引用真是这个类型**，不是就按节点名兜底。
     *
     * ⚠ 为什么不能只写 `this.frame ?? 按名字找`：预制件里把 **`Node`** 拖进 `@property(Sprite)` / `@property(Label)`
     * 字段时，序列化下来的是那个"不匹配的引用"，运行时 `this.frame` 非空、`isValid` 也是 true ——
     * `?? ` 与 `if (x)` 两条兜底**全都不生效**，于是 `x.color` / `x.node` 在**别的行**上炸
     * （实测：把 `sub` 拖成了 Node，报错落在 `sub.node.active`，栈上完全看不出是引用拖错了）。
     * 这类"拖错引用"在编辑器里看不出来、预制件 JSON 里也只是一条合法引用，只有运行时才现形
     * （同 `HeroCard` / `audit:bag` F16b 记过的那条）。
     */
    private pick<T extends Component>(current: T, path: string, ctor: new () => T): T {
        if (current instanceof ctor && current.isValid) return current;
        return this.node.getChildByPath(path)?.getComponent(ctor) ?? null;
    }
}
