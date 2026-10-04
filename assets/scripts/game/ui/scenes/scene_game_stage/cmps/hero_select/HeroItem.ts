import { _decorator, Button, Node, resources, Sprite, SpriteFrame } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { TbRoot } from 'db://assets/scripts/platform/excel_table/TbRoot';
import { UnitCfgContainer } from '../../../../../excel_table/Tb_UnitConfig';
import { AbilityCfgContainer } from '../../../../../excel_table/Tb_AbilityConfig';
import { StageScopeEvents, StageScopeKeys } from '../StageScope';
import { AtlasIcon } from '../../../../../common/AtlasIcon';
import type { HeroSelectVM } from '../../../../../battle/HeroSelect';
const { ccclass, property } = _decorator;

/**
 * 英雄选择列表项（内嵌 UI 小组件 → 继承 UIWidget）
 *
 * 通信方式（不需要也知道面板在哪、更不需要引用兄弟）：
 *   - 读选中态：inject `HeroSelect` 门面，读 `selectedId`（item 之间的互斥高亮），变了自动刷
 *   - 通知面板：`scope.emit(StageScopeEvents.HeroPicked, heroId)`，由面板决定关面板 / 进战斗
 */
@ccclass('HeroItem')
export class HeroItem extends UIWidget {
    @property(Sprite)
    heroIcon: Sprite = null;
    @property(Sprite)
    skill1Icon: Sprite = null;
    @property(Sprite)
    skill2Icon: Sprite = null;
    @property(Node)
    selectLabel: Node = null;
    @property(Node)
    selectAd: Node = null;

    @property(Node)
    selectBtn: Node = null;

    @property(Node)
    contentNode: Node = null;

    heroId: number = 0;
    selectType: number = 0;//0普通       1广告

    /** 注入的「选英雄功能门面」（本 item 不关心是谁提供的，任意深度都能拿到） */
    private heroSelect: HeroSelectVM = null;

    protected onInit(): void {
        this.heroSelect = this.inject<HeroSelectVM>(StageScopeKeys.HeroSelect, null);
        if (!this.heroSelect) {
            ezgame.warn('HeroItem 没有注入到 HeroSelect 门面（不在 Scene_Game_Stage 子树下？），选中态不会互斥');
        }
        this.selectBtn?.on(Button.EventType.CLICK, this.selectHero, this);
        this.scope.watch(() => this.heroSelect?.selectedId.value, () => this.applySelected());
    }

    protected onShow(): void {
        // 每次显示都复位：选中后 item 会隐藏自己的选择区，面板重新打开必须恢复
        this.applySelected();
    }

    protected onDispose(): void {
        // selectBtn 是本节点的子节点，销毁流程里**先它后被 _destruct()**（字段清空），
        // 直接 `.off()` 会抛 "reading 'off'" 并堵死引擎销毁队列 → 必须走 offNodeEvent 跳过已销毁节点
        this.offNodeEvent(this.selectBtn, Button.EventType.CLICK, this.selectHero, this);
    }

    /** 选中态：被选中的 item 隐藏自己的选择区（互斥由门面的 selectedId 统一决定） */
    private applySelected(): void {
        if (!this.contentNode) {
            return;
        }
        const pickedId = this.heroSelect ? this.heroSelect.selectedId.value : 0;
        this.contentNode.active = !(this.heroId > 0 && pickedId === this.heroId);
    }

    selectHero() {
        if (this.heroId <= 0) {
            return;     // 空位不可选（原写法会选中 id=0 并直接把面板关掉）
        }
        console.log("选择英雄:", this.heroId);
        // 写共享状态（别的 item 会自动取消选中）+ 向上通知（面板决策）
        if (this.heroSelect) {
            this.heroSelect.selectedId.value = this.heroId;
        }
        this.applySelected();
        this.scope.emit(StageScopeEvents.HeroPicked, this.heroId);
    }

    setHeroInfo(heroId: number, selectType: number) {
        this.heroId = heroId;
        this.selectType = selectType;
        if (selectType == 1) {
            this.selectAd.active = true;
            this.selectLabel.active = false;
        } else {
            this.selectLabel.active = true;
            this.selectAd.active = false;
        }
        // heroId 是非响应式字段，改完要显式刷一次选中态（不能指望 watch 感知）
        this.applySelected();
        //根据英雄id设置英雄头像，技能图标
        let cfg = TbRoot.ins.getTbContainer(UnitCfgContainer).getCfgById(heroId)
        if(!cfg){
            ezgame.error("未找到英雄配置："+heroId)
            return
        }
        // head_icon 是 resources 内置分包内的相对路径（如 textures/heros/huoqiang），
        // 项目未给 textures 建独立分包 → 必须用 resources.load 加载 png 的 spriteFrame 子资源；
        // 不能走 loadBundleSprite（它会把路径首段 textures 当作分包名去加载，永远失败返回 null）
        this.loadIcon(cfg.head_icon, this.heroIcon, "英雄头像");
        // 技能图标：取本英雄配置的前两个技能（units.json 的 abilities，含被动，与 HUD 技能栏同一口径），
        // 图标路径来自 abilities.json 的 icon 列（为空的技能沿用上面的 `if (!icon) return`，保留预制件占位图）
        const skills = (cfg.abilities ?? []).slice(0, 2);
        const abilityTb = TbRoot.ins.getTbContainer(AbilityCfgContainer);
        skills.forEach((abilityId, index) => {
            const icon = abilityTb.getCfgById(abilityId)?.icon;
            if (!icon) return;
            this.loadSkillIcon(icon, index === 0 ? this.skill1Icon : this.skill2Icon, "技能图标");
        });
    }

    /** 加载 `path/spriteFrame` 并写入目标 Sprite（失败只报错，不把已有图刷成空白） */
    private loadIcon(path: string, target: Sprite, label: string): void {
        if (!path || !target) return;
        resources.load(`${path}/spriteFrame`, SpriteFrame, (err, spriteFrame) => {
            if (err || !spriteFrame) {
                ezgame.error(`${label}加载失败：${path}`, err)
                return
            }
            if (target.isValid) target.spriteFrame = spriteFrame
        })
    }

    /**
     * 加载**技能图标**并写入目标 Sprite（icon 列 → `textures/skills/<技能名>`）。
     * 与上面的 `loadIcon` 只差一件事：**先试图集**（`textures/skills/skills`），
     * 取不到再回落碎图 —— 三级降级与"命中哪条路"的日志都在共用的 `AtlasIcon` 里。
     *
     * ⚠ 头像（`textures/heros/*`）**故意不走这里**：那套目前是碎图、没有图集，
     * 硬走图集只会多两条注定失败的子资源请求（构建版还会因此打红字），零收益。
     * 将来 `textures/heros` 也打成图集时，把 `setHeroInfo` 里那行一起换成这个即可。
     */
    private loadSkillIcon(path: string, target: Sprite, label: string): void {
        if (!path || !target) return;
        AtlasIcon.loadIconFrame(path).then((spriteFrame) => {
            if (!spriteFrame) {
                ezgame.error(`${label}加载失败：${path}`)
                return
            }
            if (target.isValid) target.spriteFrame = spriteFrame
        })
    }
}
