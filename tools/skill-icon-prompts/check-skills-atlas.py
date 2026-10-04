#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
技能图集验收体检：`assets/resources/textures/skills/skills.plist`（+ 同名 png）对不对。

判据（任何一条不过 = 违规，退出码 1）
------------------------------------
[1] **结构契约** —— 与 `build-atlas.py` 的 `write_plist()` 以及一份**真导入过**的图集逐键对齐：
    顶层 `frames` + `metadata`；`metadata` 是那 6 个键（`format`=3 / `pixelFormat`="RGBA8888" /
    `premultiplyAlpha` 假 / `realTextureFileName` == `textureFileName` == "skills.png" / `size`）；
    每一帧**恰好 5 个键**（`spriteOffset` / `spriteSize` / `spriteSourceSize` / `textureRect` /
    `textureRotated`），前四个是字符串、最后一个是布尔。
[2] **帧集 == 配表** —— 复用 `build-skills-atlas.py` 的 `collect_frame_names()`（规则只留一份：
    `abilities.json` 里 `icon` 以 `textures/skills/` 开头的去重主干名）。缺帧 / 多帧 / 碎图没落地都算违规。
[3] **逐帧几何对账**（最重要的一条）—— 拿碎图算 alpha 包围盒（等价导入器的 `trimThreshold=1`），
    与 plist 逐字段对：
        spriteSize       == (包围盒宽, 包围盒高)
        spriteSourceSize == 碎图原始 (宽, 高)
        spriteOffset     == ((l+r)/2 - W/2, H/2 - (t+b)/2)     ← **y 向上**，这个符号不能翻
        textureRotated   == false
    碎图已退（`retire-loose-skill-icons.py` 跑过）时本段自动降级成「只查 textureRotated」，不误报。
[4] **图集大图逐帧像素对账**（`--no-pixels` 可跳过）—— 碎图裁出来的那一块，必须与 `skills.png` 里
    `textureRect` 那一块**逐像素相同**。防的是「plist 与 png 不同步」（重打了一半、或碎图改过没重打）。
[5] **textureRect 合法性** —— 每块都在 `metadata.size` 内、`textureRect` 的尺寸 == `spriteSize`、
    两两不重叠、间距满足打包时的 2 px；同时核对大图实际像素尺寸 == `metadata.size`。
[6] **编辑器导入状态**（信息，不计入判定）—— `skills.plist.meta` 有没有 `sprite-atlas` 与逐帧子资源。

⚠ **不要拿 `trimX`/`trimY` 去和碎图比**：碎图里它是「帧在那张小图里的坐标」，图集里是
「帧在**整张图集**里的坐标」（= `textureRect` 的原点）—— **本来就该不同**。
遗物那边第一版体检脚本拿这两个字段去比对，一次报了 614 处（= 307×2）——是判据错了不是数据错了。
这里只断言 `textureRect` 的原点（见 [5]），**不比对也不"修" trimX/trimY**。

用法:
    python tools/skill-icon-prompts/check-skills-atlas.py
    python tools/skill-icon-prompts/check-skills-atlas.py --limit 0        # 打全量清单
    python tools/skill-icon-prompts/check-skills-atlas.py --dir <其它目录>
"""

import argparse
import contextlib
import importlib.util
import io
import json
import os
import plistlib
import re
import sys

from PIL import Image, ImageChops

try:                                   # Windows 控制台是 GBK：中文打不出来就替换，别抛异常
    sys.stdout.reconfigure(errors="replace")
except Exception:                      # 被当模块 import、且调用方把 stdout 换成了 StringIO 时
    pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SKILLS_DIR = os.path.join(ROOT, "assets", "resources", "textures", "skills")
BUILD_TOOL = os.path.join(ROOT, "tools", "skill-icon-prompts", "build-skills-atlas.py")
ATLAS_TOOL = os.path.join(ROOT, "tools", "relic-icon-prompts", "build-atlas.py")
ABILITIES = os.path.join(ROOT, "assets", "resources", "tb", "abilities.json")

# 结构契约（照 write_plist 与真导入过的图集；不要自己加字段）
TOP_KEYS = ["frames", "metadata"]
FRAME_KEYS = ["spriteOffset", "spriteSize", "spriteSourceSize", "textureRect", "textureRotated"]
META_KEYS = ["format", "pixelFormat", "premultiplyAlpha", "realTextureFileName",
             "textureFileName", "size"]
STR_FIELDS = ["spriteOffset", "spriteSize", "spriteSourceSize", "textureRect"]
PAD_FALLBACK = 2          # 打包间距（真值从 build-atlas.py 的 PAD 读）
TOL = 1e-6
NUM = r"-?\d+(?:\.\d+)?"


class Report(object):
    """攒违规数 + 记录最大几何偏差。"""

    def __init__(self, limit):
        self.limit = limit
        self.bad = 0
        self.warn = 0
        self.worst = 0.0
        self.worst_at = ""

    def fail(self, text, ind=1):
        self.bad += 1
        print("    " + "  " * ind + "!! " + text)

    def soft(self, text, ind=1):
        self.warn += 1
        print("    " + "  " * ind + "~~ " + text)

    def note(self, text, ind=0):
        print("    " + "  " * ind + text)

    def dev(self, value, where):
        """记一个几何偏差的绝对值，用于汇总里的「最大偏差」。"""
        try:
            v = abs(float(value))
        except (TypeError, ValueError):
            return
        if v > self.worst:
            self.worst = v
            self.worst_at = where

    def cap(self, items):
        """按 --limit 截断清单，返回 (要打印的, 省掉几条)。0 = 全量。"""
        items = list(items)
        if self.limit and len(items) > self.limit:
            return items[:self.limit], len(items) - self.limit
        return items, 0


class CaptureOut(object):
    """给 `contextlib.redirect_stdout` 用的捕获流。

    为什么不用 `io.StringIO`：`build-skills-atlas.py` 在 **import 时**就调
    `sys.stdout.reconfigure(errors="replace")`，而 StringIO 没有 `reconfigure`
    → 直接 AttributeError（本脚本第一版就栽在这：一旦 stdout 被重定向，帧集就取不到）。
    """

    def __init__(self):
        self.buf = io.StringIO()

    def write(self, s):
        return self.buf.write(s)

    def flush(self):
        pass

    def reconfigure(self, **kwargs):        # no-op：重定向流没有编码可配
        pass

    def getvalue(self):
        return self.buf.getvalue()


def diff_bbox(diff):
    """差异图里「第一处不同」的包围盒。

    ⚠ **不要直接用 `diff.getbbox()`**：Pillow 对带 alpha 的图默认 `alpha_only=True`，
    只看 alpha 通道 —— 两个像素颜色不同但 alpha 相同时（RGB 改了、透明度没改）会返回 None，
    于是「图集大图被改过」这种真问题会被漏掉（本脚本第一版就漏了，被自测的 T8 抓住）。
    """
    try:
        box = diff.getbbox(alpha_only=False)
    except TypeError:                     # 老版本 Pillow 没有 alpha_only 参数
        box = diff.getbbox()
    if box is None:
        try:
            if any(mx for _mn, mx in diff.getextrema()):
                box = (0, 0, 1, 1)
        except Exception:
            pass
    return box


def num_eq(a, b):
    try:
        return abs(float(a) - float(b)) < TOL
    except (TypeError, ValueError):
        return a == b


def fmt_num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    if abs(f - round(f)) < 1e-9:
        return str(int(round(f)))
    return ("%.3f" % f).rstrip("0").rstrip(".")


def fmt_pair(v):
    if isinstance(v, (tuple, list)):
        return "(%s)" % ", ".join(fmt_num(x) for x in v)
    return fmt_num(v)


def parse_pair(v):
    m = re.match(r"^\{\s*(%s)\s*,\s*(%s)\s*\}$" % (NUM, NUM), str(v))
    return (float(m.group(1)), float(m.group(2))) if m else None


def parse_rect(v):
    m = re.match(r"^\{\{\s*(%s)\s*,\s*(%s)\s*\}\s*,\s*\{\s*(%s)\s*,\s*(%s)\s*\}\s*\}$"
                 % (NUM, NUM, NUM, NUM), str(v))
    return tuple(float(g) for g in m.groups()) if m else None


def load_module(path, name):
    """按路径加载（这几个脚本的文件名带连字符，普通 import 不行）。

    `exec_module` 也包在 `CaptureOut` 里：被加载的脚本在**模块级**就会调
    `sys.stdout.reconfigure(errors="replace")`，而调用方（或本脚本自身）此时可能正把 stdout
    重定向成普通 `io.StringIO` —— 那会 AttributeError（本脚本第一版就栽在这：
    一旦 stdout 被重定向，帧集就整段取不到）。
    """
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(CaptureOut()):
        spec.loader.exec_module(mod)
    return mod


def stem_of(frame_key):
    return frame_key[:-4] if str(frame_key).lower().endswith(".png") else str(frame_key)


def rect_gaps(a, b):
    """两块矩形 (x,y,w,h) 在两个轴上的间隙；负 = 该轴重叠，0 = 贴着。"""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    gap_x = max(bx - (ax + aw), ax - (bx + bw))
    gap_y = max(by - (ay + ah), ay - (by + bh))
    return (gap_x, gap_y)


def pair_gap(gap_x, gap_y):
    """两块矩形"挨得多近"（用于报告最小间距）：有轴分离就取分离轴，斜对角取小（保守）。"""
    if gap_x >= 0 and gap_y >= 0:
        return min(gap_x, gap_y)
    if gap_x >= 0:
        return gap_x
    if gap_y >= 0:
        return gap_y
    return max(gap_x, gap_y)


def print_summary(R, n_plist, n_expect, canvas, mode, extra=""):
    warn_txt = ("，另有 %d 条警告" % R.warn) if R.warn else ""
    print("")
    print("-" * 64)
    print("plist 帧数   : %d" % n_plist)
    print("配表应有帧数 : %s" % n_expect)
    print("画布尺寸     : %s" % canvas)
    if R.worst > TOL:
        print("最大几何偏差 : %s px（%s）" % (fmt_num(R.worst), R.worst_at or "?"))
    else:
        print("最大几何偏差 : 0（逐字段相等）")
    print("对账模式     : %s" % mode)
    print("违规         : %d 处%s" % (R.bad, warn_txt))
    if extra:
        print("附注         : %s" % extra)
    print("结论         : %s" % ("全部通过" if R.bad == 0 else "有 %d 处违规" % R.bad))
    print("-" * 64)


def main(argv=None):
    ap = argparse.ArgumentParser(description="技能图集（skills.plist + skills.png）验收体检")
    ap.add_argument("--dir", default=SKILLS_DIR, help="技能图标目录（图集与碎图都在这里）")
    ap.add_argument("--atlas-name", default="skills", help="图集名：skills -> skills.plist / skills.png")
    ap.add_argument("--limit", type=int, default=20, help="详细清单最多打印多少条（0 = 全量）")
    ap.add_argument("--no-pixels", action="store_true", help="跳过 [4] 图集大图的逐帧像素对账")
    args = ap.parse_args(argv)

    R = Report(args.limit)
    tex_name = args.atlas_name + ".png"
    plist_path = os.path.join(args.dir, args.atlas_name + ".plist")
    png_path = os.path.join(args.dir, args.atlas_name + ".png")
    meta_path = plist_path + ".meta"

    print("技能图集体检")
    print("  图集索引 : %s" % os.path.relpath(plist_path, ROOT))
    print("  图集大图 : %s" % os.path.relpath(png_path, ROOT))
    print("  碎图目录 : %s" % os.path.relpath(args.dir, ROOT))

    if not os.path.isfile(plist_path):
        print("")
        print("[X] 图集索引不存在 —— 图集还没生成（也可能是 --dir / --atlas-name 指错了）")
        print("    先生成（帧集由 assets/resources/tb/abilities.json 的 icon 列决定）：")
        print("      python tools/skill-icon-prompts/build-skills-atlas.py --apply")
        print("    再切回 Cocos Creator 窗口让它导入（编辑器不在前台时资源库不刷新）")
        print("")
        print("结论：未通过（图集缺失，退出码 1）")
        return 1

    try:
        with open(plist_path, "rb") as fh:
            data = plistlib.load(fh)
    except Exception as e:
        print("")
        print("[X] plist 解析失败：%s: %s" % (type(e).__name__, e))
        print("    文件可能被截断 / 不是 XML plist；重跑 build-skills-atlas.py --apply 再导入")
        print("")
        print("结论：未通过（plist 不可解析，退出码 1）")
        return 1

    atlas_pad = PAD_FALLBACK
    try:
        atlas_pad = int(load_module(ATLAS_TOOL, "relic_build_atlas").PAD)
    except Exception:
        pass

    if not isinstance(data, dict):
        R.fail("plist 顶层不是 dict，而是 %s" % type(data).__name__, ind=0)
        print_summary(R, 0, "?", "?", "未对账")
        return 1

    # ---------------------------------------------------------------- [1] 结构契约
    print("")
    print("[1] 结构契约（对着 build-atlas.py 的 write_plist 与真导入过的图集逐键）")
    for k in TOP_KEYS:
        if k not in data:
            R.fail("顶层缺键 `%s`" % k)
    for k in sorted(set(data) - set(TOP_KEYS)):
        R.soft("顶层多了一个键 `%s`（契约里只有 %s）" % (k, " / ".join(TOP_KEYS)))

    raw_frames = data.get("frames")
    if not isinstance(raw_frames, dict):
        R.fail("`frames` 不是 dict（实际 %s）" % type(raw_frames).__name__)
        raw_frames = {}
    if not raw_frames:
        R.fail("`frames` 里一帧都没有")

    frames = {}
    key_shape_bad, key_set_bad, type_bad = [], [], []
    for fname in sorted(raw_frames):
        stem = stem_of(fname)
        if not str(fname).lower().endswith(".png"):
            key_shape_bad.append(fname)
        rec = raw_frames[fname]
        if not isinstance(rec, dict):
            R.fail("帧 `%s` 的值不是 dict（实际 %s）" % (fname, type(rec).__name__))
            continue
        missing = [k for k in FRAME_KEYS if k not in rec]
        extra = [k for k in rec if k not in FRAME_KEYS]
        if missing:
            key_set_bad.append((fname, "缺 " + "/".join(missing)))
        if extra:
            key_set_bad.append((fname, "多 " + "/".join(sorted(extra))))
        for f in STR_FIELDS:
            if f in rec and not isinstance(rec[f], str):
                type_bad.append((fname, f, type(rec[f]).__name__))
        if "textureRotated" in rec and not isinstance(rec["textureRotated"], bool):
            type_bad.append((fname, "textureRotated", type(rec["textureRotated"]).__name__))

        rect = parse_rect(rec.get("textureRect"))
        size = parse_pair(rec.get("spriteSize"))
        src = parse_pair(rec.get("spriteSourceSize"))
        off = parse_pair(rec.get("spriteOffset"))
        for label, val in (("textureRect", rect), ("spriteSize", size),
                           ("spriteSourceSize", src), ("spriteOffset", off)):
            if val is None:
                R.fail("帧 `%s` 的 %s 解析不了：%r" % (fname, label, rec.get(label)))
        if None in (rect, size, src, off):
            continue
        # ⚠ 四个字段各存各的，**别混用**：`textureRect` 的 w/h 与 `spriteSize` 在正确图集里数值
        # 相同，所以「拿 rect 的 w/h 当 spriteSize 用」这种写法不会立刻露馅，却会让 [3] 漏检
        # （本脚本第一版就是这么写的：把 spriteSize 改成 {161,160} 竟然全绿）。
        frames[stem] = {"key": fname, "rect": rect, "size": size, "src": src, "off": off,
                        "rot": rec.get("textureRotated")}

    if key_shape_bad:
        shown, hidden = R.cap(key_shape_bad)
        R.fail("有 %d 个帧名不带 `.png` 后缀（TexturePacker format 3 一律带；导入后子资源名才去扩展名）"
               % len(key_shape_bad))
        for n in shown:
            R.note("`%s`" % n, ind=2)
        if hidden:
            R.note("…… 另 %d 个未打印（--limit 0 打全量）" % hidden, ind=2)
    if key_set_bad:
        shown, hidden = R.cap(key_set_bad)
        R.fail("有 %d 帧的键集不是那 5 个（每帧必须**恰好** %s）" % (len(key_set_bad), "/".join(FRAME_KEYS)))
        for n, why in shown:
            R.note("%s（%s）" % (n, why), ind=2)
        if hidden:
            R.note("…… 另 %d 帧未打印" % hidden, ind=2)
    if type_bad:
        shown, hidden = R.cap(type_bad)
        R.fail("有 %d 处值类型不对（前 4 个字段必须是字符串、textureRotated 必须是布尔）" % len(type_bad))
        for n, f, t in shown:
            R.note("%s 的 %s 是 %s" % (n, f, t), ind=2)
        if hidden:
            R.note("…… 另 %d 处未打印" % hidden, ind=2)

    meta = data.get("metadata")
    if not isinstance(meta, dict):
        R.fail("`metadata` 不是 dict（实际 %s）" % type(meta).__name__)
        meta = {}
    meta_size = None
    for k in META_KEYS:
        if k not in meta:
            R.fail("`metadata` 缺键 `%s`" % k)
    for k in sorted(set(meta) - set(META_KEYS)):
        R.soft("`metadata` 多了一个键 `%s`（write_plist 只写 %s）" % (k, " / ".join(META_KEYS)))
    if not (isinstance(meta.get("format"), int) and meta.get("format") == 3):
        R.fail("`metadata.format` 应为整数 3（TexturePacker 4.x 的 plist），实际 %r" % (meta.get("format"),))
    if meta.get("pixelFormat") != "RGBA8888":
        R.fail("`metadata.pixelFormat` 应为 \"RGBA8888\"，实际 %r" % (meta.get("pixelFormat"),))
    if meta.get("premultiplyAlpha"):
        R.fail("`metadata.premultiplyAlpha` 应为假，实际 %r（预乘会让透明边缘发黑）"
               % (meta.get("premultiplyAlpha"),))
    for k in ("realTextureFileName", "textureFileName"):
        if meta.get(k) != tex_name:
            R.fail("`metadata.%s` 应为 %r，实际 %r" % (k, tex_name, meta.get(k)))
    meta_size = parse_pair(meta.get("size"))
    if meta.get("size") is not None:
        if meta_size is None:
            R.fail("`metadata.size` 解析不了：%r" % (meta.get("size"),))
        elif meta_size[0] <= 0 or meta_size[1] <= 0:
            R.fail("`metadata.size` 不是正数：%s" % fmt_pair(meta_size))
    if R.bad == 0:
        R.note("顶层 2 键 / metadata %d 键 / 每帧恰好 %d 键 —— 全部对得上（%d 帧）"
               % (len(META_KEYS), len(FRAME_KEYS), len(frames)))

    # ---------------------------------------------------------------- [2] 帧集 == 配表
    print("")
    print("[2] 帧集 == 配表（%s 的 `icon` 列，规则复用 build-skills-atlas.py）"
          % os.path.relpath(ABILITIES, ROOT))
    expected, build_notes = [], ""
    if os.path.isfile(BUILD_TOOL):
        try:
            bmod = load_module(BUILD_TOOL, "skill_build_atlas")
            # 帧集规则只在 build-skills-atlas.py 里有一份：把"读哪张配表、去哪找碎图"指到本脚本的口径
            bmod.ABILITIES = ABILITIES
            bmod.SKILLS_DIR = args.dir
            buf = CaptureOut()
            with contextlib.redirect_stdout(buf):
                expected, _missing = bmod.collect_frame_names()
            build_notes = buf.getvalue().strip()
        except Exception as e:
            R.fail("加载 build-skills-atlas.py 的 collect_frame_names() 失败：%s: %s"
                   % (type(e).__name__, e))
    else:
        R.fail("找不到 %s —— 帧集规则拿不到" % os.path.relpath(BUILD_TOOL, ROOT))
    if build_notes:
        for line in build_notes.splitlines():
            R.note(line.strip(), ind=1)

    plist_stems = set(frames)
    expect_set = set(expected)
    missing_frames = sorted(expect_set - plist_stems)
    extra_frames = sorted(plist_stems - expect_set)
    if missing_frames:
        shown, hidden = R.cap(missing_frames)
        R.fail("图集缺 %d 帧（配表引用了但 plist 里没有）：%s" % (len(missing_frames), "、".join(shown)))
        if hidden:
            R.note("…… 另 %d 帧未打印" % hidden, ind=2)
    if extra_frames:
        shown, hidden = R.cap(extra_frames)
        R.fail("图集多 %d 帧（plist 里有但配表没引用）：%s" % (len(extra_frames), "、".join(shown)))
        if hidden:
            R.note("…… 另 %d 帧未打印" % hidden, ind=2)

    on_disk = [n for n in expected if os.path.isfile(os.path.join(args.dir, n + ".png"))]
    gone = [n for n in expected if n not in on_disk]
    if on_disk and gone:
        shown, hidden = R.cap(gone)
        R.fail("配表引用的 %d 张碎图不在磁盘上（--dir=%s）：%s"
               % (len(gone), os.path.relpath(args.dir, ROOT), "、".join(shown)))
        if hidden:
            R.note("…… 另 %d 张未打印" % hidden, ind=2)
    if not missing_frames and not extra_frames:
        R.note("plist %d 帧 == 配表 %d 个图标主干名，一一对应" % (len(plist_stems), len(expect_set)))
    R.note("碎图在盘 %d 张 / 配表 %d 个 / plist %d 帧" % (len(on_disk), len(expect_set), len(plist_stems)))

    # ---------------------------------------------------------------- [3] 逐帧几何对账
    print("")
    if on_disk:
        mode = "碎图逐帧对账（%d 张）" % len(on_disk)
        print("[3] 逐帧几何对账（碎图 alpha 包围盒 ↔ plist；等价导入器 trimThreshold=1）")
        printed = 0
        for name in on_disk:
            rec = frames.get(name)
            if rec is None:
                continue                      # 帧集问题已在 [2] 报过
            path = os.path.join(args.dir, name + ".png")
            try:
                im = Image.open(path)
                orig_mode = im.mode
                im = im.convert("RGBA")        # 与 build-atlas.py load_frames 同一口径
            except Exception as e:
                R.fail("%s 打不开：%s: %s" % (name + ".png", type(e).__name__, e))
                continue
            box = im.getchannel("A").getbbox()
            if box is None:
                R.fail("%s 整张全透明（没有可裁的内容；build-atlas.py 会跳过它）" % (name + ".png"))
                continue
            W, H = im.size
            l, t, r, b = box
            exp_size = (r - l, b - t)
            exp_src = (W, H)
            exp_off = ((l + r) / 2.0 - W / 2.0, H / 2.0 - (t + b) / 2.0)
            checks = [
                ("spriteSize", exp_size, tuple(rec["size"]), "包围盒 %s" % fmt_pair(box)),
                ("spriteSourceSize", exp_src, tuple(rec["src"]), "碎图原始尺寸"),
                ("spriteOffset", exp_off, tuple(rec["off"]), "y 向上"),
            ]
            bads = []
            for label, exp, act, note in checks:
                diffs = [float(act[i]) - float(exp[i]) for i in (0, 1)]
                if not (num_eq(exp[0], act[0]) and num_eq(exp[1], act[1])):
                    bads.append((label, exp, act, note))
                    R.dev(max(abs(diffs[0]), abs(diffs[1])), "%s.%s" % (name, label))
            if rec["rot"] is not False:
                bads.append(("textureRotated", False, rec["rot"], "本图集一律不旋转"))
                R.dev(1.0, "%s.textureRotated" % name)
            if bads:
                R.bad += len(bads)
                if printed < (R.limit or 10 ** 9):
                    print("    !! %s（碎图 %dx%d，%s）" % (name, W, H, orig_mode))
                    for label, exp, act, note in bads:
                        print("         %-17s 期望 %-16s 实际 %-16s（%s）"
                              % (label, fmt_pair(exp), fmt_pair(act), note))
                    printed += 1
        if printed and R.limit and R.bad > printed:
            R.note("（上面只打印了 %d 帧，--limit 0 打全量）" % printed, ind=1)
        if R.bad == 0:
            R.note("每帧的 spriteSize / spriteSourceSize / spriteOffset / textureRotated 全部对上"
                   "（%d 帧 × 4 项；offsetX=(l+r)/2-W/2、offsetY=H/2-(t+b)/2，y 向上）" % len(on_disk))
    else:
        mode = "碎图已退（几何对账降级为只查 textureRotated）"
        print("[3] 逐帧几何对账")
        R.note("碎图一张都不在了（retire-loose-skill-icons.py 跑过）→ 与碎图的对账无法再做；")
        R.note("本段降级为只查 textureRotated（仍逐帧，不误报）")
        rot_bad = [n for n, r in sorted(frames.items()) if r["rot"] is not False]
        if rot_bad:
            shown, hidden = R.cap(rot_bad)
            R.fail("有 %d 帧 textureRotated 不是 false：%s" % (len(rot_bad), "、".join(shown)))
            if hidden:
                R.note("…… 另 %d 帧未打印" % hidden, ind=2)
        else:
            R.note("全部 %d 帧 textureRotated == false" % len(frames))

    # ---------------------------------------------------------------- [4] 大图像素对账
    print("")
    print("[4] 图集大图逐帧像素对账（碎图裁出来的那一块 ↔ skills.png 里 textureRect 那一块）")
    sheet = None
    if args.no_pixels:
        R.note("--no-pixels：本段跳过（信息性检查，跳过不影响结论）")
    elif not on_disk:
        R.note("碎图已退 → 没有可比的源图，本段跳过（图集自身的合法性见 [5]）")
    elif not os.path.isfile(png_path):
        R.fail("图集大图不存在：%s（plist 在但 png 不在，图集是半成品）"
               % os.path.relpath(png_path, ROOT))
    else:
        try:
            sheet = Image.open(png_path).convert("RGBA")
        except Exception as e:
            R.fail("图集大图打不开：%s: %s" % (type(e).__name__, e))
    if sheet is not None and on_disk:
        mismatch = []
        for name in on_disk:
            rec = frames.get(name)
            if rec is None:
                continue
            try:
                im = Image.open(os.path.join(args.dir, name + ".png")).convert("RGBA")
            except Exception:
                continue
            box = im.getchannel("A").getbbox()
            if box is None:
                continue
            crop = im.crop(box)
            rx, ry, rw, rh = (int(v) for v in rec["rect"])
            rect = (rx, ry, rx + rw, ry + rh)
            if rect[2] > sheet.width or rect[3] > sheet.height or rect[0] < 0 or rect[1] < 0:
                mismatch.append((name, "textureRect 超出画布，没法比"))
                continue
            if crop.size != (rw, rh):
                mismatch.append((name, "碎图裁块 %dx%d 与 textureRect %dx%d 不符"
                                 % (crop.size[0], crop.size[1], rw, rh)))
                continue
            diff = ImageChops.difference(crop, sheet.crop(rect))
            dbox = diff_bbox(diff)
            if dbox is not None:
                n_px = sum(1 for px in diff.getdata() if px != (0, 0, 0, 0))
                mismatch.append((name, "有 %d 个像素不同（首处 %s）" % (n_px, fmt_pair(dbox))))
        if mismatch:
            shown, hidden = R.cap(mismatch)
            R.fail("%d 帧的像素与图集大图不一致 → plist 与 png 可能不同步（重打图集再导入）" % len(mismatch))
            for n, why in shown:
                R.note("%s：%s" % (n, why), ind=2)
            if hidden:
                R.note("…… 另 %d 帧未打印" % hidden, ind=2)
        else:
            R.note("%d 帧逐像素相同（碎图裁块 == 大图对应块，RGBA 全等）" % len(on_disk))

    if sheet is not None and meta_size:
        if (sheet.width, sheet.height) != (int(meta_size[0]), int(meta_size[1])):
            R.fail("图集大图实际 %dx%d 与 metadata.size %s 不符"
                   % (sheet.width, sheet.height, fmt_pair(meta_size)))

    # ---------------------------------------------------------------- [5] textureRect 合法性
    print("")
    canvas = meta_size if meta_size else None
    canvas_txt = "%sx%s" % (fmt_num(canvas[0]), fmt_num(canvas[1])) if canvas else "?"
    print("[5] textureRect 合法性（越界 / 重叠 / 间距 >= %d px）" % atlas_pad)
    if canvas is None:
        R.fail("没有可用的 metadata.size，本段无法判定")
    else:
        CW, CH = int(canvas[0]), int(canvas[1])
        out_of_canvas, size_mismatch = [], []
        for name, r in sorted(frames.items()):
            rx, ry, rw, rh = r["rect"]
            if rx < 0 or ry < 0 or rx + rw > CW or ry + rh > CH:
                out_of_canvas.append((name, (rx, ry, rw, rh)))
            # textureRect 的尺寸必须等于 spriteSize（不旋转的图集里两者恒等）
            if not (num_eq(rw, r["size"][0]) and num_eq(rh, r["size"][1])):
                size_mismatch.append((name, (rx, ry, rw, rh), tuple(r["size"])))
        if out_of_canvas:
            shown, hidden = R.cap(out_of_canvas)
            R.fail("有 %d 帧的 textureRect 超出画布 %dx%d" % (len(out_of_canvas), CW, CH))
            for n, rect in shown:
                R.note("%s textureRect={{%s,%s},{%s,%s}}"
                       % (n, fmt_num(rect[0]), fmt_num(rect[1]), fmt_num(rect[2]), fmt_num(rect[3])), ind=2)
            if hidden:
                R.note("…… 另 %d 帧未打印" % hidden, ind=2)
        else:
            R.note("全部 %d 帧都在画布 %dx%d 内" % (len(frames), CW, CH))
        if size_mismatch:
            shown, hidden = R.cap(size_mismatch)
            R.fail("有 %d 帧的 textureRect 尺寸与 spriteSize 不一致（不旋转的图集里两者必须相等）"
                   % len(size_mismatch))
            for n, rect, size in shown:
                R.note("%s textureRect %sx%s vs spriteSize %s" % (n, fmt_num(rect[2]), fmt_num(rect[3]),
                                                                   fmt_pair(size)), ind=2)
            if hidden:
                R.note("…… 另 %d 帧未打印" % hidden, ind=2)

        names = sorted(frames)
        overlaps, violations, min_gap, min_gap_at = [], [], None, ""
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                a, b = frames[names[i]], frames[names[j]]
                ra, rb = tuple(a["rect"]), tuple(b["rect"])
                gx, gy = rect_gaps(ra, rb)
                if gx < 0 and gy < 0:
                    overlaps.append((names[i], names[j], (ra, rb)))
                # 打过 padding 的框两两不相交 → 两个轴的间隙里**至少有一个** >= 间距
                elif max(gx, gy) < atlas_pad:
                    violations.append((names[i], names[j], gx, gy))
                g = pair_gap(gx, gy)
                if min_gap is None or g < min_gap:
                    min_gap, min_gap_at = g, "%s ↔ %s" % (names[i], names[j])
        if overlaps:
            shown, hidden = R.cap(overlaps)
            R.fail("有 %d 对帧的 textureRect 互相重叠" % len(overlaps))
            for n1, n2, rects in shown:
                R.note("%s ↔ %s" % (n1, n2), ind=2)
            if hidden:
                R.note("…… 另 %d 对未打印" % hidden, ind=2)
        else:
            R.note("两两不重叠（%d 帧 %d 对，全查过）" % (len(names), len(names) * (len(names) - 1) // 2))
        if violations:
            shown, hidden = R.cap(violations)
            R.fail("有 %d 对帧的间距小于 %d px" % (len(violations), atlas_pad))
            for n1, n2, gx, gy in shown:
                R.note("%s ↔ %s：x 轴间隙 %s、y 轴间隙 %s"
                       % (n1, n2, fmt_num(gx), fmt_num(gy)), ind=2)
            if hidden:
                R.note("…… 另 %d 对未打印" % hidden, ind=2)
        else:
            R.note("相邻帧间距满足 >= %d px（判定口径：两轴间隙里至少一个 >= %d；"
                   "贴着但不重叠、且间隙够大不算违规）" % (atlas_pad, atlas_pad))
        if min_gap is not None:
            R.note("观测到的最小间距 = %s px（%s；斜对角按两轴取小，属保守口径）"
                   % (fmt_num(min_gap), min_gap_at))
        # textureRect 的原点就是「帧在图集里的坐标」——导入后就是该帧子资源的 trimX/trimY。
        # 碎图的 trimX/trimY 是「帧在那张小图里的坐标」，两者**本来就该不同**，这里不比对、也不"修"。
        R.note("备注：trimX/trimY 只在图集内部自洽（= textureRect 原点），不与碎图比对")

    # ---------------------------------------------------------------- [6] 编辑器导入状态
    print("")
    print("[6] 编辑器导入状态")
    R.note("判据：`.meta` **不存在** = 信息（还没导入，由 retire 脚本的闸 1 卡）；")
    R.note("      `.meta` **存在但对不上当前 plist** = **违规**（导入过，但数据已过期）")
    if not os.path.isfile(meta_path):
        R.note("没有 %s —— 编辑器还没导入这张图集" % os.path.relpath(meta_path, ROOT))
        R.note("切回 Cocos Creator 窗口（或按 Assets 面板刷新）才会生成；编辑器不在前台时资源库不刷新")
    else:
        try:
            with io.open(meta_path, "r", encoding="utf-8") as fh:
                am = json.load(fh)
        except Exception as e:
            am = None
            R.bad("第 6 组", "%s 读不了：%s: %s" % (os.path.relpath(meta_path, ROOT), type(e).__name__, e))
        if isinstance(am, dict):
            ud = am.get("userData") or {}
            subs = am.get("subMetas") or {}
            sub_names = set()
            for sub in subs.values():
                if sub.get("name"):
                    sub_names.add(sub["name"])
            R.note("importer=%s imported=%s format=%s atlasTextureName=%s"
                   % (am.get("importer"), am.get("imported"), ud.get("format"),
                      ud.get("atlasTextureName")))
            R.note("子资源 %d 个（sprite-frame %d），plist 帧 %d 个，帧名覆盖 %s"
                   % (len(subs), sum(1 for s in subs.values() if s.get("importer") == "sprite-frame"),
                      len(frames),
                      "齐全" if sub_names >= set(frames) else "不全：缺 %s"
                      % "、".join(sorted(set(frames) - sub_names)[:5])))

            # ---- 关键：`.meta` 里的逐帧裁剪数据必须与**当前** plist 一致 ----
            #
            # 为什么必须有这一条（2026-10 真踩过）：改过交付尺寸（200 → 64）之后重打了图集，
            # 但 `.meta` 还是上一次导入留下的**旧 200×200 / 648×1620** 的裁剪数据
            # （width/height 160、rawWidth/rawHeight 200、trimX 486、trimY 1134）。
            # 只看「有没有 .meta + 帧名齐不齐」是**看不出来**的 —— 结构完全合法，
            # 于是 retire 的闸 1 会放行，而图集帧在编辑器重导入之前是按旧数据描述的
            # （槽位里的大小/位置全错）。所以这里按帧逐个对账。
            stale = []
            for name in sorted(frames):
                sub = next((s for s in subs.values() if s.get("name") == name), None)
                if sub is None:
                    continue
                sud = sub.get("userData") or {}
                rec = frames[name]
                rect = rec["rect"]          # (x, y, w, h) —— 图集内的坐标
                src = rec["src"]            # (w, h) —— 碎图原始尺寸
                want = {
                    "width": int(round(rect[2])),
                    "height": int(round(rect[3])),
                    "rawWidth": int(round(src[0])),
                    "rawHeight": int(round(src[1])),
                    "trimX": int(round(rect[0])),
                    "trimY": int(round(rect[1])),
                }
                diff = {k: (sud.get(k), v) for k, v in want.items() if sud.get(k) != v}
                if diff:
                    stale.append((name, diff))
            if stale:
                name, diff = stale[0]
                detail = "、".join("%s 实际=%s 应为=%s" % (k, a, b) for k, (a, b) in list(diff.items())[:4])
                R.fail("`.meta` 与当前 plist **对不上（导入数据已过期）**：共 %d 帧不一致，"
                       "首个 `%s`（%s）→ 说明图集在上次导入**之后**被重打过（改了交付尺寸或换了帧集）。"
                       "切回 Cocos Creator 窗口让它重新导入即可自愈；在自愈之前**不要**退碎图。"
                       % (len(stale), name, detail))
            else:
                R.note("`.meta` 的逐帧裁剪数据与当前 plist **逐字段一致**（%d 帧）" % len(frames))

    mode_txt = mode
    print_summary(R, len(frames), len(expect_set) if expected else "?", canvas_txt, mode_txt)
    return 0 if R.bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
