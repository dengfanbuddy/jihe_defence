#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make-delivery.py —— 把 ComfyUI 出的原图（640×640 那一档）做成**工程可直接用**的 200×200 RGBA 图标。

为什么需要这一步（两个实测理由，别手改图代替）：
  1. **MARGIN 那句提示词不可靠**。提示词里写了「四周各留约 1/10」，实测 4 张里 bfury 下边距只有 6.1%、
     assault 左右各 8.1%（刚好卡在门槛上）—— 模型对"留白"只有大致感觉。交付时按 alpha 包围盒**重新摆位**
     才是确定性的：不管模型把主体画多大，出来都是「长边占 80%、四周各留 10%」。
  2. **成套图标需要一致的视觉大小**。307 张各自构图宽窄不一（实测包围盒占位 30%~84%），直接缩到 200px
     会出现「有的塞满、有的很小」的参差；按包围盒归一到同一占比后，整屏商店的图标才是一套。

做三件事：按 alpha 裁到主体 → 装进正方形画布并把长边归一到 `--content` → LANCZOS 缩到 200×200（RGBA）。
**透明边缘用预乘 alpha 缩放**（先乘 alpha 再缩、缩完除回来），否则透明像素里的黑 RGB 会在边缘渗出深色描边。

用法：
    python tools/relic-icon-prompts/make-delivery.py --src .tmp/relic-icons-out --dst .tmp/relic-icons-200
    python tools/relic-icon-prompts/make-delivery.py --src .tmp/relic-icons-pilot --dst .tmp/relic-icons-200 --only bfury,blink
做完直接跑交付体检确认：`python tools/relic-icon-prompts/check-icons.py --dir .tmp/relic-icons-200`
"""
import argparse
import os
import sys

import numpy as np
from PIL import Image

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")

# alpha 低于这个值就当背景（抗锯齿边缘的半透明像素不算主体）
ALPHA_FLOOR = 16


def alpha_bbox(im):
    """主体包围盒：把 alpha 二值化后再求 bbox（`getbbox()` 直接对 RGBA 用会把任意非零像素都算进去）。"""
    mask = im.getchannel("A").point(lambda v: 255 if v >= ALPHA_FLOOR else 0)
    return mask.getbbox()


def resize_premultiplied(im, size):
    """预乘 alpha 再缩放，避免透明区域的黑 RGB 在边缘渗出深色描边。

    透明像素的 RGB 是模型随手填的（常是黑），直接 LANCZOS 会让这些黑渗进主体边缘一圈；
    「预乘 → 缩放 → 除回来」是标准解法，numpy 就是为这一步用的。
    """
    arr = np.asarray(im.convert("RGBA"), dtype=np.float32)
    a = arr[..., 3:4] / 255.0
    pre = arr.copy()
    pre[..., :3] = arr[..., :3] * a  # 预乘
    pm = Image.fromarray(pre.astype(np.uint8), "RGBA").resize(size, Image.LANCZOS)
    out = np.asarray(pm, dtype=np.float32)
    a2 = out[..., 3:4] / 255.0
    safe = np.where(a2 > 0, a2, 1.0)
    out[..., :3] = np.where(a2 > 0, out[..., :3] / safe, 0.0)  # 除回来
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def delivery(src_path, dst_path, size, content):
    im = Image.open(src_path).convert("RGBA")
    # ⚠ 假透明闸：**这一步不做的话，本脚本会把假透明"洗白"**。
    # 源图整张不透明时，包围盒 = 全画幅 → 本脚本照样贴出一圈透明边距、输出一张"合规"的 200×200，
    # 于是 check-icons 全绿，而图里其实烘焙着一块底板。实测踩过：4 张图 alpha 全是 240~255，
    # 交付后 alpha 极值却是 (0, 255)、留白正好 10% —— **指标全过，图是废的**。
    hist = im.getchannel("A").histogram()
    total = im.size[0] * im.size[1]
    if sum(hist[:128]) / total < 0.01:
        return None, "源图没有真透明像素（假透明：alpha 全在 128 以上，底板被画进像素了）—— 别交付，先重出或用官方去背景模板"
    box = alpha_bbox(im)
    if box is None:
        return None, "整张图全透明，没有主体"
    sub = im.crop(box)
    bw, bh = sub.size
    # 长边归一到 content（正方形画布），让主体在 200×200 里占据固定比例、四周等宽留白
    scale = (size * content) / max(bw, bh)
    tw, th = max(1, round(bw * scale)), max(1, round(bh * scale))
    # 先按目标尺寸预乘缩放，再贴到正方形画布正中
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    small = resize_premultiplied(sub, (tw, th))
    canvas.paste(small, ((size - tw) // 2, (size - th) // 2))
    canvas.save(dst_path, "PNG", optimize=True)
    return box, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="ComfyUI 原图目录")
    ap.add_argument("--dst", required=True, help="交付目录（200×200）")
    ap.add_argument("--size", type=int, default=200, help="交付边长（工程统一 200）")
    ap.add_argument("--content", type=float, default=0.80,
                    help="主体长边占画布的比例（0.80 = 四周各留 10%%）")
    ap.add_argument("--only", default="", help="只处理这些 key（逗号分隔）")
    args = ap.parse_args()

    os.makedirs(args.dst, exist_ok=True)
    wanted = {k.strip() for k in args.only.split(",") if k.strip()}
    names = sorted(f for f in os.listdir(args.src) if f.lower().endswith(".png"))
    if wanted:
        names = [f for f in names if os.path.splitext(f)[0] in wanted]

    done = bad = 0
    for i, name in enumerate(names, 1):
        box, err = delivery(os.path.join(args.src, name), os.path.join(args.dst, name), args.size, args.content)
        if err:
            print(f"  [{i}/{len(names)}] × {name}：{err}")
            bad += 1
            continue
        print(f"  [{i}/{len(names)}] √ {name}：主体 {box[2] - box[0]}×{box[3] - box[1]}px → {args.size}×{args.size} RGBA")
        done += 1
    print(f"\n◆ 交付 {done} 张 · 失败 {bad} 张 → {args.dst}")
    print(f"◆ 体检：python tools/relic-icon-prompts/check-icons.py --dir {args.dst}")


if __name__ == "__main__":
    main()
