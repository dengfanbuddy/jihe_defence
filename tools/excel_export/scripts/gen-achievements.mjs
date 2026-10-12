#!/usr/bin/env node
/**
 * gen-achievements.mjs — 成就表生成器（**设计真源** → `assets/resources/tb/achievements.json`）
 *
 * 为什么要有这个脚本：2026-11 之前成就表是「25 条 × 固定 3 档（铜/银/金）= 75 行」的手写表；
 * 用户口径改成 **「阶段1 / 阶段2 / …（档位数不限）」** 之后，光「账号等级」一条就有 20 档，
 * 全表 150+ 行 —— 手写既写不对（`count` / `reward_gold` 要逐档严格递增）也改不动
 * （调一次奖励曲线要碰 20 个数）。所以这里把**档位表**与**奖励曲线**写成数据 + 公式：
 *
 *   阶段(i) 的奖励 = 从该条的「首档奖励 r1」到「末档奖励 rN」做几何插值（取整到 5）
 *   ⇒ 每条只需给 [r1, rN] 两个数，改曲线只改这两个数，且天然严格递增（rN/r1 ≥ 6）。
 *
 * 用法：`node tools/excel_export/scripts/gen-achievements.mjs [--dry-run]`
 *   写完 JSON 后**必须回灌 xlsx**（编辑源是 xlsx，只改 JSON 会被下一次导表覆盖）：
 *   `cd tools/excel_export && node src/cli.ts json2excel --force --table achievements`
 *   然后 `npm run export` + `npm run check`，并跑 `npm run audit:achieve`。
 *
 * ── 本轮（2026-11 成就改版）的六条口径 ──
 * ① **档位名 = 阶段N**（不再是铜/银/金）—— 因为档位数不再固定是 3；
 * ② **一条成就的档位数按它的成长空间定**（账号等级 20 档 / 收集类 6~7 档 / 通关类 5~6 档）；
 * ③ **奖励不再有「第三档就 1000+」**：全表首档合计 ≈ 1,630（对标回收后的 1,945），
 *    1000 以上的档**只出现在长链的末档**，全表总投放 ≈ 5.4 万（原 40,595，用户口径「略上调」）；
 * ④ **局内（单局）成就一律加「局数」门槛** —— 旧写法是"单局峰值"，一局就能把 3 档全领掉
 *    （用户口径「战线推进，一局就能领到银 1000 多」）。现在改成 **「第 N 阶段 × M 局」**：
 *    新 target `run_*`（见下表），一局最多推进 1 点进度；
 * ⑤ **「万人斩」500 击杀太低**（一局约 1,267 击杀）—— 全表的「累计」阈值按
 *    `docs/局内刷怪节奏设计.md` §12.6 的单局产出重标（一局 ≈ 1267 击杀 / ≈ 30 万伤害 /
 *    ≈ 9120 局内金币 / ≈ 24 次抽取 / 英雄 ≈ Lv.29），首档 ≈ 2~4 局、末档 ≈ 100~150 局；
 * ⑥ **末档效果不动**：10 条 `effect_code` 仍是「一条成就一个来源、只挂末档」。
 *
 * ── 新增的 5 个 target（`run_*`：**累加型，计数单位是「局」**，`param` 是门槛）──
 * | target | param | 语义（每满足一次 +1 局） |
 * |---|---|---|
 * | `run_stage`       | 阶段数 | 单局把战线推进到第 param 阶段 |
 * | `run_hero_level`  | 等级   | 单局英雄等级达到 param 级 |
 * | `run_kill`        | 击杀数 | 单局击杀达到 param 只 |
 * | `run_gold`        | 金币   | 单局持有金币达到 param |
 * | `run_survive`     | 秒     | 单局存活达到 param 秒 |
 *
 * ⚠ 改这张表**必须同时**改：`tools/excel_export/src/core/schema.ts`（target 枚举）、
 *   `game/excel_table/Tb_AchievementConfig.ts`（AchTarget / ACH_RUN_TARGETS）、
 *   `game/data/configs/AchievementConfig.ts`（ACH_TARGET_MODE）、
 *   `tools/achievement-audit/verify-achievements.mjs`（行数 / 分类条数 / 设计区间）、
 *   以及 `docs/成就系统设计.md` §3/§4/§6。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, 'assets/resources/tb/achievements.json');

/** 分类 → id 段首（31xx 等级 / 32xx 闯关 / 33xx 战斗 / 34xx 经济 / 35xx 收集 / 36xx 挑战） */
const SEGMENT = { level: 31, stage: 32, combat: 33, economy: 34, collect: 35, challenge: 36 };

/* ===================================================================
 * 工具
 * =================================================================== */

/** `[a, b]` → `[a, a+step, …, b]`（含两端） */
function steps(a, b, step) {
    const out = [];
    for (let v = a; v <= b; v += step) out.push(v);
    return out;
}

/** 取整到 5（奖励不出现 37 这种数） */
function round5(v) {
    return Math.max(5, Math.round(v / 5) * 5);
}

/**
 * 奖励曲线：从首档 `a` 到末档 `b` 做**几何插值**（取整到 5）。
 * 几何而不是线性：难度本身是几何增长的（阈值 ×1.6~2 一档），奖励跟着走才有"越难越值钱"的手感，
 * 而且它能保证**严格递增**（线性 + 取整在档位多时可能撞成两个相同的数）。
 */
function ramp(a, b, n) {
    if (n <= 1) return [round5(b)];
    const r = Math.pow(b / a, 1 / (n - 1));
    return Array.from({ length: n }, (_, i) => round5(a * Math.pow(r, i)));
}

/** 「门槛 × 局数」型档位：[门槛, 局数] → tier 对象 */
function gate(pairs, descOf) {
    return pairs.map(([param, count]) => ({ count, param, desc: descOf(param, count) }));
}

/** 纯计数型档位：count 列表 → tier 对象 */
function counts(list, descOf) {
    return list.map((count) => ({ count, desc: descOf(count) }));
}

/* ===================================================================
 * 设计真源
 * =================================================================== */

/**
 * 25 条成就。字段：
 *   group / category / sort / name / target / effect?([code, value]) / reward?([首档, 末档])
 *   tiers[]：{ count, param?, desc }（tier 序号由数组下标 +1 决定，**不要手写**）
 *
 * 数值依据（`docs/局内刷怪节奏设计.md` §12.6 的长局口径）：
 *   一局 ≈ 1267 击杀 · ≈ 30 万伤害 · ≈ 9120 局内金币 · ≈ 24 次抽取/遗物 · 英雄 ≈ Lv.29 · 时长 ≈ 1110s
 *   ⇒ 「累计」类的首档取 2~4 局、末档取 100~150 局；「局数」类的末档取 12~20 局。
 */
const PLAN = [
    /* ────────────── ① 等级 level（39 档） ────────────── */
    {
        group: 'lv_account', category: 'level', sort: 1, name: '指挥官之路',
        target: 'level_reached', effect: ['hero_start_level', 1], reward: [30, 900],
        // 每 5 级一阶，直到新版等级表的满级 100（见 gen-player-levels.mjs）
        tiers: counts(steps(5, 100, 5), (c) => `账号等级达到${c}级。`),
    },
    {
        group: 'lv_hero', category: 'level', sort: 2, name: '英雄宗师',
        target: 'run_hero_level', effect: ['battle_exp_bonus', 10], reward: [60, 700],
        // 一局完整通关 ≈ Lv.29（无尽模式还能更高），所以门槛卡在 5~30
        tiers: gate([[5, 3], [10, 5], [15, 8], [20, 10], [25, 15], [30, 20]],
            (p, c) => `累计${c}局单局英雄等级达到${p}级。`),
    },
    {
        group: 'lv_levelup', category: 'level', sort: 3, name: '步步高升',
        target: 'level_up_count', reward: [40, 800],
        // 1→100 级一共 99 次升级
        tiers: counts([5, 10, 20, 30, 50, 70, 99], (c) => `累计提升账号等级${c}次。`),
    },
    {
        group: 'lv_login', category: 'level', sort: 4, name: '风雨无阻',
        target: 'login_streak', reward: [40, 600],
        tiers: counts([3, 7, 14, 30, 60, 100], (c) => `连续登录${c}天。`),
    },

    /* ────────────── ② 闯关 stage（23 档） ────────────── */
    {
        group: 'st_clear', category: 'stage', sort: 1, name: '百战之师',
        target: 'victory', effect: ['run_start_gold', 50], reward: [80, 1000],
        tiers: counts([1, 3, 5, 10, 20, 50], (c) => `击败最终BOSS通关${c}次。`),
    },
    {
        group: 'st_stage', category: 'stage', sort: 2, name: '战线推进',
        target: 'run_stage', effect: ['shop_option_plus', 1], reward: [60, 1200],
        // 阶段模式只有 5 个阶段（第 5 阶段 = 最终 Boss）；末两档转到**无尽模式**的高阶段
        tiers: gate([[2, 3], [3, 5], [4, 8], [5, 12], [6, 15], [8, 18], [10, 20]],
            (p, c) => `累计${c}局把战线推进到第${p}阶段。`),
    },
    {
        group: 'st_nodmg', category: 'stage', sort: 3, name: '毫发无伤',
        target: 'clear_no_damage', reward: [80, 700],
        tiers: counts([1, 3, 6, 10, 20], (c) => `在未受到任何伤害的情况下通关${c}次。`),
    },
    {
        group: 'st_speed', category: 'stage', sort: 4, name: '闪电战',
        target: 'clear_fast', reward: [80, 700],
        tiers: counts([1, 3, 6, 10, 20], (c) => `在最终BOSS出现后30秒内击败它，累计${c}次。`),
    },

    /* ────────────── ③ 战斗 combat（27 档） ────────────── */
    {
        group: 'cb_kill', category: 'combat', sort: 1, name: '万人斩',
        target: 'kill_enemies', effect: ['kill_buff_discount', 10], reward: [60, 1200],
        // ⚠ 旧首档 500 = 0.4 局（一局约 1267 击杀），用户口径「这也太少了」
        tiers: counts([3000, 12000, 30000, 60000, 100000, 160000], (c) => `累计击败${c}名敌人。`),
    },
    {
        group: 'cb_kill_run', category: 'combat', sort: 2, name: '单局屠戮',
        target: 'run_kill', reward: [50, 600],
        tiers: gate([[250, 5], [600, 8], [1000, 10], [1500, 12], [2500, 15], [4000, 20]],
            (p, c) => `累计${c}局单局击杀达到${p}只。`),
    },
    {
        group: 'cb_damage', category: 'combat', sort: 3, name: '伤害之王',
        target: 'damage_dealt', effect: ['gold_gain_bonus', 10], reward: [60, 1400],
        // 一局约 30 万伤害 ⇒ 首档 3.3 局、末档 ≈ 117 局
        tiers: counts([1000000, 3000000, 8000000, 18000000, 35000000], (c) => `累计造成${c}点伤害。`),
    },
    {
        group: 'cb_crit', category: 'combat', sort: 4, name: '暴击狂人',
        target: 'crit_hits', reward: [50, 600],
        tiers: counts([500, 2500, 8000, 20000, 45000], (c) => `累计打出${c}次暴击。`),
    },
    {
        group: 'cb_games', category: 'combat', sort: 5, name: '久经沙场',
        target: 'play_games', reward: [50, 500],
        tiers: counts([10, 30, 100, 300, 600], (c) => `完成对局${c}局（胜负不限）。`),
    },

    /* ────────────── ④ 经济 economy（20 档） ────────────── */
    {
        group: 'ec_earn', category: 'economy', sort: 1, name: '富甲一方',
        target: 'gold_earned', effect: ['shop_draw_discount', 10], reward: [60, 1000],
        // 一局约 9120 局内金币 ⇒ 末档 ≈ 110 局
        tiers: counts([20000, 100000, 300000, 600000, 1000000], (c) => `在局内累计获得${c}金币。`),
    },
    {
        group: 'ec_spend', category: 'economy', sort: 2, name: '消费达人',
        target: 'spend_gold', reward: [50, 600],
        tiers: counts([15000, 80000, 250000, 500000, 900000], (c) => `在局内累计消耗${c}金币。`),
    },
    {
        group: 'ec_run_gold', category: 'economy', sort: 3, name: '单局首富',
        target: 'run_gold', reward: [50, 500],
        // 一局赚 9120 但基本花光，所以"持有峰值"卡在 300~3500
        tiers: gate([[300, 3], [600, 5], [1200, 8], [2000, 12], [3500, 15]],
            (p, c) => `累计${c}局单局持有${p}金币。`),
    },
    {
        group: 'ec_draw', category: 'economy', sort: 4, name: '抽卡成瘾',
        target: 'draw_count', effect: ['ad_free_draw', 1], reward: [60, 900],
        // 一局约 24 次抽取 ⇒ 末档 ≈ 125 局
        tiers: counts([50, 250, 800, 1800, 3000], (c) => `在肉鸽商店累计抽取${c}次。`),
    },

    /* ────────────── ⑤ 收集 collect（24 档） ────────────── */
    {
        group: 'co_relic', category: 'collect', sort: 1, name: '图鉴大师',
        target: 'relic_collected', effect: ['hero_select_free', 1], reward: [80, 1200],
        // ⚠ 「共 268 件」两处都要对：文案里的数字 + 末档 count（`npm run check` 的跨表校验盯着）
        //
        // 2026-11 改版：局外池从 37 件扩到 **268 件**（= 局内池，用户口径「局内局外严格对齐」），
        // 档位跟着重排 —— **仍然 7 档**（刻意不改档位数：`reward: [80, 1200]` 的几何插值是按档位数算的，
        // 档位数一变，成就金币总量 53,645 就跟着变，而那一串数已经写进了经济口径文档）。
        // 节奏依据：局外抽取「档内优先未收集」+ 每天约 3 抽 ⇒ 10 件 ≈ 4 天 / 50 件 ≈ 3 周 / 200 件 ≈ 数月，
        // 末档 268 = **集齐**（跨表校验要求 ≤ 表行数，正好取满）。
        tiers: counts([10, 25, 50, 90, 140, 200, 268], () => '收集局外遗物图鉴（共268件）。'),
    },
    {
        group: 'co_buff', category: 'collect', sort: 2, name: '药剂收藏家',
        target: 'buff_types', reward: [70, 900],
        tiers: counts([5, 8, 11, 14, 17, 19], () => '在神器商店购买过不同种类的神器（共19种）。'),
    },
    {
        group: 'co_skill', category: 'collect', sort: 3, name: '技能全通',
        target: 'skills_picked', reward: [70, 900],
        tiers: counts([5, 10, 15, 20, 25, 31], () => '抽到过不同种类的肉鸽技能（共31个）。'),
    },
    {
        group: 'co_pick', category: 'collect', sort: 4, name: '淘宝专家',
        target: 'relics_picked', reward: [50, 500],
        // 一局约 24 件 ⇒ 末档 ≈ 125 局
        tiers: counts([100, 400, 900, 1800, 3000], (c) => `在局内累计获得${c}件遗物。`),
    },

    /* ────────────── ⑥ 挑战 challenge（21 档，全部 silent） ────────────── */
    {
        group: 'ch_norelic', category: 'challenge', sort: 1, name: '裸装勇士', silent: 1,
        target: 'run_no_relic_clear', effect: ['relic_start_gift', 1], reward: [100, 1500],
        tiers: counts([1, 3, 6, 10, 20], (c) => `不带任何遗物通关${c}次。`),
    },
    {
        group: 'ch_oneskill', category: 'challenge', sort: 2, name: '独门绝技', silent: 1,
        target: 'clear_one_skill', reward: [100, 1200],
        tiers: counts([1, 3, 6, 10, 20], (c) => `只使用1个技能槽通关${c}次。`),
    },
    {
        group: 'ch_lowhp', category: 'challenge', sort: 3, name: '残血英雄', silent: 1,
        target: 'clear_low_hp', reward: [100, 1200],
        tiers: counts([1, 3, 6, 10, 20], (c) => `在生命值低于10%时击败最终BOSS通关${c}次。`),
    },
    {
        group: 'ch_survive', category: 'challenge', sort: 4, name: '屹立不倒', silent: 1,
        target: 'run_survive', reward: [100, 1500],
        // 阶段模式一局 1110s；1200 秒起只有无尽模式能到
        tiers: gate([[300, 3], [600, 5], [900, 8], [1200, 10], [1800, 12], [3000, 15]],
            (p, c) => `累计${c}局单局存活达到${p}秒。`),
    },
];

/* ===================================================================
 * 展开成配表行
 * =================================================================== */

function build() {
    const rows = [];
    const counters = {};
    const problems = [];

    for (const def of PLAN) {
        const n = def.tiers.length;
        const rewards = ramp(def.reward[0], def.reward[1], n);
        const seg = SEGMENT[def.category];

        for (let i = 0; i < n; i++) {
            const t = def.tiers[i];
            counters[def.category] = (counters[def.category] ?? 0) + 1;
            const row = {
                id: seg * 100 + counters[def.category],
                group: def.group,
                tier: i + 1,
                category: def.category,
                name: def.name,
                desc: t.desc,
                target: def.target,
                count: t.count,
                reward_gold: rewards[i],
            };
            // param 只给 run_* 型（门槛）；其余类型的 param 留空
            if (t.param !== undefined) row.param = String(t.param);
            // 效果只挂末档（容器与体检都会盯这条）
            if (def.effect && i === n - 1) {
                row.effect_code = def.effect[0];
                row.effect_value = def.effect[1];
            }
            if (def.silent) row.silent = 1;
            row.sort = def.sort;
            rows.push(row);
        }
    }

    // ── 生成期自检（生成器自己先当一次门禁，别把坏表写进仓库）──
    const byGroup = new Map();
    for (const r of rows) {
        if (!byGroup.has(r.group)) byGroup.set(r.group, []);
        byGroup.get(r.group).push(r);
    }
    if (byGroup.size !== PLAN.length) problems.push(`group 数 ${byGroup.size} ≠ 计划 ${PLAN.length}`);
    for (const [g, list] of byGroup) {
        for (let i = 0; i < list.length; i++) {
            if (list[i].tier !== i + 1) problems.push(`${g} 档位不连续：第 ${i + 1} 行 tier=${list[i].tier}`);
            if (i > 0) {
                if (!(list[i].count > list[i - 1].count)) problems.push(`${g} count 未递增：${list[i - 1].count} → ${list[i].count}`);
                if (!(list[i].reward_gold > list[i - 1].reward_gold)) problems.push(`${g} reward 未递增：${list[i - 1].reward_gold} → ${list[i].reward_gold}`);
            }
            if (!(list[i].count > 0)) problems.push(`${g}#${list[i].tier} count 非正`);
        }
    }
    const ids = rows.map((r) => r.id);
    if (new Set(ids).size !== ids.length) problems.push('id 有重复');
    const effectCodes = rows.filter((r) => r.effect_code).map((r) => r.effect_code);
    if (new Set(effectCodes).size !== effectCodes.length) problems.push('effect_code 有重复来源');

    return { rows, problems, effectCodes };
}

const { rows, problems, effectCodes } = build();

const total = rows.reduce((s, r) => s + r.reward_gold, 0);
const tier1 = rows.filter((r) => r.tier === 1).reduce((s, r) => s + r.reward_gold, 0);
const byCat = {};
for (const r of rows) byCat[r.category] = (byCat[r.category] ?? 0) + r.reward_gold;

console.log(`成就表生成：${rows.length} 行 / ${PLAN.length} 条 / 效果 ${effectCodes.length} 条`);
console.log(`  金币总计 ${total}（首档合计 ${tier1}）`);
console.log(`  分类小计 ${Object.entries(byCat).map(([c, v]) => `${c} ${v}`).join(' / ')}`);

if (problems.length) {
    console.error('\n✘ 生成期自检未通过：');
    problems.forEach((p) => console.error(`  · ${p}`));
    process.exit(1);
}

if (process.argv.includes('--dry-run')) {
    console.log('\n(--dry-run：未写盘)');
} else {
    fs.writeFileSync(OUT, JSON.stringify(rows, null, 2) + '\n');
    console.log(`\n✔ 已写入 ${path.relative(ROOT, OUT)}`);
    console.log('  下一步：cd tools/excel_export && node src/cli.ts json2excel --force --table achievements');
}
