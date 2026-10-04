# tools/hit-feel-sfx —— 打击反馈音效的「声音配方 + 离线渲染 + 试听」

**B4 听觉的素材来源。** 11 个音（T0~T7 八档 + 出手 + 闪避 + 全局点击）与 5 个音高变体，
**全部由本目录离线合成**：没有下载任何第三方素材，因此**没有授权义务、也没有风格不搭的问题**。

设计口径（要几个音 / 多长 / 多响 / 音色方向 / 为什么不做低频层）在
`docs/打击反馈设计.md` §12；**运行期数值的唯一真源**是 `assets/scripts/game/common/HitFeelConfig.ts`。

```
tools/hit-feel-sfx/
├── design.mjs        ← 「要什么声音」：11 条配方 + 5 条变体 + 渲染全局设置（合成的唯一真源，不做 DSP）
├── render.mjs        ← 「怎么算」：零依赖 CLI + DSP（移植演示台 §3 的 noiseHit / toneHit）+ `--check`
├── manifest.json     ← 生成物：每条的时长/字节/峰值/RMS/sha256/配方摘要
├── tier-table.json   ← 生成物：从 HitFeelConfig.ts 解析出的档位表快照（渲染器的自检依据）
├── check-drift.mjs   ← 「试听页 ↔ 真源 ↔ 素材」三方对账（可 `--write` 同步试听页）
├── audition.html     ← 试听页（按档位听 / 听合并与节流）
└── README.md         ← 本文件
```

产物落在 **`assets/resources/sfx/*.wav`**（16 个，合计 **139 KB**）。

---

## 1. 怎么听（不需要编辑器、不需要装任何依赖）

- **推荐**：起一个本地静态服务再打开 `tools/hit-feel-sfx/audition.html`
  （任何静态服务器都行，例如 `python -m http.server 8791`，然后访问
  `http://127.0.0.1:8791/tools/hit-feel-sfx/audition.html`），这样 `../../assets/resources/sfx/*.wav` 一定能取到。
- 直接双击 `audition.html`（`file://`）在 Chrome / Firefox 下通常也能播（`<audio>` 不受 XHR 的 `file://` 限制）；
  如果整页没声音，先确认点过页面（浏览器要求先有用户交互），再换成静态服务。

页面上能做的事：逐档试听 / 变体单独试听 / 总音量 / 两个节奏场景（**波次节奏**听"同帧合并"、
**过载**听"节流怎么吞"），以及实时的 响/丢 计数。页内那份节流账本是**为了听感而复制的**，
它不对任何东西负责 —— 权威是 `HitFeelDirector.requestSfx` 与 `npm run audit:hitfeel` 第 ⑰ 组。

## 2. 三道门禁（各管一段，别互相替代）

| 命令 | 管什么 | 什么时候会红 |
|---|---|---|
| `node render.mjs --check` | **字节层**：盘上的 wav 是否 = 现配方渲染的结果；`manifest.json` / `tier-table.json` 是否新鲜；配置引用的键是否都在盘上 | 有人手改了 wav、改了 `design.mjs` 没重渲、改了 `HitFeelConfig.ts` 没重跑、真源解析失败 |
| `node check-drift.mjs` | **口径层**：`HitFeelConfig.ts` ↔ `audition.html` 内嵌快照 ↔ 素材文件集合（**素材门禁**，缺文件即失败） | 改了音量/键名没同步试听页（`--write` 修）、缺文件、多出孤儿 wav、两个解析器对不上 |
| `npm run audit:hitfeel`（第 ⑰ 组） | **代码层**：节流账本真的成立吗（同帧合并、50ms ≤2 声、超限丢弃计数、音量不吃密度 k、只给英雄响出手音） | 逻辑改坏了。**素材缺失只警告不判失败** —— 素材是外部的，不该卡住代码门禁 |

`--check` 与 `check-drift.mjs` 都**绝不写盘**（`check-drift.mjs --write` 除外，那正是它的用途）。

## 3. 改一个音（最常见的三件事）

**① 音色不对**（觉得"太闷/太脆/太长"）
改 `design.mjs` 里那一条配方（`bp()` = 带通噪声层，`sw()` = 扫频音层）→ `node render.mjs` → 回到试听页刷新听。
**不要**改 `render.mjs`：那是 DSP，改它等于动全部 16 条。
改完记得 `node render.mjs --check` 应为绿（它比的是"盘上 = 现配方"，重渲过就一定绿）。

**② 音量/变体数不对**（"普攻太响""暴击要更明显"）
改 `HitFeelConfig.ts` 的档位表 → 依次跑：
```powershell
cd tools/hit-feel-sfx
node render.mjs                 # 让 tier-table.json 跟上真源
node check-drift.mjs --write    # 让试听页跟上真源
node check-drift.mjs            # 确认三方一致
cd ../../tools/excel_export; npm run audit:hitfeel
```

**③ 要加/删一个音**
`design.mjs` 的 `BASE_TABLE` + `SFX_ORDER`（顺序决定渲染与 manifest 的排列）→ `HitFeelConfig.ts` 里挂上键名
→ 上面那一串命令。删音时别忘了把盘上的 wav 一起删（`check-drift.mjs` 会把多出来的文件当**孤儿**报出来）。

**确定性**：噪声用按**键名派生**的种子（`mulberry32`），所以同样的配方永远渲染出**逐字节相同**的文件 ——
重跑不会让 git 里出现 16 个"改了但其实没改"的二进制 diff（本次落地连跑两次已验证哈希一致）。

## 4. 素材口径（与设计文档的一处有意偏差）

| 项 | 值 | 为什么 |
|---|---|---|
| 位置 | `assets/resources/sfx/` | `AudioMgr.playSFX('hit_crit')` 会自己补 `sfx/` 前缀；放在**主包**是有意的：它是主玩法反馈，不该等分包 |
| 格式 | **16-bit PCM WAV** | §12.7 原写 `.ogg`；但 ogg 需要编码器，本工具**零依赖**，而 WAV 对几十毫秒的短音反而最干净（mp3 会在文件头带 ~1100 采样的编码延迟） |
| 采样率 | **22050 Hz 单声道** | §12.7 原写 44.1kHz。全部配方的能量都在 ~5.5kHz 以下 → 22.05k 够用，体积减半（139KB vs ~280KB）；`resources` 是主包，移动端首包敏感 |
| 峰值 | **0.80**（逐条归一化） | 响度差**不烘焙进素材**，由运行期按档位表的 `sfxVolume` 施加（改音量不用重渲） |
| 时长 | 36ms（click）~1357ms（clear），合计 **3.21s** | 均为"干"音：无混响尾巴，-40dB 收尾时刻 18~1075ms |

⚠ **`.meta` 不在本目录管理范围内**：Cocos 编辑器首次导入 `assets/resources/sfx/` 时会自动生成 16 个
`.meta`（含 uuid），**请随提交一起入库** —— 少了它，构建时资源没有 uuid，运行期 `resources.load` 会取不到。

## 5. 授权 / 来源

**全部为本仓库自合成**，`design.mjs` 里的配方参数移植自本仓库自己的
`tools/hit-feel-preview/index.html` §3（那是本作打击感的设计工具），**没有引入任何第三方音频素材**，
因此**没有署名、版税或"仅限非商用"之类的义务**。
（设计文档 §12.6 要求"落库时记来源"：本目录的产品就是那条记录 —— 来源 = 本工具。）

## 6. 已知边界

- **`click` 的音量不在这里**：它由平台层 `AudioMgr.defaultTouchStart` 写死为 0.5（平台层不该反过来依赖游戏层配置），
  试听页里那一行只是"素材要齐"的登记。
- **没有 BGM / 语音**：本批只做打击反馈（B4）。整包音频（BGM、按钮、商店、升级）是另一件事。
- **低频层（E4）不单独出文件**：手机外放对 70Hz 基本无输出，重量做进了 `kill_big` / `hero_hurt` / `clear` 的配方本身。
- **`hero_hurt` 的"不同族"是量化过的**：>1kHz 能量占比 19%（其余音 20%~70%，且它的谱质心只有 147Hz）——
  耳朵上读作"闷、钝、来自我身上"，而不是"打到什么了"。
