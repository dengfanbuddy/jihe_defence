import { _decorator, Button, Color, Label, Node, ProgressBar, resources, Sprite, SpriteFrame } from 'cc';
import { useBattleStore } from '../../../../stores';
import { EventBus } from '../../../../battle';
import { EventNames } from '../../../../battle/core/EventBus';
import { UIWidget } from '../../../../../platform/ui/UIWidget';
import { StageScopeEvents, StageScopeKeys } from './StageScope';
import { SkillSlot } from './skill_slot/SkillSlot';
import { SkillDetailPanel, ensureSkillDetailPanel, SKILL_DETAILS_NODE } from './skill_slot/SkillDetailPanel';
import { showFloatText } from './skill_slot/FloatText';
import { TbRoot } from 'db://assets/scripts/platform/excel_table/TbRoot';
import { UnitCfgContainer } from '../../../../excel_table/Tb_UnitConfig';
import { FINAL_BOSS_STAGE } from '../../../../common/EntityVisualConfig';
import { HIT_FEEL_INFO } from '../../../../common/HitFeelConfig';
import type { SkillSlotsVM } from '../../../../battle/SkillSlots';
import type { HeroSelectVM } from '../../../../battle/HeroSelect';
import type { BuffShopVM } from '../../../../battle/BuffShop';
import type { BossSchedulerVM, BossSlotKey, BossSlotVM } from '../../../../battle/BossScheduler';

const { ccclass, property } = _decorator;

/** Boss 条目的倒计时在「充能 CD」与「场上限时」两种状态下的字色（限时 = 警示色，催玩家去处理） */
const BOSS_TIME_CD_COLOR = new Color(255, 255, 255, 255);
const BOSS_TIME_LIMIT_COLOR = new Color(255, 76, 76, 255);
/** 库存为 0（点不动）时数量文案的灰度 */
const BOSS_COUNT_IDLE_COLOR = new Color(160, 160, 160, 255);
const BOSS_COUNT_READY_COLOR = new Color(0, 0, 0, 255);

/** 预制件里 `bosses` 下的三个条目节点名 → 调度器的槽位键 */
const BOSS_NODE_NAMES: [BossSlotKey, string][] = [
    ['gold', 'gold_boss'],
    ['kill', 'kill_boss'],
    ['guard', 'enimy_guard'],
];

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

    battleStore = useBattleStore()
    private startSF: SpriteFrame = null;
    private pauseSF: SpriteFrame = null;

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

    /** 宿主注入的「退出战斗」动作（场景在 onLoad 里 provide，所以 onInit 里注入得到） */
    private exitBattle: () => void = null;
    /** 宿主注入的**选英雄功能门面**：HUD 只读它的 `panelVisible` 写面板节点 active、按钮只翻这个开关 */
    private heroSelect: HeroSelectVM = null;
    /** 宿主注入的**Buff 商店功能门面**：同上（面板节点在本 HUD 下 → active 由本 HUD 写） */
    private buffShop: BuffShopVM = null;
    /** 宿主注入的**技能槽功能门面**：格子组件自己 inject 了一份；HUD 读它只为弹详情面板 */
    private skillSlotStates: SkillSlotsVM = null;
    /** 宿主注入的**Boss 调度门面**：本 HUD 只读它渲染 `bosses` 三个条目；点击向上发 `BossDeploy` */
    private bossScheduler: BossSchedulerVM = null;
    /** `bosses` 三个条目的运行时节点缓存（`setupBossEntries` 里按名字找，不改预制件） */
    private bossEntries: BossEntryRefs[] = [];

    /* ===================================================================
     * UIWidget 生命周期（Cocos 原生回调由基类接管，不要重写）
     * =================================================================== */

    protected onInit(): void {
        // 宿主注入：退出动作 + 三个功能门面（放 onInit 拿得到，是因为场景在 onLoad 里 provide）
        this.exitBattle = this.inject<() => void>(StageScopeKeys.ExitBattle, null);
        this.heroSelect = this.inject<HeroSelectVM>(StageScopeKeys.HeroSelect, null);
        this.buffShop = this.inject<BuffShopVM>(StageScopeKeys.BuffShop, null);
        this.skillSlotStates = this.inject<SkillSlotsVM>(StageScopeKeys.SkillSlots, null);
        this.bossScheduler = this.inject<BossSchedulerVM>(StageScopeKeys.BossScheduler, null);

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

        // 技能栏：给预制件里摆好的 4 个槽位节点逐个挂上 SkillSlot（运行时挂，不用改预制件）
        this.setupSkillSlots();

        // Boss 面板：预制件里 `bosses` 下已经摆好三个条目（gold_boss / kill_boss / enimy_guard），
        // 每个都挂了 Button —— 这里只做「找到节点 + 绑点击」，不改预制件
        this.setupBossEntries();

        // 长按技能槽 → 弹详情面板；松手 → 收起（面板节点在 HUD 名下 → 由 HUD 写它的显隐）
        // ⚠ 这两行必须排在「挂面板组件」**之前**：面板初始化万一抛异常，也不会把事件订阅一起吞掉
        this.scope.on(StageScopeEvents.SkillDetailRequested, this.onSkillDetailRequested, this);
        this.scope.on(StageScopeEvents.SkillDetailDismissed, this.hideSkillDetail, this);

        // 详情面板：节点由预制件提供（`skill_details`），这里只把组件挂上去并**立刻收起** ——
        // 预制件里该节点是 active 的（作者要看到它才好摆位），不收起来开局就顶着一块示例文案
        this.ensureDetailPanel();
        this.hideSkillDetail();

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
        // Boss 条目的点击回调是逐条目现造的闭包，没法用方法名 off —— 存在 bossEntries 里成对摘
        for (const e of this.bossEntries) {
            this.offNodeEvent(e.node, Button.EventType.CLICK, e.onClick, this);
        }
        this.bossEntries = [];
    }

    /* ===================================================================
     * 刷新（只读 store → 写 UI；onShow 与各个 watcher 的公共出口）
     * =================================================================== */

    private refreshAll(): void {
        // 打击反馈 F10：换局先把弹跳清干净（上一局弹到一半的节点别把缩放带进新一局）
        this.resetPunches();
        this.refreshHeroSelectPanel();
        this.refreshBuffShopPanel();
        this.refreshHeroInfo();
        this.refreshHp();
        this.refreshGold();
        this.refreshKills();
        this.refreshLevel();
        this.refreshDifficulty();
        this.updateProgress();
        this.refreshBosses();
    }

    private refreshHeroSelectPanel(): void {
        if (!this.heroSelectPanel) return;
        const visible = !!(this.heroSelect && this.heroSelect.panelVisible.value);
        this.heroSelectPanel.active = visible;
        // 详情面板常驻且渲染层级在面板之上 → 别的面板一开就把它收掉，别压住人家
        if (visible) this.hideSkillDetail();
    }

    /** Buff 商店面板显隐：状态是 `BuffShop.panelVisible`（宿主 provide 的门面），节点在本 HUD 下 → 由本 HUD 写 */
    private refreshBuffShopPanel(): void {
        if (!this.shopBuffPanel) return;
        const visible = !!(this.buffShop && this.buffShop.panelVisible.value);
        this.shopBuffPanel.active = visible;
        if (visible) this.hideSkillDetail();
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
        if (this.hp_value) this.hp_value.string = `${hp}/${maxHp}`;
        if (this.hp_bar) this.hp_bar.progress = maxHp > 0 ? Math.min(1, this.battleStore.hp / maxHp) : 0;
        // 打击反馈 F10：自己的血量变化也弹一下（挨打是最该被看见的信息）
        this.punch(this.hp_value?.node);
    }

    private refreshGold(): void {
        if (this.money_gold_value) this.money_gold_value.string = `${this.battleStore.gold}`;
        this.punch(this.money_gold_value?.node);
    }

    private refreshKills(): void {
        // ⚠ 显示的是**击杀数余额**（`killPoints`，击杀商店的货币，买东西会减少），
        //   不是累计击杀数（那是 `kills`，只进结算面板与成就）。
        if (this.money_kill_value) this.money_kill_value.string = `${this.battleStore.killPoints}`;
        // 打击反馈 F10 + F8 的 HUD 侧：击杀计数弹一下（配合屏幕层的击杀落款）
        this.punch(this.money_kill_value?.node);
    }

    private refreshLevel(): void {
        const { level, exp, expToNext } = this.battleStore;
        if (this.lv_value) this.lv_value.string = `Lv.${level}`;
        if (this.lv__exp_value) this.lv__exp_value.string = `${Math.trunc(exp)}/${expToNext}`;
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
     */
    private updateProgress(): void {
        const stage = this.battleStore.phase;
        const time = this.battleStore.phaseRemainTime;
        const total = this.battleStore.phaseTotalTime;
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
        if (stage < FINAL_BOSS_STAGE) {//1~4 常规阶段
            if (this.progress_name) this.progress_name.string = `阶段 ${stage}/${this.battleStore.maxPhase}`;
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
     * 战斗结束：弹出结算面板（面板数据后续再补）。开新一局时 onShow 会自动收起。
     *
     * @param victory 胜负 —— 由 `Scene_Game_Stage.endRun(result)` 传入（最终 Boss 被击杀 = 胜；
     *                英雄阵亡 / Boss 阶段超时 = 负），只影响这里的标题文案
     */
    showEnd(victory = false): void {
        if (this.end_title) this.end_title.string = victory ? '战斗胜利' : '战斗失败';
        if (this.endNode) this.endNode.active = true;
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
