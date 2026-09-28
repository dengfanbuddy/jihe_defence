import { Color, Label, Node, UIOpacity, UITransform, Vec3, tween } from 'cc';

/**
 * FloatText —— **一条会飘起来淡出的提示字**（纯代码构建，无预制件依赖）
 *
 * 用途：技能槽全部锁定、选中技能发不出去时的「飘字提示」（需求原文："都锁定则飘字提示"）。
 * 与战斗飘伤害字（`game_stage/entityview/DamageTextLayer`）是**两套东西**，别混：
 *   · 伤害飘字在世界坐标 → 跟随怪物、压在实体之上；
 *   · 本提示在 **UI 坐标** → 贴在技能栏上方、压在 HUD 之下（同一个 Canvas 里的两个视觉通道）。
 *
 * 口径：一条提示一个节点（用完即销毁），不做池化 —— 提示是低频交互（点一次出一条），
 * 池化省下的那点分配还不如多一层状态机带来的维护成本。
 */

/** 默认飘字时长（秒） */
const DURATION = 1.4;
/** 上飘距离（像素） */
const RISE = 70;
/** 字号 */
const FONT_SIZE = 22;

/** 提示字配色：暖黄 + 深色描边（战斗背景是浅色的，纯色字会糊） */
const TEXT_COLOR = new Color(255, 214, 102, 255);
const OUTLINE_COLOR = new Color(40, 30, 10, 255);

/**
 * 在某节点下弹一条飘字。
 *
 * @param host 挂载节点（一般是 HUD 根节点；节点用完自动销毁）
 * @param message 文案
 * @param anchor 锚点节点：飘字会出现在它**正上方**（一般传技能栏节点）。不传则落在 host 中心
 * @param offsetY 在锚点之上再抬多少像素
 */
export function showFloatText(host: Node, message: string, anchor?: Node | null, offsetY = 90): void {
    if (!host?.isValid || !message) return;

    const node = new Node('float_text');
    node.layer = host.layer;
    host.addChild(node);
    node.setSiblingIndex(host.children.length - 1); // 压在同级之上

    const ui = node.addComponent(UITransform);
    ui.setContentSize(500, FONT_SIZE + 10);
    ui.setAnchorPoint(0.5, 0.5);

    const label = node.addComponent(Label);
    label.string = message;
    label.fontSize = FONT_SIZE;
    label.lineHeight = FONT_SIZE + 6;
    label.color = TEXT_COLOR.clone();
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.enableOutline = true;
    label.outlineColor = OUTLINE_COLOR.clone();
    label.outlineWidth = 2;

    const opacity = node.addComponent(UIOpacity);
    opacity.opacity = 255;

    // 位置：锚点节点的世界位置 → host 的局部空间
    // ⚠ 走 `convertToNodeSpaceAR` 而不是"世界坐标相减"：UI 世界坐标里含父链缩放（Canvas 适配缩放、
    //   预制件 scale 都可能不是 1），相减出来的差值不是局部坐标，飘字会跑偏。
    const hostUi = host.getComponent(UITransform);
    const anchorWorld = anchor?.isValid ? anchor.getWorldPosition() : host.getWorldPosition();
    const anchorLocal = hostUi ? hostUi.convertToNodeSpaceAR(anchorWorld) : anchorWorld.clone();
    node.setPosition(new Vec3(anchorLocal.x, anchorLocal.y + offsetY, 0));

    // 上飘 + 淡出 → 自毁
    const start = node.position.clone();
    const end = new Vec3(start.x, start.y + RISE, start.z);
    tween(node)
        .to(DURATION, { position: end })
        .start();
    tween(opacity)
        .delay(DURATION * 0.35)
        .to(DURATION * 0.65, { opacity: 0 })
        .call(() => {
            if (node.isValid) node.destroy();
        })
        .start();
}
