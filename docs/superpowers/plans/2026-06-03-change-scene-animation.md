# Top_ChangeScene Morphing Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a beautiful scene transition animation using Cocos Creator Graphics API with morphing shapes, progress ring, particles, and completion burst.

**Architecture:** Single Component `Top_ChangeScene` with a Graphics component and Label component. Listens to `GlobalEventMgr` for `"SCENE_LOAD_PROGRESS"` events. All drawing done in `update()` via Graphics API.

**Tech Stack:** Cocos Creator 3.x, TypeScript, Graphics API, GlobalEventMgr

---

### Task 1: Implement Top_ChangeScene Component

**File:** `assets/scripts/game/ui/top/Top_ChangeScene.ts`

- [ ] **Step 1: Write the full component implementation**

```typescript
import { _decorator, Component, Graphics, Node, Label, Color, Vec2 } from 'cc';
import { GlobalEventMgr } from '../../../platform/event/GlobalEventMgr';
const { ccclass, property } = _decorator;

// Shape vertex generators (normalized to unit circle, centered at origin)
function getTriangleVertices(rotation: number): Vec2[] {
    const verts: Vec2[] = [];
    for (let i = 0; i < 3; i++) {
        const angle = rotation + (i / 3) * Math.PI * 2 - Math.PI / 2;
        verts.push(new Vec2(Math.cos(angle), Math.sin(angle)));
    }
    return verts;
}

function getSquareVertices(rotation: number): Vec2[] {
    const verts: Vec2[] = [];
    for (let i = 0; i < 4; i++) {
        const angle = rotation + (i / 4) * Math.PI * 2 + Math.PI / 4;
        verts.push(new Vec2(Math.cos(angle), Math.sin(angle)));
    }
    return verts;
}

function getHexagonVertices(rotation: number): Vec2[] {
    const verts: Vec2[] = [];
    for (let i = 0; i < 6; i++) {
        const angle = rotation + (i / 6) * Math.PI * 2;
        verts.push(new Vec2(Math.cos(angle), Math.sin(angle)));
    }
    return verts;
}

function getCircleVertices(rotation: number, segments: number = 24): Vec2[] {
    const verts: Vec2[] = [];
    for (let i = 0; i < segments; i++) {
        const angle = rotation + (i / segments) * Math.PI * 2;
        verts.push(new Vec2(Math.cos(angle), Math.sin(angle)));
    }
    return verts;
}

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

const SHAPE_TRIANGLE = 0;
const SHAPE_SQUARE = 1;
const SHAPE_CIRCLE = 2;
const SHAPE_HEXAGON = 3;

@ccclass('Top_ChangeScene')
export class Top_ChangeScene extends Component {
    @property(Graphics)
    private graphics: Graphics = null;

    @property(Label)
    private progressLabel: Label = null;

    @property
    private morphDuration: number = 1.2; // Time per shape

    @property
    private morphTransition: number = 0.5; // Transition time between shapes

    @property
    private rotationSpeed: number = 30; // Degrees per second

    @property
    private ringRadius: number = 200;

    @property(Color)
    private mainColor: Color = new Color(103, 153, 154);

    @property(Color)
    private accentColor: Color = new Color(239, 238, 237);

    // State
    private _progress: number = 0;
    private _currentShape: number = SHAPE_TRIANGLE;
    private _nextShape: number = SHAPE_SQUARE;
    private _morphTimer: number = 0;
    private _morphFactor: number = 0; // 0~1 transition between shapes
    private _rotation: number = 0;
    private _isTransitioning: boolean = false;
    private _particles: Particle[] = [];
    private _burstParticles: BurstParticle[] = [];
    private _isCompleting: boolean = false;
    private _completionTimer: number = 0;
    private _flashAlpha: number = 0;
    private _burstDone: boolean = false;
    private _completed: boolean = false;
    private _screenW: number = 750;
    private _screenH: number = 1334;
    private _cx: number = 375;
    private _cy: number = 667;
    private _glowRadius: number = 0;

    private _shapeVertices: Vec2[][] = [];
    private _currentVerts: Vec2[] = [];

    start() {
        this._screenW = 750;
        this._screenH = 1334;
        this._cx = this._screenW / 2;
        this._cy = this._screenH / 2;

        // Init particles
        for (let i = 0; i < 8; i++) {
            this._particles.push({
                angle: (i / 8) * Math.PI * 2,
                radius: this.ringRadius + 30 + Math.random() * 40,
                speed: 30 + Math.random() * 20,
                size: 2 + Math.random() * 3,
                alpha: 0.5 + Math.random() * 0.5
            });
        }

        // Precompute shape vertices
        this._shapeVertices = [
            getTriangleVertices(0),
            getSquareVertices(0),
            getCircleVertices(0),
            getHexagonVertices(0)
        ];
        this._currentVerts = this._shapeVertices[0];

        // Update label
        if (this.progressLabel) {
            this.progressLabel.string = '0%';
        }

        // Listen for progress event
        GlobalEventMgr.ins.addNotice('SCENE_LOAD_PROGRESS', this, this.onProgress);

        // Start hidden - show(0) will reveal it
        this.node.active = false;
    }

    onDestroy() {
        GlobalEventMgr.ins.removeNotice('SCENE_LOAD_PROGRESS', this, this.onProgress);
    }

    public onProgress(progress: number) {
        this._progress = Math.max(0, Math.min(1, progress));

        if (!this.node.active) {
            this.node.active = true;
        }

        if (this.progressLabel) {
            this.progressLabel.string = `${Math.round(this._progress * 100)}%`;
        }

        if (this._progress >= 1 && !this._isCompleting) {
            this.triggerCompletion();
        }
    }

    private triggerCompletion() {
        this._isCompleting = true;
        this._completionTimer = 0;
        this._burstParticles = [];

        if (this.progressLabel) {
            this.progressLabel.string = '100%';
        }
    }

    update(dt: number) {
        if (this._completed) return;

        this._rotation += this.rotationSpeed * dt;

        // Update morphing
        if (!this._isCompleting) {
            this._morphTimer += dt;

            if (this._isTransitioning) {
                this._morphFactor += dt / this.morphTransition;
                if (this._morphFactor >= 1) {
                    this._morphFactor = 1;
                    this._isTransitioning = false;
                    this._currentShape = this._nextShape;
                    this._morphTimer = 0;
                }
            } else {
                if (this._morphTimer >= this.morphDuration) {
                    this._nextShape = (this._currentShape + 1) % 4;
                    this._isTransitioning = true;
                    this._morphFactor = 0;
                }
            }

            // Generate glow
            this._glowRadius = this.ringRadius * 0.4 + Math.sin(Date.now() * 0.003) * 5;
        }

        // Update orbiting particles
        for (const p of this._particles) {
            p.angle += p.speed * dt * 0.01;
        }

        // Update completion
        if (this._isCompleting) {
            this._completionTimer += dt;

            if (this._completionTimer < 0.3) {
                // Phase 1: shape expands
                this._glowRadius = this.ringRadius * 0.5 * (1 + this._completionTimer / 0.3 * 0.5);
            } else if (this._completionTimer < 0.8) {
                // Phase 2: burst particles
                if (!this._burstDone) {
                    this._burstDone = true;
                    for (let i = 0; i < 16; i++) {
                        const angle = (i / 16) * Math.PI * 2 + Math.random() * 0.3;
                        const speed = 200 + Math.random() * 300;
                        this._burstParticles.push({
                            x: this._cx,
                            y: this._cy,
                            vx: Math.cos(angle) * speed,
                            vy: Math.sin(angle) * speed,
                            size: 3 + Math.random() * 5,
                            alpha: 1,
                            life: 0.5 + Math.random() * 0.3,
                            maxLife: 0.5 + Math.random() * 0.3
                        });
                    }
                }

                for (const bp of this._burstParticles) {
                    bp.x += bp.vx * dt;
                    bp.y += bp.vy * dt;
                    bp.life -= dt;
                    bp.alpha = Math.max(0, bp.life / bp.maxLife);
                    bp.vx *= 0.95;
                    bp.vy *= 0.95;
                }
                this._burstParticles = this._burstParticles.filter(p => p.alpha > 0);

                // Flash starts after burst
                if (this._completionTimer > 0.5) {
                    this._flashAlpha = Math.min(1, (this._completionTimer - 0.5) / 0.2);
                }
            } else {
                // Phase 3: fade flash
                this._flashAlpha = Math.max(0, 1 - (this._completionTimer - 0.8) / 0.3);
                if (this._completionTimer >= 1.1) {
                    this._completed = true;
                    this.node.active = false;
                    this.graphics.clear();
                    this.destroy();
                    return;
                }
            }
        }

        this.draw();
    }

    private draw() {
        const g = this.graphics;
        if (!g) return;
        g.clear();

        // Draw background dim
        g.fillColor = new Color(0, 0, 0, 178); // 0.7 alpha
        g.rect(0, 0, this._screenW, this._screenH);
        g.fill();

        if (this._isCompleting && this._burstDone) {
            // Draw burst particles
            for (const bp of this._burstParticles) {
                const c = this.mainColor.clone();
                c.a = Math.round(bp.alpha * 255);
                g.fillColor = c;
                g.circle(bp.x, bp.y, bp.size);
                g.fill();
            }
        }

        if (!this._isCompleting || this._completionTimer < 0.3) {
            this.drawShape();
            this.drawProgressRing();
            this.drawParticles();
        }

        // Draw flash overlay
        if (this._flashAlpha > 0) {
            g.fillColor = new Color(255, 255, 255, Math.round(this._flashAlpha * 255));
            g.rect(0, 0, this._screenW, this._screenH);
            g.fill();
        }
    }

    private getInterpolatedVertices(): Vec2[] {
        // Get vertices from current and next shape, interpolate
        const fromIdx = this._currentShape;
        const toIdx = this._nextShape;
        const from = this._shapeVertices[fromIdx];
        const to = this._shapeVertices[toIdx];
        const t = this._isTransitioning ? this._morphFactor : 0;

        if (!this._isTransitioning) {
            return from;
        }

        // Align vertex counts by repeating the smaller one
        const maxVerts = Math.max(from.length, to.length);
        const result: Vec2[] = [];

        for (let i = 0; i < maxVerts; i++) {
            const f = from[i % from.length];
            const tgt = to[i % to.length];
            result.push(new Vec2(
                f.x + (tgt.x - f.x) * t,
                f.y + (tgt.y - f.y) * t
            ));
        }

        return result;
    }

    private drawShape() {
        const g = this.graphics;
        const verts = this.getInterpolatedVertices();
        const radius = this.ringRadius * 0.45;
        const rotRad = this._rotation * Math.PI / 180;

        // Draw glow (outer)
        const glowColor = this.mainColor.clone();
        glowColor.a = 30;
        g.fillColor = glowColor;
        g.circle(this._cx, this._cy, this._glowRadius + 10);
        g.fill();

        // Draw shape
        g.lineWidth = 3;
        g.strokeColor = this.mainColor;
        g.fillColor = new Color(
            this.mainColor.r,
            this.mainColor.g,
            this.mainColor.b,
            40
        );

        const firstV = verts[0];
        g.moveTo(
            this._cx + firstV.x * radius,
            this._cy + firstV.y * radius
        );

        for (let i = 1; i < verts.length; i++) {
            const v = verts[i];
            g.lineTo(
                this._cx + v.x * radius,
                this._cy + v.y * radius
            );
        }
        g.close();
        g.fill();
        g.stroke();

        // Draw edge glow (slightly larger semi-transparent copy)
        g.lineWidth = 6;
        const edgeGlow = this.mainColor.clone();
        edgeGlow.a = 50;
        g.strokeColor = edgeGlow;

        g.moveTo(
            this._cx + firstV.x * radius,
            this._cy + firstV.y * radius
        );
        for (let i = 1; i < verts.length; i++) {
            const v = verts[i];
            g.lineTo(
                this._cx + v.x * radius,
                this._cy + v.y * radius
            );
        }
        g.close();
        g.stroke();
    }

    private drawProgressRing() {
        const g = this.graphics;
        const r = this.ringRadius;
        const angle = this._progress * Math.PI * 2;

        // Background ring
        g.lineWidth = 4;
        g.strokeColor = new Color(255, 255, 255, 30);
        g.circle(this._cx, this._cy, r);
        g.stroke();

        // Progress arc
        if (angle > 0) {
            g.lineWidth = 4;
            g.strokeColor = this.mainColor;
            g.arc(this._cx, this._cy, r, -Math.PI / 2, -Math.PI / 2 + angle, 100);
            g.stroke();

            // End dot
            const endX = this._cx + r * Math.cos(-Math.PI / 2 + angle);
            const endY = this._cy + r * Math.sin(-Math.PI / 2 + angle);
            g.fillColor = this.mainColor;
            g.circle(endX, endY, 5);
            g.fill();
        }
    }

    private drawParticles() {
        const g = this.graphics;
        const rotRad = this._rotation * Math.PI / 180;

        for (const p of this._particles) {
            const x = this._cx + Math.cos(p.angle + rotRad) * p.radius;
            const y = this._cy + Math.sin(p.angle + rotRad) * p.radius;
            const c = this.mainColor.clone();
            c.a = Math.round(p.alpha * 200);
            g.fillColor = c;
            g.circle(x, y, p.size);
            g.fill();
        }
    }
}
```

- [ ] **Step 2: Verify the component**

Run: `npx tsc --noEmit` (or check in Cocos Creator that the script compiles)

- [ ] **Step 3: Commit**

```bash
git add assets/scripts/game/ui/top/Top_ChangeScene.ts
git commit -m "feat: implement morphing scene transition animation with Graphics"
```
