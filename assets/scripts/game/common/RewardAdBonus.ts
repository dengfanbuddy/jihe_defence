import { BattleConstUtil } from '../battle/core/BattleConstUtil';

/**
 * ============================================================
 * RewardAdBonus —— **结算面板「看广告翻倍」的倍率规则**（纯规则，无 cc 依赖、不碰数据层）
 * ============================================================
 *
 * 这条链路的由来（2026-11，用户口径）：
 * >
 * > 「给一个广告入口，看广告给 1~3 倍的奖励，可以有一位小数。」
 *
 * ── 它做什么 ──
 *
 * 一局打完、结算面板弹出时掷**一个**倍率（`settleAdMulMin` ~ `settleAdMulMax`，
 * 现 1.0 ~ 3.0），把这一局的**两份奖励**（局外金币 + 通用英雄经验）**一起**乘上去：
 *
 * ```
 * 倍率 mul ∈ {1.0, 1.1, 1.2, …, 3.0}        // 步长 = 10^-decimals（现 1 位小数，共 21 档）
 * 翻倍后金币 = round(金币 × mul)
 * 翻倍后经验 = round(经验 × mul)
 * 广告补发   = 翻倍后 − 已经落库的基础值    // 见下面口径 ③
 * ```
 *
 * ── 四条口径（写死，别在别处再算一遍）──
 *
 *   ① **倍率在面板弹出的那一刻就掷好、并且画给玩家看**（按钮上直接写「×2.3」）。
 *      不做"看完广告才开盲盒"：那样玩家点下去之前不知道值不值，
 *      而掷出 ×1.0 的那一次（本区间内 21 档里 1 档 ≈ 4.8%）会变成"看完广告什么都没多拿"的事故。
 *      先掷后看 ⇒ 玩家自己决定这一次要不要看 —— 这也是为什么 `settleAdMulMin` 可以配 1.0
 *      （配 1.0 时那 4.8% 的局面按钮不值得点，但**绝不是欺骗**）。想让它永远有赚头就把这个键调高。
 *   ② **不随机二次**：`roll()` 只在一局结算里调一次，结果由宿主存着；
 *      广告失败（没接 SDK / 中途关掉）**重试仍是同一个倍率**，不会越点越高。
 *   ③ **基础奖励先落库、广告只补差额**：`endRun` 里先把基础金币 / 经验发掉（见
 *      `RunClearReward` / `RunClearHeroExp`），看完广告再发 `round(base × mul) − base`。
 *      这样"玩家看完广告直接杀进程"最多丢掉差额、绝不会丢掉整局奖励，
 *      也不会出现"面板上的数和背包里的数对不上"（口径同 `docs/gdd_reward` 的"面板只是回执"）。
 *   ④ **一局一次**：结算面板只有一个广告位，看完即置灰（判据在 `Scene_Game_Stage.endRun` 的
 *      `settleAdUsed`，这里只提供规则、不存状态）。
 *
 * ── 与另外两个广告位的区别（别混）──
 *
 *   | 广告位 | 触发 | 花什么 | 拿什么 |
 *   |---|---|---|---|
 *   | `relic_refresh` / `hero_refresh` / `buff_shop_refresh` | 局内金币不足 | 一次看视频（有券则扣券） | 免费刷新一次 |
 *   | `revive` | 英雄阵亡 | 一次看视频（有券则扣券） | 原地复活 |
 *   | **`settle_reward_bonus`（本模块）** | **一局结束的结算面板** | 一次看视频（**不认券**） | **金币 + 英雄经验同乘一个倍率** |
 *
 *   局内广告券（`ad_ticket`）**不覆盖本广告位**：券的口径是"局内那两个商店广告位"
 *   （见 `docs/meta-growth/README.md` §3），而这一格发的是**局外资源**，
 *   认券等于把"局外收益"变成可以提前囤的东西 —— 那是另一套设计，本项目不做。
 */
export class RewardAdBonus {

    /** 倍率下限（`battle_constants.settleAdMulMin`，现 1.0） */
    static minMul(): number {
        return Math.max(0, BattleConstUtil.getSettleAdMulMin());
    }

    /** 倍率上限（`battle_constants.settleAdMulMax`，现 3.0） */
    static maxMul(): number {
        return Math.max(RewardAdBonus.minMul(), BattleConstUtil.getSettleAdMulMax());
    }

    /** 小数位数（`battle_constants.settleAdMulDecimals`，现 1；用户口径「可以有一位小数」） */
    static decimals(): number {
        const d = Math.floor(BattleConstUtil.getSettleAdMulDecimals());
        return Math.min(3, Math.max(0, d));
    }

    /** 一档 = `10^-decimals`（现 0.1） */
    static step(): number {
        return Math.pow(10, -RewardAdBonus.decimals());
    }

    /**
     * **掷一个倍率**（闭区间 `[min, max]`，步长恰好是一档，现 1 位小数）。
     *
     * 为什么用"档位"而不是 `min + Math.random() * (max - min)` 再四舍五入：
     * 后者在两端会出现半个档的偏差（1.0 与 3.0 各自只分到 1/42 的概率），
     * 而且浮点噪声会掷出 1.9999999999999998 这种"看起来是 2.0、格式化后也是 2.0"的值 ——
     * 档位法保证**掷出来的数逐字节等于它显示出来的数**（`format()` 是恒等变换）。
     *
     * @param rand 随机源（缺省 `Math.random`；体检脚本注入固定序列就能复现某一档）
     */
    static roll(rand: () => number = Math.random): number {
        const min = RewardAdBonus.minMul();
        const max = RewardAdBonus.maxMul();
        const steps = Math.round((max - min) / RewardAdBonus.step());
        const r = typeof rand === 'function' ? rand() : 0;
        // 脏随机源（NaN / 越界 / 负数）一律当 0 → 取下限，绝不掷出区间外的值
        const k = Number.isFinite(r) ? Math.min(steps, Math.max(0, Math.floor(r * (steps + 1)))) : 0;
        return RewardAdBonus.roundMul(min + k * RewardAdBonus.step());
    }

    /** 按配置的小数位收敛（消掉 `1.0 + 3 * 0.1 = 1.3000000000000003` 这类浮点噪声） */
    static roundMul(mul: number): number {
        const p = Math.pow(10, RewardAdBonus.decimals());
        return Math.round((Number.isFinite(mul) ? mul : 0) * p) / p;
    }

    /**
     * 倍率的**显示串**（按钮 / 日志用）：`2.3` / `1.0` / `3.0`。
     * 固定按 `decimals()` 位小数，所以 `3` 一定写成 `3.0` —— 界面上"×3"和"×3.0"混着写很像 bug。
     */
    static format(mul: number): string {
        return RewardAdBonus.roundMul(mul).toFixed(RewardAdBonus.decimals());
    }

    /** 这一档值不值得看（`> 1` 才有额外收益；判据只有这一处，按钮的置灰也读它） */
    static isWorthWatching(mul: number): boolean {
        return RewardAdBonus.roundMul(mul) > 1;
    }

    /**
     * 翻倍后的**总额**（金币 / 经验共用同一把尺，所以这是一个通用函数）。
     * 非正的基础值原样返回 0 —— 没发奖励就没有"翻倍"这回事。
     */
    static boosted(base: number, mul: number): number {
        const b = Math.max(0, Math.floor(base) || 0);
        if (b <= 0) return 0;
        return Math.max(b, Math.round(b * RewardAdBonus.roundMul(mul)));
    }

    /** 看完广告要**补发**的差额（= `boosted - base`；恒 ≥ 0） */
    static bonus(base: number, mul: number): number {
        const b = Math.max(0, Math.floor(base) || 0);
        return Math.max(0, RewardAdBonus.boosted(b, mul) - b);
    }

    /** 一句话说明（日志用）：`看广告 ×2.3 → 金币 +144 ⇒ +331（补 +187）· 经验 +80 ⇒ +184（补 +104）` */
    static describe(gold: number, heroExp: number, mul: number): string {
        const g = Math.max(0, Math.floor(gold) || 0);
        const e = Math.max(0, Math.floor(heroExp) || 0);
        return `看广告 ×${RewardAdBonus.format(mul)} →`
            + ` 金币 ${g} ⇒ ${RewardAdBonus.boosted(g, mul)}（补 +${RewardAdBonus.bonus(g, mul)}）`
            + ` · 经验 ${e} ⇒ ${RewardAdBonus.boosted(e, mul)}（补 +${RewardAdBonus.bonus(e, mul)}）`;
    }
}
