/**
 * Cocos Creator 知识库数据
 * 
 * 7 大主题原始数据：component_properties / ui_design_rules / layout_patterns /
 * widget_strategy / node_structure / animation_patterns / best_practices
 * 
 * 混合模式：initialize 注入关键摘要 + knowledge_query 工具返回详细内容
 */

// ==================== 1. 组件属性 (component_properties) ====================

export interface ComponentPropInfo {
    type: string;
    description: string;
    default?: any;
}

export interface ComponentInfo {
    type: string;
    description: string;
    properties: Record<string, ComponentPropInfo>;
}

export const COMPONENT_PROPERTIES: Record<string, ComponentInfo> = {
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

export const UI_DESIGN_RULES = {
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

// ==================== 3. 布局模式 (layout_patterns) ====================

export interface LayoutPattern {
    name: string;
    description: string;
    structure: string;
    tips?: string;
}

export const LAYOUT_PATTERNS: LayoutPattern[] = [
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

// ==================== 4. Widget 策略 (widget_strategy) ====================

export interface WidgetStrategy {
    scenario: string;
    description: string;
    widgetConfig: string;
}

export const WIDGET_STRATEGIES: WidgetStrategy[] = [
    { scenario: '全屏背景', description: '覆盖整个屏幕', widgetConfig: 'isAlignTop+isAlignBottom+isAlignLeft+isAlignRight = 0' },
    { scenario: '居中弹窗', description: '屏幕正中央', widgetConfig: 'isAlignVerticalCenter+isAlignHorizontalCenter = 0' },
    { scenario: '顶栏', description: '屏幕顶部固定', widgetConfig: 'isAlignTop + isAlignLeft + isAlignRight' },
    { scenario: '底栏', description: '屏幕底部固定', widgetConfig: 'isAlignBottom + isAlignLeft + isAlignRight' },
    { scenario: '安全区适配', description: '避开 notch/圆角', widgetConfig: 'SafeArea 组件 + alignMode=ON_WINDOW_RESIZE' },
    { scenario: '响应式布局', description: '随屏幕等比缩放', widgetConfig: 'isAbsoluteXxx=false（百分比模式）' },
    { scenario: '右上角按钮', description: '固定在右上角', widgetConfig: 'isAlignTop + isAlignRight' },
    { scenario: '左下角按钮', description: '固定在左下角', widgetConfig: 'isAlignBottom + isAlignLeft' },
];

// ==================== 5. 节点结构模板 (node_structure) ====================

export interface NodeStructureTemplate {
    name: string;
    description: string;
    structure: string;
    tips?: string;
}

export const NODE_STRUCTURES: NodeStructureTemplate[] = [
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

// ==================== 6. 动画预设 (animation_patterns) ====================

export interface AnimationPattern {
    name: string;
    description: string;
    method: 'cc.tween' | 'script';
    code: string;
    requires?: string;
    use_case: string;
}

export const ANIMATION_PATTERNS: AnimationPattern[] = [
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

// ==================== 7. 最佳实践 (best_practices) ====================

export interface BestPractice {
    category: string;
    title: string;
    rules: string[];
}

export const BEST_PRACTICES: BestPractice[] = [
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

export const KNOWLEDGE_TOPICS = [
    { name: 'component_properties', title: '组件属性大全', description: '所有 Cocos 组件的完整属性列表及类型说明', count: Object.keys(COMPONENT_PROPERTIES).length },
    { name: 'ui_design_rules', title: 'UI 设计规范', description: '坐标系统/边界框/触摸目标/字号/间距/安全区等', count: Object.keys(UI_DESIGN_RULES).length },
    { name: 'layout_patterns', title: 'UI 布局模板', description: '12 种常见 UI 布局的推荐节点结构', count: LAYOUT_PATTERNS.length },
    { name: 'widget_strategy', title: 'Widget 对齐策略', description: '全屏/居中/顶栏/底栏/安全区等 Widget 配置', count: WIDGET_STRATEGIES.length },
    { name: 'node_structure', title: '场景节点架构', description: '游戏主场景/主菜单/战斗场景等推荐节点层级', count: NODE_STRUCTURES.length },
    { name: 'animation_patterns', title: '动画预设', description: '13 种常见动画效果的 tween 代码', count: ANIMATION_PATTERNS.length },
    { name: 'best_practices', title: '最佳实践', description: '性能/多分辨率/场景管理/输入/内存/音频/动画/UI 架构', count: BEST_PRACTICES.length },
];
