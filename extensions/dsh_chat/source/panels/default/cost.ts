/**
 * 花费那一块的**纯函数**：把四个字段（金额 / 显示口径 / 账本事实 / 读账本失败的原因）
 * 变成面板要画的文字。
 *
 * ## 为什么单独一个文件
 *
 * 与 `progress.ts` / `mention.ts` 同一个理由：面板的 DOM 代码没法直接测，所以凡是
 * **有正确答案**的东西（格式化、该说哪句话）一律搬到这里 —— `scripts/verify-panel.js`
 * 会把编译出来的 `dist/panels/default/cost.js` `require` 进来跑一张已知答案表。
 * 本文件**零依赖**（只 `import type`），预览器与浏览器里都能跑。
 *
 * ## 为什么这里管「说明」，而 `stats.ts` 不管
 *
 * `stats.ts` 只负责**读数据**（读缓存、读账本、认形状），一句面板上的话都不写；
 * 凡是「这两个数为什么不一样」「钱为什么显示成这个符号」都由这一份说。
 * 两处各说一半就会互相打架（同一个原因在抽屉里出现两遍，而两遍的措辞还不一样）。
 *
 * ## 为什么格式化要「逐字移植」而不是自己写
 *
 * 面板上显示的钱必须和 DSH 自己（web 那边的花费面板）**同一个数、同一种写法**，
 * 否则用户看到两个不一致的金额时，没有任何办法判断哪个是真的。
 * 所以 `formatMoney` 是上游 `dsh-cost-meter/lib/pricing.js` 那个函数的逐字移植，
 * 连「数值过小时自动放宽两位小数」这种细节都照搬 —— `scripts/verify-stats.js` 里有一条
 * 断言**把真插件 import 进来对拍**（装了插件才跑，没装就跳过并说明）。
 */

import type { CostDisplay, CostLedgerView } from '../../constants';

/** 这条会话在检查点里的花费（`costUsage.totals.cost` 归一化之后的那三个字段）。 */
export interface CostFacts {
    amount: number;
    provider: string;
    model: string;
}

/**
 * 上游 `formatMoney` 的逐字移植（见文件头注释）。
 *
 * @param usdCost - **美元**金额（投影缓存里那个 `cost` 就是美元）。
 * @param display - 账本里的显示设置（币种 / 符号 / 小数位 / 汇率）。
 * @returns 带货币符号的字符串，例如 `¥19.09` / `$2.65`。
 */
export function formatMoney(usdCost: number, display: CostDisplay): string {
    const rate = Number(display.exchangeRate);
    const value = usdCost * (Number.isFinite(rate) && rate > 0 ? rate : 1);
    const symbol = display.symbol.length > 0 ? display.symbol : '$';
    const req = Number(display.decimals);
    const decimals = Math.max(0, Math.min(10, Number.isFinite(req) ? Math.floor(req) : 2));
    let effective = decimals;
    // 数值过小时放宽两位（上游就是这么写的，逐字照搬：`10 ** -decimals` 那个判断）。
    if (value > 0 && value < 10 ** -decimals) effective = decimals + 2;
    const fixed = value.toFixed(effective);
    const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
    return `${symbol}${trimmed}`;
}

/**
 * 两处金额差多少才算「对不上」：绝对 0.0001 美元，或者相对 1%。
 *
 * 为什么不要求分毫不差：账本保留的是**调用当时**按当时价表算出的金额，而检查点会用
 * **当前**价表把整份日志重折一遍 —— 改过价表或汇率之后两者本来就会不一样，
 * 而那种差异通常很小。真正要报出来的是「差了一个数量级」这类。
 */
const COST_DISAGREE_ABS = 0.0001;
const COST_DISAGREE_RATIO = 0.01;

/**
 * 「这条会话没有花费记录」的三种来路 —— **三种话术，一句都不许混**。
 *
 * 为什么值得单列：用户看到空白时唯一想知道的就两件事 ——「是不是坏了」与「我该做什么」。
 * 三种来路的答案完全不同：
 * - `mounted === true`：插件挂着，所以**只是这条会话太老**（或别的 profile 跑的）→ 不用做什么；
 * - `mounted === false`：这个 profile **刻意没挂**那个第三方 bundle（见下面那条注释）
 *   → 说清"这是本 profile 的选择"并给一条能直接粘的命令；
 * - `mounted === null`：连 profile 清单都读不到 → 老实说分不清，不猜（猜错的两种话术都很难看）。
 *
 * ## ⚠ `mounted === false` 在本工程是**常态**（2026-12 起）
 *
 * 本 profile 的决策是**零第三方 bundle**：`dsh-profile/package.json` 的 `dsh.profile.bundles`
 * 里只有两个 in-box 的 `@deepseek-ai/*`。原因是「声明了却没装」的代价**不是少一块功能**，
 * 而是 `resolveBundleDir` 直接抛 → **整棵树起不来**（面板上只有一句"agent 启动失败"）。
 * 所以这句话术不能写成"出问题了"，得写成"**我们刻意的**" + "想用怎么加回来"。
 *
 * @param mounted - 见 `constants.ts` 的 `SessionUsage.costMounted`。
 * @param bundle - 那个第三方 bundle 的名字（由 `stats.ts` 给，不在这里写死）。
 */
function noRecordNote(mounted: boolean | null, bundle: string): string {
    if (mounted === false) {
        return (
            `没有花费记录 —— 花费那一行由 ${bundle} 注册，而本 profile 刻意不挂它` +
            '（第三方 bundle 一旦声明了却没装，整个 agent 都起不来，所以这里只要 in-box 的那两层）。' +
            `别的功能不受影响；想用就在命令行跑一次 \`dsh plugin --profile cocos add ${bundle}\`（要网络），装完重开面板。`
        );
    }
    if (mounted === true) {
        return (
            `没有花费记录 —— 花费那一行由 ${bundle} 注册（这个 profile 挂着它），所以它只对「挂上之后跑过的会话」有值：` +
            '更早的会话、以及别的 profile 跑的会话都没有这一行。'
        );
    }
    return (
        `没有花费记录 —— 花费那一行由 ${bundle} 注册；读不到这个 profile 的清单，` +
        '所以分不清是「没装它」还是「这条会话太老」。'
    );
}

/** 花费那一块要画的文字（DOM 由 `index.ts` 建）。 */
export interface CostText {
    /**
     * 显示成多少钱（读不到账本时就是美元原值）；**一个金额都没有时是 null** ——
     * 那种情况下面板画「没有花费记录」，**绝不画 0**（0 会假装「没花钱」）。
     */
    amount: string | null;
    /** 主行左边：谁花的（`provider / model`）；金额来自账本时标明来路。 */
    head: string;
    /** 账本原值（**恒为美元**）—— 与 `amount` 并列画，避免「折算是怎么来的」说不清。 */
    usd: string | null;
    /** 账本记的模型调用次数；没有就是 null。 */
    calls: string | null;
    /** 账本里**今天**的花费（全部工程）；没有就是 null。 */
    today: string | null;
    /** 这一块要说的话（一条一条画）—— 来路、折算、对账、读失败的原因全在这里。 */
    notes: string[];
}

/** 美元原值的写法：四位小数（金额都不大，两位看不出差别）。 */
function usdText(amount: number): string {
    return `$${amount.toFixed(4)}`;
}

/**
 * 把用量那几个字段变成「花费」这一块的文字。
 *
 * **金额只有一个**（不是两处各画一个）：检查点里有就用检查点的，没有才退回账本里那条会话
 * （老会话的检查点里没有 `costUsage` 这一行）。两个都有时检查点优先，理由是抽屉里
 * 其它每一行都是同一个来路 —— 混两种来路会让「水位 / 落后多少条」失去意义；
 * 但**对不上就要说出来**，绝不挑一个安静地画。
 *
 * @param input.cost - 检查点里的花费；没有就是 null。
 * @param input.display - 账本里的显示设置；读不到就是 null（按美元原值画并说明）。
 * @param input.ledger - 账本里与这条会话有关的事实；没有就是 null。
 * @param input.note - 读账本失败的原因（`stats.ts` 给的原文）；没有就是 null。
 * @param input.mounted - 这个 profile 挂没挂那个 bundle（`null` = 读不到清单）。
 * @param input.bundle - 那个 bundle 的名字（话术里会写出来）。
 * @returns 该画的文字；**永远返回对象**（`amount === null` 表示这块没有金额可画）。
 */
export function costTextOf(input: {
    cost: CostFacts | null;
    display: CostDisplay | null;
    ledger: CostLedgerView | null;
    note: string | null;
    mounted: boolean | null;
    bundle: string;
}): CostText {
    const { cost, display, ledger, note, mounted, bundle } = input;
    const notes: string[] = [];
    // 读账本失败的原因**永远排第一句**（不管有没有金额：它是「为什么少了东西」的解释）
    if (note !== null) notes.push(note);

    const fromCheckpoint = cost !== null;
    const amount = fromCheckpoint ? cost.amount : (ledger ? ledger.sessionUsd : null);
    const todayUsd = ledger ? ledger.todayUsd : null;

    /**
     * ⚠ **一个金额都没有时立刻返回**，绝不能再说「显示口径」那几句：
     * 「上面显示的是账本原值（美元）」在**没有上面**的时候是一句凭空指路的话
     * （实测踩过：缺省那一屏上它指着「没有花费记录」）。
     * 这一条是**顺序**问题 —— 先判有没有金额、为什么没有，再谈怎么显示钱。
     */
    if (amount === null) {
        notes.push(noRecordNote(mounted, bundle));
        return { amount: null, head: '', usd: null, calls: null, today: null, notes };
    }

    // 没有显示口径就说清楚「为什么上面那个是美元」，这是**结论**，紧跟原因。
    if (display === null) {
        notes.push('没有账本的显示设置，就不知道你设的币种与汇率 —— 上面显示的是账本原值（美元）。');
    } else if (display.currency !== 'USD' || display.exchangeRate !== 1) {
        notes.push(
            `金额由 cost-meter 以美元入账，这里按账本里的显示设置（${display.currency}，汇率 ${display.exchangeRate}）` +
                `折成 ${display.symbol} 显示；价表本身是 ${display.pricingCurrency} 的。`,
        );
    }

    if (!fromCheckpoint) {
        notes.push('这条会话的检查点里没有花费行，金额取自 cost-meter 的账本（它按每次调用的实际价格记账）。');
    }

    const fromLedger = ledger ? ledger.sessionUsd : null;
    if (fromCheckpoint && fromLedger !== null && Math.abs(amount - fromLedger) > Math.max(COST_DISAGREE_ABS, Math.abs(fromLedger) * COST_DISAGREE_RATIO)) {
        notes.push(
            `两处金额对不上：检查点里是 ${usdText(amount)}，账本是 ${usdText(fromLedger)}。` +
                '账本保留的是调用当时按当时价表算出的金额，检查点会用当前价表把整份日志重折一遍，' +
                '所以改过价表或汇率之后两者就会不一样。上面显示的是检查点那一份。',
        );
    }

    if (todayUsd !== null) {
        notes.push('「今日」那一行是这台机器上所有工程加起来的一天，不只是本工程（账本是共享的）。');
    }

    return {
        amount: display ? formatMoney(amount, display) : usdText(amount),
        head: fromCheckpoint ? `${cost.provider || '?'} / ${cost.model || '?'}` : '本会话（来自账本）',
        usd: usdText(amount),
        calls: ledger && ledger.calls !== null ? `${ledger.calls} 次模型调用` : null,
        today: todayUsd !== null ? (display ? formatMoney(todayUsd, display) : usdText(todayUsd)) : null,
        notes,
    };
}
