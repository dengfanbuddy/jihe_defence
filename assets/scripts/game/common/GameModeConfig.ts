/**
 * ============================================================
 * GameModeConfig —— **游戏模式**（主界面「游戏」页 `Scene_Menu/content/right/game` 那张模式卡）的唯一真源
 * ============================================================
 *
 * 纯 TS，**无 cc 依赖**：不碰节点、不读存档、不认识界面。它只回答四件事：
 *   ① 现在支持哪几个模式（`GAME_MODES`）；② 默认选哪个（`DEFAULT_GAME_MODE`）；
 *   ③ 每个模式叫什么、卡上那两行文案是什么（`name` / `desc`）；
 *   ④ 难度弹窗上那两格文案怎么写（标题点名模式：`gameModeDifficultyTitle` / 计数：`gameModeDifficultyCount`）。
 *
 * ── 三条口径（改之前先读）──
 *   ① **模式 id 就是卡片节点的名字**：`content/right/game/lists/contents/<id>`。
 *      于是「加一个模式」= 加一行 `GAME_MODES` + 在预制件 `contents` 下摆一张同名卡，
 *      代码里**没有第二张表**要同步（`card-002`「挑战boss」这类还没做的卡会被代码显式收起）。
 *   ② **模式与难度是两个正交的轴**：模式决定"这一局怎么玩"（有无终点），
 *      难度决定"这一局多难"（`DifficultyConfig` 的 1~100 档）。
 *      两者都存 `LevelData`，但**只有模式被记在"当前选中"里**，档位是**按模式各记一份**。
 *   ③ **模式本身不做解锁**（本期两种模式随时可切）：`no_ending` 的可玩档位与
 *      `stage` 共用同一条解锁阶梯（`LevelData.getUnlockedLevel()` = 已通关的最高档 + 1）——
 *      设计稿的口径是「无尽模式 = 在已解锁难度上无限阶段」（`docs/prd/肉鸽塔防_游戏设计定案.md` §14.3）。
 *
 * ⚠ **局内的差异尚未落地**：`Scene_Game_Stage` 现在只把模式读进
 *   `battleStore.mode`（HUD 左上角会显示模式名），**还没有按模式改玩法规则** ——
 *   无尽模式目前仍会走到最终 Boss 阶段结束。要落地就在这里加标记位，
 *   在 `Scene_Game_Stage.checkStage` 一处消费（见 `docs/game-mode/README.md` §5）。
 *
 * @example
 * ```ts
 * import { GAME_MODES, DEFAULT_GAME_MODE, gameModeName } from '../common/GameModeConfig';
 *
 * gameModeName('no_ending');            // → '无尽模式'
 * gameModeName('card-002');             // → '阶段模式'（非法一律回落默认，不抛错）
 * ```
 */

/** 模式 id（**与预制件里那张卡的名字逐字相同**） */
export const GameMode = {
    /** 阶段模式：1~100 档，打到最终 Boss 通关（现役唯一有终点的模式） */
    Stage: 'stage',
    /** 无尽模式：先选一个基准难度，局内无阶段上限（**局内规则待落地**，见文件头） */
    NoEnding: 'no_ending',
} as const;

export type GameModeId = typeof GameMode[keyof typeof GameMode];

/** 一个模式的展示信息（全部来自本文件，预制件里的文案只是占位） */
export interface GameModeInfo {
    /** 模式 id（= 卡片节点名） */
    id: GameModeId;
    /** 卡上第一行 / 顶部信息区的标题 */
    name: string;
    /** 卡上第二行 / 顶部信息区的说明（**含 `\n`，预制件里的 Label 按两行排版**） */
    desc: string;
}

/**
 * 支持的模式列表 —— **顺序 = 预制件 `contents` 下的卡片顺序**（代码按名字匹配，不按下标）。
 *
 * 只有列在这里的模式才是"支持的"：`contents` 下别的卡片（如 `card-002`「挑战boss」）
 * 会被 `Cmp_Game` 显式 `active = false` 收起，点不动。
 */
export const GAME_MODES: readonly GameModeInfo[] = [
    {
        id: GameMode.Stage,
        name: '阶段模式',
        desc: '逐步挑战更高难度，\n解锁新的敌人和奖励',
    },
    {
        id: GameMode.NoEnding,
        name: '无尽模式',
        desc: '无尽的敌人浪潮，\n挑战你的极限生成能力',
    },
];

/** 默认模式（**首次进主界面 / 存档里的模式非法**时用它 —— 与需求一致：默认选中阶段模式） */
export const DEFAULT_GAME_MODE: GameModeId = GameMode.Stage;

/** 这个值是不是一个**受支持**的模式 id（脏存档 / 资源改名时的唯一判据） */
export function isGameMode(value: unknown): value is GameModeId {
    return GAME_MODES.some((m) => m.id === value);
}

/**
 * 把任意输入收敛成受支持的模式 id（非法一律回 `DEFAULT_GAME_MODE`）。
 * **不抛错、不写盘** —— 脏存档的收敛一律在读取时做（与 `LevelData` 同口径）。
 */
export function normalizeGameMode(value: unknown): GameModeId {
    return isGameMode(value) ? value : DEFAULT_GAME_MODE;
}

/** 取一个模式的展示信息（非法 id 回落默认模式，界面不会画出空标题） */
export function getGameModeInfo(value: unknown): GameModeInfo {
    const id = normalizeGameMode(value);
    return GAME_MODES.find((m) => m.id === id) ?? GAME_MODES[0];
}

/** 模式名（卡上/顶部信息区的标题） */
export function gameModeName(value: unknown): string {
    return getGameModeInfo(value).name;
}

/** 模式说明（卡上/顶部信息区的两行小字） */
export function gameModeDesc(value: unknown): string {
    return getGameModeInfo(value).desc;
}

/**
 * 难度弹窗**标题**那一行（`ui_difficulty/panel/header/title`）。
 *
 * 弹窗是**按模式打开**的（"点开始游戏先展示此模式要玩的难度"），所以标题必须点名模式 ——
 * 否则玩家看不出自己正要开哪一套难度。
 *
 * ⚠ **为什么是"选难度"而不是"难度选择"**：标题框只有 120px 宽、`overflow = NONE`（不裁字但会**溢出**绘制），
 *   而它左边就是面板边缘、右边是 `count` 与关闭按钮。实测（`labelFit`，canvas 真量）：
 *   `阶段模式 · 难度选择` = 267px（左边缘 -325 < 面板 -320，**压出面板**）；
 *   `阶段模式 · 选难度` = 237px（[-310, -74]，面板内、离 count 还有 221px）✓
 *   改文案前**先用 `labelFit` 量一遍**，别凭感觉加字。
 */
export function gameModeDifficultyTitle(value: unknown): string {
    return `${gameModeName(value)} · 选难度`;
}

/**
 * 难度弹窗顶部那行计数（`ui_difficulty/panel/header/count`）。
 *
 * ⚠ 这里**不点名模式**：count 框只有 93px、右边 24px 就是关闭按钮，
 *   `阶段模式 · 共 100 关` 实测 200px 会**盖住关闭按钮**（模式名放在 `title` 里，见上）。
 */
export function gameModeDifficultyCount(count: number): string {
    const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    return `共 ${total} 关`;
}
