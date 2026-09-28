import { GlobalEventMgr } from "../../../platform/event/GlobalEventMgr";
import { IState } from "../../../platform/fsm/fsm_type";
import { EventKeys } from "../../common/EventKeys";
import { Scene_Game_Stage } from "../../ui/scenes/scene_game_stage/Scene_Game_Stage";


/**
 * ⚠ 本状态机当前**没有任何调用方**（`fsm_core` 只被 `fsm_hierarchical` 引用，后者无人使用），
 *   保留仅为 FSM 框架示例。
 *
 * 候选英雄 / 面板开关、以及刷新费用与广告额度都已收进 `HeroSelect`（`game/battle/HeroSelect.ts`），
 * 所以这里只调它的入口（状态本来就持有 `Scene_Game_Stage` 作为 context）。
 */
export class HeroSelectionState implements IState<Scene_Game_Stage> {


    onEnter(context: Scene_Game_Stage, ...params: any[]): void {
        console.log("进入英雄选择状态");
        context.heroSelect?.startRun();
    }



}
