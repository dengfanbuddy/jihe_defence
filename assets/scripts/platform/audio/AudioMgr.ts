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

    // 当前播放的背景音乐ID
    private currentBgmId: number = null;

    //自定义全局点击事件
    public touchStart:Function = null;
    //默认点击事件
    public defaultTouchStart:Function = ()=>{
        // 全局触摸音：音量 0.5（音效清单见 `docs/打击反馈设计.md` §12.3 第 11 行）
        this.playSFX("click", 0.5)
    };


    //音效和音乐缓存
    clipCache:Map<string,AudioClip> = new Map()




    // 播放背景音乐
    public playBGM(): void {
        if (this.bgm) {
            this.bgm.play();
        }
    }

    // 停止背景音乐
    public stopBGM(): void {
        if (this.bgm ) {
            this.bgm .stop();
        }
    }

    // 暂停背景音乐
    public pauseBGM(): void {
        if (this.bgm) {
            this.bgm.pause();
        }
    }


    // 设置背景音乐音量
    public setBGMVolume(volume: number): void {
        this.bgmVolume = volume;
        if (this.bgm) {
            this.bgm.volume = this.bgmVolume
        }
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
        //音量检查
        let flag: string = sys.localStorage.getItem("local_sfx");
        if (flag == "0") {
            console.log("音效声音为0");
            return;
        }
        //TODO 音效开关检查

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