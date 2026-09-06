/**
 * 肉鸽商店道具 —— 对应 dota2 全部装备（293 件），4 品质：白/蓝/黄/红
 * 数据源: dota2_equip.json（zh 名、cost、attrib、components）
 * 质量分布: {"white":186,"blue":38,"gold":37,"red":32}
 */
window.ITEM_DATA = [
    {
        "id": 1,
        "code": "quelling_blade",
        "name": "压制之刃",
        "en": "Quelling Blade",
        "cost": 100,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/quelling_blade.png",
        "attr": [],
        "effect": "效果：砍树；压制",
        "ability": "砍树：Destroy a target tree.",
        "lore": "The axe of a fallen gnome, it allows you to effectively maneuver the forest.",
        "suggest": "攻击力 +14%",
        "tags": [
            "远程点杀"
        ],
        "cd": 4
    },
    {
        "id": 2,
        "code": "stout_shield",
        "name": "圆盾",
        "en": "Stout Shield",
        "cost": 100,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/stout_shield.png",
        "attr": [],
        "effect": "格挡几率: 50；效果：伤害格挡",
        "ability": "伤害格挡：Grants a 50% chance to block 20 damage from incoming attacks on melee heroes, and 8 damage on ranged.",
        "lore": "One man's wine barrel bottom is another man's shield.",
        "suggest": "攻击力 +14%",
        "tags": [
            "远程点杀",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 3,
        "code": "gauntlets",
        "name": "力量手套",
        "en": "Gauntlets of Strength",
        "cost": 140,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/gauntlets.png",
        "attr": [
            "最大生命 +60",
            "生命恢复 +0.15/s"
        ],
        "effect": "最大生命 +60；生命恢复 +0.15/s",
        "ability": "",
        "lore": "Studded leather gloves that add brute strength.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 4,
        "code": "slippers",
        "name": "敏捷便靴",
        "en": "Slippers of Agility",
        "cost": 140,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/slippers.png",
        "attr": [
            "攻击速度 +3%",
            "护甲 +0.42"
        ],
        "effect": "攻击速度 +3%；护甲 +0.42",
        "ability": "",
        "lore": "Light boots made from spider skin that tingles your senses.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "召唤增殖"
        ],
        "cd": false
    },
    {
        "id": 5,
        "code": "mantle",
        "name": "智力斗篷",
        "en": "Mantle of Intelligence",
        "cost": 140,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/mantle.png",
        "attr": [
            "魔法抗性 +1.2%",
            "伤害输出 +1.5%"
        ],
        "effect": "魔法抗性 +1.2%；伤害输出 +1.5%",
        "ability": "",
        "lore": "A beautiful sapphire mantle worn by generations of queens.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 6,
        "code": "circlet",
        "name": "圆环",
        "en": "Circlet",
        "cost": 155,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/circlet.png",
        "attr": [
            "最大生命 +40",
            "攻击速度 +2%",
            "魔法抗性 +0.8%",
            "护甲 +0.28"
        ],
        "effect": "最大生命 +40；攻击速度 +2%；魔法抗性 +0.8%；护甲 +0.28",
        "ability": "",
        "lore": "An elegant circlet designed for human princesses.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 7,
        "code": "ring_of_protection",
        "name": "守护指环",
        "en": "Ring of Protection",
        "cost": 175,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ring_of_protection.png",
        "attr": [
            "护甲 +2"
        ],
        "effect": "护甲 +2",
        "ability": "",
        "lore": "A glimmering ring that defends its bearer.",
        "suggest": "护甲 +10%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 8,
        "code": "ring_of_regen",
        "name": "回复指环",
        "en": "Ring of Regen",
        "cost": 175,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ring_of_regen.png",
        "attr": [
            "生命恢复 +1/s"
        ],
        "effect": "生命恢复 +1/s",
        "ability": "",
        "lore": "This ring is considered a good luck charm among the Gnomes.",
        "suggest": "生命 +18% | 回复 +7%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 9,
        "code": "sobi_mask",
        "name": "贤者面罩",
        "en": "Sage's Mask",
        "cost": 175,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/sobi_mask.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "A mask commonly used by mages and warlocks for various rituals.",
        "suggest": "回复 +7%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 10,
        "code": "magic_stick",
        "name": "魔棒",
        "en": "Magic Stick",
        "cost": 200,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/magic_stick.png",
        "attr": [],
        "effect": "最大充能: 10；效果：能量充能",
        "ability": "能量充能：Instantly restores 15 health and mana per charge stored.\n\n Max 10 charges. Gains a charge whenever a visible enemy within 1200 range uses an ability.",
        "lore": "A simple wand used to channel magic energies, it is favored by apprentice wizards and great warlocks alike.",
        "suggest": "生命 +18%",
        "tags": [
            "远程点杀",
            "法术爆发"
        ],
        "cd": 17
    },
    {
        "id": 11,
        "code": "infused_raindrop",
        "name": "雨滴",
        "en": "Infused Raindrops",
        "cost": 225,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/infused_raindrop.png",
        "attr": [],
        "effect": "效果：魔法伤害格挡",
        "ability": "魔法伤害格挡：Consumes a charge to block 120 magic damage from damage instances over 75 damage. \n\nComes with 6 charges. When the charges are gone, the item disappears.",
        "lore": "Elemental protection from magical assaults.",
        "suggest": "攻击力 +14% | 回复 +7% | 元素强度 +7%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 7
    },
    {
        "id": 12,
        "code": "wind_lace",
        "name": "风灵之纹",
        "en": "Wind Lace",
        "cost": 225,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/wind_lace.png",
        "attr": [
            "移动速度 +15"
        ],
        "effect": "移动速度 +15",
        "ability": "",
        "lore": "Hasten to battle on wind-touched heels.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "召唤增殖"
        ],
        "cd": false
    },
    {
        "id": 13,
        "code": "wizard_hat",
        "name": "巫师帽",
        "en": "Wizard Hat",
        "cost": 250,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/wizard_hat.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 14,
        "code": "blight_stone",
        "name": "枯萎之石",
        "en": "Orb of Blight",
        "cost": 300,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/blight_stone.png",
        "attr": [],
        "effect": "效果：次级腐蚀",
        "ability": "次级腐蚀：Your attacks reduce the target's armor by -2 for 3 seconds.",
        "lore": "An unnerving stone unearthed beneath the Fields of Endless Carnage.",
        "suggest": "攻击力 +14% | 护甲 +10%",
        "tags": [
            "元素持续",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 15,
        "code": "orb_of_venom",
        "name": "淬毒之珠",
        "en": "Orb of Venom",
        "cost": 350,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/orb_of_venom.png",
        "attr": [],
        "effect": "伤害: 10；效果：剧毒攻击",
        "ability": "剧毒攻击：Poisons the target, dealing 10 magical damage per second. Lasts for 3 seconds.",
        "lore": "Envenoms your veapon with the venom of a venomous viper.",
        "suggest": "攻击力 +14%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 9
    },
    {
        "id": 16,
        "code": "blades_of_attack",
        "name": "攻击之爪",
        "en": "Blades of Attack",
        "cost": 450,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/blades_of_attack.png",
        "attr": [
            "攻击力 +9"
        ],
        "effect": "攻击力 +9",
        "ability": "",
        "lore": "The damage of these small, concealable blades should not be underestimated.",
        "suggest": "攻击力 +14%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 17,
        "code": "belt_of_strength",
        "name": "力量腰带",
        "en": "Belt of Strength",
        "cost": 450,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/belt_of_strength.png",
        "attr": [
            "最大生命 +120",
            "生命恢复 +0.3/s"
        ],
        "effect": "最大生命 +120；生命恢复 +0.3/s",
        "ability": "",
        "lore": "A valued accessory for improving vitality.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 18,
        "code": "boots_of_elves",
        "name": "精灵布带",
        "en": "Band of Elvenskin",
        "cost": 450,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/boots_of_elves.png",
        "attr": [
            "攻击速度 +6%",
            "护甲 +0.84"
        ],
        "effect": "攻击速度 +6%；护甲 +0.84",
        "ability": "",
        "lore": "A tensile fabric often used for its light weight and ease of movement.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "召唤增殖"
        ],
        "cd": false
    },
    {
        "id": 19,
        "code": "robe",
        "name": "法师长袍",
        "en": "Robe of the Magi",
        "cost": 450,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/robe.png",
        "attr": [
            "魔法抗性 +2.4%",
            "伤害输出 +3%"
        ],
        "effect": "魔法抗性 +2.4%；伤害输出 +3%",
        "ability": "",
        "lore": "This robe corrupts the soul of the user, but provides wisdom in return.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 20,
        "code": "crown",
        "name": "王冠",
        "en": "Crown",
        "cost": 450,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/crown.png",
        "attr": [
            "最大生命 +80",
            "攻击速度 +4%",
            "魔法抗性 +1.6%",
            "护甲 +0.56"
        ],
        "effect": "最大生命 +80；攻击速度 +4%；魔法抗性 +1.6%；护甲 +0.56",
        "ability": "",
        "lore": "A stately crown created to ensure a well-meaning but ungifted heir could fend off usurpers and govern with a strong hand.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 21,
        "code": "gloves",
        "name": "加速手套",
        "en": "Gloves of Haste",
        "cost": 450,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/gloves.png",
        "attr": [
            "攻击速度 +20%"
        ],
        "effect": "攻击速度 +20%",
        "ability": "",
        "lore": "A pair of magical gloves that seems to render weapons weightless.",
        "suggest": "攻击力 +14%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 22,
        "code": "shawl",
        "name": "披巾",
        "en": "Shawl",
        "cost": 450,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/shawl.png",
        "attr": [
            "魔法抗性 +10%"
        ],
        "effect": "魔法抗性 +10%",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 23,
        "code": "chainmail",
        "name": "锁子甲",
        "en": "Chainmail",
        "cost": 500,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/chainmail.png",
        "attr": [
            "护甲 +4"
        ],
        "effect": "护甲 +4",
        "ability": "",
        "lore": "A medium weave of metal chains.",
        "suggest": "护甲 +12%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 24,
        "code": "boots",
        "name": "速度之靴",
        "en": "Boots of Speed",
        "cost": 500,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/boots.png",
        "attr": [
            "移动速度 +45"
        ],
        "effect": "移动速度 +45",
        "ability": "",
        "lore": "Fleet footwear, increasing movement.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 25,
        "code": "voodoo_mask",
        "name": "巫毒面具",
        "en": "Voodoo Mask",
        "cost": 650,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/voodoo_mask.png",
        "attr": [],
        "effect": "+15% 吸血；效果：吸血",
        "ability": "吸血：Heals the wearer for a percentage of spell damage dealt to enemies.",
        "lore": "A mask tuned to sip the arcane bindings that pass between caster and foe.",
        "suggest": "攻击力 +17%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": false
    },
    {
        "id": 26,
        "code": "ring_of_health",
        "name": "恢复指环",
        "en": "Ring of Health",
        "cost": 700,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ring_of_health.png",
        "attr": [
            "生命恢复 +4/s"
        ],
        "effect": "生命恢复 +4/s",
        "ability": "",
        "lore": "A shiny ring found beneath a fat halfling's corpse.",
        "suggest": "生命 +22% | 回复 +8%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 27,
        "code": "void_stone",
        "name": "虚无宝石",
        "en": "Void Stone",
        "cost": 700,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/void_stone.png",
        "attr": [
            "生命恢复 +1/s"
        ],
        "effect": "生命恢复 +1/s",
        "ability": "",
        "lore": "Jewelry that was once used to channel nether realm magic, this ring pulses with energy.",
        "suggest": "回复 +8%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 28,
        "code": "chasm_stone",
        "name": "裂隙之石",
        "en": "Chasm Stone",
        "cost": 800,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/chasm_stone.png",
        "attr": [],
        "effect": "+40 作用范围",
        "ability": "",
        "lore": "",
        "suggest": "生命 +22%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 29,
        "code": "quarterstaff",
        "name": "短棍",
        "en": "Quarterstaff",
        "cost": 875,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/quarterstaff.png",
        "attr": [
            "攻击速度 +10%",
            "攻击力 +10"
        ],
        "effect": "攻击速度 +10%；攻击力 +10",
        "ability": "",
        "lore": "A basic staff that allows you to strike quickly.",
        "suggest": "攻击力 +17%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 30,
        "code": "javelin",
        "name": "标枪",
        "en": "Javelin",
        "cost": 900,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/javelin.png",
        "attr": [],
        "effect": "效果：穿刺",
        "ability": "穿刺：Grants each attack a 25% chance to pierce through evasion and deal 60 bonus magical damage.",
        "lore": "A rather typical spear that can sometimes pierce through an enemy's armor when used to attack.",
        "suggest": "攻击力 +17% | 护甲 +12% | 闪避 +7%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 31,
        "code": "lifesteal",
        "name": "吸血面具",
        "en": "Morbid Mask",
        "cost": 900,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/lifesteal.png",
        "attr": [],
        "effect": "+18% 吸血；效果：吸血",
        "ability": "吸血：Heals the attacker for a percentage of physical damage dealt.",
        "lore": "A mask that drains the energy of those caught in its gaze.",
        "suggest": "攻击力 +17%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 32,
        "code": "gem",
        "name": "真视宝石",
        "en": "Gem of True Sight",
        "cost": 900,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/gem.png",
        "attr": [],
        "effect": "作用半径: 900；持续时间: 4；效果：显形；真视；永恒",
        "ability": "显形：Gives True Sight over a 300 radius revealing wards and units even in Fog of War.",
        "lore": "Not one thrall creature of the depths,\r\nNor spirit bound in drowning's keep,\r\nNor Maelrawn the Tentacular,\r\nShall rest till seas, gem comes to sleep.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀",
            "召唤增殖"
        ],
        "cd": 12
    },
    {
        "id": 33,
        "code": "cloak",
        "name": "抗魔斗篷",
        "en": "Cloak",
        "cost": 900,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/cloak.png",
        "attr": [
            "魔法抗性 +18%"
        ],
        "effect": "魔法抗性 +18%",
        "ability": "",
        "lore": "A cloak made of a magical material that works to dispel any magic cast on it.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 34,
        "code": "shadow_amulet",
        "name": "暗影护符",
        "en": "Shadow Amulet",
        "cost": 900,
        "quality": "blue",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/shadow_amulet.png",
        "attr": [],
        "effect": "渐隐时间: 1.25；移速降低: 35；渐隐持续时间: 3.5；效果：渐隐",
        "ability": "渐隐：Grants invisibility to you or a target allied hero for 3.5s. Movement speed during the invisibility is reduced by 35%.",
        "lore": "A small talisman that clouds the senses of one's enemies when held perfectly still.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "元素持续"
        ],
        "cd": 18
    },
    {
        "id": 35,
        "code": "splintmail",
        "name": "片甲",
        "en": "Splintmail",
        "cost": 950,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/splintmail.png",
        "attr": [
            "护甲 +7"
        ],
        "effect": "护甲 +7",
        "ability": "",
        "lore": "",
        "suggest": "护甲 +12%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 36,
        "code": "helm_of_iron_will",
        "name": "铁意头盔",
        "en": "Helm of Iron Will",
        "cost": 975,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/helm_of_iron_will.png",
        "attr": [
            "护甲 +4",
            "生命恢复 +4/s"
        ],
        "effect": "护甲 +4；生命恢复 +4/s",
        "ability": "",
        "lore": "The helmet of a legendary warrior who fell in battle.",
        "suggest": "生命 +22% | 护甲 +12% | 回复 +8%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 37,
        "code": "broadsword",
        "name": "阔剑",
        "en": "Broadsword",
        "cost": 1000,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/broadsword.png",
        "attr": [
            "攻击力 +15"
        ],
        "effect": "攻击力 +15",
        "ability": "",
        "lore": "The classic weapon of choice for knights, this blade is sturdy and reliable for slaying enemies.",
        "suggest": "攻击力 +17%",
        "tags": [
            "元素持续"
        ],
        "cd": false
    },
    {
        "id": 38,
        "code": "diadem",
        "name": "头冠",
        "en": "Diadem",
        "cost": 1000,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/diadem.png",
        "attr": [
            "最大生命 +120",
            "攻击速度 +6%",
            "魔法抗性 +2.4%",
            "护甲 +0.84"
        ],
        "effect": "最大生命 +120；攻击速度 +6%；魔法抗性 +2.4%；护甲 +0.84",
        "ability": "",
        "lore": "A crown that can never be removed.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 39,
        "code": "ogre_axe",
        "name": "食人魔之斧",
        "en": "Ogre Axe",
        "cost": 1000,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ogre_axe.png",
        "attr": [
            "最大生命 +200",
            "生命恢复 +0.5/s"
        ],
        "effect": "最大生命 +200；生命恢复 +0.5/s",
        "ability": "",
        "lore": "You grow stronger just by holding it.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 40,
        "code": "blade_of_alacrity",
        "name": "欢欣之刃",
        "en": "Blade of Alacrity",
        "cost": 1000,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/blade_of_alacrity.png",
        "attr": [
            "攻击速度 +10%",
            "护甲 +1.4"
        ],
        "effect": "攻击速度 +10%；护甲 +1.4",
        "ability": "",
        "lore": "A long blade imbued with time magic.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 41,
        "code": "staff_of_wizardry",
        "name": "魔力法杖",
        "en": "Staff of Wizardry",
        "cost": 1000,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/staff_of_wizardry.png",
        "attr": [
            "魔法抗性 +4%",
            "伤害输出 +5%"
        ],
        "effect": "魔法抗性 +4%；伤害输出 +5%",
        "ability": "",
        "lore": "A staff of magical powers passed down from the eldest mages.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 42,
        "code": "blitz_knuckles",
        "name": "闪电指节",
        "en": "Blitz Knuckles",
        "cost": 1000,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/blitz_knuckles.png",
        "attr": [
            "攻击速度 +35%"
        ],
        "effect": "攻击速度 +35%",
        "ability": "",
        "lore": "An underground arcanist's update of a back-alley classic.",
        "suggest": "攻击力 +17%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 43,
        "code": "claymore",
        "name": "大剑",
        "en": "Claymore",
        "cost": 1350,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/claymore.png",
        "attr": [
            "攻击力 +20"
        ],
        "effect": "攻击力 +20",
        "ability": "",
        "lore": "A sword that can cut through armor, it's a commonly chosen first weapon for budding swordsmen.",
        "suggest": "攻击力 +22% | 护甲 +15%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 44,
        "code": "ghost",
        "name": "幽魂权杖",
        "en": "Ghost Scepter",
        "cost": 1500,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ghost.png",
        "attr": [
            "最大生命 +100",
            "攻击速度 +5%",
            "魔法抗性 +2%",
            "护甲 +0.7"
        ],
        "effect": "最大生命 +100；攻击速度 +5%；魔法抗性 +2%；护甲 +0.7；持续时间: 4.0；效果：幽灵形态",
        "ability": "幽灵形态：You enter ghost form for 4 seconds, becoming immune to physical damage, but are unable to attack and -30% more vulnerable to magic damage.",
        "lore": "Imbues the wielder with a ghostly presence, allowing them to evade physical damage.",
        "suggest": "攻击力 +22%",
        "tags": [
            "法术爆发",
            "召唤增殖"
        ],
        "cd": 22
    },
    {
        "id": 45,
        "code": "mithril_hammer",
        "name": "秘银锤",
        "en": "Mithril Hammer",
        "cost": 1600,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/mithril_hammer.png",
        "attr": [
            "攻击力 +24"
        ],
        "effect": "攻击力 +24",
        "ability": "",
        "lore": "A hammer forged of pure mithril.",
        "suggest": "攻击力 +22%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 46,
        "code": "ring_of_tarrasque",
        "name": "恐鳌之戒",
        "en": "Ring of Tarrasque",
        "cost": 1700,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ring_of_tarrasque.png",
        "attr": [
            "生命恢复 +12/s"
        ],
        "effect": "生命恢复 +12/s",
        "ability": "",
        "lore": "An ageless ring forged with an otherwise simple blood magic amplified by the presumed source of its key component.",
        "suggest": "生命 +29% | 回复 +11%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 47,
        "code": "tiara_of_selemene",
        "name": "赛莉蒙娜之冠",
        "en": "Tiara of Selemene",
        "cost": 1700,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/tiara_of_selemene.png",
        "attr": [
            "生命恢复 +6/s"
        ],
        "effect": "生命恢复 +6/s",
        "ability": "",
        "lore": "A symbol of favor bestowed upon the high priestess of Selemene.",
        "suggest": "回复 +11%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 48,
        "code": "blink",
        "name": "闪烁匕首",
        "en": "Blink Dagger",
        "cost": 2250,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/blink.png",
        "attr": [],
        "effect": "闪烁距离: 1200；受伤后禁用时间: 3.0；最大闪烁距离限制: 960；效果：闪烁",
        "ability": "闪烁：Teleport to a target point up to 1200 units away. \n\nBlink Dagger cannot be used for 3 seconds after taking damage from an enemy hero or Roshan.",
        "lore": "The fabled dagger used by the fastest assassin ever to walk the lands.",
        "suggest": "攻击力 +22%",
        "tags": [
            "控制减速"
        ],
        "cd": 15
    },
    {
        "id": 49,
        "code": "overwhelming_blink",
        "name": "撼地闪烁",
        "en": "Overwhelming Blink",
        "cost": 6800,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/overwhelming_blink.png",
        "attr": [
            "最大生命 +500",
            "生命恢复 +1.25/s"
        ],
        "effect": "最大生命 +500；生命恢复 +1.25/s；闪烁距离: 1200；受伤后禁用时间: 3.0；最大闪烁距离限制: 960；作用半径: 800；移速减缓: 50；效果：撼地闪烁",
        "ability": "撼地闪烁：Teleport to a target point up to 1200 units away.\n\nAfter teleportation, all enemies in a 800 AoE take damage equal to 100 + 50% of your strength and an additional 100% over time, and have 50% movement speed slow and 50 attack speed slow for 6 seconds. \n\nOverwhelming Blink cannot be used for 3 seconds after taking damage from an enemy hero or Roshan.",
        "lore": "A horrifying dagger forged in the chaos maw and nigh untouchable by mortal hands.",
        "suggest": "攻击力 +32% | 攻速 +19%",
        "tags": [
            "控制减速"
        ],
        "cd": 15
    },
    {
        "id": 50,
        "code": "swift_blink",
        "name": "疾速闪烁",
        "en": "Swift Blink",
        "cost": 6800,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/swift_blink.png",
        "attr": [
            "攻击速度 +25%",
            "护甲 +3.5"
        ],
        "effect": "攻击速度 +25%；护甲 +3.5；闪烁距离: 1200；受伤后禁用时间: 3.0；最大闪烁距离限制: 960；持续时间: 6；效果：疾速闪烁",
        "ability": "疾速闪烁：Teleport to a target point up to 1200 units away.\n\nAfter teleportation, you gain 40% phased movement speed and +35 Agility for 6 seconds. \n\nSwift Blink cannot be used for 3 seconds after taking damage from an enemy hero or Roshan.",
        "lore": "A cunning blade able to anticipate and enable its bearer's movements.",
        "suggest": "攻击力 +32%",
        "tags": [
            "控制减速"
        ],
        "cd": 15
    },
    {
        "id": 51,
        "code": "arcane_blink",
        "name": "奥术闪烁",
        "en": "Arcane Blink",
        "cost": 6800,
        "quality": "white",
        "category": "basic",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/arcane_blink.png",
        "attr": [
            "魔法抗性 +10%",
            "伤害输出 +12.5%"
        ],
        "effect": "魔法抗性 +10%；伤害输出 +12.5%；闪烁距离: 1400；受伤后禁用时间: 3.0；最大闪烁距离限制: 1120；治疗量: 250；持续时间: 0；效果：奥术闪烁",
        "ability": "奥术闪烁：Teleport to a target point up to 1400 units away. \n\nAfter teleportation, you restore 250 health and 100 mana.\n\nArcane Blink cannot be used for 3 seconds after taking damage from an enemy hero or Roshan.",
        "lore": "A revitalizing tool to help bear the weight of arcane expenditure.",
        "suggest": "攻击力 +32% | 生命 +42%",
        "tags": [
            "法术爆发",
            "控制减速"
        ],
        "cd": 9
    },
    {
        "id": 52,
        "code": "famango",
        "name": "治疗莲花",
        "en": "Healing Lotus",
        "cost": 0,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/famango.png",
        "attr": [],
        "effect": "效果：吃莲花",
        "ability": "吃莲花：Instantly restores 125 health and mana.",
        "lore": "",
        "suggest": "生命 +18%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 5
    },
    {
        "id": 53,
        "code": "great_famango",
        "name": "大型治疗莲花",
        "en": "Great Healing Lotus",
        "cost": 0,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/great_famango.png",
        "attr": [],
        "effect": "效果：吃莲花",
        "ability": "吃莲花：Instantly restores 400 health and mana.",
        "lore": "",
        "suggest": "生命 +18%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 5
    },
    {
        "id": 54,
        "code": "greater_famango",
        "name": "巨型治疗莲花",
        "en": "Greater Healing Lotus",
        "cost": 0,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/greater_famango.png",
        "attr": [],
        "effect": "效果：吃莲花",
        "ability": "吃莲花：Instantly restores 900 health and mana.",
        "lore": "",
        "suggest": "生命 +18%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 5
    },
    {
        "id": 55,
        "code": "ward_observer",
        "name": "侦查守卫",
        "en": "Observer Ward",
        "cost": 0,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ward_observer.png",
        "attr": [],
        "effect": "效果：种植",
        "ability": "种植：Plants an Observer Ward, an invisible watcher that gives ground vision in a 1600 radius to your team. Lasts 6 minutes.\n\nHold Control to give one Observer Ward to an allied hero.",
        "lore": "A form of half-sentient plant, often cultivated by apprentice wizards.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "元素持续",
            "召唤增殖"
        ],
        "cd": 1
    },
    {
        "id": 56,
        "code": "greater_faerie_fire",
        "name": "巨型仙灵之火",
        "en": "Greater Faerie Fire",
        "cost": 0,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/greater_faerie_fire.png",
        "attr": [
            "攻击力 +20"
        ],
        "effect": "攻击力 +20；效果：灌注",
        "ability": "灌注：Instantly restores 250 health.",
        "lore": "",
        "suggest": "攻击力 +14% | 生命 +18%",
        "tags": [
            "元素持续",
            "坦克反伤"
        ],
        "cd": 10
    },
    {
        "id": 57,
        "code": "royal_jelly",
        "name": "皇家蜂蜜",
        "en": "Royal Jelly",
        "cost": 0,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/royal_jelly.png",
        "attr": [
            "最大生命 +50",
            "生命恢复 +2.5/s",
            "生命恢复 +1.25/s"
        ],
        "effect": "最大生命 +50；生命恢复 +2.5/s；生命恢复 +1.25/s；最大充能: 10；效果：吞噬",
        "ability": "吞噬：Consumes all charges and grants a target allied unit a buff that provides +2.5 Health Regen and +1.25 Mana Regen per charge for 8s. \n\nIf the unit is attacked by an enemy hero or Roshan, the effect is lost.",
        "lore": "To those who harvest olgru jelly, success serves more than mere profit--it's often the means to survival--for only the jelly itself can cure the ravages that follow a sting from the vigilant denizens ",
        "suggest": "攻击力 +14% | 生命 +18% | 回复 +7%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 58,
        "code": "repair_kit",
        "name": "修理工具包",
        "en": "Repair Kit",
        "cost": 0,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/repair_kit.png",
        "attr": [
            "生命恢复 +25/s"
        ],
        "effect": "生命恢复 +25/s；持续时间: 30；效果：建筑维修",
        "ability": "建筑维修：Targets a building, restoring 40% of it's health over 30 seconds. Also grants +10 armor during this period.",
        "lore": "",
        "suggest": "生命 +18% | 护甲 +10% | 回复 +7%",
        "tags": [
            "坦克反伤"
        ],
        "cd": 60
    },
    {
        "id": 59,
        "code": "roshans_banner",
        "name": "肉山旗帜",
        "en": "Roshan's Banner",
        "cost": 0,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/roshans_banner.png",
        "attr": [],
        "effect": "持续时间: 120；作用半径: 600 / 900 / 1200；摧毁次数: 6 / 8 / 10；效果：放置旗帜",
        "ability": "放置旗帜：Creates a banner at the target location. Lane creeps in the area of effect become damage immune while the Banner is up. Lasts 120 seconds.\n\n Can be destroyed. Melee hero attacks deal 2x damage to the banner.",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "召唤增殖"
        ],
        "cd": 1
    },
    {
        "id": 60,
        "code": "madstone_bundle",
        "name": "狂石包裹",
        "en": "Madstone Bundle",
        "cost": 0,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/madstone_bundle.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 61,
        "code": "royale_with_cheese",
        "name": "芝士块",
        "en": "Block of Cheese",
        "cost": 2,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/royale_with_cheese.png",
        "attr": [
            "生命恢复 +3000/s",
            "生命恢复 +2000/s"
        ],
        "effect": "生命恢复 +3000/s；生命恢复 +2000/s；持续时间: 5；效果：美味",
        "ability": "美味：Try me!",
        "lore": "First there was the Belt of Strength. Then there were the Boots of Travel. Now, at long last, the Block of Cheese.",
        "suggest": "生命 +18% | 回复 +7%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 40
    },
    {
        "id": 62,
        "code": "tango_single",
        "name": "吃树（分享）",
        "en": "Tango (Shared)",
        "cost": 30,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/tango_single.png",
        "attr": [
            "生命恢复 +3.5/s"
        ],
        "effect": "生命恢复 +3.5/s；效果：吞噬",
        "ability": "吞噬：Consumes a target tree to gain 3.5 health regeneration for 16 seconds. Consuming an Ironwood Tree doubles the heal duration.\n\nTree Range: 165",
        "lore": "Om nom nom.",
        "suggest": "生命 +18% | 回复 +7%",
        "tags": [
            "远程点杀",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 63,
        "code": "blood_grenade",
        "name": "鲜血手雷",
        "en": "Blood Grenade",
        "cost": 50,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/blood_grenade.png",
        "attr": [
            "最大生命 +50"
        ],
        "effect": "最大生命 +50；作用半径: 300；负面效果持续时间: 5；效果：投掷手雷",
        "ability": "投掷手雷：Throw a grenade at the target area. Enemies in the area will take 50 damage on impact, and be slowed by -15% and take 15 damage every 1s for 5 seconds. Radius 300.",
        "lore": "Both the hunter and the hunted must pay the blood price.",
        "suggest": "攻击力 +14% | 生命 +18%",
        "tags": [
            "元素持续",
            "控制减速"
        ],
        "cd": 10
    },
    {
        "id": 64,
        "code": "ward_sentry",
        "name": "岗哨守卫",
        "en": "Sentry Ward",
        "cost": 50,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ward_sentry.png",
        "attr": [],
        "effect": "效果：种植",
        "ability": "种植：Plants a Sentry Ward, an invisible watcher that grants True Sight, the ability to see invisible enemy units and wards, to any existing allied vision within a 1050 radius.\nLasts 7 minutes.\n\nDoes not grant ground vision.\nHold Control to give one Sentry Ward to an allied hero.",
        "lore": "A form of plant originally grown in the garden of a fearful king.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "召唤增殖"
        ],
        "cd": 1
    },
    {
        "id": 65,
        "code": "ward_dispenser",
        "name": "守卫补给包",
        "en": "Observer and Sentry Wards",
        "cost": 50,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ward_dispenser.png",
        "attr": [
            "最大生命 +75"
        ],
        "effect": "最大生命 +75；侦查视野范围: 1600；侦查持续时间（分钟）: 6；岗哨持续时间（分钟）: 8；岗哨真视范围: 1050；效果：种植",
        "ability": "种植：Plant the currently active ward. Double-Click to switch the currently active ward.",
        "lore": "Advancements in stacking efficiency have made wards easier to carry than ever.",
        "suggest": "生命 +18%",
        "tags": [
            "坦克反伤",
            "召唤增殖"
        ],
        "cd": false
    },
    {
        "id": 66,
        "code": "courier",
        "name": "动物信使",
        "en": "Animal Courier",
        "cost": 50,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/courier.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 67,
        "code": "smoke_of_deceit",
        "name": "诡计之雾",
        "en": "Smoke of Deceit",
        "cost": 50,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/smoke_of_deceit.png",
        "attr": [],
        "effect": "额外移速: 15；持续时间: 45.0；效果：伪装",
        "ability": "伪装：Turns the caster and all allied player-controlled units in a 1200 radius invisible, and grants 15% bonus movement speed for 45 seconds. \n\n While the caster is still disguised, any allies that come within 300 range of them will also get the buff applied to them. Each smoke can only be applied once to allies. \n\nAttacking or moving within 1025 range of an enemy hero or tower, will break the invisibility. \n\nDisguise grants invisibility that is immune to True Sight. \n\nSmoke of Deceit is usable from the backpack and has no cooldown when swapped into the main inventory.",
        "lore": "The charlatan wizard Myrddin's only true contribution to the arcane arts.",
        "suggest": "攻击力 +14% | 冷却 -7%",
        "tags": [
            "远程点杀"
        ],
        "cd": 1
    },
    {
        "id": 68,
        "code": "branches",
        "name": "铁树枝干",
        "en": "Iron Branch",
        "cost": 55,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/branches.png",
        "attr": [
            "最大生命 +20",
            "攻击速度 +1%",
            "魔法抗性 +0.4%",
            "护甲 +0.14"
        ],
        "effect": "最大生命 +20；攻击速度 +1%；魔法抗性 +0.4%；护甲 +0.14；效果：种树",
        "ability": "种树：Targets the ground to plant a happy little tree that lasts for 20 seconds.",
        "lore": "A seemingly ordinary branch, its ironlike qualities are bestowed upon the bearer.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 69,
        "code": "clarity",
        "name": "净化药水",
        "en": "Clarity",
        "cost": 60,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/clarity.png",
        "attr": [
            "生命恢复 +6/s"
        ],
        "effect": "生命恢复 +6/s；效果：补充",
        "ability": "补充：Grants 6 mana regeneration to the target for 25 seconds.\n\nIf the unit is attacked by an enemy hero or Roshan, the effect is lost.",
        "lore": "Clear water that enhances the ability to meditate.",
        "suggest": "攻击力 +14% | 回复 +7%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 70,
        "code": "faerie_fire",
        "name": "仙灵之火",
        "en": "Faerie Fire",
        "cost": 65,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/faerie_fire.png",
        "attr": [
            "攻击力 +2"
        ],
        "effect": "攻击力 +2；效果：灌注",
        "ability": "灌注：Instantly restores 85 health.",
        "lore": "The ethereal flames from the ever-burning ruins of Kindertree ignite across realities.",
        "suggest": "攻击力 +14% | 生命 +18%",
        "tags": [
            "元素持续",
            "坦克反伤"
        ],
        "cd": 5
    },
    {
        "id": 71,
        "code": "enchanted_mango",
        "name": "魔法芒果",
        "en": "Enchanted Mango",
        "cost": 65,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enchanted_mango.png",
        "attr": [],
        "effect": "效果：吃芒果",
        "ability": "吃芒果：Instantly restores 100 mana.",
        "lore": "The bittersweet flavors of Jidi Isle are irresistible to amphibians.",
        "suggest": "生命 +18% | 回复 +7%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 72,
        "code": "tome_of_knowledge",
        "name": "经验之书",
        "en": "Tome of Knowledge",
        "cost": 75,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/tome_of_knowledge.png",
        "attr": [],
        "effect": "效果：启迪",
        "ability": "启迪：Grants you 750 experience plus 150 per tome consumed by your team after the first two.",
        "lore": "That which raises beast to man and man to god.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 73,
        "code": "dust",
        "name": "显影之尘",
        "en": "Dust of Appearance",
        "cost": 80,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/dust.png",
        "attr": [],
        "effect": "持续时间: 12；作用半径: 1050；伤害: 25；效果：显形",
        "ability": "显形：For 12 seconds, creates an area that reveals and slows invisible heroes by -20% in a 1050 radius where the caster was standing. Invisible units revealed by dust take 25 damage.\n\n The debuff effect on enemies lingers for 8s after leaving the area of effect.",
        "lore": "One may hide visage, but never volume.",
        "suggest": "攻击力 +14%",
        "tags": [
            "控制减速"
        ],
        "cd": 30
    },
    {
        "id": 74,
        "code": "tango",
        "name": "吃树",
        "en": "Tango",
        "cost": 90,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/tango.png",
        "attr": [
            "生命恢复 +7/s"
        ],
        "effect": "生命恢复 +7/s；效果：吞噬",
        "ability": "吞噬：Consumes a target tree to gain 7 health regeneration for 16 seconds. Consuming an Ironwood Tree doubles the heal duration.\n\nComes with 3 charges. Can be used on an allied hero to give them one Tango.\n\nTree Range: 165",
        "lore": "Forage to survive on the battlefield.",
        "suggest": "生命 +18% | 回复 +7%",
        "tags": [
            "远程点杀",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 75,
        "code": "flask",
        "name": "治疗药膏",
        "en": "Healing Salve",
        "cost": 100,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/flask.png",
        "attr": [
            "生命恢复 +30/s"
        ],
        "effect": "生命恢复 +30/s；效果：药膏",
        "ability": "药膏：Grants 30 health regeneration to the target for 13 seconds.\n\nIf the unit is attacked by an enemy hero or Roshan, the effect is lost.\n\nHeals for half the amount per second when cast on an ally.",
        "lore": "A magical salve that can quickly mend even the deepest of wounds.",
        "suggest": "攻击力 +14% | 生命 +18% | 回复 +7%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 76,
        "code": "flying_courier",
        "name": "飞行信使",
        "en": "Flying Courier",
        "cost": 100,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/flying_courier.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 77,
        "code": "tpscroll",
        "name": "回城卷轴",
        "en": "Town Portal Scroll",
        "cost": 100,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/tpscroll.png",
        "attr": [],
        "effect": "效果：传送",
        "ability": "传送：After channeling for 3 seconds, teleports you to a target friendly building. \n\nDouble-click to teleport to your team's base fountain.",
        "lore": "What a hero truly needs.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": 80
    },
    {
        "id": 78,
        "code": "cheese",
        "name": "奶酪",
        "en": "Cheese",
        "cost": 1000,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/cheese.png",
        "attr": [
            "生命恢复 +2500/s",
            "生命恢复 +1500/s"
        ],
        "effect": "生命恢复 +2500/s；生命恢复 +1500/s；效果：融化",
        "ability": "融化：Instantly restores 2500 health and 1500 mana.",
        "lore": "Made from the milk of a long lost Furbolg vendor, it restores the vitality of those who taste it.",
        "suggest": "生命 +22% | 回复 +8%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 40
    },
    {
        "id": 79,
        "code": "refresher_shard",
        "name": "刷新碎片",
        "en": "Refresher Shard",
        "cost": 1000,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/refresher_shard.png",
        "attr": [
            "生命恢复 +12/s",
            "生命恢复 +6/s",
            "攻击力 +20"
        ],
        "effect": "生命恢复 +12/s；生命恢复 +6/s；攻击力 +20；效果：重置冷却",
        "ability": "重置冷却：Resets the cooldowns of all your abilities. Shares a cooldown with Refresher Orb. This item's cooldown only progresses in your hero's main inventory.",
        "lore": "",
        "suggest": "攻击力 +17% | 生命 +22% | 回复 +8%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 180
    },
    {
        "id": 80,
        "code": "moon_shard",
        "name": "银月之晶",
        "en": "Moon Shard",
        "cost": 4000,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/moon_shard.png",
        "attr": [
            "攻击速度 +140%"
        ],
        "effect": "攻击速度 +140%；+400 视野；效果：吞噬；暗影视野",
        "ability": "吞噬：Consume the Moon Shard to permanently gain 60 attack speed and 200 bonus night vision. Max 1 use.",
        "lore": "Said to be a tear from the lunar goddess Selemene.",
        "suggest": "攻击力 +27% | 攻速 +16%",
        "tags": [
            "元素持续"
        ],
        "cd": false
    },
    {
        "id": 81,
        "code": "mango_tree",
        "name": "芒果树",
        "en": "Mango Tree",
        "cost": null,
        "quality": "white",
        "category": "consumable",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/mango_tree.png",
        "attr": [],
        "effect": "效果：种植芒果树",
        "ability": "种植芒果树：Targets the ground to plant a mango tree that provides unlimited mango power. The tree generates Enchanted Mangoes every 60 seconds, and provides unobstructed vision in the area .",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 82,
        "code": "fluffy_hat",
        "name": "绒毛帽",
        "en": "Fluffy Hat",
        "cost": 250,
        "quality": "white",
        "category": "secret_shop",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/fluffy_hat.png",
        "attr": [
            "最大生命 +125"
        ],
        "effect": "最大生命 +125",
        "ability": "",
        "lore": "Fine and functional foppery for the fashion-forward fighter.",
        "suggest": "生命 +18%",
        "tags": [
            "坦克反伤",
            "召唤增殖"
        ],
        "cd": false
    },
    {
        "id": 83,
        "code": "energy_booster",
        "name": "能量之球",
        "en": "Energy Booster",
        "cost": 800,
        "quality": "white",
        "category": "secret_shop",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/energy_booster.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "This lapis gemstone is commonly added to the collection of wizards seeking to improve their presence in combat.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 84,
        "code": "vitality_booster",
        "name": "活力之球",
        "en": "Vitality Booster",
        "cost": 1000,
        "quality": "blue",
        "category": "secret_shop",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/vitality_booster.png",
        "attr": [
            "最大生命 +250"
        ],
        "effect": "最大生命 +250",
        "ability": "",
        "lore": "A ruby gemstone that has been passed down through generations of warrior kin.",
        "suggest": "生命 +22%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 85,
        "code": "point_booster",
        "name": "精气之球",
        "en": "Point Booster",
        "cost": 1200,
        "quality": "blue",
        "category": "secret_shop",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/point_booster.png",
        "attr": [
            "最大生命 +175"
        ],
        "effect": "最大生命 +175",
        "ability": "",
        "lore": "A perfectly formed amethyst that nourishes body and mind when held.",
        "suggest": "生命 +29%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 86,
        "code": "talisman_of_evasion",
        "name": "闪避护符",
        "en": "Talisman of Evasion",
        "cost": 1300,
        "quality": "blue",
        "category": "secret_shop",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/talisman_of_evasion.png",
        "attr": [
            "闪避 +15%"
        ],
        "effect": "闪避 +15%",
        "ability": "",
        "lore": "A necklace that allows you to anticipate enemy attacks.",
        "suggest": "攻击力 +22% | 闪避 +9%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 87,
        "code": "platemail",
        "name": "板甲",
        "en": "Platemail",
        "cost": 1400,
        "quality": "blue",
        "category": "secret_shop",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/platemail.png",
        "attr": [
            "护甲 +10"
        ],
        "effect": "护甲 +10",
        "ability": "",
        "lore": "Thick metal plates that protect the entire upper body. Avoid dropping on feet.",
        "suggest": "护甲 +15%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 88,
        "code": "hyperstone",
        "name": "振奋宝石",
        "en": "Hyperstone",
        "cost": 2000,
        "quality": "blue",
        "category": "secret_shop",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/hyperstone.png",
        "attr": [
            "攻击速度 +60%"
        ],
        "effect": "攻击速度 +60%",
        "ability": "",
        "lore": "A mystical, carved stone that boosts the fervor of the holder.",
        "suggest": "攻击力 +22%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 89,
        "code": "demon_edge",
        "name": "恶魔刀锋",
        "en": "Demon Edge",
        "cost": 2200,
        "quality": "blue",
        "category": "secret_shop",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/demon_edge.png",
        "attr": [
            "攻击力 +40"
        ],
        "effect": "攻击力 +40",
        "ability": "",
        "lore": "One of the oldest weapons forged by the Demon-Smith Abzidian, it killed its maker when he tested its edge.",
        "suggest": "攻击力 +22%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 90,
        "code": "ultimate_orb",
        "name": "极限法球",
        "en": "Ultimate Orb",
        "cost": 2800,
        "quality": "blue",
        "category": "secret_shop",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ultimate_orb.png",
        "attr": [
            "最大生命 +300",
            "攻击速度 +15%",
            "魔法抗性 +6%",
            "护甲 +2.1"
        ],
        "effect": "最大生命 +300；攻击速度 +15%；魔法抗性 +6%；护甲 +2.1",
        "ability": "",
        "lore": "A mystical orb containing the essence of life.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 91,
        "code": "eagle",
        "name": "鹰歌弓",
        "en": "Eaglesong",
        "cost": 2800,
        "quality": "blue",
        "category": "secret_shop",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/eagle.png",
        "attr": [
            "攻击速度 +25%",
            "护甲 +3.5"
        ],
        "effect": "攻击速度 +25%；护甲 +3.5",
        "ability": "",
        "lore": "Capturing the majestic call of an eagle, this mystical horn brings limitless dexterity to those who hear it.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 92,
        "code": "reaver",
        "name": "掠夺者之斧",
        "en": "Reaver",
        "cost": 2800,
        "quality": "blue",
        "category": "secret_shop",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/reaver.png",
        "attr": [
            "最大生命 +500",
            "生命恢复 +1.25/s"
        ],
        "effect": "最大生命 +500；生命恢复 +1.25/s",
        "ability": "",
        "lore": "A massive axe capable of tearing whole mountains down.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 93,
        "code": "mystic_staff",
        "name": "神秘法杖",
        "en": "Mystic Staff",
        "cost": 2800,
        "quality": "blue",
        "category": "secret_shop",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/mystic_staff.png",
        "attr": [
            "魔法抗性 +10%",
            "伤害输出 +12.5%"
        ],
        "effect": "魔法抗性 +10%；伤害输出 +12.5%",
        "ability": "",
        "lore": "Enigmatic staff made of only the most expensive crystals.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 94,
        "code": "relic",
        "name": "圣者遗物",
        "en": "Sacred Relic",
        "cost": 3400,
        "quality": "blue",
        "category": "secret_shop",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/relic.png",
        "attr": [
            "攻击力 +55"
        ],
        "effect": "攻击力 +55",
        "ability": "",
        "lore": "An ancient weapon that often turns the tides of war.",
        "suggest": "攻击力 +27%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 95,
        "code": "orb_of_frost",
        "name": "寒霜宝珠",
        "en": "Orb of Frost",
        "cost": 300,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/orb_of_frost.png",
        "attr": [],
        "effect": "持续时间: 3；效果：冰霜",
        "ability": "冰霜：Your attacks slow the target's movement by -13% (-6% against melee targets), and reduces Health Restoration by 13%. Lasts for 3 seconds.",
        "lore": "Slowly growing since the universe began, it will envelop everything when it ends.",
        "suggest": "攻击力 +14% | 生命 +18%",
        "tags": [
            "元素持续",
            "控制减速"
        ],
        "cd": false
    },
    {
        "id": 96,
        "code": "buckler",
        "name": "玄冥盾牌",
        "en": "Buckler",
        "cost": 425,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/buckler.png",
        "attr": [
            "护甲 +1"
        ],
        "effect": "护甲 +1；效果：玄冥光环",
        "ability": "玄冥光环：Grants 2 armor to allied player units.\n\nRadius: 1200",
        "lore": "A powerful shield that imbues the bearer with the strength of heroes past, it is capable of protecting entire armies in battle.",
        "suggest": "护甲 +10%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 97,
        "code": "ring_of_basilius",
        "name": "王者之戒",
        "en": "Ring of Basilius",
        "cost": 425,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ring_of_basilius.png",
        "attr": [
            "生命恢复 +1/s"
        ],
        "effect": "生命恢复 +1/s；光环半径: 1200；效果：王者光环",
        "ability": "王者光环：Grants 1 mana regeneration to allies. \n\nRadius: 1200",
        "lore": "Ring given as a reward to the greatest mages.",
        "suggest": "回复 +7%",
        "tags": [
            "法术爆发",
            "召唤增殖"
        ],
        "cd": false
    },
    {
        "id": 98,
        "code": "headdress",
        "name": "回复头巾",
        "en": "Headdress",
        "cost": 425,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/headdress.png",
        "attr": [
            "生命恢复 +2/s"
        ],
        "effect": "生命恢复 +2/s；光环半径: 1200；效果：回复光环",
        "ability": "回复光环：Grants 2 health regeneration to allies.\n\nRadius: 1200",
        "lore": "Creates a soothing aura that restores allies in battle.",
        "suggest": "生命 +18% | 回复 +7%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 99,
        "code": "magic_wand",
        "name": "魔杖",
        "en": "Magic Wand",
        "cost": 460,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/magic_wand.png",
        "attr": [
            "最大生命 +60",
            "攻击速度 +3%",
            "魔法抗性 +1.2%",
            "护甲 +0.42"
        ],
        "effect": "最大生命 +60；攻击速度 +3%；魔法抗性 +1.2%；护甲 +0.42；最大充能: 20；效果：能量充能",
        "ability": "能量充能：Instantly restores 15 health and mana per charge stored. \n\nMax 20 charges. Gains a charge whenever a visible enemy within 1200 range uses an ability.",
        "lore": "A simple wand used to channel magic energies, it is favored by apprentice wizards and great warlocks alike.",
        "suggest": "生命 +18%",
        "tags": [
            "远程点杀",
            "法术爆发"
        ],
        "cd": 15
    },
    {
        "id": 100,
        "code": "bracer",
        "name": "护腕",
        "en": "Bracer",
        "cost": 505,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/bracer.png",
        "attr": [
            "最大生命 +100",
            "生命恢复 +0.25/s",
            "攻击速度 +2%",
            "护甲 +0.28",
            "魔法抗性 +0.8%",
            "伤害输出 +1%",
            "最大生命 +50"
        ],
        "effect": "最大生命 +100；生命恢复 +0.25/s；攻击速度 +2%；护甲 +0.28；魔法抗性 +0.8%；伤害输出 +1%；最大生命 +50",
        "ability": "",
        "lore": "The bracer is a common choice to toughen up defenses and increase longevity.",
        "suggest": "攻击力 +17% | 生命 +22% | 回复 +8%",
        "tags": [
            "元素持续",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 101,
        "code": "wraith_band",
        "name": "怨灵系带",
        "en": "Wraith Band",
        "cost": 505,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/wraith_band.png",
        "attr": [
            "攻击速度 +5%",
            "护甲 +0.7",
            "最大生命 +40",
            "生命恢复 +0.1/s",
            "魔法抗性 +0.8%",
            "伤害输出 +1%",
            "攻击速度 +6%",
            "护甲 +1"
        ],
        "effect": "攻击速度 +5%；护甲 +0.7；最大生命 +40；生命恢复 +0.1/s；魔法抗性 +0.8%；伤害输出 +1%；攻击速度 +6%；护甲 +1",
        "ability": "",
        "lore": "A circlet with faint whispers echoing about it.",
        "suggest": "攻击力 +17% | 护甲 +12%",
        "tags": [
            "坦克反伤",
            "召唤增殖"
        ],
        "cd": false
    },
    {
        "id": 102,
        "code": "null_talisman",
        "name": "无用挂件",
        "en": "Null Talisman",
        "cost": 505,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/null_talisman.png",
        "attr": [
            "魔法抗性 +2%",
            "伤害输出 +2.5%",
            "最大生命 +40",
            "生命恢复 +0.1/s",
            "攻击速度 +2%",
            "护甲 +0.28",
            "生命恢复 +1/s"
        ],
        "effect": "魔法抗性 +2%；伤害输出 +2.5%；最大生命 +40；生命恢复 +0.1/s；攻击速度 +2%；护甲 +0.28；生命恢复 +1/s",
        "ability": "",
        "lore": "A small gemstone attached to several chains.",
        "suggest": "回复 +8%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 103,
        "code": "bottle",
        "name": "魔瓶",
        "en": "Bottle",
        "cost": 675,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/bottle.png",
        "attr": [
            "生命恢复 +110/s",
            "生命恢复 +60/s"
        ],
        "effect": "生命恢复 +110/s；生命恢复 +60/s；最大充能: 3；效果：再生；储存符文",
        "ability": "再生：Consumes a charge to restore 110 health and 60 mana over 2.7 seconds. If the hero is attacked by an enemy hero or Roshan, the effect is lost.\n\nThe Bottle automatically refills at the fountain.\n\nHold Control to use on an allied hero.",
        "lore": "An old bottle that survived the ages, the contents placed inside become enchanted.",
        "suggest": "攻击力 +17% | 生命 +22% | 回复 +8%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 104,
        "code": "soul_ring",
        "name": "魂戒",
        "en": "Soul Ring",
        "cost": 805,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/soul_ring.png",
        "attr": [
            "最大生命 +120",
            "生命恢复 +0.3/s",
            "护甲 +2"
        ],
        "effect": "最大生命 +120；生命恢复 +0.3/s；护甲 +2；持续时间: 10；效果：牺牲",
        "ability": "牺牲：Consume %abilityhealthcost% health to temporarily gain 170 mana. Lasts 10 seconds.\n\nIf the mana gained cannot fit in your mana pool, it creates a buffer of mana that will be used before your mana pool.",
        "lore": "A ring that feeds on the souls of those who wear it.",
        "suggest": "生命 +22% | 护甲 +12%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 25
    },
    {
        "id": 105,
        "code": "urn_of_shadows",
        "name": "影之灵龛",
        "en": "Urn of Shadows",
        "cost": 825,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/urn_of_shadows.png",
        "attr": [
            "生命恢复 +1/s",
            "最大生命 +40",
            "攻击速度 +2%",
            "魔法抗性 +0.8%",
            "护甲 +0.28",
            "护甲 +2"
        ],
        "effect": "生命恢复 +1/s；最大生命 +40；攻击速度 +2%；魔法抗性 +0.8%；护甲 +0.28；护甲 +2；持续时间: 8.0；效果：灵魂释放",
        "ability": "灵魂释放：Provides 30 health regeneration when cast on allies, and deals 25 damage per second when cast on enemies.\n\nLasts 8 seconds.\n\nGains charges every time an enemy hero dies within 1500 units.",
        "lore": "Contains the ashes of powerful demons.",
        "suggest": "攻击力 +17% | 生命 +22% | 护甲 +12%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 10
    },
    {
        "id": 106,
        "code": "tranquil_boots",
        "name": "静谧之鞋",
        "en": "Tranquil Boots",
        "cost": 900,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/tranquil_boots.png",
        "attr": [
            "移动速度 +65",
            "生命恢复 +14/s"
        ],
        "effect": "移动速度 +65；生命恢复 +14/s；治疗量: 250；效果：破防",
        "ability": "破防：Whenever you attack a hero or are attacked by any unit, the bonus 14 HP regen is lost and the movement speed bonus is reduced to 40 for 13 seconds.",
        "lore": "While they increase the longevity of the wearer, this boot is not particularly reliable.",
        "suggest": "攻击力 +17% | 生命 +22% | 护甲 +12%",
        "tags": [
            "坦克反伤"
        ],
        "cd": 13
    },
    {
        "id": 107,
        "code": "pocket_roshan",
        "name": "口袋肉山",
        "en": "Pocket Roshan",
        "cost": 1000,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/pocket_roshan.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": 60
    },
    {
        "id": 108,
        "code": "orb_of_corrosion",
        "name": "腐蚀之球",
        "en": "Orb of Corrosion",
        "cost": 1050,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/orb_of_corrosion.png",
        "attr": [
            "攻击速度 +7%",
            "护甲 +0.98"
        ],
        "effect": "攻击速度 +7%；护甲 +0.98；持续时间: 3.0；效果：腐蚀",
        "ability": "腐蚀：Your attacks reduce the target's armor by -2, slows their movement by -16% (-8% against melee targets), and reduces Health Restoration by 16%. Lasts for 3 seconds.",
        "lore": "Seepage from the wounds of a warrior deity, sealed in an arcanist's orb following a campaign of vicious slaughter.",
        "suggest": "攻击力 +17% | 生命 +22% | 护甲 +12%",
        "tags": [
            "元素持续",
            "控制减速"
        ],
        "cd": false
    },
    {
        "id": 109,
        "code": "falcon_blade",
        "name": "猎鹰之刃",
        "en": "Falcon Blade",
        "cost": 1125,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/falcon_blade.png",
        "attr": [
            "最大生命 +200",
            "生命恢复 +1/s",
            "攻击力 +14"
        ],
        "effect": "最大生命 +200；生命恢复 +1/s；攻击力 +14",
        "ability": "",
        "lore": "An enchanted blade that long ago raised a hopeless urchin from pauper to king.",
        "suggest": "攻击力 +17% | 生命 +22% | 回复 +8%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 110,
        "code": "cornucopia",
        "name": "丰饶之角",
        "en": "Cornucopia",
        "cost": 1200,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/cornucopia.png",
        "attr": [
            "生命恢复 +5/s",
            "生命恢复 +2/s",
            "攻击力 +7"
        ],
        "effect": "生命恢复 +5/s；生命恢复 +2/s；攻击力 +7",
        "ability": "",
        "lore": "A source of spiritual and physical nourishment.",
        "suggest": "攻击力 +22% | 生命 +29% | 回复 +11%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 111,
        "code": "pavise",
        "name": "帕维斯",
        "en": "Pavise",
        "cost": 1350,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/pavise.png",
        "attr": [
            "护甲 +3",
            "最大生命 +175"
        ],
        "effect": "护甲 +3；最大生命 +175；持续时间: 7；效果：保护",
        "ability": "保护：When cast on an ally, grants them a physical damage barrier that absorbs 250 damage. Duration: 7s.",
        "lore": "Devised by a wizard who made one too many enemies.",
        "suggest": "攻击力 +22% | 生命 +29% | 护甲 +15%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 16
    },
    {
        "id": 112,
        "code": "power_treads",
        "name": "动力鞋",
        "en": "Power Treads",
        "cost": 1400,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/power_treads.png",
        "attr": [
            "移动速度 +45",
            "移动速度 +55",
            "攻击速度 +25%"
        ],
        "effect": "移动速度 +45；移动速度 +55；攻击速度 +25%；+10 所选属性；效果：切换属性",
        "ability": "切换属性：Switches between +10 Strength, +10 Agility, or +10 Intelligence.",
        "lore": "A pair of tough-skinned boots that change to meet the demands of the wearer.",
        "suggest": "攻击力 +22%",
        "tags": [
            "远程点杀",
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 113,
        "code": "pers",
        "name": "坚韧球",
        "en": "Perseverance",
        "cost": 1400,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/pers.png",
        "attr": [
            "生命恢复 +5/s",
            "生命恢复 +2/s"
        ],
        "effect": "生命恢复 +5/s；生命恢复 +2/s",
        "ability": "",
        "lore": "A gem that grants heart to the bearer.",
        "suggest": "生命 +29% | 回复 +11%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 114,
        "code": "aghanims_shard",
        "name": "阿哈利姆魔晶",
        "en": "Aghanim's Shard",
        "cost": 1400,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/aghanims_shard.png",
        "attr": [],
        "effect": "效果：技能升级",
        "ability": "技能升级：Upgrades an existing ability or adds a new ability to your hero.",
        "lore": "With origins known only to a single wizard, fragments of this impossible crystal are nearly as coveted as the renowned scepter itself.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 115,
        "code": "aghanims_shard_roshan",
        "name": "阿哈利姆魔晶（肉山）",
        "en": "Aghanim's Shard - Consumable",
        "cost": 1400,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/aghanims_shard_roshan.png",
        "attr": [],
        "effect": "效果：技能升级",
        "ability": "技能升级：Upgrades an existing ability or adds a new ability to your hero.",
        "lore": "With origins known only to a single wizard, fragments of this impossible crystal are nearly as coveted as the renowned scepter itself.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 116,
        "code": "phase_boots",
        "name": "相位鞋",
        "en": "Phase Boots",
        "cost": 1450,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/phase_boots.png",
        "attr": [
            "移动速度 +50",
            "攻击力 +18",
            "攻击力 +12",
            "护甲 +4"
        ],
        "effect": "移动速度 +50；攻击力 +18；攻击力 +12；护甲 +4；额外攻速: 0；效果：相位",
        "ability": "相位：Gives 20% increased movement speed on melee heroes, and 10% on ranged heroes, and lets you move through units and turn more quickly for 3 seconds.",
        "lore": "Boots that allow the wearer to travel between the ether.",
        "suggest": "攻击力 +22% | 攻速 +13% | 护甲 +15%",
        "tags": [
            "远程点杀",
            "坦克反伤"
        ],
        "cd": 8
    },
    {
        "id": 117,
        "code": "arcane_boots",
        "name": "秘法鞋",
        "en": "Arcane Boots",
        "cost": 1500,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/arcane_boots.png",
        "attr": [
            "移动速度 +45",
            "生命恢复 +1/s"
        ],
        "effect": "移动速度 +45；生命恢复 +1/s；光环半径: 1200；效果：补充；王者光环",
        "ability": "补充：Restores 150 mana to all nearby allies.\n\nRadius: 1200",
        "lore": "Magi equipped with these boots are valued in battle.",
        "suggest": "回复 +11%",
        "tags": [
            "法术爆发"
        ],
        "cd": 55
    },
    {
        "id": 118,
        "code": "oblivion_staff",
        "name": "空明杖",
        "en": "Oblivion Staff",
        "cost": 1625,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/oblivion_staff.png",
        "attr": [
            "魔法抗性 +4%",
            "伤害输出 +5%",
            "攻击速度 +35%",
            "生命恢复 +1/s"
        ],
        "effect": "魔法抗性 +4%；伤害输出 +5%；攻击速度 +35%；生命恢复 +1/s",
        "ability": "",
        "lore": "Deceptively hidden as an ordinary staff, it is actually very powerful, much like the Eldritch who originally possessed it.",
        "suggest": "攻击力 +22% | 回复 +11%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 119,
        "code": "ancient_janggo",
        "name": "韧鼓",
        "en": "Drum of Endurance",
        "cost": 1625,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ancient_janggo.png",
        "attr": [
            "生命恢复 +2.5/s",
            "最大生命 +160",
            "生命恢复 +0.4/s"
        ],
        "effect": "生命恢复 +2.5/s；最大生命 +160；生命恢复 +0.4/s；光环移速: 15；额外移速加成: 13；持续时间: 6；效果：耐力；迅捷光环",
        "ability": "耐力：Gives +35 attack speed and +13% movement speed to nearby allies for 6 seconds.\n\nRadius: 1200",
        "lore": "A relic that enchants the bodies of those around it for swifter movement in times of crisis.",
        "suggest": "攻击力 +22% | 攻速 +13% | 生命 +29%",
        "tags": [
            "坦克反伤"
        ],
        "cd": 45
    },
    {
        "id": 120,
        "code": "vanguard",
        "name": "先锋盾",
        "en": "Vanguard",
        "cost": 1700,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/vanguard.png",
        "attr": [
            "最大生命 +250",
            "生命恢复 +4/s"
        ],
        "effect": "最大生命 +250；生命恢复 +4/s；格挡几率: 60；效果：伤害格挡",
        "ability": "伤害格挡：Grants a 60% chance to block 50 damage from incoming attacks on melee heroes, and 25 damage on ranged.",
        "lore": "A powerful shield that defends its wielder from even the most vicious of attacks.",
        "suggest": "攻击力 +22% | 生命 +29% | 回复 +11%",
        "tags": [
            "远程点杀",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 121,
        "code": "veil_of_discord",
        "name": "纷争面纱",
        "en": "Veil of Discord",
        "cost": 1700,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/veil_of_discord.png",
        "attr": [
            "最大生命 +175",
            "魔法抗性 +4%",
            "伤害输出 +5%"
        ],
        "effect": "最大生命 +175；魔法抗性 +4%；伤害输出 +5%；+18% 吸血；增伤: 10；效果：法术虚弱",
        "ability": "法术虚弱：Cast a 900 radius blast that causes enemy heroes to take 10% increased damage from spells.\n\nCan be cast while channeling.\n\nDuration: 16 seconds.",
        "lore": "The headwear of corrupt magi.",
        "suggest": "攻击力 +22% | 生命 +29%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 16
    },
    {
        "id": 122,
        "code": "mekansm",
        "name": "梅肯斯姆",
        "en": "Mekansm",
        "cost": 1775,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/mekansm.png",
        "attr": [
            "护甲 +5",
            "生命恢复 +2.5/s"
        ],
        "effect": "护甲 +5；生命恢复 +2.5/s；光环半径: 1200；治疗量: 250；效果：恢复；梅肯光环",
        "ability": "恢复：Restores 250 health to allied units in a 1200 radius.",
        "lore": "A glowing jewel formed out of assorted parts that somehow fit together perfectly.",
        "suggest": "生命 +29% | 护甲 +15% | 回复 +11%",
        "tags": [
            "坦克反伤"
        ],
        "cd": 50
    },
    {
        "id": 123,
        "code": "essence_distiller",
        "name": "精华萃取器",
        "en": "Essence Distiller",
        "cost": 1775,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/essence_distiller.png",
        "attr": [
            "生命恢复 +1/s",
            "最大生命 +60",
            "攻击速度 +3%",
            "魔法抗性 +1.2%",
            "护甲 +0.42",
            "护甲 +6"
        ],
        "effect": "生命恢复 +1/s；最大生命 +60；攻击速度 +3%；魔法抗性 +1.2%；护甲 +0.42；护甲 +6；持续时间: 8.0；效果：灵魂释放",
        "ability": "灵魂释放：Provides 40 health regeneration when cast on allies.\n\nCan be ground targeted to lie dormant for up to 15s and attach to the first enemy that comes within 400 radius. When on enemies, deals 25 damage per second and provides True Sight over them and shares their vision with the wearer's team.\n\nLasts 8 seconds.\n\nGains charges every time an enemy hero dies within 1500 units.",
        "lore": "",
        "suggest": "攻击力 +22% | 生命 +29% | 护甲 +15%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 10
    },
    {
        "id": 124,
        "code": "dragon_lance",
        "name": "魔龙枪",
        "en": "Dragon Lance",
        "cost": 1900,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/dragon_lance.png",
        "attr": [
            "攻击速度 +15%",
            "护甲 +2.1",
            "最大生命 +200",
            "生命恢复 +0.5/s",
            "攻击距离 +130"
        ],
        "effect": "攻击速度 +15%；护甲 +2.1；最大生命 +200；生命恢复 +0.5/s；攻击距离 +130",
        "ability": "",
        "lore": "The forward charge of the wyvern host grants no quarter.",
        "suggest": "攻击力 +22%",
        "tags": [
            "远程点杀",
            "召唤增殖"
        ],
        "cd": false
    },
    {
        "id": 125,
        "code": "mask_of_madness",
        "name": "疯狂面具",
        "en": "Mask of Madness",
        "cost": 1900,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/mask_of_madness.png",
        "attr": [
            "攻击力 +20"
        ],
        "effect": "攻击力 +20；+24% 吸血；效果：狂暴；吸血",
        "ability": "狂暴：Gives 100 attack speed, 8% / 12% movement speed (ranged/melee), and 30% slow resistance, but reduces your armor by 7 and silences you. Lasts 6 seconds.",
        "lore": "Once this mask is worn, its bearer becomes an uncontrollable aggressive force.",
        "suggest": "攻击力 +22% | 攻速 +13% | 护甲 +15%",
        "tags": [
            "远程点杀",
            "控制减速"
        ],
        "cd": 16
    },
    {
        "id": 126,
        "code": "lesser_crit",
        "name": "水晶剑",
        "en": "Crystalys",
        "cost": 2000,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/lesser_crit.png",
        "attr": [
            "攻击力 +32",
            "暴击率 +30%",
            "暴击倍率 +160%"
        ],
        "effect": "攻击力 +32；暴击率 +30%；暴击倍率 +160%；效果：致命一击",
        "ability": "致命一击：Grants each attack a 30% chance to deal 160% damage.",
        "lore": "A blade forged from rare crystals, it seeks weak points in enemy armor.",
        "suggest": "攻击力 +22% | 护甲 +15% | 暴击 +11%",
        "tags": [
            "物理暴击",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 127,
        "code": "kaya",
        "name": "慧光",
        "en": "Kaya",
        "cost": 2100,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/kaya.png",
        "attr": [
            "魔法抗性 +6.4%",
            "伤害输出 +8%",
            "生命恢复 +30/s"
        ],
        "effect": "魔法抗性 +6.4%；伤害输出 +8%；生命恢复 +30/s；+10% 增伤",
        "ability": "",
        "lore": "",
        "suggest": "回复 +11%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 128,
        "code": "sange",
        "name": "散华",
        "en": "Sange",
        "cost": 2100,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/sange.png",
        "attr": [
            "最大生命 +320",
            "生命恢复 +0.8/s",
            "生命恢复 +16/s"
        ],
        "effect": "最大生命 +320；生命恢复 +0.8/s；生命恢复 +16/s；+25% 减速抗性",
        "ability": "",
        "lore": "Sange is an unusually accurate weapon, seeking weak points automatically.",
        "suggest": "生命 +29% | 回复 +11%",
        "tags": [
            "控制减速",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 129,
        "code": "yasha",
        "name": "夜叉",
        "en": "Yasha",
        "cost": 2100,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/yasha.png",
        "attr": [
            "攻击速度 +16%",
            "护甲 +2.24",
            "攻击速度 +15%",
            "移动速度 +10"
        ],
        "effect": "攻击速度 +16%；护甲 +2.24；攻击速度 +15%；移动速度 +10",
        "ability": "",
        "lore": "Yasha is regarded as the swiftest weapon ever created.",
        "suggest": "攻击力 +22%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 130,
        "code": "glimmer_cape",
        "name": "微光披风",
        "en": "Glimmer Cape",
        "cost": 2150,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/glimmer_cape.png",
        "attr": [
            "魔法抗性 +20%"
        ],
        "effect": "魔法抗性 +20%；持续时间: 5；效果：微光",
        "ability": "微光：After a 0.5 second delay, grants invisibility, 20 movement speed and a magic damage barrier that absorbs up to 375 damage to you or a target allied unit for 5 seconds.\n\nCan be cast while channeling.",
        "lore": "The stolen cape of a master illusionist.",
        "suggest": "攻击力 +22%",
        "tags": [
            "法术爆发",
            "召唤增殖"
        ],
        "cd": 15
    },
    {
        "id": 131,
        "code": "hand_of_midas",
        "name": "迈达斯之手",
        "en": "Hand of Midas",
        "cost": 2200,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/hand_of_midas.png",
        "attr": [
            "攻击速度 +35%"
        ],
        "effect": "攻击速度 +35%；效果：转化",
        "ability": "转化：Kills a non-hero target for 160 gold. Killing a neutral creep additionally grants a madstone bundle. \n\n Cannot be used on Ancient creeps.",
        "lore": "Preserved through unknown magical means, the Hand of Midas is a weapon of greed, sacrificing animals to line the owner's pockets.",
        "suggest": "攻击力 +22% | 金币获取 +13%",
        "tags": [
            "法术爆发",
            "召唤增殖"
        ],
        "cd": false
    },
    {
        "id": 132,
        "code": "vladmir",
        "name": "弗拉迪米尔的祭品",
        "en": "Vladmir's Offering",
        "cost": 2200,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/vladmir.png",
        "attr": [
            "护甲 +1"
        ],
        "effect": "护甲 +1；光环半径: 1200；效果：祭品光环",
        "ability": "祭品光环：Grants 20% lifesteal, 18% bonus damage, 1 mana regeneration, and 2 armor to nearby allies.\n\nRadius: 1200",
        "lore": "An eerie mask that is haunted with the malice of a fallen vampire.",
        "suggest": "攻击力 +22% | 护甲 +15% | 回复 +11%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": false
    },
    {
        "id": 133,
        "code": "force_staff",
        "name": "原力法杖",
        "en": "Force Staff",
        "cost": 2200,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/force_staff.png",
        "attr": [
            "魔法抗性 +4%",
            "伤害输出 +5%",
            "最大生命 +175"
        ],
        "effect": "魔法抗性 +4%；伤害输出 +5%；最大生命 +175；效果：推力",
        "ability": "推力：Pushes any target unit 600 units in the direction it is facing.",
        "lore": "Allows you to manipulate others, for good or evil.",
        "suggest": "生命 +29%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 19
    },
    {
        "id": 134,
        "code": "holy_locket",
        "name": "圣洁吊坠",
        "en": "Holy Locket",
        "cost": 2250,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/holy_locket.png",
        "attr": [
            "最大生命 +140",
            "攻击速度 +7%",
            "魔法抗性 +2.8%",
            "护甲 +0.98"
        ],
        "effect": "最大生命 +140；攻击速度 +7%；魔法抗性 +2.8%；护甲 +0.98；最大充能: 25；冷却: 13；效果：能量充能；神圣祝福",
        "ability": "能量充能：Target an allied unit to increase their incoming Heal Amplification by 10% for 4s and instantly restore 17 health and 15 mana per charge stored. \n\nAutomatically gains a charge every 10 seconds and whenever a visible enemy within 1200 range uses an ability.",
        "lore": "A prized relic long thought lost forever in a failed crusade.",
        "suggest": "生命 +29% | 冷却 -11%",
        "tags": [
            "远程点杀",
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 135,
        "code": "rod_of_atos",
        "name": "阿托斯之棍",
        "en": "Rod of Atos",
        "cost": 2250,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/rod_of_atos.png",
        "attr": [
            "魔法抗性 +4.8%",
            "伤害输出 +6%",
            "最大生命 +275"
        ],
        "effect": "魔法抗性 +4.8%；伤害输出 +6%；最大生命 +275；持续时间: 2.0；效果：致残",
        "ability": "致残：Roots the target for 2 seconds.",
        "lore": "Atos, the Lord of Blight, has his essence stored in this deceptively simple wand.",
        "suggest": "生命 +29%",
        "tags": [
            "控制减速",
            "坦克反伤"
        ],
        "cd": 18
    },
    {
        "id": 136,
        "code": "aether_lens",
        "name": "以太之镜",
        "en": "Aether Lens",
        "cost": 2275,
        "quality": "blue",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/aether_lens.png",
        "attr": [
            "生命恢复 +2/s"
        ],
        "effect": "生命恢复 +2/s；+225 施法距离",
        "ability": "",
        "lore": "Polished with the incantation of his final breath, the gift of a dying mage to his sickly son.",
        "suggest": "回复 +11%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 137,
        "code": "blade_mail",
        "name": "刃甲",
        "en": "Blade Mail",
        "cost": 2400,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/blade_mail.png",
        "attr": [
            "攻击力 +15",
            "护甲 +7"
        ],
        "effect": "攻击力 +15；护甲 +7；持续时间: 5.5；效果：伤害反弹；伤害反弹",
        "ability": "伤害反弹：For 5.5 seconds, return all incoming damage, increasing the percentage by 85%.",
        "lore": "A razor-sharp coat of mail, it is the choice of selfless martyrs in combat.",
        "suggest": "攻击力 +22% | 护甲 +15%",
        "tags": [
            "元素持续",
            "坦克反伤"
        ],
        "cd": 25
    },
    {
        "id": 138,
        "code": "travel_boots",
        "name": "远行鞋",
        "en": "Boots of Travel",
        "cost": 2500,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/travel_boots.png",
        "attr": [
            "移动速度 +90"
        ],
        "effect": "移动速度 +90；回城冷却: 40；效果：回城卷轴",
        "ability": "回城卷轴：Upgrades your Town Portal Scroll, allowing it to target units, reduces cooldown and does not consume a charge on usage.",
        "lore": "Winged boots that grant omnipresence.",
        "suggest": "冷却 -11%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 139,
        "code": "armlet",
        "name": "臂章",
        "en": "Armlet of Mordiggian",
        "cost": 2500,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/armlet.png",
        "attr": [
            "攻击力 +15",
            "攻击速度 +25%",
            "护甲 +6",
            "生命恢复 +5/s"
        ],
        "effect": "攻击力 +15；攻击速度 +25%；护甲 +6；生命恢复 +5/s；效果：邪恶之力",
        "ability": "邪恶之力：When active, Unholy Strength grants +35 damage, +25 strength and +4 armor, but drains 45 health per second.\n\n You cannot die from the health drain when Unholy Strength is activated, nor from the strength loss when Unholy Strength is deactivated.",
        "lore": "Weapon of choice among brutes, the bearer sacrifices his life energy to gain immense strength and power.",
        "suggest": "攻击力 +22% | 生命 +29% | 护甲 +15%",
        "tags": [
            "元素持续",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 140,
        "code": "diffusal_blade",
        "name": "净魂之刃",
        "en": "Diffusal Blade",
        "cost": 2500,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/diffusal_blade.png",
        "attr": [
            "攻击速度 +15%",
            "护甲 +2.1",
            "魔法抗性 +4%",
            "伤害输出 +5%"
        ],
        "effect": "攻击速度 +15%；护甲 +2.1；魔法抗性 +4%；伤害输出 +5%；效果：抑制；破法",
        "ability": "抑制：Targets an enemy, slowing it for 4 seconds.",
        "lore": "An enchanted blade that allows the user to cut straight into the enemy's soul.",
        "suggest": "攻击力 +22%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 15
    },
    {
        "id": 141,
        "code": "helm_of_the_dominator",
        "name": "支配头盔",
        "en": "Helm of the Dominator",
        "cost": 2550,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/helm_of_the_dominator.png",
        "attr": [
            "最大生命 +120",
            "攻击速度 +6%",
            "魔法抗性 +2.4%",
            "护甲 +0.84",
            "护甲 +6",
            "生命恢复 +6/s"
        ],
        "effect": "最大生命 +120；攻击速度 +6%；魔法抗性 +2.4%；护甲 +0.84；护甲 +6；生命恢复 +6/s；效果：支配",
        "ability": "支配：Takes control of one neutral, non-ancient target unit and sets its movement speed to 370 and max health to a minimum of 1000. Also provides the unit with +25 base attack damage, +12 health regen, +4 mana regen and +4 armor. \n\nDominated units with a max health of greater than 1000 retain their original max health. Grants the caster 50% of the gold and experience bounty of the dominated creep. Dominated unit's bounty is set to 100 gold and it can no longer be killed by abilities that instantly kill creeps otherwise.\n\nThe Helm cannot be used for 3 seconds after the dominated creep takes damage from an enemy hero or Roshan.",
        "lore": "The powerful headpiece of a dead necromancer.",
        "suggest": "攻击力 +22% | 生命 +29% | 护甲 +15%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 45
    },
    {
        "id": 142,
        "code": "specialists_array",
        "name": "专家阵列",
        "en": "Specialist's Array",
        "cost": 2550,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/specialists_array.png",
        "attr": [
            "攻击速度 +12%",
            "护甲 +1.68",
            "攻击力 +20"
        ],
        "effect": "攻击速度 +12%；护甲 +1.68；攻击力 +20；触发几率: 30；效果：分裂射击",
        "ability": "分裂射击：Ranged attacks have a 30% chance to fire additional projectiles at up to 2 nearby enemies with 150 extra range and within a 120 degree angle in front of the attacker. The additional projectiles deal 20 + 75% damage of a normal attack and do not trigger on hit effects. The primary attack deals 20 + 100% damage of a normal attack.",
        "lore": "An impressive kit of trigger enhancements born in an aging assassin's idle mind.",
        "suggest": "攻击力 +22%",
        "tags": [
            "远程点杀",
            "元素持续"
        ],
        "cd": false
    },
    {
        "id": 143,
        "code": "solar_crest",
        "name": "炎阳纹章",
        "en": "Solar Crest",
        "cost": 2575,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/solar_crest.png",
        "attr": [
            "护甲 +7",
            "移动速度 +25",
            "最大生命 +200"
        ],
        "effect": "护甲 +7；移动速度 +25；最大生命 +200；持续时间: 7；效果：闪耀",
        "ability": "闪耀：When cast on an ally, grants them 5 armor, 60 attack speed, 15% movement speed and a 350 physical damage barrier. \n\nDoes not grant bonus armor, movement or attack speed if used on self. \n\nDuration: 7",
        "lore": "A talisman forged to honor the daytime sky.",
        "suggest": "攻击力 +22% | 攻速 +13% | 生命 +29%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 16
    },
    {
        "id": 144,
        "code": "phylactery",
        "name": "灵匣",
        "en": "Phylactery",
        "cost": 2600,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/phylactery.png",
        "attr": [
            "最大生命 +120",
            "攻击速度 +6%",
            "魔法抗性 +2.4%",
            "护甲 +0.84",
            "生命恢复 +5/s",
            "生命恢复 +2/s"
        ],
        "effect": "最大生命 +120；攻击速度 +6%；魔法抗性 +2.4%；护甲 +0.84；生命恢复 +5/s；生命恢复 +2/s；效果：强化法术",
        "ability": "强化法术：The next Unit Target spell you cast on an enemy deals a separate 150 bonus damage to the target and slows them by 30% for 3s.",
        "lore": "An amulet overflowing with powerful magics.",
        "suggest": "攻击力 +22% | 生命 +29% | 回复 +11%",
        "tags": [
            "法术爆发",
            "控制减速"
        ],
        "cd": 9
    },
    {
        "id": 145,
        "code": "cyclone",
        "name": "尤尔的神圣权杖",
        "en": "Eul's Scepter of Divinity",
        "cost": 2600,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/cyclone.png",
        "attr": [
            "魔法抗性 +4%",
            "伤害输出 +5%",
            "生命恢复 +2/s",
            "移动速度 +20"
        ],
        "effect": "魔法抗性 +4%；伤害输出 +5%；生命恢复 +2/s；移动速度 +20；效果：龙卷风",
        "ability": "龙卷风：Sweeps a target unit up into a cyclone, making them invulnerable for 2.5 seconds. Cyclone can only be cast on enemy units or yourself.\n\nEnemy units take 50 magical damage upon landing.\nDispel Type: Basic Dispel",
        "lore": "A mysterious scepter passed down through the ages, its disruptive winds can be used for good or evil.",
        "suggest": "攻击力 +22% | 回复 +11%",
        "tags": [
            "法术爆发",
            "召唤增殖"
        ],
        "cd": 23
    },
    {
        "id": 146,
        "code": "consecrated_wraps",
        "name": "圣化裹布",
        "en": "Consecrated Wraps",
        "cost": 2600,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/consecrated_wraps.png",
        "attr": [
            "魔法抗性 +15%",
            "最大生命 +120",
            "攻击速度 +6%",
            "魔法抗性 +2.4%",
            "护甲 +0.84",
            "最大生命 +250"
        ],
        "effect": "魔法抗性 +15%；最大生命 +120；攻击速度 +6%；魔法抗性 +2.4%；护甲 +0.84；最大生命 +250；最大层数: 3；持续时间: 7；效果：神圣",
        "ability": "神圣：Gain a stack every 3s, up to a maximum of 3 stacks. Upon gaining a stack, your movement speed is increased by 20% for 7s.\n\nWhenever you take damage from a player-controlled unit or Roshan, consume all stacks to gain an all damage barrier for 7s that absorbs 120 damage per stack (360 max).",
        "lore": "",
        "suggest": "攻击力 +22% | 生命 +29%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 147,
        "code": "echo_sabre",
        "name": "回音战刃",
        "en": "Echo Sabre",
        "cost": 2700,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/echo_sabre.png",
        "attr": [
            "攻击力 +20",
            "最大生命 +300",
            "生命恢复 +0.75/s",
            "生命恢复 +1/s"
        ],
        "effect": "攻击力 +20；最大生命 +300；生命恢复 +0.75/s；生命恢复 +1/s；移速减缓: 100；效果：回音击",
        "ability": "回音击：Causes melee attacks to attack twice in quick succession. The double attacks apply a 100% movement slow for 0.8 seconds on the first strike.",
        "lore": "A deceptively swift blade imbued with resonant magic.",
        "suggest": "攻击力 +22% | 回复 +11%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 5
    },
    {
        "id": 148,
        "code": "spirit_vessel",
        "name": "魂之灵瓮",
        "en": "Spirit Vessel",
        "cost": 2725,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/spirit_vessel.png",
        "attr": [
            "生命恢复 +1/s",
            "最大生命 +200",
            "攻击速度 +10%",
            "魔法抗性 +4%",
            "护甲 +1.4",
            "护甲 +2"
        ],
        "effect": "生命恢复 +1/s；最大生命 +200；攻击速度 +10%；魔法抗性 +4%；护甲 +1.4；护甲 +2；持续时间: 8.0；效果：灵魂释放",
        "ability": "灵魂释放：When used against enemies, it reduces health by 4% of current health per second, and reduces Health Restoration by 70%. Deals 25 damage per second. \n\nWhen used on allies, it provides 40 health regeneration per second. \n\nLasts 8 seconds.\n\nGains charges every time an enemy hero dies within 1500 units or the user dies.",
        "lore": "",
        "suggest": "攻击力 +22% | 生命 +29% | 护甲 +15%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 10
    },
    {
        "id": 149,
        "code": "witch_blade",
        "name": "巫师之刃",
        "en": "Witch Blade",
        "cost": 2775,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/witch_blade.png",
        "attr": [
            "攻击速度 +40%",
            "魔法抗性 +4.8%",
            "伤害输出 +6%",
            "生命恢复 +1/s",
            "护甲 +5"
        ],
        "effect": "攻击速度 +40%；魔法抗性 +4.8%；伤害输出 +6%；生命恢复 +1/s；护甲 +5；+300 弹道速度；效果：巫师之刃",
        "ability": "巫师之刃：Causes your next attack to apply a poison for 4 seconds, slowing by 25% and dealing 0.75x your intelligence as damage every second. This attack has True Strike.",
        "lore": "A spiteful blade inadvertently possessed by the soul of its incautious creator.",
        "suggest": "攻击力 +22% | 护甲 +15% | 回复 +11%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 9
    },
    {
        "id": 150,
        "code": "meteor_hammer",
        "name": "陨星锤",
        "en": "Meteor Hammer",
        "cost": 2850,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/meteor_hammer.png",
        "attr": [
            "最大生命 +120",
            "生命恢复 +0.3/s",
            "攻击速度 +6%",
            "护甲 +0.84",
            "魔法抗性 +9.6%",
            "伤害输出 +12%",
            "生命恢复 +35/s"
        ],
        "effect": "最大生命 +120；生命恢复 +0.3/s；攻击速度 +6%；护甲 +0.84；魔法抗性 +9.6%；伤害输出 +12%；生命恢复 +35/s；+10% 增伤；眩晕时间: 0.75；效果：陨星锤",
        "ability": "陨星锤：CHANNELED - After a successful channel, summons a meteor that strikes a 400 AoE, stunning enemies for 0.75 seconds and dealing impact damage. Continues to deal damage over time to enemies units and buildings for 6 seconds. Non-building units are also slowed for 20% for the duration of the burn. \n\nBuilding Impact Damage: 90 \nBuilding Over Time Damage: 50 \n\nNon-Building Impact Damage: 130 \nNon-Building Over Time Damage: 50 \n\nChannel Duration: 2 seconds.\nLanding Time: 0.5 seconds.",
        "lore": "",
        "suggest": "攻击力 +22% | 回复 +11% | 召唤物强度 +13%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 24
    },
    {
        "id": 151,
        "code": "basher",
        "name": "碎颅锤",
        "en": "Skull Basher",
        "cost": 2875,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/basher.png",
        "attr": [
            "攻击力 +30",
            "最大生命 +200",
            "生命恢复 +0.5/s"
        ],
        "effect": "攻击力 +30；最大生命 +200；生命恢复 +0.5/s；效果：重击",
        "ability": "重击：Grants melee heroes a 25% chance on hit to stun the target for 1.2 seconds and deal 100 bonus physical damage. Bash chance for ranged heroes is 10%.",
        "lore": "A feared weapon in the right hands, this maul's ability to shatter the defenses of its opponents should not be underestimated.",
        "suggest": "攻击力 +22%",
        "tags": [
            "远程点杀",
            "控制减速"
        ],
        "cd": 2
    },
    {
        "id": 152,
        "code": "maelstrom",
        "name": "漩涡",
        "en": "Maelstrom",
        "cost": 2950,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/maelstrom.png",
        "attr": [
            "攻击力 +25",
            "攻击速度 +25%"
        ],
        "effect": "攻击力 +25；攻击速度 +25%；效果：连锁闪电",
        "ability": "连锁闪电：Grants a 25% chance on attack to release a bolt of electricity that leaps between 4 targets within a 650 radius, dealing 110 magical damage to each. Lightning proc pierces evasion.",
        "lore": "A hammer forged for the gods themselves, Maelstrom allows its user to harness the power of lightning.",
        "suggest": "攻击力 +22% | 闪避 +9%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": false
    },
    {
        "id": 153,
        "code": "aeon_disk",
        "name": "永恒之盘",
        "en": "Aeon Disk",
        "cost": 3000,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/aeon_disk.png",
        "attr": [
            "最大生命 +250"
        ],
        "effect": "最大生命 +250；状态抗性: 75；冷却: 105.0 / 125.0 / 145.0 / 165.0；效果：连击破除",
        "ability": "连击破除：When you take damage and your health falls below 70%, a strong dispel is applied and you gain a 2.5 second buff that provides +75% Status Resistance and causes all damage you deal and are dealt to be reduced to zero. Only triggers on player based damage. Cooldown increases every time it triggers.Dispel Type: Strong Dispel",
        "lore": "",
        "suggest": "攻击力 +27% | 生命 +36% | 冷却 -14%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 105
    },
    {
        "id": 154,
        "code": "soul_booster",
        "name": "灵魂之匣",
        "en": "Soul Booster",
        "cost": 3000,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/soul_booster.png",
        "attr": [
            "最大生命 +425"
        ],
        "effect": "最大生命 +425",
        "ability": "",
        "lore": "Regain lost courage.",
        "suggest": "生命 +36%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 155,
        "code": "dagon",
        "name": "达贡之神力",
        "en": "Dagon",
        "cost": 3050,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/dagon.png",
        "attr": [
            "最大生命 +120",
            "攻击速度 +6%",
            "魔法抗性 +2.4%",
            "护甲 +0.84",
            "最大生命 +200"
        ],
        "effect": "最大生命 +120；攻击速度 +6%；魔法抗性 +2.4%；护甲 +0.84；最大生命 +200；伤害: 400 / 500 / 600 / 700 / 800；+60/90/120/150/180 施法距离；效果：能量爆发",
        "ability": "能量爆发：Emits a powerful burst of magical damage upon a targeted enemy unit. Upgradable.\n\nDamage: 400\n Mana Cost: 120",
        "lore": "A lesser wand that grows in power the longer it is used, it brings magic to the fingertips of the user.",
        "suggest": "攻击力 +27% | 生命 +36%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 27
    },
    {
        "id": 156,
        "code": "mage_slayer",
        "name": "法师克星",
        "en": "Mage Slayer",
        "cost": 3100,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/mage_slayer.png",
        "attr": [
            "魔法抗性 +20%",
            "生命恢复 +6/s",
            "生命恢复 +2/s",
            "攻击力 +15"
        ],
        "effect": "魔法抗性 +20%；生命恢复 +6/s；生命恢复 +2/s；攻击力 +15；持续时间: 3；效果：法师克星",
        "ability": "法师克星：Places a debuff when you attack enemies, dealing 40 physical damage per second and causing them to do 40% less spell damage for 3 seconds.",
        "lore": "Forged by a secret order in The Third Age of Praxa'cia to fell the False King.",
        "suggest": "攻击力 +27% | 生命 +36% | 回复 +14%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 157,
        "code": "invis_sword",
        "name": "影刃",
        "en": "Shadow Blade",
        "cost": 3250,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/invis_sword.png",
        "attr": [
            "攻击力 +25",
            "攻击速度 +35%"
        ],
        "effect": "攻击力 +25；攻击速度 +35%；效果：暗影步",
        "ability": "暗影步：Makes you invisible for 17 seconds, or until you attack or cast a spell. While Shadow Walk is active, you move 20% faster and can move through units. \n\nIf attacking to end the invisibility, you gain 175 bonus physical damage on that attack.",
        "lore": "The blade of a fallen king, it allows you to move unseen and strike from the shadows.",
        "suggest": "攻击力 +27%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 25
    },
    {
        "id": 158,
        "code": "orchid",
        "name": "紫怨",
        "en": "Orchid Malevolence",
        "cost": 3275,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/orchid.png",
        "attr": [
            "攻击速度 +35%",
            "攻击力 +20",
            "生命恢复 +2/s",
            "魔法抗性 +4.8%",
            "伤害输出 +6%"
        ],
        "effect": "攻击速度 +35%；攻击力 +20；生命恢复 +2/s；魔法抗性 +4.8%；伤害输出 +6%；效果：灵魂灼烧",
        "ability": "灵魂灼烧：Silences the target unit for 5 seconds. At the end of the silence, 30% of the damage received while silenced is inflicted as bonus magical damage.",
        "lore": "A garnet rod constructed from the essence of a fire demon.",
        "suggest": "攻击力 +27% | 生命 +36% | 回复 +14%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 18
    },
    {
        "id": 159,
        "code": "revenants_brooch",
        "name": "英灵胸针",
        "en": "Revenant's Brooch",
        "cost": 3300,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/revenants_brooch.png",
        "attr": [
            "攻击力 +35",
            "暴击率 +30%",
            "暴击倍率 +80%"
        ],
        "effect": "攻击力 +35；暴击率 +30%；暴击倍率 +80%；+15% 吸血；效果：幻影暴击",
        "ability": "幻影暴击：Grants each attack a 30% chance to deal an additional 80% of the attack's damage as bonus magic damage.",
        "lore": "The cursed brooch of a fallen guardian who stalks forever between the veil of life and death.",
        "suggest": "攻击力 +27% | 暴击 +14%",
        "tags": [
            "物理暴击",
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 160,
        "code": "heavens_halberd",
        "name": "天堂之戟",
        "en": "Heaven's Halberd",
        "cost": 3400,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/heavens_halberd.png",
        "attr": [
            "护甲 +9",
            "生命恢复 +6/s",
            "闪避 +25%"
        ],
        "effect": "护甲 +9；生命恢复 +6/s；闪避 +25%；效果：缴械",
        "ability": "缴械：Prevents a target from attacking for 3.5 seconds.",
        "lore": "This halberd moves with the speed of a smaller weapon, allowing the bearer to win duels that a heavy edge would not.",
        "suggest": "攻击力 +27% | 生命 +36% | 护甲 +19%",
        "tags": [
            "坦克反伤"
        ],
        "cd": 16
    },
    {
        "id": 161,
        "code": "desolator",
        "name": "黯灭",
        "en": "Desolator",
        "cost": 3500,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/desolator.png",
        "attr": [
            "攻击力 +55"
        ],
        "effect": "攻击力 +55；效果：腐蚀；灵魂窃取",
        "ability": "腐蚀：Your attacks reduce the target's armor by -6 for 7 seconds.",
        "lore": "A wicked weapon, used in torturing political criminals.",
        "suggest": "攻击力 +27% | 护甲 +19%",
        "tags": [
            "元素持续",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 162,
        "code": "pipe",
        "name": "洞察烟斗",
        "en": "Pipe of Insight",
        "cost": 3725,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/pipe.png",
        "attr": [
            "生命恢复 +14/s",
            "魔法抗性 +20%"
        ],
        "effect": "生命恢复 +14/s；魔法抗性 +20%；光环半径: 1200；效果：护盾；洞察光环",
        "ability": "护盾：Gives a magic damage barrier that absorbs 425 damage to all nearby allies. Lasts 8 seconds.\n\nRadius: 1200",
        "lore": "A powerful artifact of mysterious origin, it creates barriers against magical forces.",
        "suggest": "攻击力 +27% | 生命 +36% | 回复 +14%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 60
    },
    {
        "id": 163,
        "code": "crimson_guard",
        "name": "赤红甲",
        "en": "Crimson Guard",
        "cost": 3725,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/crimson_guard.png",
        "attr": [
            "最大生命 +250",
            "生命恢复 +12/s",
            "护甲 +6"
        ],
        "effect": "最大生命 +250；生命恢复 +12/s；护甲 +6；格挡几率: 60；持续时间: 7；效果：守卫；伤害格挡",
        "ability": "守卫：For 7 seconds, grant nearby allied heroes and buildings a 100% chance to block damage equal to 70 plus 2% of the caster's max health value from each incoming attack.\n\nRadius: 1200",
        "lore": "A cuirass originally built to protect against the dreaded Year Beast.",
        "suggest": "攻击力 +27% | 生命 +36% | 护甲 +19%",
        "tags": [
            "远程点杀",
            "坦克反伤"
        ],
        "cd": 40
    },
    {
        "id": 164,
        "code": "wraith_pact",
        "name": "怨灵契约",
        "en": "Wraith Pact",
        "cost": 3800,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/wraith_pact.png",
        "attr": [
            "最大生命 +250"
        ],
        "effect": "最大生命 +250；光环半径: 1200",
        "ability": "",
        "lore": "",
        "suggest": "生命 +36%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 60
    },
    {
        "id": 165,
        "code": "lotus_orb",
        "name": "清莲宝珠",
        "en": "Lotus Orb",
        "cost": 3850,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/lotus_orb.png",
        "attr": [
            "护甲 +10",
            "生命恢复 +6/s",
            "生命恢复 +4/s"
        ],
        "effect": "护甲 +10；生命恢复 +6/s；生命恢复 +4/s；效果：回音之壳",
        "ability": "回音之壳：Applies a shield to the target unit for 5 seconds which re-casts most targeted spells back to their caster.\n\nThe shielded unit will still take damage from the spell.\nDispel Type: Basic Dispel",
        "lore": "The jewel at its center still reflects a pale image of its creator.",
        "suggest": "攻击力 +27% | 生命 +36% | 护甲 +19%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 15
    },
    {
        "id": 166,
        "code": "eternal_shroud",
        "name": "永世法衣",
        "en": "Eternal Shroud",
        "cost": 3900,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/eternal_shroud.png",
        "attr": [
            "魔法抗性 +20%",
            "最大生命 +200",
            "生命恢复 +0.5/s",
            "最大生命 +250"
        ],
        "effect": "魔法抗性 +20%；最大生命 +200；生命恢复 +0.5/s；最大生命 +250；层数持续时间: 5；最大层数: 6；效果：遮蔽；永恒耐力",
        "ability": "遮蔽：Restores mana equal to 25% of incoming enemy spell damage before reductions.",
        "lore": "A pristine hood that feeds upon strife to empower its owner.",
        "suggest": "攻击力 +27% | 生命 +36% | 元素强度 +14%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 167,
        "code": "bfury",
        "name": "狂战斧",
        "en": "Battle Fury",
        "cost": 3900,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/bfury.png",
        "attr": [
            "攻击力 +50",
            "生命恢复 +7/s",
            "生命恢复 +2/s"
        ],
        "effect": "攻击力 +50；生命恢复 +7/s；生命恢复 +2/s；效果：砍树；压制；分裂攻击",
        "ability": "砍树：Destroy a target tree.",
        "lore": "The bearer of this mighty axe gains the ability to cut down swaths of enemies at once.",
        "suggest": "攻击力 +27% | 生命 +36% | 回复 +14%",
        "tags": [
            "远程点杀",
            "法术爆发"
        ],
        "cd": 4
    },
    {
        "id": 168,
        "code": "black_king_bar",
        "name": "黑皇杖",
        "en": "Black King Bar",
        "cost": 4050,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/black_king_bar.png",
        "attr": [
            "最大生命 +200",
            "生命恢复 +0.5/s",
            "攻击力 +24"
        ],
        "effect": "最大生命 +200；生命恢复 +0.5/s；攻击力 +24；持续时间: 9 / 8 / 7；效果：天神下凡",
        "ability": "天神下凡：Applies a basic dispel. Grants 60% magic resistance and immunity to reflected and pure damage. For the duration of the effect, any negative effect from enemy spells has no effect. \n\nDuration: 9s \nDispel Type: Basic Dispel",
        "lore": "A powerful staff imbued with the strength of giants.",
        "suggest": "攻击力 +27% | 元素强度 +14%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 95
    },
    {
        "id": 169,
        "code": "ultimate_scepter",
        "name": "阿哈利姆神杖",
        "en": "Aghanim's Scepter",
        "cost": 4200,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ultimate_scepter.png",
        "attr": [
            "最大生命 +200",
            "攻击速度 +10%",
            "魔法抗性 +4%",
            "护甲 +1.4",
            "最大生命 +175"
        ],
        "effect": "最大生命 +200；攻击速度 +10%；魔法抗性 +4%；护甲 +1.4；最大生命 +175；效果：技能升级",
        "ability": "技能升级：Upgrades the ultimate, and some abilities, of all heroes.",
        "lore": "The scepter of a wizard with demigod-like powers.",
        "suggest": "生命 +36%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 170,
        "code": "sange_and_yasha",
        "name": "散夜对剑",
        "en": "Sange and Yasha",
        "cost": 4200,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/sange_and_yasha.png",
        "attr": [
            "最大生命 +320",
            "生命恢复 +0.8/s",
            "攻击速度 +16%",
            "护甲 +2.24",
            "攻击速度 +20%",
            "移动速度 +12",
            "生命恢复 +20/s"
        ],
        "effect": "最大生命 +320；生命恢复 +0.8/s；攻击速度 +16%；护甲 +2.24；攻击速度 +20%；移动速度 +12；生命恢复 +20/s；+16% 状态抗性",
        "ability": "",
        "lore": "Sange and Yasha, when attuned by the moonlight and used together, become a very powerful combination.",
        "suggest": "攻击力 +27% | 生命 +36% | 回复 +14%",
        "tags": [
            "控制减速",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 171,
        "code": "kaya_and_sange",
        "name": "慧散对剑",
        "en": "Kaya and Sange",
        "cost": 4200,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/kaya_and_sange.png",
        "attr": [
            "最大生命 +320",
            "生命恢复 +0.8/s",
            "魔法抗性 +6.4%",
            "伤害输出 +8%",
            "生命恢复 +40/s",
            "生命恢复 +20/s"
        ],
        "effect": "最大生命 +320；生命恢复 +0.8/s；魔法抗性 +6.4%；伤害输出 +8%；生命恢复 +40/s；生命恢复 +20/s；+25% 减速抗性；+12% 增伤",
        "ability": "",
        "lore": "Two of three known items of unimaginable power that many believe were crafted at the same enchanter's forge.",
        "suggest": "生命 +36% | 回复 +14%",
        "tags": [
            "法术爆发",
            "控制减速"
        ],
        "cd": false
    },
    {
        "id": 172,
        "code": "yasha_and_kaya",
        "name": "夜慧对剑",
        "en": "Yasha and Kaya",
        "cost": 4200,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/yasha_and_kaya.png",
        "attr": [
            "攻击速度 +16%",
            "护甲 +2.24",
            "魔法抗性 +6.4%",
            "伤害输出 +8%",
            "攻击速度 +20%",
            "生命恢复 +40/s",
            "移动速度 +12"
        ],
        "effect": "攻击速度 +16%；护甲 +2.24；魔法抗性 +6.4%；伤害输出 +8%；攻击速度 +20%；生命恢复 +40/s；移动速度 +12；+12% 增伤",
        "ability": "",
        "lore": "Yasha and Kaya when paired together share a natural resonance.",
        "suggest": "攻击力 +27% | 回复 +14%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 173,
        "code": "boots_of_bearing",
        "name": "气宇之靴",
        "en": "Boots of Bearing",
        "cost": 4225,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/boots_of_bearing.png",
        "attr": [
            "生命恢复 +2.5/s",
            "最大生命 +160",
            "生命恢复 +0.4/s"
        ],
        "effect": "生命恢复 +2.5/s；最大生命 +160；生命恢复 +0.4/s；光环移速: 20；额外移速加成: 15；持续时间: 6；效果：耐力；迅捷光环",
        "ability": "耐力：Gives +50 attack speed and +15% movement speed to nearby allies for 6 seconds. For the first 1.5 seconds allies are immune to slows.\n\n Radius: 1200",
        "lore": "Resplendent footwear fashioned for the ancient herald that first dared spread the glory of Stonehall beyond the original borders of its nascent claim.",
        "suggest": "攻击力 +27% | 攻速 +16% | 生命 +36%",
        "tags": [
            "控制减速",
            "坦克反伤"
        ],
        "cd": 30
    },
    {
        "id": 174,
        "code": "nullifier",
        "name": "否决挂饰",
        "en": "Nullifier",
        "cost": 4350,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/nullifier.png",
        "attr": [
            "攻击力 +75",
            "护甲 +10"
        ],
        "effect": "攻击力 +75；护甲 +10；弹道速度: 1800；移速减缓: 10%；效果：否决",
        "ability": "否决：Dispels the target and applies a debuff for 4 seconds. Continuously dispels and slows the target.\n\nDispel Type: Basic Dispel",
        "lore": "",
        "suggest": "攻击力 +27% | 生命 +36% | 护甲 +19%",
        "tags": [
            "控制减速",
            "坦克反伤"
        ],
        "cd": 10
    },
    {
        "id": 175,
        "code": "hurricane_pike",
        "name": "飓风长戟",
        "en": "Hurricane Pike",
        "cost": 4450,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/hurricane_pike.png",
        "attr": [
            "魔法抗性 +6%",
            "伤害输出 +7.5%",
            "最大生命 +200",
            "攻击速度 +20%",
            "护甲 +2.8",
            "最大生命 +300",
            "生命恢复 +0.75/s",
            "攻击距离 +130"
        ],
        "effect": "魔法抗性 +6%；伤害输出 +7.5%；最大生命 +200；攻击速度 +20%；护甲 +2.8；最大生命 +300；生命恢复 +0.75/s；攻击距离 +130；额外攻速: 100；效果：飓风推进",
        "ability": "飓风推进：Pushes you and target enemy 425 units away from each other, and for 6 seconds, allows you to make 5 attacks against the target without range restrictions and with +100 attack speed.\n\nCan be cast on self or allies to push the target 600 units in the direction it is facing.\nEnemy Range: 425",
        "lore": "A legendary pike once held as royal sigil of the ancient wyvern riders.",
        "suggest": "攻击力 +27% | 攻速 +16% | 生命 +36%",
        "tags": [
            "远程点杀",
            "坦克反伤"
        ],
        "cd": 19
    },
    {
        "id": 176,
        "code": "guardian_greaves",
        "name": "卫士胫甲",
        "en": "Guardian Greaves",
        "cost": 4450,
        "quality": "gold",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/guardian_greaves.png",
        "attr": [
            "移动速度 +50",
            "护甲 +5",
            "生命恢复 +1/s",
            "生命恢复 +2.5/s",
            "生命恢复 +1.5/s"
        ],
        "effect": "移动速度 +50；护甲 +5；生命恢复 +1/s；生命恢复 +2.5/s；生命恢复 +1.5/s；效果：修复；守护光环",
        "ability": "修复：Restores 325 health and 200 mana to nearby allies, and removes most negative effects from the caster.\n\nRadius: 1200\nDispel Type: Basic Dispel",
        "lore": "One of many holy instruments constructed to honor the Omniscience.",
        "suggest": "生命 +36% | 护甲 +19% | 回复 +14%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 45
    },
    {
        "id": 177,
        "code": "shivas_guard",
        "name": "希瓦的守护",
        "en": "Shiva's Guard",
        "cost": 4500,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/shivas_guard.png",
        "attr": [
            "护甲 +17"
        ],
        "effect": "护甲 +17；+75 作用范围；光环半径: 1200；光环攻速: -45；效果：极寒冲击；冰霜光环",
        "ability": "极寒冲击：Emits a freezing wave that deals 260 magical damage to enemies and slows their movement by -40% for 4 seconds.\n\nRadius: 825",
        "lore": "Said to have belonged to a goddess, today it retains much of its former power.",
        "suggest": "攻击力 +27% | 攻速 +16% | 生命 +36%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 27
    },
    {
        "id": 178,
        "code": "manta",
        "name": "幻影斧",
        "en": "Manta Style",
        "cost": 4650,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/manta.png",
        "attr": [
            "最大生命 +200",
            "生命恢复 +0.5/s",
            "攻击速度 +26%",
            "护甲 +3.64",
            "魔法抗性 +4%",
            "伤害输出 +5%",
            "攻击速度 +15%",
            "移动速度 +10"
        ],
        "effect": "最大生命 +200；生命恢复 +0.5/s；攻击速度 +26%；护甲 +3.64；魔法抗性 +4%；伤害输出 +5%；攻击速度 +15%；移动速度 +10；效果：镜像",
        "ability": "镜像：Creates 2 images of your hero that last 18 seconds. \n\nMelee images deal 33% damage, while Ranged images deal 28%. Illusions take 300% damage. \n\nDispel Type: Basic Dispel",
        "lore": "An axe made of reflective materials that causes confusion amongst enemy ranks.",
        "suggest": "攻击力 +27%",
        "tags": [
            "远程点杀",
            "召唤增殖"
        ],
        "cd": 34
    },
    {
        "id": 179,
        "code": "gungir",
        "name": "冈格尼尔",
        "en": "Gleipnir",
        "cost": 4650,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/gungir.png",
        "attr": [
            "最大生命 +450",
            "魔法抗性 +4.8%",
            "伤害输出 +6%"
        ],
        "effect": "最大生命 +450；魔法抗性 +4.8%；伤害输出 +6%；+75 作用范围；作用半径: 275；持续时间: 2.0；效果：永恒锁链",
        "ability": "永恒锁链：Roots all enemies in a 350 radius for 2 seconds.",
        "lore": "Bindings forged by impossible means to leash an ancient evil.",
        "suggest": "生命 +36%",
        "tags": [
            "法术爆发",
            "控制减速"
        ],
        "cd": 18
    },
    {
        "id": 180,
        "code": "bloodstone",
        "name": "血精石",
        "en": "Bloodstone",
        "cost": 4700,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/bloodstone.png",
        "attr": [
            "最大生命 +650",
            "魔法抗性 +6%",
            "伤害输出 +7.5%"
        ],
        "effect": "最大生命 +650；魔法抗性 +6%；伤害输出 +7.5%；+20% 吸血；光环半径: 1200；效果：血之契约；法术虚弱光环",
        "ability": "血之契约：Increases Bloodstone's Spell Lifesteal to 60%. Lasts 5 seconds.",
        "lore": "The Bloodstone's bright ruby color is unmistakable on the battlefield, as the owner seems to have infinite vitality and spirit.",
        "suggest": "攻击力 +27% | 生命 +36% | 回复 +14%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 30
    },
    {
        "id": 181,
        "code": "radiance",
        "name": "辉耀",
        "en": "Radiance",
        "cost": 4700,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/radiance.png",
        "attr": [
            "攻击力 +55",
            "攻击力 +60",
            "闪避 +25%"
        ],
        "effect": "攻击力 +55；攻击力 +60；闪避 +25%；光环半径: 650；效果：灼烧",
        "ability": "灼烧：When active, scorches enemies for 60 magical damage per second. Illusions deal 35 magical damage per second.\n\nRadius: 650",
        "lore": "A divine weapon that causes damage and a bright burning effect that lays waste to nearby enemies.",
        "suggest": "攻击力 +27% | 闪避 +11%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": false
    },
    {
        "id": 182,
        "code": "harpoon",
        "name": "渔叉",
        "en": "Harpoon",
        "cost": 4700,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/harpoon.png",
        "attr": [
            "攻击力 +25",
            "最大生命 +500",
            "生命恢复 +1.25/s",
            "攻击速度 +10%",
            "护甲 +1.4",
            "魔法抗性 +4%",
            "伤害输出 +5%",
            "生命恢复 +2/s"
        ],
        "effect": "攻击力 +25；最大生命 +500；生命恢复 +1.25/s；攻击速度 +10%；护甲 +1.4；魔法抗性 +4%；伤害输出 +5%；生命恢复 +2/s；被动冷却: 5；效果：牵引；回音击",
        "ability": "牵引：When targeting an enemy, fire a harpoon at them, that pulls you and the target closer together, up to 35% of the distance between you and your target. If the caster is melee, the hero and target are always pulled to within melee distance of each other. Targeting a tree always pulls you all the way to that tree.",
        "lore": "A perfect solution for the flight of foes.",
        "suggest": "攻击力 +27% | 回复 +14% | 冷却 -14%",
        "tags": [
            "远程点杀",
            "法术爆发"
        ],
        "cd": 19
    },
    {
        "id": 183,
        "code": "sphere",
        "name": "林肯法球",
        "en": "Linken's Sphere",
        "cost": 4800,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/sphere.png",
        "attr": [
            "最大生命 +320",
            "攻击速度 +16%",
            "魔法抗性 +6.4%",
            "护甲 +2.24",
            "生命恢复 +6/s",
            "生命恢复 +4/s"
        ],
        "effect": "最大生命 +320；攻击速度 +16%；魔法抗性 +6.4%；护甲 +2.24；生命恢复 +6/s；生命恢复 +4/s；效果：法术格挡；转移法术格挡",
        "ability": "法术格挡：Blocks most targeted spells once every 14 seconds.",
        "lore": "This magical sphere once protected one of the most famous heroes in history.",
        "suggest": "生命 +36% | 回复 +14%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 14
    },
    {
        "id": 184,
        "code": "crellas_crozier",
        "name": "克莱拉牧杖",
        "en": "Crella's Crozier",
        "cost": 4800,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/crellas_crozier.png",
        "attr": [
            "最大生命 +120",
            "攻击速度 +6%",
            "魔法抗性 +2.4%",
            "护甲 +0.84",
            "最大生命 +450"
        ],
        "effect": "最大生命 +120；攻击速度 +6%；魔法抗性 +2.4%；护甲 +0.84；最大生命 +450；持续时间: 4.0；作用半径: 900；层数持续时间: 1.5；效果：卢穆斯克仪式；腐化光环",
        "ability": "卢穆斯克仪式：You enter ghost form for 4 seconds, becoming immune to physical damage, but are unable to attack and -30% more vulnerable to magic damage.\n\nSteal 5% movement speed from enemy heroes in 900 range every second. Movement speed steal lasts 1.5s.\n\nPutrefaction Aura's effect is increased to 75%. All of the lost Health Restoration is redirected to you every second.",
        "lore": "",
        "suggest": "攻击力 +27% | 生命 +36%",
        "tags": [
            "远程点杀",
            "法术爆发"
        ],
        "cd": 20
    },
    {
        "id": 185,
        "code": "octarine_core",
        "name": "奥术之心",
        "en": "Octarine Core",
        "cost": 4900,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/octarine_core.png",
        "attr": [
            "最大生命 +450",
            "生命恢复 +6/s"
        ],
        "effect": "最大生命 +450；生命恢复 +6/s；+25% 冷却",
        "ability": "",
        "lore": "At the core of spellcraft are spectrums only the very gifted can sense.",
        "suggest": "生命 +36% | 回复 +14% | 冷却 -14%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 186,
        "code": "refresher",
        "name": "刷新球",
        "en": "Refresher Orb",
        "cost": 5000,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/refresher.png",
        "attr": [
            "生命恢复 +14/s",
            "生命恢复 +7/s"
        ],
        "effect": "生命恢复 +14/s；生命恢复 +7/s；效果：重置冷却",
        "ability": "重置冷却：Resets the cooldowns of all your abilities. Shares a cooldown with Refresher Shard. This item's cooldown only progresses in your hero's main inventory.",
        "lore": "A powerful artifact created for wizards.",
        "suggest": "攻击力 +27% | 生命 +36% | 回复 +14%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 180
    },
    {
        "id": 187,
        "code": "monkey_king_bar",
        "name": "金箍棒",
        "en": "Monkey King Bar",
        "cost": 5000,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/monkey_king_bar.png",
        "attr": [
            "攻击力 +50",
            "攻击速度 +50%",
            "攻击距离 +50"
        ],
        "effect": "攻击力 +50；攻击速度 +50%；攻击距离 +50；效果：穿刺",
        "ability": "穿刺：Grants each attack a 80% chance to pierce through evasion and deal 70 bonus magical damage.",
        "lore": "A powerful staff used by a master warrior.",
        "suggest": "攻击力 +27% | 闪避 +11%",
        "tags": [
            "法术爆发",
            "经济成长"
        ],
        "cd": false
    },
    {
        "id": 188,
        "code": "satanic",
        "name": "撒旦之邪力",
        "en": "Satanic",
        "cost": 5050,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/satanic.png",
        "attr": [
            "最大生命 +500",
            "生命恢复 +1.25/s",
            "攻击力 +25"
        ],
        "effect": "最大生命 +500；生命恢复 +1.25/s；攻击力 +25；+30% 吸血；效果：邪恶狂怒；吸血",
        "ability": "邪恶狂怒：Increases Lifesteal percentage to 175% for 6 seconds. \n\nDispel Type: Basic Dispel",
        "lore": "Immense power at the cost of your soul.",
        "suggest": "攻击力 +27%",
        "tags": [
            "远程点杀"
        ],
        "cd": 30
    },
    {
        "id": 189,
        "code": "heart",
        "name": "恐鳌之心",
        "en": "Heart of Tarrasque",
        "cost": 5100,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/heart.png",
        "attr": [
            "最大生命 +800",
            "生命恢复 +2/s"
        ],
        "effect": "最大生命 +800；生命恢复 +2/s；+1% 最大生命值恢复；效果：巨兽之血",
        "ability": "巨兽之血：Your health regeneration is increased by 1.5% of your missing health.",
        "lore": "Preserved heart of an extinct monster, it bolsters the bearer's fortitude.",
        "suggest": "生命 +36% | 回复 +14%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 190,
        "code": "greater_crit",
        "name": "代达罗斯之殇",
        "en": "Daedalus",
        "cost": 5100,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/greater_crit.png",
        "attr": [
            "攻击力 +88",
            "暴击率 +30%",
            "暴击倍率 +225%"
        ],
        "effect": "攻击力 +88；暴击率 +30%；暴击倍率 +225%；效果：致命一击",
        "ability": "致命一击：Grants each attack a 30% chance to deal 225% damage.",
        "lore": "A weapon of incredible power that is difficult for even the strongest of warriors to control.",
        "suggest": "攻击力 +27% | 暴击 +14%",
        "tags": [
            "物理暴击"
        ],
        "cd": false
    },
    {
        "id": 191,
        "code": "assault",
        "name": "强袭胸甲",
        "en": "Assault Cuirass",
        "cost": 5125,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/assault.png",
        "attr": [
            "攻击速度 +30%",
            "护甲 +10"
        ],
        "effect": "攻击速度 +30%；护甲 +10；光环半径: 1200；光环攻速: 30；效果：强袭光环",
        "ability": "强袭光环：Grants 30 attack speed and 5 armor to nearby allied units and structures, and decreases nearby enemy unit and structure armor by -5.\n\nRadius: 1200",
        "lore": "Forged in the depths of the nether reaches, this hellish mail provides an army with increased armor and attack speed.",
        "suggest": "攻击力 +27% | 攻速 +16% | 护甲 +19%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 192,
        "code": "sheepstick",
        "name": "邪恶镰刀",
        "en": "Scythe of Vyse",
        "cost": 5200,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/sheepstick.png",
        "attr": [
            "魔法抗性 +12%",
            "伤害输出 +15%",
            "生命恢复 +8/s"
        ],
        "effect": "魔法抗性 +12%；伤害输出 +15%；生命恢复 +8/s；效果：妖术",
        "ability": "妖术：Turns a target unit into a harmless critter for 2.8 seconds. The target has a base movement speed of 140 and will be silenced, muted, and disarmed.\nInstantly destroys illusions.",
        "lore": "The most guarded relic among the cult of Vyse, it is the most coveted weapon among magi.",
        "suggest": "暴击 +14% | 回复 +14%",
        "tags": [
            "物理暴击",
            "法术爆发"
        ],
        "cd": 20
    },
    {
        "id": 193,
        "code": "ethereal_blade",
        "name": "虚灵之刃",
        "en": "Ethereal Blade",
        "cost": 5200,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ethereal_blade.png",
        "attr": [
            "最大生命 +480",
            "攻击速度 +24%",
            "魔法抗性 +9.6%",
            "护甲 +3.36",
            "生命恢复 +1.2/s"
        ],
        "effect": "最大生命 +480；攻击速度 +24%；魔法抗性 +9.6%；护甲 +3.36；生命恢复 +1.2/s；持续时间: 4.0；弹道速度: 1400；效果：以太冲击",
        "ability": "以太冲击：Converts the target unit to ethereal form, rendering them immune to physical damage, but unable to attack and -30% more vulnerable to magic damage.\n\n Enemy targets are also slowed by -80%, and take 1x the sum of all your attributes + 50 as magical damage.\nDuration: 4 seconds",
        "lore": "A flickering blade of a ghastly nature, it is capable of dealing damage in both magical and physical planes.",
        "suggest": "攻击力 +27%",
        "tags": [
            "法术爆发",
            "控制减速"
        ],
        "cd": 22
    },
    {
        "id": 194,
        "code": "butterfly",
        "name": "蝴蝶",
        "en": "Butterfly",
        "cost": 5450,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/butterfly.png",
        "attr": [
            "攻击速度 +35%",
            "护甲 +4.9",
            "闪避 +35%",
            "攻击力 +25"
        ],
        "effect": "攻击速度 +35%；护甲 +4.9；闪避 +35%；攻击力 +25；+20% 基础攻速加成",
        "ability": "",
        "lore": "Only the mightiest and most experienced of warriors can wield the Butterfly, but it provides incredible dexterity in combat.",
        "suggest": "攻击力 +27% | 攻速 +16% | 闪避 +11%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 195,
        "code": "mjollnir",
        "name": "雷神之锤",
        "en": "Mjollnir",
        "cost": 5500,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/mjollnir.png",
        "attr": [
            "攻击力 +25",
            "攻击速度 +90%"
        ],
        "effect": "攻击力 +25；攻击速度 +90%；最大充能: 0；效果：静电充能；连锁闪电",
        "ability": "静电充能：Places a charged shield on a target unit for 15 seconds which has a 20% chance to release a 225 magical damage shocking bolt at a nearby attacker and 4 additional enemies.",
        "lore": "Thor's magical hammer, made for him by the dwarves Brok and Eitri.",
        "suggest": "攻击力 +32% | 闪避 +13%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 35
    },
    {
        "id": 196,
        "code": "angels_demise",
        "name": "坎达",
        "en": "Khanda",
        "cost": 5600,
        "quality": "white",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/angels_demise.png",
        "attr": [
            "最大生命 +450",
            "最大生命 +160",
            "攻击速度 +8%",
            "魔法抗性 +3.2%",
            "护甲 +1.12",
            "生命恢复 +7/s",
            "生命恢复 +3/s"
        ],
        "effect": "最大生命 +450；最大生命 +160；攻击速度 +8%；魔法抗性 +3.2%；护甲 +1.12；生命恢复 +7/s；生命恢复 +3/s；效果：强化法术",
        "ability": "强化法术：The next Unit Target spell you cast on an enemy deals a separate 250 additional damage, disables their passives, and slows their movement speed by 30% for 4s.",
        "lore": "A blade sharp enough to slice through magic itself.",
        "suggest": "攻击力 +32% | 生命 +42% | 回复 +16%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 9
    },
    {
        "id": 197,
        "code": "rapier",
        "name": "圣剑",
        "en": "Divine Rapier",
        "cost": 5600,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/rapier.png",
        "attr": [
            "攻击力 +250",
            "攻击力 +100"
        ],
        "effect": "攻击力 +250；攻击力 +100；效果：转化；永恒",
        "ability": "转化：Toggle to gain either 25% bonus spell amplification or 250 bonus attack damage.",
        "lore": "So powerful, it cannot have a single owner.",
        "suggest": "攻击力 +32%",
        "tags": [
            "法术爆发"
        ],
        "cd": 6
    },
    {
        "id": 198,
        "code": "helm_of_the_overlord",
        "name": "统御头盔",
        "en": "Helm of the Overlord",
        "cost": 5650,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/helm_of_the_overlord.png",
        "attr": [
            "最大生命 +420",
            "攻击速度 +21%",
            "魔法抗性 +8.4%",
            "护甲 +2.94",
            "护甲 +7",
            "生命恢复 +7/s"
        ],
        "effect": "最大生命 +420；攻击速度 +21%；魔法抗性 +8.4%；护甲 +2.94；护甲 +7；生命恢复 +7/s；效果：支配",
        "ability": "支配：Takes control of one neutral target unit and sets its movement speed to 380 and max health to a minimum of 1800. Also provides the unit with +70 base attack damage, +12 health regen, +4 mana regen, +7 armor, and levels up some abilities of the target by 1 level. \n\nDominated units with a max health of greater than 1800 retain their original max health. Grants the caster the gold and experience bounty of the dominated creep. Dominated unit's bounty is set to 250 gold and it can no longer be killed by abilities that instantly kill creeps otherwise.\n\nThe Helm cannot be used for 3 seconds after the dominated creep takes damage from an enemy hero or Roshan.",
        "lore": "The powerful headpiece of an undead necromancer.",
        "suggest": "攻击力 +32% | 生命 +42% | 护甲 +22%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 45
    },
    {
        "id": 199,
        "code": "silver_edge",
        "name": "白银之锋",
        "en": "Silver Edge",
        "cost": 5700,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/silver_edge.png",
        "attr": [
            "攻击力 +70",
            "攻击速度 +35%"
        ],
        "effect": "攻击力 +70；攻击速度 +35%；效果：暗影步",
        "ability": "暗影步：Makes you invisible for 17 seconds, or until you attack or cast a spell. While invisible, you move 25% faster and can move through units. \n\nAttacking to end the invisibility will deal 300 bonus physical damage, disable their passive abilities for 5 seconds, and cap their movement speed to 200.",
        "lore": "Once used to slay an unjust king, only to have the kingdom erupt into civil war in the aftermath.",
        "suggest": "攻击力 +32% | 回复 +16%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 20
    },
    {
        "id": 200,
        "code": "ultimate_scepter_2",
        "name": "阿哈利姆福佑",
        "en": "Aghanim's Blessing",
        "cost": 5800,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ultimate_scepter_2.png",
        "attr": [],
        "effect": "效果：技能升级",
        "ability": "技能升级：Upgrades the ultimate, and some abilities, of all heroes.",
        "lore": "The scepter of a wizard with demigod-like powers.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 201,
        "code": "ultimate_scepter_roshan",
        "name": "阿哈利姆福佑（肉山）",
        "en": "Aghanim's Blessing - Roshan",
        "cost": 5800,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ultimate_scepter_roshan.png",
        "attr": [],
        "effect": "效果：技能升级",
        "ability": "技能升级：Upgrades the ultimate, and some abilities, of all heroes.",
        "lore": "The scepter of a wizard with demigod-like powers.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 202,
        "code": "skadi",
        "name": "斯嘉蒂之眼",
        "en": "Eye of Skadi",
        "cost": 5900,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/skadi.png",
        "attr": [
            "最大生命 +700",
            "攻击速度 +35%",
            "魔法抗性 +14%",
            "护甲 +4.9"
        ],
        "effect": "最大生命 +700；攻击速度 +35%；魔法抗性 +14%；护甲 +4.9；效果：霜寒攻击",
        "ability": "霜寒攻击：Attacks lower enemy movement by -25% if they are melee and -50% if they are ranged. Attacks also lower enemy attack speed by -20% and Health Restoration by 50%. Lasts for 3 seconds.",
        "lore": "Extremely rare artifact, guarded by the azure dragons.",
        "suggest": "攻击力 +32% | 攻速 +19% | 生命 +42%",
        "tags": [
            "远程点杀",
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 203,
        "code": "hydras_breath",
        "name": "九头蛇之息",
        "en": "Hydra's Breath",
        "cost": 5900,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/hydras_breath.png",
        "attr": [
            "最大生命 +300",
            "生命恢复 +0.75/s",
            "攻击速度 +30%",
            "护甲 +4.2",
            "攻击力 +25",
            "攻击距离 +150"
        ],
        "effect": "最大生命 +300；生命恢复 +0.75/s；攻击速度 +30%；护甲 +4.2；攻击力 +25；攻击距离 +150；触发几率: 30；效果：瘴气；多头",
        "ability": "瘴气：Attacks poison enemies, dealing 2.5% of the target's Max HP as Magical Damage per second for 3 seconds.",
        "lore": "",
        "suggest": "攻击力 +32% | 生命 +42%",
        "tags": [
            "远程点杀",
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 204,
        "code": "devastator",
        "name": "帕拉斯玛",
        "en": "Parasma",
        "cost": 5975,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/devastator.png",
        "attr": [
            "魔法抗性 +16%",
            "伤害输出 +20%",
            "攻击速度 +40%",
            "护甲 +7",
            "生命恢复 +1/s"
        ],
        "effect": "魔法抗性 +16%；伤害输出 +20%；攻击速度 +40%；护甲 +7；生命恢复 +1/s；+300 弹道速度；被动冷却: 4；效果：巫师之刃；魔法腐蚀",
        "ability": "巫师之刃：Causes your next attack to have true strike, apply a poison for 4 seconds, slowing by 25% and dealing 0.75x your intelligence as damage every second.",
        "lore": "Warning: There is no antidote if picked up by the wrong end.",
        "suggest": "攻击力 +32% | 护甲 +22% | 回复 +16%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 7
    },
    {
        "id": 205,
        "code": "disperser",
        "name": "斥散刃",
        "en": "Disperser",
        "cost": 6100,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/disperser.png",
        "attr": [
            "攻击速度 +40%",
            "护甲 +5.6",
            "魔法抗性 +4%",
            "伤害输出 +5%"
        ],
        "effect": "攻击速度 +40%；护甲 +5.6；魔法抗性 +4%；伤害输出 +5%；效果：压制；破法",
        "ability": "压制：Dispels both the wearer and the target. Enemy targets are slowed for 5 seconds. Allied targets gain bonus movespeed and 40% slow resistance for 5 seconds. Caster is always granted the ally benefit on cast.\n\nBoth movement speed reduction and increase start at 100% and gradually decrease to 0% over the course of the buff duration.\nDispel Type: Basic Dispel",
        "lore": "Once entrusted to an Apostle General of the Rumusque Faithful's expeditionary force.",
        "suggest": "攻击力 +32%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 15
    },
    {
        "id": 206,
        "code": "abyssal_blade",
        "name": "深渊之刃",
        "en": "Abyssal Blade",
        "cost": 6250,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/abyssal_blade.png",
        "attr": [
            "攻击力 +35",
            "最大生命 +520",
            "生命恢复 +1.3/s",
            "生命恢复 +20/s"
        ],
        "effect": "攻击力 +35；最大生命 +520；生命恢复 +1.3/s；生命恢复 +20/s；+30% 减速抗性；眩晕时间: 1.6；效果：压制；重击",
        "ability": "压制：Stuns a target enemy unit for 1.6 seconds. \n\nPierces Debuff Immunity.",
        "lore": "The lost blade of the Commander of the Abyss, this edge cuts into an enemy's soul.",
        "suggest": "攻击力 +32% | 生命 +42% | 回复 +16%",
        "tags": [
            "远程点杀",
            "控制减速"
        ],
        "cd": 35
    },
    {
        "id": 207,
        "code": "trident",
        "name": "三叉戟",
        "en": "Trident",
        "cost": 6301,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/trident.png",
        "attr": [
            "最大生命 +600",
            "生命恢复 +1.5/s",
            "攻击速度 +30%",
            "护甲 +4.2",
            "魔法抗性 +12%",
            "伤害输出 +15%",
            "移动速度 +10"
        ],
        "effect": "最大生命 +600；生命恢复 +1.5/s；攻击速度 +30%；护甲 +4.2；魔法抗性 +12%；伤害输出 +15%；移动速度 +10；+30% 状态抗性",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +32% | 生命 +42% | 回复 +16%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 208,
        "code": "bloodthorn",
        "name": "血棘",
        "en": "Bloodthorn",
        "cost": 6400,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/bloodthorn.png",
        "attr": [
            "魔法抗性 +10%",
            "伤害输出 +12.5%",
            "攻击速度 +70%",
            "生命恢复 +4/s",
            "攻击力 +20"
        ],
        "effect": "魔法抗性 +10%；伤害输出 +12.5%；攻击速度 +70%；生命恢复 +4/s；攻击力 +20；持续时间: 6；效果：灵魂撕裂；穿刺",
        "ability": "灵魂撕裂：Silences a target for 5 seconds. At the end of the silence, an additional 60% of all damage taken during the silence will be dealt to the target as magical damage.\n\nAll attacks on the silenced target will deal additional damage equal to 50 if the attacker is a hero, and 25, if the attacker is a creep. Provides True Strike for your attacks and attacks from your controlled units against the silenced target.",
        "lore": "A reviled blade that bites deeper with each wriggle of its victim's final throes.",
        "suggest": "攻击力 +32% | 生命 +42% | 闪避 +13%",
        "tags": [
            "法术爆发",
            "控制减速"
        ],
        "cd": 15
    },
    {
        "id": 209,
        "code": "wind_waker",
        "name": "风灵法杖",
        "en": "Wind Waker",
        "cost": 6800,
        "quality": "red",
        "category": "synthesized",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/wind_waker.png",
        "attr": [
            "移动速度 +30",
            "生命恢复 +3/s",
            "魔法抗性 +14%",
            "伤害输出 +17.5%"
        ],
        "effect": "移动速度 +30；生命恢复 +3/s；魔法抗性 +14%；伤害输出 +17.5%；效果：龙卷风",
        "ability": "龙卷风：Sweeps a target unit up into a cyclone, making them invulnerable for 2.5 seconds. Cyclone can be cast on yourself, enemy units or allied units. When cast on yourself, you can move the tornado at a speed of 300.\n\nEnemy units take 50 magical damage upon landing.\nDispel Type: Basic Dispel",
        "lore": "Proof enough to some that unseen forces manipulate the happenings of the material plane.",
        "suggest": "攻击力 +32% | 回复 +16%",
        "tags": [
            "法术爆发",
            "召唤增殖"
        ],
        "cd": 19
    },
    {
        "id": 210,
        "code": "chipped_vest",
        "name": "碎裂背心",
        "en": "Chipped Vest",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/chipped_vest.png",
        "attr": [],
        "effect": "效果：碎屑",
        "ability": "碎屑：Every time you are attacked, you return 30 damage to heroes and 15 damage to creeps.",
        "lore": "It doesn't look like much, but it's oddly comfy.",
        "suggest": "攻击力 +14%",
        "tags": [
            "召唤增殖"
        ],
        "cd": false
    },
    {
        "id": 211,
        "code": "possessed_mask",
        "name": "附魂面具",
        "en": "Possessed Mask",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/possessed_mask.png",
        "attr": [],
        "effect": "效果：吸血",
        "ability": "吸血：Heals the attacker for 5 HP on each attack.",
        "lore": "Even when discarded with specific purpose and great care, this frightening mask always finds its way onto the face of a new owner.",
        "suggest": "攻击力 +14% | 生命 +18%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 212,
        "code": "occult_bracelet",
        "name": "秘仪手环",
        "en": "Occult Bracelet",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/occult_bracelet.png",
        "attr": [
            "生命恢复 +0.4/s"
        ],
        "effect": "生命恢复 +0.4/s；层数持续时间: 5；效果：埃洛夏仪式",
        "ability": "埃洛夏仪式：Each time the wearer is attacked, they gain a stack of 0.4 mana regen, up to 5 stacks. Stacks last for 5 seconds.",
        "lore": "A band that bears effigy of the dark goddess Eloshar's unsleeping eye.",
        "suggest": "攻击力 +14% | 回复 +7%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 213,
        "code": "dagger_of_ristul",
        "name": "瑞斯图尔尖匕",
        "en": "Dagger of Ristul",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/dagger_of_ristul.png",
        "attr": [
            "攻击力 +25"
        ],
        "effect": "攻击力 +25；持续时间: 8；效果：浸染",
        "ability": "浸染：Consume health to temporarily gain 25 damage for 8 seconds.",
        "lore": "A sinister shiv that grants favor to those willing to stain its blade with a sacrifice of their own blood.",
        "suggest": "攻击力 +14% | 生命 +18%",
        "tags": [
            "元素持续",
            "坦克反伤"
        ],
        "cd": 30
    },
    {
        "id": 214,
        "code": "duelist_gloves",
        "name": "决斗者手套",
        "en": "Duelist Gloves",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/duelist_gloves.png",
        "attr": [],
        "effect": "额外攻速: 20；作用半径: 1200；效果：大胆",
        "ability": "大胆：Grants 20 attack speed as long as there are enemy heroes within 1200 units.",
        "lore": "",
        "suggest": "攻击力 +14% | 攻速 +8%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 215,
        "code": "polliwog_charm",
        "name": "蝌蚪护符",
        "en": "Pollywog Charm",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/polliwog_charm.png",
        "attr": [],
        "effect": "持续时间: 14；效果：呱呱",
        "ability": "呱呱：Increases the health regeneration of a target ally by 8 for 14 seconds. While standing in water, the blessed unit also moves 10% faster.",
        "lore": "A tiny trinket that wriggles when wet.",
        "suggest": "生命 +18% | 回复 +7%",
        "tags": [
            "坦克反伤"
        ],
        "cd": 45
    },
    {
        "id": 216,
        "code": "kobold_cup",
        "name": "狗头人酒杯",
        "en": "Kobold Cup",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/kobold_cup.png",
        "attr": [],
        "effect": "效果：一路顺风",
        "ability": "一路顺风：Increases movement speed of all allied units by 10% in a 1000 unit radius around the caster for 6 seconds.",
        "lore": "The Kobold King will sip when he damn well pleases.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": 40
    },
    {
        "id": 217,
        "code": "dormant_curio",
        "name": "沉睡奇物",
        "en": "Dormant Curio",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/dormant_curio.png",
        "attr": [],
        "effect": "效果：隐藏潜力",
        "ability": "隐藏潜力：Neutral Artifacts you craft while holding a Dormant Curio have their potency increased by 30%.",
        "lore": "Everyone has an idea, but no one has a clue.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 218,
        "code": "weighted_dice",
        "name": "加重骰子",
        "en": "Weighted Dice",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/weighted_dice.png",
        "attr": [],
        "effect": "效果：上膛",
        "ability": "上膛：Increases your base damage maximum by 6. When calculating your base damage or creep bounty from last hits, the value is computed 2 times and the highest value is taken.",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "召唤增殖",
            "经济成长"
        ],
        "cd": false
    },
    {
        "id": 219,
        "code": "ash_legion_shield",
        "name": "余烬军团战盾",
        "en": "Ash Legion Shield",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/ash_legion_shield.png",
        "attr": [],
        "effect": "持续时间: 6；效果：盾墙",
        "ability": "盾墙：Reduce your own movement speed by 20 to provide a 160 physical damage barrier to allied player controlled units in a 800 unit radius. Lasts for 6 seconds.",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "远程点杀"
        ],
        "cd": 40
    },
    {
        "id": 220,
        "code": "stonefeather_satchel",
        "name": "石羽小包",
        "en": "Stonefeather Satchel",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/stonefeather_satchel.png",
        "attr": [],
        "effect": "效果：变形",
        "ability": "变形：Toggle to switch the contents of the Satchel between a pound of Feathers or Rocks.\n\nFeathers: increase movement speed by 12 and distance of forced movement effects applied to the wearer by 30%.\n\nRocks: increase armor by 3 and decrease the distance of forced movement effects applied to the wearer by 30%.",
        "lore": "",
        "suggest": "护甲 +10%",
        "tags": [
            "远程点杀",
            "坦克反伤"
        ],
        "cd": 6
    },
    {
        "id": 221,
        "code": "foragers_kit",
        "name": "采菌套具",
        "en": "Forager's Kit",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/foragers_kit.png",
        "attr": [],
        "effect": "作用半径: 1200；效果：采集",
        "ability": "采集：When the cooldown is ready, nearby trees that can be foraged will appear. By standing next to a tree for 1s, you can forage the tree and find flora, fungi or a bag of gold containing 30 gold.",
        "lore": "",
        "suggest": "冷却 -7% | 金币获取 +8%",
        "tags": [
            "经济成长"
        ],
        "cd": 60
    },
    {
        "id": 222,
        "code": "poor_mans_shield",
        "name": "穷鬼盾",
        "en": "Poor Man's Shield",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/poor_mans_shield.png",
        "attr": [],
        "effect": "格挡几率: 50；效果：伤害格挡",
        "ability": "伤害格挡：Gives a 100% chance to block 30 damage from incoming attacks on melee heroes, and 20 damage on ranged.\n\nHas a 50% chance to block damage from creeps.",
        "lore": "A busted old shield that seems to block more than it should.",
        "suggest": "攻击力 +14%",
        "tags": [
            "远程点杀",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 223,
        "code": "medallion_of_courage",
        "name": "勇气勋章",
        "en": "Medallion of Courage",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/medallion_of_courage.png",
        "attr": [],
        "effect": "持续时间: 8；效果：勇气",
        "ability": "勇气：Increases armor by 7 or decreases armor by -4 for 8s depending on if cast on an ally or enemy. Cannot be cast on self.",
        "lore": "",
        "suggest": "护甲 +10%",
        "tags": [
            "坦克反伤"
        ],
        "cd": 18
    },
    {
        "id": 224,
        "code": "essence_ring",
        "name": "精华指环",
        "en": "Essence Ring",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/essence_ring.png",
        "attr": [],
        "effect": "生命获取: 240；效果：生命精华",
        "ability": "生命精华：Increases your current and max health by 240 for 10 seconds.",
        "lore": "An ancient bauble blessed by the breath of Verodicia.",
        "suggest": "生命 +18%",
        "tags": [
            "坦克反伤"
        ],
        "cd": 25
    },
    {
        "id": 225,
        "code": "pogo_stick",
        "name": "翻腾玩具",
        "en": "Tumbler's Toy",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/pogo_stick.png",
        "attr": [],
        "effect": "效果：跃迁",
        "ability": "跃迁：Propels your hero forward 300 units. Tumbler's Toy gets disabled for 3 seconds if its owner receives damage from a player source.",
        "lore": "An antique plaything found in the ruins of an Ozenja circus bazaar.",
        "suggest": "攻击力 +14%",
        "tags": [
            "法术爆发",
            "控制减速"
        ],
        "cd": 15
    },
    {
        "id": 226,
        "code": "seeds_of_serenity",
        "name": "宁静种籽",
        "en": "Seeds of Serenity",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/seeds_of_serenity.png",
        "attr": [
            "生命恢复 +8/s"
        ],
        "effect": "生命恢复 +8/s；作用半径: 400；持续时间: 8；效果：青翠山谷",
        "ability": "青翠山谷：Target the ground with a 400 radius. Provides health regeneration to all allied units while they are in the area of effect equal to 8 + 25% of the caster's health regeneration at the time of casting. Lasts 8 seconds.",
        "lore": "An evergreen sprout treasured by the woodkin and highly coveted by interlopers and their like.",
        "suggest": "生命 +18% | 回复 +7%",
        "tags": [
            "坦克反伤"
        ],
        "cd": 35
    },
    {
        "id": 227,
        "code": "defiant_shell",
        "name": "不屈护壳",
        "en": "Defiant Shell",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/defiant_shell.png",
        "attr": [],
        "effect": "效果：互惠",
        "ability": "互惠：When attacked, the hero counter-attacks a target within their attack range for 80% of their regular attack damage.",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "远程点杀"
        ],
        "cd": 5
    },
    {
        "id": 228,
        "code": "mana_draught",
        "name": "法力之饮",
        "en": "Mana Draught",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/mana_draught.png",
        "attr": [
            "生命恢复 +70/s"
        ],
        "effect": "生命恢复 +70/s；效果：干杯；填满",
        "ability": "干杯：Restores 70 + 3% of the caster's maximum mana over 6 seconds. If the hero is attacked by an enemy hero or Roshan, the effect is lost.\n\nHold Control to use on an allied hero.",
        "lore": "A refreshing drink best shared with friends.",
        "suggest": "攻击力 +14% | 回复 +7% | 冷却 -7%",
        "tags": [
            "法术爆发"
        ],
        "cd": 60
    },
    {
        "id": 229,
        "code": "crippling_crossbow",
        "name": "致残之弩",
        "en": "Crippling Crossbow",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/crippling_crossbow.png",
        "attr": [],
        "effect": "持续时间: 4；伤害: 25；弹道速度: 1400；效果：跛行",
        "ability": "跛行：Hits an enemy for 25 damage, then slows them by 50% and reduces Health Restoration by 40% for 4 seconds. The slow gradually fades over the duration of the spell.",
        "lore": "The ever-weeping woodgrain of this crossbow coats every bolt in a potent but short-lived narcotic sap.",
        "suggest": "攻击力 +14% | 生命 +18%",
        "tags": [
            "法术爆发",
            "控制减速"
        ],
        "cd": 30
    },
    {
        "id": 230,
        "code": "searing_signet",
        "name": "炽热纹章",
        "en": "Searing Signet",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/searing_signet.png",
        "attr": [],
        "effect": "效果：灼烧穿透",
        "ability": "灼烧穿透：Instances of magic damage from spells over 60 ignites enemies, causing them to take 80 magic damage over 6 seconds. Burn damage against non-hero targets is decreased by 50%.",
        "lore": "To torture a magic user, one must devise means far beyond the mundane.",
        "suggest": "攻击力 +14%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": false
    },
    {
        "id": 231,
        "code": "cloak_of_flames",
        "name": "火焰斗篷",
        "en": "Cloak of Flames",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/cloak_of_flames.png",
        "attr": [],
        "effect": "伤害: 40；作用半径: 375；效果：献祭",
        "ability": "献祭：Burns enemy units in a 375 unit radius for 40 damage per second. Illusions deal 25 damage per second.",
        "lore": "A very fine cloak that plays host to an overly-protective living flame.",
        "suggest": "攻击力 +14% | 护甲 +10%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": false
    },
    {
        "id": 232,
        "code": "psychic_headband",
        "name": "通灵头带",
        "en": "Psychic Headband",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/psychic_headband.png",
        "attr": [],
        "effect": "施法距离: 0；效果：心灵推击",
        "ability": "心灵推击：Pushes the target enemy unit away from you 400 distance.",
        "lore": "A failed experiment in finer telekinetic control, still fit for other ends.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀",
            "召唤增殖"
        ],
        "cd": 15
    },
    {
        "id": 233,
        "code": "stormcrafter",
        "name": "风暴宝器",
        "en": "Stormcrafter",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/stormcrafter.png",
        "attr": [],
        "effect": "伤害: 70；效果：瓶装闪电",
        "ability": "瓶装闪电：Zaps 2 enemy targets within 700 range, dealing 70 damage and a 40% slow for 0.4 seconds.",
        "lore": "The accidental byproduct of a spell conjured to entrap a lesser god.",
        "suggest": "攻击力 +14% | 回复 +7%",
        "tags": [
            "远程点杀",
            "法术爆发"
        ],
        "cd": 6
    },
    {
        "id": 234,
        "code": "unrelenting_eye",
        "name": "不倦之眼",
        "en": "Unrelenting Eye",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/unrelenting_eye.png",
        "attr": [],
        "effect": "效果：永不停歇",
        "ability": "永不停歇：Increases slow resistance by 50%. This bonus is reduced by 10% for every enemy hero within the wearer's attack radius.",
        "lore": "A serpent's eye the size of a melon (and just as moist).",
        "suggest": "攻击力 +14%",
        "tags": [
            "控制减速",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 235,
        "code": "gunpowder_gauntlets",
        "name": "火药手套",
        "en": "Gunpowder Gauntlet",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/gunpowder_gauntlets.png",
        "attr": [
            "攻击力 +120"
        ],
        "effect": "攻击力 +120；效果：振奋人群",
        "ability": "振奋人群：Your next attack deals an additional 120 magic damage and splashes to units within 250 units for 50% of the original attack's damage plus the additional magic damage.",
        "lore": "A 'harmless' prank that went entirely too far.",
        "suggest": "攻击力 +14%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 10
    },
    {
        "id": 236,
        "code": "serrated_shiv",
        "name": "锯齿短刀",
        "en": "Serrated Shiv",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/serrated_shiv.png",
        "attr": [],
        "effect": "触发几率: 20；效果：开膛",
        "ability": "开膛：Attacks have a 20% chance to have True Strike and deal 8% of the target's current health as bonus physical damage. Deals a flat bonus of 200 against Roshan.",
        "lore": "Too dangerous for taskwork, this blade's only purpose is vile murder.",
        "suggest": "攻击力 +14% | 生命 +18%",
        "tags": [
            "坦克反伤"
        ],
        "cd": 1
    },
    {
        "id": 237,
        "code": "jidi_pollen_bag",
        "name": "基迪花粉袋",
        "en": "Jidi Pollen Bag",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/jidi_pollen_bag.png",
        "attr": [],
        "effect": "负面效果持续时间: 9；效果：授粉",
        "ability": "授粉：Spreads pollen on all enemy units in a 700 unit radius for 9 seconds, decreasing their health restoration by 50% and dealing damage equal to 9% of their maximum health per second.",
        "lore": "Very dangerous. Very difficult to obtain more.",
        "suggest": "攻击力 +14% | 生命 +18%",
        "tags": [
            "坦克反伤"
        ],
        "cd": 25
    },
    {
        "id": 238,
        "code": "spellslinger",
        "name": "咏咒之坠",
        "en": "Spellslinger",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/spellslinger.png",
        "attr": [],
        "effect": "持续时间: 10；效果：齐射",
        "ability": "齐射：20% of the mana used to cast abilities is recovered over 10 seconds.",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 239,
        "code": "partisans_brand",
        "name": "天游烙印",
        "en": "Partisan's Brand",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/partisans_brand.png",
        "attr": [
            "攻击力 +9"
        ],
        "effect": "攻击力 +9；效果：烙印",
        "ability": "烙印：Increases spell damage dealt to player controlled units by 9%.",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 240,
        "code": "dandelion_amulet",
        "name": "蒲公英护符",
        "en": "Dandelion Amulet",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/dandelion_amulet.png",
        "attr": [],
        "effect": "效果：魔法伤害格挡",
        "ability": "魔法伤害格挡：Every 12s, blocks up to 300 magic damage from damage instances over 75 damage.",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 12
    },
    {
        "id": 241,
        "code": "rattlecage",
        "name": "回响之笼",
        "en": "Rattlecage",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/rattlecage.png",
        "attr": [],
        "effect": "作用半径: 600；弹道速度: 1000；效果：回响",
        "ability": "回响：After taking 220 damage from any source, the wearer fires a projectile at up to 2 random enemies in a 600 radius, prioritizing heroes, that deal 110 physical damage and slow the targets movement and attack speed by 100% for 0.2s.",
        "lore": "",
        "suggest": "攻击力 +14% | 攻速 +8% | 护甲 +10%",
        "tags": [
            "元素持续",
            "控制减速"
        ],
        "cd": false
    },
    {
        "id": 242,
        "code": "giant_maul",
        "name": "巨人重锤",
        "en": "Giant's Maul",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/giant_maul.png",
        "attr": [
            "暴击倍率 +150%"
        ],
        "effect": "暴击倍率 +150%；攻速降低: 15；负面效果持续时间: 3；效果：粉碎重击",
        "ability": "粉碎重击：Empowers the next attack to be a critical hit dealing 150% damage. Hitting an enemy with an empowered attack temporarily decreases their movement speed by 10%, attack speed by 15%, and cast speed by 20% for 3 seconds.",
        "lore": "Crude but smashingly effective.",
        "suggest": "攻击力 +14% | 攻速 +8% | 暴击 +7%",
        "tags": [
            "物理暴击"
        ],
        "cd": 15
    },
    {
        "id": 243,
        "code": "metamorphic_mandible",
        "name": "变态上颚",
        "en": "Metamorphic Mandible",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/metamorphic_mandible.png",
        "attr": [],
        "effect": "持续时间: 5；效果：化蛹",
        "ability": "化蛹：Enter into an insect form for 5 seconds, increasing magic resistance by 50% and movement speed by 15%. While an insect, your size is decreased and your armor is reduced by 45%.",
        "lore": "",
        "suggest": "护甲 +10% | 元素强度 +7%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 30
    },
    {
        "id": 244,
        "code": "idol_of_screeauk",
        "name": "斯凯奥克神像",
        "en": "Idol of Scree'auk",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/idol_of_screeauk.png",
        "attr": [
            "闪避 +25%"
        ],
        "effect": "闪避 +25%；持续时间: 5；效果：虚假飞行",
        "ability": "虚假飞行：Gain 50% slow resistance, phased movement, and 25% evasion for 5 seconds.",
        "lore": "",
        "suggest": "闪避 +6%",
        "tags": [
            "控制减速",
            "坦克反伤"
        ],
        "cd": 30
    },
    {
        "id": 245,
        "code": "flayers_bota",
        "name": "剥皮者之靴",
        "en": "Flayer's Bota",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/flayers_bota.png",
        "attr": [],
        "effect": "持续时间: 6；效果：嗜血；血之奔涌",
        "ability": "嗜血：Gain 15% base damage and 30 attack speed for 6 seconds.",
        "lore": "",
        "suggest": "攻击力 +14% | 攻速 +8% | 冷却 -7%",
        "tags": [
            "远程点杀"
        ],
        "cd": 65
    },
    {
        "id": 246,
        "code": "prophets_pendulum",
        "name": "先知灵摆",
        "en": "Prophet's Pendulum",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/prophets_pendulum.png",
        "attr": [],
        "effect": "效果：残留",
        "ability": "残留：30% of incoming damage is delayed over 5 seconds.",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "召唤增殖"
        ],
        "cd": false
    },
    {
        "id": 247,
        "code": "enchanters_bauble",
        "name": "附魔师之椟",
        "en": "Enchanter's Bauble",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enchanters_bauble.png",
        "attr": [],
        "effect": "当前加成: 0%；效果：魅惑",
        "ability": "魅惑：Increases the bonuses of the item's Neutral Enchantment by 15%. Every time this item is crafted again the bonus is increased by 40%.",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 248,
        "code": "conjurers_catalyst",
        "name": "咒术师触媒",
        "en": "Conjurer's Catalyst",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/conjurers_catalyst.png",
        "attr": [],
        "effect": "持续时间: 6；伤害: 40；效果：技能溢出",
        "ability": "技能溢出：Dealing 100 spell damage to an enemy causes them to overheat and deal damage to their allies in a 300 unit radius. Hero targets deal 40 damage to their allies, other targets deal 15 damage.",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 249,
        "code": "desolator_2",
        "name": "冥河黯灭",
        "en": "Stygian Desolator",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/desolator_2.png",
        "attr": [],
        "effect": "效果：高级腐蚀",
        "ability": "高级腐蚀：Your attacks reduce the target's armor by -13 for 7 seconds.",
        "lore": "The original demonic favorite that served as basis for the beloved mortal design.",
        "suggest": "攻击力 +14% | 护甲 +10%",
        "tags": [
            "元素持续",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 250,
        "code": "spider_legs",
        "name": "网虫腿",
        "en": "Spider Legs",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/spider_legs.png",
        "attr": [],
        "effect": "持续时间: 14；效果：疾行",
        "ability": "疾行：Grants you 20% bonus movement speed, 50% improved turn rate, and free pathing for 14 seconds. Walking over trees causes them to be destroyed.",
        "lore": "A horrifying yet useful mixture of necromancy and artificing.",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": 20
    },
    {
        "id": 251,
        "code": "demonicon",
        "name": "冥灵书",
        "en": "Book of the Dead",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/demonicon.png",
        "attr": [],
        "effect": "效果：高级恶魔召唤",
        "ability": "高级恶魔召唤：Summon 2 demonic warriors and 2 demonic archers that last 65 seconds. The Warrior burns mana every hit, reveals invisible units, and deals magical damage to whoever kills it. The Archer has a basic dispel ability with a slow and a passive movement speed aura.",
        "lore": "A record of the final reckoning. With one page torn out.",
        "suggest": "攻击力 +14% | 召唤物强度 +8%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 80
    },
    {
        "id": 252,
        "code": "fallen_sky",
        "name": "天崩",
        "en": "Fallen Sky",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/fallen_sky.png",
        "attr": [],
        "effect": "眩晕时间: 1.6；受伤后禁用时间: 3.0；效果：天崩",
        "ability": "天崩：Transform into a meteor that strikes down at the target area after 1 seconds in a 315 AoE, stunning enemies for 1.6 seconds and dealing impact damage. Continues to deal damage every 1 seconds to enemy units and buildings for 6 seconds.\n\nBuilding Impact Damage: 75 \nBuilding Over Time Damage: 60 \n\nNon-Building Impact Damage: 150 \nNon-Building Over Time Damage: 60\n\nFallen Sky cannot be used for 3 seconds after taking damage from an enemy hero or Roshan.",
        "lore": "One of the few surviving creations of the acolytes of the Wyrmforge.",
        "suggest": "攻击力 +14% | 回复 +7%",
        "tags": [
            "法术爆发",
            "控制减速"
        ],
        "cd": 25
    },
    {
        "id": 253,
        "code": "minotaur_horn",
        "name": "牛头人之角",
        "en": "Minotaur Horn",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/minotaur_horn.png",
        "attr": [
            "魔法抗性 +50%"
        ],
        "effect": "魔法抗性 +50%；持续时间: 2；效果：次级天神下凡",
        "ability": "次级天神下凡：Applies a basic dispel. Grants 50% magic resistance and immunity to reflected and pure damage for 2s. For the duration of the effect, any negative effect from enemy spells has no effect.\n\nDispel Type: Basic Dispel",
        "lore": "The trophy from a mighty beast ambushed and slain in the recesses of its own home.",
        "suggest": "攻击力 +14% | 元素强度 +7%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": 40
    },
    {
        "id": 254,
        "code": "heavy_blade",
        "name": "巫毒之刃",
        "en": "Witchbane",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/heavy_blade.png",
        "attr": [],
        "effect": "作用半径: 300；伤害: 4；效果：净化；征服",
        "ability": "净化：Dispel all enemies and allies in a 300 unit radius.\n\nDispel Type: Basic Dispel",
        "lore": "With ready access to test subjects, untold cruelties have been dreamed up and loosed upon the world from within the walls of the Tyler Estate.",
        "suggest": "攻击力 +14%",
        "tags": [
            "法术爆发",
            "元素持续"
        ],
        "cd": 40
    },
    {
        "id": 255,
        "code": "dezun_bloodrite",
        "name": "德尊血仪",
        "en": "Dezun Bloodrite",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/dezun_bloodrite.png",
        "attr": [
            "最大生命 +35"
        ],
        "effect": "最大生命 +35；效果：血之祈祷",
        "ability": "血之祈祷：Spells have a 16% larger Area of Effect, but now additionally cost health equal to 35% of their mana cost.",
        "lore": "The gateway to a lost lineage of power, unlocked only with blood.",
        "suggest": "生命 +18%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 256,
        "code": "divine_regalia",
        "name": "神圣圣衣",
        "en": "Divine Regalia",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/divine_regalia.png",
        "attr": [],
        "effect": "效果：尊贵",
        "ability": "尊贵：Increases outgoing damage by 20%. Dying permanently disables this Neutral Item and the current Enchantment is lost.",
        "lore": "So magnificent, it cannot abide failure.",
        "suggest": "攻击力 +14%",
        "tags": [
            "元素持续",
            "控制减速"
        ],
        "cd": false
    },
    {
        "id": 257,
        "code": "riftshadow_prism",
        "name": "影墟棱晶",
        "en": "Riftshadow Prism",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/riftshadow_prism.png",
        "attr": [],
        "effect": "受到的伤害: 200；持续时间: 20；生命消耗: 8；效果：折射",
        "ability": "折射：Spend 8% of your current life total to create a full health illusion that lasts for 20 seconds. The illusion has 50% outgoing damage and takes 200% of incoming damage.",
        "lore": "",
        "suggest": "攻击力 +14% | 生命 +18%",
        "tags": [
            "坦克反伤",
            "召唤增殖"
        ],
        "cd": 30
    },
    {
        "id": 258,
        "code": "harmonizer",
        "name": "协和",
        "en": "Harmonizer",
        "cost": 0,
        "quality": "white",
        "category": "neutral",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/harmonizer.png",
        "attr": [],
        "effect": "增伤: 6；效果：平衡",
        "ability": "平衡：Gain 5% spell manacost reduction for every spell off cooldown and 6% spell amplification for every spell on cooldown.",
        "lore": "",
        "suggest": "冷却 -7%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 259,
        "code": "aegis",
        "name": "不朽之守护",
        "en": "Aegis of the Immortal",
        "cost": 0,
        "quality": "blue",
        "category": "special",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/aegis.png",
        "attr": [],
        "effect": "重生时间: 5.0；消失时间: 300.0；消失时间: 5；消失时间（加速模式）: 240.0；效果：重生",
        "ability": "重生：Brings you to life with full health and mana 5 seconds after you die, at the location where you died. \n\nReincarnation must be used within 5 minutes or Aegis of the Immortal disappears. If it expires, it will heal you over 5 seconds (dispels on damage).",
        "lore": "The Immortal was said to own a shield that protected him from death itself.",
        "suggest": "攻击力 +14% | 生命 +18%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 260,
        "code": "tome_of_aghanim",
        "name": "阿哈利姆之书",
        "en": "Tome of Aghanim",
        "cost": 0,
        "quality": "white",
        "category": "special",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/tome_of_aghanim.png",
        "attr": [],
        "effect": "持续时间（分钟）: 3；效果：吞噬",
        "ability": "吞噬：Temporarily grants an allied target the Aghanim's Scepter buff for 3 minutes.",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "召唤增殖"
        ],
        "cd": false
    },
    {
        "id": 261,
        "code": "fusion_rune",
        "name": "融合符文",
        "en": "Fusion Rune",
        "cost": 0,
        "quality": "white",
        "category": "special",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/fusion_rune.png",
        "attr": [],
        "effect": "持续时间: 50；效果：吞噬",
        "ability": "吞噬：Grants the target the bonuses of every Power Rune for 50 seconds. Each use consumes a charge.",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": 120
    },
    {
        "id": 262,
        "code": "tier1_token",
        "name": "中立装备代币 I",
        "en": "Tier 1 Token",
        "cost": null,
        "quality": "white",
        "category": "special",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/tier1_token.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 263,
        "code": "tier2_token",
        "name": "中立装备代币 II",
        "en": "Tier 2 Token",
        "cost": null,
        "quality": "white",
        "category": "special",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/tier2_token.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 264,
        "code": "tier3_token",
        "name": "中立装备代币 III",
        "en": "Tier 3 Token",
        "cost": null,
        "quality": "white",
        "category": "special",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/tier3_token.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 265,
        "code": "tier4_token",
        "name": "中立装备代币 IV",
        "en": "Tier 4 Token",
        "cost": null,
        "quality": "white",
        "category": "special",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/tier4_token.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 266,
        "code": "tier5_token",
        "name": "中立装备代币 V",
        "en": "Tier 5 Token",
        "cost": null,
        "quality": "white",
        "category": "special",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/tier5_token.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 267,
        "code": "enhancement_vast",
        "name": "高远",
        "en": "Vast",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_vast.png",
        "attr": [
            "攻击距离 +60",
            "攻击力 +6"
        ],
        "effect": "攻击距离 +60；攻击力 +6；-4/-6/-8 护甲",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +14% | 护甲 +10%",
        "tags": [
            "远程点杀",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 268,
        "code": "enhancement_quickened",
        "name": "迅速",
        "en": "Quickened",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_quickened.png",
        "attr": [
            "移动速度 +15"
        ],
        "effect": "移动速度 +15",
        "ability": "",
        "lore": "",
        "suggest": "闪避 +6%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 269,
        "code": "enhancement_audacious",
        "name": "冒险",
        "en": "Audacious",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_audacious.png",
        "attr": [
            "攻击速度 +100%"
        ],
        "effect": "攻击速度 +100%；+80 魔法攻击伤害；+10% 受到的伤害",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 270,
        "code": "enhancement_mystical",
        "name": "神秘",
        "en": "Mystical",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_mystical.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "",
        "suggest": "回复 +7%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 271,
        "code": "enhancement_alert",
        "name": "警觉",
        "en": "Alert",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_alert.png",
        "attr": [
            "攻击速度 +7%"
        ],
        "effect": "攻击速度 +7%；+0/150/225/300 视野",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 272,
        "code": "enhancement_brawny",
        "name": "壮实",
        "en": "Brawny",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_brawny.png",
        "attr": [
            "最大生命 +110"
        ],
        "effect": "最大生命 +110；+0/0/0/25% 减速抗性",
        "ability": "",
        "lore": "",
        "suggest": "生命 +18% | 回复 +7%",
        "tags": [
            "控制减速",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 273,
        "code": "enhancement_tough",
        "name": "坚强",
        "en": "Tough",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_tough.png",
        "attr": [
            "攻击力 +7"
        ],
        "effect": "攻击力 +7；+0/0/0/40% 击退抗性",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +14% | 护甲 +10%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 274,
        "code": "enhancement_feverish",
        "name": "狂热",
        "en": "Feverish",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_feverish.png",
        "attr": [],
        "effect": "+15% 冷却",
        "ability": "",
        "lore": "",
        "suggest": "冷却 -7%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 275,
        "code": "enhancement_fleetfooted",
        "name": "捷足",
        "en": "Fleetfooted",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_fleetfooted.png",
        "attr": [
            "移动速度 +115"
        ],
        "effect": "移动速度 +115",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 276,
        "code": "enhancement_crude",
        "name": "粗暴",
        "en": "Crude",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_crude.png",
        "attr": [
            "生命恢复 +10/s",
            "魔法抗性 +2.4%",
            "伤害输出 +3%"
        ],
        "effect": "生命恢复 +10/s；魔法抗性 +2.4%；伤害输出 +3%；-8/12/16% 基础攻击间隔",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +14% | 生命 +18% | 回复 +7%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 277,
        "code": "enhancement_boundless",
        "name": "无边",
        "en": "Boundless",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_boundless.png",
        "attr": [
            "攻击距离 +150"
        ],
        "effect": "攻击距离 +150；+275 施法距离",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 278,
        "code": "enhancement_wise",
        "name": "睿智",
        "en": "Wise",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_wise.png",
        "attr": [],
        "effect": "",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 279,
        "code": "enhancement_timeless",
        "name": "永恒",
        "en": "Timeless",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_timeless.png",
        "attr": [],
        "effect": "+8/15% 负面效果持续时间；+6/16% 增伤",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 280,
        "code": "enhancement_greedy",
        "name": "贪婪",
        "en": "Greedy",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_greedy.png",
        "attr": [],
        "effect": "每分钟金钱加成: 75 / 100；-30/-60 攻击力",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "法术爆发",
            "召唤增殖"
        ],
        "cd": false
    },
    {
        "id": 281,
        "code": "enhancement_vampiric",
        "name": "吸血鬼",
        "en": "Vampiric",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_vampiric.png",
        "attr": [],
        "effect": "+30% 吸血；+20% 吸血；+300 视野",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 282,
        "code": "enhancement_keen_eyed",
        "name": "犀利",
        "en": "Keen-eyed",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_keen_eyed.png",
        "attr": [],
        "effect": "+125/135/145 施法距离",
        "ability": "",
        "lore": "",
        "suggest": "回复 +7%",
        "tags": [
            "法术爆发"
        ],
        "cd": false
    },
    {
        "id": 283,
        "code": "enhancement_evolved",
        "name": "进化",
        "en": "Evolved",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_evolved.png",
        "attr": [
            "最大生命 +800",
            "攻击速度 +40%",
            "魔法抗性 +16%",
            "护甲 +5.6"
        ],
        "effect": "最大生命 +800；攻击速度 +40%；魔法抗性 +16%；护甲 +5.6",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 284,
        "code": "enhancement_titanic",
        "name": "巨神",
        "en": "Titanic",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_titanic.png",
        "attr": [
            "攻击力 +8"
        ],
        "effect": "攻击力 +8；+10/12/14% 状态抗性；-10/-12/-14% 攻击速度",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 285,
        "code": "enhancement_fierce",
        "name": "凶猛",
        "en": "Fierce",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_fierce.png",
        "attr": [
            "移动速度 +30",
            "攻击力 +15"
        ],
        "effect": "移动速度 +30；攻击力 +15；+250 视野",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 286,
        "code": "enhancement_dominant",
        "name": "主导",
        "en": "Dominant",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_dominant.png",
        "attr": [
            "攻击速度 +25%",
            "魔法抗性 +15%",
            "最大生命 +205"
        ],
        "effect": "攻击速度 +25%；魔法抗性 +15%；最大生命 +205",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +14% | 生命 +18%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 287,
        "code": "enhancement_restorative",
        "name": "恢复",
        "en": "Restorative",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_restorative.png",
        "attr": [
            "生命恢复 +8/s"
        ],
        "effect": "生命恢复 +8/s；+10% 治疗增幅",
        "ability": "",
        "lore": "",
        "suggest": "生命 +18% | 回复 +7%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 288,
        "code": "enhancement_thick",
        "name": "厚实",
        "en": "Thick",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_thick.png",
        "attr": [
            "最大生命 +240",
            "生命恢复 +3/s",
            "护甲 +7"
        ],
        "effect": "最大生命 +240；生命恢复 +3/s；护甲 +7",
        "ability": "",
        "lore": "",
        "suggest": "生命 +18% | 护甲 +10% | 回复 +7%",
        "tags": [
            "法术爆发",
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 289,
        "code": "enhancement_curious",
        "name": "释放",
        "en": "Unleashed",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_curious.png",
        "attr": [],
        "effect": "+30% 装备效能",
        "ability": "",
        "lore": "",
        "suggest": "技能强化（见效果）",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 290,
        "code": "enhancement_vital",
        "name": "活力",
        "en": "Vital",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_vital.png",
        "attr": [
            "生命恢复 +2/s"
        ],
        "effect": "生命恢复 +2/s",
        "ability": "",
        "lore": "",
        "suggest": "生命 +18% | 回复 +7%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 291,
        "code": "enhancement_hulking",
        "name": "笨重",
        "en": "Hulking",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_hulking.png",
        "attr": [
            "最大生命 +5",
            "攻击速度 +30%"
        ],
        "effect": "最大生命 +5；攻击速度 +30%；+1.5% 最大生命值恢复",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +14% | 生命 +18% | 回复 +7%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    },
    {
        "id": 292,
        "code": "enhancement_manic",
        "name": "癫狂",
        "en": "Manic",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_manic.png",
        "attr": [],
        "effect": "-18% 基础攻击间隔；+20% 施法速度加成；-20% 视野",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +14%",
        "tags": [
            "远程点杀"
        ],
        "cd": false
    },
    {
        "id": 293,
        "code": "enhancement_nimble",
        "name": "轻快",
        "en": "Nimble",
        "cost": 0,
        "quality": "white",
        "category": "enhancement",
        "img": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/enhancement_nimble.png",
        "attr": [
            "移动速度 +6",
            "攻击力 +10"
        ],
        "effect": "移动速度 +6；攻击力 +10；-1.5/2.25/3 生命恢复",
        "ability": "",
        "lore": "",
        "suggest": "攻击力 +14% | 生命 +18% | 回复 +7%",
        "tags": [
            "坦克反伤"
        ],
        "cd": false
    }
];
