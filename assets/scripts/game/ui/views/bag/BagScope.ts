/**
 * BagScope.ts — 局外背包全屏页（`View_Bag`）的 scope 契约（事件 + 页面 VM 形状）
 *
 * 与 `views/shop/ShopScope.ts` / `views/task/TaskScope.ts` 同一套路：
 * **页面只渲染 + 上报，判据只在一个 VM 里算一次**（VM 构造在 `./BagVM`）。
 *
 * 方向约定：
 *   · 状态向下：`buildBagPageVM(key)` 把「这一屏要显示什么」算成一份 `BagPageVM`
 *     交给 `View_Bag.applyPage(vm)`；页面**不读数据层**、不自己算「有几件 / 能不能用」。
 *   · 通知向上：格子（`BagItem`）只 `scope.emit(BagScopeEvents.SelectItem, key)`；
 *     真正"换选中 + 重画详情"的是**这一屏自己**（`View_Bag` 就是宿主，见下）。
 *
 * ⚠ **宿主 = `Scene_Menu` 是做不到的**（与商城同一条结论）：
 * `UIScope.emit` 只沿 `node.parent` 向上冒泡，而 `views` 层与 `scenes` 层是 UIManager 下的**兄弟节点**
 * （见 `platform/ui/UIScope.ts` 规则 1），页面的 `emit` 永远到不了 `Scene_Menu` 的作用域。
 * 所以形态是：**页面自己 `scope.on` 自己 `emit` 的事件**，`Scene_Menu` 只负责"开"与"与另两个全屏页互斥"。
 *
 * 口径真源是 `docs/bag/README.md`：装什么 / 一件道具长什么样 / 容量怎么算都在那份文档里，
 * 本文件只把它们翻译成类型。
 */
import type { BagItemRarity } from '../../../excel_table/Tb_BagItemConfig';

/**
 * 格子节点契约（`prefabs/ui/views/bag/cmps/Bag_Cell` 根节点下的子节点名）。
 * 与 `SHOP_CELL_NODE` 同一用途：预制件里没拖引用时按名字兜底解析，
 * 也供体检脚本对"代码要的路径"与"预制件有的路径"（`docs/bag/README.md` §4）。
 */
export const BAG_CELL_NODE = {
    /** 选中环（节点存在即画环；`active=false` = 未选中） */
    ring: 'ring',
    /** 道具图标 */
    icon: 'icon',
    /** 数量（`×3`） */
    count: 'count',
    /** 有效期倒计时（静置 `active=false`；> 0 才显示，见 `BagItem.setInfo`） */
    timer: 'timer',
    /** 倒计时文字（`timer` 的子节点） */
    timerLabel: 'label',
} as const;

/**
 * **空位底色** = `c-ink-200`（token 真源 `docs/art-style/tokens.json`；工程里同一档
 * 用在"进度条轨道 / 侧栏底 / 分隔"上 —— 语义正好是"位置在这儿、里面是空的"）。
 *
 * ⚠ **两处共用这一个常量，不许各写一份**（2026-11 从 `BagItem` 挪到这里，因为它有了第二个使用方）：
 *   · 背包**空槽**（`BagItem` 画的那一格）；
 *   · 详情面板的**未选中**底框（`View_Bag` 画的 `item_detail/content/icon_tile`）——
 *     两处讲的是同一件事："这儿本来该有东西，现在没有"，所以颜色必须是同一个，
 *     否则一格空槽与一块空面板并排显示时会看着像两种不同的"空"。
 *
 * ⚠ 三条不能踩的：
 *   ① **不许用品质色**（连白档 `quality.common #DDDDDD` 也不行）—— 空位没有品质，
 *      染上去就是"这件东西是白档"，而 `#DDDDDD` 与这一档的灰只差 5 个灰阶、肉眼分不出；
 *   ② 之所以是**实心灰**而不是描边/虚线：两处都只有一张白底圆角九宫格可染，
 *      而工程里唯一的描边图 `rect_board_*` 是**烤进去的青绿**（乘上灰会发脏，
 *      与 `View_Bag.SELL_ON_TEXT` 同一处置）—— 只能靠染白底图来表达"这儿是空的"；
 *   ③ 取值来自 token 表，不许随手调一个"差不多的灰"（`npm run audit:ui` 只管预制件里的
 *      **静态**色，运行期写的色靠这条注释 + `audit:bag` 的 F13/F14/F17 兜）。
 */
export const BAG_EMPTY_FRAME = '#D8D8D8';

/**
 * 详情面板在**什么都没选中**时显示的名字（`item_detail/content/name` 那一行）。
 *
 * 口径（2026-11）：面板**恒显示**，没有选中时画这个占位词（而不是整块收起，见 `BagPageVM.detail`）。
 * 文案放在契约里而不是散在界面里：以后要改措辞（"未选中" / "请选择道具"）只改这一行。
 */
export const BAG_NO_SELECTION_TEXT = '未选中';

/**
 * 页面向上冒泡的事件。
 * ⚠ **唯一监听方是页面自己**（`View_Bag.bindEvents` 里的 `scope.on`）—— 见文件头说明：
 * 跨层冒泡到 `Scene_Menu` 做不到。**再多一处监听 = 一次点击被处理两次**。
 * ⚠ 左上角「返回」**不在这里**：views 形态下页面自己 `UIManager.closeUI(View_Bag)` 收掉自己。
 */
export const BagScopeEvents = {
    /** 点某一格道具（参数：道具 `key`）→ 换选中并重画详情面板 */
    SelectItem: 'bag:selectItem',
} as const;

/** 顶栏读数（金币 / 通用英雄经验） */
export interface BagResBarVM {
    /** 局外金币（`itemData.getCurrency(CurrencyType.Gold)`） */
    gold: number;
    /** 通用英雄经验（`heroData.getSharedExp()`） */
    heroExp: number;
}

/**
 * 一个槽位。**两种**：有货的格子 / 空槽。
 *
 * ⚠ 「有几件」来自 `BagData`，「长什么样」来自 `bag_items.json` —— 两者在 `BagVM` 里合流，
 * 页面不自己查任何一边。
 * ⚠ **空槽也是一格**（2026-11 口径）：背包界面**恒画满 `capacity.cap` 个槽**（80），
 * 没有道具的那些是空槽 —— 这样玩家一眼看得出"还有多少位置"，而不是"空背包什么都没有"。
 * 空槽由 `empty` 标记，`key` 恒为空串（⚠ 空串**不是**合法道具 key，所以"拿 key 反查配表"
 * 那条路对空槽天然返回 null，不需要额外判空）。
 */
export interface BagCellVM {
    /**
     * 道具 key（= `bag_items.key`；点击时原样冒泡回来）。
     * ⚠ **空槽恒为 `''`**，页面/格子据此认定"这一格不装东西"。
     */
    key: string;
    /**
     * 是不是**空槽**（没有道具、只是把格子画出来）。
     * `true` 时下面这些字段全是占位值（`name`/`icon` 空串、`count` 0、`expireAt` 0、
     * `selected` false），界面**不许**再按它们渲染 —— 只在底框上画一格空槽色。
     */
    empty: boolean;
    /** 道具名（配表 `name`；空槽 = 空串） */
    name: string;
    /** 图标资源路径（resources 相对、不带扩展名；空 = 保持预制件占位图不动） */
    icon: string;
    /** 品质（决定格子底框色；色值真源 `game/common/RelicRarityColor.ts`；空槽 = 不染品质色） */
    rarity: BagItemRarity;
    /** 持有数量（空槽 = 0） */
    count: number;
    /**
     * 过期时间戳（ms；**0 = 永久 → 格子不显示倒计时**）。
     * ⚠ 这里下发的是**绝对时间戳**而不是"还剩几秒"：倒计时是每秒自己在走的，
     * 若下发一个算好的秒数，页面每秒都得重建整页 VM（牵连图标与全部格子）。
     * 下发时间戳之后，秒级刷新只需要格子自己重写一行文字（`BagItem.tickTimer`）。
     */
    expireAt: number;
    /** 是不是当前选中的那一格（选中 = 画环）。⚠ 空槽恒 false（环只画在有货的格子上） */
    selected: boolean;
}

/**
 * 详情面板（右列 `item_detail`）。
 *
 * ⚠ **面板恒显示**（2026-11 改口径）：一件都没选中时它是"未选中"占位态（`empty = true`），
 * 而不是整块收起 —— 见 `BagPageVM.detail`。
 *
 * ⚠ **本期"使用 / 出售"是只读的**（2026-11 拍板）：
 * 表里 12 行的 `usable` / `sellable` 全是 0 —— 这些道具都是**入局 / 抽取时自动抵扣**的，
 * 手动点"使用"没有意义；而"出售"会开一个金币回收口，与
 * 「金币是抽取燃料」的既有经济（`docs/meta-growth/README.md` §1.3）直接打架。
 * 所以按钮只按配表判据置灰，**为什么**由正文第二行回答（`useHint` / 效果文案）。
 *
 * ⚠ 面板上**没有**"持有数量"这一行（预制件的 `item_detail/content` 只有
 * `icon_tile/icon` / `name` / `desc` / `btn_use[label]` / `btn_sell[label]` 五个子节点）：
 * 数量由**格子上那个 `×N`**回答，而选中的那一格就在左边一列，不必在面板里再说一遍。
 *
 * ⚠ 节点结构（2026-11 用户改过版，`content` 是**容器**，五个子节点挂在它下面）：
 * ```
 * item_detail            ← 面板根（白底 + ScrollView + Widget）
 *   content              ← VERTICAL Layout（spacingY 20 / paddingTop 10），子节点由它排版
 *     icon_tile          ← 品质底框（未选中时画 BAG_EMPTY_FRAME）
 *       icon             ← 道具图标（未选中时整个收起）
 *     name               ← 名字（未选中时写 BAG_NO_SELECTION_TEXT）
 *     desc               ← 正文（RESIZE_HEIGHT：写几行长多高，不裁字）
 *     btn_use / label
 *     btn_sell / {bg, ring, label}
 * ```
 * 两态由 `empty` 一处分派（`View_Bag.applyDetail`）：未选中只画**灰底 + 名字**，
 * 图标 / 正文 / 两个按钮全收起。
 */
export interface BagDetailVM {
    /**
     * **两态**（与 `BagCellVM.empty` 对称）：
     *   · `false` = 有选中 → 画这一件（品质底框 / 图标 / 名字 / 正文 / 两个按钮）；
     *   · `true`  = **没有选中**（背包是空的，或选中的那一件刚被用光还没来得及回落）
     *              → 面板**照样显示**，只画"空位"：`BAG_EMPTY_FRAME` 灰底 + `BAG_NO_SELECTION_TEXT` 名字。
     * ⚠ `true` 时下面除 `name` 之外的字段全是占位值（`''` / `'common'` / `false`），
     *   界面**不许**再按它们渲染（否则会把上一件道具的残留留在面板上）。
     */
    empty: boolean;
    key: string;
    name: string;
    /** 正文（**两行**：配表 `desc` + 第二行的效果 / 使用说明，见 `BagVM.buildDetailVM`；未选中 = 空串） */
    desc: string;
    icon: string;
    rarity: BagItemRarity;
    /** 配表判据：能不能手动用 / 能不能出售（本期全 false） */
    usable: boolean;
    sellable: boolean;
    /** 「使用」按钮文案（可用 = `使用`，不可用 = `不可使用`） */
    useText: string;
    /** 「出售」按钮文案（可卖 = `出售 N`，不可卖 = `不可出售`） */
    sellText: string;
}

/** 底栏容量（`bottom_bar` 的「容量 N/80」+ 进度条） */
export interface BagCapacityVM {
    /** 已占用的格子数（= 有存量的**种类**数；**不是** `cells.length` —— 后者含空槽，恒 ≥ cap） */
    used: number;
    /** 格子上限（`BAG_SLOT_CAPACITY` = 80，一格 = 一种道具）；同时也是**画出来的槽位数** */
    cap: number;
    /** 是否已满（满了底栏数字转 `c-warn` 提醒） */
    full: boolean;
}

/** 整页 VM —— 宿主**一次算好、一次下发**（避免页面里出现第二份判据） */
export interface BagPageVM {
    resBar: BagResBarVM;
    /**
     * **整片槽位**（按配表 `sort` 升序：前 `capacity.used` 个有货，后面全是空槽）。
     *
     * ⚠ 长度**恒 ≥ `capacity.cap`**（= 80）—— 空背包也铺满 80 个空槽，
     * 界面不需要自己补格子（"补到几个"是判据，只能有一个落点，见 `docs/bag/README.md` §3.4）。
     * 存量反常地超过上限时（不该发生）会**照实多出来**，而不是把道具静默藏掉。
     */
    cells: BagCellVM[];
    /**
     * 详情面板 —— **恒有一份**（不是 `| null`）。
     *
     * ⚠ 2026-11 改口径：面板**不再整块收起**。原来的写法是"没有选中就 `detail = null` → 面板 `active = false`"，
     * 而这一屏左边是一列格子、右边是面板：面板整块消失之后右半边只剩一片空白，
     * 左边却还站着 80 个格子（空背包也铺满，见 `cells`）——玩家看到的是"面板没加载出来"，
     * 而不是"背包是空的"。现在没有选中时下发的是**未选中占位态**（`detail.empty = true`）。
     */
    detail: BagDetailVM;
    capacity: BagCapacityVM;
}
