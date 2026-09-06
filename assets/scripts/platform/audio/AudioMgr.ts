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
        this.playSFX("click")
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
    public async playSFX(url: string) {
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
        this.sfx.playOneShot(audioClip, 1);
    }
    loadAudioClip(url: string): Promise<AudioClip> {
        return new Promise<AudioClip>(r => {
            // 优先从资源缓存获取
            if (this.clipCache.has(url)) {
                r(this.clipCache.get(url));
                return;
            }
            // 通过 ResManager 的 bundle 加载系统加载音频
            ResManager.inst.loadBundleRes(url, AudioClip).then((clip: AudioClip) => {
                if (clip) {
                    this.clipCache.set(url, clip);
                    r(clip);
                } else {
                    // bundle 加载失败，降级到 resources.load
                    resources.load(url, AudioClip, (err, clip) => {
                        if (err) {
                            console.error(`加载音效失败: ${url}`, err);
                            r(null);
                        } else {
                            this.clipCache.set(url, clip);
                            r(clip);
                        }
                    });
                }
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