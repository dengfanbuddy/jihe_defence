# 怪物 / 经济数值设计模板

## A. 怪物类型设计表（units.json team=2 场景）

| 项 | 内容 |
|---|---|
| 名称 / 类型 | normal / elite / boss / gold_boss / exp_boss |
| 出现阶段 | |
| 威胁定位 | （血牛 / 高伤 / 高速 / 辅助） |

| 属性 | 设计值 | 依据 |
|---|---|---|
| HP | | 普通怪 = 英雄 DPS × TTK(1~2s)；精英 5~10×；Boss = 满配DPS×10~30s |
| 单次伤害 | | 英雄被 3~8 下击杀（英雄EHP/次数） |
| 攻速/攻击间隔 | | |
| 移速 | | 与英雄/塔交互 |
| 护甲/魔抗 | | 配合英雄伤害类型 |
| 攻击距离 | | |

**奖励表**：
| 字段 | 值 | 依据 |
|---|---|---|
| goldReward | | 普通怪 1~3；精英 10~25；Boss 30~100+ |
| expReward | | 相对该阶段升级需求占比设计 |
| rewardType | | boss/gold_boss/exp_boss |
| ai | | chase/wander/orbit/attack_stop/boss |

## B. 单局经济预算推导

```
阶段时长 × 刷怪速度 ≈ 击杀数
击杀数 × 平均单位奖励 ≈ 阶段收入（÷难度系数与时间通胀的分配）
目标抽取次数 × 均价(100+50×n) = 需求金币
```

| 阶段 | 预计击杀 | 平均金币/怪 | 阶段金币 | 目标抽取 | 预算检查 |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |

## C. 全局常量（battle_constants.json，仅当需要修改）

| 键 | 现值 | 建议 | 说明 |
|---|---|---|---|
| enemyDropGoldDefault | 1 | | |
| enemyDropExpDefault | 10 | | |
| battleExpFormulaBase/Ratio | 60/1.18 | | |
| heroExpFormulaBase/Ratio | 100/1.12 | | |
| clearRewardHeroExpBase | 80 | | |
| rewardTimeBasePerSec/Cap | 0.00067/0.4 | | |

## D. JSON 片段

```json
// units.json 追加怪物（id=?）：
{
  "id": ?, "name": "?", "team": 2,
  "base_attributes": [...],
  "attack_interval": ?,
  "goldReward": ?, "expReward": ?, "rewardType": "normal",
  "ai": { "type": "chase", "params": {} }
}
```
