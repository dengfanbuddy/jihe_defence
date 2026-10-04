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

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

import type { DshChatSettings } from './settings';

/** 定位结果。`*Source` 说明这个路径是怎么来的，用于面板展示与报错文案。 */
export interface ResolvedRuntime {
    nodeExe: string | null;
    nodeSource: string;
    dshBin: string | null;
    dshSource: string;
}

/** 跑一次 `where`/`which`，拿第一个命中的绝对路径。 */
function which(command: string): string | null {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    try {
        const out = execFileSync(finder, [command], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        const first = out
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)[0];
        return first ?? null;
    } catch {
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
function dshBinFromShim(shimPath: string | null): string | null {
    if (!shimPath) return null;
    const candidate = join(dirname(shimPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    return existsSync(candidate) ? candidate : null;
}

/**
 * 已知的 node 安装位置（兜底用；探测不到 PATH 时按顺序试）。
 *
 * 导出是为了能被 `scripts/verify-cocos-engine.js` 断言 —— 这个模块曾经 0 测试覆盖，
 * 而里面藏着一条**恒为死代码**的兜底（拼了两遍 `nodejs`）。
 */
export function knownNodePaths(): string[] {
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
    out.push(nvmSymlink ? join(nvmSymlink, 'node.exe') : 'C:\\nvm4w\\nodejs\\node.exe');
    return out;
}

/**
 * 定位 node 与 dsh。
 *
 * @param settings - 当前设置（`nodePath` / `dshBin` 是显式覆盖）。
 * @returns 定位结果；某一项为 null 表示没找到（调用方负责给出可操作的报错）。
 */
export function resolveRuntime(settings: DshChatSettings): ResolvedRuntime {
    const out: ResolvedRuntime = { nodeExe: null, nodeSource: '', dshBin: null, dshSource: '' };

    // node：显式设置 → PATH → 已知路径
    if (settings.nodePath && existsSync(settings.nodePath)) {
        out.nodeExe = settings.nodePath;
        out.nodeSource = '设置';
    } else {
        const found = which('node');
        if (found && existsSync(found)) {
            out.nodeExe = found;
            out.nodeSource = 'PATH';
        } else {
            for (const candidate of knownNodePaths()) {
                if (existsSync(candidate)) {
                    out.nodeExe = candidate;
                    out.nodeSource = '已知路径';
                    break;
                }
            }
        }
    }
    if (!out.nodeExe) out.nodeSource = '未找到';

    // dsh：显式设置 → 从 dsh shim 推导 → 从 npm shim 推导
    if (settings.dshBin && existsSync(settings.dshBin)) {
        out.dshBin = settings.dshBin;
        out.dshSource = '设置';
    } else {
        const fromDsh = dshBinFromShim(which('dsh'));
        if (fromDsh) {
            out.dshBin = fromDsh;
            out.dshSource = 'PATH 上的 dsh';
        } else {
            const fromNpm = dshBinFromShim(which('npm'));
            if (fromNpm) {
                out.dshBin = fromNpm;
                out.dshSource = 'PATH 上的 npm';
            }
        }
    }
    if (!out.dshBin) out.dshSource = '未找到';

    return out;
}
