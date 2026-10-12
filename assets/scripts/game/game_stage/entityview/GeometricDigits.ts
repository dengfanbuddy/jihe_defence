import { Graphics } from 'cc';
import { DAMAGE_TEXT } from '../../common/DamageTextConfig';

/**
 * ============================================================
 * GeometricDigits —— 极简几何数字字形（0~9 + `.` `k` `万`），用 Graphics 矢量描边直接画
 * ============================================================
 *
 * 为什么不用字体资产：
 *   · Label 每个数字一次 draw call；LabelAtlas 同样一个组件一次 draw call（N 个数字 = N 次），
 *     而且都要出图集/字体资产 + 走一遍编辑器导入。
 *   · 本方案把**整层所有飘字画在同一个 Graphics 上**（见 DamageTextLayer），
 *     整层恒定 **1 次 draw call**，且零资产依赖、任意字号不失真、配色随代码走。
 *
 * 字形口径（与项目的极简几何风格一致）：
 *   · 每个字形 = 若干条**折线子路径**，坐标写在 [0, 0.7] × [0, 1] 的归一化字框里
 *     （x 以字宽 0.7 为界，y 以字高 1 为界，y 向上、基线 y = 0）
 *   · 笔画全部是**水平/垂直段**，直角拐角、无曲线、无衬线、无描边，缩放到任意字号都不失真
 *     （唯一放宽：`k` 的两笔斜画，见 `GEOMETRIC_SYMBOLS` 的注释）
 *   · 首尾点重合的子路径按**闭合路径**处理（描边时用 g.close()，保证拐角是完整的直角，
 *     不会因为首尾两个端点各自被平切而在角上留缺口）
 *
 * 扩展方式：数字往 `GEOMETRIC_DIGITS`（下标 = 数字值）、符号往 `GEOMETRIC_SYMBOLS`（键 = ASCII 码）
 * 各加一条折线数据；未定义的字符会被跳过（宽度照留），不会崩。
 * ⚠ 飘字能不能画全，取决于 `common/GoldText.formatNumber` 会产出哪些字符 ——
 *   改那边的分档（k/万/亿）就要来这边补字形。
 */

/** 归一化字框宽度（字高固定为 1，故字宽 0.7 → 数字偏窄长，读起来更"几何"） */
export const GLYPH_BOX_WIDTH = 0.7;

/**
 * 字形表：下标 = 数字值（0~9）
 * 每条子路径 = [x0,y0, x1,y1, ...]；首尾点重合 = 闭合路径（矩形类字形）
 */
export const GEOMETRIC_DIGITS: number[][][] = [
    // 0：闭合矩形
    [[0.05, 0.08, 0.65, 0.08, 0.65, 0.92, 0.05, 0.92, 0.05, 0.08]],
    // 1：一根竖（仅一根，与 7 段数码管一致，窄但不糊）
    [[0.35, 0, 0.35, 1]],
    // 2：上横 → 右竖（上半）→ 中横 → 左竖（下半）→ 下横
    [[0.05, 0.92, 0.65, 0.92, 0.65, 0.5, 0.05, 0.5, 0.05, 0.08, 0.65, 0.08]],
    // 3：上横 → 右竖（整条）→ 下横，外加中横
    [[0.05, 0.92, 0.65, 0.92, 0.65, 0.08, 0.05, 0.08], [0.05, 0.5, 0.65, 0.5]],
    // 4：左上竖 + 中横 + 右竖（整条）
    [[0.05, 0.92, 0.05, 0.5, 0.65, 0.5], [0.65, 0.92, 0.65, 0.08]],
    // 5：上横 → 左竖（上半）→ 中横 → 右竖（下半）→ 下横
    [[0.65, 0.92, 0.05, 0.92, 0.05, 0.5, 0.65, 0.5, 0.65, 0.08, 0.05, 0.08]],
    // 6：上横 → 左竖（整条）→ 下横 → 右竖（下半）→ 中横
    [[0.65, 0.92, 0.05, 0.92, 0.05, 0.08, 0.65, 0.08, 0.65, 0.5, 0.05, 0.5]],
    // 7：上横 → 右竖（整条）
    [[0.05, 0.92, 0.65, 0.92, 0.65, 0.08]],
    // 8：闭合矩形 + 中横（与 6/9 的区别就在这一横两侧竖线的完整性）
    [[0.05, 0.08, 0.65, 0.08, 0.65, 0.92, 0.05, 0.92, 0.05, 0.08], [0.05, 0.5, 0.65, 0.5]],
    // 9：右竖（整条）→ 上横 → 左竖（上半）→ 中横
    [[0.65, 0.08, 0.65, 0.92, 0.05, 0.92, 0.05, 0.5, 0.65, 0.5]],
];

/** 数字字符（'0'~'9'）→ 字形；非数字返回 undefined */
export function getDigitGlyph(charCode: number): number[][] | undefined {
    const v = charCode - 48; // '0' = 48
    return v >= 0 && v <= 9 ? GEOMETRIC_DIGITS[v] : undefined;
}

/**
 * **符号字形表**：键 = 字符的 ASCII 码（`'.'` = 46 / `'k'` = 107 / `'万'` = 19975）。
 *
 * 为什么必须有它：飘字现在走**缩写口径**（`common/GoldText.formatNumber` ——
 * 1000 → `1.2k`、10000 → `1.2万`），数字串里会混进小数点与单位后缀。
 * 而 `drawDigits` 对表里没有的字符是"**宽度照留、笔画不画**"，
 * 于是画面上会变成「1.2」后面空一格 —— 看起来像渲染坏了，玩家也读不出量级。
 *
 * 字形口径与数字完全一致（[0, 0.7]×[0, 1] 的折线子路径，y 向上、基线 y = 0），只有两条放宽：
 *   · `k` 的两笔斜画**是本文件唯一的斜线** —— 几何风格里没有别的办法画出 k；
 *     数字与 `.`/`万` 仍然全是横竖段；
 *   · `万` 是**简化的三笔**（上横 / 横折 / 撇），只求"一眼认得出是万"，不追求汉字字形 ——
 *     飘字字号只有 16px（暴击 25.6px），笔画一多就糊成一团。
 *
 * ⚠ 加字符就往这里加一条，**不要再往 `GEOMETRIC_DIGITS` 里塞非数字**：
 *   那个表的下标语义就是数字值本身（`tools/damage-text-preview/gen-mockup.mjs` 也按它解析）。
 */
export const GEOMETRIC_SYMBOLS: Record<number, number[][]> = {
    // '.' 基线上一个**小方点**（闭合路径 → 描边后是个实心点；画成短横会读成下划线）
    46: [[0.20, 0.04, 0.38, 0.04, 0.38, 0.22, 0.20, 0.22, 0.20, 0.04]],
    // 'k' 竖 + 两笔斜画
    107: [
        [0.14, 0.95, 0.14, 0.05],
        [0.14, 0.42, 0.58, 0.95],
        [0.14, 0.42, 0.58, 0.05],
    ],
    // '万' 上横 → 横折 → 撇（**刻意不收钩**：16px 上一个字只有 16px 高，
    //     多一笔就糊成一团，而"上横 + 折 + 撇"这个骨架已经认得出是万）
    19975: [
        [0.02, 0.95, 0.68, 0.95],
        [0.06, 0.66, 0.50, 0.66, 0.50, 0.06],
        [0.30, 0.62, 0.08, 0.10],
    ],
};

/**
 * 任意字符 → 字形（数字走 `GEOMETRIC_DIGITS`，`.`/`k`/`万` 走 `GEOMETRIC_SYMBOLS`）。
 * 表里没有的字符返回 undefined（`drawDigits` 宽度照留、不画）。
 */
export function getGlyph(charCode: number): number[][] | undefined {
    return getDigitGlyph(charCode) ?? GEOMETRIC_SYMBOLS[charCode];
}

/**
 * 量一串数字的绘制宽度（不画，只算）—— 用于在数字左侧预留暴击菱形标的位置。
 *
 * 宽度公式与 drawDigits 完全一致：(字数-1) × 字距 + 字宽
 */
export function measureDigits(text: string, size: number): number {
    const count = text.length;
    if (count <= 0) return 0;
    return (count - 1) * size * DAMAGE_TEXT.advanceRatio + size * GLYPH_BOX_WIDTH;
}

/**
 * 画一串数字（居中于 centerX，基线在 baselineY）
 *
 * 调用方**不必**自己 stroke：本函数内部会按当前 Graphics 的 strokeColor / lineWidth
 * 把这一串数字一次性 stroke 掉（stroke() 会消费并清空当前路径缓冲，
 * 所以可以连续对同一个 Graphics 画多个不同颜色的数字，互不串色）。
 *
 * @returns 这一串数字的实际绘制宽度（用于暴击菱形标等外围装饰）
 */
export function drawDigits(
    g: Graphics,
    text: string,
    centerX: number,
    baselineY: number,
    size: number,
): number {
    const advance = size * DAMAGE_TEXT.advanceRatio;
    const totalWidth = measureDigits(text, size);
    const count = text.length;

    let penX = centerX - totalWidth * 0.5;
    for (let i = 0; i < count; i++) {
        const glyph = getGlyph(text.charCodeAt(i));
        if (glyph) {
            for (let s = 0; s < glyph.length; s++) {
                const sub = glyph[s];
                const len = sub.length;
                // 首尾点重合 → 闭合路径：少画最后一段，改用 close() 补回，拐角才是完整直角
                const closed = len >= 8 && sub[0] === sub[len - 2] && sub[1] === sub[len - 1];
                const end = closed ? len - 2 : len;
                g.moveTo(penX + sub[0] * size, baselineY + sub[1] * size);
                for (let k = 2; k < end; k += 2) {
                    g.lineTo(penX + sub[k] * size, baselineY + sub[k + 1] * size);
                }
                if (closed) g.close();
            }
        }
        penX += advance; // 未定义字符也占位（宽度照留）
    }

    g.stroke();
    return totalWidth;
}

/**
 * 画暴击的实心菱形几何标（贴在数字左侧）
 *
 * 极简几何风格里，这比"放大加粗"更能宣示暴击，而且天然把"暴击"和"数字恰好很大"分开。
 * 用 fill（实心）而不是 stroke（描边）：实心小块在飘字互相重叠时依然干净，
 * 描边外框会互相切出噪音。
 *
 * @param halfWidth  半宽
 * @param halfHeight 半高
 */
export function fillDiamond(
    g: Graphics,
    centerX: number,
    centerY: number,
    halfWidth: number,
    halfHeight: number,
): void {
    g.moveTo(centerX, centerY + halfHeight);
    g.lineTo(centerX + halfWidth, centerY);
    g.lineTo(centerX, centerY - halfHeight);
    g.lineTo(centerX - halfWidth, centerY);
    g.close();
    g.fill();
}
