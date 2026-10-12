/* @dsh-recipe
{
  "name": "build-collapsible-slot-row",
  "description": "在已存在的父节点下幂等搭出「折叠槽位行」：收纳按钮(圆角底+图标+箭头+计数) + 展开区(等距槽位 + 三行说明浮层)，默认收起；色/字号取 art-style token，Label 不写 lineHeight",
  "context": "scene",
  "params": {
    "rootPath": "父节点路径（nodeByPath 用）",
    "slotCount": "槽位个数",
    "cellSize": "槽位边长",
    "cellPitch": "槽位中心间距",
    "cellPadX": "首格中心 x",
    "contentW": "展开区宽",
    "contentH": "展开区高",
    "contentX": "展开区 x",
    "contentY": "展开区 y",
    "toggleSize": "收纳按钮边长",
    "toggleY": "收纳按钮 y",
    "tipW": "说明浮层宽",
    "tipH": "说明浮层高",
    "tipX": "说明浮层 x",
    "tipY": "说明浮层 y",
    "hintText": "说明浮层第三行文案",
    "roundTexture": "圆角底图 db:// 路径",
    "iconTexture": "按钮图标 db:// 路径（空串=不建）",
    "arrowTexture": "箭头图 db:// 路径（空串=不建）"
  },
  "returns": "{ root, children, cellCount }",
  "createdAt": "2026-10-09T21:06:17.178Z"
}
*/

// 在一个已存在的父节点下搭「折叠槽位行」：收纳按钮 + 展开区(等距槽位 + 说明浮层)，默认收起
const root = nodeByPath(args.rootPath);
if (!root) throw new Error('找不到父节点：' + args.rootPath);
const frames = {
    round: await loadFrame(args.roundTexture),
    icon: args.iconTexture ? await loadFrame(args.iconTexture) : null,
    arrow: args.arrowTexture ? await loadFrame(args.arrowTexture) : null,
};
const COL = {
    accent: new cc.Color(103, 153, 154, 255),
    empty: new cc.Color(216, 216, 216, 255),
    surface: new cc.Color(255, 255, 255, 255),
    ink900: new cc.Color(68, 80, 84, 255),
    ink600: new cc.Color(106, 105, 107, 255),
    ink400: new cc.Color(153, 153, 153, 255),
    onDark: new cc.Color(255, 255, 255, 255),
};
root.removeAllChildren();
function mkNode(name, parent, w, h, ax, ay) {
    const n = new cc.Node(name);
    n.layer = parent.layer;
    parent.addChild(n);
    const ui = n.addComponent(cc.UITransform);
    ui.setAnchorPoint(ax === undefined ? 0.5 : ax, ay === undefined ? 0.5 : ay);
    ui.setContentSize(w, h);
    return n;
}
function mkRect(name, parent, w, h, color) {
    const n = mkNode(name, parent, w, h);
    const sp = n.addComponent(cc.Sprite);
    sp.sizeMode = cc.Sprite.SizeMode.CUSTOM;      // 必须先于 spriteFrame
    sp.type = cc.Sprite.Type.SLICED;
    sp.spriteFrame = frames.round;
    sp.color = color.clone();
    n.getComponent(cc.UITransform).setContentSize(w, h);
    return n;
}
function mkLabel(name, parent, text, fontSize, color, w, h, ax, align) {
    const n = mkNode(name, parent, w, h, ax);
    const lb = n.addComponent(cc.Label);
    lb.string = text;
    lb.fontSize = fontSize;
    lb.color = color.clone();
    lb.horizontalAlign = align === undefined ? cc.Label.HorizontalAlign.CENTER : align;
    lb.verticalAlign = cc.Label.VerticalAlign.CENTER;
    lb.overflow = cc.Label.Overflow.CLAMP;
    return n;
}
// ① 收纳按钮（常显）
const toggle = mkRect('toggle', root, args.toggleSize, args.toggleSize, COL.accent);
toggle.setPosition(0, args.toggleY);
const tbtn = toggle.addComponent(cc.Button);
tbtn.transition = cc.Button.Transition.SCALE;
tbtn.target = toggle;
if (frames.icon) {
    const ic = mkNode('icon', toggle, 40, 40);
    const isp = ic.addComponent(cc.Sprite);
    isp.sizeMode = cc.Sprite.SizeMode.CUSTOM;
    isp.spriteFrame = frames.icon;
    isp.color = COL.onDark.clone();
    ic.setPosition(-6, 2);
}
if (frames.arrow) {
    const ar = mkNode('arrow', toggle, 16, 16);
    const asp = ar.addComponent(cc.Sprite);
    asp.sizeMode = cc.Sprite.SizeMode.CUSTOM;
    asp.spriteFrame = frames.arrow;
    asp.color = COL.onDark.clone();
    ar.setPosition(24, 0);
}
mkLabel('count', toggle, '', 12, COL.onDark, 56, 16).setPosition(0, -24);

// ② 展开区（锚点在左下 → 向右生长；默认收起）
const content = mkNode('content', root, args.contentW, args.contentH, 0, 0);
content.setPosition(args.contentX, args.contentY);
content.active = false;
const cells = mkNode('cells', content, args.contentW, args.cellSize, 0, 0);   // 锚点在左下：容器框才罩得住孩子
for (let i = 0; i < args.slotCount; i++) {
    const cell = mkRect('cell_' + (i + 1), cells, args.cellSize, args.cellSize, COL.empty);
    cell.setPosition(args.cellPadX + i * args.cellPitch, args.cellSize / 2);
    const btn = cell.addComponent(cc.Button);
    btn.transition = cc.Button.Transition.SCALE;
    btn.target = cell;
    mkRect('bg', cell, args.cellSize - 8, args.cellSize - 8, COL.surface);
    const ic = mkNode('icon', cell, 36, 36);
    const isp = ic.addComponent(cc.Sprite);
    isp.sizeMode = cc.Sprite.SizeMode.CUSTOM;
    isp.color = COL.onDark.clone();
    ic.setPosition(0, 8);
    ic.active = false;
    mkLabel('name', cell, '', 14, COL.ink900, args.cellSize - 12, 20);
}
// ③ 说明浮层（三行左对齐 —— 用中心锚点会把字画到面板外）
const tip = mkRect('tip', content, args.tipW, args.tipH, COL.surface);
tip.setPosition(args.tipX, args.tipY);
tip.active = false;
mkLabel('name', tip, '', 16, COL.ink900, args.tipW - 32, 22, 0, cc.Label.HorizontalAlign.LEFT).setPosition(-args.tipW / 2 + 16, 26);
mkLabel('desc', tip, '', 14, COL.ink600, args.tipW - 32, 20, 0, cc.Label.HorizontalAlign.LEFT).setPosition(-args.tipW / 2 + 16, 0);
mkLabel('hint', tip, args.hintText, 12, COL.ink400, args.tipW - 32, 18, 0, cc.Label.HorizontalAlign.LEFT).setPosition(-args.tipW / 2 + 16, -28);

snapshot();
return { root: root.name, children: root.children.map((c) => c.name), cellCount: cells.children.length };
