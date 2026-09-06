# 属性公式旧方案（v1）— 存档参考

> 本文档记录 2025-06 之前使用的旧版属性公式和设计，保留以供后续扩展参考。

---

## 旧公式（v1）

### AttributeSet 运行时公式（3 层 Modifier）

```
final = (base + sum(ADD)) × (1 + sum(MULTIPLY)) × product(1 + FINAL_MULTIPLY)
```

**3 种 ModifierOp：**

| Op | 含义 | 公式位置 |
|---|---|---|
| `ADD` | 固定值加成 | 加在基础值上，被 MULTIPLY 放大 |
| `MULTIPLY` | 百分比加成 | 乘 (base + addSum) |
| `FINAL_MULTIPLY` | 最终百分比加成 | 乘最终结果 |
| `OVERRIDE` | 覆盖模式 | 最高优先级获胜，绕过公式 |

**特点：** 所有固定值（包括局外装备、局内 Buff 的 flat 加成）都先加到 base 上，再被百分比放大 — 导致 flat 加成隐性受益于所有百分比。

### 局外计算器公式（5 层 OuterBonusGroup）

```
final = ((base + baseFixed) × (1 + basePercent) + extraFixed × (1 + extraPercent)) × (1 + allPercent)
```

**5 层加成类型：**

| 层 | 字段 | 类型 | 说明 |
|---|---|---|---|
| 1 | `baseFixed` | 固定值 | 加在英雄基础值上 |
| 2 | `basePercent` | 百分比 | 乘 (base + baseFixed) |
| 3 | `extraFixed` | 固定值 | 额外固定值加成 |
| 4 | `extraPercent` | 百分比 | 乘 extraFixed |
| 5 | `allPercent` | 百分比 | 乘最终总结果 |

**特点：** 区分"基础"和"额外"的固定值/百分比，两层固定值+两层百分比+一层全局百分比，策划可以精细控制每项装备的加成归属。

### 局外→运行时映射规则

通过 `HeroEntity.applyOuterBonuses()` 将 5 层局外加成转换为 3 层 Modifier：

```
baseFixed   → ModifierOp.ADD
basePercent → ModifierOp.MULTIPLY
extraFixed  → ModifierOp.ADD
extraPercent→ ModifierOp.MULTIPLY
allPercent  → ModifierOp.FINAL_MULTIPLY
```

---

## 新公式（v2）— 当前使用

### AttributeSet 运行时公式（简化版）

```
final = [base × (1 + sum(MULTIPLY)) + sum(ADD)] × product(1 + FINAL_MULTIPLY)
```

**关键变化：** `ADD` 移到乘法外侧，固定值不再被百分比放大。

### 局外计算器公式（简化版）

```
final = base × (1 + sumPercent) + sumFlat
```

**2 层加成类型：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `flat` | 固定值 | 加在百分比计算之后 |
| `percent` | 百分比 | 乘在 base 上 |

### 修改原因

- flat 加成被百分比隐性放大 → 数值预期与效果不符
- 5 层局外 → 3 层 Modifier 的映射规则复杂难理解
- 简化后策划可直接预期"固定值+50 = 永远+50"

---

## 扩展思路（如需恢复多层结构）

若后续需要多层加成，可在 `AttributeSet` 中恢复：

1. 恢复 `FINAL_MULTIPLY` 在公式中的位置（当前仍保留 ModifierOp 枚举）
2. 在 `OuterBonusGroup` 增加字段（如 `finalPercent`）
3. `applyOuterBonuses` 增加对应转换

或使用 `OVERRIDE` 模式（优先级最高），绕过公式直接覆盖属性。
