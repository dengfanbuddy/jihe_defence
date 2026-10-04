# 遗物图标 · AI 出图提示词清单

> 由 `tools/relic-icon-prompts/gen-prompts.mjs --style cartoon` 从 `subjects.json` 生成，**不要手改本文件**（改描述改 subjects.json 再重跑）。

风格档：**`cartoon`**（可选 `dota` / `dota-muted` / `project`，换档重跑即覆盖本文件的三份产物）。

共 **307** 条（= `relics.json` 全部 307 行）：可直接走「参考图重绘」293 条，只有文生图 14 条。

完整提示词在 `prompts.json` / `prompts.csv`；本文件只列**共享模板**与**逐条主题**，方便肉眼看风格是否跑偏。

## 一、两条路线（同一个主题，两种出图方式）

| 路线 | 输入 | 提示词字段 | 适用 |
|---|---|---|---|
| **A 参考图重绘**（推荐） | 现成的 dota 图标（88×64） | `prompt_edit_zh`（中文指令） | 293 件肉鸽道具 + 7 件局外中立道具 —— 造型最保真 |
| **B 纯文生图** | 无 | `prompt_t2i`（英文散文） | 全部 307 件；也是 9 件没图的遗物（id 1~5 / 1296 / 1300）唯一的路 |

## 二、当前风格档 `cartoon` 的共享风格段（307 条都含这一段；换档改 `gen-prompts.mjs` 的 `STYLE_PRESETS`）

- The object is drawn as a bright cartoon game icon: its shape is built from a few simple chunky geometric volumes that read instantly at small size, and every form is closed by a bold, even, rounded outline of one dark slate tone.
- Colour is applied as flat cel shading: each surface carries one solid base colour plus at most one darker flat tone, with a hard clean edge between them and no soft blending anywhere.
- The surfaces stay completely clean: no scratches, no grain, no stitched creases, no rust, no grime, no wear and no painted texture, and no gradient, glow or specular highlight appears anywhere in the picture.
- The image is cheerful and simple rather than moody: the shapes are rounded and friendly, and the object keeps a solid mid-valued body closed by a strong dark outline, so both its silhouette and its interior stay legible when the icon is scaled down to a small square.
- The palette is cheerful but sits in the middle of the value range rather than at the top of it: each material takes a solid mid-tone such as steel blue-grey, warm ochre, mid brown wood, muted teal or terracotta, the pale tone appears only as a highlight on the lit edge, and the object reads as a mid-valued shape with a clear light-and-dark structure; no neon, no pastel wash and no muddy near-black fill is used.
- The light is clear and even and comes from the front and slightly above: the lit surface is the flat base colour, the shaded surface is one flat step darker and covers roughly the shaded third of the shape, and the object casts no shadow onto the empty field around it.
- The overall composition is a single centred object on a transparent square field, brightly lit and easy to read, with even margins all round and the friendly, tidy look of a casual mobile game item icon.
- The whole silhouette stops short of every edge, leaving a margin of roughly one tenth of the frame empty on the left, on the right, above and below, so the object never touches the border of the square.

背景段（每条都有）：Nothing else appears in the frame: the field around the object is fully transparent, with no backdrop, no ground plane, no horizon, no floor shadow and no border, so the empty area shows evenly to the left, to the right, above and below the object.

## 三、逐条主题（`kind` 决定摆位与朝向句）

| # | id | key | 中文名 | English | kind | 主题（英文视觉描述，插进模板 anchor 句） |
|---|---|---|---|---|---|---|
| 1 | 1 | `thorn_mail` | 荆棘护甲 | Thorn Mail | armor | a dark chest plate with rows of short curved thorns growing outward from its surface |
| 2 | 2 | `vampire_fang` | 吸血獠牙 | Vampire Fang | organ | a pair of long curved fangs crossed over each other, a deep red seam running down one |
| 3 | 3 | `flame_sword` | 烈焰之剑 | Flame Sword | weapon_melee | a broad straight sword with angular flame tongues rising along both edges of the blade |
| 4 | 4 | `giant_heart` | 巨人之心 | Giant's Heart | organ | a large stone-grey heart shaped crystal with thick blocky facets and a pale vertical seam |
| 5 | 5 | `palm_mercy` | 掌中怜悯 | Mercy in Palm | misc | an open hand held palm upward with a small bright ember resting in the middle of it |
| 6 | 1001 | `quelling_blade` | 压制之刃 | Quelling Blade | weapon_melee | a short single-bitted woodcutter's axe, a chipped grey steel head on a stubby dark wooden handle with a leather wrist loop |
| 7 | 1002 | `stout_shield` | 圆盾 | Stout Shield | shield | a small round wooden shield, iron rim strips and a domed iron boss at its centre, worn planks across the face |
| 8 | 1003 | `gauntlets` | 力量手套 | Gauntlets of Strength | garment | a single heavy leather work glove, thick padded knuckles and small iron studs along the back of the hand |
| 9 | 1004 | `slippers` | 敏捷便靴 | Slippers of Agility | boots | a light soft leather slipper with a thin sole and a pointed upturned toe, laced with a single cord |
| 10 | 1005 | `mantle` | 智力斗篷 | Mantle of Intelligence | garment | a short hooded cloak folded into a compact bundle, soft blue-grey cloth closed by a small silver clasp |
| 11 | 1006 | `circlet` | 圆环 | Circlet | jewelry | a slender silver circlet of thin wire, one small round blue gem set at its front |
| 12 | 1007 | `ring_of_protection` | 守护指环 | Ring of Protection | jewelry | a plain thick iron band ring with a flattened shield-like face and faint hammer marks |
| 13 | 1008 | `ring_of_regen` | 回复指环 | Ring of Regen | jewelry | a small gold ring set with a round green gem in a raised claw setting |
| 14 | 1009 | `sobi_mask` | 贤者面罩 | Sage's Mask | garment | a carved wooden face mask with narrow slanted eye slits, dark stained grain and small bone inlays at the brow |
| 15 | 1010 | `magic_stick` | 魔棒 | Magic Stick | staff | a short wooden wand bound with a strip of pale cloth near the grip, a small amber bead fixed at the tip |
| 16 | 1011 | `infused_raindrop` | 雨滴 | Infused Raindrops | gem | a single teardrop-shaped crystal droplet of pale blue glass with a bright core |
| 17 | 1012 | `wind_lace` | 风灵之纹 | Wind Lace | jewelry | a small feather charm of three pale plumes bound to a braided cord with a bead |
| 18 | 1013 | `wizard_hat` | 巫师帽 | Wizard Hat | garment | a tall pointed wizard's hat with a wide bent brim and a broad buckled band |
| 19 | 1014 | `blight_stone` | 枯萎之石 | Orb of Blight | gem | a rough dull-green stone orb with a pitted cracked surface and dark seams |
| 20 | 1015 | `orb_of_venom` | 淬毒之珠 | Orb of Venom | gem | a small round orb of green venom, a darker green core suspended inside the glassy surface |
| 21 | 1016 | `blades_of_attack` | 攻击之爪 | Blades of Attack | weapon_melee | a pair of curved grey steel claw blades mounted on a hand grip, edges notched from use |
| 22 | 1017 | `belt_of_strength` | 力量腰带 | Belt of Strength | garment | a heavy brown leather belt with a large square iron buckle and a row of rivets |
| 23 | 1018 | `boots_of_elves` | 精灵布带 | Band of Elvenskin | garment | a band of pale striped cloth looped into a roll, its ends bound with a thin cord |
| 24 | 1019 | `robe` | 法师长袍 | Robe of the Magi | garment | a deep blue mage's robe with wide hanging sleeves, a gold trim edge and a small collar clasp |
| 25 | 1020 | `crown` | 王冠 | Crown | jewelry | a small gold crown of three points, each point capped with a bead and one red gem at the centre |
| 26 | 1021 | `gloves` | 加速手套 | Gloves of Haste | garment | a pair of light tan leather gloves with open fingers and stitched cuffs |
| 27 | 1022 | `shawl` | 披巾 | Shawl | garment | a folded shawl of soft pale cloth with a fringed hem and a fine woven pattern |
| 28 | 1023 | `chainmail` | 锁子甲 | Chainmail | armor | a folded shirt of interlocking grey iron rings with a short slit collar |
| 29 | 1024 | `boots` | 速度之靴 | Boots of Speed | boots | a single brown leather boot with a folded cuff, a low heel and cross-strap lacing |
| 30 | 1025 | `voodoo_mask` | 巫毒面具 | Voodoo Mask | garment | a tribal mask of dark wood with bared bone teeth, a feathered brow and painted bands |
| 31 | 1026 | `ring_of_health` | 恢复指环 | Ring of Health | jewelry | a heavy gold ring set with a square red gem held by four small prongs |
| 32 | 1027 | `void_stone` | 虚无宝石 | Void Stone | gem | a dark violet gem cut into a tall faceted oval, its centre almost black |
| 33 | 1028 | `chasm_stone` | 裂隙之石 | Chasm Stone | gem | a split grey stone disc with a deep dark crevice running through it and rough broken edges |
| 34 | 1029 | `quarterstaff` | 短棍 | Quarterstaff | weapon_melee | a plain straight wooden staff with iron caps at both ends and leather wraps at the grips |
| 35 | 1030 | `javelin` | 标枪 | Javelin | weapon_ranged | a light throwing javelin with a narrow leaf-shaped steel head and a feathered tail binding |
| 36 | 1031 | `lifesteal` | 吸血面具 | Morbid Mask | garment | a pale bone-white face mask with narrow red eye slits and a hooked nose ridge |
| 37 | 1032 | `gem` | 真视宝石 | Gem of True Sight | gem | a bright cut blue-white gem in a round faceted brilliant shape with a flat top |
| 38 | 1033 | `cloak` | 抗魔斗篷 | Cloak | garment | a hooded cloak of dark blue cloth with a silver border band and a deep folded hood |
| 39 | 1034 | `shadow_amulet` | 暗影护符 | Shadow Amulet | jewelry | a small dark obsidian amulet on a cord, a shallow carved face on its polished face |
| 40 | 1035 | `splintmail` | 片甲 | Splintmail | armor | overlapping rectangular steel splints riveted in rows onto a dark leather backing |
| 41 | 1036 | `helm_of_iron_will` | 铁意头盔 | Helm of Iron Will | helm | a plain iron cap helmet with riveted bands and a short straight nose guard |
| 42 | 1037 | `broadsword` | 阔剑 | Broadsword | weapon_melee | a wide straight double-edged sword with a short simple crossguard and a wrapped grip |
| 43 | 1038 | `diadem` | 头冠 | Diadem | jewelry | a jewelled golden diadem set with a row of alternating small round gems |
| 44 | 1039 | `ogre_axe` | 食人魔之斧 | Ogre Axe | weapon_melee | a crude heavy axe with a chipped thick blade, iron banding and a knotted wooden haft |
| 45 | 1040 | `blade_of_alacrity` | 欢欣之刃 | Blade of Alacrity | weapon_melee | a slim curved blade of pale green-grey steel with a slender swept hilt |
| 46 | 1041 | `staff_of_wizardry` | 魔力法杖 | Staff of Wizardry | staff | a tall wooden staff topped by a blue crystal orb held in a three-claw metal mount |
| 47 | 1042 | `blitz_knuckles` | 闪电指节 | Blitz Knuckles | weapon_melee | a set of iron knuckle dusters, the grip cut with a small lightning-bolt shaped opening |
| 48 | 1043 | `claymore` | 大剑 | Claymore | weapon_melee | a long two-handed straight sword with a wide guard and a dark leather-wrapped grip |
| 49 | 1044 | `ghost` | 幽魂权杖 | Ghost Scepter | staff | a pale sceptre with a small skull finial, its shaft shaped like a thin bone with a claw foot |
| 50 | 1045 | `mithril_hammer` | 秘银锤 | Mithril Hammer | weapon_melee | a bright silver war hammer with a heavy square head and a short wooden haft |
| 51 | 1046 | `ring_of_tarrasque` | 恐鳌之戒 | Ring of Tarrasque | jewelry | a heavy gold ring whose face is carved into a snarling beast head |
| 52 | 1047 | `tiara_of_selemene` | 赛莉蒙娜之冠 | Tiara of Selemene | jewelry | a delicate crescent tiara of thin silver arms set with three pale moonstones |
| 53 | 1048 | `blink` | 闪烁匕首 | Blink Dagger | weapon_melee | a curved dagger with a wide winged guard and a purple gem set in the pommel |
| 54 | 1049 | `overwhelming_blink` | 撼地闪烁 | Overwhelming Blink | weapon_melee | a heavy ceremonial dagger with a broad chipped blade and a red crystal fixed in the guard |
| 55 | 1050 | `swift_blink` | 疾速闪烁 | Swift Blink | weapon_melee | a slim dagger with three feathers bound at the pommel and a green gem in the guard |
| 56 | 1051 | `arcane_blink` | 奥术闪烁 | Arcane Blink | weapon_melee | a runed dagger with a blue crystal embedded in the flat of the blade and etched lines along the spine |
| 57 | 1052 | `famango` | 治疗莲花 | Healing Lotus | plant | a single pink lotus blossom with layered rounded petals opening around a pale centre |
| 58 | 1053 | `great_famango` | 大型治疗莲花 | Great Healing Lotus | plant | a large lotus bloom with two rings of petals and a bright golden seed core |
| 59 | 1054 | `greater_famango` | 巨型治疗莲花 | Greater Healing Lotus | plant | a huge lotus flower with broad overlapping petals fanning out around a raised centre |
| 60 | 1055 | `ward_observer` | 侦查守卫 | Observer Ward | ward | a short wooden ward totem carved with a single wide eye, standing on a pointed stake bound with cord |
| 61 | 1056 | `greater_faerie_fire` | 巨型仙灵之火 | Greater Faerie Fire | consumable | a small clay pot holding a bright pale blue flame that rises above the rim |
| 62 | 1057 | `royal_jelly` | 皇家蜂蜜 | Royal Jelly | consumable | a wedge of golden honeycomb resting in a shallow dish, its cells open and glossy |
| 63 | 1058 | `repair_kit` | 修理工具包 | Repair Kit | consumable | a rolled canvas tool wrap with a hammer, a wrench and a few nails poking out of the top |
| 64 | 1059 | `roshans_banner` | 肉山旗帜 | Roshan's Banner | banner | a torn crimson battle banner on a short pole, a horned beast skull painted across the cloth |
| 65 | 1060 | `madstone_bundle` | 狂石包裹 | Madstone Bundle | gem | a bundle of rough red crystal shards tied together with a dark cord |
| 66 | 1061 | `royale_with_cheese` | 芝士块 | Block of Cheese | consumable | a thick yellow wedge of cheese with round holes and a waxed rind |
| 67 | 1062 | `tango_single` | 吃树（分享） | Tango (Shared) | plant | a small bundle of green herb leaves tied at the stems with a strip of twine |
| 68 | 1063 | `blood_grenade` | 鲜血手雷 | Blood Grenade | consumable | a round glass grenade filled with dark red liquid, a short fuse cord through its neck |
| 69 | 1064 | `ward_sentry` | 岗哨守卫 | Sentry Ward | ward | a squat wooden sentry ward carved with a narrow slit eye, bound with blue cloth and set on a stake |
| 70 | 1065 | `ward_dispenser` | 守卫补给包 | Observer and Sentry Wards | ward | an open cloth satchel holding two small wooden ward totems, their carved heads showing above the rim |
| 71 | 1066 | `courier` | 动物信使 | Animal Courier | creature | a small pack donkey carrying a strapped canvas satchel and a tiny lantern on its back |
| 72 | 1067 | `smoke_of_deceit` | 诡计之雾 | Smoke of Deceit | consumable | a squat dark glass bottle with a cork stopper, grey vapour curling out from around the neck |
| 73 | 1068 | `branches` | 铁树枝干 | Iron Branch | plant | three thin bare wooden branches tied together in a bundle, cut ends showing growth rings |
| 74 | 1069 | `clarity` | 净化药水 | Clarity | consumable | a slim blue glass potion bottle with a cork stopper and a paper label band |
| 75 | 1070 | `faerie_fire` | 仙灵之火 | Faerie Fire | consumable | a tiny blue flame hovering in a small earthen pot with a chipped rim |
| 76 | 1071 | `enchanted_mango` | 魔法芒果 | Enchanted Mango | plant | a ripe golden mango with a single dark leaf at the stem and a soft blush on one side |
| 77 | 1072 | `tome_of_knowledge` | 经验之书 | Tome of Knowledge | book | a thick closed book with a metal corner clasp, a ribbon bookmark and a plain cover |
| 78 | 1073 | `dust` | 显影之尘 | Dust of Appearance | consumable | a small leather pouch tipped sideways, pale fine powder spilling from its open mouth |
| 79 | 1074 | `tango` | 吃树 | Tango | plant | a tied bundle of green herb leaves with a short wooden tag on the cord |
| 80 | 1075 | `flask` | 治疗药膏 | Healing Salve | consumable | a round glass flask of thick red salve with a cork stopper and a corded neck |
| 81 | 1076 | `flying_courier` | 飞行信使 | Flying Courier | creature | a small winged courier with spread feathered wings above a strapped canvas satchel |
| 82 | 1077 | `tpscroll` | 回城卷轴 | Town Portal Scroll | book | a rolled parchment scroll tied with a blue ribbon and sealed with a round wax stamp |
| 83 | 1078 | `cheese` | 奶酪 | Cheese | consumable | a thick wedge of pale cheese with a bite taken out of one corner and a rind along the back |
| 84 | 1079 | `refresher_shard` | 刷新碎片 | Refresher Shard | gem | a jagged blue crystal shard with sharp facets and a bright pale core |
| 85 | 1080 | `moon_shard` | 银月之晶 | Moon Shard | gem | a crescent-moon shaped silver crystal, its inner curve polished and its outer edge rough |
| 86 | 1081 | `mango_tree` | 芒果树 | Mango Tree | plant | a small potted mango tree with a short trunk, a few broad leaves and two ripe fruit |
| 87 | 1082 | `fluffy_hat` | 绒毛帽 | Fluffy Hat | garment | a soft round white fur hat with folded ear flaps and a stitched brim |
| 88 | 1083 | `energy_booster` | 能量之球 | Energy Booster | gem | a bright blue orb of dense energy with a lighter core and a smooth polished surface |
| 89 | 1084 | `vitality_booster` | 活力之球 | Vitality Booster | gem | a deep red orb of solid vitality with a warm bright centre |
| 90 | 1085 | `point_booster` | 精气之球 | Point Booster | gem | a pale green orb of clear glassy substance with a small dark core |
| 91 | 1086 | `talisman_of_evasion` | 闪避护符 | Talisman of Evasion | jewelry | a winged silver talisman hung on a fine chain, its face cut with a shallow spiral |
| 92 | 1087 | `platemail` | 板甲 | Platemail | armor | a folded suit of polished plate armour with ridged shoulder pieces and a segmented skirt |
| 93 | 1088 | `hyperstone` | 振奋宝石 | Hyperstone | gem | a bright red faceted gem cut in a tall pointed shape with a hot lighter centre |
| 94 | 1089 | `demon_edge` | 恶魔刀锋 | Demon Edge | weapon_melee | a jagged dark blade with a saw-toothed edge and a hooked tip, a horned guard at the hilt |
| 95 | 1090 | `ultimate_orb` | 极限法球 | Ultimate Orb | gem | a plain grey-white orb of even matte surface with faint cloudy bands inside |
| 96 | 1091 | `eagle` | 鹰歌弓 | Eaglesong | weapon_ranged | a curved horn bow with feathered tips and a braided string |
| 97 | 1092 | `reaver` | 掠夺者之斧 | Reaver | weapon_melee | a massive axe with a jagged crescent blade, iron bands on the haft and a small skull pommel |
| 98 | 1093 | `mystic_staff` | 神秘法杖 | Mystic Staff | staff | a dark wooden staff crowned with a purple crystal held in a clawed setting |
| 99 | 1094 | `relic` | 圣者遗物 | Sacred Relic | weapon_melee | a curved golden blade fragment with a bright polished edge and a red gem set at the break |
| 100 | 1095 | `orb_of_frost` | 寒霜宝珠 | Orb of Frost | gem | a pale blue orb of frost with a cluster of small ice shards frozen around its base |
| 101 | 1096 | `buckler` | 玄冥盾牌 | Buckler | shield | a small round metal buckler with a raised domed centre and rivets around the rim |
| 102 | 1097 | `ring_of_basilius` | 王者之戒 | Ring of Basilius | jewelry | a gold ring set with a blue gem, a small three-point crown motif on the band |
| 103 | 1098 | `headdress` | 回复头巾 | Headdress | garment | a cloth headband of pale linen with a small red gem fixed at the brow |
| 104 | 1099 | `magic_wand` | 魔杖 | Magic Wand | staff | a short wooden wand whose tip holds a green gem in a three-claw metal setting |
| 105 | 1100 | `bracer` | 护腕 | Bracer | garment | a leather arm bracer plated with three iron strips and closed by two buckled straps |
| 106 | 1101 | `wraith_band` | 怨灵系带 | Wraith Band | jewelry | a slender pale armband of ghostly cloth with a single small dark gem at its centre |
| 107 | 1102 | `null_talisman` | 无用挂件 | Null Talisman | jewelry | a small dark talisman on a cord with a single dim gem set in its flat face |
| 108 | 1103 | `bottle` | 魔瓶 | Bottle | consumable | a round glass bottle with a cork stopper and a shallow pool of liquid at the bottom |
| 109 | 1104 | `soul_ring` | 魂戒 | Soul Ring | jewelry | a dark iron ring set with a square green soulstone, small studs around the band |
| 110 | 1105 | `urn_of_shadows` | 影之灵龛 | Urn of Shadows | consumable | a small bone-white funerary urn with dark iron bands and a fitted lid |
| 111 | 1106 | `tranquil_boots` | 静谧之鞋 | Tranquil Boots | boots | a soft pale leather boot with a small wing motif at the ankle and two buckled straps |
| 112 | 1107 | `pocket_roshan` | 口袋肉山 | Pocket Roshan | creature | a miniature horned beast statue standing on a small stone base, thick arms folded across its chest |
| 113 | 1108 | `orb_of_corrosion` | 腐蚀之球 | Orb of Corrosion | gem | a rusty green orb with corroded pitted surface and thick droplets hanging from its underside |
| 114 | 1109 | `falcon_blade` | 猎鹰之刃 | Falcon Blade | weapon_melee | a straight sword with a falcon-head crossguard and rows of small feather shapes along the guard |
| 115 | 1110 | `cornucopia` | 丰饶之角 | Cornucopia | consumable | a curved horn of plenty tipped over, round fruit and leaves spilling from its mouth |
| 116 | 1111 | `pavise` | 帕维斯 | Pavise | shield | a tall rectangular standing shield of banded wood with iron edging and a narrow vision slot |
| 117 | 1112 | `power_treads` | 动力鞋 | Power Treads | boots | a sturdy brown boot whose ankle strap carries three small gems in different tones |
| 118 | 1113 | `pers` | 坚韧球 | Perseverance | jewelry | a heavy gold ring threaded onto a short chain, a dark gem hanging as its pendant |
| 119 | 1114 | `aghanims_shard` | 阿哈利姆魔晶 | Aghanim's Shard | gem | a jagged bright blue crystal shard with long facets and a pale inner core |
| 120 | 1115 | `aghanims_shard_roshan` | 阿哈利姆魔晶（肉山） | Aghanim's Shard - Consumable | gem | a jagged blue crystal shard with a horned beast sigil carved into its flat face |
| 121 | 1116 | `phase_boots` | 相位鞋 | Phase Boots | boots | a dark leather boot with a small angular blade fin at the heel and a strapped ankle |
| 122 | 1117 | `arcane_boots` | 秘法鞋 | Arcane Boots | boots | a sturdy boot with a large blue gem set into the ankle strap and a plated toe cap |
| 123 | 1118 | `oblivion_staff` | 空明杖 | Oblivion Staff | staff | a dark wooden staff topped with a small skull finial and a purple gem in its brow |
| 124 | 1119 | `ancient_janggo` | 韧鼓 | Drum of Endurance | consumable | a small hand drum with a taut skin head, tightened by cords and hung with a beater |
| 125 | 1120 | `vanguard` | 先锋盾 | Vanguard | shield | a heavy round shield with a domed iron boss, layered rim plates and a row of rivets |
| 126 | 1121 | `veil_of_discord` | 纷争面纱 | Veil of Discord | garment | a purple cloth veil with a beaded brow band and a small gem hanging at its centre |
| 127 | 1122 | `mekansm` | 梅肯斯姆 | Mekansm | helm | a golden ceremonial helm with a red gem at the brow and a fan-shaped crest above it |
| 128 | 1123 | `essence_distiller` | 精华萃取器 | Essence Distiller | consumable | a glass distilling apparatus of tubes and a bulb, green liquid pooled in the lower flask |
| 129 | 1124 | `dragon_lance` | 魔龙枪 | Dragon Lance | weapon_ranged | a long lance with a dragon-head socket, overlapping scale bands and a red gem at the collar |
| 130 | 1125 | `mask_of_madness` | 疯狂面具 | Mask of Madness | garment | a horned mask with a wide grinning mouth, a red gem set between the horns |
| 131 | 1126 | `lesser_crit` | 水晶剑 | Crystalys | weapon_melee | a sword whose blade is a single translucent crystal, a slim guard of pale metal at the hilt |
| 132 | 1127 | `kaya` | 慧光 | Kaya | weapon_melee | a slender curved blade of pale violet crystal with a fine wire guard and a short grip |
| 133 | 1128 | `sange` | 散华 | Sange | weapon_melee | a heavy red-tinted cleaver blade with a thick spine and a cord-wrapped grip |
| 134 | 1129 | `yasha` | 夜叉 | Yasha | weapon_melee | a slim pale blue blade swept into a double curve, its hilt bound in pale cloth |
| 135 | 1130 | `glimmer_cape` | 微光披风 | Glimmer Cape | garment | a hooded cape of pale shimmering cloth with a wide collar and a small clasp at the throat |
| 136 | 1131 | `hand_of_midas` | 迈达斯之手 | Hand of Midas | garment | a golden gauntlet shaped like a hand, its palm open and a coin resting in it |
| 137 | 1132 | `vladmir` | 弗拉迪米尔的祭品 | Vladmir's Offering | helm | a dark iron helm with two curved horns and a short red banner rising from its crest |
| 138 | 1133 | `force_staff` | 原力法杖 | Force Staff | staff | a wooden staff with a white gem fixed in a ring mount at the top and carved bands below |
| 139 | 1134 | `holy_locket` | 圣洁吊坠 | Holy Locket | jewelry | a heart-shaped metal locket on a fine chain, a red gem set into its hinged face |
| 140 | 1135 | `rod_of_atos` | 阿托斯之棍 | Rod of Atos | staff | a short wooden rod banded with iron, a green gem held at the top between two prongs |
| 141 | 1136 | `aether_lens` | 以太之镜 | Aether Lens | gem | a round lens in a brass frame with a ring of small notches around the rim |
| 142 | 1137 | `blade_mail` | 刃甲 | Blade Mail | armor | a dark chest piece set with rows of outward-pointing blades along the shoulders and ribs |
| 143 | 1138 | `travel_boots` | 远行鞋 | Boots of Travel | boots | a brown leather boot with small feathered wings at the heel and a blue gem on the cuff |
| 144 | 1139 | `armlet` | 臂章 | Armlet of Mordiggian | jewelry | a heavy iron armlet with short spikes along its edge and a red gem set in the plate |
| 145 | 1140 | `diffusal_blade` | 净魂之刃 | Diffusal Blade | weapon_melee | a curved pale blade with a faint blue sheen, its hilt bound in pale ribbon |
| 146 | 1141 | `helm_of_the_dominator` | 支配头盔 | Helm of the Dominator | helm | a horned helm with a closed face plate and a red gem centred on the brow band |
| 147 | 1142 | `specialists_array` | 专家阵列 | Specialist's Array | weapon_ranged | a fan of four slim throwing blades held in a stitched leather sheath |
| 148 | 1143 | `solar_crest` | 炎阳纹章 | Solar Crest | jewelry | a round medallion with a raised sunburst face and a red gem at its centre |
| 149 | 1144 | `phylactery` | 灵匣 | Phylactery | consumable | a small stoppered vessel of dark green glass bound with two bone bands |
| 150 | 1145 | `cyclone` | 尤尔的神圣权杖 | Eul's Scepter of Divinity | staff | a tall wooden staff crowned with a small spiral cyclone ornament above a ring collar |
| 151 | 1146 | `consecrated_wraps` | 圣化裹布 | Consecrated Wraps | garment | a roll of pale bandage cloth with a golden emblem stitched onto the outer wrap |
| 152 | 1147 | `echo_sabre` | 回音战刃 | Echo Sabre | weapon_melee | a curved sabre with a doubled blade edge, a green gem set in the guard |
| 153 | 1148 | `spirit_vessel` | 魂之灵瓮 | Spirit Vessel | consumable | a green glazed vessel with iron bands, a small pale flame rising above its mouth |
| 154 | 1149 | `witch_blade` | 巫师之刃 | Witch Blade | weapon_melee | a curved blade coated in a green tarnish, a small gem fixed where the blade meets the guard |
| 155 | 1150 | `meteor_hammer` | 陨星锤 | Meteor Hammer | weapon_melee | a war hammer whose head is a cracked stone meteor with a short chain hanging from the haft |
| 156 | 1151 | `basher` | 碎颅锤 | Skull Basher | weapon_melee | a heavy mace with a horned skull-shaped head mounted on a banded iron haft |
| 157 | 1152 | `maelstrom` | 漩涡 | Maelstrom | weapon_melee | a mace with a forked head, two angular lightning-bolt shapes springing from the top |
| 158 | 1153 | `aeon_disk` | 永恒之盘 | Aeon Disk | jewelry | a thick round disc with toothed gear edges and a blue gem set in its centre |
| 159 | 1154 | `soul_booster` | 灵魂之匣 | Soul Booster | gem | a green orb with a bright pale core, held in a clawed metal setting at its base |
| 160 | 1155 | `dagon` | 达贡之神力 | Dagon | staff | a red-lacquered wand with a small skull finial and a red gem set in the skull's brow |
| 161 | 1156 | `mage_slayer` | 法师克星 | Mage Slayer | weapon_melee | a curved grey blade with a notched back edge and a green gem in the crossguard |
| 162 | 1157 | `invis_sword` | 影刃 | Shadow Blade | weapon_melee | a dark sword whose blade fades into pale drifting smoke toward the tip |
| 163 | 1158 | `orchid` | 紫怨 | Orchid Malevolence | weapon_melee | a purple-crystal blade with a stylised orchid flower worked into the guard |
| 164 | 1159 | `revenants_brooch` | 英灵胸针 | Revenant's Brooch | jewelry | a green brooch with a small carved ghost face inside its oval frame |
| 165 | 1160 | `heavens_halberd` | 天堂之戟 | Heaven's Halberd | weapon_melee | a halberd with a broad axe head and a spear point, rows of feather shapes along the socket |
| 166 | 1161 | `desolator` | 黯灭 | Desolator | weapon_melee | a heavy black blade with a corroded pitted edge and a wrapped two-handed grip |
| 167 | 1162 | `pipe` | 洞察烟斗 | Pipe of Insight | consumable | a long-stemmed smoking pipe with a deep bowl, a green gem set into the bowl's band |
| 168 | 1163 | `crimson_guard` | 赤红甲 | Crimson Guard | shield | a round shield lacquered deep red with a domed iron boss and a ring of rivets |
| 169 | 1164 | `wraith_pact` | 怨灵契约 | Wraith Pact | banner | a dark wooden totem carved with a hooded wraith face and hung with two small charms |
| 170 | 1165 | `lotus_orb` | 清莲宝珠 | Lotus Orb | gem | a blue crystal orb wrapped in an open ring of lotus petals |
| 171 | 1166 | `eternal_shroud` | 永世法衣 | Eternal Shroud | garment | a dark hooded shroud whose opening reveals a pale blank face, cloth hanging in heavy folds |
| 172 | 1167 | `bfury` | 狂战斧 | Battle Fury | weapon_melee | a heavy two-handed broadaxe, a wide crescent steel head pierced by two round cut-outs, a dark wooden haft bound in leather |
| 173 | 1168 | `black_king_bar` | 黑皇杖 | Black King Bar | weapon_melee | a massive dark iron club with a squared head, a red gem set into its face |
| 174 | 1169 | `ultimate_scepter` | 阿哈利姆神杖 | Aghanim's Scepter | staff | a golden scepter topped with a blue gem held in a clawed crown mount |
| 175 | 1170 | `sange_and_yasha` | 散夜对剑 | Sange and Yasha | weapon_melee | a crossed pair of blades, a heavy red cleaver laid over a slim pale blue curved sword |
| 176 | 1171 | `kaya_and_sange` | 慧散对剑 | Kaya and Sange | weapon_melee | a crossed pair of blades, a slender violet crystal blade laid over a heavy red cleaver |
| 177 | 1172 | `yasha_and_kaya` | 夜慧对剑 | Yasha and Kaya | weapon_melee | a crossed pair of blades, a slim pale blue curved sword laid over a violet crystal blade |
| 178 | 1173 | `boots_of_bearing` | 气宇之靴 | Boots of Bearing | boots | a sturdy boot with feathered wings at the heel and a small hand drum hanging beside it |
| 179 | 1174 | `nullifier` | 否决挂饰 | Nullifier | gem | a dark orb wrapped in a short length of chain, one broken link hanging loose |
| 180 | 1175 | `hurricane_pike` | 飓风长戟 | Hurricane Pike | weapon_ranged | a long pike whose collar carries two small spiral whirlwind ornaments |
| 181 | 1176 | `guardian_greaves` | 卫士胫甲 | Guardian Greaves | boots | a heavy plated greave boot with overlapping shin plates and a green gem at the knee |
| 182 | 1177 | `shivas_guard` | 希瓦的守护 | Shiva's Guard | armor | a blue-lacquered chest plate with a high collar, short ice shards growing from the shoulders |
| 183 | 1178 | `manta` | 幻影斧 | Manta Style | weapon_melee | a pair of mirrored curved blades side by side, thin shafts and pale blue edges |
| 184 | 1179 | `gungir` | 冈格尼尔 | Gleipnir | weapon_ranged | a short rod wound with a tight chain, its head cut into a jagged lightning-bolt shape |
| 185 | 1180 | `bloodstone` | 血精石 | Bloodstone | gem | a deep red gem orb with dark cracks running across its surface and a dull centre |
| 186 | 1181 | `radiance` | 辉耀 | Radiance | weapon_melee | a curved golden blade with a bright pale core, stylised flame tongues rising along its back edge |
| 187 | 1182 | `harpoon` | 渔叉 | Harpoon | weapon_ranged | a barbed harpoon head on a short shaft with a coil of rope tied at the butt |
| 188 | 1183 | `sphere` | 林肯法球 | Linken's Sphere | gem | a blue orb circled by a thin floating ring with a small clasp at its front |
| 189 | 1184 | `crellas_crozier` | 克莱拉牧杖 | Crella's Crozier | staff | a tall shepherd's crook staff with a curled head and a green gem set in the curl |
| 190 | 1185 | `octarine_core` | 奥术之心 | Octarine Core | gem | a violet orb with a visible lattice core of crossing bars inside its surface |
| 191 | 1186 | `refresher` | 刷新球 | Refresher Orb | gem | a pale blue orb wrapped by two crossing metal rings, small studs where the rings meet |
| 192 | 1187 | `monkey_king_bar` | 金箍棒 | Monkey King Bar | staff | a golden rod with a red gem set at its head and a small monkey face carved below it |
| 193 | 1188 | `satanic` | 撒旦之邪力 | Satanic | weapon_melee | a heavy dark cleaver with a thick spine and a red gem mounted in the guard |
| 194 | 1189 | `heart` | 恐鳌之心 | Heart of Tarrasque | organ | a heart-shaped deep red crystal with faceted faces and a pale seam down the middle |
| 195 | 1190 | `greater_crit` | 代达罗斯之殇 | Daedalus | weapon_melee | a long crystal sword with a red gem set in the pommel and a straight bright-edged blade |
| 196 | 1191 | `assault` | 强袭胸甲 | Assault Cuirass | armor | a dark chest plate with two wing-shaped shoulder plates and a row of short spikes along the collar |
| 197 | 1192 | `sheepstick` | 邪恶镰刀 | Scythe of Vyse | staff | a wooden staff topped with a carved sheep's head, its horns curling back around a gem |
| 198 | 1193 | `ethereal_blade` | 虚灵之刃 | Ethereal Blade | weapon_melee | a translucent violet blade with a pale inner light, a green gem at the guard |
| 199 | 1194 | `butterfly` | 蝴蝶 | Butterfly | weapon_melee | a pair of wing-shaped blades sweeping apart from a single grip, their edges finely serrated |
| 200 | 1195 | `mjollnir` | 雷神之锤 | Mjollnir | weapon_melee | a heavy war hammer with angular lightning-bolt shapes springing from both sides of its head |
| 201 | 1196 | `angels_demise` | 坎达 | Khanda | weapon_melee | a heavy straight sword with a broad rectangular guard and a dark red gem in the pommel |
| 202 | 1197 | `rapier` | 圣剑 | Divine Rapier | weapon_melee | a long slender rapier with a golden swept hilt and a straight gleaming blade |
| 203 | 1198 | `helm_of_the_overlord` | 统御头盔 | Helm of the Overlord | helm | a dark horned helm with a tall red crest and a red gem set above the face opening |
| 204 | 1199 | `silver_edge` | 白银之锋 | Silver Edge | weapon_melee | a pale curved blade trailing wisps of shadow along its spine, a dark gem at the guard |
| 205 | 1200 | `ultimate_scepter_2` | 阿哈利姆福佑 | Aghanim's Blessing | book | a golden tablet with a blue gem at its centre and a band of small studs around the edge |
| 206 | 1201 | `ultimate_scepter_roshan` | 阿哈利姆福佑（肉山） | Aghanim's Blessing - Roshan | book | a golden tablet with a horned beast sigil carved at its centre and a blue gem above it |
| 207 | 1202 | `skadi` | 斯嘉蒂之眼 | Eye of Skadi | gem | a pale blue-white orb with a narrow vertical pupil, small ice crystals clustered at its base |
| 208 | 1203 | `hydras_breath` | 九头蛇之息 | Hydra's Breath | weapon_melee | a curved green blade whose guard carries three small serpent heads on slim necks |
| 209 | 1204 | `devastator` | 帕拉斯玛 | Parasma | staff | a long rod with a purple crystal head and two thin rings floating around it |
| 210 | 1205 | `disperser` | 斥散刃 | Disperser | weapon_melee | a slim curved blade with a green gem at the guard and a wrapped grip |
| 211 | 1206 | `abyssal_blade` | 深渊之刃 | Abyssal Blade | weapon_melee | a heavy dark sword with a chipped edge, a red gem in the guard and a short chain hanging from the pommel |
| 212 | 1207 | `trident` | 三叉戟 | Trident | weapon_ranged | a three-pronged trident with a blue gem set at the collar where the prongs meet |
| 213 | 1208 | `bloodthorn` | 血棘 | Bloodthorn | staff | a staff wrapped in thorny vine, dark red thorns protruding along its length and a red gem at the tip |
| 214 | 1209 | `wind_waker` | 风灵法杖 | Wind Waker | staff | a slim staff with a curled spiral ornament at its head and two small feathers tied below |
| 215 | 1210 | `chipped_vest` | 碎裂背心 | Chipped Vest | armor | a ragged leather vest with three chipped iron plates stitched across the chest |
| 216 | 1211 | `possessed_mask` | 附魂面具 | Possessed Mask | garment | a plain wooden mask with a second smaller face carved inside its mouth |
| 217 | 1212 | `occult_bracelet` | 秘仪手环 | Occult Bracelet | jewelry | a bracelet of small carved bone links with a single dark gem at its clasp |
| 218 | 1213 | `dagger_of_ristul` | 瑞斯图尔尖匕 | Dagger of Ristul | weapon_melee | a slim dagger with a hooked notched blade and a short bound grip |
| 219 | 1214 | `duelist_gloves` | 决斗者手套 | Duelist Gloves | garment | a single fencing glove with a wide frilled cuff and a stitched back panel |
| 220 | 1215 | `polliwog_charm` | 蝌蚪护符 | Pollywog Charm | jewelry | a small charm of glass holding a curled tadpole, hung on a woven cord |
| 221 | 1216 | `kobold_cup` | 狗头人酒杯 | Kobold Cup | consumable | a squat clay cup with a chipped rim, a single coin resting at the bottom |
| 222 | 1217 | `dormant_curio` | 沉睡奇物 | Dormant Curio | misc | a small closed wooden box with an iron keyhole and a carved lid |
| 223 | 1218 | `weighted_dice` | 加重骰子 | Weighted Dice | misc | a pair of square bone dice, one tipped up to show a heavy iron core inside |
| 224 | 1219 | `ash_legion_shield` | 余烬军团战盾 | Ash Legion Shield | shield | a round dark iron shield with a legion emblem stamped in the centre and ash grey paint flaking at the rim |
| 225 | 1220 | `stonefeather_satchel` | 石羽小包 | Stonefeather Satchel | garment | a small leather satchel with three grey stone feather charms hanging from its flap |
| 226 | 1221 | `foragers_kit` | 采菌套具 | Forager's Kit | consumable | a woven basket holding three mushrooms, a small knife tucked through the handle |
| 227 | 1222 | `poor_mans_shield` | 穷鬼盾 | Poor Man's Shield | shield | a crude round shield of rough planks with two nailed iron bands across the face |
| 228 | 1223 | `medallion_of_courage` | 勇气勋章 | Medallion of Courage | jewelry | a round bronze medallion with a carved rampant beast on its face and a ring at the top |
| 229 | 1224 | `essence_ring` | 精华指环 | Essence Ring | jewelry | a thin metal ring enclosing a small green essence bead held in a wire cage |
| 230 | 1225 | `pogo_stick` | 翻腾玩具 | Tumbler's Toy | misc | a small wooden roly-poly toy with a rounded weighted base and a painted grinning face |
| 231 | 1226 | `seeds_of_serenity` | 宁静种籽 | Seeds of Serenity | plant | a split seed pod holding three round seeds, one small green sprout uncurling beside it |
| 232 | 1227 | `defiant_shell` | 不屈护壳 | Defiant Shell | armor | a curved segment of thick shell armour with two rows of studs along its edge |
| 233 | 1228 | `mana_draught` | 法力之饮 | Mana Draught | consumable | a small round bottle of bright blue draught with a wax-sealed cork |
| 234 | 1229 | `crippling_crossbow` | 致残之弩 | Crippling Crossbow | weapon_ranged | a small hand crossbow with a loaded barbed bolt and a cranked winding handle |
| 235 | 1230 | `searing_signet` | 炽热纹章 | Searing Signet | jewelry | a heavy signet ring whose red gem is cut with three stylised flame points |
| 236 | 1231 | `cloak_of_flames` | 火焰斗篷 | Cloak of Flames | garment | a dark cloak whose hem is cut into a row of rising flame shapes |
| 237 | 1232 | `psychic_headband` | 通灵头带 | Psychic Headband | garment | a narrow cloth headband with a small gem fixed where a third eye would sit |
| 238 | 1233 | `stormcrafter` | 风暴宝器 | Stormcrafter | consumable | a round glass flask containing a small angular lightning bolt above dark clouds |
| 239 | 1234 | `unrelenting_eye` | 不倦之眼 | Unrelenting Eye | jewelry | an eye-shaped amulet with a dark pupil, hung on a short chain |
| 240 | 1235 | `gunpowder_gauntlets` | 火药手套 | Gunpowder Gauntlet | garment | a heavy leather gauntlet with two powder charges strapped on the back and a short fuse |
| 241 | 1236 | `serrated_shiv` | 锯齿短刀 | Serrated Shiv | weapon_melee | a small knife with a deeply serrated edge and a stubby wrapped handle |
| 242 | 1237 | `jidi_pollen_bag` | 基迪花粉袋 | Jidi Pollen Bag | consumable | a small cloth bag of pollen, a puff of pale dust escaping from its open neck |
| 243 | 1238 | `spellslinger` | 咏咒之坠 | Spellslinger | jewelry | a small pendant in the shape of a rolled scroll with a rune stamped on its face |
| 244 | 1239 | `partisans_brand` | 天游烙印 | Partisan's Brand | banner | a small rectangular banner plate bearing a forked pennant emblem, hung on a short pole |
| 245 | 1240 | `dandelion_amulet` | 蒲公英护符 | Dandelion Amulet | jewelry | a round amulet holding a dandelion seed head, a few seeds floating free beside it |
| 246 | 1241 | `rattlecage` | 回响之笼 | Rattlecage | misc | a small iron cage with a domed top, loose chain links rattling inside it |
| 247 | 1242 | `giant_maul` | 巨人重锤 | Giant's Maul | weapon_melee | a huge two-handed maul with a rough stone head bound by two iron bands |
| 248 | 1243 | `metamorphic_mandible` | 变态上颚 | Metamorphic Mandible | organ | a pair of insect mandibles joined at a hinge, dark chitin with serrated inner edges |
| 249 | 1244 | `idol_of_screeauk` | 斯凯奥克神像 | Idol of Scree'auk | misc | a small carved stone idol of a bird with an open beak, standing on a stepped base |
| 250 | 1245 | `flayers_bota` | 剥皮者之靴 | Flayer's Bota | boots | a soft hide boot with two curved claws stitched at the toe |
| 251 | 1246 | `prophets_pendulum` | 先知灵摆 | Prophet's Pendulum | jewelry | a pointed crystal pendulum hanging from a short chain with a bead at the top |
| 252 | 1247 | `enchanters_bauble` | 附魔师之椟 | Enchanter's Bauble | jewelry | a small ornate casket-like bauble with three tiny gems set into its lid |
| 253 | 1248 | `conjurers_catalyst` | 咒术师触媒 | Conjurer's Catalyst | gem | a faceted crystal catalyst held in a wire ring mount with two small hooks |
| 254 | 1249 | `desolator_2` | 冥河黯灭 | Stygian Desolator | weapon_melee | a heavy violet-black blade with a corroded edge and a dark gem in the guard |
| 255 | 1250 | `spider_legs` | 网虫腿 | Spider Legs | creature | a harness of four jointed insect legs with hooked tips, strapped to a small back plate |
| 256 | 1251 | `demonicon` | 冥灵书 | Book of the Dead | book | a dark bound book with a skull embossed on its cover and a bone clasp |
| 257 | 1252 | `fallen_sky` | 天崩 | Fallen Sky | gem | a cracked stone sphere with a pale seam running around it and three small fragments floating loose beside it |
| 258 | 1253 | `minotaur_horn` | 牛头人之角 | Minotaur Horn | organ | a thick curved horn banded with iron at its base and tapering to a dark tip |
| 259 | 1254 | `heavy_blade` | 巫毒之刃 | Witchbane | weapon_melee | a broad curved blade with a carved bone grip and a small charm tied to the guard |
| 260 | 1255 | `dezun_bloodrite` | 德尊血仪 | Dezun Bloodrite | misc | a shallow ritual bowl with red sigils cut around its rim and a short blade resting across it |
| 261 | 1256 | `divine_regalia` | 神圣圣衣 | Divine Regalia | armor | an ornate golden chest piece with layered shoulder plates and a row of small gems down the front |
| 262 | 1257 | `riftshadow_prism` | 影墟棱晶 | Riftshadow Prism | gem | a tall triangular prism of dark crystal with a bright slit running down its centre |
| 263 | 1258 | `harmonizer` | 协和 | Harmonizer | misc | a small metal tuning fork with two prongs and a ring of fine notches around its handle |
| 264 | 1259 | `aegis` | 不朽之守护 | Aegis of the Immortal | jewelry | a round golden medallion with a carved horned face at its centre and a studded rim |
| 265 | 1260 | `tome_of_aghanim` | 阿哈利姆之书 | Tome of Aghanim | book | a thick blue-bound tome with a gem set in its cover and two metal corner pieces |
| 266 | 1261 | `fusion_rune` | 融合符文 | Fusion Rune | rune_glyph | a flat rune stone carved with two interlocking rings cut through its face |
| 267 | 1262 | `tier1_token` | 中立装备代币 I | Tier 1 Token | misc | a plain bronze token coin with a single notch cut into its rim |
| 268 | 1263 | `tier2_token` | 中立装备代币 II | Tier 2 Token | misc | a silver token coin with two notches on its rim and a stamped centre mark |
| 269 | 1264 | `tier3_token` | 中立装备代币 III | Tier 3 Token | misc | a golden token coin with three notches on its rim and a small gem at its centre |
| 270 | 1265 | `tier4_token` | 中立装备代币 IV | Tier 4 Token | misc | a heavy pale-metal token coin with four notches and a raised four-point star on its face |
| 271 | 1266 | `tier5_token` | 中立装备代币 V | Tier 5 Token | misc | a dark ornate token coin with five notches and a red gem set into a crown-shaped centre |
| 272 | 1267 | `enhancement_vast` | 高远 | Vast | rune_glyph | an abstract emblem of one upward arrow splitting a long horizontal line, two wide arcs opening at the sides |
| 273 | 1268 | `enhancement_quickened` | 迅速 | Quickened | rune_glyph | an abstract emblem of two nested chevrons pointing right and a short trailing bar behind them |
| 274 | 1269 | `enhancement_audacious` | 冒险 | Audacious | rune_glyph | an abstract emblem of a bold triangle with a diagonal stroke rising out of its apex |
| 275 | 1270 | `enhancement_mystical` | 神秘 | Mystical | rune_glyph | an abstract emblem of an open circle with a crescent set inside it and a dot at the centre |
| 276 | 1271 | `enhancement_alert` | 警觉 | Alert | rune_glyph | an abstract emblem of a wide almond eye shape with a single dot as its pupil |
| 277 | 1272 | `enhancement_brawny` | 壮实 | Brawny | rune_glyph | an abstract emblem of a thick square block with two heavy bars stacked beneath it |
| 278 | 1273 | `enhancement_tough` | 坚强 | Tough | rune_glyph | an abstract emblem of a blocky hexagonal shield outline with a vertical bar down its middle |
| 279 | 1274 | `enhancement_feverish` | 狂热 | Feverish | rune_glyph | an abstract emblem of three rising wavy strokes of increasing height above a short base line |
| 280 | 1275 | `enhancement_fleetfooted` | 捷足 | Fleetfooted | rune_glyph | an abstract emblem of a slim arrow with two short speed ticks trailing behind it |
| 281 | 1276 | `enhancement_crude` | 粗暴 | Crude | rune_glyph | an abstract emblem of a jagged angular wedge with a rough chipped edge |
| 282 | 1277 | `enhancement_boundless` | 无边 | Boundless | rune_glyph | an abstract emblem of a wide ring left open by a gap at the top right |
| 283 | 1278 | `enhancement_wise` | 睿智 | Wise | rune_glyph | an abstract emblem of two stacked triangles above a dot, forming a small tower |
| 284 | 1279 | `enhancement_timeless` | 永恒 | Timeless | rune_glyph | an abstract emblem of two triangles meeting at a point like an hourglass inside a ring |
| 285 | 1280 | `enhancement_greedy` | 贪婪 | Greedy | rune_glyph | an abstract emblem of a thick ring closing on a small square held inside it |
| 286 | 1281 | `enhancement_vampiric` | 吸血鬼 | Vampiric | rune_glyph | an abstract emblem of a droplet shape with two short fangs cut into its lower edge |
| 287 | 1282 | `enhancement_keen_eyed` | 犀利 | Keen-eyed | rune_glyph | an abstract emblem of a crosshair of four short bars around a narrow slit pupil |
| 288 | 1283 | `enhancement_evolved` | 进化 | Evolved | rune_glyph | an abstract emblem of a spiral opening outward from a solid dot at its centre |
| 289 | 1284 | `enhancement_titanic` | 巨神 | Titanic | rune_glyph | an abstract emblem of a heavy trapezoid block with a thick bar across its middle |
| 290 | 1285 | `enhancement_fierce` | 凶猛 | Fierce | rune_glyph | an abstract emblem of three parallel claw slashes curving down to the left |
| 291 | 1286 | `enhancement_dominant` | 主导 | Dominant | rune_glyph | an abstract emblem of a bold chevron pointing up above a heavy horizontal bar |
| 292 | 1287 | `enhancement_restorative` | 恢复 | Restorative | rune_glyph | an abstract emblem of a thick plus sign set inside an open ring |
| 293 | 1288 | `enhancement_thick` | 厚实 | Thick | rune_glyph | an abstract emblem of two heavy stacked bars with a short upright between them |
| 294 | 1289 | `enhancement_curious` | 释放 | Unleashed | rune_glyph | an abstract emblem of a ring burst open with three short strokes flying away from the break |
| 295 | 1290 | `enhancement_vital` | 活力 | Vital | rune_glyph | an abstract emblem of a diamond heart shape crossed by a single pulse line |
| 296 | 1291 | `enhancement_hulking` | 笨重 | Hulking | rune_glyph | an abstract emblem of a broad blocky silhouette with two heavy shoulder squares |
| 297 | 1292 | `enhancement_manic` | 癫狂 | Manic | rune_glyph | an abstract emblem of a zigzag lightning stroke coiled into a loose spiral |
| 298 | 1293 | `enhancement_nimble` | 轻快 | Nimble | rune_glyph | an abstract emblem of two slim chevrons set at an angle with a fine dot between them |
| 299 | 1294 | `gloves_of_haste` | 敏捷手套 | Gloves of Haste | garment | a pair of slim pale leather gloves with feather-shaped stitching along the knuckles |
| 300 | 1295 | `trusty_shovel` | 可靠铁锹 | Trusty Shovel | tool | a sturdy shovel with a broad iron blade and a straight wooden handle gripped by two hands' worth of wrap |
| 301 | 1296 | `oak_heart` | 橡木之心 | Oak Heart | plant | a heart-shaped pendant carved from oak with rough bark edges and a small acorn hanging from it |
| 302 | 1297 | `enchanted_quiver` | 附魔箭袋 | Enchanted Quiver | weapon_ranged | a leather quiver holding three arrows, their feathered fletching showing above the rim and a rune burned into the strap |
| 303 | 1298 | `philosophers_stone` | 贤者之石 | Philosopher's Stone | gem | a deep crimson stone cut into a rounded lump, held in a banded brass ring mount |
| 304 | 1299 | `imp_claw` | 恶魔之爪 | Imp Claw | organ | a curved horned claw with three hooked talons and a small red gem set at its base |
| 305 | 1300 | `titan_slab` | 泰坦石板 | Titan Slab | misc | a thick rectangular stone slab covered in carved parallel grooves, one corner broken away |
| 306 | 1301 | `pirate_hat` | 海盗帽 | Pirate Hat | garment | a dark tricorn hat with a turned-up brim and a small skull emblem pinned to its band |
| 307 | 1302 | `apex` | 巅峰之器 | Apex | jewelry | an ornate pointed relic with three ascending blades fanning upward from a red gem at its base |
