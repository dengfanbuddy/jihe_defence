import { _decorator, Component, sys ,Node, Graphics, color, BlockInputEvents, tween, Label, Vec2, Vec3, v3, v2, UITransform, view} from "cc";

const { ccclass, property } = _decorator;

/**
 * 
```
基本思路
    遮罩层：全屏半透明背景，仅留出可操作区域

    高亮目标：通过图形绘制或节点缩放突出显示可交互元素

    步骤控制：通过队列管理引导步骤的切换

    事件拦截：阻止非引导区域的操作
高级优化
    数据驱动：将引导步骤配置为JSON文件，方便策划修改

    形状适配：支持矩形/圆形高亮区域

    箭头指示：在提示文字旁添加箭头动画

    自动定位：根据目标节点位置动态计算提示框位置

    多语言支持：结合i18n实现多语言提示
注意事项：
    使用 convertToWorldSpaceAR 确保坐标转换正确

    引导结束后恢复节点原始状态（如缩放）

    通过 cc.BlockInputEvents 阻止误操作

    使用本地存储记录引导完成状态
```
 */
@ccclass('GuideManager')
export default class GuideManager extends Component {
    private static instance: GuideManager = null;
    private steps: any[] = [];  // 引导步骤数组
    private currentStep: number = -1;
    private maskLayer: Node = null;  // 遮罩层
    private tipLabel: Node = null;   // 提示文本
    private winWidth:number = 0;
    private winHeight:number = 0;

    public static getInstance(): GuideManager {
        return this.instance;
    }

    onLoad() {
        GuideManager.instance = this;
        this.winWidth = view.getVisibleSize().width;
        this.winHeight = view.getVisibleSize().height;
        this.createMaskLayer();
        this.createTipLabel();
        this.node.active = false;
    }

    // 初始化引导步骤
    public initGuide(steps: any[]) {
        this.steps = steps;
        this.startGuide();
    }

    // 开始引导
    private startGuide() {
        this.node.active = true;
        this.currentStep = 0;
        this.executeStep(this.currentStep);
    }

    // 执行指定步骤
    private executeStep(stepIndex: number) {
        const stepData = this.steps[stepIndex];
        if (!stepData) {
            this.exitGuide();
            return;
        }

        // 高亮目标节点
        this.highlightTarget(stepData.targetNode);
        // 显示提示文字
        this.showTip(stepData.tipText, stepData.tipPosition);
        // 设置点击事件
        this.setClickEvent(stepData.targetNode);
    }

    // 下一步
    public nextStep() {
        this.currentStep++;
        this.executeStep(this.currentStep);
    }

    // 退出引导
    private exitGuide() {
        this.node.active = false;
        // 保存引导状态（示例）
        sys.localStorage.setItem('guide_finished', 'true');
    }
    // 在GuideManager.ts中继续添加
    // 创建遮罩层
    private createMaskLayer() {
        this.maskLayer = new Node('Mask');
        const graphics = this.maskLayer.addComponent(Graphics);

        // 绘制全屏半透明背景
        graphics.fillColor = color(0, 0, 0, 180);
        graphics.rect(0, 0, this.winWidth, this.winHeight);
        graphics.fill();

        // 添加触摸拦截
        this.maskLayer.addComponent(BlockInputEvents);
        this.node.addChild(this.maskLayer);
    }

    // 高亮目标节点
    private highlightTarget(target: Node) {
        if (!target) return;

        // 计算目标节点的世界坐标
        const worldPos = target.parent.getComponent(UITransform).convertToWorldSpaceAR(target.position);
        const localPos = this.maskLayer.getComponent(UITransform).convertToNodeSpaceAR(worldPos);

        // 在遮罩层挖洞
        const graphics = this.maskLayer.getComponent(Graphics);
        graphics.clear();
        graphics.fillColor = color(0, 0, 0, 180);
        graphics.rect(0, 0, this.winWidth, this.winHeight);

        // 绘制透明区域（圆形示例）
        graphics.moveTo(localPos.x, localPos.y);
        graphics.circle(localPos.x, localPos.y, target.getComponent(UITransform).width / 2);
        graphics.fill();

        // 添加目标节点动画（可选）
        tween(target)
            .repeatForever(
                tween()
                    .to(0.5, { scale: 1.1 })
                    .to(0.5, { scale: 1 })
            ).start();
    }

    // 创建提示文本
    private createTipLabel() {
        this.tipLabel = new Node('Tip');
        const label = this.tipLabel.addComponent(Label);
        label.string = '';
        label.fontSize = 24;
        label.lineHeight = 30;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        this.node.addChild(this.tipLabel);
    }

    // 显示提示文字
    private showTip(text: string, position: Vec2) {
        this.tipLabel.getComponent(Label).string = text;
        this.tipLabel.setPosition(v3(position.x,position.y,0))
    }

    // 设置目标点击事件
    private setClickEvent(target: Node) {
        target.once(Node.EventType.TOUCH_END, () => {
            this.nextStep();
        }, this);
    }
}

function guidTest() {
    // 在游戏启动时初始化引导
    const steps = [
        {
            targetNode: this.buttonNode1,  // 需要引导的按钮节点
            tipText: "点击这里开始游戏",
            tipPosition: v2(0, 100)     // 提示文字位置（相对屏幕）
        },
        {
            targetNode: this.shopButton,
            tipText: "这里是商店按钮",
            tipPosition: v2(-100, 50)
        }
    ];

    GuideManager.getInstance().initGuide(steps);
}