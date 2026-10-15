/**
 * 局内倍速（战斗 HUD 右侧 `speed` 三档）—— **数值与节点契约的唯一真源**。
 *
 * ── 它是什么 ──
 * 玩家在局内把**整局的推进速度**调快：阶段倒计时 / 刷怪节奏 / 战斗结算 / Boss 充能与场上限时
 * 一起按倍率推进（唯一入口 `Scene_Game_Stage.update`）。
 *
 * ⚠ **倍速不改任何数值收益**：一局的总击杀 / 总金币 / 总经验 / 通关奖励都按 `elapsed` 与配表走，
 *   倍速只是把同一局用更短的**现实时间**放完（18.8 分钟的单局，2× 下 ≈ 9.4 分钟）。
 *   所以它是**体验优化**，不是奖励 —— 别把它接进任何"给多少资源"的计算里。
 *
 * ⚠ **只缩规则与战斗两条线，不缩表现层**：打击反馈的顿帧账本（1s 窗口 ≤30ms）与
 *   印痕/屏幕层一律走**真实 dt**，倍速下"顿帧占游戏时间的比例"自然被稀释 —— 这是刻意的，
 *   不要为了"手感一致"去乘它（那会让 2× 下真实每秒的顿帧量翻倍）。
 *
 * ── 三条档位为什么是 1 / 1.5 / 2 ──
 * 本作是**自动战斗**，玩家的操作点是抽遗物 / 选技能 / 买 Buff / 放 Boss / 点怪切目标，
 * 而**三个功能面板打开时战斗是暂停的**（`panelPaused`）—— 所以倍速压的是"面板之外的观察与操作时间"。
 * 2× 是这台机器在"还能看清战场、来得及反应"前提下的上限；3× 以上只适合纯放置玩法，本作不是。
 *
 * ── 解锁 ──
 * 账号等级 ≥ `BATTLE_SPEED_UNLOCK_ACCOUNT_LEVEL` 时 HUD 才显示这三档（未解锁整块 `active=false`，
 * 而不是摆三个点不动的灰格子 —— 界面上不许出现"点不动又不说为什么"的按钮）。
 * 门槛取**账号等级**（局外、跨局）而不是局内等级：局内 2 级只要开局十几秒，挡不住任何人，
 * 而且每局都要重新解锁 = 重复惩罚。账号 2 级 ≈ 一两局通关，正好是"熟悉过游戏了"。
 */

/** 承载三档的父节点名（`View_Game_Stage` 的直接子节点） */
export const SPEED_ROOT_NODE = 'speed';

/** 一个倍速档位 */
export interface BattleSpeedStep {
    /** 倍率（喂给时间源；1 = 原速） */
    mul: number;
    /** 按钮文案 */
    label: string;
    /** 按钮节点名（`speed` 的子节点） */
    node: string;
}

/**
 * 三档（**顺序 = 界面上从上到下**）。
 *
 * ⚠ 节点名同时是代码找节点的键（HUD 运行时按名字取、不拖 `@property`），
 *   改名字要连着预制件一起改（同 `SPEED_ROOT_NODE` 的做法）。
 */
export const BATTLE_SPEED_STEPS: BattleSpeedStep[] = [
    { mul: 1, label: '1×', node: 'x1' },
    { mul: 1.5, label: '1.5×', node: 'x1_5' },
    { mul: 2, label: '2×', node: 'x2' },
    { mul: 3, label: '3×', node: 'x3' },
];

/** 默认倍率（= 第一档）。⚠ 跨局保留玩家选的档位，换局**不**复位成它 */
export const BATTLE_SPEED_DEFAULT = BATTLE_SPEED_STEPS[0].mul;

/**
 * 解锁倍速所需的**账号等级**（局外，`DataCenter.ins.playerInfo.data.level`）。
 * 想改成配表驱动 → 挪进 `battle_constants.json`（同 `skillSlotUnlockLevels` 的形态）。
 */
export const BATTLE_SPEED_UNLOCK_ACCOUNT_LEVEL = 2;

/** 按倍率取档位（认不出来 → 默认档，绝不返回 undefined 让调用方炸） */
export function findSpeedStep(mul: number): BattleSpeedStep {
    for (const s of BATTLE_SPEED_STEPS) {
        if (Math.abs(s.mul - mul) < 1e-6) return s;
    }
    return BATTLE_SPEED_STEPS[0];
}
