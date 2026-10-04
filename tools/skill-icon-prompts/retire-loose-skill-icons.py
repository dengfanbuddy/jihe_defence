#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
收尾：技能图集体检通过后，退掉 `assets/resources/textures/skills/` 里**已被图集覆盖**的技能碎图。

结构照 `tools/relic-icon-prompts/retire-loose-icons.py`（同样的安全姿态：缺省只预演、
闸不过就整体不执行、删前先备份），差别是**第一道闸换成了「图集真的被编辑器导入过」**。

四道闸（任何一道不过就整体不执行，退出码 1）
------------------------------------------
闸 1 **图集真的被 Cocos Creator 编辑器导入过** —— `skills.plist.meta` 存在、`importer == "sprite-atlas"`、
     `imported == true`、`userData.format == 3`，且 `subMetas` 里**每一帧**都有对应子资源
     （子资源 `name` == 帧主干名，即帧名去掉 `.png`，与真导入过的 `relics.plist.meta` 一致）。
     ⚠ **这一道是整件事的重点**：没有它，删掉碎图之后运行时既取不到图集帧、也取不到碎图 → 图标全空。
     编辑器不在前台时资源库不刷新（`.meta` 不会生成，本项目实测过）→ 切回 Cocos 窗口或按一下
     Assets 面板刷新，再跑本脚本。**没有绕过开关**（没有 --force 之类的口子）：闸不过就是不删。
闸 2 **`check-skills-atlas.py` 必须退出码 0**（结构契约 / 帧集 == 配表 / 逐帧几何 / 像素 / rect 合法性）。
闸 3 **引用方扫描（附加闸，来自 retire-loose-icons.py 的第 2 道闸）** —— 全工程 `.prefab` / `.scene` /
     `.json` / `.anim` 里没有资源还按 uuid 引用待删的碎图（删了会让预制件留悬空引用）。
闸 4 **删前先备份** 到 `tools/skill-icon-prompts/backup-skill-icons.zip` 并核对条目数（已存在就覆盖）。
     （编号说明：用户口径的三道闸 = 导入 / 体检 / 备份，附加的引用扫描占了闸 3 的编号，备份顺延为闸 4。）

**绝不删**（报告里会明说）：
    `bullet.png`         —— `SkillSlot.ts` / `ShopRelicsItem.ts` 的 `PLACEHOLDER_ICON` 回落占位图
    `baotou.png`         —— 既有遗留资源（128×128，无人引用，不在本次范围）
    `huoqiang.png`       —— 既有遗留资源（128×128，无人引用；**注意别和 `huoqiang_skill.png` 混了**）
    `魔棒·去背景.png`     —— 既有遗留资源（不在本次范围）

只删**同时**满足两条的 `<主干名>.png`：① 主干名是图集里的一帧；② `abilities.json` 的 `icon` 列引用了它。
连同它的 `<主干名>.png.meta` 一起删（与碎图同生共死，留一个孤儿 `.meta` 没意义）。

回滚（一条命令；zip 里的条目是**扁平**的 basename，直接解进技能目录即可）：
    Expand-Archive -Force tools/skill-icon-prompts/backup-skill-icons.zip assets/resources/textures/skills

用法:
    python tools/skill-icon-prompts/retire-loose-skill-icons.py            # 预演（缺省，只报告）
    python tools/skill-icon-prompts/retire-loose-skill-icons.py --apply    # 真删
"""

import argparse
import contextlib
import glob
import importlib.util
import io
import json
import os
import plistlib
import subprocess
import sys
import zipfile

try:                                   # Windows 控制台是 GBK：中文打不出来就替换，别抛异常
    sys.stdout.reconfigure(errors="replace")
except Exception:                      # 被当模块 import、且调用方把 stdout 换成了 StringIO 时
    pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SKILLS_DIR = os.path.join(ROOT, "assets", "resources", "textures", "skills")
BUILD_TOOL = os.path.join(ROOT, "tools", "skill-icon-prompts", "build-skills-atlas.py")
CHECK_TOOL = os.path.join(ROOT, "tools", "skill-icon-prompts", "check-skills-atlas.py")
ABILITIES = os.path.join(ROOT, "assets", "resources", "tb", "abilities.json")
BACKUP = os.path.join(ROOT, "tools", "skill-icon-prompts", "backup-skill-icons.zip")
ATLAS_NAME = "skills"

# 永不删（精确文件名，**不要**用前缀匹配 —— `huoqiang` 是 `huoqiang_skill` 的前缀）
#
# ⚠⚠ **`why` 里的「无人引用」不能凭印象写 —— 2026-10 真栽过**：
#   这张名单原本写着 `baotou.png` / `huoqiang.png` 是「无人引用」的遗留资源，
#   于是它们被当成可清理的垃圾从目录里去掉了 —— 而事实是**两者各被
#   `Scene_Menu.prefab` 按 uuid 引用 5 次**（`cc.Sprite._spriteFrame`，选人卡的英雄槽占位图）。
#   删掉之后预制件留下 **10 处悬空引用**，编辑器里图标槽会变空。
#   所以现在**每次运行都会现场扫一遍引用数**（见 `report_keep_list`），
#   写着「无人引用」却扫出引用 = **闸不过、拒绝执行**，杜绝这类"文档腐烂型"误删。
NEVER_DELETE = {
    "bullet.png": "代码级回落占位图（SkillSlot.ts / ShopRelicsItem.ts 的 PLACEHOLDER_ICON）",
    "baotou.png": "被 Scene_Menu.prefab 按 uuid 引用（英雄槽占位图）；改名/替换前先改预制件",
    "huoqiang.png": "被 Scene_Menu.prefab 按 uuid 引用（英雄槽占位图）；改名/替换前先改预制件",
    "魔棒·去背景.png": "无人引用（1920×1920 / 610KB 的抠图试稿）—— 真要清它请单独确认，不在本脚本范围内",
}
# 上面 `why` 里出现这些词就表示"声称没有任何引用"，本脚本会现场核对（对不上就是闸不过）
NO_REF_CLAIM = "无人引用"


class CaptureOut(object):
    """给 `contextlib.redirect_stdout` 用的捕获流（StringIO 没有 `reconfigure`，
    而 `build-skills-atlas.py` 在 import 时就会调 `sys.stdout.reconfigure(...)` → 会炸）。"""

    def __init__(self):
        self.buf = io.StringIO()

    def write(self, s):
        return self.buf.write(s)

    def flush(self):
        pass

    def reconfigure(self, **kwargs):
        pass

    def getvalue(self):
        return self.buf.getvalue()


def load_module(path, name):
    """按路径加载（这几个脚本的文件名带连字符，普通 import 不行）。

    `exec_module` 包在 `CaptureOut` 里：被加载的脚本在**模块级**就会调
    `sys.stdout.reconfigure(errors="replace")`，而调用方此时可能正把 stdout 重定向成普通
    `io.StringIO`（例如自测脚本）—— 那会 AttributeError。
    """
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(CaptureOut()):
        spec.loader.exec_module(mod)
    return mod


def read_plist_frames(plist_path):
    """plist → 帧主干名集合（`.png` 后缀去掉）。"""
    with open(plist_path, "rb") as fh:
        data = plistlib.load(fh)
    frames = data.get("frames") or {}
    return set(k[:-4] if str(k).lower().endswith(".png") else str(k) for k in frames)


def config_frames():
    """配表（abilities.json 的 icon 列）引用的帧主干名 —— 规则只在 build-skills-atlas.py 里有一份。"""
    mod = load_module(BUILD_TOOL, "skill_build_atlas")
    # 帧集规则只在 build-skills-atlas.py 里有一份：把"读哪张配表、去哪找碎图"指到本脚本的口径
    mod.ABILITIES = ABILITIES
    mod.SKILLS_DIR = SKILLS_DIR
    buf = CaptureOut()
    with contextlib.redirect_stdout(buf):
        names, missing = mod.collect_frame_names()
    return names, missing, buf.getvalue().strip()


def gate1_editor_imported(frame_names):
    """闸 1：编辑器真的导入过这张图集（.meta 有 importer=sprite-atlas 且逐帧子资源齐全）。"""
    plist_path = os.path.join(SKILLS_DIR, ATLAS_NAME + ".plist")
    meta_path = plist_path + ".meta"
    print("[闸 1] 图集是否已被 Cocos Creator 编辑器真正导入")
    print("    读 %s" % os.path.relpath(meta_path, ROOT))

    if not os.path.isfile(meta_path):
        print("    !! .meta 不存在 —— 编辑器还没导入这张图集，**拒绝执行**")
        print("       · 新加的 skills.plist / skills.png 只有**切回 Cocos Creator 窗口**")
        print("         （或按一下 Assets 面板的刷新）才会被导入并生成 .meta 与 library 产物；")
        print("         编辑器不在前台时资源库不刷新（本项目实测过：library/ 无写入、.meta 不生成）。")
        print("       · 导入成功后重跑本脚本；在那之前**一张碎图都不会删** ——")
        print("         否则会出现「图集没有帧、碎图也被删了」的空图标。")
        print("       · 本闸没有绕过开关：这是整件事的重点，不给 --force 之类的口子。")
        return False

    try:
        with io.open(meta_path, "r", encoding="utf-8") as fh:
            am = json.load(fh)
    except Exception as e:
        print("    !! .meta 读不了：%s: %s" % (type(e).__name__, e))
        return False

    ud = am.get("userData") or {}
    subs = am.get("subMetas") or {}
    sub_names = set(s.get("name") for s in subs.values() if s.get("name"))
    print("    importer=%s imported=%s format=%s atlasTextureName=%s"
          % (am.get("importer"), am.get("imported"), ud.get("format"), ud.get("atlasTextureName")))
    print("    子资源 %d 个 / plist 帧 %d 个" % (len(subs), len(frame_names)))

    bad = []
    if am.get("importer") != "sprite-atlas":
        bad.append("importer 应为 \"sprite-atlas\"，实际 %r" % (am.get("importer"),))
    if am.get("imported") is not True:
        bad.append("imported 应为 true（导入没成功），实际 %r" % (am.get("imported"),))
    if ud.get("format") != 3:
        bad.append("userData.format 应为 3，实际 %r" % (ud.get("format"),))
    missing = sorted(frame_names - sub_names)
    if missing:
        bad.append("有 %d 帧在 subMetas 里找不到对应子资源（子资源 name 应等于帧主干名）：%s%s"
                   % (len(missing), "、".join(missing[:5]), " …" if len(missing) > 5 else ""))
    if bad:
        for b in bad:
            print("    !! " + b)
        print("    !! 闸 1 没过 —— 编辑器还没把这 40 帧全导进来，**拒绝执行**")
        print("       切回 Cocos Creator 窗口 / 按一下 Assets 面板刷新，等导入完成再跑；")
        print("       若长时间不刷新，检查 Console 里这张 plist 有没有导入报错。")
        return False

    print("    OK：sprite-atlas 已导入，%d 帧逐帧都有子资源" % len(frame_names))
    return True


def gate2_check_atlas():
    """闸 2：check-skills-atlas.py 退出码 0。"""
    print("[闸 2] 图集体检 %s" % os.path.relpath(CHECK_TOOL, ROOT))
    if not os.path.isfile(CHECK_TOOL):
        print("    !! 找不到体检脚本，拒绝执行")
        return False
    try:
        r = subprocess.run([sys.executable, CHECK_TOOL, "--dir", SKILLS_DIR],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
    except Exception as e:
        print("    !! 跑不起来：%s: %s" % (type(e).__name__, e))
        return False
    lines = (r.stdout or "").strip().splitlines()
    print("    退出码 = %d" % r.returncode)
    for line in lines[-8:]:
        print("    | " + line)
    if r.returncode != 0:
        err = (r.stderr or "").strip().splitlines()
        if err:
            print("    | stderr: " + err[-1])
        print("    !! 体检没过（细节直接跑上面那条命令看全量清单）—— 拒绝执行")
        return False
    return True


def scan_uuid_refs(pngs):
    """
    扫全工程，返回 `{相对路径: [png 名, ...]}` —— 谁还按 uuid 引用这些 png（经 .meta）。

    抽成独立函数是因为**两个地方都要用**：
      · 闸 3（待删碎图**不许**有引用）；
      · 保底名单自检（`NEVER_DELETE` 里声称「无人引用」的**必须真的**没有引用）。
    两处共用一份实现，避免"闸 3 查得严、保底名单没人查"这种半覆盖。
    """
    uuids = {}
    for p in pngs:
        meta = p + ".meta"
        if not os.path.isfile(meta):
            continue
        try:
            with io.open(meta, "r", encoding="utf-8") as fh:
                m = json.load(fh)
        except Exception:
            continue
        if m.get("uuid"):
            uuids[m["uuid"]] = os.path.basename(p)

    targets = []
    for pat in ("assets/**/*.prefab", "assets/**/*.scene", "assets/**/*.json", "assets/**/*.anim"):
        targets += glob.glob(os.path.join(ROOT, pat), recursive=True)
    hits = {}
    for path in targets:
        if path.lower().startswith(SKILLS_DIR.lower()):
            continue                                  # 碎图自己的 .meta 不算
        try:
            txt = io.open(path, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        for u, key in uuids.items():
            if u in txt:
                hits.setdefault(os.path.relpath(path, ROOT), []).append(key)
    return uuids, hits, len(targets)


def report_keep_list():
    """
    保底名单自检：`NEVER_DELETE` 每一条都**现场**扫一遍引用数，并核对 `why` 的说法。

    为什么值得单独一步：这张名单是"绝不删"的唯一依据，而它之前**没有任何验证** ——
    写着「无人引用」的两张图其实被预制件引用着，于是它们被当成垃圾清掉了
    （见 `NEVER_DELETE` 上的长注释）。判据：声称「无人引用」却扫出引用 → 闸不过。
    """
    print("[闸 0] 保底名单自检（NEVER_DELETE 的 `why` 必须与现场一致）")
    present = [os.path.join(SKILLS_DIR, n) for n in NEVER_DELETE
               if os.path.isfile(os.path.join(SKILLS_DIR, n))]
    absent = [n for n in NEVER_DELETE if not os.path.isfile(os.path.join(SKILLS_DIR, n))]
    _uuids, hits, scanned = scan_uuid_refs(present)
    ref_by_name = {}
    for _path, keys in hits.items():
        for k in keys:
            ref_by_name[k] = ref_by_name.get(k, 0) + 1

    ok = True
    for name, why in NEVER_DELETE.items():
        n = ref_by_name.get(name, 0)
        here = os.path.isfile(os.path.join(SKILLS_DIR, name))
        if not here:
            print("    ~~ %-22s 当前不在目录里（%s）" % (name, why))
            continue
        claims_none = NO_REF_CLAIM in why
        if claims_none and n > 0:
            ok = False
            print("    !! %-22s `why` 说「%s」，但现场扫出被 %d 个资源引用 → 说法是错的，拒绝执行"
                  % (name, NO_REF_CLAIM, n))
        else:
            print("    %-4s %-22s 被 %d 个资源引用  %s"
                  % ("OK" if (n == 0) == claims_none else "~~", name, n, why))
    print("    扫描 %d 个预制件/场景/配表/动画；目录里缺席的保底项 %d 个（缺席本身不是错，"
          "但若是被误删要按 `backup-legacy-skill-orphans.zip` 恢复）" % (scanned, len(absent)))
    if absent:
        print("    ~~ 缺席：%s" % "、".join(absent))
    print("")
    return ok


def gate3_refs(pngs):
    """闸 3（附加）：全工程没有资源还按 uuid 引用待删的碎图。"""
    print("[闸 3] 引用方扫描（附加闸：谁还在按 uuid 引用待删的碎图）")
    uuids, hits, n_targets = scan_uuid_refs(pngs)
    print("    待删碎图 %d 张，其中 %d 张有 .meta/uuid" % (len(pngs), len(uuids)))
    if hits:
        for path, keys in hits.items():
            print("    !! %s -> %s" % (path, keys))
        print("    !! 先把这些引用方改掉（改指图集帧的子资源 uuid）再删")
        return False
    print("    扫描 %d 个预制件/场景/配表/动画：没有任何资源按 uuid 引用待删碎图 → 删除是安全的"
          % n_targets)
    return True


def main():
    ap = argparse.ArgumentParser(description="退掉已被图集覆盖的技能碎图（缺省只预演）")
    ap.add_argument("--apply", action="store_true", help="真删（不给就只预演，不碰任何文件）")
    args = ap.parse_args()

    print("=" * 64)
    print("退掉技能碎图（保留图集 %s.plist + %s.png）" % (ATLAS_NAME, ATLAS_NAME))
    print("模式：%s" % ("真删（--apply）" if args.apply else "预演（只报告，不删任何文件）"))
    print("=" * 64)

    plist_path = os.path.join(SKILLS_DIR, ATLAS_NAME + ".plist")
    if not os.path.isfile(plist_path):
        print("[X] 图集索引不存在：%s" % os.path.relpath(plist_path, ROOT))
        print("    先生成图集：python tools/skill-icon-prompts/build-skills-atlas.py --apply")
        print("    再切回 Cocos Creator 窗口让它导入，然后重跑本脚本。")
        print("    退出码 1（没有图集就没有『已被图集覆盖』这回事，绝不删碎图）")
        return 1

    try:
        atlas_frames = read_plist_frames(plist_path)
    except Exception as e:
        print("[X] plist 解析失败：%s: %s" % (type(e).__name__, e))
        print("    退出码 1")
        return 1
    print("[信息] 图集帧 %d 个：%s.plist" % (len(atlas_frames), ATLAS_NAME))
    print("")

    # ---------------------------------------------------------------- 闸 0
    # 保底名单自检放最前面：它是"哪些图绝不删"的唯一依据，一旦它的说明写错，
    # 后面几道闸再严也没用（它们只查"待删"的那批，不查"保底"的那批）。
    gate0 = report_keep_list()

    # ---------------------------------------------------------------- 闸 1
    gate1 = gate1_editor_imported(atlas_frames)
    print("")

    # ---------------------------------------------------------------- 闸 2
    gate2 = gate2_check_atlas()
    print("")

    # ---------------------------------------------------------------- 待删清单
    print("[信息] 待删清单（必须同时：① 是图集里的一帧 ② abilities.json 的 icon 列引用了它）")
    cfg_names, cfg_missing, cfg_notes = ([], [], "")
    try:
        cfg_names, cfg_missing, cfg_notes = config_frames()
    except Exception as e:
        print("    !! 读配表帧集失败：%s: %s" % (type(e).__name__, e))
    cfg_set = set(cfg_names)
    if cfg_notes:
        for line in cfg_notes.splitlines():
            print("    | " + line.strip())
    if cfg_missing:
        print("    ~~ 配表引用了但磁盘上没有的图标 %d 个：%s"
              % (len(cfg_missing), "、".join(cfg_missing[:5])))
    only_atlas = sorted(atlas_frames - cfg_set)
    only_cfg = sorted(cfg_set - atlas_frames)
    if only_atlas:
        print("    ~~ 图集里有但配表没引用（不删）：%s" % "、".join(only_atlas[:5]))
    if only_cfg:
        print("    ~~ 配表引用了但图集里没有（不删，先补图集）：%s" % "、".join(only_cfg[:5]))

    deletable = sorted((atlas_frames & cfg_set) - set(NEVER_DELETE))
    pngs, metas, skipped_loose = [], [], []
    for stem in deletable:
        p = os.path.join(SKILLS_DIR, stem + ".png")
        if os.path.isfile(p):
            pngs.append(p)
            if os.path.isfile(p + ".meta"):
                metas.append(p + ".meta")
    # 目录里还有别的 png（遗留图），明确列出来说明不动
    for p in sorted(glob.glob(os.path.join(SKILLS_DIR, "*.png"))):
        base = os.path.basename(p)
        if base in NEVER_DELETE or base == ATLAS_NAME + ".png":
            continue
        if p not in pngs:
            skipped_loose.append(base)

    png_bytes = sum(os.path.getsize(p) for p in pngs)
    meta_bytes = sum(os.path.getsize(p) for p in metas)
    print("    待删 %d 个文件（%d 个 png + %d 个 meta），共 %s"
          % (len(pngs) + len(metas), len(pngs), len(metas),
             "{:,}B".format(png_bytes + meta_bytes)))
    for p in pngs:
        print("       %-28s %8s B" % (os.path.basename(p), "{:,}".format(os.path.getsize(p))))
    print("    绝不删（不在图集覆盖范围内）：")
    for name, why in NEVER_DELETE.items():
        exists = os.path.isfile(os.path.join(SKILLS_DIR, name))
        print("       %-28s %s%s" % (name, why, "" if exists else "（当前不在目录里）"))
    if skipped_loose:
        print("    其余不在图集/配表里的 png（也保留）：%s" % "、".join(skipped_loose))
    if not pngs:
        print("    （没有可删的碎图 —— 可能已经退过了）")
    print("")

    # ---------------------------------------------------------------- 闸 3
    gate3 = gate3_refs(pngs) if pngs else True
    print("")

    # ---------------------------------------------------------------- 闸 4（备份）
    print("[闸 4] 删前备份到 %s" % os.path.relpath(BACKUP, ROOT))
    backup_ok = False          # 备份这道闸在 --apply 时才真的执行（预演不写盘）
    backup_txt = "预演未执行"
    if not pngs:
        print("    没有待删文件，跳过备份")
        backup_ok = True
        backup_txt = "无待删文件"
    elif not args.apply:
        print("    预演：**先不动盘**。给 --apply 时会先把这 %d 个文件写进 zip 并核对条目数，"
              "核对通过才删。" % (len(pngs) + len(metas)))
        print("    （占 %s；已存在会覆盖成当前这一份碎集）"
              % "{:,}B".format(png_bytes + meta_bytes))
        backup_ok = True
    else:
        if os.path.isfile(BACKUP):
            print("    备份已存在（是上一轮碎集的备份）→ 覆盖成当前这一份")
        os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
        with zipfile.ZipFile(BACKUP, "w", zipfile.ZIP_DEFLATED) as z:
            for p in pngs:
                z.write(p, os.path.basename(p))          # 扁平 basename → 回滚一条命令
            for p in metas:
                z.write(p, os.path.basename(p))
        with zipfile.ZipFile(BACKUP) as z:
            names = z.namelist()
            bad_entry = z.testzip()
        png_entries = [n for n in names if n.lower().endswith(".png")]
        print("    已写入 %s（%s）" % (os.path.relpath(BACKUP, ROOT),
                                     "{:,}B".format(os.path.getsize(BACKUP))))
        print("    核对：zip 里 %d 个条目（其中 .png %d 个）vs 待删 png %d 个 / meta %d 个"
              % (len(names), len(png_entries), len(pngs), len(metas)))
        ok_count = len(png_entries) == len(pngs) and len(names) == len(pngs) + len(metas)
        missing_in_zip = [os.path.basename(p) for p in pngs if os.path.basename(p) not in names]
        if not ok_count or missing_in_zip or bad_entry is not None:
            print("    !! 备份不完整（缺条目 %s，损坏条目 %s）—— 拒绝执行"
                  % (missing_in_zip[:5], bad_entry))
        else:
            print("    OK：每个待删文件都在 zip 里，且逐个校验无损")
            backup_ok = True
            backup_txt = "已写入并核对 %d 个条目" % len(names)
    print("")

    gates_ok = gate0 and gate1 and gate2 and gate3 and backup_ok

    print("-" * 64)
    print("闸 0 保底名单   : %s" % ("过" if gate0 else "没过"))
    print("闸 1 编辑器导入 : %s" % ("过" if gate1 else "没过"))
    print("闸 2 图集体检   : %s" % ("过" if gate2 else "没过"))
    print("闸 3 引用扫描   : %s" % ("过" if gate3 else "没过"))
    print("闸 4 删前备份   : %s" % backup_txt)
    print("待删            : %d 个文件（%s），共 %s"
          % (len(pngs) + len(metas), "png %d + meta %d" % (len(pngs), len(metas)),
             "{:,}B".format(png_bytes + meta_bytes)))
    print("永不删          : %s" % "、".join(sorted(NEVER_DELETE)))
    print("备份            : %s" % os.path.relpath(BACKUP, ROOT))
    print("回滚（一条命令）:")
    print("    Expand-Archive -Force %s %s"
          % (os.path.relpath(BACKUP, ROOT).replace("\\", "/"),
             os.path.relpath(SKILLS_DIR, ROOT).replace("\\", "/")))
    print("    （zip 里是扁平的 basename，直接解进技能目录即可；图集方案不用改代码）")

    if not args.apply:
        print("模式            : 预演（**没有删任何文件**；加 --apply 才真删）")
        print("结论            : %s" % ("闸全过，可以 --apply" if gates_ok else "有闸没过，拒绝执行"))
        print("-" * 64)
        return 0 if gates_ok else 1

    if not gates_ok:
        print("模式            : 真删（--apply）")
        print("结论            : 有闸没过 —— **拒绝执行**，一个文件都没删")
        print("-" * 64)
        return 1

    removed = 0
    for p in pngs + metas:
        os.remove(p)
        removed += 1
    print("模式            : 真删（--apply）")
    print("已删            : %d 个文件，回收 %s" % (removed, "{:,}B".format(png_bytes + meta_bytes)))
    left = sorted(os.path.basename(p) for p in glob.glob(os.path.join(SKILLS_DIR, "*")))
    print("目录现在只剩    : %s" % "、".join(left))
    print("结论            : 完成。真源变成 %s.plist + %s.png；回滚见上面的 Expand-Archive"
          % (ATLAS_NAME, ATLAS_NAME))
    print("-" * 64)
    return 0


if __name__ == "__main__":
    sys.exit(main())
