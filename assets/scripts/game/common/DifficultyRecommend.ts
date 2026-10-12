/**
 * ============================================================
 * DifficultyRecommend —— 「你该打哪一档」的**唯一判据**（纯 TS，无 cc 依赖）
 * ============================================================
 *
 * ── 它解决的是哪件事 ──
 *   `DifficultyConfig` 的那条曲线**本身是对的**：实测（`tools/difficulty-curve/sim.mjs`）
 *   最低成长在档 1 打 65 秒、中位在自己那一档打 41 秒、最高成长在档 100 打 40 秒 —— 三个锚点都成立。
 *   但"**该打哪一档**"这件事原先没人管：解锁门槛是"通关第 N 档 → 解锁第 N+1 档"，
 *   于是一个已经集齐局外遗物的玩家**被锁在档 3**，而他的档位是**档 80**。
 *   他看到的当然是"一路秒杀，包括 Boss" —— 那一段本来就是给新号设计的。
 *
 *   ⇒ 本文件回答：**按你的局外成长，你该从第几档开始。**
 *
 * ── 输入为什么是「局外遗物平均份数」而不是"战力分" ──
 *   局外遗物的份数是**唯一无上限**的那一层（`加成值 × 收集份数`），也是量级最大的一层：
 *   实测每件集齐一遍就把一级英雄的 DPS 抬 **×45**，而满成就只有 **×1.2**。
 *   它还是客户端**最便宜**能拿到的一个数：`总份数 ÷ 局外遗物件数`，
 *   不需要在客户端复刻一遍 `tools/lib/battle-power.mjs` 那份战力模型
 *   （那份模型是权威，但它读的是 8 张表 + 5 个源码常量 —— 客户端再写一遍必然两边跑偏）。
 *
 *   ⚠ **已知近似**（读结论前必读）：
 *     ① 份数取**平均**（总份数 ÷ 37）。局外抽取是"档内优先未收集"，所以真实分布本来就接近均匀；
 *        但"某一件抽了 5 份、别的 0 份"的账号会被本表低估（表按均匀分布标定）。
 *     ② **不含成就**（`×1.2`）与**英雄局外等级**。这两层加起来远小于份数那一层，
 *        所以对"该打哪一档"的判断影响在个位数档位内 —— 不值得为它把整份战力模型搬进客户端。
 *     ③ 这张表是**在 1 级英雄上量的**（比满级更保守：越早问越好）。
 *
 * ── 这张表怎么来的（**不要手改，重跑脚本**）──
 * ```bash
 * node tools/difficulty-curve/recommend-anchors.mjs          # 打印下面的 COPIES_RATIO
 * node tools/difficulty-curve/recommend-anchors.mjs --json   # 直接出数组
 * ```
 * 改了 `relics.json` 的局外版 / 局外抽取池 / 属性口径之后**必跑**它并回填下面的表。
 *
 * ── 三个锚点（`ratio` → 档位）从哪来 ──
 *   就是 `sim.mjs` 那张"难度 × 成长"表里**每个成长档自己的"正正好"档位**
 *   （判据 = 最终 Boss 墙钟 TTK 打到 40 秒 = 30 秒定标 × 取 75%）：
 *
 *   | 成长档 | 局外份数 | 实测 `ratio` | 实测"正正好"档位 |
 *   |---|---|---|---|
 *   | 最低成长 | 0 | ×1 | 档 1 |
 *   | 中位 | 1 | ×45.767 | 档 80 |
 *   | 最高成长 | 3 | ×134.771 | 档 100 |
 *
 *   ⚠ **档位 80 / 100 是上一轮 sim 的结论**（当时中位在档 80 打 40.7 秒、最高成长在档 100 打 40.2 秒）。
 *   2026-11 局外表重设计之后**只重键了比值（45.817 → 45.767、537.27 → 134.771）、档位刻意没动** ——
 *   重定难度底数是**另一个决定**，见下面 `RATIO_LEVEL_ANCHORS` 的 ⚠ 与
 *   `tools/outer-relic-design/README.md` §4 第 3 条（那里记着"修完局内池过滤器之后 sim 会说该打档 ~95"）。
 *
 *   中间**按 `ln(ratio)` 线性插值**（阶梯是指数的，所以必须在对数轴上插），
 *   这就是下面 `RATIO_LEVEL_ANCHORS` 只有三个点的原因。
 *
 * ── 几个由此表得到的读数（写完就能对账）──
 *   份数 0.25（约 67 件）→ 档 ≈ 53；0.5（约 134 件）→ 档 ≈ 66；
 *   0.75（约 201 件）→ 档 ≈ 74；1（集齐 268 件）→ 档 80；3（约 804 件）→ 档 100。
 *   ⚠ "件数" = 份数 × 268（局外池件数，2026-11 起与局内池严格对齐）；
 *   档位随新表逐点重算过 —— 旧表在低段更平（0.25 份只到档 ≈38），高段更陡（3 份撞到档 100 就走完了）。
 * 门禁：`node tools/difficulty-curve/recommend-anchors.mjs --verify`（逐点漂移 ≤1%）。
 *
 * @example
 * ```ts
 * import { recommendLevel, ratioOfCopies } from '../common/DifficultyRecommend';
 *
 * ratioOfCopies(1);      // → 45.767（集齐一遍：DPS 是零局外的 45 倍）
 * recommendLevel(1);     // → 80（该打档 80，而不是被锁在档 3）
 * recommendLevel(0);     // → 1（新号）
 * ```
 */

import { DIFFICULTY_MAX, clampLevel, levelLabel } from './DifficultyConfig';

/**
 * 「局外遗物**平均**份数 → 面板 DPS 相对零局外的倍率」标定表（升序，`[份数, 倍率]`）。
 *
 * 真源 = `node tools/difficulty-curve/recommend-anchors.mjs`（10 英雄 1 级取中位，
 * 走 `tools/lib/battle-power.mjs` 那份唯一战力模型）。**手改这张表 = 与战力模型脱钩。**
 *
 * 低段（0 ~ 0.25）刻意加密：那一段最陡（前 13 件就把 DPS 抬 ×3.4、67 件抬到 ×12），
 * 而它对应的正是"新号头几天"，推荐档位在这一段给高一点就会把新玩家推进打不过的档。
 *
 * ⚠ **2026-11 局外池扩到 268 件之后这张表整条重标过一次**（旧表是按 37 件池量的）：
 * 份数是"**已收集总数 ÷ 池子件数**"，池子大 7.24 倍 ⇒ **同一个份数现在对应 7.24 倍的抽数**
 * （0.05 份 = 13 件 = 13 抽 vs 旧表的 2 抽）。所以：
 *   · **低段整体抬高**（旧 0.05 份 ×1.81 → 新 ×3.45）：新表的单件值是**整数**（攻击 +4 起），
 *     不会像旧表那样"抽到一件 +0.5 攻击"被抹成 0；
 *   · **高段整体压平**（旧 3 份 ×537 → 新 ×134.8）：旧表的攻速 +135%/份 与暴击 +47%/份 是**乘区**，
 *     几份就把面板拉爆（攻速撞 5.0 上限）；新表**只有加法轴**，曲线是近似线性的 —— 这正是
 *     用户口径「攻速/暴击率/闪避率这类不能给」想要的结果，不是标定漂移。
 *   · 三个锚点（0/1/3 份）不受影响：**1 份仍然 = ×45.8**（1 份就是"每件各一份"= 集齐一遍，
 *     新旧表在这个点上是被标定成等价的）。
 */
export const COPIES_RATIO: readonly (readonly [number, number])[] = [
    [0, 1],
    [0.05, 3.446],
    [0.1, 5.716],
    [0.15, 7.941],
    [0.2, 10.166],
    [0.25, 12.391],
    [0.35, 16.841],
    [0.5, 23.516],
    [0.75, 34.642],
    [1, 45.767],
    [1.25, 56.893],
    [1.5, 68.018],
    [2, 90.269],
    [2.5, 112.52],
    [3, 134.771],
    [4, 179.273],
    [5, 223.774],
];

/**
 * 「战力倍率 → 推荐档位」的三个锚点（`[ratio, 档位]`，升序）。
 *
 * 三个点全部来自 `sim.mjs` 实测（见文件头那张表），**不是拟合出来的**。
 * 之间按 `ln(ratio)` 线性插值 —— 难度阶梯是指数的，所以插值必须在**对数轴**上做，
 * 在 ratio 轴上线性插会把中段压得严重偏低。
 *
 * ⚠ **2026-11 只重键了比值、没动档位**（`44.975 → 45.767`、`529.263 → 134.771`）：
 * 档位 1 / 80 / 100 是上一轮 `sim.mjs` 的实测结论，而**重定难度底数是一个独立的决定**
 * （用户口径明确说"难度曲线不用跟着局外重标"），所以这里刻意**不**顺手改玩家看到的推荐结果。
 * 必须知道的一件事：`sim.mjs` 里"局内池"的过滤器同时修了一个真 bug（原来漏掉 28 件 `both`），
 * 修完之后**同一批面板**在难度 100 打最终 Boss 只要 ~48 秒（原来是 40.7 秒@档 80 这个锚点），
 * 也就是**现在的推荐档位偏保守**（模拟器会说该打档 ~95）。要重定就跑：
 * ```bash
 * node tools/difficulty-curve/tune.mjs --k=1 --detail     # 看"各成长档 40 秒档"落在哪
 * ```
 * 见 `tools/outer-relic-design/README.md` §4 第 3 条。
 */
export const RATIO_LEVEL_ANCHORS: readonly (readonly [number, number])[] = [
    [1, 1],
    [45.767, 80],
    [134.771, 100],
];

/** 表里的份数上界（超过它按最后两点的对数斜率外推） */
function tailSlope(): number {
    const n = COPIES_RATIO.length;
    const [c1, r1] = COPIES_RATIO[n - 2];
    const [c2, r2] = COPIES_RATIO[n - 1];
    return Math.log(r2 / r1) / Math.log(c2 / c1);
}

/**
 * 局外遗物**平均**份数 → 面板 DPS 相对零局外的倍率。
 *
 * 表内线性插值（表够密），超过表尾按**最后两点的对数斜率**外推（份数无上限，
 * 玩家真能抽到 10 份以上，不外推就会把他们都夹在 ×1164）。
 *
 * @param avgCopies 平均份数 = 已收集**总份数** ÷ 局外遗物件数（`OuterRelicDraw.outerPool().length`）
 */
export function ratioOfCopies(avgCopies: number): number {
    if (!Number.isFinite(avgCopies) || avgCopies <= 0) return 1;

    const last = COPIES_RATIO[COPIES_RATIO.length - 1];
    if (avgCopies >= last[0]) {
        // 外推：ratio = 表尾 ratio × (份数 / 表尾份数)^斜率
        return last[1] * Math.pow(avgCopies / last[0], tailSlope());
    }

    for (let i = 1; i < COPIES_RATIO.length; i++) {
        const [c1, r1] = COPIES_RATIO[i - 1];
        const [c2, r2] = COPIES_RATIO[i];
        if (avgCopies <= c2) {
            const t = (avgCopies - c1) / (c2 - c1);
            return r1 + (r2 - r1) * t;
        }
    }
    return last[1];
}

/**
 * 战力倍率 → 推荐档位（1 ~ `DIFFICULTY_MAX`）。
 *
 * 三个锚点之间在**对数轴**上线性插值；低于第一个锚点 → 档 1；高于最后一个 → `DIFFICULTY_MAX`。
 */
export function recommendLevelOfRatio(ratio: number): number {
    if (!Number.isFinite(ratio) || ratio <= RATIO_LEVEL_ANCHORS[0][0]) return 1;

    const n = RATIO_LEVEL_ANCHORS.length;
    const [maxRatio, maxLevel] = RATIO_LEVEL_ANCHORS[n - 1];
    if (ratio >= maxRatio) return clampLevel(maxLevel);

    for (let i = 1; i < n; i++) {
        const [r1, l1] = RATIO_LEVEL_ANCHORS[i - 1];
        const [r2, l2] = RATIO_LEVEL_ANCHORS[i];
        if (ratio <= r2) {
            const t = Math.log(ratio / r1) / Math.log(r2 / r1);
            return clampLevel(Math.round(l1 + (l2 - l1) * t));
        }
    }
    return clampLevel(maxLevel);
}

/**
 * **唯一入口**：按局外遗物收集程度算"你该从第几档开始"。
 *
 * @param avgCopies 平均份数（见 `ratioOfCopies`）；0 / 非法值 → 档 1
 */
export function recommendLevel(avgCopies: number): number {
    return recommendLevelOfRatio(ratioOfCopies(avgCopies));
}

/**
 * 详情条标题：`关卡 80 · 推荐`（当前待确认的那一档就是推荐档时带后缀）。
 *
 * 为什么后缀只有四个字：`panel/detail/title` 是 `Overflow.NONE`（不裁字、节点自适应宽度），
 * 左边距到「确定」按钮之间可用 **405 px**（实测），而 `关卡 80` 只占 201 px ——
 * 加长文案不会裁字，但会往按钮上压，所以**不许再往上堆字**。
 */
export function detailTitleOf(level: number, recommended: number): string {
    const n = clampLevel(level);
    return levelLabel(n) + (n === clampLevel(recommended) ? ' · 推荐' : '');
}

/** 一句话（开局日志 / 排查用）：`推荐难度：关卡 80（局外遗物平均 1.00 份，战力 ×44.98）` */
export function describeRecommend(avgCopies: number): string {
    const level = recommendLevel(avgCopies);
    return `推荐难度：${levelLabel(level)}`
        + `（局外遗物平均 ${avgCopies.toFixed(2)} 份，战力 ×${ratioOfCopies(avgCopies).toFixed(2)}）`;
}

/** 档位总数（转发 `DifficultyConfig`，免得到处 import 两个文件） */
export const RECOMMEND_MAX_LEVEL = DIFFICULTY_MAX;
