/**
 * 属性 int 化换算验证：配置 100=100% → 运行时 float → 消费语义不变
 * 覆盖：单位基础值 / attributes 默认 / Modifier 贡献 / 补数乘法叠加
 */
import { AttributeScaling } from './assets/scripts/game/battle/core/AttributeScaling';
import { AttributeSystem } from './assets/scripts/game/battle/AttributeSystem';
import { AttributeStackMode } from './assets/scripts/game/battle/types';
import { AttributeType } from './assets/scripts/game/battle/core/Types';

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
    console.log((cond ? '[OK] ' : '[FAIL] ') + name);
    if (cond) pass++; else fail++;
}

// 1. 映射类本身
check('魔抗缩放系数 100', AttributeScaling.scale(AttributeType.MagicResist) === 100);
check('攻速缩放系数 100', AttributeScaling.scale(AttributeType.AtkSpeed) === 100);
check('生命不缩放', AttributeScaling.scale(AttributeType.MaxHp) === 1);
check('normalize: 25 → 0.25', Math.abs(AttributeScaling.normalize(AttributeType.MagicResist, 25) - 0.25) < 1e-9);
check('normalize: 120 → 1.2', Math.abs(AttributeScaling.normalize(AttributeType.AtkSpeed, 120) - 1.2) < 1e-9);
check('normalize: 非缩放属性原样', AttributeScaling.normalize(AttributeType.MaxHp, 500) === 500);
check('denormalize: 0.25 → 25', AttributeScaling.denormalize(AttributeType.MagicResist, 0.25) === 25);

// 2. fake 属性容器（attributes.json int 化后的形态）
const attrContainer: any = {
    cfgs: [
        { id: 1, name: '最大生命', stack_mode: AttributeStackMode.Add, base: 100, min: 1, max: 99999 },
        { id: 4, name: '攻击速度', stack_mode: AttributeStackMode.Multiply, base: 100, min: 10, max: 1000 },
        { id: 7, name: '魔法抗性', stack_mode: AttributeStackMode.Complement, base: 25, min: 0, max: 95 },
        { id: 16, name: '攻击距离', stack_mode: AttributeStackMode.Add, base: 100, min: 50, max: 2000 },
    ],
    getCfgById(id: number) { return this.cfgs.find((c: any) => c.id === id); },
};

// 3. 单位基础值（units.json 改造后形态）
const attrs = new AttributeSystem(attrContainer, [
    [AttributeType.MaxHp, 500],        // 不缩放
    [AttributeType.AtkSpeed, 120],     // 1.2
    [AttributeType.MagicResist, 25],   // 0.25
    [AttributeType.AtkRange, 100],
] as any);

check('单位 hp=500 读回 500', attrs.get(AttributeType.MaxHp) === 500);
check('单位攻速 120 → 运行时 1.2', Math.abs(attrs.get(AttributeType.AtkSpeed) - 1.2) < 1e-9);
check('单位魔抗 25 → 运行时 0.25', Math.abs(attrs.get(AttributeType.MagicResist) - 0.25) < 1e-9);
check('默认魔抗 25 → 0.25', Math.abs(attrs.getBase(AttributeType.MagicResist) - 0.25) < 1e-9);

// 4. Modifier 贡献（配置 int：魔抗+20 → 0.2，补数乘法叠加）
attrs.setContributions(AttributeType.MagicResist, [
    { value: 20, order: 0 },  // 配置 int：20 = +20%
]);
const mr = attrs.get(AttributeType.MagicResist);
// base 0.25，补数叠加 +0.2 → 1 - (1-0.25)*(1-0.2) = 1 - 0.6 = 0.4
check('魔抗叠加 0.25+20% → 0.40', Math.abs(mr - 0.4) < 1e-9);

// 5. 钳制范围换算（max 95 → 0.95）
attrs.setContributions(AttributeType.MagicResist, [{ value: 200, order: 0 }]);
check('魔抗钳制 max 95 → 0.95', Math.abs(attrs.get(AttributeType.MagicResist) - 0.95) < 1e-9);

console.log('');
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
