import { _decorator, Color, Label, Node, ProgressBar } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { DataCenter } from '../../../../data';
import type { IPlayerInfo } from '../../../../data';
import { Tabs } from 'db://assets/scripts/platform/ui/Tabs';
const { ccclass, property } = _decorator;


@ccclass('Cmp_FuncTabs')
export class Cmp_FuncTabs extends Tabs {


    selectFontColor: Color = new Color("FFFFFF")
    unSelectFontColor: Color = new Color("354047")

    protected applyTabSelected(tab: Node, index: number, selected: boolean): void {
        let bgNode = tab.getChildByName("active_bg")
        let labelCmp = tab.getChildByName("name").getComponent(Label)
        if (selected) {
            bgNode.active = true
            labelCmp.color = this.selectFontColor
            return
        }
        bgNode.active = false
        labelCmp.color = this.unSelectFontColor
    }

    // ────────────── 刷新（只读数据 → 写 UI） ──────────────

}
