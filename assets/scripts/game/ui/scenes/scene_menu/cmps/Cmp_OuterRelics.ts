import { _decorator, Color, instantiate, Label, Node } from 'cc';
import { Tabs } from 'db://assets/scripts/platform/ui/Tabs';
import { DataCenter } from '../../../../data';
import { getOuterBonusTotals, getOuterRelics } from '../../../../data/configs/EquipmentConfig';
import { rarityTier } from '../../../../common/RelicRarityColor';
import { OuterRelicItem } from './OuterRelicItem';
import { OuterAttrItem } from './OuterAttrItem';

const { ccclass, property } = _decorator;

/** 生成出来的行节点名前缀（`clearGenerated` 只清这些，作者摆的 summary / header / empty 不动） */
const ROW_PREFIX = 'row_';

/**
 * `Scene_Menu` → 「遗物」页（`content/right/outer_relics`）的页面控制器
 *
 * ── 页面结构（编辑器里的节点契约）──
 * ```
 * outer_relics                ← 本组件挂这里（同时是 Tabs 宿主：tab 与 content 的共同祖先）
 * ├── tabs                    ← tabBarNode：tab_overview / tab_attr
 * └── pages                   ← contentBarNode：overview / attrs（顺序与 tab 一一对应）
 *     ├── overview            ScrollView（总览：所有遗物）
 *     │   └── lists           Layout(V) ← relicList
 *     └── attrs               ScrollView（属性总览：所有遗物属性的总和）
 *         └── lists           Layout(V) ← attrList
 * templates                   active=false 的两个模板节点（不进列表，只当克隆源）
 * ```
 *
 * ── 为什么用「模板节点 + instantiate」而不是在预制件里摆 N 行 ──
 * 局外遗物有 **37 件**（属性总览 9 行），逐行手摆既笨又会在加遗物时忘了补。
 * 模板节点放在 `templates` 下（`active=false`），运行时克隆 —— 行内容仍然在编辑器里看得见、改得动，
 * 而且**不需要新建预制件资产**（省掉一次「等编辑器导入 .meta」）。
 *
 * ── 数据来源（本组件不做任何数值换算）──
 *   · 遗物清单：`getOuterRelics()`（`relics.json` 里 `scope` 含 outer 的 37 件）
 *   · 数量：`DataCenter.ins.equipCollection.getCollectedCount(id)`
 *   · 属性总和：`getOuterBonusTotals()`（内部 = `getAllEquipmentBonuses()` 按属性求和）
 *
 * 继承 `Tabs`（与左侧菜单的 `Cmp_FuncTabs` 同一套路）：两个子 tab 的切换、选中态、
 * content 显隐全由框架管，本类只做「切了要重刷吗」与「列表怎么铺」。
 */
@ccclass('Cmp_OuterRelics')
export class Cmp_OuterRelics extends Tabs {

    /** 「总览」的列表容器（`pages/overview/lists`） */
    @property({ type: Node, tooltip: '总览列表容器（pages/overview/lists）' })
    relicList: Node = null;

    /** 「属性总览」的列表容器（`pages/attrs/lists`） */
    @property({ type: Node, tooltip: '属性总览列表容器（pages/attrs/lists）' })
    attrList: Node = null;

    /** 遗物行的模板节点（`templates/OuterRelicItem`，`active=false`，运行时克隆） */
    @property({ type: Node, tooltip: '遗物行模板（templates/OuterRelicItem）' })
    relicTemplate: Node = null;

    /** 属性行的模板节点（`templates/OuterAttrItem`，`active=false`，运行时克隆） */
    @property({ type: Node, tooltip: '属性行模板（templates/OuterAttrItem）' })
    attrTemplate: Node = null;

    /** 选中态的文字色（与左侧菜单同一套口径） */
    private readonly selectFontColor = new Color('#FFFFFF');
    /** 未选中态的文字色 */
    private readonly unselectFontColor = new Color('#354047');

    /* ==================== 生命周期 ==================== */

    protected onInit(): void {
        // Tabs.onInit 要先把选中态 provide 出去、收集节点并绑点击
        super.onInit();
        // ⚠ 这里**不铺数据**：本页所在节点在运行时是 `active=false` 的（左侧菜单默认选「游戏」），
        // 直到点「遗物」才被激活 —— 那一刻 onLoad→onEnable 连着跑，`onShow` 一定会执行一次。
        // 在 onInit 里再铺一遍就是白铺（37+9 行克隆两次）。
    }

    protected onShow(): void {
        super.onShow();
        // 每次显示都重建：数量是外部数据（`equipCollection` 随时会变），
        // 它不是响应式字段，watch 不到 —— 与 `HeroSelectPanel.checkHeroList` 同一个理由。
        this.rebuildAll();
    }

    /**
     * 选中态表现：**与左侧菜单 `Cmp_FuncTabs` 完全同口径**（`active_bg` 显隐 + `name` 换色），
     * 这样页面内外的 tab 长得一样。框架默认实现是转发给 `TabItem`，本页的 tab 没挂它。
     */
    protected applyTabSelected(tab: Node, _index: number, selected: boolean): void {
        const bg = tab.getChildByName('active_bg');
        if (bg) bg.active = selected;
        const label = tab.getChildByName('name')?.getComponent(Label);
        if (label) label.color = selected ? this.selectFontColor.clone() : this.unselectFontColor.clone();
    }

    /* ==================== 铺列表 ==================== */

    private rebuildAll(): void {
        // 数据层没加载好（TbRoot 未就绪）时**不要**把异常抛到 onLoad 里 —— 那会连带弄坏整个 Scene_Menu；
        // 退化成空页，等下次 onShow 再试。
        try {
            this.rebuildRelics();
            this.rebuildAttrs();
        } catch (err) {
            ezgame.error('[遗物图鉴] 铺列表出错（页面留空，下次显示会重试）', err);
        }
    }

    /**
     * 总览：所有局外遗物，**按品质从高到低**排（图鉴观感），同档按 id 升序。
     * 已收集的正常显示、未收集的整行置灰（置灰在 `OuterRelicItem.setInfo` 里按数量决定）。
     */
    private rebuildRelics(): void {
        const list = this.relicList;
        if (!list || !this.relicTemplate) return;
        this.clearGenerated(list);

        const relics = getOuterRelics()
            .slice()
            .sort((a, b) => rarityTier(b.rarity) - rarityTier(a.rarity) || a.id - b.id);

        const collection = DataCenter.ins.equipCollection;
        let owned = 0;
        for (const cfg of relics) {
            const count = collection.getCollectedCount(cfg.id);
            if (count > 0) owned++;
            const row = this.spawnRow(this.relicTemplate, list, `${ROW_PREFIX}${cfg.id}`);
            row?.getComponent(OuterRelicItem)?.setInfo(cfg, count);
        }

        // 作者摆的汇总行（`lists/summary`）常驻在最上面
        const summary = list.getChildByName('summary');
        if (summary) {
            const label = summary.getComponent(Label);
            if (label) label.string = `已收集 ${owned}/${relics.length}`;
            summary.setSiblingIndex(0);
        }
    }

    /** 属性总览：所有遗物属性加成的**总和**，每种属性一行；一条都没有时显示空态提示 */
    private rebuildAttrs(): void {
        const list = this.attrList;
        if (!list || !this.attrTemplate) return;
        this.clearGenerated(list);

        const rows = getOuterBonusTotals();
        for (const row of rows) {
            const node = this.spawnRow(this.attrTemplate, list, `${ROW_PREFIX}attr_${row.attrId}`);
            node?.getComponent(OuterAttrItem)?.setInfo(row);
        }

        const relics = getOuterRelics();
        const collection = DataCenter.ins.equipCollection;
        const owned = relics.filter((r) => collection.getCollectedCount(r.id) > 0).length;

        // 汇总行（作者摆的 `lists/summary`）：把「这是已收集的总和」写清楚，
        // 免得被读成「所有遗物（含未获得）的总和」—— 那是两个完全不同的数
        const summary = list.getChildByName('summary');
        if (summary) {
            const label = summary.getComponent(Label);
            if (label) label.string = `已收集 ${owned}/${relics.length} —— 下面是已收集遗物的加成总和`;
            summary.setSiblingIndex(0);
        }
        // 表头：用同一个模板写死三个格子名（作者摆的 `lists/header`）
        const header = list.getChildByName('header');
        if (header) {
            header.getComponent(OuterAttrItem)?.setHeader('属性', '固定加成', '百分比加成');
            header.setSiblingIndex(1);
        }
        // 空态提示（作者摆的 `lists/empty`）
        const empty = list.getChildByName('empty');
        if (empty) empty.active = rows.length === 0;
    }

    /** 克隆模板 → 挂到列表 → 返回（模板缺失/组件缺失时返回 null，不抛） */
    private spawnRow(template: Node, parent: Node, name: string): Node | null {
        const node = instantiate(template);
        if (!node) return null;
        node.name = name;
        node.active = true;
        parent.addChild(node);
        return node;
    }

    /**
     * 清掉上一次生成的行。
     *
     * ⚠ 两条都必须做对：
     *   ① **只清 `ROW_PREFIX` 开头的** —— `summary` / `header` / `empty` 是作者摆在预制件里的，
     *      被清掉就再也回不来了（它们不是克隆出来的）；
     *   ② **先 `removeFromParent()` 再 `destroy()`** —— `destroy()` 是**延迟到帧末**执行的，
     *      只调 `destroy()` 的话这一帧内 `list.children` 里新旧行**同时存在**，
     *      `Layout` 会按多出一倍的行算高度、画出重叠的列表（实测过：父节点重复出现两批行）。
     *      `removeFromParent()` 是立即生效的，调完 `children` 就干净了。
     */
    private clearGenerated(list: Node): void {
        for (const child of [...list.children]) {
            if (!child.name.startsWith(ROW_PREFIX)) continue;
            child.removeFromParent();
            child.destroy();
        }
    }
}
