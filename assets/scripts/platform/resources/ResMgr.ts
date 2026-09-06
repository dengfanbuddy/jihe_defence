import { AnimationClip, Asset, AssetManager, AudioClip, BufferAsset, ImageAsset, JsonAsset, Material, Prefab, SpriteAtlas, SpriteFrame, TextAsset, Texture2D, assetManager, rect, resources, size, sp } from "cc";
import { LogMgr } from "../log/LogMgr";

export interface BundleMeta {
    name: string,
    remote: boolean,
    [key: string]: any
}

/**
 * 主要管理远程资源，只有原生情况下，会调用bundle中资源
 * TODO 动态加载的资源需要在适当的时候进行释放，不然一直占用内存
 * 
 * 资源类型：
 * 1.图集
 * 2.字体
 * 3.声音
 * 4.spine骨骼动画
 * 5.材质球
 * 6.动画
 * 7.预制件
 * 8.二进制数据
 * 9.单个图片
 */
export class ResManager {

    private static _inst: ResManager;
    public static get inst() {
        if (!this._inst) {
            this._inst = new ResManager();
        }
        return this._inst;
    }

    /** 远程资源列表 */
    private _remoteAssetMap: Map<string, Asset> = new Map();
    /** 图集列表 */
    private _atlasMap: Map<string, SpriteAtlas> = new Map();

    private _jsonMap: Map<string, any> = new Map();
    private _textMap: Map<string, TextAsset> = new Map();
    // private _spineMap: Map<string, Map<string, sp.SkeletonData>> = new Map();
    // public get spineMap(): Map<string, Map<string, sp.SkeletonData>> {
    //     return this._spineMap;
    // }

    //bundle元数据
    private bundleMetas: Map<string, BundleMeta> = new Map()
    //已加载bundle
    private _bundleMap: Map<string, AssetManager.Bundle> = new Map();


    public init() {
        //
    }

    constructor() {

    }



    //#region 加载bundle

    public addBundleMeta(name: string, meta: BundleMeta) {
        this.bundleMetas.set(name, meta)
    }

    /**
     * 加载分包
     * @param name 远程包名字
     * @param isRemote 是否是远程包
     * @param remoteIndex 远程下标
     * @param progressCB 进度
     * @returns 
     */
    public loadBundle(name: string): Promise<void> {
        return new Promise<void>((r, e) => {
            let meta = this.bundleMetas.get(name)
            if (!meta) {
                LogMgr.err("未找到bundle元数据：" + name)
                e("未找到bundle元数据：" + name)
                return
            }
            if (this._bundleMap.get(name)) {
                LogMgr.warn("分包资源已经被加载", name);
                r();
                return;
            }
            assetManager.loadBundle(name, (err: any, data: AssetManager.Bundle) => {
                if (!err) {
                    LogMgr.info("加载bunble包 suc: " + name);
                    this._bundleMap.set(name, data);
                    if (meta.remote) {
                        data.preloadDir("", null, null, () => {
                            LogMgr.info("预加载远程bundle资源完成 suc: " + name);
                        });
                    }
                    r();
                } else {
                    LogMgr.err("加载bundle包错误:" + name + ":" + err);
                    e(err);
                }
            });
        });
    }
    //#endregin

    //#region 加载资源
    /**
     * 直接根据url加载远程资源
     * @param url 
     * @returns 
     */
    private async loadRemoteRes(url: string, type: any): Promise<any> {
        return new Promise<any>(resp => {
            assetManager.loadRemote(url, (err: Error, data: any) => {
                if (err) {
                    LogMgr.err("加载失败:" + url);
                    resp([url, null]);
                } else {
                    resp([url, data]);
                    this._remoteAssetMap.set(url, data);
                }
            })
        })
    }

    /**
    * 批量加载远端资源(如果有加载失败会停止下载后面资源)
    * @param {string[]} urls
    */
    public loadRemoteResArr(urls: string[], type: any): Promise<any> {
        return new Promise<any>(resp => {
            if (!urls || urls.length == 0) {
                resp(null);
            } else {
                let reource = {};
                for (var i: number = 0; i < urls.length; i++) {
                    this.loadRemoteRes(urls[i], type).then(result => {
                        reource[result[0]] = result[1];
                        if (Object.keys(reource).length == urls.length) {
                            //加载完
                            resp(reource);
                        }
                    });
                }
            }
        })
    }

    /**
     * 释放远程资源
     * @param url 
     */
    public releaseRemoteRes(url: string) {
        let asset: Asset = this._remoteAssetMap.get(url);
        if (!Asset) {
            LogMgr.warn("没有缓存资源释放:" + url);
        }
        assetManager.releaseAsset(asset);
    }
    public async  loadBundleSprite(path: string): Promise<SpriteFrame> {
        if(!path.endsWith("/spriteFrame")){
            path = path+"/spriteFrame"
        }
       return this.loadBundleRes(path,SpriteFrame)
    }
    /**
     * 加载分包资源
     * @param path 相对于分包文件夹的路径 
     * @param path 
     * @returns 
     */
    public async  loadBundleRes(path: string,  type?: any): Promise<any> {
        let index = path.indexOf("/")
        if(index==0){
            LogMgr.err("分包资源路径格式必须为 分包名/资源路径，当前路径为："+path)
            return Promise.resolve(null);
        }
        let name = path.substring(0, index)
        let resPath = path.substring(index+1)
        let bundle: AssetManager.Bundle = this._bundleMap.get(name);
        if (!bundle) {
            await this.loadBundle(name)
            bundle = this._bundleMap.get(name);
            if (!bundle) {
                LogMgr.err("分包:" + name + "加载失败");
                return Promise.resolve(null);
            }
        }
        return new Promise<any>(resp => {
            let result = bundle.get(resPath, type);
            if (result) {
                resp(result);
                return;
            }
            // console.log("loadBundleRes: ", name, url, type);
            bundle.load(resPath, type, (err: any, data: any) => {
                if (!err) {
                    resp(data);
                } else {
                    LogMgr.err("加载" + name + " bundle中资源" + resPath + "错误:" + err);
                    resp(null);
                }
            })
        })
    }




    //#endregin





    /**
     * 非CDN远端图集
     * @param url 
     * @returns 
     */
    private async loadNativeAtlas(url: string): Promise<SpriteAtlas> {
        let imageUrlStr: string = url;
        return new Promise<SpriteAtlas>(resp => {
            if (this._atlasMap.get(imageUrlStr)) {
                resp(this._atlasMap.get(imageUrlStr));
                return;
            }
            this.loadBundleRes(imageUrlStr, SpriteAtlas).then(r => {
                if (r == null) {
                    console.log("加载.plist文件失败");
                    console.log(r);
                    resp(null);
                } else {
                    this._atlasMap.set(imageUrlStr, r[imageUrlStr]);
                    resp(r[imageUrlStr]);
                }
            });
        })
    }

    /**
     * 远程图集
     * @param url 
     * @returns 
     */
    // private async loadRemoteAtlas(url: string): Promise<SpriteAtlas> {
    //     let imageUrlStr: string[] = [];
    //     imageUrlStr.push(baseUrl + ".plist");
    //     imageUrlStr.push(baseUrl + ".png");
    //     return new Promise<SpriteAtlas>(resp => {
    //         if (this._atlasMap.get(url)) {
    //             resp(this._atlasMap.get(baseUrl));
    //             return;
    //         }
    //         this.loadResArr(imageUrlStr, null, bundleType).then(r => {
    //             if (r == null) {
    //                 console.log("加载.plist文件失败");
    //                 console.log(r);
    //                 resp(null);
    //             } else {
    //                 let spAtlas = this.createAtlas(r[imageUrlStr[0]], r[imageUrlStr[1]]);
    //                 this._atlasMap.set(baseUrl, spAtlas);
    //                 resp(spAtlas);
    //             }
    //         });
    //     })
    // }

    private createAtlas(plist: Asset, png: ImageAsset): SpriteAtlas {
        const plistRegex = /[,{}\s]+/;
        const tmpRect = rect();
        const tmpSize = size();
        const texture = new Texture2D(), sa = new SpriteAtlas();
        texture.image = png;
        const asset = plist._nativeAsset, frames = asset.frames, _frames = sa.spriteFrames;
        for (const key in frames) {
            const sf = new SpriteFrame(), frame = frames[key];
            sf.texture = texture;
            let tmp: string[] = frame.textureRect.split(plistRegex, 5);
            sf.rect = tmpRect.set(parseInt(tmp[1]), parseInt(tmp[2]), parseInt(tmp[3]), parseInt(tmp[4]));
            tmp = frame.spriteOffset.split(plistRegex, 3);
            sf.offset = tmpRect.set(parseInt(tmp[1]), parseInt(tmp[2]));
            tmp = frame.spriteSourceSize.split(plistRegex, 3);
            sf.originalSize = tmpSize.set(parseInt(tmp[1]), parseInt(tmp[2]));
            sf.rotated = frame.textureRotated;
            _frames[key.slice(0, -4)] = sf; //key需要去掉后缀.png
        }
        return sa;
    }

    //======================>> 加载resource资源 start <<================================//

    /**
     * 加载本地资源
     * @param url 
     * @returns 
     */
    private async loadLocalRes(url: string, type: any): Promise<any> {
        return new Promise<any>(resp => {
            resources.load(url, (err: Error, data: any) => {
                if (err) {
                    LogMgr.warn("加载失败:" + url);
                    resp([url, null]);
                } else {
                    resp([url, data]);
                }
            })
        })
    }

    /**
     * 加载本地的spine预乘材质球
     * 注:开了aplha通道
     * @returns 
     */
    public loadSpineMaterial(): Promise<Material> {
        return new Promise<Material>(async r => {
            let url: string = 'shader/spineMaterial';
            let info: [string, Material] = await this.loadLocalRes(url, Material);
            r(info[1]);
        })

    }

    //======================>> 加载resource资源 end <<================================//

    /**加载过的animation */
    private _aniMap: Map<string, AnimationClip> = new Map();
    /**
     * 加载prefab
     * @param url 路径
     * @param bundle 
     * @returns 
     */
    // public loadAnima(url: string, bundle: string = EnumBundle.prefabResources): Promise<AnimationClip> {
    //     return new Promise<AnimationClip>(async r => {
    //         if (!url.startsWith('anima/')) url = "anima/" + url;
    //         let _anima: AnimationClip = this._aniMap.get(url);
    //         if (_anima) {
    //             r(_anima)
    //         } else {
    //             let load: [string, AnimationClip] = await this.loadNativeRes(url, AnimationClip, bundle)
    //             _anima = load[1];
    //             if (_anima) {
    //                 this._aniMap.set(load[0], _anima);
    //                 r(_anima);
    //             } else {
    //                 r(null);
    //             }
    //         }
    //     })

    // }

    /**加载过的prefab */
    private _prefabMap: Map<string, Map<string, Prefab>> = new Map();
    /**
     * 加载prefab
     * @param url 路径
     * @param bundle 
     * @returns 
     */
    // public loadPrefab(url: string, bundle: string = EnumBundle.prefabResources, start: boolean = true): Promise<Prefab> {
    //     return new Promise<Prefab>(async r => {
    //         if (start) {
    //             if (!url.startsWith('prefab/')) url = "prefab/" + url;
    //         }
    //         let _map: Map<string, Prefab> = this._prefabMap.get(bundle);
    //         if (!_map) {
    //             _map = new Map();
    //             this._prefabMap.set(bundle, _map);
    //         }
    //         let _prefab: Prefab = _map.get(bundle);
    //         if (_prefab) {
    //             r(_prefab)
    //         } else {
    //             let load: [string, Prefab] = await this.loadNativeRes(url, Prefab, bundle)
    //             _prefab = load[1];
    //             if (_prefab) {
    //                 _map.set(load[0], _prefab);
    //                 r(_prefab);
    //             } else {
    //                 r(null);
    //             }
    //         }
    //     })

    // }

    /**
    * 加载prefab
    * @param url 路径
    * @param bundle 
    * @returns 
    */
    // public loadPrefabAllUrl(url: string, bundle: string = EnumBundle.prefabResources): Promise<Prefab> {
    //     return new Promise<Prefab>(async r => {
    //         let _map: Map<string, Prefab> = this._prefabMap.get(bundle);
    //         if (!_map) {
    //             _map = new Map();
    //             this._prefabMap.set(bundle, _map);
    //         }
    //         let _prefab: Prefab = _map.get(bundle);
    //         if (_prefab) {
    //             r(_prefab)
    //         } else {
    //             let load: [string, Prefab] = await this.loadNativeRes(url, Prefab, bundle)
    //             _prefab = load[1];
    //             if (_prefab) {
    //                 _map.set(load[0], _prefab);
    //                 r(_prefab);
    //             } else {
    //                 r(null);
    //             }
    //         }
    //     })

    // }

    /**
     * 批量加载prefab
     * @param urlArr 
     * @param bundle 
     * @returns 
     */
    // public preLoadPrefabs(urlArr: string[], bundle: string = EnumBundle.prefabResources): Promise<{ [url: string]: Prefab }> {
    //     return new Promise<{ [url: string]: Prefab }>(async r => {
    //         let _map: Map<string, Prefab> = this._prefabMap.get(bundle);
    //         if (!_map) {
    //             _map = new Map();
    //             this._prefabMap.set(bundle, _map);
    //         }
    //         let result = await this._loadNativeResArr(urlArr, Prefab, bundle)
    //         if (result) {
    //             for (let key in result) {
    //                 if (result[key]) {
    //                     _map.set(key, result[key]);
    //                 }
    //             }
    //         }
    //         r(result);
    //     })
    // }

    /**
     * 删除预制体
     * @param bundle 
     */
    public delBundelPrefabs(bundle: string) {
        this._prefabMap.delete(bundle);
    }



    //======================>> 加载remoteResources资源 start <<================================//

    /**已加载过的SkeletonData */
    // private _chapterSpineMap: Map<string, Map<string, sp.SkeletonData>> = new Map();
    // public get chapterSpineMap(): Map<string, Map<string, sp.SkeletonData>> {
    //     return this._chapterSpineMap;
    // }
    /**
     * 加载 章节spine skeleton 过图会删除
     * @param url 
     * @param bundleType
     * @param type 0-默认二进制格式 other-json格式
     * @returns 
     */
    // public loadChapterSpineSkeleton(url: string, bundleType: string = EnumBundle.remoteResources, type: number = 0): Promise<sp.SkeletonData> {
    //     return new Promise<sp.SkeletonData>(async resp => {
    //         let thisObj = this;
    //         let isCdn: boolean = this._isLoadNativeLoad(bundleType)
    //         let mainUrl: string = !isCdn ? "spine/" + url : Global.inst.basePathDir + "spine/" + url;
    //         // MDebug.logDebug("load spine sk : " + mainUrl);
    //         if (!this._chapterSpineMap.get(bundleType)) {
    //             this._chapterSpineMap.set(bundleType, new Map());
    //         }
    //         if (this._chapterSpineMap.get(bundleType).get(url)) {
    //             resp(this._chapterSpineMap.get(bundleType).get(url));
    //             return;
    //         }
    //         if (!isCdn) {
    //             this.loadResArr([mainUrl], sp.SkeletonData, bundleType).then(result => {
    //                 if (result) {
    //                     thisObj._chapterSpineMap.get(bundleType).set(url, result[mainUrl]);
    //                     //加载成功
    //                     resp(result[mainUrl]);
    //                 }
    //             })
    //         } else {
    //             let urlArr: string[] = [];
    //             if (!type) {//默认格式
    //                 urlArr = [mainUrl + ".png", mainUrl + ".skel", mainUrl + ".atlas"]
    //             } else {
    //                 urlArr = [mainUrl + ".png", mainUrl + ".json", mainUrl + ".atlas"]
    //             }
    //             this.loadResArr(urlArr, sp.SkeletonData, bundleType).then(result => {
    //                 if (result) {
    //                     MDebug.logDebug("load spine sk suc : " + mainUrl);
    //                     let asset: sp.SkeletonData = this._createSkeleton(url, mainUrl, result, bundleType, type);
    //                     resp(asset);
    //                 }
    //             })
    //         }
    //     })
    // }

    /**
    * 加载  skeleton 
    * @param url 
    * @param bundleType
    * @param type 0-默认二进制格式 other-json格式
    * @returns 
    */
    // public loadClothSpineSkeleton(url: string, bundleType: string = EnumBundle.remoteResources, type: number = 0): Promise<sp.SkeletonData> {
    //     return new Promise<sp.SkeletonData>(async resp => {
    //         let thisObj = this;
    //         let isCdn: boolean = this._isLoadNativeLoad(bundleType)
    //         let mainUrl: string = !isCdn ? url : Global.inst.basePathDir + url;
    //         // MDebug.logDebug("load spine sk : " + mainUrl);
    //         if (!isCdn) {
    //             this.loadResArr([mainUrl], sp.SkeletonData, bundleType).then(result => {
    //                 if (result) {
    //                     if (!thisObj._spineMap.get(bundleType)) {
    //                         thisObj._spineMap.set(bundleType, new Map());
    //                     }
    //                     thisObj._spineMap.get(bundleType).set(url, result[mainUrl]);
    //                     //加载成功
    //                     resp(result[mainUrl]);
    //                 }
    //             })
    //         } else {
    //             let urlArr: string[] = [];
    //             if (!type) {//默认格式
    //                 urlArr = [mainUrl + ".png", mainUrl + ".skel", mainUrl + ".atlas"]
    //             } else {
    //                 urlArr = [mainUrl + ".png", mainUrl + ".json", mainUrl + ".atlas"]
    //             }
    //             this.loadResArr(urlArr, sp.SkeletonData, bundleType).then(result => {
    //                 if (result) {
    //                     MDebug.logDebug("load spine sk suc : " + mainUrl);
    //                     let asset: sp.SkeletonData = this._createSkeleton(url, mainUrl, result, bundleType, type);
    //                     resp(asset);
    //                 }
    //             })
    //         }
    //     })
    // }

    /**
     * 创建spine骨骼
     * @param url 
     * @param mainUrl 
     * @param result load result
     * @param type 0-默认二进制格式 other-json格式
     * @returns 
     */
    // private _createSkeleton(url: string, mainUrl: string, result: any, bundleType: string, type: number = 0): sp.SkeletonData {
    //     let asset = new sp.SkeletonData();
    //     if (type) {//json格式
    //         if (!result[mainUrl + ".json"]) {
    //             return null;
    //         }
    //         asset.skeletonJson = result[mainUrl + ".json"].json;
    //     } else {//默认二进制格式
    //         if (!result[mainUrl + ".skel"]) {
    //             return null;
    //         }
    //         asset._nativeAsset = result[mainUrl + ".skel"]._buffer;
    //         asset._nativeUrl = result[mainUrl + ".skel"]._nativeUrl;
    //         asset._uuid = mainUrl;//随便设置值
    //     }
    //     if (!result[mainUrl + ".atlas"]) {
    //         return null;
    //     }
    //     asset.atlasText = result[mainUrl + ".atlas"].text;
    //     let texture2d = new Texture2D();
    //     if (!result[mainUrl + ".png"]) {
    //         return null;
    //     }
    //     texture2d.image = result[mainUrl + ".png"];
    //     asset.textures = [texture2d];
    //     let urlInfo: string[] = url.split("/");
    //     let picUrl: string = urlInfo.length > 1 ? urlInfo[1] : urlInfo[0];
    //     asset.textureNames = [picUrl + ".png"];//名字一定要保持一致 不然会报错
    //     //加载成功
    //     if (!this._spineMap.get(bundleType)) {
    //         this._spineMap.set(bundleType, new Map());
    //     }
    //     this._spineMap.get(bundleType).set(url, asset);
    //     return asset
    // }

    /**
     * 预加载spine
     * @param urlArr 
     * @param bundleType 
     * @param type 
     * @returns 
     */
    // public preloadSpine(urlArr: string[], bundleType: string = EnumBundle.remoteResources, type: number = 0): Promise<void> {
    //     return new Promise<void>(r => {
    //         if (!urlArr.length) {
    //             r();
    //             return;
    //         }
    //         let thisObj = this;
    //         let mainUrlArr: string[] = [];
    //         let isCdn: boolean = this._isLoadNativeLoad(bundleType)
    //         for (let url of urlArr) {
    //             mainUrlArr.push(!isCdn ? "spine/" + url : Global.inst.basePathDir + "spine/" + url);
    //         }
    //         let i: number;
    //         let mainUrl: string;
    //         let url: string;
    //         if (!isCdn) {
    //             this.loadResArr(mainUrlArr, sp.SkeletonData, bundleType).then(result => {
    //                 if (result) {
    //                     for (i = 0; i < mainUrlArr.length; i++) {
    //                         mainUrl = mainUrlArr[i];
    //                         url = urlArr[i];
    //                         thisObj._spineMap.set(url, result[mainUrl]);
    //                     }
    //                     //加载成功
    //                     r();
    //                 }
    //             })
    //         } else {
    //             let loadUrlArr: string[] = [];
    //             for (mainUrl of mainUrlArr) {
    //                 if (!type) {//默认格式
    //                     loadUrlArr = [mainUrl + ".png", mainUrl + ".skel", mainUrl + ".atlas"]
    //                 } else {
    //                     loadUrlArr = [mainUrl + ".png", mainUrl + ".json", mainUrl + ".atlas"]
    //                 }
    //             }
    //             this.loadResArr(loadUrlArr, sp.SkeletonData, bundleType).then(result => {
    //                 if (result) {
    //                     for (i = 0; i < mainUrlArr.length; i++) {
    //                         mainUrl = mainUrlArr[i];
    //                         url = urlArr[i];
    //                         this._createSkeleton(url, mainUrl, result, bundleType, type);
    //                     }
    //                     r();
    //                 }
    //             })
    //         }
    //     })
    // }

    /**
     * 获取图片资源
     * @param icon 
     * @returns 
     */
    // public async loadSpriteFrameArr(iconArr: string[], bundleType: string = EnumBundle.remoteResources, type: string = '.png'): Promise<boolean> {
    //     for (let i: number = 0; i < iconArr.length; i++) {
    //         await this.loadSpriteFrame(iconArr[i], bundleType, type);
    //     }
    //     return Promise.resolve(true);
    // }

    /**
     * 获取图片资源
     * @param icon 
     * @returns 
     */
    public loadSpriteFrame(icon: string): Promise<SpriteFrame> {
        return new Promise<SpriteFrame>(resolve => {
            // 远程 url 不带图片后缀名，此时必须指定远程图片文件的类型
            this.loadBundleRes(icon, ImageAsset).then(data => {
                    if (data) {
                        // console.log("data", data);
                        const spriteFrame = new SpriteFrame();
                        const texture = new Texture2D();
                        texture.image = data[icon];
                        spriteFrame.texture = texture;
                        resolve(spriteFrame);
                    } else {
                        resolve(null);
                    }
                })
            }
        )
    }

    /**
     * 图片
     * @param icon 
     * @returns 
     */
    public loadRemoteFrame(icon: string) {
        return new Promise<SpriteFrame>(resolve => {
            this.loadRemoteRes(icon, ImageAsset).then(data => {
                if (data && data[1]) {
                    // console.log("data", data);
                    const spriteFrame = new SpriteFrame();
                    const texture = new Texture2D();
                    texture.image = data[1];
                    spriteFrame.texture = texture;
                    resolve(spriteFrame);
                } else {
                    resolve(null);
                }
            })
        })
    }

    public loadBinary(url: string) {
        assetManager.loadAny(url, (e, data) => {
            if (e) {
                console.error("加载失败：" + url);
                let cfgBuffer = data as BufferAsset
                let ab = cfgBuffer.buffer()
                let dv = new DataView(ab)

                return
            }
        })
    }

    // public loadJsonArr() {
    //     let urls = BundleManager.inst.subResUrls;
    //     let newUrl = [];
    //     if (this._isLoadNativeLoad(EnumBundle.remoteResources)) {
    //         urls.forEach(url => {
    //             newUrl.push(Global.inst.basePathDir + url + ".json");
    //         })
    //     } else {
    //         newUrl = urls;
    //     }
    //     return new Promise<any>(resolve => {
    //         this.loadResArr(newUrl, JsonAsset, EnumBundle.remoteResources).then(data => {
    //             if (data) {
    //                 // console.log("data", data);
    //                 newUrl.forEach((url: string, index: number) => {
    //                     let jsonData = (data[url] as JsonAsset).json;
    //                     this._jsonMap.set(urls[index], jsonData);
    //                 })
    //                 // console.log("_jsonMap", this._jsonMap);
    //                 resolve(true);
    //             } else {
    //                 resolve(false);
    //             }
    //         })
    //     })
    // }

    public loadSound(url: string, bundleType?: string): Promise<AudioClip> {
        return new Promise<AudioClip>(resolve => {
            // let newUrl: string = "";
            // if (this._isLoadNativeLoad(EnumBundle.remoteResources)) {
            //     newUrl = Global.inst.basePathDir + url + ".mp3";
            // } else {
            //     newUrl = url;
            // }
            // this.loadResArr([newUrl], AudioClip, bundleType).then(data => {
            //     if (data) {
            //         resolve(data[newUrl]);
            //     } else {
            //         resolve(null);
            //     }
            // })
        })
    }

    // public loadTxt(url: string, bundleType?: string): Promise<TextAsset> {
    //     return new Promise<TextAsset>(resolve => {
    //         if (this._textMap.has(url)) {
    //             resolve(this._textMap.get(url));
    //             return;
    //         }
    //         let newUrl: string = "";
    //         if (this._isLoadNativeLoad(EnumBundle.remoteResources)) {
    //             newUrl = Global.inst.basePathDir + url + ".txt";
    //         } else {
    //             newUrl = url;
    //         }
    //         this.loadResArr([newUrl], TextAsset, bundleType).then(data => {
    //             if (data) {
    //                 this._textMap.set(url, data[newUrl]);
    //                 resolve(data[newUrl]);
    //             } else {
    //                 resolve(null);
    //             }
    //         })
    //     })
    // }

    public getJosn(url: string) {
        return this._jsonMap.get(url);
    }






    public iconAtlasMap: Map<string, SpriteAtlas> = new Map();
    public getBoardItemSpriteFrame2(itemId: number, icon: string): SpriteFrame {
        let atlasName: string = icon;
        let sa: SpriteAtlas = this.iconAtlasMap.get(atlasName);
        if (sa) {
            return sa.getSpriteFrame(itemId.toString());
        } else {
            return null;
        }
    }
    //======================>> 加载remoteResources资源 end <<================================//


    public getAtlasByName(name: string) {
        return this._atlasMap.get(name);
    }

    public loadNativeAtlasImg(atlasName: string, imgName: string): SpriteFrame {
        let sa: SpriteAtlas = this._atlasMap.get(atlasName);
        if (sa) {
            return sa.getSpriteFrame(imgName);
        }
        return null;
    }

}