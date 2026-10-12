/**
 * LevelDataModule - 难度（关卡）进度数据模块
 *
 * 存**局外**的三件事（局内那一局怎么缩放由 `common/DifficultyConfig` 算，不在这里）：
 *   · **当前选中的模式** —— 主界面「游戏」页那张模式卡点一下就落盘（`common/GameModeConfig` 是真源）
 *   · **已通关的最高档** —— 解锁推进的唯一依据：「通关第 N 档 → 解锁第 N+1 档」；
 *     **全局一份**（两个模式共用这条阶梯，见下）
 *   · **每个模式各自的**当前选择 / 上次玩过的档 / 单局最高阶段 —— 难度弹窗的默认选中项、
 *     主界面的「上次玩过」、以及**无尽模式唯一的成绩**（它没有通关，只有"打到第几阶段"）
 *
 * ── 解锁规则（2026-11 起是**两条取高**，别再照旧记忆恢复）──
 *   ① 通关第 N 档 → 解锁第 N+1 档（老口径，「成绩」那条路）；
 *   ② **按局外成长放开** → 推荐档位（`getRecommendLevel()`，见 `common/DifficultyRecommend`）。
 *   可玩档位 = 1 ~ `max(已通关 + 1, 推荐档位)`。
 *
 *   为什么加了 ②：难度阶梯本身是对的（最高成长在档 100 打 40 秒、中位在档 80 打 41 秒、
 *   最低成长在档 1 打 65 秒，三个锚点都成立），但只有 ① 的话玩家**永远追不上自己的档位** ——
 *   集齐局外遗物的玩家该打档 80，却按"一局只解锁一档"被锁在档 3，
 *   他能看到的全是"给新号准备的那一段"，于是体感就是"**一路秒杀，包括 Boss**"。
 *
 * ── 两个模式怎么分（本期口径，见 `docs/game-mode/README.md`）──
 *   · **共用**：`cleared`（已通关的最高档）→ 解锁阶梯。设计稿的口径是「无尽模式 = 在已解锁难度上无限阶段」，
 *     所以它**不单独解锁**，也**不单独记通关**（它没有终点，不会 `markCleared`）。
 *   · **各记一份**：`selected` / `lastPlayed` / `bestStage`。切回某个模式时，难度弹窗默认停在
 *     "这个模式上次准备打的档"，而不是被另一个模式覆盖掉。
 *   · 于是主界面顶部那两个读数：**「最高通过」是全局的**（两个模式显示同一个数），
 *     **「上次玩过」跟着模式走**。要让「最高通过」也分模式，改 `getClearedLevel()` 一处即可。
 *
 * ⚠ 与 `PlayerInfo.maxWave` 的区别：`maxWave` 记的是**局内阶段**（1~5），
 *   本模块记的是**难度档位**（1~100），两者是正交的两个轴，别混用。
 *
 * ⚠ **`modes` 必须是数组，不能是字典**：`DataModule` 读档走 `mergeDeep`，
 *   动态字典（`{stage: {...}}`）在"默认值里没有这个 key"时会被整片吃掉
 *   （`BagData.items` / `EquipmentCollection.collected` 都踩过），数组则是整体覆盖。
 *
 * @example
 * ```ts
 * // 主界面：选了模式 / 读进度画顶部信息
 * const lv = DataCenter.ins.levelData;
 * lv.selectMode('no_ending');       // 模式卡点一下（唯一入口）
 * lv.getMode();                     // → 'no_ending'
 * lv.getLastPlayedLevel();          // → 该模式上次打过的档（0 = 还没打过）
 * lv.getClearedLevel();             // → 全局：已通关的最高档
 *
 * // 难度弹窗：读进度画三态 + 落盘选择（都按**当前模式**各记一份）
 * lv.isUnlocked(7);                 // 7 档能不能点（全局阶梯）
 * lv.selectLevel(7);                // 确认选择（未解锁会被拒，返回 false）
 *
 * // 局内通关：解锁下一档
 * DataCenter.ins.levelData.markCleared(7);
 * ```
 */

import { DataModule } from '../DataModule';
import { StorageUtil } from '../StorageUtil';
import { DIFFICULTY_MAX, clampLevel } from '../../common/DifficultyConfig';
import { DEFAULT_GAME_MODE, GAME_MODES, normalizeGameMode, type GameModeId } from '../../common/GameModeConfig';

/** 本模块的存档键（`DataModule` 会加 `jihe_defence_` 前缀；构造里要读**原始存档**，所以抽成常量） */
const LEVEL_PROGRESS_KEY = 'level_progress';

/** 单个模式的进度（`selected` / `lastPlayed` / `bestStage` 按模式各记一份） */
export interface IModeProgress {
    /** 模式 id（`GameModeConfig.GameMode`；取值只可能是 `GAME_MODES` 里的 id） */
    mode: string;
    /** 这个模式**当前选中**的档（1 ~ `DIFFICULTY_MAX`）—— 打开难度弹窗时的默认落点 */
    selected: number;
    /** 这个模式**上次实际打过**的档（0 = 还没打过；主界面「上次玩过」显示它） */
    lastPlayed: number;
    /**
     * 这个模式**单局到达过的最高阶段**（0 = 还没打过）—— 设计稿 §14.3 的「记录：最高到达阶段数」。
     *
     * ⚠ 为什么**不**并进 `PlayerInfo.maxWave`：那个是**全局**的一个数（跨模式共用），
     *   而"最高阶段"在两个模式下量纲完全不同（阶段模式最多到 5，无尽模式可以到几十上百）。
     *   混在一个字段里，无尽模式的一局会把阶段模式的读数顶成没有意义的大数。
     *
     * ⚠ 无尽模式是它唯一的"成绩"出口（那个模式没有通关，只有"打到第几阶段"）；
     *   阶段模式也顺手记（同一行代码，不按模式分岔），但界面不用它（阶段模式看 `cleared`）。
     */
    bestStage: number;
}

/** 难度进度数据结构 */
export interface ILevelData {
    /** 已通关的最高难度档（0 = 一档都没通关过）—— **全局一份**，两个模式共用（见文件头） */
    cleared: number;
    /**
     * ⚠ **旧档兼容字段**（= 只有一个模式时"当前选中的难度档"）。
     * 读档时会被迁进 `modes` 里默认模式那一条，之后**没有任何读写方** ——
     * 别写它、也别读它，一律走 `getSelectedLevel()` / `selectLevel()`。
     */
    selected: number;
    /** ⚠ **旧档兼容字段**，同 `selected`（= 只有一个模式时的「上次玩过」）。 */
    lastPlayed: number;
    /** 当前选中的模式 id（`GameModeConfig.GameMode`；脏值在读取时收敛，不写盘） */
    mode: string;
    /** 每个模式各自的进度（**数组**，不是字典 —— 理由见文件头） */
    modes: IModeProgress[];
}

/** `lastPlayed` 的合法区间是 0~100（0 = 没打过），不能用 `clampLevel`（它会把 0 抬成 1） */
function clampLastPlayed(value: unknown): number {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return 0;
    return n > DIFFICULTY_MAX ? DIFFICULTY_MAX : n;
}

/**
 * `bestStage` 的合法区间是 0~`BEST_STAGE_MAX`（0 = 还没打过）。
 * **上界故意远大于阶段模式的 5** —— 无尽模式的阶段数没有上限，用难度档位那把尺（100）会把它夹爆。
 */
const BEST_STAGE_MAX = 9999;
function clampBestStage(value: unknown): number {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return 0;
    return n > BEST_STAGE_MAX ? BEST_STAGE_MAX : n;
}

export class LevelDataModule extends DataModule<ILevelData> {
    /**
     * 「按局外成长该从第几档开始」的**提供者**（由 `DataCenter.init()` 注入）。
     *
     * 为什么不在这里 `import` 那条计算链：`data/funcs/*` 是全工程被体检 stage 得最多的一片
     * （`common/DifficultyRecommend` → `common/DifficultyConfig` 每多一层，
     * `audit:bag` / `audit:mall` / `audit:draw` / `audit:mode` 的 `SOURCES` 白名单都要跟着补，
     * 漏一个就是**整个体检跑不起来**、而报错长得像"体检脚本自己坏了"）。
     * `DataCenter` 注入既避开这件事，也与 `TaskData.setHost` / `AchievementData.setHost` 同一套路。
     *
     * **未注入 = 恒 1 = 退回"只按通关进度解锁"**（体检脚本不注入，所以它们验的还是老口径）。
     */
    private recommendProvider: (() => number) | null = null;

    /**
     * 注入「推荐档位」提供者（`DataCenter.init()` 调一次；传 null 关掉这条通路）。
     * 提供者可以随时返回不同值（它会跟着局外收集变化），所以**只存函数、不缓存结果**。
     */
    setRecommendProvider(fn: (() => number) | null): void {
        this.recommendProvider = fn;
    }

    constructor() {
        super(LEVEL_PROGRESS_KEY);
        // 老存档迁移的判据必须看**原始存档**：`DataModule` 的构造已经把默认值合并进来了，
        // 所以 `this.data.modes` 永远是"每个模式都有一条"的全量数组 ——
        // 只看 `this.data` 的话，"没有 `modes` 的旧档"和"新档"长得一模一样，迁移会永远不触发
        // （2026-11 之前就是如此：代码写着迁移、实际从来没跑过，旧档的选中难度会被悄悄归 1）。
        const raw = StorageUtil.getItem<Partial<ILevelData>>(LEVEL_PROGRESS_KEY) as Record<string, unknown> | null;
        this.ensureRecords(!raw || !Array.isArray(raw.modes));
    }

    protected defaultData(): ILevelData {
        return {
            cleared: 0,
            selected: 1,
            lastPlayed: 0,
            mode: DEFAULT_GAME_MODE,
            modes: GAME_MODES.map((m) => ({ mode: m.id, selected: 1, lastPlayed: 0, bestStage: 0 })),
        };
    }

    /* ===================================================================
     * 模式（主界面模式卡的唯一落盘口）
     * =================================================================== */

    /** 当前选中的模式（脏值收敛到默认，**不写盘**） */
    getMode(): GameModeId {
        return normalizeGameMode(this.data.mode);
    }

    /**
     * 选一个模式（主界面模式卡点一下调它）。
     * @returns 是否写入了（非法 id / 与当前相同 → false，数据不动）
     */
    selectMode(mode: string): boolean {
        const id = normalizeGameMode(mode);
        if (id !== mode) return false;          // 只认受支持的 id（`card-002` 那种一律拒绝）
        if (this.data.mode === id) return false;
        this.data.mode = id;
        return true;
    }

    /**
     * 主界面刷新用的**指纹**（模式 + 全局进度 + 每个模式的 selected/lastPlayed）。
     *
     * 给 `scope.watch` 当只读数据源：**它不建记录、不写盘**（在 watcher 的取值函数里改数据
     * 会让追踪重入），值一变就说明主界面该重画了。
     */
    progressKey(): string {
        const parts: string[] = [this.getMode(), `${this.getClearedLevel()}`];
        for (const info of GAME_MODES) {
            const rec = this.findRecord(info.id);
            parts.push(`${info.id}:${rec ? clampLevel(rec.selected) : 0}/${rec ? clampLastPlayed(rec.lastPlayed) : 0}`
                + `/${rec ? clampBestStage(rec.bestStage) : 0}`);
        }
        return parts.join('|');
    }

    /* ===================================================================
     * 读（判据只有这几条，界面**不要自己重算**）
     * =================================================================== */

    /** 档位总数（= DifficultyConfig 的 100） */
    getMaxLevel(): number {
        return DIFFICULTY_MAX;
    }

    /** 已通关的最高档（0 = 无；脏存档会被收敛到 0~100）—— **全局一份**，与模式无关 */
    getClearedLevel(): number {
        const n = Math.floor(this.data.cleared);
        if (!Number.isFinite(n) || n < 0) return 0;
        return n > DIFFICULTY_MAX ? DIFFICULTY_MAX : n;
    }

    /** 已通关的档数（= 最高档；档位是连续推进的，不存在跳档） */
    getClearedCount(): number {
        return this.getClearedLevel();
    }

    /**
     * **按局外成长推荐到第几档**（1 ~ 100）—— 「你该打哪一档」的判据，由注入的提供者给。
     *
     * 为什么要它：难度阶梯本身是对的（每个成长档都有自己的"正正好"档位），但
     * "通关第 N 档才解锁第 N+1 档"这条串行门槛让玩家**永远追不上自己的档位** ——
     * 集齐局外遗物的玩家该打档 80，却被锁在档 3，于是他看到的是"一路秒杀，包括 Boss"。
     * 实测口径见 `common/DifficultyRecommend` 的文件头（含标定脚本）。
     *
     * **未注入提供者时恒为 1**（= 老口径：只有档 1），所以体检与老存档行为不变。
     */
    getRecommendLevel(): number {
        if (!this.recommendProvider) return 1;
        const n = Math.floor(Number(this.recommendProvider()));
        if (!Number.isFinite(n)) return 1;
        return clampLevel(n);
    }

    /**
     * **已解锁到第几档** —— 可玩档位 = 1 ~ 本值。
     *
     * 两条路**取高**（2026-11 起）：
     *   ① `已通关 + 1` —— 通关推进（老口径，一档没过时只有档 1 可玩）；
     *   ② `getRecommendLevel()` —— **按局外成长放开**。
     *
     * 为什么是"取高"而不是"取代"：`cleared` 是玩家的**成绩**（主界面「最高通过」读它、
     * 结算面板据它提示"解锁了下一档"），拿掉它等于把推进感一起删了；
     * 而只留它就会出现"档位追不上战力"。两者取高既保住成绩，又让玩家够得到自己的档位。
     * **两个模式共用**（无尽模式不单独解锁，见文件头）。
     */
    getUnlockedLevel(): number {
        return Math.min(DIFFICULTY_MAX, Math.max(this.getClearedLevel() + 1, this.getRecommendLevel()));
    }

    /** 该档是否可玩（弹窗里"已解锁"的那一档底色） */
    isUnlocked(level: number): boolean {
        const n = clampLevel(level);
        return n <= this.getUnlockedLevel();
    }

    /** 该档是否已通关（弹窗里的"已通关勾"） */
    isCleared(level: number): boolean {
        const n = clampLevel(level);
        return n >= 1 && n <= this.getClearedLevel();
    }

    /**
     * 某个模式**当前选中的档**（开战时用；`mode` 省略 = 当前模式）。
     * **只读收敛**：脏存档（选择 > 已解锁，例如换了台设备/改过档）一律夹回可玩区间，不写盘。
     */
    getSelectedLevel(mode?: string): number {
        const n = clampLevel(this.recordOf(mode).selected);
        return Math.min(n, this.getUnlockedLevel());
    }

    /**
     * 某个模式**上次玩过的档**（`mode` 省略 = 当前模式）。
     * **0 = 还没打过** —— 这里允许 0，不能用 `clampLevel`。
     */
    getLastPlayedLevel(mode?: string): number {
        return clampLastPlayed(this.recordOf(mode).lastPlayed);
    }

    /**
     * 某个模式**单局到达过的最高阶段**（`mode` 省略 = 当前模式；**0 = 还没打过**）。
     *
     * 这是**无尽模式唯一的成绩出口**（那个模式没有"通关"，只有"打到第几阶段"）。
     * 主界面「游戏」页/结算面板要显示它就读这里，**不要**去读 `PlayerInfo.maxWave`（那是全局的，见 `IModeProgress`）。
     */
    getBestStage(mode?: string): number {
        return clampBestStage(this.recordOf(mode).bestStage);
    }

    /* ===================================================================
     * 写（唯一入口，界面只调这几个）
     * =================================================================== */

    /**
     * 确认选择某档（难度弹窗「确定」；`mode` 省略 = 当前模式 —— 弹窗开的就是当前模式那套）。
     * @returns 是否写入成功（未解锁 / 越界 → false，数据不动）
     */
    selectLevel(level: number, mode?: string): boolean {
        const n = clampLevel(level);
        if (!this.isUnlocked(n)) return false;
        const rec = this.recordOf(mode);
        if (rec.selected !== n) rec.selected = n;
        return true;
    }

    /** 记「这一档打过」（进入战斗时调；主界面「上次玩过」读它） */
    markPlayed(level: number, mode?: string): void {
        const n = clampLevel(level);
        const rec = this.recordOf(mode);
        if (rec.lastPlayed !== n) rec.lastPlayed = n;
    }

    /**
     * 记「本局到达过第几阶段」（`Scene_Game_Stage.endRun` 调；**只增不减**）。
     *
     * 两个模式下都会记（同一行代码，不按模式分岔 —— 分岔会多出一处"按模式判断"），
     * 但**意义只在无尽模式**：阶段模式的阶段数天然封顶在 5，那个模式的成绩看 `cleared`。
     *
     * @returns 是否刷新了纪录（true = 本局比之前打得远，界面可以据此提示）
     */
    markBestStage(stage: number, mode?: string): boolean {
        const n = clampBestStage(stage);
        if (n <= 0) return false;
        const rec = this.recordOf(mode);
        if (n <= clampBestStage(rec.bestStage)) return false;
        rec.bestStage = n;
        return true;
    }

    /**
     * 记「这一档通关了」（`Scene_Game_Stage.endRun('victory')` 调）—— **解锁推进的唯一入口**。
     * @returns 是否**新推进了进度**（true = 本次通关解锁了更高档位，主界面/弹窗可以据此提示）
     */
    markCleared(level: number): boolean {
        const n = clampLevel(level);
        const advanced = n > this.getClearedLevel();
        if (advanced) this.data.cleared = n;
        // 「上次玩过」按**本局所在的模式**记（无尽模式通关同样算它这一档打过）
        this.markPlayed(n);
        return advanced;
    }

    /* ===================================================================
     * 内部：模式记录的取用与迁移
     * =================================================================== */

    /** 找一个模式已有的记录（**纯读**，没有就回 null） */
    private findRecord(mode: string): IModeProgress {
        const id = normalizeGameMode(mode);
        const list = this.data.modes;
        if (!Array.isArray(list)) return null;
        for (const rec of list) {
            if (rec && rec.mode === id) return rec;
        }
        return null;
    }

    /**
     * 取某个模式的记录，缺了就补一条（`selected` = 1 / `lastPlayed` = 0）。
     *
     * 自愈式，所以**不需要**在别处再写一遍"补记录"的逻辑：`load()` / `reset()` 之后
     * 任何一次读写都会把缺的那条补回来（`reset()` 会直接铺满，见 `defaultData`）。
     */
    private recordOf(mode?: string): IModeProgress {
        const id = normalizeGameMode(mode);
        const found = this.findRecord(id);
        if (found) return found;
        const created: IModeProgress = { mode: id, selected: 1, lastPlayed: 0, bestStage: 0 };
        if (!Array.isArray(this.data.modes)) this.data.modes = [];
        this.data.modes.push(created);
        return created;
    }

    /**
     * 读档后把 `GAME_MODES` 里每个模式都补齐一条记录（幂等），并在**旧档**上做一次迁移。
     *
     * ⚠ **老存档迁移**：只有 `selected` / `lastPlayed` 两个标量、没有 `modes` 数组的存档，
     *   把那两个值归到**默认模式（阶段模式）**名下 —— 那时工程里只有它一个模式，
     *   所以这是无损迁移，不丢玩家进度。
     *
     * @param legacy 这份存档是不是"模式之前的旧档"（判据在构造里，看的是**原始存档**有没有 `modes`）
     */
    private ensureRecords(legacy: boolean): void {
        for (const info of GAME_MODES) {
            if (!this.findRecord(info.id)) this.recordOf(info.id);
        }
        if (!legacy) return;
        const rec = this.recordOf(DEFAULT_GAME_MODE);
        rec.selected = clampLevel(this.data.selected);
        rec.lastPlayed = clampLastPlayed(this.data.lastPlayed);
    }
}
