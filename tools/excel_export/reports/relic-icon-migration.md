# 遗物图标迁移报告（远程 URL → `textures/relics/*`）

- 配表：`assets/resources/tb/relics.json`
- 图标目录：`assets/resources/textures/relics`（png 294 张）
- 路径口径：`textures/relics/<dota2 key>`（**不带扩展名**，与 `units.head_icon` 一致）
- 遗物总行数：307

## 汇总

| 项 | 数量 |
|---|---|
| 本次改为本地路径 | 293 |
| 无本地图（保留远程 URL） | 7 |
| 无图标（本来就没配） | 7 |
| 本地路径但文件缺失 | 0 |

## 无本地图的行（保留远程 URL，只报不改）

> 这 7 件是**局外独有**的中立道具（`scope=outer`），素材站没有对应文件；局外 UI 尚未落地，先保留 URL。

| id | 遗物 | 期望文件名 |
|---|---|---|
| 1294 | 敏捷手套 | gloves_of_haste.png |
| 1295 | 可靠铁锹 | trusty_shovel.png |
| 1297 | 附魔箭袋 | enchanted_quiver.png |
| 1298 | 贤者之石 | philosophers_stone.png |
| 1299 | 恶魔之爪 | imp_claw.png |
| 1301 | 海盗帽 | pirate_hat.png |
| 1302 | 巅峰之器 | apex.png |

## 没有 icon 的行（运行时回落占位图 `textures/skills/bullet`）

| id | 遗物 | scope |
|---|---|---|
| 1 | 荆棘护甲 | inner |
| 2 | 吸血獠牙 | inner |
| 3 | 烈焰之剑 | inner |
| 4 | 巨人之心 | inner |
| 5 | 掌中怜悯 | inner |
| 1296 | 橡木之心 | outer |
| 1300 | 泰坦石板 | outer |

## 明细（本次迁移）

| id | 遗物 | 本地路径 |
|---|---|---|
| 1001 | 压制之刃 | `textures/relics/quelling_blade` |
| 1002 | 圆盾 | `textures/relics/stout_shield` |
| 1003 | 力量手套 | `textures/relics/gauntlets` |
| 1004 | 敏捷便靴 | `textures/relics/slippers` |
| 1005 | 智力斗篷 | `textures/relics/mantle` |
| 1006 | 圆环 | `textures/relics/circlet` |
| 1007 | 守护指环 | `textures/relics/ring_of_protection` |
| 1008 | 回复指环 | `textures/relics/ring_of_regen` |
| 1009 | 贤者面罩 | `textures/relics/sobi_mask` |
| 1010 | 魔棒 | `textures/relics/magic_stick` |
| 1011 | 雨滴 | `textures/relics/infused_raindrop` |
| 1012 | 风灵之纹 | `textures/relics/wind_lace` |
| 1013 | 巫师帽 | `textures/relics/wizard_hat` |
| 1014 | 枯萎之石 | `textures/relics/blight_stone` |
| 1015 | 淬毒之珠 | `textures/relics/orb_of_venom` |
| 1016 | 攻击之爪 | `textures/relics/blades_of_attack` |
| 1017 | 力量腰带 | `textures/relics/belt_of_strength` |
| 1018 | 精灵布带 | `textures/relics/boots_of_elves` |
| 1019 | 法师长袍 | `textures/relics/robe` |
| 1020 | 王冠 | `textures/relics/crown` |
| 1021 | 加速手套 | `textures/relics/gloves` |
| 1022 | 披巾 | `textures/relics/shawl` |
| 1023 | 锁子甲 | `textures/relics/chainmail` |
| 1024 | 速度之靴 | `textures/relics/boots` |
| 1025 | 巫毒面具 | `textures/relics/voodoo_mask` |
| 1026 | 恢复指环 | `textures/relics/ring_of_health` |
| 1027 | 虚无宝石 | `textures/relics/void_stone` |
| 1028 | 裂隙之石 | `textures/relics/chasm_stone` |
| 1029 | 短棍 | `textures/relics/quarterstaff` |
| 1030 | 标枪 | `textures/relics/javelin` |
| 1031 | 吸血面具 | `textures/relics/lifesteal` |
| 1032 | 真视宝石 | `textures/relics/gem` |
| 1033 | 抗魔斗篷 | `textures/relics/cloak` |
| 1034 | 暗影护符 | `textures/relics/shadow_amulet` |
| 1035 | 片甲 | `textures/relics/splintmail` |
| 1036 | 铁意头盔 | `textures/relics/helm_of_iron_will` |
| 1037 | 阔剑 | `textures/relics/broadsword` |
| 1038 | 头冠 | `textures/relics/diadem` |
| 1039 | 食人魔之斧 | `textures/relics/ogre_axe` |
| 1040 | 欢欣之刃 | `textures/relics/blade_of_alacrity` |
| 1041 | 魔力法杖 | `textures/relics/staff_of_wizardry` |
| 1042 | 闪电指节 | `textures/relics/blitz_knuckles` |
| 1043 | 大剑 | `textures/relics/claymore` |
| 1044 | 幽魂权杖 | `textures/relics/ghost` |
| 1045 | 秘银锤 | `textures/relics/mithril_hammer` |
| 1046 | 恐鳌之戒 | `textures/relics/ring_of_tarrasque` |
| 1047 | 赛莉蒙娜之冠 | `textures/relics/tiara_of_selemene` |
| 1048 | 闪烁匕首 | `textures/relics/blink` |
| 1049 | 撼地闪烁 | `textures/relics/overwhelming_blink` |
| 1050 | 疾速闪烁 | `textures/relics/swift_blink` |
| 1051 | 奥术闪烁 | `textures/relics/arcane_blink` |
| 1052 | 治疗莲花 | `textures/relics/famango` |
| 1053 | 大型治疗莲花 | `textures/relics/great_famango` |
| 1054 | 巨型治疗莲花 | `textures/relics/greater_famango` |
| 1055 | 侦查守卫 | `textures/relics/ward_observer` |
| 1056 | 巨型仙灵之火 | `textures/relics/greater_faerie_fire` |
| 1057 | 皇家蜂蜜 | `textures/relics/royal_jelly` |
| 1058 | 修理工具包 | `textures/relics/repair_kit` |
| 1059 | 肉山旗帜 | `textures/relics/roshans_banner` |
| 1060 | 狂石包裹 | `textures/relics/madstone_bundle` |
| 1061 | 芝士块 | `textures/relics/royale_with_cheese` |
| 1062 | 吃树（分享） | `textures/relics/tango_single` |
| 1063 | 鲜血手雷 | `textures/relics/blood_grenade` |
| 1064 | 岗哨守卫 | `textures/relics/ward_sentry` |
| 1065 | 守卫补给包 | `textures/relics/ward_dispenser` |
| 1066 | 动物信使 | `textures/relics/courier` |
| 1067 | 诡计之雾 | `textures/relics/smoke_of_deceit` |
| 1068 | 铁树枝干 | `textures/relics/branches` |
| 1069 | 净化药水 | `textures/relics/clarity` |
| 1070 | 仙灵之火 | `textures/relics/faerie_fire` |
| 1071 | 魔法芒果 | `textures/relics/enchanted_mango` |
| 1072 | 经验之书 | `textures/relics/tome_of_knowledge` |
| 1073 | 显影之尘 | `textures/relics/dust` |
| 1074 | 吃树 | `textures/relics/tango` |
| 1075 | 治疗药膏 | `textures/relics/flask` |
| 1076 | 飞行信使 | `textures/relics/flying_courier` |
| 1077 | 回城卷轴 | `textures/relics/tpscroll` |
| 1078 | 奶酪 | `textures/relics/cheese` |
| 1079 | 刷新碎片 | `textures/relics/refresher_shard` |
| 1080 | 银月之晶 | `textures/relics/moon_shard` |
| 1081 | 芒果树 | `textures/relics/mango_tree` |
| 1082 | 绒毛帽 | `textures/relics/fluffy_hat` |
| 1083 | 能量之球 | `textures/relics/energy_booster` |
| 1084 | 活力之球 | `textures/relics/vitality_booster` |
| 1085 | 精气之球 | `textures/relics/point_booster` |
| 1086 | 闪避护符 | `textures/relics/talisman_of_evasion` |
| 1087 | 板甲 | `textures/relics/platemail` |
| 1088 | 振奋宝石 | `textures/relics/hyperstone` |
| 1089 | 恶魔刀锋 | `textures/relics/demon_edge` |
| 1090 | 极限法球 | `textures/relics/ultimate_orb` |
| 1091 | 鹰歌弓 | `textures/relics/eagle` |
| 1092 | 掠夺者之斧 | `textures/relics/reaver` |
| 1093 | 神秘法杖 | `textures/relics/mystic_staff` |
| 1094 | 圣者遗物 | `textures/relics/relic` |
| 1095 | 寒霜宝珠 | `textures/relics/orb_of_frost` |
| 1096 | 玄冥盾牌 | `textures/relics/buckler` |
| 1097 | 王者之戒 | `textures/relics/ring_of_basilius` |
| 1098 | 回复头巾 | `textures/relics/headdress` |
| 1099 | 魔杖 | `textures/relics/magic_wand` |
| 1100 | 护腕 | `textures/relics/bracer` |
| 1101 | 怨灵系带 | `textures/relics/wraith_band` |
| 1102 | 无用挂件 | `textures/relics/null_talisman` |
| 1103 | 魔瓶 | `textures/relics/bottle` |
| 1104 | 魂戒 | `textures/relics/soul_ring` |
| 1105 | 影之灵龛 | `textures/relics/urn_of_shadows` |
| 1106 | 静谧之鞋 | `textures/relics/tranquil_boots` |
| 1107 | 口袋肉山 | `textures/relics/pocket_roshan` |
| 1108 | 腐蚀之球 | `textures/relics/orb_of_corrosion` |
| 1109 | 猎鹰之刃 | `textures/relics/falcon_blade` |
| 1110 | 丰饶之角 | `textures/relics/cornucopia` |
| 1111 | 帕维斯 | `textures/relics/pavise` |
| 1112 | 动力鞋 | `textures/relics/power_treads` |
| 1113 | 坚韧球 | `textures/relics/pers` |
| 1114 | 阿哈利姆魔晶 | `textures/relics/aghanims_shard` |
| 1115 | 阿哈利姆魔晶（肉山） | `textures/relics/aghanims_shard_roshan` |
| 1116 | 相位鞋 | `textures/relics/phase_boots` |
| 1117 | 秘法鞋 | `textures/relics/arcane_boots` |
| 1118 | 空明杖 | `textures/relics/oblivion_staff` |
| 1119 | 韧鼓 | `textures/relics/ancient_janggo` |
| 1120 | 先锋盾 | `textures/relics/vanguard` |
| 1121 | 纷争面纱 | `textures/relics/veil_of_discord` |
| 1122 | 梅肯斯姆 | `textures/relics/mekansm` |
| 1123 | 精华萃取器 | `textures/relics/essence_distiller` |
| 1124 | 魔龙枪 | `textures/relics/dragon_lance` |
| 1125 | 疯狂面具 | `textures/relics/mask_of_madness` |
| 1126 | 水晶剑 | `textures/relics/lesser_crit` |
| 1127 | 慧光 | `textures/relics/kaya` |
| 1128 | 散华 | `textures/relics/sange` |
| 1129 | 夜叉 | `textures/relics/yasha` |
| 1130 | 微光披风 | `textures/relics/glimmer_cape` |
| 1131 | 迈达斯之手 | `textures/relics/hand_of_midas` |
| 1132 | 弗拉迪米尔的祭品 | `textures/relics/vladmir` |
| 1133 | 原力法杖 | `textures/relics/force_staff` |
| 1134 | 圣洁吊坠 | `textures/relics/holy_locket` |
| 1135 | 阿托斯之棍 | `textures/relics/rod_of_atos` |
| 1136 | 以太之镜 | `textures/relics/aether_lens` |
| 1137 | 刃甲 | `textures/relics/blade_mail` |
| 1138 | 远行鞋 | `textures/relics/travel_boots` |
| 1139 | 臂章 | `textures/relics/armlet` |
| 1140 | 净魂之刃 | `textures/relics/diffusal_blade` |
| 1141 | 支配头盔 | `textures/relics/helm_of_the_dominator` |
| 1142 | 专家阵列 | `textures/relics/specialists_array` |
| 1143 | 炎阳纹章 | `textures/relics/solar_crest` |
| 1144 | 灵匣 | `textures/relics/phylactery` |
| 1145 | 尤尔的神圣权杖 | `textures/relics/cyclone` |
| 1146 | 圣化裹布 | `textures/relics/consecrated_wraps` |
| 1147 | 回音战刃 | `textures/relics/echo_sabre` |
| 1148 | 魂之灵瓮 | `textures/relics/spirit_vessel` |
| 1149 | 巫师之刃 | `textures/relics/witch_blade` |
| 1150 | 陨星锤 | `textures/relics/meteor_hammer` |
| 1151 | 碎颅锤 | `textures/relics/basher` |
| 1152 | 漩涡 | `textures/relics/maelstrom` |
| 1153 | 永恒之盘 | `textures/relics/aeon_disk` |
| 1154 | 灵魂之匣 | `textures/relics/soul_booster` |
| 1155 | 达贡之神力 | `textures/relics/dagon` |
| 1156 | 法师克星 | `textures/relics/mage_slayer` |
| 1157 | 影刃 | `textures/relics/invis_sword` |
| 1158 | 紫怨 | `textures/relics/orchid` |
| 1159 | 英灵胸针 | `textures/relics/revenants_brooch` |
| 1160 | 天堂之戟 | `textures/relics/heavens_halberd` |
| 1161 | 黯灭 | `textures/relics/desolator` |
| 1162 | 洞察烟斗 | `textures/relics/pipe` |
| 1163 | 赤红甲 | `textures/relics/crimson_guard` |
| 1164 | 怨灵契约 | `textures/relics/wraith_pact` |
| 1165 | 清莲宝珠 | `textures/relics/lotus_orb` |
| 1166 | 永世法衣 | `textures/relics/eternal_shroud` |
| 1167 | 狂战斧 | `textures/relics/bfury` |
| 1168 | 黑皇杖 | `textures/relics/black_king_bar` |
| 1169 | 阿哈利姆神杖 | `textures/relics/ultimate_scepter` |
| 1170 | 散夜对剑 | `textures/relics/sange_and_yasha` |
| 1171 | 慧散对剑 | `textures/relics/kaya_and_sange` |
| 1172 | 夜慧对剑 | `textures/relics/yasha_and_kaya` |
| 1173 | 气宇之靴 | `textures/relics/boots_of_bearing` |
| 1174 | 否决挂饰 | `textures/relics/nullifier` |
| 1175 | 飓风长戟 | `textures/relics/hurricane_pike` |
| 1176 | 卫士胫甲 | `textures/relics/guardian_greaves` |
| 1177 | 希瓦的守护 | `textures/relics/shivas_guard` |
| 1178 | 幻影斧 | `textures/relics/manta` |
| 1179 | 冈格尼尔 | `textures/relics/gungir` |
| 1180 | 血精石 | `textures/relics/bloodstone` |
| 1181 | 辉耀 | `textures/relics/radiance` |
| 1182 | 渔叉 | `textures/relics/harpoon` |
| 1183 | 林肯法球 | `textures/relics/sphere` |
| 1184 | 克莱拉牧杖 | `textures/relics/crellas_crozier` |
| 1185 | 奥术之心 | `textures/relics/octarine_core` |
| 1186 | 刷新球 | `textures/relics/refresher` |
| 1187 | 金箍棒 | `textures/relics/monkey_king_bar` |
| 1188 | 撒旦之邪力 | `textures/relics/satanic` |
| 1189 | 恐鳌之心 | `textures/relics/heart` |
| 1190 | 代达罗斯之殇 | `textures/relics/greater_crit` |
| 1191 | 强袭胸甲 | `textures/relics/assault` |
| 1192 | 邪恶镰刀 | `textures/relics/sheepstick` |
| 1193 | 虚灵之刃 | `textures/relics/ethereal_blade` |
| 1194 | 蝴蝶 | `textures/relics/butterfly` |
| 1195 | 雷神之锤 | `textures/relics/mjollnir` |
| 1196 | 坎达 | `textures/relics/angels_demise` |
| 1197 | 圣剑 | `textures/relics/rapier` |
| 1198 | 统御头盔 | `textures/relics/helm_of_the_overlord` |
| 1199 | 白银之锋 | `textures/relics/silver_edge` |
| 1200 | 阿哈利姆福佑 | `textures/relics/ultimate_scepter_2` |
| 1201 | 阿哈利姆福佑（肉山） | `textures/relics/ultimate_scepter_roshan` |
| 1202 | 斯嘉蒂之眼 | `textures/relics/skadi` |
| 1203 | 九头蛇之息 | `textures/relics/hydras_breath` |
| 1204 | 帕拉斯玛 | `textures/relics/devastator` |
| 1205 | 斥散刃 | `textures/relics/disperser` |
| 1206 | 深渊之刃 | `textures/relics/abyssal_blade` |
| 1207 | 三叉戟 | `textures/relics/trident` |
| 1208 | 血棘 | `textures/relics/bloodthorn` |
| 1209 | 风灵法杖 | `textures/relics/wind_waker` |
| 1210 | 碎裂背心 | `textures/relics/chipped_vest` |
| 1211 | 附魂面具 | `textures/relics/possessed_mask` |
| 1212 | 秘仪手环 | `textures/relics/occult_bracelet` |
| 1213 | 瑞斯图尔尖匕 | `textures/relics/dagger_of_ristul` |
| 1214 | 决斗者手套 | `textures/relics/duelist_gloves` |
| 1215 | 蝌蚪护符 | `textures/relics/polliwog_charm` |
| 1216 | 狗头人酒杯 | `textures/relics/kobold_cup` |
| 1217 | 沉睡奇物 | `textures/relics/dormant_curio` |
| 1218 | 加重骰子 | `textures/relics/weighted_dice` |
| 1219 | 余烬军团战盾 | `textures/relics/ash_legion_shield` |
| 1220 | 石羽小包 | `textures/relics/stonefeather_satchel` |
| 1221 | 采菌套具 | `textures/relics/foragers_kit` |
| 1222 | 穷鬼盾 | `textures/relics/poor_mans_shield` |
| 1223 | 勇气勋章 | `textures/relics/medallion_of_courage` |
| 1224 | 精华指环 | `textures/relics/essence_ring` |
| 1225 | 翻腾玩具 | `textures/relics/pogo_stick` |
| 1226 | 宁静种籽 | `textures/relics/seeds_of_serenity` |
| 1227 | 不屈护壳 | `textures/relics/defiant_shell` |
| 1228 | 法力之饮 | `textures/relics/mana_draught` |
| 1229 | 致残之弩 | `textures/relics/crippling_crossbow` |
| 1230 | 炽热纹章 | `textures/relics/searing_signet` |
| 1231 | 火焰斗篷 | `textures/relics/cloak_of_flames` |
| 1232 | 通灵头带 | `textures/relics/psychic_headband` |
| 1233 | 风暴宝器 | `textures/relics/stormcrafter` |
| 1234 | 不倦之眼 | `textures/relics/unrelenting_eye` |
| 1235 | 火药手套 | `textures/relics/gunpowder_gauntlets` |
| 1236 | 锯齿短刀 | `textures/relics/serrated_shiv` |
| 1237 | 基迪花粉袋 | `textures/relics/jidi_pollen_bag` |
| 1238 | 咏咒之坠 | `textures/relics/spellslinger` |
| 1239 | 天游烙印 | `textures/relics/partisans_brand` |
| 1240 | 蒲公英护符 | `textures/relics/dandelion_amulet` |
| 1241 | 回响之笼 | `textures/relics/rattlecage` |
| 1242 | 巨人重锤 | `textures/relics/giant_maul` |
| 1243 | 变态上颚 | `textures/relics/metamorphic_mandible` |
| 1244 | 斯凯奥克神像 | `textures/relics/idol_of_screeauk` |
| 1245 | 剥皮者之靴 | `textures/relics/flayers_bota` |
| 1246 | 先知灵摆 | `textures/relics/prophets_pendulum` |
| 1247 | 附魔师之椟 | `textures/relics/enchanters_bauble` |
| 1248 | 咒术师触媒 | `textures/relics/conjurers_catalyst` |
| 1249 | 冥河黯灭 | `textures/relics/desolator_2` |
| 1250 | 网虫腿 | `textures/relics/spider_legs` |
| 1251 | 冥灵书 | `textures/relics/demonicon` |
| 1252 | 天崩 | `textures/relics/fallen_sky` |
| 1253 | 牛头人之角 | `textures/relics/minotaur_horn` |
| 1254 | 巫毒之刃 | `textures/relics/heavy_blade` |
| 1255 | 德尊血仪 | `textures/relics/dezun_bloodrite` |
| 1256 | 神圣圣衣 | `textures/relics/divine_regalia` |
| 1257 | 影墟棱晶 | `textures/relics/riftshadow_prism` |
| 1258 | 协和 | `textures/relics/harmonizer` |
| 1259 | 不朽之守护 | `textures/relics/aegis` |
| 1260 | 阿哈利姆之书 | `textures/relics/tome_of_aghanim` |
| 1261 | 融合符文 | `textures/relics/fusion_rune` |
| 1262 | 中立装备代币 I | `textures/relics/tier1_token` |
| 1263 | 中立装备代币 II | `textures/relics/tier2_token` |
| 1264 | 中立装备代币 III | `textures/relics/tier3_token` |
| 1265 | 中立装备代币 IV | `textures/relics/tier4_token` |
| 1266 | 中立装备代币 V | `textures/relics/tier5_token` |
| 1267 | 高远 | `textures/relics/enhancement_vast` |
| 1268 | 迅速 | `textures/relics/enhancement_quickened` |
| 1269 | 冒险 | `textures/relics/enhancement_audacious` |
| 1270 | 神秘 | `textures/relics/enhancement_mystical` |
| 1271 | 警觉 | `textures/relics/enhancement_alert` |
| 1272 | 壮实 | `textures/relics/enhancement_brawny` |
| 1273 | 坚强 | `textures/relics/enhancement_tough` |
| 1274 | 狂热 | `textures/relics/enhancement_feverish` |
| 1275 | 捷足 | `textures/relics/enhancement_fleetfooted` |
| 1276 | 粗暴 | `textures/relics/enhancement_crude` |
| 1277 | 无边 | `textures/relics/enhancement_boundless` |
| 1278 | 睿智 | `textures/relics/enhancement_wise` |
| 1279 | 永恒 | `textures/relics/enhancement_timeless` |
| 1280 | 贪婪 | `textures/relics/enhancement_greedy` |
| 1281 | 吸血鬼 | `textures/relics/enhancement_vampiric` |
| 1282 | 犀利 | `textures/relics/enhancement_keen_eyed` |
| 1283 | 进化 | `textures/relics/enhancement_evolved` |
| 1284 | 巨神 | `textures/relics/enhancement_titanic` |
| 1285 | 凶猛 | `textures/relics/enhancement_fierce` |
| 1286 | 主导 | `textures/relics/enhancement_dominant` |
| 1287 | 恢复 | `textures/relics/enhancement_restorative` |
| 1288 | 厚实 | `textures/relics/enhancement_thick` |
| 1289 | 释放 | `textures/relics/enhancement_curious` |
| 1290 | 活力 | `textures/relics/enhancement_vital` |
| 1291 | 笨重 | `textures/relics/enhancement_hulking` |
| 1292 | 癫狂 | `textures/relics/enhancement_manic` |
| 1293 | 轻快 | `textures/relics/enhancement_nimble` |

