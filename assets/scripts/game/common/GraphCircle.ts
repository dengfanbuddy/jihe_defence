import { _decorator, Component, Node, Graphics, Color } from 'cc';
const { ccclass, property, executeInEditMode } = _decorator;


@ccclass('GraphCircle')
@executeInEditMode
export class GraphCircle extends Component {
    graph: Graphics
    @property({ visible: false, serializable: true })
    private _radius: number = 100;
    @property({ visible: false, serializable: true })
    private _lineColor: Color = new Color(0, 255, 0, 100);
    @property({ visible: false, serializable: true })
    private _lineWidth: number = 3;


    @property({
        tooltip: "技能范围半径",
        slide: true,  // 显示滑块
        range: [50, 500],  // 范围限制
    })
    get radius() {
        return this._radius;
    }
    set radius(value: number) {
        this._radius = value;
        this.drawGraph();  // ← 属性变化时自动刷新
    }


    @property({
        type: Color,
        tooltip: "线框颜色"
    })
    get lineColor() {
        return this._lineColor;
    }
    set lineColor(value: Color) {
        this._lineColor = value;
        this.drawGraph();
    }

    @property({ slide: true, range: [1, 10] })
    get lineWidth() {
        return this._lineWidth;
    }
    set lineWidth(val: number) {
        this._lineWidth = val;
        this.drawGraph();
    }
    start() {
        this.graph = this.getComponent(Graphics);
        this.drawGraph();
    }

    drawGraph() {
        if (!this.graph) return;

        this.graph.clear();
        this.graph.lineWidth = this._lineWidth;
        this.graph.strokeColor = this._lineColor;

        // 只描边，不填充
        this.graph.circle(0, 0, this._radius);
        this.graph.stroke();
    }
}


