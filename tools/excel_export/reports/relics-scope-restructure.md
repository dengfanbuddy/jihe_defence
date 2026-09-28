# relics 表改造报告：一件遗物一行（restructure-relics-scope.mjs）

生成时间：2026-09-26T15:27:33.605Z

> 口径：「遗物局内局外用同一个 id、icon、品质等，只是 modifiers、描述分局内局外」。
> 规则与列定义见 `docs/配置规则_品质与词条门禁.md` §1.1，表结构见 `tools/excel_export/src/core/schema.ts` 的 relics。

## 1. 概览

| 项 | 改造前 | 改造后 |
|---|---|---|
| 行数 | 307 | 307 |
| 局内件（scope=inner） | 270 | 270 |
| 两侧都有（scope=both） | 0 | 28 |
| 仅局外（scope=outer） | 9 | 9 |
| 局外专属列 hero_id | 有（8 件英雄专属在用） | **已删除该列** |

账目：`局内件 + 两侧都有 = 改造前的局内件数`；`两侧都有 + 仅局外 = 改造前非英雄专属的局外件数`（45 - 8 删除）。

## 2. 删除：英雄专属装备 0 件（「无英雄专属」）

| 旧 id | 名称 | 品质 | code | 说明 |
|---|---|---|---|---|

> 这批装备只有局外版、没有局内对应物，且带 `hero_id` 专属归属；删除后 `code=spc_*` 与 `hero_id` 列不再存在，
> `EquipmentConfig.getHeroSpecificEquipId()` 一并删除。

## 3. 合并：0 件同一个 dota2 道具合成一行（用局内 id）

| 旧局外 id | 局外名 | 局外品质 | → 局内 id | 局内名 | 局内品质 | 判同依据 | 备注 |
|---|---|---|---|---|---|---|---|

判同依据两条，都指向同一件 dota2 道具：

- **按 slug**（局外 `code` 去前缀 ↔ 局内 `icon` 文件名）：素材站用的是 dota2 **内部代号**，与公开名偶尔不同 ——
  `d2_crystalys` → `lesser_crit.png`、`d2_battlefury` → `bfury.png`、`d2_heart_of_tarrasque` → `heart.png`、
  `d2_assault_cuirass` → `assault.png`、`d2_iron_branch` → `branches.png`、`d2_daedalus` → `greater_crit.png`；
- **按中文名**：上面 6 件正是「公开名与素材名不同」的那批，靠中文名兜底；
  28 件里 22 件 slug 先命中（其中 16 件中文名也一致），6 件只能靠中文名判同。

> 全部 28 对都做过 slug 距离复核：未匹配的 9 件与最近局内 slug 的编辑距离 ≥3 且语义无关（`apex` vs `gem` 之类），无漏配。

## 4. 新 id：仅局外的 9 件 dota2 道具（1294 起）

| 旧 id | 新 id | 名称 | 品质 | code | category | 图标 |
|---|---|---|---|---|---|---|
| 1294 | **1294** | 敏捷手套 | epic | d2_gloves_of_haste | d2_basic | 按 dota2 素材站规则补 |
| 1295 | **1295** | 可靠铁锹 | common | d2n_trusty_shovel | d2_neutral | 按 dota2 素材站规则补 |
| 1296 | **1296** | 橡木之心 | rare | d2n_oak_heart | d2_neutral | **待补（素材站无此文件）** |
| 1297 | **1297** | 附魔箭袋 | rare | d2n_enchanted_quiver | d2_neutral | 按 dota2 素材站规则补 |
| 1298 | **1298** | 贤者之石 | epic | d2n_philosophers_stone | d2_neutral | 按 dota2 素材站规则补 |
| 1299 | **1299** | 恶魔之爪 | epic | d2n_imp_claw | d2_neutral | 按 dota2 素材站规则补 |
| 1300 | **1300** | 泰坦石板 | legendary | d2n_titan_slab | d2_neutral | **待补（素材站无此文件）** |
| 1301 | **1301** | 海盗帽 | legendary | d2n_pirate_hat | d2_neutral | 按 dota2 素材站规则补 |
| 1302 | **1302** | 巅峰之器 | legendary | d2n_apex | d2_neutral | 按 dota2 素材站规则补 |

> 这 9 件没有局内版：`scope="outer"`，只有 `description_outer`/`modifiers_outer`，**不进肉鸽商店抽取池**（`ShopConfig.getRelics()` 按 scope 过滤）。

### 4.1 补上的图标 7 个（与局内 293 件同源同规则，逐个 HTTP 校验过 200 / 88×64）

- 1294 敏捷手套 → `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/gloves_of_haste.png`
- 1295 可靠铁锹 → `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/trusty_shovel.png`
- 1297 附魔箭袋 → `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enchanted_quiver.png`
- 1298 贤者之石 → `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/philosophers_stone.png`
- 1299 恶魔之爪 → `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/imp_claw.png`
- 1301 海盗帽 → `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/pirate_hat.png`
- 1302 巅峰之器 → `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/apex.png`

### 4.2 图标待补 2 个（素材站确实没有该文件，返回 404，不写死坏 URL）

- 1296 橡木之心（slug `oak_heart`）
- 1300 泰坦石板（slug `titan_slab`）

## 5. 字段映射（旧 → 新）

| 旧字段 | 新字段 | 说明 |
|---|---|---|
| `scope: "inner"` | `scope: "inner"` | 只有局内版 |
| `scope: "outer"`（有局内对应物） | `scope: "both"` | 两侧都有，**并用局内 id** |
| `scope: "outer"`（无局内对应物） | `scope: "outer"` | 只有局外版，id 改为 1294 起 |
| `description` | `description_inner`（局内行）/ `description_outer`（局外行） | 两侧各自的文案原样保留 |
| `modifiers` | `modifiers_inner` / `modifiers_outer` | 两侧各自的效果原样保留（口径都是 int ×100） |
| `code` | `code`（保留） | 由「局外专属列」升级为遗物身份列：同一件遗物一个 dota2 code |
| `category` | `category`（保留） | `d2_basic` / `d2_upgrade` / `d2_neutral`；`hero_specific` 已随英雄专属装备删除 |
| `hero_id` | **删除** | 无英雄专属 |
| `icon` | `icon`（保留） | 局内局外**共用**一张图（局外独有件按素材站规则补） |
| `rarity` / `name` / `id` | 保留 | 两侧冲突时取局内（见 §3） |

## 6. 尚未定案（本次不动）

1. **本体升级链**：`d2_basic → d2_upgrade` 的合成关系（原来靠 `code` 前缀 + `category` 表达）现在 28 件合并行只剩一个 code，
   若要落成「局外可以合成升级」，需要另加列（例如 `upgrade_to`）；当前没有这张关系表。
2. **同一件遗物的两套数值预算**：局外版给的是固定值（白/蓝档只能给固定值），局内版给的是百分比 ——
   合并成一行后，请按「同一件遗物两侧强度量级大致相当」复核一遍（局外 45 → 37 件里，5 件品质取了局内档）。
3. **局外给攻速**（数值手册 §4.3 铁律冲突）：合并后仍是 8 件（`check:affix` 逐条报警，本次不动）。

