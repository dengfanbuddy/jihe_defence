import { error } from "cc";
import { RedDotCallback, RedDotNode } from "./RedDotNode";
/**
 * ```text
1.数据结构设计：

    使用树形结构存储红点节点

    每个节点包含子节点映射（Map）

    维护激活状态和回调集合

2.核心功能实现：

    路径解析：将字符串路径转换为层级数组

    节点获取：自动创建不存在的路径节点

3.状态传播：

    子节点变化时自动更新父节点状态

    使用观察者模式通知状态变更

4.关键特性：

    自动状态更新：子节点状态变化自动影响父节点

    层级管理：支持任意深度的红点路径（如 Main/Task/Daily）

    高效查询：O(n) 时间复杂度（n 为路径深度）
```
代码示例：
```
// 系统初始化时
RedDotMgr.ins.setActive('Main/Mail', true);

// 在UI组件中
onLoad() {
    this.unsubscribe = RedDotMgr.ins.subscribe(
        'Main/Mail',
        (active) => this.mailRedDot.active = active
    );
}
//UI隐藏时
onDestroy() {
    this.unsubscribe?.();
}
//功能关闭时，移除不必要的节点，防止内存泄漏
funcClose(){
    RedDotMgr.ins.removeNode("Main")
}
```
 */
class RedDotMgr {
    private static instance: RedDotMgr;
    private root: RedDotNode = new RedDotNode("root");

    public static get ins(): RedDotMgr {
        if (!this.instance) {
            this.instance = new RedDotMgr();
        }
        return this.instance;
    }

    private parsePath(path: string): string[] {
        return path.split('/').filter(p => p.length > 0);
    }


    getNode(path: string): RedDotNode {
        let parts = this.parsePath(path);
        let node = this.root;
        
        for (const part of parts) {
            let child = node.getChild(part);
            if (!child) {
                child = node.addChild(part);
            }
            node = child;
        }
        return node;
    }

    //按路径移除节点
    removeNode(path:string){
        let nodeNames = this.parsePath(path)
        let node = this.root;
        for (let nodeName of nodeNames) {
            let child = node.getChild(nodeName)
            if(child){
                node = child
            }
        }
        if(node!=this.root){
            node.removeFromParent()
        }
    }

    setActive(path: string, isActive: boolean) {
        const node = this.getNode(path);
        node.isActive = isActive;
    }

    subscribe(path: string, callback: RedDotCallback) {
        const node = this.getNode(path);
        node.subscribe(callback);
        return () => node.unsubscribe(callback);
    }

    resolvePath(...nodeName:string[]){
        if(nodeName.length==0){
            throw new error("红点路径节点不能为空！")
        }
        let path = "";
        nodeName.forEach(n => path += "/" + n)
        // 去除首位的斜杠
        if (path.startsWith("/")) {
            path = path.substring(1);
        }
        if(path===""){
            throw new error("红点路径节点不能为空！")
        }
        return path
    }
}

// 使用示例
// export class RedDotExample {
//     private redDotSystem = RedDotSystem.Instance;

//     setup() {
//         // 订阅红点变化
//         this.redDotSystem.subscribe('Main/Task/Daily', (isActive) => {
//             this.updateTaskDailyRedDot(isActive);
//         });

//         // 触发红点变化
//         this.redDotSystem.setActive('Main/Task/Daily', true);
//     }

//     private updateTaskDailyRedDot(isActive: boolean) {
//         // 更新对应的UI表现
//         const redDotNode = find('Main/Task/Daily/RedDot');
//         redDotNode.active = isActive;
//     }
// }