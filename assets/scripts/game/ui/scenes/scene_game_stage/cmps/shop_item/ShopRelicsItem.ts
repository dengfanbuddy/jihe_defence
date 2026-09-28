import { _decorator, Color, Label, Node, Sprite, SpriteFrame, Button, resources } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { ShopConfig, type ShopRarity } from '../../../../../data/configs/ShopConfig';
import { StageScopeEvents } from '../UiScopeKeys';

const { ccclass, property } = _decorator;

/**
 * 遗物品质配色（**唯一配色源**，与预制件里的占位色无关）
 * 白 common / 蓝 rare / 黄 epic（美术取色偏紫）/ 红 legendary
 */
const RARITY_COLOR: Record<ShopRarity, string> = {
    common: '#DDDDDD',
    rare: '#5096FF',
    epic: '#CF68FF',
    legendary: '#FF6464',
};

/** 不可选（本次已选过 / 空槽）时的灰化色 */
const DISABLED_GREY = new Color(124, 124, 124, 255);

/**
 * 遗物面板里的**一个遗物槽位**（内嵌 UI 小组件 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * 职责只有三件（业务全在宿主 `Scene_Game_Stage`，本组件不知道金币、不知道商店、更不知道别的槽位）：
 *   ① 渲染：按遗物 id 查 relics.json 出图标 / 名字 / 描述，名字按品质上色
 *   ② 通知：点击 → `scope.emit(StageScopeEvents.RelicPicked, id, 是否需要广告)`，
 *      由面板/场景决定「能不能选、要不要看广告、选中后干什么」——item 自己**不埋单、不关面板**
 *   ③ 表现：被选走 / 空槽 → 收起自身内容并禁用点击（"选择的遗物隐藏"）
 *
 * 通信：只向上 `emit`（沿 `node.parent` 冒泡到 `Scene_Game_Stage` 的 scope），
 * 不读全局 store、不引用兄弟、不 getComponent 找面板。
 */
@ccclass('ShopRiItem')
export class ShopRiItem extends UIWidget {

    /** 图标（预制件放的是 `head/inner` 那层的 Sprite） */
    @property(Sprite)
    icon: Sprite = null;
    /** 遗物名（按品质上色） */
    @property(Label)
    nameLabel: Label = null;
    /** 效果描述（relics.json 的**局内版**描述） */
    @property(Label)
    descLabel: Label = null;
    /** 内容根节点：空槽 / 已选走时整块收起（按钮留在原地，靠 interactable 关掉点击） */
    @property(Node)
    contentNode: Node = null;
    /** 点击区（挂在槽位节点上的 Button）：点击 = 选这件遗物；不可选时置灰 + interactable=false */
    @property(Button)
    selectBtn: Button = null;
    /** 「看广告」角标（可空；selectType=1 时显示） */
    @property(Node)
    selectAdNode: Node = null;

    /** 当前槽位的遗物 id（0 = 空槽；非响应式字段，改完由 setItemInfo 内部显式刷一次表现） */
    relicId: number = 0;
    /** 选取方式：0 普通（花金币 / 已在本次抽取里选中） · 1 广告（需要看激励视频） */
    selectType: number = 0;

    /** 是否可点（面板根据「本次是否已选过 / 是否需要广告」下发） */
    private selectable = false;
    /** 预制件里的原始颜色（首次使用时缓存，用于从灰化状态恢复） */
    private baseColors = new Map<string, Color>();
    /** 已加载的图标（按 url 缓存，避免每次刷新面板都重新下载远程图） */
    private static iconCache: Map<string, SpriteFrame> = new Map<string, SpriteFrame>();

    protected onInit(): void {
        this.selectBtn?.node.on(Button.EventType.CLICK, this.onClickItem, this);
    }

    protected onShow(): void {
        // 每次面板打开都按当前状态复位一次（item 的 relicId 是普通字段，非响应式，watch 感知不到）
        this.applySelectable();
        this.applyContentVisible(this.relicId > 0);
    }

    protected onDispose(): void {
        // selectBtn 是后代组件（Button 自身也会被 _destruct → `.node` 变 null），走 offNodeEvent 双重兜底
        this.offNodeEvent(this.selectBtn?.node, Button.EventType.CLICK, this.onClickItem, this);
    }

    /* ===================================================================
     * 对外：面板下发数据（面板只调这两个方法）
     * =================================================================== */

    /**
     * 设置槽位展示的遗物。
     * @param id 遗物 id（relics.json）；**≤ 0 = 空槽**（收起内容）
     * @param selectType 0 普通选取 · 1 需要广告才能选取（显示广告角标）
     */
    setItemInfo(id: number, selectType: number): void {
        this.relicId = id > 0 ? id : 0;
        this.selectType = selectType;

        if (this.relicId <= 0) {
            this.applyContentVisible(false);
            this.applySelectable();
            return;
        }

        const cfg = ShopConfig.getRelic(this.relicId);
        if (!cfg) {
            ezgame.error(`[遗物面板] 未找到遗物配置：${this.relicId}`);
            this.relicId = 0;
            this.applyContentVisible(false);
            this.applySelectable();
            return;
        }

        if (this.nameLabel) {
            this.nameLabel.string = cfg.name ?? '';
            this.baseColors.set('name', new Color(RARITY_COLOR[cfg.rarity] ?? RARITY_COLOR.common));
        }
        if (this.descLabel) this.descLabel.string = ShopConfig.getRelicDesc(cfg);
        this.loadIcon(cfg.icon);

        if (this.selectAdNode) this.selectAdNode.active = selectType === 1;
        this.applyContentVisible(true);
        this.applySelectable();
    }

    /** 面板下发「这一格现在能不能点」（已选过 / 空槽 → false，表现上灰化） */
    setSelectable(canSelect: boolean): void {
        this.selectable = canSelect;
        this.applySelectable();
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    /** 内容显隐：空槽 / 已被选走 → 收起（"选择的遗物隐藏"），按钮留在原地但不可点 */
    private applyContentVisible(visible: boolean): void {
        if (this.contentNode) this.contentNode.active = visible;
        if (this.selectAdNode) this.selectAdNode.active = visible && this.selectType === 1;
    }

    /** 可点状态 + 灰化表现（Button 的 disabledColor 只对 COLOR 过渡生效，这里手动调色，预制件用哪种过渡都一致） */
    private applySelectable(): void {
        const canSelect = this.selectable && this.relicId > 0 && !!this.contentNode?.active;
        if (this.selectBtn) this.selectBtn.interactable = canSelect;

        const tint = (comp: Sprite | Label | null, key: string, grey: boolean): void => {
            if (!comp) return;
            if (!this.baseColors.has(key)) this.baseColors.set(key, comp.color.clone());
            comp.color = grey ? DISABLED_GREY.clone() : this.baseColors.get(key).clone();
        };
        tint(this.icon, 'icon', !canSelect);
        tint(this.descLabel, 'desc', !canSelect);
        // 名字用品质色，灰化时也要灰掉（品质色本身很亮，不然"置灰"看不出来）
        if (this.nameLabel) {
            if (!this.baseColors.has('name')) this.baseColors.set('name', new Color(RARITY_COLOR.common));
            this.nameLabel.color = canSelect
                ? this.baseColors.get('name').clone()
                : DISABLED_GREY.clone();
        }
    }

    /** 点击：只负责"通知"，是否成功、是否要看广告、选中后的收尾全在宿主场景 */
    private onClickItem(): void {
        if (!this.selectable || this.relicId <= 0) return;
        this.scope.emit(StageScopeEvents.RelicPicked, this.relicId, this.selectType === 1);
    }

    /**
     * 加载遗物图标。
     * relics.json 的 icon 是**远程 URL**（steam CDN），本地图标则是 resources 内相对路径，两种都支持：
     * 远程走 `ezgame.res.loadRemoteFrame`，本地走 `resources.load(.../spriteFrame)`；按 url 缓存，失败只报错。
     */
    private loadIcon(url: string): void {
        if (!this.icon) return;
        if (!url) {
            // 没配图标 → 清掉上一件遗物残留的图（槽位会被轮流复用，不能留脏图）
            this.icon.spriteFrame = null;
            return;
        }

        const cached = ShopRiItem.iconCache.get(url);
        if (cached) {
            this.icon.spriteFrame = cached;
            return;
        }

        const apply = (sf: SpriteFrame): void => {
            if (!sf) return;
            ShopRiItem.iconCache.set(url, sf);
            if (this.icon?.isValid) this.icon.spriteFrame = sf;
        };

        if (/^https?:\/\//i.test(url)) {
            ezgame.res.loadRemoteFrame(url).then(apply).catch((err) => {
                ezgame.error(`[遗物面板] 远程图标加载失败：${url}`, err);
            });
            return;
        }
        resources.load(`${url}/spriteFrame`, SpriteFrame, (err, sf) => {
            if (err || !sf) {
                ezgame.error(`[遗物面板] 图标加载失败：${url}`, err);
                return;
            }
            apply(sf);
        });
    }
}
