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
exports.knownNodePaths = knownNodePaths;
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
/**
 * 已知的 node 安装位置（兜底用；探测不到 PATH 时按顺序试）。
 *
 * 导出是为了能被 `scripts/verify-cocos-engine.js` 断言 —— 这个模块曾经 0 测试覆盖，
 * 而里面藏着一条**恒为死代码**的兜底（拼了两遍 `nodejs`）。
 */
function knownNodePaths() {
    if (process.platform !== 'win32') {
        // 覆盖 Linux 与 macOS（含 Apple Silicon 的 Homebrew 前缀）
        return ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node'];
    }
    const out = [
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Program Files (x86)\\nodejs\\node.exe',
    ];
    // nvm-for-windows：`NVM_SYMLINK` **本身就已经是那个 nodejs 目录**（实测本机是 `C:\nvm4w\nodejs`），
    // 所以不能再往下拼一层 `nodejs`。之前拼了，于是这条兜底恒为死代码
    // （`…\nodejs\nodejs\node.exe` 不存在）—— 表现为"PATH 探测失败后仍然找不到 node"。
    const nvmSymlink = process.env.NVM_SYMLINK;
    out.push(nvmSymlink ? (0, path_1.join)(nvmSymlink, 'node.exe') : 'C:\\nvm4w\\nodejs\\node.exe');
    return out;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2UvcGF0aHMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7R0FZRzs7QUFvREgsd0NBZUM7QUFRRCx3Q0E0Q0M7QUFySEQsaURBQTZDO0FBQzdDLDJCQUFnQztBQUNoQywrQkFBcUM7QUFZckMsdUNBQXVDO0FBQ3ZDLFNBQVMsS0FBSyxDQUFDLE9BQWU7SUFDMUIsTUFBTSxNQUFNLEdBQUcsT0FBTyxDQUFDLFFBQVEsS0FBSyxPQUFPLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDO0lBQ3BFLElBQUksQ0FBQztRQUNELE1BQU0sR0FBRyxHQUFHLElBQUEsNEJBQVksRUFBQyxNQUFNLEVBQUUsQ0FBQyxPQUFPLENBQUMsRUFBRSxFQUFFLFFBQVEsRUFBRSxNQUFNLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztRQUNwRyxNQUFNLEtBQUssR0FBRyxHQUFHO2FBQ1osS0FBSyxDQUFDLE9BQU8sQ0FBQzthQUNkLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO2FBQzFCLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUN4QixPQUFPLEtBQUssYUFBTCxLQUFLLGNBQUwsS0FBSyxHQUFJLElBQUksQ0FBQztJQUN6QixDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ0wsT0FBTyxJQUFJLENBQUM7SUFDaEIsQ0FBQztBQUNMLENBQUM7QUFFRDs7Ozs7Ozs7R0FRRztBQUNILFNBQVMsY0FBYyxDQUFDLFFBQXVCO0lBQzNDLElBQUksQ0FBQyxRQUFRO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDM0IsTUFBTSxTQUFTLEdBQUcsSUFBQSxXQUFJLEVBQUMsSUFBQSxjQUFPLEVBQUMsUUFBUSxDQUFD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T0FBTyxHQUFHLGNBQWMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztZQUM3QyxJQUFJLE9BQU8sRUFBRSxDQUFDO2dCQUNWLEdBQUcsQ0FBQyxNQUFNLEdBQUcsT0FBTyxDQUFDO2dCQUNyQixHQUFHLENBQUMsU0FBUyxHQUFHLGFBQWEsQ0FBQztZQUNsQyxDQUFDO1FBQ0wsQ0FBQztJQUNMLENBQUM7SUFDRCxJQUFJLENBQUMsR0FBRyxDQUFDLE1BQU07UUFBRSxHQUFHLENBQUMsU0FBUyxHQUFHLEtBQUssQ0FBQztJQUV2QyxPQUFPLEdBQUcsQ0FBQztBQUNmLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIOi/kOihjOaXtuWumuS9je+8muaJvuWIsCoq6IO955SoKirnmoQgbm9kZSDkuI4gZHNoIENMSeOAglxuICpcbiAqICMjIOS4uuS7gOS5iOS4jeiDveaDs+W9k+eEtlxuICpcbiAqIC0g57yW6L6R5Zmo5Li76L+b56iL6Ieq5bex55qEIGBwcm9jZXNzLmV4ZWNQYXRoYCDmmK8gKipDb2Nvc0NyZWF0b3IuZXhlKirvvIhFbGVjdHJvbu+8ie+8jFxuICogICDkuI3mmK8gbm9kZeOAguaLv+Wug+WOu+i3kSBkc2gg55qEIEVTTSDlhaXlj6PopoHkuYjlpLHotKXjgIHopoHkuYjot5HmiJAgTm9kZSAyMO+8iOe8lui+keWZqOWGheW1jOeJiOacrO+8ie+8jFxuICogICDmiYDku6XmiJHku6zkuIDlvosqKuWPpuaJvuezu+e7nyBub2RlKirvvIjlrp7mtYvmnKzmnLrmmK8gYEM6XFxudm00d1xcbm9kZWpzXFxub2RlLmV4ZWDvvIx2MjTvvInjgIJcbiAqIC0gZHNoIOeahOWFpeWPo+aYryBgLi4uXFxub2RlX21vZHVsZXNcXEBkZWVwc2Vlay1haVxcZHNoXFxsaWJcXGJpbi5qc2DvvIzkuI3mmK8gYGRzaC5jbWRgXG4gKiAgIO+8iGAuY21kYCDmmK8gbnBtIOeahCBzaGlt77yM55SoIGZvcmsg6LeR5a6D5Lya5aSa5LiA5bGCIHNoZWxs77yJ44CCXG4gKiAtIOWFqOmdoOeMnOS8muiEhu+8muaJgOS7pemhuuW6j+aYryAqKuiuvue9ruimhuebliDihpIgUEFUSCDmjqLmtYsg4oaSIOW3suefpeWAmemAiSoq77yM5bm25oqK44CM5LuO5ZOq5om+5Yiw55qE44CNXG4gKiAgIOS4gOi1t+WbnuS8oO+8jOmdouadv+S4iuebtOaOpeaYvuekuu+8jOWHuumXrumimOS4gOecvOeci+W+l+ingeOAglxuICovXG5cbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gJ2ZzJztcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tICdwYXRoJztcblxuaW1wb3J0IHR5cGUgeyBEc2hDaGF0U2V0dGluZ3MgfSBmcm9tICcuL3NldHRpbmdzJztcblxuLyoqIOWumuS9jee7k+aenOOAgmAqU291cmNlYCDor7TmmI7ov5nkuKrot6/lvoTmmK/mgI7kuYjmnaXnmoTvvIznlKjkuo7pnaLmnb/lsZXnpLrkuI7miqXplJnmlofmoYjjgIIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVzb2x2ZWRSdW50aW1lIHtcbiAgICBub2RlRXhlOiBzdHJpbmcgfCBudWxsO1xuICAgIG5vZGVTb3VyY2U6IHN0cmluZztcbiAgICBkc2hCaW46IHN0cmluZyB8IG51bGw7XG4gICAgZHNoU291cmNlOiBzdHJpbmc7XG59XG5cbi8qKiDot5HkuIDmrKEgYHdoZXJlYC9gd2hpY2hg77yM5ou/56ys5LiA5Liq5ZG95Lit55qE57ud5a+56Lev5b6E44CCICovXG5mdW5jdGlvbiB3aGljaChjb21tYW5kOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgICBjb25zdCBmaW5kZXIgPSBwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInID8gJ3doZXJlLmV4ZScgOiAnd2hpY2gnO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG91dCA9IGV4ZWNGaWxlU3luYyhmaW5kZXIsIFtjb21tYW5kXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA1MDAwLCB3aW5kb3dzSGlkZTogdHJ1ZSB9KTtcbiAgICAgICAgY29uc3QgZmlyc3QgPSBvdXRcbiAgICAgICAgICAgIC5zcGxpdCgvXFxyP1xcbi8pXG4gICAgICAgICAgICAubWFwKChsaW5lKSA9PiBsaW5lLnRyaW0oKSlcbiAgICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbilbMF07XG4gICAgICAgIHJldHVybiBmaXJzdCA/PyBudWxsO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG59XG5cbi8qKlxuICog5LuOIG5wbSDnmoTlhajlsYAgYmluIOebruW9leaOqOWvvCBkc2gg55qE5YWl5Y+j5paH5Lu244CCXG4gKlxuICogbnBtIOaKiiBzaGltIOaUvuWcqCBgPHByZWZpeD5g77yI5pys5py65pivIGBEOlxcTXlBcHBsaWNhdGlvblxcbm9kZWpzXFxub2RlX2NhY2hlYO+8ie+8jFxuICog55yf5q2j55qE5YyF5ZyoIGA8cHJlZml4Plxcbm9kZV9tb2R1bGVzXFxAZGVlcHNlZWstYWlcXGRzaFxcbGliXFxiaW4uanNg44CCXG4gKlxuICogQHBhcmFtIHNoaW1QYXRoIC0gYHdoZXJlIGRzaGAgLyBgd2hlcmUgbnBtYCDmi7/liLDnmoQgc2hpbSDot6/lvoTjgIJcbiAqIEByZXR1cm5zIOWFpeWPo+aWh+S7tue7neWvuei3r+W+hO+8jOaIliBudWxs44CCXG4gKi9cbmZ1bmN0aW9uIGRzaEJpbkZyb21TaGltKHNoaW1QYXRoOiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgaWYgKCFzaGltUGF0aCkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgY2FuZGlkYXRlID0gam9pbihkaXJuYW1lKHNoaW1QYXRoKSwgJ25vZGVfbW9kdWxlcycsICdAZGVlcHNlZWstYWknLCAnZHNoJywgJ2xpYicsICdiaW4uanMnKTtcbiAgICByZXR1cm4gZXhpc3RzU3luYyhjYW5kaWRhdGUpID8gY2FuZGlkYXRlIDogbnVsbDtcbn1cblxuLyoqXG4gKiDlt7Lnn6XnmoQgbm9kZSDlronoo4XkvY3nva7vvIjlhZzlupXnlKjvvJvmjqLmtYvkuI3liLAgUEFUSCDml7bmjInpobrluo/or5XvvInjgIJcbiAqXG4gKiDlr7zlh7rmmK/kuLrkuobog73ooqsgYHNjcmlwdHMvdmVyaWZ5LWNvY29zLWVuZ2luZS5qc2Ag5pat6KiAIOKAlOKAlCDov5nkuKrmqKHlnZfmm77nu48gMCDmtYvor5Xopobnm5bvvIxcbiAqIOiAjOmHjOmdouiXj+edgOS4gOadoSoq5oGS5Li65q275Luj56CBKirnmoTlhZzlupXvvIjmi7zkuobkuKTpgY0gYG5vZGVqc2DvvInjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGtub3duTm9kZVBhdGhzKCk6IHN0cmluZ1tdIHtcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ3dpbjMyJykge1xuICAgICAgICAvLyDopobnm5YgTGludXgg5LiOIG1hY09T77yI5ZCrIEFwcGxlIFNpbGljb24g55qEIEhvbWVicmV3IOWJjee8gO+8iVxuICAgICAgICByZXR1cm4gWycvdXNyL2xvY2FsL2Jpbi9ub2RlJywgJy91c3IvYmluL25vZGUnLCAnL29wdC9ob21lYnJldy9iaW4vbm9kZSddO1xuICAgIH1cbiAgICBjb25zdCBvdXQgPSBbXG4gICAgICAgICdDOlxcXFxQcm9ncmFtIEZpbGVzXFxcXG5vZGVqc1xcXFxub2RlLmV4ZScsXG4gICAgICAgICdDOlxcXFxQcm9ncmFtIEZpbGVzICh4ODYpXFxcXG5vZGVqc1xcXFxub2RlLmV4ZScsXG4gICAgXTtcbiAgICAvLyBudm0tZm9yLXdpbmRvd3PvvJpgTlZNX1NZTUxJTktgICoq5pys6Lqr5bCx5bey57uP5piv6YKj5LiqIG5vZGVqcyDnm67lvZUqKu+8iOWunua1i+acrOacuuaYryBgQzpcXG52bTR3XFxub2RlanNg77yJ77yMXG4gICAgLy8g5omA5Lul5LiN6IO95YaN5b6A5LiL5ou85LiA5bGCIGBub2RlanNg44CC5LmL5YmN5ou85LqG77yM5LqO5piv6L+Z5p2h5YWc5bqV5oGS5Li65q275Luj56CBXG4gICAgLy8g77yIYOKAplxcbm9kZWpzXFxub2RlanNcXG5vZGUuZXhlYCDkuI3lrZjlnKjvvInigJTigJQg6KGo546w5Li6XCJQQVRIIOaOoua1i+Wksei0peWQjuS7jeeEtuaJvuS4jeWIsCBub2RlXCLjgIJcbiAgICBjb25zdCBudm1TeW1saW5rID0gcHJvY2Vzcy5lbnYuTlZNX1NZTUxJTks7XG4gICAgb3V0LnB1c2gobnZtU3ltbGluayA/IGpvaW4obnZtU3ltbGluaywgJ25vZGUuZXhlJykgOiAnQzpcXFxcbnZtNHdcXFxcbm9kZWpzXFxcXG5vZGUuZXhlJyk7XG4gICAgcmV0dXJuIG91dDtcbn1cblxuLyoqXG4gKiDlrprkvY0gbm9kZSDkuI4gZHNo44CCXG4gKlxuICogQHBhcmFtIHNldHRpbmdzIC0g5b2T5YmN6K6+572u77yIYG5vZGVQYXRoYCAvIGBkc2hCaW5gIOaYr+aYvuW8j+imhueblu+8ieOAglxuICogQHJldHVybnMg5a6a5L2N57uT5p6c77yb5p+Q5LiA6aG55Li6IG51bGwg6KGo56S65rKh5om+5Yiw77yI6LCD55So5pa56LSf6LSj57uZ5Ye65Y+v5pON5L2c55qE5oql6ZSZ77yJ44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlUnVudGltZShzZXR0aW5nczogRHNoQ2hhdFNldHRpbmdzKTogUmVzb2x2ZWRSdW50aW1lIHtcbiAgICBjb25zdCBvdXQ6IFJlc29sdmVkUnVudGltZSA9IHsgbm9kZUV4ZTogbnVsbCwgbm9kZVNvdXJjZTogJycsIGRzaEJpbjogbnVsbCwgZHNoU291cmNlOiAnJyB9O1xuXG4gICAgLy8gbm9kZe+8muaYvuW8j+iuvue9riDihpIgUEFUSCDihpIg5bey55+l6Lev5b6EXG4gICAgaWYgKHNldHRpbmdzLm5vZGVQYXRoICYmIGV4aXN0c1N5bmMoc2V0dGluZ3Mubm9kZVBhdGgpKSB7XG4gICAgICAgIG91dC5ub2RlRXhlID0gc2V0dGluZ3Mubm9kZVBhdGg7XG4gICAgICAgIG91dC5ub2RlU291cmNlID0gJ+iuvue9ric7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgZm91bmQgPSB3aGljaCgnbm9kZScpO1xuICAgICAgICBpZiAoZm91bmQgJiYgZXhpc3RzU3luYyhmb3VuZCkpIHtcbiAgICAgICAgICAgIG91dC5ub2RlRXhlID0gZm91bmQ7XG4gICAgICAgICAgICBvdXQubm9kZVNvdXJjZSA9ICdQQVRIJztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGtub3duTm9kZVBhdGhzKCkpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXhpc3RzU3luYyhjYW5kaWRhdGUpKSB7XG4gICAgICAgICAgICAgICAgICAgIG91dC5ub2RlRXhlID0gY2FuZGlkYXRlO1xuICAgICAgICAgICAgICAgICAgICBvdXQubm9kZVNvdXJjZSA9ICflt7Lnn6Xot6/lvoQnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG4gICAgaWYgKCFvdXQubm9kZUV4ZSkgb3V0Lm5vZGVTb3VyY2UgPSAn5pyq5om+5YiwJztcblxuICAgIC8vIGRzaO+8muaYvuW8j+iuvue9riDihpIg5LuOIGRzaCBzaGltIOaOqOWvvCDihpIg5LuOIG5wbSBzaGltIOaOqOWvvFxuICAgIGlmIChzZXR0aW5ncy5kc2hCaW4gJiYgZXhpc3RzU3luYyhzZXR0aW5ncy5kc2hCaW4pKSB7XG4gICAgICAgIG91dC5kc2hCaW4gPSBzZXR0aW5ncy5kc2hCaW47XG4gICAgICAgIG91dC5kc2hTb3VyY2UgPSAn6K6+572uJztcbiAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBmcm9tRHNoID0gZHNoQmluRnJvbVNoaW0od2hpY2goJ2RzaCcpKTtcbiAgICAgICAgaWYgKGZyb21Ec2gpIHtcbiAgICAgICAgICAgIG91dC5kc2hCaW4gPSBmcm9tRHNoO1xuICAgICAgICAgICAgb3V0LmRzaFNvdXJjZSA9ICdQQVRIIOS4iueahCBkc2gnO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgZnJvbU5wbSA9IGRzaEJpbkZyb21TaGltKHdoaWNoKCducG0nKSk7XG4gICAgICAgICAgICBpZiAoZnJvbU5wbSkge1xuICAgICAgICAgICAgICAgIG91dC5kc2hCaW4gPSBmcm9tTnBtO1xuICAgICAgICAgICAgICAgIG91dC5kc2hTb3VyY2UgPSAnUEFUSCDkuIrnmoQgbnBtJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAoIW91dC5kc2hCaW4pIG91dC5kc2hTb3VyY2UgPSAn5pyq5om+5YiwJztcblxuICAgIHJldHVybiBvdXQ7XG59XG4iXX0=