import { _decorator, assetManager, Component, director, Node, UITransform } from 'cc';
import { DataCenter } from '../data';
import { TbRoot } from '../../platform/excel_table/TbRoot';
const { ccclass, property } = _decorator;

@ccclass('Loading')
export class Loading extends Component {


    async onLoad() {
        //加载script脚本bundle
        await this.loadscripts()
        //加载资源等等
        DataCenter.ins.init();
        this.scheduleOnce(() => {
            director.loadScene("Main")
        },0.5)
    }

    loadscripts(){
        return new Promise((resolve,reject)=>{
            assetManager.loadBundle("scripts", (err,data) => {
                if (err) {
                    reject(err)
                    return
                }
                TbRoot.ins.loadTbs().then((data) => {
                    resolve(data)
                }).catch((err) => {
                    reject(err)
                })
            })
        })
    }


    update(deltaTime: number) {
        
    }
}


