import { _decorator, Button, Component, instantiate, Label, Layout, Node, ScrollView } from 'cc';
import { buildGameRules } from '../../../../common/GameRulesConfig';

const { ccclass, property } = _decorator;

/** 面板节点名（**预制件里作者摆好的**，HUD 的直接子节点）：`View_Game_Stage/help_panel` */
export const HELP_PANEL_NODE = 'help_panel';

/* ===================================================================
 * 节点契约（**名字必须与预制件一致**；改预制件里的名字要同改这里）
 * =================================================================== */

/** 全屏压暗层（点它 = 关闭） */
const SCRIM_NODE = 'scrim';
/** 白底圆角板子（标题 / 分隔线 / 滚动区 / 关闭都在它下面） */
const PANEL_NODE = 'pannel';
/** 标题（预制件里写好「游戏规则」，本组件**不覆写**，留给策划改文案） */
const TITLE_NODE = 'title';
/** 右上角关闭按钮 */
const CLOSE_NODE = 'close';
/** ScrollView 本体（`view` 是它的子节点，Mask 挂在 `view` 上 —— 不能与 ScrollView 同节点） */
const SCROLL_NODE = 'scroll';
/** 滚动视区（`scroll/view`，挂 Mask） */
const VIEW_NODE = 'view';
/** 行容器（`scroll/view/content`，挂 Layout 竖排）；本组件往里克隆行 */
const CONTENT_NODE = 'content';
/** 小标题行模板（`active=false`，运行时克隆） */
const ROW_TITLE_NODE = 'row_title';
/** 正文行模板（`active=false`，运行时克隆） */
const ROW_TEXT_NODE = 'row_text';

/**
 * HelpPanel —— **游戏规则说明**面板（点 HUD 上的问号弹出）
 *
 * 节点是**预制件里作者摆好的**（`View_Game_Stage/help_panel`：位置 / 结构 / 配色都是资产，
 * 代码不搬它、不摆位），本组件由 HUD 在运行时 `addComponent` 挂上去、子节点按名字取
 * （与 `skill_details` 的 `SkillDetailPanel`、`hero_properties` 的 `HeroPropertiesPanel` 同一套路）：
 *
 * ```
 * help_panel                  全屏容器（750×1334，四边拉伸 Widget，BlockInputEvents 挡住战场点击）
 *   ├─ scrim                  压暗层（点一下 = 关闭）
 *   ├─ pannel                 白底圆角面板（660×1080）
 *   │    ├─ title             「游戏规则」（20px ink-900，居中）
 *   │    ├─ line              1px 分隔线（ink-200）
 *   │    ├─ scroll            ScrollView（竖向）
 *   │    │    └─ view         Mask 视区
 *   │    │         └─ content Layout（竖排 + 容器自适应高）
 *   │    └─ close             关闭按钮（45×45，SCALE 手感）
 *   ├─ row_title              小标题行模板（active=false）
 *   └─ row_text               正文行模板（active=false）
 * ```
 *
 * ── 三件事分得干干净净（同 HeroPropertiesPanel 的分工）──
 *   · **写什么**（章节 / 数值）→ `GameRulesConfig.buildGameRules()`（**唯一文案真源**，纯 TS）
 *   · **怎么画**（建行 / 滚动 / 显隐）→ 本组件
 *   · **什么时候开、什么时候关** → HUD（开关状态是宿主 provide 的门面，见 `StageScopeKeys.HelpPanel`）
 *
 * ── 四条口径 ──
 *   ① **行是克隆出来的、不是硬编码的**：预制件只放两个模板（`row_title` / `row_text`），
 *      章节数量由文案决定 —— 加一章规则只改 `GameRulesConfig`，不用碰预制件；
 *   ② **重建只发生在"本局难度变了"时**（`builtKey` 指纹）：规则文案里的倍率随难度档位变，
 *      但同一次打开不该重新建几十个节点；
 *   ③ **不自己关自己**：关闭按钮 / 压暗层只调 `onRequestClose`（HUD 写开关状态），
 *      这样"谁在开"只有一处（否则 HUD 的开关会和面板自己的 active 打架）；
 *   ④ **绑定后立刻收起**：预制件里 `help_panel` 是 `active` 的（作者要看到它才好摆位置，
 *      同 `hero_properties` / `skill_details`），不收起来开局就顶着一块全屏浮层。
 *
 * ⚠ 生命周期：本组件挂在**预制件节点**上，显隐由 HUD 调 `show/hide` 驱动（不是 `UIWidget` ——
 *   它不吃 UI 框架的 show/hide 生命周期，也没有 scope 通信需求）。
 */
@ccclass('HelpPanel')
export class HelpPanel extends Component {

    /* ===== 编辑器备用：想在编辑器里拖模板就填这里（留空 = 按名字取子节点） ===== */
    @property(Node)
    rowTitleNode: Node = null;
    @property(Node)
    rowTextNode: Node = null;

    /** 关闭请求（点关闭按钮 / 点压暗层）—— **由 HUD 注入**，面板自己不写开关状态 */
    onRequestClose: (() => void) | null = null;

    /** 解析出来的引用（`bind()` 之后有效） */
    private scrim: Node = null;
    private closeBtn: Node = null;
    private view: Node = null;
    private content: Node = null;
    private scroll: ScrollView = null;
    private bound = false;
    /** 上一次建行用的指纹（难度档位）：一样就不再重建 */
    private builtKey = '';
    /** 已经建出来的行数（日志用） */
    private rowCount = 0;

    /* ===================================================================
     * 绑定（幂等）
     * =================================================================== */

    /**
     * 解析面板里的节点（重复调用只做一次）；HUD 在 `addComponent` 之后调一次。
     * 首次绑定后会**先收起面板**（见文件头口径 ④）。
     */
    bind(): void {
        if (this.bound) return;
        this.bound = true;

        const pannel = this.node.getChildByName(PANEL_NODE);
        this.scrim = this.node.getChildByName(SCRIM_NODE);
        this.closeBtn = pannel?.getChildByName(CLOSE_NODE) ?? null;
        const scrollNode = pannel?.getChildByName(SCROLL_NODE) ?? null;
        this.scroll = scrollNode?.getComponent(ScrollView) ?? null;
        this.view = scrollNode?.getChildByName(VIEW_NODE) ?? null;
        this.content = this.view?.getChildByName(CONTENT_NODE) ?? null;
        this.rowTitleNode = this.rowTitleNode ?? this.node.getChildByName(ROW_TITLE_NODE);
        this.rowTextNode = this.rowTextNode ?? this.node.getChildByName(ROW_TEXT_NODE);

        // 关闭的两条路（都是"请求 HUD 关"，不是自己关）
        this.closeBtn?.on(Button.EventType.CLICK, this.requestClose, this);
        this.scrim?.on(Button.EventType.CLICK, this.requestClose, this);

        if (!pannel || !this.closeBtn || !this.scroll || !this.content || !this.rowTitleNode || !this.rowTextNode) {
            // 这条 warn 带实际子节点名：点问号没反应时一眼能看出"面板找对了、某个子节点名字不对"
            const names = this.node.children.map((c) => c.name).join(' / ') || '(没有子节点)';
            ezgame.warn(`[游戏规则] ${this.node.name} 的节点契约不完整`
                + `（pannel=${!!pannel}, close=${!!this.closeBtn}, scroll=${!!this.scroll},`
                + ` content=${!!this.content}, row_title=${!!this.rowTitleNode}, row_text=${!!this.rowTextNode}）`
                + `；实际子节点：${names}`);
        }

        this.node.active = false;
    }

    /* ===================================================================
     * 显隐（HUD 调）
     * =================================================================== */

    /**
     * 打开面板。
     *
     * @param difficulty 本局难度档位（`battleStore.difficulty`）—— 「难度与结算」一节按它现算倍率；
     *                   档位变了会重建行（见文件头口径 ②）
     */
    show(difficulty = 1): void {
        this.bind();
        if (!this.content || !this.rowTitleNode || !this.rowTextNode) {
            ezgame.warn('[游戏规则] 面板结构不完整，规则内容画不出来（见上一条 warn 列出的实际子节点）');
            return;
        }
        this.buildRows(difficulty);
        this.node.active = true;
        // 每次打开都回到顶部（看完一屏再打开，不该停在上次的位置）
        this.scroll?.scrollToTop(0);
    }

    /** 收起面板 */
    hide(): void {
        if (this.node?.isValid) this.node.active = false;
    }

    /** 当前是否可见（HUD 用它判"该开还是该关"） */
    get visible(): boolean {
        return !!this.node?.isValid && this.node.active;
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    /** 点关闭按钮 / 点压暗层 → 请求 HUD 关（面板不自己写开关状态） */
    private requestClose(): void {
        this.onRequestClose?.();
    }

    /**
     * 按当前难度建行（**同难度只建一次**）。
     *
     * 清空用 `removeAllChildren` + 逐个 `destroy`：`removeAllChildren` 只是解除父子关系，
     * 不回收节点（克隆出来的行不留着，下次同难度也不会重建，所以销毁是对的）。
     */
    private buildRows(difficulty: number): void {
        const key = `${difficulty > 0 ? Math.floor(difficulty) : 1}`;
        if (this.builtKey === key) return;
        this.builtKey = key;

        for (const child of this.content.children.slice()) child.destroy();
        this.rowCount = 0;

        const sections = buildGameRules({ difficulty });
        for (const section of sections) {
            this.appendRow(this.rowTitleNode, section.title);
            for (const line of section.lines) this.appendRow(this.rowTextNode, line);
        }
        // 行高是 Label 自己算的（RESIZE_HEIGHT），下一次布局才生效 —— 显式催一次，
        // 免得开面板那一帧 content 还是旧高度（滚动条会先闪一下）
        this.content.getComponent(Layout)?.updateLayout();
        ezgame.info(`[游戏规则] 建了 ${this.rowCount} 行（${sections.length} 章，难度 ${key}）`);
    }

    /** 克隆模板行 → 写文案 → 挂到 content（模板自身 `active=false`，克隆体要显式激活） */
    private appendRow(template: Node, text: string): void {
        if (!template) return;
        const row = instantiate(template);
        row.name = template.name;
        row.active = true;
        const label = row.getComponent(Label);
        if (label) label.string = text;
        row.setParent(this.content);
        this.rowCount++;
    }
}

/**
 * 便捷：确保 HUD 下有一块「游戏规则」面板（组件没有就挂上去）。
 *
 * 节点来自**预制件**（`help_panel`，作者摆好位置与结构），所以这里找不到就返回 null、
 * 并把**实际的子节点名**打进日志（便于对照预制件），不运行时建节点 ——
 * 位置/结构是策划资产，代码不该自己拼一块（同 `ensureSkillDetailPanel` / `ensureHeroPropertiesPanel`）。
 */
export function ensureHelpPanel(host: Node): HelpPanel {
    if (!host?.isValid) return null;

    // ① 认名字（面板节点的唯一真源）；② 没有名字节点时才退回"子树里已经挂过组件"的那个节点
    const named = host.getChildByName(HELP_PANEL_NODE);
    const found = host.getComponentInChildren(HelpPanel);
    const node = named ?? found?.node ?? null;

    if (!node) {
        const names = host.children.map((c) => c.name).join(' / ') || '(没有子节点)';
        ezgame.warn(`[游戏规则] ${host.name} 下找不到 ${HELP_PANEL_NODE} 节点（实际子节点：${names}），点问号不会弹规则说明`);
        return null;
    }
    if (found && found.node !== node) {
        ezgame.warn(`[游戏规则] 组件挂在 ${found.node.name} 上，但面板节点是 ${node.name} —— 以 ${node.name} 为准`);
    }

    const panel = node.getComponent(HelpPanel) ?? node.addComponent(HelpPanel);
    panel.bind();
    return panel;
}
