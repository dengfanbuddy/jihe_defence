#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
收尾：图集验收通过后，**退掉 307 张碎图**（以及已经被 plist 图集取代的 `auto-atlas.pac`）。

三道闸（任何一道不过就整体不执行，退出码 1）：
  1. `check-atlas.py` 必须全绿 —— 图集真的导入了、307 帧、外形字段与碎图逐字段一致；
  2. 全工程 `.prefab` / `.scene` / `.json` / `.anim` **没有**任何资源还引用碎图的 uuid
     （教训：删被 uuid 引用的资源而不改引用方，预制件会留悬空引用，编辑器里图标槽是空的）；
  3. 目标文件都得先**备份进 zip** 才允许删 —— 碎图是 `make-delivery.py` 的产物、
     没有 git 备份（新加的 14 张还是 untracked），删掉就只剩图集里那份像素了。

删完之后的**真源**变成 `relics.plist` + `relics.png`：
  · 想重新打图集 → 先从 zip 解回碎图，再跑 `build-atlas.py`；
  · 想换交付尺寸（640 原图还在）→ 重跑 `make-delivery.py --size N` 得到新碎图，再重打图集；
  · 想回退成碎图方案 → 解 zip，删 `relics.plist`/`relics.png`（`ShopRelicsItem` 本来就有按路径回落的旧路）。

用法:
    python tools/relic-icon-prompts/retire-loose-icons.py                 # 预演（只报告）
    python tools/relic-icon-prompts/retire-loose-icons.py --apply         # 真删
"""

import argparse
import glob
import io
import json
import os
import subprocess
import sys
import zipfile

sys.stdout.reconfigure(errors="replace")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RELICS = os.path.join(ROOT, "assets", "resources", "textures", "relics")
BACKUP = os.path.join(ROOT, "tools", "relic-icon-prompts", "backup-relic-icons-64.zip")


def run_check_atlas():
    checker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check-atlas.py")
    r = subprocess.run([sys.executable, checker], capture_output=True, text=True, encoding="utf-8",
                       errors="replace")
    tail = (r.stdout or "").strip().splitlines()
    print("    check-atlas.py 退出码 = %d" % r.returncode)
    for line in tail[-3:]:
        print("    | " + line)
    return r.returncode == 0


def loose_files():
    pngs, metas = [], []
    for p in sorted(glob.glob(os.path.join(RELICS, "*.png"))):
        if os.path.basename(p).startswith("relics."):
            continue
        pngs.append(p)
    for p in sorted(glob.glob(os.path.join(RELICS, "*.png.meta"))):
        if os.path.basename(p).startswith("relics."):
            continue
        metas.append(p)
    return pngs, metas


def loose_uuids(metas):
    out = {}
    for meta in metas:
        try:
            m = json.load(io.open(meta, encoding="utf-8"))
        except Exception:
            continue
        if m.get("uuid"):
            out[m["uuid"]] = os.path.basename(meta)[:-len(".png.meta")]
    return out


def scan_refs(uuids):
    """全工程找还有谁引用这些 uuid（排除碎图自己的 meta）"""
    hits = {}
    targets = []
    for pat in ("assets/**/*.prefab", "assets/**/*.scene", "assets/**/*.json", "assets/**/*.anim"):
        targets += glob.glob(os.path.join(ROOT, pat), recursive=True)
    for p in targets:
        if p.lower().startswith(RELICS.lower()):
            continue
        try:
            txt = io.open(p, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        for u, key in uuids.items():
            if u in txt:
                hits.setdefault(os.path.relpath(p, ROOT), []).append(key)
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真删（不给就只预演）")
    args = ap.parse_args()

    ok = True

    print("[闸 1] 图集验收")
    if not run_check_atlas():
        print("    !! 图集体检没过 —— 不执行（碎图是商店现在唯一的图源）")
        ok = False

    pngs, metas = loose_files()
    uuids = loose_uuids(metas)
    print("[信息] 碎图 %d 张 / meta %d 个 / uuid %d 个" % (len(pngs), len(metas), len(uuids)))
    if len(pngs) != len(uuids) or not pngs:
        print("    !! 碎图与 uuid 数量对不上，先查清楚")
        ok = False

    print("[闸 2] 引用方扫描（谁还在按 uuid 引用碎图）")
    hits = scan_refs(uuids)
    if hits:
        for p, keys in hits.items():
            print("    !! %s -> %s" % (p, keys))
        print("    !! 先把这些引用方改掉再删")
        ok = False
    else:
        print("    没有任何资源按 uuid 引用碎图 → 删除是安全的")

    print("[闸 3] 备份到 %s" % os.path.relpath(BACKUP, ROOT))

    if not args.apply:
        print("\n== 预演结束（加 --apply 才真删）==")
        return 0 if ok else 1

    if not ok:
        print("\n!! 有闸没过，拒绝执行")
        return 1

    os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
    with zipfile.ZipFile(BACKUP, "w", zipfile.ZIP_DEFLATED) as z:
        for p in pngs + metas:
            z.write(p, "relics/" + os.path.basename(p))
        pac = os.path.join(RELICS, "auto-atlas.pac")
        if os.path.exists(pac):
            z.write(pac, "relics/auto-atlas.pac")
    print("    已备份 %d 个文件 -> %s (%s)"
          % (len(pngs) + len(metas), os.path.relpath(BACKUP, ROOT),
             "{:,}B".format(os.path.getsize(BACKUP))))

    removed = 0
    for p in pngs + metas:
        os.remove(p)
        removed += 1
    print("    已删碎图 %d 个文件" % removed)

    for extra in ("auto-atlas.pac", "auto-atlas.pac.meta"):
        p = os.path.join(RELICS, extra)
        if os.path.exists(p):
            os.remove(p)
            print("    已删 %s（改用 plist 图集，不留两份）" % extra)

    left = [os.path.basename(p) for p in sorted(glob.glob(os.path.join(RELICS, "*")))]
    print("\n目录现在只剩: %s" % left)
    return 0


if __name__ == "__main__":
    sys.exit(main())
