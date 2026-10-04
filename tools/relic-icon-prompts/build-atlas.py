#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 assets/resources/textures/relics/ 下的碎图打成 **Cocos Creator 的「图集资源（Atlas）」**
= TexturePacker 4.x 的 plist（format 3）+ 同名 png 一对，拖进资源管理器即可被 3.8 的
`sprite-atlas` 导入器识别，展开后是 307 个 SpriteFrame 子资源。

格式真源（不是猜的）
--------------------
本机另一个工程里有一份 3.8 真导入过的图集：
    D:\\Project\\cocos\\merge_tower_defense\\assets\\resources\\icons\\pack\\texture.plist(+.meta)
它的 meta 写着 `"importer": "sprite-atlas"`、`userData.format = 3`、`subMetas` 里 16 个
`sprite-frame` 子资源（uuid = `<atlasUuid>@<5位十六进制>`，`name` = 帧名去掉扩展名）。
本脚本产出的 plist 就是照它的结构写的：
    frames/<name>.png -> { spriteOffset, spriteSize, spriteSourceSize, textureRect, textureRotated }
    metadata -> { format:3, pixelFormat, premultiplyAlpha, realTextureFileName, textureFileName, size }

坐标口径（照那个工程的 meta 反推、并用本工程碎图的 meta 验证过）
--------------------------------------------------------------
· `textureRect` = `{{x,y},{w,h}}`，**左上角为原点、y 向下**（图的 y 就是子资源 meta 里的 trimY）。
· `spriteSourceSize` = 原始（未裁剪）尺寸；`spriteSize` = 裁剪后尺寸。
· `spriteOffset` = 裁剪后中心相对原图中心的偏移，**y 向上**。
· 本工程碎图 meta 的实测关系（quelling_blade：bbox(19,6,44,57) → trimX 19 / trimY 6 /
  width 25 / height 51 / raw 64 / offsetX -0.5 / offsetY 0.5）证实：
      trimX = bbox.left, trimY = bbox.top
      offsetX = (bbox.left + bbox.right)/2 - W/2
      offsetY = H/2 - (bbox.top + bbox.bottom)/2      ← 注意 y 向上
  本脚本就按这三条写，**目标是让图集帧的裁剪数据与现有碎图逐字段一致 → 换图集后画面零变化**。

用法:
    python tools/relic-icon-prompts/build-atlas.py --dst <输出目录> [--name relics] [--max-width 2048]
    python tools/relic-icon-prompts/build-atlas.py --report            # 只算不写
"""

import argparse
import io
import os
import sys

from PIL import Image

sys.stdout.reconfigure(errors="replace")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "assets", "resources", "textures", "relics")

PAD = 2          # 帧与帧之间的间距（plist 图集没有"扩边"元数据，靠间距防采样渗色）
MAX_WIDTH = 2048


def alpha_bbox(im):
    """与导入器 trimThreshold=1 等价：裁掉 alpha==0 的边。返回 (l,t,r,b)。"""
    return im.getchannel("A").getbbox()


def load_frames(src, names=None):
    """读碎图。

    names 给定时**只读这些帧**（主干名，不带扩展名）—— 用于「帧集由配表决定」的场景：
    `textures/skills/` 里躺着 4 张没有任何消费者的遗留图（bullet / baotou / huoqiang / 魔棒·去背景），
    直接扫目录会把它们一起打进图集。缺省（None）行为与原来完全一致：扫整个目录。
    """
    if names is not None:
        wanted = list(names)
        entries = [n + ".png" for n in wanted]
    else:
        entries = sorted(n for n in os.listdir(src) if n.lower().endswith(".png"))
    frames = []
    for name in entries:
        if not name.lower().endswith(".png"):
            continue
        if names is None and name.startswith("relics"):   # 上一次跑出来的图集本身，别递归打包
            continue
        path = os.path.join(src, name)
        if not os.path.isfile(path):
            print("  !! 清单里的帧不存在，跳过: %s" % name)
            continue
        im = Image.open(path).convert("RGBA")
        box = alpha_bbox(im)
        if box is None:                    # 整张全透明
            print("  !! 跳过全透明图: %s" % name)
            continue
        crop = im.crop(box)
        key = os.path.splitext(name)[0]
        W, H = im.size
        off_x = (box[0] + box[2]) / 2.0 - W / 2.0
        off_y = H / 2.0 - (box[1] + box[3]) / 2.0
        frames.append({
            "key": key, "img": crop, "src": (W, H), "box": box,
            "off": (off_x, off_y),
        })
    return frames


class MaxRects:
    """MaxRects / Best-Short-Side-Fit —— TexturePacker 的默认算法就是 MaxRects。"""

    def __init__(self, max_w, max_h):
        self.max_w, self.max_h = max_w, max_h
        self.free = [(0, 0, max_w, max_h)]
        self.used = []

    def insert(self, w, h):
        best = None
        for i, (fx, fy, fw, fh) in enumerate(self.free):
            if w <= fw and h <= fh:
                leftover_h = fw - w
                leftover_v = fh - h
                short = min(leftover_h, leftover_v)
                long = max(leftover_h, leftover_v)
                score = (short, long)
                if best is None or score < best[0]:
                    best = (score, i, (fx, fy, fw, fh))
        if best is None:
            return None
        _s, i, (fx, fy, fw, fh) = best
        node = (fx, fy, w, h)
        self.used.append(node)
        self._split(node)
        self._prune()
        return (fx, fy)

    def _split(self, node):
        """MaxRects 标准 SplitFreeNode：与 node 相交的空闲矩形切成 上/下/左/右 四块。"""
        nx, ny, nw, nh = node
        out = []
        for (fx, fy, fw, fh) in self.free:
            if nx >= fx + fw or nx + nw <= fx or ny >= fy + fh or ny + nh <= fy:
                out.append((fx, fy, fw, fh))          # 不相交：原样保留
                continue
            if ny > fy:                                # 上（整宽）
                out.append((fx, fy, fw, ny - fy))
            if ny + nh < fy + fh:                      # 下（整宽）
                out.append((fx, ny + nh, fw, fy + fh - (ny + nh)))
            if nx > fx:                                # 左（整高）
                out.append((fx, fy, nx - fx, fh))
            if nx + nw < fx + fw:                      # 右（整高）
                out.append((nx + nw, fy, fx + fw - (nx + nw), fh))
        self.free = out

    def _prune(self):
        """去掉被其它空闲矩形完全包含的（MaxRects 的标准剪枝）。"""
        keep = []
        for i, a in enumerate(self.free):
            contained = False
            for j, b in enumerate(self.free):
                if i == j:
                    continue
                if (b[0] <= a[0] and b[1] <= a[1]
                        and b[0] + b[2] >= a[0] + a[2]
                        and b[1] + b[3] >= a[1] + a[3]):
                    contained = True
                    break
            if not contained:
                keep.append(a)
        self.free = keep

    def bounds(self):
        if not self.used:
            return (0, 0)
        return (max(u[0] + u[2] for u in self.used),
                max(u[1] + u[3] for u in self.used))


def pack(frames, max_w, max_h=8192, align=4):
    """按面积从大到小放（MaxRects 的常规预处理），返回 [(frame, x, y)] 与画布尺寸。"""
    order = sorted(frames, key=lambda f: -(f["img"].width * f["img"].height))
    rects = MaxRects(max_w, max_h)
    placed = []
    for f in order:
        w, h = f["img"].size
        pos = rects.insert(w + PAD, h + PAD)
        if pos is None:
            raise SystemExit("!! 放不下：把 --max-width 调大（当前 %d）" % max_w)
        placed.append((f, pos[0], pos[1]))
    bw, bh = rects.bounds()
    # 画布尺寸向上对齐：压缩纹理（ASTC/ETC2）按 4x4 分块，尺寸不是 4 的倍数会浪费
    aw = (bw + align - 1) // align * align
    ah = (bh + align - 1) // align * align
    return placed, (aw, ah)


def write_png(placed, size, out_png):
    sheet = Image.new("RGBA", size, (0, 0, 0, 0))
    for f, x, y in placed:
        sheet.paste(f["img"], (x, y))
    sheet.save(out_png)
    return os.path.getsize(out_png)


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def write_plist(placed, size, tex_name, out_plist):
    L = []
    L.append('<?xml version="1.0" encoding="UTF-8"?>')
    L.append('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">')
    L.append('<plist version="1.0">')
    L.append('<dict>')
    L.append('<key>frames</key>')
    L.append('<dict>')
    for f, x, y in sorted(placed, key=lambda p: p[0]["key"]):
        w, h = f["img"].size
        sw, sh = f["src"]
        ox, oy = f["off"]
        L.append('<key>%s.png</key>' % esc(f["key"]))
        L.append('<dict>')
        L.append('<key>spriteOffset</key>')
        L.append('<string>{%s,%s}</string>' % (fmt(ox), fmt(oy)))
        L.append('<key>spriteSize</key>')
        L.append('<string>{%d,%d}</string>' % (w, h))
        L.append('<key>spriteSourceSize</key>')
        L.append('<string>{%d,%d}</string>' % (sw, sh))
        L.append('<key>textureRect</key>')
        L.append('<string>{{%d,%d},{%d,%d}}</string>' % (x, y, w, h))
        L.append('<key>textureRotated</key>')
        L.append('<false/>')
        L.append('</dict>')
    L.append('</dict>')
    L.append('<key>metadata</key>')
    L.append('<dict>')
    L.append('<key>format</key>')
    L.append('<integer>3</integer>')
    L.append('<key>pixelFormat</key>')
    L.append('<string>RGBA8888</string>')
    L.append('<key>premultiplyAlpha</key>')
    L.append('<false/>')
    L.append('<key>realTextureFileName</key>')
    L.append('<string>%s</string>' % esc(tex_name))
    L.append('<key>textureFileName</key>')
    L.append('<string>%s</string>' % esc(tex_name))
    L.append('<key>size</key>')
    L.append('<string>{%d,%d}</string>' % size)
    L.append('</dict>')
    L.append('</dict>')
    L.append('</plist>')
    L.append('')
    with io.open(out_plist, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(L))
    return os.path.getsize(out_plist)


def fmt(v):
    """整数就不带小数点，和 TexturePacker 的输出习惯一致。"""
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return ("%.1f" % v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=SRC)
    ap.add_argument("--dst", default=None, help="输出目录（不写就只报告）")
    ap.add_argument("--name", default="relics")
    ap.add_argument("--max-width", type=int, default=MAX_WIDTH)
    ap.add_argument("--names-file", default="",
                    help="只打包这些帧：一个 JSON 数组文件（帧主干名，不带扩展名）。"
                         "缺省 = 扫 --src 下所有 png（原行为）。")
    args = ap.parse_args()

    names = None
    if args.names_file:
        import json
        with io.open(args.names_file, "r", encoding="utf-8") as fh:
            names = json.load(fh)
        if not isinstance(names, list):
            raise SystemExit("!! --names-file 必须是 JSON 数组（帧主干名列表）")

    frames = load_frames(args.src, names)
    if not frames:
        print("!! 没找到碎图: %s" % args.src)
        return 1
    src_area = sum(f["img"].width * f["img"].height for f in frames)
    loose_area = sum(f["src"][0] * f["src"][1] for f in frames)
    placed, size = pack(frames, args.max_width)
    W, H = size
    canvas = W * H

    print("碎图张数   : %d" % len(frames))
    print("裁剪后面积 : %s px（碎图原始 %s px，裁掉 %.1f%%）"
          % ("{:,}".format(src_area), "{:,}".format(loose_area),
             100.0 * (1 - src_area / float(loose_area or 1))))
    print("图集尺寸   : %dx%d（间距 %d）= %s px" % (W, H, PAD, "{:,}".format(canvas)))
    print("填充率     : %.1f%%" % (100.0 * src_area / canvas))
    print("未压缩显存 : %.2f MB（RGBA8888）" % (canvas * 4 / 1048576.0))

    f0 = placed[0][0]
    print("抽查 %-16s textureRect={{%d,%d},{%d,%d}} spriteSize={%d,%d} spriteSourceSize={%d,%d} spriteOffset={%s,%s}"
          % (f0["key"], placed[0][1], placed[0][2], f0["img"].width, f0["img"].height,
             f0["img"].width, f0["img"].height, f0["src"][0], f0["src"][1],
             fmt(f0["off"][0]), fmt(f0["off"][1])))

    if not args.dst:
        print("\n（--dst 没给，只算不写）")
        return 0

    os.makedirs(args.dst, exist_ok=True)
    out_png = os.path.join(args.dst, args.name + ".png")
    out_plist = os.path.join(args.dst, args.name + ".plist")
    png_bytes = write_png(placed, size, out_png)
    plist_bytes = write_plist(placed, size, args.name + ".png", out_plist)
    print("\n已写出 %s (%s)" % (out_png, "{:,}B".format(png_bytes)))
    print("已写出 %s (%s)" % (out_plist, "{:,}B".format(plist_bytes)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
