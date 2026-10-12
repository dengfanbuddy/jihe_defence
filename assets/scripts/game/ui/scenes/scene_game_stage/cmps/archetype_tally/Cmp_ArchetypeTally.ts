import { _decorator, Color, Label } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { StageScopeKeys } from '../StageScope';
import { ARCHETYPE_FORM_THRESHOLD, type ArchetypeTallyVM } from '../../../../../battle/ArchetypeTally';

const { ccclass, property } = _decorator;

/** 常态色 = `c-ink-400`（tokens 的「次要说明文字」）—— 与商店格/摊位上的标签同一档灰 */
const COLOR_IDLE = new Color(153, 153, 153, 255);
/** 成型那一瞬的高亮色 = `c-accent-600`（tokens 的「品牌主色 / 选中文字」） */
const COLOR_FLASH = new Color(103, 153, 154, 255);
/** 高亮持续多久（秒）—— 够看见，又不至于在战斗中一直抢注意力 */
const FLASH_SEC = 1.6;
/**
 * HUD 上最多画几个流派。
 *
 * 为什么不画全 8 个：HUD 那一行（约 560px）放不下 8 段，而且**玩家真正关心的是"我在堆哪条线"**，
 * 前 3 名已经回答了。想看全量是"翻面板"的场景，不是常驻 HUD 的场景。
 */
const MAX_SHOWN = 3;

/**
 * 局内 HUD 的**流派进度行**（内嵌 UI 小组件 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * 回答的是那句判据：*玩家永远感受不到"我这局玩的是什么流派"*。逐件的标签 2026-11 已经
 * 三面点亮（商店格 / 击杀商店摊位 / 图鉴行），但那是"这一件是什么"，
 * 这里补的是"**整局加起来**我在堆哪条线"。
 *
 * ── 显示口径 ──
 *   一行文本：`远程点杀 4/5  ·  物理暴击 3/5  ·  法术爆发 2/5`（前 3 名，按件数降序）
 *   ① 已达成型线的词前面带 `◆`（**常驻**标记 —— 成型提示不该看完就消失）；
 *   ② 首次成型的那一瞬整行转 `c-accent-600` 并保持 1.6 秒（**这就是"成型提示"**，
 *      不弹窗、不挡战场：本作战斗区的注意力预算很紧，见 `docs/打击反馈设计.md`）；
 *   ③ 一件都没拿到时**这一行留白**（写空串，**不是**把节点 `active = false` —— 理由见 `redraw()` 里的注释，
 *      那会把 watcher 一起暂停掉）。
 *
 * ── 通信（严格按 StageScope 的规矩）──
 *   只 `inject` 只读门面 `ArchetypeTallyVM`、只 `scope.watch(tally.revision)`；
 *   不读 store、不引用兄弟、不 getComponent 找 HUD。统计真源在场景（`refreshArchetypeTally`）。
 */
@ccclass('CmpArchetypeTally')
export class CmpArchetypeTally extends UIWidget {

    /** 那一行文字（预制件里就是本节点上的 Label） */
    @property(Label)
    listLabel: Label = null;

    /** 宿主 provide 的只读门面（`onInit` 注入） */
    private tally: ArchetypeTallyVM = null;

    /** 高亮剩余时间（> 0 表示正在闪） */
    private flashing = false;

    protected onInit(): void {
        this.tally = this.inject<ArchetypeTallyVM>(StageScopeKeys.ArchetypeTally, null);
        if (!this.tally) {
            ezgame.warn('CmpArchetypeTally 没注入到 ArchetypeTally 门面（不在 Scene_Game_Stage 子树下？），流派进度不会刷新');
        }
        // 只 watch 版本号（不 watch 具体计数）：统计的写者是场景，本组件纯渲染
        this.scope.watch(() => this.tally?.revision.value, () => this.redraw());
    }

    protected onShow(): void {
        this.redraw();
    }

    protected onDispose(): void {
        this.unschedule(this.endFlash);
    }

    /* ===================================================================
     * 渲染
     * =================================================================== */

    /** 按当前统计重画（宿主每次 `recount()` 后由 watcher 触发） */
    private redraw(): void {
        const total = this.tally ? this.tally.totalCount : 0;

        // 一件都没有 → 这一行**写空串留白**。
        // ⚠ 刻意**不**用 `node.active = false` 收起：本组件就挂在这一行自己的节点上，
        //   而 `UIWidget` 在 `onDisable` 时会统一 pause 掉 scope 的 watcher
        //   （见 `platform/ui/UIWidget.ts` 的基类注释）—— 把自己 disable 掉，
        //   就等于把"拿到第一件之后该重画"那次回调也一起停掉了，**这一行永远出不来**。
        //   空串的 Label 本来就不画任何东西，视觉上等价。
        if (total <= 0) {
            if (this.listLabel) this.listLabel.string = '';
            return;
        }

        const list = this.tally.top(MAX_SHOWN);
        if (this.listLabel) {
            this.listLabel.string = list
                .map((c) => `${c.formed ? '◆' : ''}${c.tag} ${c.count}/${ARCHETYPE_FORM_THRESHOLD}`)
                .join('  ·  ');
        }

        // 一次性提示：只在本组件还没画过这次成型时闪（`drainFormed` 取走即清）
        const formed = this.tally.drainFormed();
        if (formed.length > 0) this.flash();
    }

    /** 成型的一瞬：整行转 accent，`FLASH_SEC` 后回 ink */
    private flash(): void {
        if (!this.listLabel?.isValid) return;
        this.flashing = true;
        this.listLabel.color = COLOR_FLASH.clone();
        this.unschedule(this.endFlash);
        this.scheduleOnce(this.endFlash, FLASH_SEC);
    }

    /** 箭头函数字段：`scheduleOnce` / `unschedule` 认的是同一个引用 */
    private endFlash = (): void => {
        if (!this.flashing) return;
        this.flashing = false;
        if (this.listLabel?.isValid) this.listLabel.color = COLOR_IDLE.clone();
    };
}
