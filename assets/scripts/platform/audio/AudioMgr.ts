import { _decorator, AudioClip, AudioSource, Component, director, game ,Input,input,Node, resources, sys} from "cc";
import { ResManager } from "../resources/ResMgr";

const { ccclass, property } = _decorator;

@ccclass('AudioMgr')
export default class AudioMgr extends Component{

    // 单例模式
    private static instance: AudioMgr = null;
    public static get ins(): AudioMgr {
        if (AudioMgr.instance === null) {
            let rootNode = new Node("AudioMgr")
            AudioMgr.instance = rootNode.addComponent(AudioMgr)
            //添加bgm节点
            let bgmNode = new Node("bgmNode")
            bgmNode.setParent(rootNode)
            let bgmS = bgmNode.addComponent(AudioSource)
            bgmS.loop = true
            AudioMgr.instance.bgm = bgmS

            //添加音效节点
            let sfxNode = new Node("vfxNode")
            sfxNode.setParent(rootNode)
            let sfxS = sfxNode.addComponent(AudioSource)
            sfxS.loop = false
            AudioMgr.instance.sfx = sfxS

            //添加音效节点
            let voiceNode = new Node("voiceNode")
            voiceNode.setParent(rootNode)
            let vS = voiceNode.addComponent(AudioSource)
            vS.loop = false
            AudioMgr.instance.voice = vS

            director.addPersistRootNode(rootNode); // 持久化节点，切换场景时不销毁

            input.on(Input.EventType.TOUCH_START,()=>{
                if(AudioMgr.instance.touchStart){
                    AudioMgr.instance.touchStart.call(AudioMgr.instance)
                }else{
                    AudioMgr.instance.defaultTouchStart.call(AudioMgr.instance)
                }
            })
            //TODO 全局按钮音效？
            // ⚠ 这个全局触摸音是**在第一次访问 `AudioMgr.ins` 时**才注册的（本 getter 是唯一入口）。
            //   2026-10 之前全工程没人访问过 `ins`，所以它从来没生效过；B4 起战斗场景会访问它
            //   （注入打击反馈的播放回调），于是"每次触摸一声 click"从**第一局战斗开始**生效 ——
            //   这是有意的（点空地换目标是本作的核心交互，给一声点击是合理的），但要改音量/关掉就改这里。
        } 
        return AudioMgr.instance;
    }

    //TODO 每个声音设置都要设置一个开关，关闭就不播放

    // 背景音乐
    private bgm: AudioSource = null;
    // 音效
    private sfx:AudioSource = null;
    // 语音
    private voice: AudioSource = null;



    // 背景音乐音量
    private bgmVolume: number = 1.0;
    // 音效音量
    private sfxVolume: number = 1.0;
    // 语音音量
    private voiceVolume: number = 1.0;

    /**
     * 当前播放的 BGM 资源路径（`audio/xxx`；空字符串 = 现在没有 BGM）。
     *
     * 为什么存路径而不是"一个 id/一个 bool"：`playBGM` 要**幂等** ——
     * 一局里换英雄（重新选）不该把音乐从头切一遍，而"同一首已经播过、且已经播到 40 秒"
     * 只有比得出"现在这首 == 你要的那首"才判得了。
     */
    private currentBgmUrl: string = '';

    /**
     * 音效开关（`localStorage.local_sfx == '0'` = 静音）的**缓存**。
     *
     * 为什么必须缓存：`playSFX` 是**热路径**（打击反馈的音效由 `HitFeelDirector` 节流后调用，
     * 上限 2 声 / 50ms ≈ 40 次/秒；boss 战命中密度最高时就是贴着这个上限在打）。
     * 原来的写法在每次调用里做两件昂贵的事：
     *   · `sys.localStorage.getItem('local_sfx')` —— 同步读存储；
     *   · 静音时 `console.log('音效声音为0')` —— **DevTools 开着时每条日志都是同步 DOM 写入**，
     *     40 条/秒足以把主线程按住（表现为 profiler 里逻辑/渲染都只有 1~2ms，但 FPS 掉到个位数）。
     * 现在改成"最多每 `SFX_SWITCH_TTL_MS` 读一次存储"，且**只在开关真的翻转时**打一条日志。
     */
    private sfxMuted = false;
    /** 上次读开关的时刻（`Date.now()`，毫秒；-1 = 还没读过） */
    private sfxSwitchAt = -1;
    /** 读一次开关的最短间隔（毫秒）—— 控制台里手改 `local_sfx` 后最多 1 秒生效 */
    private static readonly SFX_SWITCH_TTL_MS = 1000;

    //自定义全局点击事件
    public touchStart:Function = null;
    //默认点击事件
    public defaultTouchStart:Function = ()=>{
        // 全局触摸音：音量 0.5（音效清单见 `docs/打击反馈设计.md` §12.3 第 11 行）
        this.playSFX("click", 0.5)
    };


    //音效和音乐缓存
    clipCache:Map<string,AudioClip> = new Map()




    /**
     * 播放背景音乐（**按资源路径**，不是"把 bgm 节点上挂着的那首播了"）。
     *
     * 口径与 `playSFX` 一致：**先查缓存 → 再加载 → 再播**，且加载失败只是"没声音"，绝不抛。
     *
     * @param url 资源路径。**不带扩展名**；`audio/` 前缀可省（本方法自己补），
     *            例如 `playBGM('audio/normal_battle')` → 加载 `resources/audio/normal_battle`。
     * @param volume 音量倍数（0~1）。**给了就写进 `bgmVolume`**（下一次播放仍然用它，
     *               所以"战斗 BGM 0.6"这种口径由调用方在第一次播的时候定一次即可）。
     *
     * 三条保证：
     *   ① **幂等** —— 同一首正在播时直接返回（换英雄/重进面板不会把音乐切回开头）；
     *   ② **可关** —— `localStorage.local_bgm == '0'` 时整条不播（与 `local_sfx` 同一套开关）；
     *   ③ **异步加载要预加载** —— 3.7 MB 的 mp3 首次加载有秒级延迟，
     *      进战斗前先 `preloadBgm()`（同 `preloadSfx` 的理由：音乐晚半拍起 = 像卡住了）。
     */
    public async playBGM(url: string, volume?: number): Promise<void> {
        //音量检查
        if (sys.localStorage.getItem("local_bgm") == "0") {
            console.log("背景音乐声为0");
            return;
        }
        if (volume !== undefined && Number.isFinite(volume)) {
            this.setBGMVolume(volume);
        }
        if (!url) return;
        if (!url.startsWith("audio/")) url = "audio/" + url;
        if (!this.bgm) return;
        // 幂等：同一首已经在播就什么都不做（`playing` 为假 = 暂停/播完，那种情况要重新起播）
        if (this.currentBgmUrl === url && this.bgm.playing) return;

        let clip: AudioClip = this.clipCache.get(url);
        if (!clip) {
            clip = await this.loadAudioClip(url);
        }
        if (!clip) return;   // 缺文件 / 加载失败：音乐是"可有可无"的东西，绝不能把一帧战斗打断
        // ⚠ 记路径必须在 play() **之前**：await 期间可能又来了另一次 playBGM，
        //   两个协程同时走到这里时，后写的那个才是"真正在播的"（play 是同步的，最后写的赢）
        this.currentBgmUrl = url;
        this.bgm.clip = clip;
        this.bgm.loop = true;
        this.bgm.volume = this.bgmVolume;
        this.bgm.play();
    }

    /** 预加载一首 BGM（只进缓存，不出声）—— 进战斗前调，避免第一声音乐晚半拍 */
    public async preloadBgm(url: string): Promise<void> {
        if (!url) return;
        if (!url.startsWith("audio/")) url = "audio/" + url;
        if (this.clipCache.has(url)) return;
        await this.loadAudioClip(url);
    }

    // 停止背景音乐
    public stopBGM(): void {
        if (this.bgm ) {
            this.bgm .stop();
        }
        // 记住"现在没有 BGM"：下次 playBGM 传同一首时要能重新起播（幂等判据靠它）
        this.currentBgmUrl = '';
    }

    // 暂停背景音乐
    public pauseBGM(): void {
        if (this.bgm) {
            this.bgm.pause();
        }
    }

    /** 继续播放背景音乐（暂停后恢复；**没有 BGM 时是空操作**，不会凭空起播某首曲子） */
    public resumeBGM(): void {
        if (this.bgm && !this.bgm.playing && this.currentBgmUrl) {
            this.bgm.play();
        }
    }


    // 设置背景音乐音量
    public setBGMVolume(volume: number): void {
        this.bgmVolume = volume;
        if (this.bgm) {
            this.bgm.volume = this.bgmVolume
        }
    }

    /**
     * 当前音效是不是被关掉了（`localStorage.local_sfx == '0'`）。
     *
     * 口径（三条，别绕过它去直接读 `localStorage`）：
     *   · **最多每 `SFX_SWITCH_TTL_MS` 读一次存储**：热路径（每秒几十次）上不能每次都同步读；
     *   · 控制台里手改 `local_sfx` 后**最多 1 秒生效**（TTL 就是为这条留的逃生口）；
     *   · 开关**翻转时**才打一条日志（不是每次调用都打）——
     *     原来的 `console.log("音效声音为0")` 在静音状态下每秒刷几十条，DevTools 开着时
     *     会把主线程按住（profiler 里逻辑/渲染都 1~2ms、FPS 却只有个位数就是这个味道）。
     */
    private isSfxMuted(): boolean {
        const now = Date.now();
        if (this.sfxSwitchAt >= 0 && (now - this.sfxSwitchAt) < AudioMgr.SFX_SWITCH_TTL_MS) {
            return this.sfxMuted;
        }
        this.sfxSwitchAt = now;
        const muted = sys.localStorage.getItem("local_sfx") === "0";
        if (muted !== this.sfxMuted) {
            this.sfxMuted = muted;
            console.log(muted ? "[音效] 已静音（local_sfx = 0），本局不再播放音效" : "[音效] 已恢复播放");
        }
        return this.sfxMuted;
    }

    // 播放音效
    /**
     * 播放一个音效（**先查缓存 → 再加载 → 再播**；首次播放会有一次异步加载）。
     *
     * @param url 资源路径。**不带扩展名、不带 `sfx/` 前缀**（本方法自己补），
     *            例如 `playSFX('hit_crit')` → 加载 `resources/sfx/hit_crit`。
     * @param volume 音量倍数（0~1，最终 = `AudioSource.volume × 它`；缺省 1）
     *
     * ⚠ 战斗里**密集**触发的音效必须先 `preloadSfx()`：本方法是"先加载再播"，
     * 首次那一发会晚到（打击反馈里"晚半拍"等于"没响"）。
     */
    public async playSFX(url: string, volume: number = 1) {
        //音量检查（走缓存：热路径上不许每次调用都读 localStorage / 打日志，见 isSfxMuted 的注释）
        if (this.isSfxMuted()) return;

        if (!url.startsWith("sfx/")) {
            url = "sfx/" + url;
        }
        let audioClip: AudioClip = this.clipCache.get(url);
        if (!audioClip) {
            audioClip = await this.loadAudioClip(url);
        }
        // if (Global.inst.PlatformType == EnumPlatformType.wx) {
        //     let soundAC: any = this._soundPool.getObj();
        //     if (soundAC) {
        //         soundAC.src = audioClip.nativeUrl;
        //         // soundAC.loop = loop;
        //         soundAC.play();
        //     }
        // } else {
        //     this.curSoundAC.playOneShot(audioClip, 1);
        // }
        // ⚠ clip 可能是 null（文件缺失 / 加载失败）：真引擎的 playOneShot(null) 会抛异常，
        //   而音效是"可有可无"的东西，绝不能因为它把一帧的战斗推进整个打断
        if (!audioClip) return;
        this.sfx.playOneShot(audioClip, volume);
    }

    /**
     * 预加载一批音效（只加载进缓存，不发声）。
     *
     * 为什么必须有：`playSFX` 是"缓存未命中就 await 加载"，战斗里第一次命中才去加载
     * 会让那一发**明显晚于**画面上的印痕 —— 而打击反馈最怕的就是音画不同步。
     * 进战斗时把本局会用到的键一次性喂进来（清单见 `HitFeelConfig.hitFeelSfxKeys()`）。
     */
    public async preloadSfx(keys: string[]): Promise<void> {
        if (!keys || keys.length === 0) return;
        for (const k of keys) {
            if (!k) continue;
            const url = k.startsWith("sfx/") ? k : "sfx/" + k;
            if (this.clipCache.has(url)) continue;
            await this.loadAudioClip(url);
        }
    }

    loadAudioClip(url: string): Promise<AudioClip> {
        return new Promise<AudioClip>(r => {
            // 优先从资源缓存获取
            if (this.clipCache.has(url)) {
                r(this.clipCache.get(url));
                return;
            }
            /**
             * ⚠ **先 `resources.load`，再退回 bundle** —— 顺序不能反。
             *
             * 反过来的代价（2026-10 实测踩到）：`ResManager.loadBundleRes` 会**按首段路径当分包名**，
             * 而音效一律带 `sfx/` 前缀、工程又没有名为 `sfx` 的分包
             * → 每次首次加载都会先打印一条 `分包:sfx加载失败`，再降级到 `resources.load` 才成功。
             * 音效放在主包（`assets/resources/sfx/`）是有意的：它们是主玩法反馈，不该等分包。
             */
            resources.load(url, AudioClip, (err, clip) => {
                if (!err && clip) {
                    this.clipCache.set(url, clip);
                    r(clip);
                    return;
                }
                // 主包没有 → 可能是分包资源（未来的 BGM / 语音包），走 bundle 加载
                ResManager.inst.loadBundleRes(url, AudioClip).then((bundleClip: AudioClip) => {
                    if (bundleClip) {
                        this.clipCache.set(url, bundleClip);
                        r(bundleClip);
                    } else {
                        console.error(`加载音效失败: ${url}`, err);
                        r(null);
                    }
                });
            });
        });
    }

    // 设置音效音量
    public setSFXVolume(volume: number): void {
        this.sfxVolume = volume;
        if (this.sfx) {
            this.sfx.volume = volume;
        }
    }

    // 播放语音
    public playVoice(index: number): void {
        if (this.voice) {
            this.voice.play();
        }
    }

    // 设置语音音量
    public setVoiceVolume(volume: number): void {
        this.voiceVolume = volume;
    }

    // 停止所有音频
    public stopAll(): void {
        if (this.bgm) this.bgm.stop();
        if (this.sfx) this.sfx.stop();
        if (this.voice) this.voice.stop();
    }

    // 暂停所有音频
    public pauseAll(): void {
        if (this.bgm) this.bgm.pause();
        if (this.sfx) this.sfx.pause();
        if (this.voice) this.voice.pause();
    }

    // 恢复所有音频
    public resumeAll(): void {
        if (this.bgm) this.bgm.play();
        if (this.sfx) this.sfx.play();
        if (this.voice) this.voice.play();
    }
}