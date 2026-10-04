import { _decorator, Button, Color, Label, Node, ProgressBar, resources, Sprite, SpriteFrame } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { AtlasIcon } from '../../../../common/AtlasIcon';
import { NodeUtils } from '../../../../common/NodeUtils';
import { formatGold } from '../../../../common/GoldText';
import { HeroScopeEvents, type HeroCardVM } from './HeroScope';

const { ccclass, property } = _decorator;

/**
 * 「解锁 / 升级」按钮的两态色（与成就页 `AchievementItem.STATE_STYLE` 同一套青/灰口径）：
 * 可点 = 青底白字；不可点（金币不够）= 浅灰底白字。
 *
 * ⚠ 为什么把 `Button.transition` 关掉自己写色：`interactable = false` 时 Button 会用 `_disabledColor`
 *   统一覆盖外观，作者摆的两态直接被同一块灰吃掉（`AchievementItem` / `TaskItem` 同一个坑）。
 */
const BTN_ENABLED_BG = '#3F9E9B';
const BTN_DISABLED_BG = '#B9C1C1';

/** 详情按钮的两种文案（点它切换 `property` 行显示「当前值」还是「每级成长」） */
const DETAIL_TEXT_ON = '详 情';
const DETAIL_TEXT_OFF = '收 起';

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
 *   ② 通知:点「解 锁」`emit(Unlock)`、点「升 级」`emit(LevelUp)`、点「详 情」`emit(Detail)`
 *      —— 花钱、写存档、刷新都由宿主 `Cmp_Heroes` 做，本类不碰 `DataCenter`；
 *   ③ 详情态：`detail` 按钮只是一个**显示模式开关**（不是二级页面）——
 *      关闭时属性行显示「当前值」（`320`），打开时显示「每级成长」（`+12/级`）。
 *
 * ⚠ **英雄详情页是另一个独立预制件（还没做）**：做好之后「升级按钮 + 消耗经验升级」搬过去，
 *   本卡片的 `unlock` 按钮与 `detail` 开关随之调整 —— 现在卡片只画状态，不负责那套流程。
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
 * ├── detail/Label      「详 情」/「收 起」
 * ├── unlock            解锁 / 升级按钮 → Label(文案) / icon(金币图标) / value(价格)
 * └── property(-00N)    4 行属性 → icon / name / value
 * ```
 * 所有子节点引用都按名字兜底解析（`@property` 没拖也能跑），与 `AchievementItem.resolveRefs` 同一套路。
 *
 * ⚠ 改版后**两处拖引用极易拖错**，`resolveRefs` 里会按名字纠正并打日志（见那两个 `warn`）：
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
    @property(Node)
    detailNode: Node = null;
    @property([Node])
    propertyNodes: Node[] = [];

    /* ==================== 运行时状态 ==================== */

    /** 当前卡面数据（null = 没有内容） */
    private vm: HeroCardVM | null = null;
    /** 详情态（true = 属性行显示每级成长） */
    private expanded = false;
    /** 等级整块（`lv` 容器：前缀 + 数字），未解锁时整块收起（只藏数字会留一个孤零零的「LV.」） */
    private lvNode: Node | null = null;
    /** 经验条上的数字标签（可选节点 `exp_bar/Label`，预制件里没有就不写） */
    private expLabel: Label | null = null;
    /** 已加载过的头像路径（同一张卡重刷时不再重复解析） */
    private loadedHead: string | null = null;
    /** 已加载过的技能图标路径 */
    private loadedSkill: string | null = null;

    /* ==================== 生命周期 ==================== */

    protected onInit(): void {
        this.resolveRefs();
        // 两个按钮都自己写色（见文件头 BTN_ENABLED_BG 那段的说明）
        const detailBtn = this.detailBtn();
        if (detailBtn) {
            detailBtn.transition = Button.Transition.NONE;
            detailBtn.node.on(Button.EventType.CLICK, this.onClickDetail, this);
        }
        const actionBtn = this.actionBtn();
        if (actionBtn) {
            actionBtn.transition = Button.Transition.NONE;
            actionBtn.node.on(Button.EventType.CLICK, this.onClickAction, this);
        }
    }

    protected onShow(): void {
        // 显示时按当前数据无条件重画一次（vm 是普通字段，watch 感知不到）
        if (this.vm) this.apply();
    }

    protected onDispose(): void {
        // 后代节点走 offNodeEvent（节点销毁时 node.off 会炸，见 AGENTS.md）
        const detailBtn = this.detailBtn(false);
        if (detailBtn) this.offNodeEvent(detailBtn.node, Button.EventType.CLICK, this.onClickDetail, this);
        const actionBtn = this.actionBtn(false);
        if (actionBtn) this.offNodeEvent(actionBtn.node, Button.EventType.CLICK, this.onClickAction, this);
    }

    /* ===================================================================
     * 对外：宿主下发数据
     * =================================================================== */

    /** 设置这张卡显示哪个英雄（`null` = 整卡收起） */
    setInfo(vm: HeroCardVM | null): void {
        this.vm = vm ?? null;
        this.expanded = false;         // 换内容就复位详情态（宿主重铺列表时会重新下发）
        this.apply();
    }

    /** 当前卡片对应的英雄 id（0 = 没有内容） */
    getHeroId(): number {
        return this.vm?.heroId ?? 0;
    }

    /** 宿主用它做「同时只展开一张卡」的互斥（不发事件，纯表现） */
    setExpanded(expanded: boolean): void {
        if (this.expanded === expanded) return;
        this.expanded = expanded;
        this.applyDetail();
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
        this.applyDetail(false);       // 属性行刚画过（`applyAttrs` 已按当前详情态取值），只刷按钮文案

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
     * 经验进度条（`exp_bar`）：`progress = 当前经验 / 升下一级所需`（`vm.exp` / `vm.expMax`）。
     *
     * 收起条件（两条都不画空条）：**未解锁**（没有档案，经验无意义）或 `expMax <= 0`
     * （配表没给经验口径）—— 否则玩家会看到一条永远是 0 的进度条，像是坏了。
     *
     * ⚠ `vm.expMax` 由宿主给（`HeroData.getExpForNextLevel`），**本类不算经验公式** ——
     *   公式只该有一份，结算（`addHeroExp`）与展示（这里）必须同口径。
     */
    private applyExp(vm: HeroCardVM): void {
        const bar = this.expBar;
        if (!bar) return;

        const show = vm.unlocked && vm.expMax > 0;
        bar.node.active = show;
        if (!show) return;

        // `progress` 是 0~1 的比例，ProgressBar 直接按 `totalLength × progress` 设 `Bar` 的宽度；
        // 这里 clamp 一道，免得脏存档（exp 比 expMax 还大）把填充条画到框外
        bar.progress = Math.min(1, Math.max(0, vm.exp / vm.expMax));

        // 预制件里没有这个数字标签就不写（节点可选，见 file head 的节点契约）
        if (this.expLabel) {
            this.expLabel.string = `${Math.floor(vm.exp)}/${Math.floor(vm.expMax)}`;
        }
    }

    /** 「解锁 / 升级」按钮：文案 + 价格 + 能不能点 + 两态色 */
    private applyAction(vm: HeroCardVM): void {
        const btn = this.actionBtn();
        if (this.actionSprite) this.actionSprite.color = new Color().fromHEX(vm.enabled ? BTN_ENABLED_BG : BTN_DISABLED_BG);
        if (this.actionLabel) this.actionLabel.string = vm.unlocked ? '升 级' : '解 锁';

        if (this.actionValueLabel) {
            // 价格为 0 = 免费（配表把基准价配成 0 时）→ 收起价格文字，免得显示一个孤零零的「0」
            this.actionValueLabel.string = vm.cost > 0 ? formatGold(vm.cost) : '';
            this.actionValueLabel.node.active = vm.cost > 0;
        }

        // ⚠ 顺序：先把所有颜色写完再设 interactable —— `transition = NONE` 下 Button 不会覆盖颜色，
        //   但 `interactable = false` 仍然会拦掉 CLICK（这正是我们要的：钱不够点不动）
        if (btn) {
            btn.transition = Button.Transition.NONE;
            btn.interactable = vm.enabled;
        }
    }

    /** 4 行属性：图标 / 名称 / 值（值按详情态切「当前值」或「每级成长」） */
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
            if (valueLabel) valueLabel.string = this.expanded ? data.growthText : data.valueText;

            const iconSprite = row.getChildByName('icon')?.getComponent(Sprite);
            if (iconSprite && data.icon) {
                this.loadLooseIcon(data.icon, iconSprite, `属性图标 ${data.name}`);
            }
        }
    }

    /**
     * 详情态：按钮文案 + 4 行属性重画（属性行显示什么只有一处判据 = `applyAttrs`）。
     * @param refreshAttrs 刚画完属性行时传 false，省掉一次重复渲染
     */
    private applyDetail(refreshAttrs = true): void {
        const label = this.detailNode?.getChildByName('Label')?.getComponent(Label);
        if (label) label.string = this.expanded ? DETAIL_TEXT_OFF : DETAIL_TEXT_ON;
        if (refreshAttrs && this.vm) this.applyAttrs(this.vm);
    }

    /* ===================================================================
     * 交互
     * =================================================================== */

    /** 点「解 锁」/「升 级」：只向上通知（买不买、够不够钱由宿主判） */
    private onClickAction(): void {
        const vm = this.vm;
        if (!vm || !vm.enabled) return;
        this.scope.emit(vm.unlocked ? HeroScopeEvents.LevelUp : HeroScopeEvents.Unlock, vm.heroId);
    }

    /** 点「详 情」/「收 起」：先切自己的显示，再通知宿主做互斥 */
    private onClickDetail(): void {
        if (!this.vm) return;
        this.expanded = !this.expanded;
        this.applyDetail();
        this.scope.emit(HeroScopeEvents.Detail, this.vm.heroId, this.expanded);
    }

    /* ===================================================================
     * 节点契约
     * =================================================================== */

    /** 解锁 / 升级按钮（缺 Button 时补一个；`create=false` 只查不建，销毁时用） */
    private actionBtn(create = true): Button | null {
        // 按钮**必须挂在 `unlock` 上**（它才是 80×40 的点击区域）：挂在 `unlock/icon`（26×26 金币图标）
        // 上会出现「只有戳到金币才点得动」。`actionSprite` 也一律解析成 `unlock` 自己的 Sprite（见 resolveRefs）
        const node = this.node.getChildByName('unlock') ?? this.actionSprite?.node;
        if (!node) return null;
        const exist = node.getComponent(Button);
        if (exist) return exist;
        return create ? node.addComponent(Button) : null;
    }

    /** 详情按钮（同上） */
    private detailBtn(create = true): Button | null {
        const node = this.detailNode ?? this.node.getChildByName('detail');
        if (!node) return null;
        const exist = node.getComponent(Button);
        if (exist) return exist;
        return create ? node.addComponent(Button) : null;
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
     * 改版后预制件里拖的 `lvLabel` 指的多半是那个前缀 Label —— 往里写数字会变成
     * 「LV.12」旁边再挂一个数字，所以这里**一律按名字改用 `lv/value`**，拖错只报一次日志。
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
