import { MonsterAI } from './MonsterAI';
import type { BattleContext } from '../BattleContext';

/**
 * ============================================================
 * BossAI —— Boss 阶段机 AI（"Boss 背景"的那一套：分阶段行为 + 技能循环）
 * ============================================================
 *
 * 配置全在 `units.json` 的 `ai.params`（`ai.type === 'boss'`），三个字段：
 *
 * ```jsonc
 * {
 *   "type": "boss",
 *   "params": {
 *     // ① 技能循环（2026-11 新增；本项缺省时回落到老字段 skillInterval/skillId）
 *     "skills": [
 *       { "abilityId": 1,  "interval": 6,  "delay": 3 },                    // 全程，每 6s
 *       { "abilityId": 30, "interval": 16, "delay": 8,  "hpBelow": 0.65 },  // 掉到 65% 血才解锁
 *       { "abilityId": 31, "interval": 22, "delay": 14, "hpBelow": 0.35 }   // 掉到 35% 血才解锁
 *     ],
 *     // ② 阶段机：按当前血量比例切行为（从高血量到低血量），可给自己挂狂暴 Modifier
 *     "phases": [
 *       { "hpRatio": 1,   "behavior": "chase",       "params": { "speedMul": 0.8 } },
 *       { "hpRatio": 0.7, "behavior": "orbit",       "params": { "orbitRadius": 150, "angularSpeed": 1.2 } },
 *       { "hpRatio": 0.4, "behavior": "chase",       "params": { "speedMul": 1.6 } },
 *       { "hpRatio": 0.2, "behavior": "attack_stop", "params": { "stopDuration": 1.2, "speedMul": 1.8 },
 *         "onEnterModifier": 9, "onEnterDuration": 8 }
 *     ]
 *   }
 * }
 * ```
 *
 * ── 为什么必须修它（2026-11 抓到的真 bug）──
 *   这份配置**一直都在**（2006 深渊领主 / 2008 经验贤者都写着 `skillInterval` + `skillId`），
 *   但那个 `skillId` 是**字符串**（`"fireball"` / `"sun_light"`），而 `AbilitySystem.CastAbility`
 *   要的是**数字 id**（它 `getAbility(id)` 按 `a.getId() === id` 找）——
 *   于是 `getAbility('fireball')` 恒为 undefined、`CastAbility` 恒返回 false，
 *   **Boss 的技能从来没放出来过**，而且一声不吭（没有 warn、没有日志）。
 *   修法两条一起上：① `resolveAbilityRef()` 同时认数字 id / 数字串 / `code` / `name_en` / 中文名；
 *   ② 解析不出来 / 施放失败就 `console.warn`（静默失败是这个工程最贵的一类 bug）。
 *
 * ── 为什么技能是"列表 + 各自 interval"而不是一个 skillInterval ──
 *   最终 Boss 的威胁要**随血量递进**：一开场就放大招会让"前期压血"变成惩罚，
 *   而 `hpBelow` 让"打到 65% 解锁恐惧咆哮、35% 解锁深渊诅咒"成为可读的阶段语言。
 */
export class BossAI extends MonsterAI {
    /** 阶段定义（按 hpRatio 降序） */
    private phases: BossPhaseSpec[] = [];
    /** 技能循环 */
    private skills: BossSkillSpec[] = [];
    /** 当前阶段索引 */
    private phaseIdx = 0;
    /** 上一个**已回调过**的阶段索引（-1 = 还没进过任何阶段） */
    private appliedPhase = -1;
    /** 每个技能的剩余冷却（与 `skills` 同下标） */
    private skillTimers: number[] = [];
    /** 已经告警过（避免每帧刷屏） */
    private warned = false;

    override onAttach(): void {
        const resolve = (raw: unknown): number => resolveAbilityRef(raw, this.abilityCfgs());
        this.phases = normalizePhases(this.getParam<any>('phases', []));
        this.skills = normalizeSkills(this.getParam<any>('skills', null), this.params, resolve);
        this.skillTimers = this.skills.map((s) => Math.max(0, s.delay));
        this.phaseIdx = 0;
        this.appliedPhase = -1;
        this.warned = false;
        // 配了技能却一个都解析不出来 → 当场喊出来（否则就是一个"看起来有技能"的哑巴 Boss）
        const declared = this.params?.skills ?? (this.params?.skillId ? [this.params.skillId] : null);
        if (declared && this.skills.length === 0) {
            console.warn(`[BossAI] ${(this.entity as any)?.name} 的技能配置一条都没解析出来：`
                + `${JSON.stringify(declared)} —— 检查 units.json 的 ai.params.skills.abilityId 是否指向 abilities.json 的 id`);
        }
    }

    /** 当前阶段索引（0 起；调试 / 体检用） */
    getPhaseIndex(): number { return this.phaseIdx; }

    /** 本 Boss 的技能循环（调试 / 体检用；返回副本，外部改不动内部状态） */
    getSkills(): BossSkillSpec[] { return this.skills.map((s) => ({ ...s })); }

    update(dt: number): void {
        const target = this.findTarget();
        if (!target) return;

        // 1. 阶段判定（按当前血量比例）
        const hpRatio = this.entity.getMaxHp() > 0 ? this.entity.hp / this.entity.getMaxHp() : 0;
        let idx = 0;
        for (let i = 0; i < this.phases.length; i++) {
            if (hpRatio <= this.phases[i].hpRatio) {
                idx = i;
                break;
            }
        }
        if (idx !== this.phaseIdx) {
            this.phaseIdx = idx;
            console.log(`[BossAI] ${this.entity.name} 进入阶段 ${idx + 1} (HP ${Math.round(hpRatio * 100)}%)`);
        }

        // 2. 阶段切换回调（进入新阶段时**只调一次**）
        if (this.phaseIdx !== this.appliedPhase) {
            this.appliedPhase = this.phaseIdx;
            this.onPhaseChanged(this.phaseIdx);
        }

        // 3. 技能循环
        this.tickSkills(dt, target, hpRatio);

        // 4. 当前阶段行为
        this.executeBehavior(this.phases[this.phaseIdx], dt, target);
    }

    /** 阶段切换钩子（子类可覆写；缺省按配表的 `onEnterModifier` 给自己挂一层） */
    protected onPhaseChanged(phaseIdx: number): void {
        const spec = this.phases[phaseIdx];
        const mod = Number(spec?.onEnterModifier ?? 0);
        if (!(mod > 0)) return;
        const host = this.entity as any;
        const dur = Number(spec?.onEnterDuration ?? -1);
        // 走 ModifierSystem 的统一入口（origin 带阶段号，重进同一阶段不会叠出多层）
        host?.modifiers?.AddModifier?.(mod, host, dur, spec?.onEnterKv, `bossphase:${phaseIdx + 1}`);
    }

    /**
     * 技能循环：每个技能各持一个计时器，到点、**在施法距离内**、且血量档位已解锁才放。
     *
     * ⚠ 距离必须判：`orbit` 阶段会主动保持 150px 距离，而技能的 `cast_range` 常常更大 ——
     *   不判距离时"放技能"与"站位"会互相打架（表现为远处的 Boss 隔空放技能）。
     */
    private tickSkills(dt: number, target: any, hpRatio: number): void {
        if (this.skills.length === 0) return;
        const me = (this.entity as any).position ?? { x: 0, y: 0 };
        const tx = target?.position?.x ?? me.x;
        const ty = target?.position?.y ?? me.y;
        const dist = Math.hypot(tx - me.x, ty - me.y);

        for (let i = 0; i < this.skills.length; i++) {
            const spec = this.skills[i];
            this.skillTimers[i] -= dt;
            if (this.skillTimers[i] > 0) continue;
            if (spec.hpBelow < 1 && hpRatio > spec.hpBelow) continue;   // 还没掉到这个血量档

            const range = this.skillRange(spec);
            if (dist > range) continue;                                  // 不在施法距离内：等它靠近，不重置节拍

            const ok = this.castSkill(spec, target);
            // 无论成没成都要重置节拍：失败多半是"技能还在自己的冷却里"，
            // 每帧重试只会白跑（`canCast` 会拦，但那是无意义的每帧开销）
            this.skillTimers[i] = spec.interval;
            if (!ok && !this.warned) {
                this.warned = true;
                console.warn(`[BossAI] ${this.entity.name} 的技能 ${spec.abilityId} 施放失败`
                    + '（id 配错 / 仍在冷却 / 蓝不够？）—— 技能放不出来时 Boss 会退化成"只会平A的木桩"');
            }
        }
    }

    /** 技能的施法距离（像素）：配表 `cast_range`，缺省回落普攻距离 */
    private skillRange(spec: BossSkillSpec): number {
        if (spec.range > 0) return spec.range;
        const cfg = this.abilityCfgs().find((c: any) => Number(c?.id) === spec.abilityId);
        const cast = Number(cfg?.cast_range ?? 0);
        if (cast > 0) return cast;
        return this.entity.getAttackRange();
    }

    /** 放一个技能（把"字符串 id 解析不出来"这类静默失败显式化） */
    private castSkill(spec: BossSkillSpec, target: any): boolean {
        const host = this.entity as any;
        if (!host?.abilities?.CastAbility) return false;
        // ⚠ `selfCast` 必须支持：2008「经验贤者」的技能是**治疗**（abilities#3 圣光术），
        //   而 BossAI 的常规目标是"最近的敌人"—— 照默认传下去它会**给英雄加血**。
        const t = spec.selfCast ? host : target;
        return host.abilities.CastAbility(spec.abilityId, t) === true;
    }

    /** 技能配表（懒查一次，缓存到本实例上） */
    private abilityCfgs(): any[] {
        const self = this as any;
        if (!self.__skillCfgs) self.__skillCfgs = (this.ctx?.abilityContainer as any)?.cfgs ?? [];
        return self.__skillCfgs;
    }

    /** 执行当前阶段行为（委托给对应 AI 逻辑） */
    private executeBehavior(phase: BossPhaseSpec | undefined, dt: number, target: any): void {
        const p = phase?.params ?? {};
        const dist = this.distanceTo(target);
        const attackRange = this.entity.getAttackRange();

        switch (phase?.behavior) {
            case 'orbit': {
                const radius = p.orbitRadius ?? 250;
                const angular = p.angularSpeed ?? 1.5;
                const dx = target.position.x - this.entity.position.x;
                const dy = target.position.y - this.entity.position.y;
                const cur = Math.hypot(dx, dy) || 1;
                const radialX = dx / cur, radialY = dy / cur;
                this.entity.position.x += radialX * (cur - radius) * 0.5 * dt;
                this.entity.position.y += radialY * (cur - radius) * 0.5 * dt;
                this.moveDirection(-radialY * angular, radialX * angular, dt, 1);
                // ⚠ 判的是 `max(环绕半径, 攻击距离)`：只判 radius 时，
                //   若环绕半径 < 攻击距离，Boss 会站在"打得到却不出手"的死区里原地转圈
                if (cur <= Math.max(radius, attackRange) && !this.entity.isAttackOnCooldown()) {
                    this.tryAttack(target);
                }
                break;
            }
            case 'attack_stop': {
                if (dist <= attackRange) {
                    if (this.tryAttack(target)) {
                        this.timer = p.stopDuration ?? 2;
                    } else if (this.timer <= 0) {
                        this.timer = p.stopDuration ?? 2;
                    }
                    this.timer -= dt;
                    // 停顿期间不动
                } else {
                    this.moveToward(target, dt, p.speedMul ?? 1);
                }
                break;
            }
            case 'chase':
            default: {
                if (dist <= attackRange) {
                    this.tryAttack(target);
                } else {
                    this.moveToward(target, dt, p.speedMul ?? 1);
                }
                break;
            }
        }
    }
}

/* ===================================================================
 * 配表解析（纯函数，导出供体检脚本真跑）
 * =================================================================== */

/** 一个阶段的行为定义（`units.json` 的 `ai.params.phases[]`） */
export interface BossPhaseSpec {
    /** 血量比例阈值：当前 HP 比例 ≤ 它时进入本阶段（1 = 一开场就在本阶段） */
    hpRatio: number;
    /** 本阶段的移动/攻击行为（chase / orbit / attack_stop） */
    behavior: string;
    /** 行为参数（透传给行为实现） */
    params?: Record<string, any>;
    /** 进入本阶段时给自己挂的 Modifier id（0/缺省 = 不挂；如 9 = 狂暴） */
    onEnterModifier?: number;
    /** 上面那条 Modifier 的持续（秒；-1/缺省 = 永久） */
    onEnterDuration?: number;
    /** 上面那条 Modifier 的 kv */
    onEnterKv?: Record<string, any>;
}

/** 一个技能循环项（`units.json` 的 `ai.params.skills[]`） */
export interface BossSkillSpec {
    /** **数字**技能 id（`abilities.json` 的 id）。字符串写法在 `normalizeSkills` 里被解析 */
    abilityId: number;
    /** 施放间隔（秒） */
    interval: number;
    /** 首次施放的延迟（秒）—— 出场不要一上来就放大招 */
    delay: number;
    /** 血量比例 ≤ 它才解锁（1 = 全程可用） */
    hpBelow: number;
    /** 施法距离（像素；0 = 用技能配表的 cast_range，再缺省用普攻距离） */
    range: number;
    /**
     * 施法目标是不是**自己**。
     *
     * 缺省 false = 打最近的敌人（Boss 的常态）。治疗/护盾类技能必须配 true ——
     * 否则 `CastAbility(skill, 最近的敌人)` 会变成"给英雄加血"（2008 经验贤者就踩在这上面）。
     */
    selfCast: boolean;
}

/** 阶段表规范化：过滤非法项、按 hpRatio 降序、空表回落"两段追击"默认 */
export function normalizePhases(raw: any): BossPhaseSpec[] {
    const out: BossPhaseSpec[] = [];
    if (Array.isArray(raw)) {
        for (const p of raw) {
            if (!p || typeof p !== 'object') continue;
            const hpRatio = Number(p.hpRatio);
            if (!Number.isFinite(hpRatio)) continue;
            out.push({
                hpRatio: Math.max(0, Math.min(1, hpRatio)),
                behavior: String(p.behavior ?? 'chase'),
                params: p.params,
                onEnterModifier: Number(p.onEnterModifier ?? 0) || undefined,
                onEnterDuration: p.onEnterDuration,
                onEnterKv: p.onEnterKv,
            });
        }
    }
    out.sort((a, b) => b.hpRatio - a.hpRatio);
    if (out.length === 0) {
        // 默认两阶段：70% 前正常追击，70% 后狂暴追击
        return [
            { hpRatio: 1.0, behavior: 'chase', params: { speedMul: 1 } },
            { hpRatio: 0.7, behavior: 'chase', params: { speedMul: 1.5 } },
        ];
    }
    return out;
}

/**
 * 技能表规范化。
 *
 * 两种写法都认（**老字段刻意保留**：`units.json` 里 2026-11 之前写的都是老写法，
 * 直接删掉会让那两只 Boss 静默变成"没有技能"—— 那正是本次要修的 bug）：
 *   · 新：`skills: [{ abilityId | skillId, interval, delay, hpBelow, range }]`
 *   · 老：`skillInterval` + `skillId`（单个技能，delay = interval）
 *
 * @param raw     `params.skills`
 * @param params  整个 `params`（读老字段 + 给新写法兜底 interval）
 * @param resolve 字符串 → 数字技能的解析器（缺省只认数字与数字串）
 */
export function normalizeSkills(
    raw: any,
    params: Record<string, any>,
    resolve?: (raw: unknown) => number,
): BossSkillSpec[] {
    const toId = resolve ?? ((v: unknown): number => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    });
    const fallbackInterval = Math.max(0, Number(params?.skillInterval ?? 0));
    const out: BossSkillSpec[] = [];

    if (Array.isArray(raw)) {
        for (const s of raw) {
            if (!s || typeof s !== 'object') continue;
            const id = toId(s.abilityId ?? s.skillId);
            if (!(id > 0)) continue;
            const interval = Number(s.interval ?? fallbackInterval);
            out.push({
                abilityId: id,
                interval: interval > 0 ? interval : 6,
                delay: Math.max(0, Number(s.delay ?? 0)),
                hpBelow: clamp01(Number(s.hpBelow ?? 1)),
                range: Math.max(0, Number(s.range ?? 0)),
                selfCast: s.selfCast === true || Number(s.selfCast) === 1,
            });
        }
        return out;
    }

    // 老写法：单个技能（`skillInterval` + `skillId`）
    const legacyId = toId(params?.skillId);
    if (legacyId > 0 && fallbackInterval > 0) {
        out.push({
            abilityId: legacyId, interval: fallbackInterval, delay: fallbackInterval,
            hpBelow: 1, range: 0, selfCast: false,
        });
    }
    return out;
}

/**
 * 把配表里的技能标识解析成**数字技能 id**（导出是为了能单独体检）。
 *
 * 认四种写法（按优先级）：数字 / 数字串 / `code` / `name_en` / 中文 `name`。
 * 解析不出来返回 0（调用方据此告警 —— **不许静默**）。
 */
export function resolveAbilityRef(raw: unknown, cfgs: any[]): number {
    if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
    const s = String(raw ?? '').trim();
    if (!s) return 0;
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    for (const c of cfgs ?? []) {
        if (c?.code === s || c?.name_en === s || c?.name === s) return Number(c?.id) || 0;
    }
    return 0;
}

/** 类型再导出（`MonsterAI` 的 ctx 用法需要它，体检脚本也用它构造假 ctx） */
export type { BattleContext };

function clamp01(v: number): number {
    if (!Number.isFinite(v)) return 1;
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
