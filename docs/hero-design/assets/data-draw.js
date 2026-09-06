/**
 * 额外技能 · 品质抽取概率（随英雄等级提升，高品质概率上升）
 * 单位 %，同品质内再按权重分配。品质：白/蓝/黄/红
 */
window.RSKILL_DRAW = [
    { band: '英雄 Lv.1-9',   white: 55, blue: 30, gold: 12, red: 3 },
    { band: '英雄 Lv.10-19', white: 40, blue: 32, gold: 20, red: 8 },
    { band: '英雄 Lv.20-29', white: 28, blue: 34, gold: 24, red: 14 },
    { band: '英雄 Lv.30',    white: 20, blue: 30, gold: 26, red: 24 }
];
window.RSKILL_QUAL_NAME = { common: '白', rare: '蓝', epic: '黄', legendary: '红' };
window.RSKILL_QUAL_CLASS = { common: 'q-white', rare: 'q-blue', epic: 'q-gold', legendary: 'q-red' };
