/**
 * StageScope —— **局内战斗页（Scene_Game_Stage 子树）的作用域契约**
 *
 * 这一个文件回答四个问题，看完不用再去翻别的文件：
 *   ① 这一页向下 provide 了**什么**（下面 `StageScopeKeys`，只有 5 条）
 *   ② 每一条的**类型**是什么（直接指向功能类的只读门面 `XxxVM`，类型不再靠注释约定）
 *   ③ 子树向上**通知什么**（`StageScopeEvents`，宿主 `scope.on` 接住后转交给功能类）
 *   ④ 面板节点**在谁名下**（谁持有节点谁写 `active`，见文末「节点归属」表）
 *
 * ── 判据：这个概念属于谁？（不是「现在谁在读」）──
 *   ① **UI 摆放 / 功能页面状态**（面板开关、面板要渲染的候选、界面私有选中态）
 *      → 页面级，由宿主 `provide`（本文件，值是**功能类自己的 ref**）。
 *      判据：**删掉那个控件，这个值还有意义吗？没有 → 页面级**。
 *   ② **局内运行状态**（`level` / `exp` / `enemiesAlive` / `isPaused`）
 *      → 不是页面级：写它的不是 UI 交互，而是游戏规则，场景自己的升级 / 刷怪 / 抽卡 / 暂停逻辑也在读它
 *        （`addBattleExp` 直接拿 `level/exp/expToNext` 算升级）→ 留在 `useBattleStore`。
 *   ③ **战斗真源的响应式投影**（`hp` / `maxHp` / `gold` / `kills` / `phase` / `phaseRemainTime`）
 *      → 只有本界面的 HUD 在读，看起来也像「界面内部数据」，但**它描述的是这一局战斗**（生命周期 = 对局），
 *        而且跨层视图（popup 层结算 / 商店弹窗）`inject` 不到、只能走 store → 留在 `useBattleStore`。
 *
 *   一句话：**属于「界面怎么摆」的 → scope；属于「这一局战斗」的 → store**。
 *
 * ── 铁律：一个功能一个键，provide 的是**功能门面**，不是字段 ──
 *   ⚠ 曾经这里会 provide **19 个裸 `ref`**（4 个功能 × 4~6 条），后果不是"键多"这么表面：
 *     · 面板拿不到"规则"，只能拿"原料" → 「刷新按钮能不能点」这条判据在 3 个面板里各抄了一遍
 *       （逐字相同，注释还写着"判据必须与 XXX 完全一致"），`ShopBuffItem` 把价格/满层口径也重算了一遍；
 *     · 每个消费点都要手写泛型 + `null` 兜底 + `?.`，键与类型的对应关系只存在于注释里。
 *   现在：**每条键的值都是一个功能实例（按只读门面 `XxxVM` 声明类型）**，
 *   面板问对象要规则（`shop.refreshGate()` / `buffShop.nextPriceOf(id)`），规则只有一处。
 *   加一个字段不再需要"改键 + 加 provide + 改 N 个 inject"，只在功能类与用它的那个控件里各写一次。
 *
 * ── 谁 provide ──
 *   宿主 `Scene_Game_Stage`（整棵战斗 UI 子树的宿主），在 `onLoad` 里 provide（必须早于子树 `onInit`）。
 *   值与规则都在功能类里（`game/battle/`：`HeroSelect` / `RelicShop` / `BuffShop` / `SkillSlots`），
 *   场景只做「持节点 + provide 门面 + 转发事件 + 提供平台能力」。
 *
 * 命名约定：`'域:用途'`，日志里一眼能看出是谁的键。
 */

import type { HeroSelectVM } from '../../../../battle/HeroSelect';
import type { RelicShopVM } from '../../../../battle/RelicShop';
import type { BuffShopVM } from '../../../../battle/BuffShop';
import type { SkillSlotsVM } from '../../../../battle/SkillSlots';
import type { BossSchedulerVM } from '../../../../battle/BossScheduler';
import type { ItemBagVM } from '../../../../battle/ItemBag';
import type { ArchetypeTallyVM } from '../../../../battle/ArchetypeTally';
import type { StatusBarVM } from '../../../../battle/StatusBar';
import type { Ref } from '../../../../../platform/reactivity';
import type { HeroPropertiesVM } from './hero_properties/HeroPropertiesVM';

/**
 * 「游戏规则说明」面板的开关（**唯一真源**）。
 *
 * 它不是功能类（面板只读文案、不改任何战斗状态），但同样必须由宿主持有：
 *   · HUD 只 `open()` / `close()` 翻开关，节点 `active` 由 HUD 按 `visible` 写；
 *   · 宿主 `Scene_Game_Stage` watch `visible` → 面板开着时**冻结本局**（同三个商店面板，
 *     见 `syncPanelPaused`）—— 全屏面板挡着战场，不暂停的话玩家读完规则回来已经被打死了。
 */
export interface HelpPanelVM {
    /** 面板是否开着（HUD 写、宿主读；两边都不另存第二份） */
    readonly visible: Ref<boolean>;
    /** 打开规则说明（HUD 的问号按钮调它） */
    open(): void;
    /** 关闭规则说明（面板的关闭按钮 / 压暗层调它） */
    close(): void;
}

export const StageScopeKeys = {
    /** 退出战斗（动作）：由 `Scene_Game_Stage` 提供，战斗 UI 内任意深度都能调用 */
    ExitBattle: 'stage:exitBattle',

    /**
     * 英雄属性快照（动作）：由 `Scene_Game_Stage` 提供（`buildHeroPropertiesVM(this.hero, …)`）。
     *
     * 属性真源在**出战英雄实体的 `AttributeSystem`**（遗物 / 击杀商店 Buff 的贡献都合在里面），
     * 场景之外的任何地方都拿不到它 —— HUD 只在"点头像开面板"时调一次，取完就画，不缓存、不响应式。
     * 返回 null = 还没有出战英雄（HUD 据此**不打开**面板，而不是开一块空板子）。
     */
    HeroProperties: 'heroProperties:snapshot',

    /** 选英雄功能门面（`HeroSelectVM`：候选 / 面板开关 / 选中态 / 刷新费用与广告额度 / 刷新判据） */
    HeroSelect: 'heroSelect:vm',

    /** 遗物（肉鸽商店）功能门面（`RelicShopVM`：4 个候选格 / 本次是否已选 / 广告补选 / 刷新判据） */
    RelicShop: 'relicShop:vm',

    /** 击杀商店（Buff）功能门面（`BuffShopVM`：4 个摊位 / 层数 / 下一层价格 / 可买性 / 刷新判据） */
    BuffShop: 'buffShop:vm',

    /** 技能槽功能门面（`SkillSlotsVM`：4 个格子的技能 id / 等级 / 锁定 + 冷却进度） */
    SkillSlots: 'skillSlots:vm',

    /**
     * Boss 调度功能门面（`BossSchedulerVM`：三个槽位的库存 / 倒计时 / 可点性）。
     * HUD 的 `bosses` 子树读它渲染；点击向上发 `StageScopeEvents.BossDeploy`。
     */
    BossScheduler: 'bossScheduler:vm',

    /**
     * **局内掉落 Buff 小背包**功能门面（`ItemBagVM`：6 个格子 / 每格的配置 / 可不可用 / 空格数）。
     *
     * ⚠ 与 `BuffShop`（**神器**：永久 + 可叠层 + 花击杀数买）是**两条轨**，别混：
     *   这个背包装的是**打阶段 Boss 掉的限时道具**，捡到不生效，玩家点格子才生效。
     *   HUD 的 6 格读它渲染；**双击**格子向上发 `StageScopeEvents.BattleItemUse`。
     *   （单击"看描述"是背包面板内部的私事，走 `item_bag/ItemBagCell.ts` 的 `ITEM_BAG_PICKED`，
     *     不占本文件的键 —— 这里只放**宿主需要知道**的事。）
     */
    ItemBag: 'itemBag:vm',

    /**
     * 「游戏规则说明」面板的开关（`HelpPanelVM`）。
     * HUD 的问号按钮 `open()`、面板的关闭按钮 `close()`；节点显隐由 HUD 写，
     * 宿主读它做战斗冻结（同三个商店面板）。
     */
    HelpPanel: 'helpPanel:vm',

    /**
     * **本局流派进度**（`ArchetypeTallyVM`：8 个流派各拿了几件 / 谁已成型）。
     *
     * 为什么是页面级而不是 `useBattleStore`：按本文件的判据 —— *删掉那个控件，这个值还有意义吗？*
     * 没有。它**不参与任何战斗规则**（不改伤害、不改抽取），纯粹是把"你堆的是哪条线"画给玩家看，
     * 所以属于「界面怎么摆」。宿主在「买到遗物 / 技能落槽 / 买到神器 / 重开一局」后 `recount()`，
     * HUD 只 `watch(tally.revision)` 重画。
     */
    ArchetypeTally: 'archetypeTally:vm',

    /**
     * **HUD 状态栏**（`StatusBarVM`：本帧该显示的几条状态 / 短标 / 剩余秒数 / 层数）。
     *
     * 为什么是页面级而不是 store：按本文件的判据 —— *删掉那一行控件，这些值还有意义吗？*
     * 没有。它是把**英雄身上此刻挂着什么**画出来的纯投影，不参与任何战斗规则
     * （判据在 `battle/StatusBar.ts`，本组件一个字都不算）。
     *
     * ⚠ 它是**每帧读一次**的门面（倒计时在变），与其它"状态变了才通知"的门面不同：
     *   两条路都行，但订阅 `OnModifierAdded/Removed` 只回答"增删了"、回答不了"还剩几秒"。
     */
    StatusBar: 'statusBar:vm',
} as const;

/**
 * 键 → 值的类型（一张表就是这一页的数据契约，`provide`/`inject` 的泛型都从它取）。
 * 面板侧建议按名字写：`this.inject<HeroSelectVM>(StageScopeKeys.HeroSelect, null)`。
 */
export interface StageScopeMap {
    [StageScopeKeys.ExitBattle]: () => void;
    [StageScopeKeys.HeroProperties]: () => HeroPropertiesVM | null;
    [StageScopeKeys.HeroSelect]: HeroSelectVM;
    [StageScopeKeys.RelicShop]: RelicShopVM;
    [StageScopeKeys.BuffShop]: BuffShopVM;
    [StageScopeKeys.SkillSlots]: SkillSlotsVM;
    [StageScopeKeys.BossScheduler]: BossSchedulerVM;
    [StageScopeKeys.ItemBag]: ItemBagVM;
    [StageScopeKeys.HelpPanel]: HelpPanelVM;
    [StageScopeKeys.ArchetypeTally]: ArchetypeTallyVM;
    [StageScopeKeys.StatusBar]: StatusBarVM;
}

/** 局内 UI 的作用域事件（每个 UIWidget 一条独立总线，随作用域销毁自动清空，不用手写 off） */
export const StageScopeEvents = {
    /* ── 选英雄面板：item / 面板 → 宿主 `Scene_Game_Stage`（emit 沿父链冒泡，宿主 scope.on 收到） ── */

    /** 某个英雄被选中：参数 heroId（宿主转给 `HeroSelect.pick`，由它校验并回调创建英雄） */
    HeroPicked: 'heroSelect:picked',
    /** 点「刷新」：参数无（宿主转给 `HeroSelect.refresh`：金币够就扣钱、否则看广告） */
    HeroRefresh: 'heroSelect:refresh',

    /* ── 遗物面板：面板 / item → 宿主 ── */

    /** 点「刷新」：参数无（宿主转给 `RelicShop.refresh`） */
    RelicRefresh: 'relic:refresh',
    /** 点某个遗物：参数 (relicId: number, viaAd: boolean)；宿主转给 `RelicShop.pick` */
    RelicPicked: 'relic:picked',

    /* ── Buff 商店面板：面板 / item → 宿主 ── */

    /** 点「刷新」：参数无（宿主转给 `BuffShop.refresh`） */
    BuffShopRefresh: 'buffShop:refresh',
    /** 买某个 Buff：参数 (buffId: number)；宿主转给 `BuffShop.buy` */
    BuffShopBought: 'buffShop:bought',

    /* ── 技能槽：格子组件 → 宿主（沿父链冒泡；锁定的状态在 SkillSlots 里，格子自己不写） ── */

    /**
     * 点了某个格子的锁定图标：参数 (index: number)。
     * 宿主转给 `SkillSlots.toggleLock(index)`；被拒（槽 0 永久锁定）时由宿主飘字提示。
     */
    SkillLockToggled: 'skill:lockToggled',
    /**
     * 长按某个格子：参数 (index: number)。
     * 由 **HUD**（它持有详情面板节点）接住并弹面板 —— 长按不改变战斗状态，没必要绕到场景。
     */
    SkillDetailRequested: 'skill:detailRequested',
    /**
     * 收起详情面板：参数无。
     * **短按**某个技能槽（没到长按门槛 = "点一下别处"）与触摸被取消时发；**长按后松手不发**
     * （面板要能读完，松手就收会常常一帧都画不出来）。
     */
    SkillDetailDismissed: 'skill:detailDismissed',

    /* ── Boss 条目：HUD 的 `bosses` 三个子节点 → 宿主 ── */

    /**
     * 点了某个 Boss 条目：参数 `(key: BossSlotKey)`（`'gold' | 'kill' | 'guard'`）。
     * 宿主转给 `BossScheduler.deploy(key)` —— 由它校验库存与场上上限（HUD 不判能不能放）。
     */
    BossDeploy: 'boss:deploy',

    /* ── 掉落 Buff 背包：格子组件 → 宿主 ── */

    /**
     * **双击**背包第 `index` 格想**使用**那件道具：参数 `(index: number)`。
     * 宿主转给 `ItemBag.use(index)` —— 由它校验格子有没有东西、英雄在不在场，并施加效果后清格。
     * （HUD 不判能不能用；只读面有 `canUse(index)` 供它置灰。**单击看描述**是面板内部事件，
     *   不发到宿主这里 —— 见 `item_bag/ItemBagCell.ts` 的 `ITEM_BAG_PICKED`。）
     */
    BattleItemUse: 'itemBag:use',

    /* ── 结算面板：广告位 → 宿主 ── */

    /**
     * **结算面板的广告位被点了一下**：参数无。
     *
     * 为什么走冒泡而不是 HUD 自己拉广告：这一格发的是**局外资源**（金币 + 通用英雄经验），
     * 规则（倍率不重掷 / 只补差额 / 一局一次）与落库都在宿主那一侧
     * （`Scene_Game_Stage.onSettleAdRequested` → `common/RewardAdBonus` + `DataCenter`）。
     * HUD 只负责画三态（可点 / 播放中 / 已翻倍置灰）—— 与三个商店的 `playAd` 依赖逐字同构。
     *
     * ⚠ 它**不认局内广告券**（`ad_ticket` 只覆盖局内那两个商店广告位，见 `docs/meta-growth/README.md` §3）。
     */
    SettleAdRequested: 'settle:adRequested',
} as const;

/* ===================================================================
 * 节点归属（**谁持有节点，谁写 `active`** —— 面板自己不动自己的节点）
 *
 * ⚠ 这张表是"显隐为什么写在那个组件里"的唯一说明。面板的开关状态（`panelVisible`）一律由
 *   功能类持有、面板/HUD 只翻开关；谁的名字在下面这一列，谁就 watch 它并写节点 active。
 * =================================================================== */
//
//  面板 / 节点                      | 持有者（写 active 的地方）        | 开关状态（真源）
//  --------------------------------|--------------------------------|--------------------------------
//  选英雄面板  heroSelectPanel       | HUD `View_Game_Stage`           | `HeroSelectVM.panelVisible`
//  Buff 商店面板 shopBuffPanel       | HUD `View_Game_Stage`           | `BuffShopVM.panelVisible`
//  遗物面板    relicPanelNode        | 场景 `Scene_Game_Stage`          | `RelicShopVM.panelVisible`
//  技能详情浮层 skill_details       | HUD `View_Game_Stage`（节点在预制件里）| 不驻留（按住才看，见 SkillDetail* 事件）
//  英雄属性浮层 hero_properties      | HUD `View_Game_Stage`（节点在预制件里）| HUD 自己翻（点头像切换，非响应式）
//  游戏规则面板 help_panel           | HUD `View_Game_Stage`（节点在预制件里）| `HelpPanelVM.visible`（宿主 provide）
//  掉落 Buff 背包 item_bags          | HUD `View_Game_Stage`（节点在预制件里）| 面板自己一份（默认收起，非响应式）
//  结算面板    endNode               | HUD `View_Game_Stage`           | `showEnd(victory, runGold, heroExp, elapsed, adMul)` 直接写（非响应式）
//                                    |                                | runGold / heroExp = 本局结算金币与英雄经验，见 common/RunClearReward · RunClearHeroExp
//  结算面板的广告位 end/ad_btn        | HUD `View_Game_Stage`           | 同上（倍率由宿主掷好递进来，HUD 只画三态；点击冒泡 `SettleAdRequested`）
//
//  遗物面板的节点在场景名下（历史原因：入口按钮与面板都摆在了场景预制件上），
//  其余面板在 HUD 预制件里 —— 想统一就把节点挪进 HUD 子树，代码不用改（换持有者即可）。
