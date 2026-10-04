/**
 * set-landed.mjs —— 把「这 30 条技能**现在**落地成什么了」写进作者数据（幂等）
 *
 * 为什么要有这个字段：
 *   `skills.json` 原本只有**审查结论**（`verdict`：需脚本 / 需重设计 / 需补钩子…），
 *   那是"动手前的判定"。2026-10 全部落地之后，如果文档还停在这一层，
 *   读的人会以为 30 条技能还没做（`docs/skill-icons/skills.md` 会一直显示"需重设计"）。
 *
 * **只写两样东西，其余全部由生成器从配表推导**（这是刻意的）：
 *   · `indirect` —— **脚本在运行时自己挂的** Modifier（配表里看不到，比如 116 的灼烧 50、
 *     117 的冰冻 53、127 借用的圣盾 45）；配表能看到的 `apply_modifier` 由生成器**直接读**，
 *     不在这里抄一份，避免两处漂移。
 *   · `note` —— 一句话说清落地形态（给人看）。
 *
 * `kind`（declarative / script / mixed）也是**推导**出来的，不在这里写死：
 *   · 引用的 Modifier 里**没有任何**带 `script_id` 的 → `declarative`
 *   · 有带 `script_id` 的、也有没带的（或技能本身有 `modify_attr` 动作）→ `mixed`
 *   · 全是带 `script_id` 的且没有声明式动作 → `script`
 *   —— 这样"文档说的落地形态"与"配表+脚本真实的形态"永远一致，写错了生成器会报。
 *
 * 幂等：同 id 的 `landed` 整块替换，键序按 `skills.json` 既有风格（id 段在前、landed 在后）。
 *
 * 用法：
 *   node tools/skill-icon-prompts/set-landed.mjs --dry-run
 *   node tools/skill-icon-prompts/set-landed.mjs
 *   node tools/skill-icon-prompts/gen-prompts.mjs        # 重生成 docs（会逐条对账，漂移即退出码 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SRC = path.join(HERE, 'skills.json');
const DRY = process.argv.includes('--dry-run');

/**
 * 30 条技能的落地形态。
 * `indirect` = **脚本运行时自己挂的** Modifier（配表看不见的那些）；空数组表示没有。
 * 数值与配表真源在 `assets/resources/tb/abilities.json`，这里一个字都不抄。
 */
const LANDED = {
    101: { indirect: [], note: '脚本追加 `count` 段 `pct×atk` 伤害（每段独立走伤害管线，各自 roll 暴击）' },
    102: { indirect: [], note: '脚本按实际站位投影取「身后 + 锥角内」的 `count` 个敌人' },
    103: { indirect: [], note: '纯声明式：`modifiers.events[on_attack_landed].actions[lifesteal]`（唯一需要新增 Modifier 行的一条 —— `ratio` 是动作字段、没有 var 绑定）' },
    104: { indirect: [], note: '纯声明式：`modify_attr [4 攻速, add]`' },
    105: { indirect: [], note: '纯声明式：`modify_attr [16 攻击距离, percent]`' },
    106: { indirect: [], note: '纯声明式：`modify_attr [1 最大生命, percent]`（三阶追加 `[9 生命恢复, add]`）' },
    107: { indirect: [], note: '纯声明式：`modify_attr [14 暴击率, add]`（三阶追加 `[15 暴击倍率, best]`）' },
    108: { indirect: [], note: '**混装**：护甲那半句是声明式 `modify_attr [6, add]`，格挡那半句是脚本往 `on_block_damage.blocked` 里写数' },
    109: { indirect: [], note: '脚本在两个时机分工：`on_attack_start` 记「打的是满血目标」，`on_attack_landed` 消费并追加伤害' },
    110: { indirect: [], note: '**重设计**：换成真实存在的乘区 —— `modify_attr [11 伤害输出, percent]`，三阶追加受伤倍率减伤' },
    111: { indirect: [], note: '脚本订阅 `ctx.bus` 的 `on_kill`（该事件只发总线、不派发给 Modifier），加金后补发 `on_gold_gained` 让 HUD 刷新' },
    112: { indirect: [], note: '脚本做一个带池子的拦截器：往 `on_block_damage.blocked` 写吸收量，破池后自计时充能' },
    113: { indirect: [], note: '**重设计**：`Projectile` 没有返程，换成「命中后弹向英雄最近的另一个敌人」' },
    114: { indirect: [], note: '脚本链式弹射（复用 `visited` 集合防来回弹）' },
    115: { indirect: [50], note: '脚本以中弹者为中心做范围伤害；三阶的灼烧直接复用 116 的 DoT（Modifier 50）' },
    116: { indirect: [50], note: '脚本按施加时的 atk 生成 DoT（Modifier 50），`dps × stackCount` —— 修掉了配表 `tick_damage` 不随层数放大的老口径' },
    117: { indirect: [53], note: '**混装**：减速是声明式模板（Modifier 53，`modify_attr` 条目带 `var` 由 kv 传幅度），只有「满 3 层冻结」这个条件走脚本' },
    118: { indirect: [52], note: '脚本按 atk 生成毒 DoT（Modifier 52）；三阶的「死亡传染」放在 `OnDestroy` 里判宿主真死' },
    119: { indirect: [], note: '**重设计**：锚点从「技能释放」换成普攻命中（英雄永远不施放技能）；首跳 100%，之后每跳 ×decay' },
    120: { indirect: [56], note: '**混装**：层数用声明式标记行（Modifier 56，纯计数、`stack_mode:stack`），只有「满 5 层引爆」这个条件走脚本' },
    121: { indirect: [], note: '脚本读命中后的血线比例（追加伤害段，而不是往 `DamageOut` 乘区塞系数）' },
    122: { indirect: [], note: '脚本订阅总线 `on_kill`，以死者位置为中心做范围伤害' },
    123: { indirect: [], note: '**重设计**：召唤基建不存在 → 自身周期性自动开火（`OnTick` 自计时，不依赖死代码 `modifiers.cd`）' },
    124: { indirect: [], note: '**重设计**：召唤 + 「释放技能时」双重不可达 → 普攻概率追加一击' },
    125: { indirect: [], note: '**重设计**：换成「击杀攒层 → 普攻一次性倾泻」，不再引用本作不存在的元素体系' },
    126: { indirect: [], note: '脚本挂 `on_deal_damage`（**只有这个事件的载荷带 `isCrit`**）并加 busy 标志防递归' },
    127: { indirect: [7, 45], note: '**补了引擎派发**：`Entity.resolveAttackHit` 的闪避分支现在会发 `on_evade`；反击用 Modifier 7 眩晕、三阶护盾复用 45（护盾逻辑只有一份）' },
    128: { indirect: [66], note: '**混装**：增伤是声明式 `modify_attr [11, percent]`（原稿「给友军」在单英雄局里等于给自己），破甲光环走脚本（Modifier 66）' },
    129: { indirect: [6], note: '脚本挂 `on_take_damage`：**该事件派发在死亡检查之前**，补血 + 置回 `alive` 就能真的拦住死亡；三阶无敌用 Modifier 6' },
    130: { indirect: [], note: '纯声明式：`modify_attr [3 攻击力, percent] + [1 最大生命, 负 percent]`' },
};

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const problems = [];
const missing = [];

for (const s of data.skills) {
    const l = LANDED[s.id];
    if (!l) { missing.push(`${s.id} ${s.name} 没有登记落地形态`); continue; }
}

// 反向：登记了但配表里没有的技能
const ids = new Set(data.skills.map((s) => s.id));
for (const k of Object.keys(LANDED)) {
    if (!ids.has(Number(k))) problems.push(`LANDED 里的 id ${k} 不在 skills.json 里`);
}
problems.push(...missing);
if (problems.length) {
    console.error('✗ 自检失败：');
    for (const p of problems) console.error(`   - ${p}`);
    process.exit(1);
}

let touched = 0;
for (const s of data.skills) {
    const l = LANDED[s.id];
    const next = { indirect: l.indirect, note: l.note };
    if (JSON.stringify(s.landed) !== JSON.stringify(next)) touched++;
    s.landed = next;
}

// 键序：把 `landed` 放到最后（author 数据在前、落地状态在后）；`art` 保持原顺序
const ordered = {
    _doc: data._doc,
    _verdict_legend: data._verdict_legend,
    style: data.style,
    skills: data.skills.map((s) => {
        const out = {};
        for (const k of Object.keys(s)) if (k !== 'landed') out[k] = s[k];
        out.landed = s.landed;
        return out;
    }),
};

console.log(`◆ ${data.skills.length} 条技能：${touched} 条的 landed 有变化`);
const tally = {};
for (const s of data.skills) {
    const ind = s.landed.indirect.length ? `（间接挂 ${s.landed.indirect.join('/')}）` : '';
    tally[ind ? 'indirect' : 'direct'] = (tally[ind ? 'indirect' : 'direct'] ?? 0) + 1;
    console.log(`   ${String(s.id).padStart(3)} ${s.name.padEnd(6, '　')} ${s.landed.note.slice(0, 40)}… ${ind}`);
}
console.log(`◆ 间接挂 Modifier 的：${tally.indirect ?? 0} 条 / 30`);

if (DRY) { console.log('（--dry-run：未写盘）'); process.exit(0); }
fs.writeFileSync(SRC, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
console.log(`✔ 已写 ${path.relative(ROOT, SRC)}`);
console.log('   下一步：node tools/skill-icon-prompts/gen-prompts.mjs');
