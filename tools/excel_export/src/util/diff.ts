/** JSON 深度比较（用于 verify 往返自检，输出可读的差异路径） */

export interface DiffResult {
    /** 差异描述（最多 limit 条） */
    diffs: string[];
    /** 差异总数 */
    count: number;
}

export function diffJson(expected: unknown, actual: unknown, limit = 10): DiffResult {
    const diffs: string[] = [];
    let count = 0;

    const walk = (a: unknown, b: unknown, path: string): void => {
        if (count > limit) return;
        if (a === b) return;

        const ta = typeOf(a);
        const tb = typeOf(b);
        if (ta !== tb) {
            count++;
            if (diffs.length < limit) diffs.push(`${path}: 类型不一致（期望 ${ta}: ${short(a)}，实际 ${tb}: ${short(b)}）`);
            return;
        }
        if (ta === 'array') {
            const aa = a as unknown[];
            const bb = b as unknown[];
            if (aa.length !== bb.length) {
                count++;
                if (diffs.length < limit) diffs.push(`${path}: 数组长度不一致（期望 ${aa.length}，实际 ${bb.length}）`);
            }
            const n = Math.max(aa.length, bb.length);
            for (let i = 0; i < n; i++) walk(aa[i], bb[i], `${path}[${i}]`);
            return;
        }
        if (ta === 'object') {
            const ao = a as Record<string, unknown>;
            const bo = b as Record<string, unknown>;
            const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
            for (const k of keys) {
                if (!(k in ao)) {
                    count++;
                    if (diffs.length < limit) diffs.push(`${path}.${k}: 多出字段（实际 ${short(bo[k])}）`);
                    continue;
                }
                if (!(k in bo)) {
                    count++;
                    if (diffs.length < limit) diffs.push(`${path}.${k}: 丢失字段（期望 ${short(ao[k])}）`);
                    continue;
                }
                walk(ao[k], bo[k], `${path}.${k}`);
            }
            return;
        }
        count++;
        if (diffs.length < limit) diffs.push(`${path}: 值不一致（期望 ${short(a)}，实际 ${short(b)}）`);
    };

    walk(expected, actual, '$');
    return { diffs, count };
}

function typeOf(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

function short(v: unknown): string {
    const s = JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
}
