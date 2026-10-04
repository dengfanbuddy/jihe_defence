"use strict";
/**
 * 运行时定位：找到**能用**的 node 与 dsh CLI。
 *
 * ## 为什么不能想当然
 *
 * - 编辑器主进程自己的 `process.execPath` 是 **CocosCreator.exe**（Electron），
 *   不是 node。拿它去跑 dsh 的 ESM 入口要么失败、要么跑成 Node 20（编辑器内嵌版本），
 *   所以我们一律**另找系统 node**（实测本机是 `C:\nvm4w\nodejs\node.exe`，v24）。
 * - dsh 的入口是 `...\node_modules\@deepseek-ai\dsh\lib\bin.js`，不是 `dsh.cmd`
 *   （`.cmd` 是 npm 的 shim，用 fork 跑它会多一层 shell）。
 * - 全靠猜会脆：所以顺序是 **设置覆盖 → PATH 探测 → 已知候选**，并把「从哪找到的」
 *   一起回传，面板上直接显示，出问题一眼看得见。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveRuntime = resolveRuntime;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path_1 = require("path");
/** 跑一次 `where`/`which`，拿第一个命中的绝对路径。 */
function which(command) {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    try {
        const out = (0, child_process_1.execFileSync)(finder, [command], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        const first = out
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)[0];
        return first !== null && first !== void 0 ? first : null;
    }
    catch {
        return null;
    }
}
/**
 * 从 npm 的全局 bin 目录推导 dsh 的入口文件。
 *
 * npm 把 shim 放在 `<prefix>`（本机是 `D:\MyApplication\nodejs\node_cache`），
 * 真正的包在 `<prefix>\node_modules\@deepseek-ai\dsh\lib\bin.js`。
 *
 * @param shimPath - `where dsh` / `where npm` 拿到的 shim 路径。
 * @returns 入口文件绝对路径，或 null。
 */
function dshBinFromShim(shimPath) {
    if (!shimPath)
        return null;
    const candidate = (0, path_1.join)((0, path_1.dirname)(shimPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    return (0, fs_1.existsSync)(candidate) ? candidate : null;
}
/** 已知的 node 安装位置（兜底用；探测不到 PATH 时按顺序试）。 */
function knownNodePaths() {
    var _a;
    if (process.platform !== 'win32')
        return ['/usr/local/bin/node', '/usr/bin/node'];
    return [
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Program Files (x86)\\nodejs\\node.exe',
        // nvm-for-windows 的默认根
        (0, path_1.join)((_a = process.env.NVM_SYMLINK) !== null && _a !== void 0 ? _a : 'C:\\nvm4w', 'nodejs', 'node.exe'),
    ];
}
/**
 * 定位 node 与 dsh。
 *
 * @param settings - 当前设置（`nodePath` / `dshBin` 是显式覆盖）。
 * @returns 定位结果；某一项为 null 表示没找到（调用方负责给出可操作的报错）。
 */
function resolveRuntime(settings) {
    const out = { nodeExe: null, nodeSource: '', dshBin: null, dshSource: '' };
    // node：显式设置 → PATH → 已知路径
    if (settings.nodePath && (0, fs_1.existsSync)(settings.nodePath)) {
        out.nodeExe = settings.nodePath;
        out.nodeSource = '设置';
    }
    else {
        const found = which('node');
        if (found && (0, fs_1.existsSync)(found)) {
            out.nodeExe = found;
            out.nodeSource = 'PATH';
        }
        else {
            for (const candidate of knownNodePaths()) {
                if ((0, fs_1.existsSync)(candidate)) {
                    out.nodeExe = candidate;
                    out.nodeSource = '已知路径';
                    break;
                }
            }
        }
    }
    if (!out.nodeExe)
        out.nodeSource = '未找到';
    // dsh：显式设置 → 从 dsh shim 推导 → 从 npm shim 推导
    if (settings.dshBin && (0, fs_1.existsSync)(settings.dshBin)) {
        out.dshBin = settings.dshBin;
        out.dshSource = '设置';
    }
    else {
        const fromDsh = dshBinFromShim(which('dsh'));
        if (fromDsh) {
            out.dshBin = fromDsh;
            out.dshSource = 'PATH 上的 dsh';
        }
        else {
            const fromNpm = dshBinFromShim(which('npm'));
            if (fromNpm) {
                out.dshBin = fromNpm;
                out.dshSource = 'PATH 上的 npm';
            }
        }
    }
    if (!out.dshBin)
        out.dshSource = '未找到';
    return out;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2UvcGF0aHMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7R0FZRzs7QUErREgsd0NBNENDO0FBekdELGlEQUE2QztBQUM3QywyQkFBZ0M7QUFDaEMsK0JBQXFDO0FBWXJDLHVDQUF1QztBQUN2QyxTQUFTLEtBQUssQ0FBQyxPQUFlO0lBQzFCLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxRQUFRLEtBQUssT0FBTyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQztJQUNwRSxJQUFJLENBQUM7UUFDRCxNQUFNLEdBQUcsR0FBRyxJQUFBLDRCQUFZLEVBQUMsTUFBTSxFQUFFLENBQUMsT0FBTyxDQUFDLEVBQUUsRUFBRSxRQUFRLEVBQUUsTUFBTSxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7UUFDcEcsTUFBTSxLQUFLLEdBQUcsR0FBRzthQUNaLEtBQUssQ0FBQyxPQUFPLENBQUM7YUFDZCxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQzthQUMxQixNQUFNLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDeEIsT0FBTyxLQUFLLGFBQUwsS0FBSyxjQUFMLEtBQUssR0FBSSxJQUFJLENBQUM7SUFDekIsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLE9BQU8sSUFBSSxDQUFDO0lBQ2hCLENBQUM7QUFDTCxDQUFDO0FBRUQ7Ozs7Ozs7O0dBUUc7QUFDSCxTQUFTLGNBQWMsQ0FBQyxRQUF1QjtJQUMzQyxJQUFJLENBQUMsUUFBUTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQzNCLE1BQU0sU0FBUyxHQUFHLElBQUEsV0FBSSxFQUFDLElBQUEsY0FBTyxFQUFDLFFBQVEsQ0FBQyxFQUFFLGNBQWMs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QUFDLEdBQUcsQ0FBQyxNQUFNO1FBQUUsR0FBRyxDQUFDLFNBQVMsR0FBRyxLQUFLLENBQUM7SUFFdkMsT0FBTyxHQUFHLENBQUM7QUFDZixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDov5DooYzml7blrprkvY3vvJrmib7liLAqKuiDveeUqCoq55qEIG5vZGUg5LiOIGRzaCBDTEnjgIJcbiAqXG4gKiAjIyDkuLrku4DkuYjkuI3og73mg7PlvZPnhLZcbiAqXG4gKiAtIOe8lui+keWZqOS4u+i/m+eoi+iHquW3seeahCBgcHJvY2Vzcy5leGVjUGF0aGAg5pivICoqQ29jb3NDcmVhdG9yLmV4ZSoq77yIRWxlY3Ryb27vvInvvIxcbiAqICAg5LiN5pivIG5vZGXjgILmi7/lroPljrvot5EgZHNoIOeahCBFU00g5YWl5Y+j6KaB5LmI5aSx6LSl44CB6KaB5LmI6LeR5oiQIE5vZGUgMjDvvIjnvJbovpHlmajlhoXltYzniYjmnKzvvInvvIxcbiAqICAg5omA5Lul5oiR5Lus5LiA5b6LKirlj6bmib7ns7vnu58gbm9kZSoq77yI5a6e5rWL5pys5py65pivIGBDOlxcbnZtNHdcXG5vZGVqc1xcbm9kZS5leGVg77yMdjI077yJ44CCXG4gKiAtIGRzaCDnmoTlhaXlj6PmmK8gYC4uLlxcbm9kZV9tb2R1bGVzXFxAZGVlcHNlZWstYWlcXGRzaFxcbGliXFxiaW4uanNg77yM5LiN5pivIGBkc2guY21kYFxuICogICDvvIhgLmNtZGAg5pivIG5wbSDnmoQgc2hpbe+8jOeUqCBmb3JrIOi3keWug+S8muWkmuS4gOWxgiBzaGVsbO+8ieOAglxuICogLSDlhajpnaDnjJzkvJrohIbvvJrmiYDku6Xpobrluo/mmK8gKirorr7nva7opobnm5Yg4oaSIFBBVEgg5o6i5rWLIOKGkiDlt7Lnn6XlgJnpgIkqKu+8jOW5tuaKiuOAjOS7juWTquaJvuWIsOeahOOAjVxuICogICDkuIDotbflm57kvKDvvIzpnaLmnb/kuIrnm7TmjqXmmL7npLrvvIzlh7rpl67popjkuIDnnLznnIvlvpfop4HjgIJcbiAqL1xuXG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tICdjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tICdmcyc7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSAncGF0aCc7XG5cbmltcG9ydCB0eXBlIHsgRHNoQ2hhdFNldHRpbmdzIH0gZnJvbSAnLi9zZXR0aW5ncyc7XG5cbi8qKiDlrprkvY3nu5PmnpzjgIJgKlNvdXJjZWAg6K+05piO6L+Z5Liq6Lev5b6E5piv5oCO5LmI5p2l55qE77yM55So5LqO6Z2i5p2/5bGV56S65LiO5oql6ZSZ5paH5qGI44CCICovXG5leHBvcnQgaW50ZXJmYWNlIFJlc29sdmVkUnVudGltZSB7XG4gICAgbm9kZUV4ZTogc3RyaW5nIHwgbnVsbDtcbiAgICBub2RlU291cmNlOiBzdHJpbmc7XG4gICAgZHNoQmluOiBzdHJpbmcgfCBudWxsO1xuICAgIGRzaFNvdXJjZTogc3RyaW5nO1xufVxuXG4vKiog6LeR5LiA5qyhIGB3aGVyZWAvYHdoaWNoYO+8jOaLv+esrOS4gOS4quWRveS4reeahOe7neWvuei3r+W+hOOAgiAqL1xuZnVuY3Rpb24gd2hpY2goY29tbWFuZDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgY29uc3QgZmluZGVyID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ3dpbjMyJyA/ICd3aGVyZS5leGUnIDogJ3doaWNoJztcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoZmluZGVyLCBbY29tbWFuZF0sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNTAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XG4gICAgICAgIGNvbnN0IGZpcnN0ID0gb3V0XG4gICAgICAgICAgICAuc3BsaXQoL1xccj9cXG4vKVxuICAgICAgICAgICAgLm1hcCgobGluZSkgPT4gbGluZS50cmltKCkpXG4gICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pWzBdO1xuICAgICAgICByZXR1cm4gZmlyc3QgPz8gbnVsbDtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxufVxuXG4vKipcbiAqIOS7jiBucG0g55qE5YWo5bGAIGJpbiDnm67lvZXmjqjlr7wgZHNoIOeahOWFpeWPo+aWh+S7tuOAglxuICpcbiAqIG5wbSDmioogc2hpbSDmlL7lnKggYDxwcmVmaXg+YO+8iOacrOacuuaYryBgRDpcXE15QXBwbGljYXRpb25cXG5vZGVqc1xcbm9kZV9jYWNoZWDvvInvvIxcbiAqIOecn+ato+eahOWMheWcqCBgPHByZWZpeD5cXG5vZGVfbW9kdWxlc1xcQGRlZXBzZWVrLWFpXFxkc2hcXGxpYlxcYmluLmpzYOOAglxuICpcbiAqIEBwYXJhbSBzaGltUGF0aCAtIGB3aGVyZSBkc2hgIC8gYHdoZXJlIG5wbWAg5ou/5Yiw55qEIHNoaW0g6Lev5b6E44CCXG4gKiBAcmV0dXJucyDlhaXlj6Pmlofku7bnu53lr7not6/lvoTvvIzmiJYgbnVsbOOAglxuICovXG5mdW5jdGlvbiBkc2hCaW5Gcm9tU2hpbShzaGltUGF0aDogc3RyaW5nIHwgbnVsbCk6IHN0cmluZyB8IG51bGwge1xuICAgIGlmICghc2hpbVBhdGgpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGNhbmRpZGF0ZSA9IGpvaW4oZGlybmFtZShzaGltUGF0aCksICdub2RlX21vZHVsZXMnLCAnQGRlZXBzZWVrLWFpJywgJ2RzaCcsICdsaWInLCAnYmluLmpzJyk7XG4gICAgcmV0dXJuIGV4aXN0c1N5bmMoY2FuZGlkYXRlKSA/IGNhbmRpZGF0ZSA6IG51bGw7XG59XG5cbi8qKiDlt7Lnn6XnmoQgbm9kZSDlronoo4XkvY3nva7vvIjlhZzlupXnlKjvvJvmjqLmtYvkuI3liLAgUEFUSCDml7bmjInpobrluo/or5XvvInjgIIgKi9cbmZ1bmN0aW9uIGtub3duTm9kZVBhdGhzKCk6IHN0cmluZ1tdIHtcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ3dpbjMyJykgcmV0dXJuIFsnL3Vzci9sb2NhbC9iaW4vbm9kZScsICcvdXNyL2Jpbi9ub2RlJ107XG4gICAgcmV0dXJuIFtcbiAgICAgICAgJ0M6XFxcXFByb2dyYW0gRmlsZXNcXFxcbm9kZWpzXFxcXG5vZGUuZXhlJyxcbiAgICAgICAgJ0M6XFxcXFByb2dyYW0gRmlsZXMgKHg4NilcXFxcbm9kZWpzXFxcXG5vZGUuZXhlJyxcbiAgICAgICAgLy8gbnZtLWZvci13aW5kb3dzIOeahOm7mOiupOaguVxuICAgICAgICBqb2luKHByb2Nlc3MuZW52Lk5WTV9TWU1MSU5LID8/ICdDOlxcXFxudm00dycsICdub2RlanMnLCAnbm9kZS5leGUnKSxcbiAgICBdO1xufVxuXG4vKipcbiAqIOWumuS9jSBub2RlIOS4jiBkc2jjgIJcbiAqXG4gKiBAcGFyYW0gc2V0dGluZ3MgLSDlvZPliY3orr7nva7vvIhgbm9kZVBhdGhgIC8gYGRzaEJpbmAg5piv5pi+5byP6KaG55uW77yJ44CCXG4gKiBAcmV0dXJucyDlrprkvY3nu5PmnpzvvJvmn5DkuIDpobnkuLogbnVsbCDooajnpLrmsqHmib7liLDvvIjosIPnlKjmlrnotJ/otKPnu5nlh7rlj6/mk43kvZznmoTmiqXplJnvvInjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVSdW50aW1lKHNldHRpbmdzOiBEc2hDaGF0U2V0dGluZ3MpOiBSZXNvbHZlZFJ1bnRpbWUge1xuICAgIGNvbnN0IG91dDogUmVzb2x2ZWRSdW50aW1lID0geyBub2RlRXhlOiBudWxsLCBub2RlU291cmNlOiAnJywgZHNoQmluOiBudWxsLCBkc2hTb3VyY2U6ICcnIH07XG5cbiAgICAvLyBub2Rl77ya5pi+5byP6K6+572uIOKGkiBQQVRIIOKGkiDlt7Lnn6Xot6/lvoRcbiAgICBpZiAoc2V0dGluZ3Mubm9kZVBhdGggJiYgZXhpc3RzU3luYyhzZXR0aW5ncy5ub2RlUGF0aCkpIHtcbiAgICAgICAgb3V0Lm5vZGVFeGUgPSBzZXR0aW5ncy5ub2RlUGF0aDtcbiAgICAgICAgb3V0Lm5vZGVTb3VyY2UgPSAn6K6+572uJztcbiAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBmb3VuZCA9IHdoaWNoKCdub2RlJyk7XG4gICAgICAgIGlmIChmb3VuZCAmJiBleGlzdHNTeW5jKGZvdW5kKSkge1xuICAgICAgICAgICAgb3V0Lm5vZGVFeGUgPSBmb3VuZDtcbiAgICAgICAgICAgIG91dC5ub2RlU291cmNlID0gJ1BBVEgnO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2Yga25vd25Ob2RlUGF0aHMoKSkge1xuICAgICAgICAgICAgICAgIGlmIChleGlzdHNTeW5jKGNhbmRpZGF0ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgb3V0Lm5vZGVFeGUgPSBjYW5kaWRhdGU7XG4gICAgICAgICAgICAgICAgICAgIG91dC5ub2RlU291cmNlID0gJ+W3suefpei3r+W+hCc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAoIW91dC5ub2RlRXhlKSBvdXQubm9kZVNvdXJjZSA9ICfmnKrmib7liLAnO1xuXG4gICAgLy8gZHNo77ya5pi+5byP6K6+572uIOKGkiDku44gZHNoIHNoaW0g5o6o5a+8IOKGkiDku44gbnBtIHNoaW0g5o6o5a+8XG4gICAgaWYgKHNldHRpbmdzLmRzaEJpbiAmJiBleGlzdHNTeW5jKHNldHRpbmdzLmRzaEJpbikpIHtcbiAgICAgICAgb3V0LmRzaEJpbiA9IHNldHRpbmdzLmRzaEJpbjtcbiAgICAgICAgb3V0LmRzaFNvdXJjZSA9ICforr7nva4nO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IGZyb21Ec2ggPSBkc2hCaW5Gcm9tU2hpbSh3aGljaCgnZHNoJykpO1xuICAgICAgICBpZiAoZnJvbURzaCkge1xuICAgICAgICAgICAgb3V0LmRzaEJpbiA9IGZyb21Ec2g7XG4gICAgICAgICAgICBvdXQuZHNoU291cmNlID0gJ1BBVEgg5LiK55qEIGRzaCc7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zdCBmcm9tTnBtID0gZHNoQmluRnJvbVNoaW0od2hpY2goJ25wbScpKTtcbiAgICAgICAgICAgIGlmIChmcm9tTnBtKSB7XG4gICAgICAgICAgICAgICAgb3V0LmRzaEJpbiA9IGZyb21OcG07XG4gICAgICAgICAgICAgICAgb3V0LmRzaFNvdXJjZSA9ICdQQVRIIOS4iueahCBucG0nO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuICAgIGlmICghb3V0LmRzaEJpbikgb3V0LmRzaFNvdXJjZSA9ICfmnKrmib7liLAnO1xuXG4gICAgcmV0dXJuIG91dDtcbn1cbiJdfQ==