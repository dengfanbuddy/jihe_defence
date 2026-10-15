/* @dsh-recipe
{
  "name": "create-single-node-effect-prefab",
  "description": "在场景里临时建一个单节点（UITransform + Graphics + 可选脚本组件）并另存为 .prefab 资产，然后把场景里的节点删掉；用于\"表现层要一个可编辑的预制件\"这类需求",
  "context": "scene",
  "params": {
    "url": "db://assets/.../xxx.prefab（必须给出完整文件名；目标目录要先存在）",
    "name": "预制件根节点名",
    "scriptClass": "可选，挂在根上的脚本组件类名（如 MineView）；不给就只建节点+Graphics",
    "width": "可选，UITransform 宽（默认 512；Graphics 按 UITransform 矩形被 UI 剔除，别给小了）",
    "height": "可选，UITransform 高（默认 512）",
    "parentPath": "可选，临时宿主节点的路径（默认挂场景根）",
    "layer": "可选，节点 layer（默认 UI_2D = 33554432）",
    "graphics": "可选，false = 不加 Graphics 组件"
  },
  "returns": "{ uuid, url, name, scriptClass } —— 新预制件资产的 uuid 与路径",
  "createdAt": "2026-10-13T11:49:53.205Z"
}
*/

// 在编辑器的场景里造一个"单节点表现预制件"（UI_2D + UITransform + Graphics + 可选脚本组件），
// 存成 .prefab 资产后把场景里的临时节点删掉（原节点会被替换成实例，所以必须删）。
const Cls = args.scriptClass ? cc.js.getClassByName(args.scriptClass) : null;
if (args.scriptClass && !Cls) throw new Error('脚本类未注册（脚本还没编译/重载？）：' + args.scriptClass);
const parent = args.parentPath ? nodeByPath(args.parentPath) : cc.director.getScene();
if (!parent) throw new Error('父节点不存在：' + args.parentPath);
const n = new cc.Node(args.name);
n.layer = args.layer === undefined ? cc.Layers.Enum.UI_2D : args.layer;
parent.addChild(n);
n.addComponent(cc.UITransform).setContentSize(args.width || 512, args.height || 512);
if (args.graphics !== false) n.addComponent(cc.Graphics);
if (Cls) n.addComponent(Cls);
const uuid = await cce.Prefab.createPrefabAssetFromNode(n.uuid, args.url);
if (n.isValid) n.destroy();
return { uuid, url: args.url, name: args.name, scriptClass: args.scriptClass || null };
