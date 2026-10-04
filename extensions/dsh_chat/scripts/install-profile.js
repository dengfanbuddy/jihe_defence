/**
 * 把 `dsh-profile/` **幂等地**装进 `$DSH_HOME/profiles/cocos/`。
 *
 * ## 为什么是 `.js`（CommonJS）而不是 `.mjs`
 *
 * **踩过的坑**：本文件原来是 ESM `.mjs`，扩展主进程用 `await import()` 加载它。
 * 但扩展是按 `module: CommonJS` 编译的，而 **TypeScript 会把 `import()` 降级成 `require()`** ——
 * 于是运行时拿着一个 `file:///...` 的 URL 去 require，报
 * `Cannot find module 'file:///D:/.../install-profile.mjs'`。因为外面有 try/catch，
 * 这个错误只变成一行 warning 被吞掉了（症状是「profile 一直没同步，但没人知道」）。
 * 改成 CJS 之后 `require()` 是原生语义，链路最直。
 *
 * ## 为什么要这个脚本，而不是让用户手工建 profile
 *
 * - **profile 目录在工程之外**（`%USERPROFILE%\.dsh\profiles\cocos`），不能进 git；工程里这份
 *   `dsh-profile/` 才是**可评审、可版本化的真源**，装完只是它的投影。
 * - **必须幂等**：编辑器每次加载扩展都会调它。所以「内容不同才写盘」，并回报一份 changed 清单。
 * - **完全离线**：不走 pnpm、不碰 registry。bundles（dsh-base / dsh-sdk-app）在
 *   `$DSH_HOME/profiles/node_modules` 里已经有了（DSH 安装时就位好的共享依赖），
 *   我们自己的插件直接拷成 `profiles/cocos/node_modules/dsh-cocos-bridge/` ——
 *   这正是 pnpm 会摆放的位置，Loader 从配置目录按 Node 规则就能解析到。
 *
 * 由扩展主进程 `require()` 调用，也可以手工跑：
 *
 * ```sh
 * node extensions/dsh_chat/scripts/install-profile.js
 * ```
 *
 * @module dsh_chat/install-profile
 */

'use strict';

const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join, relative, resolve } = require('node:path');

/** profile 名。`dsh --profile cocos` 就是它。 */
const PROFILE_NAME = 'cocos';

/** 与 `dsh-profile/` 的内容绑定；改了 profile 就抬这个号，方便一眼看出装的是哪版。 */
const PROFILE_VERSION = '0.2.0';

/** 我们**拥有**的 profile 根文件（会按内容同步；profile 里别的东西一律不碰）。 */
const OWNED_ROOT_FILES = ['package.json', 'cordis.patch.yml'];

/** 插件的目录名 —— 也就是 Loader 解析的那个裸 specifier。 */
const PLUGIN_PACKAGE_NAME = 'dsh-cocos-bridge';

/**
 * 解析 DSH home。
 *
 * 优先级：显式入参 → `DSH_HOME` 环境变量 → `~/.dsh`。与 DSH 自己的 `resolveDshHome` 同一口径。
 *
 * @param {string} [explicit] - 调用方显式给的路径。
 * @returns {string} 绝对路径。
 */
function resolveDshHome(explicit) {
    if (explicit) return resolve(explicit);
    const fromEnv = process.env.DSH_HOME;
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim());
    return join(homedir(), '.dsh');
}

/**
 * 递归列出目录下的所有**文件**（相对路径，用 `/` 分隔保证跨平台一致）。
 *
 * @param {string} root - 目录绝对路径。
 * @param {string} [base] - 相对基准，递归内部使用。
 * @returns {string[]} 相对路径列表。
 */
function listFiles(root, base = root) {
    /** @type {string[]} */
    const out = [];
    if (!existsSync(root)) return out;
    for (const entry of readdirSync(root)) {
        const abs = join(base, entry);
        if (statSync(abs).isDirectory()) out.push(...listFiles(abs, base));
        else out.push(relative(root, abs).split('\\').join('/'));
    }
    return out;
}

/**
 * 内容不同才写盘。
 *
 * @param {string} source - 源文件。
 * @param {string} dest - 目标文件。
 * @param {string[]} changes - 变更清单（就地追加）。
 * @param {string} label - 变更清单里显示的名字。
 * @returns {boolean} 是否发生了写入。
 */
function syncFile(source, dest, changes, label) {
    const next = readFileSync(source, 'utf8');
    let current = null;
    try {
        current = readFileSync(dest, 'utf8');
    } catch {
        current = null;
    }
    if (current === next) return false;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, next);
    changes.push(`${current === null ? '新增' : '更新'} ${label}`);
    return true;
}

/**
 * 安装/修复 profile。幂等：内容一致时一个字节都不写。
 *
 * @param {object} [options] - 可选项。
 * @param {string} [options.sourceDir] - `dsh-profile/` 的位置（默认按脚本位置推算）。
 * @param {string} [options.dshHome] - 覆盖 DSH home。
 * @returns {{ok: boolean, dshHome: string, profileDir: string, version: string, changes: string[], profileExisted: boolean}} 安装报告。
 */
function installProfile(options = {}) {
    const sourceDir = options.sourceDir ? resolve(options.sourceDir) : resolve(__dirname, '..', 'dsh-profile');
    if (!existsSync(sourceDir)) throw new Error(`install-profile: 找不到 profile 源目录 ${sourceDir}`);

    const dshHome = resolveDshHome(options.dshHome);
    const profileDir = join(dshHome, 'profiles', PROFILE_NAME);
    const profileExisted = existsSync(join(profileDir, 'package.json'));
    /** @type {string[]} */
    const changes = [];

    mkdirSync(profileDir, { recursive: true });

    // 1) profile 根文件（我们拥有的那几个）
    for (const name of OWNED_ROOT_FILES) {
        const source = join(sourceDir, name);
        if (!existsSync(source)) continue;
        syncFile(source, join(profileDir, name), changes, name);
    }

    // 2) cordis.yml 只是 Loader 的 include 锚点，DSH 每次启动都会把它重写成空树；
    //    只在缺失时补一份，免得我们写的注释版跟 DSH 的重写来回打架。
    const rootConfig = join(profileDir, 'cordis.yml');
    if (!existsSync(rootConfig)) {
        syncFile(join(sourceDir, 'cordis.yml'), rootConfig, changes, 'cordis.yml');
    }

    // 3) 插件 → profile 局部 node_modules（Loader 从配置目录按名字就能解析到）
    const pluginSource = join(sourceDir, 'plugin', PLUGIN_PACKAGE_NAME);
    const pluginDest = join(profileDir, 'node_modules', PLUGIN_PACKAGE_NAME);
    const wanted = new Set(listFiles(pluginSource));
    for (const rel of wanted) {
        syncFile(join(pluginSource, rel), join(pluginDest, rel), changes, `node_modules/${PLUGIN_PACKAGE_NAME}/${rel}`);
    }
    // 3b) 清掉我们**曾经**装过、现在源里已经没有的文件（只在我们自己的包目录里动手）
    for (const rel of listFiles(pluginDest)) {
        if (wanted.has(rel)) continue;
        rmSync(join(pluginDest, rel), { force: true });
        changes.push(`删除 node_modules/${PLUGIN_PACKAGE_NAME}/${rel}（源里已移除）`);
    }

    // 4) 版本戳：一眼看出装的是哪一版、从哪来
    const stampPath = join(profileDir, '.dsh-chat-profile.json');
    if (changes.length > 0 || !existsSync(stampPath)) {
        writeFileSync(
            stampPath,
            JSON.stringify({ version: PROFILE_VERSION, sourceDir, updatedAt: new Date().toISOString() }, null, 4),
        );
    }

    return { ok: true, dshHome, profileDir, version: PROFILE_VERSION, changes, profileExisted };
}

module.exports = { installProfile, resolveDshHome, PROFILE_NAME, PROFILE_VERSION, PLUGIN_PACKAGE_NAME };

// 直接 `node install-profile.js` 时打印一份报告，方便手工排查。
if (require.main === module) {
    try {
        const report = installProfile();
        console.log(`[dsh_chat] profile 已就位：${report.profileDir}`);
        console.log(`[dsh_chat] 版本 ${report.version}；${report.changes.length === 0 ? '无变更（已是最新）' : ''}`);
        for (const line of report.changes) console.log(`  - ${line}`);
    } catch (error) {
        console.error(`[dsh_chat] 安装 profile 失败：${error instanceof Error ? error.message : error}`);
        process.exitCode = 1;
    }
}
