#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
图集验收体检：确认 `relics.plist` + `relics.png` 这张**图集资源**真的导入成功、且帧数据没跑偏。

两种模式（自动判断，不用传参）
--------------------------------
· **换图集前（碎图还在）**：与碎图逐字段对账 —— 这是最强的一道闸。
  换图集最大的风险不是"导不进去"，而是"导进去了但每张图的裁剪数据变了"：
  `RelicItem.content/head/inner` 是 `sizeMode=CUSTOM(50×50)` + `trim=true`，
  帧的 width/height/rawWidth/rawHeight/offsetX/offsetY 一变，**图标在槽位里的大小与位置就变**。
  所以判据不是"能加载"，而是这些字段与原碎图**逐字段相等**。
· **换图集后（碎图已退，`retire-loose-icons.py` 跑过）**：改为**与 plist 自洽对账** ——
  每个子资源的 width/height/rawWidth/rawHeight/offsetX/offsetY/trimX/trimY
  必须与 plist 里那一帧的 spriteSize/spriteSourceSize/spriteOffset/textureRect 完全对应。

⚠ **`trimX`/`trimY` 永远不要拿去和碎图比**：碎图里它是"帧在那张小图里的坐标"，
图集里它是"帧在**整张图集**里的坐标"（= `textureRect` 原点）—— 本来就该不同。
第一版脚本就是栽在这，一次报 614 处（= 307×2，恰好只有这两个字段）：**是指标错了，不是数据错了**。

用法:
    python tools/relic-icon-prompts/check-atlas.py
    python tools/relic-icon-prompts/check-atlas.py --atlas-name relics --size 64
"""

import argparse
import glob
import io
import json
import os
import plistlib
import re
import sys

sys.stdout.reconfigure(errors="replace")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RELICS = os.path.join(ROOT, "assets", "resources", "textures", "relics")
LIBRARY = os.path.join(ROOT, "library")

# 决定"图标长什么样"的字段（大小 / 原始尺寸 / 居中偏移）—— 必须与碎图逐字段相等
FIELDS_LOOK = ["width", "height", "rawWidth", "rawHeight", "offsetX", "offsetY"]


def read_meta(path):
    with io.open(path, encoding="utf-8") as fh:
        return json.load(fh)


def read_plist_frames(folder, name):
    """plist → {帧名: {x,y,w,h,sw,sh,ox,oy}}"""
    path = os.path.join(folder, name + ".plist")
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, "rb") as fh:
        data = plistlib.load(fh)

    def pair(s):
        m = re.match(r"\{(-?[\d.]+),(-?[\d.]+)\}", str(s))
        return (float(m.group(1)), float(m.group(2))) if m else None

    def size(s):
        m = re.match(r"\{(-?[\d.]+),(-?[\d.]+)\}", str(s))
        return (float(m.group(1)), float(m.group(2))) if m else None

    def rect(s):
        m = re.match(r"\{\{(-?[\d.]+),(-?[\d.]+)\},\{(-?[\d.]+),(-?[\d.]+)\}\}", str(s))
        return tuple(float(g) for g in m.groups()) if m else None

    for fname, f in (data.get("frames") or {}).items():
        key = fname[:-4] if fname.lower().endswith(".png") else fname
        r = rect(f.get("textureRect"))
        sz = size(f.get("spriteSize"))
        ss = size(f.get("spriteSourceSize"))
        off = pair(f.get("spriteOffset"))
        if not (r and sz and ss and off):
            continue
        out[key] = {"x": r[0], "y": r[1], "w": sz[0], "h": sz[1],
                    "sw": ss[0], "sh": ss[1], "ox": off[0], "oy": off[1]}
    return out


def loose_frames(folder, size):
    """碎图 → {key: userData}（只取该尺寸的那批；图集本身排除掉）"""
    out = {}
    for meta in sorted(glob.glob(os.path.join(folder, "*.png.meta"))):
        base = os.path.basename(meta)
        if base.startswith("relics."):
            continue
        try:
            m = read_meta(meta)
        except Exception:
            continue
        for sub in (m.get("subMetas") or {}).values():
            if sub.get("importer") == "sprite-frame" and sub.get("userData"):
                ud = sub["userData"]
                if ud.get("rawWidth") == size and ud.get("rawHeight") == size:
                    out[base[:-len(".png.meta")]] = ud
    return out


def num_eq(a, b):
    try:
        return abs(float(a) - float(b)) < 1e-6
    except (TypeError, ValueError):
        return a == b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=RELICS)
    ap.add_argument("--atlas-name", default="relics")
    ap.add_argument("--size", type=int, default=64)
    args = ap.parse_args()

    ok = True
    atlas_meta_path = os.path.join(args.dir, args.atlas_name + ".plist.meta")

    # 1) 图集 meta
    if not os.path.exists(atlas_meta_path):
        print("[X] 没有 %s —— 编辑器还没导入这张图集" % os.path.relpath(atlas_meta_path, ROOT))
        return 1
    am = read_meta(atlas_meta_path)
    print("[1] importer=%s imported=%s uuid=%s"
          % (am.get("importer"), am.get("imported"), am.get("uuid")))
    if am.get("importer") != "sprite-atlas":
        print("    !! importer 应该是 sprite-atlas（plist 图集），现在不是")
        ok = False
    if not am.get("imported"):
        print("    !! imported 不是 true（导入没成功）")
        ok = False

    # 2) userData
    ud = am.get("userData") or {}
    print("[2] format=%s atlasTextureName=%s textureUuid=%s"
          % (ud.get("format"), ud.get("atlasTextureName"), ud.get("textureUuid")))
    if ud.get("format") != 3:
        print("    !! format 应为 3（TexturePacker 4.x 的 plist）")
        ok = False
    if ud.get("atlasTextureName") != args.atlas_name + ".png":
        print("    !! atlasTextureName 应指向 %s.png" % args.atlas_name)
        ok = False

    subs = am.get("subMetas") or {}
    by_name = {}
    for sub in subs.values():
        if sub.get("name"):
            by_name[sub["name"]] = sub.get("userData") or {}
    pf = read_plist_frames(args.dir, args.atlas_name)

    # 3) 帧数：子资源 vs plist（永远能查）
    print("[3] 图集子资源=%d  plist 帧=%d" % (len(by_name), len(pf)))
    if not subs or not pf:
        print("    !! 图集里一帧都没有（plist 的 frames 没被解析出来）")
        ok = False
    elif set(by_name) != set(pf):
        only_sub = sorted(set(by_name) - set(pf))[:5]
        only_pl = sorted(set(pf) - set(by_name))[:5]
        print("    !! 子资源与 plist 的帧名对不上：只在子资源=%s 只在 plist=%s" % (only_sub, only_pl))
        ok = False

    # 4) 与 plist 自洽（永远能查）：每个子资源必须与 plist 那一帧完全对应
    bad = []
    for key, p in pf.items():
        g = by_name.get(key)
        if g is None:
            continue
        pairs = [("trimX", p["x"]), ("trimY", p["y"]), ("width", p["w"]), ("height", p["h"]),
                 ("rawWidth", p["sw"]), ("rawHeight", p["sh"]),
                 ("offsetX", p["ox"]), ("offsetY", p["oy"])]
        for f, want in pairs:
            if not num_eq(g.get(f), want):
                bad.append((key, f, want, g.get(f)))
    if bad:
        print("[4] !! 子资源与 plist 不一致 %d 处（前 10）：" % len(bad))
        for key, f, want, got in bad[:10]:
            print("       %-24s %-12s plist=%-8s 子资源=%s" % (key, f, want, got))
        ok = False
    else:
        print("[4] 每个子资源与 plist 那一帧逐字段对应（%d 帧 × 8 字段："
              "trimX/trimY/width/height/rawWidth/rawHeight/offsetX/offsetY）" % len(pf))

    # 5) 如果碎图还在 → 额外做"与碎图逐字段对账"（最强的一道闸）
    loose = loose_frames(args.dir, args.size)
    if loose:
        print("[5] 碎图还在（%d 张）→ 追加与碎图逐字段对账" % len(loose))
        missing = sorted(n for n in loose if n not in by_name)
        if missing:
            print("    !! 图集缺少 %d 张碎图的帧：%s%s"
                  % (len(missing), missing[:5], " ..." if len(missing) > 5 else ""))
            ok = False
        diff = []
        for key, old in loose.items():
            new = by_name.get(key)
            if new is None:
                continue
            for f in FIELDS_LOOK:
                if not num_eq(old.get(f), new.get(f)):
                    diff.append((key, f, old.get(f), new.get(f)))
        if diff:
            print("    !! 决定外形的字段不一致 %d 处（前 10 条）：" % len(diff))
            for key, f, a, b in diff[:10]:
                print("       %-24s %-12s 碎图=%-8s 图集=%s" % (key, f, a, b))
            ok = False
        else:
            print("    外形字段逐字段一致（%d × %d）→ 图标大小与居中偏移与碎图完全相同"
                  % (len(loose), len(FIELDS_LOOK)))
    else:
        print("[5] 碎图已退（`retire-loose-icons.py` 跑过）→ 与碎图的对账无法再做，"
              "以 [4] 的 plist 自洽为准")

    # 6) library 产物
    uid = am.get("uuid")
    lib_hit = []
    if uid and os.path.isdir(os.path.join(LIBRARY, uid[:2])):
        d = os.path.join(LIBRARY, uid[:2])
        lib_hit = [n for n in os.listdir(d) if n.startswith(uid)]
    print("[6] library 导入产物: %d 个（图集 json + %d 帧子资源%s）"
          % (len(lib_hit), max(0, len(lib_hit) - 1),
             "，含贴图" if any(n.endswith(".png") for n in lib_hit) else ""))
    if not lib_hit:
        print("    !! library 里没有该 uuid 的产物 —— 编辑器可能没真正导入")
        ok = False

    print("")
    print("结论：%s" % ("全部通过" if ok else "有项目没通过"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
