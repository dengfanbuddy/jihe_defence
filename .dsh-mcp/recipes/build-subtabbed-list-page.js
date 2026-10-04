/* @dsh-recipe
{
  "name": "build-subtabbed-list-page",
  "description": "在给定父节点下搭一个「N 个子 tab + N 个 ScrollView 子页（各带 Mask / 垂直 Layout 的 lists）+ 一个 active=false 的模板容器」的页面骨架；纯节点无脚本，幂等（先删同名旧节点）。用来给 Scene_Menu 那类\"左侧一级 tab、页内还有二级 tab\"的页面快速起骨架：子页的 ScrollView/Wiget/Layout 一次配对好，之后只要往 templates 里摆行节点、写一个继承 Tabs 的页控制器即可",
  "context": "scene",
  "params": {
    "parentPath": "页面根的节点路径（如一级 tab 的 content 节点路径）",
    "labelStyleRefPath": "取字体设置用的参照 Label 节点路径（复制 useSystemFont/font/fontFamily，避免自造一套字体）",
    "tabBgRefPath": "tab 选中底图用的参照节点路径（取它的 spriteFrame；传空串则不画底图）",
    "tabLabels": "二级 tab 文案数组，长度 = 子页数量",
    "tabBarName": "tab 容器节点名",
    "pagesName": "子页容器节点名",
    "templatesName": "模板容器节点名",
    "tabNodePrefix": "tab 节点名前缀（如 'tab_'，拼成 tab_0 / tab_1）",
    "pagePrefix": "子页节点名前缀（如 'page_'）",
    "width": "页面宽（像素）",
    "height": "页面高（像素）",
    "tabHeight": "tab 条高",
    "tabGap": "tab 条左右留白",
    "tabFontSize": "tab 字号",
    "tabFontColor": "未选中 tab 的文字色",
    "tabBgColor": "选中底图染色",
    "withMask": "子页是否加 cc.Mask（列表长时必须 true，否则会溢出版面）",
    "spacingY": "lists 的行间距",
    "padding": "lists 四周内边距"
  },
  "returns": "{ tabBar, pages, templates, pages4: [{page, list}] } —— 各关键节点的 uuid；调用方再给 tabBar/pages 挂一个继承 Tabs 的页控制器（tabBarNode/contentBarNode 指过来），并往 templates 里摆行节点",
  "createdAt": "2026-10-02T14:31:24.028Z"
}
*/

const { Node, UITransform, Widget, Layout, Sprite, Label, Mask, ScrollView, Button, Color } = cc;
const parent = nodeByPath(args.parentPath);
if (!parent) throw new Error('父节点不存在: ' + args.parentPath);

const refLabel = nodeByPath(args.labelStyleRefPath).getComponent(Label);
const tabBgSf = args.tabBgRefPath ? nodeByPath(args.tabBgRefPath).getComponent(Sprite).spriteFrame : null;

const mk = (name, p, w, h, ax = 0.5, ay = 0.5) => {
  const n = new Node(name); n.layer = p.layer; p.addChild(n);
  const ui = n.addComponent(UITransform); ui.setContentSize(w, h); ui.setAnchorPoint(ax, ay); return n;
};
const setLabel = (n, text, size, align, hex) => {
  const lb = n.addComponent(Label);
  lb.useSystemFont = refLabel.useSystemFont; lb.font = refLabel.font; lb.fontFamily = refLabel.fontFamily;
  lb.string = text; lb.fontSize = size; lb.lineHeight = Math.round(size * 1.2);
  lb.horizontalAlign = align; lb.verticalAlign = Label.VerticalAlign.CENTER;
  lb.overflow = Label.Overflow.NONE; lb.color = new Color(hex); return lb;
};
const setSprite = (n, sf, hex, sliced) => {
  const sp = n.addComponent(Sprite);
  sp.sizeMode = Sprite.SizeMode.CUSTOM;   // 必须在赋 spriteFrame 之前，否则会被按 TRIMMED 改成贴图原始尺寸
  sp.spriteFrame = sf; sp.type = sliced ? Sprite.Type.SLICED : Sprite.Type.SIMPLE;
  sp.trim = false; sp.color = new Color(hex); return sp;
};

// 幂等：先删同名旧节点
for (const nm of [args.tabBarName, args.pagesName, args.templatesName]) {
  const old = parent.getChildByName(nm);
  if (old) { old.removeFromParent(); old.destroy(); }
}

const labels = args.tabLabels || ['总览', '属性总览'];
const w = args.width, tabH = args.tabHeight, pageH = args.height - tabH;

// ── tabBar ──
const tabBar = mk(args.tabBarName, parent, w, tabH);
const tw = tabBar.addComponent(Widget);
tw.isAlignTop = true; tw.top = 0; tw.isAlignLeft = true; tw.left = 0; tw.isAlignRight = true; tw.right = 0;
tabBar.setPosition(0, args.height / 2 - tabH / 2);
const tabW = Math.floor((w - 2 * args.tabGap) / labels.length);
labels.forEach((text, i) => {
  const t = mk(args.tabNodePrefix + i, tabBar, tabW, tabH - 12);
  t.setPosition(-w / 2 + args.tabGap + tabW / 2 + i * tabW, 0);
  t.addComponent(Button);
  const bg = mk('active_bg', t, tabW, tabH - 12);
  if (tabBgSf) setSprite(bg, tabBgSf, args.tabBgColor, false);
  bg.active = i === 0;
  const nm = mk('name', t, tabW, tabH - 12);
  setLabel(nm, text, args.tabFontSize, Label.HorizontalAlign.CENTER, args.tabFontColor);
});

// ── pages（每个子页一个 ScrollView + Mask + lists） ──
const pages = mk(args.pagesName, parent, w, pageH);
const pw = pages.addComponent(Widget);
pw.isAlignTop = true; pw.top = tabH; pw.isAlignBottom = true; pw.bottom = 0;
pw.isAlignLeft = true; pw.left = 0; pw.isAlignRight = true; pw.right = 0;
pages.getComponent(UITransform).setContentSize(w, pageH);
pages.setPosition(0, -tabH / 2);

const made = [];
labels.forEach((_, i) => {
  const v = mk(args.pagePrefix + i, pages, w, pageH);
  const vw = v.addComponent(Widget);
  vw.isAlignTop = true; vw.top = 0; vw.isAlignBottom = true; vw.bottom = 0;
  vw.isAlignLeft = true; vw.left = 0; vw.isAlignRight = true; vw.right = 0;
  vw.updateAlignment();
  if (args.withMask) { const m = v.addComponent(Mask); m.type = Mask.Type.GRAPHICS_RECT; }
  const sv = v.addComponent(ScrollView);
  sv.horizontal = false; sv.vertical = true; sv.inertia = true; sv.brake = 0.5; sv.elastic = true;
  sv.bounceDuration = 1; sv.cancelInnerEvents = true;
  const content = mk('lists', v, w, 0, 0.5, 1);
  content.setPosition(0, pageH / 2);
  const lay = content.addComponent(Layout);
  lay.type = Layout.Type.VERTICAL; lay.resizeMode = Layout.ResizeMode.CONTAINER;
  lay.spacingY = args.spacingY; lay.paddingTop = args.padding;
  lay.paddingBottom = args.padding; lay.paddingLeft = args.padding; lay.paddingRight = args.padding;
  lay.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
  sv.content = content;
  lay.updateLayout();
  v.active = i === 0;
  made.push({ page: v.uuid, list: content.uuid });
});

// ── templates（active=false 的克隆源容器） ──
const tpl = mk(args.templatesName, parent, 10, 10);
tpl.active = false;

return { tabBar: tabBar.uuid, pages: pages.uuid, templates: tpl.uuid, pages4: made };
