# attr-audit —— 「属性到底生不生效」体检

一条命令，把**属性链路真跑一遍**，回答一个问题：

> 配表里给某个属性的词条，运行时真的把那个属性改了吗？

```bash
node tools/attr-audit/audit.mjs              # 直接跑
node tools/attr-audit/audit.mjs --hero 1001  # 换体检用的英雄（缺省 1002 赏金猎人）
cd tools/excel_export && npm run audit:attr   # 等价命令
```

退出码：**有「加了属性却没变」的词条 → 1**（可挂 CI）；只是表里没覆盖的属性 → 0。

## 为什么需要它

属性链路是「Modifier 贡献 → 下次读取时按 `AttributeSystem.combine` 重算」，所以
**配表写对了、代码也是对的，属性仍然可能不生效**。这个工具就是在踩到下面三类坑之后落地的：

| 坑 | 现象 | 真实案例 |
|---|---|---|
| `duration: null`（Excel 空单元格导出） | 效果**下一帧**就被判过期移除，飘字/HUD 先涨后回落 | 全部 259 条遗物的 `modifiers_inner[].duration`；见 `Modifier.normalizeDuration` |
| `percent` 打在**基础值为 0** 的属性上 | `0 × (1+v) = 0`，词条恒不生效 | 护甲 13 条 + 生命恢复 23 条（「统御头盔」护甲 +22% → 0） |
| 属性涨了但**下游判据不成立** | 暴击率涨到 14%，但暴击倍率 1.0，而 `rollCrit` 要求 `> 1` → 永远不暴击 | `attributes.json` 属性 15 base = 100 |

## 它怎么工作（不是静态扫描）

1. 用 TypeScript 的 `transpileModule` 把项目里**真实的**战斗源码编成 CJS 到系统临时目录：
   `Entity` / `AttributeSystem` / `ModifierSystem` / `Modifier` / `DamagePipeline` /
   `BattleEquipSystem` / `Tb_RelicConfig`；
2. 只给「碰 cc 表现层 / 配表容器 / 注册表」的少数依赖打桩（`StatusSystem`、`AbilitySystem`、
   `Projectile`、`AIRegistry`、`BattleContext`、`BattleConstUtil`、`EntityVisualConfig`、`TbContainer`）；
3. 用**真实配表**（`assets/resources/tb/*.json`）造英雄实体 → `RelicSystem.AddRelic(真遗物)`
   → 推进一帧 → 读 `AttributeSystem` 的**运行时值**（百分比型属性已换算成 float）；
4. 每个属性挑一件「给得最多」的遗物做这一遍，最后再单独验一次暴击（打 300 次看伤害值有几种）。

输出三段：

- **逐属性表**：`前 ⇒ 后` + ✅/❌ 判定（❌ 即「加了却没变」，会让退出码变 1）
- **暴击专项**：暴击率 / 暴击倍率 / 300 次伤害值分布
- **数据面提示**：文案里承诺了属性数值、但这一侧一个 `modifiers` 都没有的遗物（等价于
  `npm run check:affix` 的「获得后无任何效果」）

## 注意

- 打桩意味着它**不覆盖**技能/Buff/事件驱动的效果，只覆盖「属性词条」这条链；
  行为类效果请用编辑器实跑。
- 它读的是 `assets/resources/tb/*.json`（**不是** `excel/*.xlsx`），所以改完表要先
  `npm run export`（或改 JSON 后 `npm run import` 回灌），体检结果才是最新的。
- 临时编译产物写在系统临时目录，退出时删除；不需要 `npm install`（只依赖仓库里的 `typescript`）。
