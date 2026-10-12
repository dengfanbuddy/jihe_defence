/**
 * 「遗物池配平」一次性迁移（**幂等**，可反复跑）
 *
 * 背景：`docs/hero-archetype/README.md` §7 的「遗物池配平」缺口。2026-11 之前只做了"补两条新流派"，
 * 主标签形状是 `坦克反伤 93 / 法术爆发 59 / 远程点杀 44 / 召唤增殖 20 / 控制减速 14 / 背水血怒 12 /
 * 弹幕散射 9 / 元素持续 7 / 物理暴击 6 / 经济成长 4`（268 件）—— 最厚/最薄 **23×**：
 * 两条线吃掉一半池子，而 5 条专精线每条不到 15 件 ⇒ **成型线（5 件）永远点不亮**。
 * 其中「坦克反伤」93 件里有 **52 件是白档纯属性件**。
 *
 * 本脚本做两件事（都只改 `scripts/lib/relic-inner-design.mjs` 这一个真源）：
 *
 *   A. **白档 107 件**：主标签从 `坦克 52 / 法术 44 / 远程 11` 调成 **`远程 40 / 坦克 30 / 法术 37`**
 *      —— 靠 **重排 `a` 顺序**（`tagsOf` 取 `a` 里第一条命中 `ATTR_TAGS` 的属性 ⇒ "归类"就是"排序"）
 *      + 给 16 件**进攻型垫底件补一条攻击距离(16)**（`docs/调研_流派与强化件设计总表.md` §3 B 批
 *      说的"把白档池子的进攻件补厚"）。补出来的属性集合由求解器挑，保证**同效果件 ≤2**（C 组门禁）。
 *
 *   B. **蓝+档 161 件**：把 40 件"名字/机制本来就两边都算"的件从宽线划到专精线
 *      （带暴击属性的件→物理暴击、火/冰/毒件→元素持续、击杀收益件→经济成长、多目标件→弹幕散射…），
 *      宽线只留真正属于自己的件。**钩子实例总数不变（换钩不是加钩）⇒ 战力中性**，
 *      且**每条钩子仍在用**（脚本会卡这条红线）。
 *
 * ⚠ **为什么不硬压成 10 条线均分**（见 `README.md` §7.1）：
 *   ① 白档只有 9 条固定值属性，**只能推出 3 个词**（远程点杀 / 坦克反伤 / 法术爆发）⇒
 *      这 3 条线天然比专精线厚，这是**结构下限**，不是没配平；
 *   ② 「坦克反伤」是唯一的防御词，池子里的防御件全归它 ⇒ 要压到 48 只能把 25 件纯防御件
 *      （抗魔斗篷 / 恐鳌之心 / 永世法衣…）的**效果**改掉。本脚本按"语义优先"只动真正两边的件。
 *
 * 用法：`node scripts/rebalance-relic-pool.mjs`（`--dry` 只报告不写盘 / `--show` 打逐件 diff）
 * ⚠ 写完必须走生成链：`gen:relic-design` → `gen:relics-inner` → `json2excel --force --table relics`
 *   → `npm run export` → `npm run check` → `check:pool` / `audit:archetype` / `audit:mine` …
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTR_TAGS, GENERIC_ATTR_TAGS, HOOKS, ATTR_CN, MAX_ATTRS_PER_RELIC } from './lib/relic-inner-design.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'lib/relic-inner-design.mjs');
const DRY = process.argv.includes('--dry');
const SHOW = process.argv.includes('--show');

/** 攻击距离 —— 白档"补进攻"用的那一条属性（`ATTR_VALUE.common[16]` 已登记） */
const RANGE = 16;

/* =====================================================================================
 * A. 白档 107 件 → 主标签（`r` 远程点杀 / `t` 坦克反伤 / `m` 法术爆发）
 *
 * 口径：**按名字（`kw`）与它已经给的那几条属性定**，不硬凑数字——
 *   · 「压制/敏捷/追猎/蓄势/溅射/阔剑/重剑/秘银/净化/以太/凶猛垫…」= 进攻件 → 远程点杀；
 *   · 「反伤/格挡/守护/血甲/护甲/锁甲/恢复/坚韧/壮实/坚强垫…」= 防御件 → 坦克反伤；
 *   · 「回蓝/法力/附魔/芒果/能量/神秘/圣衣…」= 施法件 → 法术爆发。
 * ===================================================================================== */
const WHITE = {
    /* ---- 坦克反伤 34 ---- */
    1: 't', 1002: 't', 1003: 't', 1006: 't', 1007: 't', 1008: 't', 1009: 't', 1011: 't', 1018: 't', 1020: 't',
    1023: 't', 1026: 't', 1035: 't', 1038: 't', 1039: 't', 1040: 't', 1045: 't', 1047: 't', 1060: 't', 1068: 't',
    1096: 't', 1110: 't', 1113: 't', 1216: 't', 1219: 't', 1220: 't', 1223: 't', 1224: 't', 1243: 't', 1245: 't',
    1249: 't', 1272: 't', 1273: 't', 1288: 't',
    /* ---- 法术爆发 42 ---- */
    1010: 'm', 1016: 'm', 1027: 'm', 1046: 'm', 1056: 'm', 1067: 'm', 1071: 'm', 1075: 'm', 1082: 'm', 1083: 'm',
    1084: 'm', 1097: 'm', 1102: 'm', 1103: 'm', 1104: 'm', 1106: 'm', 1108: 'm', 1118: 'm', 1214: 'm', 1215: 'm',
    1217: 'm', 1218: 'm', 1222: 'm', 1228: 'm', 1229: 'm', 1232: 'm', 1234: 'm', 1235: 'm', 1237: 'm', 1238: 'm',
    1239: 'm', 1240: 'm', 1246: 'm', 1247: 'm', 1251: 'm', 1256: 'm', 1258: 'm', 1270: 'm', 1271: 'm', 1276: 'm',
    1290: 'm', 1291: 'm',
    /* ---- 远程点杀 31 ---- */
    1001: 'r', 1004: 'r', 1012: 'r', 1017: 'r', 1024: 'r', 1028: 'r', 1029: 'r', 1036: 'r', 1037: 'r', 1042: 'r',
    1043: 'r', 1057: 'r', 1069: 'r', 1078: 'r', 1085: 'r', 1099: 'r', 1136: 'r', 1210: 'r', 1211: 'r', 1225: 'r',
    1227: 'r', 1230: 'r', 1248: 'r', 1250: 'r', 1254: 'r', 1255: 'r', 1275: 'r', 1277: 'r', 1282: 'r', 1285: 'r',
    1293: 'r',
};

/**
 * 白档里**要补一条攻击距离(16)**的件 → **目标属性集合**（写死，不走搜索：组合太紧，让求解器自己挑会撞）。
 *
 * 判据有三条，缺一条就不写进来：
 *   ① **不让出攻击力**（进攻件没了攻击力就不叫进攻件）；
 *   ② 目标集合在白档里的件数 **≤2**（`check:pool` C 组：白/蓝档同效果最多 2 件）；
 *   ③ 属性条目 ≤3（`MAX_ATTRS_PER_RELIC`）。
 * 白档可用的 9 条固定值属性里，"含 `3 攻击力` + `16 攻击距离` + 第三条"的组合**总共只有 7 种**
 * （`1/2/6/9/10/26/27` 各一种）⇒ 每种 2 件 = **14 件上限**，而其中 7 个槽已被现网占用 ⇒ 只能补 7~8 件。
 */
const WHITE_ADD_RANGE = {
    1029: [3, 10, 16],     // 攻击
    1036: [1, 3, 16],      // 耐久
    1037: [3, 9, 16],      // 阔剑
    1042: [3, 6, 16],      // 连锁
    1043: [3, 6, 16],      // 重剑
    1057: [3, 16, 26],     // 补给
    1078: [2, 3, 16],      // 奶酪
    1210: [3, 16, 27],     // 碎屑
};

/**
 * **腾槽**：把占着"要用的那个集合"的件改成别的集合（它已经确定不是远程点杀，丢攻击力不影响身份）。
 * 1273「坚强垫」原本是 `[3,6,16]`（坦克反伤件）⇒ 改成 `[6,9,16]`，把 `[3,6,16]` 让给 1042/1043。
 */
const WHITE_RESLOT = {
    1273: [6, 9, 16],
};

/** 让出属性时的偏好：越靠前越先让（防御/回蓝优先，攻击力最后） */
const DROP_ORDER = [9, 26, 10, 6, 2, 1, 27];
/** 白档可用的固定值属性（`ATTR_VALUE.common` 的 9 条）—— 只在"必须换一条"时才用来补位 */
const WHITE_ATTR_POOL = [1, 2, 3, 6, 9, 10, 26, 27];

/* =====================================================================================
 * B. 蓝+ 161 件 → 新钩子表（**只列要改的件**；没列到的一律不动）
 *
 * 三条纪律：
 *   ① **换钩不是加钩**（宽线让出多少条，专精线就接住多少条）⇒ 钩子实例总数不变、战力中性；
 *   ② 换上去的钩子必须**与这件遗物的名字/机制对得上**（例：`1242 巨人重锤` 本来就给暴击率 + 暴击倍率，
 *      从「震荡」改挂「暴击回响」是**纠正**）；
 *   ③ **`h` 的第一项决定主标签**（取 `HOOK_TAGS[首项][0]`）⇒ 只是"两边都算"的件（如 `1157 影刃`
 *      同时有首击与暴击回响）只需**重排**，效果一个字都不用改。
 *   ⚠ `hitPct` / `splash` / `pierce` / `frost` / `evadeCounter` 是**双标签**钩子，
 *     第一项固定 ⇒ 光靠重排换不了线（`hitPct` 永远是「远程点杀」、`frost` 永远是「元素持续」）。
 * ===================================================================================== */
const HOOKS_NEW = {
    /* ---- 物理暴击 6 → 14 ---- */
    1192: ['critEcho'],                    // 邪恶镰刀：本来就给暴击率 +22 / 暴击倍率 225（原挂「妖术」）
    1242: ['critEcho'],                    // 巨人重锤：同上（原挂「震荡」）
    1123: ['critEcho'],                    // 精华萃取器：击杀叠攻击力 → 暴击回响（同为"越打越强"的进攻轴）
    1286: ['critEcho'],                    // 主导：同上
    1129: ['multishot'],                   // 夜叉：攻速 → 散射（原「连击」）  ← 见弹幕段
    1212: ['critEcho'],                    // 秘仪手环：周期叠攻击力 → 暴击回响（原「仪式」）
    1089: ['critEcho'],                    // 恶魔刀锋：纯伤害件（原「首击」）
    1292: ['critEcho'],                    // 癫狂：代价件（攻速换多受 10% 伤害）→ 暴击的"博一把"
    1034: ['critEcho'],                    // 暗影护符：闪避件 → 暴击回响（「闪避反击」本来就是"闪完反打"）
    1244: ['critEcho'],                    // 斯凯奥克神像：同上
    1116: ['critEcho'],                    // 相位鞋：同上
    1086: ['critEcho'],                    // 闪避护符：同上
    /* ⚠ `1157 影刃` **不动**：它是 `audit:archetype` A/C 段的固定样本（三标签
     *   `['远程点杀','物理暴击','召唤增殖']`，用来验"只认主标签"）—— 把它换成暴击主标签
     *   会让那段判据失去样本。要动它就得同时改那两段。 */

    /* ---- 元素持续 7 → 13 ---- */
    1070: ['ignite'],                      // 仙灵之火：火（原「坚韧」回血）
    1226: ['poison'],                      // 宁静种籽：种籽 → 中毒（原「复苏」）
    1213: ['poison'],                      // 瑞斯图尔尖匕（浸染）：涂毒（原「追击」固定魔法伤害）
    1124: ['ignite'],                      // 魔龙枪：龙息（原「追击」）
    1177: ['frost'],                       // 希瓦的守护：冰霜（原「减速光环」—— 同为冰系，改挂带持续伤害的那条）
    1135: ['frost'],                       // 阿托斯之棍：冰（原「减速光环」）

    /* ---- 经济成长 4 → 14 ---- */
    1092: ['killGold'],                    // 掠夺者之斧："掠夺"（原「击杀回血」）
    1061: ['killGold'],                    // 芝士块：食物 = 资源（原「击杀回血」）
    1105: ['killGold'],                    // 影之灵龛：灵魂换金（原「击杀回血」）
    1148: ['killExpFlat'],                 // 魂之灵瓮：灵魂 = 经验（原「击杀回血」）
    1162: ['killExpFlat'],                 // 洞察烟斗："洞察"= 经验（原「法术屏障」）
    1278: ['killExpFlat'],                 // 睿智："睿智"= 经验（原「击杀减冷却」）
    1059: ['killGold'],                    // 肉山旗帜：肉山 = 金币（原「阶段增益」）
    1132: ['killGold'],                    // 弗拉基米尔的祭品：祭品 = 收益（原「击杀回血」）
    1154: ['killExpFlat'],                 // 灵魂之匣：同上（原「坚韧」）
    1058: ['killGold'],                    // 修理工具包：拆解回收（原「复苏」）
    1144: ['killExpFlat'],                 // 灵匣：灵魂容器 = 经验（原「击杀回蓝」）

    /* ---- 控制减速 14 → 13（让出 4 件给元素/暴击，接住 3 件）---- */
    1156: ['silenceProc', 'magicBarrier'], // 法师克星：重排（主线转沉默）
    1199: ['hexProc', 'firstStrike'],      // 白银之锋：「破隐诅咒」= 妖术（原「沉默」；同时保住 `hexProc` 这条钩子在用）
    1140: ['silenceProc', 'hitFlat'],      // 净魂之刃：重排（主线转沉默）

    /* ---- 背水血怒 12 → 18 ---- */
    4: ['bloodRush'],                      // 巨人之心：最大生命 + 攻速 → 血怒（原「坚韧」）
    1269: ['desperateAtk'],                // 冒险：代价件（护甲 −4 换进攻）→ 拼命（原「重击」）
    5: ['lastBreath'],                     // 掌中怜悯：低血线才发力的"怜悯"（原「不屈」）
    1044: ['desperateAtk'],                // 幽魂权杖：低血线减伤 → 拼命（背水血怒的"低血线"轴，交付物从生存换成输出）
    1253: ['lastBreath'],                  // 牛头人之角：濒死守护 → 浴血（同上）
    1165: ['lastBreath', 'regenTick'],     // 清莲宝珠：重排 + 首项换浴血（同为"血线"机制，主线转背水）

    /* ---- 弹幕散射 9 → 15 ---- */
    1179: ['multishot', 'execute'],        // 冈格尼尔：神枪开花（原「穿透」；`pierce` 与 `multishot` 同为多目标）
    1187: ['multishot'],                   // 金箍棒：一发打多个（原「穿透」）
    1129: ['multishot'],                   // 夜叉：攻速 → 散射（原「连击」）
    1021: ['volley'],                      // 加速手套：攻速 → 周期齐射（原「连击」）
    1112: ['multishot'],                   // 动力鞋：攻速 → 散射（原「连击」）
    1279: ['volley'],                      // 永恒：周期齐射（原「阶段增益」）

    /* ---- 召唤增殖 20 → 21 ---- */
    1141: ['clones', 'killStackAtk'],      // 支配头盔：重排（主线转增殖体）

    /* ---- 法术爆发：接手宽线让出的"法术味"件 ---- */
    1005: ['hitFlat'],                     // 智力斗篷：智力 → 普攻追加魔法（原「重击」）
    1172: ['killCdr', 'atkSpeedStack'],    // 夜慧对剑：重排（主线转冷却）
    1145: ['killCdr'],                     // 尤尔的神圣权杖：权杖 → 施法（原「法术屏障」）
};

/* =====================================================================================
 * 派生层
 * ===================================================================================== */

const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');
const lineRe = (id) => new RegExp(`^(\\s*\\{ id: ${id}, .*)$`);
const problems = [];
const report = [];

/** 一件遗物"只重排 `a` 时"能推出的主标签 */
function reachableByReorder(attrs) {
    const out = [];
    for (const a of attrs) if (ATTR_TAGS[a] && !out.includes(ATTR_TAGS[a])) out.push(ATTR_TAGS[a]);
    if (out.length) return out;
    for (const a of attrs) if (GENERIC_ATTR_TAGS[a] && !out.includes(GENERIC_ATTR_TAGS[a])) out.push(GENERIC_ATTR_TAGS[a]);
    return out;
}
const TAG_OF_KIND = { r: '远程点杀', t: '坦克反伤', m: '法术爆发' };

/** 读一行里的收益属性 id（`a: [...]`） */
function attrsOfLine(line) {
    const m = line.match(/a: \[([^\]]*)\]/);
    return m ? m[1].split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)) : null;
}

/* ---------- A-1. 求解"补 16"的那 16 件：结果集合必须 ≤2 / 属性条目 ≤3 ---------- */

const whiteLines = new Map();          // id → 行号
for (const id of Object.keys(WHITE).map(Number)) {
    const idx = lines.findIndex((l) => lineRe(id).test(l));
    if (idx < 0) { problems.push(`找不到白档 ${id} 那一行`); continue; }
    whiteLines.set(id, idx);
}

/** 现有"收益集合 → 件数"（补 16 之前） */
const setCount = new Map();
const keyOf = (attrs) => [...attrs].sort((a, b) => a - b).join(',');
for (const idx of whiteLines.values()) {
    const a = attrsOfLine(lines[idx]);
    if (a) setCount.set(keyOf(a), (setCount.get(keyOf(a)) ?? 0) + 1);
}
/** 上限：白/蓝档同效果 ≤2（`check:pool` 的 C 组） */
const MAX_SAME = 2;

const rangePlan = new Map();           // id → 新的属性数组
for (const [idStr, attrs] of Object.entries(WHITE_ADD_RANGE)) {
    const id = Number(idStr);
    if (!whiteLines.has(id)) { problems.push(`补 16 的名单里 ${id} 不在白档表里`); continue; }
    const cur = attrsOfLine(lines[whiteLines.get(id)]);
    if (!cur) { problems.push(`${id} 没有 a: []`); continue; }
    if (attrs.length > MAX_ATTRS_PER_RELIC) problems.push(`${id} 的目标集合有 ${attrs.length} 条属性（上限 ${MAX_ATTRS_PER_RELIC}）`);
    if (!attrs.includes(RANGE)) problems.push(`${id} 的目标集合里没有攻击距离`);
    if (cur.includes(3) && !attrs.includes(3)) problems.push(`${id} 原本有攻击力，目标集合却没有（不许把进攻件变成没有攻击力的件）`);
    rangePlan.set(id, attrs);
    // ⚠ **幂等**：已经落成目标集合的件不再重复记账（否则第二次跑会把它自己数成第 3 件）
    if (keyOf(cur) === keyOf(attrs)) continue;
    const key = keyOf(attrs);
    setCount.set(key, (setCount.get(key) ?? 0) + 1);
    report.push(`  补 16：${String(id).padStart(4)} [${cur.map((a) => ATTR_CN[a]).join('+')}] → [${attrs.map((a) => ATTR_CN[a]).join('+')}]`);
}
for (const [idStr, attrs] of Object.entries(WHITE_RESLOT)) {
    const id = Number(idStr);
    if (!whiteLines.has(id)) { problems.push(`腾槽名单里 ${id} 不在白档表里`); continue; }
    const cur = attrsOfLine(lines[whiteLines.get(id)]);
    rangePlan.set(id, attrs);
    if (keyOf(cur) === keyOf(attrs)) continue;        // 幂等
    setCount.set(keyOf(cur), (setCount.get(keyOf(cur)) ?? 0) - 1);
    setCount.set(keyOf(attrs), (setCount.get(keyOf(attrs)) ?? 0) + 1);
    report.push(`  腾槽：  ${String(id).padStart(4)} [${cur.map((a) => ATTR_CN[a]).join('+')}] → [${attrs.map((a) => ATTR_CN[a]).join('+')}]`);
}
for (const [key, n] of setCount) {
    if (n > MAX_SAME) problems.push(`白档同效果件被推到 ${n} 件（上限 ${MAX_SAME}）：[${key}]`);
}
for (const [, p] of rangePlan) void p;

/* ---------- A-2. 逐件定顺序（目标标签那条属性排最前） ---------- */

let whiteTouched = 0;
for (const [id, kind] of Object.entries(WHITE).map(([k, v]) => [Number(k), v])) {
    const idx = whiteLines.get(id);
    if (idx === undefined) continue;
    const attrs = rangePlan.get(id) ?? attrsOfLine(lines[idx]);
    const want = TAG_OF_KIND[kind];
    // ⚠ 两段查找：先 `ATTR_TAGS`（有区分度的属性），再 `GENERIC_ATTR_TAGS`（1 最大生命 / 3 攻击力 的兜底）
    const exact = attrs.find((a) => ATTR_TAGS[a] === want) ?? attrs.find((a) => GENERIC_ATTR_TAGS[a] === want);
    if (exact === undefined) {
        problems.push(`白档 ${id}：给它 ${attrs.map((a) => ATTR_CN[a]).join('+')} 之后推不出「${want}」（可达：${reachableByReorder(attrs).join('/') || '无'}）`);
        continue;
    }
    const next = [exact, ...attrs.filter((a) => a !== exact)];
    const before = attrsOfLine(lines[idx]);
    if (JSON.stringify(before) !== JSON.stringify(next)) whiteTouched++;
    lines[idx] = lines[idx].replace(/a: \[[^\]]*\]/, `a: [${next.join(', ')}]`);
}

/* ---------- B. 钩子表 ---------- */

const HOOK_BY_ID = Object.fromEntries(HOOKS.map((h) => [h.id, h]));
let hookTouched = 0;
for (const [idStr, hooks] of Object.entries(HOOKS_NEW)) {
    const id = Number(idStr);
    const idx = lines.findIndex((l) => lineRe(id).test(l));
    if (idx < 0) { problems.push(`找不到 ${id} 那一行`); continue; }
    /**
     * ⚠ **白档不许有钩子**（`RARITY_PLAN.common.hooks = 0`：白档只给属性）。
     * 这条护栏是必需的：本脚本对"没有 `h:` 的行"有一套插入写法，而白档的行全都没有 `h:` ——
     * 表里误写一个白档 id 就会**静默给白件加一条钩子**（2026-11 实测踩到：`1214 决斗` 被加了 `stunProc`）。
     */
    if (/r: 'common'/.test(lines[idx])) { problems.push(`${id} 是白档件，不许挂钩子（白档只给属性）`); continue; }
    for (const h of hooks) if (!HOOK_BY_ID[h]) problems.push(`${id}：未定义的钩子 ${h}`);
    if (hooks.length > 3) problems.push(`${id}：钩子超过 3 个`);
    const before = lines[idx].match(/h: \[([^\]]*)\]/)?.[1] ?? '(无)';
    const lit = hooks.map((h) => `"${h}"`).join(', ');
    const orig = lines[idx];
    if (lines[idx].includes('h: [')) lines[idx] = lines[idx].replace(/h: \[[^\]]*\]/, `h: [${lit}]`);
    else lines[idx] = lines[idx].replace(/,\s*kw:/, `, h: [${lit}], kw:`);
    if (lines[idx] !== orig) hookTouched++;               // 幂等：一样就不算改动
    if (SHOW) report.push(`  蓝+ ${String(id).padStart(4)} h=[${before}] → [${lit}]`);
}

/* ---------- 汇总 ---------- */

if (problems.length) {
    console.error(`✖ 迁移表有问题（${problems.length} 条），未写盘：`);
    for (const p of problems) console.error('   ' + p);
    process.exit(1);
}
if (DRY) {
    console.log(`[池配平] --dry：白档改 ${whiteTouched} 件、蓝+改 ${hookTouched} 件，未写盘`);
} else {
    fs.writeFileSync(FILE, lines.join('\n'), 'utf8');
    console.log(`[池配平] 已写 ${path.relative(path.resolve(__dirname, '../../..'), FILE)}：白档 ${whiteTouched} 件、蓝+ ${hookTouched} 件`);
}
if (SHOW) for (const r of report) console.log(r);
