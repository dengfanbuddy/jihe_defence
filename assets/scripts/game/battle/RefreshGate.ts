/**
 * RefreshGate —— 三个商店面板共用的「刷新按钮判据」（**唯一真源**）
 *
 * 为什么单独成一个文件：这条判据原本散在 4 个地方各写一遍 ——
 * 三个功能类的准入分支（`HeroSelect.refresh()` / `RelicShop.refresh()` / `BuffShop.refresh()`），
 * 加上三个面板里**逐字相同**的 `refreshRefreshButton()`（连注释都写着"判据必须与 XXX 完全一致"）。
 * 靠注释承诺的"必须一致"迟早会不一致，两种翻车都很常见：
 *   · 面板说能点、功能类拒绝 → 玩家点了没反应（最容易被当成 bug）；
 *   · 面板置灰、功能类其实允许 → 白白少一次刷新机会（广告免费次数用不出去）。
 *
 * 现在只有一处：**功能类算（`refreshGate()`），面板画（`RefreshButtonView.applyRefreshButton`）**。
 *
 * ⚠ **货币由调用方决定**：选英雄 / 遗物抽取传**金币**（`battleStore.gold`），
 *   击杀商店传**击杀数**（`battleStore.killPoints`）—— 本函数只认「余额 / 费用」两个数字，
 *   不知道也不该知道那是什么货币（货币真源与扣费口都在宿主）。
 *
 * ⚠ 三个输入必须都是**响应式**的（`refreshCost` / `adFreeLeft` 是 ref，货币余额来自 store），
 *   否则面板的 watcher 收不到变化。面板侧用 `refreshGateKey()` 当 watch 源，就是为了
 *   "判据只依赖这几个 ref、且只在判据真的变了时才重画"。
 */

/** 刷新按钮的判据（功能类算出来交给面板画） */
export interface RefreshGate {
    /** 按钮能不能点（= `viaFree || canPay || viaTicket || viaAd`） */
    enabled: boolean;
    /**
     * 还剩**免费刷新**次数（开局白送的那种）→ 点了不花货币、也不抬价。
     *
     * ⚠ 它**不是** `canPay` 的一种：`canPay` 仍然是"货币够不够"的纯比较（费用数字的颜色靠它），
     *   两者可以同时为真 —— 此时该走免费那一支（见 `refresh()` 的优先级）。
     * ⚠ 只有击杀商店（神器）会传 `freeLeft`，选英雄 / 遗物抽取缺省 `freeLeft = 0` ⇒ 恒 false。
     */
    viaFree: boolean;
    /** 货币够不够（费用数字的颜色：够 = 原色、不够 = 红） */
    canPay: boolean;
    /**
     * 货币不够、但背包里有**局内广告券** → 点了直接扣券（**不弹广告**）。
     * ⚠ 只有肉鸽商店（遗物抽取）会传 `ticketLeft`：券的口径是"只覆盖局内那两个广告位"
     *   （见 `docs/meta-growth/README.md` §3），选英雄 / 击杀商店缺省 `ticketLeft = 0` ⇒ 恒 false。
     */
    viaTicket: boolean;
    /** 货币不够、也没券、但还有广告免费次数 → 点了走「看广告」 */
    viaAd: boolean;
}

/**
 * 算一次判据：还有免费次数 → 白拿；否则货币 ≥ 费用 → 直接扣；否则有券 → 扣券；
 * 否则还有广告免费次数 → 看广告；都没有 → 置灰。
 *
 * **优先级**（写死在这里，三个面板共用同一份）：`免费 ＞ 花货币 ＞ 用券 ＞ 看广告 ＞ 置灰`。
 * 为什么免费在最前：它一次性的、且不抬价 —— 让玩家先花掉击杀数再用免费次数，等于把那一次白送吞掉。
 * 为什么券在广告之前：券就是"把看广告这一步挪到局外做"的产物（`docs/meta-growth/README.md` §3），
 * 若让广告先走，玩家攒的券永远用不出去。
 *
 * ⚠ **四个分支互斥**（`viaFree` 为真时后三个恒 false）：它们决定按钮上画哪张图标
 *   （券 / 广告 / 货币），同时成立会出现"免费那一次画着看广告的图标"。
 *
 * ⚠ **券不增加局内配额**：用券时局内那一次额度照扣（`RelicShop.roll(true)` 仍 `adFreeUsed++`），
 *   所以"攒一周券 = 一局白拿 14 次"这种事不会发生。
 *
 * @param balance 本局**货币余额**（金币或击杀数；真源与 HUD 显示同一口径）
 * @param cost 本次刷新费用（功能类的 `refreshCost.value`，单位与 `balance` 一致）
 * @param adFreeLeft 剩余「广告免费刷新」次数（功能类的 `adFreeLeft.value`）
 * @param ticketLeft 背包里**局内广告券**的张数（**只传数量，不传"能不能扣"** ——
 *                   真要扣券时由消费方再问一次 `BagData.consumeItem`，扣不动就退回看广告那一支）
 * @param freeLeft 剩余**免费刷新**次数（功能类的 `freeRefreshLeft.value`；缺省 0 = 这条通道不存在）
 */
export function evaluateRefreshGate(balance: number, cost: number, adFreeLeft: number, ticketLeft = 0, freeLeft = 0): RefreshGate {
    const viaFree = freeLeft > 0;
    const canPay = balance >= cost;
    const viaTicket = !viaFree && !canPay && ticketLeft > 0;
    const viaAd = !viaFree && !canPay && !viaTicket && adFreeLeft > 0;
    return { enabled: viaFree || canPay || viaTicket || viaAd, viaFree, canPay, viaTicket, viaAd };
}

/**
 * 按钮的**绘制指纹**，给 UI 的 watcher 当 watch 源用。
 *
 * 四个坑都在这个函数里挡掉：
 *   ① 不能直接 watch `refreshGate()` 的返回值 —— 它每次都是**新对象**，watch 的 `Object.is` 比较恒为 false，
 *      金币 100 → 101 这种"判据其实没变"的变化也会白白重画一次按钮。
 *   ② **必须带上 `cost` 一起 watch** —— 判据只有 4 个布尔，费用从 50 涨到 100 时若金币两种都够，
 *      判据不变，但费用数字必须重画（只看判据会"显示 50、实际扣 100"）。
 *   ③ **必须带上 `viaTicket`**（2026-11 加券时踩过这个坑）：它决定按钮是「看广告」还是「用 券」，
 *      漏了这一位就是"有券了按钮还写着看广告" —— 判据变了按钮不重画，正是本函数存在的唯一理由。
 *   ④ **必须带上 `viaFree`**（2026-11 加免费刷新时同理）：它决定按钮是「免费刷新」还是「刷新」，
 *      而且免费那一次会把费用数字换成「免费」—— 漏了这一位就是"白送的那一次按钮还写着 50"。
 */
export function refreshButtonKey(gate: RefreshGate | null | undefined, cost: number): string {
    if (!gate) return '';
    return `${gate.viaFree ? 1 : 0}${gate.enabled ? 1 : 0}${gate.canPay ? 1 : 0}${gate.viaTicket ? 1 : 0}${gate.viaAd ? 1 : 0}|${cost}`;
}
