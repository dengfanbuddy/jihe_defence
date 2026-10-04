#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
install-hero-icons.py —— 把交付目录里的 20 张图装进工程资源目录。

装到哪（路径来自 docs/hero-icons/prompts.json 的 `icon_path`，**不带扩展名**，与 units.json 的
`head_icon` 同口径）：
    hero_<code>.png   → assets/resources/textures/heros/<code>.png
    skill_<code>.png  → assets/resources/textures/skills/<code>_skill.png

三道闸（与遗物那套 `install-icons.py` / `retire-loose-icons.py` 同一套路子）：
  ① **体检全绿才装**：先跑 `check-hero-icons.py`，不过就不装（避免把脏图装进工程）。
  ② **覆盖前先备份**：现役 4 个英雄的头像文件已存在（huoqiang/shangjin/zhousi/fuwang），
     这次是**原地替换**（用户口径：10 个英雄统一风格）。任何会被覆盖的文件先打包进
     `tools/hero-icon-prompts/backup-hero-portraits.zip` 才允许写；**回滚 = 解压放回 + 重进编辑器**。
  ③ **不碰 .meta**：`.meta` 由编辑器生成（导入器算 trim/vertices/nuv）。
     手写 `.meta` 会切图错位，见 AGENTS.md 的「新拷进来的 png 要等编辑器导入」。

⚠ **装完必须切回 Cocos 窗口**：编辑器窗口不在前台时资源库不刷新（`library/` 无写入、`.meta` 不生成）。
   切回窗口（或按 Assets 面板刷新）才会导入。

⚠ **两个默认值可覆盖（本脚本同时服务「英雄头像/技能图」与「肉鸽技能图」两套）**：
   `--prompts`（清单，缺省 `docs/hero-icons/prompts.json`）与 `--backup`（备份 zip，缺省
   `backup-hero-portraits.zip`）。**跑技能那套时必须两个都换** —— 否则会去读错清单，
   而且备份 zip 是 `"w"` 打开（会截断），**会毁掉英雄头像的回滚包**。

用法：
    # 1) 演练（默认行为）：只报告会装什么、会覆盖什么，不写盘
    python tools/hero-icon-prompts/install-hero-icons.py
    # 2) 真装
    python tools/hero-icon-prompts/install-hero-icons.py --apply
    # 3) 只装部分（按清单里的 code 过滤）
    python tools/hero-icon-prompts/install-hero-icons.py --apply --only huanci,zhuoer
    # 4) 装肉鸽技能那 30 张（两个默认值都要换！）
    python tools/hero-icon-prompts/install-hero-icons.py --apply \
        --src .tmp/skill-icons-final --prompts docs/skill-icons/prompts.json \
        --backup backup-skill-icons.zip
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import zipfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
RES = os.path.join(ROOT, "assets", "resources")
DEFAULT_PROMPTS = os.path.join(ROOT, "docs", "hero-icons", "prompts.json")
DEFAULT_BACKUP = os.path.join(HERE, "backup-hero-portraits.zip")


def run_check(src_dir, prompts):
    """闸①：体检必须全绿（退出码 0）。用**同一份清单**跑，尺寸校验才准。"""
    r = subprocess.run([sys.executable, os.path.join(HERE, "check-hero-icons.py"),
                        "--dir", src_dir, "--prompts", prompts],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    tail = (r.stdout or "").strip().splitlines()
    for line in tail[-4:]:
        print(f"    {line}")
    return r.returncode == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(ROOT, ".tmp", "hero-icons-final"),
                    help="交付目录（key.png 命名）")
    ap.add_argument("--apply", action="store_true", help="真写盘（缺省只演练）")
    ap.add_argument("--only", default="", help="只装这些（逗号分隔的 code）")
    ap.add_argument("--prompts", default=DEFAULT_PROMPTS, help="出图清单（决定 icon_path）")
    ap.add_argument("--backup", default=DEFAULT_BACKUP, help="覆盖前备份到哪个 zip")
    args = ap.parse_args()

    PROMPTS = args.prompts
    BACKUP = args.backup

    if not os.path.isfile(PROMPTS):
        sys.exit(f"× 找不到 {PROMPTS}（先跑 gen-prompts.mjs）")
    with open(PROMPTS, "r", encoding="utf-8") as fh:
        items = json.load(fh)["items"]
    only = {s.strip() for s in args.only.split(",") if s.strip()}

    plan, missing = [], []
    for it in items:
        if only and it["code"] not in only:
            continue
        src = os.path.join(args.src, f"{it['key']}.png")
        if not (os.path.exists(src) and os.path.getsize(src) > 1024):
            missing.append(it["key"])
            continue
        dst = os.path.join(RES, it["icon_path"] + ".png")
        plan.append((it, src, dst))

    if missing:
        print(f"⚠ 交付目录里缺 {len(missing)} 张（还没后处理）：{', '.join(missing)}")
    if not plan:
        sys.exit("× 没有可装的图")

    over = [(it, s, d) for it, s, d in plan if os.path.exists(d)]
    print(f"◆ 计划安装 {len(plan)} 个文件（其中**会覆盖已存在的 {len(over)} 个**）")
    for it, _s, d in plan:
        tag = "覆盖" if os.path.exists(d) else "新增"
        print(f"  [{tag}] {it['key']:<22} → {os.path.relpath(d, ROOT).replace(chr(92), '/')}")

    if over:
        print("\n  ⚠ 会被覆盖的现有文件：")
        for it, _s, d in over:
            print(f"     · {os.path.relpath(d, ROOT).replace(chr(92), '/')}（{os.path.getsize(d) // 1024} KB）")

    if not args.apply:
        print("\n◆ 演练结束（未写盘）。要真装加 --apply")
        return

    print("\n◆ 闸① 交付体检")
    if not run_check(args.src, PROMPTS):
        sys.exit("× 体检不过，拒绝安装（先修图，别把脏图装进工程）")
    print("    √ 体检全绿")

    if over:
        print(f"◆ 闸② 备份 {len(over)} 个将被覆盖的文件 → {os.path.relpath(BACKUP, ROOT)}")
        with zipfile.ZipFile(BACKUP, "w", zipfile.ZIP_DEFLATED) as z:
            for it, _s, d in over:
                z.write(d, arcname=os.path.relpath(d, RES).replace("\\", "/"))
                # 一起备份 .meta：回滚时 uuid 不变，预制件/配表引用才不会断
                if os.path.exists(d + ".meta"):
                    z.write(d + ".meta", arcname=os.path.relpath(d + ".meta", RES).replace("\\", "/"))
        print(f"    √ {BACKUP}（{os.path.getsize(BACKUP) // 1024} KB）")

    print("◆ 闸③ 拷文件（不动 .meta）")
    for it, s, d in plan:
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy2(s, d)
        print(f"    √ {os.path.relpath(d, ROOT).replace(chr(92), '/')}")

    print(f"\n◆ 装了 {len(plan)} 个文件。")
    print("◆ **下一步要去 Cocos 窗口前台**（或按 Assets 面板刷新）触发导入 —— 窗口不在前台时资源库不刷新。")
    print("◆ 装完复验：python tools/hero-icon-prompts/check-hero-icons.py --installed")
    if over:
        print(f"◆ 回滚：把 {os.path.basename(BACKUP)} 解压回 assets/resources/ 覆盖，再刷新编辑器。")


if __name__ == "__main__":
    main()
