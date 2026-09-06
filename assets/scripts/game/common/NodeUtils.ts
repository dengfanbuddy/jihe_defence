
import { Node, Sprite, SpriteFrame, Material, UIRenderer, Label, Mask, Graphics, builtinResMgr } from 'cc';

export class NodeUtils {


    static setGray(node: Node, isGray: boolean): void {

        if (node == null || node.isValid == false) {

            return;

        }

        let material: Material = builtinResMgr.get(isGray ? "ui-sprite-gray-material" : "");

        let renders = node.getComponentsInChildren(UIRenderer);

        for (let i = 0; i < renders.length; i++) {

            renders[i].customMaterial = material;

        }

    }
}