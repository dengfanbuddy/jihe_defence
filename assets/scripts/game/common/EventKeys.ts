export class EventKeys {
    private static id: number = 0;
    private static nextId() {
        return ++EventKeys.id;
    }
    public static readonly SceneChange = new class {
        SceneChange = "SCENE_Change";
        OnProgress = "SCENE_LOAD_PROGRESS";
    }
    public static readonly GameStage = new class {
        ShowHeroSelectList = "ShowHeroSelectList";
        CreateHero = EventKeys.nextId();
        Pause = EventKeys.nextId();
    }
}