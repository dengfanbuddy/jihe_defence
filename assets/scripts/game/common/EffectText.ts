/**
 * EffectText.ts — 效果文案的**展示口径**（唯一实现）
 *
 * 配表里一条遗物的效果是**一整句**（`relics.description_inner`）：
 *   `攻击力 +20%；吸血 +12%；代价：最大生命 -12%`
 * 而商店格子只有 86px 宽（`RelicItem/content/desc`，fs12）—— 整句直接塞进去会**任意断行**
 * （「攻击力 +13；吸血」/「+7%；攻击速度」…），一条效果被劈成两行、下一行又从半句话开始。
 * 这里按 `；` 拆开 → **一条效果一行**，行与行之间才看得出结构。
 *
 * 为什么单独一个文件：格子的 desc 同时给**遗物与技能**用（`ShopRiItem` 两处），
 * 两份实现迟早会有一边忘了改。技能文案（`abilities.lv1/lv2/lv3`）现在都没有 `；`，
 * 走这里是**无操作**，所以调用方不必分支。
 *
 * ⚠ 只管**展示**，不动配表：`ShopConfig.getRelicDesc` 仍返回原句
 * （状态栏详情页按原句排版，两处口径互不影响）。
 */
export function toEffectLines(text: string): string {
    return String(text ?? '')
        .split(/[；;]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .join('\n');
}
