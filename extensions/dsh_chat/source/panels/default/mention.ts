/**
 * 输入框里的两个**触发器**：`@路径` 的 token 语法，与 `/命令` 的行首判定。
 *
 * ## 为什么 `@` 语法是「移植」而不是「自己写一套」
 *
 * DSH 把这一段做成了**浏览器安全、终端与 Web 共用**的语法模块
 * （`@deepseek-ai/dsh-file-reference` 的 `grammar.ts`）：`activeAtToken` 认光标处的
 * 活动 token，`formatFileMention` 决定选中后插入什么文本。它的每一条规则都是**撞出来**的：
 *
 * | 规则 | 为什么 |
 * |---|---|
 * | `@` 必须在行首或空白之后 | 否则 `a@b.com` 这种邮箱地址会把补全菜单弹出来 |
 * | 查询直接切到行尾即可（不需要「token 在光标前结束」的额外判断） | 正则锚在 `$` 上，天然只认「光标处的那个 token」 |
 * | 路径含空白 → 用 `@"..."` | 不用引号的话，`@my file.ts` 到模型那边会裂成两个 token |
 * | 选**目录**时不闭合引号（`@"dir/`） | 补全要能继续往下钻一层 |
 * | 控制字符 / 内嵌引号 → 返回 `undefined` | 语法表达不了，宁可不插入也不要插一条会被解析错的路径 |
 *
 * 所以这里**逐字移植**（含上面这些边界的写法），而不是「照意思重写一遍」——
 * 重写必然在某条边界上漂移，而漂移的表现是「某些路径插进去之后模型收到的不是那个路径」，
 * 那种 bug 从界面上根本看不出来。`scripts/verify-panel.js` 里有一条**对账**：
 * 拿同一批输入同时跑我们这份与 DSH 装的那份，逐字符比对结果。
 *
 * ⚠ 面板跑在编辑器的渲染进程里，**不能 import node_modules**（面板是纯 DOM、零依赖，
 * 见 `README` 的「界面」一节），所以只能移植 + 对账，不能直接引用。
 *
 * @module dsh_chat/panel/mention
 */

/** `@` 补全的一个候选（形状对齐 `FileReferenceCandidate`；面板只需要这两个字段）。 */
export interface MentionCandidate {
    /** 工作区相对路径。 */
    path: string;
    /** 目录选中后**继续往下钻**（引号保持打开），文件选中即完成。 */
    kind: 'file' | 'directory';
}

/** 光标处那个活动 `@` token（对齐 `ActiveAtToken`）。 */
export interface ActiveAtToken {
    /** 被替换掉的那一整段（含 `@` 与可能的开引号）。 */
    prefix: string;
    /** `@` 或 `@"` 之后的查询文本。 */
    query: string;
    /** 用户是不是显式打开了引号（`@"`）。 */
    quoted: boolean;
}

/**
 * 取光标处那个活动 `@` token。
 *
 * 移植自 `@deepseek-ai/dsh-file-reference/grammar` 的 `activeAtToken`（逐字）。
 *
 * @param line - 光标所在的那一行。
 * @param cursorCol - 光标在这一行里的列号。
 * @returns 活动 token；不在 `@` token 里时 `undefined`。
 */
export function activeAtToken(line: string, cursorCol: number): ActiveAtToken | undefined {
    const beforeCursor = line.slice(0, cursorCol);
    const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(beforeCursor);
    if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
        return { prefix: quoted[1], query: quoted[2], quoted: true };
    }
    const plain = /(?:^|\s)(@([^\s]*))$/u.exec(beforeCursor);
    if (plain?.[1] === undefined || plain[2] === undefined) return undefined;
    return { prefix: plain[1], query: plain[2], quoted: false };
}

/**
 * 把选中的候选格式化成要插入的提示词文本。
 *
 * 移植自 `@deepseek-ai/dsh-file-reference/grammar` 的 `formatFileMention`（逐字）。
 *
 * @param candidate - 选中的文件或目录。
 * @param preserveQuote - 用户已经打开了引号时，即使路径没空白也保持引号（否则他会看到引号凭空消失）。
 * @returns 插入文本；这条路径语法表达不了时 `undefined`。
 */
export function formatFileMention(candidate: MentionCandidate, preserveQuote: boolean): string | undefined {
    const path = candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path;
    if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
    const quoted = preserveQuote || /\s/u.test(path);
    if (!quoted) return `@${path}`;
    if (candidate.kind === 'directory') return `@"${path}`;
    return `@"${path}"`;
}

/**
 * 把「整个输入框的值 + 光标位置」换算成「光标所在行 + 行内列号」。
 *
 * 为什么需要这一步：`activeAtToken` 的口径是**一行**（DSH 的输入框本来就只有一行），
 * 而面板用的是 `<textarea>`（要能换行）。`@` 的查询不可能跨行，所以取光标前最后一个
 * 换行符切一刀就够了。
 *
 * @param value - textarea 的完整值。
 * @param caret - 光标在整个值里的偏移（`selectionStart`）。
 * @returns 行文本与行内列号。
 */
export function lineAt(value: string, caret: number): { line: string; col: number } {
    const at = Math.max(0, Math.min(caret, value.length));
    const start = value.lastIndexOf('\n', at - 1) + 1;
    const end = value.indexOf('\n', at);
    const line = value.slice(start, end === -1 ? value.length : end);
    return { line, col: at - start };
}

/**
 * 把光标处的活动 token 换成一段新文本。
 *
 * @param value - textarea 的完整值。
 * @param caret - 光标偏移。
 * @param token - `activeAtToken` 给的那个 token（要被换掉的就是它的 `prefix`）。
 * @param insertion - 要插入的文本（`formatFileMention` 的返回值）。
 * @returns 新的值与新的光标位置。
 */
export function replaceToken(
    value: string,
    caret: number,
    token: ActiveAtToken,
    insertion: string,
): { value: string; caret: number } {
    const at = Math.max(0, Math.min(caret, value.length));
    const head = value.slice(0, at);
    // `prefix` 一定贴在光标前面（它就是 `beforeCursor` 的尾部），找不到就说明调用时机错了 ——
    // 这时**一个字符都不改**，比改错位置强（宁可补全不生效，也不要把用户打的字弄乱）。
    if (!head.endsWith(token.prefix)) return { value, caret: at };
    const headStart = at - token.prefix.length;
    const next = `${value.slice(0, headStart)}${insertion}${value.slice(at)}`;
    return { value: next, caret: headStart + insertion.length };
}

/** 输入框里正在敲的那条命令（行首 `/` + 还没出现的空白）。 */
export interface CommandDraft {
    /** `/` 之后、空白之前的名字片段（可能是空的，表示刚敲下 `/`）。 */
    query: string;
}

/**
 * 判断输入框里现在是不是「正在敲命令名」。
 *
 * 与 `@` 不同，命令的语法是**行首**的（`ctx.commands` 的 `parseCommand`：第 0 字节必须是斜杠，
 * 名字之后全是 `rawInput`）。所以这里只在「整份输入就是 `/xxx`（还没有空白）」时才算触发器 ——
 * 一旦出现了空格，用户已经在写参数了，再弹菜单就是碍事。
 *
 * @param value - textarea 的完整值。
 * @param caret - 光标偏移。
 * @returns 正在敲的那段名字；不是命令草稿时 `undefined`。
 */
export function commandDraft(value: string, caret: number): CommandDraft | undefined {
    if (!value.startsWith('/')) return undefined;
    if (/\s/.test(value)) return undefined;
    // 只认「光标在末尾」：在中间编辑命令名时弹菜单会把方向键抢走，得不偿失
    if (caret !== value.length) return undefined;
    return { query: value.slice(1) };
}
