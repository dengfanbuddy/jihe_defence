import { _decorator, Button, Color, Label, Node, ProgressBar, resources, Sprite, SpriteFrame } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { AtlasIcon } from '../../../../common/AtlasIcon';
import { NodeUtils } from '../../../../common/NodeUtils';
import { formatGold } from '../../../../common/GoldText';
import { HeroScopeEvents, type HeroCardVM } from './HeroScope';

const { ccclass, property } = _decorator;

/**
 * 「解锁 / 升级」按钮的两态色（与成就页 `AchievementItem.STATE_STYLE` 同一套青/灰口径）：
 * 可点 = `c-accent-action` 青绿；不可点（金币不够）= `c-disabled-pill` 浅灰。
 * 两个色 2026-10 已登记进 `docs/美术风格预设.md` §1（+ `tokens.json` / `art-style/index.html` 三处同源）——
 * 在此之前它们属于"工程在用但没进 §1"的违规态。
 *
 * ⚠ 按钮是 `rect_board_rd_10` —— **只描边不填充的环**（贴图中心 alpha = 0），所以文案其实是写在
 *   **卡面白底**上的深色字，不是"青底白字"；成就页那颗白字能读，是因为它的卡面是整块铜色 `#C98B5E`。
 *
 * ⚠ 为什么把 `Button.transition` 关掉自己写色：`interactable = false` 时 Button 会用 `_disabledColor`
 *   统一覆盖外观，作者摆的两态直接被同一块灰吃掉（`AchievementItem` / `TaskItem` 同一个坑）。
 */
const BTN_ENABLED_BG = '#3F9E9B';    // c-accent-action
const BTN_DISABLED_BG = '#B9C1C1';   // c-disabled-pill

/**
 * 「详 情」按钮的文案（点了**打开英雄详情弹窗**，不再切属性行的取值方式）。
 *
 * 2026-11 改：这个按钮原来是"在「当前值 / 每级成长」之间切一下"的显示开关（`expanded` 那套），
 * 弹窗落地后那套退休 —— 卡片只显示当前值，每级成长与技能三件套在弹窗里看。
 */
const DETAIL_TEXT = '详 情';

/**
 * `common/exp_icon` 的贴图**全卡共用一份缓存**。
 *
 * 为什么需要：英雄页一次铺 10 张卡、每次数据变化还会整批重铺 —— 逐张 `resources.load`
 * 就是同一张图被加载几十次（`HeroCard.loadLooseIcon` 那条路每张卡各持一个 `loadedXxx` 字段，
 * 挡得住"同一张卡重画"，挡不住"十张卡各加载一次"）。
 */
let expIconFrame: SpriteFrame | null = null;
let expIconPromise: Promise<SpriteFrame | null> | null = null;

/** 取经验图标（`common/exp_icon`，青绿**美术本色**，不染色）；失败只报错一次 */
function ensureExpIconFrame(): Promise<SpriteFrame | null> {
    if (expIconFrame) return Promise.resolve(expIconFrame);
    if (!expIconPromise) {
        expIconPromise = new Promise((resolve) => {
            resources.load('textures/common/exp_icon/spriteFrame', SpriteFrame, (err, sf) => {
                if (err || !sf) {
                    ezgame.error('[英雄页] 经验图标加载失败：textures/common/exp_icon', err);
                    resolve(null);
                    return;
                }
                expIconFrame = sf;
                resolve(sf);
            });
        });
    }
    return expIconPromise;
}

/**
 * 两个「改版后极易拖错」的引用只警告**一次**。
 * 为什么：`resolveRefs` 每张卡跑一次、每次重铺列表还会克隆一批新卡，
 * 逐个实例吼会在控制台刷成屏（而这两条是**编辑器里的拖引用**问题，看到一次就够了）。
 */
let warnedLevelRef = false;
let warnedActionRef = false;

/**
 * 「英雄」页列表里的**一张卡**（内嵌 UI 小组件 → 继承 `UIWidget`，**不加 `@uiview`**）
 *
 * 职责只有三件：
 *   ① 渲染：把宿主下发的 `HeroCardVM` 画到预制件的节点上（头像 / 锁 / 名字 / 等级 + 经验条 /
 *      技能图 / 4 行属性 / 解锁·升级按钮的文案与价格）；
 *   ② 通知:点「解 锁」`emit(Unlock)`、点「升 级」`emit(LevelUp)`、点「详 情」`emit(OpenDetail)`
 *      —— 扣资源、写存档、开弹窗、刷新都由宿主做（`Unlock`/`LevelUp` 的监听方是 `Scene_Menu`，
 *      见 `HeroScope.ts` 里"谁收事件"那段），本类不碰 `DataCenter`；
 *   ③ 价格**图标跟着花什么走**（`vm.costKind`）：解锁 = 金币图；升级 = 经验图（青绿本色）。
 *      卡片的价格口径在 2026-11 从"金币"改成"解锁花金币 / 升级花通用英雄经验"，图标不跟着换
 *      就会出现「文案说升级、旁边顶着一枚金币」。
 *
 * 节点契约（与 `Scene_Menu.prefab` 的 `content/right/heros/lists/HeroItem` 一致，
 * 同名模板资产在 `prefabs/ui/scenes/scene_menu/cmps/HeroItem.prefab`）：
 * ```
 * HeroItem
 * ├── bg                底图
 * ├── icon              头像槽 → inner(头像) / lock(未解锁遮罩 + 锁)
 * ├── name              英雄名
 * ├── lv                等级**容器**（自己也挂了个 Label，是静态前缀「LV.」）
 * │   └── value         等级**数字**（写这里，别写前缀那个 Label）
 * ├── exp_bar           经验进度条（ProgressBar，横向）→ Bar(填充条)
 * ├── skill             技能槽 → Sprite(技能图标)
 * ├── detail/Label      「详 情」（点了开英雄详情弹窗）
 * ├── unlock            解锁 / 升级按钮 → Label(文案) / icon(金币或经验图标) / value(价格)
 * └── property(-00N)    4 行属性 → icon / name / value
 * ```
 * 所有子节点引用都按名字兜底解析（`@property` 没拖也能跑），与 `AchievementItem.resolveRefs` 同一套路。
 *
 * ⚠ 三处引用**极易拖错**（2026-10 已在编辑器里重拖修正，体检 `npm run audit:herocard` 的 A1b/A4b
 *   现在断言它们**指向正确节点**）。`resolveRefs` 里那两条"按名字纠正 + 只警告一次"**仍然保留** ——
 *   防的是下一次改版又拖错；该兜底路径由同一个体检的 A′ 对照组（注入一份拖错副本再跑）继续钉住：
 *   · `lvLabel`：`lv` 自己的 Label 是静态前缀「LV.」，**数字在 `lv/value`**；
 *   · `actionSprite`：必须是 `unlock` **自己**的 Sprite（按钮底图 = 点击落点 + 两态配色载体），
 *     拖成 `unlock/icon`（金币图标）会「点不到整块按钮」且把金币图标染成青/灰。
 */
@ccclass('HeroCard')
export class HeroCard extends UIWidget {

    /* ==================== 编辑器配置（全都可以不拖，按名字兜底） ==================== */

    @property(Sprite)
    headSprite: Sprite = null;
    @property(Node)
    lockNode: Node = null;
    @property(Label)
    nameLabel: Label = null;
    /** 等级**数字**标签（= `lv/value`；`lv` 自己的 Label 是静态前缀「LV.」，别往上写数字） */
    @property(Label)
    lvLabel: Label = null;
    /** 经验进度条（`exp_bar` 上的 `cc.ProgressBar`；横向，`progress = exp / expMax`） */
    @property(ProgressBar)
    expBar: ProgressBar = null;
    @property(Sprite)
    skillSprite: Sprite = null;
    @property(Sprite)
    actionSprite: Sprite = null;
    @property(Label)
    actionLabel: Label = null;
    @property(Label)
    actionValueLabel: Label = null;
    @property(Sprite)
    actionIconSprite: Sprite = null;
    @property(Node)
    detailNode: Node = null;
    @property([Node])
    propertyNodes: Node[] = [];

    /* ==================== 运行时状态 ==================== */

    /** 当前卡面数据（null = 没有内容） */
    private vm: HeroCardVM | null = null;
    /** 等级整块（`lv` 容器：前缀 + 数字），未解锁时整块收起（只藏数字会留一个孤零零的「LV.」） */
    private lvNode: Node | null = null;
    /** 经验条上的数字标签（可选节点 `exp_bar/Label`，预制件里没有就不写） */
    private expLabel: Label | null = null;
    /** 已加载过的头像路径（同一张卡重刷时不再重复解析） */
    private loadedHead: string | null = null;
    /** 已加载过的技能图标路径 */
    private loadedSkill: string | null = null;
    /** 价格图标：当前显示的是哪种（避免每帧重复写贴图/颜色） */
    private costIconKind: 'exp' | 'gold' | null = null;
    /** 价格图标的**预制件原样**（金币图 + 它的颜色），从经验图切回来时要用 */
    private costIconBaseFrame: SpriteFrame | null = null;
    private costIconBaseColor: Color | null = null;
    /** 「解 锁/升 级」按钮（`onInit` 记下来给 `onDispose` 用，见 onDispose 的注释） */
    private actionButton: Button | null = null;
    /** 「详 情」按钮（同上） */
    private detailButton: Button | null = null;

    /* ==================== 生命周期 ==================== */

    protected onInit(): void {
        this.resolveRefs();
        // 两个按钮都自己写色（见文件头 BTN_ENABLED_BG 那段的说明）。
        // ⚠ 引用必须**在这里**（= onLoad，节点还活着）就记进字段：`onDispose` 里**不能再 `getComponent`**，
        //   见 onDispose 的注释。
        const detailBtn = this.detailBtn();
        if (detailBtn) {
            this.detailButton = detailBtn;
            detailBtn.transition = Button.Transition.NONE;
            detailBtn.node.on(Button.EventType.CLICK, this.onClickDetail, this);
        }
        const actionBtn = this.actionBtn();
        if (actionBtn) {
            this.actionButton = actionBtn;
            actionBtn.transition = Button.Transition.NONE;
            actionBtn.node.on(Button.EventType.CLICK, this.onClickAction, this);
        }
    }

    protected onShow(): void {
        // 显示时按当前数据无条件重画一次（vm 是普通字段，watch 感知不到）
        if (this.vm) this.apply();
    }

    /**
     * ⚠⚠ 这里**绝不允许再 `getComponent` / `getChildByName` 去"现找"按钮**（踩过，用户报过的那条栈）：
     *
     * 引擎销毁一个节点时（`node.ts:1532-1545`）：① 先销毁节点自己的事件处理器 → ② **递归销毁全部子节点**
     * （每个被销毁的对象都会跑 `CCObject._destruct()`，own 字段一律置 null，`Node._components` 在其中）→
     * ③ **最后**才逐个销毁**本节点自己的组件**（`onDestroy` → `onDispose`）。也就是说 `onDispose` 跑起来时，
     * 卡片下面那棵子树已经是**空壳**：`this.detailNode` 这个引用还在手上，但对它 `getComponent(Button)` 会在
     * `Node._findComponent` 里读 `comps.length`（`comps = node._components` = null）抛
     * `TypeError: Cannot read properties of null (reading 'length')` —— 真机报的就是这条。
     * （`UIWidget.onDestroy` 已 try/catch 兜住，画面不会卡死，但控制台会被刷，且说明销毁路径碰了别的组件。）
     *
     * 正确姿势（两条一起用）：
     *   · 按钮组件在 `onInit` 就记进 `detailButton` / `actionButton`，这里只借 `?.node`；
     *   · 摘事件的活儿交给 `offNodeEvent` —— 它判 `node` 为 null 或 `!isValid` 时直接跳过
     *     （被 `_destruct` 过的组件 `.node` 已经是 null），而"跳过"是安全的：监听随节点的事件处理器一起消亡。
     */
    protected onDispose(): void {
        // 后代节点走 offNodeEvent（节点销毁时 node.off 会炸，见 AGENTS.md）
        this.offNodeEvent(this.detailButton?.node, Button.EventType.CLICK, this.onClickDetail, this);
        this.offNodeEvent(this.actionButton?.node, Button.EventType.CLICK, this.onClickAction, this);
    }

    /* ===================================================================
     * 对外：宿主下发数据
     * =================================================================== */

    /** 设置这张卡显示哪个英雄（`null` = 整卡收起） */
    setInfo(vm: HeroCardVM | null): void {
        this.vm = vm ?? null;
        this.apply();
    }

    /** 当前卡片对应的英雄 id（0 = 没有内容） */
    getHeroId(): number {
        return this.vm?.heroId ?? 0;
    }

    /* ===================================================================
     * 渲染
     * =================================================================== */

    private apply(): void {
        const vm = this.vm;
        if (!vm) {
            this.node.active = false;
            return;
        }
        this.node.active = true;

        if (this.nameLabel) this.nameLabel.string = vm.name;
        this.applyHead(vm);
        this.applyExp(vm);
        this.applyAction(vm);
        this.applyAttrs(vm);

        // 未解锁 → 整卡置灰（材质一招通吃 Sprite/Label，见 NodeUtils.setGray），
        // 但「解 锁」按钮要**亮着**（灰卡 + 亮按钮 = 一眼看出"这里能买"）→ 按钮子树单独复原
        NodeUtils.setGray(this.node, !vm.unlocked);
        if (this.actionSprite) NodeUtils.setGray(this.actionSprite.node, false);
    }

    /** 头像 + 锁 + 等级（头像是**碎图**：`textures/heros/*`，不走图集） */
    private applyHead(vm: HeroCardVM): void {
        if (this.lockNode) this.lockNode.active = !vm.unlocked;

        // 等级：整块（前缀「LV.」+ 数字）跟着解锁态收放，数字只写 `lv/value`
        if (this.lvNode) this.lvNode.active = vm.unlocked;
        if (this.lvLabel) this.lvLabel.string = vm.unlocked ? `${Math.max(1, vm.level)}` : '';

        if (this.headSprite && vm.headIcon && this.loadedHead !== vm.headIcon) {
            this.loadedHead = vm.headIcon;
            this.loadLooseIcon(vm.headIcon, this.headSprite, '英雄头像');
        }
        // 技能图标走图集三级降级（`textures/skills` 已打图集；取不到会自己回落到碎图）
        if (this.skillSprite && vm.skillIcon && this.loadedSkill !== vm.skillIcon) {
            this.loadedSkill = vm.skillIcon;
            AtlasIcon.loadIconFrame(vm.skillIcon).then((sf) => {
                if (sf && this.skillSprite?.isValid) this.skillSprite.spriteFrame = sf;
            });
        }
    }

    /**
     * 经验进度条（`exp_bar`）：`progress = 持有经验 / 升下一级所需`（`vm.exp` / `vm.expMax`）。
     *
     * 分子是**通用英雄经验池**（所有英雄共用一份，不是每个英雄各存一份）—— 所以同一个池子下，
     * 等级高的英雄条更短（他要的更多）。这与详情弹窗里那条进度条是**同一个数**。
     *
     * 收起条件（两条都不画空条）：**未解锁**（没有档案，经验无意义）或 `expMax <= 0`
     * （配表没给经验口径）—— 否则玩家会看到一条永远是 0 的进度条，像是坏了。
     *
     * ⚠ `vm.expMax` 由宿主给（`HeroData.getExpForNextLevel`），**本类不算经验公式** ——
     *   公式只该有一份，升级扣费（`tryLevelUp`）与展示（这里）必须同口径。
     */
    private applyExp(vm: HeroCardVM): void {
        const bar = this.expBar;
        if (!bar) return;

        const show = vm.unlocked && vm.expMax > 0;
        bar.node.active = show;
        if (!show) return;

        // `progress` 是 0~1 的比例，ProgressBar 直接按 `totalLength × progress` 设 `Bar` 的宽度；
        // 这里 clamp 一道，免得脏存档（池子比所需还大）把填充条画到框外
        bar.progress = Math.min(1, Math.max(0, vm.exp / vm.expMax));

        // 预制件里没有这个数字标签就不写（节点可选，见 file head 的节点契约）
        if (this.expLabel) {
            this.expLabel.string = `${Math.floor(vm.exp)}/${Math.floor(vm.expMax)}`;
        }
    }

    /** 「解锁 / 升级」按钮：文案 + 价格 + 花费图标 + 能不能点 + 两态色 */
    private applyAction(vm: HeroCardVM): void {
        const btn = this.actionBtn();
        if (this.actionSprite) this.actionSprite.color = new Color().fromHEX(vm.enabled ? BTN_ENABLED_BG : BTN_DISABLED_BG);
        if (this.actionLabel) this.actionLabel.string = vm.unlocked ? '升 级' : '解 锁';

        if (this.actionValueLabel) {
            // 价格为 0 = 免费（配表把解锁价配成 0 时）→ 收起价格文字，免得显示一个孤零零的「0」
            this.actionValueLabel.string = vm.cost > 0 ? formatGold(vm.cost) : '';
            this.actionValueLabel.node.active = vm.cost > 0;
        }
        this.applyCostIcon(vm);

        // ⚠ 顺序：先把所有颜色写完再设 interactable —— `transition = NONE` 下 Button 不会覆盖颜色，
        //   但 `interactable = false` 仍然会拦掉 CLICK（这正是我们要的：钱/经验不够点不动）
        if (btn) {
            btn.transition = Button.Transition.NONE;
            btn.interactable = vm.enabled;
        }
    }

    /**
     * 按钮上的**花费图标**跟着花什么走（`vm.costKind`）：
     *   · `gold`（未解锁 · 花金币）→ 预制件里那张金币图 + 它原本的颜色（卡面克制，不额外染金）；
     *   · `exp`（已解锁 · 花通用英雄经验）→ `common/exp_icon`，**回本色白**（那是青绿美术本色，
     *     染色会把它的层次压掉），与详情弹窗底部那个图标是同一张。
     *
     * ⚠ 老 VM（没有 `costKind` 字段）按 `unlocked` 推一次，行为与改版前一致（金币图）。
     */
    private applyCostIcon(vm: HeroCardVM): void {
        const sprite = this.actionIconSprite;
        if (!sprite) return;

        const kind: 'exp' | 'gold' = vm.costKind ?? (vm.unlocked ? 'exp' : 'gold');
        if (this.costIconKind === kind) return;
        this.costIconKind = kind;

        if (kind === 'gold') {
            if (this.costIconBaseFrame) sprite.spriteFrame = this.costIconBaseFrame;
            if (this.costIconBaseColor) sprite.color = this.costIconBaseColor;
            return;
        }

        sprite.color = new Color(255, 255, 255, 255);
        ensureExpIconFrame().then((sf) => {
            // 加载回来时这张卡可能已经被重铺/换英雄了 → 只在"仍处于经验语境"时写
            if (sf && sprite.isValid && this.costIconKind === 'exp') sprite.spriteFrame = sf;
        });
    }

    /** 4 行属性：图标 / 名称 / 当前值（每级成长在详情弹窗里看） */
    private applyAttrs(vm: HeroCardVM): void {
        for (let i = 0; i < this.propertyNodes.length; i++) {
            const row = this.propertyNodes[i];
            if (!row) continue;

            const data = vm.attrs[i];
            row.active = !!data;
            if (!data) continue;

            const nameLabel = row.getChildByName('name')?.getComponent(Label);
            if (nameLabel) nameLabel.string = data.name;

            const valueLabel = row.getChildByName('value')?.getComponent(Label);
            if (valueLabel) valueLabel.string = data.valueText;

            const iconSprite = row.getChildByName('icon')?.getComponent(Sprite);
            if (iconSprite && data.icon) {
                this.loadLooseIcon(data.icon, iconSprite, `属性图标 ${data.name}`);
            }
        }
    }

    /* ===================================================================
     * 交互
     * =================================================================== */

    /** 点「解 锁」/「升 级」：只向上通知（买不买、够不够由宿主判） */
    private onClickAction(): void {
        const vm = this.vm;
        if (!vm || !vm.enabled) return;
        this.scope.emit(vm.unlocked ? HeroScopeEvents.LevelUp : HeroScopeEvents.Unlock, vm.heroId);
    }

    /** 点「详 情」：把「给谁开弹窗」报上去（弹窗的数据、显隐、判据全在宿主那一侧） */
    private onClickDetail(): void {
        if (!this.vm) return;
        this.scope.emit(HeroScopeEvents.OpenDetail, this.vm.heroId);
    }

    /* ===================================================================
     * 节点契约
     * =================================================================== */

    /**
     * 解锁 / 升级按钮（缺 Button 时补一个）。
     * ⚠ 只在**节点还活着**的时候调（`onInit` / `apply`）；**不要**在 `onDispose` 里调 —— 那时后代节点已被
     * `_destruct`，`getComponent` 会抛（见 onDispose 的注释），按钮引用一律用 `this.actionButton`。
     */
    private actionBtn(): Button | null {
        // 按钮**必须挂在 `unlock` 上**（它才是 140×40 的点击区域）：挂在 `unlock/icon`（26×26 金币图标）
        // 上会出现「只有戳到金币才点得动」。`actionSprite` 也一律解析成 `unlock` 自己的 Sprite（见 resolveRefs）
        const node = this.node.getChildByName('unlock') ?? this.actionSprite?.node;
        if (!node) return null;
        const exist = node.getComponent(Button);
        if (exist) return exist;
        return node.addComponent(Button);
    }

    /** 详情按钮（同上；`onDispose` 里用记下来的 `this.detailButton`，不调本方法） */
    private detailBtn(): Button | null {
        const node = this.detailNode ?? this.node.getChildByName('detail');
        if (!node) return null;
        const exist = node.getComponent(Button);
        if (exist) return exist;
        return node.addComponent(Button);
    }

    /** 按名字兜底解析子节点（预制件里没拖 `@property` 也能跑） */
    private resolveRefs(): void {
        const n = this.node;
        const icon = n.getChildByName('icon');
        const skill = n.getChildByName('skill');

        this.headSprite = this.headSprite ?? icon?.getChildByName('inner')?.getComponent(Sprite);
        this.lockNode = this.lockNode ?? icon?.getChildByName('lock');
        this.nameLabel = this.nameLabel ?? n.getChildByName('name')?.getComponent(Label);
        this.resolveLevel(n);
        this.resolveExpBar(n);
        // 技能图标是 `skill` 的**第一个子节点**（作者摆的名字是 `Sprite`；也接受 `inner` 这个通用叫法）
        this.skillSprite = this.skillSprite
            ?? skill?.getChildByName('Sprite')?.getComponent(Sprite)
            ?? skill?.getChildByName('inner')?.getComponent(Sprite);
        this.detailNode = this.detailNode ?? n.getChildByName('detail');

        // 按钮底图 = `unlock` **自己**的 Sprite（点击落点 + 两态配色都认它，见 actionBtn 的说明）
        const unlock = n.getChildByName('unlock');
        const unlockSprite = unlock?.getComponent(Sprite) ?? null;
        if (unlockSprite && this.actionSprite && this.actionSprite !== unlockSprite && !warnedActionRef) {
            warnedActionRef = true;
            console.warn('[英雄页] 卡片上的 actionSprite 拖的不是 `unlock` 自己的 Sprite'
                + '（大概率拖成了 `unlock/icon`：按钮点不动 + 金币图标被染成青/灰），已按名字改用 `unlock`；'
                + '建议在编辑器里重拖一次');
        }
        this.actionSprite = unlockSprite ?? this.actionSprite;
        this.actionLabel = this.actionLabel ?? unlock?.getChildByName('Label')?.getComponent(Label);
        this.actionValueLabel = this.actionValueLabel ?? unlock?.getChildByName('value')?.getComponent(Label);
        // 价格图标：`unlock/icon`（金币图）。**进这里的第一时间记下它的原样** ——
        // 升级语境会把它换成经验图，之后还要能切回来（见 applyCostIcon）。
        const costIcon = unlock?.getChildByName('icon')?.getComponent(Sprite) ?? null;
        if (costIcon && !this.costIconBaseFrame) {
            this.costIconBaseFrame = costIcon.spriteFrame;
            this.costIconBaseColor = costIcon.color ? costIcon.color.clone() : null;
        }
        this.actionIconSprite = this.actionIconSprite ?? costIcon;

        // 详情按钮的文案是**静态**的（点了开弹窗，不再切换文案）——
        // 老预制件里可能还留着「收 起」，这里按名字纠正一次
        const detailLabel = this.detailNode?.getChildByName('Label')?.getComponent(Label);
        if (detailLabel) detailLabel.string = DETAIL_TEXT;

        if (!this.propertyNodes.length) {
            const rows: Node[] = [];
            for (const name of ['property', 'property-001', 'property-002', 'property-003']) {
                const row = n.getChildByName(name);
                if (row) rows.push(row);
            }
            this.propertyNodes = rows;
        }

        if (!this.nameLabel || !this.actionSprite || !this.headSprite) {
            console.warn('[英雄页] 卡片子节点契约不完整（需要 name / unlock / icon>inner）：', n.name);
        }
    }

    /**
     * 等级：`lv` 是**容器**（自己也挂着 Label，是静态前缀「LV.」），**数字在 `lv/value`**。
     *
     * 改版后预制件里拖的 `lvLabel` 一度指向那个前缀 Label —— 往里写数字会变成
     * 「LV.12」旁边再挂一个数字，所以这里**一律按名字改用 `lv/value`**，拖错只报一次日志。
     * （2026-10 预制件里已重拖修正，这段兜底留着防下次改版；回归由体检的 A′ 对照组覆盖。）
     * 老预制件（等级直接写在 `lv` 的 Label 上）也认：取不到 `value` 子节点就退回 `lv` 自己的 Label。
     */
    private resolveLevel(n: Node): void {
        const lv = n.getChildByName('lv');
        this.lvNode = this.lvNode ?? lv;
        if (!lv) return;

        const number = lv.getChildByName('value')?.getComponent(Label) ?? null;
        if (number) {
            if (this.lvLabel && this.lvLabel !== number && !warnedLevelRef) {
                warnedLevelRef = true;
                console.warn('[英雄页] 卡片上的 lvLabel 拖的不是 `lv/value`（等级数字），已按名字改用 `lv/value`；'
                    + '建议在编辑器里重拖一次');
            }
            this.lvLabel = number;
            return;
        }
        this.lvLabel = this.lvLabel ?? lv.getComponent(Label);
    }

    /** 经验条：`exp_bar` 上的 ProgressBar（`@property` 与名字兜底二选一，取到即用） */
    private resolveExpBar(n: Node): void {
        const root = n.getChildByName('exp_bar');
        this.expBar = this.expBar ?? root?.getComponent(ProgressBar);
        // 数字标签是**可选**节点（预制件现在没摆）：摆了就写「当前/所需」，没摆就只画进度
        this.expLabel = this.expLabel
            ?? root?.getChildByName('Label')?.getComponent(Label)
            ?? root?.getChildByName('value')?.getComponent(Label);
    }

    /* ===================================================================
     * 图标加载
     * =================================================================== */

    /**
     * 加载**碎图**（`textures/heros/*`、`textures/property/*`、`textures/common/*`）——
     * 必须用 `resources.load(路径/spriteFrame)`：`loadBundleSprite` 会把路径首段 `textures`
     * 当成分包名去加载，永远失败（见 `game_stage/HeroItem` 的同一条注释）。
     * 失败只报错、**不把已有图刷成空白**（占位图比空白更像"没坏"）。
     */
    private loadLooseIcon(path: string, target: Sprite, label: string): void {
        if (!path || !target) return;
        resources.load(`${path}/spriteFrame`, SpriteFrame, (err, spriteFrame) => {
            if (err || !spriteFrame) {
                ezgame.error(`[英雄页] ${label}加载失败：${path}`, err);
                return;
            }
            if (target.isValid) target.spriteFrame = spriteFrame;
        });
    }
}
