// 适配脚本：ScreenAdapter.ts
import { _decorator, Component, director, view, Widget } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('ScreenAdapter')
export class ScreenAdapter extends Component {


    start() {
        console.log("scene:"+director.getScene().name+" nodeName:"+this.node.name+"  uuid"+this.node.uuid);
        
        // 获取屏幕实际分辨率
        const screenSize = view.getVisibleSize();
        const screenWidth = screenSize.width;
        const screenHeight = screenSize.height;

        // 获取设计分辨率
        let design = view.getDesignResolutionSize();

        // 计算缩放比例
        const scaleX = screenWidth / design.width;
        const scaleY = screenHeight / design.height;
        const scale = Math.min(scaleX, scaleY); // 取较小的比例，确保内容完整显示

        // 缩放根节点
        this.node.setScale(scale, scale);

        // 调整节点位置（可选）
        const offsetX = (screenWidth - design.width * scale) / 2;
        const offsetY = (screenHeight - design.height * scale) / 2;
        this.node.setPosition(offsetX, offsetY);
    }
}