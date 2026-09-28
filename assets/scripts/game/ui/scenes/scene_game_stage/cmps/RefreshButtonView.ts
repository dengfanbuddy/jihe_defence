import { Button, Color, Label, Node, Sprite } from 'cc';
import type { RefreshGate } from '../../../../battle/RefreshGate';

/**
 * RefreshButtonView —— 三个商店面板共用的**刷新按钮表现**（纯函数，不持有任何状态）
 *
 * 提取原因：`HeroSelectPanel` / `ShopRelicsPanel` / `ShopBuffPanel` 里的 `refreshRefreshButton()`
 * 曾经是**逐字相同**的三份（连配色常量都各写了一遍），而"判据"这件事已经被
 * `RefreshGate` 收口到功能类 —— 这里只负责把判据画到节点上，不做任何判断。
 *
 * 分工：
 *   功能类（`HeroSelect` / `RelicShop` / `BuffShop`）→ `refreshGate()` 算出 enabled / canPay / viaAd
 *   本函数 → 按判据写 interactable、灰化、按钮文案、费用数字与颜色
 *
 * ⚠ 面板的 watcher 一定要 watch `refreshButtonKey(gate, cost)`（含 cost），否则费用变了不会重画 —— 见 `RefreshGate.ts`。
 */

/** 刷新按钮可点 / 置灰时的配色（按钮底图是深色 Sprite，置灰就调亮它） */
const BTN_ENABLED_COLOR = new Color(255, 255, 255, 255);
const BTN_DISABLED_COLOR = new Color(124, 124, 124, 255);
/** 费用文字的两种颜色：够钱（原色）/ 不够钱（红） */
const COST_ENOUGH_COLOR = new Color(106, 105, 107, 255);
const COST_LACK_COLOR = new Color(255, 60, 60, 255);

/** 一个面板的刷新按钮三件套（面板把自己拖的引用传进来即可；缺哪个就跳过哪个） */
export interface RefreshButtonNodes {
    /** 按钮根节点（挂 `Button` + 底图 `Sprite`） */
    btnNode: Node | null;
    /** 按钮上的文字：金币够 = 「刷新」、不够但有广告次数 = 「看广告」 */
    btnLabel: Label | null;
    /** 费用数字 */
    costLabel: Label | null;
}

/**
 * 按判据画一次刷新按钮。
 *
 * @param nodes 面板的三个节点引用（允许为空，各段独立跳过）
 * @param gate 功能类算出的判据（`null` = 门面没注入到 → 一律按"不可点"画）
 * @param cost 本次刷新费用（`refreshCost` 的当前值）
 */
export function applyRefreshButton(nodes: RefreshButtonNodes, gate: RefreshGate | null, cost: number): void {
    const enabled = !!gate && gate.enabled;
    const canPay = !!gate && gate.canPay;
    const viaAd = !!gate && gate.viaAd;

    if (nodes.btnNode) {
        const btn = nodes.btnNode.getComponent(Button);
        if (btn) btn.interactable = enabled;
        const sprite = nodes.btnNode.getComponent(Sprite);
        if (sprite) sprite.color = (enabled ? BTN_ENABLED_COLOR : BTN_DISABLED_COLOR).clone();
    }
    if (nodes.btnLabel) {
        // 金币够 → 「刷新」；不够但有广告次数 → 「看广告」；都不行 → 保持「刷新」（配合置灰）
        nodes.btnLabel.string = canPay ? '刷新' : (viaAd ? '看广告' : '刷新');
        nodes.btnLabel.color = (enabled ? BTN_ENABLED_COLOR : BTN_DISABLED_COLOR).clone();
    }
    if (nodes.costLabel) {
        nodes.costLabel.string = `${cost}`;
        nodes.costLabel.color = (canPay ? COST_ENOUGH_COLOR : COST_LACK_COLOR).clone();
    }
}
