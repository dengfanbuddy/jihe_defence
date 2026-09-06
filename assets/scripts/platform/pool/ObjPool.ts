import { LogMgr } from "../log/LogMgr";
import { IRecycle } from "./Recycle";


export default class ObjPool<T> {
    /**类名 */
    private _classObj: any;
    /**对象池 */
    private _objArr: T[];
    /**计数 */
    private _num: number;
    /**创建方法实例 */
    private _creatFuncObj: any;
    /**创建方法 */
    private _creatFunc: Function;
    /**创建参数 */
    private _creatArgs: any[];

    /**
     * 构造函数
     *
     * @param classObj 类对象，需要是一个带有new方法的对象
     * @param creatFuncObj 创建函数对象，可选参数，默认为null
     * @param creatFunc 创建函数，可选参数，默认为null
     * @param creatArgs 创建函数参数数组，可选参数，默认为null
     */
    public constructor(classObj: { new(...args): T; }, creatFuncObj: any = null, creatFunc: Function = null, creatArgs: any[] = null) {
        this._classObj = classObj;
        this._objArr = [];
        this._num = 0;
        this._creatFuncObj = creatFuncObj;
        this._creatFunc = creatFunc;
        this._creatArgs = creatArgs;
    }

    /**
     * 获取对象
     * @param showTip 
     * @returns 
     */
    public getObj(showTip: boolean = false): T {
        if (this._objArr.length > 0) {
            return this._objArr.shift();
        } else {
            this._num++;
            if (this._num % 100 == 0) {
                LogMgr.warn(this._classObj.name, "对象池创建对象数量:", this._num);
            }
            if (this._creatFunc && this._creatArgs) {
                if (this._creatArgs) {
                    return this._creatFunc.apply(this._creatFuncObj, this._creatArgs);
                } else {
                    return this._creatFunc.apply(this._creatFuncObj);
                }
            } else {
                return new this._classObj();
            }
        }
    }
    /**
     * 获取对象
     * @param showTip 
     * @returns Primiose对象 适合异步创建对象的方法
     */
    public async getPromiseObj(): Promise<T> {
        return new Promise<T>(r => {
            if (this._objArr.length > 0) {
                r(this._objArr.shift());
            } else {
                this._num++;
                if (this._num % 100 == 0) {
                    LogMgr.warn(this._classObj.name, "对象池创建对象数量:", this._num);
                }
                if (this._creatFunc) {
                    if (this._creatArgs) {
                        r(this._creatFunc.apply(this._creatFuncObj, this._creatArgs));
                    } else {
                        r(this._creatFunc.apply(this._creatFuncObj));
                    }
                } else {
                    r(new this._classObj());
                }
            }
        })

    }

    /**
     * 将指定类型的对象压入对象池
     *
     * @param obj 要压入对象池的对象
     * @param showTip 是否显示提示信息，默认为false
     * @returns 无返回值
     */
    public recyle(obj: T): void {
        if (!(obj instanceof this._classObj)) {
            LogMgr.err("装入对象池的类型错误:", obj, "--", this._classObj.name);
            return;
        }
        if(this.isRecycle(obj)){
            obj.recycle();
        }
        this._objArr.push(obj);
        if (this._objArr.length % 100 == 0) {
            LogMgr.warn("对象池当前对象数量:", this._objArr.length);
        }
    }

    public clearPool(): void {
        this._objArr = [];
        this._num = 0;
    }

    public isRecycle(obj: any): obj is IRecycle {
        return 'recycle' in obj && typeof obj.recycle === 'function';
      }

}