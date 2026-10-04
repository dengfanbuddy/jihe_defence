#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 `assets/resources/textures/skills/` 里的**技能图标**打成 Cocos Creator 的
「图集资源（Atlas）」= plist(format 3) + 同名 png 一对。

与遗物图集（`tools/relic-icon-prompts/build-atlas.py`）的关系
------------------------------------------------------------
**格式知识只有一份**：plist 结构、MaxRects 排布、四条坐标口径（trimX=bbox.left /
trimY=bbox.top / offsetX=(l+r)/2-W/2 / offsetY=H/2-(t+b)/2，**y 向上**）全部复用
`build-atlas.py` 的函数（用 importlib 按路径加载 —— 那个文件名里有连字符，不能直接 import）。
本脚本只多做一件事：**决定打哪些帧**。

为什么帧集要由配表决定，而不是扫目录
--------------------------------------
`textures/skills/` 目录里有几张**没有任何消费者**的遗留图：

    bullet.png              128×128   —— 是 SkillSlot / ShopRelicsItem 的**回落占位图**，必须留在图集外
    baotou.png              128×128   —— 无人引用（遗留素材）
    huoqiang.png            128×128   —— 无人引用（与 textures/heros/huoqiang.png 同名但不同图）
    魔棒·去背景.png          ~624 KB   —— 无人引用（某次实验残留，占着 resources/ 的构建体积）

扫目录会把它们一起打进图集（还把 624KB 那张也塞进去）。所以这里的帧集取
**`assets/resources/tb/abilities.json` 里 `icon` 列引用到的全部路径去重** ——
配表引用谁就打谁，自解释、可复核。

用法:
    python tools/skill-icon-prompts/build-skills-atlas.py                # 只算不写（报告）
    python tools/skill-icon-prompts/build-skills-atlas.py --apply        # 写盘
    python tools/skill-icon-prompts/build-skills-atlas.py --max-width 512
"""

import argparse
import importlib.util
import io
import json
import os
import sys

sys.stdout.reconfigure(errors="replace")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ATLAS_TOOL = os.path.join(ROOT, "tools", "relic-icon-prompts", "build-atlas.py")
ABILITIES = os.path.join(ROOT, "assets", "resources", "tb", "abilities.json")
SKILLS_DIR = os.path.join(ROOT, "assets", "resources", "textures", "skills")
PREFIX = "textures/skills/"

# 帧间距 2（plist 图集没有"扩边"元数据，靠间距防采样渗色）
#
# 画布宽度：**扫出来的，不是拍的**。40 帧 × 64×64 交付（裁剪后 51×51）实测：
#     max-width  画布        填充率   未压缩
#       256      212×532     92.2%    0.43 MB   ← 最优（帧少的时候窄画布填充率反而最高）
#       320      320×372     87.4%    0.45 MB
#       384      372×320     87.4%    0.45 MB
#       512      480×268     80.9%    0.49 MB
#       704      692×212     70.9%    0.56 MB
# ⚠ **换交付尺寸/换帧集之后这个数会变**（200 那轮的最优是 704）—— 重打前先不带 --apply 扫一遍。
DEFAULT_MAX_WIDTH = 256


def load_atlas_module():
    """按路径加载 build-atlas.py（文件名带连字符，普通 import 不行）。"""
    spec = importlib.util.spec_from_file_location("relic_build_atlas", ATLAS_TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def collect_frame_names(with_bullet=False):
    """从真配表收集要打帧的图标主干名（去重、保序）。

    `with_bullet=True` 时把占位图 bullet 也算进来 —— 用于「将来想把占位图也收进图集」的探路，
    缺省 False（占位图留在图集外，消费方两条路都能取到它）。
    """
    with io.open(ABILITIES, "r", encoding="utf-8") as fh:
        rows = json.load(fh)

    names = []
    seen = set()
    for row in rows:
        icon = (row.get("icon") or "").strip()
        if not icon:
            continue
        if not icon.startswith(PREFIX):
            print("  !! 跳过不在 skills/ 下的图标: %s（技能 %s）" % (icon, row.get("id")))
            continue
        stem = icon[len(PREFIX):]
        if stem in seen:
            continue
        seen.add(stem)
        names.append(stem)

    if with_bullet and "bullet" not in seen:
        names.append("bullet")

    # 逐张确认文件真的在（配表引用了但文件不存在 = 装机漏了，必须报出来而不是静默少打一帧）
    missing = [n for n in names if not os.path.isfile(os.path.join(SKILLS_DIR, n + ".png"))]
    if missing:
        print("  ✗ 配表引用了但文件不存在（先跑 install-hero-icons.py 装机）：")
        for m in missing:
            print("      %s.png" % m)
    return names, missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真写盘（缺省只出报告）")
    ap.add_argument("--name", default="skills")
    ap.add_argument("--max-width", type=int, default=DEFAULT_MAX_WIDTH)
    ap.add_argument("--with-bullet", action="store_true", help="把占位图 bullet 也打进图集")
    args = ap.parse_args()

    ba = load_atlas_module()

    names, missing = collect_frame_names(with_bullet=args.with_bullet)
    print("配表引用的技能图标 : %d 张" % len(names))
    if missing:
        return 1

    frames = ba.load_frames(SKILLS_DIR, names)
    if not frames:
        print("!! 一张都没读到")
        return 1

    src_area = sum(f["img"].width * f["img"].height for f in frames)
    loose_area = sum(f["src"][0] * f["src"][1] for f in frames)
    placed, size = ba.pack(frames, args.max_width)
    W, H = size
    canvas = W * H

    print("实际打包张数       : %d" % len(frames))
    print("裁剪后面积         : %s px（碎图原始 %s px，裁掉 %.1f%%）"
          % ("{:,}".format(src_area), "{:,}".format(loose_area),
             100.0 * (1 - src_area / float(loose_area or 1))))
    print("图集尺寸           : %dx%d（间距 %d）= %s px"
          % (W, H, ba.PAD, "{:,}".format(canvas)))
    print("填充率             : %.1f%%" % (100.0 * src_area / canvas))
    print("未压缩显存         : %.2f MB（RGBA8888）" % (canvas * 4 / 1048576.0))

    f0 = placed[0][0]
    print("抽查 %-16s textureRect={{%d,%d},{%d,%d}} spriteSize={%d,%d} spriteSourceSize={%d,%d} spriteOffset={%s,%s}"
          % (f0["key"], placed[0][1], placed[0][2], f0["img"].width, f0["img"].height,
             f0["img"].width, f0["img"].height, f0["src"][0], f0["src"][1],
             ba.fmt(f0["off"][0]), ba.fmt(f0["off"][1])))

    if not args.apply:
        print("\n（没给 --apply：只算不写）")
        return 0

    out_png = os.path.join(SKILLS_DIR, args.name + ".png")
    out_plist = os.path.join(SKILLS_DIR, args.name + ".plist")
    png_bytes = ba.write_png(placed, size, out_png)
    plist_bytes = ba.write_plist(placed, size, args.name + ".png", out_plist)
    print("\n已写出 %s (%s)" % (out_png, "{:,}B".format(png_bytes)))
    print("已写出 %s (%s)" % (out_plist, "{:,}B".format(plist_bytes)))
    print("\n下一步：python tools/skill-icon-prompts/check-skills-atlas.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
