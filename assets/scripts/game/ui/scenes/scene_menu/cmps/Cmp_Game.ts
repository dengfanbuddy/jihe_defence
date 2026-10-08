import { _decorator, Label, Node } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { DataCenter } from '../../../../data';
import {
    GAME_MODES, gameModeDesc, gameModeName, isGameMode, type GameModeId,
} from '../../../../common/GameModeConfig';

const { ccclass, property } = _decorator;

/**
 * 子节点契约（与 `Scene_Menu.prefab` 的 `content/right/game` 一致；`@property` 没拖时按这些路径兜底）。
 * ⚠ 改预制件里的名字要同步这里。
 */
const NODE = {
    /** 顶部信息区的**模式名**（`info/name` 上的 Label） */
    infoName: 'info/name',
    /** 顶部信息区的**模式说明**（`info/name` 下的 `desc` —— 它是 name 的子节点） */
    infoDesc: 'info/name/desc',
    /** 「最高通过」的数值（`info/passed/value`） */
    passed: 'info/passed/value',
    /** 「上次玩过」的数值（`info/last/value`） */
    last: 'info/last/value',
    /** 模式卡容器（`lists/contents`；它的子节点 = 卡片，**节点名就是模式 id**） */
    cards: 'lists/contents',
} as const;

/**
 * 卡片里那块「选中态」覆盖层的节点名 —— 青绿描边环（`rect_board_rd_20`）+ 右上角标（`conor`）+ 勾（`gou`）。
 * 它是一张**整卡大小**的 Sprite，压在 `bg` / `game_bg` 之上：**只负责画，不接点击**
 * （Cocos 的节点触摸只命中"注册过监听器的节点"，所以它不会挡住卡片自己的 `TOUCH_END`）。
 */
const CARD_SELECTED = 'active';

/** 卡片上的两行文案（与预制件一致） */
const CARD_NAME = 'name';
const CARD_DESC = 'desc';

/**
 * 一张模式卡的运行期句柄。
 * `onClick` 是**每张卡各一个的闭包**（节点事件只能按注册时的同一个引用摘，见 `onDispose`）——
 * 与 `platform/ui/Tabs.bindTabClicks` 同一个写法。
 */
interface ModeCard {
    id: GameModeId;
    node: Node;
    /** 选中态覆盖层（可能为 null —— 预制件少摆了就是"没有选中外观"，不影响能不能点） */
    selected: Node;
    nameLabel: Label;
    descLabel: Label;
    onClick: () => void;
}

/**
 * Cmp_Game —— 主界面「游戏」页（`Scene_Menu/content/right/game`）的页面控制器
 *
 * 内嵌 UI 小组件 → 继承 `UIWidget`（**不加 @uiview**）。
 *
 * ── 节点契约（`assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab`）──
 * ```
 * game                       ← 本组件挂这里
 * ├── info                   顶部信息区（跟着**选中的模式**变）
 * │   ├── name               ← 模式名（如「阶段模式」）
 * │   │   └── desc           ← 模式说明（两行）
 * │   ├── passed/value       ← 最高通过（**全局**：已通关的最高档）
 * │   └── last/value         ← 上次玩过（**按模式**：该模式上次打过的档）
 * └── lists(ScrollView)
 *     └── contents           卡片容器
 *         ├── stage          ← 模式卡（节点名 = 模式 id）
 *         │   ├── bg / game_bg
 *         │   ├── active     ← 选中态覆盖层（亮 = 这张被选中）
 *         │   ├── name / desc
 *         ├── no_ending      ← 同上
 *         └── card-002       ← 「挑战boss」：**还没做** → 本组件把它显式收起
 * ```
 *
 * ── 职责（只做三件）──
 *   ① **选模式**：点一张卡 → `LevelData.selectMode(id)` 落盘（**唯一写入口**）→ 立刻重画；
 *   ② **画顶部信息**：模式名 / 说明 / 最高通过 / 上次玩过（全部读 `LevelData`，本类不算账）；
 *   ③ **画卡片**：文案来自 `GameModeConfig`（预制件里的是占位），选中态只亮当前模式那一张。
 *
 * ── 为什么"进游戏"不在这里 ──
 * 「开始游戏」按钮是 `bottom/right/enter_game`（**不在本组件的子树里**，归 `Scene_Menu`），
 * 它先弹**难度选择弹窗**、由弹窗「确定」才真正开战 —— 那条流程在 `Scene_Menu` 里，
 * 本组件只负责"现在选的是哪个模式"这一件事（模式一落盘，弹窗开的自然就是它那套难度）。
 *
 * ── 三条实现口径 ──
 *   ① **卡片按名字匹配，不按下标**：多摆/少摆一张卡、调换顺序都不会串位；
 *      名字不在 `GAME_MODES` 里的卡（如 `card-002`）一律**收起**（点了也不会有反应的东西不该出现在列表里）。
 *   ② **不用 `Button`**：卡片是"选中项"不是"按钮"，加 Button 会带来 SCALE/染色过渡与
 *      `interactable` 的副作用（`AchievementItem` / `TaskItem` 踩过）；这里与底部三个页签同口径，
 *      走节点 `TOUCH_END`。想改成按钮：在预制件里给卡片加 `Button`，再把 `bindCardTouches` 换成
 *      `Button.EventType.CLICK` 即可。
 *   ③ **`onShow` 无条件重画**：本页节点会被左侧页签 `active=false` 收起（`Cmp_FuncTabs`），
 *      收起期间 watcher 是暂停的 —— 回到本页时必须按**当前**数据整块刷一次
 *      （`scope.resume()` 的补播是另一条保险，两条都在才不怕时序）。
 */
@ccclass('Cmp_Game')
export class Cmp_Game extends UIWidget {

    /** 顶部信息区的模式名（`info/name`）—— 留 `@property` 只为编辑器里能拖，不拖就按路径解析 */
    @property(Label)
    infoName: Label = null;
    /** 顶部信息区的模式说明（`info/name/desc`） */
    @property(Label)
    infoDesc: Label = null;
    /** 「最高通过」的数值（`info/passed/value`） */
    @property(Label)
    passedValue: Label = null;
    /** 「上次玩过」的数值（`info/last/value`） */
    @property(Label)
    lastValue: Label = null;
    /** 模式卡容器（`lists/contents`） */
    @property(Node)
    cardsNode: Node = null;

    /** 收集到的模式卡（顺序 = 预制件 `contents` 下的顺序） */
    private cards: ModeCard[] = [];

    /** 子节点是否已经解析过（`render` 每次都调 `resolveRefs`，只真解析一次） */
    private refsResolved = false;

    /* ===================================================================
     * 生命周期（Cocos 回调由基类接管，子类只用 onInit / onShow / onDispose）
     * =================================================================== */

    protected onInit(): void {
        this.resolveRefs();
        this.bindCards();
        // 数据一变就重画：模式（点卡）、全局通关进度（局内通关）、各模式的"上次玩过"（进过局）
        // ⚠ 源用只读的 `progressKey()`（它不建记录、不写盘），值没变就不会回调
        this.scope.watch(() => DataCenter.ins.levelData.progressKey(), () => this.render());
        // `watch` 不带 `immediate` 时初次**不回调** —— 第一帧必须自己画一次，
        // 否则看到的是预制件里烤死的占位文案（与 `Scene_Menu.refreshGold` 同一个坑）
        this.render();
        console.log(`[游戏模式] onInit：当前模式=${gameModeName(DataCenter.ins.levelData.getMode())}，`
            + `卡片 ${this.cards.length}/${GAME_MODES.length}（${this.cards.map((c) => c.id).join(', ')}）`);
    }

    /** 每次显示（左侧页签切回本页）按当前数据整块重画（理由见类注释③） */
    protected onShow(): void {
        this.render();
    }

    protected onDispose(): void {
        // 节点事件只能按注册时的**同一个闭包**摘（`Tabs.unbindTabClicks` 同口径）；
        // 一律走 `offNodeEvent`：卡片是本节点的后代，销毁时可能已被 `_destruct()` 清空字段
        for (const card of this.cards) {
            this.offNodeEvent(card.node, Node.EventType.TOUCH_END, card.onClick, this);
        }
        this.cards = [];
    }

    /* ===================================================================
     * 交互
     * =================================================================== */

    /** 点一张模式卡：落盘（唯一写入口）→ 立刻重画 */
    private onClickCard(id: GameModeId): void {
        const data = DataCenter.ins.levelData;
        if (data.getMode() === id) return;          // 点已经选中的那张：无副作用（不重复写盘）
        if (!data.selectMode(id)) {
            ezgame.warn(`[游戏模式] 切到「${id}」被拒（不在 GameModeConfig.GAME_MODES 里？）→ 本次点击无效果`);
            return;
        }
        ezgame.info(`[游戏模式] 选中：${gameModeName(id)}（下次「开始游戏」按它的难度开）`);
        // watcher 也会触发，但那是异步的：这里直接重画一次，选中态当场就变（`render` 幂等）
        this.render();
    }

    /* ===================================================================
     * 渲染（只读数据层 → 写 UI；`onInit` / `onShow` / watcher 的公共出口）
     * =================================================================== */

    private render(): void {
        this.resolveRefs();
        const data = DataCenter.ins.levelData;
        const mode = data.getMode();

        // ① 顶部信息区：模式名 / 说明 / 最高通过（全局）/ 上次玩过（按模式）
        this.setLabel(this.infoName, gameModeName(mode));
        this.setLabel(this.infoDesc, gameModeDesc(mode));
        this.setLabel(this.passedValue, `${data.getClearedLevel()}`);
        this.setLabel(this.lastValue, `${data.getLastPlayedLevel(mode)}`);

        // ② 卡片：文案来自配置（预制件里的是占位），选中态**只亮当前模式那一张**
        for (const card of this.cards) {
            this.setLabel(card.nameLabel, gameModeName(card.id));
            this.setLabel(card.descLabel, gameModeDesc(card.id));
            if (card.selected && card.selected.isValid) card.selected.active = card.id === mode;
        }
    }

    /** 写文案（相同就不写：避免无意义的字符串重排） */
    private setLabel(label: Label, text: string): void {
        if (label && label.isValid && label.string !== text) label.string = text;
    }

    /* ===================================================================
     * 节点契约
     * =================================================================== */

    /** 解析 `@property` 没拖的引用（只真解析一次） */
    private resolveRefs(): void {
        if (this.refsResolved) return;
        this.refsResolved = true;

        const n = this.node;
        this.infoName = this.infoName ?? n.getChildByPath(NODE.infoName)?.getComponent(Label);
        this.infoDesc = this.infoDesc ?? n.getChildByPath(NODE.infoDesc)?.getComponent(Label);
        this.passedValue = this.passedValue ?? n.getChildByPath(NODE.passed)?.getComponent(Label);
        this.lastValue = this.lastValue ?? n.getChildByPath(NODE.last)?.getComponent(Label);
        this.cardsNode = this.cardsNode ?? n.getChildByPath(NODE.cards);

        if (!this.infoName || !this.passedValue || !this.lastValue || !this.cardsNode) {
            ezgame.warn(`[游戏模式] ${n.name} 的子节点契约不完整（需要 ${NODE.infoName} / `
                + `${NODE.passed} / ${NODE.last} / ${NODE.cards}）：找到 name=${!!this.infoName} `
                + `passed=${!!this.passedValue} last=${!!this.lastValue} cards=${!!this.cardsNode}`);
        }
    }

    /**
     * 收集模式卡并绑点击（只在 `onInit` 调一次）。
     *
     * 判据是**节点名 = 模式 id**（`GameModeConfig.GameMode`）：
     *   · 名字不在 `GAME_MODES` 里的卡（如 `card-002`「挑战boss」）→ 显式收起，点都点不到；
     *   · 配了模式却没有对应卡 → 记一条 warn（那种模式在界面上选不了）。
     */
    private bindCards(): void {
        this.cards = [];
        if (!this.cardsNode) return;

        for (const child of this.cardsNode.children) {
            if (!isGameMode(child.name)) {
                // 还没做的模式：收起（预制件里可以是 `active=false`，这里再兜一次，
                // 免得作者为了看排版把它打开就带上线了）
                if (child.active) child.active = false;
                continue;
            }
            const id: GameModeId = child.name;
            const onClick = () => this.onClickCard(id);
            child.on(Node.EventType.TOUCH_END, onClick);
            this.cards.push({
                id,
                node: child,
                selected: child.getChildByName(CARD_SELECTED),
                nameLabel: child.getChildByName(CARD_NAME)?.getComponent(Label),
                descLabel: child.getChildByName(CARD_DESC)?.getComponent(Label),
                onClick,
            });
        }

        for (const info of GAME_MODES) {
            if (this.cards.some((c) => c.id === info.id)) continue;
            ezgame.warn(`[游戏模式] ${NODE.cards} 下找不到「${info.id}」那张卡 → `
                + `${info.name}选不了（要求：卡片节点的名字就是模式 id）`);
        }
        if (this.cards.length === 0) {
            ezgame.warn(`[游戏模式] ${this.node.name} 下一张模式卡都没收集到 → 模式切换不可用`);
        }
    }
}
