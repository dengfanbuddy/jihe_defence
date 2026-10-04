#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check-icons.py —— 遗物图标交付体检（PIL，无第三方依赖除 Pillow）

查四件事（都是踩过的坑，见 docs/relic-icon/README.md §1/§2/§4）：
  ① **真 alpha**：整图 alpha 最小值必须是 0。若最小值 > 0，说明背景是**画进像素里的浅灰/棋盘格**
     （实测：用户那张 ComfyUI 测试图 alpha 最小值 237、61% 面积是烘焙的棋盘格）——进游戏就是灰底方图。
  ② **外轮廓留白**：把透明区当底，量主体包围盒，四边留白各应 ≥ 8%（槽位 50×50 + 70×70 底框，贴边会被切）。
  ③ **正方形**：预制件 `RelicItem/content/head/inner` 是 50×50 `sizeMode=CUSTOM` Sprite，非正方形会被拉伸。
  ④ **交付尺寸**：**64×64**（2026-10 用户口径：做完压到 64×64 再进图集；显示槽位是 50×50，
     所以 64 是 1.28×，够 1x 用；要更清晰就重跑 `make-delivery.py --size 128` —— **原图 640×640 留着，换尺寸不用重出图**）。

用法：
    python tools/relic-icon-prompts/check-icons.py                          # 查 assets/resources/textures/relics
    python tools/relic-icon-prompts/check-icons.py --dir D:/relic-icons-out  # 查出图目录
    python tools/relic-icon-prompts/check-icons.py --dir X --limit 20        # 只看前 20 张（打印明细）
    python tools/relic-icon-prompts/check-icons.py --dir X --size 200        # 按别的交付尺寸查
退出码：有违规 = 1。
"""
import argparse
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("× 需要 Pillow：pip install pillow")

# Windows 控制台默认 GBK，勾叉类字符容易 UnicodeEncodeError —— 兜一层，永不因打印崩掉
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
DEFAULT_DIR = os.path.join(ROOT, "assets", "resources", "textures", "relics")
MARGIN_MIN = 0.08          # 四边留白下限
EXPECT_SIZE = 64           # 交付尺寸（正方形边长）；`--size` 可覆盖
# 目录里**不是**交付图、不该参与体检的文件：`yazhizhiren.png` 是 `RelicItem.prefab` 里
# 图标槽的占位图（1024×1024，按 uuid 引用，永远不替换）—— 不排除它的话每次体检都会多一条假红。
SKIP = {"yazhizhiren.png"}


def measure(path, expect_size=EXPECT_SIZE):
    """返回 (w, h, alpha_min, 四边留白比例 or None, 问题列表)"""
    im = Image.open(path)
    w, h = im.size
    rgba = im.convert("RGBA")
    amin = rgba.getchannel("A").getextrema()[0]

    problems = []
    if amin > 0:
        problems.append(f"无透明背景（alpha 最小 {amin}，背景是画进像素里的）")

    # 主体包围盒：alpha>0 的像素（真透明图里就是主体）
    alpha = rgba.getchannel("A")
    bbox = alpha.point(lambda v: 255 if v > 8 else 0).getbbox() if amin == 0 else None
    margins = None
    if bbox:
        left, top, right, bottom = bbox
        margins = (left / w, 1 - right / w, top / h, 1 - bottom / h)
        if min(margins) < MARGIN_MIN:
            problems.append("外轮廓留白不足（左%.0f%% 右%.0f%% 上%.0f%% 下%.0f%%）"
                            % tuple(m * 100 for m in margins))

    if w != h:
        problems.append(f"不是正方形（{w}×{h}），进 50×50 槽会被拉伸")
    if (w, h) != (expect_size, expect_size):
        problems.append(f"尺寸不是 {expect_size}×{expect_size}（当前 {w}×{h}）")
    return w, h, amin, margins, problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=DEFAULT_DIR)
    ap.add_argument("--limit", type=int, default=0, help="只打印前 N 张明细（0 = 全部）")
    ap.add_argument("--size", type=int, default=EXPECT_SIZE, help="期望的正方形边长（默认 64）")
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        sys.exit(f"× 目录不存在：{args.dir}")
    files = sorted(f for f in os.listdir(args.dir) if f.lower().endswith(".png"))
    skipped = [f for f in files if f in SKIP]
    files = [f for f in files if f not in SKIP]
    if not files:
        sys.exit(f"× 目录里没有 png：{args.dir}")
    if skipped:
        print(f"（跳过 {len(skipped)} 个非交付文件：{', '.join(skipped)}）")

    bad = []
    shown = 0
    for name in files:
        w, h, amin, margins, problems = measure(os.path.join(args.dir, name), args.size)
        if problems:
            bad.append((name, problems))
        if args.limit and shown < args.limit:
            shown += 1
            m = "—" if not margins else "左%.0f%% 右%.0f%% 上%.0f%% 下%.0f%%" % tuple(x * 100 for x in margins)
            print(f"{'×' if problems else '√'} {name:34} {w}×{h}  alpha_min={amin:3d}  留白 {m}")
            for p in problems:
                print(f"    · {p}")

    print(f"\n◆ {args.dir}")
    print(f"◆ 共 {len(files)} 张，违规 {len(bad)} 张（留白下限 {MARGIN_MIN:.0%}，尺寸 {args.size}×{args.size}）")
    if bad:
        head = bad[:10]
        print("◆ 违规清单（前 10）：")
        for name, problems in head:
            print(f"   · {name}：{problems[0]}" + (f"（等 {len(problems)} 条）" if len(problems) > 1 else ""))
        print("\n◆ 修法见 docs/relic-icon/README.md §4（真 alpha）与 §2（留白 MARGIN）")
        sys.exit(1)
    print("√ 全部通过")


if __name__ == "__main__":
    main()
