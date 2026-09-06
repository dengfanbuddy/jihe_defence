import { _decorator, Button, Component, Label, Node, Sprite } from 'cc';
import { EventBus } from '../../../battle';
import { EventNames } from '../../../battle/core/EventBus';
import { useBattleStore } from '../../../stores';
const { ccclass, property } = _decorator;

@ccclass('HeroItem')
export class HeroItem extends Component {
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
    battleStore = useBattleStore();

    start() {
        this.selectBtn.on(Button.EventType.CLICK, this.selectHero, this);
    }
    selectHero() {
        console.log("选择英雄:", this.heroId);
        this.contentNode.active = false;
        this.battleStore.showSelectHeroPanel = false;
        //替换主界面的英雄图标，技能图标，属性替换
        EventBus.emit(EventNames.BATTLE_SELECT_HERO, { ID: this.heroId });
        //如果是普通英雄，则进入战斗阶段

        //如果是英雄选择阶段，则进入刷怪阶段
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
        //根据英雄id设置英雄头像，技能图标
    }


}


