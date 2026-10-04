# .dsh-mcp —— dsh_chat 的 recipe 存放处

这里存的是**跑通过、且以后还能再用一次的可执行代码**（recipe），不是文档。

- 每条 recipe 一个 `.js` 文件，元数据内嵌在文件头的 `/* @dsh-recipe {…} */` 里。
- 代码体与 `cocos_execute_code` 里写的代码**完全同构**：顶层可 `return` / `await`，`args` 是入参。
- AI 侧入口（都是沙箱里的助手，不是独立工具）：
  `findRecipes(关键词?)` / `readRecipe(name)` / `saveRecipe(name, code, meta?)` /
  `runRecipe(name, args?)` / `deleteRecipe(name)`。

## 存进来的门槛（复用门禁）

`saveRecipe` 会**拒绝**「一次探索的记录」，只收「以后还能再用一次」的代码：

- 必填 `description`（这段代码干什么）与 `returns`（复用它能看到什么）；
- `params` 声明的每个键，代码里必须真的用到 `args.<键>`；
- 代码里不许有具体 uuid、绝对路径、`.tmp/` 这类一次性值（应当走 `args`）；
- 名字里不许带日期/时间戳；
- **名字按「形状」而不是「用途」**（`build-subtabbed-list-page` ✅ / `build-login-ui-tree` ❌）——
  名字就是索引，用途化的名字换个场景就检索不到；
- **换个参数还得能跑，而且能说出 ≥2 个"形状相同、用途不同"的未来调用点** ——
  说不出就说明它是「这次探索的记录」，该 `return` 出来而不是存成 recipe。

**建议入库**（跟着工程走，团队共享）。不想共享就把它加进 `.gitignore`。

为什么不做一个「工程知识库 JSON」：过期的事实比没有事实更糟，而过期的代码会当场报错。
工程专有的流程与坑点请写进 `.agents/skills/`，那里人能策展、能 review。
