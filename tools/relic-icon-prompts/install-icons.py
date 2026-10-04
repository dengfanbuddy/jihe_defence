#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
install-icons.py —— 把 `make-delivery.py` 交付的 200×200 图标装进工程。

用法：
    # 先空跑看清会动哪些文件
    python tools/relic-icon-prompts/install-icons.py --src .tmp/relic-icons-200 --dry-run
    # 确认无误再真装
    python tools/relic-icon-prompts/install-icons.py --src .tmp/relic-icons-200

三道闸（任何一条不过就跳过那张，不会把坏图装进工程）：
  ① **不碰 `yazhizhiren.png`** —— 它是 `RelicItem.prefab` 里图标槽的占位图（预制件按 uuid 引用），
     出图目录里万一有同名文件也一律跳过；
  ② **交付体检不过的不装** —— 真 alpha（`A` 最小值必须为 0）、正方形、200×200、四边留白 ≥ 8%；
  ③ **不在提示词清单里的文件名不装** —— 防止把别的批次/手改的图混进来（`--allow-extra` 可放行）。

**不动 `.meta`**：覆盖同名文件时 uuids 不变，编辑器只当作"贴图内容变了"；新增文件（本地原本没图的那
14 件）要等编辑器导入生成 `.meta`（编辑器窗口不在前台时资源库不刷新，切回 Cocos 窗口才导入）。
"""
import argparse
import csv
import os
import shutil
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DEFAULT_CSV = os.path.join(ROOT, "docs", "relic-icon", "prompts.csv")
DEFAULT_DST = os.path.join(ROOT, "assets", "resources", "textures", "relics")
KEEP = {"yazhizhiren.png"}  # 占位图，永不覆盖

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")


def check(path, size):
    """交付体检：返回 (通过?, 原因)。"""
    im = Image.open(path)
    if im.mode != "RGBA":
        return False, f"不是 RGBA（{im.mode}）"
    if im.size != (size, size):
        return False, f"尺寸 {im.size[0]}×{im.size[1]} ≠ {size}×{size}"
    alpha = im.getchannel("A")
    if alpha.getextrema()[0] != 0:
        return False, f"假透明（alpha 最小值 {alpha.getextrema()[0]}，应为 0）"
    box = alpha.point(lambda v: 255 if v >= 16 else 0).getbbox()
    if box is None:
        return False, "整张全透明"
    w, h = im.size
    m = min(box[0] / w, (w - 1 - box[2]) / w, box[1] / h, (h - 1 - box[3]) / h) * 100
    if m < 8:
        return False, f"留白不足（最小边距 {m:.1f}% < 8%）"
    return True, ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="交付目录（make-delivery.py 的输出）")
    ap.add_argument("--dst", default=DEFAULT_DST)
    ap.add_argument("--csv", default=DEFAULT_CSV)
    ap.add_argument("--size", type=int, default=64, help="期望的正方形边长（工程遗物图标交付规格 = 64）")
    ap.add_argument("--dry-run", action="store_true", help="只打印会动什么，不写盘")
    ap.add_argument("--allow-extra", action="store_true",
                    help="放行不在提示词清单里的文件名（默认拒绝，防止混进别的图）")
    args = ap.parse_args()

    known = set()
    with open(args.csv, "r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            name = (row.get("out_png") or "").strip()
            if name:
                known.add(name)

    names = sorted(f for f in os.listdir(args.src) if f.lower().endswith(".png"))
    if not names:
        sys.exit(f"× {args.src} 里没有 png")

    replaced, added, skipped = [], [], []
    for name in names:
        src = os.path.join(args.src, name)
        dst = os.path.join(args.dst, name)
        if name in KEEP:
            skipped.append((name, "占位图，永不覆盖"))
            continue
        if known and name not in known and not args.allow_extra:
            skipped.append((name, "不在 prompts.csv 清单里（--allow-extra 可放行）"))
            continue
        ok, why = check(src, args.size)
        if not ok:
            skipped.append((name, why))
            continue
        exists = os.path.exists(dst)
        if not args.dry_run:
            os.makedirs(args.dst, exist_ok=True)
            shutil.copy2(src, dst)
        (replaced if exists else added).append(name)

    verb = "将覆盖" if args.dry_run else "已覆盖"
    print(f"◆ 交付目录：{args.src}")
    print(f"◆ 工程目录：{args.dst}{'（--dry-run，没写盘）' if args.dry_run else ''}")
    print(f"\n{verb} {len(replaced)} 张（本地原本就有，配表不用改）")
    if added:
        print(f"新增 {len(added)} 张（本地原本没有 → 这 {len(added)} 件要改配表 icon 列 + 等编辑器导入）：")
        for n in added:
            print(f"    + {n}")
    if skipped:
        print(f"跳过 {len(skipped)} 张：")
        for n, why in skipped:
            print(f"    - {n}：{why}")
    if not args.dry_run and added:
        print("\n◆ 下一步：给上面这 %d 件补 icon 列（见 docs/relic-icon/README.md §7.3），"
              "然后切回 Cocos 编辑器等导入" % len(added))


if __name__ == "__main__":
    main()
