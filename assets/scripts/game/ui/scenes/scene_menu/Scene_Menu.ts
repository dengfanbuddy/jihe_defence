import { _decorator, Button, Component, director, Label, Node } from 'cc';
import BaseView from 'db://assets/scripts/platform/ui/BaseView';
import { uiview } from 'db://assets/scripts/platform/ui/UIDecorator';
import UIManager from 'db://assets/scripts/platform/ui/UIManager';
import { ViewLayer } from 'db://assets/scripts/platform/ui/ViewInfo';
import { Scene_Game_Stage } from '../scene_game_stage/Scene_Game_Stage';
import { View_TaskUI } from '../../views/task/View_TaskUI';
import { View_Shop } from '../../views/shop/View_Shop';
import { View_Bag } from '../../views/bag/View_Bag';
import { CurrencyType, DataCenter, type IHeroActionResult } from '../../../data';
import { ScopeKey } from 'db://assets/scripts/platform/ui/UIScope';
import { ref } from 'db://assets/scripts/platform/reactivity';
import { Cmp_Difficulty } from './cmps/Cmp_Difficulty';
import { DifficultyScopeEvents } from './cmps/DifficultyScope';
import { describeLevel } from '../../../common/DifficultyConfig';
import { gameModeName } from '../../../common/GameModeConfig';
import { Cmp_Game } from './cmps/Cmp_Game';
import { Cmp_HeroDetail } from './cmps/Cmp_HeroDetail';
import { HeroScopeEvents } from './cmps/HeroScope';
import { buildDetailVM } from './cmps/HeroVM';
import { HeroConfig } from '../../../data/configs/HeroConfig';


const { ccclass, property } = _decorator;

/** 难度弹窗节点的名字（`@property` 没拖时的兜底；场景根节点的直接子节点） */
const DIFFICULTY_NODE_NAME = 'ui_difficulty';

/**
 * 「游戏」页的节点路径（模式卡 + 顶部进度那条）—— `Cmp_Game` 挂在它上面。
 * 它是左侧页签 `Cmp_FuncTabs` 的 content 之一（`content/right` 的第 0 个），
 * 所以路由/显隐归 `Tabs`，这里只负责"确保组件在"。
 */
const GAME_PAGE_PATH = 'content/right/game';

/** 英雄详情弹窗节点的名字（同上；**必须在 `ui_difficulty` 之后**，见预制件的子节点顺序） */
const HERO_DETAIL_NODE_NAME = 'ui_hero_detail';

/**
 * 商城入口（一）：底部左侧页签 `bottom/left/shop`（与 `bag` / `task` 同形：**纯 `Sprite` 节点、
 * 连 `Button` 都没有** → 走节点触摸事件，与 `taskBtn` 同口径）。
 * ⚠ 它是 `Scene_Menu.prefab` 里后加的一格，`@property` 没拖时按这条路径兜底解析。
 */
const SHOP_TAB_PATH = 'bottom/left/shop';

/** 背包入口：底部左侧页签 `bottom/left/bag`（同上，纯 Sprite 节点走节点触摸） */
const BAG_TAB_PATH = 'bottom/left/bag';

/**
 * 三个 **`views` 层的全屏页**（背包 / 商城 / 任务）—— 用来做互斥，见 `closeViewPages`。
 * `[视图类, 类名]`；类名要跟 `@uiview` 注册的视图名一致（UIManager 就是按它查栈的）。
 */
const VIEW_PAGES: Array<[any, string]> = [
    [View_Bag, 'View_Bag'],
    [View_Shop, 'View_Shop'],
    [View_TaskUI, 'View_TaskUI'],
];

/**
 * 商城入口（二）：顶栏 `head/coins` 下三格各自的 `add`（同样是纯 Sprite 节点）。
 * 三格 `value` 的读数还没接（`ernergy-001/002` 指代什么要先定，见 `docs/shop/README.md` §3.1）。
 */
const SHOP_ENTRY_PATHS = [
    'head/coins/gold/add',
    'head/coins/ernergy-001/add',
    'head/coins/ernergy-002/add',
];

/**
 * 顶栏金币读数 = `head/coins/gold/value`（`@property goldValueNode` 没拖时的兜底路径，
 * 与上面两个进度标签同口径）。
 */
const GOLD_VALUE_PATH = 'head/coins/gold/value';

@uiview({
    prefabPath: 'prefabs/ui/scenes/scene_menu/Scene_Menu', // 预制件路径
    layer: ViewLayer[ViewLayer.Scene], // 所属层级
    single: true,//是否是单例，单例的话只能有一个当前视图存在
})
@ccclass('Scene_Menu')
export class Scene_Menu extends BaseView {


    playerInfoNode:Node

    /** 成就红点（左侧页签 `achivement/icon/red_dot`，见 AchievementData.getClaimableCount） */
    private achieveRedDot: Node = null;


    /** 弹窗上的页面控制器（组件挂在 `ui_difficulty` 上，这里只是引用） */
    private difficulty: Cmp_Difficulty = null;
    /** 弹窗的两条向上事件是否已接（幂等守卫，见 `wireDifficultyEvents`） */
    private difficultyWired = false;

    /** 英雄详情弹窗的节点 + 控制器（组件挂在 `ui_hero_detail` 上） */
    private heroDetail: Cmp_HeroDetail = null;
    /** 英雄页那几条向上事件是否已接（幂等守卫，与难度弹窗同一个理由） */
    private heroWired = false;
    /** 弹窗当前给谁开着（0 = 没开；解锁/升级后据此判断要不要重推 VM） */
    private heroDetailHeroId = 0;
    /**
     * 「游戏」页的控制器（组件挂在 `content/right/game` 上，这里只是引用）。
     *
     * ⚠ 顶部那两格进度（最高通过 / 上次玩过）与模式卡的选中态**都归它画**（那是它的子树）——
     *   本文件不再自己写 `content/right/game/info/**` 的标签，只保证"组件在"。
     */
    private gamePage: Cmp_Game = null;
    /** 商城入口的三颗 `add`（`head/coins/<格名>/add`；退订要用同一批节点） */
    private shopEntryNodes: Node[] = [];


    //背包功能按钮
    @property(Node)
    bagBtn: Node = null;
    //任务功能按钮
    @property(Node)
    taskBtn: Node = null;
    //商城功能按钮（底部页签 `bottom/left/shop`；没拖就按路径兜底解析）
    @property(Node)
    shopBtn: Node = null;
    //进入游戏功能按钮
    @property(Node)
    enterGameBtn: Node = null;

    /** 难度选择弹窗的节点（`ui_difficulty`；预制件里已拖好，没拖就按名字兜底解析） */
    @property(Node)
    difficultyNode: Node = null;

    /** 英雄详情弹窗的节点（`ui_hero_detail`；同上，没拖就按名字兜底解析） */
    @property(Node)
    heroDetailNode: Node = null;

    @property(Label)
    goldValueNode: Label = null;

    start() {
        // 进入游戏：先弹**难度选择**，由弹窗「确定」再真正开战（见 enterGame）
        this.enterGameBtn?.on(Button.EventType.CLICK, this.onClickEnterGame, this);
        // 任务入口（bottom/left/task）：该节点上没有 Button，用节点触摸事件当点击
        // （想改成按钮：在预制件里给它加 Button，再把这里换成 Button.EventType.CLICK）
        this.taskBtn?.on(Node.EventType.TOUCH_END, this.onClickTask, this);
        // 背包入口：底部「背包」页签（同上没有 Button；`@property bagBtn` 预制件里已拖好）
        this.wireBagTab();
        // 商城入口（一）：底部「商城」页签（同上没有 Button）
        this.wireShopTab();
        // 商城入口（二）：顶栏 coins 三格的「+」
        this.wireShopEntries();
    }

    /* ===================================================================
     * 背包（全屏页；形态 = views 形态的 BaseView：`prefabs/ui/views/bag/View_Bag`）
     *
     * 分层（与商城/任务页逐字同口径，完整口径见 `docs/bag/README.md` §2）：
     *   · **入口归宿主**：底部「背包」页签（`bottom/left/bag`，`@property bagBtn` 已拖）。
     *   · **互斥归宿主**：它与另两个全屏页、两个场景内嵌弹窗都不同时可见（见 `closeViewPages` /
     *     `closeDifficultyPanel` / `closeHeroDetail`）—— 叠在一起时上面那个会盖住下面那个的返回键。
     *   · **返回归页面自己**（`View_Bag.onClickBack` → `UIManager.closeUI`），宿主不用收。
     *   · **判据与数据都不在这里**：页面自己就是宿主（跨层 `emit` 到不了本场景，见
     *     `views/bag/BagScope.ts` 文件头）—— 判据在 `BagVM`、存量在 `BagData`，本文件只管"开"。
     * =================================================================== */

    /** 底部「背包」页签：纯 Sprite 节点 → 节点触摸当点击（与 `taskBtn` 同口径） */
    private wireBagTab(): void {
        this.bagBtn = this.bagBtn ?? this.node.getChildByPath(BAG_TAB_PATH);
        if (!this.bagBtn) {
            ezgame.warn(`[背包] 找不到底部页签节点 ${BAG_TAB_PATH} → 那一格点不动`);
            return;
        }
        this.bagBtn.on(Node.EventType.TOUCH_END, this.onClickBag, this);
    }

    /** 打开背包（全屏页；进游戏/回主界面时由 `UIManager` 的层级切换自动收掉） */
    private onClickBag(): void {
        this.closeViewPages('View_Bag');
        this.closeDifficultyPanel();
        this.closeHeroDetail();
        UIManager.ins.showUI(View_Bag);
    }

    /**
     * 把**同层的另外两个全屏页**收掉（背包 / 商城 / 任务）。
     *
     * ⚠ 为什么必须由宿主做：`UIManager.showUI` 只在**切到场景层**时才自动关闭其它层的 UI
     *   （`closeAndCacheOverlayLayers`），**同一个 `views` 层里连开两个页面不会互斥** ——
     *   两个全屏页会直接叠在一起，上面那个把下面那个的返回键盖住，玩家就回不去了。
     * 没开的页面调 `closeUI` 是空操作（栈里找不到就 return），所以这里可以无脑全调一遍。
     */
    private closeViewPages(except: string): void {
        for (const [cls, name] of VIEW_PAGES) {
            if (name === except) continue;
            UIManager.ins.closeUI(cls);
        }
    }

    /* ===================================================================
     * 商城（全屏页；形态 = views 形态的 BaseView：`prefabs/ui/views/shop/View_Shop`）
     *
     * 分层（与项目其它界面一致，完整口径见 `docs/shop/README.md` §1）：
     *   · **入口归宿主**：底部「商城」页签 + 顶栏 `head/coins/{gold,ernergy-001,ernergy-002}/add` 三颗。
     *   · **互斥归宿主**：开商城前先收起 `ui_difficulty` / `ui_hero_detail` ——
     *     三个都是全屏/模态，叠在一起上面那个会盖住下面那个的关闭按钮（与 `onClickEnterGame` 同一行口径）。
     *   · **返回归页面自己**（`View_Shop.onClickBack` → `UIManager.closeUI`），宿主不用收。
     *   · **判据与发奖都不在这里**：页面自己就是宿主（跨层 `emit` 到不了本场景，见 `views/shop/ShopScope.ts`
     *     文件头的说明）—— 判据在 `ShopVM`、发奖在 `DataCenter`，本文件只管"开"和"互斥"。
     * =================================================================== */

    /** 底部「商城」页签：纯 Sprite 节点 → 节点触摸当点击（与 `taskBtn` 同口径） */
    private wireShopTab(): void {
        this.shopBtn = this.shopBtn ?? this.node.getChildByPath(SHOP_TAB_PATH);
        if (!this.shopBtn) {
            ezgame.warn(`[商城] 找不到底部页签节点 ${SHOP_TAB_PATH} → 那一格点不动`);
            return;
        }
        this.shopBtn.on(Node.EventType.TOUCH_END, this.onClickShop, this);
    }

    /** 顶栏三格的「+」都是纯 Sprite 节点 → 节点触摸当点击（与 `taskBtn` 同口径） */
    private wireShopEntries(): void {
        for (const path of SHOP_ENTRY_PATHS) {
            const add = this.node.getChildByPath(path);
            if (!add) {
                ezgame.warn(`[商城] 找不到入口节点 ${path} → 顶栏那一格点「+」不会有反应`);
                continue;
            }
            add.on(Node.EventType.TOUCH_END, this.onClickShop, this);
            this.shopEntryNodes.push(add);
        }
    }

    /** 打开商城（全屏页；进游戏/回主界面时由 `UIManager` 的层级切换自动收掉） */
    private onClickShop(): void {
        // 三个全屏页互斥（同层不会自动关，见 closeViewPages）
        this.closeViewPages('View_Shop');
        this.closeDifficultyPanel();
        this.closeHeroDetail();
        UIManager.ins.showUI(View_Shop);
    }

    /** 打开任务界面（任务数据/领奖规则在 data/funcs/TaskData.ts，界面只是宿主） */
    private onClickTask(): void {
        this.closeViewPages('View_TaskUI');
        this.closeDifficultyPanel();
        this.closeHeroDetail();
        UIManager.ins.showUI(View_TaskUI);
    }

    /* ===================================================================
     * 难度选择弹窗（宿主侧：持有节点 + 显隐 + 接弹窗冒泡上来的两件事）
     *
     * 分工：弹窗（`Cmp_Difficulty`）只渲染三态与选择，**不落盘、不跳场景**；
     *       落盘选择与进游戏都在这里 —— 那是"流程归谁管"的问题，不是弹窗的事。
     * =================================================================== */

    /**
     * 解析弹窗节点、拿到控制器组件。
     * 幂等（`init()` 与「开始游戏」各调一次）：**不管显隐**（显隐见 `openDifficultyPanel` / `closeDifficultyPanel`），
     * 组件在就复用（预制件里已经挂在 `ui_difficulty` 上了，`addComponent` 只是兜底）。
     */
    private setupDifficultyPanel(): void {
        this.difficultyNode = this.difficultyNode ?? this.node.getChildByName(DIFFICULTY_NODE_NAME);
        if (!this.difficultyNode) return;
        this.difficulty = this.difficulty ?? this.difficultyNode.getComponent(Cmp_Difficulty)
            ?? this.difficultyNode.addComponent(Cmp_Difficulty);
    }

    /**
     * 接弹窗冒泡上来的两件事（确定 / 关闭）。
     * 单独一步 + `difficultyWired` 守卫：它**不能**跟着节点解析一起判幂等 ——
     * 万一第一次解析节点时弹窗还没就位（拿不到节点），事件也不能就此永久不接。
     */
    private wireDifficultyEvents(): void {
        if (this.difficultyWired) return;
        this.difficultyWired = true;
        this.scope.on(DifficultyScopeEvents.Confirm, (level: number) => this.enterGame(level), this);
        this.scope.on(DifficultyScopeEvents.Close, () => this.closeDifficultyPanel(), this);
    }

    /** 点「开始游戏」：开弹窗（弹窗缺失时兜底成"直接按当前选择开战"，不让主界面卡死） */
    private onClickEnterGame(): void {
        this.setupDifficultyPanel();
        if (!this.difficultyNode || !this.difficulty) {
            ezgame.warn(`[难度选择] 弹窗不可用（预制件里没有 ${DIFFICULTY_NODE_NAME} 节点？）→ 按当前选择直接开战`);
            this.enterGame(DataCenter.ins.levelData.getSelectedLevel());
            return;
        }
        // 两个全屏弹窗**不同时开**（叠在一起时上面那个会盖住下面那个的关闭按钮，见 README §3.1）
        this.closeHeroDetail();
        // 节点显隐由**持有节点的宿主**写（弹窗自己不动自己的 active）。
        // 打开这一下会触发弹窗的 onShow → 它按最新进度重铺/重画（不用宿主去喂数据）。
        // ⚠ 弹窗读的是**当前模式**那套进度（`LevelData.getSelectedLevel()` 默认取当前模式），
        //   而当前模式是模式卡点一下就已经落盘了的（`Cmp_Game.onClickCard`）——
        //   所以这里不需要、也不该再传一次模式。
        this.difficultyNode.active = true;
    }

    private closeDifficultyPanel(): void {
        if (this.difficultyNode && this.difficultyNode.isValid) this.difficultyNode.active = false;
    }

    /**
     * 真正开战（弹窗「确定」`DifficultyScopeEvents.Confirm`、以及弹窗缺失时的兜底都走这里）。
     *
     * ⚠ **顺序不能换**：先把选择的档位落盘（`selectLevel`），再 `showUI(Scene_Game_Stage)` ——
     *   战斗场景是在自己的 `show()` 里读这个档位的，反过来写就会让这一局用的是上一档的数值。
     * ⚠ 档位是**按模式各记一份**的，所以这里必须带上当前模式（`selectLevel` 省略模式 = 当前模式，
     *   显式传一次是为了让"这一段落的是哪个模式的账"在代码里看得见）。
     */
    private enterGame(level: number): void {
        const data = DataCenter.ins.levelData;
        const mode = data.getMode();
        if (!data.selectLevel(level, mode)) {
            // 理论上进不来（未解锁的格子点不动）；真发生了就退回当前合法选择，不让流程断掉
            ezgame.warn(`[难度选择] 档位 ${level} 未解锁，改用当前选择 ${data.getSelectedLevel(mode)}`);
        }
        ezgame.info(`[难度选择] 开战：${gameModeName(mode)} · ${describeLevel(data.getSelectedLevel(mode))}`);
        this.closeDifficultyPanel();
        UIManager.ins.showUI(Scene_Game_Stage);
    }

    /* ===================================================================
     * 「游戏」页（模式卡 + 顶部进度）
     *
     * 分工：**页面自己就是数据的主人** —— `Cmp_Game` 直接读写 `LevelData`
     * （模式落盘、顶部信息刷新、卡片选中态都在它里面），与 `Cmp_Difficulty` / `Cmp_Heroes` 同口径。
     * 本文件只做一件事：**保证那个组件在**（它是"点开始游戏"这条流程的前半段，
     * 组件丢了就选不了模式 —— 与难度弹窗缺失时的兜底同一个理由）。
     * =================================================================== */

    /**
     * 解析「游戏」页的节点并拿到控制器（幂等：`init()` 调一次）。
     * 预制件里组件已经挂好了，`addComponent` 只是兜底（作者漏挂时页面还不至于变成死的）。
     */
    private setupGamePage(): void {
        const pageNode = this.node.getChildByPath(GAME_PAGE_PATH);
        if (!pageNode) {
            ezgame.warn(`[游戏模式] 预制件里找不到「游戏」页节点（${GAME_PAGE_PATH}）→ 模式切不了、顶部进度也不会刷新`);
            return;
        }
        this.gamePage = this.gamePage ?? pageNode.getComponent(Cmp_Game) ?? pageNode.addComponent(Cmp_Game);
    }

    /* ===================================================================
     * 英雄详情弹窗（宿主侧：持有节点 + 显隐 + 接英雄页冒泡上来的四件事）
     *
     * ── 为什么宿主是 `Scene_Menu` 而不是英雄页（`Cmp_Heroes`）──
     * `UIScope.emit` **只沿 `node.parent` 向上冒泡**，而 `ui_hero_detail` 是**根节点的子节点**
     * （与 `content` 平级 —— 弹窗要盖住整屏，塞不进 `content/right/heros` 里）。
     * 于是卡片发的「详 情」会冒到根、弹窗发的「升 级 / 解 锁」也只冒到根：
     * **根节点的 `Scene_Menu` 是唯一同时能看到这两侧的宿主**，`Cmp_Heroes` 只负责把列表画出来。
     * 由此还定下一条硬口径：`Unlock` / `LevelUp` **只有这里一个监听方** ——
     * 卡片与弹窗的按钮发的是同一个事件，两边各接一半就会「从弹窗点一下被处理两次」（重复扣费）。
     *
     * 分工（与本文件里难度弹窗逐字同口径）：
     *   · 弹窗只渲染 VM + 上报；**判据（够不够、花什么、花多少）在 `HeroVM` 算一次**；
     *   · 扣资源 / 写存档在 `DataCenter`（`unlockHero` 扣金币、`levelUpHero` 扣通用英雄经验）；
     *   · 列表重铺由 `Cmp_Heroes` 自己的指纹 watcher 负责（数据一变它自己重铺，不用这里去催）。
     * =================================================================== */

    /**
     * 解析弹窗节点、拿到控制器组件。
     * 幂等（`init()` 与每次开弹窗各调一次）：**不管显隐**（显隐见 `openHeroDetail` / `closeHeroDetail`），
     * 组件在就复用（预制件里已经挂在 `ui_hero_detail` 上了，`addComponent` 只是兜底）。
     */
    private setupHeroDetailPanel(): void {
        this.heroDetailNode = this.heroDetailNode ?? this.node.getChildByName(HERO_DETAIL_NODE_NAME);
        if (!this.heroDetailNode) return;
        this.heroDetail = this.heroDetail ?? this.heroDetailNode.getComponent(Cmp_HeroDetail)
            ?? this.heroDetailNode.addComponent(Cmp_HeroDetail);
    }

    /**
     * 接英雄页冒泡上来的四件事（开弹窗 / 关弹窗 / 解锁 / 升级）。
     * 单独一步 + `heroWired` 守卫：与难度弹窗同一个理由 —— 它**不能**跟着节点解析一起判幂等，
     * 万一第一次解析节点时弹窗还没就位（拿不到节点），事件也不能就此永久不接。
     */
    private wireHeroEvents(): void {
        if (this.heroWired) return;
        this.heroWired = true;
        this.scope.on(HeroScopeEvents.OpenDetail, this.openHeroDetail, this);
        this.scope.on(HeroScopeEvents.CloseDetail, this.closeHeroDetail, this);
        this.scope.on(HeroScopeEvents.Unlock, this.onHeroUnlock, this);
        this.scope.on(HeroScopeEvents.LevelUp, this.onHeroLevelUp, this);
    }

    /** 卡片点了「详 情」→ 开弹窗并下发这个英雄的整包数据 */
    private openHeroDetail(heroId: number): void {
        this.setupHeroDetailPanel();
        if (!this.heroDetailNode || !this.heroDetail) {
            ezgame.warn(`[英雄详情] 弹窗不可用（预制件里没有 ${HERO_DETAIL_NODE_NAME} 节点？）→ 本次点击无效果`);
            return;
        }
        // 两个全屏弹窗不同时开（同 onClickEnterGame 的说明）
        this.closeDifficultyPanel();
        this.heroDetailHeroId = heroId;
        this.pushHeroDetail();
    }

    /** 关联弹窗（不写任何数据；`heroDetailHeroId` 归零后，后续动作不会再往一个关着的弹窗里推数据） */
    private closeHeroDetail(): void {
        this.heroDetailHeroId = 0;
        if (this.heroDetailNode && this.heroDetailNode.isValid) this.heroDetailNode.active = false;
    }

    /**
     * 按当前数据重推一次弹窗内容（**开弹窗 / 解锁成功 / 升级成功后各调一次**）。
     *
     * ⚠ 这是"解锁后状态改变"能立刻看见的关键那一步：解锁成功后 `HeroVM.buildDetailVM` 会算出
     * **另一份 VM**（不再是"盖着锁 + 金币价 + 解 锁"，而是"亮起来 + 等级/经验 + 经验价 + 升 级"），
     * 弹窗按新 VM 整块重画 —— 不需要关掉再打开。
     */
    private pushHeroDetail(): void {
        const heroId = this.heroDetailHeroId;
        if (!heroId) return;

        const vm = buildDetailVM(heroId);
        if (!vm) {
            ezgame.warn(`[英雄详情] 配表里没有 id=${heroId} 这个英雄 → 收起弹窗`);
            this.closeHeroDetail();
            return;
        }
        this.heroDetail?.setVM(vm);
        if (this.heroDetailNode && this.heroDetailNode.isValid) this.heroDetailNode.active = true;
    }

    /** 点「解 锁」：**花金币**解锁（卡片与弹窗的按钮都会走到这里） */
    private onHeroUnlock(heroId: number): void {
        const res = DataCenter.ins.unlockHero(heroId);
        this.reportHeroResult('解锁', heroId, res);
        // 解锁成功后弹窗要给玩家看到"变了"：重推一次 VM（关着的时候这行是空操作）
        if (this.heroDetailHeroId === heroId) this.pushHeroDetail();
    }

    /** 点「升 级」：**花通用英雄经验**升级（同上） */
    private onHeroLevelUp(heroId: number): void {
        const res = DataCenter.ins.levelUpHero(heroId);
        this.reportHeroResult('升级', heroId, res);
        if (this.heroDetailHeroId === heroId) this.pushHeroDetail();
    }

    /** 失败原因是数据层给的判据（钱/经验不够、已解锁、未解锁），界面不自己重算一遍 */
    private reportHeroResult(action: string, heroId: number, res: IHeroActionResult): void {
        const name = HeroConfig.getHero(heroId)?.name ?? `id=${heroId}`;
        if (res.ok) {
            const what = action === '解锁' ? '金币' : '通用英雄经验';
            ezgame.info(`[英雄] ${name} ${action}成功（消耗 ${res.cost} ${what}，当前 Lv.${res.level}）`);
            return;
        }
        ezgame.warn(`[英雄] ${name} ${action}失败：${this.heroReasonText(res.reason)}`);
    }

    private heroReasonText(reason: string): string {
        switch (reason) {
            case 'no_gold': return '局外金币不足';
            case 'no_exp': return '通用英雄经验不足';
            case 'no_formula': return '配表没给经验口径（heroExpFormulaBase 配成 0？）';
            case 'already_unlocked': return '已经解锁了';
            case 'locked': return '还没解锁';
            case 'unknown_hero': return '配表里没有这个英雄';
            default: return reason || '未知原因';
        }
    }

    /**
     * 成就红点：左侧功能页签 `achivement/icon/red_dot` 的显隐。
     *
     * ⚠ **为什么放在常驻的 `Scene_Menu` 而不是成就页（`Cmp_Achievement`）**：
     * 成就页节点在没选中时是 `active=false`，挂在它上面的 watcher 会随 `onDisable` 暂停 ——
     * 红点就只在「已经打开了成就页」时才亮，而那正是最不需要它的时候。
     * 数据侧判据只有一条：`AchievementData.getClaimableCount() > 0`（有可领档就亮，领完自然灭）。
     */
    protected init(): void {
        this.achieveRedDot = this.node.getChildByPath('content/left/menus/contents/achivement/icon/red_dot');
        if (!this.achieveRedDot) {
            ezgame.warn('[成就] 找不到左侧页签红点节点（content/left/menus/contents/achivement/icon/red_dot）');
        }
        this.refreshAchieveRedDot(DataCenter.ins.achieveData.getClaimableCount());
        this.scope.watch(
            () => DataCenter.ins.achieveData.getClaimableCount(),
            (count: number) => this.refreshAchieveRedDot(count),
        );

        // 难度弹窗：解析节点 + 收它冒泡上来的两件事（确定 / 关闭），并**开局收起**
        // （预制件里这个节点是 `active=false` —— 静置态就该是关的；显隐归宿主管，见 open/closeDifficultyPanel）
        this.wireDifficultyEvents();
        this.setupDifficultyPanel();
        if (!this.difficultyNode) {
            ezgame.warn(`[难度选择] 预制件里找不到弹窗节点（${DIFFICULTY_NODE_NAME}）→ 点「开始游戏」将按当前选择直接开战`);
        } else {
            this.closeDifficultyPanel();
        }
        // 英雄详情弹窗：同上（事件是「开弹窗 / 关弹窗 / 解锁 / 升级」四件，见上面那一大段注释）
        this.wireHeroEvents();
        this.setupHeroDetailPanel();
        if (!this.heroDetailNode) {
            ezgame.warn(`[英雄详情] 预制件里找不到弹窗节点（${HERO_DETAIL_NODE_NAME}）→ 英雄页点「详 情」不会弹窗`);
        } else {
            this.closeHeroDetail();
        }
        // 「游戏」页：确保 `Cmp_Game` 在（模式卡的选中态 + 顶部「最高通过 / 上次玩过」都归它画）。
        // ⚠ 这里**不刷**那两格进度：它自己 `onInit` 就会画一次，之后靠自己的 watcher 跟。
        //   （宿主原来是直接写 `content/right/game/info/**` 的，那属于"越过页面去写它的子节点"，
        //     已把那两格连同 watcher 一起搬进 `Cmp_Game`。）
        this.setupGamePage();
        // 顶栏金币：先解析节点（`@property` 没拖就按路径兜底）、**先刷一次现值**，再挂监听。
        // 顺序不能反：watch 不立即执行，先挂后刷才有"第一帧就是真值"（见 refreshGold 的说明）。
        this.goldValueNode = this.goldValueNode ?? this.node.getChildByPath(GOLD_VALUE_PATH)?.getComponent(Label);
        if (!this.goldValueNode) {
            ezgame.warn(`[金币] 顶栏找不到读数节点 ${GOLD_VALUE_PATH} → 顶栏金币不会刷新`);
        } else {
            this.refreshGold();
        }
        // 局外金币的**唯一来源**是 `itemData.currencies.gold`（商城发奖 / 英雄解锁 / 遗物抽取都改它），
        // 所以盯这一个读法就够；本屏被缓存时 watcher 会暂停并**在 resume 时补播**（回主界面能跟上）。
        this.scope.watch(
            () => DataCenter.ins.itemData.getCurrency(CurrencyType.Gold),
            () => this.refreshGold(),
        );
    }

    /**
     * 顶栏「金币」读数：把 `ItemData` 里的**真实金币**画到 `head/coins/gold/value` 上。
     *
     * ⚠ **只有 `scope.watch` 是不够的**（这是这一格原来显示不对的原因）：
     *   `platform/reactivity` 的 `watch` 不带 `immediate` 时，初次只 `effect.run()` 取一遍旧值、
     *   **不回调** —— 于是进主界面第一眼看到的是预制件里烤死的静态文案（现为 `200`），
     *   而不是存档里的真实金币；要等金币**变化一次**才会被改对。
     *   本方法就是补上"首次绘制"这一下（`init()` 与 `show()` 各调一次）。
     * 数值一律走数据层门面 `getCurrency()`（它读的就是响应式字段，watcher 照样能追踪），
     * 本方法只做"读 → 写"，不自己算账。
     */
    private refreshGold(): void {
        if (!this.goldValueNode || !this.goldValueNode.isValid) return;
        this.goldValueNode.string = `${DataCenter.ins.itemData.getCurrency(CurrencyType.Gold)}`;
    }

    private refreshAchieveRedDot(count: number): void {
        if (this.achieveRedDot && this.achieveRedDot.isValid) {
            this.achieveRedDot.active = count > 0;
        }
    }

    onDestroy(): void {
        // 摘节点事件（事件挂在自己的节点上，退订要走 offNodeEvent 兜底，见 AGENTS.md）
        this.offNodeEvent(this.taskBtn, Node.EventType.TOUCH_END, this.onClickTask, this);
        this.offNodeEvent(this.bagBtn, Node.EventType.TOUCH_END, this.onClickBag, this);
        this.offNodeEvent(this.shopBtn, Node.EventType.TOUCH_END, this.onClickShop, this);
        this.offNodeEvent(this.enterGameBtn, Button.EventType.CLICK, this.onClickEnterGame, this);
        for (const add of this.shopEntryNodes) {
            this.offNodeEvent(add, Node.EventType.TOUCH_END, this.onClickShop, this);
        }
        this.shopEntryNodes = [];
        super.onDestroy();
    }

    protected show(): void {
        // 回到主界面（局内 `exit()` → showUI(Scene_Menu)）：两个弹窗一律是收起的。
        // ⚠ 「最高通过 / 上次玩过」不在这里补 —— 那两格归 `Cmp_Game`（它 `onShow` 会按当前数据重画，
        //   而且它的节点自始至终是激活的、watcher 一直是活的，回来时不会漏）。
        this.closeDifficultyPanel();
        this.closeHeroDetail();
        // 金币同理：本屏是被缓存的（`closeView` 只 `active=false`、不销毁），回来时**不走 `init()`**，
        // 所以这里也兜一次现值（watcher 的补播是另一条保险，两条都在才不怕时序）
        this.refreshGold();
    }

    protected close(): void {

    }


    static ScopeKey = {
        MenuSelect:"MenuSelect"
    }
}
