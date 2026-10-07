/* @dsh-recipe
{
  "name": "wrap-grid-into-vertical-scrollview",
  "description": "把一个\"已经手工摆好的一堆卡片/格子\"的容器节点改造成**竖直滚动列表**：容器本身挂 ScrollView（只开竖向）+ 可选四边 Widget 对齐，下面补 view（Mask 剪裁）与 content（GRID 版式、按列数自动换行、容器高自增）两层，并把原有子节点整体挪进 content。幂等：重复跑只覆盖参数、不重复建节点/组件。⚠ Mask 挂 view 不挂容器本体（同节点会让子树在编辑态被裁没）；新建容器节点要显式设 UI_2D 层",
  "context": "scene",
  "params": {
    "listPath": "容器节点的**完整节点路径**（如 should_hide_in_hierarchy/View_Shop/ad_list）",
    "width": "滚动视区宽（content 宽同值，GRID 按它算列宽）",
    "height": "滚动视区高（Mask 与 ScrollView.view 都取这个）",
    "columns": "每行几格（GRID constraintNum；1 = 一列式竖排）",
    "spacingX": "列间距",
    "spacingY": "行间距",
    "top": "Widget 上边距（传 null 表示不碰 Widget）",
    "bottom": "Widget 下边距（口径：想停在某个兄弟卡片之上，就填 卡片的 _bottom + 卡片高 + 想要的缝）",
    "left": "Widget 左边距",
    "right": "Widget 右边距"
  },
  "returns": "{ listPath, contentChildren, contentHeight, layout, listComps, viewComps, listRect, cells } —— 改造后的契约快照（contentHeight 是版式算出来的真实高，cells 是各条目的左/下边界，用来核\"下沿没越界\")",
  "createdAt": "2026-10-06T12:40:37.104Z",
  "verifiedAt": "2026-10-06T12:40:41.054Z"
}
*/
const list = nodeByPath(args.listPath);
if (!list) throw new Error('找不到列表容器：' + args.listPath);
const T = (n) => n.getComponent(cc.UITransform) || n.addComponent(cc.UITransform);
const mk = (name, parent) => { let n = parent.getChildByName(name); if (!n) { n = new cc.Node(name); n.parent = parent; } n.layer = cc.Layers.Enum.UI_2D; T(n); return n; };

// 已经被改造过的容器：只认 view/content 两层是自己建的，其余子节点都当"条目"
const cells = list.children.filter((c) => ['view', 'content'].indexOf(c.name) < 0);
const view = mk('view', list);
const content = mk('content', view);

T(list).setAnchorPoint(0.5, 1); T(list).setContentSize(args.width, args.height);
T(view).setAnchorPoint(0.5, 1); T(view).setContentSize(args.width, args.height); view.setPosition(0, 0);
T(content).setAnchorPoint(0.5, 1); T(content).setContentSize(args.width, 0); content.setPosition(0, 0);
for (const c of cells) if (c.parent !== content) c.setParent(content);

const layout = content.getComponent(cc.Layout) || content.addComponent(cc.Layout);
layout.type = cc.Layout.Type.GRID;
layout.resizeMode = cc.Layout.ResizeMode.CONTAINER;
layout.constraint = cc.Layout.Constraint.FIXED_COL;
layout.constraintNum = args.columns;
layout.startAxis = cc.Layout.AxisDirection.HORIZONTAL;
layout.verticalDirection = cc.Layout.VerticalDirection.TOP_TO_BOTTOM;
layout.horizontalDirection = cc.Layout.HorizontalDirection.LEFT_TO_RIGHT;
layout.spacingX = args.spacingX; layout.spacingY = args.spacingY;
layout.paddingLeft = 0; layout.paddingRight = 0; layout.paddingTop = 0; layout.paddingBottom = 0;

const sv = list.getComponent(cc.ScrollView) || list.addComponent(cc.ScrollView);
sv.horizontal = false; sv.vertical = true; sv.elastic = true; sv.inertia = true;
sv.brake = 0.75; sv.cancelInnerEvents = true; sv.content = content;

// ⚠ Mask 挂 \`view\` 上，**不是**挂 list 上（同节点会让整棵子树在编辑态被裁没，见 skill 坑 14）
const staleMask = list.getComponent(cc.Mask); if (staleMask) staleMask.destroy();
const staleG = list.getComponent(cc.Graphics); if (staleG) staleG.destroy();
const mask = view.getComponent(cc.Mask) || view.addComponent(cc.Mask);
mask.type = cc.MaskType.GRAPHICS_RECT; mask.inverted = false;

// 四边对齐（想让它"下沿停在某个兄弟卡片之上"，bottom 就填那个卡片的上沿再留点缝）
const w = list.getComponent(cc.Widget);
if (w && args.top !== null && args.top !== undefined) {
    w.isAlignTop = true; w.isAlignLeft = true; w.isAlignRight = true; w.isAlignBottom = true;
    w.top = args.top; w.bottom = args.bottom; w.left = args.left; w.right = args.right;
    w.updateAlignment();
}
layout.updateLayout(true);

const canvas = list.parent;
return {
    listPath: args.listPath,
    contentChildren: content.children.map((c) => c.name),
    contentHeight: T(content).height,
    layout: { columns: layout.constraintNum, spacingX: layout.spacingX, spacingY: layout.spacingY },
    listComps: list.components.map((c) => c.constructor.name),
    viewComps: view.components.map((c) => c.constructor.name),
    listRect: worldRect(list, { root: canvas }),
    cells: content.children.map((c) => { const r = worldRect(c, { root: canvas }); return [c.name, r.left, r.bottom]; }),
};
