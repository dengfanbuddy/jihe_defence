#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check-hero-icons.py —— 英雄头像 / 技能图标的交付体检。

查六件事（全部是**工程既有口径的实测值**，不是审美偏好；出处见 docs/hero-icons/README.md）：
  ① **单色**：不透明像素（alpha ≥ FLOOR）的 RGB **必须全是 #F6F6F6**。
     现有素材就是这个纯度 —— `textures/heros/huoqiang.png` 不透明像素 66% 是 #F6F6F6、其余是它的
     抗锯齿邻色，`textures/skills/bullet.png` **100% 是 #FFFFFF**，第二颜色为零。
     底色由预制件给（头像 #A85A5A / 技能图 #70ACB3），所以图里多一个颜色就是错。
  ② **真 alpha**：整图 alpha 最小值必须是 0，否则背景是画进像素里的（进游戏就是一块方板）。
  ③ **正方形**：交付图必须是正方形（槽位是 `sizeMode=CUSTOM`，非正方形会被拉伸）。
  ④ **包围盒正方形 + 留白**：alpha 包围盒的宽高必须相等（±1px），四边留白各 ≥ MARGIN_MIN。
     ⚠ 这条是**工程正确性**不是美观：`_isTrimmedMode=true` + `sizeMode=CUSTOM` 下，
     导入器按包围盒算 trim、节点再把 trim 后的矩形铺满槽位 → **包围盒非正方形 = 画面被拉伸**。
  ⑤ **交付尺寸**：头像 256×256 / 技能图 **64×64**（2026-10 口径：技能图压到 64，
     因为真实显示处最大只有 50×50、选人卡是 20×20；`.meta` 一变，图集也随之变小）。
  ⑥ **脆度**：半透明像素（0.05 < alpha < 0.95）占比不能过高 —— 那些是「白色材质被打了光」留下的
     灰面，说明模型画的是立体插画而不是白描色块；这类灰面进游戏就是脏边。

用法：
    # 查出图目录（还没装机的产物）
    python tools/hero-icon-prompts/check-hero-icons.py --dir .tmp/hero-icons-final
    # 查装机后的真实资源目录（按 prompts.json 的 icon_path 逐个验）
    python tools/hero-icon-prompts/check-hero-icons.py --installed
    # 只看前几张明细
    python tools/hero-icon-prompts/check-hero-icons.py --dir X --limit 6
退出码：有违规 = 1。
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
PROMPTS = os.path.join(ROOT, "docs", "hero-icons", "prompts.json")

BODY_RGB = np.array([246, 246, 246], dtype=np.int16)
COLOR_TOL = 2              # 允许 ±2 的抗锯齿/量化误差
ALPHA_FLOOR = 128          # 「不透明像素」的门槛
MARGIN_MIN = 0.06          # 四边留白下限（交付按 80% 摆放 → 理论 10%）
SOFT_MAX = 0.28            # 半透明像素占比上限
EXPECT = {"emblem": 256, "icon": 64}


def measure(path, expect_size):
    im = Image.open(path)
    w, h = im.size
    rgba = im.convert("RGBA")
    arr = np.asarray(rgba, dtype=np.int16)
    alpha = arr[..., 3]
    amin = int(alpha.min())

    problems = []
    if amin > 0:
        problems.append(f"无透明背景（alpha 最小 {amin}，背景画进像素里了）")

    solid = alpha >= ALPHA_FLOOR
    n_solid = int(solid.sum())
    if n_solid == 0:
        return w, h, amin, None, ["整张图没有不透明像素"], {}

    # ① 单色
    rgb = arr[..., :3]
    off = np.abs(rgb - BODY_RGB[None, None, :]).max(axis=2)
    bad_color = int((solid & (off > COLOR_TOL)).sum())
    color_ratio = bad_color / n_solid
    if color_ratio > 0.005:
        # 报出最常见的杂色，便于定位是「模型加了色」还是「抗锯齿」
        vals, counts = np.unique(rgb[solid & (off > COLOR_TOL)].reshape(-1, 3), axis=0, return_counts=True)
        top = vals[np.argsort(-counts)][:3]
        top_s = ", ".join("#%02X%02X%02X" % tuple(int(v) for v in c) for c in top)
        problems.append(f"不是单色：{color_ratio:.2%} 的不透明像素偏离 #F6F6F6（最多见 {top_s}）")

    # ③④ 正方形 + 包围盒
    mask = alpha >= 20
    ys, xs = np.where(mask)
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
    bw, bh = bbox[2] - bbox[0] + 1, bbox[3] - bbox[1] + 1
    margins = (bbox[0] / w, 1 - (bbox[2] + 1) / w, bbox[1] / h, 1 - (bbox[3] + 1) / h)
    if abs(bw - bh) > 1:
        problems.append(f"包围盒不是正方形（{bw}×{bh}）→ trim+CUSTOM 下会被拉伸")
    if min(margins) < MARGIN_MIN:
        problems.append("留白不足（左%.1f%% 右%.1f%% 上%.1f%% 下%.1f%%）" % tuple(m * 100 for m in margins))

    if w != h:
        problems.append(f"不是正方形（{w}×{h}）")
    if expect_size and (w, h) != (expect_size, expect_size):
        problems.append(f"尺寸不是 {expect_size}×{expect_size}（当前 {w}×{h}）")

    # ⑥ 脆度
    soft = int(((alpha > 13) & (alpha < 242)).sum()) / (w * h)
    if soft > SOFT_MAX:
        problems.append(f"半透明像素过多（{soft:.1%}）—— 像是被打了光的白色材质，不是白描色块")

    diag = {
        "bbox": [bw, bh],
        "content_ratio": round(max(bw, bh) / w, 3),
        "color_dev": round(color_ratio, 5),
        "soft": round(soft, 4),
        "solid_ratio": round(n_solid / (w * h), 3),
    }
    return w, h, amin, margins, problems, diag


def size_by_key():
    """key → 期望边长（从 prompts.json 读，避免在这里硬编码第二份尺寸表）。"""
    with open(PROMPTS, "r", encoding="utf-8") as fh:
        items = json.load(fh)["items"]
    return {it["key"]: int(it["size"]) for it in items}


def collect_installed():
    """按 prompts.json 的 icon_path 去真实资源目录找文件（内置分包相对路径 + .png）。"""
    with open(PROMPTS, "r", encoding="utf-8") as fh:
        items = json.load(fh)["items"]
    pairs, missing = [], []
    for it in items:
        p = os.path.join(ROOT, "assets", "resources", it["icon_path"] + ".png")
        (pairs if os.path.exists(p) else missing).append(p if os.path.exists(p) else it["icon_path"])
    return pairs, missing, {it["icon_path"] + ".png": it for it in items}


def main():
    # ⚠ `global` 必须出现在本函数里**第一次用到 PROMPTS 之前** ——
    #   argparse 的 default 就会读它，所以这行必须放在最前面（放后面是 SyntaxError，
    #   表现是「体检直接崩 → 装机闸①报体检不过」，别被误导成图有问题）。
    global PROMPTS

    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="", help="要体检的目录（key.png 命名）")
    ap.add_argument("--installed", action="store_true", help="按 prompts.json 的 icon_path 查装机后的资源")
    ap.add_argument("--limit", type=int, default=0, help="只打印前 N 张明细")
    ap.add_argument("--prompts", default=PROMPTS,
                    help="清单文件（缺省 = 英雄那份）。技能图标传 docs/skill-icons/prompts.json，"
                         "这样 --dir 模式能按清单里的 size 校验边长，而不是跳过尺寸检查。")
    args = ap.parse_args()

    # 清单路径可覆盖：`size_by_key()` / `collect_installed()` 读的是模块级 PROMPTS
    PROMPTS = args.prompts

    entries = []   # (label, path, expect_size)
    if args.installed:
        pairs, missing, meta = collect_installed()
        if missing:
            print(f"⚠ 还没装机的 {len(missing)} 个：{', '.join(missing)}")
        for p in pairs:
            rel = os.path.relpath(p, os.path.join(ROOT, "assets", "resources")).replace("\\", "/")
            it = meta[rel]
            entries.append((rel, p, EXPECT[it["slot"]]))
    else:
        d = args.dir or os.path.join(ROOT, ".tmp", "hero-icons-final")
        if not os.path.isdir(d):
            sys.exit(f"× 目录不存在：{d}")
        sizes = size_by_key()
        for f in sorted(os.listdir(d)):
            if not f.lower().endswith(".png") or f.startswith("_"):
                continue
            key = f[:-4]
            entries.append((f, os.path.join(d, f), sizes.get(key)))

    if not entries:
        sys.exit("× 没有可体检的文件")

    bad, shown = [], 0
    for label, p, exp in entries:
        w, h, amin, margins, problems, diag = measure(p, exp or 0)
        if problems:
            bad.append((label, problems))
        if args.limit and shown < args.limit:
            shown += 1
            m = "—" if not margins else "左%.1f%% 右%.1f%% 上%.1f%% 下%.1f%%" % tuple(x * 100 for x in margins)
            print(f"{'×' if problems else '√'} {label:38} {w}×{h}  包围盒 {diag['bbox']}  占屏 {diag['content_ratio']:.0%}  "
                  f"杂色 {diag['color_dev']:.2%}  半透 {diag['soft']:.1%}  留白 {m}")
            for pr in problems:
                print(f"    · {pr}")

    print(f"\n◆ 共 {len(entries)} 张，违规 {len(bad)} 张")
    print(f"◆ 判据：单色 #F6F6F6（±{COLOR_TOL}）/ 真 alpha / 正方形 / 包围盒正方形 / 留白 ≥{MARGIN_MIN:.0%} / 半透明 ≤{SOFT_MAX:.0%}")
    if bad:
        print("◆ 违规清单：")
        for label, problems in bad[:12]:
            print(f"   · {label}：{problems[0]}" + (f"（等 {len(problems)} 条）" if len(problems) > 1 else ""))
        sys.exit(1)
    print("√ 全部通过")


if __name__ == "__main__":
    main()
