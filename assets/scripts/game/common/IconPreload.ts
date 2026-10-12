import { TbRoot } from '../../platform/excel_table/TbRoot';
import type { TbContainer } from '../../platform/excel_table/TbContainer';
// ⚠ 容器一律**值导入**：`@tb_config` 装饰器靠模块求值完成 TbRoot 注册（同 `data/configs/HeroConfig.ts`）。
//    顺带保证这 7 张表在 Loading 阶段就已注册 —— 本文件读的就是它们。
import { UnitCfgContainer } from '../excel_table/Tb_UnitConfig';
import { RelicCfgContainer } from '../excel_table/Tb_RelicConfig';
import { AbilityCfgContainer } from '../excel_table/Tb_AbilityConfig';
import { ModifierCfgContainer } from '../excel_table/Tb_ModifierConfig';
import { BattleItemCfgContainer } from '../excel_table/Tb_BattleItemConfig';
import { KillBuffCfgContainer } from '../excel_table/Tb_KillBuffConfig';
import { BagItemCfgContainer } from '../excel_table/Tb_BagItemConfig';
import { AtlasIcon } from './AtlasIcon';

/**
 * 启动期**图标预载** —— 在 Loading 场景把全工程的图标一次性喂进 `AtlasIcon` 的缓存。
 *
 * ── 为什么要有它 ──
 * 所有图标消费方（英雄卡 / 英雄详情 / 遗物图鉴 / 局内商店 / 技能槽 / 状态栏 / 掉落背包 / 神器 …
 * 见 `docs/agent-notes/UI与表现层.md`）的写法都是同一套：
 * **先画预制件里的占位图 → `AtlasIcon.loadIconFrame()` 解析好了再换上去**。
 * 冷启动时第一次打开某个界面，那张图还在磁盘上（图集要整包拉、碎图要单独拉），
 * 于是玩家会先看见一帧甚至几百毫秒的占位图 —— 这就是「进了游戏先显示占位图」的来源。
 *
 * 这里在进度条还在走的时候把它们全部解析完。之后各界面拿到的都是**已 resolve 的 promise**，
 * 回调落在微任务里、同一帧渲染前就写进 `Sprite`，占位图根本来不及被画出来。
 *
 * ── 预载什么 ──
 * ① **配表里带图标的 7 张表**（`ICON_SOURCES`）：英雄头像 / 遗物 / 技能 / 掉落 Buff /
 *    状态 Buff / 神器 / 背包道具。读的是**配表本身**，所以表加了行、换了图都不用改这里。
 * ② **代码里写死的碎图路径**（`EXTRA_ICON_PATHS`）：属性行图标、刷新按钮四态、技能槽的锁……
 *    这些不在任何配表里，只能手写；**以后新加这种常量图标要顺手补进去**。
 *
 * ── 三条口径 ──
 * · **一律走 `AtlasIcon.loadIconFrame`**：图集本体 → 帧子资源 → 旧碎图三级降级 + 按路径缓存
 *   只有那一份实现（`common/AtlasIcon.ts`），本文件**不碰 `resources`**，也不自己判图集路径。
 * · **失败绝不阻塞启动**：`loadIconFrame` 全失败 resolve(null)、永不 reject，本文件再叠一层超时兜底
 *   （`TIMEOUT_MS`）—— 宁可少几张图，也不能把玩家卡在 Loading 场景（同 `Loading.ts` 的放行口径）。
 * · **幂等**：一个进程只跑一次（promise 常驻），第二次调用直接复用；进度回调只在第一次生效。
 *
 * ── 用法 ──
 * ```ts
 * await IconPreload.preloadAll((finished, total) => { ... });   // 进度条口径同 TbRoot.loadTbs
 * ```
 */
export class IconPreload {

    /**
     * 预载总超时（毫秒）。
     * 超了就不再等（放行走人），**没跑完的那几张在后台继续加载**，缓存照样会热起来 ——
     * 这条是"启动路径上任何一张图坏掉都不能让玩家卡住"的兜底，不是性能旋钮。
     */
    private static readonly TIMEOUT_MS = 10000;

    /**
     * 单批并发数。图集本体只有 4 个（`textures/{relics,skills,artifacts,buffs}/<同名>`）
     * 且由 `AtlasIcon` 内部去重，真正并发的是碎图；12 是"够快"与"别把加载器刷爆"的折中。
     */
    private static readonly BATCH = 12;

    /** 日志前缀（本文件是共用实现，不挂宿主前缀） */
    private static readonly LOG_TAG = '[图标预载]';

    /** 失败清单最多打几条（全打会刷屏，268 张遗物集体失败时尤其） */
    private static readonly MAX_WARN_DETAIL = 8;

    /** 常驻的预载 promise：非空 = 跑过或正在跑（幂等的落点） */
    private static pending: Promise<void> = null;

    /**
     * 预载全部图标。**可以重复调用**（第二次直接复用同一个 promise）。
     *
     * @param onProgress 每张图解析结束（无论成败）回调一次：`(已完成数, 总数)`；
     *                   Loading 场景的进度条靠它拿到"图标阶段"的真实进度。不传则零开销。
     */
    static preloadAll(onProgress?: (finished: number, total: number) => void): Promise<void> {
        if (!IconPreload.pending) {
            const work = IconPreload.run(onProgress);
            IconPreload.pending = new Promise<void>((resolve) => {
                let settled = false;
                const done = () => {
                    if (settled) return;
                    settled = true;
                    resolve();
                };
                work.then(done, done);
                setTimeout(() => {
                    if (settled) return;
                    ezgame.warn(`${IconPreload.LOG_TAG} 超过 ${IconPreload.TIMEOUT_MS}ms 仍未跑完，先放行（剩下的图在后台继续加载）`);
                    done();
                }, IconPreload.TIMEOUT_MS);
            });
        }
        return IconPreload.pending;
    }

    /**
     * 收集这次会预载哪些图（**纯读表 + 去重，不加载任何资源**）。
     * 返回 `路径 → 来源标签[]`：同一张图被多张表/常量引用时会聚成一条（日志里能看出"谁在用它"）。
     * 单独公开是为了够得着"到底预载了什么"——排查"某界面还是先闪占位图"时先看这里有没有它。
     */
    static collect(): Map<string, string[]> {
        const map = new Map<string, string[]>();
        /** 只认 resources 内的、不带扩展名的相对路径；空串 / 远程 URL / 别的口径一律跳过 */
        const add = (raw: any, from: string) => {
            if (typeof raw !== 'string') return;
            const path = raw.trim();
            if (!path || path.indexOf('textures/') !== 0) return;
            const labels = map.get(path);
            if (!labels) {
                map.set(path, [from]);
                return;
            }
            if (labels.indexOf(from) < 0) labels.push(from);
        };

        for (const src of ICON_SOURCES) {
            try {
                const container = TbRoot.ins.getTbContainer(src.container);
                for (const cfg of container.getcfgs()) add(cfg[src.field], src.label);
            } catch (e) {
                // 表没注册 / 还没加载：**只警告一次然后继续**，不能让一张表拖垮整段预载
                ezgame.warn(`${IconPreload.LOG_TAG} 读表失败，跳过「${src.label}」：${e instanceof Error ? e.message : e}`);
            }
        }
        for (const path of EXTRA_ICON_PATHS) add(path, '代码常量');

        return map;
    }

    /* ===================================================================
     * 内部实现
     * =================================================================== */

    /** 真正的预载：按批并发解析，逐张回报进度，最后打一条汇总 */
    private static async run(onProgress?: (finished: number, total: number) => void): Promise<void> {
        const startTime = Date.now();
        const collected = IconPreload.collect();
        const paths = Array.from(collected.keys());
        const total = paths.length;

        if (!total) {
            // 走到这里基本只有一个原因：配表没加载完就被调用了
            ezgame.warn(`${IconPreload.LOG_TAG} 一张图都没收集到（配表未加载？）`);
            onProgress?.(1, 1);
            return;
        }
        onProgress?.(0, total);

        let finished = 0;
        const failed: string[] = [];
        const tick = (path: string, sf: any) => {
            if (!sf) failed.push(path);
            finished++;
            onProgress?.(finished, total);
        };

        for (let i = 0; i < total; i += IconPreload.BATCH) {
            const batch = paths.slice(i, i + IconPreload.BATCH);
            // `loadIconFrame` 正常路径不会 reject，`.catch` 是"引擎回调里出意外"的兜底：
            // 少了它，一张图的异常会让这一批 `Promise.all` 整体 reject ⇒ 后面的批次全不跑。
            await Promise.all(batch.map((path) =>
                AtlasIcon.loadIconFrame(path).then((sf) => tick(path, sf), () => tick(path, null))));
        }

        const cost = Date.now() - startTime;
        ezgame.info(`${IconPreload.LOG_TAG} 完成 ${total - failed.length}/${total} 张，耗时 ${cost}ms｜来源：${IconPreload.summarize(collected)}`);
        if (failed.length) {
            const head = failed.slice(0, IconPreload.MAX_WARN_DETAIL).join('、');
            const more = failed.length > IconPreload.MAX_WARN_DETAIL ? ` 等 ${failed.length} 张` : '';
            ezgame.warn(`${IconPreload.LOG_TAG} 取不到图（这些界面会退回占位图）：${head}${more}`);
        }
    }

    /** 汇总文本：`遗物 268 / 技能 30 / 代码常量 17`（按路径数统计，同一张图只算一次） */
    private static summarize(collected: Map<string, string[]>): string {
        const count = new Map<string, number>();
        const order: string[] = [];
        for (const labels of collected.values()) {
            for (const label of labels) {
                if (!count.has(label)) order.push(label);
                count.set(label, (count.get(label) ?? 0) + 1);
            }
        }
        return order.map((label) => `${label} ${count.get(label)}`).join(' / ');
    }
}

/**
 * 一个图标来源 = 一张配表 + 表里存图标路径的列。
 * 加一个新来源只要往这张表里补一行（容器必须值导入，见文件头的 ⚠）。
 */
interface IconSource {
    /** 日志里的中文名（用来打印"哪张表贡献了几张图"） */
    label: string;
    /** 配表容器类：`TbRoot.ins.getTbContainer()` 按类名取已加载的实例 */
    container: new (...args: any[]) => TbContainer<any>;
    /** 图标路径所在的列名 */
    field: string;
}

/**
 * 配表侧的图标来源（**覆盖英雄 / 遗物 / Buff / 神器四类，加技能与背包道具**）。
 *
 * ⚠ 这张表是"界面要显示的图"与"启动时预载的图"的**唯一对应关系**：
 *   哪张表加了一列图标（或换了列名），这里就得跟着改，否则那个界面还是老样子——先占位后替换。
 */
const ICON_SOURCES: IconSource[] = [
    { label: '英雄头像', container: UnitCfgContainer, field: 'head_icon' },
    { label: '遗物', container: RelicCfgContainer, field: 'icon' },
    { label: '技能', container: AbilityCfgContainer, field: 'icon' },
    { label: '掉落Buff', container: BattleItemCfgContainer, field: 'icon' },
    { label: '状态Buff', container: ModifierCfgContainer, field: 'icon' },
    { label: '神器', container: KillBuffCfgContainer, field: 'icon' },
    { label: '背包道具', container: BagItemCfgContainer, field: 'icon' },
];

/**
 * 代码里**写死**的碎图（不在任何配表里）。
 *
 * 每条都注明了消费方：删掉一行只是少预载一张图（那个界面退回"先占位后替换"），不会坏功能；
 * 反过来，新加了这种常量图标就补到这里。
 */
const EXTRA_ICON_PATHS: string[] = [
    // 英雄卡 / 英雄详情弹窗的属性行图标（`data/configs/HeroConfig.ts` 的 `ATTR_ICON`）
    'textures/common/heart',
    'textures/property/atk',
    'textures/property/defence',
    'textures/property/atk_range',
    // 刷新/购买按钮四态：金币 / 广告 / 广告券 / 击杀数（`RefreshButtonView`）
    'textures/common/gold',
    'textures/common/ad',
    'textures/common/ad_ticket',
    'textures/common/monster',
    // 技能槽的锁（`SkillSlot`）与技能/遗物的统一占位图（`SkillSlot` / `ShopRelicsItem`）
    'textures/common/lock',
    'textures/common/unlock',
    'textures/skills/bullet',
    // HUD 与卡片上的零碎图：经验图标（`HeroCard`）/ 暂停 / 开始（`View_Game_Stage`）
    'textures/common/exp_icon',
    'textures/common/pause',
    'textures/common/start',
    // 运行期新建节点的圆角底块与遮罩（掉落背包 / 状态栏 / 复活弹窗）
    'textures/common/rect_rd_20',
    'textures/common/rect_rd_5',
    'textures/common/white_4x4',
];
