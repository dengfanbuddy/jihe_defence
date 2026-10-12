/**
 * HeroPropertiesVM —— 局内「英雄属性详情」面板的**判据与数据投影**（唯一实现）
 *
 * 这一份文件回答两件事，看完不用再去翻别的地方：
 *   ① 面板铺**哪几行**（= `attributes.json` 里定义的全部属性，按 id 升序 —— **不手抄一份清单**）
 *   ② 每行的**值从哪来**（= 出战英雄实体 `Entity.attrs`（`AttributeSystem`）的**当前值**）
 *
 * ── 为什么不复用局外的 `HeroConfig.getAttrRows` ──
 *   局外那份是"按 `units.base_attributes` + `growthValues × 等级`**算**出来的"，
 *   它在局内是**错的**：局内英雄的属性里还叠着**遗物 / 击杀商店 Buff**（`ModifierSystem` 的贡献），
 *   而 `AttributeSystem.get()` 才是那份合起来的真值。玩家在局内看到的必须是他此刻真的在用的数
 *   （否则就是"面板写着 73 攻击、打出来的不是 73"）。
 *
 * ── 为什么不在这里缓存 / 不响应式 ──
 *   属性随时会变（遗物、Buff、升级、DoT），`AttributeSystem` 每次 `get()` 自己会按脏标记重算。
 *   面板是**开着的时候取一份快照**（`snapshot()`），所以本文件是**纯函数**：
 *   给它一个英雄实体，回一份可以直接画的数据；不给就回 null（还没选英雄）。
 *
 * ── 为什么行清单从配表现读 ──
 *   `attributes.json` 是属性的唯一真源（连 `AttributeType` 枚举的编号都和它对齐）。
 *   手抄一份 12 项 / 22 项的清单，等策划加一条属性就会出现"加了却没显示"，
 *   而且两个清单迟早不一致 —— 现读就没有这个问题（预制件里行节点不够会打 warn，见 panel）。
 */

import type { Entity } from '../../../../../battle';
import { TbRoot } from '../../../../../../platform/excel_table/TbRoot';
import { AttributeCfgContainer } from '../../../../../excel_table/Tb_AttributeConfig';
import { HeroConfig } from '../../../../../data/configs/HeroConfig';

/** 面板上的一行：属性名 + **当前值**的展示文案 */
export interface HeroPropertyRowVM {
    /** 属性编号（`AttributeType`；调试/自检用） */
    attrId: number;
    /** 属性中文名（`attributes.json.name`，取不到回落 `属性 N`） */
    name: string;
    /** 当前值的展示文案（比例型属性是 `120%`，其余取整 `452`） */
    valueText: string;
}

/** 面板要画的一整份数据（打开面板那一刻的快照） */
export interface HeroPropertiesVM {
    /** 出战英雄的单位配置 id（`units.json` 的 1000 段） */
    heroId: number;
    /** 英雄名（`units.name`） */
    name: string;
    /** **局内等级**（`battleStore.level`，不是局外英雄等级） */
    level: number;
    /** 属性行（顺序 = `attributes.json` 的 id 升序） */
    rows: HeroPropertyRowVM[];
}

/**
 * 取一份「当前英雄属性」快照。
 *
 * @param hero 出战英雄实体（`Scene_Game_Stage.hero`）；**null = 还没选英雄 / 本局已作废**
 * @param level 局内等级（`battleStore.level`）
 * @returns 面板可以直接画的数据；英雄或配表还没就绪时返回 **null**（调用方据此**不打开**面板 ——
 *          宁可不开，也不要开一块写着假数据的板子）
 */
export function buildHeroPropertiesVM(hero: Entity | null, level: number): HeroPropertiesVM | null {
    if (!hero?.attrs) return null;

    const tb = attributeContainer();
    if (!tb) return null;

    const rows: HeroPropertyRowVM[] = [];
    for (const def of tb.cfgs.slice().sort((a, b) => a.id - b.id)) {
        // `AttributeSystem.get` 已经把"基础值 + 遗物/Buff 贡献 + 上下限钳制"合完了 —— 直接读它就是玩家此刻的数
        const value = hero.attrs.get(def.id);
        rows.push({
            attrId: def.id,
            name: def.name || `属性 ${def.id}`,
            // 展示口径与英雄卡 / 局外详情弹窗**同一把尺**（`HeroConfig.formatAttrValue`）：
            // 比例型属性（攻速/魔抗/闪避/暴击…见 `AttributeScaling.SCALE`）显示成百分数，其余取整
            valueText: HeroConfig.formatAttrValue(def.id, value),
        });
    }

    return {
        heroId: hero.id,
        name: hero.name || `英雄 ${hero.id}`,
        level: Math.max(1, Math.floor(level || 1)),
        rows,
    };
}

/** `attributes` 容器（表未加载完成时返回 null，不抛 —— 同 `HeroConfig` 的兜底口径） */
function attributeContainer(): AttributeCfgContainer | null {
    try {
        return TbRoot.ins.getTbContainer(AttributeCfgContainer) ?? null;
    } catch {
        return null;
    }
}
