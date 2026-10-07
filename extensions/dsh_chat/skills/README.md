# skills/ —— 随插件发布的通用 skill

这里放的 skill 会跟着 `dsh_chat` 插件走：**任何工程装上插件就有**，工程里不需要写任何东西。

## 怎么生效的

扩展 fork `dsh --profile cocos` 时会注入一个环境变量（见 `source/dsh-host.ts`）：

```
DSH_BUNDLED_SKILL_DIR = <扩展根>/skills
```

`@deepseek-ai/dsh-skill-filesystem` 会读它，把这个目录当成 **bundled 根**扫描
（`lib/index.js:84` 与 `:181-186`，`rank = BUNDLED_SKILL_RANK = 600`）。
之所以走环境变量而不是 `cordis.patch.yml`：配置里的路径是用 `path.resolve()` 解析的，
**相对路径会落到 dsh 进程的 cwd（= 工程根）**，写死了又变成机器相关；环境变量没有这个问题。

## 6 个 skill 根与优先级（`rank` 越小越优先）

| rank | 根 | 谁配的 |
|---|---|---|
| 100 | `<工程>/.dsh/skills` | 工程 |
| 200 | `<工程>/.agents/skills` | 工程 |
| 300 | `config.customSkillDirs` | profile |
| 400 | `$DSH_HOME/skills` | 用户 |
| 500 | `~/.agents/skills` | 用户 |
| **600** | **`DSH_BUNDLED_SKILL_DIR`（= 本目录）** | **本插件** |

## ⚠ 同名是「整体覆盖」，不是「合并」

`@deepseek-ai/dsh-skill` 的 `collectLayer`（`lib/index.js:312-326`）把候选**按 rank 升序排**，
再按名字 `seen` 去重 —— **排前面的赢**，被盖住的只打一条 warning：

```
skill "cocos-editor-ops" from <source> ignored because a higher-priority skill already exists
```

**所以工程里不要再放一个同名的 `cocos-editor-ops`** —— 那会把本目录这份的 11 条坑
**整个吃掉**（既不合并也不追加）。要写项目专有约定，**另起一个名字**（如 `mygame-ui-conventions`）。
这条已经写进 `cocos-editor-ops/SKILL.md` 的抬头，防止下一个人踩。

## 什么该放这里，什么不该

| | 判据 | 例子 |
|---|---|---|
| ✅ **放这里** | 跟**引擎版本或本插件**绑定，换项目照样成立 | `cc.find` 名字含 `/` 时静默返回 null；EditBox 把宿主节点撑成贴图尺寸；Widget 单边对齐在回写时漂移 |
| ❌ **别放这里** | 是**某个项目的取舍**，换个项目不一定成立 | 设计分辨率用 750×1334；节点命名规范；「产物不得引用 `assets/`」 |

第二条最容易走错：**项目取舍伪装成「引擎经验」是最贵的一种错事实** ——
下一个项目会毫无怀疑地照抄。落笔前问一句：**「这条换到别的项目还成立吗？」**

## 加一条新事实之前

`SKILL.md` 里每条事实都挂了一条 `<!-- fact: … | verify: … -->` 声明，由
`node scripts/verify-skill-facts.js`（或 `npm run verify:skill`）守着：

- 能算的 → `verify: script:<锚点名>`（锚点必须真跑通过）
- 只能人验的 → `verify: manual | <一句「人在哪、看什么」>`

**新增一条坑却没声明怎么验 = 门禁直接红。** 数字以门禁输出为准，别手抄
（`node scripts/verify-skill-facts.js` 现在报 **18 条声明：10 条可执行锚点 / 8 条 `manual`**）——
**manual 应该降，但不该假装是 0。**
