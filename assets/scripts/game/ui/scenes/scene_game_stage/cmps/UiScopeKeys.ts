/**
 * 局内 UI 的作用域键 / 局部事件名（UIScope provide / inject / emit）
 *
 * 只放「局内 UI 子树内部」的东西：向子树注入的状态、以及子树向上通知的事件。
 * 跨界面共享的数据请用全局 store（useBattleStore），不要塞进作用域。
 *
 * ── 判据：这个概念属于谁？（不是「现在谁在读」）──
 *   ① **UI 摆放**（面板开关 / 面板要渲染的列表 / 界面私有选中态）
 *      → 页面级，由宿主 `provide`（本文件下面那一组）。判据：**删掉那个控件，这个值还有意义吗？没有 → 页面级**。
 *   ② **局内运行状态**（`level` / `exp` / `enemiesAlive` / `isPaused`）
 *      → 不是页面级：写它的不是 UI 交互，而是游戏规则，场景自己的升级 / 刷怪 / 抽卡 / 暂停逻辑也在读它
 *        （`addBattleExp` 直接拿 `level/exp/expToNext` 算升级）→ 留在 `useBattleStore`。
 *   ③ **战斗真源的响应式投影**（`hp` / `maxHp` / `gold` / `kills` / `phase` / `phaseRemainTime`）
 *      → 只有本界面的 HUD 在读，看起来也像「界面内部数据」，但**它描述的是这一局战斗**（生命周期 = 对局），
 *        而且跨层视图（popup 层结算 / 商店弹窗）`inject` 不到、只能走 store → 留在 `useBattleStore`。
 *        真要让宿主 provide 也不是不行，代价是「换个读者（比如加个结算弹窗）就得挪回 store」。
 *
 *   一句话：**属于「界面怎么摆」的 → scope；属于「这一局战斗」的 → store**。
 *
 * ── 谁 provide（宿主 = `Scene_Game_Stage`，值是功能类自己的 ref）──
 *   三套面板（选英雄 / 遗物 / Buff 商店）的页面级状态都由**功能类**持有
 *   （`HeroSelect` / `RelicShop` / `BuffShop`，见 `game/battle/`），
 *   场景在 `onLoad` 里统一 `provide` 出去、把子树冒泡上来的事件转回给它们。
 *   这样「功能的状态 + 流程」在一个类里，「节点持有 + 接线」在场景里，UI 只渲染与上报。
 *
 * 命名约定：`'域:用途'`，日志里一眼能看出是谁的键。
 */

export const StageScopeKeys = {
    /** 退出战斗：由 `Scene_Game_Stage` 提供（场景是整棵战斗 UI 子树的宿主），战斗 UI 内任意深度都能调用 */
    ExitBattle: 'stage:exitBattle',

    /* ── 选英雄面板：`HeroSelect` 提供（宿主 onLoad 里 provide，子树 onInit 即可注入） ── */

    /** 本局候选英雄 id（`ref<number[]>`，0 = 空位） */
    HeroSelectList: 'heroSelect:list',
    /** 面板是否显示（`ref<boolean>`；开局设 true、HUD 按钮设 true、面板关闭按钮与选中后设 false） */
    HeroSelectPanelVisible: 'heroSelect:panelVisible',
    /** 当前选中的英雄 id（`ref<number>`；item 之间的互斥高亮，**不再是面板私有状态**） */
    HeroSelectSelectedId: 'heroSelect:selectedId',
    /** 刷新一次候选的金币费用（`ref<number>`；面板显示 + 与 gold 比较决定置灰） */
    HeroSelectRefreshCost: 'heroSelect:refreshCost',
    /** 剩余「广告免费刷新」次数（`ref<number>`；>0 时金币不够也不置灰，改为「看广告」） */
    HeroSelectAdFreeLeft: 'heroSelect:adFreeLeft',

    /* ── 遗物（肉鸽商店）面板：`RelicShop` 提供 ── */

    /** 面板是否显示（`ref<boolean>`；入口按钮设 true、面板关闭按钮设 false，宿主按它写面板节点 active） */
    RelicPanelVisible: 'relic:panelVisible',
    /** 4 个槽位的遗物 id（`ref<number[]>`，0 = 空槽 / 已被选走 → item 收起） */
    RelicSlots: 'relic:slots',
    /** 本次刷新是否已选过（`ref<boolean>`；已选 → 剩余槽位置灰不可点） */
    RelicRollUsed: 'relic:rollUsed',
    /** 剩余槽位是否转为「看广告才能选」（`ref<boolean>`；选过之后还有广告补选次数时为 true） */
    RelicAdMode: 'relic:adMode',
    /** 本次刷新的金币费用（`ref<number>`） */
    RelicRefreshCost: 'relic:refreshCost',
    /** 剩余「广告免费刷新」次数（`ref<number>`） */
    RelicAdFreeLeft: 'relic:adFreeLeft',

    /* ── 击杀商店（Buff）面板：`BuffShop` 提供 ── */

    /** 面板是否显示（`ref<boolean>`） */
    BuffShopPanelVisible: 'buffShop:panelVisible',
    /** 4 个摊位的 Buff id（`ref<number[]>`，0 = 空摊 → item 收起） */
    BuffShopSlots: 'buffShop:slots',
    /** 每个 Buff 的已购层数（`ref<Record<number, number>>`；item 据此显示「层数/上限」与下一层价格） */
    BuffShopStacks: 'buffShop:stacks',
    /** 刷新一次摊位的金币费用（`ref<number>`） */
    BuffShopRefreshCost: 'buffShop:refreshCost',
    /** 剩余「广告免费刷新」次数（`ref<number>`） */
    BuffShopAdFreeLeft: 'buffShop:adFreeLeft',
} as const;

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
} as const;
