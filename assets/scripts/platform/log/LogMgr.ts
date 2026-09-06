

export enum logLevel{
    Debug = 1,
    Info = 2,
    Warning = 3,
    Error = 4
}
/**

 * 日志管理类，用于统一日志输出格式

 */
export class LogMgr {

    public static logLevel:number = logLevel.Info;
    public static logOpen:boolean = true;


    /**

     * 用于输出调试信息

     */
    public static get debug() {
        if(!LogMgr.logOpen || LogMgr.logLevel>logLevel.Debug){
            return this.nullLog;
        }else{
            return window.console.log.bind(window.console, `%c【Debug】${this.getDateString()}`, 'color: white; background-color: #007BFF; font-weight: bold; font-size: 14px;');
        }
    }

    /**

     * 用于输出一般信息

     */

    public static get info() {
        if(!LogMgr.logOpen || LogMgr.logLevel>logLevel.Info){
            return this.nullLog;
        }else{
            return window.console.log.bind(window.console, `%c【Info】${this.getDateString()}`, 'color: white; background-color: #28A745; font-weight: bold; font-size: 14px;');
        }
    }

    /**

     * 用于输出警告信息

     */

    public static get warn() {
        if(!LogMgr.logOpen || LogMgr.logLevel>logLevel.Warning){
            return this.nullLog;
        }else{
            return window.console.log.bind(window.console, `%c【Warning】${this.getDateString()}`, 'color: black; background-color: #FFC107; font-weight: bold; font-size: 14px;');
        }
    
    }

    /**

     * 用于输出错误信息

     */

    public static get err() {
        return window.console.log.bind(window.console, `%c【Error】${this.getDateString()}`, 'color: white; background-color: #DC3545; font-weight: bold; font-size: 14px;');
    }


    private static nullLog(...args:any){

    }
    private static getDateString(): string {
        let d = new Date();
        let timeStr = "";
        let str = String(d.getFullYear());
        timeStr += str + "-";
        str = String(d.getMonth());
        timeStr += str + "-";
        str = String(d.getDay());
        timeStr += str + " ";
        str = String(d.getHours());
        timeStr += (str.length==1? "0"+str : str) + ":";
        str = String(d.getMinutes());
        timeStr += (str.length==1? "0"+str : str) + ":";
        str = String(d.getSeconds());
        timeStr += (str.length==1? "0"+str : str) + "-";
        str = String(d.getMilliseconds());
        if(str.length==1){
            timeStr += "0"+str;
        }else if(str.length==2){
            timeStr += "00"+str;
        }else{
            timeStr += str;
        }

        timeStr = "[" + timeStr + "]";
        return timeStr;
    }

}