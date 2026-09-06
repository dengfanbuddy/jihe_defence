import { _decorator, Button, Component, director, Node } from 'cc';
import { uiview } from '../../../platform/ui/UIDecorator';
import { ViewLayer } from '../../../platform/ui/ViewInfo';
import BaseView from '../../../platform/ui/BaseView';
import UIManager from '../../../platform/ui/UIManager';
import { Scene_Game_Stage } from '../../game_stage/scene/Scene_Game_Stage';
import { NodeUtils } from '../../common/NodeUtils';

const { ccclass, property } = _decorator;

@uiview({
    prefabPath: 'prefabs/scenes/Scene_Menu', // 预制件路径
    layer: ViewLayer[ViewLayer.Scene], // 所属层级
    single:true,//是否是单例，单例的话只能有一个当前视图存在
})
@ccclass('Scene_Menu')
export class Scene_Menu extends BaseView<null,null> {
    @property(Node)
    enterGameBtn: Node = null;

    start() {
        this.enterGameBtn.on(Button.EventType.CLICK, () => {
            // 进入游戏
            UIManager.ins.showUI(Scene_Game_Stage);
        })
        let node = this.node.getChildByPath("bottom")
        console.log(node)
        NodeUtils.setGray(node,true);
    }

}


