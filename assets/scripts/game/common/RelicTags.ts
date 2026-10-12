/**
 * 遗物流派标签的**展示口径**（唯一一份）
 *
 * 数据源 = `relics.json` 的 `tags`（1~3 个，**第 1 个是主标签**），由
 * `tools/excel_export/scripts/lib/relic-inner-design.mjs` 的 `tagsOf()` 从钩子与属性**推出来**、不手写。
 * 词表共用 `RELIC_ARCHETYPES` 那 10 个词（远程点杀 / 坦克反伤 / 物理暴击 / 法术爆发 /
 * 召唤增殖 / 元素持续 / 经济成长 / 控制减速 / **背水血怒 / 弹幕散射**），与 `abilities.json` /
 * `kill_buffs.json` 是同一套 ——
 * 玩家在同一屏里同时看到遗物、技能、神器，三张表各用一套词等于给他三套语言。
 *
 * 为什么单独一个文件：分隔符与"能显示几个"这两件事**会被多个界面问**（局内商店格只放得下 1 个、
 * 局外图鉴行放得下全部），散到各组件里迟早出现"商店写 `·`、图鉴写 `/`"。
 * 与 `RelicRarityColor.ts`（品质色的唯一口径）同一分工。
 *
 * ⚠ **标签不做颜色编码**（曾设想过"8 个流派 8 个色块"，2026-11 词表扩到 10 个之后更不可能）：
 * `docs/art-style/tokens.json` 是
 * **双色制**（一处墨灰 + 一处青绿），凑不出 8 个有区分度的分类色；而仅有的 4 个高区分度色
 * （白 / 蓝 / 紫 / 红）**已经是品质色**，占用会被读成品质。所以标签一律**文字**，
 * 颜色只取 ink 阶（局内商店格 `#999999`、图鉴行 `#999999`），过 `npm run audit:ui`。
 */

/** 多个标签之间的分隔符（`坦克反伤 · 物理暴击`）。全角间隔号两侧各一个半角空格。 */
export const TAG_SEPARATOR = ' · ';

/**
 * 主标签（`tags[0]`）—— 放不下全部标签时**只显示这一个**。
 *
 * 口径来自配表注释（`Tb_RelicConfig.RelicCfg.tags`）："1~3 个，**第 1 个是主标签**"。
 * 10 个词全是 4 汉字，@12px 约 48px —— 正好放进局内商店格那 70px 宽的标签框。
 *
 * @returns 主标签；没有标签（9 件仅局外版的 dota2 中立道具）/ 入参为空时回**空串**（不是 null，调用方直接写进 Label）
 */
export function primaryTag(tags?: readonly string[] | null): string {
    return tags && tags.length > 0 ? (tags[0] ?? '') : '';
}

/**
 * 把标签拼成一行展示文案（`坦克反伤 · 物理暴击`）。
 *
 * @param tags 配表的 `tags`
 * @param max  最多显示几个；`0` / 留空 = 全部。超出部分**静默丢掉**（不写"…"：
 *             标签是分类不是数量，省略号会让人以为还有别的隐藏信息）
 * @returns 拼接结果；一个都没有时回**空串**（调用方写进 Label 即"这行是空的"）
 */
export function formatTags(tags?: readonly string[] | null, max = 0): string {
    const list = (tags ?? []).filter((t) => !!t);
    if (list.length === 0) return '';
    const shown = max > 0 ? list.slice(0, max) : list;
    return shown.join(TAG_SEPARATOR);
}
