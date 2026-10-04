import { _decorator, Button, Color, instantiate, Label, Node, ScrollView } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { DataCenter } from '../../../../data';
import { AchievementConfig } from '../../../../data/configs/AchievementConfig';
import { AchievementItem } from './AchievementItem';
import { AchScopeEvents } from './AchievementScope';
import type { AchCategoryEntry } from '../../../../data/configs/AchievementConfig';
import type { AchGroupState } from '../../../../data/funcs/AchievementData';

const { ccclass, property } = _decorator;

/** 生成出来的行节点名前缀（`clearGenerated` 只清这些，模板 / 作者摆的节点不动） */
const ROW_PREFIX = 'row_';
/** 分类按钮名 → 分类码（`cat_level` → `level`，与 `ACH_CATEGORY_ORDER` 同一套码） */
const CAT_NODE_PREFIX = 'cat_';

/** 分类条两态色（取自任务界面 `View_TaskUI` 的 tab_daily/tab_weekly 实测值） */
const TAB_ACTIVE_BG = '#3F9E9B';
const TAB_ACTIVE_LABEL = '#FFFFFF';
const TAB_INACTIVE_BG = '#E3E8E8';
const TAB_INACTIVE_LABEL = '#3F9E9B';

/**
 * `Scene_Menu` → 「成就」页（`content/right/achivements`）的页面控制器
 *
 * ── 页面结构（编辑器里的节点契约）──
 * ```
 * achivements                 ← 本组件挂这里（**不再是 ScrollView**，只是页面宿主 + 分类条 + 视口的共同父节点）
 * ├── scroll                  ← 滚动**视口**（546×1186 @ y=-36，上边留出 72 的分类条；Mask 矩形裁切 + ScrollView，content = lists）
 * │   └── lists               ← Layout(V) 成就列表容器（模板卡 + 运行时克隆的 row_*）
 * │       └── card            ← 唯一的卡片 = **克隆模板**（运行时 onInit 置 active=false）
 * └── category_bar            ← 分类条（6 个 cat_* 按钮，每个含 active_bg + name）—— **排在最后**，在滚动区之外，永远压不住
 * ```
 *
 * ⚠⚠ **为什么 ScrollView 必须挂在 `scroll` 这个子节点上、而不是挂在页面上（2026-10-03 进游戏实测连踩两次）**
 *   ① `ScrollView` 的视口**取的是它自己所在的节点**（`view` 这个序列化字段**根本不存在** —— 查过本预制件里
 *      5 个 ScrollView（含能正常工作的 `outer_relics/pages/overview`），只有 `_content`，没有 view 字段；
 *      用代码 `sv.view = 子节点` 设的那一下**只活在内存里，存盘就丢**）；
 *   ② 于是「把页面当视口」时 `_calculateBoundary()` 会把 **content 顶端对齐到页面顶端**（629），
 *      `lists` 被从 557 顶到 629，第一张卡（顶部 619）**正好盖住分类条 557~629** —— 表现就是「分类条看不到」。
 *   所以视口只能**自成节点**：`scroll` 的顶端 = 557 = `lists` 的顶端，两者对齐后互不推挤，
 *   分类条又在这个视口**之外**（Mask 也裁不到它）→ 结构上不可能再被盖住。
 *
 * ── 职责（分层：规则在数据层，本类只做宿主）──
 *   · 分类条选中态（`active_bg` 显隐 + `name` 换色）：**不走第二套 `Tabs` 框架** ——
 *     分类是「过滤条件」而不是「6 个独立页面」，所以照 `View_TaskUI` 的页签口径自己管；
 *   · 取列表数据（`AchievementData.getGroups(category)`）、克隆铺行、把卡片的 `领取` 冒泡转交给数据层；
 *   · **判据不在这里重算**：能不能领、进度多少、效果生不生效全由数据层给（`getGroupState`）。
 *
 * ── 两种兜底（设计稿 §7.3/§7.4）──
 *   · **找不到 `category_bar`** → 退化成「一页到底」：所有分类顺序平铺，每个分类前插一行标题（方案 B）；
 *   · **配表未就绪**（`TbRoot` 没加载完）→ 不抛异常，退化成空页 + 日志，等下次 `onShow` 重试
 *     （抛到 onLoad 里会连带弄坏整个 `Scene_Menu`）。
 *
 * 红点不在本类：左侧功能页签的 `red_dot` 要在**本页隐藏时**也能亮，而本组件挂在隐藏的页面节点上
 * （watcher 随 onDisable 暂停），所以红点由常驻的 `Scene_Menu` 负责。
 */
@ccclass('Cmp_Achievement')
export class Cmp_Achievement extends UIWidget {

    /** 列表容器（`achivements/view/lists`，Layout(V)） */
    @property(Node)
    lists: Node = null;
    /** 卡片模板（`achivements/view/lists/card`，运行时置 active=false 只当克隆源） */
    @property(Node)
    cardTemplate: Node = null;
    /** 分类条（`achivements/category_bar`；**允许为空** → 走方案 B 兜底） */
    @property(Node)
    categoryBar: Node = null;

    /**
     * 滚动视口上的 ScrollView（`achivements/scroll`）。
     * **故意不做成 `@property`**：它只能按名字解析（`scroll` 子节点上那一个），
     * 留一个拖不上的空槽在 Inspector 里反而更像"漏配了"。
     */
    private scrollView: ScrollView = null;

    /** 当前选中的分类码（空串 = 方案 B 的「全部平铺」） */
    private activeCategory = '';
    /** 分类条上按顺序排好的按钮（与 `AchievementConfig.getCategories()` 无关，按节点名反查码） */
    private catButtons: Node[] = [];

    protected onInit(): void {
        this.resolveRefs();
        // 模板不进列表：克隆出来的行统一叫 row_<group>，清行时只清 row_ 前缀（见 clearGenerated）
        if (this.cardTemplate) this.cardTemplate.active = false;
        this.bindCategoryBar();
        this.scope.on(AchScopeEvents.Claim, this.onClaim, this);
        // 进度指纹：任何地方上报进度 / 领奖，都会自动重刷列表，不需要手动广播
        this.scope.watch(() => this.fingerprint(), () => this.rebuild());
        // 常驻一行自检日志：页面「什么都没有」时，控制台这几行能区分是「组件没跑」还是「配表没加载」
        console.log(`[成就页] onInit：lists=${!!this.lists} cardTemplate=${!!this.cardTemplate} `
            + `categoryBar=${!!this.categoryBar} scrollView=${!!this.scrollView}`);
    }

    protected onShow(): void {
        // 「不需要打一局就会变」的那几条（账号等级 / 连续登录 / 图鉴 / 种类数）每次进页面都对齐一次
        DataCenter.ins.achieveData.syncNonRunPeaks();
        this.ensureCategory();
        console.log(`[成就页] onShow：配表就绪=${AchievementConfig.isReady()}，`
            + `分类=${this.activeCategory || '(全部)'}，分类按钮=${this.catButtons.length} 个`);
        this.rebuild();
    }

    /* ===================================================================
     * 交互
     * =================================================================== */

    private bindCategoryBar(): void {
        if (!this.categoryBar) {
            console.warn('[成就页] 预制件里没有 category_bar → 退化成「一页到底」（方案 B）');
            return;
        }
        for (const child of this.categoryBar.children) {
            if (!child.name.startsWith(CAT_NODE_PREFIX)) continue;
            this.catButtons.push(child);
            child.on(Button.EventType.CLICK, this.onClickCategory, this);
        }
    }

    /** 分类按钮点击（Button 的 CLICK 事件回传的就是 Button 组件本身） */
    private onClickCategory(button: Button): void {
        const node = button?.node;
        const code = node?.name?.startsWith(CAT_NODE_PREFIX) ? node.name.slice(CAT_NODE_PREFIX.length) : '';
        if (!code || code === this.activeCategory) return;
        this.activeCategory = code;
        this.applyCategoryBar();
        this.rebuild();
    }

    /**
     * 领奖（宿主职责）：**先问数据层能不能领**，再按结果刷新。
     * 失败原因是数据层的判据（已领取 / 下一档未达成 / 未知成就），界面不自己重算一遍。
     */
    private onClaim(group: string): void {
        const res = DataCenter.ins.achieveData.claim(group);
        if (!res.ok) {
            ezgame.warn(`[成就] 领取失败：${res.reason}（group=${group}）`);
        } else {
            ezgame.info(`[成就] 领取成功：${group} 第 ${res.tier} 档，+${res.gold} 金币`);
        }
        this.rebuild();   // 成败都重刷（失败时可能只是状态过期）
    }

    /* ===================================================================
     * 铺列表
     * =================================================================== */

    /** 选定默认分类：表里的第一个（且必须真的存在于预制件的分类条上） */
    private ensureCategory(): void {
        const entries = AchievementConfig.getCategories();
        if (!this.categoryBar) {
            this.activeCategory = '';     // 方案 B：全部平铺
            return;
        }
        if (entries.some(e => e.code === this.activeCategory)) return;
        this.activeCategory = entries.length ? entries[0].code : '';
    }

    private rebuild(): void {
        const list = this.lists;
        if (!list) {
            // 节点契约断了：报出来（这条最容易在改预制件结构时踩到）
            const msg = '[成就页] 找不到列表容器（achivements/scroll/lists），页面无法渲染';
            console.error(msg);
            ezgame.error(msg);
            return;
        }

        if (!AchievementConfig.isReady()) {
            // 配表未就绪：**不要抛异常**（抛进 onLoad 会连带弄坏整个 Scene_Menu），
            // 但也**不许留白页** —— 留一张占位卡把原因写在屏幕上，下次 onShow 会重试
            this.clearGenerated(list);
            this.showNotice(list, '配表未就绪', 'TbRoot 还没加载完成，重新进入本页会重试');
            const msg = '[成就页] 配表未就绪（TbRoot 还没加载完），页面留空，下次显示会重试';
            console.error(msg);
            ezgame.error(msg);
            return;
        }

        this.applyCategoryBar();
        this.clearGenerated(list);

        let rows = 0;
        if (this.categoryBar) {
            const groups = DataCenter.ins.achieveData.getGroups(this.activeCategory);
            for (const state of groups) {
                if (this.spawnRow(list, state)) rows++;
            }
        } else {
            // 方案 B 兜底：按分类顺序平铺 + 每个分类前插一行标题
            for (const entry of AchievementConfig.getCategories()) {
                const groups = DataCenter.ins.achieveData.getGroups(entry.code);
                if (!groups.length) continue;
                this.spawnTitleRow(list, entry);
                for (const state of groups) {
                    if (this.spawnRow(list, state)) rows++;
                }
            }
        }

        if (rows === 0) {
            // 配表就绪却一行都没有：也是异常态（分类码对不上 / 全被隐藏过滤），别留白页
            this.showNotice(list, '本分类暂无成就', `分类=${this.activeCategory || '(全部)'}，配表里没有对应行`);
        }
        console.log(`[成就页] 铺行完成：分类=${this.activeCategory || '(全部)'}，共 ${rows} 行`);
        this.scrollToTop();
    }

    /**
     * 空态兜底：克隆一张占位卡，把「为什么没有内容」直接写在屏幕上。
     *
     * ⚠ 这条不是装饰 —— 之前「配表未就绪」的路径是**整页空白**，从画面上分不清
     *   「组件根本没跑」/「配表没加载」/「节点契约断了」，只能靠翻控制台。留一张带文案的卡就一眼能看出来。
     */
    private showNotice(list: Node, name: string, desc: string): void {
        const node = this.spawnFromTemplate(list, `${ROW_PREFIX}notice`);
        if (!node) return;
        const item = node.getComponent(AchievementItem);
        if (item) item.enabled = false;            // 占位卡不参与数据下发与点击
        const nameLabel = node.getChildByName('name')?.getComponent(Label);
        if (nameLabel) nameLabel.string = name;
        const detail = node.getChildByName('detail')?.getChildByName('Label')?.getComponent(Label);
        if (detail) detail.string = desc;
        const unlock = node.getChildByName('unlock');
        if (unlock) unlock.active = false;
        const lock = node.getChildByName('icon')?.getChildByName('lock');
        if (lock) lock.active = false;
    }

    /** 克隆模板 → 挂到列表 → 下发数据（模板/组件缺失时返回 null，不抛） */
    private spawnRow(list: Node, state: AchGroupState): Node | null {
        const node = this.spawnFromTemplate(list, `${ROW_PREFIX}${state.group}`);
        if (!node) return null;
        const item = node.getComponent(AchievementItem) ?? node.addComponent(AchievementItem);
        item.setInfo(state);
        return node;
    }

    /** 方案 B 的标题行：克隆模板后只留 `name`（其余全部收起），不挂 `AchievementItem` */
    private spawnTitleRow(list: Node, entry: AchCategoryEntry): void {
        const node = this.spawnFromTemplate(list, `${ROW_PREFIX}title_${entry.code}`);
        if (!node) return;
        for (const child of node.children) child.active = child.name === 'name';
        const label = node.getChildByName('name')?.getComponent(Label);
        if (label) label.string = entry.name;
    }

    private spawnFromTemplate(list: Node, name: string): Node | null {
        const template = this.cardTemplate ?? list.getChildByName('card');
        if (!template) {
            ezgame.error('[成就页] 找不到卡片模板（lists/card），列表无法铺开');
            return null;
        }
        const node = instantiate(template);
        if (!node) return null;
        node.name = name;
        node.active = true;
        list.addChild(node);
        return node;
    }

    /**
     * 清掉上一次生成的行。
     *
     * ⚠ 两条都必须做对（与 `Cmp_OuterRelics.clearGenerated` 同坑）：
     *   ① **只清 `ROW_PREFIX` 开头的** —— `card` 模板是作者摆在预制件里的，被清掉就再也回不来了；
     *   ② **先 `removeFromParent()` 再 `destroy()`** —— `destroy()` 延迟到帧末执行，
     *      只调它会让这一帧内 `Layout` 按新旧两批行算高度、画出重叠的列表。
     */
    private clearGenerated(list: Node): void {
        for (const child of [...list.children]) {
            if (!child.name.startsWith(ROW_PREFIX)) continue;
            child.removeFromParent();
            child.destroy();
        }
    }

    /** 分类条两态：选中 = 青底白字，未选中 = 浅灰底青字（与任务界面同一套色） */
    private applyCategoryBar(): void {
        if (!this.categoryBar) return;
        for (const btn of this.catButtons) {
            const code = btn.name.slice(CAT_NODE_PREFIX.length);
            const selected = code === this.activeCategory;
            const bg = btn.getChildByName('active_bg');
            if (bg) bg.active = selected;
            // 底色写进 Button 的 normalColor（只改 Sprite 会被 Color 过渡冲掉，见 AGENTS.md 的 UI 组件坑）
            const button = btn.getComponent(Button);
            if (button) {
                button.transition = Button.Transition.NONE;
                button.normalColor = new Color().fromHEX(selected ? TAB_ACTIVE_BG : TAB_INACTIVE_BG);
            }
            const label = btn.getChildByName('name')?.getComponent(Label);
            if (label) label.color = new Color().fromHEX(selected ? TAB_ACTIVE_LABEL : TAB_INACTIVE_LABEL);
        }
    }

    /**
     * 切分类/重刷后回到顶部（内容比视口短时是空操作）。
     *
     * ⚠ `scrollToTop()` 对齐的是 **ScrollView 所在节点（`scroll`）的顶端**，所以 ScrollView 必须挂在
     *   `scroll` 上而不是页面上（见类头那段：挂在页面上时这一步会把列表顶到分类条上面去）。
     *   现在两者顶端都是 557，是同一个位置。
     */
    private scrollToTop(): void {
        const sv = this.scrollView;
        if (sv && sv.isValid) sv.scrollToTop(0);
    }

    /**
     * 进度指纹 —— watcher 的订阅源：**只要它变了就重刷界面**。
     * 用「group:进度:已领档」拼串而不是 deep watch：读到的字段就是真实依赖，改动一处也只刷一次
     * （与 `View_TaskUI.progressFingerprint` 同套路）。
     */
    private fingerprint(): string {
        const data = DataCenter.ins.achieveData;
        return AchievementConfig.getAll()
            .map(g => {
                const s = data.getGroupState(g.group);
                return s ? `${s.group}:${s.progress}:${s.claimedTier}` : g.group;
            })
            .join(',');
    }

    /* ===================================================================
     * 节点契约
     * =================================================================== */

    /** 按名字兜底解析节点（编辑器里没拖 `@property` 也能跑） */
    private resolveRefs(): void {
        const n = this.node;
        this.lists = this.lists ?? n.getChildByPath('scroll/lists') ?? n.getChildByName('lists');
        this.cardTemplate = this.cardTemplate ?? this.lists?.getChildByName('card');
        this.categoryBar = this.categoryBar ?? n.getChildByName('category_bar');
        // ScrollView 挂在**视口子节点**上（不能挂在页面上，见类头 ⚠⚠）；兜底再找自己身上那份
        this.scrollView = this.scrollView ?? n.getChildByName('scroll')?.getComponent(ScrollView) ?? n.getComponent(ScrollView);
    }

    protected onDispose(): void {
        for (const btn of this.catButtons) {
            this.offNodeEvent(btn, Button.EventType.CLICK, this.onClickCategory, this);
        }
        this.catButtons = [];
    }
}
