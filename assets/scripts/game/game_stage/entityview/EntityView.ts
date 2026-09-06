import { _decorator, Component, Node } from 'cc';
import { Entity } from '../../battle';
const { ccclass, property } = _decorator;


@ccclass('EntityView')
export class EntityView extends Component {
    entity: Entity = null;          // 绑定逻辑实体（不回引，单向）

    /** 本 View 对应的预制件路径（对象池回收时按此路径回桶） */
    prefabPath = '';

    /** 上次同步到节点的位置（脏检查：位置没变就跳过 setPosition，省 transform 重算） */
    private _lastX = 0;
    private _lastY = 0;

    /** 表现层节点（子节点引用，可在预制件中绑定或运行时获取） */
    // @property(Node) body: Node = null;  // 预留：身体/动画节点

    /** 工厂创建后调用：绑定逻辑实体 + 记录预制件路径 + 订阅事件 */
    bind(entity: Entity, prefabPath = '') {
        this.entity = entity;
        this.prefabPath = prefabPath;
        entity.view = this;         // 反向引用（Entity 已有该字段）
        // 订阅死亡/受击事件 → 播动画/飘字
        // 初始位置同步（并记录，供 update 脏检查比对）
        this.node.setPosition(entity.position.x, entity.position.y);
        this._lastX = entity.position.x;
        this._lastY = entity.position.y;
    }

    /** 对象池回收前调用：解除引用，防止内存泄漏 */
    unbind() {
        if (this.entity) {
            this.entity.view = null; // 切断 Entity → View 反向引用
            this.entity = null;
        }
        // 若有子引用（血条/特效），一并解除
        this.node.setPosition(0, 0);
        this._lastX = 0;
        this._lastY = 0;
    }

    update(dt: number) {
        if (!this.entity || this.entity.IsDead()) return;
        const p = this.entity.position;
        // 位置没变 → 跳过 setPosition（静止怪/英雄不再每帧触发矩阵重算）
        if (p.x === this._lastX && p.y === this._lastY) return;
        // 位置同步（逻辑驱动移动，表现跟随）
        this.node.setPosition(p.x, p.y);
        this._lastX = p.x;
        this._lastY = p.y;
    }
}
