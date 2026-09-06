import { _decorator, Component, Node } from 'cc';
import { Projectile } from '../../battle';
const { ccclass, property } = _decorator;

/**
 * ProjectileView —— 弹道表现组件（挂在弹道预制件节点上）
 *
 * 与 EntityView 同构：逻辑 Projectile 负责位置推进（tick 内移动 position），
 * 本组件只做"位置同步 + 表现"：
 *   - update(): node.setPosition(projectile.position) 每帧跟随
 *   - 命中/到达后由 ProjectileViewPool 回收（本组件不自行销毁）
 *
 * 设计：逻辑层驱动位置（Projectile.position），表现层只读跟随。
 * 这样弹道移动可脱离场景测试/模拟，表现层可随意换皮肤不改逻辑。
 */
@ccclass('ProjectileView')
export class ProjectileView extends Component {
    projectile: Projectile = null;
    prefabPath = '';

    /** 工厂创建后调用：绑定逻辑弹道 */
    bind(projectile: Projectile, prefabPath = '') {
        this.projectile = projectile;
        this.prefabPath = prefabPath;
        // 初始位置同步（逻辑层已记录起点）
        this.node.setPosition(projectile.position.x, projectile.position.y);
    }

    /** 对象池回收前调用：解除引用 */
    unbind() {
        this.projectile = null;
        this.node.setPosition(0, 0);
    }

    update(dt: number) {
        if (!this.projectile) return;
        // 位置同步：逻辑 Projectile.tick 已推进 position，这里只跟随
        this.node.setPosition(this.projectile.position.x, this.projectile.position.y);
        void dt;
    }
}
