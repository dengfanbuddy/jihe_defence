# prefab-diff —— 预制件 / 场景的「语义 diff」

回答一个问题：**「这次改动，我到底动了哪些节点和字段？」**

```bash
node tools/prefab-diff/diff.mjs assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab
# 旧侧缺省 = git HEAD 里的同一路径。在 tools/excel_export 里跑也认（路径先按当前目录、再按工程根解析）：
cd tools/excel_export && npm run diff:prefab -- ../../assets/resources/prefabs/ui/scenes/scene_menu/Scene_Menu.prefab
```

> ⚠ **带旗标时别走 npm**：本机 npm 会把 `--b` / `--path` / `--gate` 当成它自己的配置吃掉
> （`npm warn Unknown cli config "--b"`，与 AGENTS.md 里 `json2excel --force` 同一个坑）⇒
> `npm run diff:prefab` 只适合**裸位置参数**，要加旗标就直接 `node tools/prefab-diff/diff.mjs …`。

## 为什么不用别的判据

| 判据 | 对 `Scene_Menu.prefab` 的实测（838 KB / 48069 行，实际只多了 1 个组件、改了 2 个节点名 + 4 个字段） | 结论 |
|---|---|---|
| 字节级相等 | 逐字节比 —— 排版/下标一动就红，且**永远看不见「引用指到了哪个节点」** | 只配用在「确定性重放」（如 `tools/hit-feel-sfx/render.mjs --check`） |
| `git diff`（行级） | **1173 个 hunk、+1224 / −1185 行**，其中 **1147 个新增行是 `__id__` 重编号** | 快，但判据太糙，读不动 |
| 本脚本（语义） | **≈75 ms**（实测 57~95）：新增 0 / 删除 0 / **改名 2** / 实质改动 4 处 / 噪声 0 | 就是给这个用的 |

为什么文本级在这份文件上必然废：预制件是**扁平数组 + 按下标 `{"__id__": n}` 互相引用** —— 往中间插一个对象，后面**所有**引用的下标都要顺移。

## 身份：`__prefab.fileId`（这是它比文本 diff 强的关键）

编辑器给每个序列化元素发一个稳定 id（这份文件 988 个）：

- **改名与移动是精确的**：`card → stage` 会报成 1 处改名（子节点 7 个跟随），而不是 16 个「删」+ 16 个「增」；
- **组件按 fileId 配对**：往中间插一个组件，不会把它后面所有组件都判成「变了」；
- 引用 `{"__id__": n}` 一律解成 `@路径`（节点）/ `#cc.Label`（组件等非节点对象）/ `uuid:…`（资源），
  指向自己或自己后代的写成 `@.` / `@./x`，并按**新侧路径**渲染 ⇒ **父节点改名不会污染子树里任何字段**；
- 脚本组件的 `__type__` 是压缩 uuid，按 `assets/**/*.ts.meta` 反查成文件名显示（`Cmp_Game.ts`），
  解不出来就原样显示（前缀匹配上的会带一个 `？`）。

## 用法

```bash
node tools/prefab-diff/diff.mjs <新文件>                # 旧侧取 git HEAD 里的同一路径（最常用）
node tools/prefab-diff/diff.mjs --a <旧> --b <新>       # 任意两份：也用来比「存盘前快照 vs 存盘后」
node tools/prefab-diff/diff.mjs <新文件> --path ui_difficulty   # 只看某棵子树（按路径**段**匹配，中间一段也行）
node tools/prefab-diff/diff.mjs <新文件> --json         # 结构化结果到 stdout，人读报告改走 stderr
node tools/prefab-diff/diff.mjs <新文件> --gate --allow 1   # 实质改动 > 1 处就退出码 1
```

退出码：`0` = 跑通（**默认差异不算失败**）· `1` = 只在 `--gate` 下且超出 `--allow` · `2` = 跑不动
（文件读不到 / 不是 Cocos 序列化数组 / 取 HEAD 失败 / 参数错）—— **"跑不动"一律算 2，绝不当成"没改动"**。

## 给别的工程用（可分发边界）

**零依赖、零业务耦合**：只 `node:fs` / `node:path` / `node:child_process`，不认识遗物/商城/难度这些名词，
只认 Cocos 3.x 的序列化格式 ⇒ 任何 Cocos 3.x 工程的 `.prefab` / `.scene` 都能比。

唯一的「工程假设」是**工程根**（用来解析相对路径与取 `git HEAD`），缺省从脚本位置推（`tools/prefab-diff/../..`），
拷到别处时用 `--root <目录>` 指明即可：

```bash
node <随便放哪>/diff.mjs --root /path/to/其他工程 assets/resources/prefabs/x.prefab
```

实测：把 `diff.mjs` 拷到工程的**另一层目录**再用 `--root <工程>` 指回来，输出与原地跑逐字一致；
反过来**不给 `--root` 又放错位置**时，它以退出码 `2` 明说「`git: not a git repository`」——
**不会**悄悄拿别的文件当基线（"跑不动"永远是 2，不是"没改动"）。

另外两处「有工程痕迹但不影响移植」的：脚本名反查读的是 `assets/**/*.ts.meta`（任何 Cocos 工程都有），
缺失时只是显示成压缩 uuid；输出是中文。**业务判据（「这个界面该有哪些节点」）不在这个工具里** —— 那是 `audit:*` 那一族的活。

## 判据口径（想质疑结论时看这里）

- **比**：节点自身除下列字段外的全部字段；每个组件的全部字段（除下表）；子节点**顺序**（UI 的 z 序就是它）；
- **不比**：`__type__` / `__prefab` / `_prefab` / `_id`（运行时生成）/ `_components` / `_children`（单列）/
  `_name`（它就是路径标签，改名由「改名」那一节报）/ `_parent`（由 `_children` 决定的回指，路径变了它必然跟着变）；
- **噪声**（单独计数、不进结论）：浮点尾数差（相对容差 `--tol`，默认 1e-9）、等长的 id 类字符串；
  实测这份文件 **0 条** —— 因为编辑器存盘是稳定的，噪声是「同一编辑器的前后两次序列化」才容易冒出来的东西。

## 已知边界

- 只认 Cocos Creator 3.x 的**扁平数组**序列化格式（`.prefab` 与 `.scene` 同格式）；
- **`.scene` 里 fileId 很稀疏**（实测 `assets/scenes/Main.scene`：20 个节点只有 5 个有）⇒ 场景文件里的改名会退化成「删 + 增」，
  这是 Cocos 的格式差异，不是工具的疏忽（头部会明说「其余按路径认」）；
- **预制件根节点没有 fileId**（Cocos 不给根节点发）⇒ 根节点改名会退化成「删根 + 增根」；
- `cc.PrefabInfo` 之类的编辑器内部对象折叠成 `#cc.PrefabInfo`，它的 `fileId`/`asset` 指针不进判据；
- 组件在节点上的**顺序进判据**（引擎按数组顺序调生命周期），这是有意为之。

## 与 `audit:*` 的分工

- **本工具 = 看差异**（这次改了什么）——不判断"改得对不对"；
- **`npm run audit:*` = 判契约**（节点名/引用路径/两态…）——那才是门禁，且它们要编译真源码 + 手写桩，**强业务耦合**；
- 两者组合起来的用法：改完预制件先 `diff:prefab` 确认「只动了我以为的那些」，再跑对应的 `audit:*` 确认契约没破。
