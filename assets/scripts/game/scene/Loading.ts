import { _decorator, assetManager, Component, director, Label, ProgressBar } from 'cc';
import { DataCenter } from '../data';
import { TbRoot } from '../../platform/excel_table/TbRoot';
const { ccclass, property } = _decorator;

/**
 * 启动进度的两段权重（加起来 = 1），按"体感耗时"分配：
 * ① `scripts` 分包（全部脚本）最重；② 配表 14 张 JSON 次之。
 * `DataCenter.ins.init()` 是同步的（瞬间完成），不单独占权重，收尾时直接补到 100%。
 */
const STAGE_BUNDLE = 0.55;
const STAGE_TABLES = 0.45;

/** 进度条最短走完时长（秒）：加载再快也要让玩家看见它从 0 走到 100%，否则界面像闪了一下 */
const MIN_SHOW_TIME = 0.8;
/** 平滑逼近的最慢速度（每秒进度）：尾段差值很小时靠它继续走，而不是指数爬行磨蹭 */
const MIN_SPEED = 0.6;
/** 平滑逼近系数（每秒）：越大越跟手、越小越平缓 */
const SMOOTH = 4;
/** 收尾吸附阈值：差值小于它就直接写成 1，避免浮点上永远差最后一丁点、条看着没满 */
const SNAP_EPSILON = 0.002;

/**
 * 首场景（`Loading.scene`）的加载宿主。
 *
 * 启动顺序（全工程唯一保证「分包 → 配表 → 数据」顺序的地方）：
 * `loadBundle('scripts')` → `TbRoot.loadTbs()` → `DataCenter.init()` → `director.loadScene('Main')`。
 *
 * 进度条口径：**只反映真实进度**（分包 onProgress / 配表逐张完成），
 * 不掺假的定时推演；显示值每帧向真实值平滑逼近，且**只增不减**。
 */
@ccclass('Loading')
export class Loading extends Component {

    @property({ type: ProgressBar, tooltip: '进度条：显示真实加载进度（0~1，只增不减）' })
    progressBar: ProgressBar = null;

    @property({ type: Label, tooltip: '百分比文本：跟随进度条显示，如 "25%"' })
    percentLabel: Label = null;

    /** 真实进度目标值（由各加载阶段推进，只增不减） */
    private _target = 0;
    /** 当前显示值（每帧向 `_target` 逼近，避免进度条"跳格"） */
    private _display = 0;
    /** 进度条已经展示了多久（用于 `MIN_SHOW_TIME`） */
    private _shownTime = 0;
    /** 等进度条走完的挂起回调（非空 = 正在等） */
    private _fullBarResolve: (() => void) = null;

    async onLoad() {
        // 归零起步：预制件里存的是静态值（曾经是 30% / "25%"），不能当起点用
        this._apply(0);

        try {
            await this.loadscripts();
            // 数据层初始化（同步，内含等级表对齐 / 跨天重置 / 存档迁移）
            DataCenter.ins.init();
        } catch (e) {
            // 加载失败也要放行：卡在 Loading 场景比带着缺失数据进 Main 更难排查
            console.error('[Loading] 启动加载失败', e);
        }

        this._setTarget(1);
        await this._waitFullBar();
        director.loadScene('Main');
    }

    /** 加载 `scripts` 分包 →（成功后在回调里）加载配表，两段各自推进进度 */
    loadscripts() {
        return new Promise<void>((resolve, reject) => {
            assetManager.loadBundle('scripts', {
                onProgress: (finished: number, total: number) => {
                    this._setTarget(this._stageProgress(STAGE_BUNDLE, finished, total));
                },
            }, (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                // 分包阶段结束（onProgress 不保证回满，这里补一次）
                this._setTarget(STAGE_BUNDLE);
                TbRoot.ins
                    .loadTbs((finished, total) => {
                        this._setTarget(STAGE_BUNDLE + this._stageProgress(STAGE_TABLES, finished, total));
                    })
                    .then(() => {
                        this._setTarget(STAGE_BUNDLE + STAGE_TABLES);
                        resolve();
                    })
                    .catch(reject);
            });
        });
    }

    update(deltaTime: number) {
        this._shownTime += deltaTime;

        if (this._display < this._target) {
            const speed = Math.max(MIN_SPEED, (this._target - this._display) * SMOOTH);
            this._display = Math.min(this._target, this._display + speed * deltaTime);
            // 收尾吸附：把最后 0.2% 直接补满（否则 100% 只是四舍五入出来的）
            if (this._target >= 1 && this._target - this._display <= SNAP_EPSILON) {
                this._display = 1;
            }
            this._apply(this._display);
        }

        this._checkFullBar();
    }

    // ────────────── 进度 ──────────────

    /** 某阶段内部进度（0~1）× 该阶段权重；`total` 非法时按未开始处理（不产生 NaN） */
    private _stageProgress(weight: number, finished: number, total: number): number {
        if (!total || total <= 0) return 0;
        return weight * Math.min(1, finished / total);
    }

    /**
     * 推进真实进度。
     * **只增不减**：并行加载的回调顺序不保证（配表是并行拉的），任何回退都会让进度条倒着走。
     */
    private _setTarget(p: number) {
        const v = Math.max(0, Math.min(1, p));
        if (v > this._target) this._target = v;
    }

    /** 写进度条与百分比文本（唯一落点） */
    private _apply(p: number) {
        const v = Math.max(0, Math.min(1, p));
        if (this.progressBar) this.progressBar.progress = v;
        if (this.percentLabel) this.percentLabel.string = `${Math.round(v * 100)}%`;
    }

    /** 等进度条真的走到 100% 且已展示够久（让"它在动"这件事被看见），再切场景 */
    private _waitFullBar(): Promise<void> {
        return new Promise<void>((resolve) => {
            this._fullBarResolve = resolve;
            this._checkFullBar();
        });
    }

    private _checkFullBar() {
        if (!this._fullBarResolve) return;
        if (this._display < 1 || this._shownTime < MIN_SHOW_TIME) return;
        const resolve = this._fullBarResolve;
        this._fullBarResolve = null;
        resolve();
    }
}
