/* ⚠ 已归档（2026-10-04）—— 这一条**不是 recipe**。留在 `.dsh-mcp/archive/` 只作参考实现，**不要放回 `recipes/`**。
 *
 * 为什么归档（判据 = 换参数还能跑 + 能说出 ≥2 个未来调用点）：
 *   它的**结构是写死的**（背景 / 柔化层 / SafeArea / 居中主列 / 圆角面板 / 两个 EditBox / 登录注册按钮 / 版本协议条），
 *   9 个参数只能换文案与贴图 uuid —— 换个用途（设置页、背包页）根本搭不出来。
 *   名字也按**用途**（login）而非**形状**命名，检索时命不中。
 *   对照：`recipes/build-subtabbed-list-page.js` 按形状命名 + 18 个真参数，那条才是 recipe。
 *
 * 它夹带的**事实**已搬进 skill（纪律 6：丢代码之前先把事实搬走）：
 *   ① Widget 只用「四边拉伸 / 居中」两种对齐、且只打开显式给了值的对齐项  → SKILL.md 坑 9
 *   ② 贴底横条用 Layout(VERTICAL / BOTTOM_TO_TOP) 绕开单边对齐漂移        → SKILL.md 坑 9
 *   ③ Sprite 先 sizeMode=CUSTOM 再赋 spriteFrame                          → 早已在 SKILL.md 坑 4
 *   ④ EditBox 自建背景 Sprite 的 sizeMode 也要先改                         → 早已在 SKILL.md 坑 4
 *      （本文件独有的那条：EditBox 的两个子节点叫 TEXT_LABEL / PLACEHOLDER_LABEL —— 已并入坑 4）
 *   ⑤ 建树脚本幂等：同名根先删再建                                        → 早已在 SKILL.md 纪律 1
 *
 * 归档而不是删除：`.dsh-mcp/` 当时**未入库**（`git ls-files .dsh-mcp` = 0），删了就找不回来。
 * 不影响索引：`listRecipeRecords` 是 `readdirSync(recipes/)` 非递归、只收本层 `*.js`（`source/core/recipes.ts:214-226`）。
 */
/* @dsh-recipe
{
  "name": "build-login-ui-tree",
  "description": "在当前场景的 Canvas 下按契约搭一棵登录界面节点树（背景 / 柔化层 / SafeArea / 居中主列 / 圆角面板 / 账号密码两个 EditBox / 登录注册按钮 / 底部版本与协议条），全 Widget 适配、零脚本；幂等（先删同名根再建），跑完可直接把返回的 nodeUuid 喂给 cce.Prefab.createPrefabAssetFromNode 存成预制件",
  "context": "scene",
  "params": {
    "canvasPath": "Canvas 节点路径，一般是 'Canvas'",
    "rootName": "根节点名，建议 'LoginUI'",
    "bgFrame": "背景 spriteFrame 的 uuid（由调用方查好传进来，不要在代码里写死）",
    "panelFrame": "面板用九宫格 spriteFrame 的 uuid",
    "fieldFrame": "输入框底 spriteFrame 的 uuid",
    "roundFrame": "圆角按钮 spriteFrame 的 uuid",
    "logoFrame": "logo 用 spriteFrame 的 uuid",
    "title": "主标题文案",
    "subtitle": "副标题文案"
  },
  "returns": "{ nodeUuid, nodes } —— 根节点 uuid（可直接喂给 cce.Prefab.createPrefabAssetFromNode）与节点总数",
  "createdAt": "2026-09-30T04:50:00.000Z"
}
*/
// 口径（都是踩出来的）：
// 1) 设计分辨率 750×1334 / fitWidth；只用「四边拉伸」与「水平垂直居中」两种 Widget 对齐；
// 2) 底部条走 Layout(VERTICAL / BOTTOM_TO_TOP)，**避开单边(bottom only)对齐在 Widget 回写时漂移**的引擎坑；
// 3) Sprite 一律 **先 sizeMode = CUSTOM 再赋 spriteFrame**（默认 TRIMMED 会把宿主节点撑成贴图原始尺寸）；
// 4) EditBox 会自建背景 Sprite —— 它的 sizeMode 也要在赋帧前改，否则输入框节点被缩成 2×2；
// 5) 幂等：同名根先删再建，重复跑不会堆两棵树。
const UI2D = cc.Layers.Enum.UI_2D;
const canvas = nodeByPath(args.canvasPath);
if (!canvas) throw new Error('找不到画布节点：' + args.canvasPath);

for (const old of [...canvas.children]) {
    if (old.name === args.rootName) old.destroy();
}

const load = (uuid) =>
    new Promise((res, rej) => cc.assetManager.loadAny({ uuid }, (e, a) => (e ? rej(new Error(uuid + ' :: ' + e.message)) : res(a))));
const [sfBg, sfPanel, sfField, sfRound, sfLogo] = await Promise.all([
    load(args.bgFrame),
    load(args.panelFrame),
    load(args.fieldFrame),
    load(args.roundFrame),
    load(args.logoFrame),
]);

const col = (hex, alpha) => {
    const c = new cc.Color();
    c.fromHEX(hex);
    if (alpha != null) c.a = alpha;
    return c;
};
const C = { ink: '#2F4A50', sub: '#7C9A9E', field: '#EDF3F3', teal: '#3F8F8F', white: '#FFFFFF', ph: '#9FB6B8' };

function node(name, parent, w, h, x, y) {
    const n = new cc.Node(name);
    n.layer = UI2D;
    parent.addChild(n);
    const ut = n.addComponent(cc.UITransform);
    ut.setAnchorPoint(0.5, 0.5);
    ut.setContentSize(w, h);
    n.setPosition(x || 0, y || 0, 0);
    return n;
}

/** Widget：`ALWAYS` + 只打开显式给了值的那些对齐项 */
function widget(n, cfg) {
    const w = n.addComponent(cc.Widget);
    w.alignMode = cc.Widget.AlignMode.ALWAYS;
    for (const key of ['Left', 'Right', 'Top', 'Bottom', 'HorizontalCenter', 'VerticalCenter']) {
        const prop = key[0].toLowerCase() + key.slice(1);
        if (cfg[prop] != null) w['isAlign' + key] = true;
    }
    for (const key of ['left', 'right', 'top', 'bottom', 'horizontalCenter', 'verticalCenter']) {
        if (cfg[key] != null) w[key] = cfg[key];
    }
    w.updateAlignment();
    return w;
}

/** ★ sizeMode 必须先于 spriteFrame 赋值（见文件头第 3 条） */
function sprite(n, frame, w, h, o) {
    const s = n.addComponent(cc.Sprite);
    s.sizeMode = cc.Sprite.SizeMode.CUSTOM;
    s.type = o && o.sliced ? cc.Sprite.Type.SLICED : cc.Sprite.Type.SIMPLE;
    s.spriteFrame = frame;
    s.color = col((o && o.color) || C.white, o && o.alpha);
    n.getComponent(cc.UITransform).setContentSize(w, h);
    return s;
}

function label(n, str, o) {
    const l = n.addComponent(cc.Label);
    l.string = str;
    l.fontSize = o.size;
    l.lineHeight = o.line || Math.round(o.size * 1.4);
    l.horizontalAlign = o.hAlign == null ? cc.Label.HorizontalAlign.CENTER : o.hAlign;
    l.verticalAlign = cc.Label.VerticalAlign.CENTER;
    l.overflow = cc.Label.Overflow.CLAMP;
    l.enableWrapText = false;
    l.isBold = !!o.bold;
    if (o.spacingX) l.spacingX = o.spacingX;
    l.color = col(o.color || C.ink);
    return l;
}

/** EditBox：连它自建的 TEXT_LABEL / PLACEHOLDER_LABEL 一起规整（见文件头第 4 条） */
function editBox(row, o) {
    const n = node('input', row, o.w || 500, 92, 0, 0);
    const eb = n.addComponent(cc.EditBox);
    eb.inputMode = cc.EditBox.InputMode.SINGLE_LINE;
    eb.inputFlag = o.password ? cc.EditBox.InputFlag.PASSWORD : cc.EditBox.InputFlag.DEFAULT;
    eb.returnType = cc.EditBox.KeyboardReturnType.DONE;
    eb.maxLength = o.maxLength || 16;
    eb.placeholder = o.placeholder;
    for (const child of ['TEXT_LABEL', 'PLACEHOLDER_LABEL']) {
        const ln = n.getChildByName(child);
        if (!ln) continue;
        const lut = ln.getComponent(cc.UITransform) || ln.addComponent(cc.UITransform);
        lut.setAnchorPoint(0, 1);
        const lb = ln.getComponent(cc.Label) || ln.addComponent(cc.Label);
        lb.fontSize = 28;
        lb.lineHeight = 38;
        lb.horizontalAlign = cc.Label.HorizontalAlign.LEFT;
        lb.verticalAlign = cc.Label.VerticalAlign.CENTER;
        lb.overflow = cc.Label.Overflow.CLAMP;
        lb.enableWrapText = false;
        lb.color = col(child === 'TEXT_LABEL' ? C.ink : C.ph);
    }
    const self = n.getComponent(cc.Sprite);
    if (self) {
        self.sizeMode = cc.Sprite.SizeMode.CUSTOM;
        self.spriteFrame = null;
        self.color = new cc.Color(255, 255, 255, 0);
    }
    return eb;
}

function button(parent, name, text, w, h, x, y, o) {
    const n = node(name, parent, w, h, x, y);
    sprite(n, sfRound, w, h, { sliced: true, color: o.bg });
    const b = n.addComponent(cc.Button);
    b.transition = cc.Button.Transition.SCALE;
    b.zoomScale = 0.96;
    b.duration = 0.08;
    b.target = n;
    label(node('label', n, w - 40, h), text, { size: o.size, bold: o.bold, color: o.color });
    return n;
}

const root = node(args.rootName, canvas, 750, 1334, 0, 0);
widget(root, { left: 0, right: 0, top: 0, bottom: 0 });

const bg = node('bg', root, 750, 1334, 0, 0);
sprite(bg, sfBg, 750, 1334, {});
widget(bg, { left: 0, right: 0, top: 0, bottom: 0 });

const scrim = node('scrim', root, 750, 1334, 0, 0);
sprite(scrim, sfField, 750, 1334, { sliced: true, alpha: 110 });
widget(scrim, { left: 0, right: 0, top: 0, bottom: 0 });

const safe = node('safe', root, 750, 1334, 0, 0);
widget(safe, { left: 0, right: 0, top: 0, bottom: 0 });
safe.addComponent(cc.SafeArea);

const content = node('content', safe, 690, 900, 0, 0);
widget(content, { horizontalCenter: 0, verticalCenter: 0 });

sprite(node('logo', content, 160, 184, 0, 330), sfLogo, 160, 184, {});
label(node('title', content, 640, 70, 0, 195), args.title, { size: 54, line: 70, bold: true });
label(node('subtitle', content, 640, 30, 0, 142), args.subtitle, { size: 22, line: 30, color: C.sub, spacingX: 8 });

const panel = node('panel', content, 620, 480, 0, -125);
const panelBg = node('panel_bg', panel, 620, 480, 0, 0);
sprite(panelBg, sfPanel, 620, 480, { sliced: true });
widget(panelBg, { left: 0, right: 0, top: 0, bottom: 0 });

const account = node('account', panel, 540, 92, 0, 150);
const accBg = node('bg', account, 540, 92, 0, 0);
sprite(accBg, sfField, 540, 92, { sliced: true, color: C.field });
widget(accBg, { left: 0, right: 0, top: 0, bottom: 0 });
editBox(account, { placeholder: '请输入账号', maxLength: 16 });

const password = node('password', panel, 540, 92, 0, 48);
const pwdBg = node('bg', password, 540, 92, 0, 0);
sprite(pwdBg, sfField, 540, 92, { sliced: true, color: C.field });
widget(pwdBg, { left: 0, right: 0, top: 0, bottom: 0 });
editBox(password, { placeholder: '请输入密码', maxLength: 20, password: true });

button(panel, 'login_btn', '登    录', 540, 96, 0, -68, { bg: C.teal, color: C.white, size: 36, bold: true });
button(panel, 'register_btn', '注册新账号', 540, 80, 0, -178, { bg: C.white, color: C.teal, size: 28, bold: false });

const bar = node('bottom_bar', safe, 750, 1334, 0, 0);
widget(bar, { left: 0, right: 0, top: 0, bottom: 0 });
const lay = bar.addComponent(cc.Layout);
lay.type = cc.Layout.Type.VERTICAL;
lay.verticalDirection = cc.Layout.VerticalDirection.BOTTOM_TO_TOP;
lay.horizontalDirection = cc.Layout.HorizontalDirection.LEFT_TO_RIGHT;
lay.resizeMode = cc.Layout.ResizeMode.NONE;
lay.paddingBottom = 24;
lay.paddingLeft = 30;
lay.paddingRight = 30;
lay.spacingY = 6;
label(node('version', bar, 690, 30, 0, 0), 'v1.0.0', { size: 20, line: 30, color: C.sub });
label(node('agreement', bar, 690, 30, 0, 0), '登录即代表同意《用户协议》与《隐私政策》', { size: 20, line: 30, color: C.sub });
lay.updateLayout(true);

snapshot();

let count = 0;
(function walk(n) {
    count += 1;
    for (const child of n.children) walk(child);
})(root);

// 顺带回报两个输入框的最终尺寸：验收「节点没被贴图的 TRIMMED 撑坏」要的就是这两个数
const sizeOf = (target) => {
    const ut = target.getComponent(cc.UITransform);
    return { w: ut.width, h: ut.height };
};

return {
    nodeUuid: root.uuid,
    nodes: count,
    accountSize: sizeOf(account),
    passwordSize: sizeOf(password),
};
