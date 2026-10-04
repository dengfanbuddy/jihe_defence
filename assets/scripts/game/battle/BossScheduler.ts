import { ref, type Ref } from '../../platform/reactivity';

/**
 * BossScheduler —— **局内三类 Boss 的「充能 → 点击放出 → 限时」完整规则封装**（纯 TS，无 cc 依赖）
 *
 * ── 与「CD 到点自动刷」的区别（这是本设计的核心）──
 *   Boss **不是自动事件，是玩家手上的资源**：
 *     · CD 走完 → **库存 +1**（不是刷到场上），库存上限 `maxStock`
 *     · **点击** Boss 条目 → 库存 −1 → **真正放到场上**
 *     · 放出去后开始**限时**；到点没被击杀 → 离场（不给奖励）
 *   玩家因此可以攒着两只一起放（自造高潮）、也可以一直攒着不放到更需要的时候 ——
 *   这是「压力曲线」交给玩家的那半个旋钮（另半个是防守守卫的加码，见 §5.5）。
 *
 * ── 三个槽位的规则差异（`BOSS_SLOTS`）──
 *
 *   | 槽位 | CD | 库存初始 | 超时离场后 | 击杀后 |
 *   |---|---|---|---|---|
 *   | `gold` 金币怪 | 120s | 0（靠充能） | 库存**不恢复**（钱跑了就是跑了） | 库存不变 |
 *   | `kill` 击杀怪 | 150s | 0（靠充能） | 库存**不恢复** | 库存不变 |
 *   | `guard` 敌方守卫 | **无 CD** | **2（开局满）** | 库存**恢复 +1**（"限时未击杀，数量仍会恢复"） | 库存**不恢复**（这两只杀掉就没了） |
 *
 *   → 守卫的两条规则合起来是一条不变式：**`库存 = maxStock − 已击杀数 − 场上数`**
 *     所以「2 个击杀后数量保持 0」是自动成立的，不需要额外状态。
 *
 * ── 状态（`ref`，宿主 `provide` 只读门面给 HUD）──
 *   `slots`  三个槽位的展示快照（**整秒**粒度：CD/限时都取整，避免每帧触发 UI 重画）
 *            每条见 `BossSlotVM`：`stock`（库存，HUD 的 `count`）/ `timeLeft` + `showingLimit`
 *            （HUD 的 `time/value` —— 同一格两用：场上有 Boss 就显示**最快到期的那只的剩余限时**，
 *             否则显示 **CD 剩余**）/ `canDeploy`（点击判据）
 *
 * ⚠ **动作不在只读面上**：HUD 点击只 `scope.emit(BossDeploy, key)` 向上，由宿主转交 `deploy()`。
 * ⚠ 本类**不做任何战斗结算**：放怪/回收/加码全部走 `deps` 回调（宿主负责 acquire / 摆位 / 回收）。
 */

/** 三个槽位的键（与预制件 `bosses` 下的三个子节点一一对应） */
export type BossSlotKey = 'gold' | 'kill' | 'guard';

/** 一个槽位的静态规则 */
export interface BossSlotDef {
    key: BossSlotKey;
    /** 显示名（HUD 的 `name` 节点直接写它；也可不写，用预制件里摆好的文案） */
    label: string;
    /** 单位 id（`units.json` 的怪物段） */
    unitId: number;
    /** 充能 CD（秒）；**0 = 无 CD**（守卫：开局直接满库存，不参与充能） */
    cd: number;
    /** 库存上限（**同时也是场上上限**：场上到达该数就不给再放，防"攒一堆一次全放"刷经济） */
    maxStock: number;
    /** 限时（秒）：放出去后多久没被击杀就离场 */
    timeLimit: number;
    /** 超时离场后是否把库存还回来（只有守卫 `true`） */
    recoverOnTimeout: boolean;
}

/**
 * 三个槽位的默认规则。
 *
 * 数值依据见 `docs/局内刷怪节奏设计.md` §12.4（报时密度）与 §5.3/§5.4（Boss 定位）：
 *   · 金币怪 120s / 限时 60s —— 一局 1110s 最多充能 9 次，是"钱袋子"，限时短才有抢钱的张力
 *   · 击杀怪 150s / 限时 90s —— 威胁型；90s 没清掉就白放一只（软失败计时器）
 *   · 守卫   无 CD / 开局 2 只 / 限时 90s —— 长肉盾，玩家自调的难度阀；杀掉一只就加码
 */
export const BOSS_SLOTS: BossSlotDef[] = [
    { key: 'gold',  label: '金币怪',   unitId: 2007, cd: 120, maxStock: 2, timeLimit: 60, recoverOnTimeout: false },
    { key: 'kill',  label: '击杀怪',   unitId: 2009, cd: 150, maxStock: 2, timeLimit: 90, recoverOnTimeout: false },
    { key: 'guard', label: '敌方守卫', unitId: 2010, cd: 0,   maxStock: 2, timeLimit: 90, recoverOnTimeout: true  },
];

/** 一个槽位给 HUD 的展示快照（只读） */
export interface BossSlotVM {
    key: BossSlotKey;
    /** 库存（HUD 的 `count` 显示成 `x{stock}`） */
    stock: number;
    maxStock: number;
    /** 场上数量 */
    alive: number;
    /** 倒计时秒数（已取整）；`showTime = false` 时无意义 */
    timeLeft: number;
    /** 当前显示的是「限时」还是「CD」（HUD 据此换颜色：限时 = 警示色） */
    showingLimit: boolean;
    /** 这一格这一帧有没有倒计时要显示（守卫无 CD 且没放出去 → 没有） */
    showTime: boolean;
    /** 现在能不能点（库存 > 0 且 场上未满） */
    canDeploy: boolean;
}

/**
 * BossScheduler 向局内 UI 暴露的**只读面**（宿主 `provide` 的是实例本身，用这个接口约束 HUD 能碰什么）。
 *
 * ⚠ **动作不在只读面上**（`deploy` / `reset` / `tick` / `onEntityDead` 都不声明）：
 *   HUD 只 `scope.emit(StageScopeEvents.BossDeploy, key)` 向上，由宿主转交。
 */
export interface BossSchedulerVM {
    /** 三个槽位的展示快照（整秒粒度，只在真的变了时才换新数组） */
    readonly slots: Ref<BossSlotVM[]>;
    /** 已击杀的敌方守卫数（0~2）；宿主用它做刷怪加码（"每击杀一个守卫，怪物刷新加快、数量增多"） */
    getGuardKills(): number;
}

export interface BossSchedulerDeps {
    /**
     * 把一个 Boss 放到场上。宿主负责 `monsterPool.acquire` + 摆到刷新圈 + 记引用。
     * @returns 实体 uid（**<0 = 失败**，本类会回滚库存）
     */
    spawn(def: BossSlotDef): number;
    /**
     * 让场上的某个 Boss **离场**（限时到期）。宿主负责回收实体。
     * ⚠ 必须**不给任何奖励** —— 走的是"撤离"而不是"死亡"（`ctx.RemoveEntity` + 回收，
     *   不要复用 `Entity.hp = 0` 那条死亡链，否则会白送金币/经验）。
     */
    despawn(uid: number, def: BossSlotDef): void;
    /** 一只敌方守卫被**击杀**（宿主在这里做加码：同时数量 +1、批间隔缩短） */
    onGuardKilled?(killed: number): void;
}

/** 场上的一只 Boss 实例 */
interface LiveBoss {
    key: BossSlotKey;
    uid: number;
    /** 剩余限时（秒） */
    remaining: number;
}

export class BossScheduler {

    /** 三个槽位的展示快照（HUD watch 它） */
    readonly slots: Ref<BossSlotVM[]> = ref<BossSlotVM[]>([]);

    private defs: BossSlotDef[];
    private deps: BossSchedulerDeps;

    /** 每个槽位的充能剩余（秒） */
    private cdLeft: Record<string, number> = {};
    /** 每个槽位的库存（点一下 −1） */
    private stock: Record<string, number> = {};
    /** 场上的 Boss（每只各持一个限时计时器） */
    private live: LiveBoss[] = [];
    /** 已击杀的守卫数（0~2） */
    private guardKills = 0;

    /** 上一次 publish 的指纹（整秒 + 库存 + 场上 + 可点性；一样就不换数组，避免每帧触发 UI 重画） */
    private lastKey = '';

    constructor(deps: BossSchedulerDeps, defs: BossSlotDef[] = BOSS_SLOTS) {
        this.deps = deps;
        this.defs = defs;
        this.reset();
    }

    /* ===================================================================
     * 生命周期
     * =================================================================== */

    /** 换局复位：库存清空（守卫直接满）、CD 归位、场上引用作废、守卫击杀数归零 */
    reset(): void {
        this.live = [];
        this.guardKills = 0;
        for (const d of this.defs) {
            this.stock[d.key] = d.cd > 0 ? 0 : d.maxStock;
            this.cdLeft[d.key] = d.cd;
        }
        this.publish(true);
    }

    /** 每帧推进（宿主在 `tick` 里调；暂停时不调，所以不需要自己判暂停） */
    tick(dt: number): void {
        // 1. 充能：库存满了就**不走表**（标准充能制，避免"充满还在空转"浪费）
        for (const d of this.defs) {
            if (d.cd <= 0) continue;
            if (this.stock[d.key] >= d.maxStock) continue;
            this.cdLeft[d.key] -= dt;
            if (this.cdLeft[d.key] <= 0) {
                this.stock[d.key] = Math.min(d.maxStock, this.stock[d.key] + 1);
                this.cdLeft[d.key] = d.cd;
                console.log(`[Boss] ${d.label} 充能完成 → 库存 ${this.stock[d.key]}/${d.maxStock}（点击放出）`);
            }
        }

        // 2. 场上限时：倒着遍历（要在循环里 splice）
        for (let i = this.live.length - 1; i >= 0; i--) {
            const b = this.live[i];
            b.remaining -= dt;
            if (b.remaining > 0) continue;
            const d = this.defOf(b.key);
            this.live.splice(i, 1);
            if (!d) continue;
            // 超时**离场**：不给奖励（金币怪带着钱跑掉 / 击杀怪溜走 / 守卫撤回去）
            this.deps.despawn(b.uid, d);
            if (d.recoverOnTimeout) {
                this.stock[d.key] = Math.min(d.maxStock, this.stock[d.key] + 1);
            }
            console.log(`[Boss] ${d.label} 限时 ${d.timeLimit}s 到期未被击杀 → 离场`
                + `${d.recoverOnTimeout ? `，库存恢复为 ${this.stock[d.key]}` : '（不给奖励）'}`);
        }

        this.publish();
    }

    /* ===================================================================
     * 点击放出
     * =================================================================== */

    /**
     * 点击某个 Boss 条目 → 库存 −1、把它放到场上。
     *
     * 准入（**HUD 画的 `canDeploy` 就是这一份判据**，不另抄一遍）：
     *   ① 该槽位库存 > 0（CD 还没充能完 / 已经用掉了 → 点不动）
     *   ② 场上该类型的数量 < `maxStock`（防止攒两只 + 充能两只 = 一次四只刷经济）
     *
     * @returns 是否真的放出去了
     */
    deploy(key: BossSlotKey): boolean {
        const d = this.defOf(key);
        if (!d) {
            console.warn(`[Boss] 未知槽位 ${key}`);
            return false;
        }
        if (this.stock[key] <= 0) {
            console.warn(`[Boss] ${d.label} 库存为 0（CD 剩余 ${Math.ceil(this.cdLeft[key] ?? 0)}s），点不动`);
            return false;
        }
        const alive = this.aliveOf(key);
        if (alive >= d.maxStock) {
            console.warn(`[Boss] ${d.label} 场上已有 ${alive} 只（上限 ${d.maxStock}），点不动`);
            return false;
        }

        const uid = this.deps.spawn(d);
        if (uid < 0) {
            console.warn(`[Boss] ${d.label} 放出失败（宿主 spawn 返回 ${uid}），库存不变`);
            return false;
        }

        this.stock[key] -= 1;
        this.live.push({ key, uid, remaining: d.timeLimit });
        console.log(`[Boss] 放出 ${d.label}（uid ${uid}），库存 ${this.stock[key]}/${d.maxStock}，限时 ${d.timeLimit}s`);
        this.publish(true);
        return true;
    }

    /* ===================================================================
     * 宿主回报
     * =================================================================== */

    /**
     * 场上的一只 Boss **被击杀**（宿主在 `OnDeath` 里调）。
     *
     * · 击杀守卫 → `guardKills++` 并回调宿主做加码；库存**不恢复**
     * · 击杀金币怪/击杀怪 → 只把它从场上列表移掉（库存本来就不恢复）
     *
     * 非本调度器放出的实体（uid 不在表里）静默忽略 —— 野生 Boss 不归它管。
     */
    onEntityDead(uid: number): void {
        const i = this.live.findIndex((b) => b.uid === uid);
        if (i < 0) return;
        const b = this.live[i];
        this.live.splice(i, 1);
        const d = this.defOf(b.key);
        if (d && d.key === 'guard') {
            this.guardKills++;
            console.log(`[Boss] 敌方守卫被击杀 ${this.guardKills}/${d.maxStock} → 库存保持 ${this.stock[d.key]}（不再恢复）`);
            this.deps.onGuardKilled?.(this.guardKills);
        }
        this.publish(true);
    }

    /* ===================================================================
     * 查询
     * =================================================================== */

    /** 已击杀的守卫数（0~2）；宿主用它做刷怪加码 */
    getGuardKills(): number { return this.guardKills; }

    /** 某个槽位现在能不能点（与 HUD 的 `canDeploy` 同一份判据） */
    canDeploy(key: BossSlotKey): boolean {
        const d = this.defOf(key);
        if (!d) return false;
        return this.stock[key] > 0 && this.aliveOf(key) < d.maxStock;
    }

    /** 场上某类型的数量 */
    aliveOf(key: BossSlotKey): number {
        let n = 0;
        for (const b of this.live) if (b.key === key) n++;
        return n;
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    private defOf(key: BossSlotKey): BossSlotDef | undefined {
        return this.defs.find((d) => d.key === key);
    }

    /**
     * 把当前状态投影成 HUD 快照。
     *
     * ⚠ **只在投影真的变了的时候才换新数组**：倒计时是浮点推进的，每帧都 `slots.value = [...]`
     *   会让 HUD 的 watcher 每帧醒一次（`Object.is` 比较恒 false）—— 这里是**整秒粒度**的指纹。
     */
    private publish(force = false): void {
        const rows: BossSlotVM[] = [];
        for (const d of this.defs) {
            const ls: LiveBoss[] = [];
            for (const b of this.live) if (b.key === d.key) ls.push(b);

            let timeLeft = 0;
            let showingLimit = false;
            let showTime = false;
            if (ls.length > 0) {
                // 场上有 → 显示**最快到期的那只**的剩余限时（最该被处理的那条信息）
                timeLeft = Infinity;
                for (const b of ls) if (b.remaining < timeLeft) timeLeft = b.remaining;
                showingLimit = true;
                showTime = true;
            } else if (d.cd > 0) {
                timeLeft = this.cdLeft[d.key] ?? 0;
                showTime = true;
            }

            rows.push({
                key: d.key,
                stock: this.stock[d.key] ?? 0,
                maxStock: d.maxStock,
                alive: ls.length,
                timeLeft: Math.max(0, Math.ceil(timeLeft)),
                showingLimit,
                showTime,
                canDeploy: (this.stock[d.key] ?? 0) > 0 && ls.length < d.maxStock,
            });
        }

        const key = rows.map((r) => `${r.key}:${r.stock}:${r.alive}:${r.showTime ? r.timeLeft : '-'}:${r.showingLimit ? 1 : 0}`).join('|');
        if (!force && key === this.lastKey) return;
        this.lastKey = key;
        this.slots.value = rows;
    }
}
