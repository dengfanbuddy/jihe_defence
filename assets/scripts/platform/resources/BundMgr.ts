import { AssetManager, JsonAsset, SpriteFrame, assetManager, error, resources } from "cc";

/**
 * 管理bundle中资源
 */
export class BundleManager {
    private static _inst: BundleManager;
    public static get inst() {
        if (!this._inst) {
            this._inst = new BundleManager();
        }
        return this._inst;
    }

    private _bundleMap: Map<string, AssetManager.Bundle> = new Map();
    /**subPackage分包下资源 */
    private _subResUrls: string[] = [];
    public get subResUrls(): string[] {
        return this._subResUrls;
    }
    public pushSubResourceUrls(urls: string[]): void {
        for (let i = 0; i < urls.length; i++) {
            if (urls[i] != null) {
                if (this._subResUrls.indexOf(urls[i]) == -1) {
                    this._subResUrls.push(urls[i]);
                }
            }
        }
    }


    /**
    * 加载json分包资源
    */
    public loadJsonRes(): Promise<boolean> {
        return new Promise<boolean>(resp => {
            if (this._subResUrls.length == 0) {
                resp(true);
            } else {
                resources.load(this._subResUrls, (err: any, res: JsonAsset[]) => {
                    if (err) {
                        error(err.message || err);
                        return;
                    }
                    // 获取到 Json 数据
                    // const jsonData: object = res.json!;

                })
            }
        })
    }

    /**
     * 加载分包
     * @param name 远程包名字
     * @param isRemote 是否是远程包
     * @param remoteIndex 远程下标
     * @param progressCB 进度
     * @returns 
     */
    public loadSubPkg(name: string, isRemote: boolean = false, progressCB?: (p: number) => void): Promise<void> {

        //remoteBundles里的name和远程包name一致
        // let url: string = isRemote ? assetManager.downloader.remoteBundles[remoteIndex] : name;
        return new Promise<void>((r, e) => {
            var inst = Global.inst.platformInst;
            if (!inst || name == EnumBundle.scripts) {
                r(this.loadSubBundle(name));
                return;
            }
            if (this._bundleMap.get(name)) {
                MDebug.warn("分包资源已经被加载", name);
                r();
                return;
            }
            assetManager.loadBundle(name, (err: any, data: AssetManager.Bundle) => {
                if (!err) {
                    MDebug.log("加载bunble包 suc: " + name);
                    this._bundleMap.set(name, data);
                    if (isRemote) {
                        data.preloadDir("", null, null, () => {
                            MDebug.log("预加载bunble资源完成 suc: " + name);
                        });
                    }
                    r();
                } else {
                    MDebug.logDebug("加载bundle包错误:" + err);
                    e(err);
                }
            });
            // var task = inst.loadSubpackage({
            //     name: url, // name 可以填 name 或者 root
            //     success: (res) => {
            //         this._bundleMap.set(name, res);
            //         r();
            //     },
            //     fail: (res) => {
            //         // 分包加载失败通过 fail 回调
            //         MDebug.error("分包:" + name + '加载失败' + JSON.stringify(res));
            //         e(res);
            //     }
            // });
            // if (progressCB != null) {
            //     task.onProgressUpdate(res => {
            //         progressCB(res.totalBytesWritten / res.totalBytesExpectedToWrite);
            //         // progressCB(res.progress);
            //     })
            // }
        });
    }

    /**
     * 非小游戏分包
     * @param name 
     */
    private loadSubBundle(name: string) {
        return new Promise<void>((r, e) => {
            assetManager.loadBundle(name, (err: any, data: AssetManager.Bundle) => {
                if (!err) {
                    if (name != EnumBundle.scripts) {
                        this._bundleMap.set(name, data);
                    }
                    r();
                } else {
                    MDebug.error('loadBundle error ', err)
                }
            })
        });
    }

    /**
     * 加载分包资源
     * @param name 
     * @param url 
     * @returns 
     */
    public loadBundleRes(name: string, url: string, type?: any): Promise<any> {
        let bundle: AssetManager.Bundle = this._bundleMap.get(name);
        if (!bundle) {
            MDebug.warn("分包:" + name + "不存在");
            return Promise.resolve(null);
        }
        return new Promise<any>(resp => {
            let result = bundle.get(url, type);
            if (result) {
                resp(result);
                return;
            }
            // console.log("loadBundleRes: ", name, url, type);
            bundle.load(url, type, (err: any, data: any) => {
                if (!err) {
                    resp(data);
                } else {
                    MDebug.error("加载" + name + "bundle中资源" + url + "错误:" + err);
                    resp(null);
                }
            })
        })
    }

    /**
     * 批量加载分包资源
     * @param name 
     * @param url 
     * @returns 
     */
    public loadBundleResArr(name: string, urlArr: string[], type?: any): Promise<any> {
        let bundle: AssetManager.Bundle = this._bundleMap.get(name);
        if (!bundle) {
            MDebug.warn("分包:" + name + "不存在");
            return Promise.resolve(null);
        }
        return new Promise<any>(resp => {
            bundle.load(urlArr, type, (err: any, data: any) => {
                if (!err) {
                    resp(data);
                } else {
                    MDebug.error("加载" + name + "bundle中资源错误, ", urlArr);
                    resp(null);
                }
            })
        })
    }

    // /**
    //  * 获取ui中资源
    //  * @param url 
    //  * @returns 
    //  */
    // public getUISpriteFrameByUrl(url: string) {
    //     let bundle: AssetManager.Bundle = this._bundleMap.get(EnumBundle.UIResources);
    //     if (!bundle) {
    //         MDebug.warn("分包:" + EnumBundle.UIResources + "不存在");
    //         Promise.reject(null);
    //     }
    //     return bundle.get(url, SpriteFrame);
    // }

    /**
     * 加载json分包资源
     * @param name 
     * @param url 
     * @returns 
     */
    public getBundleRes(name: string, url: string): any {
        let bundle: AssetManager.Bundle = this._bundleMap.get(name);
        if (!bundle) {
            MDebug.warn("分包:" + name + "不存在");
            return null;
        }
        return bundle.get(url);
    }

    /**
     * 释放bundle中资源
     * @param name 
     * @param url 
     */
    public releaseBundleRes(name: string, url: string) {
        let bundle: AssetManager.Bundle = this._bundleMap.get(name);
        if (!bundle) {
            MDebug.warn("分包:" + name + "不存在");
            return;
        }
        bundle.release(url);
    }

    /**
     * 释放bundle
     * @param name 
     */
    public releaseBundle(name: string) {
        let bundle: AssetManager.Bundle = this._bundleMap.get(name);
        if (!bundle) {
            MDebug.warn("分包:" + name + "不存在");
            return;
        }
        bundle.releaseAll();
    }

    public isLoaded(name: string): boolean {
        return this._bundleMap.has(name);
    }
}