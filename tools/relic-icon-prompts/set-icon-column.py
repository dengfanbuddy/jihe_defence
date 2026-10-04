#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
set-icon-column.py —— 给「本地原本没图」的遗物补 `icon` 列（`relics.json`）。

背景（2026-09 那次迁移的收尾）：`relics.json` 的 307 行里，**293 行的 icon 早就是本地路径**
（`textures/relics/<key>`，同名覆盖即可，配表一个字不用改），剩下 **14 行**没有本地素材：
  · 7 行 `icon` 是空的：id 1~5（手工 demo 遗物）+ 1296 / 1300
  · 7 行 `icon` 是 steam CDN 的远程 URL：1294/1295/1297/1298/1299/1301/1302
本轮出图把这 14 件都出出来了（文件名 = `prompts.csv` 的 `key`），所以要把 `icon` 指过去。

**幂等**：只改「icon 不是本地路径 **且** 目标 png 确实存在」的行；已经是本地路径的行一律不动。

用法：
    python tools/relic-icon-prompts/set-icon-column.py --dry-run   # 只打印会改哪些行
    python tools/relic-icon-prompts/set-icon-column.py             # 真改 JSON

⚠ 改完 **必须回灌 xlsx**，否则下一次 `npm run export` 会把 JSON 覆盖回去：
    cd tools/excel_export && node src/cli.ts json2excel --force --table relics
    npm run check && npm run verify
"""
import argparse
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
RELICS = os.path.join(ROOT, "assets", "resources", "tb", "relics.json")
CSV = os.path.join(ROOT, "docs", "relic-icon", "prompts.csv")
ICON_DIR = os.path.join(ROOT, "assets", "resources", "textures", "relics")
PREFIX = "textures/relics"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--relics", default=RELICS)
    ap.add_argument("--csv", default=CSV)
    ap.add_argument("--icon-dir", default=ICON_DIR)
    args = ap.parse_args()

    with open(args.csv, "r", encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    key_of = {r["relic_id"]: r["key"] for r in rows if r.get("relic_id")}

    with open(args.relics, "r", encoding="utf-8") as fh:
        relics = json.load(fh)

    changed, missing, already = [], [], 0
    for r in relics:
        rid = str(r.get("id"))
        cur = (r.get("icon") or "").strip()
        if cur.startswith("textures/"):
            already += 1
            continue
        key = key_of.get(rid)
        if not key:
            missing.append((rid, "prompts.csv 里没有这件遗物"))
            continue
        png = os.path.join(args.icon_dir, key + ".png")
        if not os.path.exists(png):
            missing.append((rid, f"本地没有 {key}.png"))
            continue
        changed.append((rid, r.get("name"), cur or "(空)", f"{PREFIX}/{key}"))
        r["icon"] = f"{PREFIX}/{key}"

    print(f"◆ relics.json 共 {len(relics)} 行")
    print(f"◆ icon 已是本地路径、不动：{already} 行")
    print(f"◆ 本次{'将' if args.dry_run else '已'}改：{len(changed)} 行")
    for rid, name, old, new in changed:
        src = "远程URL" if old.startswith("http") else old
        print(f"    id {rid:>5}  {name or '':<12} {src[:38]:<38} → {new}")
    if missing:
        print(f"◆ 没法改的 {len(missing)} 行（本轮不处理）：")
        for rid, why in missing:
            print(f"    id {rid:>5}：{why}")

    if args.dry_run:
        print("\n（--dry-run，没写盘）")
        return
    if not changed:
        print("\n◆ 没有要改的行（幂等，重复跑不会变）")
        return
    with open(args.relics, "w", encoding="utf-8") as fh:
        json.dump(relics, fh, ensure_ascii=False, indent=2)
    print(f"\n◆ 已写 {args.relics}")
    print("◆ 别忘了回灌 xlsx：cd tools/excel_export && node src/cli.ts json2excel --force --table relics")
    print("◆ 然后 npm run check && npm run verify")


if __name__ == "__main__":
    main()
