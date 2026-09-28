# 配表工具（tools/excel_export）

《集合防御》的配表流水线：**Excel 是编辑源**，导表工具把它编译成游戏读取的
`assets/resources/tb/*.json`。

```
excel/*.xlsx  ──npm run export──▶  assets/resources/tb/*.json  ──▶  TbRoot 加载
     ▲                                                                  │
     └──────────────── npm run import（首刷 / 回灌）────────────────────┘
```

- 无需编译：Node 24 原生执行 TypeScript（`node src/cli.ts ...`）
- 依赖只有一个：[exceljs](https://github.com/exceljs/exceljs)（读/写 xlsx）
- 表结构集中定义在 `src/core/schema.ts`，新增字段只改一处

---

## 快速开始

```bash
cd tools/excel_export
npm install                  # 首次（沙箱/无权限时可加 --cache "$env:TEMP\npm-cache"）

npm run export               # 导表：excel/*.xlsx → assets/resources/tb/*.json
npm run check                # 只校验不写盘（CI 用；Excel 与 JSON 不一致时退出码 1）
npm run import -- --force    # 反向生成表格（会覆盖表格，丢弃手工修改）
npm run verify               # 往返自检：JSON → Excel → JSON 必须无损
npm run check:shop           # 肉鸽商店抽取体检（空池/重复/费用曲线/品质分布，见下）
npm run check:affix          # 品质×词条门禁体检（违规退出码 1；--strict 警告也算失败、--limit 0 打全量）
npm run migrate:affix        # 按门禁规则迁移 units/relics（幂等；--dry-run 只出报告）
npm run fix:crit             # 暴击口径修复（属性15 base=150 + 文案承诺的暴击词条回填 + 叠加方式归一；幂等）
npm run audit:attr           # 属性生效体检：真跑一遍属性链路，看「加了属性有没有变」（见 tools/attr-audit）
npm run list                 # 列出所有表 / 字段 / 类型 / 说明
npm run typecheck            # tsc --noEmit
```

当前共 10 张表：

| 分组 | 表 |
|---|---|
| 战斗核心（6） | `units` `attributes` `abilities` `modifiers` `relics` `battle_constants` |
| 肉鸽商店（4） | `shop_constants` `shop_draw` `shop_skills` `kill_buffs` |

> **relics 表是「一件遗物一行」（2026-07）**：局内版与局外版是同一件遗物，共用 `id` / `name` / `code` / `icon` / `rarity` / `category`，
> 只有**效果与描述分两侧**（`modifiers_inner` / `description_inner` 与 `modifiers_outer` / `description_outer`），
> `scope` 说明这件遗物在哪几侧出现（`inner` 只有局内版 / `outer` 只有局外版 / `both` 两侧都有）。
> 原局外装备表 `equipments` 已并入这里（英雄专属装备已删除）。规则见 `docs/配置规则_品质与词条门禁.md` §1.1，体检命令 `npm run check:affix`。

**肉鸽商店的道具就是「遗物」的局内版**：293 件 dota2 道具（设计稿 `docs/hero-design/`）已迁移进 `relics.json`（id **1001~1293**），
而**效果是原子化的**：纯属性加成全部引用 `modifiers.json` 里**唯一一条**「属性修改」共享模板（id **1000**），
道具自己的属性类型/数值/叠加方式写在遗物条目的 `kv.attrs` 里 —— 即「一条效果模板 + 外部参数」，不为每件道具建 Modifier：

```jsonc
// relics.json
{ "id": 1001, "name": "压制之刃", "scope": "inner", "modifiers_inner": [
    { "modifier": 1000, "duration": null, "kv": { "attrs": [[3, 14, "percent"]] } } ] }
// modifiers.json（全项目唯一一条）
{ "id": 1000, "name": "属性修改", "duration": -1, "stack_mode": "none",
  "effects": [ { "type": "modify_attr", "attrs_var": "attrs" } ] }
```

迁移脚本可幂等重跑 —— 它只更新**局内版**（`id ≥ 1000`），手工遗物（id < 1000）、仅局外版（`scope="outer"`，id 1294~1302）
与两侧都有的遗物的**局外版**都原样保留：

```bash
node tools/excel_export/scripts/gen-shop-from-hero-design.ts   # 设计稿 → relics/modifiers/shop_skills/kill_buffs/shop_draw
node tools/excel_export/scripts/migrate-modifier-effects.ts    # 一次性：旧 properties/states/tick 三列 → effects（幂等）
cd tools/excel_export && npm run import -- --force --table relics,modifiers,shop_skills,kill_buffs,shop_draw
npm run export                                                 # 之后 Excel 就是唯一编辑源
npm run migrate:affix                                          # ⚠ 设计稿给的是百分比原值，重跑 gen-shop 后必须再跑一次门禁迁移
```

> `shop_constants.json`（商店规则常量）是**手写源**，脚本不读也不写它。
> 道具的**被动**（砍树/重击/光环/吃莲花/种植/传送…）需要行为实现，设计稿只给了文字，暂未落表；
> 文本保留在遗物 `description_inner` 与设计稿里，实现时再加独立的 Modifier（自带 `cd` + `effects`/`script_id`，
> 性质属主动的应走 `abilities.json`）。

---

## 表格规范

每张表一个 sheet，前 3 行是表头，第 4 行起是数据：

| 行 | 内容 | 说明 |
|---|---|---|
| 第 1 行 | **字段名** | 英文，等于 JSON 的键名；程序按它取值 |
| 第 2 行 | **类型** | `int` / `number` / `string` / …（工具以 schema 为准，此行为提示） |
| 第 3 行 | **中文说明** | 给策划看 |
| 第 4 行起 | 数据 | 一行 = 一条记录（KV 表一行 = 一个常量） |

约定：

- 首列是主键（绝大多数表是 `id`，`battle_constants` 是 `key`），主键必填且不能重复。
- **单元格留空 = 该字段不输出**（走代码默认值）；写 `null` = 输出 JSON `null`（如 `damage_type` 填 `null`）。
- 列名以 `#` 或 `_` 开头 = 备注列，导表时忽略，可以随便写。
- 不认识的列名会**报错**（防止写错列名导致数据静默丢失）。
- 枚举列（第 2 行为 `enum`）带下拉框，填了候选值以外的内容会给出警告。

### 字段类型

| 类型 | 单元格怎么写 | 导出的 JSON |
|---|---|---|
| `int` | `300` | `300` |
| `number` | `2.5` | `2.5` |
| `string` | `火枪` | `"火枪"` |
| `bool` | `1` / `0` / `true` / `是` | `true` / `false` |
| `enum` | `hero`（带下拉框） | `"hero"` |
| `json` | `[{"type":"damage","value":60}]` | 原样解析，**必须合法 JSON** |
| `anyvalue` | `100` / `def/(def+100)` / `[1,5,12,20]` | `100` / `"def/(def+100)"` / `[1,5,12,20]` |
| `attrpairs` | `1:320\|9:1.5` | `[[1,320],[9,1.5]]` |
| `floatpairs` | `1:12\|6:0.3` | `[[1,12],[6,0.3]]` |
| `modprops` | `13:0\|5:-90@slow\|6:5#add` | `[[13,0],[5,{"value":-90,"var":"slow"}],[6,{"value":5,"mode":"add"}]]`（**已无表使用**，保留兼容旧表） |
| `kvnum` | `atk:2\|critRate:0.1` | `{"atk":2,"critRate":0.1}` |
| `kvstr` | `atk:flat\|hp:percent` | `{"atk":"flat","hp":"percent"}` |
| `intarray` / `numberarray` | `12,16` 或 `12\|16` | `[12,16]` |
| `stringarray` | `fire,ice` | `["fire","ice"]` |

细节：

- 空数组要写 `[]`（写 `[]` 才会导出 `[]`，留空则是「不输出该字段」）。
- 所有简写类型都**兼容 JSON 原写法**：直接从旧 JSON 里复制 `[[1,320],[2,120]]` 粘进单元格也能识别。
- `modprops` 的 `@变量` 对应 `{"var":"slow"}`（施加时用 kv 里的值替换 value），`#叠加方式` 对应 `{"mode":"add"}`。
  该类型自「效果原子化」后**已无表使用**（`modifiers.properties` 已变成 `modifiers.effects`），保留仅为兼容旧表。
- 数值请填**纯数字**（不要写 `+2`、`2m`、`10%` 这种带单位的文本）。

### 几个容易踩的坑（数值口径）

- `units.base_attributes` 是 `[[属性id, 值]]`；**百分比型属性**（攻速 4 / 魔抗 7 / 闪避 8 / 暴率 14 / 暴伤 15 / 倍率 11~13）
  按 **100 = 100%** 填整数，其余属性填原值。
- `units.growthValues` 是**每级成长**，浮点语义（暴击 `0.005` = 0.5%/级），**不 ×100**。
- `relics.scope` 必填，取值 = **这件遗物在哪几侧出现**：`inner` 只有局内版 / `outer` 只有局外版 / `both` 两侧都有；
  两侧的效果与描述分列（`description_inner` + `modifiers_inner` / `description_outer` + `modifiers_outer`），
  `scope` 说了有某一侧就必须填那一侧（校验会拦）。身份列 `id` / `name` / `code` / `icon` / `rarity` / `category` 两侧共用。
- `relics` 的 `modifiers_inner` / `modifiers_outer` 是引用列表（`[{"modifier":1000,"duration":null,"kv":{"attrs":[[3,14,"percent"]]}}]`）。
  `duration: null` = 用 Modifier 自己的 `duration`（-1 = 永久）；`kv` 是效果的**外部参数**（模板里声明了 `attrs_var` 就必须给）。
- **`modifiers.effects` 是原子效果列表**（一个效果一件事，`properties`/`states`/`tick` 三列已废弃）：

  | type | 参数 | 含义 |
  |---|---|---|
  | `modify_attr` | `attrs`（`[[属性id, 值, 叠加方式], …]`）/ `attrs_var` | 属性贡献；`attrs_var: "attrs"` = 整张属性表由施加方 `kv.attrs` 传入 |
  | `apply_state` | `state`（`stunned`/`rooted`/`invulnerable`…）、`value` | 存活期间施加状态 |
  | `tick_damage` | `interval` / `value` / `damage_type` | 每 interval 秒造成一次伤害（DoT） |
  | `tick_heal` | `interval` / `value` | 每 interval 秒治疗一次（HoT） |
  | `tick_apply_modifier` | `interval` / `modifier` / `duration` / `chance` | 每 interval 秒施加一次别的 Modifier |

  每条周期效果**各持一个计时器**，同一 Modifier 上多条周期效果各算各的间隔。
  条目里的 `var`（`{"attr":5,"value":-90,"var":"slow"}`）表示该数值由施加时 `kv.slow` 覆盖。
- `modifiers.effects` 里 `attrs` 的**叠加方式**（`[[3, 14, "percent"]]` 的第三项，缺省 `add`）：

  | mode | 配置值口径 | 结算 |
  |---|---|---|
  | `add`（缺省） | 缩放型属性 int = 值×100；其余填原值 | `final = base + Σv`，**固定值** |
  | `percent` | **百分数**（`14` = +14%），对所有属性一视同仁 | `final = base × (1 + Σv/100)`，**对基础属性的百分比加成**，多来源加法叠加、不复利 |
  | `multiply` | **小数**（`0.14` = +14%） | `final = base × Π(1 + v)`，多来源**复利** |
  | `complement` / `best` | 同 add | 补数乘法 / 取优 |

  > `percent` 与 `multiply` 都表达「+14%」，但口径不同：`percent` 用百分数且**同类相加**（两件 +14%/+18% → ×1.32），
  > `multiply` 用小数且**逐条相乘**（→ ×1.3452）。道具/遗物的百分比加成一律用 `percent`。
  > 结算顺序：`percent` 先只乘**基础值**，`add` 固定值加在其后。
- `modifiers.cd` 是**该效果自己的冷却**（秒）：带 cd 的被动各是一条独立 Modifier，同一实体上**各算各的冷却**。
- `shop_skills.stage` 显式落列，便于单独调整某技能的出场阶段；遗物（道具）的阶段由 `rarity` 推导（白 1 / 蓝 2 / 黄 3 / 红 4）。
- `kill_buffs.attr_id` 是 AttributeType 编号（`atk`=3 / `hp`=1 / `range`=16 / `def`=6 / `aspd`=4 / `crit`=14 / `dodge`=8 / `regen`=9）。

---

## 命令详解

### `npm run export`（excel2json，导表）

```
node src/cli.ts excel2json [--table units,abilities] [--check] [--strict] [--no-cross-check]
    [--excel-dir <目录>] [--json-dir <目录>]
```

1. 读 `excel/<表名>.xlsx` → 校验表头/类型/主键 → 逐行解码
2. **跨表关联校验**：技能/属性/Modifier 的 id 引用是否存在、`effects` 动作类型与事件名是否是代码支持的
3. 全部通过才写 `assets/resources/tb/<表名>.json`（任何错误一律不写盘，避免半个脏表）

- `--check`：只校验 + 比对现有 JSON，不写盘；两者不一致时退出码 1（可挂 CI）
- `--strict`：警告也当错误
- `--no-cross-check`：跳过跨表校验（只在特殊情况下使用）

跨表校验读不到某张表时会**回退读磁盘上的 JSON**；只导部分表（`--table`）不会误报。

### `npm run import`（json2excel，生成/回灌表格）

```
node src/cli.ts json2excel [--table units] [--force]
```

由 JSON 生成 xlsx，用于**首次出表**或 **JSON 被批量改动后同步回表格**。
已存在的表格默认跳过，必须显式 `--force` 才会覆盖（覆盖会丢弃策划在表格里的手工修改）。

### `npm run verify`（往返自检）

对每张表执行 `JSON → 表格 → JSON`，深度比对是否完全一致。新增/修改字段类型后务必跑一次，
它能立刻发现「类型选错导致数据有损」（例如把带小数的属性配成 `int`、把 `[]` 当空单元格丢掉）。

### `npm run check:shop`（肉鸽商店抽取体检）

```bash
node scripts/check-shop-draw.mjs
```

用真实 `tb/shop_*.json` + `tb/relics.json` 跑批量模拟抽取（每个「阶段 × 英雄等级」2000 次），输出品质分布、
遗物(道具):技能 比例、越阶命中率、最少选项数，并检查选项重复、池子耗尽与费用曲线。退出码 1 = 有异常。

> 该脚本复刻了 `battle/ShopSystem.ts` 的抽取判定（Node 里跑不起 `cc` 依赖）；
> 改 ShopSystem 抽取逻辑时需同步脚本内的判定，否则体检结果会失真。

### `npm run list`

打印所有表、字段、类型、中文说明和必填标记，用来快速查「某个字段叫什么、什么类型」。

---

## 常见操作

### 加一个字段

1. 编辑 `src/core/schema.ts`，在对应表的 `fields` 里加一行：
   ```ts
   { key: 'newField', type: 'number', desc: '新字段说明' },
   ```
2. `npm run import -- --force` 重新生成表格（或手工在第 1/2/3 行补上这一列）
3. 在表格里填数据 → `npm run export`

### 加一张新表

1. 在 `src/core/schema.ts` 的 `TABLES` 里加一个 `TableSchema`（`jsonPath` 指向 `assets/resources/tb/xxx.json`）
2. 在 `assets/scripts/game/excel_table/` 下写一个容器类：
   ```ts
   @tb_config(':tb/xxx')
   export class XxxCfgContainer extends TbContainer<XxxCfg> { getTbName() { return 'XxxCfg'; } }
   ```
3. `npm run import` 生成空表模板 → 填数据 → `npm run export`

数组表的 JSON 顶层是数组；`format: 'kv'` 的表（如 `battle_constants`）顶层是键值对象，
表格用 `key` / `value` / `desc` 三列表达，`desc` 列是辅助列（`meta: true`）不导出。

---

## 目录结构

```
tools/excel_export/
├── excel/                  # 表格（编辑源，建议入库）
│   ├── units.xlsx  attributes.xlsx  abilities.xlsx  modifiers.xlsx
│   ├── relics.xlsx  battle_constants.xlsx
│   └── shop_constants.xlsx  shop_draw.xlsx  shop_skills.xlsx  kill_buffs.xlsx
├── scripts/
│   ├── gen-shop-from-hero-design.ts   # 设计稿 docs/hero-design → relics（含 kv.attrs）+ 共享属性模板 + shop_*.json（幂等）
│   ├── migrate-modifier-effects.ts    # 一次性：modifiers 旧 properties/states/tick 三列 → effects（幂等）
│   ├── check-shop-draw.mjs            # 抽取体检（npm run check:shop）
│   ├── lib/affix-rules.mjs            # 「品质 × 词条」门禁规则单一真源（含遗物两侧的取用帮助函数）
│   ├── check-affix-gating.mjs         # 门禁体检（npm run check:affix，逐侧检查）
│   ├── migrate-affix-gating.mjs       # 按门禁规则迁移 units/relics（npm run migrate:affix，幂等）
│   ├── fix-crit-baseline.mjs          # 暴击口径修复（npm run fix:crit，幂等：属性15 base + 词条回填 + 叠加方式）
│   └── restructure-relics-scope.mjs   # 一次性：relics 改成「一件遗物一行」（28 件合并 / 9 件接 1294~1302 / 删 8 件英雄专属）
├── src/
│   ├── cli.ts              # 命令行入口（export / import / verify / list）
│   ├── core/
│   │   ├── schema.ts       # ★ 表结构定义（新增字段改这里）
│   │   ├── types.ts        # 类型与字段定义
│   │   ├── codec.ts        # 单元格 ⇄ JSON 值 编解码
│   │   ├── excelIo.ts      # xlsx 读写、表头样式、枚举下拉框
│   │   ├── excelToJson.ts  # 导表主流程（含校验）
│   │   ├── jsonToExcel.ts  # 反向生成表格
│   │   └── crossCheck.ts   # 跨表 id 引用校验
│   └── util/               # 路径 / 报告 / JSON diff
└── package.json
```

## 注意

- 导表只覆盖 `assets/resources/tb/*.json` 的**文件内容**，不动 Cocos 的 `.meta` 文件，编辑器会正常重新导入。
- 生成的 JSON 统一为 2 空格缩进（早期 `equipments.json` 那种紧凑格式会被规整，内容不变）。
- 表格文件是二进制，git 上看不出改动内容；改动较大时建议在提交信息里说明。
- 沙箱/受限环境里 `npm install` 若报 `EPERM ... npm-cache`，加 `--cache "$env:TEMP\npm-cache"` 指定可写缓存目录即可。
