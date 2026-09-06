"use strict";
/**
 * Cocos Creator 知识库数据
 *
 * 7 大主题原始数据：component_properties / ui_design_rules / layout_patterns /
 * widget_strategy / node_structure / animation_patterns / best_practices
 *
 * 混合模式：initialize 注入关键摘要 + knowledge_query 工具返回详细内容
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.KNOWLEDGE_TOPICS = exports.BEST_PRACTICES = exports.ANIMATION_PATTERNS = exports.NODE_STRUCTURES = exports.WIDGET_STRATEGIES = exports.LAYOUT_PATTERNS = exports.UI_DESIGN_RULES = exports.COMPONENT_PROPERTIES = void 0;
exports.COMPONENT_PROPERTIES = {
    'cc.Sprite': {
        type: 'cc.Sprite',
        description: '精灵渲染组件（extends UIRenderer）',
        properties: {
            spriteAtlas: { type: 'cc.SpriteAtlas', description: '精灵图集' },
            spriteFrame: { type: 'cc.SpriteFrame', description: '精灵帧' },
            type: { type: 'Enum', description: '渲染类型（SIMPLE/SLICED/TILED/FILLED）', default: 0 },
            fillType: { type: 'Enum', description: '填充类型 (HORIZONTAL/VERTICAL/RADIAL)', default: 0 },
            fillCenter: { type: 'cc.Vec2', description: '填充中心点', default: '{"x":0,"y":0}' },
            fillStart: { type: 'Float', description: '填充起始', default: 0 },
            fillRange: { type: 'Float', description: '填充范围', default: 0 },
            trim: { type: 'Boolean', description: '是否裁剪透明边', default: true },
            grayscale: { type: 'Boolean', description: '灰度模式', default: false },
            sizeMode: { type: 'Enum', description: '尺寸追踪模式 (RAW/TRIMMED/CUSTOM)', default: 1 },
        },
    },
    'cc.Label': {
        type: 'cc.Label',
        description: '文本标签组件（extends UIRenderer）',
        properties: {
            string: { type: 'String', description: '文本内容', default: 'label' },
            horizontalAlign: { type: 'Enum', description: '水平对齐 (LEFT/CENTER/RIGHT)', default: 1 },
            verticalAlign: { type: 'Enum', description: '垂直对齐 (TOP/CENTER/BOTTOM)', default: 1 },
            actualFontSize: { type: 'Float', description: '实际渲染字号（shrink 模式）' },
            fontSize: { type: 'Float', description: '字号', default: 40 },
            lineHeight: { type: 'Float', description: '行高', default: 40 },
            spacingX: { type: 'Float', description: '字符间距（仅 BMFont）', default: 0 },
            overflow: { type: 'Enum', description: '溢出模式 (NONE/CLAMP/SHRINK/RESIZE_HEIGHT)', default: 0 },
            enableWrapText: { type: 'Boolean', description: '自动换行', default: true },
            useSystemFont: { type: 'Boolean', description: '使用系统字体', default: true },
            fontFamily: { type: 'String', description: '字体族名', default: 'Arial' },
            font: { type: 'cc.Font', description: '自定义字体资源' },
            cacheMode: { type: 'Enum', description: '缓存模式 (NONE/BITMAP/CHAR)', default: 0 },
            isBold: { type: 'Boolean', description: '加粗', default: false },
            isItalic: { type: 'Boolean', description: '斜体', default: false },
            isUnderline: { type: 'Boolean', description: '下划线', default: false },
            underlineHeight: { type: 'Float', description: '下划线高度', default: 2 },
            enableOutline: { type: 'Boolean', description: '启用描边', default: false },
            outlineColor: { type: 'cc.Color', description: '描边颜色' },
            outlineWidth: { type: 'Float', description: '描边宽度', default: 2 },
            enableShadow: { type: 'Boolean', description: '启用阴影', default: false },
            shadowColor: { type: 'cc.Color', description: '阴影颜色' },
            shadowOffset: { type: 'cc.Vec2', description: '阴影偏移', default: '{"x":2,"y":2}' },
            shadowBlur: { type: 'Float', description: '阴影模糊', default: 2 },
        },
    },
    'cc.Button': {
        type: 'cc.Button',
        description: '按钮组件（extends Component）',
        properties: {
            target: { type: 'cc.Node', description: '过渡目标节点' },
            interactable: { type: 'Boolean', description: '是否可交互', default: true },
            transition: { type: 'Enum', description: '过渡类型 (NONE/COLOR/SPRITE/SCALE)', default: 0 },
            normalColor: { type: 'cc.Color', description: '普通状态颜色' },
            pressedColor: { type: 'cc.Color', description: '按下状态颜色' },
            hoverColor: { type: 'cc.Color', description: '悬停状态颜色' },
            disabledColor: { type: 'cc.Color', description: '禁用状态颜色' },
            duration: { type: 'Float', description: '过渡持续时间', default: 0.1 },
            zoomScale: { type: 'Float', description: '缩放比例', default: 1.2 },
            normalSprite: { type: 'cc.SpriteFrame', description: '普通状态精灵' },
            pressedSprite: { type: 'cc.SpriteFrame', description: '按下状态精灵' },
            hoverSprite: { type: 'cc.SpriteFrame', description: '悬停状态精灵' },
            disabledSprite: { type: 'cc.SpriteFrame', description: '禁用状态精灵' },
            clickEvents: { type: 'cc.Component.EventHandler[]', description: '点击事件处理器' },
        },
    },
    'cc.Widget': {
        type: 'cc.Widget',
        description: 'UI 对齐组件（extends Component）',
        properties: {
            target: { type: 'cc.Node', description: '对齐目标（默认父节点）' },
            isAlignTop: { type: 'Boolean', description: '对齐顶部', default: false },
            isAlignBottom: { type: 'Boolean', description: '对齐底部', default: false },
            isAlignLeft: { type: 'Boolean', description: '对齐左边', default: false },
            isAlignRight: { type: 'Boolean', description: '对齐右边', default: false },
            isAlignVerticalCenter: { type: 'Boolean', description: '垂直居中', default: false },
            isAlignHorizontalCenter: { type: 'Boolean', description: '水平居中', default: false },
            top: { type: 'Float', description: '顶部边距', default: 0 },
            bottom: { type: 'Float', description: '底部边距', default: 0 },
            left: { type: 'Float', description: '左边距', default: 0 },
            right: { type: 'Float', description: '右边距', default: 0 },
            horizontalCenter: { type: 'Float', description: '水平居中偏移', default: 0 },
            verticalCenter: { type: 'Float', description: '垂直居中偏移', default: 0 },
            isAbsoluteTop: { type: 'Boolean', description: '顶部边距为像素/百分比', default: true },
            isAbsoluteBottom: { type: 'Boolean', description: '底部边距为像素/百分比', default: true },
            isAbsoluteLeft: { type: 'Boolean', description: '左边距为像素/百分比', default: true },
            isAbsoluteRight: { type: 'Boolean', description: '右边距为像素/百分比', default: true },
            alignMode: { type: 'Enum', description: '对齐刷新模式 (ONCE/ON_WINDOW_RESIZE/ALWAYS)', default: 2 },
        },
    },
    'cc.Layout': {
        type: 'cc.Layout',
        description: '布局容器组件（extends Component）',
        properties: {
            type: { type: 'Enum', description: '布局类型 (NONE/HORIZONTAL/VERTICAL/GRID)', default: 0 },
            resizeMode: { type: 'Enum', description: '调整模式 (NONE/CONTAINER/CHILDREN)', default: 0 },
            cellSize: { type: 'cc.Size', description: '网格单元尺寸', default: '{"width":40,"height":40}' },
            startAxis: { type: 'Enum', description: '网格起始轴 (HORIZONTAL/VERTICAL)', default: 0 },
            paddingLeft: { type: 'Float', description: '左内边距', default: 0 },
            paddingRight: { type: 'Float', description: '右内边距', default: 0 },
            paddingTop: { type: 'Float', description: '上内边距', default: 0 },
            paddingBottom: { type: 'Float', description: '下内边距', default: 0 },
            spacingX: { type: 'Float', description: '水平间距', default: 0 },
            spacingY: { type: 'Float', description: '垂直间距', default: 0 },
            constraint: { type: 'Enum', description: '约束类型 (NONE/FIXED_COL/FIXED_ROW)', default: 0 },
            constraintNum: { type: 'Float', description: '约束数量', default: 2 },
            affectedByScale: { type: 'Boolean', description: '受子节点缩放影响布局', default: false },
        },
    },
    'cc.ScrollView': {
        type: 'cc.ScrollView',
        description: '滚动视图组件（extends ViewGroup）',
        properties: {
            content: { type: 'cc.Node', description: '滚动内容节点' },
            horizontal: { type: 'Boolean', description: '启用水平滚动', default: true },
            vertical: { type: 'Boolean', description: '启用垂直滚动', default: true },
            horizontalScrollBar: { type: 'cc.ScrollBar', description: '水平滚动条' },
            verticalScrollBar: { type: 'cc.ScrollBar', description: '垂直滚动条' },
            elastic: { type: 'Boolean', description: '弹性回弹', default: true },
            inertia: { type: 'Boolean', description: '惯性滚动', default: true },
            bounceDuration: { type: 'Float', description: '回弹持续时间', default: 1 },
            brake: { type: 'Float', description: '制动系数', default: 0.5 },
            cancelInnerEvents: { type: 'Boolean', description: '取消内部触摸事件', default: true },
            scrollEvents: { type: 'cc.Component.EventHandler[]', description: '滚动事件回调' },
        },
    },
    'cc.EditBox': {
        type: 'cc.EditBox',
        description: '输入框组件（extends Component）',
        properties: {
            string: { type: 'String', description: '输入文本' },
            placeholder: { type: 'String', description: '占位提示文本' },
            textLabel: { type: 'cc.Label', description: '文本标签引用' },
            placeholderLabel: { type: 'cc.Label', description: '占位标签引用' },
            backgroundImage: { type: 'cc.SpriteFrame', description: '背景图片' },
            inputMode: { type: 'Enum', description: '输入模式 (ANY/EMAIL/NUMBER/URL...)', default: 0 },
            inputFlag: { type: 'Enum', description: '输入标识 (PASSWORD/SENSITIVE/...)', default: 5 },
            maxLength: { type: 'Float', description: '最大字符数', default: 20 },
            tabIndex: { type: 'Float', description: 'Tab 索引（仅 Web）', default: 0 },
            editingDidBegan: { type: 'cc.Component.EventHandler[]', description: '开始编辑事件' },
            textChanged: { type: 'cc.Component.EventHandler[]', description: '文本变化事件' },
            editingDidEnded: { type: 'cc.Component.EventHandler[]', description: '结束编辑事件' },
            editingReturn: { type: 'cc.Component.EventHandler[]', description: '回车事件' },
        },
    },
    'cc.UITransform': {
        type: 'cc.UITransform',
        description: 'UI 变换组件（extends Component）',
        properties: {
            contentSize: { type: 'cc.Size', description: '内容尺寸', default: '{"width":100,"height":100}' },
            anchorPoint: { type: 'cc.Vec2', description: '锚点', default: '{"x":0.5,"y":0.5}' },
            priority: { type: 'Float', description: '渲染优先级', default: 0 },
        },
    },
    'cc.Canvas': {
        type: 'cc.Canvas',
        description: '画布组件（extends Component）',
        properties: {
            designResolution: { type: 'cc.Size', description: '设计分辨率', default: '{"width":960,"height":640}' },
            fitHeight: { type: 'Boolean', description: '适配高度', default: false },
            fitWidth: { type: 'Boolean', description: '适配宽度', default: false },
        },
    },
};
// ==================== 2. UI 设计规则 (ui_design_rules) ====================
exports.UI_DESIGN_RULES = {
    coordinate_system: `Canvas anchor=(0.5,0.5), (0,0)=屏幕中心。可见范围: x∈[-designWidth/2, designWidth/2], y∈[-designHeight/2, designHeight/2]`,
    bounding_box: `节点(px,py)尺寸(w,h)锚点(ax,ay): left=px-w*ax, right=px+w*(1-ax), bottom=py-h*ay, top=py+h*(1-ay)`,
    positioning_tips: `居中: position=(0,0)。全屏背景: size=designResolution, position=(0,0)。右上角: position=(designWidth/2, designHeight/2)`,
    touch_targets: `最小触摸目标: 44x44 点 (88x88 @2x)。推荐: 48x48`,
    font_sizes: `标题: 32-40, 正文: 24-28, 标注: 18-22, 按钮: 24-32`,
    spacing: `标准间距: 8, 16, 24, 32, 48。使用 8 的倍数`,
    colors: `文本对比度 >= 4.5:1`,
    safe_area: `notch 区域: 顶部 44pt, 底部 34pt (iPhone)`,
    button_sizes: `小: 120x44, 中: 200x60, 大: 300x80。最小宽 = 文本宽 + 48`,
    margins: `屏幕边缘: 16-24px。元素间距: 8-16px。区域间距: 24-48px`,
};
exports.LAYOUT_PATTERNS = [
    {
        name: 'dialog',
        description: '模态弹窗 (Modal Dialog)',
        structure: `DialogRoot (Widget: full, 半透明遮罩 rgba(0,0,0,128), BlockInputEvents)
  Panel (UITransform: 600x400, 居中)
    Title (Label, fontSize:32, 顶部)
    CloseBtn (Button, 右上角)
    Content (Label/RichText, 中间, 可滚动)
    ButtonGroup (Layout: horizontal, spacingX:24, 底部)
      CancelBtn (Button)
      ConfirmBtn (Button)`,
        tips: '使用 BlockInputEvents 防止点击穿透。添加 scale 0→1 动画打开效果',
    },
    {
        name: 'scroll_list',
        description: '垂直/水平滚动列表',
        structure: `ScrollView (ScrollView, vertical:true)
  view (Mask, Widget: full)
    content (Layout: vertical, spacingY:8, resizeMode:CONTAINER)
      Item1 (prefab 实例)
      Item2 (prefab 实例)
      ...`,
        tips: 'content 锚点设 (0.5,1) 以顶部对齐。使用 prefab 作为 Item。可添加 ScrollBar',
    },
    {
        name: 'tab_bar',
        description: '标签栏',
        structure: `TabBar (Widget: top+left+right, height:60)
  Tab1 (Button, Layout 子项)
  Tab2 (Button)
  Tab3 (Button)
ContentPanel (Widget: stretch, 显示当前标签内容)`,
        tips: '使用 Toggle 组件实现单选标签。通过切换 active 控制内容面板',
    },
    {
        name: 'hud',
        description: '游戏内 HUD 覆盖层',
        structure: `HUD (Widget: full)
  TopBar (Widget: top+left+right, height:80)
    Avatar (Sprite+Mask)
    HPBar (ProgressBar)
    CoinIcon + CoinLabel
    SettingsBtn (Button, 右上)
  BottomBar (Widget: bottom+left+right, height:120)
    SkillButtons (Layout: horizontal, spacingX:16)
    JoystickArea (左, 触摸输入)`,
        tips: '使用 SafeArea 避免 notch 遮挡。HUD 渲染优先级高于游戏场景',
    },
    {
        name: 'login',
        description: '登录界面',
        structure: `LoginPanel (居中, 500x400)
  Title (Label: "登录", fontSize:36, 顶部)
  AccountInput (EditBox, placeholder:"请输入账号")
  PasswordInput (EditBox, inputFlag:PASSWORD, placeholder:"请输入密码")
  LoginBtn (Button: "登录", 蓝色)
  RegisterBtn (Button: "注册", 文字按钮)
  VersionLabel (Label: "v1.0.0", 底部)`,
    },
    {
        name: 'settings',
        description: '设置界面',
        structure: `SettingsPanel (居中, 700x500)
  Title (Label: "设置")
  CloseBtn (右上)
  ScrollView
    content (Layout: vertical, spacingY:16)
      AudioSection (Slider: 音量)
      GraphicsSection (Dropdown: 画质)
      ControlSection (Toggle: 操作方式)
  ResetBtn (Button: "恢复默认", 底部)`,
    },
    {
        name: 'grid_inventory',
        description: '网格背包/仓库',
        structure: `InventoryPanel (居中, 600x500)
  Title (Label: "背包")
  CloseBtn (右上)
  TabBar (Layout: horizontal — 武器/防具/道具)
  ScrollView (Widget: stretch)
    content (Layout: GRID, constraint:FIXED_COL, constraintNum:4, spacingX:8, spacingY:8)
      Slot1 (Prefab: bg Sprite + icon Sprite + count Label)
      Slot2 ...
  DetailPanel (右侧或底部, 显示选中物品信息)`,
        tips: '使用 GRID 布局 + FIXED_COL。Slot 尺寸 = (contentWidth - padding - spacing*(cols-1)) / cols',
    },
    {
        name: 'leaderboard',
        description: '排行榜界面',
        structure: `LeaderboardPanel (居中, 600x700)
  Title (Label: "排行榜")
  TabBar (Layout: horizontal — 好友/全球)
  ScrollView
    content (Layout: vertical)
      RankItem1 (Prefab: Rank# + Avatar + Name + Score)
      RankItem2 ...
  MyRank (底部: 我的排名和分数)`,
    },
    {
        name: 'loading',
        description: '加载界面',
        structure: `LoadingRoot (Widget: full)
  BgSprite (全屏背景)
  LoadingText (Label: "加载中...", 居中)
  ProgressBar (ProgressBar, 居中, 300x20)
  TipsText (Label: "小提示", 底部)`,
    },
    {
        name: 'toast',
        description: '轻提示/Toast',
        structure: `ToastRoot (Widget: full, BlockInputEvents=false)
  ToastBg (Sprite: 半透明圆角矩形, 居中)
  ToastText (Label: "提示内容", 居中, fontSize:28)`,
        tips: '2-3 秒后自动销毁。使用 fade_in + fade_out 动画',
    },
    {
        name: 'shop',
        description: '商店界面',
        structure: `ShopPanel (居中, 800x600)
  Title (Label: "商店")
  CloseBtn (右上)
  TabBar (Layout: horizontal — 推荐/角色/道具/皮肤)
  ScrollView
    content (Layout: GRID, constraint:FIXED_COL, constraintNum:3)
      ShopItem (Prefab: Icon + Name + Price + BuyBtn)
  CurrencyBar (顶部: 金币/钻石数量)`,
    },
    {
        name: 'level_select',
        description: '关卡选择界面',
        structure: `LevelSelectPanel (居中, 800x600)
  Title (Label: "选择关卡")
  ScrollView
    content (Layout: GRID, constraint:FIXED_ROW, constraintNum:5)
      LevelNode1 (Button: "1-1", 显示关卡状态/星级)
      LevelNode2 ...
  BottomInfo (选中关卡信息: 名称/难度/掉落)`,
    },
];
exports.WIDGET_STRATEGIES = [
    { scenario: '全屏背景', description: '覆盖整个屏幕', widgetConfig: 'isAlignTop+isAlignBottom+isAlignLeft+isAlignRight = 0' },
    { scenario: '居中弹窗', description: '屏幕正中央', widgetConfig: 'isAlignVerticalCenter+isAlignHorizontalCenter = 0' },
    { scenario: '顶栏', description: '屏幕顶部固定', widgetConfig: 'isAlignTop + isAlignLeft + isAlignRight' },
    { scenario: '底栏', description: '屏幕底部固定', widgetConfig: 'isAlignBottom + isAlignLeft + isAlignRight' },
    { scenario: '安全区适配', description: '避开 notch/圆角', widgetConfig: 'SafeArea 组件 + alignMode=ON_WINDOW_RESIZE' },
    { scenario: '响应式布局', description: '随屏幕等比缩放', widgetConfig: 'isAbsoluteXxx=false（百分比模式）' },
    { scenario: '右上角按钮', description: '固定在右上角', widgetConfig: 'isAlignTop + isAlignRight' },
    { scenario: '左下角按钮', description: '固定在左下角', widgetConfig: 'isAlignBottom + isAlignLeft' },
];
exports.NODE_STRUCTURES = [
    {
        name: 'game_main',
        description: '通用游戏主场景',
        structure: `Scene
  Canvas (Canvas 组件, designResolution)
    Background (Sprite, Widget: full, 最低优先级)
    GameLayer (游戏内容)
      Map/Level (tiledmap 或 sprite-based)
      Player (Sprite + Animation + RigidBody2D)
      Enemies (敌人实例容器)
      Effects (粒子效果, 伤害数字)
    UILayer (Widget: full, 位于 GameLayer 之上)
      HUD (分数, 血量, 控制按钮)
      PauseBtn (右上)
    PopupLayer (弹窗, 最高优先级)
  Camera (Camera, ortho for 2D)
  AudioManager (AudioSource × 2: BGM + SFX)`,
        tips: '分离 game/UI/popup 层便于 z-order 控制。使用不同 Canvas 相机或 sortingOrder',
    },
    {
        name: 'main_menu',
        description: '主菜单场景',
        structure: `Canvas
  Background (Sprite, 全屏背景, 可能带动画)
  Title (Label, 大字号游戏标题, 居中偏上)
  MenuButtons (Layout: vertical, spacingY:24, 居中)
    StartBtn (Button: "开始游戏", 大号)
    SettingsBtn (Button: "设置")
    AboutBtn (Button: "关于")
  VersionLabel (Label: v1.0, 右下角)
  Decoration (Spine/粒子, 背景装饰)`,
    },
    {
        name: 'battle_scene',
        description: '战斗场景',
        structure: `Canvas
  BattleLayer (游戏战斗)
    BattleField (网格/六边形地图)
    UnitsContainer (双方单位)
      PlayerUnits (玩家单位)
      EnemyUnits (敌方单位)
    EffectLayer (技能特效)
  UILayer
    TopBar (回合信息, 资源)
    UnitInfo (选中单位详情)
    ActionPanel (技能按钮, 移动按钮)
    EndTurnBtn (结束回合)`,
    },
];
exports.ANIMATION_PATTERNS = [
    {
        name: 'fade_in',
        description: '淡入效果',
        method: 'cc.tween',
        code: `cc.tween(node).set({opacity:0}).to(0.3, {opacity:255}).start()`,
        requires: 'UIOpacity 组件',
        use_case: '弹窗打开, 场景过渡, 元素出现',
    },
    {
        name: 'fade_out',
        description: '淡出效果',
        method: 'cc.tween',
        code: `cc.tween(node).to(0.3, {opacity:0}).call(()=>node.destroy()).start()`,
        requires: 'UIOpacity 组件',
        use_case: '弹窗关闭, 元素消失',
    },
    {
        name: 'scale_bounce',
        description: '弹跳放大 (弹窗打开)',
        method: 'cc.tween',
        code: `cc.tween(node).set({scale:cc.v3(0,0,1)}).to(0.3, {scale:cc.v3(1.1,1.1,1)}).to(0.1, {scale:cc.v3(1,1,1)}).start()`,
        use_case: '弹窗打开, 奖励展示',
    },
    {
        name: 'scale_close',
        description: '缩小消失 (弹窗关闭)',
        method: 'cc.tween',
        code: `cc.tween(node).to(0.2, {scale:cc.v3(0,0,1)}).call(()=>node.destroy()).start()`,
        use_case: '弹窗关闭',
    },
    {
        name: 'slide_in_bottom',
        description: '从底部滑入',
        method: 'cc.tween',
        code: `const y=node.position.y; 
cc.tween(node)
  .set({position:cc.v3(node.position.x, y-500, 0)})
  .to(0.4, {position:cc.v3(node.position.x, y, 0)}, {easing:'backOut'})
  .start()`,
        use_case: '底部面板, 操作栏',
    },
    {
        name: 'slide_in_right',
        description: '从右侧滑入',
        method: 'cc.tween',
        code: `const x=node.position.x; 
cc.tween(node)
  .set({position:cc.v3(x+600, node.position.y, 0)})
  .to(0.3, {position:cc.v3(x, node.position.y, 0)}, {easing:'cubicOut'})
  .start()`,
        use_case: '侧边栏, 抽屉菜单',
    },
    {
        name: 'shake',
        description: '抖动/震动效果',
        method: 'cc.tween',
        code: `const p=node.position; 
cc.tween(node)
  .to(0.05,{position:cc.v3(p.x+5,p.y,0)})
  .to(0.05,{position:cc.v3(p.x-5,p.y,0)})
  .to(0.05,{position:cc.v3(p.x+3,p.y,0)})
  .to(0.05,{position:cc.v3(p.x,p.y,0)})
  .start()`,
        use_case: '受击效果, 错误反馈, 伤害表现',
    },
    {
        name: 'pulse',
        description: '持续脉动/呼吸效果',
        method: 'cc.tween',
        code: `cc.tween(node)
  .to(0.8, {scale:cc.v3(1.1,1.1,1)})
  .to(0.8, {scale:cc.v3(1,1,1)})
  .union().repeatForever().start()`,
        use_case: '高亮按钮, 可收集物品, 注意力吸引',
    },
    {
        name: 'float',
        description: '上下浮动循环',
        method: 'cc.tween',
        code: `const y=node.position.y; 
cc.tween(node)
  .to(1, {position:cc.v3(node.position.x, y+10, 0)})
  .to(1, {position:cc.v3(node.position.x, y-10, 0)})
  .union().repeatForever().start()`,
        use_case: '漂浮图标, 提示箭头, 待机动画',
    },
    {
        name: 'typewriter',
        description: '打字机文本效果',
        method: 'script',
        code: `async function typewriter(label: cc.Label, text: string, interval=0.05) {
  label.string = '';
  for (let i = 0; i < text.length; i++) {
    label.string += text[i];
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}`,
        use_case: '对话文本, 故事叙述',
    },
    {
        name: 'number_roll',
        description: '数字滚动计数',
        method: 'cc.tween',
        code: `const obj = { v: fromValue };
cc.tween(obj)
  .to(0.5, { v: toValue })
  .call(() => { label.string = Math.floor(obj.v).toString(); })
  .start()`,
        use_case: '分数变化, 金币获取, 伤害数字',
    },
    {
        name: 'flip_card',
        description: '卡片翻转 3D 效果 (Y轴旋转)',
        method: 'cc.tween',
        code: `cc.tween(node)
  .to(0.15, {scale:cc.v3(0,1,1)})
  .call(() => { /* swap front/back sprite */ })
  .to(0.15, {scale:cc.v3(1,1,1)})
  .start()`,
        use_case: '翻牌游戏, 卡片展示',
    },
    {
        name: 'combo_sequence',
        description: '级联入场序列 (多节点依次出现)',
        method: 'cc.tween',
        code: `items.forEach((node, i) => {
  cc.tween(node)
    .delay(i * 0.1)
    .set({opacity:0, scale:cc.v3(0.5,0.5,1)})
    .to(0.3, {opacity:255, scale:cc.v3(1,1,1)})
    .start();
})`,
        use_case: '列表项依次展示, 奖励物品级联, 菜单按钮序列',
    },
];
exports.BEST_PRACTICES = [
    {
        category: 'performance',
        title: '性能优化',
        rules: [
            '使用 SpriteAtlas 合批，减少 draw call',
            '使用 cc.NodePool 对象池管理频繁创建/销毁的对象（子弹/敌人/特效）',
            '避免在 update() 中调用 getComponent，在 onLoad/start 中缓存组件引用',
            '非移动 UI 元素启用 "Static" 标记进行静态合批',
            'Label cacheMode: 静态文本用 BITMAP，变化频繁的文本用 CHAR',
            '移动端粒子总数控制在 200 以内',
            'Spine/DragonBones 开启 Cache Mode 减少 CPU 开销',
        ],
    },
    {
        category: 'multi_resolution',
        title: '多分辨率适配',
        rules: [
            'Canvas 设计分辨率设为目标分辨率（如 1280x720 或 1920x1080）',
            '横屏游戏 fitHeight=true，竖屏游戏 fitWidth=true',
            '所有 UI 定位使用 Widget，不要硬编码绝对坐标',
            '使用百分比模式 (isAbsolute=false) 适配不同屏幕',
            '背景图用 Widget full + 略大于屏幕覆盖所有比例',
            '使用 SafeArea 组件适配 notch/圆角设备',
            '测试比例: 16:9, 18:9, 19.5:9 (iPhone), 4:3 (iPad)',
        ],
    },
    {
        category: 'scene_management',
        title: '场景管理',
        rules: [
            '使用 cc.director.loadScene 切换场景',
            '使用 cc.director.preloadScene 预加载下一场景',
            'Additive UI: cc.resources.load 加载预制体后 instantiate 添加',
            '保留持久根节点 cc.game.addPersistRootNode 用于全局管理器',
            '分 Bundle 按场景/功能组织资源，按需加载',
            '场景切换时显示加载画面，防止白屏',
        ],
    },
    {
        category: 'input_handling',
        title: '触摸与输入',
        rules: [
            '使用 node.on(Node.EventType.TOUCH_START/MOVE/END) 处理触摸',
            'Button 组件自动处理状态过渡',
            '弹窗遮罩添加 BlockInputEvents 防穿透',
            '最小触摸目标 44x44 点',
            '防连点: 点击后 0.5s 内禁用按钮',
            '拖拽: 使用 TOUCH_MOVE delta + convertToNodeSpaceAR',
            '多指触控: 用 touch ID 区分不同触点',
        ],
    },
    {
        category: 'memory_management',
        title: '资源与内存管理',
        rules: [
            '离开场景时释放未使用资源: cc.assetManager.releaseAsset()',
            '使用 AssetBundle.release() 释放整个 Bundle',
            '场景设置自动释放 (autoReleaseAssets)',
            '动态纹理用完即销毁',
            'Spine/DragonBones: 不再使用的角色释放骨骼数据资源',
            '监控: 调试时使用 cc.assetManager.assets 检查已加载资源',
            '纹理压缩: 移动端使用 ASTC/ETC2, Web 用 WebP',
        ],
    },
    {
        category: 'audio',
        title: '音频实现',
        rules: [
            'BGM 和 SFX 使用独立 AudioSource 组件，独立控制音量',
            'BGM: loop=true, 一个 AudioSource, 淡入淡出切换',
            'SFX: playOneShot() 播放短音效，允许重叠',
            '需要即时响应的音效（按钮/打击）预加载音频',
            '移动端: 首次用户交互后才播放音频 — 在首次触摸时队列 BGM',
            '格式: BGM 用 MP3 (压缩), SFX 用 OGG/WAV (低延迟)',
            '全局音频管理器跨场景常驻: cc.game.addPersistRootNode',
        ],
    },
    {
        category: 'animation_tips',
        title: '动画实现技巧',
        rules: [
            '代码驱动动画优先使用 cc.tween 而非 Animation 组件',
            '复杂时间线动画使用 Animation 组件在编辑器创作',
            '缓动函数: backOut 弹跳弹入, cubicOut 平滑减速, elasticOut 弹簧效果',
            '每次开始新 tween 前停掉旧 tween: cc.Tween.stopAllByTarget(node)',
            'UI 过渡 0.2-0.3s 最敏捷, 0.5s+ 显拖沓',
            'Spine: 用 timeScale 控制速度, setMix() 平滑过渡',
            '批量动画: delay(i*0.05) 实现级联入场效果',
        ],
    },
    {
        category: 'ui_architecture',
        title: 'UI 系统架构',
        rules: [
            '层级顺序: Background → GameLayer → UILayer → PopupLayer → ToastLayer',
            'UIManager 单例管理弹窗栈 (open/close/back)',
            '每个面板是一个预制体，按需加载，关闭时销毁',
            '数据模型与视图分离 — 数据变化时更新视图',
            '使用 cc.EventTarget 或自定义 EventBus 跨面板通信',
            '文本使用 i18n key，不硬编码',
            '通用组件（确认弹窗/物品槽）提取为可复用 Prefab',
        ],
    },
];
// ==================== 知识库索引 ====================
exports.KNOWLEDGE_TOPICS = [
    { name: 'component_properties', title: '组件属性大全', description: '所有 Cocos 组件的完整属性列表及类型说明', count: Object.keys(exports.COMPONENT_PROPERTIES).length },
    { name: 'ui_design_rules', title: 'UI 设计规范', description: '坐标系统/边界框/触摸目标/字号/间距/安全区等', count: Object.keys(exports.UI_DESIGN_RULES).length },
    { name: 'layout_patterns', title: 'UI 布局模板', description: '12 种常见 UI 布局的推荐节点结构', count: exports.LAYOUT_PATTERNS.length },
    { name: 'widget_strategy', title: 'Widget 对齐策略', description: '全屏/居中/顶栏/底栏/安全区等 Widget 配置', count: exports.WIDGET_STRATEGIES.length },
    { name: 'node_structure', title: '场景节点架构', description: '游戏主场景/主菜单/战斗场景等推荐节点层级', count: exports.NODE_STRUCTURES.length },
    { name: 'animation_patterns', title: '动画预设', description: '13 种常见动画效果的 tween 代码', count: exports.ANIMATION_PATTERNS.length },
    { name: 'best_practices', title: '最佳实践', description: '性能/多分辨率/场景管理/输入/内存/音频/动画/UI 架构', count: exports.BEST_PRACTICES.length },
];
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoia25vd2xlZGdlRGF0YS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NvdXJjZS9tY3Ava25vd2xlZGdlL2tub3dsZWRnZURhdGEudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7O0dBT0c7OztBQWdCVSxRQUFBLG9CQUFvQixHQUFrQztJQUMvRCxXQUFXLEVBQUU7UUFDVCxJQUFJLEVBQUUsV0FBVztRQUNqQixXQUFXLEVBQUUsNEJBQTRCO1FBQ3pDLFVBQVUsRUFBRTtZQUNSLFdBQVcsRUFBRSxFQUFFLElBQUksRUFBRSxnQkFBZ0IsRUFBRSxXQUFXLEVBQUUsTUFBTSxFQUFFO1lBQzVELFdBQVcsRUFBRSxFQUFFLElBQUksRUFBRSxnQkFBZ0IsRUFBRSxXQUFXLEVBQUUsS0FBSyxFQUFFO1lBQzNELElBQUksRUFBRSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsV0FBVyxFQUFFLGtDQUFrQyxFQUFFLE9BQU8sRUFBRSxDQUFDLEVBQUU7WUFDbkYsUUFBUSxFQUFFLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxXQUFXLEVBQUUsbUNBQW1DLEVBQUUsT0FBTyxFQUFFLENBQUMsRUFBRTtZQUN4RixVQUFVLEVBQUUsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLFdBQVcsRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLGVBQWUsRUFBRTtZQUMvRSxTQUFTLEVBQUUsRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUUsT0FBTyxFQUFFLENBQUMsRUFBRTtZQUM3RCxTQUFTLEVBQUUsRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUUsT0FBTyxFQUFFLENBQUMsRUFBRTtZQUM3RCxJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLFdBQVcsRUFBRSxTQUFTLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRTtZQUNoRSxTQUFTLEVBQUUsRUFBRSxJQUFJLEVB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LEVBQUUsTUFBTSxFQUFFLFdBQVcsRUFBRSxnQ0FBZ0MsRUFBRSxLQUFLLEVBQUUsc0JBQWMsQ0FBQyxNQUFNLEVBQUU7Q0FDekgsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ29jb3MgQ3JlYXRvciDnn6Xor4blupPmlbDmja5cbiAqIFxuICogNyDlpKfkuLvpopjljp/lp4vmlbDmja7vvJpjb21wb25lbnRfcHJvcGVydGllcyAvIHVpX2Rlc2lnbl9ydWxlcyAvIGxheW91dF9wYXR0ZXJucyAvXG4gKiB3aWRnZXRfc3RyYXRlZ3kgLyBub2RlX3N0cnVjdHVyZSAvIGFuaW1hdGlvbl9wYXR0ZXJucyAvIGJlc3RfcHJhY3RpY2VzXG4gKiBcbiAqIOa3t+WQiOaooeW8j++8mmluaXRpYWxpemUg5rOo5YWl5YWz6ZSu5pGY6KaBICsga25vd2xlZGdlX3F1ZXJ5IOW3peWFt+i/lOWbnuivpue7huWGheWuuVxuICovXG5cbi8vID09PT09PT09PT09PT09PT09PT09IDEuIOe7hOS7tuWxnuaApyAoY29tcG9uZW50X3Byb3BlcnRpZXMpID09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tcG9uZW50UHJvcEluZm8ge1xuICAgIHR5cGU6IHN0cmluZztcbiAgICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICAgIGRlZmF1bHQ/OiBhbnk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tcG9uZW50SW5mbyB7XG4gICAgdHlwZTogc3RyaW5nO1xuICAgIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gICAgcHJvcGVydGllczogUmVjb3JkPHN0cmluZywgQ29tcG9uZW50UHJvcEluZm8+O1xufVxuXG5leHBvcnQgY29uc3QgQ09NUE9ORU5UX1BST1BFUlRJRVM6IFJlY29yZDxzdHJpbmcsIENvbXBvbmVudEluZm8+ID0ge1xuICAgICdjYy5TcHJpdGUnOiB7XG4gICAgICAgIHR5cGU6ICdjYy5TcHJpdGUnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ+eyvueBtea4suafk+e7hOS7tu+8iGV4dGVuZHMgVUlSZW5kZXJlcu+8iScsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIHNwcml0ZUF0bGFzOiB7IHR5cGU6ICdjYy5TcHJpdGVBdGxhcycsIGRlc2NyaXB0aW9uOiAn57K+54G15Zu+6ZuGJyB9LFxuICAgICAgICAgICAgc3ByaXRlRnJhbWU6IHsgdHlwZTogJ2NjLlNwcml0ZUZyYW1lJywgZGVzY3JpcHRpb246ICfnsr7ngbXluKcnIH0sXG4gICAgICAgICAgICB0eXBlOiB7IHR5cGU6ICdFbnVtJywgZGVzY3JpcHRpb246ICfmuLLmn5PnsbvlnovvvIhTSU1QTEUvU0xJQ0VEL1RJTEVEL0ZJTExFRO+8iScsIGRlZmF1bHQ6IDAgfSxcbiAgICAgICAgICAgIGZpbGxUeXBlOiB7IHR5cGU6ICdFbnVtJywgZGVzY3JpcHRpb246ICfloavlhYXnsbvlnosgKEhPUklaT05UQUwvVkVSVElDQUwvUkFESUFMKScsIGRlZmF1bHQ6IDAgfSxcbiAgICAgICAgICAgIGZpbGxDZW50ZXI6IHsgdHlwZTogJ2NjLlZlYzInLCBkZXNjcmlwdGlvbjogJ+Whq+WFheS4reW/g+eCuScsIGRlZmF1bHQ6ICd7XCJ4XCI6MCxcInlcIjowfScgfSxcbiAgICAgICAgICAgIGZpbGxTdGFydDogeyB0eXBlOiAnRmxvYXQnLCBkZXNjcmlwdGlvbjogJ+Whq+WFhei1t+WniycsIGRlZmF1bHQ6IDAgfSxcbiAgICAgICAgICAgIGZpbGxSYW5nZTogeyB0eXBlOiAnRmxvYXQnLCBkZXNjcmlwdGlvbjogJ+Whq+WFheiMg+WbtCcsIGRlZmF1bHQ6IDAgfSxcbiAgICAgICAgICAgIHRyaW06IHsgdHlwZTogJ0Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+aYr+WQpuijgeWJqumAj+aYjui+uScsIGRlZmF1bHQ6IHRydWUgfSxcbiAgICAgICAgICAgIGdyYXlzY2FsZTogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn54Gw5bqm5qih5byPJywgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgICAgIHNpemVNb2RlOiB7IHR5cGU6ICdFbnVtJywgZGVzY3JpcHRpb246ICflsLrlr7jov73ouKrmqKHlvI8gKFJBVy9UUklNTUVEL0NVU1RPTSknLCBkZWZhdWx0OiAxIH0sXG4gICAgICAgIH0sXG4gICAgfSxcbiAgICAnY2MuTGFiZWwnOiB7XG4gICAgICAgIHR5cGU6ICdjYy5MYWJlbCcsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn5paH5pys5qCH562+57uE5Lu277yIZXh0ZW5kcyBVSVJlbmRlcmVy77yJJyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgc3RyaW5nOiB7IHR5cGU6ICdTdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aWh+acrOWGheWuuScsIGRlZmF1bHQ6ICdsYWJlbCcgfSxcbiAgICAgICAgICAgIGhvcml6b250YWxBbGlnbjogeyB0eXBlOiAnRW51bScsIGRlc2NyaXB0aW9uOiAn5rC05bmz5a+56b2QIChMRUZUL0NFTlRFUi9SSUdIVCknLCBkZWZhdWx0OiAxIH0sXG4gICAgICAgICAgICB2ZXJ0aWNhbEFsaWduOiB7IHR5cGU6ICdFbnVtJywgZGVzY3JpcHRpb246ICflnoLnm7Tlr7npvZAgKFRPUC9DRU5URVIvQk9UVE9NKScsIGRlZmF1bHQ6IDEgfSxcbiAgICAgICAgICAgIGFjdHVhbEZvbnRTaXplOiB7IHR5cGU6ICdGbG9hdCcsIGRlc2NyaXB0aW9uOiAn5a6e6ZmF5riy5p+T5a2X5Y+377yIc2hyaW5rIOaooeW8j++8iScgfSxcbiAgICAgICAgICAgIGZvbnRTaXplOiB7IHR5cGU6ICdGbG9hdCcsIGRlc2NyaXB0aW9uOiAn5a2X5Y+3JywgZGVmYXVsdDogNDAgfSxcbiAgICAgICAgICAgIGxpbmVIZWlnaHQ6IHsgdHlwZTogJ0Zsb2F0JywgZGVzY3JpcHRpb246ICfooYzpq5gnLCBkZWZhdWx0OiA0MCB9LFxuICAgICAgICAgICAgc3BhY2luZ1g6IHsgdHlwZTogJ0Zsb2F0JywgZGVzY3JpcHRpb246ICflrZfnrKbpl7Tot53vvIjku4UgQk1Gb25077yJJywgZGVmYXVsdDogMCB9LFxuICAgICAgICAgICAgb3ZlcmZsb3c6IHsgdHlwZTogJ0VudW0nLCBkZXNjcmlwdGlvbjogJ+a6ouWHuuaooeW8jyAoTk9ORS9DTEFNUC9TSFJJTksvUkVTSVpFX0hFSUdIVCknLCBkZWZhdWx0OiAwIH0sXG4gICAgICAgICAgICBlbmFibGVXcmFwVGV4dDogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn6Ieq5Yqo5o2i6KGMJywgZGVmYXVsdDogdHJ1ZSB9LFxuICAgICAgICAgICAgdXNlU3lzdGVtRm9udDogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5L2/55So57O757uf5a2X5L2TJywgZGVmYXVsdDogdHJ1ZSB9LFxuICAgICAgICAgICAgZm9udEZhbWlseTogeyB0eXBlOiAnU3RyaW5nJywgZGVzY3JpcHRpb246ICflrZfkvZPml4/lkI0nLCBkZWZhdWx0OiAnQXJpYWwnIH0sXG4gICAgICAgICAgICBmb250OiB7IHR5cGU6ICdjYy5Gb250JywgZGVzY3JpcHRpb246ICfoh6rlrprkuYnlrZfkvZPotYTmupAnIH0sXG4gICAgICAgICAgICBjYWNoZU1vZGU6IHsgdHlwZTogJ0VudW0nLCBkZXNjcmlwdGlvbjogJ+e8k+WtmOaooeW8jyAoTk9ORS9CSVRNQVAvQ0hBUiknLCBkZWZhdWx0OiAwIH0sXG4gICAgICAgICAgICBpc0JvbGQ6IHsgdHlwZTogJ0Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+WKoOeylycsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICAgICAgICBpc0l0YWxpYzogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5pac5L2TJywgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgICAgIGlzVW5kZXJsaW5lOiB7IHR5cGU6ICdCb29sZWFuJywgZGVzY3JpcHRpb246ICfkuIvliJLnur8nLCBkZWZhdWx0OiBmYWxzZSB9LFxuICAgICAgICAgICAgdW5kZXJsaW5lSGVpZ2h0OiB7IHR5cGU6ICdGbG9hdCcsIGRlc2NyaXB0aW9uOiAn5LiL5YiS57q/6auY5bqmJywgZGVmYXVsdDogMiB9LFxuICAgICAgICAgICAgZW5hYmxlT3V0bGluZTogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5ZCv55So5o+P6L65JywgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgICAgIG91dGxpbmVDb2xvcjogeyB0eXBlOiAnY2MuQ29sb3InLCBkZXNjcmlwdGlvbjogJ+aPj+i+ueminOiJsicgfSxcbiAgICAgICAgICAgIG91dGxpbmVXaWR0aDogeyB0eXBlOiAnRmxvYXQnLCBkZXNjcmlwdGlvbjogJ+aPj+i+ueWuveW6picsIGRlZmF1bHQ6IDIgfSxcbiAgICAgICAgICAgIGVuYWJsZVNoYWRvdzogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5ZCv55So6Zi05b2xJywgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgICAgIHNoYWRvd0NvbG9yOiB7IHR5cGU6ICdjYy5Db2xvcicsIGRlc2NyaXB0aW9uOiAn6Zi05b2x6aKc6ImyJyB9LFxuICAgICAgICAgICAgc2hhZG93T2Zmc2V0OiB7IHR5cGU6ICdjYy5WZWMyJywgZGVzY3JpcHRpb246ICfpmLTlvbHlgY/np7snLCBkZWZhdWx0OiAne1wieFwiOjIsXCJ5XCI6Mn0nIH0sXG4gICAgICAgICAgICBzaGFkb3dCbHVyOiB7IHR5cGU6ICdGbG9hdCcsIGRlc2NyaXB0aW9uOiAn6Zi05b2x5qih57OKJywgZGVmYXVsdDogMiB9LFxuICAgICAgICB9LFxuICAgIH0sXG4gICAgJ2NjLkJ1dHRvbic6IHtcbiAgICAgICAgdHlwZTogJ2NjLkJ1dHRvbicsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn5oyJ6ZKu57uE5Lu277yIZXh0ZW5kcyBDb21wb25lbnTvvIknLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICB0YXJnZXQ6IHsgdHlwZTogJ2NjLk5vZGUnLCBkZXNjcmlwdGlvbjogJ+i/h+a4oeebruagh+iKgueCuScgfSxcbiAgICAgICAgICAgIGludGVyYWN0YWJsZTogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5piv5ZCm5Y+v5Lqk5LqSJywgZGVmYXVsdDogdHJ1ZSB9LFxuICAgICAgICAgICAgdHJhbnNpdGlvbjogeyB0eXBlOiAnRW51bScsIGRlc2NyaXB0aW9uOiAn6L+H5rih57G75Z6LIChOT05FL0NPTE9SL1NQUklURS9TQ0FMRSknLCBkZWZhdWx0OiAwIH0sXG4gICAgICAgICAgICBub3JtYWxDb2xvcjogeyB0eXBlOiAnY2MuQ29sb3InLCBkZXNjcmlwdGlvbjogJ+aZrumAmueKtuaAgeminOiJsicgfSxcbiAgICAgICAgICAgIHByZXNzZWRDb2xvcjogeyB0eXBlOiAnY2MuQ29sb3InLCBkZXNjcmlwdGlvbjogJ+aMieS4i+eKtuaAgeminOiJsicgfSxcbiAgICAgICAgICAgIGhvdmVyQ29sb3I6IHsgdHlwZTogJ2NjLkNvbG9yJywgZGVzY3JpcHRpb246ICfmgqzlgZznirbmgIHpopzoibInIH0sXG4gICAgICAgICAgICBkaXNhYmxlZENvbG9yOiB7IHR5cGU6ICdjYy5Db2xvcicsIGRlc2NyaXB0aW9uOiAn56aB55So54q25oCB6aKc6ImyJyB9LFxuICAgICAgICAgICAgZHVyYXRpb246IHsgdHlwZTogJ0Zsb2F0JywgZGVzY3JpcHRpb246ICfov4fmuKHmjIHnu63ml7bpl7QnLCBkZWZhdWx0OiAwLjEgfSxcbiAgICAgICAgICAgIHpvb21TY2FsZTogeyB0eXBlOiAnRmxvYXQnLCBkZXNjcmlwdGlvbjogJ+e8qeaUvuavlOS+iycsIGRlZmF1bHQ6IDEuMiB9LFxuICAgICAgICAgICAgbm9ybWFsU3ByaXRlOiB7IHR5cGU6ICdjYy5TcHJpdGVGcmFtZScsIGRlc2NyaXB0aW9uOiAn5pmu6YCa54q25oCB57K+54G1JyB9LFxuICAgICAgICAgICAgcHJlc3NlZFNwcml0ZTogeyB0eXBlOiAnY2MuU3ByaXRlRnJhbWUnLCBkZXNjcmlwdGlvbjogJ+aMieS4i+eKtuaAgeeyvueBtScgfSxcbiAgICAgICAgICAgIGhvdmVyU3ByaXRlOiB7IHR5cGU6ICdjYy5TcHJpdGVGcmFtZScsIGRlc2NyaXB0aW9uOiAn5oKs5YGc54q25oCB57K+54G1JyB9LFxuICAgICAgICAgICAgZGlzYWJsZWRTcHJpdGU6IHsgdHlwZTogJ2NjLlNwcml0ZUZyYW1lJywgZGVzY3JpcHRpb246ICfnpoHnlKjnirbmgIHnsr7ngbUnIH0sXG4gICAgICAgICAgICBjbGlja0V2ZW50czogeyB0eXBlOiAnY2MuQ29tcG9uZW50LkV2ZW50SGFuZGxlcltdJywgZGVzY3JpcHRpb246ICfngrnlh7vkuovku7blpITnkIblmagnIH0sXG4gICAgICAgIH0sXG4gICAgfSxcbiAgICAnY2MuV2lkZ2V0Jzoge1xuICAgICAgICB0eXBlOiAnY2MuV2lkZ2V0JyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdVSSDlr7npvZDnu4Tku7bvvIhleHRlbmRzIENvbXBvbmVudO+8iScsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIHRhcmdldDogeyB0eXBlOiAnY2MuTm9kZScsIGRlc2NyaXB0aW9uOiAn5a+56b2Q55uu5qCH77yI6buY6K6k54i26IqC54K577yJJyB9LFxuICAgICAgICAgICAgaXNBbGlnblRvcDogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5a+56b2Q6aG26YOoJywgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgICAgIGlzQWxpZ25Cb3R0b206IHsgdHlwZTogJ0Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+Wvuem9kOW6lemDqCcsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICAgICAgICBpc0FsaWduTGVmdDogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5a+56b2Q5bem6L65JywgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgICAgIGlzQWxpZ25SaWdodDogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5a+56b2Q5Y+z6L65JywgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgICAgIGlzQWxpZ25WZXJ0aWNhbENlbnRlcjogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5Z6C55u05bGF5LitJywgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgICAgIGlzQWxpZ25Ib3Jpem9udGFsQ2VudGVyOiB7IHR5cGU6ICdCb29sZWFuJywgZGVzY3JpcHRpb246ICfmsLTlubPlsYXkuK0nLCBkZWZhdWx0OiBmYWxzZSB9LFxuICAgICAgICAgICAgdG9wOiB7IHR5cGU6ICdGbG9hdCcsIGRlc2NyaXB0aW9uOiAn6aG26YOo6L656LedJywgZGVmYXVsdDogMCB9LFxuICAgICAgICAgICAgYm90dG9tOiB7IHR5cGU6ICdGbG9hdCcsIGRlc2NyaXB0aW9uOiAn5bqV6YOo6L656LedJywgZGVmYXVsdDogMCB9LFxuICAgICAgICAgICAgbGVmdDogeyB0eXBlOiAnRmxvYXQnLCBkZXNjcmlwdGlvbjogJ+W3pui+uei3nScsIGRlZmF1bHQ6IDAgfSxcbiAgICAgICAgICAgIHJpZ2h0OiB7IHR5cGU6ICdGbG9hdCcsIGRlc2NyaXB0aW9uOiAn5Y+z6L656LedJywgZGVmYXVsdDogMCB9LFxuICAgICAgICAgICAgaG9yaXpvbnRhbENlbnRlcjogeyB0eXBlOiAnRmxvYXQnLCBkZXNjcmlwdGlvbjogJ+awtOW5s+WxheS4reWBj+enuycsIGRlZmF1bHQ6IDAgfSxcbiAgICAgICAgICAgIHZlcnRpY2FsQ2VudGVyOiB7IHR5cGU6ICdGbG9hdCcsIGRlc2NyaXB0aW9uOiAn5Z6C55u05bGF5Lit5YGP56e7JywgZGVmYXVsdDogMCB9LFxuICAgICAgICAgICAgaXNBYnNvbHV0ZVRvcDogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn6aG26YOo6L656Led5Li65YOP57SgL+eZvuWIhuavlCcsIGRlZmF1bHQ6IHRydWUgfSxcbiAgICAgICAgICAgIGlzQWJzb2x1dGVCb3R0b206IHsgdHlwZTogJ0Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+W6lemDqOi+uei3neS4uuWDj+e0oC/nmb7liIbmr5QnLCBkZWZhdWx0OiB0cnVlIH0sXG4gICAgICAgICAgICBpc0Fic29sdXRlTGVmdDogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5bem6L656Led5Li65YOP57SgL+eZvuWIhuavlCcsIGRlZmF1bHQ6IHRydWUgfSxcbiAgICAgICAgICAgIGlzQWJzb2x1dGVSaWdodDogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5Y+z6L656Led5Li65YOP57SgL+eZvuWIhuavlCcsIGRlZmF1bHQ6IHRydWUgfSxcbiAgICAgICAgICAgIGFsaWduTW9kZTogeyB0eXBlOiAnRW51bScsIGRlc2NyaXB0aW9uOiAn5a+56b2Q5Yi35paw5qih5byPIChPTkNFL09OX1dJTkRPV19SRVNJWkUvQUxXQVlTKScsIGRlZmF1bHQ6IDIgfSxcbiAgICAgICAgfSxcbiAgICB9LFxuICAgICdjYy5MYXlvdXQnOiB7XG4gICAgICAgIHR5cGU6ICdjYy5MYXlvdXQnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ+W4g+WxgOWuueWZqOe7hOS7tu+8iGV4dGVuZHMgQ29tcG9uZW5077yJJyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgdHlwZTogeyB0eXBlOiAnRW51bScsIGRlc2NyaXB0aW9uOiAn5biD5bGA57G75Z6LIChOT05FL0hPUklaT05UQUwvVkVSVElDQUwvR1JJRCknLCBkZWZhdWx0OiAwIH0sXG4gICAgICAgICAgICByZXNpemVNb2RlOiB7IHR5cGU6ICdFbnVtJywgZGVzY3JpcHRpb246ICfosIPmlbTmqKHlvI8gKE5PTkUvQ09OVEFJTkVSL0NISUxEUkVOKScsIGRlZmF1bHQ6IDAgfSxcbiAgICAgICAgICAgIGNlbGxTaXplOiB7IHR5cGU6ICdjYy5TaXplJywgZGVzY3JpcHRpb246ICfnvZHmoLzljZXlhYPlsLrlr7gnLCBkZWZhdWx0OiAne1wid2lkdGhcIjo0MCxcImhlaWdodFwiOjQwfScgfSxcbiAgICAgICAgICAgIHN0YXJ0QXhpczogeyB0eXBlOiAnRW51bScsIGRlc2NyaXB0aW9uOiAn572R5qC86LW35aeL6L20IChIT1JJWk9OVEFML1ZFUlRJQ0FMKScsIGRlZmF1bHQ6IDAgfSxcbiAgICAgICAgICAgIHBhZGRpbmdMZWZ0OiB7IHR5cGU6ICdGbG9hdCcsIGRlc2NyaXB0aW9uOiAn5bem5YaF6L656LedJywgZGVmYXVsdDogMCB9LFxuICAgICAgICAgICAgcGFkZGluZ1JpZ2h0OiB7IHR5cGU6ICdGbG9hdCcsIGRlc2NyaXB0aW9uOiAn5Y+z5YaF6L656LedJywgZGVmYXVsdDogMCB9LFxuICAgICAgICAgICAgcGFkZGluZ1RvcDogeyB0eXBlOiAnRmxvYXQnLCBkZXNjcmlwdGlvbjogJ+S4iuWGhei+uei3nScsIGRlZmF1bHQ6IDAgfSxcbiAgICAgICAgICAgIHBhZGRpbmdCb3R0b206IHsgdHlwZTogJ0Zsb2F0JywgZGVzY3JpcHRpb246ICfkuIvlhoXovrnot50nLCBkZWZhdWx0OiAwIH0sXG4gICAgICAgICAgICBzcGFjaW5nWDogeyB0eXBlOiAnRmxvYXQnLCBkZXNjcmlwdGlvbjogJ+awtOW5s+mXtOi3nScsIGRlZmF1bHQ6IDAgfSxcbiAgICAgICAgICAgIHNwYWNpbmdZOiB7IHR5cGU6ICdGbG9hdCcsIGRlc2NyaXB0aW9uOiAn5Z6C55u06Ze06LedJywgZGVmYXVsdDogMCB9LFxuICAgICAgICAgICAgY29uc3RyYWludDogeyB0eXBlOiAnRW51bScsIGRlc2NyaXB0aW9uOiAn57qm5p2f57G75Z6LIChOT05FL0ZJWEVEX0NPTC9GSVhFRF9ST1cpJywgZGVmYXVsdDogMCB9LFxuICAgICAgICAgICAgY29uc3RyYWludE51bTogeyB0eXBlOiAnRmxvYXQnLCBkZXNjcmlwdGlvbjogJ+e6puadn+aVsOmHjycsIGRlZmF1bHQ6IDIgfSxcbiAgICAgICAgICAgIGFmZmVjdGVkQnlTY2FsZTogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5Y+X5a2Q6IqC54K557yp5pS+5b2x5ZON5biD5bGAJywgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgfSxcbiAgICB9LFxuICAgICdjYy5TY3JvbGxWaWV3Jzoge1xuICAgICAgICB0eXBlOiAnY2MuU2Nyb2xsVmlldycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn5rua5Yqo6KeG5Zu+57uE5Lu277yIZXh0ZW5kcyBWaWV3R3JvdXDvvIknLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBjb250ZW50OiB7IHR5cGU6ICdjYy5Ob2RlJywgZGVzY3JpcHRpb246ICfmu5rliqjlhoXlrrnoioLngrknIH0sXG4gICAgICAgICAgICBob3Jpem9udGFsOiB7IHR5cGU6ICdCb29sZWFuJywgZGVzY3JpcHRpb246ICflkK/nlKjmsLTlubPmu5rliqgnLCBkZWZhdWx0OiB0cnVlIH0sXG4gICAgICAgICAgICB2ZXJ0aWNhbDogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5ZCv55So5Z6C55u05rua5YqoJywgZGVmYXVsdDogdHJ1ZSB9LFxuICAgICAgICAgICAgaG9yaXpvbnRhbFNjcm9sbEJhcjogeyB0eXBlOiAnY2MuU2Nyb2xsQmFyJywgZGVzY3JpcHRpb246ICfmsLTlubPmu5rliqjmnaEnIH0sXG4gICAgICAgICAgICB2ZXJ0aWNhbFNjcm9sbEJhcjogeyB0eXBlOiAnY2MuU2Nyb2xsQmFyJywgZGVzY3JpcHRpb246ICflnoLnm7Tmu5rliqjmnaEnIH0sXG4gICAgICAgICAgICBlbGFzdGljOiB7IHR5cGU6ICdCb29sZWFuJywgZGVzY3JpcHRpb246ICflvLnmgKflm57lvLknLCBkZWZhdWx0OiB0cnVlIH0sXG4gICAgICAgICAgICBpbmVydGlhOiB7IHR5cGU6ICdCb29sZWFuJywgZGVzY3JpcHRpb246ICfmg6/mgKfmu5rliqgnLCBkZWZhdWx0OiB0cnVlIH0sXG4gICAgICAgICAgICBib3VuY2VEdXJhdGlvbjogeyB0eXBlOiAnRmxvYXQnLCBkZXNjcmlwdGlvbjogJ+WbnuW8ueaMgee7reaXtumXtCcsIGRlZmF1bHQ6IDEgfSxcbiAgICAgICAgICAgIGJyYWtlOiB7IHR5cGU6ICdGbG9hdCcsIGRlc2NyaXB0aW9uOiAn5Yi25Yqo57O75pWwJywgZGVmYXVsdDogMC41IH0sXG4gICAgICAgICAgICBjYW5jZWxJbm5lckV2ZW50czogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5Y+W5raI5YaF6YOo6Kem5pG45LqL5Lu2JywgZGVmYXVsdDogdHJ1ZSB9LFxuICAgICAgICAgICAgc2Nyb2xsRXZlbnRzOiB7IHR5cGU6ICdjYy5Db21wb25lbnQuRXZlbnRIYW5kbGVyW10nLCBkZXNjcmlwdGlvbjogJ+a7muWKqOS6i+S7tuWbnuiwgycgfSxcbiAgICAgICAgfSxcbiAgICB9LFxuICAgICdjYy5FZGl0Qm94Jzoge1xuICAgICAgICB0eXBlOiAnY2MuRWRpdEJveCcsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn6L6T5YWl5qGG57uE5Lu277yIZXh0ZW5kcyBDb21wb25lbnTvvIknLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBzdHJpbmc6IHsgdHlwZTogJ1N0cmluZycsIGRlc2NyaXB0aW9uOiAn6L6T5YWl5paH5pysJyB9LFxuICAgICAgICAgICAgcGxhY2Vob2xkZXI6IHsgdHlwZTogJ1N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Y2g5L2N5o+Q56S65paH5pysJyB9LFxuICAgICAgICAgICAgdGV4dExhYmVsOiB7IHR5cGU6ICdjYy5MYWJlbCcsIGRlc2NyaXB0aW9uOiAn5paH5pys5qCH562+5byV55SoJyB9LFxuICAgICAgICAgICAgcGxhY2Vob2xkZXJMYWJlbDogeyB0eXBlOiAnY2MuTGFiZWwnLCBkZXNjcmlwdGlvbjogJ+WNoOS9jeagh+etvuW8leeUqCcgfSxcbiAgICAgICAgICAgIGJhY2tncm91bmRJbWFnZTogeyB0eXBlOiAnY2MuU3ByaXRlRnJhbWUnLCBkZXNjcmlwdGlvbjogJ+iDjOaZr+WbvueJhycgfSxcbiAgICAgICAgICAgIGlucHV0TW9kZTogeyB0eXBlOiAnRW51bScsIGRlc2NyaXB0aW9uOiAn6L6T5YWl5qih5byPIChBTlkvRU1BSUwvTlVNQkVSL1VSTC4uLiknLCBkZWZhdWx0OiAwIH0sXG4gICAgICAgICAgICBpbnB1dEZsYWc6IHsgdHlwZTogJ0VudW0nLCBkZXNjcmlwdGlvbjogJ+i+k+WFpeagh+ivhiAoUEFTU1dPUkQvU0VOU0lUSVZFLy4uLiknLCBkZWZhdWx0OiA1IH0sXG4gICAgICAgICAgICBtYXhMZW5ndGg6IHsgdHlwZTogJ0Zsb2F0JywgZGVzY3JpcHRpb246ICfmnIDlpKflrZfnrKbmlbAnLCBkZWZhdWx0OiAyMCB9LFxuICAgICAgICAgICAgdGFiSW5kZXg6IHsgdHlwZTogJ0Zsb2F0JywgZGVzY3JpcHRpb246ICdUYWIg57Si5byV77yI5LuFIFdlYu+8iScsIGRlZmF1bHQ6IDAgfSxcbiAgICAgICAgICAgIGVkaXRpbmdEaWRCZWdhbjogeyB0eXBlOiAnY2MuQ29tcG9uZW50LkV2ZW50SGFuZGxlcltdJywgZGVzY3JpcHRpb246ICflvIDlp4vnvJbovpHkuovku7YnIH0sXG4gICAgICAgICAgICB0ZXh0Q2hhbmdlZDogeyB0eXBlOiAnY2MuQ29tcG9uZW50LkV2ZW50SGFuZGxlcltdJywgZGVzY3JpcHRpb246ICfmlofmnKzlj5jljJbkuovku7YnIH0sXG4gICAgICAgICAgICBlZGl0aW5nRGlkRW5kZWQ6IHsgdHlwZTogJ2NjLkNvbXBvbmVudC5FdmVudEhhbmRsZXJbXScsIGRlc2NyaXB0aW9uOiAn57uT5p2f57yW6L6R5LqL5Lu2JyB9LFxuICAgICAgICAgICAgZWRpdGluZ1JldHVybjogeyB0eXBlOiAnY2MuQ29tcG9uZW50LkV2ZW50SGFuZGxlcltdJywgZGVzY3JpcHRpb246ICflm57ovabkuovku7YnIH0sXG4gICAgICAgIH0sXG4gICAgfSxcbiAgICAnY2MuVUlUcmFuc2Zvcm0nOiB7XG4gICAgICAgIHR5cGU6ICdjYy5VSVRyYW5zZm9ybScsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnVUkg5Y+Y5o2i57uE5Lu277yIZXh0ZW5kcyBDb21wb25lbnTvvIknLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBjb250ZW50U2l6ZTogeyB0eXBlOiAnY2MuU2l6ZScsIGRlc2NyaXB0aW9uOiAn5YaF5a655bC65a+4JywgZGVmYXVsdDogJ3tcIndpZHRoXCI6MTAwLFwiaGVpZ2h0XCI6MTAwfScgfSxcbiAgICAgICAgICAgIGFuY2hvclBvaW50OiB7IHR5cGU6ICdjYy5WZWMyJywgZGVzY3JpcHRpb246ICfplJrngrknLCBkZWZhdWx0OiAne1wieFwiOjAuNSxcInlcIjowLjV9JyB9LFxuICAgICAgICAgICAgcHJpb3JpdHk6IHsgdHlwZTogJ0Zsb2F0JywgZGVzY3JpcHRpb246ICfmuLLmn5PkvJjlhYjnuqcnLCBkZWZhdWx0OiAwIH0sXG4gICAgICAgIH0sXG4gICAgfSxcbiAgICAnY2MuQ2FudmFzJzoge1xuICAgICAgICB0eXBlOiAnY2MuQ2FudmFzJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICfnlLvluIPnu4Tku7bvvIhleHRlbmRzIENvbXBvbmVudO+8iScsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIGRlc2lnblJlc29sdXRpb246IHsgdHlwZTogJ2NjLlNpemUnLCBkZXNjcmlwdGlvbjogJ+iuvuiuoeWIhui+qOeOhycsIGRlZmF1bHQ6ICd7XCJ3aWR0aFwiOjk2MCxcImhlaWdodFwiOjY0MH0nIH0sXG4gICAgICAgICAgICBmaXRIZWlnaHQ6IHsgdHlwZTogJ0Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+mAgumFjemrmOW6picsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICAgICAgICBmaXRXaWR0aDogeyB0eXBlOiAnQm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn6YCC6YWN5a695bqmJywgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgfSxcbiAgICB9LFxufTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT0gMi4gVUkg6K6+6K6h6KeE5YiZICh1aV9kZXNpZ25fcnVsZXMpID09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCBjb25zdCBVSV9ERVNJR05fUlVMRVMgPSB7XG4gICAgY29vcmRpbmF0ZV9zeXN0ZW06IGBDYW52YXMgYW5jaG9yPSgwLjUsMC41KSwgKDAsMCk95bGP5bmV5Lit5b+D44CC5Y+v6KeB6IyD5Zu0OiB44oiIWy1kZXNpZ25XaWR0aC8yLCBkZXNpZ25XaWR0aC8yXSwgeeKIiFstZGVzaWduSGVpZ2h0LzIsIGRlc2lnbkhlaWdodC8yXWAsXG4gICAgYm91bmRpbmdfYm94OiBg6IqC54K5KHB4LHB5KeWwuuWvuCh3LGgp6ZSa54K5KGF4LGF5KTogbGVmdD1weC13KmF4LCByaWdodD1weCt3KigxLWF4KSwgYm90dG9tPXB5LWgqYXksIHRvcD1weStoKigxLWF5KWAsXG4gICAgcG9zaXRpb25pbmdfdGlwczogYOWxheS4rTogcG9zaXRpb249KDAsMCnjgILlhajlsY/og4zmma86IHNpemU9ZGVzaWduUmVzb2x1dGlvbiwgcG9zaXRpb249KDAsMCnjgILlj7PkuIrop5I6IHBvc2l0aW9uPShkZXNpZ25XaWR0aC8yLCBkZXNpZ25IZWlnaHQvMilgLFxuICAgIHRvdWNoX3RhcmdldHM6IGDmnIDlsI/op6bmkbjnm67moIc6IDQ0eDQ0IOeCuSAoODh4ODggQDJ4KeOAguaOqOiNkDogNDh4NDhgLFxuICAgIGZvbnRfc2l6ZXM6IGDmoIfpopg6IDMyLTQwLCDmraPmloc6IDI0LTI4LCDmoIfms6g6IDE4LTIyLCDmjInpkq46IDI0LTMyYCxcbiAgICBzcGFjaW5nOiBg5qCH5YeG6Ze06LedOiA4LCAxNiwgMjQsIDMyLCA0OOOAguS9v+eUqCA4IOeahOWAjeaVsGAsXG4gICAgY29sb3JzOiBg5paH5pys5a+55q+U5bqmID49IDQuNToxYCxcbiAgICBzYWZlX2FyZWE6IGBub3RjaCDljLrln586IOmhtumDqCA0NHB0LCDlupXpg6ggMzRwdCAoaVBob25lKWAsXG4gICAgYnV0dG9uX3NpemVzOiBg5bCPOiAxMjB4NDQsIOS4rTogMjAweDYwLCDlpKc6IDMwMHg4MOOAguacgOWwj+WuvSA9IOaWh+acrOWuvSArIDQ4YCxcbiAgICBtYXJnaW5zOiBg5bGP5bmV6L6557yYOiAxNi0yNHB444CC5YWD57Sg6Ze06LedOiA4LTE2cHjjgILljLrln5/pl7Tot506IDI0LTQ4cHhgLFxufTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT0gMy4g5biD5bGA5qih5byPIChsYXlvdXRfcGF0dGVybnMpID09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCBpbnRlcmZhY2UgTGF5b3V0UGF0dGVybiB7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gICAgc3RydWN0dXJlOiBzdHJpbmc7XG4gICAgdGlwcz86IHN0cmluZztcbn1cblxuZXhwb3J0IGNvbnN0IExBWU9VVF9QQVRURVJOUzogTGF5b3V0UGF0dGVybltdID0gW1xuICAgIHtcbiAgICAgICAgbmFtZTogJ2RpYWxvZycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn5qih5oCB5by556qXIChNb2RhbCBEaWFsb2cpJyxcbiAgICAgICAgc3RydWN0dXJlOiBgRGlhbG9nUm9vdCAoV2lkZ2V0OiBmdWxsLCDljYrpgI/mmI7pga7nvakgcmdiYSgwLDAsMCwxMjgpLCBCbG9ja0lucHV0RXZlbnRzKVxuICBQYW5lbCAoVUlUcmFuc2Zvcm06IDYwMHg0MDAsIOWxheS4rSlcbiAgICBUaXRsZSAoTGFiZWwsIGZvbnRTaXplOjMyLCDpobbpg6gpXG4gICAgQ2xvc2VCdG4gKEJ1dHRvbiwg5Y+z5LiK6KeSKVxuICAgIENvbnRlbnQgKExhYmVsL1JpY2hUZXh0LCDkuK3pl7QsIOWPr+a7muWKqClcbiAgICBCdXR0b25Hcm91cCAoTGF5b3V0OiBob3Jpem9udGFsLCBzcGFjaW5nWDoyNCwg5bqV6YOoKVxuICAgICAgQ2FuY2VsQnRuIChCdXR0b24pXG4gICAgICBDb25maXJtQnRuIChCdXR0b24pYCxcbiAgICAgICAgdGlwczogJ+S9v+eUqCBCbG9ja0lucHV0RXZlbnRzIOmYsuatoueCueWHu+epv+mAj+OAgua3u+WKoCBzY2FsZSAw4oaSMSDliqjnlLvmiZPlvIDmlYjmnpwnLFxuICAgIH0sXG4gICAge1xuICAgICAgICBuYW1lOiAnc2Nyb2xsX2xpc3QnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ+WeguebtC/msLTlubPmu5rliqjliJfooagnLFxuICAgICAgICBzdHJ1Y3R1cmU6IGBTY3JvbGxWaWV3IChTY3JvbGxWaWV3LCB2ZXJ0aWNhbDp0cnVlKVxuICB2aWV3IChNYXNrLCBXaWRnZXQ6IGZ1bGwpXG4gICAgY29udGVudCAoTGF5b3V0OiB2ZXJ0aWNhbCwgc3BhY2luZ1k6OCwgcmVzaXplTW9kZTpDT05UQUlORVIpXG4gICAgICBJdGVtMSAocHJlZmFiIOWunuS+iylcbiAgICAgIEl0ZW0yIChwcmVmYWIg5a6e5L6LKVxuICAgICAgLi4uYCxcbiAgICAgICAgdGlwczogJ2NvbnRlbnQg6ZSa54K56K6+ICgwLjUsMSkg5Lul6aG26YOo5a+56b2Q44CC5L2/55SoIHByZWZhYiDkvZzkuLogSXRlbeOAguWPr+a3u+WKoCBTY3JvbGxCYXInLFxuICAgIH0sXG4gICAge1xuICAgICAgICBuYW1lOiAndGFiX2JhcicsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn5qCH562+5qCPJyxcbiAgICAgICAgc3RydWN0dXJlOiBgVGFiQmFyIChXaWRnZXQ6IHRvcCtsZWZ0K3JpZ2h0LCBoZWlnaHQ6NjApXG4gIFRhYjEgKEJ1dHRvbiwgTGF5b3V0IOWtkOmhuSlcbiAgVGFiMiAoQnV0dG9uKVxuICBUYWIzIChCdXR0b24pXG5Db250ZW50UGFuZWwgKFdpZGdldDogc3RyZXRjaCwg5pi+56S65b2T5YmN5qCH562+5YaF5a65KWAsXG4gICAgICAgIHRpcHM6ICfkvb/nlKggVG9nZ2xlIOe7hOS7tuWunueOsOWNlemAieagh+etvuOAgumAmui/h+WIh+aNoiBhY3RpdmUg5o6n5Yi25YaF5a656Z2i5p2/JyxcbiAgICB9LFxuICAgIHtcbiAgICAgICAgbmFtZTogJ2h1ZCcsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn5ri45oiP5YaFIEhVRCDopobnm5blsYInLFxuICAgICAgICBzdHJ1Y3R1cmU6IGBIVUQgKFdpZGdldDogZnVsbClcbiAgVG9wQmFyIChXaWRnZXQ6IHRvcCtsZWZ0K3JpZ2h0LCBoZWlnaHQ6ODApXG4gICAgQXZhdGFyIChTcHJpdGUrTWFzaylcbiAgICBIUEJhciAoUHJvZ3Jlc3NCYXIpXG4gICAgQ29pbkljb24gKyBDb2luTGFiZWxcbiAgICBTZXR0aW5nc0J0biAoQnV0dG9uLCDlj7PkuIopXG4gIEJvdHRvbUJhciAoV2lkZ2V0OiBib3R0b20rbGVmdCtyaWdodCwgaGVpZ2h0OjEyMClcbiAgICBTa2lsbEJ1dHRvbnMgKExheW91dDogaG9yaXpvbnRhbCwgc3BhY2luZ1g6MTYpXG4gICAgSm95c3RpY2tBcmVhICjlt6YsIOinpuaRuOi+k+WFpSlgLFxuICAgICAgICB0aXBzOiAn5L2/55SoIFNhZmVBcmVhIOmBv+WFjSBub3RjaCDpga7mjKHjgIJIVUQg5riy5p+T5LyY5YWI57qn6auY5LqO5ri45oiP5Zy65pmvJyxcbiAgICB9LFxuICAgIHtcbiAgICAgICAgbmFtZTogJ2xvZ2luJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICfnmbvlvZXnlYzpnaInLFxuICAgICAgICBzdHJ1Y3R1cmU6IGBMb2dpblBhbmVsICjlsYXkuK0sIDUwMHg0MDApXG4gIFRpdGxlIChMYWJlbDogXCLnmbvlvZVcIiwgZm9udFNpemU6MzYsIOmhtumDqClcbiAgQWNjb3VudElucHV0IChFZGl0Qm94LCBwbGFjZWhvbGRlcjpcIuivt+i+k+WFpei0puWPt1wiKVxuICBQYXNzd29yZElucHV0IChFZGl0Qm94LCBpbnB1dEZsYWc6UEFTU1dPUkQsIHBsYWNlaG9sZGVyOlwi6K+36L6T5YWl5a+G56CBXCIpXG4gIExvZ2luQnRuIChCdXR0b246IFwi55m75b2VXCIsIOiTneiJsilcbiAgUmVnaXN0ZXJCdG4gKEJ1dHRvbjogXCLms6jlhoxcIiwg5paH5a2X5oyJ6ZKuKVxuICBWZXJzaW9uTGFiZWwgKExhYmVsOiBcInYxLjAuMFwiLCDlupXpg6gpYCxcbiAgICB9LFxuICAgIHtcbiAgICAgICAgbmFtZTogJ3NldHRpbmdzJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICforr7nva7nlYzpnaInLFxuICAgICAgICBzdHJ1Y3R1cmU6IGBTZXR0aW5nc1BhbmVsICjlsYXkuK0sIDcwMHg1MDApXG4gIFRpdGxlIChMYWJlbDogXCLorr7nva5cIilcbiAgQ2xvc2VCdG4gKOWPs+S4iilcbiAgU2Nyb2xsVmlld1xuICAgIGNvbnRlbnQgKExheW91dDogdmVydGljYWwsIHNwYWNpbmdZOjE2KVxuICAgICAgQXVkaW9TZWN0aW9uIChTbGlkZXI6IOmfs+mHjylcbiAgICAgIEdyYXBoaWNzU2VjdGlvbiAoRHJvcGRvd246IOeUu+i0qClcbiAgICAgIENvbnRyb2xTZWN0aW9uIChUb2dnbGU6IOaTjeS9nOaWueW8jylcbiAgUmVzZXRCdG4gKEJ1dHRvbjogXCLmgaLlpI3pu5jorqRcIiwg5bqV6YOoKWAsXG4gICAgfSxcbiAgICB7XG4gICAgICAgIG5hbWU6ICdncmlkX2ludmVudG9yeScsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn572R5qC86IOM5YyFL+S7k+W6kycsXG4gICAgICAgIHN0cnVjdHVyZTogYEludmVudG9yeVBhbmVsICjlsYXkuK0sIDYwMHg1MDApXG4gIFRpdGxlIChMYWJlbDogXCLog4zljIVcIilcbiAgQ2xvc2VCdG4gKOWPs+S4iilcbiAgVGFiQmFyIChMYXlvdXQ6IGhvcml6b250YWwg4oCUIOatpuWZqC/pmLLlhbcv6YGT5YW3KVxuICBTY3JvbGxWaWV3IChXaWRnZXQ6IHN0cmV0Y2gpXG4gICAgY29udGVudCAoTGF5b3V0OiBHUklELCBjb25zdHJhaW50OkZJWEVEX0NPTCwgY29uc3RyYWludE51bTo0LCBzcGFjaW5nWDo4LCBzcGFjaW5nWTo4KVxuICAgICAgU2xvdDEgKFByZWZhYjogYmcgU3ByaXRlICsgaWNvbiBTcHJpdGUgKyBjb3VudCBMYWJlbClcbiAgICAgIFNsb3QyIC4uLlxuICBEZXRhaWxQYW5lbCAo5Y+z5L6n5oiW5bqV6YOoLCDmmL7npLrpgInkuK3nianlk4Hkv6Hmga8pYCxcbiAgICAgICAgdGlwczogJ+S9v+eUqCBHUklEIOW4g+WxgCArIEZJWEVEX0NPTOOAglNsb3Qg5bC65a+4ID0gKGNvbnRlbnRXaWR0aCAtIHBhZGRpbmcgLSBzcGFjaW5nKihjb2xzLTEpKSAvIGNvbHMnLFxuICAgIH0sXG4gICAge1xuICAgICAgICBuYW1lOiAnbGVhZGVyYm9hcmQnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ+aOkuihjOamnOeVjOmdoicsXG4gICAgICAgIHN0cnVjdHVyZTogYExlYWRlcmJvYXJkUGFuZWwgKOWxheS4rSwgNjAweDcwMClcbiAgVGl0bGUgKExhYmVsOiBcIuaOkuihjOamnFwiKVxuICBUYWJCYXIgKExheW91dDogaG9yaXpvbnRhbCDigJQg5aW95Y+LL+WFqOeQgylcbiAgU2Nyb2xsVmlld1xuICAgIGNvbnRlbnQgKExheW91dDogdmVydGljYWwpXG4gICAgICBSYW5rSXRlbTEgKFByZWZhYjogUmFuayMgKyBBdmF0YXIgKyBOYW1lICsgU2NvcmUpXG4gICAgICBSYW5rSXRlbTIgLi4uXG4gIE15UmFuayAo5bqV6YOoOiDmiJHnmoTmjpLlkI3lkozliIbmlbApYCxcbiAgICB9LFxuICAgIHtcbiAgICAgICAgbmFtZTogJ2xvYWRpbmcnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ+WKoOi9veeVjOmdoicsXG4gICAgICAgIHN0cnVjdHVyZTogYExvYWRpbmdSb290IChXaWRnZXQ6IGZ1bGwpXG4gIEJnU3ByaXRlICjlhajlsY/og4zmma8pXG4gIExvYWRpbmdUZXh0IChMYWJlbDogXCLliqDovb3kuK0uLi5cIiwg5bGF5LitKVxuICBQcm9ncmVzc0JhciAoUHJvZ3Jlc3NCYXIsIOWxheS4rSwgMzAweDIwKVxuICBUaXBzVGV4dCAoTGFiZWw6IFwi5bCP5o+Q56S6XCIsIOW6lemDqClgLFxuICAgIH0sXG4gICAge1xuICAgICAgICBuYW1lOiAndG9hc3QnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ+i9u+aPkOekui9Ub2FzdCcsXG4gICAgICAgIHN0cnVjdHVyZTogYFRvYXN0Um9vdCAoV2lkZ2V0OiBmdWxsLCBCbG9ja0lucHV0RXZlbnRzPWZhbHNlKVxuICBUb2FzdEJnIChTcHJpdGU6IOWNiumAj+aYjuWchuinkuefqeW9oiwg5bGF5LitKVxuICBUb2FzdFRleHQgKExhYmVsOiBcIuaPkOekuuWGheWuuVwiLCDlsYXkuK0sIGZvbnRTaXplOjI4KWAsXG4gICAgICAgIHRpcHM6ICcyLTMg56eS5ZCO6Ieq5Yqo6ZSA5q+B44CC5L2/55SoIGZhZGVfaW4gKyBmYWRlX291dCDliqjnlLsnLFxuICAgIH0sXG4gICAge1xuICAgICAgICBuYW1lOiAnc2hvcCcsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn5ZWG5bqX55WM6Z2iJyxcbiAgICAgICAgc3RydWN0dXJlOiBgU2hvcFBhbmVsICjlsYXkuK0sIDgwMHg2MDApXG4gIFRpdGxlIChMYWJlbDogXCLllYblupdcIilcbiAgQ2xvc2VCdG4gKOWPs+S4iilcbiAgVGFiQmFyIChMYXlvdXQ6IGhvcml6b250YWwg4oCUIOaOqOiNkC/op5LoibIv6YGT5YW3L+earuiCpClcbiAgU2Nyb2xsVmlld1xuICAgIGNvbnRlbnQgKExheW91dDogR1JJRCwgY29uc3RyYWludDpGSVhFRF9DT0wsIGNvbnN0cmFpbnROdW06MylcbiAgICAgIFNob3BJdGVtIChQcmVmYWI6IEljb24gKyBOYW1lICsgUHJpY2UgKyBCdXlCdG4pXG4gIEN1cnJlbmN5QmFyICjpobbpg6g6IOmHkeW4gS/pkrvnn7PmlbDph48pYCxcbiAgICB9LFxuICAgIHtcbiAgICAgICAgbmFtZTogJ2xldmVsX3NlbGVjdCcsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn5YWz5Y2h6YCJ5oup55WM6Z2iJyxcbiAgICAgICAgc3RydWN0dXJlOiBgTGV2ZWxTZWxlY3RQYW5lbCAo5bGF5LitLCA4MDB4NjAwKVxuICBUaXRsZSAoTGFiZWw6IFwi6YCJ5oup5YWz5Y2hXCIpXG4gIFNjcm9sbFZpZXdcbiAgICBjb250ZW50IChMYXlvdXQ6IEdSSUQsIGNvbnN0cmFpbnQ6RklYRURfUk9XLCBjb25zdHJhaW50TnVtOjUpXG4gICAgICBMZXZlbE5vZGUxIChCdXR0b246IFwiMS0xXCIsIOaYvuekuuWFs+WNoeeKtuaAgS/mmJ/nuqcpXG4gICAgICBMZXZlbE5vZGUyIC4uLlxuICBCb3R0b21JbmZvICjpgInkuK3lhbPljaHkv6Hmga86IOWQjeensC/pmr7luqYv5o6J6JC9KWAsXG4gICAgfSxcbl07XG5cbi8vID09PT09PT09PT09PT09PT09PT09IDQuIFdpZGdldCDnrZbnlaUgKHdpZGdldF9zdHJhdGVneSkgPT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGludGVyZmFjZSBXaWRnZXRTdHJhdGVneSB7XG4gICAgc2NlbmFyaW86IHN0cmluZztcbiAgICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICAgIHdpZGdldENvbmZpZzogc3RyaW5nO1xufVxuXG5leHBvcnQgY29uc3QgV0lER0VUX1NUUkFURUdJRVM6IFdpZGdldFN0cmF0ZWd5W10gPSBbXG4gICAgeyBzY2VuYXJpbzogJ+WFqOWxj+iDjOaZrycsIGRlc2NyaXB0aW9uOiAn6KaG55uW5pW05Liq5bGP5bmVJywgd2lkZ2V0Q29uZmlnOiAnaXNBbGlnblRvcCtpc0FsaWduQm90dG9tK2lzQWxpZ25MZWZ0K2lzQWxpZ25SaWdodCA9IDAnIH0sXG4gICAgeyBzY2VuYXJpbzogJ+WxheS4reW8ueeqlycsIGRlc2NyaXB0aW9uOiAn5bGP5bmV5q2j5Lit5aSuJywgd2lkZ2V0Q29uZmlnOiAnaXNBbGlnblZlcnRpY2FsQ2VudGVyK2lzQWxpZ25Ib3Jpem9udGFsQ2VudGVyID0gMCcgfSxcbiAgICB7IHNjZW5hcmlvOiAn6aG25qCPJywgZGVzY3JpcHRpb246ICflsY/luZXpobbpg6jlm7rlrponLCB3aWRnZXRDb25maWc6ICdpc0FsaWduVG9wICsgaXNBbGlnbkxlZnQgKyBpc0FsaWduUmlnaHQnIH0sXG4gICAgeyBzY2VuYXJpbzogJ+W6leagjycsIGRlc2NyaXB0aW9uOiAn5bGP5bmV5bqV6YOo5Zu65a6aJywgd2lkZ2V0Q29uZmlnOiAnaXNBbGlnbkJvdHRvbSArIGlzQWxpZ25MZWZ0ICsgaXNBbGlnblJpZ2h0JyB9LFxuICAgIHsgc2NlbmFyaW86ICflronlhajljLrpgILphY0nLCBkZXNjcmlwdGlvbjogJ+mBv+W8gCBub3RjaC/lnIbop5InLCB3aWRnZXRDb25maWc6ICdTYWZlQXJlYSDnu4Tku7YgKyBhbGlnbk1vZGU9T05fV0lORE9XX1JFU0laRScgfSxcbiAgICB7IHNjZW5hcmlvOiAn5ZON5bqU5byP5biD5bGAJywgZGVzY3JpcHRpb246ICfpmo/lsY/luZXnrYnmr5TnvKnmlL4nLCB3aWRnZXRDb25maWc6ICdpc0Fic29sdXRlWHh4PWZhbHNl77yI55m+5YiG5q+U5qih5byP77yJJyB9LFxuICAgIHsgc2NlbmFyaW86ICflj7PkuIrop5LmjInpkq4nLCBkZXNjcmlwdGlvbjogJ+WbuuWumuWcqOWPs+S4iuinkicsIHdpZGdldENvbmZpZzogJ2lzQWxpZ25Ub3AgKyBpc0FsaWduUmlnaHQnIH0sXG4gICAgeyBzY2VuYXJpbzogJ+W3puS4i+inkuaMiemSricsIGRlc2NyaXB0aW9uOiAn5Zu65a6a5Zyo5bem5LiL6KeSJywgd2lkZ2V0Q29uZmlnOiAnaXNBbGlnbkJvdHRvbSArIGlzQWxpZ25MZWZ0JyB9LFxuXTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT0gNS4g6IqC54K557uT5p6E5qih5p2/IChub2RlX3N0cnVjdHVyZSkgPT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGludGVyZmFjZSBOb2RlU3RydWN0dXJlVGVtcGxhdGUge1xuICAgIG5hbWU6IHN0cmluZztcbiAgICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICAgIHN0cnVjdHVyZTogc3RyaW5nO1xuICAgIHRpcHM/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBOT0RFX1NUUlVDVFVSRVM6IE5vZGVTdHJ1Y3R1cmVUZW1wbGF0ZVtdID0gW1xuICAgIHtcbiAgICAgICAgbmFtZTogJ2dhbWVfbWFpbicsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn6YCa55So5ri45oiP5Li75Zy65pmvJyxcbiAgICAgICAgc3RydWN0dXJlOiBgU2NlbmVcbiAgQ2FudmFzIChDYW52YXMg57uE5Lu2LCBkZXNpZ25SZXNvbHV0aW9uKVxuICAgIEJhY2tncm91bmQgKFNwcml0ZSwgV2lkZ2V0OiBmdWxsLCDmnIDkvY7kvJjlhYjnuqcpXG4gICAgR2FtZUxheWVyICjmuLjmiI/lhoXlrrkpXG4gICAgICBNYXAvTGV2ZWwgKHRpbGVkbWFwIOaIliBzcHJpdGUtYmFzZWQpXG4gICAgICBQbGF5ZXIgKFNwcml0ZSArIEFuaW1hdGlvbiArIFJpZ2lkQm9keTJEKVxuICAgICAgRW5lbWllcyAo5pWM5Lq65a6e5L6L5a655ZmoKVxuICAgICAgRWZmZWN0cyAo57KS5a2Q5pWI5p6cLCDkvKTlrrPmlbDlrZcpXG4gICAgVUlMYXllciAoV2lkZ2V0OiBmdWxsLCDkvY3kuo4gR2FtZUxheWVyIOS5i+S4iilcbiAgICAgIEhVRCAo5YiG5pWwLCDooYDph48sIOaOp+WItuaMiemSrilcbiAgICAgIFBhdXNlQnRuICjlj7PkuIopXG4gICAgUG9wdXBMYXllciAo5by556qXLCDmnIDpq5jkvJjlhYjnuqcpXG4gIENhbWVyYSAoQ2FtZXJhLCBvcnRobyBmb3IgMkQpXG4gIEF1ZGlvTWFuYWdlciAoQXVkaW9Tb3VyY2Ugw5cgMjogQkdNICsgU0ZYKWAsXG4gICAgICAgIHRpcHM6ICfliIbnprsgZ2FtZS9VSS9wb3B1cCDlsYLkvr/kuo4gei1vcmRlciDmjqfliLbjgILkvb/nlKjkuI3lkIwgQ2FudmFzIOebuOacuuaIliBzb3J0aW5nT3JkZXInLFxuICAgIH0sXG4gICAge1xuICAgICAgICBuYW1lOiAnbWFpbl9tZW51JyxcbiAgICAgICAgZGVzY3JpcHRpb246ICfkuLvoj5zljZXlnLrmma8nLFxuICAgICAgICBzdHJ1Y3R1cmU6IGBDYW52YXNcbiAgQmFja2dyb3VuZCAoU3ByaXRlLCDlhajlsY/og4zmma8sIOWPr+iDveW4puWKqOeUuylcbiAgVGl0bGUgKExhYmVsLCDlpKflrZflj7fmuLjmiI/moIfpopgsIOWxheS4reWBj+S4iilcbiAgTWVudUJ1dHRvbnMgKExheW91dDogdmVydGljYWwsIHNwYWNpbmdZOjI0LCDlsYXkuK0pXG4gICAgU3RhcnRCdG4gKEJ1dHRvbjogXCLlvIDlp4vmuLjmiI9cIiwg5aSn5Y+3KVxuICAgIFNldHRpbmdzQnRuIChCdXR0b246IFwi6K6+572uXCIpXG4gICAgQWJvdXRCdG4gKEJ1dHRvbjogXCLlhbPkuo5cIilcbiAgVmVyc2lvbkxhYmVsIChMYWJlbDogdjEuMCwg5Y+z5LiL6KeSKVxuICBEZWNvcmF0aW9uIChTcGluZS/nspLlrZAsIOiDjOaZr+ijhemlsClgLFxuICAgIH0sXG4gICAge1xuICAgICAgICBuYW1lOiAnYmF0dGxlX3NjZW5lJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICfmiJjmlpflnLrmma8nLFxuICAgICAgICBzdHJ1Y3R1cmU6IGBDYW52YXNcbiAgQmF0dGxlTGF5ZXIgKOa4uOaIj+aImOaWlylcbiAgICBCYXR0bGVGaWVsZCAo572R5qC8L+WFrei+ueW9ouWcsOWbvilcbiAgICBVbml0c0NvbnRhaW5lciAo5Y+M5pa55Y2V5L2NKVxuICAgICAgUGxheWVyVW5pdHMgKOeOqeWutuWNleS9jSlcbiAgICAgIEVuZW15VW5pdHMgKOaVjOaWueWNleS9jSlcbiAgICBFZmZlY3RMYXllciAo5oqA6IO954m55pWIKVxuICBVSUxheWVyXG4gICAgVG9wQmFyICjlm57lkIjkv6Hmga8sIOi1hOa6kClcbiAgICBVbml0SW5mbyAo6YCJ5Lit5Y2V5L2N6K+m5oOFKVxuICAgIEFjdGlvblBhbmVsICjmioDog73mjInpkq4sIOenu+WKqOaMiemSrilcbiAgICBFbmRUdXJuQnRuICjnu5PmnZ/lm57lkIgpYCxcbiAgICB9LFxuXTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT0gNi4g5Yqo55S76aKE6K6+IChhbmltYXRpb25fcGF0dGVybnMpID09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCBpbnRlcmZhY2UgQW5pbWF0aW9uUGF0dGVybiB7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gICAgbWV0aG9kOiAnY2MudHdlZW4nIHwgJ3NjcmlwdCc7XG4gICAgY29kZTogc3RyaW5nO1xuICAgIHJlcXVpcmVzPzogc3RyaW5nO1xuICAgIHVzZV9jYXNlOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBBTklNQVRJT05fUEFUVEVSTlM6IEFuaW1hdGlvblBhdHRlcm5bXSA9IFtcbiAgICB7XG4gICAgICAgIG5hbWU6ICdmYWRlX2luJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICfmt6HlhaXmlYjmnpwnLFxuICAgICAgICBtZXRob2Q6ICdjYy50d2VlbicsXG4gICAgICAgIGNvZGU6IGBjYy50d2Vlbihub2RlKS5zZXQoe29wYWNpdHk6MH0pLnRvKDAuMywge29wYWNpdHk6MjU1fSkuc3RhcnQoKWAsXG4gICAgICAgIHJlcXVpcmVzOiAnVUlPcGFjaXR5IOe7hOS7ticsXG4gICAgICAgIHVzZV9jYXNlOiAn5by556qX5omT5byALCDlnLrmma/ov4fmuKEsIOWFg+e0oOWHuueOsCcsXG4gICAgfSxcbiAgICB7XG4gICAgICAgIG5hbWU6ICdmYWRlX291dCcsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn5reh5Ye65pWI5p6cJyxcbiAgICAgICAgbWV0aG9kOiAnY2MudHdlZW4nLFxuICAgICAgICBjb2RlOiBgY2MudHdlZW4obm9kZSkudG8oMC4zLCB7b3BhY2l0eTowfSkuY2FsbCgoKT0+bm9kZS5kZXN0cm95KCkpLnN0YXJ0KClgLFxuICAgICAgICByZXF1aXJlczogJ1VJT3BhY2l0eSDnu4Tku7YnLFxuICAgICAgICB1c2VfY2FzZTogJ+W8ueeql+WFs+mXrSwg5YWD57Sg5raI5aSxJyxcbiAgICB9LFxuICAgIHtcbiAgICAgICAgbmFtZTogJ3NjYWxlX2JvdW5jZScsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn5by56Lez5pS+5aSnICjlvLnnqpfmiZPlvIApJyxcbiAgICAgICAgbWV0aG9kOiAnY2MudHdlZW4nLFxuICAgICAgICBjb2RlOiBgY2MudHdlZW4obm9kZSkuc2V0KHtzY2FsZTpjYy52MygwLDAsMSl9KS50bygwLjMsIHtzY2FsZTpjYy52MygxLjEsMS4xLDEpfSkudG8oMC4xLCB7c2NhbGU6Y2MudjMoMSwxLDEpfSkuc3RhcnQoKWAsXG4gICAgICAgIHVzZV9jYXNlOiAn5by556qX5omT5byALCDlpZblirHlsZXnpLonLFxuICAgIH0sXG4gICAge1xuICAgICAgICBuYW1lOiAnc2NhbGVfY2xvc2UnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ+e8qeWwj+a2iOWksSAo5by556qX5YWz6ZetKScsXG4gICAgICAgIG1ldGhvZDogJ2NjLnR3ZWVuJyxcbiAgICAgICAgY29kZTogYGNjLnR3ZWVuKG5vZGUpLnRvKDAuMiwge3NjYWxlOmNjLnYzKDAsMCwxKX0pLmNhbGwoKCk9Pm5vZGUuZGVzdHJveSgpKS5zdGFydCgpYCxcbiAgICAgICAgdXNlX2Nhc2U6ICflvLnnqpflhbPpl60nLFxuICAgIH0sXG4gICAge1xuICAgICAgICBuYW1lOiAnc2xpZGVfaW5fYm90dG9tJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICfku47lupXpg6jmu5HlhaUnLFxuICAgICAgICBtZXRob2Q6ICdjYy50d2VlbicsXG4gICAgICAgIGNvZGU6IGBjb25zdCB5PW5vZGUucG9zaXRpb24ueTsgXG5jYy50d2Vlbihub2RlKVxuICAuc2V0KHtwb3NpdGlvbjpjYy52Myhub2RlLnBvc2l0aW9uLngsIHktNTAwLCAwKX0pXG4gIC50bygwLjQsIHtwb3NpdGlvbjpjYy52Myhub2RlLnBvc2l0aW9uLngsIHksIDApfSwge2Vhc2luZzonYmFja091dCd9KVxuICAuc3RhcnQoKWAsXG4gICAgICAgIHVzZV9jYXNlOiAn5bqV6YOo6Z2i5p2/LCDmk43kvZzmoI8nLFxuICAgIH0sXG4gICAge1xuICAgICAgICBuYW1lOiAnc2xpZGVfaW5fcmlnaHQnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ+S7juWPs+S+p+a7keWFpScsXG4gICAgICAgIG1ldGhvZDogJ2NjLnR3ZWVuJyxcbiAgICAgICAgY29kZTogYGNvbnN0IHg9bm9kZS5wb3NpdGlvbi54OyBcbmNjLnR3ZWVuKG5vZGUpXG4gIC5zZXQoe3Bvc2l0aW9uOmNjLnYzKHgrNjAwLCBub2RlLnBvc2l0aW9uLnksIDApfSlcbiAgLnRvKDAuMywge3Bvc2l0aW9uOmNjLnYzKHgsIG5vZGUucG9zaXRpb24ueSwgMCl9LCB7ZWFzaW5nOidjdWJpY091dCd9KVxuICAuc3RhcnQoKWAsXG4gICAgICAgIHVzZV9jYXNlOiAn5L6n6L655qCPLCDmir3lsYnoj5zljZUnLFxuICAgIH0sXG4gICAge1xuICAgICAgICBuYW1lOiAnc2hha2UnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ+aKluWKqC/pnIfliqjmlYjmnpwnLFxuICAgICAgICBtZXRob2Q6ICdjYy50d2VlbicsXG4gICAgICAgIGNvZGU6IGBjb25zdCBwPW5vZGUucG9zaXRpb247IFxuY2MudHdlZW4obm9kZSlcbiAgLnRvKDAuMDUse3Bvc2l0aW9uOmNjLnYzKHAueCs1LHAueSwwKX0pXG4gIC50bygwLjA1LHtwb3NpdGlvbjpjYy52MyhwLngtNSxwLnksMCl9KVxuICAudG8oMC4wNSx7cG9zaXRpb246Y2MudjMocC54KzMscC55LDApfSlcbiAgLnRvKDAuMDUse3Bvc2l0aW9uOmNjLnYzKHAueCxwLnksMCl9KVxuICAuc3RhcnQoKWAsXG4gICAgICAgIHVzZV9jYXNlOiAn5Y+X5Ye75pWI5p6cLCDplJnor6/lj43ppogsIOS8pOWus+ihqOeOsCcsXG4gICAgfSxcbiAgICB7XG4gICAgICAgIG5hbWU6ICdwdWxzZScsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn5oyB57ut6ISJ5YqoL+WRvOWQuOaViOaenCcsXG4gICAgICAgIG1ldGhvZDogJ2NjLnR3ZWVuJyxcbiAgICAgICAgY29kZTogYGNjLnR3ZWVuKG5vZGUpXG4gIC50bygwLjgsIHtzY2FsZTpjYy52MygxLjEsMS4xLDEpfSlcbiAgLnRvKDAuOCwge3NjYWxlOmNjLnYzKDEsMSwxKX0pXG4gIC51bmlvbigpLnJlcGVhdEZvcmV2ZXIoKS5zdGFydCgpYCxcbiAgICAgICAgdXNlX2Nhc2U6ICfpq5jkuq7mjInpkq4sIOWPr+aUtumbhueJqeWTgSwg5rOo5oSP5Yqb5ZC45byVJyxcbiAgICB9LFxuICAgIHtcbiAgICAgICAgbmFtZTogJ2Zsb2F0JyxcbiAgICAgICAgZGVzY3JpcHRpb246ICfkuIrkuIvmta7liqjlvqrnjq8nLFxuICAgICAgICBtZXRob2Q6ICdjYy50d2VlbicsXG4gICAgICAgIGNvZGU6IGBjb25zdCB5PW5vZGUucG9zaXRpb24ueTsgXG5jYy50d2Vlbihub2RlKVxuICAudG8oMSwge3Bvc2l0aW9uOmNjLnYzKG5vZGUucG9zaXRpb24ueCwgeSsxMCwgMCl9KVxuICAudG8oMSwge3Bvc2l0aW9uOmNjLnYzKG5vZGUucG9zaXRpb24ueCwgeS0xMCwgMCl9KVxuICAudW5pb24oKS5yZXBlYXRGb3JldmVyKCkuc3RhcnQoKWAsXG4gICAgICAgIHVzZV9jYXNlOiAn5ryC5rWu5Zu+5qCHLCDmj5DnpLrnrq3lpLQsIOW+heacuuWKqOeUuycsXG4gICAgfSxcbiAgICB7XG4gICAgICAgIG5hbWU6ICd0eXBld3JpdGVyJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICfmiZPlrZfmnLrmlofmnKzmlYjmnpwnLFxuICAgICAgICBtZXRob2Q6ICdzY3JpcHQnLFxuICAgICAgICBjb2RlOiBgYXN5bmMgZnVuY3Rpb24gdHlwZXdyaXRlcihsYWJlbDogY2MuTGFiZWwsIHRleHQ6IHN0cmluZywgaW50ZXJ2YWw9MC4wNSkge1xuICBsYWJlbC5zdHJpbmcgPSAnJztcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCB0ZXh0Lmxlbmd0aDsgaSsrKSB7XG4gICAgbGFiZWwuc3RyaW5nICs9IHRleHRbaV07XG4gICAgYXdhaXQgbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIGludGVydmFsICogMTAwMCkpO1xuICB9XG59YCxcbiAgICAgICAgdXNlX2Nhc2U6ICflr7nor53mlofmnKwsIOaVheS6i+WPmei/sCcsXG4gICAgfSxcbiAgICB7XG4gICAgICAgIG5hbWU6ICdudW1iZXJfcm9sbCcsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAn5pWw5a2X5rua5Yqo6K6h5pWwJyxcbiAgICAgICAgbWV0aG9kOiAnY2MudHdlZW4nLFxuICAgICAgICBjb2RlOiBgY29uc3Qgb2JqID0geyB2OiBmcm9tVmFsdWUgfTtcbmNjLnR3ZWVuKG9iailcbiAgLnRvKDAuNSwgeyB2OiB0b1ZhbHVlIH0pXG4gIC5jYWxsKCgpID0+IHsgbGFiZWwuc3RyaW5nID0gTWF0aC5mbG9vcihvYmoudikudG9TdHJpbmcoKTsgfSlcbiAgLnN0YXJ0KClgLFxuICAgICAgICB1c2VfY2FzZTogJ+WIhuaVsOWPmOWMliwg6YeR5biB6I635Y+WLCDkvKTlrrPmlbDlrZcnLFxuICAgIH0sXG4gICAge1xuICAgICAgICBuYW1lOiAnZmxpcF9jYXJkJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICfljaHniYfnv7vovawgM0Qg5pWI5p6cIChZ6L205peL6L2sKScsXG4gICAgICAgIG1ldGhvZDogJ2NjLnR3ZWVuJyxcbiAgICAgICAgY29kZTogYGNjLnR3ZWVuKG5vZGUpXG4gIC50bygwLjE1LCB7c2NhbGU6Y2MudjMoMCwxLDEpfSlcbiAgLmNhbGwoKCkgPT4geyAvKiBzd2FwIGZyb250L2JhY2sgc3ByaXRlICovIH0pXG4gIC50bygwLjE1LCB7c2NhbGU6Y2MudjMoMSwxLDEpfSlcbiAgLnN0YXJ0KClgLFxuICAgICAgICB1c2VfY2FzZTogJ+e/u+eJjOa4uOaIjywg5Y2h54mH5bGV56S6JyxcbiAgICB9LFxuICAgIHtcbiAgICAgICAgbmFtZTogJ2NvbWJvX3NlcXVlbmNlJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICfnuqfogZTlhaXlnLrluo/liJcgKOWkmuiKgueCueS+neasoeWHuueOsCknLFxuICAgICAgICBtZXRob2Q6ICdjYy50d2VlbicsXG4gICAgICAgIGNvZGU6IGBpdGVtcy5mb3JFYWNoKChub2RlLCBpKSA9PiB7XG4gIGNjLnR3ZWVuKG5vZGUpXG4gICAgLmRlbGF5KGkgKiAwLjEpXG4gICAgLnNldCh7b3BhY2l0eTowLCBzY2FsZTpjYy52MygwLjUsMC41LDEpfSlcbiAgICAudG8oMC4zLCB7b3BhY2l0eToyNTUsIHNjYWxlOmNjLnYzKDEsMSwxKX0pXG4gICAgLnN0YXJ0KCk7XG59KWAsXG4gICAgICAgIHVzZV9jYXNlOiAn5YiX6KGo6aG55L6d5qyh5bGV56S6LCDlpZblirHnianlk4HnuqfogZQsIOiPnOWNleaMiemSruW6j+WIlycsXG4gICAgfSxcbl07XG5cbi8vID09PT09PT09PT09PT09PT09PT09IDcuIOacgOS9s+Wunui3tSAoYmVzdF9wcmFjdGljZXMpID09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCBpbnRlcmZhY2UgQmVzdFByYWN0aWNlIHtcbiAgICBjYXRlZ29yeTogc3RyaW5nO1xuICAgIHRpdGxlOiBzdHJpbmc7XG4gICAgcnVsZXM6IHN0cmluZ1tdO1xufVxuXG5leHBvcnQgY29uc3QgQkVTVF9QUkFDVElDRVM6IEJlc3RQcmFjdGljZVtdID0gW1xuICAgIHtcbiAgICAgICAgY2F0ZWdvcnk6ICdwZXJmb3JtYW5jZScsXG4gICAgICAgIHRpdGxlOiAn5oCn6IO95LyY5YyWJyxcbiAgICAgICAgcnVsZXM6IFtcbiAgICAgICAgICAgICfkvb/nlKggU3ByaXRlQXRsYXMg5ZCI5om577yM5YeP5bCRIGRyYXcgY2FsbCcsXG4gICAgICAgICAgICAn5L2/55SoIGNjLk5vZGVQb29sIOWvueixoeaxoOeuoeeQhumikee5geWIm+W7ui/plIDmr4HnmoTlr7nosaHvvIjlrZDlvLkv5pWM5Lq6L+eJueaViO+8iScsXG4gICAgICAgICAgICAn6YG/5YWN5ZyoIHVwZGF0ZSgpIOS4reiwg+eUqCBnZXRDb21wb25lbnTvvIzlnKggb25Mb2FkL3N0YXJ0IOS4ree8k+WtmOe7hOS7tuW8leeUqCcsXG4gICAgICAgICAgICAn6Z2e56e75YqoIFVJIOWFg+e0oOWQr+eUqCBcIlN0YXRpY1wiIOagh+iusOi/m+ihjOmdmeaAgeWQiOaJuScsXG4gICAgICAgICAgICAnTGFiZWwgY2FjaGVNb2RlOiDpnZnmgIHmlofmnKznlKggQklUTUFQ77yM5Y+Y5YyW6aKR57mB55qE5paH5pys55SoIENIQVInLFxuICAgICAgICAgICAgJ+enu+WKqOerr+eykuWtkOaAu+aVsOaOp+WItuWcqCAyMDAg5Lul5YaFJyxcbiAgICAgICAgICAgICdTcGluZS9EcmFnb25Cb25lcyDlvIDlkK8gQ2FjaGUgTW9kZSDlh4/lsJEgQ1BVIOW8gOmUgCcsXG4gICAgICAgIF0sXG4gICAgfSxcbiAgICB7XG4gICAgICAgIGNhdGVnb3J5OiAnbXVsdGlfcmVzb2x1dGlvbicsXG4gICAgICAgIHRpdGxlOiAn5aSa5YiG6L6o546H6YCC6YWNJyxcbiAgICAgICAgcnVsZXM6IFtcbiAgICAgICAgICAgICdDYW52YXMg6K6+6K6h5YiG6L6o546H6K6+5Li655uu5qCH5YiG6L6o546H77yI5aaCIDEyODB4NzIwIOaIliAxOTIweDEwODDvvIknLFxuICAgICAgICAgICAgJ+aoquWxj+a4uOaIjyBmaXRIZWlnaHQ9dHJ1Ze+8jOerluWxj+a4uOaIjyBmaXRXaWR0aD10cnVlJyxcbiAgICAgICAgICAgICfmiYDmnIkgVUkg5a6a5L2N5L2/55SoIFdpZGdldO+8jOS4jeimgeehrOe8lueggee7neWvueWdkOaghycsXG4gICAgICAgICAgICAn5L2/55So55m+5YiG5q+U5qih5byPIChpc0Fic29sdXRlPWZhbHNlKSDpgILphY3kuI3lkIzlsY/luZUnLFxuICAgICAgICAgICAgJ+iDjOaZr+WbvueUqCBXaWRnZXQgZnVsbCArIOeVpeWkp+S6juWxj+W5leimhuebluaJgOacieavlOS+iycsXG4gICAgICAgICAgICAn5L2/55SoIFNhZmVBcmVhIOe7hOS7tumAgumFjSBub3RjaC/lnIbop5Lorr7lpIcnLFxuICAgICAgICAgICAgJ+a1i+ivleavlOS+izogMTY6OSwgMTg6OSwgMTkuNTo5IChpUGhvbmUpLCA0OjMgKGlQYWQpJyxcbiAgICAgICAgXSxcbiAgICB9LFxuICAgIHtcbiAgICAgICAgY2F0ZWdvcnk6ICdzY2VuZV9tYW5hZ2VtZW50JyxcbiAgICAgICAgdGl0bGU6ICflnLrmma/nrqHnkIYnLFxuICAgICAgICBydWxlczogW1xuICAgICAgICAgICAgJ+S9v+eUqCBjYy5kaXJlY3Rvci5sb2FkU2NlbmUg5YiH5o2i5Zy65pmvJyxcbiAgICAgICAgICAgICfkvb/nlKggY2MuZGlyZWN0b3IucHJlbG9hZFNjZW5lIOmihOWKoOi9veS4i+S4gOWcuuaZrycsXG4gICAgICAgICAgICAnQWRkaXRpdmUgVUk6IGNjLnJlc291cmNlcy5sb2FkIOWKoOi9vemihOWItuS9k+WQjiBpbnN0YW50aWF0ZSDmt7vliqAnLFxuICAgICAgICAgICAgJ+S/neeVmeaMgeS5heagueiKgueCuSBjYy5nYW1lLmFkZFBlcnNpc3RSb290Tm9kZSDnlKjkuo7lhajlsYDnrqHnkIblmagnLFxuICAgICAgICAgICAgJ+WIhiBCdW5kbGUg5oyJ5Zy65pmvL+WKn+iDvee7hOe7h+i1hOa6kO+8jOaMiemcgOWKoOi9vScsXG4gICAgICAgICAgICAn5Zy65pmv5YiH5o2i5pe25pi+56S65Yqg6L2955S76Z2i77yM6Ziy5q2i55m95bGPJyxcbiAgICAgICAgXSxcbiAgICB9LFxuICAgIHtcbiAgICAgICAgY2F0ZWdvcnk6ICdpbnB1dF9oYW5kbGluZycsXG4gICAgICAgIHRpdGxlOiAn6Kem5pG45LiO6L6T5YWlJyxcbiAgICAgICAgcnVsZXM6IFtcbiAgICAgICAgICAgICfkvb/nlKggbm9kZS5vbihOb2RlLkV2ZW50VHlwZS5UT1VDSF9TVEFSVC9NT1ZFL0VORCkg5aSE55CG6Kem5pG4JyxcbiAgICAgICAgICAgICdCdXR0b24g57uE5Lu26Ieq5Yqo5aSE55CG54q25oCB6L+H5rihJyxcbiAgICAgICAgICAgICflvLnnqpfpga7nvanmt7vliqAgQmxvY2tJbnB1dEV2ZW50cyDpmLLnqb/pgI8nLFxuICAgICAgICAgICAgJ+acgOWwj+inpuaRuOebruaghyA0NHg0NCDngrknLFxuICAgICAgICAgICAgJ+mYsui/nueCuTog54K55Ye75ZCOIDAuNXMg5YaF56aB55So5oyJ6ZKuJyxcbiAgICAgICAgICAgICfmi5bmi706IOS9v+eUqCBUT1VDSF9NT1ZFIGRlbHRhICsgY29udmVydFRvTm9kZVNwYWNlQVInLFxuICAgICAgICAgICAgJ+WkmuaMh+inpuaOpzog55SoIHRvdWNoIElEIOWMuuWIhuS4jeWQjOinpueCuScsXG4gICAgICAgIF0sXG4gICAgfSxcbiAgICB7XG4gICAgICAgIGNhdGVnb3J5OiAnbWVtb3J5X21hbmFnZW1lbnQnLFxuICAgICAgICB0aXRsZTogJ+i1hOa6kOS4juWGheWtmOeuoeeQhicsXG4gICAgICAgIHJ1bGVzOiBbXG4gICAgICAgICAgICAn56a75byA5Zy65pmv5pe26YeK5pS+5pyq5L2/55So6LWE5rqQOiBjYy5hc3NldE1hbmFnZXIucmVsZWFzZUFzc2V0KCknLFxuICAgICAgICAgICAgJ+S9v+eUqCBBc3NldEJ1bmRsZS5yZWxlYXNlKCkg6YeK5pS+5pW05LiqIEJ1bmRsZScsXG4gICAgICAgICAgICAn5Zy65pmv6K6+572u6Ieq5Yqo6YeK5pS+IChhdXRvUmVsZWFzZUFzc2V0cyknLFxuICAgICAgICAgICAgJ+WKqOaAgee6ueeQhueUqOWujOWNs+mUgOavgScsXG4gICAgICAgICAgICAnU3BpbmUvRHJhZ29uQm9uZXM6IOS4jeWGjeS9v+eUqOeahOinkuiJsumHiuaUvumqqOmqvOaVsOaNrui1hOa6kCcsXG4gICAgICAgICAgICAn55uR5o6nOiDosIPor5Xml7bkvb/nlKggY2MuYXNzZXRNYW5hZ2VyLmFzc2V0cyDmo4Dmn6Xlt7LliqDovb3otYTmupAnLFxuICAgICAgICAgICAgJ+e6ueeQhuWOi+e8qTog56e75Yqo56uv5L2/55SoIEFTVEMvRVRDMiwgV2ViIOeUqCBXZWJQJyxcbiAgICAgICAgXSxcbiAgICB9LFxuICAgIHtcbiAgICAgICAgY2F0ZWdvcnk6ICdhdWRpbycsXG4gICAgICAgIHRpdGxlOiAn6Z+z6aKR5a6e546wJyxcbiAgICAgICAgcnVsZXM6IFtcbiAgICAgICAgICAgICdCR00g5ZKMIFNGWCDkvb/nlKjni6znq4sgQXVkaW9Tb3VyY2Ug57uE5Lu277yM54us56uL5o6n5Yi26Z+z6YePJyxcbiAgICAgICAgICAgICdCR006IGxvb3A9dHJ1ZSwg5LiA5LiqIEF1ZGlvU291cmNlLCDmt6HlhaXmt6Hlh7rliIfmjaInLFxuICAgICAgICAgICAgJ1NGWDogcGxheU9uZVNob3QoKSDmkq3mlL7nn63pn7PmlYjvvIzlhYHorrjph43lj6AnLFxuICAgICAgICAgICAgJ+mcgOimgeWNs+aXtuWTjeW6lOeahOmfs+aViO+8iOaMiemSri/miZPlh7vvvInpooTliqDovb3pn7PpopEnLFxuICAgICAgICAgICAgJ+enu+WKqOerrzog6aaW5qyh55So5oi35Lqk5LqS5ZCO5omN5pKt5pS+6Z+z6aKRIOKAlCDlnKjpppbmrKHop6bmkbjml7bpmJ/liJcgQkdNJyxcbiAgICAgICAgICAgICfmoLzlvI86IEJHTSDnlKggTVAzICjljovnvKkpLCBTRlgg55SoIE9HRy9XQVYgKOS9juW7tui/nyknLFxuICAgICAgICAgICAgJ+WFqOWxgOmfs+mikeeuoeeQhuWZqOi3qOWcuuaZr+W4uOmpuzogY2MuZ2FtZS5hZGRQZXJzaXN0Um9vdE5vZGUnLFxuICAgICAgICBdLFxuICAgIH0sXG4gICAge1xuICAgICAgICBjYXRlZ29yeTogJ2FuaW1hdGlvbl90aXBzJyxcbiAgICAgICAgdGl0bGU6ICfliqjnlLvlrp7njrDmioDlt6cnLFxuICAgICAgICBydWxlczogW1xuICAgICAgICAgICAgJ+S7o+eggempseWKqOWKqOeUu+S8mOWFiOS9v+eUqCBjYy50d2VlbiDogIzpnZ4gQW5pbWF0aW9uIOe7hOS7ticsXG4gICAgICAgICAgICAn5aSN5p2C5pe26Ze057q/5Yqo55S75L2/55SoIEFuaW1hdGlvbiDnu4Tku7blnKjnvJbovpHlmajliJvkvZwnLFxuICAgICAgICAgICAgJ+e8k+WKqOWHveaVsDogYmFja091dCDlvLnot7PlvLnlhaUsIGN1YmljT3V0IOW5s+a7keWHj+mAnywgZWxhc3RpY091dCDlvLnnsKfmlYjmnpwnLFxuICAgICAgICAgICAgJ+avj+asoeW8gOWni+aWsCB0d2VlbiDliY3lgZzmjonml6cgdHdlZW46IGNjLlR3ZWVuLnN0b3BBbGxCeVRhcmdldChub2RlKScsXG4gICAgICAgICAgICAnVUkg6L+H5rihIDAuMi0wLjNzIOacgOaVj+aNtywgMC41cysg5pi+5ouW5rKTJyxcbiAgICAgICAgICAgICdTcGluZTog55SoIHRpbWVTY2FsZSDmjqfliLbpgJ/luqYsIHNldE1peCgpIOW5s+a7kei/h+a4oScsXG4gICAgICAgICAgICAn5om56YeP5Yqo55S7OiBkZWxheShpKjAuMDUpIOWunueOsOe6p+iBlOWFpeWcuuaViOaenCcsXG4gICAgICAgIF0sXG4gICAgfSxcbiAgICB7XG4gICAgICAgIGNhdGVnb3J5OiAndWlfYXJjaGl0ZWN0dXJlJyxcbiAgICAgICAgdGl0bGU6ICdVSSDns7vnu5/mnrbmnoQnLFxuICAgICAgICBydWxlczogW1xuICAgICAgICAgICAgJ+Wxgue6p+mhuuW6jzogQmFja2dyb3VuZCDihpIgR2FtZUxheWVyIOKGkiBVSUxheWVyIOKGkiBQb3B1cExheWVyIOKGkiBUb2FzdExheWVyJyxcbiAgICAgICAgICAgICdVSU1hbmFnZXIg5Y2V5L6L566h55CG5by556qX5qCIIChvcGVuL2Nsb3NlL2JhY2spJyxcbiAgICAgICAgICAgICfmr4/kuKrpnaLmnb/mmK/kuIDkuKrpooTliLbkvZPvvIzmjInpnIDliqDovb3vvIzlhbPpl63ml7bplIDmr4EnLFxuICAgICAgICAgICAgJ+aVsOaNruaooeWei+S4juinhuWbvuWIhuemuyDigJQg5pWw5o2u5Y+Y5YyW5pe25pu05paw6KeG5Zu+JyxcbiAgICAgICAgICAgICfkvb/nlKggY2MuRXZlbnRUYXJnZXQg5oiW6Ieq5a6a5LmJIEV2ZW50QnVzIOi3qOmdouadv+mAmuS/oScsXG4gICAgICAgICAgICAn5paH5pys5L2/55SoIGkxOG4ga2V577yM5LiN56Gs57yW56CBJyxcbiAgICAgICAgICAgICfpgJrnlKjnu4Tku7bvvIjnoa7orqTlvLnnqpcv54mp5ZOB5qe977yJ5o+Q5Y+W5Li65Y+v5aSN55SoIFByZWZhYicsXG4gICAgICAgIF0sXG4gICAgfSxcbl07XG5cbi8vID09PT09PT09PT09PT09PT09PT09IOefpeivhuW6k+e0ouW8lSA9PT09PT09PT09PT09PT09PT09PVxuXG5leHBvcnQgY29uc3QgS05PV0xFREdFX1RPUElDUyA9IFtcbiAgICB7IG5hbWU6ICdjb21wb25lbnRfcHJvcGVydGllcycsIHRpdGxlOiAn57uE5Lu25bGe5oCn5aSn5YWoJywgZGVzY3JpcHRpb246ICfmiYDmnIkgQ29jb3Mg57uE5Lu255qE5a6M5pW05bGe5oCn5YiX6KGo5Y+K57G75Z6L6K+05piOJywgY291bnQ6IE9iamVjdC5rZXlzKENPTVBPTkVOVF9QUk9QRVJUSUVTKS5sZW5ndGggfSxcbiAgICB7IG5hbWU6ICd1aV9kZXNpZ25fcnVsZXMnLCB0aXRsZTogJ1VJIOiuvuiuoeinhOiMgycsIGRlc2NyaXB0aW9uOiAn5Z2Q5qCH57O757ufL+i+ueeVjOahhi/op6bmkbjnm67moIcv5a2X5Y+3L+mXtOi3nS/lronlhajljLrnrYknLCBjb3VudDogT2JqZWN0LmtleXMoVUlfREVTSUdOX1JVTEVTKS5sZW5ndGggfSxcbiAgICB7IG5hbWU6ICdsYXlvdXRfcGF0dGVybnMnLCB0aXRsZTogJ1VJIOW4g+WxgOaooeadvycsIGRlc2NyaXB0aW9uOiAnMTIg56eN5bi46KeBIFVJIOW4g+WxgOeahOaOqOiNkOiKgueCuee7k+aehCcsIGNvdW50OiBMQVlPVVRfUEFUVEVSTlMubGVuZ3RoIH0sXG4gICAgeyBuYW1lOiAnd2lkZ2V0X3N0cmF0ZWd5JywgdGl0bGU6ICdXaWRnZXQg5a+56b2Q562W55WlJywgZGVzY3JpcHRpb246ICflhajlsY8v5bGF5LitL+mhtuagjy/lupXmoI8v5a6J5YWo5Yy6562JIFdpZGdldCDphY3nva4nLCBjb3VudDogV0lER0VUX1NUUkFURUdJRVMubGVuZ3RoIH0sXG4gICAgeyBuYW1lOiAnbm9kZV9zdHJ1Y3R1cmUnLCB0aXRsZTogJ+WcuuaZr+iKgueCueaetuaehCcsIGRlc2NyaXB0aW9uOiAn5ri45oiP5Li75Zy65pmvL+S4u+iPnOWNlS/miJjmlpflnLrmma/nrYnmjqjojZDoioLngrnlsYLnuqcnLCBjb3VudDogTk9ERV9TVFJVQ1RVUkVTLmxlbmd0aCB9LFxuICAgIHsgbmFtZTogJ2FuaW1hdGlvbl9wYXR0ZXJucycsIHRpdGxlOiAn5Yqo55S76aKE6K6+JywgZGVzY3JpcHRpb246ICcxMyDnp43luLjop4HliqjnlLvmlYjmnpznmoQgdHdlZW4g5Luj56CBJywgY291bnQ6IEFOSU1BVElPTl9QQVRURVJOUy5sZW5ndGggfSxcbiAgICB7IG5hbWU6ICdiZXN0X3ByYWN0aWNlcycsIHRpdGxlOiAn5pyA5L2z5a6e6Le1JywgZGVzY3JpcHRpb246ICfmgKfog70v5aSa5YiG6L6o546HL+WcuuaZr+euoeeQhi/ovpPlhaUv5YaF5a2YL+mfs+mikS/liqjnlLsvVUkg5p625p6EJywgY291bnQ6IEJFU1RfUFJBQ1RJQ0VTLmxlbmd0aCB9LFxuXTtcbiJdfQ==