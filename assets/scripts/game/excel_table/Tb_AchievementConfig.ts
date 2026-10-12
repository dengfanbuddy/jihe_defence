import { tb_config } from '../../platform/excel_table/TbConfigDecorator';
import { TbContainer } from '../../platform/excel_table/TbContainer';

/**
 * 成就配置表（achievements.json）
 *
 * **一行 = 一档**（不是一行一成就）：同一条成就的多档共用 `group`，
 * 程序在 `afterHandle()` 里按 group 归并成 `AchGroupCfg`（一条成就 = 一份 tiers[]）。
 *
 * 与任务表（`Tb_TaskConfig` / `tasks.json`）的分工见 `docs/成就系统设计.md`：
 *   · tasks        = 日/周**周期性**任务，奖励账号经验 + 金币，会重置；
 *   · achievements = **一次性永久**目标，奖励金币；**核心成就的末档**额外给 1 个特殊效果。
 *
 * id 段位：31xx 等级 / 32xx 闯关 / 33xx 战斗 / 34xx 经济 / 35xx 收集 / 36xx 挑战
 * （段内**顺序编号**，一个分类不超过 99 行：成就表**每行一档**，所以一条成就占几行由它的档位数决定）。
 *
 * ⚠ **档位数不固定**（2026-11 改版）：以前是「每条成就恰好 3 档（铜/银/金）」，现在按成长空间定 ——
 * 账号等级 20 档、收集类 6~7 档、通关类 5~6 档。界面上的档位文案因此改成 **「阶段N」**
 * （`common/AchievementTierColor.ts`），档位色按"第几档 / 共几档"的比例取三色锚点。
 *
 * 结构化门禁（`afterHandle` 里运行时告警，`npm run check` 里有对应的硬校验）：
 *   ① 同 group 的 tier 从 1 连续；② count / reward_gold 严格递增；
 *   ③ `effect_code` 只允许出现在该 group 的**最大 tier**；④ 同一 effect_code 全表最多 1 个来源；
 *   ⑤ `run_*` 型 target **必须**写正整数的 `param`（门槛），否则那条成就**永远不会推进**。
 *
 * 查询：TbRoot.ins.getTbContainer(AchievementCfgContainer).getByCategory('stage')
 */
/** 成就分类（界面页签） */
export type AchCategory = 'level' | 'stage' | 'combat' | 'economy' | 'collect' | 'challenge';

/**
 * 完成条件标识。
 * **前 12 个与 `tasks.json` 共用**（语义唯一真源 = `TaskData.TargetMode`，两者必须一致）；
 * 其余是成就专属（数据来源见 `docs/成就系统设计.md` §3.3）。
 */
export type AchTarget =
    // —— 与 tasks 共用 ——
    | 'login' | 'play_games' | 'victory' | 'kill_enemies' | 'gold_earned' | 'spend_gold'
    | 'relics_picked' | 'skills_used' | 'buffs_bought' | 'stage_reached' | 'hero_level' | 'level_reached'
    // —— 成就专属·累计 / 峰值 / 标记 ——
    | 'level_up_count' | 'login_streak' | 'survive_time' | 'kill_in_run' | 'gold_in_run'
    | 'clear_no_damage' | 'clear_fast' | 'clear_low_hp' | 'run_no_relic_clear' | 'clear_one_skill'
    | 'damage_dealt' | 'crit_hits' | 'draw_count' | 'relic_collected' | 'buff_types' | 'skills_picked'
    // —— 成就专属·「门槛 × 局数」（2026-11 新增，见 ACH_RUN_TARGETS）——
    | 'run_stage' | 'run_hero_level' | 'run_kill' | 'run_gold' | 'run_survive';

/**
 * 「门槛 × 局数」型 target（**累加型，计数单位是「局」**）。
 *
 * 为什么加这一族（用户口径 2026-11）：「战线推进，一局就能领到银 1000 多」——
 * 旧的 `stage_reached` / `hero_level` 是**单局峰值**，而一局里就能从第 1 阶段打到第 5 阶段，
 * 于是三档在同一局里全部达成。改成这一族之后，**一局最多推进 1 点进度**，
 * 玩家必须"很多局都做到"才能拿到高档位。
 *
 * `param` = 门槛（正整数，字符串写在配表里），语义见下表；
 * 上报口 = `AchievementData.reportRunGoals()`（结算时调一次，见 `Scene_Game_Stage.reportRunTasks`）。
 */
export const ACH_RUN_TARGETS: AchTarget[] = [
    'run_stage',        // param = 阶段数：单局把战线推进到第 param 阶段
    'run_hero_level',   // param = 等级：单局英雄等级达到 param 级
    'run_kill',         // param = 击杀数：单局击杀达到 param 只
    'run_gold',         // param = 金币：单局持有金币达到 param
    'run_survive',      // param = 秒：单局存活达到 param 秒
];

/** 是否「门槛 × 局数」型 target */
export function isRunTarget(target: string): boolean {
    return ACH_RUN_TARGETS.indexOf(target as AchTarget) >= 0;
}

/**
 * 特殊效果标识（**白名单 11 条**）。
 * 数值语义 / 封顶 / 生效点见 `game/common/AchievementEffectMeta.ts`（唯一真源）。
 *
 * ⚠ 这 11 条**不是"成就专用"**：它同时是「局外增益券池」的键表（`battle_constants.shopBoostTicketValues`
 *   与 `bag_items` 的 `boost_*` 行必须一条不漏地覆盖它，`audit:bag` A7c / `audit:mall` B4 盯着），
 *   也是局外红件词缀（`relics.effects_outer`）的取值表 —— 所以**加一条 code 要同时补这三处**，
 *   否则有的券发不出去、红件词缀写进去也是静默无效。
 */
export type AchEffectCode =
    | 'run_start_gold' | 'run_start_kill_points' | 'shop_option_plus' | 'shop_draw_discount' | 'ad_free_draw'
    | 'kill_buff_discount' | 'gold_gain_bonus' | 'battle_exp_bonus' | 'hero_start_level' | 'hero_select_free'
    | 'relic_start_gift';

/** 成就的一档（= 配表一行） */
export interface AchCfg {
    /** 成就ID（31xx 等级 / 32xx 闯关 / 33xx 战斗 / 34xx 经济 / 35xx 收集 / 36xx 挑战） */
    id: number;
    /** 成就组（同一条成就的多档共用） */
    group: string;
    /** 档位序号：**1 起、组内连续**（界面文案 = 「阶段N」，档位数不限） */
    tier: number;
    /** 分类（界面页签） */
    category: AchCategory;
    /** 成就名 */
    name: string;
    /** 成就描述（**逐档可不同**：卡面显示的是「下一档」这一行的 desc，如「累计3局把战线推进到第2阶段。」） */
    desc?: string;
    /** 图标资源路径（不带扩展名；空 = 回落占位图） */
    icon?: string;
    /** 完成条件 */
    target: AchTarget;
    /** 条件参数（`run_*` 型 = **门槛**，正整数；其余类型留空） */
    param?: string;
    /** 目标数量（> 0） */
    count: number;
    /** 奖励·局外金币 */
    reward_gold: number;
    /** 特殊效果标识（**只允许出现在该 group 的最大 tier**） */
    effect_code?: AchEffectCode;
    /** 效果数值（百分比类填百分数：10 = 10%） */
    effect_value?: number;
    /** 1 = 隐藏成就（达成前不展示） */
    silent?: number;
    /** 同分类内排序 */
    sort?: number;
}

/** 一条成就（= 同 group 的全部档位归并后的展示/计算单位） */
export interface AchGroupCfg {
    /** 成就组 */
    group: string;
    /** 分类 */
    category: AchCategory;
    /** 成就名 */
    name: string;
    /** 描述（缺省空串） */
    desc: string;
    /** 图标（缺省空串） */
    icon: string;
    /** 完成条件 */
    target: AchTarget;
    /** 条件参数（缺省空串） */
    param: string;
    /** 是否隐藏成就 */
    silent: boolean;
    /** 排序 */
    sort: number;
    /** 全部档位（**按 tier 升序**） */
    tiers: AchCfg[];
    /** 最高档（缺省 0） */
    maxTier: number;
    /** 末档的特殊效果（无则 null）——「只有高等级成就有特殊效果」的落点 */
    effect: AchEffectRef | null;
}

/** 末档效果引用 */
export interface AchEffectRef {
    code: AchEffectCode;
    value: number;
}

@tb_config(':tb/achievements')
export class AchievementCfgContainer extends TbContainer<AchCfg> {
    getTbName(): string { return 'AchievementCfg'; }

    /** 归并后的成就（一条 = 同 group 的全部档位，已按 category/sort 排序） */
    groups: AchGroupCfg[] = [];

    /** group → 归并结果 */
    private _groupMap: Map<string, AchGroupCfg> = new Map();

    /**
     * 表数据装载完成后归并成「成就」并做结构化体检。
     *
     * 归并是**必须**的：配表一行一档是为了让每档能写各自的 `count` / `param` / `desc` / 奖励 / 效果，
     * 但界面与数据层要的是「一条成就 + 它的全部档位」——归并只做一次，别让消费方各自拼。
     * ⚠ 档位数**不固定**（3~20 档），所以任何地方都不许假设「恰好 3 档」。
     */
    afterHandle(): void {
        this.groups = [];
        this._groupMap.clear();

        for (const cfg of this.cfgs) {
            let g = this._groupMap.get(cfg.group);
            if (!g) {
                g = {
                    group: cfg.group,
                    category: cfg.category,
                    name: cfg.name,
                    desc: cfg.desc ?? '',
                    icon: cfg.icon ?? '',
                    target: cfg.target,
                    param: cfg.param ?? '',
                    silent: (cfg.silent ?? 0) === 1,
                    sort: cfg.sort ?? 0,
                    tiers: [],
                    maxTier: 0,
                    effect: null,
                };
                this._groupMap.set(cfg.group, g);
                this.groups.push(g);
            }
            g.tiers.push(cfg);
            if ((cfg.sort ?? 0) > 0 && g.sort === 0) g.sort = cfg.sort ?? 0;
        }

        // 档位排序 + 末档效果提取 + 体检
        const effectSource = new Map<string, string>();
        for (const g of this.groups) {
            g.tiers.sort((a, b) => a.tier - b.tier);
            g.maxTier = g.tiers.length ? g.tiers[g.tiers.length - 1].tier : 0;

            const last = g.tiers[g.tiers.length - 1];
            if (last && last.effect_code) {
                g.effect = { code: last.effect_code, value: last.effect_value ?? 0 };
                // ④ 同一 effect_code 只允许 1 个来源（保证「效果不叠加」，见设计稿 §5.3）
                const prevSource = effectSource.get(last.effect_code);
                if (prevSource) {
                    console.warn(`[成就表] effect_code「${last.effect_code}」有多个来源（${prevSource} / ${g.group}），`
                        + '设计口径是每条效果只有 1 个来源，请检查 achievements.xlsx');
                } else {
                    effectSource.set(last.effect_code, g.group);
                }
            }

            this._validateGroup(g);
        }

        // 稳定排序：先分类（按 ACH_CATEGORY_ORDER），再 sort，最后 group 名
        const order = new Map<string, number>();
        ACH_CATEGORY_ORDER.forEach((c, i) => order.set(c, i));
        this.groups.sort((a, b) =>
            (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99)
            || a.sort - b.sort
            || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
    }

    /** 一条成就（按 group） */
    getGroup(group: string): AchGroupCfg | undefined {
        return this._groupMap.get(group);
    }

    /** 全部成就（已排序） */
    getGroups(): AchGroupCfg[] {
        return this.groups;
    }

    /** 某个分类的成就（已排序） */
    getByCategory(category: string): AchGroupCfg[] {
        return this.groups.filter(g => g.category === category);
    }

    /** 某条成就的某一档配表行（不存在返回 undefined） */
    getTierCfg(group: string, tier: number): AchCfg | undefined {
        return this._groupMap.get(group)?.tiers.find(t => t.tier === tier);
    }

    /** 某条成就的最高档（缺省 0） */
    getMaxTier(group: string): number {
        return this._groupMap.get(group)?.maxTier ?? 0;
    }

    // ────────────── 内部：结构化体检（只告警，不抛异常） ──────────────

    private _validateGroup(g: AchGroupCfg): void {
        for (let i = 0; i < g.tiers.length; i++) {
            const cfg = g.tiers[i];
            // ① 档位从 1 连续
            if (cfg.tier !== i + 1) {
                console.warn(`[成就表] ${g.group} 的档位不连续：第 ${i + 1} 行是 tier=${cfg.tier}（应为 ${i + 1}）`);
            }
            // ② count / reward_gold 严格递增
            if (i > 0) {
                const prev = g.tiers[i - 1];
                if (cfg.count <= prev.count) {
                    console.warn(`[成就表] ${g.group} 的 count 未递增：tier${prev.tier}=${prev.count} → tier${cfg.tier}=${cfg.count}`);
                }
                if (cfg.reward_gold <= prev.reward_gold) {
                    console.warn(`[成就表] ${g.group} 的 reward_gold 未递增：tier${prev.tier}=${prev.reward_gold} → tier${cfg.tier}=${cfg.reward_gold}`);
                }
            }
            // ③ 效果只允许在末档
            if (cfg.effect_code && cfg.tier !== g.maxTier) {
                console.warn(`[成就表] ${g.group} 的 tier${cfg.tier} 带了 effect_code`
                    + `（只有末档 tier${g.maxTier} 允许有效果），该效果会被忽略`);
            }
            // 目标数量必须 > 0（否则一进游戏就完成）
            if (!(cfg.count > 0)) {
                console.warn(`[成就表] ${g.group} 的 tier${cfg.tier} count=${cfg.count} 非法（应 > 0）`);
            }
            // ⑤ 「门槛 × 局数」型必须写正整数 param —— 漏了/写错的话这条成就**永远不会推进**
            //   （判据在 `AchievementData.reportRunGoals`：param 解析不出正数就整条跳过），
            //   而配表侧完全看不出来（导表工具只校验字段类型）。
            if (isRunTarget(cfg.target) && !(Number(cfg.param) > 0)) {
                console.warn(`[成就表] ${g.group} 的 tier${cfg.tier} 是 ${cfg.target}（门槛×局数型），`
                    + `但 param=${JSON.stringify(cfg.param)} 不是正整数 —— 这一档永远不会推进`);
            }
            // 非局数型不该带 param（带了是误导：判据根本不读它）
            if (!isRunTarget(cfg.target) && cfg.param !== undefined && cfg.param !== '') {
                console.warn(`[成就表] ${g.group} 的 tier${cfg.tier} 不是门槛×局数型（${cfg.target}），`
                    + `param=${JSON.stringify(cfg.param)} 不会被消费`);
            }
        }
    }
}

/** 分类顺序（界面分类条的顺序，**唯一真源**） */
export const ACH_CATEGORY_ORDER: string[] = ['level', 'stage', 'combat', 'economy', 'collect', 'challenge'];

/** 分类中文名（界面分类条用） */
export const ACH_CATEGORY_NAME: Record<string, string> = {
    level: '等级',
    stage: '闯关',
    combat: '战斗',
    economy: '经济',
    collect: '收集',
    challenge: '挑战',
};
