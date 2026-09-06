import { _decorator, Component, Graphics, Node, Label, Color, Vec2, UITransform, Tween, tween } from 'cc';
import { GlobalEventMgr } from '../../../platform/event/GlobalEventMgr';
import BaseView from '../../../platform/ui/BaseView';
import { ViewLayer } from '../../../platform/ui/ViewInfo';
import { uiview } from '../../../platform/ui/UIDecorator';
const { ccclass, property } = _decorator;

interface Particle {
    angle: number;
    radius: number;
    speed: number;
    size: number;
    alpha: number;
}

interface BurstParticle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    size: number;
    alpha: number;
    life: number;
    maxLife: number;
}

/** 生成正N边形顶点（单位圆上，逆时针） */
function makeRegularVertices(n: number, rotation: number): Vec2[] {
    const verts: Vec2[] = [];
    const start = rotation - Math.PI / 2;
    for (let i = 0; i < n; i++) {
        const a = start + (i / n) * Math.PI * 2;
        verts.push(new Vec2(Math.cos(a), Math.sin(a)));
    }
    return verts;
}

/** 生成圆形近似顶点 */
function makeCircleVertices(segments: number, rotation: number): Vec2[] {
    return makeRegularVertices(segments, rotation);
}

/** 将两个顶点数组对齐到相同数量 */
function alignVertices(a: Vec2[], b: Vec2[]): [Vec2[], Vec2[]] {
    const maxLen = Math.max(a.length, b.length);
    const va: Vec2[] = [];
    const vb: Vec2[] = [];
    for (let i = 0; i < maxLen; i++) {
        va.push(a[i % a.length]);
        vb.push(b[i % b.length]);
    }
    return [va, vb];
}

@uiview({
    prefabPath: 'prefabs/ui/Top_ChangeScene', // 预制件路径
    layer: ViewLayer[ViewLayer.Top], // 所属层级
    single:true,//是否是单例，单例的话只能有一个当前视图存在
})
@ccclass('Top_ChangeScene')
export class Top_ChangeScene extends BaseView<null,null> {
    @property(Graphics)
    private graphics: Graphics = null;

    /** 形态停留时间（秒） */
    @property
    private morphHold: number = 1.2;

    /** 形态过渡时间（秒） */
    @property
    private morphLerp: number = 0.5;

    /** 旋转速度（度/秒） */
    @property
    private rotateSpeed: number = 25;

    /** 外圈半径 */
    @property
    private ringRadius: number = 200;

    @property(Color)
    private mainColor: Color = new Color(103, 153, 154);

    @property(Color)
    private accentColor: Color = new Color(239, 238, 237);

    // ---- 内部状态 ----
    private _progress: number = 0;
    private _currentIdx: number = 0;
    private _nextIdx: number = 1;
    private _morphT: number = 0;
    private _morphTimer: number = 0;
    private _transitioning: boolean = false;
    private _rotation: number = 0;

    private _particles: Particle[] = [];
    private _burstParticles: BurstParticle[] = [];

    private _completing: boolean = false;
    private _compTimer: number = 0;
    private _flashAlpha: number = 0;
    private _burstSpawned: boolean = false;
    private _done: boolean = false;

    private _shapePool: Vec2[][] = [];
    private _label: Label = null;
    private _w: number = 750;
    private _h: number = 1334;
    private _cx: number = 0;
    private _cy: number = 0;
    /** 是否已完成一次性初始化（label、粒子、事件监听等） */
    private _initDone: boolean = false;

    /** tween 缓动用的代理对象 */
    private _progressProxy: { value: number } = { value: 0 };

    // ---- 生命周期 ----

    start() {
        this.doInit();
    }

    activate() {
        this.doInit();
    }

    /** 初始化/重置动画状态。UIManager 可在创建节点后直接调用。 */
    public doInit() {
        // 重置状态
        this._done = false;
        this._completing = false;
        this._progress = 0;
        this._morphTimer = 0;
        this._morphT = 0;
        this._transitioning = false;
        this._currentIdx = 0;
        this._nextIdx = 1;
        this._rotation = 0;
        this._compTimer = 0;
        this._flashAlpha = 0;
        this._burstSpawned = false;
        this._burstParticles = [];
        this._progressProxy.value = 0;
        if (this.progressTween) {
            this.progressTween.stop();
            this.progressTween = null;
        }

        // 一次性初始化（label、粒子、事件监听等）
        if (this._initDone) return;
        this._initDone = true;

        const uiTrans = this.node.getComponent(UITransform);
        if (uiTrans) {
            this._w = uiTrans.width;
            this._h = uiTrans.height;
        }
        // 本地坐标系：anchor (0.5,0.5) 使 (0,0) 为中心
        this._cx = 0;
        this._cy = 0;

        // 预计算四个形态的顶点（相对偏移，中心为原点）
        const r = this.ringRadius * 0.45;
        this._shapePool = [
            makeRegularVertices(3, 0).map(v => new Vec2(v.x * r, v.y * r)),
            makeRegularVertices(4, Math.PI / 4).map(v => new Vec2(v.x * r, v.y * r)),
            makeCircleVertices(24, 0).map(v => new Vec2(v.x * r, v.y * r)),
            makeRegularVertices(6, 0).map(v => new Vec2(v.x * r, v.y * r)),
        ];

        // 创建 Label 子节点显示百分比
        const labelNode = new Node('ProgressLabel');
        this._label = labelNode.addComponent(Label);
        this._label.string = '0%';
        this._label.fontSize = 48;
        this._label.lineHeight = 56;
        this._label.color = this.accentColor;
        labelNode.setParent(this.node);
        labelNode.setPosition(0, 0, 0);
        // labelNode.setPosition(0, -this.ringRadius * 0.2, 0);
        const labelUi = labelNode.getComponent(UITransform);
        if (labelUi) labelUi.setContentSize(200, 60);

        // 初始化粒子
        for (let i = 0; i < 8; i++) {
            this._particles.push({
                angle: (i / 8) * Math.PI * 2,
                radius: this.ringRadius + 25 + Math.random() * 45,
                speed: 20 + Math.random() * 25,
                size: 2 + Math.random() * 3,
                alpha: 0.4 + Math.random() * 0.6,
            });
        }

        // 监听全局加载进度事件
        GlobalEventMgr.ins.addNotice('SCENE_LOAD_PROGRESS', this, this.onProgress);
    }

    onDestroy() {
        GlobalEventMgr.ins.removeNotice('SCENE_LOAD_PROGRESS', this, this.onProgress);
    }

    // ---- 事件回调 ----
    progressTween: Tween = null;
    public onProgress(progress: number) {
        const target = Math.max(0, Math.min(1, progress));

        // 已完成或正在完成，不再响应进度
        if (this._done || this._completing) return;

        // 停止上次 tween
        if (this.progressTween) {
            this.progressTween.stop();
            this.progressTween = null;
        }

        const currentVal = this._progressProxy.value;
        const delta = Math.abs(target - currentVal);
        const duration = Math.max(0.5 * delta, 0.1);

        this.progressTween = tween(this._progressProxy)
            .to(duration, { value: target }, {
                onUpdate: () => {
                    this._progress = this._progressProxy.value;
                    if (this._label) {
                        this._label.string = `${Math.round(this._progress * 100)}%`;
                    }
                },
            })
            .call(() => {
                this._progress = target;
                if (this._label) {
                    this._label.string = `${Math.round(target * 100)}%`;
                }
                // 数值到达目标后才检测是否完成
                if (target >= 1 && !this._completing) {
                    this._startCompletion();
                }
            })
            .start();
    }

    // ---- 完成动画 ----

    private _startCompletion() {
        this._completing = true;
        this._compTimer = 0;
        this._burstSpawned = false;
        if (this._label) this._label.string = '100%';
        this.node.active = false
    }

    // ---- 每帧更新 ----

    update(dt: number) {
        if (this._done) return;

        this._rotation += this.rotateSpeed * dt;

        if (!this._completing) {
            // 加载阶段：循环形态变换
            this._updateMorph(dt);
            this._updateParticles(dt);
        } else {
            this._updateCompletion(dt);
        }

        this._draw();
    }

    // ---- 子更新 ----

    private _updateMorph(dt: number) {
        this._morphTimer += dt;

        if (this._transitioning) {
            this._morphT += dt / this.morphLerp;
            if (this._morphT >= 1) {
                this._morphT = 1;
                this._transitioning = false;
                this._currentIdx = this._nextIdx;
                this._morphTimer = 0;
            }
        } else {
            if (this._morphTimer >= this.morphHold) {
                this._nextIdx = (this._currentIdx + 1) % 4;
                this._transitioning = true;
                this._morphT = 0;
            }
        }
    }

    private _updateParticles(_dt: number) {
        for (const p of this._particles) {
            p.angle += p.speed * _dt * 0.01;
        }
    }

    private _updateCompletion(dt: number) {
        this._compTimer += dt;
        const t = this._compTimer;

        // Phase 1 (0~0.3s): 图形膨胀（在 draw 中通过 compTimer < 0.3 控制）
        // Phase 2 (0.3~0.8s): 爆破碎片飞散 + 闪光渐入
        if (!this._burstSpawned && t >= 0.3) {
            this._burstSpawned = true;
            for (let i = 0; i < 20; i++) {
                const a = (i / 20) * Math.PI * 2 + Math.random() * 0.4;
                const speed = 180 + Math.random() * 350;
                this._burstParticles.push({
                    x: this._cx,
                    y: this._cy,
                    vx: Math.cos(a) * speed,
                    vy: Math.sin(a) * speed,
                    size: 2 + Math.random() * 5,
                    alpha: 1,
                    life: 0.5 + Math.random() * 0.4,
                    maxLife: 0.5 + Math.random() * 0.4,
                });
            }
        }

        for (const bp of this._burstParticles) {
            bp.x += bp.vx * dt;
            bp.y += bp.vy * dt;
            bp.life -= dt;
            bp.alpha = Math.max(0, bp.life / bp.maxLife);
            bp.vx *= 0.96;
            bp.vy *= 0.96;
        }
        this._burstParticles = this._burstParticles.filter(p => p.alpha > 0);

        // 闪光控制
        if (t < 0.8) {
            this._flashAlpha = Math.max(0, (t - 0.3) / 0.3);
        } else {
            this._flashAlpha = Math.max(0, 1 - (t - 0.8) / 0.4);
        }

        // Phase 3 (0.8~1.2s): 闪光渐隐 → 结束
        if (t >= 1.2) {
            this._done = true;
            this.graphics.clear();
            this.node.active = false;
            this.destroy();
        }
    }

    // ---- 主绘制 ----

    private _draw() {
        const g = this.graphics;
        if (!g) return;
        g.clear();

        // 1. 实心黑底背景
        g.fillColor = new Color(0, 0, 0, 255);
        g.rect(-this._w / 2, -this._h / 2, this._w, this._h);
        g.fill();

        if (this._completing) {
            // 绘制爆破碎片
            for (const bp of this._burstParticles) {
                const c = this.mainColor.clone();
                c.a = Math.round(bp.alpha * 255);
                g.fillColor = c;
                g.circle(bp.x, bp.y, bp.size);
                g.fill();
            }
        }

        // 加载阶段 或 完成阶段前 0.3s 仍绘制图形
        if (!this._completing || this._compTimer < 0.3) {
            this._drawShape();
            this._drawRing();
            this._drawParticles();
        }

        // 全屏闪光
        if (this._flashAlpha > 0) {
            g.fillColor = new Color(255, 255, 255, Math.round(this._flashAlpha * 255));
            g.rect(-this._w / 2, -this._h / 2, this._w, this._h);
            g.fill();
        }
    }

    // ---- 绘制子元素 ----

    /** 获取当前帧插值后的顶点列表 */
    private _getMorphedVertices(): Vec2[] {
        if (!this._transitioning) {
            return this._shapePool[this._currentIdx];
        }
        const from = this._shapePool[this._currentIdx];
        const to = this._shapePool[this._nextIdx];
        const [a, b] = alignVertices(from, to);
        const t = this._morphT;
        // ease-in-out 缓动
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        return a.map((v, i) => {
            const tv = b[i];
            return new Vec2(v.x + (tv.x - v.x) * ease, v.y + (tv.y - v.y) * ease);
        });
    }

    private _drawShape() {
        const g = this.graphics;
        const verts = this._getMorphedVertices();
        if (verts.length < 2) return;

        const cx = this._cx;
        const cy = this._cy;

        // 外发光圆
        const glowR = this.ringRadius * 0.45;
        g.fillColor = new Color(this.mainColor.r, this.mainColor.g, this.mainColor.b, 25);
        g.circle(cx, cy, glowR + 12);
        g.fill();

        // 图形填充
        const first = verts[0];
        g.moveTo(cx + first.x, cy + first.y);
        for (let i = 1; i < verts.length; i++) {
            const v = verts[i];
            g.lineTo(cx + v.x, cy + v.y);
        }
        g.close();
        g.fillColor = new Color(this.mainColor.r, this.mainColor.g, this.mainColor.b, 35);
        g.fill();

        // 外描边（发光效果）
        g.lineWidth = 6;
        const glowColor = this.mainColor.clone();
        glowColor.a = 50;
        g.strokeColor = glowColor;
        g.moveTo(cx + first.x, cy + first.y);
        for (let i = 1; i < verts.length; i++) {
            const v = verts[i];
            g.lineTo(cx + v.x, cy + v.y);
        }
        g.close();
        g.stroke();

        // 内描边（主色实线）
        g.lineWidth = 2.5;
        g.strokeColor = this.mainColor;
        g.moveTo(cx + first.x, cy + first.y);
        for (let i = 1; i < verts.length; i++) {
            const v = verts[i];
            g.lineTo(cx + v.x, cy + v.y);
        }
        g.close();
        g.stroke();
    }

    private _drawRing() {
        const g = this.graphics;
        const cx = this._cx;
        const cy = this._cy;
        const r = this.ringRadius;

        // 背景圆环
        g.lineWidth = 3;
        g.strokeColor = new Color(255, 255, 255, 25);
        g.circle(cx, cy, r);
        g.stroke();

        // 进度弧
        const angle = this._progress * Math.PI * 2;
        if (angle > 0.01) {
            g.lineWidth = 4;
            g.strokeColor = this.mainColor;
            g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + angle, false);
            g.stroke();

            // 进度终点小圆点
            const ex = cx + r * Math.cos(-Math.PI / 2 + angle);
            const ey = cy + r * Math.sin(-Math.PI / 2 + angle);
            g.fillColor = this.mainColor;
            g.circle(ex, ey, 5);
            g.fill();
        }
    }

    private _drawParticles() {
        const g = this.graphics;
        const rad = this._rotation * Math.PI / 180;

        for (const p of this._particles) {
            const x = this._cx + Math.cos(p.angle + rad) * p.radius;
            const y = this._cy + Math.sin(p.angle + rad) * p.radius;
            const c = this.mainColor.clone();
            c.a = Math.round(p.alpha * 200);
            g.fillColor = c;
            g.circle(x, y, p.size);
            g.fill();
        }
    }
}
