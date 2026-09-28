import { _decorator, Color, Component, Label, Node, Sprite, UITransform } from 'cc';
import { ShopConfig } from '../../../../../data/configs/ShopConfig';
import { describeEffectsAtLevel } from '../../../../../battle/AbilityDesc';

const { ccclass, property } = _decorator;

/** 详情面板节点名（**预制件里作者摆好位置**，HUD 的直接子节点）：`View_Game_Stage/skill_details` */
export const SKILL_DETAILS_NODE = 'skill_details';

/**
 * 「一行 = 一级」的节点名前缀。预制件里是 `lv_detail` / `lv_detail-001` / `lv_detail-002`
 * （Cocos 复制节点的自动命名），所以按前缀扫而不是逐个记全名 —— 再复制一行出来也能认到。
 */
const LEVEL_ROW_PREFIX = 'lv_detail';

/** 行内子节点名（与预制件一致，改名字要同步这里；两个 `lv` 是作者给标签与正文起的同名节点） */
const ROW_TAG_NODE = 'lv_node';
const ROW_DESC_NODE = 'desc_node';
const ROW_TEXT_NODE = 'lv';

/**
 * 当前等级那一档的 `lv` 配色（绿字 = 英雄现在用的就是这一级）。
 * 面板底板是浅色（预制件里正文是 `(19,19,19)` 深灰）→ 用中饱和绿，比纯绿更好读。
 */
const ACTIVE_LEVEL_COLOR = new Color(34, 177, 76, 255);

/** 行高按文案撑高时给文案留的余量（= 相邻两级之间的间距；行高不会小于预制件里作者定的值） */
const ROW_PADDING = 8;

/** 一行（一级）：标签 + 该级文案，以及预制件里作者写的原始颜色/行高（运行时改过要能还原） */
interface LevelRow {
    node: Node;
    /** `lv_node/lv`：等级标签（`lv.1`），当前档染绿 */
    tag: Label;
    /** `desc_node/lv`：该级效果文案 */
    desc: Label;
    /** 预制件里作者给标签定的颜色（当前档染绿后，别的档要还原回它） */
    tagColor: Color;
    /** 预制件里作者定的行高（文案更高时以文案为准，只往上撑、不压扁） */
    height: number;
}

/**
 * SkillDetailPanel —— **长按技能槽弹出的技能详情面板**
 *
 * 节点是**预制件里作者摆好的**（`View_Game_Stage/skill_details`，位置即最终位置，代码不搬它），
 * 本组件由 HUD 在运行时 `addComponent` 挂上去、子节点按名字取（同 `SkillSlot` / `HpBar` 的套路）：
 *
 * ```
 * skill_details              底板 Sprite + 竖向 Layout(CONTAINER) ← 本组件挂在这里
 *   ├─ lv_detail             ← 一行 = 一级
 *   │    ├─ lv_node/lv       等级标签（`lv.1`）
 *   │    └─ desc_node/lv     该级效果文案
 *   ├─ lv_detail-001
 *   └─ lv_detail-002
 * ```
 *
 * 三条口径：
 *   ① **有几级显示几行**（`max_level`）：多出来的行 `active = false` —— 竖向 Layout 是 CONTAINER，
 *      行收起来底板会自己变矮；不收起的话 1 级技能下面会挂两行空白。
 *   ② **当前等级的 `lv` 绿字**：别的档还原成预制件里作者的颜色（同一个行节点会依次给不同技能/等级
 *      复用，所以原始色必须在 `bind()` 时缓存下来，不能"设过一次就算了"）。
 *   ③ **每行文案取该级自己的**（`lv1/lv2/lv3`，没写才按 `effects` 反推）→ 玩家能直接看到升级收益。
 *
 * ⚠ 行高按文案估算撑高（预制件里行高定死 60，而文案 1~4 行不等，不撑就会两行叠字）：
 *   估算只影响**行高**，不裁剪文字（`desc` 是 `RESIZE_HEIGHT`）。
 *
 * ⚠ 生命周期：本组件挂在一个**预制件节点**上，显隐由 HUD 调 `show/hide` 驱动（不是 UIWidget，
 *   因为它不吃 UI 框架的 show/hide 生命周期，也没有 scope 通信需求）。
 */
@ccclass('SkillDetailPanel')
export class SkillDetailPanel extends Component {

    /* ===== 编辑器备用：想在编辑器里拖行节点就填这里（留空 = 按前缀扫子节点） ===== */
    @property([Node])
    levelRows: Node[] = [];

    /** 解析出来的行（`bind()` 之后有效） */
    private rows: LevelRow[] = [];
    private bound = false;

    /** 当前展示的技能（调试/自检用） */
    private shownSkillId = 0;

    /* ===================================================================
     * 绑定（幂等）
     * =================================================================== */

    /**
     * 解析面板里的行与标签（重复调用只做一次）；HUD 在 `addComponent` 之后调一次。
     *
     * 首次绑定后会**先收起面板**：预制件里 `skill_details` 是 `active` 的（作者要看到它才摆得准），
     * 不收起来开局就顶着一块写着示例文案的面板。
     */
    bind(): void {
        if (this.bound) return;
        this.bound = true;

        const rowNodes: Node[] = this.levelRows.length
            ? this.levelRows.slice()
            : this.node.children.filter((child) => child.name.indexOf(LEVEL_ROW_PREFIX) === 0);

        this.rows = [];
        for (const rowNode of rowNodes) {
            if (!rowNode) continue;
            const tag = this.findLabel(rowNode, ROW_TAG_NODE);
            const desc = this.findLabel(rowNode, ROW_DESC_NODE);
            this.rows.push({
                node: rowNode,
                tag,
                desc,
                tagColor: tag ? tag.color.clone() : new Color(0, 0, 0, 255),
                height: rowNode.getComponent(UITransform)?.height ?? 60,
            });
            if (!tag || !desc) {
                ezgame.warn(`[技能详情] 行节点 ${rowNode.name} 缺 ${ROW_TAG_NODE}/${ROW_TEXT_NODE} 或 ${ROW_DESC_NODE}/${ROW_TEXT_NODE}，这一行会缺内容`);
            }
        }
        if (!this.rows.length) {
            // 这条 warn 带实际子节点名：长按没反应时一眼能看出"面板节点找对了、行节点名字不对"
            const names = this.node.children.map((c) => c.name).join(' / ') || '(没有子节点)';
            ezgame.warn(`[技能详情] ${this.node.name} 下没找到 ${LEVEL_ROW_PREFIX}* 行节点（实际子节点：${names}），详情面板会是空的`);
        } else {
            ezgame.info(`[技能详情] ${this.node.name} 绑定 ${this.rows.length} 行（一行 = 一级）`);
        }

        // 面板自己也吃一次点击（点它就收起）—— 面板常驻，得有地方能点掉
        this.node.on(Node.EventType.TOUCH_END, this.onSelfTouchEnd, this);

        this.node.active = false;
    }

    /** 点在面板上 = 收起（长按弹出的面板不因松手收起，所以给它自己一个"点掉"的入口） */
    private onSelfTouchEnd(): void {
        this.hide();
    }

    onDestroy(): void {
        // ⚠ 只断自己这一个监听（面板节点就是本组件的节点，不走 UIComponent.offNodeEvent 那套后代节点的坑）
        const node = this.node;
        if (node?.isValid) node.off(Node.EventType.TOUCH_END, this.onSelfTouchEnd, this);
    }

    /** `行/父节点名/子节点名` → Label（面板里标签与正文的末级节点都叫 `lv`） */
    private findLabel(row: Node, holderName: string): Label {
        return row.getChildByName(holderName)?.getChildByName(ROW_TEXT_NODE)?.getComponent(Label) ?? null;
    }

    /* ===================================================================
     * 显隐
     * =================================================================== */

    /**
     * 展示某个技能的详情：**一行一级**、当前等级绿字。
     *
     * @param skillId abilities.json 的技能 id
     * @param level 当前等级（1 起；肉鸽技能升级后传槽位里的等级）
     */
    show(skillId: number, level = 1): void {
        this.bind();

        const cfg = ShopConfig.getAbility(skillId);
        if (!cfg) {
            ezgame.warn(`[技能详情] 未找到技能配置：${skillId}`);
            return;
        }
        if (!this.rows.length) {
            ezgame.warn(`[技能详情] 技能 ${skillId} 有配置，但 ${this.node.name} 里一行都没有，面板不显示`);
            return;
        }

        const maxLevel = ShopConfig.getSkillMaxLevel(cfg);
        const current = Math.max(1, Math.min(maxLevel, Math.floor(level) || 1));
        // 面板行数 = 技能等级上限（3）；行不够时只显示能显示的那几级，并在控制台点名
        const shown = Math.min(maxLevel, this.rows.length);
        if (maxLevel > this.rows.length) {
            ezgame.warn(`[技能详情] 技能 ${skillId} 有 ${maxLevel} 级，但 ${this.node.name} 只有 ${this.rows.length} 行，多的等级显示不出来`);
        }

        for (let i = 0; i < this.rows.length; i++) {
            const row = this.rows[i];
            const rowLevel = i + 1;
            const visible = rowLevel <= shown;
            row.node.active = visible; // ① 有几级显示几行
            if (!visible) continue;

            if (row.tag) {
                row.tag.string = `lv.${rowLevel}`;
                // ② 当前等级绿字；其余还原成作者的颜色（行节点会被别的技能复用）
                row.tag.color = rowLevel === current ? ACTIVE_LEVEL_COLOR.clone() : row.tagColor.clone();
            }
            // ③ 该级自己的文案
            if (row.desc) row.desc.string = describeEffectsAtLevel(cfg, rowLevel);
            this.fitRow(row);
        }

        this.shownSkillId = skillId;
        this.node.active = true;
        ezgame.info(`[技能详情] 显示「${cfg.name ?? skillId}」Lv.${current}/${maxLevel}（${shown} 行）${this.describeRenderState()}`);
    }

    /**
     * 渲染自检串（跟在那条"显示…"日志后面）。
     *
     * 为什么要它：**"日志说显示了、画面什么都没有"** 这种问题只看代码看不出来，得看运行时的客观状态 ——
     * 在不在场景树上（`activeInHierarchy`）、多大、在世界坐标的哪儿、底图有没有加载出来。
     * 面板尺寸/位置/底图任一项不对，这一串里全能看出来。
     */
    private describeRenderState(): string {
        const node = this.node;
        const ui = node.getComponent(UITransform);
        const sprite = node.getComponent(Sprite);
        const world = node.worldPosition;
        return ` | 树上=${node.activeInHierarchy}`
            + ` 尺寸=${ui ? `${Math.round(ui.width)}x${Math.round(ui.height)}` : '无UITransform'}`
            + ` 世界坐标=(${Math.round(world.x)},${Math.round(world.y)})`
            + ` 底图=${sprite ? (sprite.spriteFrame ? sprite.spriteFrame.name : '空(没加载到)') : '无Sprite'}`;
    }

    /** 收起面板 */
    hide(): void {
        this.shownSkillId = 0;
        if (this.node?.isValid) this.node.active = false;
    }

    /** 当前是否可见 */
    get visible(): boolean {
        return !!this.node?.isValid && this.node.active;
    }

    /**
     * 把一行撑到能装下它的文案（行高只往上撑）：
     * 预制件里的行高是作者按"正常长度文案"定的，长文案（4 行）会溢出到下一级那行上，
     * 而外层是竖向 CONTAINER Layout —— 行变高，底板会跟着长高。
     */
    private fitRow(row: LevelRow): void {
        const rowUi = row.node.getComponent(UITransform);
        const descUi = row.desc?.node?.getComponent(UITransform);
        let rowHeight = row.height;

        if (row.desc && descUi) {
            const width = descUi.width > 0 ? descUi.width : 270;
            const descHeight = SkillDetailPanel.estimateHeight(row.desc.string, width, row.desc.fontSize, row.desc.lineHeight);
            rowHeight = Math.max(row.height, descHeight + ROW_PADDING);
            descUi.setContentSize(width, descHeight);
        }
        if (rowUi) rowUi.setContentSize(rowUi.width, rowHeight);
    }

    /**
     * 估一段文本在定宽里有多高（按「中文一字 ≈ 1em、其余 ≈ 0.55em」估每行字数，行高取 Label 自己的）。
     * 估算只用于行高，偏一两行不会难看；比起"读 `RESIZE_HEIGHT` 的结果"要稳 ——
     * 自动高度是下次渲染提交后才写回 `UITransform` 的，同步读会拿到旧值（第一次长按行高不对、第二次才对）。
     */
    private static estimateHeight(text: string, width: number, fontSize: number, lineHeight: number): number {
        const lh = lineHeight > 0 ? lineHeight : Math.round(fontSize * 1.35);
        if (!text) return lh;
        const perLine = Math.max(1, Math.floor(width / Math.max(1, fontSize)));
        let lines = 0;
        for (const segment of text.split('\n')) {
            // 半角字符按 0.55 个宽算 → 同样宽度能放更多
            let weight = 0;
            for (const ch of segment) weight += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.55;
            lines += Math.max(1, Math.ceil(weight / perLine));
        }
        return lines * lh;
    }
}

/**
 * 便捷：确保 HUD 下有一块详情面板（组件没有就挂上去）。
 *
 * 节点来自**预制件**（`skill_details`，作者摆好位置与结构），所以这里找不到就返回 null、
 * 并把**实际的子节点名**打进日志（便于对照预制件排查），不运行时建节点 ——
 * 位置/结构是策划资产，代码不该自己拼一块。
 */
export function ensureSkillDetailPanel(host: Node): SkillDetailPanel {
    if (!host?.isValid) return null;

    // ① 认名字（面板节点的唯一真源）；② 没有名字节点时才退回"子树里已经挂过组件"的那个节点
    const named = host.getChildByName(SKILL_DETAILS_NODE);
    const found = host.getComponentInChildren(SkillDetailPanel);
    const node = named ?? found?.node ?? null;

    if (!node) {
        const names = host.children.map((c) => c.name).join(' / ') || '(没有子节点)';
        ezgame.warn(`[技能详情] ${host.name} 下找不到 ${SKILL_DETAILS_NODE} 节点（实际子节点：${names}），长按技能槽不会弹详情`);
        return null;
    }
    if (found && found.node !== node) {
        ezgame.warn(`[技能详情] 组件挂在 ${found.node.name} 上，但面板节点是 ${node.name} —— 以 ${node.name} 为准`);
    }

    const panel = node.getComponent(SkillDetailPanel) ?? node.addComponent(SkillDetailPanel);
    panel.bind();
    return panel;
}
