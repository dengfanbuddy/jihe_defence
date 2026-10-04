
import { Node, Sprite, SpriteFrame, Material, UIRenderer, Label, Mask, Graphics, builtinResMgr } from 'cc';

export class NodeUtils {


    /**
     * 整棵子树置灰 / 取消置灰（用内置的 `ui-sprite-gray-material`）。
     *
     * 为什么用**材质**而不是逐个改 `color`：Sprite 与 Label 都是 `UIRenderer`，材质一招通吃；
     * 而改 `color` 会把「品质色」这类真源覆盖掉 —— 取消置灰时就得自己记住原色再还原，
     * 每个调用方各记一份迟早会错（`ShopRiItem.baseColors` 那套就是这么来的）。
     *
     * ⚠ `isGray = false` 时**传 `null`，不要去 `builtinResMgr.get('')`**：
     * 空名字查不到资源，`get('')` 的返回值在引擎里没有契约（可能抛、也可能返回 null），
     * 而 `customMaterial = null` 是"恢复默认材质"的明确写法。
     * （2026-10 改：局外遗物图鉴是**第一个**真正调用本函数的消费方，
     *   此前它从没被跑过，「未获得 → 已获得」的复原路径也就没被验证过。）
     */
    static setGray(node: Node, isGray: boolean): void {

        if (node == null || node.isValid == false) {

            return;

        }

        let material: Material = isGray ? builtinResMgr.get("ui-sprite-gray-material") : null;

        let renders = node.getComponentsInChildren(UIRenderer);

        for (let i = 0; i < renders.length; i++) {

            renders[i].customMaterial = material;

        }

    }
}