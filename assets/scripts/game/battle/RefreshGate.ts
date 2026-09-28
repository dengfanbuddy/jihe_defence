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
 * ⚠ 三个输入必须都是**响应式**的（`refreshCost` / `adFreeLeft` 是 ref，`gold` 来自 `battleStore`），
 *   否则面板的 watcher 收不到变化。面板侧用 `refreshGateKey()` 当 watch 源，就是为了
 *   "判据只依赖这几个 ref、且只在判据真的变了时才重画"。
 */

/** 刷新按钮的判据（功能类算出来交给面板画） */
export interface RefreshGate {
    /** 按钮能不能点（= `canPay || viaAd`） */
    enabled: boolean;
    /** 金币够不够（费用数字的颜色：够 = 原色、不够 = 红） */
    canPay: boolean;
    /** 金币不够、但还有广告免费次数 → 点了走「看广告」 */
    viaAd: boolean;
}

/**
 * 算一次判据：金币 ≥ 费用 → 直接扣钱；否则还有广告免费次数 → 看广告；都没有 → 置灰。
 *
 * @param gold 本局金币（功能类的 `deps.getGold()`，真源与 HUD 显示同一口径）
 * @param cost 本次刷新费用（功能类的 `refreshCost.value`）
 * @param adFreeLeft 剩余「广告免费刷新」次数（功能类的 `adFreeLeft.value`）
 */
export function evaluateRefreshGate(gold: number, cost: number, adFreeLeft: number): RefreshGate {
    const canPay = gold >= cost;
    const viaAd = !canPay && adFreeLeft > 0;
    return { canPay, viaAd, enabled: canPay || viaAd };
}

/**
 * 按钮的**绘制指纹**，给 UI 的 watcher 当 watch 源用。
 *
 * 两个坑都在这个函数里挡掉：
 *   ① 不能直接 watch `refreshGate()` 的返回值 —— 它每次都是**新对象**，watch 的 `Object.is` 比较恒为 false，
 *      金币 100 → 101 这种"判据其实没变"的变化也会白白重画一次按钮。
 *   ② **必须带上 `cost` 一起 watch** —— 判据只有 3 个布尔，费用从 50 涨到 100 时若金币两种都够，
 *      判据不变，但费用数字必须重画（只看判据会"显示 50、实际扣 100"）。
 */
export function refreshButtonKey(gate: RefreshGate | null | undefined, cost: number): string {
    if (!gate) return '';
    return `${gate.enabled ? 1 : 0}${gate.canPay ? 1 : 0}${gate.viaAd ? 1 : 0}|${cost}`;
}
