import { _decorator, Button, Color, Label, Node, ProgressBar, resources, Sprite, SpriteFrame } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { AtlasIcon } from '../../../../common/AtlasIcon';
import { NodeUtils } from '../../../../common/NodeUtils';
import { formatCount } from '../../../../common/GoldText';
import { HeroScopeEvents, type HeroDetailVM } from './HeroScope';

const { ccclass, property } = _decorator;

/**
 * 用到的 token（`docs/art-style/tokens.json`，**不许在别处另调色**）：
 * 墨色三级 + 青绿两级 + 金币色 + 主按钮两态。
 */
const COLOR = {
    /** `c-ink-900`：标题与关键数值 */
    ink900: '#445054',
    /** `c-ink-600`：正文 / 图标 */
    ink600: '#6A696B',
    /** `c-ink-400`：次要说明 */
    ink400: '#999999',
    /** `c-accent-600`：升级价格（经验语境） */
    accent600: '#67999A',
    /** `c-gold`：金币（**只在解锁语境**出现） */
    gold: '#D38C1E',
    /** `c-accent-action`：可点的主按钮 */
    btnEnabled: '#3F9E9B',
    /** `c-disabled-pill`：不可点的主按钮（与 `HeroCard.BTN_DISABLED_BG` 同一对常量） */
    btnDisabled: '#B9C1C1',
    /** 本色（不染色） */
    plain: '#FFFFFF',
} as const;

/** 花什么资源时，底部「价格」那一格长什么样（图标 + 文案 + 配色一次配齐） */
const COST_STYLE = {
    exp: {
        label: '升级花费经验',
        icon: 'textures/common/exp_icon',
        iconColor: COLOR.plain,      // 经验图标是**青绿美术本色**，不要染色
        valueColor: COLOR.accent600,
    },
    gold: {
        label: '解锁花费金币',
        icon: 'textures/common/gold',  // 白描 → 运行时染 c-gold
        iconColor: COLOR.gold,
        valueColor: COLOR.gold,
    },
} as const;

/** 节点路径（**改预制件里的名字要同步这里**；`null` = 可选节点，缺了不报错） */
const NODE = {
    panel: 'panel',
    head: 'panel/header/head/inner',
    lock: 'panel/header/head/lock',
    name: 'panel/header/name',
    lv: 'panel/header/lv',
    lvValue: 'panel/header/lv/value',
    exp: 'panel/header/exp',
    expBar: 'panel/header/exp/bar',
    expText: 'panel/header/exp/text',
    expHint: 'panel/header/exp/hint',
    closeBtn: 'panel/header/btn_close',
    attrs: 'panel/attrs',
    skill: 'panel/skill',
    skillIcon: 'panel/skill/icon/inner',
    skillName: 'panel/skill/name',
    skillTag: 'panel/skill/tag',
    skillDesc: 'panel/skill/desc',
    costLabel: 'panel/detail/cost/label',
    costIcon: 'panel/detail/cost/icon',
    costValue: 'panel/detail/cost/value',
    heldValue: 'panel/detail/held/value',
    gold: 'panel/detail/gold',
    goldValue: 'panel/detail/gold/value',
    btn: 'panel/detail/btn_upgrade',
    btnLabel: 'panel/detail/btn_upgrade/label',
} as const;

/** 属性行前缀（`attr_1` ~ `attr_5`，顺序 = `HERO_DETAIL_ATTR_ROWS`） */
const ATTR_PREFIX = 'attr_';
/** 属性行最多铺几行（预制件里摆了 5 行） */
const ATTR_MAX = 5;

/**
 * Cmp_HeroDetail —— `Scene_Menu/ui_hero_detail`（**英雄详情弹窗**）的控制器
 *
 * 内嵌 UI 小组件 → 继承 `UIWidget`（**不加 `@uiview`**：它是 `Scene_Menu` 里的弹窗，不是 UIManager 管的视图）。
 *
 * ── 节点契约（`assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab`）──
 * ```
 * ui_hero_detail                 ← 本组件挂这里（宿主 = Scene_Menu，显隐由宿主写）
 * ├── mask                       全屏遮罩（纯视觉，**不接点击**，理由同难度弹窗）
 * └── panel
 *     ├── bg
 *     ├── header                 head(头像+锁) / name / lv(药丸) / exp(条+读数) / btn_close
 *     ├── line_1                 分隔线
 *     ├── attrs                  title + attr_1~attr_5（icon / name / value / growth）
 *     ├── skill                  title + icon/inner + name + tag + desc
 *     ├── line_2                 分隔线
 *     └── detail                 cost(升级花费经验/解锁花费金币) / held(持有经验) / gold(持有金币)
 *                                / btn_upgrade(升 级·解 锁)
 * ```
 * 所有引用都**按名字兜底解析**（`@property` 没拖也能跑），与 `Cmp_Difficulty` / `HeroCard` 同一套路。
 *
 * ⚠ 引用解析的**现状与陷阱**（2026-11 实测）：`resolveRefs` 会把解析结果**写回 `@property` 字段**，
 *   而 Cocos 会把它们**序列化进预制件** —— 也就是说作者"没拖"的引用，跑过一次之后预制件里就真的拖上了
 *   （现在这 23 个引用已逐个核对，都指向正确的节点）。因此：
 *   · **改节点名**要同时确认这些已序列化的引用（`?? ` 兜底只在字段为 null 时才生效，
 *     而改个名字不会把旧引用清空 —— 会静默继续用"旧名字那个节点"，同 `HeroCard` 记过的坑）；
 *   · 加/删/改名之后，最省事的验法是重开一次弹窗看有没有「子节点契约不完整」的告警（`resolveRefs` 末尾那条）。
 *
 * ── 职责（只有两件，别越界）──
 *   ① **渲染**：把宿主下发的 `HeroDetailVM` 画到预制件的节点上（两态：已解锁 / 未解锁）；
 *   ② **上报**：点「升 级 / 解 锁」`emit(LevelUp / Unlock)`、点「关闭」`emit(CloseDetail)`。
 *   本类**不认识 `DataCenter`、不认识配表、不碰存档** —— 判据（够不够、花什么、能不能点）
 *   全在 `HeroVM` 算好随 VM 下发（见 `HeroScope.ts` 的分层说明）。
 *
 * ⚠ **`active` 由宿主写**：弹窗自己不动自己的节点（同 `Cmp_Difficulty` 的口径 ——
 *   "弹窗缺失时兜底成不显示"的责任在宿主那一侧，弹窗自己关自己会让定位问题变难）。
 * ⚠ **`mask` 不接点击**：Cocos 的节点触摸只命中注册过监听器的节点，遮罩挂上监听后，
 *   点标题/空白处也会被命中（弹窗会在玩家没点关闭时自己收起来）。关窗只留 `btn_close` 一条路。
 */
@ccclass('Cmp_HeroDetail')
export class Cmp_HeroDetail extends UIWidget {

    /* ==================== 编辑器配置（全都可以不拖，按名字兜底） ==================== */

    @property(Node)
    panelNode: Node = null;
    @property(Sprite)
    headSprite: Sprite = null;
    @property(Node)
    lockNode: Node = null;
    @property(Label)
    nameLabel: Label = null;
    @property(Node)
    lvNode: Node = null;
    @property(Label)
    lvValueLabel: Label = null;
    @property(Node)
    expNode: Node = null;
    @property(ProgressBar)
    expBar: ProgressBar = null;
    @property(Label)
    expTextLabel: Label = null;
    @property(Label)
    expHintLabel: Label = null;
    @property(Node)
    closeBtnNode: Node = null;
    @property(Sprite)
    skillIconSprite: Sprite = null;
    @property(Label)
    skillNameLabel: Label = null;
    @property(Label)
    skillTagLabel: Label = null;
    @property(Label)
    skillDescLabel: Label = null;
    @property(Label)
    costLabel: Label = null;
    @property(Sprite)
    costIconSprite: Sprite = null;
    @property(Label)
    costValueLabel: Label = null;
    @property(Label)
    heldValueLabel: Label = null;
    @property(Node)
    goldNode: Node = null;
    @property(Label)
    goldValueLabel: Label = null;
    @property(Sprite)
    btnSprite: Sprite = null;
    @property(Label)
    btnLabel: Label = null;

    /* ==================== 运行时状态 ==================== */

    /** 当前下发的整包数据（null = 还没下发过） */
    private vm: HeroDetailVM | null = null;
    /** 技能块整块（没有技能时收起；`attrs` 同理） */
    private skillNode: Node | null = null;
    /** 5 行属性（`attr_1` ~ `attr_5`） */
    private attrRows: Node[] = [];
    /** 已加载过的头像 / 技能图 / 价格图标路径（重画时不再重复解析） */
    private loadedHead: string | null = null;
    private loadedSkill: string | null = null;
    private loadedCostIcon: string | null = null;

    /* ==================== 生命周期 ==================== */

    protected onInit(): void {
        this.resolveRefs();
        this.bindButtons();
        console.log(`[英雄详情] onInit：panel=${!!this.panelNode} 关闭按钮=${!!this.closeBtnNode} `
            + `升级按钮=${!!this.btnSprite} 属性行=${this.attrRows.length}`);
    }

    /** 每次显示按当前数据无条件重画一次（`vm` 是普通字段，watcher 感知不到） */
    protected onShow(): void {
        if (this.vm) this.apply();
    }

    protected onDispose(): void {
        this.offNodeEvent(this.closeBtnNode, Button.EventType.CLICK, this.onClickClose, this);
        this.offNodeEvent(this.btnNode()?.node, Button.EventType.CLICK, this.onClickAction, this);
        this.attrRows = [];
    }

    /* ===================================================================
     * 对外：宿主下发数据
     * =================================================================== */

    /**
     * 下发整包数据并重画（`null` = 清空；**不负责显隐**，那是宿主的事）。
     *
     * 宿主的标准写法（两行，顺序无所谓但都要写）：
     * ```ts
     * this.heroDetail.setVM(HeroVM.buildDetailVM(heroId));
     * this.heroDetailNode.active = true;
     * ```
     */
    setVM(vm: HeroDetailVM | null): void {
        this.vm = vm ?? null;
        if (this.vm) this.apply();
    }

    /** 当前显示的是哪个英雄（0 = 没数据）—— 宿主用它判断"这次动作要不要顺带刷新弹窗" */
    getHeroId(): number {
        return this.vm?.heroId ?? 0;
    }

    /* ===================================================================
     * 渲染
     * =================================================================== */

    private apply(): void {
        const vm = this.vm;
        if (!vm) return;

        this.applyHeader(vm);
        this.applyExp(vm);
        this.applyAttrs(vm);
        this.applySkill(vm);
        this.applyCost(vm);
        this.applyAction(vm);

        // 未解锁 → **整块置灰**（材质一招通吃 Sprite/Label，见 `NodeUtils.setGray`），
        // 但主按钮要**亮着**（灰面板 + 亮按钮 = 一眼看出"这里能买"）→ 按钮子树单独复原。
        // ⚠ 顺序不能反：setGray(panel) 会把按钮子树也一起灰掉。
        if (this.panelNode) NodeUtils.setGray(this.panelNode, !vm.unlocked);
        if (this.btnSprite) NodeUtils.setGray(this.btnSprite.node, false);
    }

    /** 头像 / 锁 / 名字 / 等级药丸 */
    private applyHeader(vm: HeroDetailVM): void {
        if (this.nameLabel) this.nameLabel.string = vm.name;
        if (this.lockNode) this.lockNode.active = !vm.unlocked;
        // 未解锁：等级药丸整块收起（别显示「LV.0」）
        if (this.lvNode) this.lvNode.active = vm.unlocked;
        if (this.lvValueLabel) this.lvValueLabel.string = vm.unlocked ? `${Math.max(1, vm.level)}` : '';

        if (this.headSprite && vm.headIcon && this.loadedHead !== vm.headIcon) {
            this.loadedHead = vm.headIcon;
            this.loadSprite(this.headSprite, vm.headIcon, '英雄头像');
        }
    }

    /**
     * 经验块：`持有经验 / 本级所需`。
     *
     * 收起条件（两条都不画空条）：**未解锁**（还没有档案）或 `expMax <= 0`（配表没给经验口径）。
     * 提示语按"够不够升级"分流 —— 这正是玩家点按钮前最想看到的一句话。
     */
    private applyExp(vm: HeroDetailVM): void {
        const show = vm.unlocked && vm.expMax > 0;
        if (this.expNode) this.expNode.active = show;
        if (!show) return;

        if (this.expBar) {
            // clamp 一道：脏存档（池子比所需还大）不该把填充条画到框外
            this.expBar.progress = Math.min(1, Math.max(0, vm.exp / vm.expMax));
        }
        if (this.expTextLabel) {
            this.expTextLabel.string = `${formatCount(vm.exp)} / ${formatCount(vm.expMax)}`;
        }
        if (this.expHintLabel) {
            const gap = vm.expMax - vm.exp;
            this.expHintLabel.string = gap > 0 ? `还差 ${formatCount(gap)} 经验` : '经验已足够，可以升级';
        }
    }

    /**
     * 5 行属性：**英雄真配了的那 5 项**（生命/魔法/攻击/攻速/距离，顺序即 `HERO_DETAIL_ATTR_ROWS`）。
     *
     * 值直接写宿主给的 `valueText`：未解锁时宿主已经按 **1 级**算过，
     * 界面**不要**自己按等级推（推出来的会与卡片、与局内三方不一致）。
     */
    private applyAttrs(vm: HeroDetailVM): void {
        for (let i = 0; i < this.attrRows.length; i++) {
            const row = this.attrRows[i];
            if (!row) continue;

            const data = vm.attrs[i];
            row.active = !!data;
            if (!data) continue;

            this.writeLabel(row, 'name', data.name);
            this.writeLabel(row, 'value', data.valueText);
            this.writeLabel(row, 'growth', data.growthText);

            const icon = row.getChildByName('icon')?.getComponent(Sprite);
            // `icon` 为空 = 这项的属性图标还没出图（见 `HeroConfig.ATTR_ICON`）→ 保留预制件占位图
            if (icon && data.icon) this.loadSprite(icon, data.icon, `属性图标 ${data.name}`);
        }
    }

    /** 技能三件套（图标走图集三级降级：`textures/skills` 已打图集，取不到自己回落碎图） */
    private applySkill(vm: HeroDetailVM): void {
        const skill = vm.skill;
        if (this.skillNode) this.skillNode.active = !!skill;
        if (!skill) return;

        if (this.skillNameLabel) this.skillNameLabel.string = skill.name;
        // 角标独立于名字：配表里技能名自带「(被动)」尾缀，`HeroConfig.getSkill` 已经剥掉了
        if (this.skillTagLabel) {
            this.skillTagLabel.string = skill.tag;
            this.skillTagLabel.node.active = !!skill.tag;
        }
        if (this.skillDescLabel) this.skillDescLabel.string = skill.desc;

        if (this.skillIconSprite && skill.icon && this.loadedSkill !== skill.icon) {
            this.loadedSkill = skill.icon;
            AtlasIcon.loadIconFrame(skill.icon).then((sf) => {
                if (sf && this.skillIconSprite?.isValid) this.skillIconSprite.spriteFrame = sf;
            });
        }
    }

    /**
     * 底部「这一步花什么」：**图标跟着花什么走**（升级 = 经验图标青绿本色；解锁 = 金币图标染 `c-gold`）。
     * 价格为 0（配表没给价）时收起数字，免得显示一个孤零零的「0」。
     */
    private applyCost(vm: HeroDetailVM): void {
        const style = COST_STYLE[vm.costKind] ?? COST_STYLE.gold;

        if (this.costLabel) {
            this.costLabel.string = style.label;
            this.costLabel.node.active = vm.cost > 0;
        }
        if (this.costValueLabel) {
            this.costValueLabel.string = vm.cost > 0 ? formatCount(vm.cost) : '';
            this.costValueLabel.color = new Color().fromHEX(style.valueColor);
            this.costValueLabel.node.active = vm.cost > 0;
        }
        if (this.costIconSprite) {
            this.costIconSprite.color = new Color().fromHEX(style.iconColor);
            this.costIconSprite.node.active = vm.cost > 0;
            if (style.icon && this.loadedCostIcon !== style.icon) {
                this.loadedCostIcon = style.icon;
                this.loadSprite(this.costIconSprite, style.icon, '价格图标');
            }
        }

        // 「持有通用英雄经验」与「持有金币」两个读数：**两种状态下都要画** ——
        // 遮罩是全屏的（顶栏资源条被一起盖住，见 docs/hero-detail/README.md §2 第 10 项），
        // 而未解锁时这一步花的就是**金币** —— 那恰恰是玩家最需要看到金币余额的时刻（§3.4）。
        // ⚠ 这里原先写成 `active = vm.unlocked`（只有解锁态才显示金币）—— 正好反了：
        //   未解锁时价格是金币、余额却看不到。体检 H2/H3 现在钉住"两态都显示"。
        if (this.heldValueLabel) this.heldValueLabel.string = formatCount(vm.exp);
        if (this.goldNode) this.goldNode.active = true;
        if (this.goldValueLabel) {
            this.goldValueLabel.string = formatCount(vm.gold);
            this.goldValueLabel.color = new Color().fromHEX(COLOR.gold);
        }
    }

    /**
     * 主按钮：文案（升 级 / 解 锁）+ 两态色 + 能不能点。
     *
     * ⚠ 两个坑（`HeroCard` / `AchievementItem` 都记过）：
     *   ① 必须 `transition = NONE` 自己写色 —— `interactable = false` 时 Button 会用 `_disabledColor`
     *      统一覆盖外观，作者摆的两态会被同一块灰吃掉；
     *   ② 颜色**全部写完再设 `interactable`**（顺序反了偶尔会看到一帧旧色）。
     */
    private applyAction(vm: HeroDetailVM): void {
        if (this.btnSprite) {
            this.btnSprite.color = new Color().fromHEX(vm.enabled ? COLOR.btnEnabled : COLOR.btnDisabled);
        }
        if (this.btnLabel) this.btnLabel.string = vm.unlocked ? '升 级' : '解 锁';

        const btn = this.btnNode();
        if (btn) {
            btn.transition = Button.Transition.NONE;
            btn.interactable = vm.enabled;
        }
    }

    /* ===================================================================
     * 交互（只上报，不写数据）
     * =================================================================== */

    /** 点「升 级 / 解 锁」：文案由**当前态**决定走哪条事件（价格、够不够都由宿主再判一次） */
    private onClickAction(): void {
        const vm = this.vm;
        if (!vm || !vm.enabled) return;
        this.scope.emit(vm.unlocked ? HeroScopeEvents.LevelUp : HeroScopeEvents.Unlock, vm.heroId);
    }

    private onClickClose(): void {
        this.scope.emit(HeroScopeEvents.CloseDetail);
    }

    /* ===================================================================
     * 节点契约
     * =================================================================== */

    private bindButtons(): void {
        const close = this.closeBtnNode?.getComponent(Button);
        if (close) close.transition = Button.Transition.NONE;
        this.closeBtnNode?.on(Button.EventType.CLICK, this.onClickClose, this);

        const btn = this.btnNode(true);
        if (btn) {
            btn.transition = Button.Transition.NONE;
            btn.node.on(Button.EventType.CLICK, this.onClickAction, this);
        }
    }

    /** 主按钮所在的节点（缺 Button 时补一个；`create=false` 只查不建） */
    private btnNode(create = false): Button | null {
        const node = this.btnSprite?.node ?? this.node.getChildByPath(NODE.btn);
        if (!node) return null;
        const exist = node.getComponent(Button);
        if (exist) return exist;
        return create ? node.addComponent(Button) : null;
    }

    /** 按名字兜底解析子节点（预制件里没拖 `@property` 也能跑） */
    private resolveRefs(): void {
        const n = this.node;
        this.panelNode = this.panelNode ?? n.getChildByPath(NODE.panel);
        this.headSprite = this.headSprite ?? n.getChildByPath(NODE.head)?.getComponent(Sprite);
        this.lockNode = this.lockNode ?? n.getChildByPath(NODE.lock);
        this.nameLabel = this.nameLabel ?? n.getChildByPath(NODE.name)?.getComponent(Label);
        this.lvNode = this.lvNode ?? n.getChildByPath(NODE.lv);
        this.lvValueLabel = this.lvValueLabel ?? n.getChildByPath(NODE.lvValue)?.getComponent(Label);
        this.expNode = this.expNode ?? n.getChildByPath(NODE.exp);
        this.expBar = this.expBar ?? n.getChildByPath(NODE.expBar)?.getComponent(ProgressBar);
        this.expTextLabel = this.expTextLabel ?? n.getChildByPath(NODE.expText)?.getComponent(Label);
        this.expHintLabel = this.expHintLabel ?? n.getChildByPath(NODE.expHint)?.getComponent(Label);
        this.closeBtnNode = this.closeBtnNode ?? n.getChildByPath(NODE.closeBtn);
        this.skillNode = this.skillNode ?? n.getChildByPath(NODE.skill);
        this.skillIconSprite = this.skillIconSprite ?? n.getChildByPath(NODE.skillIcon)?.getComponent(Sprite);
        this.skillNameLabel = this.skillNameLabel ?? n.getChildByPath(NODE.skillName)?.getComponent(Label);
        this.skillTagLabel = this.skillTagLabel ?? n.getChildByPath(NODE.skillTag)?.getComponent(Label);
        this.skillDescLabel = this.skillDescLabel ?? n.getChildByPath(NODE.skillDesc)?.getComponent(Label);
        this.costLabel = this.costLabel ?? n.getChildByPath(NODE.costLabel)?.getComponent(Label);
        this.costIconSprite = this.costIconSprite ?? n.getChildByPath(NODE.costIcon)?.getComponent(Sprite);
        this.costValueLabel = this.costValueLabel ?? n.getChildByPath(NODE.costValue)?.getComponent(Label);
        this.heldValueLabel = this.heldValueLabel ?? n.getChildByPath(NODE.heldValue)?.getComponent(Label);
        this.goldNode = this.goldNode ?? n.getChildByPath(NODE.gold);
        this.goldValueLabel = this.goldValueLabel ?? n.getChildByPath(NODE.goldValue)?.getComponent(Label);
        this.btnSprite = this.btnSprite ?? n.getChildByPath(NODE.btn)?.getComponent(Sprite);
        this.btnLabel = this.btnLabel ?? n.getChildByPath(NODE.btnLabel)?.getComponent(Label);

        if (!this.attrRows.length) {
            const attrs = n.getChildByPath(NODE.attrs);
            const rows: Node[] = [];
            for (let i = 1; i <= ATTR_MAX; i++) {
                const row = attrs?.getChildByName(`${ATTR_PREFIX}${i}`);
                if (row) rows.push(row);
            }
            this.attrRows = rows;
        }

        if (!this.panelNode || !this.nameLabel || !this.btnSprite || !this.closeBtnNode) {
            ezgame.warn('[英雄详情] 子节点契约不完整（需要 panel / panel/header/name / '
                + `panel/detail/btn_upgrade / panel/header/btn_close）：${this.node.name}`);
        }
    }

    /** 往某个子节点的 Label 上写字符串（节点缺失 = 静默跳过，不抛） */
    private writeLabel(parent: Node, childName: string, text: string): void {
        const label = parent.getChildByName(childName)?.getComponent(Label);
        if (label) label.string = text;
    }

    /* ===================================================================
     * 图标加载
     * =================================================================== */

    /**
     * 加载**碎图**（`textures/heros/*`、`textures/property/*`、`textures/common/*`）——
     * 必须用 `resources.load(路径/spriteFrame)`：`loadBundleSprite` 会把路径首段 `textures`
     * 当成分包名去加载，永远失败（`HeroCard` 记过同一条）。
     * 失败只报错、**不把已有图刷成空白**（占位图比空白更像"没坏"）。
     */
    private loadSprite(target: Sprite, path: string, tag: string): void {
        if (!path || !target) return;
        resources.load(`${path}/spriteFrame`, SpriteFrame, (err, spriteFrame) => {
            if (err || !spriteFrame) {
                ezgame.error(`[英雄详情] ${tag}加载失败：${path}`, err);
                return;
            }
            if (target.isValid) target.spriteFrame = spriteFrame;
        });
    }
}
