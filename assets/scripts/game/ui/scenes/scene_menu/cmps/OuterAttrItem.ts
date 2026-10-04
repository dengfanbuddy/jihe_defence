import { _decorator, Label } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { formatFlatBonus, formatPercentBonus, type OuterBonusTotal } from '../../../../data/configs/EquipmentConfig';

const { ccclass, property } = _decorator;

/**
 * 「属性总览」的**一行**：一种属性在所有遗物上的加成总和。
 *
 * 两列刻意分开（**不做"合并成一个数"**）：
 *   · **固定加成**（`flat`）—— 直接加在最终值上
 *   · **百分比加成**（`percent`）—— 对**基础属性**乘算一次（`final = base × (1 + percent) + flat`）
 *
 * 为什么不合并：百分比层的实际数值取决于**哪件英雄、哪条基础属性**（`base` 不同结果就不同），
 * 合并成一个数就必须先假定一个 base —— 那是"预览某个英雄"的活，不是"总览"的活。
 * 两列直接对应数据模型的两层，永远不会与 `OuterAttributeCalculator` 的公式漂移。
 *
 * 格式化**全部走数据层**（`formatFlatBonus` / `formatPercentBonus`）：
 * 比例型属性（攻速/暴击率/闪避/暴击倍率…）的运行时值是小数（`0.2`），要显示成 `+20%`
 * —— 这个判断只该有一份实现。
 */
@ccclass('OuterAttrItem')
export class OuterAttrItem extends UIWidget {

    /** 属性名（如「最大生命」） */
    @property(Label)
    nameLabel: Label = null;

    /** 固定加成（`+450` / 比例型属性是 `+20%`；无则 `—`） */
    @property(Label)
    flatLabel: Label = null;

    /** 百分比加成（`+5%`；无则 `—`） */
    @property(Label)
    percentLabel: Label = null;

    /** 填一行数据 */
    setInfo(row: OuterBonusTotal): void {
        if (!row) return;
        if (this.nameLabel) this.nameLabel.string = row.name;
        if (this.flatLabel) this.flatLabel.string = formatFlatBonus(row.attrId, row.flat);
        if (this.percentLabel) this.percentLabel.string = formatPercentBonus(row.percent);
    }

    /**
     * 表头行专用：只写三个格子名（这一行没有数据，但共用同一个节点契约，
     * 免得为了三行字再做一个模板）。
     */
    setHeader(name: string, flat: string, percent: string): void {
        if (this.nameLabel) this.nameLabel.string = name;
        if (this.flatLabel) this.flatLabel.string = flat;
        if (this.percentLabel) this.percentLabel.string = percent;
    }
}
