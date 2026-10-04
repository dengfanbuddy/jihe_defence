#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
comfyui_batch.py —— 把 docs/relic-icon/prompts.csv 批量投给 ComfyUI（Qwen-Image-2.1）出图。

⚠ 未在真机上验证过（没有你的 ComfyUI 实例与 API 工作流）。接口很薄：只改指定节点的
   `inputs.text`（提示词）与可选 `inputs.image`（路线 A 的参考图），其余原样透传。
   请先 `--limit 3 --dry-run` 看清补丁打在哪，再放开跑。

用法：
    # 0) 在 ComfyUI 里把工作流调通（1:1 / 1.0MP / steps 25 / cfg 1 / refine_prompt 关），
    #    然后 Workflow → Export (API) 导出 api 格式 json
    # 1) 干跑：只看补丁
    python tools/relic-icon-prompts/comfyui_batch.py --workflow wf.json \
        --prompt-node 6 --route t2i --dry-run --limit 3
    # 2) 真跑
    python tools/relic-icon-prompts/comfyui_batch.py --workflow wf.json \
        --prompt-node 6 --route t2i --out D:/relic-icons-out

路线 A（参考图重绘）额外需要：
    --route edit --load-image-node 10
    并在工作流里 LoadImage 后面接一个 ImageScale（1024×1024, lanczos）——
    原图只有 88×64，不放大就只会出 96×64 的糊图（官方：编辑尺寸跟随第一张参考图）。
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DEFAULT_CSV = os.path.join(ROOT, "docs", "relic-icon", "prompts.csv")

# Windows 控制台默认 GBK，勾叉类字符会 UnicodeEncodeError 把整批打断 —— 兜一层，永不因打印崩掉
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")


def post_json(url, payload, timeout=60):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_json(url, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_bytes(url, timeout=300):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read()


# ============================ 长批量保命层（实测：跑到一半 ComfyUI 会把连接掐掉） ============================
# 2026-10 实测：16GB 卡跑 Qwen-Image-2.1 int8（权重常驻 13.6GB）时，服务端会在出图途中
# 直接 RST 连接（`ConnectionResetError WinError 10054`），整批就此中断。所以三种失败都要兜：
#   ① 瞬时网络错（连接被重置 / 超时）      → 重试
#   ② 投出去的任务丢了（服务端重启过）      → 重投
#   ③ 单张卡住不动（显存打满后假死）        → /interrupt 打断后重投
def retry(fn, tries=4, delay=5.0, what="请求"):
    """把 `fn` 跑最多 tries 次，网络类异常（含 URLError/ConnectionResetError/timeout）退避重试。"""
    last = None
    for n in range(1, tries + 1):
        try:
            return fn()
        except urllib.error.HTTPError:
            raise  # 4xx/5xx 是确定性的（提示词/节点错了），重试没意义，交给调用方打印
        except Exception as err:  # noqa: BLE001 —— 含 ConnectionResetError / socket.timeout / URLError
            last = err
            if n < tries:
                print(f"    · {what}失败（{n}/{tries}）：{type(err).__name__}: {err}；{delay:.0f}s 后重试")
                time.sleep(delay)
                delay = min(delay * 2, 60)
    raise last


def queue_state(host, prompt_id, timeout=20):
    """返回 'running' / 'pending' / 'gone' —— 'gone' = 既不在队列也没进历史（服务端重启过，任务丢了）。"""
    try:
        q = retry(lambda: get_json(f"{host}/queue", timeout=timeout), tries=2, delay=3, what="查队列")
    except Exception:  # noqa: BLE001 —— 查不到就当没丢，下一轮再判
        return "running"
    for item in (q.get("queue_running") or []):
        if len(item) > 1 and item[1] == prompt_id:
            return "running"
    for item in (q.get("queue_pending") or []):
        if len(item) > 1 and item[1] == prompt_id:
            return "pending"
    return "gone"


def interrupt(host):
    """打断当前出图（显存打满假死时用）—— 失败无所谓，下一轮重投即可。"""
    try:
        post_json(f"{host}/interrupt", {}, timeout=20)
        return True
    except Exception:  # noqa: BLE001
        return False


def free_memory(host, unload=False):
    """释放内存。

    ⚠⚠ **2026-10 实测把这段结论整个推翻过一次，别再按"多清缓存总没错"的直觉设默认值。**

    事情的完整经过（三次实测，同一张 16GB 卡）：
      ① 模型**常驻**、一次都不清（最早 4 张 pilot）：**112 s/张**，还会卡死；
      ② 每张调一次 `/free`（`unload_models=False`）+ 大编码器：24~29 s/张，
         但**第 7 张就把显存钉在 15.5/16GB 然后假死**；
      ③ 每张连模型一起卸（`unload=True`）：26~29 s/张，稳定 —— 于是当时**误以为"卸载是必须的"**。

    后来把耗时拆开量（`steps=1` 探针 vs `steps=40`）才发现真相：
      · `steps=40` 23.5 s ／ `steps=1` 18.0 s → **固定开销 17.4 s、每步仅 0.141 s**
      · 也就是说 **24% 是采样、76% 是"每张重新加载模型"**（降分辨率只影响采样 → 实测 640→512 只快 3%）
      · 根因：当初用的编码器 `qwen3vl_8b_int8_convrot` **8.71GB** + UNET 6.76GB + VAE 0.63GB
        = **16.1GB > 16GB 显存，根本装不下** → 必然每张换进换出。

    换成 **`qwen3vl_8b_w4a8`（5.88GB）** 后总占用 **13.27GB → 装得下了**，此时再实测：
      · **`--free-every 0 --unload-every 0`（一次都不调 `/free`）：第 1 张 21 s（冷启动），之后 8.3 / 8.6 s**
      · 跑完显存 **13.7GB（模型真的常驻着）**
      · 对照：同样的 w4a8 但 `--free-every 1` → 跑完显存只剩 **1.8GB（模型被赶走了）**

    → **结论一：`/free`（哪怕 `unload_models=False`）实测会把模型逐出显存**，在"装得下"的前提下
      每调一次就白付一次重新加载的钱（9 s → 23 s）。
    → **结论二：先让模型装得下，再谈常驻**。装不下时必须每张卸（否则颠簸+假死）；
      装得下时**一次都别调 `/free`**。
    → 所以本脚本的默认值取决于你的模型组合：`docs/relic-icon/README.md` §6.1 有决策表。
    """
    try:
        post_json(f"{host}/free", {"unload_models": bool(unload), "free_memory": True}, timeout=60)
        return True
    except Exception:  # noqa: BLE001
        return False


def upload_image(host, path):
    """把本地参考图传进 ComfyUI 的 input 目录，返回它在 LoadImage 里要填的文件名。"""
    boundary = "----dsh" + uuid.uuid4().hex
    name = os.path.basename(path)
    with open(path, "rb") as fh:
        content = fh.read()
    body = b"".join([
        f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\n'
        f"Content-Type: image/png\r\n\r\n".encode("utf-8"),
        content,
        b"\r\n",
        f'--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'.encode("utf-8"),
        f"--{boundary}--\r\n".encode("utf-8"),
    ])
    req = urllib.request.Request(
        f"{host}/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read().decode("utf-8")).get("name", name)


def patch(workflow, node_id, key, value):
    node = workflow.get(str(node_id))
    if node is None:
        sys.exit(f"× 工作流里没有节点 id={node_id}；可用节点：" +
                 ", ".join(f"{k}({v.get('class_type')})" for k, v in workflow.items()))
    node.setdefault("inputs", {})[key] = value
    return node.get("class_type")


def resolve_prompt_key(workflow, node_id, forced):
    """提示词字段名：`CLIPTextEncode` 是 `text`，`PrimitiveString*` 是 `value` —— 先按实际 inputs 猜，可用 --prompt-key 覆盖。"""
    if forced:
        return forced
    inputs = (workflow.get(str(node_id)) or {}).get("inputs", {})
    for cand in ("text", "value", "prompt", "string"):
        if cand in inputs:
            return cand
    sys.exit(f"× 节点 {node_id} 的 inputs 里没有可识别的提示词字段：{list(inputs)} —— 用 --prompt-key 指定")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workflow", required=True, help="ComfyUI 导出的 API 格式工作流 json")
    ap.add_argument("--csv", default=DEFAULT_CSV)
    ap.add_argument("--prompt-node", required=True, help="吃提示词的节点 id")
    ap.add_argument("--prompt-key", default="", help="提示词字段名（默认按节点 inputs 自动识别：text / value / …）")
    ap.add_argument("--route", choices=["t2i", "edit"], default="t2i")
    ap.add_argument("--load-image-node", help="路线 A：LoadImage 节点 id")
    ap.add_argument("--out", default=os.path.join(ROOT, ".tmp", "relic-icons-out"))
    ap.add_argument("--host", default="http://127.0.0.1:8188")
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 条（0 = 全部）")
    ap.add_argument("--only", default="", help="只跑这些 key（逗号分隔）")
    ap.add_argument("--dry-run", action="store_true", help="只打印补丁结果，不投递")
    ap.add_argument("--timeout", type=int, default=900, help="单张出图等待上限（秒）")
    ap.add_argument("--skip-existing", action="store_true",
                    help="断点续跑：输出目录里已有同名 png（且非空）就跳过 —— 长批量中断后用这个接着跑")
    ap.add_argument("--stall", type=int, default=180,
                    help="单张连续这么久没出结果就判定卡住 → /interrupt 打断后重投（0 = 关）")
    ap.add_argument("--attempts", type=int, default=3, help="单张最多投几次（卡住/任务丢失时重投）")
    ap.add_argument("--free-every", type=int, default=0,
                    help="每 N 张调一次 ComfyUI /free（0 = 从不调，默认）。"
                         "**实测 /free 会把模型逐出显存**，装得下时调它等于每张白付一次重加载"
                         "（9s → 23s）；装不下时才需要靠它/--unload-every 保命。见 free_memory() 的注释")
    ap.add_argument("--unload-every", type=int, default=0,
                    help="每 N 张把模型也卸掉（0 = 从不卸，默认）。"
                         "模型组合装得进显存时**不要开**；装不下时开 1（每张卸，慢 3 倍但不会假死）")
    args = ap.parse_args()

    with open(args.workflow, "r", encoding="utf-8") as fh:
        base_workflow = json.load(fh)

    rows = []
    with open(args.csv, "r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            rows.append(row)
    if args.only:
        wanted = {k.strip() for k in args.only.split(",") if k.strip()}
        rows = [r for r in rows if r["key"] in wanted]
    if args.limit:
        rows = rows[: args.limit]

    field = "prompt_t2i" if args.route == "t2i" else "prompt_edit_zh"
    todo = [r for r in rows if (r.get(field) or "").strip()]
    if args.route == "edit" and not args.load_image_node:
        sys.exit("× 路线 A 需要 --load-image-node")
    os.makedirs(args.out, exist_ok=True)

    if args.skip_existing:
        def done(row):
            dst = os.path.join(args.out, row.get("out_png") or f"{row['key']}.png")
            return os.path.exists(dst) and os.path.getsize(dst) > 1024
        skipped = [r for r in todo if done(r)]
        todo = [r for r in todo if not done(r)]
        if skipped:
            print(f"◆ --skip-existing：跳过已完成的 {len(skipped)} 张")

    print(f"◆ 路线 {args.route}：{len(todo)} 条 / 共 {len(rows)} 条；提示词字段 = {field}")
    prompt_key = resolve_prompt_key(base_workflow, args.prompt_node, args.prompt_key)
    print(f"◆ 提示词节点 {args.prompt_node} 的字段 = inputs.{prompt_key}")

    client_id = uuid.uuid4().hex
    ok = failed = 0
    t_start = time.time()

    if not args.dry_run:
        free_memory(args.host, unload=True)  # 开工前先要一块干净显存（上一条挂掉的尾巴可能还占着）

    for i, row in enumerate(todo, 1):
        workflow = json.loads(json.dumps(base_workflow))  # 深拷贝，逐条独立
        cls = patch(workflow, args.prompt_node, prompt_key, row[field])

        ref = ""
        if args.route == "edit":
            ref = os.path.join(ROOT, row["input_image"]) if row.get("input_image") else ""
            if not os.path.exists(ref):
                print(f"  [{i}/{len(todo)}] 跳过 {row['key']}：参考图不存在（{row.get('input_image') or '无'}）")
                continue
            if args.dry_run:
                patch(workflow, args.load_image_node, "image", os.path.basename(ref))
            else:
                patch(workflow, args.load_image_node, "image", upload_image(args.host, ref))

        if args.dry_run:
            out = os.path.join(args.out, f"dryrun-{row['key']}.json")
            with open(out, "w", encoding="utf-8") as fh:
                json.dump(workflow, fh, ensure_ascii=False, indent=2)
            print(f"  [{i}/{len(todo)}] {row['key']} → 节点 {args.prompt_node}({cls}) "
                  f"{'参考图=' + os.path.basename(ref) if ref else ''} → 补丁写到 {out}")
            continue

        # ---- 投递 → 等结果 → 下载，最多 attempts 次（连接被掐 / 任务丢失 / 假死都重投）----
        t0 = time.time()
        dst = os.path.join(args.out, row.get("out_png") or f"{row['key']}.png")
        saved = False
        for attempt in range(1, args.attempts + 1):
            try:
                res = post_json(f"{args.host}/prompt", {"prompt": workflow, "client_id": client_id}, timeout=120)
            except urllib.error.HTTPError as err:
                body = err.read().decode("utf-8", "ignore")[:400]
                print(f"  [{i}/{len(todo)}] × {row['key']} 投递被拒 {err.code}：{body}")
                break  # 确定性的错，重投也没用
            except Exception as err:  # noqa: BLE001
                print(f"  [{i}/{len(todo)}] × {row['key']} 投递失败（第 {attempt} 次）：{type(err).__name__}: {err}")
                time.sleep(5)
                continue
            prompt_id = res.get("prompt_id")
            t_submit = time.time()

            last_seen = time.time()
            gone_strikes = 0
            files = []
            while True:
                if time.time() - t0 > args.timeout:
                    print(f"  [{i}/{len(todo)}] × {row['key']} 超过 --timeout {args.timeout}s，放弃这一张")
                    break
                try:
                    hist = retry(lambda: get_json(f"{args.host}/history/{prompt_id}", timeout=30),
                                 tries=3, delay=4, what="查历史")
                except Exception as err:  # noqa: BLE001
                    print(f"    · 查历史一直失败（{type(err).__name__}），当作服务端重启，重投")
                    break
                entry = hist.get(prompt_id)
                if entry:
                    for node_out in (entry.get("outputs") or {}).values():
                        files.extend(node_out.get("images") or [])
                    break
                # 没出结果：看它到底还在不在队列里。
                # ⚠ 刚投出去的几秒内 `/queue` 可能还没登记这条任务，此刻判「丢了」是**假阳性** ——
                # 实测踩过：assault 连投 3 次全被判丢失，一张图都没跑（任务其实好好地在跑）。
                # 所以要有宽限期 + 连续两次确认才算丢。
                if time.time() - t_submit < 8:
                    time.sleep(3)
                    continue
                st = queue_state(args.host, prompt_id)
                if st == "gone":
                    gone_strikes += 1
                    if gone_strikes >= 2:
                        print(f"    · 任务已不在队列（服务端重启过），重投 {row['key']}")
                        break
                else:
                    gone_strikes = 0
                if st == "running":
                    if args.stall and time.time() - last_seen > args.stall:
                        print(f"    · 卡住超过 {args.stall}s（显存打满），/interrupt 后重投 {row['key']}")
                        interrupt(args.host)
                        break
                else:
                    last_seen = time.time()  # 还在排队，重新计时
                time.sleep(3)
            if not files:
                continue  # 下一轮 attempt

            for img in files:
                if img.get("type") != "output":
                    continue
                query = urllib.parse.urlencode({
                    "filename": img.get("filename", ""),
                    "subfolder": img.get("subfolder", ""),
                    "type": img.get("type", "output"),
                })
                data = retry(lambda: get_bytes(f"{args.host}/view?{query}"), tries=4, delay=4, what="下载")
                tmp = dst + ".part"
                with open(tmp, "wb") as fh:
                    fh.write(data)  # 先写 .part 再改名：中断不会留下半张图骗过 --skip-existing
                os.replace(tmp, dst)
                print(f"  [{i}/{len(todo)}] √ {row['key']} → {dst}（{len(data) // 1024} KB，"
                      f"{time.time() - t0:.0f}s，第 {attempt} 次投递）")
                saved = True
            if saved:
                break
        if saved:
            ok += 1
        else:
            failed += 1
            print(f"  [{i}/{len(todo)}] × {row['key']} 这一张最终没出图")

        # 每 N 张卸一次模型：显存钉满后整张卡死是长批量最容易翻车的地方（见 free_memory 的注释）
        unload = bool(args.unload_every) and i % args.unload_every == 0
        if unload or (args.free_every and i % args.free_every == 0):
            free_memory(args.host, unload=unload)

    el = time.time() - t_start
    avg = el / max(1, ok + failed)
    print(f"\n◆ 完成 {ok} 张 · 失败 {failed} 张 · 用时 {el / 60:.1f} 分钟（平均 {avg:.0f}s/张）")
    # 自诊断：慢的根因几乎总是"模型没常驻"（装不下 → 每张重新加载），而不是采样慢
    if avg > 40 and not (args.free_every or args.unload_every):
        print("  ⚠ 平均耗时偏高：八成是**模型没常驻**（在每张重新加载权重）。")
        print("    先看模型总大小 vs 显存：UNET + 文本编码器 + VAE 装得下就不该这么慢。")
        print("    装不下 → 换小一档的编码器量化（如 qwen3vl_8b_w4a8 5.88GB 替 8.71GB 的 int8）；")
        print("    实在装不下 → 加 --unload-every 1（每张卸，慢但不会假死）。")
    print(f"◆ 输出目录：{args.out}")
    if failed:
        print("◆ 失败的用 `--skip-existing` 重跑即可（已出的会自动跳过）")
    print("◆ 下一步：统一降到 200×200 覆盖 assets/resources/textures/relics/（见 docs/relic-icon/README.md §7）")


if __name__ == "__main__":
    main()
