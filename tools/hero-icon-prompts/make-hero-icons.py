#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make-hero-icons.py —— 把 ComfyUI 出的原图做成**工程可直接用**的英雄头像 / 技能图标。

为什么必须有这一步（三条理由，都是实测口径，别用「让模型直接出透明底」代替）：
  1. **风格是「一个纯白色块 + 挖空」，不是「白色材质」**。扩散模型会把「白色主体」理解成
     「打了光的白材质」，于是在白块里画灰面、在边缘加高光 —— 那些灰面进 alpha 通道就是半透明脏边。
     所以：**形状交给模型，颜色由这一步强制拍平**（所有不透明像素一律 #F6F6F6，一个杂色都不留）。
  2. **承载底必须本地抠**。现有 4 张头像与 bullet 图标的不透明像素 99.9%~100% 都是同一个近白色，
     第二颜色为零 —— 这个纯度靠提示词是拿不到的。这一步按**四边采样出来的实际底色**做色键，
     比固定色值稳（模型不会正好画出 #445054）。
  3. **alpha 包围盒必须正方形**。`View_Game_Stage.prefab` 里 `item/content/head/inner` 与
     `skills/inner` 都是 `sizeMode=CUSTOM(50×50 / 20×20)` + `_isTrimmedMode=true`：
     导入器按 alpha 包围盒算 trim，节点又按 CUSTOM 尺寸把 trim 后的矩形铺满 →
     **包围盒不是正方形就会被拉伸**（现有 `bullet.png` 的包围盒正好是 164×164 正方形，
     `huoqiang.png` 是 201×203 接近正方形，就是这个原因）。这一步把包围盒补成正方形再归一。

做四件事：色键/alpha 取前景 → 全部拍平成 #F6F6F6 → 裁到包围盒并**补成正方形** → 
按「正方形边长占画布 CONTENT_RATIO」居中摆放并用**预乘 alpha** 缩到交付尺寸。

用法：
    # 1) 先导：只做 2 个英雄，出对照图先看风格
    python tools/hero-icon-prompts/make-hero-icons.py --src .tmp/hero-icons-out --dst .tmp/hero-icons-final --only huoqiang,huanci
    # 2) 全量
    python tools/hero-icon-prompts/make-hero-icons.py --src .tmp/hero-icons-out --dst .tmp/hero-icons-final
    # 3) 出「真实槽位尺寸」对照图（这一步别省：200×200 看着没问题，缩到 50×50 可能就糊了）
    python tools/hero-icon-prompts/make-hero-icons.py --src .tmp/hero-icons-out --dst .tmp/hero-icons-final --sheet .tmp/hero-icons-final/_sheet.png
"""
import argparse
import json
import os
import sys
from collections import Counter

import numpy as np
from PIL import Image

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

# alpha 低于这个值算背景（抗锯齿边缘的半透明像素不算主体）
ALPHA_FLOOR = 20

# 交付画布上「正方形包围盒」占的比例（与遗物那套的 80% 一致）
CONTENT_RATIO = 0.80

# 主体色：现有素材的实测值（huoqiang.png 不透明像素 66% 是 #F6F6F6，bullet.png 100% 是 #FFFFFF）
BODY_RGB = (246, 246, 246)

# 色键参数：到「底色」的距离小于 LO 判为背景，大于 HI 判为前景，中间线性过渡（保住抗锯齿边）
KEY_LO = 0.18
KEY_HI = 0.45

# 判「这张图自带真透明底」的门槛：边框上至少这么多比例的像素 alpha < 16
REAL_ALPHA_BORDER_RATIO = 0.35


def border_ring(im, frac=0.03):
    """取最外圈 FRAC 比例宽度的像素（只做统计用）。"""
    a = np.asarray(im.convert("RGBA"), dtype=np.float32)
    h, w = a.shape[:2]
    bw = max(1, int(round(min(h, w) * frac)))
    parts = [a[:bw, :, :].reshape(-1, 4), a[-bw:, :, :].reshape(-1, 4),
             a[:, :bw, :].reshape(-1, 4), a[:, -bw:, :].reshape(-1, 4)]
    return np.concatenate(parts, axis=0)


def detect_background(im):
    """从边框采样实际底色 —— 用中位数而不是均值，少量反锯齿白边不会把底色带偏。"""
    ring = border_ring(im)
    opaque = ring[ring[:, 3] >= 200]
    if len(opaque) == 0:
        return None, 0.0
    real_alpha_ratio = float((ring[:, 3] < 16).mean())
    return np.median(opaque[:, :3], axis=0), real_alpha_ratio


def foreground_alpha(im):
    """返回 float32 的 alpha 图（0~1）。优先用真 alpha 底，否则按采样底色色键。"""
    a = np.asarray(im.convert("RGBA"), dtype=np.float32)
    bg, real_ratio = detect_background(im)

    alpha_real = a[:, :, 3] / 255.0
    if real_ratio >= REAL_ALPHA_BORDER_RATIO:
        # 模型真给了透明底：直接用它，但把「有颜色但很透」的脏像素压掉
        return np.clip(alpha_real, 0.0, 1.0), "real-alpha", bg, real_ratio

    if bg is None:
        return np.clip(alpha_real, 0.0, 1.0), "real-alpha(no-border)", bg, real_ratio

    # 色键：到边框底色的归一化 RGB 距离
    dist = np.sqrt(((a[:, :, :3] - bg[None, None, :]) ** 2).sum(axis=2)) / 441.673  # 441.673 = sqrt(3)*255
    t = (dist - KEY_LO) / max(1e-6, (KEY_HI - KEY_LO))
    t = np.clip(t, 0.0, 1.0)
    # 平滑一下（smoothstep），让中间过渡的像素更快推到 0/1，边缘保留抗锯齿
    t = t * t * (3.0 - 2.0 * t)
    # 与真 alpha 取最小值：模型若同时给了透明底，两者都要求是前景
    return np.minimum(t, np.clip(alpha_real * 4.0, 0.0, 1.0)), "chroma-key", bg, real_ratio


def square_bbox(mask, floor=ALPHA_FLOOR):
    """主体包围盒（返回整数 bbox 与原始宽高，供报告用）。

    ⚠ **这里有个坑，第一版就栽在这**：把「裁剪窗口」补成正方形**并不会**让「内容包围盒」变正方形 ——
    包围盒是由不透明像素的范围定义的，四周补透明像素根本不会改变它。实测 `hero_huoqiang` 的
    源包围盒是 424×364，补成 424×424 的窗口之后交付图量出来还是 205×177（宽度占满、高度不足）。
    真正的修法只有一个：**把内容本身按 x/y 独立缩放到正方形**（见 process_one），
    也就是承认「非正方内容一定会被 engine 拉伸」这件事，然后由我们自己拉伸到自洽为止。
    """
    m = (mask * 255.0 >= floor)
    ys, xs = np.where(m)
    if len(xs) == 0:
        return None
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    return (x0, y0, x1 - x0 + 1, y1 - y0 + 1)


def resize_premultiplied(im, size):
    """预乘 alpha 再缩放，避免透明区域的黑 RGB 在边缘渗出深色描边。"""
    arr = np.asarray(im.convert("RGBA"), dtype=np.float32)
    a = arr[..., 3:4] / 255.0
    pre = arr.copy()
    pre[..., :3] = arr[..., :3] * a
    out = np.asarray(Image.fromarray(pre.astype(np.uint8), "RGBA").resize((size, size), Image.LANCZOS),
                     dtype=np.float32)
    a2 = out[..., 3:4] / 255.0
    with np.errstate(invalid="ignore", divide="ignore"):
        out[..., :3] = np.where(a2 > 0, out[..., :3] / np.maximum(a2, 1e-6), 0)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def process_one(src_path, size):
    """单张：色键 → 拍平白 → 裁到包围盒 → **按 x/y 独立缩放成正方形** → 居中。返回 (图, 诊断)。

    ⚠ 为什么是「缩成正方形」而不是「补成正方形」：`Sprite` 的 `sizeMode=CUSTOM` + `_isTrimmedMode=true`
    下，引擎会把**包围盒**铺满槽位（头像 50×50），所以包围盒非正方形 = 画面被拉伸。
    把内容自己在交付前缩成正方形，屏幕上的结果**与让引擎拉伸完全一致**（同样的形变量），
    但资产从此是自洽的（WYSIWYG、任何消费方行为都一样）。
    因此 `squeeze` 这个数要盯着看：它 > 1.15 说明模型画的构图太扁/太瘦，该去改提示词而不是接受形变。
    """
    im = Image.open(src_path).convert("RGBA")
    mask, how, bg, real_ratio = foreground_alpha(im)

    bb = square_bbox(mask)
    if bb is None:
        return None, {"error": "整张图都是背景（色键把主体也抠掉了）"}
    x0, y0, bw, bh = bb

    # 全部拍平成主体白：RGB 一律 #F6F6F6，只有 alpha 在变
    h, w = mask.shape
    flat = np.zeros((h, w, 4), dtype=np.uint8)
    flat[..., 0], flat[..., 1], flat[..., 2] = BODY_RGB
    flat[..., 3] = np.clip(mask * 255.0, 0, 255).astype(np.uint8)
    flat_im = Image.fromarray(flat, "RGBA")

    # 缩到「正方形边长 = 画布 × CONTENT_RATIO」：**一次重采样**同时完成
    # 「裁到包围盒」与「非等比缩成正方形」两件事 —— 少一次重采样就少一轮 LANCZOS 过冲。
    inner = max(1, int(round(size * CONTENT_RATIO)))
    crop = flat_im.crop((x0, y0, x0 + bw, y0 + bh))
    small = resize_premultiplied(crop, inner)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    off = (size - inner) // 2
    out.alpha_composite(small, (off, off))

    # ⚠ **最后无条件把 RGB 拍平**（别省这一步）：LANCZOS 有负瓣，在硬边上会**过冲**，
    #   预乘图里 246 会被冲到 >246 并被 clip 成纯白 #FFFFFF —— 实测第一版有 28% 的不透明像素
    #   变成了 #FFFFFF（体检的「单色」那条会红）。既然风格就是「一个纯色块」，
    #   那就让 alpha 独自承载形状，RGB 一律写死；透明像素也写 246（而不是留 0），
    #   这样即便引擎不做预乘采样，边缘也不会渗出黑边。
    arr = np.array(out)
    arr[..., 0], arr[..., 1], arr[..., 2] = BODY_RGB
    out = Image.fromarray(arr, "RGBA")

    alpha = np.asarray(out.getchannel("A"), dtype=np.float32) / 255.0
    squeeze = max(bw, bh) / max(1, min(bw, bh))
    diag = {
        "how": how,
        "bg": None if bg is None else [int(v) for v in bg],
        "real_alpha_border": round(real_ratio, 3),
        "src_bbox": [bw, bh],
        "squeeze": round(squeeze, 3),
        "content_px": inner,
        "alpha_extrema": [int(np.asarray(out.getchannel("A")).min()), int(np.asarray(out.getchannel("A")).max())],
        "opaque_ratio": round(float((alpha >= 0.5).mean()), 4),
        "pure_white_ratio": round(float(((np.asarray(out)[..., :3] == np.array(BODY_RGB)).all(axis=2) & (alpha >= 0.5)).sum() / max(1, (alpha >= 0.5).sum())), 4),
    }
    return out, diag


IDENTITY_RGB = (168, 90, 90, 255)   # #A85A5A 英雄头像底（View_Game_Stage.prefab item/content/head._color）
ACCENT_RGB = (112, 172, 179, 255)   # #70ACB3 技能图标底（item/content/skills._color）


def make_sheet(rows, out_path):
    """真实槽位对照图：每个英雄 4 格，**一行放 2 个英雄**（10 个英雄 = 5 行）。

    ⚠ 这一步是**判断风格的唯一正确姿势**：大图看着都没问题，
       缩到真实槽位（头像 50×50、选人卡技能图 20×20）才看得出糊不糊、剪影认不认得出。
       槽位尺寸与底色都取自 View_Game_Stage.prefab 的实测值 —— **它们不随交付尺寸变**。

    ⚠ 只画**两个槽都有图**的行：肉鸽技能清单（`docs/skill-icons/prompts.json`）里
       每条只有 `slot='icon'`，硬画会在 `emblem.width` 上炸掉。
    """
    rows = [r for r in rows if r[2] is not None and r[3] is not None]
    if not rows:
        print("  （--sheet 跳过：没有「头像+技能图」成对的行，这本清单大概是只有技能图的）")
        return None
    CELL = 132
    PER_ROW = 2
    COLS = PER_ROW * 4
    n_rows = (len(rows) + PER_ROW - 1) // PER_ROW
    sheet = Image.new("RGBA", (CELL * COLS, CELL * n_rows), (239, 238, 237, 255))
    for idx, (label, _key, emblem, icon) in enumerate(rows):
        r, c0 = divmod(idx, PER_ROW)
        y, x0 = r * CELL, c0 * 4 * CELL
        for c, (im, bg, dsz) in enumerate([
            (emblem, IDENTITY_RGB, 50),          # 选人卡 / HUD 头像（50×50）
            (emblem, (255, 255, 255, 255), 50),  # 对照：白底上几乎看不见 = 「图里不该有颜色」的证明
            (icon, ACCENT_RGB, 50),              # HUD 技能槽（50×50）
            (icon, ACCENT_RGB, 20),              # 选人卡技能图（20×20，全工程最小显示处）
        ]):
            pad = 14
            cell = Image.new("RGBA", (CELL, CELL), (255, 255, 255, 0))
            plate = Image.new("RGBA", (CELL - pad * 2, CELL - pad * 2), bg)
            small = im.resize((dsz, dsz), Image.LANCZOS)
            plate.alpha_composite(small, ((plate.width - dsz) // 2, (plate.height - dsz) // 2))
            cell.alpha_composite(plate, (pad, pad))
            sheet.alpha_composite(cell, (x0 + c * CELL, y))
    sheet.convert("RGB").save(out_path)
    return out_path


def make_preview(rows, out_path):
    """原尺寸对照图（给人看画本身）：每行一个英雄 = 头像 + 技能图，各贴自己的底色。

    ⚠ 底板尺寸**从交付出来的图里读**，不在这里再写一份 —— 写死了改交付尺寸（200→64）就会漂移。
       缺哪一侧就只画有的那一侧（肉鸽技能清单只有 `slot='icon'`）。
    """
    rows = [r for r in rows if r[2] is not None or r[3] is not None]
    if not rows:
        return None
    P = max([r[2].width for r in rows if r[2] is not None] or [0])
    I = max([r[3].width for r in rows if r[3] is not None] or [0])
    GAP, PAD = 10, 20
    W = PAD * 2 + (P + GAP if P else 0) + (I if I else 0)
    H = PAD * 2 + (max(P, I) + GAP) * len(rows) - GAP
    sheet = Image.new("RGB", (W, H), (239, 238, 237))
    plate = Image.new("RGBA", (P, P), IDENTITY_RGB) if P else None
    iplate = Image.new("RGBA", (I, I), ACCENT_RGB) if I else None
    for r, (_label, _key, emblem, icon) in enumerate(rows):
        y = PAD + r * (max(P, I) + GAP)
        x = PAD
        if plate is not None and emblem is not None:
            p = plate.copy()
            p.alpha_composite(emblem, ((P - emblem.width) // 2, (P - emblem.height) // 2))
            sheet.paste(p.convert("RGB"), (x, y + (max(P, I) - P) // 2))
        if P:
            x += P + GAP
        if iplate is not None and icon is not None:
            q = iplate.copy()
            q.alpha_composite(icon, ((I - icon.width) // 2, (I - icon.height) // 2))
            sheet.paste(q.convert("RGB"), (x, y + (max(P, I) - I) // 2))
    sheet.save(out_path)
    return out_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="ComfyUI 出的原图目录（key.png）")
    ap.add_argument("--dst", required=True, help="交付目录")
    ap.add_argument("--prompts", default=os.path.join(ROOT, "docs", "hero-icons", "prompts.json"))
    ap.add_argument("--only", default="", help="只做这些英雄（逗号分隔的 code）")
    ap.add_argument("--sheet", default="", help="额外输出一张真实槽位对照图到该路径")
    ap.add_argument("--preview", default="", help="额外输出一张原尺寸对照图（给人看画本身）")
    ap.add_argument("--report", default="", help="诊断 JSON 落盘路径（缺省 = dst/_report.json）")
    args = ap.parse_args()

    with open(args.prompts, "r", encoding="utf-8") as fh:
        items = json.load(fh)["items"]
    by_key = {it["key"]: it for it in items}

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    os.makedirs(args.dst, exist_ok=True)

    report, done, missing = {}, [], []
    for key, it in by_key.items():
        if only and it["code"] not in only and not any(o in key for o in only):
            continue
        src = os.path.join(args.src, it.get("out_png") or f"{key}.png")
        if not (os.path.exists(src) and os.path.getsize(src) > 1024):
            missing.append(key)
            continue
        out, diag = process_one(src, int(it["size"]))
        if out is None:
            report[key] = diag
            print(f"  × {key}：{diag['error']}")
            continue
        dst = os.path.join(args.dst, f"{key}.png")
        out.save(dst)
        report[key] = diag
        done.append(key)
        warn = "  ⚠ 构图太扁/太瘦，建议改提示词而不是接受形变" if diag["squeeze"] > 1.15 else ""
        print(f"  √ {key:<22} {it['size']}×{it['size']}  {diag['how']:<11} "
              f"底色={diag['bg']}  源包围盒={diag['src_bbox']}  形变={diag['squeeze']:.2f}×  "
              f"占屏={diag['opaque_ratio']:.1%}  纯白={diag['pure_white_ratio']:.1%}{warn}")

    rep_path = args.report or os.path.join(args.dst, "_report.json")
    with open(rep_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print(f"\n◆ 处理 {len(done)} 张；诊断 → {rep_path}")
    if missing:
        print(f"◆ 源图缺失 {len(missing)} 张（还没出图）：{', '.join(missing[:8])}{' …' if len(missing) > 8 else ''}")

    # 对照图（可选）：需要同时有头像与技能图
    if (args.sheet or args.preview) and done:
        groups = {}
        for key in done:
            it = by_key[key]
            im = Image.open(os.path.join(args.dst, f"{key}.png")).convert("RGBA")
            groups.setdefault(it["hero"], [None, None, it["code"]])[0 if it["slot"] == "emblem" else 1] = im
        rows = [(hero, v[2], v[0], v[1]) for hero, v in groups.items() if v[0] is not None and v[1] is not None]
        rows.sort(key=lambda r: r[1])
        if rows and args.sheet:
            print(f"◆ 真实槽位对照图 → {make_sheet(rows, args.sheet)}")
        if rows and args.preview:
            os.makedirs(os.path.dirname(args.preview) or ".", exist_ok=True)
            print(f"◆ 原尺寸对照图 → {make_preview(rows, args.preview)}")


main()
