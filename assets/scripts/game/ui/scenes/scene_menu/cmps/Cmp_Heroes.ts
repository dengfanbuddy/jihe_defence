import { _decorator, instantiate, Label, Node, Widget } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { DataCenter, CurrencyType } from '../../../../data';
import { HeroConfig } from '../../../../data/configs/HeroConfig';
import { HeroCard } from './HeroCard';
import { HeroScopeEvents, type HeroCardVM } from './HeroScope';
import type { UnitCfg } from '../../../../excel_table/Tb_UnitConfig';

const { ccclass, property } = _decorator;

/** 生成出来的行节点名前缀（`clearGenerated` 只清这些，模板不动） */
const ROW_PREFIX = 'row_';

/**
 * `Widget.AlignFlags` 里的 TOP | BOTTOM（引擎定义是 `1 << 0 | 1 << 2` = **5**）。
 *
 * 为什么写数值而不是枚举：`cc` 没有把 `AlignFlags` 导出成可 import 的枚举（`Widget.AlignFlags` 在
 * 3.8.6 的类型声明里也取不到），而预制件里存的就是这个位掩码（`lists._alignFlags = 45` = 上下左右全拉伸）。
 */
const WIDGET_VERTICAL_STRETCH = 1 | 4;

/**
 * `Scene_Menu` → 「英雄」页（`content/right/heros`）的页面控制器
 *
 * ── 页面结构（编辑器里的节点契约）──
 * ```
 * heros                       ← `Cmp_Heroes` 挂这里（**本身就是 ScrollView**，content = lists）
 * └── lists                   ← Layout(V) 列表容器（模板行 + 运行时克隆的 row_*）
 *     └── HeroItem            ← 唯一的卡片 = **克隆模板**（运行时 onInit 置 active=false）
 * ```
 * 与 `Cmp_Achievement` / `Cmp_OuterRelics` 同一套路：**模板节点跟随预制件**（作者摆的卡片
 * 在编辑器里看得见、改得动），运行时克隆；克隆只清 `row_` 前缀的行，模板永不删。
 *
 * ── 本类负责什么（分层：规则在数据层，界面只画 + 上报）──
 *   · 取英雄清单（`HeroConfig.getHeroes()`，units.json 里 category=hero 的条目，id 升序）；
 *   · 给每张卡算**整包数据**（`HeroCardVM`）：等级 / 是否解锁 / 这一步的价格 / **能不能点**；
 *     ⚠ 「够不够钱」这条判据**只在本类算一次**（`buildVM`），卡片只画，不重算；
 *   · 收卡片的事件（解锁 / 升级 / 详情）→ 调 `DataCenter.ins.unlockHero / levelUpHero`（金币的唯一出口）；
 *   · 详情互斥：同时只展开一张卡（谁展开由这里说了算，卡片只被动接受 `setExpanded`）。
 *
 * ── 挂载方式 ──
 * 本组件挂在 `content/right/heros` 上；卡片组件 `HeroCard` **不需要**在编辑器里挂 ——
 * 克隆出来的行会按需 `addComponent(HeroCard)`（同 `Cmp_Achievement.spawnRow` 的做法）。
 * 页面节点在没选中「英雄」页签时是 `active=false`，所以 `onInit` 里**不铺数据**：
 * 首次点进来时 onLoad→onEnable 连着跑，`onShow` 一定会执行一次。
 */
@ccclass('Cmp_Heroes')
export class Cmp_Heroes extends UIWidget {

    /** 列表容器（`heros/lists`，Layout(V)） */
    @property({ type: Node, tooltip: '列表容器（heros/lists）' })
    lists: Node = null;

    /** 卡片模板（`heros/lists/HeroItem`，运行时置 active=false 只当克隆源） */
    @property({ type: Node, tooltip: '卡片模板（heros/lists/HeroItem）' })
    cardTemplate: Node = null;

    /** 克隆出来的卡片（详情互斥、重刷时逐张写状态用） */
    private items: HeroCard[] = [];

    /** 当前展开详情的英雄（0 = 全收起；重刷后要恢复） */
    private expandedHeroId = 0;

    /* ==================== 生命周期 ==================== */

    protected onInit(): void {
        this.resolveRefs();
        this.detachListWidget();
        // 模板不进列表：克隆出来的行统一叫 row_<heroId>，清行时只清 row_ 前缀（见 clearGenerated）
        if (this.cardTemplate) this.cardTemplate.active = false;

        this.scope.on(HeroScopeEvents.Unlock, this.onClickUnlock, this);
        this.scope.on(HeroScopeEvents.LevelUp, this.onClickLevelUp, this);
        this.scope.on(HeroScopeEvents.Detail, this.onClickDetail, this);

        // 数据指纹：金币（够不够钱）/ 已解锁集合 / 等级，任一变化就重铺 —— 不需要手动广播
        this.scope.watch(() => this.fingerprint(), () => this.rebuild());

        // 常驻一行自检日志：页面"什么都没有"时，能区分是「组件没跑」还是「配表没加载」
        console.log(`[英雄页] onInit：lists=${!!this.lists} cardTemplate=${!!this.cardTemplate}`);
    }

    protected onShow(): void {
        this.rebuild();
    }

    /* ===================================================================
     * 铺列表
     * =================================================================== */

    private rebuild(): void {
        const list = this.lists;
        if (!list) {
            const msg = '[英雄页] 找不到列表容器（heros/lists），页面无法渲染';
            console.error(msg);
            ezgame.error(msg);
            return;
        }

        this.clearGenerated(list);
        this.items = [];

        // 配表未就绪：**不要抛异常**（抛进 onLoad 会连带弄坏整个 Scene_Menu），
        // 也不留白页 —— 留一张占位卡把原因写在屏幕上，下次 onShow 会重试
        if (!HeroConfig.isReady()) {
            this.showNotice(list, '配表未就绪', 'TbRoot 还没加载完成，重新进入本页会重试');
            const msg = '[英雄页] 配表未就绪（TbRoot 还没加载完），页面留空，下次显示会重试';
            console.error(msg);
            ezgame.error(msg);
            return;
        }

        const heroes = HeroConfig.getHeroes();
        for (const cfg of heroes) {
            this.spawnRow(list, cfg);
        }

        if (heroes.length === 0) {
            this.showNotice(list, '没有英雄', 'units.json 里没有 category=hero 的条目');
        }
        console.log(`[英雄页] 铺行完成：共 ${this.items.length} 张卡（已解锁 `
            + `${DataCenter.ins.heroData.getUnlocked().length} 个）`);
    }

    /** 克隆模板 → 挂到列表 → 下发整包数据（模板缺失时返回 null，不抛） */
    private spawnRow(list: Node, cfg: UnitCfg): Node | null {
        const node = this.spawnFromTemplate(list, `${ROW_PREFIX}${cfg.id}`);
        if (!node) return null;

        // 模板上没挂 HeroCard（不要求作者在编辑器里挂）→ 运行时补一个
        const card = node.getComponent(HeroCard) ?? node.addComponent(HeroCard);
        card.setInfo(this.buildVM(cfg));
        // 重刷后恢复详情态（互斥由 expandedHeroId 决定，见 onClickDetail）
        card.setExpanded(this.expandedHeroId === cfg.id);
        this.items.push(card);
        return node;
    }

    /** 空态兜底：克隆一张占位卡，把「为什么没有内容」写在屏幕上（同 Cmp_Achievement.showNotice） */
    private showNotice(list: Node, name: string, desc: string): void {
        const node = this.spawnFromTemplate(list, `${ROW_PREFIX}notice`);
        if (!node) return;
        const card = node.getComponent(HeroCard);
        if (card) card.enabled = false;             // 占位卡不参与数据下发与点击
        const nameLabel = node.getChildByName('name')?.getComponent(Label);
        if (nameLabel) nameLabel.string = name;
        const detail = node.getChildByName('detail')?.getChildByName('Label')?.getComponent(Label);
        if (detail) detail.string = desc;
        const unlock = node.getChildByName('unlock');
        if (unlock) unlock.active = false;
        const lock = node.getChildByName('icon')?.getChildByName('lock');
        if (lock) lock.active = false;
        // 占位卡没有数据，等级与经验条一律收起（否则会留着预制件里的示例值「1」和半条进度）
        const lv = node.getChildByName('lv');
        if (lv) lv.active = false;
        const expBar = node.getChildByName('exp_bar');
        if (expBar) expBar.active = false;
    }

    private spawnFromTemplate(list: Node, name: string): Node | null {
        const template = this.cardTemplate ?? list.getChildByName('HeroItem');
        if (!template) {
            ezgame.error('[英雄页] 找不到卡片模板（heros/lists/HeroItem），列表无法铺开');
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
     * ⚠ 两条都必须做对（与 `Cmp_Achievement` / `Cmp_OuterRelics` 同坑）：
     *   ① **只清 `ROW_PREFIX` 开头的** —— `HeroItem` 模板是作者摆在预制件里的，清掉就再也回不来了；
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

    /* ===================================================================
     * 卡片数据包（判据唯一落点）
     * =================================================================== */

    /**
     * 一张卡的整包数据。**「够不够钱」只在这里算**（卡片与页面因此永远不会各说一套）。
     *
     * 价格为 0（配表把基准价配成 0）= 免费，永远可点。
     */
    private buildVM(cfg: UnitCfg): HeroCardVM {
        const info = DataCenter.ins.heroData.getHeroInfo(cfg.id);
        const unlocked = !!info;
        const level = info?.level ?? 0;
        const cost = unlocked ? HeroConfig.getLevelUpCost(level) : HeroConfig.getUnlockCost(cfg.id);
        const gold = DataCenter.ins.itemData.getCurrency(CurrencyType.Gold);

        return {
            heroId: cfg.id,
            name: cfg.name,
            headIcon: cfg.head_icon,
            skillIcon: HeroConfig.getSkillIcons(cfg.id)[0] ?? '',
            unlocked,
            level,
            // 经验条：当前经验 / 升下一级所需（公式唯一落在 `HeroData.getExpForNextLevel`，
            // 与结算用的同一个）。未解锁没有档案 → expMax=0，卡片据此收起进度条
            exp: info?.exp ?? 0,
            expMax: unlocked ? DataCenter.ins.heroData.getExpForNextLevel(level) : 0,
            cost,
            enabled: cost <= 0 || gold >= cost,
            // 未解锁时按 1 级展示（卡片会把 `lv` 收起，属性行显示的仍是"他 1 级时的样子"）
            attrs: HeroConfig.getAttrRows(cfg.id, Math.max(1, level)),
        };
    }

    /* ===================================================================
     * 卡片事件（花钱的地方）
     * =================================================================== */

    /** 点「解 锁」：走 `DataCenter`（查价 → 扣局外金币 → 写存档） */
    private onClickUnlock(heroId: number): void {
        const res = DataCenter.ins.unlockHero(heroId);
        this.reportResult('解锁', heroId, res.ok, res.reason, res.cost);
        this.rebuild();          // 成败都重刷（失败时可能只是状态过期）
    }

    /** 点「升 级」：同上，价格随等级上涨 */
    private onClickLevelUp(heroId: number): void {
        const res = DataCenter.ins.levelUpHero(heroId);
        this.reportResult('升级', heroId, res.ok, res.reason, res.cost);
        this.rebuild();
    }

    /** 点「详 情 / 收 起」：**互斥在这一处**（点开第二张时第一张自动收起） */
    private onClickDetail(heroId: number, expanded: boolean): void {
        this.expandedHeroId = expanded ? heroId : 0;
        for (const card of this.items) {
            if (!card || !card.isValid) continue;
            card.setExpanded(card.getHeroId() === this.expandedHeroId);
        }
    }

    /** 失败原因是数据层给的判据（钱不够 / 已解锁 / 未解锁），界面不自己重算一遍 */
    private reportResult(action: string, heroId: number, ok: boolean, reason: string, cost: number): void {
        const name = HeroConfig.getHero(heroId)?.name ?? `id=${heroId}`;
        if (ok) {
            ezgame.info(`[英雄] ${name} ${action}成功（消耗 ${cost} 金币）`);
            return;
        }
        ezgame.warn(`[英雄] ${name} ${action}失败：${this.reasonText(reason)}`);
    }

    private reasonText(reason: string): string {
        switch (reason) {
            case 'no_gold': return '局外金币不足';
            case 'already_unlocked': return '已经解锁了';
            case 'locked': return '还没解锁';
            case 'unknown_hero': return '配表里没有这个英雄';
            default: return reason || '未知原因';
        }
    }

    /* ===================================================================
     * 节点契约
     * =================================================================== */

    /** 按名字兜底解析节点（编辑器里没拖 `@property` 也能跑） */
    private resolveRefs(): void {
        const n = this.node;
        this.lists = this.lists ?? n.getChildByName('lists');
        this.cardTemplate = this.cardTemplate ?? this.lists?.getChildByName('HeroItem');
    }

    /**
     * ⚠⚠ **`lists` 上多挂了一个 Widget（上下左右全拉伸 + `alignMode = ALWAYS`），会把列表压死** ——
     * 它每帧把节点高对齐回 `视口高 1258 - bottom 1044 = 214`，而 `Layout(CONTAINER)` 只在"脏"的那一帧
     * 把高度撑到内容高（10 张卡 ≈ 2140）。两者抢同一件事的结果：**只在第一张卡上停住、列表滚不动**
     * （`ScrollView` 的 content 高就是那个 214）。
     *
     * 另外三页的列表容器（`achivements/scroll/lists`、`outer_relics/pages/…/lists`、`game/lists/contents`）
     * 都**只有 Layout、没有 Widget** —— 所以这不是框架要求，是这一页多出来的。
     *
     * 这里做**最小运行时兜底**：只摘掉上/下两条对齐（保留左右拉伸，宽度口径一个字不变），
     * 高度重新归 Layout 管。**想彻底干净就在编辑器里把这个 Widget 删掉** —— 那时本方法是空操作。
     */
    private detachListWidget(): void {
        const widget = this.lists?.getComponent(Widget);
        if (!widget) return;
        const verticalStretch = (widget.alignFlags & WIDGET_VERTICAL_STRETCH) !== 0;
        if (!verticalStretch) return;
        widget.alignFlags &= ~WIDGET_VERTICAL_STRETCH;
        console.log('[英雄页] lists 上的 Widget 上下拉伸会压死 Layout 的高度（列表滚不动），已摘掉上/下对齐；'
            + '建议直接在编辑器里删掉这个 Widget');
    }

    /**
     * 数据指纹 —— watcher 的订阅源：**只要它变了就重铺界面**。
     * 用「金币 + 已解锁集合 + 等级 + 经验」拼串而不是 deep watch：读到的字段就是真实依赖，
     * 改动一处也只刷一次（与 `Cmp_Achievement.fingerprint` 同套路）。
     *
     * ⚠ `exp` 必须进指纹：一局结束发经验后只有它变（等级还是老的），漏了它经验条就一直停在旧值。
     */
    private fingerprint(): string {
        const gold = DataCenter.ins.itemData.getCurrency(CurrencyType.Gold);
        const records = DataCenter.ins.heroData.getUnlocked()
            .map((r) => `${r.id}:${r.level}:${r.exp}`)
            .join(',');
        return `${gold}|${records}`;
    }
}
