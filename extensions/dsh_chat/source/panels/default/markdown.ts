/**
 * 面板里的 markdown 渲染（子集实现）。
 *
 * ## 为什么自己写
 *
 * 面板**不许装依赖**（扩展刻意零 node_modules，克隆下来就能编），而模型输出里
 * 标题/列表/代码块/表格/行内标记全都常见 —— 只认代码块的话，回答就是一坨纯文本，
 * 这正是「界面太简陋」的一半原因（另一半是工具卡片，见 `tool-card.ts`）。
 *
 * ## 两条硬口径
 *
 * 1. **绝不用 `innerHTML`**：模型输出是不可信文本，拼字符串就有注入面。这里一律
 *    `createElement` + `textContent` 拼 DOM，链接只留 `href`（`noopener`）不做任何跳转。
 * 2. **只实现语料里真会出现的子集**：围栏代码块、标题、有序/无序列表、引用、分隔线、
 *    表格、段落；行内支持 `code` / **粗体** / *斜体* / ~~删除~~ / [链接](url) / 裸 URL。
 *    不做嵌套列表、脚注、HTML 内联 —— 多写的那部分只会是没人验证的死代码。
 *
 * 说明：不引语法高亮。DSH 的 shiki 主题 token 已经抽进 `dsw-tokens.css`，
 * 真要做高亮时按那套 token 上色即可；现在代码块的观感（底色 + banner + 复制）已经对齐。
 */

/** 建元素的小工具（都是纯 DOM，无注入面）。 */
function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** 复制文本：优先剪贴板 API，失败回落 `execCommand`（面板里两者都可能被限）。 */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* 落到下面那条 */
    }
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    } catch {
        return false;
    }
}

/** 行内标记：`` `code` `` / `**粗**` / `*斜*` / `~~删~~` / `[文字](url)`。 */
const INLINE_PATTERN =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~|\[[^\]\n]*\]\([^)\s]+\))/g;

/** 裸 URL（只在纯文本片段里找）。 */
const URL_PATTERN = /(https?:\/\/[^\s<>()"']+)/g;

/** 建一个链接（不做跳转以外的任何事）。 */
function anchor(href: string, label: string): HTMLAnchorElement {
    const a = el('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = href;
    a.textContent = label;
    return a;
}

/** 渲染一段行内文本（递归一层：粗体里还能有行内代码）。 */
export function renderInline(host: HTMLElement, text: string): void {
    const parts = text.split(INLINE_PATTERN);
    for (const part of parts) {
        if (!part) continue;
        if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
            host.appendChild(el('code', undefined, part.slice(1, -1)));
            continue;
        }
        if (part.length > 4 && (part.startsWith('**') || part.startsWith('__')) && part.slice(-2) === part.slice(0, 2)) {
            const strong = el('strong');
            renderInline(strong, part.slice(2, -2));
            host.appendChild(strong);
            continue;
        }
        if (part.length > 4 && part.startsWith('~~') && part.endsWith('~~')) {
            const del = el('del');
            renderInline(del, part.slice(2, -2));
            host.appendChild(del);
            continue;
        }
        if (part.length > 2 && (part.startsWith('*') || part.startsWith('_')) && part.slice(-1) === part.slice(0, 1)) {
            const em = el('em');
            renderInline(em, part.slice(1, -1));
            host.appendChild(em);
            continue;
        }
        const link = /^\[([^\]\n]*)\]\(([^)\s]+)\)$/.exec(part);
        if (link) {
            const a = anchor(link[2], '');
            renderInline(a, link[1] || link[2]);
            host.appendChild(a);
            continue;
        }
        // 纯文本：顺手把裸 URL 变成链接
        const pieces = part.split(URL_PATTERN);
        for (const piece of pieces) {
            if (!piece) continue;
            if (piece.startsWith('http://') || piece.startsWith('https://')) host.appendChild(anchor(piece, piece));
            else host.appendChild(document.createTextNode(piece));
        }
    }
}

/** 一个代码块（banner 上放语言 + 复制按钮）。 */
function codeBlock(language: string, code: string): HTMLElement {
    const wrap = el('div', 'dsh-code');
    const head = el('div', 'dsh-code-head');
    head.appendChild(el('span', 'dsh-code-lang', language || 'text'));
    const copy = el('button', 'dsh-btn', '复制');
    copy.addEventListener('click', (event) => {
        event.stopPropagation();
        void copyText(code).then((ok) => {
            copy.textContent = ok ? '已复制' : '复制失败';
            setTimeout(() => {
                copy.textContent = '复制';
            }, 1200);
        });
    });
    head.appendChild(copy);
    const pre = el('pre');
    pre.textContent = code;
    wrap.append(head, pre);
    return wrap;
}

/** 表格行 / 分隔行。 */
function tableCells(line: string): string[] {
    return line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
}

/** 渲染 markdown 到 `host`（会先清空）。 */
export function renderMarkdown(host: HTMLElement, text: string): void {
    host.textContent = '';
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const paragraph: string[] = [];

    const flushParagraph = (): void => {
        if (paragraph.length === 0) return;
        const p = el('p');
        renderInline(p, paragraph.join('\n'));
        host.appendChild(p);
        paragraph.length = 0;
    };

    let index = 0;
    while (index < lines.length) {
        const line = lines[index];

        // 围栏代码块
        const fence = /^\s*(?:```|~~~)\s*(\S*)\s*$/.exec(line);
        if (fence) {
            flushParagraph();
            const body: string[] = [];
            index += 1;
            while (index < lines.length && !/^\s*(?:```|~~~)\s*$/.test(lines[index])) {
                body.push(lines[index]);
                index += 1;
            }
            index += 1; // 吃掉收尾的围栏
            host.appendChild(codeBlock(fence[1], body.join('\n')));
            continue;
        }

        if (/^\s*$/.test(line)) {
            flushParagraph();
            index += 1;
            continue;
        }

        const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
            flushParagraph();
            const level = Math.min(6, Math.max(1, heading[1].length));
            const node = document.createElement(`h${level}`) as HTMLHeadingElement;
            renderInline(node, heading[2]);
            host.appendChild(node);
            index += 1;
            continue;
        }

        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            flushParagraph();
            host.appendChild(el('hr'));
            index += 1;
            continue;
        }

        if (/^\s*>\s?/.test(line)) {
            flushParagraph();
            const quote = el('blockquote');
            const buffer: string[] = [];
            while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
                buffer.push(lines[index].replace(/^\s*>\s?/, ''));
                index += 1;
            }
            renderInline(quote, buffer.join('\n'));
            host.appendChild(quote);
            continue;
        }

        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (bullet || numbered) {
            flushParagraph();
            const ordered = !bullet;
            const list = el(ordered ? 'ol' : 'ul');
            const test = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
            while (index < lines.length) {
                const item = test.exec(lines[index]);
                if (!item) break;
                const li = el('li');
                renderInline(li, item[1]);
                list.appendChild(li);
                index += 1;
            }
            host.appendChild(list);
            continue;
        }

        // 表格：本行是 | a | b |，下一行是 | --- | --- |
        if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1])) {
            flushParagraph();
            const table = el('table');
            const head = el('tr');
            for (const cell of tableCells(line)) {
                const th = el('th');
                renderInline(th, cell);
                head.appendChild(th);
            }
            const thead = el('thead');
            thead.appendChild(head);
            table.appendChild(thead);
            const tbody = el('tbody');
            index += 2;
            while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
                const row = el('tr');
                for (const cell of tableCells(lines[index])) {
                    const td = el('td');
                    renderInline(td, cell);
                    row.appendChild(td);
                }
                tbody.appendChild(row);
                index += 1;
            }
            table.appendChild(tbody);
            host.appendChild(table);
            continue;
        }

        paragraph.push(line);
        index += 1;
    }
    flushParagraph();
}
