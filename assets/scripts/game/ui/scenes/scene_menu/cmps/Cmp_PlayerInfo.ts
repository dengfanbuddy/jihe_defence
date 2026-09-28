import { _decorator, Label, ProgressBar } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { DataCenter } from '../../../../data';
import type { IPlayerInfo } from '../../../../data';
const { ccclass, property } = _decorator;

/**
 * 玩家信息条（菜单界面顶部：头像 / 等级 / 名字 / 经验条）
 *
 * 数据源：`DataCenter.ins.playerInfo.data` —— 它本身是 `reactive()` 代理，
 * 所以这里**不需要任何人通知**：任何地方 `DataCenter.ins.playerInfo.addExp(x)`、
 * `recordGameEnd()`、`signIn()` 改了字段，下面的 watcher 就会自动跑到。
 * 数据层（PlayerInfoModule）完全不知道 UI 的存在，只负责改数据。
 *
 * 说明：本组件是菜单预制件里内嵌的小组件 → 继承 UIWidget（不要加 @uiview）。
 */
@ccclass('PlayerInfoCmp')
export class PlayerInfoCmp extends UIWidget {

    @property(Label)
    lvLabel: Label = null;

    @property(Label)
    nameLabel: Label = null;

    @property(ProgressBar)
    expBar: ProgressBar = null;

    @property(Label)
    expValueLabel: Label = null;

    /** 玩家数据的响应式对象（读它的字段 = 建立依赖，别缓存成普通变量） */
    private get info(): IPlayerInfo {
        return DataCenter.ins.playerInfo.data;
    }

    protected onInit(): void {
        // watcher 交给 scope 托管：隐藏时随 scope 暂停，销毁时自动回收
        // 注意 getter 里必须真的读到字段，否则收集不到依赖
        this.scope.watch(() => this.info.name, () => this.refreshName());
        this.scope.watch(() => this.info.level, () => this.refreshLevel());
        // 经验条同时依赖 exp 与 expToNext（升级会一次改掉两者），用多源 watch
        this.scope.watch(
            [() => this.info.exp, () => this.info.expToNext],
            () => this.refreshExp(),
        );
    }

    protected onShow(): void {
        // 每次显示按当前状态无条件刷一次（resume 会补播暂停期间的触发，但显式刷一次更稳）
        this.refreshAll();
    }

    // ────────────── 刷新（只读数据 → 写 UI） ──────────────

    private refreshAll(): void {
        this.refreshName();
        this.refreshLevel();
        this.refreshExp();
    }

    private refreshName(): void {
        if (this.nameLabel) {
            this.nameLabel.string = this.info.name;
        }
    }

    private refreshLevel(): void {
        if (this.lvLabel) {
            this.lvLabel.string = this.info.level<10?`0${this.info.level}`:`{this.info.level}`;
        }
    }

    private refreshExp(): void {
        const { exp, expToNext } = this.info;
        if (this.expValueLabel) {
            this.expValueLabel.string = `${exp}/${expToNext}`;
        }
        if (this.expBar) {
            const ratio = expToNext > 0 ? exp / expToNext : 0;
            this.expBar.progress = Math.min(1, Math.max(0, ratio));
        }
    }
}
