import { _decorator, Button, Color, Label, Node, ProgressBar, Sprite, SpriteFrame, Vec3, resources } from 'cc';
import { useBattleStore } from '../../../../stores';
import { EventBus } from '../../../../battle';
import { EventNames } from '../../../../battle/core/EventBus';
import { UIWidget } from '../../../../../platform/ui/UIWidget';
import { StageScopeEvents, StageScopeKeys } from './StageScope';
import type { HelpPanelVM } from './StageScope';
import { SkillSlot } from './skill_slot/SkillSlot';
import { SkillDetailPanel, ensureSkillDetailPanel, SKILL_DETAILS_NODE } from './skill_slot/SkillDetailPanel';
import { HeroPropertiesPanel, ensureHeroPropertiesPanel, HERO_PROPERTIES_NODE } from './hero_properties/HeroPropertiesPanel';
import type { HeroPropertiesVM } from './hero_properties/HeroPropertiesVM';
import { showFloatText } from './skill_slot/FloatText';
import { HelpPanel, HELP_PANEL_NODE, ensureHelpPanel } from './HelpPanel';
import { TbRoot } from 'db://assets/scripts/platform/excel_table/TbRoot';
import { UnitCfgContainer } from '../../../../excel_table/Tb_UnitConfig';
import { FINAL_BOSS_STAGE } from '../../../../common/EntityVisualConfig';
import { gameModeName } from '../../../../common/GameModeConfig';
import { formatNumber } from '../../../../common/GoldText';
import { RewardAdBonus } from '../../../../common/RewardAdBonus';
import { HIT_FEEL_INFO } from '../../../../common/HitFeelConfig';
import { BATTLE_SPEED_STEPS, BATTLE_SPEED_UNLOCK_ACCOUNT_LEVEL, SPEED_ROOT_NODE, findSpeedStep } from '../../../../common/BattleSpeedConfig';
import type { BattleSpeedStep } from '../../../../common/BattleSpeedConfig';
import { DataCenter } from '../../../../data/DataCenter';
import { ITEM_BAG_FLOAT_OFFSET_Y } from '../../../../common/ItemBagConfig';
import { ItemBagPanel } from './item_bag/ItemBagPanel';
import { StatusBarPanel } from './status_bar/StatusBarPanel';
import type { SkillSlotsVM } from '../../../../battle/SkillSlots';
import type { HeroSelectVM } from '../../../../battle/HeroSelect';
import type { BuffShopVM } from '../../../../battle/BuffShop';
import type { ItemBagVM } from '../../../../battle/ItemBag';
import type { BossSchedulerVM, BossSlotKey, BossSlotVM } from '../../../../battle/BossScheduler';

const { ccclass, property } = _decorator;

/** Boss 条目的倒计时在「充能 CD」与「场上限时」两种状态下的字色（限时 = 警示色，催玩家去处理） */
const BOSS_TIME_CD_COLOR = new Color(255, 255, 255, 255);
const BOSS_TIME_LIMIT_COLOR = new Color(255, 76, 76, 255);
/** 库存为 0（点不动）时数量文案的灰度 */
const BOSS_COUNT_IDLE_COLOR = new Color(160, 160, 160, 255);
const BOSS_COUNT_READY_COLOR = new Color(0, 0, 0, 255);

/**
 * 倍速档位的两态色（全部取自 `docs/art-style/tokens.json`，改色要三处同改）：
 *   选中 = `c-accent-600` 底 + `c-text-on-dark` 字（同主按钮／选中态）
 *   未选 = `c-surface-sunken` 底 + `c-ink-600` 字（同"分组底 + 战斗 HUD 正文"）
 * ⚠ 未选中**不用** `c-surface`(#FFFFFF)：HUD 站在浅蓝白战场底（`c-canvas-battle` #EBF4FB）上，
 *   白底格子的边界几乎看不见（截图验过一次）。
 */
const SPEED_ON_BG = new Color(103, 153, 154, 255);
const SPEED_OFF_BG = new Color(216, 216, 216, 255);
const SPEED_ON_TEXT = new Color(255, 255, 255, 255);
const SPEED_OFF_TEXT = new Color(106, 105, 107, 255);

/** 预制件里 `bosses` 下的三个条目节点名 → 调度器的槽位键 */
const BOSS_NODE_NAMES: [BossSlotKey, string][] = [
    ['gold', 'gold_boss'],
    ['kill', 'kill_boss'],
    ['guard', 'enimy_guard'],
];

/**
 * 英雄头像节点名（HUD 的直接子节点）——**点它切换「英雄属性详情」浮层**。
 * 挂的是预制件里 `head` 节点上的 `cc.Button`（transition = NONE，不另配一套彩色态），
 * 与 `heroSelectBtn` / `bosses` 三个条目同一种接法。
 */
const HEAD_NODE = 'head';

/**
 * 说明（游戏规则）按钮的节点契约：`ctl/help`（`ctl` 是 HUD 左下角那一列按钮，见预制件）。
 * 与 `pause` / `exit` 同一个父节点 → 由 `ctl` 的 Layout 自动排下去，代码不需要管位置。
 */
const CTL_NODE = 'ctl';
const HELP_BTN_NODE = 'help';

/**
 * **局内掉落 Buff 小背包**（6 格）的节点名：`item_bags`（HUD 的直接子节点）。
 *
 * 节点树（收纳按钮 / 展开区 / 6 个格子 / 说明浮层）由预制件作者摆好，本 HUD 只在运行时
 * 把 `ItemBagPanel` 挂上去（同 `skill_details` / `hero_properties` 的做法：**不改预制件结构**）。
 */
const ITEM_BAGS_NODE = 'item_bags';

/**
 * **状态栏**的节点名（HUD 的直接子节点）：`buff_status`，12 个 `buff*` 子节点已摆好。
 *
 * 与 `item_bags` 同一种接法：节点树（Sprite + Button 的 12 格）由预制件作者摆好，
 * 本 HUD 只在运行时把 `StatusBarPanel` 挂上去（**不改预制件结构**，文本子节点由面板自己建）。
 * 判据与画法见 `status_bar/StatusBarPanel.ts` / `battle/StatusBar.ts`。
 */
const BUFF_STATUS_NODE = 'buff_status';

/**
 * 结算面板**奖励格**的图标路径（两个格子各一张，都在 `IconPreload` 的清单里预载过）。
 *
 * 为什么要运行期 load：预制件 `end/reward_content` 下**两个格子的 `icon`** 上挂的是引擎内置的
 * `default_sprite_splash`（占位白块）—— 所以**不能**靠"精灵已有 spriteFrame"来判要不要加载，
 * 见 `ensureEndIcon` 的注释。
 *   · 金币 = `textures/common/gold`（与 `RefreshButtonView.GOLD_ICON_PATH` 同一张图，**共用一份**）
 *   · 英雄经验 = `textures/common/exp_icon`（与英雄卡 / 商城「英雄经验瓶」同一张图）
 */
const END_REWARD_ICON_PATH = 'textures/common/gold';
const END_EXP_ICON_PATH = 'textures/common/exp_icon';

/**
 * 结算面板两个奖励格的**水平间距**（像素）。
 *
 * 一格 60 宽（预制件 `item` 实测），间距 80 ⇒ 两格之间留 20 —— 与 `reward_content`
 * （400×100 的容器）的留白相称。**单格时恒居中**（`x = 0`），摆位逻辑在 `showEndReward`。
 */
const END_REWARD_CELL_PITCH = 80;

/** 结算广告位的三种文案（`{mul}` 由 `RewardAdBonus.format` 填，如 `2.3`） */
const END_AD_TEXT = '看广告 · 奖励 ×{mul}';
const END_AD_PLAYING_TEXT = '广告播放中…';
const END_AD_DONE_TEXT = '已翻倍 ×{mul}';

/**
 * 结算广告位按钮底的两种颜色（都取自 `docs/art-style/tokens.json`）。
 *
 *   · 可点 = `c-accent-action` #3F9E9B —— "这里能点"的专用色（与英雄卡升级 / 成就领取同一档）
 *   · 不可点 = `c-disabled-pill` #B9C1C1 —— "这一颗按钮现在不可点"的专用色（配白字）
 * ⚠ 这两种色是**运行期写**的，`audit:ui` 扫不到（它只扫预制件上序列化的值）——
 *   所以它们必须来自 tokens，不许在这里写野生色值。
 */
const END_AD_ENABLED_COLOR = new Color(63, 158, 155, 255);
const END_AD_DISABLED_COLOR = new Color(185, 193, 193, 255);

/** 一个正在弹跳的 HUD 节点（打击反馈 B3 / F10；只用帧计时，不用 tween） */
interface HudPunch {
    node: Node;
    /** 剩余时长 / 总时长（秒） */
    remain: number;
    dur: number;
}

/**
 * 在子树里按名字深度优先找节点。
 *
 * ⚠ 不用 `cc.find`：它遇到节点名里含 `/` 的情况会找不到（项目里踩过），
 *   而且它会从场景根开始找、可能命中另一棵子树里的同名节点。
 */
function findNodeByName(root: Node, name: string): Node | null {
    if (!root) return null;
    if (root.name === name) return root;
    for (const c of root.children) {
        const hit = findNodeByName(c, name);
        if (hit) return hit;
    }
    return null;
}

/** 一个 Boss 条目的运行时节点缓存（按名字找，**不改预制件**，同 `setupSkillSlots` 的做法） */
interface BossEntryRefs {
    key: BossSlotKey;
    node: Node;
    /** 倒计时数字（`time/value`） */
    value: Label | null;
    /** 数量（`count` / `count-001`；按前缀找，名字带序号后缀） */
    count: Label | null;
    /** 倒计时底圈（`time`）；无倒计时可显示时整块收起 */
    timeNode: Node | null;
    /** 点击回调（存起来用于成对 off —— 匿名闭包没法再 off 一次） */
    onClick: () => void;
}

/** 一个倍速档位的运行时引用（按名字找，**不改预制件**，同 `setupBossEntries` 的做法） */
interface SpeedCellRefs {
    step: BattleSpeedStep;
    node: Node;
    sprite: Sprite | null;
    label: Label | null;
    /** 点击回调（存起来用于成对 off —— 匿名闭包没法再 off 一次） */
    onClick: () => void;
}

/**
 * 战斗 HUD（内嵌在 `Scene_Game_Stage.prefab` 里 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * 写法与 `HeroSelectPanel` / `HeroItem` / `PlayerInfoCmp` 一致：
 *   - 一辈子一次的事（节点事件、watcher 注册、图标预加载）→ `onInit()`
 *   - 每次显示（= 开新一局）按当前状态无条件刷一遍 → `onShow()`（缓存复用时不会再跑 `onInit`）
 *   - 节点事件在 `onDispose()` 里成对 `off`；watcher 交给 `this.scope` 托管（不再手写 watchHandles 数组）
 *   - **战斗真源的投影**（hp / gold / killPoints / level / phase…）读全局 store（场景写、UI 读）
 *   - **功能页面状态**（选英雄 / Buff 商店 / 技能槽）读宿主 provide 的**功能门面**（`inject`）——
 *     门面就是 `HeroSelect` / `BuffShop` / `SkillSlots` 的只读面（`panelVisible` 等）；
 *     退出战斗走宿主注入的动作 —— 判据与键见 `StageScope.ts` 顶部注释
 *
 * ⚠ 节点在谁名下，显隐就由谁写：选英雄 / Buff 商店面板的节点在本 HUD 名下 → 显隐由本 HUD 写
 *   （遗物面板的节点在 `Scene_Game_Stage` 名下 → 由场景写，所以那两个 @property 不在这里）。
 *
 * 宿主把它当成普通子节点即可：**不需要**任何 `init(ctx)` / `unInit()` 成对调用。
 *
 * ⚠ 不要重写 onLoad / onEnable / onDisable / onDestroy —— 会盖掉基类的 scope 生命周期
 *   （onInit / onShow / onHide / onDispose 才是钩子）。
 */
@ccclass('View_Game_Stage')
export class View_Game_Stage extends UIWidget {



    /* ===== 场景节点 ===== */
    /* ===== 信息节点 ===== */
    @property(Label)
    info_name: Label = null;
    @property(Label)
    info_mode: Label = null;
    /* ===== 信息节点 ===== */
    @property(Label)
    progress_name: Label = null;
    @property(Label)
    progress_time: Label = null;
    @property(ProgressBar)
    progress_bar: ProgressBar = null;
    /* ===== 货币节点 ===== */
    /** 金币余额（`battleStore.gold`）：选英雄刷新 + 遗物抽取的货币 */
    @property(Label)
    money_gold_value: Label = null;
    /**
     * **击杀数余额**（`battleStore.killPoints`）：击杀商店（Buff）的货币。
     * 与金币并排的第二条经济线 —— 图标是 `textures/common/monster`（`money/kill/icon`）。
     */
    @property(Label)
    money_kill_value: Label = null;

    /* ===== 角色信息节点 ===== */
    @property(Sprite)
    head_icon: Sprite = null;
    /**
     * 技能栏父节点（预制件里的 `skills`，4 个槽位节点是它的子节点）。
     * 名字沿用旧字段名 `weapons_node`（历史叫"武器栏"），语义已是**技能栏**。
     */
    @property(Node)
    weapons_node: Node = null;
    @property(Label)
    hp_value: Label = null;
    @property(ProgressBar)
    hp_bar: ProgressBar = null;
    @property(Label)
    lv_value: Label = null;
    @property(Label)
    lv__exp_value: Label = null;
    @property(ProgressBar)
    lv_exp_bar: ProgressBar = null;

    //英雄选择面板
    @property(Node)
    heroSelectPanel: Node = null;
    //英雄选择按钮
    @property(Node)
    heroSelectBtn: Node = null;

    // ⚠ 遗物（肉鸽商店）的入口按钮与面板**不在这里持有**：它们由宿主 `Scene_Game_Stage` 持有
    //   （功能封装在 `RelicShop`，节点与显隐收口在场景，见 Scene_Game_Stage 的「遗物功能」段）。
    //   HUD 只持有**它自己子树里**的选英雄面板与 Buff 商店面板。

    //buff商店选择面板（节点在这里 → 显隐也由本 HUD 写；开关状态是 BuffShop 的 ref）
    @property(Node)
    shopBuffPanel: Node = null;
    //buff商店入口按钮（点击只翻开关，不自己去开关面板节点以外的任何东西）
    @property(Node)
    shopBuffBtn: Node = null;

    @property(Node)
    pauseBtn: Node = null;
    @property(Node)
    exitBtn: Node = null;

    @property(Node)
    endNode: Node = null;

    @property(Node)
    endBtnNode: Node = null;

    /** 结算面板标题（`end/title` 上的 Label）：胜/负文案由 `showEnd(victory)` 写 */
    @property(Label)
    end_title: Label = null;

    /** 结算面板的「战斗时长」行（`end/time` 上的 Label；`showEnd` 写 mm:ss） */
    @property(Label)
    end_time: Label = null;

    /**
     * 结算面板的奖励格（`end/reward_content/item`）—— 本局发到的**局外金币**那一格。
     *
     * ⚠ 发 0 时**整格收起**（不是写个 `+0` 上去）：`endRun` 在准备期就被打断、或以后把
     *   `runClearGoldBase` 配成 0 时都会走到这一支，写 `+0` 等于告诉玩家"打了半天什么都没有"。
     *   ⚠ 2026-11 起它不再是**唯一**的奖励格 —— 右边多了「通用英雄经验」那一格（`end_exp_item`）。
     */
    @property(Node)
    end_reward_item: Node = null;

    /** 金币格图标（`end/reward_content/item/icon` 上的 Sprite；运行期 load `textures/common/gold`） */
    @property(Sprite)
    end_reward_icon: Sprite = null;

    /** 金币格数值（`end/reward_content/item/v_content/value` 上的 Label） */
    @property(Label)
    end_reward_value: Label = null;

    /**
     * 结算面板的**第二个奖励格**（`end/reward_content/item-001`）—— 本局发到的**通用英雄经验**。
     *
     * 与金币格**同构**（同一套预制件节点：`icon` + `v_content/value`），口径见 `common/RunClearHeroExp`。
     * 发 0 时同样整格收起，剩下的格子由 `showEndReward` 重新居中。
     */
    @property(Node)
    end_exp_item: Node = null;

    /** 英雄经验格图标（`end/reward_content/item-001/icon` 上的 Sprite；运行期 load `textures/common/exp_icon`） */
    @property(Sprite)
    end_exp_icon: Sprite = null;

    /** 英雄经验格数值（`end/reward_content/item-001/v_content/value` 上的 Label） */
    @property(Label)
    end_exp_value: Label = null;

    /**
     * 结算面板的**广告位**（`end/ad_btn`，挂了 Button）—— 看广告把两份奖励乘一个倍率。
     *
     * 本组件只**画**它（三态文案 + 底色 + 可点性，见 `refreshEndAdButton`），
     * 点了沿父链冒泡 `StageScopeEvents.SettleAdRequested` 交给宿主 —— 规则与发放都在场景那一侧
     * （`Scene_Game_Stage.onSettleAdRequested`，口径真源 `common/RewardAdBonus`）。
     */
    @property(Node)
    end_ad_btn: Node = null;

    /** 广告位按钮上的文案（`end/ad_btn/Label`） */
    @property(Label)
    end_ad_label: Label = null;

    battleStore = useBattleStore()
    private startSF: SpriteFrame = null;
    private pauseSF: SpriteFrame = null;

    /**
     * 结算面板广告位的**三个视图状态**（`showEnd` 开局时重置、`refreshEndAdButton` 读它们画）。
     *
     * ⚠ 它们是**纯视图**：倍率真源在宿主（`Scene_Game_Stage.settleAdMul`），
     *   "一局一次"的闸门也在宿主（`settleAdUsed`）—— 这里存一份只是为了重画按钮。
     */
    private endSettleMul = 1;
    private endSettleClaimed = false;
    private endSettlePlaying = false;
    /** 结算奖励格的图标加载记账（**按路径**记，不看精灵当前挂着什么，见 `ensureEndIcon`） */
    private endIconLoaded = new Set<string>();

    /** 已加载的英雄头像路径（同一个路径不重复 load） */
    private headIconPath = '';
    /** 技能栏的 4 个槽位组件（onInit 时按 `skills` 的子节点逐个挂上） */
    private skillSlots: SkillSlot[] = [];
    /**
     * 长按技能槽弹出的详情面板。
     * 节点是**预制件里作者摆好的** `skill_details`（位置即最终位置），组件在本 HUD 的 `onInit` 里挂上去。
     */
    private detailPanel: SkillDetailPanel = null;
    /** 上一次刷过英雄信息的英雄 id（0 = 还没刷过），用于避免重复加载同一张头像、挡住受伤/回血触发的空跑 */
    private heroInfoHeroId = 0;

    /**
     * 「英雄属性详情」浮层（**节点是预制件里作者摆好的** `hero_properties`，组件在本 HUD 的 `onInit` 里挂上去）。
     * 开关由本 HUD 自己翻（点头像切换），不是响应式状态 —— 见 `toggleHeroProperties`。
     */
    private propsPanel: HeroPropertiesPanel = null;
    /** 宿主注入的「取一份英雄属性快照」动作（属性真源在英雄实体里，只有场景拿得到） */
    private propsSnapshot: (() => HeroPropertiesVM | null) = null;
    /** 头像节点（点击入口；存起来是为了 `onDispose` 里成对摘监听） */
    private headBtnNode: Node = null;

    /** 宿主注入的「退出战斗」动作（场景在 onLoad 里 provide，所以 onInit 里注入得到） */
    private exitBattle: () => void = null;
    /**
     * 宿主注入的**游戏规则说明门面**（`HelpPanelVM`）：本 HUD 只翻它的开关 + 按它写节点 active。
     * 面板节点（`help_panel`）在本 HUD 名下，但**开着的状态由宿主持有** —— 宿主读它冻结本局
     * （全屏面板挡着战场，不暂停的话读完规则回来已经被打死了）。
     */
    private helpVM: HelpPanelVM = null;
    /** 规则说明面板组件（节点来自预制件，组件运行时挂；见 `ensureRulesPanel`） */
    private helpPanel: HelpPanel = null;
    /** 问号按钮节点（存起来是为了 `onDispose` 里成对摘监听） */
    private helpBtnNode: Node = null;
    /** 宿主注入的**选英雄功能门面**：HUD 只读它的 `panelVisible` 写面板节点 active、按钮只翻这个开关 */
    private heroSelect: HeroSelectVM = null;
    /** 宿主注入的**Buff 商店功能门面**：同上（面板节点在本 HUD 下 → active 由本 HUD 写） */
    private buffShop: BuffShopVM = null;
    /**
     * 宿主注入的**局内掉落 Buff 小背包门面**（6 个格子的内容 / 空格数）。
     * 节点与格子组件都在本 HUD 子树里 → 面板自己 inject 了一份；HUD 存这一份只为**飘字时读道具名**。
     */
    private itemBag: ItemBagVM = null;
    /** 小背包面板（组件运行时挂到预制件的 `item_bags` 节点上；见 `setupItemBag`） */
    private itemBagPanel: ItemBagPanel = null;
    /** 状态栏面板（组件运行时挂到预制件的 `buff_status` 节点上；见 `setupStatusBar`） */
    private statusBarPanel: StatusBarPanel = null;
    /** 宿主注入的**技能槽功能门面**：格子组件自己 inject 了一份；HUD 读它只为弹详情面板 */
    private skillSlotStates: SkillSlotsVM = null;
    /** 宿主注入的**Boss 调度门面**：本 HUD 只读它渲染 `bosses` 三个条目；点击向上发 `BossDeploy` */
    private bossScheduler: BossSchedulerVM = null;
    /** `bosses` 三个条目的运行时节点缓存（`setupBossEntries` 里按名字找，不改预制件） */
    private bossEntries: BossEntryRefs[] = [];
    /** 倍速三档的父节点（预制件里的 `speed`；运行时按名字找） */
    private speedRoot: Node = null;
    /** `speed` 下三个档位按钮的运行时引用（选中态只改这两个组件的色，不动节点结构） */
    private speedCells: SpeedCellRefs[] = [];

    /* ===================================================================
     * UIWidget 生命周期（Cocos 原生回调由基类接管，不要重写）
     * =================================================================== */

    protected onInit(): void {
        // 宿主注入：退出动作 + 三个功能门面（放 onInit 拿得到，是因为场景在 onLoad 里 provide）
        this.exitBattle = this.inject<() => void>(StageScopeKeys.ExitBattle, null);
        this.heroSelect = this.inject<HeroSelectVM>(StageScopeKeys.HeroSelect, null);
        this.buffShop = this.inject<BuffShopVM>(StageScopeKeys.BuffShop, null);
        this.itemBag = this.inject<ItemBagVM>(StageScopeKeys.ItemBag, null);
        this.skillSlotStates = this.inject<SkillSlotsVM>(StageScopeKeys.SkillSlots, null);
        this.bossScheduler = this.inject<BossSchedulerVM>(StageScopeKeys.BossScheduler, null);
        this.propsSnapshot = this.inject<() => HeroPropertiesVM | null>(StageScopeKeys.HeroProperties, null);
        this.helpVM = this.inject<HelpPanelVM>(StageScopeKeys.HelpPanel, null);

        // 暂停 / 继续按钮的两种图标（异步加载，点到按钮时才用得到）
        resources.load("textures/common/pause/spriteFrame", SpriteFrame, (err, data) => {
            if (err) { ezgame.error("暂停图标加载失败", err); return; }
            this.pauseSF = data;
        });
        resources.load("textures/common/start/spriteFrame", SpriteFrame, (err, data) => {
            if (err) { ezgame.error("继续图标加载失败", err); return; }
            this.startSF = data;
        });

        // 节点事件：一辈子只绑一次，onDispose 里成对 off
        // （写在 onShow 里会随每次显示叠加重绑，写在宿主 show() 里则要宿主记得摘）
        this.heroSelectBtn?.on(Button.EventType.CLICK, this.openSelectHeroPanel, this);
        this.shopBuffBtn?.on(Button.EventType.CLICK, this.openShopBuffPanel, this);
        this.pauseBtn?.on(Button.EventType.CLICK, this.pauseCheck, this);
        this.exitBtn?.on(Button.EventType.CLICK, this.exit, this);
        this.endBtnNode?.on(Button.EventType.CLICK, this.exit, this);
        // 结算面板的广告位：点击 → 冒泡给宿主（`onEndAdClicked` 只挡连点、发事件，规则不在这里）
        this.end_ad_btn?.on(Button.EventType.CLICK, this.onEndAdClicked, this);

        // 技能栏：给预制件里摆好的 4 个槽位节点逐个挂上 SkillSlot（运行时挂，不用改预制件）
        this.setupSkillSlots();

        // Boss 面板：预制件里 `bosses` 下已经摆好三个条目（gold_boss / kill_boss / enimy_guard），
        // 每个都挂了 Button —— 这里只做「找到节点 + 绑点击」，不改预制件
        this.setupBossEntries();

        // 倍速三档：同样是"预制件摆节点、这里找节点 + 绑点击"（节点名与档位值的映射在
        // `BattleSpeedConfig` 一处，改档位只改那张表 + 预制件）
        this.setupSpeedCells();

        // 长按技能槽 → 弹详情面板；松手 → 收起（面板节点在 HUD 名下 → 由 HUD 写它的显隐）
        // ⚠ 这两行必须排在「挂面板组件」**之前**：面板初始化万一抛异常，也不会把事件订阅一起吞掉
        this.scope.on(StageScopeEvents.SkillDetailRequested, this.onSkillDetailRequested, this);
        this.scope.on(StageScopeEvents.SkillDetailDismissed, this.hideSkillDetail, this);

        // 详情面板：节点由预制件提供（`skill_details`），这里只把组件挂上去并**立刻收起** ——
        // 预制件里该节点是 active 的（作者要看到它才好摆位），不收起来开局就顶着一块示例文案
        this.ensureDetailPanel();
        this.hideSkillDetail();

        // 英雄属性浮层：同样"节点来自预制件、组件运行时挂"，绑头像点击（点一下开、再点一下关）
        this.setupHeroProperties();

        // 游戏规则说明：节点来自预制件（`help_panel`）+ 问号按钮（`ctl/help`），
        // 开关状态在宿主 provide 的门面上 → 这里只"翻开关"，节点显隐统一由 refreshHelpPanel 写
        this.setupHelpPanel();

        // 局内掉落 Buff 小背包：节点来自预制件（`item_bags`），组件运行时挂
        this.setupItemBag();

        // 状态栏（英雄头像下方那一行）：节点来自预制件（`buff_status`），组件运行时挂
        this.setupStatusBar();

        // watcher 全部交给 scope：隐藏时随 scope 暂停，销毁时自动回收（不再手写 watchHandles 数组）
        if (this.heroSelect) {
            this.scope.watch(() => this.heroSelect.panelVisible.value, () => this.refreshHeroSelectPanel());
        } else {
            ezgame.warn("View_Game_Stage 没注入到 HeroSelect 门面（不在 Scene_Game_Stage 子树下？），选英雄面板不会自动显隐");
        }
        if (this.buffShop) {
            this.scope.watch(() => this.buffShop.panelVisible.value, () => this.refreshBuffShopPanel());
        } else {
            ezgame.warn("View_Game_Stage 没注入到 BuffShop 门面（不在 Scene_Game_Stage 子树下？），Buff 商店面板不会自动显隐");
        }
        if (this.helpVM) {
            this.scope.watch(() => this.helpVM.visible.value, () => this.refreshHelpPanel());
        } else {
            ezgame.warn("View_Game_Stage 没注入到 HelpPanel 门面（不在 Scene_Game_Stage 子树下？），规则说明面板不会自动显隐");
        }
        // HP / 最大生命 任意变化都刷新血条与数字（合并原来重复的两个 watch）
        this.scope.watch(
            [() => this.battleStore.hp, () => this.battleStore.maxHp],
            () => this.refreshHp(),
        );
        this.scope.watch(() => this.battleStore.gold, () => this.refreshGold());
        this.scope.watch(() => this.battleStore.killPoints, () => this.refreshKills());
        // 局内英雄等级 / 经验（升级 → 属性成长，HUD 同步）
        this.scope.watch(
            [() => this.battleStore.level, () => this.battleStore.exp, () => this.battleStore.expToNext],
            () => this.refreshLevel(),
        );
        // 本局难度（难度选择弹窗决定，场景换局时写；HUD 只读）
        this.scope.watch(() => this.battleStore.difficulty, () => this.refreshDifficulty());
        // 本局模式（主界面模式卡决定，场景换局时写；HUD 只读）
        this.scope.watch(() => this.battleStore.mode, () => this.refreshMode());
        // 倍速档位（真源 = store 的 `speedMul`，场景在 update 里读它缩放整局）
        this.scope.watch(() => this.battleStore.speedMul, () => this.refreshSpeed());
        // 阶段 / 剩余时间：单一来源是 store（场景写），取代 BATTLE_REMAINTIME 事件推送
        this.scope.watch(
            [() => this.battleStore.phase, () => this.battleStore.phaseRemainTime],
            () => this.updateProgress(),
        );
        // 英雄信息（头像 / 技能栏）：真源是「本局出战英雄」这个投影 heroId / heroSkills，
        // 场景在 selectHero → syncHeroToStore 里写；升级 / 学会新技能也会改 heroSkills
        this.scope.watch(
            [() => this.battleStore.heroId, () => this.battleStore.heroSkills],
            () => this.refreshHeroInfo(),
        );
        // Boss 面板：门面里的 `slots` 已经是**整秒粒度**的快照（功能类只在真的变了时才换新数组），
        // 所以这里直接 watch 数组引用即可，不会每帧重画
        if (this.bossScheduler) {
            this.scope.watch(() => this.bossScheduler.slots.value, () => this.refreshBosses());
        } else {
            ezgame.warn("View_Game_Stage 没注入到 BossScheduler 门面（不在 Scene_Game_Stage 子树下？），Boss 面板不会刷新");
        }
        // 属性面板**开着**时，这几样一变就重取一份快照（面板没开时整条 watch 只是空转，一次比较而已）：
        //   heroId   换英雄       level 升级（属性成长）    relicBag 抽到遗物（属性加成）
        //   heroSkills 学会技能   killPoints 买击杀商店 Buff（**买 Buff 必扣击杀数**，属性也是它改的）
        // ⚠ 属性本身没有响应式投影（真源在英雄实体的 AttributeSystem 里），所以只能按"会改属性的几个入口"来刷；
        //   漏掉的那一类（比如某种 Direct 改属性的脚本）要等关掉再开面板才会看到新值。
        this.scope.watch(
            [
                () => this.battleStore.heroId,
                () => this.battleStore.level,
                () => this.battleStore.relicBag,
                () => this.battleStore.heroSkills,
                () => this.battleStore.killPoints,
            ],
            () => this.refreshHeroProperties(),
        );
    }

    /**
     * 每次显示（= 开新一局）：按当前 store 状态无条件刷一遍。
     * 子组件的 onShow 早于宿主 `Scene_Game_Stage.show()` 里的 resetRun，随后的 store 写入会再触发各个 watcher；
     * 而**非响应式**的部分（结算面板显隐）没有被 watch 感知，必须在这里显式复位。
     */
    protected onShow(): void {
        if (this.endNode) this.endNode.active = false; // 收起上一局的结算面板
        // 详情面板是"按住才看"的临时浮层：上一局/上一次没收干净就在这里兜一次
        this.hideSkillDetail();
        // 属性浮层同理：上一局开着没关的，新一局开局先收起（数据也换人了）
        this.hideHeroProperties();
        // 规则说明是全屏面板：上一局开着没关的，新一局开局先收起（开关在宿主持有 → 关它即收起；
        // 宿主 resetRun 里也会关一次，两条路都幂等）
        this.closeHelpPanel();
        // 头像指纹复位，让本局重新按当前英雄刷一次（heroId 在换局时会先归 0，指纹不复位会漏刷）
        this.heroInfoHeroId = 0;
        this.refreshAll();
    }

    protected onDispose(): void {
        // 节点事件成对摘除（watcher / scope 局部事件由基类的 scope.dispose 统一回收）
        // ⚠ 这些按钮都是本 HUD 节点的**后代**：销毁流程里它们先被销毁 + `_destruct()`（字段清空），
        //   直接 `.off()` 会抛 "Cannot read properties of null (reading 'off')" 并堵死引擎销毁队列，
        //   所以一律走 offNodeEvent（已销毁节点会被跳过，监听随节点一起消亡、不会泄漏）
        this.offNodeEvent(this.heroSelectBtn, Button.EventType.CLICK, this.openSelectHeroPanel, this);
        this.offNodeEvent(this.shopBuffBtn, Button.EventType.CLICK, this.openShopBuffPanel, this);
        this.offNodeEvent(this.pauseBtn, Button.EventType.CLICK, this.pauseCheck, this);
        this.offNodeEvent(this.exitBtn, Button.EventType.CLICK, this.exit, this);
        this.offNodeEvent(this.endBtnNode, Button.EventType.CLICK, this.exit, this);
        this.offNodeEvent(this.end_ad_btn, Button.EventType.CLICK, this.onEndAdClicked, this);
        // 问号按钮（规则说明）：同样是本 HUD 的后代节点 → 走 offNodeEvent
        this.offNodeEvent(this.helpBtnNode, Button.EventType.CLICK, this.toggleHelpPanel, this);
        // Boss 条目的点击回调是逐条目现造的闭包，没法用方法名 off —— 存在 bossEntries 里成对摘
        for (const e of this.bossEntries) {
            this.offNodeEvent(e.node, Button.EventType.CLICK, e.onClick, this);
        }
        this.bossEntries = [];
        // 倍速三档的点击回调同样是逐档现造的闭包 → 存起来成对摘
        for (const c of this.speedCells) {
            this.offNodeEvent(c.node, Button.EventType.CLICK, c.onClick, this);
        }
        this.speedCells = [];
        // 头像的点击（开/关属性浮层）：头像本身是本 HUD 的子节点，同样走 offNodeEvent
        this.offNodeEvent(this.headBtnNode, Button.EventType.CLICK, this.toggleHeroProperties, this);
    }

    /* ===================================================================
     * 刷新（只读 store → 写 UI；onShow 与各个 watcher 的公共出口）
     * =================================================================== */

    private refreshAll(): void {
        // 打击反馈 F10：换局先把弹跳清干净（上一局弹到一半的节点别把缩放带进新一局）
        this.resetPunches();
        this.refreshHeroSelectPanel();
        this.refreshBuffShopPanel();
        this.refreshHelpPanel();
        this.refreshHeroInfo();
        this.refreshHp();
        this.refreshGold();
        this.refreshKills();
        this.refreshLevel();
        this.refreshDifficulty();
        this.refreshMode();
        this.refreshSpeed();
        this.updateProgress();
        this.refreshBosses();
    }

    private refreshHeroSelectPanel(): void {
        if (!this.heroSelectPanel) return;
        const visible = !!(this.heroSelect && this.heroSelect.panelVisible.value);
        this.heroSelectPanel.active = visible;
        // 详情面板常驻且渲染层级在面板之上 → 别的面板一开就把它收掉，别压住人家
        if (visible) this.hideSkillDetail();
        if (visible) this.hideHeroProperties();
    }

    /** Buff 商店面板显隐：状态是 `BuffShop.panelVisible`（宿主 provide 的门面），节点在本 HUD 下 → 由本 HUD 写 */
    private refreshBuffShopPanel(): void {
        if (!this.shopBuffPanel) return;
        const visible = !!(this.buffShop && this.buffShop.panelVisible.value);
        this.shopBuffPanel.active = visible;
        if (visible) this.hideSkillDetail();
        if (visible) this.hideHeroProperties();
    }

    /* ===================================================================
     * 游戏规则说明（HUD 左下角 `ctl/help` 那颗问号 + 预制件里的 `help_panel`）
     *
     * ── 节点契约（预制件已摆好，**本 HUD 不改预制件结构**）──
     *   ctl/help                 问号按钮（与 pause / exit 同一列，Layout 自动排位）
     *   help_panel               全屏面板（结构见 `HelpPanel` 的文件头）
     *
     * ── 三件事分得干干净净 ──
     *   · **写什么**（规则章节与数值）→ `GameRulesConfig.buildGameRules()`（唯一文案真源）
     *   · **怎么画**（建行 / 滚动）→ `HelpPanel`（组件运行时挂到预制件节点上）
     *   · **什么时候开、关** → 宿主 provide 的 `HelpPanelVM`：本 HUD 只"翻开关"，
     *     节点 active 由 `refreshHelpPanel` 统一写（同选英雄 / Buff 商店两块的写法）
     *
     * 为什么开关不放在 HUD 自己手里：面板是全屏的，**开着时必须冻结本局**（否则玩家读规则时
     * 会被怪打死），而"冻结"这件事只有宿主场景能做（`battleStore.panelPaused`）—— 见 `StageScope`。
     * =================================================================== */

    /** 规则说明面板显隐（门面变化 / onShow / 全量刷新都走这里） */
    private refreshHelpPanel(): void {
        const panel = this.ensureRulesPanel();
        if (!panel) return;
        const visible = !!(this.helpVM && this.helpVM.visible.value);
        if (!visible) {
            panel.hide();
            return;
        }
        // 两块浮层与全屏面板不该同时开着（谁开谁把对方收掉）
        this.hideSkillDetail();
        this.hideHeroProperties();
        panel.show(this.battleStore.difficulty);
    }

    /** 绑问号按钮 + 挂面板组件（只在 `onInit` 调一次） */
    private setupHelpPanel(): void {
        const ctl = this.node.getChildByName(CTL_NODE);
        const btn = ctl?.getChildByName(HELP_BTN_NODE) ?? null;
        if (btn) {
            this.helpBtnNode = btn;
            btn.on(Button.EventType.CLICK, this.toggleHelpPanel, this);
        } else {
            ezgame.warn(`[HUD] 预制件里找不到 \`${CTL_NODE}/${HELP_BTN_NODE}\` 节点，点不到游戏规则说明`);
        }
        // 面板组件（`bind()` 里会先把面板收起来，免得开局顶着一块全屏浮层）
        this.ensureRulesPanel();
    }

    /** 规则说明面板（组件运行时挂到预制件的 `help_panel` 节点上，只挂一次） */
    private ensureRulesPanel(): HelpPanel {
        if (this.helpPanel?.isValid) return this.helpPanel;
        // 找不到节点时 `ensureHelpPanel` 会打一条带实际子节点名的 warn（便于对照预制件）
        this.helpPanel = ensureHelpPanel(this.node);
        if (!this.helpPanel) {
            ezgame.warn(`[HUD] 没有可用的规则说明面板（预制件里应有一个名为 ${HELP_PANEL_NODE} 的节点）`);
            return null;
        }
        // 面板只发"关闭请求"，开关状态由本 HUD 翻（面板自己不写 active，见 HelpPanel 的口径 ③）
        this.helpPanel.onRequestClose = () => this.closeHelpPanel();
        return this.helpPanel;
    }

    /**
     * 点问号按钮：开着就关、关着就开。
     * 只翻门面上的开关 —— 面板的显隐由 `refreshHelpPanel`（watcher）统一写。
     */
    toggleHelpPanel(): void {
        if (!this.helpVM) {
            ezgame.warn('[HUD] 没注入到 HelpPanel 门面（不在 Scene_Game_Stage 子树下？），规则说明打不开');
            return;
        }
        if (this.helpVM.visible.value) this.helpVM.close();
        else this.helpVM.open();
    }

    /** 收起规则说明（关闭按钮 / 压暗层 / 换局都走这里；没开时是空操作） */
    closeHelpPanel(): void {
        this.helpVM?.close();
    }

    /**
     * 英雄信息（头像 + 技能栏）—— 「本局出战英雄」的投影（`battleStore.heroId`）：
     *   头像   ← units.json 的 `head_icon`
     *   技能栏 ← **不再由这里渲染**：4 个格子各自的 `SkillSlot` 组件自己 inject `SkillSlots`
     *            （技能 id / 等级 / 锁定）与 `cooldowns`（冷却进度）后响应式刷新，
     *            本 HUD 只负责"把组件挂上去"（见 `setupSkillSlots`）
     *
     * 选英雄（scene.selectHero → syncHeroToStore）/ 学会肉鸽技能 / 技能进化都会走到这里。
     * 图标是异步加载的，所以用**指纹**（heroId）挡住重复 load：
     * watcher 在受伤 / 回血时也可能被触发，不能每次都重新加载。
     */
    private refreshHeroInfo(): void {
        const heroId = this.battleStore.heroId;
        if (!heroId) return; // 还没选英雄：保持预制件原样

        if (heroId === this.heroInfoHeroId) return;
        this.heroInfoHeroId = heroId;

        const cfg = TbRoot.ins.getTbContainer(UnitCfgContainer).getCfgById(heroId);
        if (!cfg) {
            ezgame.error(`[HUD] 未找到英雄配置：${heroId}`);
            return;
        }

        // 头像
        if (cfg.head_icon && cfg.head_icon !== this.headIconPath) {
            this.headIconPath = cfg.head_icon;
            const path = cfg.head_icon;
            this.loadSpriteFrame(path, (sf) => {
                if (this.head_icon) this.head_icon.spriteFrame = sf;
            }, `英雄头像加载失败：${path}`);
        }
    }

    /* ===================================================================
     * 技能栏（4 个 SkillSlot 格子）
     * =================================================================== */

    /**
     * 给预制件 `skills` 下的 4 个槽位节点挂上 `SkillSlot`。
     *
     * ⚠ **运行时挂组件，不改预制件**：槽位节点的结构（根 = 底框 Sprite，子节点 `icon` / `cd_mask` /
     *   `lock`）已经在预制件里摆好了，`SkillSlot` 自己按节点名去找它们，所以这里只要
     *   "挂组件 + 下发下标" 两件事。想改成编辑器摆位，就把 `SkillSlot` 的 3 个子节点拖进它的
     *   `@property`，然后删掉这里的 `addComponent` 即可（其余逻辑不用动）。
     *
     * 槽位数量与 `SkillSlots.SKILL_SLOT_COUNT` 必须一致（多出来的节点不会挂组件 = 恒为空框）。
     */
    private setupSkillSlots(): void {
        this.skillSlots = [];
        if (!this.weapons_node) {
            ezgame.warn('[HUD] 没拖 weapons_node（技能栏父节点），技能栏不会显示技能');
            return;
        }
        this.weapons_node.children.forEach((node, index) => {
            const slot = node.getComponent(SkillSlot) ?? node.addComponent(SkillSlot);
            // ⚠ `addComponent` 可能**当场就跑完 onInit**（那时 slotIndex 还是 -1，组件会按兄弟顺序自推），
            //   所以这里显式下发下标后要再刷一次，首帧的表现才跟下标一致
            const changed = slot.slotIndex !== index;
            slot.slotIndex = index;
            if (changed) slot.refresh();
            this.skillSlots.push(slot);
        });
        if (!this.skillSlots.length) {
            ezgame.warn('[HUD] 技能栏父节点下没有子节点，技能栏是空的');
        }
    }

    /* ===================================================================
     * Boss 面板（预制件里的 `bosses` 子树）
     *
     * ── 节点契约（预制件已摆好，**本 HUD 不改预制件**）──
     *   bosses/                        容器（Widget + Layout）
     *     ├─ gold_boss/    [Sprite + Button]   金币怪
     *     ├─ kill_boss/    [Sprite + Button]   击杀怪
     *     └─ enimy_guard/  [Sprite + Button]   敌方守卫
     *   每个条目下：
     *     · name       Label            类型名（预制件里已写好，本 HUD **不覆写**，留给策划改文案）
     *     · time       Sprite（底圈）
     *       └─ value   Label            倒计时数字
     *     · count*     Label            数量（节点名带序号后缀，如 `count` / `count-001`，按前缀找）
     *
     * ── 一栏两用（预制件只给了 `time/value` 一个位置）──
     *   场上有这只 Boss → 显示**最快到期的那只的剩余限时**（并把数字染成警示红）
     *   场上没有        → 显示 **CD 充能倒计时**（白字）
     *   两者都没有（守卫无 CD 且没放出去）→ 把 `time` 整块收起
     *
     * ── 职责边界 ──
     *   **能不能点由门面的 `canDeploy` 说了算**（判据在 `BossScheduler` 里只有一份），
     *   本 HUD 只负责画（写字 + 染色 + 设 `Button.interactable`）与上报点击。
     * =================================================================== */

    /**
     * 按名字找到 `bosses` 三个条目并绑上点击。
     *
     * ⚠ 用自写的 DFS 找节点，**不用 `cc.find`** —— 它遇到节点名里含 `/` 的情况会找不到；
     *   也不假设 `bosses` 挂在哪一层（策划挪位置不用改代码）。
     */
    private setupBossEntries(): void {
        this.bossEntries = [];
        const root = findNodeByName(this.node, 'bosses');
        if (!root) {
            ezgame.warn('[HUD] 预制件里找不到 `bosses` 节点，Boss 面板不会显示');
            return;
        }
        for (const [key, nodeName] of BOSS_NODE_NAMES) {
            const node = root.getChildByName(nodeName);
            if (!node) {
                ezgame.warn(`[HUD] \`bosses\` 下找不到 \`${nodeName}\`，该 Boss 条目不会显示`);
                continue;
            }
            const timeNode = node.getChildByName('time');
            const value = timeNode ? (timeNode.getChildByName('value')?.getComponent(Label) ?? null) : null;
            // 数量节点的名字带序号后缀（`count` / `count-001`）→ 按前缀找，不然第二个条目永远找不到
            let count: Label = null;
            for (const c of node.children) {
                if (c.name.indexOf('count') === 0) { count = c.getComponent(Label); break; }
            }
            if (!value || !count) {
                ezgame.warn(`[HUD] \`${nodeName}\` 的节点契约不完整（time/value=${!!value}, count=${!!count}），跳过该条目`);
                continue;
            }
            const onClick = () => this.onBossClicked(key);
            node.on(Button.EventType.CLICK, onClick, this);
            this.bossEntries.push({ key, node, value, count, timeNode, onClick });
        }
        if (!this.bossEntries.length) ezgame.warn('[HUD] Boss 面板一个条目都没接上');
        this.refreshBosses();
    }

    /** 把门面的快照画到三个条目上（onShow / 门面变化 / watcher 的公共出口） */
    private refreshBosses(): void {
        if (!this.bossEntries.length) return;
        const rows: BossSlotVM[] = this.bossScheduler ? this.bossScheduler.slots.value : [];
        for (const e of this.bossEntries) {
            const row = rows.find((r) => r.key === e.key);
            if (!row) continue;

            if (e.timeNode) e.timeNode.active = row.showTime;
            if (e.value) {
                e.value.string = row.showTime ? `${row.timeLeft}` : '';
                // 限时 = 警示红（催玩家去处理）；CD = 白（等就行）
                e.value.color = (row.showingLimit ? BOSS_TIME_LIMIT_COLOR : BOSS_TIME_CD_COLOR).clone();
            }
            if (e.count) {
                // 库存 = 还能点几次（"cd 好后数量 +1，点击后数量 −1"）
                e.count.string = `x${row.stock}`;
                e.count.color = (row.stock > 0 ? BOSS_COUNT_READY_COLOR : BOSS_COUNT_IDLE_COLOR).clone();
            }
            // 点不动时把按钮置灰（判据与调度器同一份；置灰后也不会再触发点击）
            const btn = e.node.getComponent(Button);
            if (btn) btn.interactable = row.canDeploy;
        }
    }

    /**
     * 点了某个 Boss 条目 → **只往上发键**，能不能放由宿主转交的 `BossScheduler.deploy` 判。
     * （被拒的三种情形：库存 0 / 场上已满 / 配表缺单位 —— 都在那边打日志并飘提示）
     */
    private onBossClicked(key: BossSlotKey): void {
        this.scope.emit(StageScopeEvents.BossDeploy, key);
    }

    /**
     * 长按某个技能槽 → 弹详情面板。
     * 面板位置是**预制件里摆好的**（`skill_details` 就在技能栏上方居中），不按长按的槽挪位置。
     *
     * 每一步的早退都留了日志：长按没反应时，控制台能直接指出断在哪一段
     * （没日志 = 事件没到 HUD；日志说"槽里没技能" = 槽是空的；说"找不到节点" = 预制件结构）。
     */
    private onSkillDetailRequested(index: number): void {
        if (!this.skillSlotStates) {
            ezgame.warn(`[HUD] 收到槽 ${index} 的长按，但没注入到 SkillSlots 门面，取不到技能 id`);
            return;
        }
        const state = this.skillSlotStates.slotAt(index);
        if (!state || state.skillId <= 0) {
            ezgame.warn(`[HUD] 收到槽 ${index} 的长按，但该槽没有技能（skillId=${state?.skillId ?? 'null'}），不弹详情`);
            return;
        }

        const panel = this.ensureDetailPanel();
        if (!panel) return; // 找不到面板节点时 ensureSkillDetailPanel 里已经报过具体原因
        // 两块浮层在版面上有一段重叠（属性板下沿压到技能详情上沿）→ 谁弹谁把对方收掉
        this.hideHeroProperties();
        panel.show(state.skillId, state.level);
    }

    /**
     * 收起详情面板。
     * 松手**不**收起（面板要能读完）→ 收起的入口是：短按任意技能槽（走 `SkillDetailDismissed` 事件）、
     * 在面板上点一下（面板自己处理）、别的面板打开（本 HUD 与场景各调一次）、本 HUD 隐藏（`onShow`）。
     */
    hideSkillDetail(): void {
        this.detailPanel?.hide();
    }

    /** 详情面板（组件运行时挂到预制件的 `skill_details` 节点上，只挂一次） */
    private ensureDetailPanel(): SkillDetailPanel {
        if (this.detailPanel?.isValid) return this.detailPanel;
        // 找不到节点时 `ensureSkillDetailPanel` 会打一条带实际子节点名的 warn（便于对照预制件）
        this.detailPanel = ensureSkillDetailPanel(this.node);
        if (!this.detailPanel) {
            ezgame.warn(`[HUD] 没有可用的详情面板（预制件里应有一个名为 ${SKILL_DETAILS_NODE} 的节点）`);
        }
        return this.detailPanel;
    }

    /* ===================================================================
     * 英雄属性浮层（预制件里的 `hero_properties` 子树）
     *
     * ── 节点契约（预制件已摆好，**本 HUD 不改预制件**）──
     *   hero_properties/            白底圆角面板（520×400，横向居中；BlockInputEvents 挡住"点面板改攻击目标"）
     *     ├─ head/icon              英雄头像（格底是身份色圆角，`icon` 是头像碎图）
     *     ├─ name / lv              英雄名 / `Lv.N`（N = 局内等级）
     *     ├─ line_top               1px 分隔线
     *     ├─ attr_1 … attr_N        一行一种属性（`name` 属性名 + `value` 当前值）
     *     ├─ line_bottom            1px 分隔线
     *     └─ hint                   操作提示（「再点英雄头像收起」）
     *
     * ── 四件事分得干干净净 ──
     *   · **哪几行、每行是什么值** → `buildHeroPropertiesVM`（宿主 provide 的 `HeroProperties` 动作，读英雄实体）
     *   · **怎么画**（标签写字符串 / 行多了收起） → `HeroPropertiesPanel`
     *   · **什么时候开、什么时候关** → 本 HUD（点头像切换，非响应式；`onShow` / 别的浮层打开时收起）
     *   · **节点在哪、长什么样** → 预制件（代码不建行、不摆位）
     *
     * 为什么不给头像挂 `@property`:头像就是本 HUD 的直接子节点 `head`（同 `bosses` 的处理），
     * 按名字找一次即可 —— 少一个要拖的引用，也少一处"拖错了但没人发现"。
     * =================================================================== */

    /** 找头像并绑点击 + 把面板组件挂上去（只在 `onInit` 调一次） */
    private setupHeroProperties(): void {
        const head = this.node.getChildByName(HEAD_NODE);
        if (head) {
            this.headBtnNode = head;
            head.on(Button.EventType.CLICK, this.toggleHeroProperties, this);
        } else {
            ezgame.warn(`[HUD] 预制件里找不到 \`${HEAD_NODE}\` 节点，点英雄头像不会弹属性面板`);
        }
        // 面板节点 + 组件（组件自己会先收起面板，见 HeroPropertiesPanel.bind）
        this.ensureHeroPropertiesPanel();
    }

    /** 属性浮层（组件运行时挂到预制件的 `hero_properties` 节点上，只挂一次） */
    private ensureHeroPropertiesPanel(): HeroPropertiesPanel {
        if (this.propsPanel?.isValid) return this.propsPanel;
        // 找不到节点时 `ensureHeroPropertiesPanel` 会打一条带实际子节点名的 warn（便于对照预制件）
        this.propsPanel = ensureHeroPropertiesPanel(this.node);
        if (!this.propsPanel) {
            ezgame.warn(`[HUD] 没有可用的英雄属性面板（预制件里应有一个名为 ${HERO_PROPERTIES_NODE} 的节点）`);
        }
        return this.propsPanel;
    }

    /**
     * 点英雄头像：开着就收起，关着就取一份当前属性的快照打开。
     *
     * 三种"打不开"的情形都在这里拦掉并说明原因（**宁可不开，也不要开一块空板子**）：
     *   ① 预制件里没有 `hero_properties` 节点 → `ensure*` 已经报过名字了；
     *   ② 没注入到快照动作（HUD 不在 `Scene_Game_Stage` 子树下）；
     *   ③ 还没有出战英雄（`snapshot()` 回 null：开局选英雄之前点了一下头像）。
     */
    toggleHeroProperties(): void {
        const panel = this.ensureHeroPropertiesPanel();
        if (!panel) return;

        if (panel.visible) {
            panel.hide();
            return;
        }
        if (!this.propsSnapshot) {
            ezgame.warn('[HUD] 没注入到 HeroProperties 快照动作（不在 Scene_Game_Stage 子树下？），属性面板打不开');
            return;
        }
        const vm = this.propsSnapshot();
        if (!vm) {
            ezgame.warn('[HUD] 还没有出战英雄（或属性系统没就绪），属性面板不打开');
            return;
        }
        // 与技能详情浮层互斥（两者在版面上有一段重叠）
        this.hideSkillDetail();
        // 头像用 HUD 已经加载好的那一张（面板不重复 load 同一张图；还没加载完就保留预制件里的占位图）
        panel.show(vm, this.head_icon?.spriteFrame ?? null);
    }

    /**
     * 面板**开着**时重新取一份快照（等级 / 遗物 / 技能 / 击杀数变了 → 属性也变了）。
     * 没开就是一次空转（只比较几个值），所以挂在 watcher 上没有成本焦虑。
     */
    private refreshHeroProperties(): void {
        if (!this.propsPanel?.visible || !this.propsSnapshot) return;
        const vm = this.propsSnapshot();
        if (vm) this.propsPanel.show(vm, this.head_icon?.spriteFrame ?? null);
    }

    /** 收起属性浮层（本 HUD 内部的公共出口：换局 / 别的浮层打开 / 结算时调；没开时是空操作） */
    hideHeroProperties(): void {
        this.propsPanel?.hide();
    }

    /* ===================================================================
     * 局内掉落 Buff 小背包（预制件里的 `item_bags` 子树）
     *
     * ── 节点契约（预制件已摆好，**本 HUD 不改预制件结构**）──
     *   item_bags/
     *     ├─ toggle/           收纳按钮（常显）：图标 + 箭头 + `已装/格数`
     *     └─ content/          展开区（**默认收起**）
     *          ├─ cells/cell_1…cell_6   6 个格子（`ItemBagCell` 运行时挂）
     *          └─ tip/                  单击某格时的说明浮层（名字 / 效果 / 操作提示）
     *
     * ── 分工 ──
     *   · **格子内容 / 能不能用** → `ItemBag`（宿主 provide 的门面，面板 inject）
     *   · **展开收起 / 单击看描述 / 双击使用 / 落格弹跳** → `ItemBagPanel`（本 HUD 挂上去）
     *   · **飘字**（获得 / 用掉 / 满格丢弃）→ 本 HUD（只有它拿得到 HUD 节点）
     *   · **什么时候掉、掉的是哪一件** → 宿主 `Scene_Game_Stage`（它调 `drop`，再把结果丢回来）
     * =================================================================== */

    /** 把 `ItemBagPanel` 挂到预制件的 `item_bags` 上（只在 `onInit` 调一次） */
    private setupItemBag(): void {
        const node = this.node.getChildByName(ITEM_BAGS_NODE);
        if (!node) {
            ezgame.warn(`[HUD] 预制件里找不到 \`${ITEM_BAGS_NODE}\` 节点，掉落 Buff 背包不会显示`);
            return;
        }
        this.itemBagPanel = node.getComponent(ItemBagPanel) ?? node.addComponent(ItemBagPanel);
        if (!this.itemBag) {
            ezgame.warn('[HUD] 没注入到 ItemBag 门面（不在 Scene_Game_Stage 子树下？），背包里的道具名飘不出来');
        }
    }

    /**
     * ===================================================================
     * 状态栏（`buff_status`：英雄头像 + HP/EXP 条下方那一行）
     *
     *   ── 节点契约（预制件里已摆好，本 HUD 不改结构）──
     *     buff_status/            12 格（`buff` + `buff-001` … `buff-011`），每格 Sprite + Button
     *       · 前 10 格在本组件里当状态格用（运行期加 `text` 子节点画短标与秒数）
     *       · 第 11/12 格**显式收起**（第二行会压到 `item_bags` 展开区，见 `StatusBarPanel`）
     *
     *   ── 分工 ──
     *     · **显示什么 / 排序 / 同键合并** → `battle/StatusBar.ts`（宿主 provide 的门面）
     *     · **怎么画（色块 + 短标 + 秒数 · 快没了闪烁）** → `StatusBarPanel`（本 HUD 挂上去）
     *     · **状态真源** → 英雄实体身上的 Modifier 实例（面板一个字都不缓存）
     * ===================================================================
     */

    /** 把 `StatusBarPanel` 挂到预制件的 `buff_status` 上（只在 `onInit` 调一次） */
    private setupStatusBar(): void {
        const node = this.node.getChildByName(BUFF_STATUS_NODE);
        if (!node) {
            ezgame.warn(`[HUD] 预制件里找不到 \`${BUFF_STATUS_NODE}\` 节点，状态栏不会显示`);
            return;
        }
        this.statusBarPanel = node.getComponent(StatusBarPanel) ?? node.addComponent(StatusBarPanel);
    }

    /**
     * **阶段 Boss 掉了一件道具**（宿主在 `OnDeath` 的掉落钩子里调）：
     * 图标从掉落点飞进背包 + 飘一行「获得「xxx」」。
     *
     * @param cfgName 道具名（宿主从掉落结果里带过来 —— 它是**唯一算得出**这件是什么的一方）
     * @param slot    落进第几格
     * @param fromWorld 掉落点的 **UI 世界坐标**；拿不到就传 null（面板会退化成从按钮上方飞入）
     */
    onBattleItemDropped(cfgName: string, slot: number, fromWorld: Vec3 | null): void {
        if (cfgName) this.showItemFloatText(`获得「${cfgName}」`);
        this.itemBagPanel?.flyIn(fromWorld, slot);
    }

    /**
     * **背包满了、这次掉落作废**（用户口径：必须说清是哪一件被丢掉了 ——
     * 只提示"背包已满"的话，玩家会以为道具"打到了但没进包"是个 bug）。
     */
    onBattleItemRejected(cfgName: string): void {
        this.showItemFloatText(`背包已满，「${cfgName || '道具'}」已自动丢弃`);
    }

    /** **用掉了一件道具**（宿主转交 `ItemBag.use` 成功之后调）：飘「使用「xxx」（N 秒）」 */
    onBattleItemUsed(cfgName: string, seconds: number): void {
        const tail = seconds > 0 ? `（${seconds} 秒）` : '';
        this.showItemFloatText(`使用「${cfgName}」${tail}`);
    }

    /** 背包相关的飘字统一挂在**收纳按钮**正上方（收起态下贴着屏幕左下角，视线不用挪） */
    private showItemFloatText(message: string): void {
        showFloatText(this.node, message, this.itemBagPanel?.anchorNode ?? this.weapons_node, ITEM_BAG_FLOAT_OFFSET_Y);
    }

    /**
     * 飘字提示（贴在技能栏上方）。
     * 需求：「技能槽都锁定时选中技能 → 飘字提示」；场景通过本方法把提示丢给 UI（节点在 HUD 名下 → HUD 写）。
     */
    showFloatText(message: string): void {
        showFloatText(this.node, message, this.weapons_node, 90);
    }

    /**
     * 加载 `path/spriteFrame`（resources 内置分包，与 HeroItem 的头像同一套约定）。
     * 失败只报错、不改动节点，避免把已有图刷成空白。
     */
    private loadSpriteFrame(path: string, onLoaded: (sf: SpriteFrame) => void, errMsg: string): void {
        if (!path) return;
        resources.load(`${path}/spriteFrame`, SpriteFrame, (err, sf) => {
            if (err || !sf) {
                ezgame.error(errMsg, err);
                return;
            }
            onLoaded(sf);
        });
    }

    private refreshHp(): void {
        const hp = Math.trunc(this.battleStore.hp);
        const maxHp = this.battleStore.maxHp;
        // 大数值走缩写口径（`formatNumber`：≥1000 → 1.2k / ≥1万 → 1.2万）——
        // 后期 `12000/12000` 这种 11 个字符会把血条上的那格顶爆（同金币/击杀数）
        if (this.hp_value) this.hp_value.string = `${formatNumber(hp)}/${formatNumber(maxHp)}`;
        if (this.hp_bar) this.hp_bar.progress = maxHp > 0 ? Math.min(1, this.battleStore.hp / maxHp) : 0;
        // 打击反馈 F10：自己的血量变化也弹一下（挨打是最该被看见的信息）
        this.punch(this.hp_value?.node);
    }

    private refreshGold(): void {
        if (this.money_gold_value) this.money_gold_value.string = formatNumber(this.battleStore.gold);
        this.punch(this.money_gold_value?.node);
    }

    private refreshKills(): void {
        // ⚠ 显示的是**击杀数余额**（`killPoints`，击杀商店的货币，买东西会减少），
        //   不是累计击杀数（那是 `kills`，只进结算面板与成就）。
        //   缩写的理由最硬：一局的击杀数收入是**四位数**（≈1500），不缩写就会把「金币」挤走。
        if (this.money_kill_value) this.money_kill_value.string = formatNumber(this.battleStore.killPoints);
        // 打击反馈 F10 + F8 的 HUD 侧：击杀计数弹一下（配合屏幕层的击杀落款）
        this.punch(this.money_kill_value?.node);
    }

    private refreshLevel(): void {
        const { level, exp, expToNext } = this.battleStore;
        if (this.lv_value) this.lv_value.string = `Lv.${level}`;
        if (this.lv__exp_value) this.lv__exp_value.string = `${formatNumber(Math.trunc(exp))}/${formatNumber(expToNext)}`;
        if (this.lv_exp_bar && expToNext > 0) this.lv_exp_bar.progress = Math.min(1, exp / expToNext);
        // 打击反馈 F10：经验每跳一次弹一下；**升级**是更大的事件 → 等级数字也弹
        this.punch(this.lv__exp_value?.node);
        if (this.lastPunchLevel !== level) {
            if (this.lastPunchLevel !== 0) this.punch(this.lv_value?.node);
            this.lastPunchLevel = level;
        }
    }

    /**
     * 左上角信息条的「难度 N」（`info/name`）。
     *
     * ⚠ 这个格子原来是预制件里的**死文案**（写死的「难度 99」，全工程没有任何写入方）——
     *   本局难度是响应式的（`battleStore.difficulty`，场景在 `resetRun` 里按难度弹窗的选择写入），
     *   所以换一档进游戏就会跟着变。想改文案格式就改这一行。
     */
    private refreshDifficulty(): void {
        if (this.info_name) this.info_name.string = `难度 ${this.battleStore.difficulty}`;
    }

    /**
     * 左上角信息条的**模式名**（`info/mode`）—— 与「难度 N」并排的那一格。
     *
     * ⚠ 它原来是预制件里的**死文案**「阶梯模式」，全工程没有写入方（连主界面的「阶段模式」都对不上）。
     *   现在跟 `battleStore.mode`（主界面模式卡选的）走，换模式进游戏就会跟着变。
     */
    private refreshMode(): void {
        if (this.info_mode) this.info_mode.string = gameModeName(this.battleStore.mode);
    }

    /* ===================================================================
     * 倍速（HUD 右侧 `speed` 三档）—— 档位值 / 节点名 / 解锁级在 `BattleSpeedConfig`
     *
     * 分工：**HUD 只写"选哪一档"**（`battleStore.speedMul` + 选中态染色），
     * 整局怎么按这个倍率推进是场景的事（`Scene_Game_Stage.update` 里乘时间源）。
     * 三条口径：
     *   ① 节点由预制件提供、这里只按名字找 + 绑点击（同 `setupBossEntries`，不动预制件结构）；
     *   ② **未解锁整块收起**，而不是摆三个点不动的灰格子 —— 界面上不许出现"点不动又不说为什么"
     *      的按钮，而这一格也没地方挂一行解释（收起是唯一不撒谎的形态）；
     *   ③ 解锁判据是**账号等级**（局外、跨局），每次 `onShow` 重算一次（换局/升级后立刻可见）。
     * =================================================================== */

    /** 倍速三档：按名字找节点、绑点击、缓存引用（`onInit` 调一次） */
    private setupSpeedCells(): void {
        this.speedRoot = findNodeByName(this.node, SPEED_ROOT_NODE);
        if (!this.speedRoot) {
            ezgame.warn(`[HUD] 预制件里没找到倍速节点 ${SPEED_ROOT_NODE}，倍速不可用（结构与 BattleSpeedConfig 对不上？）`);
            return;
        }
        for (const step of BATTLE_SPEED_STEPS) {
            const node = this.speedRoot.getChildByName(step.node);
            if (!node) {
                ezgame.warn(`[HUD] 倍速档位节点 ${SPEED_ROOT_NODE}/${step.node}（${step.label}）缺失，该档点不到`);
                continue;
            }
            const onClick = () => this.battleStore.setSpeed(step.mul);
            node.on(Button.EventType.CLICK, onClick, this);
            this.speedCells.push({
                step,
                node,
                sprite: node.getComponent(Sprite),
                label: node.getChildByName('label')?.getComponent(Label) ?? null,
                onClick,
            });
        }
    }

    /** 倍速整块的显隐（账号等级门槛）+ 三档选中态（`onShow` 与 `speedMul` 的 watcher 都走这里） */
    private refreshSpeed(): void {
        if (!this.speedRoot) return;
        const unlocked = this.isSpeedUnlocked();
        this.speedRoot.active = unlocked;
        if (!unlocked) return;  // 没解锁时连染色都省了（整块不可见）
        const cur = findSpeedStep(this.battleStore.speedMul);
        for (const c of this.speedCells) {
            const on = c.step.mul === cur.mul;
            if (c.sprite) c.sprite.color = on ? SPEED_ON_BG : SPEED_OFF_BG;
            if (c.label) c.label.color = on ? SPEED_ON_TEXT : SPEED_OFF_TEXT;
        }
    }

    /** 倍速解锁判据：**账号等级**（局外）≥ `BattleSpeedConfig` 里的门槛 */
    private isSpeedUnlocked(): boolean {
        const level = DataCenter.ins.playerInfo?.data?.level ?? 1;
        return level >= BATTLE_SPEED_UNLOCK_ACCOUNT_LEVEL;
    }

    /* ===================================================================
     * 打击反馈 B3（F10）：HUD 数值弹跳
     *
     * 「静态数字是最容易被忽略的信息」—— 数字变化时让节点弹一下（1.25× 起手、线性回到 1）。
     * 三条口径：
     *   ① **帧驱动**，不用 tween/定时器（与工程里 HitFlash/HpBar/印痕层同一条纪律：
     *      Cocos 的 tween 与 schedule 在节点被缓存复用时容易残留）；
     *   ② 同一个节点重复触发只**刷新剩余时长**（不叠倍率）—— 连击时金币每 0.3s 跳一次，
     *      叠加会把数字吹成气球；
     *   ③ **收尾必须复位 scale**（否则下一次弹跳从 1.25 起算，越弹越大）。
     * =================================================================== */

    /** 正在弹的 HUD 节点（数据表；节点本身不池化 —— HUD 一辈子都在） */
    private punches: HudPunch[] = [];
    /** 上一次弹过的等级（0 = 还没刷过）：只有**真的升级**才弹等级数字，不是每次加经验都弹 */
    private lastPunchLevel = 0;

    /** 让一个 HUD 节点弹一下（同一节点重复调用只刷新时长；null / 已销毁 = 无操作） */
    private punch(node: Node | null | undefined): void {
        if (!node?.isValid) return;
        const dur = HIT_FEEL_INFO.hudPopMs / 1000;
        if (!(dur > 0)) return;
        for (let i = 0; i < this.punches.length; i++) {
            if (this.punches[i].node === node) {
                this.punches[i].remain = dur;
                return;
            }
        }
        // 上限：HUD 上同时在弹的节点不会超过这么多（存量拒绝，不做淘汰 —— 弹跳不值得为它建池）
        if (this.punches.length >= 8) return;
        this.punches.push({ node, remain: dur, dur });
    }

    /** 清掉全部弹跳并复位缩放（换局 / 全量刷新时调） */
    private resetPunches(): void {
        for (let i = 0; i < this.punches.length; i++) {
            const p = this.punches[i];
            if (p.node?.isValid) p.node.setScale(1, 1, 1);
        }
        this.punches.length = 0;
        this.lastPunchLevel = 0;
    }

    /**
     * 每帧推进弹跳（Cocos 会在组件定义了 `update` 时自动调用；
     * `UIComponent` 基类没有 `update`，所以这里不覆盖任何东西）
     */
    update(dt: number): void {
        if (this.punches.length === 0) return;
        for (let i = this.punches.length - 1; i >= 0; i--) {
            const p = this.punches[i];
            p.remain -= dt;
            if (p.remain > 0 && p.node?.isValid) {
                // 起手最大 → 线性回到 1（"弹一下"，不是"弹几下"：多段回弹在浅底 HUD 上会读成抖动）
                const s = 1 + HIT_FEEL_INFO.hudPopPct * (p.remain / p.dur);
                p.node.setScale(s, s, 1);
                continue;
            }
            if (p.node?.isValid) p.node.setScale(1, 1, 1);
            this.punches.splice(i, 1);
        }
    }

    /** 秒 → `mm:ss`（HUD 倒计时统一格式） */
    private formatTime(seconds: number): string {
        const total = Math.ceil(seconds);
        const minute = Math.floor(total / 60);
        const sec = total % 60;
        return `${minute < 10 ? '0' + minute : minute}:${sec < 10 ? '0' + sec : sec}`;
    }

    /**
     * 阶段进度：0 = 准备中（倒计时，不刷怪）、1~4 = 常规阶段、5 = Boss 阶段。
     * 全部读 `battleStore.phase / phaseRemainTime / phaseTotalTime`（场景每秒写一次），
     * **进度条分母用 phaseTotalTime**（阶段时长真源在 `GameStageConfig.stageTime/bossTime`），
     * 不再在这里写死 300/120 —— 写死过会和场景实际时长不一致，导致进度条永远填不满。
     *
     * ── 两个模式在这里怎么分（2026-11 无尽模式落地）──
     *   · `maxPhase > 0`（阶段模式 = `GameModeRules` 的 `STAGE_COUNT`）：`阶段 N/M`，
     *     最后一格是 Boss 阶段（`stage >= FINAL_BOSS_STAGE` → 只写「Boss」）。
     *   · `maxPhase == 0`（无尽模式）：**不画分母**（写 `阶段 N/0` 是明摆着的谎 ——
     *     那个模式没有"第几阶段 / 共几阶段"这回事），而且**永远不会有 Boss 阶段**
     *     （`modeRules.isFinalBossStage` 恒为 false），所以那一格也不会跳成「Boss」。
     *     判据就是 `maxPhase`，**别在这里再读一次模式 id**（模式的真源在 `GameModeRules`，
     *     界面只该读场景投影过来的数）。
     */
    private updateProgress(): void {
        const stage = this.battleStore.phase;
        const time = this.battleStore.phaseRemainTime;
        const total = this.battleStore.phaseTotalTime;
        const maxPhase = this.battleStore.maxPhase;
        const endless = !(maxPhase > 0);            // 0 / 脏值都按"不画分母"处理
        if (this.progress_time) {
            this.progress_time.node.active = true;
            this.progress_time.string = this.formatTime(time);
        }
        if (stage == 0) {//准备阶段
            if (this.progress_name) this.progress_name.string = "准备中";
            if (this.progress_bar) this.progress_bar.node.active = false;
            return;
        }
        if (this.progress_bar) this.progress_bar.node.active = true;
        // 已过时间 / 总时长（阶段刚切进来时 total 已知，倒计时到 0 时进度条正好填满）
        const ratio = total > 0 ? Math.min(1, Math.max(0, (total - time) / total)) : 0;
        if (endless || stage < FINAL_BOSS_STAGE) {//1~4 常规阶段 / 无尽模式的任意阶段
            if (this.progress_name) {
                this.progress_name.string = endless ? `阶段 ${stage}` : `阶段 ${stage}/${maxPhase}`;
            }
            if (this.progress_bar) this.progress_bar.progress = ratio;
            return;
        }
        //boss阶段
        if (this.progress_name) this.progress_name.string = `Boss`;
        if (this.progress_bar) this.progress_bar.progress = ratio;
    }

    /* ===================================================================
     * 对外接口（宿主 Scene_Game_Stage 调用）
     * =================================================================== */

    /**
     * 战斗结束：弹出结算面板。开新一局时 onShow 会自动收起。
     *
     * 面板上三块内容（节点都是预制件里摆好的 `end` 子树）：
     *   · `end/title`         —— 胜/负（本方法写）
     *   · `end/time`          —— 战斗时长 mm:ss（本方法写）
     *   · `end/reward_content/item` —— **本局结算金币**（`DataCenter.grantRunClearGold` 发的那个数，见
     *     `common/RunClearReward` 的文件头）。发 0 时整格收起。
     *
     * @param victory 胜负 —— 由 `Scene_Game_Stage.endRun(result)` 传入（最终 Boss 被击杀 = 胜；
     *                英雄阵亡 / Boss 阶段超时 = 负），只影响这里的标题文案
     * @param runGold 本局发的**局外金币**（0 = 本局没发 / 已关闭这条产出）
     * @param heroExp 本局发的**通用英雄经验**（0 = 本局没发：只有"基数配成 0"这一种可能）
     * @param elapsed 本局存活秒数（0 = 不写时长那一行）
     * @param adMul   本局结算广告位的**倍率**（宿主 `endRun` 里掷好的，1 = 不画广告位）
     */
    showEnd(victory = false, runGold = 0, heroExp = 0, elapsed = 0, adMul = 1): void {
        if (this.end_title) this.end_title.string = victory ? '战斗胜利' : '战斗失败';
        if (this.end_time) this.end_time.string = elapsed > 0 ? `战斗时长：${View_Game_Stage.mmss(elapsed)}` : '';
        this.endSettleMul = adMul;
        this.endSettleClaimed = false;
        this.endSettlePlaying = false;
        this.showEndReward(runGold, heroExp);
        this.refreshEndAdButton();
        if (this.endNode) this.endNode.active = true;
        // 结算面板是居中的大板子，会和属性浮层叠在一起 → 结算时把属性浮层收掉
        this.hideHeroProperties();
    }

    /**
     * **看完结算广告之后**（宿主回调）—— 成功换总额、失败把按钮放回去。
     *
     * 调用点只有一处：宿主 `Scene_Game_Stage.onSettleAdRequested`（成功 / 失败**两条路都会回**，
     * 否则按钮会永远停在「广告播放中…」—— 玩家看到的是一颗再也点不动的灰按钮）。
     *
     * ⚠ 成功时收到的 `gold` / `exp` 是**总额**（不是差额）—— 面板画的是"这一局最终拿到多少"，
     *   与 `DataCenter` 里已经落库的数逐字相同（差额在数据层补，见 `common/RewardAdBonus` 口径 ③）。
     *
     * @param ok      广告是否看完（false = 中途关掉 / 没接 SDK ⇒ 什么都没发，按钮回到可点）
     * @param gold    翻倍后的**局外金币总额**（`ok = false` 时忽略）
     * @param heroExp 翻倍后的**通用英雄经验总额**（`ok = false` 时忽略）
     * @param mul     本局掷到的倍率（**不重掷**：失败重试还是它，见那份文件头的口径 ②）
     */
    applySettleAdResult(ok: boolean, gold: number, heroExp: number, mul: number): void {
        this.endSettleMul = mul;
        this.endSettlePlaying = false;
        if (ok) {
            this.endSettleClaimed = true;
            this.showEndReward(gold, heroExp);
        }
        this.refreshEndAdButton();
    }

    /**
     * 结算广告位被点了一下：置「播放中」并**冒泡给宿主**（`StageScopeEvents.SettleAdRequested`）。
     *
     * 本方法**不判**能不能看、也**不发奖** —— 那两件事在宿主那一侧（倍率真源 + `settleAdUsed` 闸门 +
     * `DataCenter` 落库）。这里只做三件视图的事：挡住连点、把按钮画成播放中、把事件发出去。
     */
    private onEndAdClicked(): void {
        if (this.endSettleClaimed || this.endSettlePlaying) return;
        if (!RewardAdBonus.isWorthWatching(this.endSettleMul)) {
            // ×1.0 那一档没有额外收益：按钮本来就是灰的（`refreshEndAdButton`），
            // 这里再兜一次是为了"万一可点性没刷上"也不去拉起一条白看的广告
            this.showFloatText('本次倍率没有额外奖励');
            return;
        }
        this.endSettlePlaying = true;
        this.refreshEndAdButton();
        this.scope.emit(StageScopeEvents.SettleAdRequested);
    }

    /**
     * 结算面板的**奖励格**（两格：局外金币 + 通用英雄经验）。
     *
     * 图标一律**运行期 load**（`textures/common/gold` / `textures/common/exp_icon`）——
     * ⚠ 这两个 `icon` 原来挂的是引擎内置的 `default_sprite_splash`（占位白块，
     *   2026-11 已把预制件里那两处 `_spriteFrame` 清成 `null` 并换成这套加载）。
     *   **但代码仍然不许用 `sprite.spriteFrame` 非空来判"要不要加载"**：
     *   那个内置帧是**真值**，判了就等于"金币图标永远不加载、只显示白块" ——
     *   这正是 2026-11 用户口径「奖励的金币要显示金币图标」背后的那个真 bug。
     *   所以这里按**路径**记一次"这张图取过了"，与精灵当前挂着什么彻底解耦。
     *
     * 两格都可能是 0（金币曲线配 0 / 经验基数配 0）→ 那一格整格收起，剩下的**重新居中**：
     * 预制件里的 `reward_content` 是**固定尺寸的容器**（400×100，Layout 类型为 NONE ⇒ 不排版），
     * 所以"一格居中、两格分开"必须由这里写坐标。间距常量见 `END_REWARD_CELL_PITCH`。
     */
    private showEndReward(runGold: number, heroExp: number): void {
        const gold = Math.max(0, Math.floor(runGold) || 0);
        const exp = Math.max(0, Math.floor(heroExp) || 0);

        if (this.end_reward_item) this.end_reward_item.active = gold > 0;
        if (this.end_reward_value) this.end_reward_value.string = gold > 0 ? `+${formatNumber(gold)}` : '';
        if (gold > 0) this.ensureEndIcon(this.end_reward_icon, END_REWARD_ICON_PATH, '[结算] 金币图标加载失败');

        if (this.end_exp_item) this.end_exp_item.active = exp > 0;
        if (this.end_exp_value) this.end_exp_value.string = exp > 0 ? `+${formatNumber(exp)}` : '';
        if (exp > 0) this.ensureEndIcon(this.end_exp_icon, END_EXP_ICON_PATH, '[结算] 英雄经验图标加载失败');

        // 剩下的格子重新居中（0 格 = 两格都收起，什么都不用摆）
        const cells: Node[] = [];
        if (gold > 0 && this.end_reward_item) cells.push(this.end_reward_item);
        if (exp > 0 && this.end_exp_item) cells.push(this.end_exp_item);
        cells.forEach((cell, i) => {
            const x = cells.length <= 1 ? 0 : (i - (cells.length - 1) / 2) * END_REWARD_CELL_PITCH;
            cell.setPosition(x, cell.position.y, cell.position.z);
        });
    }

    /**
     * 结算面板的**广告位**（`end/ad_btn`）。
     *
     * 三个状态都由本方法写（**唯一**写它的地方，别在别处再改它的文案/颜色）：
     *   · **已翻倍**  —— 看完广告了，按钮转灰、文案写最终倍率
     *   · **播放中**  —— 按下到回调回来之间，防止连点拉起第二条广告（`AdMgr` 也会拒，但玩家看到的是"点了没反应"）
     *   · **可点 / 不可点** —— 由倍率决定：`×1.0` 那一档没有额外收益，直接按住（见 `RewardAdBonus` 口径 ①）
     */
    private refreshEndAdButton(): void {
        if (!this.end_ad_btn) return;
        const mulText = RewardAdBonus.format(this.endSettleMul);
        const worth = RewardAdBonus.isWorthWatching(this.endSettleMul);

        let text = END_AD_TEXT.replace('{mul}', mulText);
        let enabled = true;
        if (this.endSettleClaimed) {
            text = END_AD_DONE_TEXT.replace('{mul}', mulText);
            enabled = false;
        } else if (this.endSettlePlaying) {
            text = END_AD_PLAYING_TEXT;
            enabled = false;
        } else if (!worth) {
            enabled = false;
        }

        if (this.end_ad_label) this.end_ad_label.string = text;
        const button = this.end_ad_btn.getComponent(Button);
        if (button) button.interactable = enabled;
        const sprite = this.end_ad_btn.getComponent(Sprite);
        if (sprite) sprite.color = enabled ? END_AD_ENABLED_COLOR : END_AD_DISABLED_COLOR;
    }

    /**
     * 结算奖励格的图标：**按路径各加载一次**，之后复用（`this.endIconLoaded` 记账）。
     * 加载失败只报错、不动节点（否则会把已有图刷成空白，同 `loadSpriteFrame` 的口径）。
     */
    private ensureEndIcon(sprite: Sprite, path: string, errMsg: string): void {
        if (!sprite || !path || this.endIconLoaded.has(path)) return;
        this.endIconLoaded.add(path);   // 先记账再加载：失败也不重试（每帧重试会把控制台刷爆）
        this.loadSpriteFrame(path, (sf) => {
            // ⚠ 回调回来时面板可能已经换了一局 / 被复用 —— 节点还在就刷，不在就算了
            if (sprite.isValid) sprite.spriteFrame = sf;
        }, errMsg);
    }

    /** 秒 → `mm:ss`（结算面板「战斗时长」那一行的格式，与预制件里的占位 `02:35` 同形） */
    private static mmss(sec: number): string {
        const t = Math.max(0, Math.floor(sec) || 0);
        const mm = Math.floor(t / 60);
        const ss = t % 60;
        return `${mm < 10 ? '0' + mm : mm}:${ss < 10 ? '0' + ss : ss}`;
    }

    exit() {
        // 宿主注入的动作优先：精确到本场景，无全局事件名漂移 / 漏 off 的问题；
        // 注入不到时回退旧的全局事件，保证按钮永远可用
        if (this.exitBattle) {
            this.exitBattle()
            return
        }
        EventBus.emit(EventNames.BATTLE_EXIT, null);
    }

    pauseCheck() {
        this.battleStore.togglePause();   // 复用 store 已有方法
        const sprite = this.pauseBtn.getComponent(Sprite);
        if (!sprite) return;              // 空安全
        // 图标还没加载完时不动它（否则会把按钮刷成空白）
        const spriteFrame = this.battleStore.isPaused ? this.startSF : this.pauseSF;
        if (spriteFrame) sprite.spriteFrame = spriteFrame;
    }

    /** 打开选英雄面板：只翻门面上的开关（面板节点显隐由 refreshHeroSelectPanel 统一写） */
    openSelectHeroPanel() {
        if (!this.heroSelect) return;
        this.heroSelect.panelVisible.value = true;
    }

    /** 打开 Buff 商店面板：只翻门面上的开关（面板节点显隐由 refreshBuffShopPanel 统一写） */
    openShopBuffPanel() {
        if (!this.buffShop) return;
        this.buffShop.panelVisible.value = true;
    }
}
