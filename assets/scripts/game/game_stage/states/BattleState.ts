import { GlobalEventMgr } from "../../../platform/event/GlobalEventMgr";
import { IState } from "../../../platform/fsm/fsm_type";
import { EventBus } from "../../battle";
import { EventNames } from "../../battle/core/EventBus";
import { EventKeys } from "../../common/EventKeys";
import { useBattleStore } from "../../stores";
import { GameStageContext, GameStateType } from "../GameStateType";
import { Scene_Game_Stage } from "../scene/Scene_Game_Stage";


export class BattleState implements IState<Scene_Game_Stage> {


    battleStore = useBattleStore();
    
    onEnter(context: Scene_Game_Stage, ...params: any[]): void {
        console.log("进入战斗状态：",this.battleStore.phase);    
    }
    
    onUpdate?(context: Scene_Game_Stage, deltaTime: number){
        let remainTime = this.battleStore.phaseRemainTime
        remainTime -= deltaTime
        if (remainTime < 0) {
            remainTime = 0
        }
        if(remainTime == 0){
            //进入下一阶段
            let maxPhase =this.battleStore.maxPhase
            if(maxPhase == 0 || this.battleStore.phase < maxPhase){//无尽
                this.battleStore.phase = this.battleStore.phase + 1
            }else {
                //最终boss阶段呢
                // context.fsm.changeState(GameStateType.FinalBoss)

                
            }
        }
    }
    
    

    
}