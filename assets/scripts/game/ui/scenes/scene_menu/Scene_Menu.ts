import { _decorator, Button, Component, director, Node } from 'cc';
import BaseView from 'db://assets/scripts/platform/ui/BaseView';
import { uiview } from 'db://assets/scripts/platform/ui/UIDecorator';
import UIManager from 'db://assets/scripts/platform/ui/UIManager';
import { ViewLayer } from 'db://assets/scripts/platform/ui/ViewInfo';
import { Scene_Game_Stage } from '../scene_game_stage/Scene_Game_Stage';
import { ScopeKey } from 'db://assets/scripts/platform/ui/UIScope';
import { ref } from 'db://assets/scripts/platform/reactivity';


const { ccclass, property } = _decorator;

@uiview({
    prefabPath: 'prefabs/ui/scenes/scene_menu/Scene_Menu', // 预制件路径
    layer: ViewLayer[ViewLayer.Scene], // 所属层级
    single: true,//是否是单例，单例的话只能有一个当前视图存在
})
@ccclass('Scene_Menu')
export class Scene_Menu extends BaseView {


    playerInfoNode:Node


    //背包功能按钮
    @property(Node)
    bagBtn: Node = null;
    //任务功能按钮
    @property(Node)
    taskBtn: Node = null;
    //进入游戏功能按钮
    @property(Node)
    enterGameBtn: Node = null;

    start() {
        this.enterGameBtn.on(Button.EventType.CLICK, () => {
            // 进入游戏
            UIManager.ins.showUI(Scene_Game_Stage);
        })
        let node = this.node.getChildByPath("bottom")



    }

    protected show(): void {

    }

    protected close(): void {

    }


    static ScopeKey = {
        MenuSelect:"MenuSelect"
    }
}




