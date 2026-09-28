import { _decorator, Component, game, Node } from 'cc';
import UIManager from '../../platform/ui/UIManager';
import { TbRoot } from '../../platform/excel_table/TbRoot';
import { BattleConstUtil } from '../battle/core/BattleConstUtil';
// 肉鸽商店配置（shop_constants / shop_draw / shop_items / shop_skills / kill_buffs）：
// 以副作用导入触发 @tb_config 装饰器注册，必须在 loadTbs() 之前完成
import '../data/configs/ShopConfig';
import { Scene_Menu } from '../ui/scenes/scene_menu/Scene_Menu';
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
