/**
 * 「运行预览」（编辑器里的 game view）的**只读探针**。
 *
 * ## ⛔ 这个模块**不再开关预览**（2026-10-08 撤掉）
 *
 * 这里曾经有第三件事：`play` / `stop` / `pause` / `resume` / `step` 五个动作
 * （走 `Editor.Message.send` + 场景进程直调 `cce.PreviewPlay`）。**整条撤了**，
 * 因为它与**编辑器那块画布黑掉**的两次现场都在同一条时间线上，而它换来的能力在本工程几乎为零：
 *
 * | 时间 | 现场 |
 * |---|---|
 * | 2026-10-08 04:48 | `真机验收2.md` R6 跑完（含两次 `cce.PreviewPlay` 起停 + 抓图重绘）后，场景面板**画面停住**、切场景也不更新，**只有重启编辑器**恢复；`docs/冻结诊断.md` |
 * | 2026-10-08 14:59 | 面板 agent 加 `Cmp_Game` 那次会话里，同一块画布抓回来的是**全空的一张图**（`blankRatio 0.988`），用户看到的就是**黑屏** |
 *
 * 「预览」本身在这台真机上也**没什么用**：编辑器内跑起来后卡在首场景 `Loading` 的
 * `loadBundle('scripts')`（`0%`，既不成功也不失败，`cc.assetManager.bundles` 里只有 `internal`），
 * 也就是**在本工程里它根本进不了游戏**。
 *
 * ⇒ 现在只剩**只读**：`querySceneMode()` 问一句「场景现在处在哪个模式」。
 * 要跑游戏请人在编辑器工具栏上自己按那颗播放键 —— 那条路与本扩展无关，
 * 出了画面问题也不会有人以为是工具干的。
 *
 * ## 留下的这条只读路（三条诚实口径）
 *
 * 1. **不猜模式**：`query-scene-mode` 回来什么就报什么；只有落在已知那四个串上才归一成
 *    `mode`，否则 `'unknown'` + 原值（编辑器换版本时立刻看得见，而不是安静地猜错）。
 * 2. **失败不吞**：消息抛错就把编辑器原文放进 `error` —— 「这个版本的编辑器没有这条消息」
 *    与「预览没在跑」是两件事，不许混成一句。
 *    ⚠ 顺带一条**如实记下的事实**：`query-scene-mode` 这条消息在编辑器安装里**只有声明、没有任何调用方**
 *    （`builtin/scene/package.json:2038` 是它唯一出现的地方，`@types/message.d.ts` 里也没有它的类型），
 *    所以「它会回 `SceneModeType` 那几个字符串」只是**从 `queryMode()` 的签名推的、没被证实**。
 *    正因为这样，本模块**只把它当一条来源**：回什么就报什么，认不出就 `unknown`，
 *    而运行态的**真判据**是场景进程那条独立来源（`cce.PreviewPlay._state`，见 `source/scene.ts` 的
 *    `readSceneMode`）—— 它只读，不碰任何状态。
 */

/** 编辑器场景的四种模式（`@types/cce/3d/facade/scene-facade-state-interface.d.ts` 的 `SceneModeType`）。 */
export const SCENE_MODES = ['general', 'prefab', 'animation', 'preview'] as const;

/** 归一之后的模式；认不出来就是 `'unknown'`。 */
export type SceneMode = (typeof SCENE_MODES)[number] | 'unknown';

/** 一条 scene 消息的回执（失败也回，不抛）。 */
export interface MessageOutcome {
    ok: boolean;
    /** 消息的返回值原文（`Editor.Message.request` 的返回） */
    value?: unknown;
    /** 失败时编辑器的原文 */
    error?: string;
}

/** 模式的探针结果：**原始值 + 归一值 + 为什么不归一**。 */
export interface SceneModeProbe extends MessageOutcome {
    /** 归一后的模式 */
    mode: SceneMode;
    /** `value` 是字符串时的原文（没有就是 null） */
    raw: string | null;
    /** 认不出来时的说明（认得出来就是 undefined） */
    note?: string;
}

function describe(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object') {
        const anyErr = error as { message?: unknown };
        if (typeof anyErr.message === 'string') return anyErr.message;
    }
    return String(error);
}

/** 问 scene 包一句话（**不抛**：失败也回成 `{ok:false, error}`）。 */
async function askScene(message: string): Promise<MessageOutcome> {
    try {
        const value = await Editor.Message.request('scene', message);
        return { ok: true, value };
    } catch (err) {
        return { ok: false, error: describe(err) };
    }
}

/**
 * 问「场景现在是什么模式」。**只读**：这条消息不改任何状态。
 *
 * @returns `mode` 只在那四个已知串上才有值；否则 `'unknown'` + `note` + 原值。
 */
export async function querySceneMode(): Promise<SceneModeProbe> {
    const outcome = await askScene('query-scene-mode');
    const raw = typeof outcome.value === 'string' ? outcome.value.trim() : null;
    if (!outcome.ok) {
        return { ...outcome, mode: 'unknown', raw, note: '这条消息没问通（见 error）—— 模式未知' };
    }
    const hit = raw !== null ? SCENE_MODES.find((mode) => mode === raw) : undefined;
    if (hit) return { ...outcome, mode: hit, raw };
    return {
        ...outcome,
        mode: 'unknown',
        raw,
        note: raw === null ? `这条消息回的不是一个字符串：${JSON.stringify(outcome.value)}` : `模式串认不出来（${JSON.stringify(raw)}）`,
    };
}
