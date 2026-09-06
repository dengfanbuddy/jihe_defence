import { _decorator, Color, Component, Label, Node } from 'cc';
import { useBattleStore } from '../../../stores';
import { watch, WatchHandle } from 'db://assets/scripts/platform/reactivity';
import { HeroItem } from './HeroItem';
const { ccclass, property } = _decorator;

@ccclass('HeroSelectPanel')
export class HeroSelectPanel extends Component {
    @property(Node)
    heroItemListNode: Node = null;
    @property(Label)
    refreshGoldValueNode: Label = null;
    @property(Node)
    refreshBtnNode: Node = null;
    @property(Node)
    closeBtnNode: Node = null;

    battleStore = useBattleStore();
    watchHandles: WatchHandle[] = [];
    heroItems: HeroItem[] = [];
    onLoad() {
        this.closeBtnNode.on(Node.EventType.MOUSE_DOWN, this.closePanel, this);
        if (this.heroItems.length == 0) {
            let heroList = this.battleStore.selectHeroList
            this.heroItemListNode.children.forEach((node) => {
                let item = node.getComponent(HeroItem);
                this.heroItems.push(item);
            })
            for (let index = 0; index < heroList.length; index++) {
                const heroId = heroList[index];
                //TODO 确定是否用广告选取
                this.heroItems[index].setHeroInfo(heroId,0);
            }
        }

    }
    onEnable() {
        // watch 返回值必须存入 watchHandles，否则 onDisable 无法停止 → 组件销毁后仍被触发
        this.watchHandles.push(watch(() => this.battleStore.gold, this.checkRefreshGoldValueStatus));
        this.checkRefreshGoldValueStatus();
    }
    closePanel() {
        this.battleStore.showSelectHeroPanel = false;
    }
    checkRefreshGoldValueStatus() {
        if (this.battleStore.gold < this.battleStore.refreshGold) {
            this.refreshGoldValueNode.color = new Color(255, 0, 0);
        } else {
            this.refreshGoldValueNode.color = new Color("6A696B");
        }
    }
    start() {

    }

    update(deltaTime: number) {

    }
    protected onDisable(): void {
        this.watchHandles.forEach(handle => handle.stop());
        this.watchHandles.length = 0; // 清空，防止重复 stop
    }

}


