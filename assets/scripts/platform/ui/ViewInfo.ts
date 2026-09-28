export enum ViewLayer {
    Scene,      // 场景层（特殊层）
    Bottom,     // 底部层
    View,       // 普通视图层
    PopUp,      // 弹窗层
    Dialog,     // 对话框层
    Tip,        // 提示层
    Top         // 顶层
}


export interface ViewInfo {
    prefabPath: string, // 预制件路径
    layer: string, // 所属层级
    single?:boolean,//是否是单例，单例的话只能有一个当前视图存在
    [key:string]:any
}