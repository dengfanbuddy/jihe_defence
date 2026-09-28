import { GlobalEventMgr } from "../../../platform/event/GlobalEventMgr";
import { IState } from "../../../platform/fsm/fsm_type";
import { EventKeys } from "../../common/EventKeys";
import { useBattleStore } from "../../stores";
import { Scene_Game_Stage } from "../../ui/scenes/scene_game_stage/Scene_Game_Stage";


export class PauseState implements IState<Scene_Game_Stage> {


    battleStore = useBattleStore();
    adTime: number = 0;
    
    onEnter(context: Scene_Game_Stage, ...params: any[]): void {
        console.log("进入暂停状态");
        this.adTime = 30;
    }  

    onUpdate(context: Scene_Game_Stage, deltaTime: number): void {
        this.adTime -= deltaTime;
        if (this.adTime <= 0) {
            this.adTime = 999999//一次暂停只拉起一次广告
            //TODO 拉起广告
        }
    }
}