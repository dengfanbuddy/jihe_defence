import { _decorator, Button, Color, Label, Node, Sprite } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { AtlasIcon } from '../../../../common/AtlasIcon';
import { tierColor, tierName } from '../../../../common/AchievementTierColor';
import { achEffectLabel, achEffectMeta } from '../../../../common/AchievementEffectMeta';
import { AchievementConfig } from '../../../../data/configs/AchievementConfig';
import { AchScopeEvents } from './AchievementScope';
import type { AchGroupState } from '../../../../data/funcs/AchievementData';

const { ccclass, property } = _decorator;

/**
 * 三种（四种）状态的表现 —— **唯一配色源**（取自任务界面作者摆的三态色：
 * 未达成灰 / 领取青 / 已领取浅灰，两处界面因此长得一样）。
 *
 * ⚠ 为什么不交给 Button 的 Color 过渡：`interactable = false` 时 Button 会用 `_disabledColor`
 * 统一覆盖外观，而「未达成」与「已领取」都不可点、作者摆的两种颜色会被同一块灰吃掉
 * （与 `TaskItem` 同一个坑）。所以这里把 `transition` 关掉、颜色由本组件写。
 */
const STATE_STYLE: Record<string, { text: string; bg: string; labelColor: string }> = {
    active: { text: '未达成', bg: '#B9C1C1', labelColor: '#FFFFFF' },
    claimable: { text: '领取', bg: '#3F9E9B', labelColor: '#FFFFFF' },
    claimed: { text: '已领取', bg: '#E0E4E4', labelColor: '#9AA6A6' },
    done: { text: '已领取', bg: '#E0E4E4', labelColor: '#9AA6A6' },
};

/** 隐藏成就未达成时的卡面文案（列表里由数据层过滤，这里是防御性兜底） */
const UNKNOWN_NAME = '???';
const UNKNOWN_DESC = '未知的挑战';

/**
 * 成就列表里的**一张卡**（内嵌 UI 小组件 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * 职责只有两件（与 `TaskItem` 同分工）：
 *   ① 渲染：把宿主下发的 `AchGroupState` 画到预制件的节点上（档位色 / 图标 / 描述进度 /
 *      领取区 / 2 个效果槽 / 效果明细行）；
 *   ② 通知：点「领取」时 `scope.emit(AchScopeEvents.Claim, group)` —— 领奖、发奖、刷新都由宿主做。
 *
 * 节点契约（与 `Scene_Menu.prefab` 的 `content/right/achivements/lists/card` 一致，见设计稿 §7.4）：
 * ```
 * card
 * ├── bg            底图（**纯白 `c-surface` + `rect_rd_20` 大圆角**，运行期不再染色）
 * ├── tier_bar      档位刻度条（卡左缘 10×158 竖条，**卡面上唯一的档位色彩载体**）
 * ├── icon          图标槽 → inner(成就图标) / lock(未达成遮罩)
 * ├── name          成就名（`c-ink-900`）
 * ├── lv            档位（铜/银/金，`c-ink-900` —— 颜色由 `tier_bar` 回答）
 * ├── detail/Label  描述 + 当前档进度（最多 3 行：描述折 2 行 + 进度 1 行）
 * ├── unlock        领取区 → Label / icon(金币) / value(金币数, 缩写)
 * ├── weapon(-001)  2 个效果槽（末档效果生效才亮）
 * └── property(-001) 2 列效果明细（末档效果生效才显示，v1 只会用到第 1 列）
 * ```
 * 所有子节点引用都按名字兜底解析（`@property` 没拖也能跑），与 `TaskItem.resolveRefs` 同一套路。
 *
 * ⚠ **2026-11 卡面改版（对齐 `docs/美术风格预设.md`）**：改版前卡面是「`rect_rd_5` + 整块档位色
 * 低透明度晕染」，且 `unlock` 用的是 `rect_board_rd_10`（**只描边不填充的空心环**）配白字 ——
 * 白字写在白卡面上根本读不出来（旧版之所以能读，是因为卡面被铜色晕染成了中明度底）。
 * 现在：卡面纯白 `rect_rd_20`、档位色收敛到左缘 `tier_bar`、`unlock` 换成**实底药丸**
 * （`rect_rd_20`，40 高 → 正好是胶囊形），白字这才成立。
 *
 * ⚠ **同一次改版顺带修掉的两条「文字被裁」**（都是布局宽度/高度不够，编辑器里预览看不出来）：
 *   ① `detail` 原来只有 2 行高（44px）—— 6 字以上的描述折成 2 行就**把进度行挤掉了**
 *      （最长的描述 24 字，实测 `20/20` 整行消失）。现在按 1.5 倍行距给足 3 行（210×72）。
 *   ② 效果明细原来是 4 列 × 86px —— 14px 字号下 6 字的效果名（如「局内初始金币」）要 84px，
 *      再塞 20px 图标必然被裁。现在收成 **2 列 × 176px**，与 2 个效果槽一一对应
 *      （配表侧一条成就最多 1 个效果、契约侧 2 个槽 → 4 列里后两列永远是死节点，已删）。
 */
@ccclass('AchievementItem')
export class AchievementItem extends UIWidget {

    @property(Sprite)
    bgSprite: Sprite = null;
    /** 档位刻度条（卡左缘竖条）—— 卡面上**唯一**的档位色彩载体 */
    @property(Sprite)
    tierBarSprite: Sprite = null;
    @property(Sprite)
    iconSprite: Sprite = null;
    @property(Node)
    lockNode: Node = null;
    @property(Label)
    nameLabel: Label = null;
    @property(Label)
    tierLabel: Label = null;
    @property(Label)
    detailLabel: Label = null;
    @property(Sprite)
    unlockSprite: Sprite = null;
    @property(Label)
    unlockLabel: Label = null;
    @property(Node)
    unlockValueNode: Node = null;
    @property(Label)
    unlockValueLabel: Label = null;
    @property(Node)
    weaponNode: Node = null;
    @property(Node)
    weaponNode2: Node = null;
    /** 效果明细列（2 列，与 2 个效果槽一一对应；v1 只会用到第 1 列） */
    @property([Node])
    propertyNodes: Node[] = [];

    /** 当前卡面数据（null = 空格子） */
    private state: AchGroupState | null = null;
    /** 已经加载过的图标路径（避免同一张卡重刷时反复解析） */
    private loadedIcon: string | null = null;

    protected onInit(): void {
        this.resolveRefs();
        // 未达成时整张卡不可点（可领取才可点），按钮表现自己写色
        const btn = this.unlockBtn();
        if (btn) {
            btn.transition = Button.Transition.NONE;
            btn.node.on(Button.EventType.CLICK, this.onClickClaim, this);
        }
    }

    protected onShow(): void {
        // 显示时按当前数据无条件重画一次（state 是普通字段，watch 感知不到）
        if (this.state) this.apply();
    }

    protected onDispose(): void {
        // 后代节点走 offNodeEvent（节点销毁时 node.off 会炸，见 AGENTS.md）
        const btn = this.unlockBtn(false);
        if (btn) this.offNodeEvent(btn.node, Button.EventType.CLICK, this.onClickClaim, this);
    }

    /* ===================================================================
     * 对外：宿主下发数据
     * =================================================================== */

    /**
     * 设置这一张卡要显示的成就。
     * @param state 由 `AchievementData.getGroupState()` 拿到的**整包状态**（null = 空格子，整卡收起）。
     *              卡面**不自己重算判据**：状态、进度、奖励、效果全由数据层给。
     */
    setInfo(state: AchGroupState | null): void {
        this.state = state ?? null;
        this.apply();
    }

    /** 当前卡片对应的成就 group（空串 = 空格子） */
    getGroup(): string {
        return this.state?.group ?? '';
    }

    /** 是否可领取（宿主判断"这一格能不能点"时也可问它） */
    isClaimable(): boolean {
        return this.state?.state === 'claimable';
    }

    /* ===================================================================
     * 内部：渲染
     * =================================================================== */

    private apply(): void {
        const s = this.state;
        if (!s) {
            this.node.active = false;
            return;
        }
        this.node.active = true;

        this.applyBgAndTier(s);
        this.applyIcon(s);
        this.applyText(s);
        this.applyUnlock(s);
        this.applyEffects(s);
    }

    /**
     * 档位：**只染左缘的刻度条**，卡面（`bg`）保持纯白、`lv` 保持墨色。
     *
     * 口径见 `AchievementTierColor` 的文件头：档位色是「品质色」那一轴的点缀，
     * 不该铺满卡面（浅底上会与正文的深色文字抢对比度，金档尤其）,也不该同时出现在两处。
     */
    private applyBgAndTier(s: AchGroupState): void {
        const hex = tierColor(s.tier);
        if (this.tierBarSprite) this.tierBarSprite.color = new Color().fromHEX(hex);
        if (this.tierLabel) this.tierLabel.string = tierName(s.tier);
    }

    /** 成就图标（配表 `icon` 是 resources 相对路径、不带扩展名；空/加载失败都保持预制件里的占位图） */
    private applyIcon(s: AchGroupState): void {
        if (this.lockNode) this.lockNode.active = s.state === 'active';
        if (!this.iconSprite) return;
        const icon = s.icon;
        if (!icon) {
            this.loadedIcon = null;       // 配表没给图标 → 保留占位图
            return;
        }
        if (this.loadedIcon === icon) return;
        this.loadedIcon = icon;
        AtlasIcon.loadIconFrame(icon).then((sf) => {
            if (!sf || !this.iconSprite || !this.iconSprite.isValid) return;
            this.iconSprite.spriteFrame = sf;
        });
    }

    /** 名称 / 描述 + 进度 */
    private applyText(s: AchGroupState): void {
        if (this.nameLabel) this.nameLabel.string = s.hidden ? UNKNOWN_NAME : s.name;

        if (this.detailLabel) {
            if (s.hidden) {
                this.detailLabel.string = UNKNOWN_DESC;
            } else if (s.state === 'done') {
                // 已领完末档：不再显示进度（设计稿 §7.4 的表现矩阵）
                this.detailLabel.string = `${s.desc}\n已完成`;
            } else {
                const tierCfg = AchievementConfig.getTierCfg(s.group, s.nextTier);
                const progressText = tierCfg
                    ? AchievementConfig.getProgressText(tierCfg, s.progress)
                    : `${s.progress}/${s.count}`;
                this.detailLabel.string = `${s.desc}\n${progressText}`;
            }
        }
    }

    /** 领取区：文案 + 底色 + 能否点击 + 下一档金币（缩写） */
    private applyUnlock(s: AchGroupState): void {
        const style = STATE_STYLE[s.state] ?? STATE_STYLE.active;
        const canClaim = s.state === 'claimable';

        const btn = this.unlockBtn();
        if (btn) btn.interactable = canClaim;
        if (this.unlockSprite) this.unlockSprite.color = new Color().fromHEX(style.bg);
        if (this.unlockLabel) {
            this.unlockLabel.string = s.hidden ? '未达成' : style.text;
            this.unlockLabel.color = new Color().fromHEX(style.labelColor);
        }
        const showValue = !s.hidden && s.nextReward > 0;
        if (this.unlockValueNode) this.unlockValueNode.active = showValue;
        if (this.unlockValueLabel) this.unlockValueLabel.string = AchievementConfig.formatGold(s.nextReward);
    }

    /**
     * 效果槽 + 效果明细列：**只有「末档效果已生效」才亮**（铜/银档阶段整块收起）。
     * v1 一条成就最多 1 个效果，所以第 2 个槽与第 2 列明细一律收起。
     */
    private applyEffects(s: AchGroupState): void {
        const unlocked = s.effectUnlocked && !!s.effect;
        if (this.weaponNode) this.weaponNode.active = unlocked;
        if (this.weaponNode2) this.weaponNode2.active = false;

        for (let i = 0; i < this.propertyNodes.length; i++) {
            const row = this.propertyNodes[i];
            if (!row) continue;
            const used = unlocked && i === 0;
            row.active = used;
            if (!used || !s.effect) continue;
            const meta = achEffectMeta(s.effect.code);
            const nameLabel = row.getChildByName('name')?.getComponent(Label);
            const valueLabel = row.getChildByName('value')?.getComponent(Label);
            // `name` / `value` 两行合起来就是一条效果的完整文案（如「局内初始金币」+「+50」）
            if (nameLabel) nameLabel.string = meta ? meta.name : s.effect.code;
            if (valueLabel) {
                const text = achEffectLabel(s.effect.code, s.effect.value);
                const space = text.lastIndexOf(' ');
                valueLabel.string = space >= 0 ? text.slice(space + 1) : text;
            }
        }
    }

    /** 点击领取：只向上通知宿主（不可点时不发） */
    private onClickClaim(): void {
        if (!this.isClaimable() || !this.state) return;
        this.scope.emit(AchScopeEvents.Claim, this.state.group);
    }

    /* ===================================================================
     * 节点契约
     * =================================================================== */

    /** 领取按钮（缺 Button 时补一个；`create=false` 只查不建，销毁时用） */
    private unlockBtn(create = true): Button | null {
        const node = this.unlockSprite?.node ?? this.node.getChildByName('unlock');
        if (!node) return null;
        const exist = node.getComponent(Button);
        if (exist) return exist;
        return create ? node.addComponent(Button) : null;
    }

    /** 按名字兜底解析子节点（预制件里没拖 `@property` 也能跑） */
    private resolveRefs(): void {
        const n = this.node;
        const icon = n.getChildByName('icon');
        const unlock = n.getChildByName('unlock');
        const detail = n.getChildByName('detail');

        this.bgSprite = this.bgSprite ?? n.getChildByName('bg')?.getComponent(Sprite);
        this.tierBarSprite = this.tierBarSprite ?? n.getChildByName('tier_bar')?.getComponent(Sprite);
        this.iconSprite = this.iconSprite ?? icon?.getChildByName('inner')?.getComponent(Sprite);
        this.lockNode = this.lockNode ?? icon?.getChildByName('lock');
        this.nameLabel = this.nameLabel ?? n.getChildByName('name')?.getComponent(Label);
        this.tierLabel = this.tierLabel ?? n.getChildByName('lv')?.getComponent(Label);
        this.detailLabel = this.detailLabel ?? detail?.getChildByName('Label')?.getComponent(Label);
        this.unlockSprite = this.unlockSprite ?? unlock?.getComponent(Sprite);
        this.unlockLabel = this.unlockLabel ?? unlock?.getChildByName('Label')?.getComponent(Label);
        this.unlockValueNode = this.unlockValueNode ?? unlock?.getChildByName('value');
        this.unlockValueLabel = this.unlockValueLabel ?? unlock?.getChildByName('value')?.getComponent(Label);
        this.weaponNode = this.weaponNode ?? n.getChildByName('weapon');
        this.weaponNode2 = this.weaponNode2 ?? n.getChildByName('weapon-001');

        if (!this.propertyNodes.length) {
            const rows: Node[] = [];
            // 只有 2 列（与 `weapon` / `weapon-001` 两个效果槽一一对应）；名字不在 = 该列不存在，跳过不报错
            for (const name of ['property', 'property-001']) {
                const row = n.getChildByName(name);
                if (row) rows.push(row);
            }
            this.propertyNodes = rows;
        }

        if (!this.nameLabel || !this.unlockSprite) {
            console.warn('[AchievementItem] 子节点契约不完整（需要 name / unlock）：', n.name);
        }
    }
}
