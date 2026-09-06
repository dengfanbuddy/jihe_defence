import { _decorator, Component, game, Node } from 'cc';
import UIManager from '../../platform/ui/UIManager';
import { Scene_Menu } from './scene_prefab/Scene_Menu';
import { TbRoot } from '../../platform/excel_table/TbRoot';
import { BattleConstUtil } from '../battle/core/BattleConstUtil';
const { ccclass, property } = _decorator;

@ccclass('Main')
export class Main extends Component {
    onLoad() {
        // 限制主循环帧率：浏览器 / 高刷屏幕上，不限帧会让游戏空转吃满 CPU（菜单无逻辑也会稳定高占用）
        game.frameRate = 60;
        this._init().catch(err => console.error('[Main]', err));
    }

    private async _init() {
        // 1. 加载配置表（TbRoot 管线：battle_constants 等）
        await TbRoot.ins.loadTbs();
        // 战斗常量就绪（BattleConstUtil 从容器刷新）
        BattleConstUtil.markLoaded();

        // 2. 打开主菜单
        this.scheduleOnce(() => {
            UIManager.ins.showUI(Scene_Menu)
        });
    }
}
