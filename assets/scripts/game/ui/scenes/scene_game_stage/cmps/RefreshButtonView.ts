import { Button, Color, Label, Node, resources, Sprite, SpriteFrame } from 'cc';
import type { RefreshGate } from '../../../../battle/RefreshGate';
import { formatNumber } from '../../../../common/GoldText';

/**
 * RefreshButtonView —— 三个商店面板共用的**刷新按钮表现**（纯函数，不持有任何状态）
 *
 * 提取原因：`HeroSelectPanel` / `ShopRelicsPanel` / `ShopBuffPanel` 里的 `refreshRefreshButton()`
 * 曾经是**逐字相同**的三份（连配色常量都各写了一遍），而"判据"这件事已经被
 * `RefreshGate` 收口到功能类 —— 这里只负责把判据画到节点上，不做任何判断。
 *
 * 分工：
 *   功能类（`HeroSelect` / `RelicShop` / `BuffShop`）→ `refreshGate()` 算出 enabled / canPay / viaAd
 *   本函数 → 按判据写 interactable、灰化、按钮文案、费用数字与**费用图标**
 *
 * ── 费用图标（五态，只换图不改布局）──
 *   ① 还有**免费刷新**次数（`viaFree`，开局白送的那种）→ 保持**货币图标**，费用数字换成「免费」
 *      （⚠ **按钮文案不动**，原因见 `applyRefreshButton` 里那段：按钮框只有 60px 宽）
 *   ② 货币够 → 货币图标（金币 / 击杀数；由面板通过 `costIconPath` 指定，不传 = 保持预制件原样）
 *   ③ 货币不够但背包里有**局内广告券**（`viaTicket`）→ **券图标**（`textures/common/ad_ticket`）＋ 文案「用 券」
 *   ④ 货币不够、没券但能看广告（`viaAd`）→ **广告图标**（`textures/common/ad`）
 *      —— 玩家口径：「金币不足时要显示看广告的图标，不然以为是花金币」。
 *      图标与货币图标同尺寸（都是 200×200），所以直接换 `spriteFrame` 不会让布局跳。
 *   ⑤ 都不行（置灰）→ 货币图标（价格仍然是有意义的信息）
 *
 * ⚠ **`viaFree` 时绝不画广告 / 券图标**：那两种图标是在回答"这一下要花什么"，
 *   而免费那一下什么都不花 —— 画成广告图标玩家会以为"白送的还得看视频"。
 *   这条由 `evaluateRefreshGate` 的分支互斥保证（`viaFree` 为真时 `viaTicket`/`viaAd` 恒 false）。
 *
 * ⚠ 面板的 watcher 一定要 watch `refreshButtonKey(gate, cost)`（含 cost、`viaTicket` 与 `viaFree`），
 *   否则费用变了 / 有券了 / 白送次数到账了都不会重画 —— 见 `RefreshGate.ts`。
 */

/** 刷新按钮可点 / 置灰时的配色（按钮底图是深色 Sprite，置灰就调亮它） */
const BTN_ENABLED_COLOR = new Color(255, 255, 255, 255);
const BTN_DISABLED_COLOR = new Color(124, 124, 124, 255);
/** 费用文字的两种颜色：够钱（原色）/ 不够钱（红） */
const COST_ENOUGH_COLOR = new Color(106, 105, 107, 255);
const COST_LACK_COLOR = new Color(255, 60, 60, 255);

/** 广告图标（`resources` 相对路径，不带扩展名）——`viaAd` 时顶替货币图标 */
export const AD_ICON_PATH = 'textures/common/ad';
/**
 * **局内广告券**图标 —— `viaTicket` 时顶替货币图标（第三态「用 券」）。
 * 与商城 A6 发的那张券是同一张图（背包里也用它），语义一眼能连上。
 */
export const TICKET_ICON_PATH = 'textures/common/ad_ticket';
/** 金币图标（预制件里 `refresh/icon` 的默认图；面板不传 `costIconPath` 时按它还原） */
export const GOLD_ICON_PATH = 'textures/common/gold';
/**
 * 击杀数图标 —— 与 HUD 的 `money/kill/icon` **同一张图**（那处预制件引用的就是它）。
 * 击杀商店的刷新费与 Buff 价格都是**击杀数**，用它才不会让玩家以为在花金币。
 */
export const KILL_ICON_PATH = 'textures/common/monster';

/** 一个面板的刷新按钮三件套（面板把自己拖的引用传进来即可；缺哪个就跳过哪个） */
export interface RefreshButtonNodes {
    /** 按钮根节点（挂 `Button` + 底图 `Sprite`） */
    btnNode: Node | null;
    /** 按钮上的文字：货币够 = 「刷新」、不够但有广告次数 = 「看广告」 */
    btnLabel: Label | null;
    /** 费用数字 */
    costLabel: Label | null;
    /**
     * 费用前面的图标（`refresh/icon`）：按货币换图，`viaAd` 时换成广告图标。
     * **不传时按名字从 `costLabel` 的兄弟节点里找**（见 `resolveCostIcon`）——
     * 这样三个面板都不用改预制件的引用绑定。
     */
    costIcon?: Sprite | null;
    /**
     * 该面板的**货币图标路径**（`resources` 相对路径，不带扩展名）：
     * 选英雄 / 遗物 = 金币（`GOLD_ICON_PATH`），击杀商店 = 击杀数（`KILL_ICON_PATH`）。
     * 不传 = 第一次调用时把预制件里的原图记为基准，只在 `viaAd` 时换成广告图标。
     */
    costIconPath?: string;
}

/**
 * 从费用数字（或按钮）节点反查同一个 `refresh` 节点下的费用图标 `icon`。
 *
 * 预制件里 `refresh` 下就是 `icon` / `value` / `refresh_btn` 三个兄弟节点（三个面板一致），
 * 所以按名字找是稳的；面板想显式拖引用也可以直接传 `costIcon`。
 */
export function resolveCostIcon(from: Node | Label | null | undefined): Sprite | null {
    const node = from instanceof Node ? from : (from?.node ?? null);
    const parent = node?.parent;
    if (!parent) return null;
    const icon = parent.getChildByName('icon') ?? parent.getChildByName('cost_icon');
    return icon ? icon.getComponent(Sprite) : null;
}

/** 已加载的图标帧（路径 → SpriteFrame）；加载失败的不进缓存，下次会重试 */
const frameCache = new Map<string, SpriteFrame>();
/** 正在加载的路径 → 等待回调（同一路径并发只发一次 resources.load） */
const framePending = new Map<string, ((sf: SpriteFrame | null) => void)[]>();
/** 每个费用图标「预制件原图」（首次调用时记录，用于从广告图标还原） */
const originFrame = new WeakMap<Sprite, SpriteFrame | null>();
/** 每个费用图标**最后想要**的贴图路径（异步回调回来时据此判断是否还该贴） */
const wantPath = new WeakMap<Sprite, string>();

/** 取一张 `resources` 图标帧（带缓存 + 并发合并；失败只打日志，不动节点上已有的图） */
function loadFrame(path: string, cb: (sf: SpriteFrame | null) => void): void {
    const hit = frameCache.get(path);
    if (hit) {
        cb(hit);
        return;
    }
    const waiting = framePending.get(path);
    if (waiting) {
        waiting.push(cb);
        return;
    }
    framePending.set(path, [cb]);
    resources.load(`${path}/spriteFrame`, SpriteFrame, (err, sf) => {
        const cbs = framePending.get(path) ?? [];
        framePending.delete(path);
        if (err || !sf) {
            ezgame.warn(`[刷新按钮] 图标加载失败：${path}`, err);
            cbs.forEach((f) => f(null));
            return;
        }
        frameCache.set(path, sf);
        cbs.forEach((f) => f(sf));
    });
}

/** 取一张 `resources` 图标帧（带缓存 + 并发合并；失败只打日志，不动节点上已有的图） */
export function loadIconFrame(path: string, cb: (sf: SpriteFrame | null) => void): void {
    loadFrame(path, cb);
}

/**
 * 把费用图标刷成「想要的那张」（货币图标 / 券图标 / 广告图标）。
 * 异步加载回来时若已经被改成别的图标（`wantPath` 变了）就丢弃这次结果，避免闪烁。
 */
function applyCostIcon(sprite: Sprite | null | undefined, path: string | null): void {
    if (!sprite) return;
    if (!originFrame.has(sprite)) originFrame.set(sprite, sprite.spriteFrame ?? null);
    if (!path) {
        const origin = originFrame.get(sprite);
        wantPath.delete(sprite);
        if (origin) sprite.spriteFrame = origin;
        return;
    }
    wantPath.set(sprite, path);
    loadFrame(path, (sf) => {
        if (!sf) return;
        if (wantPath.get(sprite) !== path) return;
        sprite.spriteFrame = sf;
    });
}

/**
 * 按判据画一次刷新按钮。
 *
 * @param nodes 面板的节点引用（允许为空，各段独立跳过）
 * @param gate 功能类算出的判据（`null` = 门面没注入到 → 一律按"不可点"画）
 * @param cost 本次刷新费用（`refreshCost` 的当前值）
 */
export function applyRefreshButton(nodes: RefreshButtonNodes, gate: RefreshGate | null, cost: number): void {
    const enabled = !!gate && gate.enabled;
    const canPay = !!gate && gate.canPay;
    // 免费刷新优先于一切（与 `evaluateRefreshGate` 的优先级同一份口径：免费 ＞ 花货币 ＞ 用券 ＞ 看广告）
    const viaFree = !!gate && gate.viaFree;
    const viaTicket = !!gate && gate.viaTicket;
    const viaAd = !!gate && gate.viaAd;

    if (nodes.btnNode) {
        const btn = nodes.btnNode.getComponent(Button);
        if (btn) btn.interactable = enabled;
        const sprite = nodes.btnNode.getComponent(Sprite);
        if (sprite) sprite.color = (enabled ? BTN_ENABLED_COLOR : BTN_DISABLED_COLOR).clone();
    }
    if (nodes.btnLabel) {
        // 货币够 → 「刷新」；不够但有券 → 「用 券」；不够也没券但有广告次数 → 「看广告」；都不行 → 保持「刷新」。
        //   ⚠ **免费那一支不改按钮文案**：这一下点击的动作仍然只是"刷新"，变的是**价格**；
        //     而按钮框只有 60px 宽（预制件里按「看广告」这 3 个字定的尺寸），4 个汉字（80px）会
        //     比按钮两边各探出 10px，并压到左边的费用数字（实测叠约 9px）。
        //     所以免费态一律靠**费用数字写成「免费」**来表达 —— 见下面 costLabel 那一段。
        nodes.btnLabel.string = canPay ? '刷新' : (viaTicket ? '用 券' : (viaAd ? '看广告' : '刷新'));
        nodes.btnLabel.color = (enabled ? BTN_ENABLED_COLOR : BTN_DISABLED_COLOR).clone();
    }
    if (nodes.costLabel) {
        // 免费那一下**不显示单价**：写「免费」而不是「0」——「0 击杀数」看着像"价格被算错了"
        // 单价走缩写口径（`formatNumber`）：遗物抽取费**不封顶**（50 → +25/次 一路涨），
        // 长局里这一格会出现四位数，不缩写就把旁边的按钮文案挤掉
        nodes.costLabel.string = viaFree ? '免费' : formatNumber(cost);
        // 免费时费用不该是红的（它压根不花货币）
        nodes.costLabel.color = (canPay || viaFree ? COST_ENOUGH_COLOR : COST_LACK_COLOR).clone();
    }
    // 费用图标：不够但有券 → 券图标；不够且没券、能看广告 → 广告图标（否则玩家会以为这一下要花金币）。
    //   ⚠ `viaFree` 时 viaTicket / viaAd 恒 false（分支互斥）→ 落回货币图标，正是我们要的。
    const icon = nodes.costIcon ?? resolveCostIcon(nodes.costLabel);
    const iconPath = viaTicket ? TICKET_ICON_PATH : (viaAd ? AD_ICON_PATH : (nodes.costIconPath ?? null));
    applyCostIcon(icon, iconPath);
}
