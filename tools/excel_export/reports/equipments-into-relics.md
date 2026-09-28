# equipments.json → relics.json 合并报告

> **⚠ 已被后续改造取代（2026-07，同一天）**：本报告记的是**第一步**（装备表并入 `relics`，落成 `scope="outer"` 段、
> id 定为 2001~2045）。随后遗物表又改成**「一件遗物一行」**：局内局外同一件遗物共用 id / icon / 品质，
> 合并行改用**局内 id**（例：铁树枝干 2009 → **1068**），只有局外版的 9 件接在 **1294~1302**，
> 8 件英雄专属装备被删除。**现行 id 以 `relics.json` 为准**，映射见 `reports/relics-scope-restructure.md`。
> 本报告仅作历史留档（词条换算口径 `attributes → kv.attrs` 仍然有效）。

生成时间：2026-09-26T14:11:32.251Z

| 原装备 id | → 遗物 id | 名称 | 品质 | 词条（kv.attrs） | 备注 |
|---|---|---|---|---|---|
| 1 | **2001** | 精密瞄准镜 | legendary（原 quality 2） | 16:2、14:10、16:5% |  |
| 2 | **2002** | 雷神之球 | legendary（原 quality 2） | 3:20、3:5% | 遗留属性 lightningDmg（无 AttributeType）未落 kv.attrs，仅保留在 description |
| 3 | **2003** | 冰霜王冠 | legendary（原 quality 2） | 1:200、9:1.5、1:5%、9:5% |  |
| 4 | **2004** | 赏金面罩 | legendary（原 quality 2） | 8:12、4:20 | allPercent 0.05 未生成（该件只有百分比型属性，基础值为 0 → percent 无效，原本也不生效） |
| 5 | **2005** | 炼金合剂 | legendary（原 quality 2） | 1:300、9:3、6:5、1:5%、9:5%、6:5% |  |
| 6 | **2006** | 幻影双刃 | legendary（原 quality 2） | 14:10、15:50 | allPercent 0.05 未生成（该件只有百分比型属性，基础值为 0 → percent 无效，原本也不生效） |
| 7 | **2007** | 毒龙尖牙 | legendary（原 quality 2） | 3:15、3:5% | 遗留属性 poisonDmg（无 AttributeType）未落 kv.attrs，仅保留在 description |
| 8 | **2008** | 斧王战盾 | legendary（原 quality 2） | 1:250、6:8、1:5%、6:5% |  |
| 9 | **2009** | 铁树枝干 | common（原 quality 1） | 3:2、1:20 |  |
| 10 | **2010** | 敏捷便鞋 | common（原 quality 1） | 3:3 |  |
| 11 | **2011** | 攻击之爪 | common（原 quality 1） | 3:9 |  |
| 12 | **2012** | 阔剑 | rare（原 quality 1.3） | 3:15 |  |
| 13 | **2013** | 恶魔刀锋 | rare（原 quality 1.3） | 3:25 |  |
| 14 | **2014** | 敏捷手套 | epic（原 quality 1.6） | 4:15 |  |
| 15 | **2015** | 秘银锤 | rare（原 quality 1.3） | 3:10 |  |
| 16 | **2016** | 力量手套 | common（原 quality 1） | 1:50 |  |
| 17 | **2017** | 力量腰带 | common（原 quality 1） | 1:100 |  |
| 18 | **2018** | 掠夺者之斧 | rare（原 quality 1.3） | 1:200 |  |
| 19 | **2019** | 锁子甲 | common（原 quality 1） | 6:5 |  |
| 20 | **2020** | 守护指环 | common（原 quality 1） | 6:3 |  |
| 21 | **2021** | 板甲 | rare（原 quality 1.3） | 6:10 |  |
| 22 | **2022** | 水晶剑 | rare（原 quality 1.3） | 3:15 |  |
| 23 | **2023** | 治疗指环 | common（原 quality 1） | 9:2 |  |
| 24 | **2024** | 活力球 | rare（原 quality 1.3） | 1:150、9:1.5 |  |
| 25 | **2025** | 魔龙枪 | rare（原 quality 1.3） | 3:10、16:1.5 |  |
| 26 | **2026** | 闪避护符 | epic（原 quality 1.6） | 8:8 |  |
| 27 | **2027** | 狂战斧 | epic（原 quality 1.6） | 3:35、4:20 |  |
| 28 | **2028** | 代达罗斯之殇 | legendary（原 quality 2） | 3:40、14:15、15:50 |  |
| 29 | **2029** | 蝴蝶 | legendary（原 quality 2） | 3:25、4:25、8:15 |  |
| 30 | **2030** | 恐鳌之心 | legendary（原 quality 2） | 1:400、9:5 |  |
| 31 | **2031** | 强袭胸甲 | legendary（原 quality 2） | 6:15、4:15 |  |
| 32 | **2032** | 希瓦之守护 | legendary（原 quality 2） | 6:20、9:3 |  |
| 33 | **2033** | 金箍棒 | epic（原 quality 1.6） | 3:30、4:20 |  |
| 34 | **2034** | 斯嘉蒂之眼 | legendary（原 quality 2） | 1:150、3:15、4:15 |  |
| 35 | **2035** | 撒旦之锋 | legendary（原 quality 2） | 3:30、1:200 |  |
| 36 | **2036** | 黑皇杖 | epic（原 quality 1.6） | 3:10、1:150、6:5 |  |
| 37 | **2037** | 虚灵刀 | epic（原 quality 1.6） | 3:25、16:1.5 |  |
| 38 | **2038** | 可靠铁锹 | common（原 quality 1） | 3:8、9:1 |  |
| 39 | **2039** | 橡木之心 | rare（原 quality 1.3） | 1:150、6:3 |  |
| 40 | **2040** | 附魔箭袋 | rare（原 quality 1.3） | 16:2 |  |
| 41 | **2041** | 贤者之石 | epic（原 quality 1.6） | 3:15、4:15 |  |
| 42 | **2042** | 恶魔之爪 | epic（原 quality 1.6） | 3:20、14:5 |  |
| 43 | **2043** | 泰坦石板 | legendary（原 quality 2） | 1:250、6:10 |  |
| 44 | **2044** | 海盗帽 | legendary（原 quality 2） | 14:12、4:10 |  |
| 45 | **2045** | 巅峰之器 | legendary（原 quality 2） | 3:30、14:15、3:5% |  |

> 合并 45 件局外装备（id 2001~2045）；局内条目补 `scope="inner"` 298 条。
> **id 变更提醒**：局外收集数据（`DataCenter.equipCollection` 里存的是旧装备 id）需按上表重映射；
> 该模块目前无任何调用方（`addCollected` 从未被调用），属"框架已备、待接线"。

