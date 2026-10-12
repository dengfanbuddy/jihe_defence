/**
 * 背景音乐（BGM）清单 —— **唯一真源**。
 *
 * ── 它是什么 ──
 * `AudioMgr` 只认"资源路径 + 音量"（平台层**不知道游戏里有哪些曲子**，也不该知道），
 * 于是"局内战斗放哪一首、多大声"这件事收在这个文件里：场景只写 `BGM_TRACKS.battle.key`。
 *
 * ── 素材放在哪 ──
 * `assets/resources/audio/<文件名>`（**主包**，与 `assets/resources/sfx/` 同一套理由：
 * 音乐是主玩法的一部分，不该等分包加载）。`path` **不带扩展名**，与 `playSFX` 的键口径一致。
 *
 * ── 为什么音量写在这里而不是平台层 ──
 * 平台层的 `bgmVolume` 是"当前这一首"的音量（会被 `playBGM` 的第二参数覆盖），
 * 而"战斗音乐应该压到 0.6"是**本作的听感口径**（音效要盖在音乐上听得清：本作是自动战斗，
 * 打击音是唯一的实时反馈）。改听感改这里，别去改 `AudioMgr`。
 *
 * ── 播放时机（谁调 `playBGM`）──
 * 见 `Scene_Game_Stage`：**选完英雄（战斗真的开始）起播**、离开战斗停。
 *   · 不在 `show()` 里播：那时是选英雄面板，还没打；`panelPaused` 期间放战斗曲会与画面不符；
 *   · 不在每次 `selectHero` 重播：一局内换英雄不该把曲子切回开头（`playBGM` 自带幂等，这里也不重调）。
 */

/** 一首 BGM 的记录 */
export interface BgmTrack {
    /** 键：`resources` 下的路径（不带扩展名） */
    key: string;
    /** 音量倍数（0~1） */
    volume: number;
    /** 说明（这是给策划看的，运行期不消费） */
    note?: string;
}

export const BGM_TRACKS: Record<string, BgmTrack> = {
    /** 局内战斗（`assets/resources/audio/normal_battle.mp3`） */
    battle: {
        key: 'audio/normal_battle',
        volume: 0.6,
        note: '阶段模式与无尽模式共用；现只有这一首，进战斗起播、出战斗停',
    },
};

/** 战斗 BGM（场景读它，不写字面量 —— 路径写错在运行期只是"没声音"，最难查） */
export const BGM_BATTLE: BgmTrack = BGM_TRACKS.battle;
