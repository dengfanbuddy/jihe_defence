import { GlobalEventMgr } from "../../../platform/event/GlobalEventMgr";
import { IState } from "../../../platform/fsm/fsm_type";
import { EventKeys } from "../../common/EventKeys";
import { useBattleStore } from "../../stores";
import { Scene_Game_Stage } from "../scene/Scene_Game_Stage";


export class HeroSelectionState implements IState<Scene_Game_Stage> {


    battleStore = useBattleStore();
    
    onEnter(context: Scene_Game_Stage, ...params: any[]): void {
        console.log("进入英雄选择状态");
        if(this.battleStore.selectHeroList.length == 0){
            this.battleStore.randomHeroes()
        }
        this.battleStore.showSelectHeroPanel = true;
    }

    

    
}