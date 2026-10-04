/**
 * 工具卡片：把一条 `tool/call` + `tool/result` 渲染成一张能读的卡片。
 *
 * ## DSH 的做法（我们照抄的部分）
 *
 * DSH 的 web 客户端把每次工具调用分派给按**工具名**键控的视图，内置了
 * shell/终端、read（文件）、write/edit（diff）、grep/glob（搜索）、web、todo、question
 * 这些卡片，认不出的走通用卡片；卡片头永远显示 运行中/成功/失败/中断 四态，
 * 内容默认折叠、点开才看原始入参与结果。这里就是这套分派的最小可用版。
 *
 * ## 为什么标题要按工具名自己拼
 *
 * 卡片头上写 `pwsh` 等于没写 —— 用户想知道的是「跑了哪条命令」「动了哪个文件」。
 * 所以 `describeTool` 从入参里抽出**那一条**信息当标题（命令 / 路径 / pattern / 问题），
 * 工具名退到次要位置。认不出结构就老实用工具名 + 原始入参（不猜）。
 *
 * 纯 DOM，无依赖；`args` 是模型给的字符串（未必是合法 JSON），解析失败一律回落原文。
 */

import type { Entry, ToolEntry } from '../../constants';
import { copyText } from './markdown';

/** 建元素小工具。 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** 卡片的种类（决定字形与标题写法）。 */
type ToolKind = 'terminal' | 'read' | 'diff' | 'search' | 'todo' | 'question' | 'code' | 'web' | 'generic';

/** 每个种类一个字形 —— 面板窄，图标用单字符，不引图标字体。 */
const GLYPH: Record<ToolKind, string> = {
    terminal: '❯',
    read: '▤',
    diff: '±',
    search: '⌕',
    todo: '☑',
    question: '?',
    code: '⟨⟩',
    web: '↗',
    generic: '•',
};

/** 按工具名分派种类。 */
function kindOf(name: string): ToolKind {
    const n = name.toLowerCase();
    if (/(^|_)(pwsh|bash|shell|terminal|exec|run_command)/.test(n)) return 'terminal';
    if (/(^|_)(read|cat|open_file|view)/.test(n)) return 'read';
    if (/(^|_)(write|edit|str_replace_editor|multi_edit|apply_patch|patch)/.test(n)) return 'diff';
    if (/(^|_)(grep|glob|search|find|fs_search|list_dir)/.test(n)) return 'search';
    if (/(^|_)(todo)/.test(n)) return 'todo';
    if (/(^|_)(ask_user_question|question|ask)/.test(n)) return 'question';
    if (/(^|_)cocos_(execute_code|describe_api|editor_state)/.test(n) || /(^|_)(code|script|execute)/.test(n)) return 'code';
    if (/(^|_)web_(search|fetch)/.test(n)) return 'web';
    return 'generic';
}

/** 解析入参：能当 JSON 对象用就顺手取字段，取不到一律回落原文（不猜结构）。 */
function parseArgs(raw?: string): { object: Record<string, unknown> | null; text: string; pretty: string } {
    const text = raw ?? '';
    if (!text.trim()) return { object: null, text, pretty: '' };
    try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { object: parsed as Record<string, unknown>, text, pretty: JSON.stringify(parsed, null, 2) };
        }
        return { object: null, text, pretty: JSON.stringify(parsed, null, 2) };
    } catch {
        return { object: null, text, pretty: text };
    }
}

/** 从入参里挑第一个非空字符串字段。 */
function pickString(object: Record<string, unknown> | null, keys: string[]): string {
    if (!object) return '';
    for (const key of keys) {
        const value = object[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

/** 单行化 + 截断（卡片头只有一行，长命令要能省略）。 */
function oneLine(text: string, limit = 160): string {
    const flat = text.replace(/\s*\n\s*/g, ' ⏎ ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 卡片的标题视图。 */
export interface ToolView {
    kind: ToolKind;
    glyph: string;
    /** 主标题（给人看的：命令/路径/pattern）。 */
    title: string;
    /** 标题是不是代码（命令、路径、pattern 用等宽，中文描述不用）。 */
    titleIsCode: boolean;
    /** 工具名（次要信息，永远显示）。 */
    name: string;
}

/** 拼一张卡片的标题。 */
export function describeTool(tool: ToolEntry): ToolView {
    const name = tool.name || 'unknown';
    const kind = kindOf(name);
    const { object } = parseArgs(tool.args);
    const view = (title: string, titleIsCode = true): ToolView => ({
        kind,
        glyph: GLYPH[kind],
        title: oneLine(title) || name,
        titleIsCode,
        name,
    });

    switch (kind) {
        case 'terminal': {
            const command = pickString(object, ['command', 'cmd', 'script', 'input']);
            return view(command || name);
        }
        case 'read':
        case 'diff': {
            const path = pickString(object, ['path', 'file_path', 'filePath', 'filename', 'file']);
            const range = pickString(object, ['offset']);
            return view(path ? `${path}${range ? ` @${range}` : ''}` : name);
        }
        case 'search': {
            const pattern = pickString(object, ['pattern', 'query', 'glob', 'path', 'regex']);
            return view(pattern || name);
        }
        case 'todo': {
            const todos = object?.todos;
            const count = Array.isArray(todos) ? todos.length : 0;
            return { kind, glyph: GLYPH[kind], title: count ? `更新待办（${count} 项）` : name, titleIsCode: false, name };
        }
        case 'question': {
            const question = pickString(object, ['question', 'prompt', 'header']);
            return { kind, glyph: GLYPH[kind], title: question || name, titleIsCode: false, name };
        }
        case 'code': {
            const context = pickString(object, ['context']);
            const target = pickString(object, ['target']);
            const code = pickString(object, ['code', 'source']);
            // describe_api 没有 code、只有 target；execute_code 反之。两者共用一个标题槽位。
            const detail = target || (code ? oneLine(code, 90) : '');
            const title = [context ? `[${context}]` : '', detail].filter(Boolean).join(' ');
            return { kind, glyph: GLYPH[kind], title: title || name, titleIsCode: true, name };
        }
        case 'web': {
            const target = pickString(object, ['query', 'url', 'q']);
            return view(target || name);
        }
        default: {
            const first = pickString(object, ['description', 'summary', 'goal', 'objective', 'name']);
            return { kind, glyph: GLYPH[kind], title: first || name, titleIsCode: !first, name };
        }
    }
}

/** 时长文案（有结果时间才算得出来）。 */
function durationText(entry: Entry): string {
    const tool = entry.tool;
    if (!tool?.endedAt || !entry.at) return '';
    const ms = Math.max(0, tool.endedAt - entry.at);
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms / 60000)}min`;
}

/** 卡片上的状态（含四态与时长）。 */
function stateOf(tool: ToolEntry): { label: string; state: 'running' | 'ok' | 'error'; duration: string } {
    if (!tool.done) return { label: '运行中', state: 'running', duration: '' };
    if (tool.ok === false) return { label: '失败', state: 'error', duration: '' };
    return { label: '完成', state: 'ok', duration: '' };
}

/** 结果默认是否展开：失败的展开（否则用户只看到一个红字，还得自己点开）。 */
export function defaultOpen(entry: Entry): boolean {
    return entry.tool?.done === true && entry.tool.ok === false;
}

/**
 * 建一张工具卡片。
 *
 * 展开状态由调用方持有（同一个 seq 的卡片会被反复重建，摊开/收起要跨重绘保留），
 * 所以这里把「用户点了头」通过 `onToggle` 回调交出去，不自己存状态。
 */
export function createToolCard(
    entry: Entry,
    open: boolean,
    onToggle: (next: boolean) => void,
): { root: HTMLElement; setOpen: (next: boolean) => void } {
    const tool = entry.tool ?? { name: '?' };
    const view = describeTool(tool);
    const status = stateOf(tool);
    const duration = durationText(entry);

    const root = el('div', 'dsh-tool');
    root.dataset.state = status.state;
    root.dataset.open = open ? 'true' : 'false';
    root.dataset.seq = String(entry.seq);

    const head = el('div', 'dsh-tool-head');
    head.appendChild(el('span', 'dsh-tool-glyph', view.glyph));

    const title = el('div', 'dsh-tool-title');
    if (view.titleIsCode) title.appendChild(el('code', undefined, view.title));
    else title.textContent = view.title;
    title.title = `${view.name}${tool.args ? `\n${tool.args}` : ''}`;
    head.appendChild(title);

    const state = el('span', 'dsh-tool-state');
    state.dataset.state = status.state;
    state.textContent = status.state === 'running' ? '● 运行中' : `${status.state === 'error' ? '✗' : '✓'} ${duration || status.label}`;
    head.appendChild(state);
    root.appendChild(head);

    const body = el('div', 'dsh-tool-body');
    const addBlock = (label: string, content: string, tone?: string): void => {
        const wrap = el('div');
        wrap.appendChild(el('div', 'dsh-tool-label', label));
        const pre = el('pre', 'dsh-pre', content);
        if (tone) pre.dataset.tone = tone;
        wrap.appendChild(pre);
        body.appendChild(wrap);
    };

    const { pretty } = parseArgs(tool.args);
    // 终端卡片标题就是那条命令，再重复一遍入参只是噪音
    if (pretty && view.kind !== 'terminal') addBlock('入参', pretty);
    if (tool.output) addBlock(view.kind === 'terminal' ? '输出' : '结果', tool.output, view.kind === 'terminal' ? 'terminal' : undefined);
    else if (!tool.done) addBlock('输出', '等待结果…', view.kind === 'terminal' ? 'terminal' : undefined);

    if (tool.output) {
        const copy = el('button', 'dsh-btn', '复制结果');
        copy.style.marginTop = '6px';
        copy.addEventListener('click', (event) => {
            event.stopPropagation();
            void copyText(tool.output ?? '').then((ok) => {
                copy.textContent = ok ? '已复制' : '复制失败';
                setTimeout(() => {
                    copy.textContent = '复制结果';
                }, 1200);
            });
        });
        body.appendChild(copy);
    }
    root.appendChild(body);

    const setOpen = (next: boolean): void => {
        root.dataset.open = next ? 'true' : 'false';
    };
    head.addEventListener('click', () => {
        const next = root.dataset.open !== 'true';
        setOpen(next);
        onToggle(next);
    });

    return { root, setOpen };
}
