// Game/States/GameStateTypes.ts
export enum GameStateType {
    HeroSelection = "HeroSelection",
    PreBattle = "PreBattle", 
    Battle = "Battle",
    PhaseBoss = "PhaseBoss",
    FinalBoss = "FinalBoss",
    Pause = "Pause",
    Victory = "Victory",
    Defeat = "Defeat"
}

// Game/GameContext.ts - 游戏上下文数据
export class GameStageContext {
    public gold: number = 0;
    public killCount: number = 0;
    public currentPhase: number = 1;
    public phaseRemainingTime: number = 360;
    public activeEnemies: any[] = [];
    public isPaused: boolean = false;
    public bossRemainingTime: number = 0;
    // ... 其他游戏数据
}