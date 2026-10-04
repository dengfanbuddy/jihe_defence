/**
 * SKILL 事实门禁 —— 「每条事实必须声明它怎么被验证」，且声明为 script: 的锚点必须真跑通过。
 *
 * 背景：这一层知识的病不是"没写下来"，而是**写错了没人发现**（实测一条错事实活了 3 小时，
 * 靠下一次会话撞见才纠正）。文件型知识没有编译期，所以给它补一道能跑的判据。
 *
 * 约定（写进 `.agents/skills/cocos-editor-ops/SKILL.md`）：
 *   <!-- fact: <id> | verify: script:<name> | <note> -->
 *   <!-- fact: <id> | verify: manual | <note 说明人怎么验> -->
 *
 * 判据：
 *   ① 每条 `## 坑 N` 标题下必须有且只有一条 fact 声明（新增坑不许裸奔）
 *   ② `verify: script:X` 的 X 必须在下面的实现表里（悬空声明 = 红）
 *   ③ 实现表里的每条 X 都必须被某条事实引用（死断言 = 红，防止判据悄悄失效）
 *   ④ `verify: manual` 必须带 note 且说清楚「人在哪里、看什么」（说不清 = 没声明）
 *   ⑤ 每个 script: 锚点必须真跑通过
 *   ⑥ 归档的 recipe 不得出现在 findRecipes 的索引里
 *
 * 用法：
 *   node extensions/dsh_chat/scripts/verify-skill-facts.js
 *   node extensions/dsh_chat/scripts/verify-skill-facts.js --json
 *
 * 退出码：0 = 全绿；1 = 有上面的任一条不成立。
 *
 * @module dsh_chat/verify-skill-facts
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const EXT_ROOT = path.resolve(SCRIPT_DIR, '..');            // extensions/dsh_chat
const REPO_ROOT = path.resolve(EXT_ROOT, '..', '..');       // 工程根

/** 事实正文**随插件发布**（`<扩展根>/skills/…`），不再是消费者工程里的那份。 */
const SKILL_FILE = path.join(EXT_ROOT, 'skills', 'cocos-editor-ops', 'SKILL.md');
const HOST_FILE = path.join(EXT_ROOT, 'source', 'dsh-host.ts');
/** 消费工程里**不该**出现同名 skill —— 同名是「整体覆盖」，会把插件这份整个吃掉。 */
const SHADOW_FILE = path.join(REPO_ROOT, '.agents', 'skills', 'cocos-editor-ops', 'SKILL.md');
const BRIDGE_FILE = path.join(EXT_ROOT, 'dsh-profile', 'plugin', 'dsh-cocos-bridge', 'index.js');
const SCENE_FILE = path.join(EXT_ROOT, 'source', 'scene.ts');
const ENGINE_FILE = path.join(EXT_ROOT, 'source', 'core', 'engine.ts');

const FACT_RE = /^<!--\s*fact:\s*([^|]+?)\s*\|\s*verify:\s*([^|]+?)\s*(?:\|\s*(.*?)\s*)?-->\s*$/;
const PIT_RE = /^##\s*坑\s*(\d+)\s*[：:]/;

const read = (file) => {
    try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
};

/** 源码里必须有某段字符串 —— "插件行为"类事实的锚点 */
const mustContain = (file, needle, why) => ({
    desc: path.relative(REPO_ROOT, file) + ' 里仍有 ' + JSON.stringify(needle),
    run() {
        const text = read(file);
        if (text == null) return { ok: false, detail: '读不到 ' + path.relative(REPO_ROOT, file) };
        const hit = text.includes(needle);
        return {
            ok: hit,
            detail: hit
                ? path.relative(REPO_ROOT, file) + ' 里仍有 ' + JSON.stringify(needle)
                : path.relative(REPO_ROOT, file) + ' 里**已经找不到** ' + JSON.stringify(needle) + ' —— ' + why,
        };
    },
});

/** 复刻 listRecipeRecords 的扫描口径：非递归、只收 recipes/ 本层的 *.js */
const listIndexedRecipes = () => {
    const dir = path.join(REPO_ROOT, '.dsh-mcp', 'recipes');
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return { dir, files: [] }; }
    const files = [];
    for (const entry of entries.sort()) {
        if (!entry.toLowerCase().endsWith('.js')) continue;
        const file = path.join(dir, entry);
        try { if (fs.statSync(file).isFile()) files.push(file); } catch { /* 忽略 */ }
    }
    return { dir, files };
};

const IMPLS = {
    'tool-count-is-4': {
        desc: 'bridge 里 ctx.tools.register 正好 4 次（工具面表格的前提）',
        run() {
            const text = read(BRIDGE_FILE);
            if (text == null) return { ok: false, detail: '读不到 bridge 插件' };
            const n = (text.match(/ctx\.tools\.register\s*\(/g) || []).length;
            return {
                ok: n === 4,
                detail: '实测注册 ' + n + ' 个工具' + (n === 4 ? '' : '（不是 4 → 「工具面」那张表已失真）'),
            };
        },
    },
    'prune-reports-hidden': mustContain(SCENE_FILE, 'editorChildrenHidden',
        '坑 1 说「剪枝时不静默，会回 editorChildrenHidden」就站不住了'),
    'nodebypath-greedy': mustContain(SCENE_FILE, 'resolvePathBySegments',
        '坑 2 说「nodeByPath 用贪心按段匹配兜住含 / 的节点名」就站不住了'),
    'capture-reports-viewstate': mustContain(SCENE_FILE, 'visibleMatchesDesign',
        '坑 5 说「截图回执里带 view.visibleMatchesDesign」就站不住了'),
    'context-inference': mustContain(ENGINE_FILE, 'contextInferred',
        '坑 6 说「漏给 context 会被推断并在回执里注明」就站不住了'),
    'loadframe-rejects-internal': mustContain(SCENE_FILE, 'db://internal',
        '坑 8 与「内置资源」那节的前提（loadFrame 只认 db://assets，内置图走 loadAny）就站不住了'),
    'archive-not-indexed': {
        desc: '归档目录（.dsh-mcp/archive/）里的文件不得进入 findRecipes 索引',
        run() {
            const { files } = listIndexedRecipes();
            const leaked = files.filter((f) => path.dirname(f) !== path.join(REPO_ROOT, '.dsh-mcp', 'recipes'));
            const archiveHit = files.filter((f) => f.split(path.sep).includes('archive'));
            if (leaked.length || archiveHit.length) {
                return { ok: false, detail: '索引里混进了非本层/归档文件：' + leaked.concat(archiveHit).join(', ') };
            }
            const archived = (() => {
                try { return fs.readdirSync(path.join(REPO_ROOT, '.dsh-mcp', 'archive')).filter((f) => f.endsWith('.js')); }
                catch { return []; }
            })();
            return {
                ok: true,
                detail: '索引 ' + files.length + ' 条（' + files.map((f) => path.basename(f)).join(', ') + '）'
                    + '；archive/ 里另有 ' + archived.length + ' 条已退出索引',
            };
        },
    },
    'bundled-skill-wired': {
        desc: 'dsh-host.ts 把 <扩展根>/skills 注入 DSH_BUNDLED_SKILL_DIR（知识才能跟着插件走）',
        run() {
            const text = read(HOST_FILE);
            if (text == null) return { ok: false, detail: '读不到 source/dsh-host.ts' };
            const hasEnv = text.includes('DSH_BUNDLED_SKILL_DIR');
            const hasFn = text.includes('bundledSkillDir');
            const hasSkill = fs.existsSync(path.join(EXT_ROOT, 'skills', 'cocos-editor-ops', 'SKILL.md'));
            return {
                ok: hasEnv && hasFn && hasSkill,
                detail: (hasEnv ? '' : 'dsh-host.ts 里没有 DSH_BUNDLED_SKILL_DIR；')
                    + (hasFn ? '' : '没有 bundledSkillDir()；')
                    + (hasSkill ? 'skills/cocos-editor-ops/SKILL.md 在位' : 'skills/cocos-editor-ops/SKILL.md 不存在'),
            };
        },
    },
    'no-shadowing-skill': {
        desc: '消费工程里没有同名的 cocos-editor-ops（同名是整体覆盖，会把插件这份吃掉）',
        run() {
            if (!fs.existsSync(SHADOW_FILE)) {
                return { ok: true, detail: path.relative(REPO_ROOT, SHADOW_FILE) + ' 不存在（正确）' };
            }
            return {
                ok: false,
                detail: '存在 ' + path.relative(REPO_ROOT, SHADOW_FILE)
                    + ' —— 它的 rank 是 200、插件 bundled 是 600，按名字去重时**低 rank 赢**，'
                    + '插件这份的 9 条坑会**全部失效**（不是合并）。项目专有约定请另起一个名字。',
            };
        },
    },
};

/** 解析 SKILL.md 里的事实声明，并检查 §判据 ①②③④ */
function parseFacts() {
    const text = read(SKILL_FILE);
    if (text == null) return { error: '读不到 ' + SKILL_FILE };

    const lines = text.split(/\r?\n/);
    const facts = [];
    const pits = [];               // { n, line, facts: [] }
    let current = null;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const pit = PIT_RE.exec(line);
        if (pit) {
            current = { n: Number(pit[1]), line: i + 1, facts: [] };
            pits.push(current);
            continue;
        }
        if (/^##\s/.test(line)) current = null;   // 出了这个坑

        const m = FACT_RE.exec(line);
        if (!m) continue;
        const fact = { id: m[1], verify: m[2], note: (m[3] || '').trim(), line: i + 1, pit: current };
        facts.push(fact);
        if (current) current.facts.push(fact);
    }
    return { facts, pits };
}

function main() {
    const json = process.argv.includes('--json');
    const parsed = parseFacts();
    if (parsed.error) {
        console.error(parsed.error);
        process.exit(1);
    }

    const { facts, pits } = parsed;
    const problems = [];
    const rows = [];

    // ① 每条坑都要有声明
    for (const pit of pits) {
        if (pit.facts.length === 0) problems.push('坑 ' + pit.n + '（SKILL.md:' + pit.line + '）没有任何 <!-- fact: --> 声明');
        if (pit.facts.length > 1) problems.push('坑 ' + pit.n + '（SKILL.md:' + pit.line + '）有 ' + pit.facts.length + ' 条声明，只允许 1 条');
    }

    // ② 悬空声明 / ④ manual 必须说清怎么验 / ⑤ 真跑
    const used = new Set();
    for (const fact of facts) {
        const m = /^script:(.+)$/.exec(fact.verify);
        if (m) {
            const name = m[1].trim();
            used.add(name);
            const impl = IMPLS[name];
            if (!impl) {
                problems.push(fact.id + ' 声明了不存在的锚点 script:' + name);
                rows.push({ fact: fact.id, verify: fact.verify, ok: false, detail: '锚点未实现' });
                continue;
            }
            let result;
            try { result = impl.run(); } catch (error) { result = { ok: false, detail: '抛错：' + error.message }; }
            if (!result.ok) problems.push(fact.id + ' 的锚点未通过 —— ' + result.detail);
            rows.push({ fact: fact.id, verify: fact.verify, ok: result.ok, detail: result.detail });
        } else if (fact.verify === 'manual') {
            if (!fact.note) problems.push(fact.id + ' 标了 manual 却没写「人在哪看什么」—— 等于没声明');
            rows.push({ fact: fact.id, verify: 'manual', ok: true, detail: fact.note || '(缺 note)' });
        } else {
            problems.push(fact.id + ' 的 verify 既不是 script:<name> 也不是 manual：' + fact.verify);
            rows.push({ fact: fact.id, verify: fact.verify, ok: false, detail: '无法识别的 verify 形式' });
        }
    }

    // ③ 死断言
    for (const name of Object.keys(IMPLS)) {
        if (!used.has(name)) problems.push('实现表里的 ' + name + ' 没有任何事实引用（死断言：它挂掉也没人知道）');
    }

    if (json) {
        console.log(JSON.stringify({ ok: problems.length === 0, facts: rows, problems }, null, 2));
    } else {
        const auto = rows.filter((r) => r.verify.startsWith('script:'));
        const manual = rows.filter((r) => r.verify === 'manual');
        console.log('SKILL 事实门禁 —— ' + path.relative(REPO_ROOT, SKILL_FILE));
        console.log('');
        for (const r of rows) {
            console.log('  ' + (r.ok ? ' ok ' : 'FAIL') + '  ' + r.fact.padEnd(30) + ' ' + r.verify);
            if (!r.ok) console.log('        └ ' + r.detail);
        }
        console.log('');
        console.log('事实 ' + rows.length + ' 条：可执行锚点 ' + auto.length + ' 条 / 显式 manual ' + manual.length + ' 条');
        console.log('（manual = 承认它只能人验；这个数字应该降，但不该假装是 0）');
        if (problems.length) {
            console.log('');
            console.log('不通过：');
            for (const p of problems) console.log('  ✗ ' + p);
        }
    }

    process.exit(problems.length ? 1 : 0);
}

main();
