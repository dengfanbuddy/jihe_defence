/**
 * 安全序列化器 —— Code Mode 的「出口闸门」。
 *
 * ## 为什么必须有它
 *
 * Code Mode 把「什么进模型上下文」的决定权交给了用户代码（`return` / `console.log`）。
 * 这在 Cocos 里会撞上三个硬问题：
 *
 * 1. **循环引用**：引擎对象是一张图 —— `node.parent.children` 指回自己，
 *    `component.node` 指回宿主。直接 `JSON.stringify` 会抛
 *    `Converting circular structure to JSON`，整次调用就废了。
 * 2. **深度爆炸**：`scene` 往下展开是整棵场景树，再往里是每个组件的内部字段，
 *    一个不小心就是几十万字符的响应体，把上下文一次烧光 —— 恰恰是 Code Mode 要避免的事。
 * 3. **不可序列化值**：`Function` / `Symbol` / getter 抛异常 / `BigInt`，
 *    以及跨 realm 的对象（沙箱里 `new Date()` 出来的实例，host 侧 `instanceof Date` 为 false）。
 *
 * ## 三条设计口径
 *
 * - **路径级防环**：用 WeakSet 记录「当前这条路径」上的对象，回溯时移除。
 *   菱形引用（同一个对象被两个兄弟字段引用）是合法的，会被正常展开两次 ——
 *   只有真正的环才记 `[Circular]`。宽而浅的爆炸由 `maxNodes` 全局预算兜住。
 * - **跨 realm 安全**：一律用 `Object.prototype.toString.call()` 判类型，不用 `instanceof`
 *   （沙箱代码造出来的 Date/Map/Set 在 host 侧 instanceof 全部为 false）。
 * - **引擎对象压成摘要**：带 `uuid` 且带 `_objFlags` 的对象（即 cc 的 `CCObject` 系：
 *   Node / Scene / Component / Asset）默认只输出 `[Node name=skill_details uuid=...]` 一行。
 *   要细节就在代码里显式取字段，或用场景沙箱里的 `dump()` ——
 *   **这正是「在沙箱里筛完再给模型看」的正确用法**。
 */

/** 引擎对象（带 uuid 的 cc 对象）的处理方式 */
export type EngineObjectMode = 'summary' | 'expand';

export interface SerializeOptions {
    /** 最大展开深度，根为 0。超出记 `[Depth]` */
    maxDepth: number;
    /** 单个数组最多保留多少项 */
    maxArrayLength: number;
    /** 单个对象最多保留多少个键 */
    maxObjectKeys: number;
    /** 单个字符串最多保留多少字符 */
    maxStringLength: number;
    /** 全局节点预算，防「宽而浅」的巨型结构拖死响应体 */
    maxNodes: number;
    /** 引擎对象的处理方式 */
    engineObjects: EngineObjectMode;
}

export const DEFAULT_SERIALIZE_OPTIONS: SerializeOptions = {
    maxDepth: 6,
    maxArrayLength: 100,
    maxObjectKeys: 60,
    maxStringLength: 4000,
    maxNodes: 20000,
    engineObjects: 'summary',
};

export interface SerializeResult {
    /** 已保证 JSON 安全的值 */
    value: unknown;
    /** 是否发生了任何形式的截断 */
    truncated: boolean;
    /** 命中的限制项（去重）—— 排查「为什么我看不到数据」时先看它 */
    limits: string[];
}

interface SerializeContext {
    opts: SerializeOptions;
    /** 当前访问路径上的对象（回溯时移除，故只拦真环） */
    seen: WeakSet<object>;
    nodes: number;
    limits: Set<string>;
}

/** 跨 realm 安全的类型标签，如 `[object Date]` */
function typeTag(value: object): string {
    try {
        return Object.prototype.toString.call(value);
    } catch {
        return '[object Unknown]';
    }
}

function mark(ctx: SerializeContext, limit: string): void {
    ctx.limits.add(limit);
}

function clipString(ctx: SerializeContext, text: string): string {
    const max = ctx.opts.maxStringLength;
    if (text.length <= max) return text;
    mark(ctx, 'maxStringLength');
    return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}

/**
 * 判断是否 cc 的 `CCObject` 系（Node / Scene / Component / Asset…）。
 *
 * 判据是「有字符串 uuid」且「自身或原型链上有 `_objFlags`」——
 * `_objFlags` 是 `CCObject` 构造函数里赋的实例字段，用户自己造的数据对象不会有。
 * 主进程里拿不到 cc 模块，所以只能这样 duck-type。
 */
function engineObjectTag(value: Record<string, unknown>): string | null {
    const uuid = value.uuid;
    if (typeof uuid !== 'string' || uuid.length === 0) return null;
    let hasFlags = false;
    try {
        hasFlags = '_objFlags' in value;
    } catch {
        hasFlags = false;
    }
    if (!hasFlags) return null;

    let ctorName = 'CCObject';
    try {
        const ctor = (value as { constructor?: { name?: string } }).constructor;
        if (ctor && typeof ctor.name === 'string' && ctor.name) ctorName = ctor.name;
    } catch {
        /* 忽略 */
    }
    const name = typeof value.name === 'string' && value.name ? ` name=${value.name}` : '';
    return `[${ctorName}${name} uuid=${uuid}]`;
}

function walk(ctx: SerializeContext, value: unknown, depth: number): unknown {
    ctx.nodes += 1;
    if (ctx.nodes > ctx.opts.maxNodes) {
        mark(ctx, 'maxNodes');
        return '[BudgetExhausted]';
    }

    if (value === null) return null;

    switch (typeof value) {
        case 'undefined':
            return '[undefined]';
        case 'boolean':
            return value;
        case 'number':
            return Number.isFinite(value) ? value : `[${String(value)}]`;
        case 'bigint':
            return `${String(value)}n`;
        case 'symbol':
            return String(value);
        case 'string':
            return clipString(ctx, value);
        case 'function': {
            const fn = value as (...args: unknown[]) => unknown;
            return `[Function ${fn.name || 'anonymous'}]`;
        }
        default:
            break;
    }

    // ---- 以下是 object ----
    const obj = value as Record<string, unknown>;
    const tag = typeTag(obj);

    switch (tag) {
        case '[object Date]':
            try {
                return (obj as unknown as Date).toISOString();
            } catch {
                return '[Invalid Date]';
            }
        case '[object RegExp]':
            return String(obj);
        case '[object Error]': {
            const err = obj as unknown as Error;
            return {
                __error: err.name || 'Error',
                message: typeof err.message === 'string' ? clipString(ctx, err.message) : undefined,
                stack: typeof err.stack === 'string' ? clipString(ctx, err.stack) : undefined,
            };
        }
        case '[object Map]': {
            if (depth >= ctx.opts.maxDepth) {
                mark(ctx, 'maxDepth');
                return '[Depth]';
            }
            const map = obj as unknown as Map<unknown, unknown>;
            const out: Record<string, unknown> = {};
            let i = 0;
            try {
                for (const [k, v] of map) {
                    if (i >= ctx.opts.maxArrayLength) {
                        mark(ctx, 'maxArrayLength');
                        out['…'] = `+${map.size - i} more entries`;
                        break;
                    }
                    out[String(k)] = walk(ctx, v, depth + 1);
                    i += 1;
                }
            } catch {
                return '[Map unreadable]';
            }
            return out;
        }
        case '[object Set]': {
            if (depth >= ctx.opts.maxDepth) {
                mark(ctx, 'maxDepth');
                return '[Depth]';
            }
            const set = obj as unknown as Set<unknown>;
            const out: unknown[] = [];
            let i = 0;
            try {
                for (const v of set) {
                    if (i >= ctx.opts.maxArrayLength) {
                        mark(ctx, 'maxArrayLength');
                        out.push(`…(+${set.size - i} more)`);
                        break;
                    }
                    out.push(walk(ctx, v, depth + 1));
                    i += 1;
                }
            } catch {
                return '[Set unreadable]';
            }
            return out;
        }
        default:
            break;
    }

    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(obj)) {
        return `[Buffer ${obj.length}B]`;
    }
    if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
        const len = (obj as unknown as { length?: number }).length;
        return `[${tag.slice(8, -1)}(${typeof len === 'number' ? len : '?'})]`;
    }

    if (ctx.opts.engineObjects === 'summary') {
        const engineTag = engineObjectTag(obj);
        if (engineTag) return engineTag;
    }

    if (depth >= ctx.opts.maxDepth) {
        mark(ctx, 'maxDepth');
        return '[Depth]';
    }

    if (ctx.seen.has(obj)) return '[Circular]';
    ctx.seen.add(obj);
    try {
        if (Array.isArray(obj)) {
            const arr = obj as unknown as unknown[];
            const limit = Math.min(arr.length, ctx.opts.maxArrayLength);
            const out: unknown[] = new Array(limit);
            for (let i = 0; i < limit; i += 1) out[i] = walk(ctx, arr[i], depth + 1);
            if (arr.length > limit) {
                mark(ctx, 'maxArrayLength');
                out.push(`…(+${arr.length - limit} more)`);
            }
            return out;
        }

        let keys: string[] = [];
        try {
            keys = Object.keys(obj);
        } catch {
            keys = [];
        }
        const limit = Math.min(keys.length, ctx.opts.maxObjectKeys);
        const out: Record<string, unknown> = {};
        for (let i = 0; i < limit; i += 1) {
            const key = keys[i];
            try {
                out[key] = walk(ctx, obj[key], depth + 1);
            } catch (err) {
                // getter 抛异常是常态（引擎对象在非活跃状态下访问某些字段会炸）
                out[key] = `[Getter threw: ${(err as Error)?.message ?? 'unknown'}]`;
            }
        }
        if (keys.length > limit) {
            mark(ctx, 'maxObjectKeys');
            out['…'] = `+${keys.length - limit} more keys`;
        }
        return out;
    } finally {
        // 关键：回溯时移除 —— 只拦「真环」，放行菱形引用
        ctx.seen.delete(obj);
    }
}

/**
 * 把任意值压成 JSON 安全结构。
 *
 * @example
 * const { value, truncated, limits } = safeSerialize(scene);
 * // scene 是 cc.Scene → value 为 "[Scene name=Main uuid=...]"
 */
export function safeSerialize(value: unknown, options?: Partial<SerializeOptions>): SerializeResult {
    const ctx: SerializeContext = {
        opts: { ...DEFAULT_SERIALIZE_OPTIONS, ...(options ?? {}) },
        seen: new WeakSet<object>(),
        nodes: 0,
        limits: new Set<string>(),
    };
    const out = walk(ctx, value, 0);
    return { value: out, truncated: ctx.limits.size > 0, limits: Array.from(ctx.limits) };
}

/** 把值格式化成便于阅读的多行文本（用于日志行与 describe_api 输出） */
export function formatValue(value: unknown, options?: Partial<SerializeOptions>): string {
    const { value: safe } = safeSerialize(value, options);
    if (safe === undefined) return 'undefined';
    try {
        const text = JSON.stringify(safe, null, 2);
        return text === undefined ? String(safe) : text;
    } catch {
        return String(safe);
    }
}

/** 单行紧凑格式，用于日志行 */
export function formatInline(value: unknown, options?: Partial<SerializeOptions>): string {
    if (typeof value === 'string') return value;
    const { value: safe } = safeSerialize(value, options);
    try {
        const text = JSON.stringify(safe);
        return text === undefined ? String(safe) : text;
    } catch {
        return String(safe);
    }
}

// ---------------------------------------------------------------------------
// refs —— 把结果里「下一步能直接拿去用的标识」抽出来
// ---------------------------------------------------------------------------

/**
 * ## 为什么要有这一段
 *
 * 模型拿到一次 `execute_code` 的回执后，最常见的下一步是「用刚才那个节点/那张图」。
 * 但回执是一大坨 JSON，uuid 可能埋在 `[Node name=x uuid=…]` 摘要里、可能在
 * `db://` 路径的中间 —— 于是模型**重新查一遍**（多一轮），或者更糟：**凭记忆编一个**。
 *
 * 所以出口处统一扫一遍，把可复用的标识去重排在结尾。
 *
 * ## 只抽「不会认错」的两类
 *
 * - **全形 uuid**（`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`，可带 Cocos 子资源后缀 `@f9941`）；
 * - **`db://` 资源库 URL**。
 *
 * 刻意**不抽**压缩型 uuid（22~23 个 base64 字符那种）：任何一段 22 字符的单词都会命中，
 * 抽出来就是噪声。也不抽「节点路径」——`Canvas/x/y` 与普通文本无法区分。
 * 要这两类就在代码里显式 `return` 它们（全形或 `db://`）。
 */

/** 一条可直接复用的标识。 */
export interface ValueRef {
    kind: 'uuid' | 'dbUrl';
    value: string;
}

/** 抽取结果：`refs` 是（可能被截断的）列表，`total` 是**去重后**的实际命中数。 */
export interface RefCollection {
    refs: ValueRef[];
    total: number;
}

/** 全形 uuid（不带 `g`：`g` 版本由 `scanString` 自己维护 `lastIndex`）。 */
const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_RE_G = new RegExp(UUID_PATTERN, 'g');

/** 资源库 URL：`db://` 起，到第一个空白 / 引号 / 括号 / JSON 分隔符为止。 */
const DB_URL_RE_G = /db:\/\/[^\s"'`<>()[\]{},;]+/g;

/** 默认最多回几条 —— 够下一步用，又不会把回执撑大。 */
export const DEFAULT_REF_LIMIT = 12;

/** 扫描一段字符串，按**出现顺序**回调里面的标识。 */
function scanString(text: string, push: (ref: ValueRef) => void): void {
    if (text.length === 0) return;
    const found: Array<{ index: number; ref: ValueRef }> = [];

    DB_URL_RE_G.lastIndex = 0;
    for (let m = DB_URL_RE_G.exec(text); m; m = DB_URL_RE_G.exec(text)) {
        // 日志/文案里常常写成 `db://assets/x.ts...`（省略号不是路径的一部分）—— 去掉尾部的点
        const value = m[0].replace(/[.…]+$/, '');
        if (value.length > 'db://'.length) found.push({ index: m.index, ref: { kind: 'dbUrl', value } });
    }

    UUID_RE_G.lastIndex = 0;
    for (let m = UUID_RE_G.exec(text); m; m = UUID_RE_G.exec(text)) {
        // `uuid@f9941` 是 Cocos 的子资源寻址写法，一起带上（`loadFrame` 之类的助手认它）
        const sub = /^@[0-9a-zA-Z]+/.exec(text.slice(m.index + m[0].length));
        found.push({ index: m.index, ref: { kind: 'uuid', value: m[0] + (sub ? sub[0] : '') } });
    }

    found.sort((a, b) => a.index - b.index);
    for (const item of found) push(item.ref);
}

/**
 * 从任意（已序列化或未序列化的）值里抽取可复用标识。
 *
 * @param value - 任意值；字符串按内容扫，数组/对象递归，其它类型忽略。
 * @param options - `{limit}`：最多回几条（默认 12，上限 200）。
 * @returns `{refs, total}`；`total > refs.length` 说明还有更多没列出来。
 */
export function collectRefs(value: unknown, options?: { limit?: number }): RefCollection {
    const rawLimit = options?.limit;
    const limit = Math.max(1, Math.min(200, typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : DEFAULT_REF_LIMIT));
    const refs: ValueRef[] = [];
    const seen = new Set<string>();
    let total = 0;

    const push = (ref: ValueRef): void => {
        const key = `${ref.kind}:${ref.value}`;
        if (seen.has(key)) return;
        seen.add(key);
        total += 1;
        if (refs.length < limit) refs.push(ref);
    };

    const visit = (node: unknown, depth: number): void => {
        if (node === null || node === undefined || depth > 12) return;
        if (typeof node === 'string') {
            scanString(node, push);
            return;
        }
        if (typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const item of node) visit(item, depth + 1);
            return;
        }
        let keys: string[] = [];
        try {
            keys = Object.keys(node as Record<string, unknown>);
        } catch {
            return;
        }
        for (const key of keys) {
            let child: unknown;
            try {
                child = (node as Record<string, unknown>)[key];
            } catch {
                continue;
            }
            visit(child, depth + 1);
        }
    };

    visit(value, 0);
    return { refs, total };
}

/**
 * 把抽取结果拼成一段可直接接在工具文案后面的文本。
 *
 * @param collection - `collectRefs` 的返回。
 * @returns 多行文本；没有标识时回空串（调用方据此决定要不要接）。
 */
export function formatRefs(collection: RefCollection): string {
    if (collection.refs.length === 0) return '';
    const more =
        collection.total > collection.refs.length ? `，共 ${collection.total} 个，这里只列前 ${collection.refs.length} 个` : '';
    return [
        '',
        `--- refs（本次结果里出现过的可复用标识：uuid / db:// 路径，去重${more}）`,
        ...collection.refs.map((ref) => `- ${ref.value}`),
    ].join('\n');
}
