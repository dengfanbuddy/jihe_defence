import { _decorator, Component, Label, Node, Sprite, SpriteFrame } from 'cc';
import type { HeroPropertiesVM } from './HeroPropertiesVM';

const { ccclass, property } = _decorator;

/** 面板节点名（**预制件里作者摆好位置**，HUD 的直接子节点）：`View_Game_Stage/hero_properties` */
export const HERO_PROPERTIES_NODE = 'hero_properties';

/**
 * 属性行节点的名字前缀：预制件里是 `attr_1` … `attr_22`
 * （序号即 `attributes.json` 的 id 升序里的第几条），所以按前缀扫 + **按序号排**，
 * 不逐个记全名 —— 再复制一行出来也能认到（复制出来的 `attr_1-001` 会按序号 1 参与排序）。
 */
const ROW_PREFIX = 'attr_';
const ROW_NAME_NODE = 'name';
const ROW_VALUE_NODE = 'value';

/** 标题栏节点名（与预制件一致；改名字要同步这里） */
const HEAD_NODE = 'head';
const HEAD_ICON_NODE = 'icon';
const NAME_NODE = 'name';
const LV_NODE = 'lv';

/** 一行属性在运行时的三件套 */
interface PropertyRowRefs {
    node: Node;
    /** 属性名（14px ink-600，左对齐） */
    name: Label | null;
    /** 当前值（16px ink-900，右对齐） */
    value: Label | null;
}

/**
 * HeroPropertiesPanel —— **点英雄头像弹出的「英雄属性详情」浮层**
 *
 * 节点是**预制件里作者摆好的**（`View_Game_Stage/hero_properties`，位置/结构/配色都是资产，
 * 代码不搬它、不建行），本组件由 HUD 在运行时 `addComponent` 挂上去、子节点按名字取
 * （与 `skill_details` 的 `SkillDetailPanel` 逐字同款套路）：
 *
 * ```
 * hero_properties                白底圆角面板（520×400，底部居中，横向居中 Widget）
 *   ├─ head                      英雄头像格底（48×48，身份色 #A85A5A 圆角）
 *   │    └─ icon                 头像（运行时换成 units.head_icon；没给就保留预制件里的占位图）
 *   ├─ name                      英雄名（20px ink-900，左对齐）
 *   ├─ lv                        `Lv.N`（16px accent-600，右对齐；N = **局内等级**）
 *   ├─ line_top                  1px 分隔线（ink-200）
 *   ├─ attr_1 … attr_22          一行 = 一种属性，两列竖排（奇数列左 / 偶数列右）
 *   │    ├─ name                 属性名（14px ink-600）
 *   │    └─ value                当前值（16px ink-900）
 *   ├─ line_bottom               1px 分隔线
 *   └─ hint                      「再点英雄头像收起」（12px ink-400，居中）
 * ```
 *
 * 三条口径：
 *   ① **行数由数据说了算**：`HeroPropertiesVM.rows` 有几条就画几条，多出来的行 `active = false`
 *      （配表加了属性而预制件行节点不够时打一条 warn 点名"少显示了几条"）；
 *   ② **值是快照**：`show()` 拿到的那一份画完就不再变 —— 属性随时会被遗物/Buff 改，
 *      但面板不该在玩家眼皮底下自己跳数；HUD 在"等级/遗物/技能变了"时重取一份快照再 `show()` 一次
 *      （见 `View_Game_Stage.refreshHeroProperties`）；
 *   ③ **不自己关自己**：开关由 HUD 管（点头像切换），面板不吃点击 —— 玩家在读数时点一下面板
 *      不该把它点没了（与 `skill_details`「点一下就收」的区别就在这里）。
 *
 * ⚠ 生命周期：本组件挂在**预制件节点**上，显隐由 HUD 调 `show/hide` 驱动（不是 UIWidget ——
 *   它不吃 UI 框架的 show/hide 生命周期，也没有 scope 通信需求，同 `SkillDetailPanel`）。
 */
@ccclass('HeroPropertiesPanel')
export class HeroPropertiesPanel extends Component {

    /* ===== 编辑器备用：想在编辑器里拖行节点就填这里（留空 = 按前缀扫子节点） ===== */
    @property([Node])
    rowNodes: Node[] = [];

    /** 解析出来的引用（`bind()` 之后有效） */
    private rows: PropertyRowRefs[] = [];
    private headIcon: Sprite | null = null;
    private nameLabel: Label | null = null;
    private lvLabel: Label | null = null;
    private bound = false;

    /* ===================================================================
     * 绑定（幂等）
     * =================================================================== */

    /**
     * 解析面板里的节点（重复调用只做一次）；HUD 在 `addComponent` 之后调一次。
     *
     * 首次绑定后会**先收起面板**：预制件里 `hero_properties` 是 `active` 的
     * （作者要看到它才摆得准，同 `skill_details`），不收起来开局就顶着一块浮层。
     */
    bind(): void {
        if (this.bound) return;
        this.bound = true;

        const headNode = this.node.getChildByName(HEAD_NODE);
        this.headIcon = headNode?.getChildByName(HEAD_ICON_NODE)?.getComponent(Sprite) ?? null;
        this.nameLabel = this.node.getChildByName(NAME_NODE)?.getComponent(Label) ?? null;
        this.lvLabel = this.node.getChildByName(LV_NODE)?.getComponent(Label) ?? null;
        if (!headNode || !this.headIcon || !this.nameLabel || !this.lvLabel) {
            ezgame.warn(`[英雄属性] ${this.node.name} 的标题栏不完整（head/icon=${!!this.headIcon}, name=${!!this.nameLabel}, lv=${!!this.lvLabel}），标题会缺内容`);
        }

        const rowNodes: Node[] = this.rowNodes.length
            ? this.rowNodes.slice()
            : this.node.children
                .filter((child) => child.name.indexOf(ROW_PREFIX) === 0)
                .sort((a, b) => rowIndexOf(a.name) - rowIndexOf(b.name));

        this.rows = [];
        const seen = new Set<number>();
        for (const rowNode of rowNodes) {
            if (!rowNode) continue;
            const idx = rowIndexOf(rowNode.name);
            if (seen.has(idx)) {
                ezgame.warn(`[英雄属性] 行节点 ${rowNode.name} 与前面的行序号相同（都算第 ${idx + 1} 行），这一行可能显示成同一条属性`);
            }
            seen.add(idx);
            const name = rowNode.getChildByName(ROW_NAME_NODE)?.getComponent(Label) ?? null;
            const value = rowNode.getChildByName(ROW_VALUE_NODE)?.getComponent(Label) ?? null;
            if (!name || !value) {
                ezgame.warn(`[英雄属性] 行节点 ${rowNode.name} 缺 ${ROW_NAME_NODE} / ${ROW_VALUE_NODE} 子节点，这一行会缺内容`);
            }
            this.rows.push({ node: rowNode, name, value });
        }
        if (!this.rows.length) {
            // 这条 warn 带实际子节点名：点头像没反应时一眼能看出"面板节点找对了、行节点名字不对"
            const names = this.node.children.map((c) => c.name).join(' / ') || '(没有子节点)';
            ezgame.warn(`[英雄属性] ${this.node.name} 下没找到 ${ROW_PREFIX}* 行节点（实际子节点：${names}），属性面板会是空的`);
        } else {
            ezgame.info(`[英雄属性] ${this.node.name} 绑定 ${this.rows.length} 行`);
        }

        this.node.active = false;
    }

    /* ===================================================================
     * 显隐
     * =================================================================== */

    /**
     * 展示一份属性快照。
     *
     * @param vm `HeroPropertiesVM`（`buildHeroPropertiesVM` 出的那一份）
     * @param headFrame 英雄头像（HUD 已经加载好的那一张；**不给就保留预制件里的占位图**，
     *                  不在这里再 `resources.load` 一次 —— 同一张图没必要两条加载路径）
     */
    show(vm: HeroPropertiesVM, headFrame: SpriteFrame | null = null): void {
        this.bind();

        if (!vm || !vm.rows.length) {
            ezgame.warn(`[英雄属性] 这一份快照里一行属性都没有（heroId=${vm?.heroId ?? 'null'}），面板不打开`);
            return;
        }
        if (!this.rows.length) {
            ezgame.warn(`[英雄属性] 有 ${vm.rows.length} 条属性，但 ${this.node.name} 里一行都没有，面板不显示`);
            return;
        }

        // 行数由数据说了算：多出来的行收起（不画半块空白）
        const shown = Math.min(vm.rows.length, this.rows.length);
        if (vm.rows.length > this.rows.length) {
            ezgame.warn(`[英雄属性] 有 ${vm.rows.length} 条属性，但 ${this.node.name} 只有 ${this.rows.length} 行，多出来的显示不出来（往预制件里补 ${ROW_PREFIX}* 行节点）`);
        }
        for (let i = 0; i < this.rows.length; i++) {
            const row = this.rows[i];
            const data = vm.rows[i];
            row.node.active = i < shown;
            if (!data) continue;
            if (row.name) row.name.string = data.name;
            if (row.value) row.value.string = data.valueText;
        }

        if (this.nameLabel) this.nameLabel.string = vm.name;
        if (this.lvLabel) this.lvLabel.string = `Lv.${vm.level}`;
        if (headFrame && this.headIcon) this.headIcon.spriteFrame = headFrame;

        this.node.active = true;
        ezgame.info(`[英雄属性] 显示「${vm.name}」Lv.${vm.level}（${shown}/${this.rows.length} 行）`);
    }

    /** 收起面板 */
    hide(): void {
        if (this.node?.isValid) this.node.active = false;
    }

    /** 当前是否可见（HUD 用它判"该开还是该关"） */
    get visible(): boolean {
        return !!this.node?.isValid && this.node.active;
    }
}

/**
 * 行节点的显示序号（`attr_1` → 0；名字不合规的排到最后，不抛）。
 *
 * ⚠ 必须**按数字**排：字符串排序会把 `attr_11` 排到 `attr_2` 前面，
 * 于是属性表的第 3 条画到了第 11 行的位置上 —— 而两列版式下这种错位肉眼很难发现。
 */
function rowIndexOf(nodeName: string): number {
    const m = /^attr_(\d+)/.exec(nodeName || '');
    if (!m) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, parseInt(m[1], 10) - 1);
}

/**
 * 便捷：确保 HUD 下有一块英雄属性面板（组件没有就挂上去）。
 *
 * 节点来自**预制件**（`hero_properties`，作者摆好位置与结构），所以这里找不到就返回 null、
 * 并把**实际的子节点名**打进日志（便于对照预制件排查），不运行时建节点 ——
 * 位置/结构是策划资产，代码不该自己拼一块（同 `ensureSkillDetailPanel`）。
 */
export function ensureHeroPropertiesPanel(host: Node): HeroPropertiesPanel {
    if (!host?.isValid) return null;

    // ① 认名字（面板节点的唯一真源）；② 没有名字节点时才退回"子树里已经挂过组件"的那个节点
    const named = host.getChildByName(HERO_PROPERTIES_NODE);
    const found = host.getComponentInChildren(HeroPropertiesPanel);
    const node = named ?? found?.node ?? null;

    if (!node) {
        const names = host.children.map((c) => c.name).join(' / ') || '(没有子节点)';
        ezgame.warn(`[英雄属性] ${host.name} 下找不到 ${HERO_PROPERTIES_NODE} 节点（实际子节点：${names}），点英雄头像不会弹属性面板`);
        return null;
    }
    if (found && found.node !== node) {
        ezgame.warn(`[英雄属性] 组件挂在 ${found.node.name} 上，但面板节点是 ${node.name} —— 以 ${node.name} 为准`);
    }

    const panel = node.getComponent(HeroPropertiesPanel) ?? node.addComponent(HeroPropertiesPanel);
    panel.bind();
    return panel;
}
