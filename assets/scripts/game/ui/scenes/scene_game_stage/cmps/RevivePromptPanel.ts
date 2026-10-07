import { _decorator, BlockInputEvents, Button, Color, Component, Label, Node, resources, Sprite, SpriteFrame, UITransform, view } from 'cc';

const { ccclass } = _decorator;

/**
 * RevivePromptPanel —— **英雄阵亡后的复活面板**（"用复活券 / 看广告复活 / 放弃本局"）
 *
 * ── 它解决什么 ──
 *   局内死亡原来只有一条路：`OnDeath → endRun('defeat')` 直接判负。现在多了一条**用玩家自己的东西换一次机会**：
 *   背包里的**局内复活券**（商城 A5 发，跨局累积）或**看一次广告**（每局限 `battle_constants.reviveAdPerRun` 次）。
 *   两者都是"**在用的地方检查背包 / 配额**"，判据不在本文件里（见 `Scene_Game_Stage.onLethalForHero`）。
 *
 * ── 为什么是**运行期建节点**而不是预制件 ──
 *   ① 面板只有一种形态、没有素材依赖（底就是 `rect_rd_20` 九宫格 + 三个 `Label`），
 *      而 `View_Game_Stage.prefab` 是 59 万字符的大预制件 —— 为一块新面板去改它，
 *      风险（fileId / PrefabInfo / 引用）明显高于收益；
 *   ② 工程里已有同类先例：`HitVfxLayer` / `HitScreenLayer` 都是运行期建节点 + 挂 `@ccclass` 组件
 *      （见 `docs/agent-notes/UI与表现层.md`）。
 *   ⚠ 所以本面板的颜色 / 字号**必须手工对齐 `docs/art-style/tokens.json`**（`audit:ui` 只扫预制件，
 *     扫不到运行期写的色）——下面每个常量都标了 token 名，改色请三处同改（md / tokens.json / 这里）。
 *
 * ── 分工（与项目其它 UI 一致）──
 *   · **判据在宿主**：`show(vm)` 收到的是"那一刻能不能用券 / 能不能看广告"的快照，面板不读数据层；
 *   · **动作向上报**：点哪颗按钮 → `onChoose('ticket' | 'ad' | 'giveup')`，由 `Scene_Game_Stage` 执行；
 *   · **不可用的按钮直接不画**（不画灰态"点不动又不说明"的按钮，见 `docs/bag/README.md` §5）。
 *
 * @example
 * ```ts
 * // Scene_Game_Stage（宿主）
 * this.revivePrompt = RevivePromptPanel.ensure(this.uiViewNode);
 * this.revivePrompt.onChoose = (c) => this.onReviveChoice(c);
 * this.revivePrompt.show({ ticketLeft: 2, canAd: true });
 * ```
 */
@ccclass('RevivePromptPanel')
export class RevivePromptPanel extends Component {

    /* ── 颜色（token 名 → 值，唯一真源 docs/art-style/tokens.json）── */
    /** `c-scrim`（遮罩 #000000 · alpha 0.7） */
    private static readonly SCRIM = new Color(0, 0, 0, 178);
    /** `c-surface`（卡片底 #FFFFFF） */
    private static readonly CARD = '#FFFFFF';
    /** `c-accent-action`（可点按钮底 #3F9E9B） */
    private static readonly BTN_ON = '#3F9E9B';
    /** `c-disabled-pill`（放弃那颗：不可点的药丸底 #B9C1C1） */
    private static readonly BTN_OFF = '#B9C1C1';
    /** `c-ink-900`（一级标题 #445054） */
    private static readonly INK_TITLE = '#445054';
    /** `c-ink-400`（次要说明 #999999） */
    private static readonly INK_HINT = '#999999';
    /** 深底上的文字：`c-text-on-dark` #FFFFFF */
    private static readonly TEXT_ON_DARK = '#FFFFFF';

    /* ── 字号（token 名 → 值，tokens.typography.scale）── */
    /** `h1` = 24 面板标题 */
    private static readonly FS_TITLE = 24;
    /** `h2` = 20 按钮文字 */
    private static readonly FS_BTN = 20;
    /** `caption` = 14 说明行 */
    private static readonly FS_HINT = 14;

    /* ── 版式（设计分辨率 750×1334 的一半 = 375×667）── */
    private static readonly CARD_W = 560;
    private static readonly CARD_H = 420;
    private static readonly BTN_W = 440;
    private static readonly BTN_H = 76;

    /** 点了一颗按钮（宿主执行真正的动作；本面板只上报） */
    public onChoose: ((choice: ReviveChoice) => void) = null;

    /** 卡片根（控件都在它下面；`hide()` 只关它，遮罩也跟着关） */
    private card: Node = null;
    private titleLabel: Label = null;
    private hintLabel: Label = null;
    private ticketBtn: Button = null;
    private ticketLabel: Label = null;
    private adBtn: Button = null;
    private giveupBtn: Button = null;

    /**
     * 建（或复用）一块复活面板。
     *
     * ⚠ 幂等：同一个宿主节点上只会有一块（按名字找），重复调只返回已有实例 ——
     *   否则每次换局都新建一块，旧的遮罩会永远挡在最上面（本面板是**全屏遮罩**）。
     */
    public static ensure(parent: Node): RevivePromptPanel {
        if (!parent || !parent.isValid) return null;
        const old = parent.getChildByName(RevivePromptPanel.NODE_NAME);
        if (old) return old.getComponent(RevivePromptPanel) ?? old.addComponent(RevivePromptPanel);
        const node = new Node(RevivePromptPanel.NODE_NAME);
        node.parent = parent;
        return node.addComponent(RevivePromptPanel);
    }

    private static readonly NODE_NAME = 'revive_prompt';

    protected onLoad(): void {
        this.build();
    }

    /* ===================================================================
     * 对外
     * =================================================================== */

    /** 面板是否显示中 */
    public isShowing(): boolean {
        return !!this.node && this.node.active;
    }

    /**
     * 显示面板。
     * @param vm `ticketLeft` = 背包里复活券张数（0 = 不画券那颗按钮）；
     *           `canAd` = 这一局还剩「看广告复活」次数且广告可用（false = 不画广告那颗按钮）。
     */
    public show(vm: RevivePromptVM): void {
        if (!this.node || !this.node.isValid) return;
        // 兜底：万一 `onLoad` 还没跑过（引擎没同步激活组件），这里补建一次 —— `build()` 自身幂等
        if (!this.card) this.build();
        const ticketLeft = Math.max(0, Math.floor(vm?.ticketLeft ?? 0));
        const canAd = !!vm?.canAd;

        if (this.titleLabel) this.titleLabel.string = '英雄阵亡';
        if (this.hintLabel) {
            this.hintLabel.string = ticketLeft > 0 || canAd
                ? '复活后满血继续本局'
                : '这一局结束了';
        }
        if (this.ticketBtn) this.ticketBtn.node.active = ticketLeft > 0;
        if (this.ticketLabel) this.ticketLabel.string = `用复活券复活（剩 ${ticketLeft}）`;
        if (this.adBtn) this.adBtn.node.active = canAd;
        if (this.giveupBtn) this.giveupBtn.node.active = true;

        this.node.active = true;
    }

    /** 收起面板（登出本局 / 已复活 / 已放弃都走它） */
    public hide(): void {
        if (this.node && this.node.isValid) this.node.active = false;
    }

    /** 清掉宿主注入的回调（场景收尾调；`onDestroy` 里**不碰别的组件**，只清自己的引用） */
    public dispose(): void {
        this.onChoose = null;
        this.hide();
    }

    protected onDestroy(): void {
        this.onChoose = null;
    }

    /* ===================================================================
     * 建节点（只跑一次）
     * =================================================================== */

    private build(): void {
        if (this.card) return;   // 幂等：`onLoad` 里建过一次就不再建（`show()` 也有一份兜底调用）
        const self = this.node;
        const ut = self.getComponent(UITransform) ?? self.addComponent(UITransform);
        const screen = view.getVisibleSize();
        ut.setContentSize(screen.width, screen.height);

        // ① 全屏遮罩：既压暗背景，也**吃掉所有触摸**（否则玩家还能点到下面的 HUD / 面板）
        const scrim = this.makeSpriteNode('scrim', self, 'textures/common/white_4x4',
            RevivePromptPanel.SCRIM, screen.width, screen.height, false);
        scrim.addComponent(BlockInputEvents);
        // ② 卡片
        this.card = this.makeSpriteNode('card', self, 'textures/common/rect_rd_20',
            new Color().fromHEX(RevivePromptPanel.CARD), RevivePromptPanel.CARD_W, RevivePromptPanel.CARD_H, true);
        this.titleLabel = this.makeLabel(this.card, 'title', 0, 150, RevivePromptPanel.FS_TITLE,
            RevivePromptPanel.INK_TITLE, '英雄阵亡');
        this.hintLabel = this.makeLabel(this.card, 'hint', 0, 100, RevivePromptPanel.FS_HINT,
            RevivePromptPanel.INK_HINT, '复活后满血继续本局');

        // ③ 三颗按钮（券 / 广告 / 放弃）；"不可用"的那两颗由 show() 直接隐藏
        const ticket = this.makeButton(this.card, 'btn_ticket', 26, RevivePromptPanel.BTN_ON, '用复活券复活');
        this.ticketBtn = ticket.btn;
        this.ticketLabel = ticket.label;
        const ad = this.makeButton(this.card, 'btn_ad', -62, RevivePromptPanel.BTN_ON, '看广告复活');
        this.adBtn = ad.btn;
        const giveup = this.makeButton(this.card, 'btn_giveup', -150, RevivePromptPanel.BTN_OFF, '放弃本局');
        this.giveupBtn = giveup.btn;

        ticket.btn.node.on(Button.EventType.CLICK, () => this.choose('ticket'), this);
        ad.btn.node.on(Button.EventType.CLICK, () => this.choose('ad'), this);
        giveup.btn.node.on(Button.EventType.CLICK, () => this.choose('giveup'), this);

        self.active = false;
    }

    private choose(choice: ReviveChoice): void {
        const cb = this.onChoose;
        if (!cb) {
            ezgame.warn(`[复活] 面板点了「${choice}」但没有接回调（宿主没注入 onChoose？）`);
            return;
        }
        cb(choice);
    }

    /* ===================================================================
     * 小工具（三处共用同一套建节点的写法）
     * =================================================================== */

    /** 建一块九宫格底（`sliced=true` 时按 SLICED 拉伸，用于卡片与按钮） */
    private makeSpriteNode(name: string, parent: Node, path: string, color: Color,
        w: number, h: number, sliced: boolean): Node {
        const node = new Node(name);
        node.parent = parent;
        node.layer = parent.layer;
        node.getComponent(UITransform) ?? node.addComponent(UITransform);
        node.getComponent(UITransform).setContentSize(w, h);
        const sp = node.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.type = sliced ? Sprite.Type.SLICED : Sprite.Type.SIMPLE;
        sp.color = color;
        this.loadFrame(path, (sf) => {
            if (sf && node.isValid) sp.spriteFrame = sf;
        });
        return node;
    }

    private makeLabel(parent: Node, name: string, x: number, y: number, fontSize: number,
        hex: string, text: string): Label {
        const node = new Node(name);
        node.parent = parent;
        node.layer = parent.layer;
        node.setPosition(x, y, 0);
        const ut = node.addComponent(UITransform);
        ut.setContentSize(RevivePromptPanel.CARD_W - 80, fontSize * 1.4);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = fontSize * 1.4;
        label.color = new Color().fromHEX(hex);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        return label;
    }

    /** 一颗药丸按钮：底（九宫格）+ 文字 + `Button`（过渡是 SCALE，见 tokens.buttonStates） */
    private makeButton(parent: Node, name: string, y: number, hex: string, text: string): {
        btn: Button; label: Label;
    } {
        const node = this.makeSpriteNode(name, parent, 'textures/common/rect_rd_20',
            new Color().fromHEX(hex), RevivePromptPanel.BTN_W, RevivePromptPanel.BTN_H, true);
        node.setPosition(0, y, 0);
        const label = this.makeLabel(node, 'label', 0, 0, RevivePromptPanel.FS_BTN,
            RevivePromptPanel.TEXT_ON_DARK, text);
        // 按钮文字要压在按钮上：把它的宽度收成按钮宽（否则长文案会溢出卡片）
        const ut = label.node.getComponent(UITransform);
        if (ut) ut.setContentSize(RevivePromptPanel.BTN_W - 40, RevivePromptPanel.BTN_H - 12);
        const btn = node.addComponent(Button);
        btn.transition = Button.Transition.SCALE;
        return { btn, label };
    }

    /** 取一张 `resources` 图标/底图（失败只打一条日志，不动节点已有内容） */
    private loadFrame(path: string, cb: (sf: SpriteFrame | null) => void): void {
        resources.load(`${path}/spriteFrame`, SpriteFrame, (err, sf) => {
            if (err || !sf) {
                ezgame.warn(`[复活] 底图加载失败：${path}`, err);
                cb(null);
                return;
            }
            cb(sf);
        });
    }
}

/** 玩家在复活面板上的三种选择 */
export type ReviveChoice = 'ticket' | 'ad' | 'giveup';

/** `show()` 的入参（**判据由宿主算好**，面板只照着画） */
export interface RevivePromptVM {
    /** 背包里的局内复活券张数（0 = 不画"用复活券"那颗按钮） */
    ticketLeft: number;
    /** 这一局还能看广告复活、且广告可用（false = 不画"看广告复活"那颗按钮） */
    canAd: boolean;
}
