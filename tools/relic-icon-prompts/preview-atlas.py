#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
离线预览 Cocos Creator 自动图集（auto-atlas.pac）的打包结果。

为什么有这个脚本
----------------
Cocos Creator 3.x 的「自动图集」是一个**构建期配置资源**，不是工程里的 PNG：

    assets/resources/textures/relics/auto-atlas.pac   （37 字节的 JSON，只有一行 __type__）

真正的大图只在**构建时**生成，编辑器里要看结果只有一个入口 ——
选中 auto-atlas.pac → 属性检查器 → 「预览」按钮 → Packed Textures / Unpacked Textures。
（官方文档 https://docs.cocos.com/creator/3.8/manual/zh/asset/auto-atlas.html 「配置自动图集资源」一节）

这个脚本把「预览」这一步离线算一遍，用途有两个：
  1. 不开编辑器就能确认 **307 张碎图装不装得下、会出几张图、长什么样**；
  2. 换 maxWidth/maxHeight 时先看清会分几页（编辑器默认 1024 会分成 2 页）。

口径与编辑器默认配置一致（见 auto-atlas.pac.meta 的 userData）：
    maxWidth/maxHeight = 页面上限（默认 1024）/ padding = 2 / 扩边 1px（contourBleed + paddingBleed）
    powerOfTwo = false（页面尺寸不向上取 2 的幂）

所有碎图同为 64×64，所以 MaxRects 在该输入下退化成按行网格，脚本用网格排布，
产出的是**示意布局**，不是编辑器那份二进制精确到像素的排布（页数与占用面积是一致的）。

用法:
    python tools/relic-icon-prompts/preview-atlas.py
    python tools/relic-icon-prompts/preview-atlas.py --max 1024 --max 2048
    python tools/relic-icon-prompts/preview-atlas.py --save
"""

import argparse
import os
import sys

from PIL import Image

sys.stdout.reconfigure(errors="replace")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "assets", "resources", "textures", "relics")
OUT_DIR = os.path.join(ROOT, "docs", "relic-icon")

PAD = 2      # 图集中碎图之间的间距
BLEED = 1    # 扩边：碎图边框外扩 1 像素并复制相邻像素


def load_items(src):
    """读入所有碎图（跳过 .pac / .meta / 非 4 通道）。"""
    items = []
    for name in sorted(os.listdir(src)):
        if not name.lower().endswith(".png"):
            continue
        path = os.path.join(src, name)
        with Image.open(path) as im:
            im = im.convert("RGBA")
            items.append((name, im))
    return items


def pack(items, max_side):
    """
    网格排布，返回 [(page_w, page_h, [(x, y, name, image)])].

    每格占位 = 碎图边长 + 2*扩边；格与格之间再留 padding。
    """
    pitch_pad = PAD + BLEED * 2          # 每个格子额外占的边距
    cell = items[0][1].width + pitch_pad  # 用第一张当基准（本项目全部同尺寸）
    per_row = max(1, (max_side - PAD) // cell)

    pages = []
    cur = []
    row = col = 0
    used_w = used_h = 0

    def flush():
        if cur:
            pages.append((used_w, used_h, list(cur)))

    for name, im in items:
        if col >= per_row:
            col = 0
            row += 1
        y = PAD + row * cell
        if y + im.height + BLEED * 2 > max_side:
            flush()
            cur.clear()
            row = col = 0
            used_w = used_h = 0
            y = PAD
        x = PAD + col * cell
        cur.append((x + BLEED, y + BLEED, name, im))
        used_w = max(used_w, x + im.width + BLEED * 2 + PAD)
        used_h = max(used_h, y + im.height + BLEED * 2 + PAD)
        col += 1

    flush()
    return pages


def render(page, out_path):
    """按 1:1 画出一页图集（含扩边）。"""
    w, h, cells = page
    sheet = Image.new("RGBA", (max(w, 1), max(h, 1)), (0, 0, 0, 0))
    for x, y, _name, im in cells:
        # 扩边：把碎图放大 1px 后按原尺寸贴，得到一圈"复制边缘像素"的外框
        grew = im.resize((im.width + BLEED * 2, im.height + BLEED * 2), Image.NEAREST)
        sheet.paste(grew, (x - BLEED, y - BLEED))
    sheet.save(out_path)
    return os.path.getsize(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=SRC)
    ap.add_argument("--max", type=int, action="append", default=None,
                    help="页面最大边长，可给多次（默认比对 1024 与 2048）")
    ap.add_argument("--save", action="store_true", help="把第一页写成 PNG 便于肉眼看")
    args = ap.parse_args()

    limits = args.max or [1024, 2048]
    items = load_items(args.src)
    if not items:
        print("!! 没找到碎图: %s" % args.src)
        return 1

    sizes = sorted({im.size for _n, im in items})
    print("碎图目录 : %s" % os.path.relpath(args.src, ROOT))
    print("碎图张数 : %d" % len(items))
    print("碎图尺寸 : %s" % ", ".join("%dx%d" % s for s in sizes))
    print("配置口径 : padding=%d, 扩边=%dpx, powerOfTwo=false" % (PAD, BLEED))
    print("")

    rc = 0
    for lim in limits:
        pages = pack(items, lim)
        total_px = sum(w * h for w, h, _c in pages)
        print("maxWidth/maxHeight = %d  ->  %d 页" % (lim, len(pages)))
        for i, (w, h, cells) in enumerate(pages, 1):
            print("    第 %d 页: %dx%d (%s 像素, 未压缩 RGBA %s)"
                  % (i, w, h, "{:,}".format(w * h), "{:.1f}MB".format(w * h * 4 / 1048576)))
            print("            容纳 %d 张" % len(cells))
        print("    合计 %s 像素 / 未压缩显存 %s"
              % ("{:,}".format(total_px), "{:.1f}MB".format(total_px * 4 / 1048576)))
        print("")

    # 用最大上限出图（这是推荐配置）
    best = max(limits)
    pages = pack(items, best)
    print("推荐 maxWidth/maxHeight = %d -> %d 页（%s 张全进图集，无 Unpacked）"
          % (best, len(pages), len(items)))

    if args.save:
        os.makedirs(OUT_DIR, exist_ok=True)
        for i, page in enumerate(pages, 1):
            name = "atlas-preview.png" if len(pages) == 1 else "atlas-preview-p%d.png" % i
            out = os.path.join(OUT_DIR, name)
            size = render(page, out)
            print("已写出预览: %s (%s)" % (os.path.relpath(out, ROOT), "{:,}B".format(size)))

    return rc


if __name__ == "__main__":
    sys.exit(main())
