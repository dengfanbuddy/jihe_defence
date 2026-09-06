import { _decorator, color, Component,Label,Node, Tween, tween, UITransform, v3 } from "cc";

const { ccclass, property } = _decorator;


@ccclass('Tips')
export class Tips extends Component{

    private text: string = "";
    private status: number = 0; // 0: normal, 1: warning, 2: error

    moveTween:Tween<Node> | null = null;

    public setText(text: string): void {
        this.text = text;
        this.node.getChildByName("text").getComponent(Label).string = text;
    }
    public setStatus(status: number): void {
        this.status = status;
        if(status === 0) {
            this.node.getChildByName("text").getComponent(Label).color= color(0, 0, 0); // 黑色
        }else if(status === 1) {
            this.node.getChildByName("text").getComponent(Label).color = color(255, 174, 0); // 黄色
        }else {
            this.node.getChildByName("text").getComponent(Label).color = color(255, 0, 0); // 红色
        }
    }

    protected onEnable(): void {
        let height = this.node.parent.getComponent(UITransform).height
        if(this.moveTween!=null){
            this.moveTween.stop(); // 停止之前的动画
        }
        this.node.setPosition(0, height / 2 - 250, 0); // 设置位置在屏幕顶部
        this.moveTween = tween(this.node).to(0.2, { position: v3(0, height / 2 - 150, 0) })
        this.moveTween.start(); // 启动动画
        this.scheduleOnce(()=>{
            this.node.active = false; // 1.5秒后隐藏
        },1.5)
    }
}