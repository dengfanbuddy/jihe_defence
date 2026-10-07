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

/**
 * profile 内容版本 —— **从插件 `package.json` 的 `version` 派生**，不再单独维护。
 *
 * 之前这里硬编码 `'0.2.0'`，而 `constants.ts` / `package.json` 是 `0.1.0` ——
 * 三处不一致时，用户报的版本号没法判断「装的到底是哪一版内容」。
 * 现在唯一真源 = `package.json` 的 `version`。
 */
const PROFILE_VERSION = require('../package.json').version;

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

/** profile 运行必需的 DSH 侧 bundles（住在 `$DSH_HOME/profiles/node_modules/@deepseek-ai/`）。 */
const REQUIRED_BUNDLES = ['dsh-base', 'dsh-sdk-app'];

/**
 * 校验 profile 声明的**第三方依赖**是不是真的装着。
 *
 * ## 为什么必须查（与 `REQUIRED_BUNDLES` 同一类故障，但更狠）
 *
 * `dsh-profile/package.json` 里的 `dependencies` 是**声明**，而 Loader 解析 bundle 名字靠的是
 * **profile 目录下的 node_modules**（`profiles/cocos/node_modules/<名字>/`，pnpm 摆的位置）。
 * 声明了却没装时，DSH **不是**跳过那一行 —— 它**直接抛**（`dsh-app-boot` 的 `resolveBundleDir`：
 * `cannot resolve profile bundle …`），`loadProfile` 又是 `bundles.map(...)`，
 * 于是**整棵插件树起不来**：`dsh --profile cocos --dump-config` 都跑不完，面板上只有一句
 * 「agent 启动失败」。第三方 bundle 缺失的代价因此**比「少一块功能」大得多** ——
 * 这正是 `syncProfileManifest` 要在**装出去的那份** manifest 里把它摘掉的原因。
 *
 * ## 为什么本脚本**不自己装**
 *
 * 这个脚本的契约是「**完全离线**、只做幂等的文件同步」，而装第三方包要 pnpm + registry。
 * 所以这里只体检 + 给出**一条能直接粘的命令**（`dsh plugin --profile cocos install`
 * 就是 DSH 自己那条报错信息里推荐的恢复路径：它转发 `pnpm install` 再按装好的状态对齐 bundles）。
 *
 * @param sourceDir - 工程里的 `dsh-profile/`（依赖声明的真源）。
 * @param profileDir - 目标 profile 目录。
 * @param dshHome - DSH home（共享依赖也在它下面）。
 * @returns 缺的包与给用户的命令。
 */
function checkDeclaredDeps(sourceDir, profileDir, dshHome) {
    const declared = declaredDependencies(sourceDir);
    const names = Object.keys(declared);
    const missing = names.filter((name) => !isInstalled(name, profileDir, dshHome));
    return {
        declared: names,
        missing,
        hint:
            missing.length === 0
                ? ''
                : `缺 ${missing.join('、')}：profile 里跑一次 \`dsh plugin --profile ${PROFILE_NAME} install\`（` +
                  '它转发 `pnpm install` 再按装好的状态对齐 bundles，需要网络与 pnpm；装完再重开面板）。',
    };
}

/** 读真源里的 `dependencies`（读不到就当没有 —— 清单损坏由 `syncProfileManifest` 那一侧负责说）。 */
function declaredDependencies(sourceDir) {
    try {
        return JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')).dependencies ?? {};
    } catch {
        return {};
    }
}

/**
 * 这个包在 profile 里解析得到吗？
 *
 * 两个位置（与 `dsh-app-boot` 的 `resolveBundleDir` 同一个口径，只是少了「dsh 安装目录」那一层
 * —— 那一层只有 DSH 自己知道，而它**本来就**是本机自带的 in-box bundle 走的路）：
 * ① `profiles/<名字>/node_modules/<包>`（`dsh plugin add` 装的那一份）；
 * ② `$DSH_HOME/profiles/node_modules/<包>`（DSH 安装时就位好的共享依赖）。
 */
function isInstalled(name, profileDir, dshHome) {
    if (existsSync(join(profileDir, 'node_modules', name, 'package.json'))) return true;
    return existsSync(join(dshHome, 'profiles', 'node_modules', name, 'package.json'));
}

/**
 * 算出**装出去的那份** `package.json` 该是什么内容。
 *
 * ## 唯一的改写：把「解析不到的第三方 bundle」从 `bundles` 里摘掉
 *
 * 真源（工程里的 `dsh-profile/package.json`）表达的是**意图**：`dependencies` 写着要装什么、
 * `bundles` 写着要挂哪些层。而**装出去的那一份**要能真的跑起来 —— 这两件事在
 * 「别人没装这个第三方插件」时是冲突的，冲突的代价上面写过：**整棵树起不来**。
 *
 * 所以规则是：
 * - `dependencies` **原样保留**（意图留着，`dsh plugin --profile cocos install` 才有东西可装）；
 * - `bundles` 里凡是在 `dependencies` 里（⇒ 我们自己要负责装）、又**解析不到**的，摘掉并报出来；
 * - **in-box bundle（`@deepseek-ai/*`，不是我们的依赖）一律不动** —— 那些走 dsh 自己的安装目录，
 *   真缺了说明整个 DSH 装坏了，那种情况下「悄悄改 profile」只会更难查。
 *
 * 自愈是双向的：装上之后 `dsh plugin add` 会把 bundles 补回来，而本函数算出来的内容也会
 * 重新包含它 —— 谁先谁后都收敛到同一份。
 *
 * @param sourceDir - 工程里的 `dsh-profile/`。
 * @param profileDir - 目标 profile 目录。
 * @param dshHome - DSH home。
 * @returns `{text, dropped}`：写盘用的内容（4 空格缩进 + 末尾换行，与真源同一种格式）与被摘掉的名字。
 */
function syncProfileManifest(sourceDir, profileDir, dshHome) {
    const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'));
    const declared = Object.keys(manifest.dependencies ?? {});
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    const dropped = [];
    const kept = bundles.filter((name) => {
        // 只有「我们的依赖」才归我们负责解析；in-box bundle 不动（见上面那段）
        if (!declared.includes(name)) return true;
        if (isInstalled(name, profileDir, dshHome)) return true;
        dropped.push(name);
        return false;
    });
    if (dropped.length > 0 && manifest.dsh?.profile) manifest.dsh.profile.bundles = kept;
    // ⚠ 与真源**逐字节**可比：同一份 JSON + 4 空格缩进 + 末尾换行。
    // 不一样的话每次加载都会「内容不同」→ 白写一次盘（幂等性就没了）。
    return { text: `${JSON.stringify(manifest, null, 4)}\n`, dropped };
}

/**
 * 校验运行期依赖 —— 这几个 bundle 缺任何一个，**插件的 4 个工具会整体加载失败**
 * （profile 里的 bridge 插件加载不起来），而 profile 自己看起来是"装好了"。
 *
 * 为什么必须做：之前的实现无论如何都回 `ok: true`，于是用户拿到的是
 * **「装成功 + 工具凭空消失」**——最难查的一类故障（要等 initialize 超时或报"未知的编辑器方法"）。
 *
 * @param {string} dshHome - DSH home。
 * @returns {{ok: boolean, root: string, missing: string[]}} 校验结果。
 */
function checkRuntimeDeps(dshHome) {
    const root = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai');
    const missing = REQUIRED_BUNDLES.filter((name) => !existsSync(join(root, name, 'package.json')));
    return { ok: missing.length === 0, root, missing };
}

/**
 * 安装/修复 profile。幂等：内容一致时一个字节都不写。
 *
 * @param {object} [options] - 可选项。
 * @param {string} [options.sourceDir] - `dsh-profile/` 的位置（默认按脚本位置推算）。
 * @param {string} [options.dshHome] - 覆盖 DSH home。
 * @returns {{ok: boolean, dshHome: string, profileDir: string, version: string, changes: string[], profileExisted: boolean, deps: object, warnings: string[]}} 安装报告。
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
        if (name === 'package.json') {
            /**
             * ⚠ 清单**不是**逐字拷贝：要先把「解析不到的第三方 bundle」摘掉（见
             * `syncProfileManifest`）。不摘的代价是 DSH 启动时直接抛异常 ——
             * 也就是说「别人没装那个第三方插件」会变成**整个 agent 起不来**，
             * 而不是「少一块功能」。
             */
            const projected = syncProfileManifest(sourceDir, profileDir, dshHome);
            const dest = join(profileDir, name);
            let current = null;
            try {
                current = readFileSync(dest, 'utf8');
            } catch {
                current = null;
            }
            if (current !== projected.text) {
                writeFileSync(dest, projected.text);
                changes.push(`${current === null ? '新增' : '更新'} ${name}`);
            }
            if (projected.dropped.length > 0) {
                changes.push(
                    `从 ${name} 的 bundles 里摘掉没装的 ${projected.dropped.join('、')}` +
                        '（不摘的话 DSH 起不来：`resolveBundleDir` 解析不到 bundle 会直接抛）',
                );
            }
            continue;
        }
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

    // 校验运行期依赖。缺 bundle **不改 ok**（profile 文件确实装好了），但必须显式带出去让调用方报红 ——
    // 静默的 `ok: true` 正是之前那次「工具凭空消失」的根因。
    const deps = checkRuntimeDeps(dshHome);
    // 第三方依赖（曾经挂过的 `dsh-cost-meter` 那一类，现在真源里是**空的**）：声明了却没装
    // → 同样必须报出来（那一路是「功能静默消失」，更狠的一路是「整棵树起不来」）。
    const declaredDeps = checkDeclaredDeps(sourceDir, profileDir, dshHome);
    /** @type {string[]} */
    const warnings = deps.ok
        ? []
        : [
            `profile 缺少 DSH 侧 bundle：${deps.missing.join('、')}（找的位置：${deps.root}）。`,
            '缺了它，插件的 4 个 cocos_* 工具会**整体加载失败**，而 profile 自己看起来是装好的。',
            '先装好 `@deepseek-ai/dsh`（bundle 会落在 $DSH_HOME/profiles/node_modules/），再重开面板。',
        ];
    if (declaredDeps.missing.length > 0) {
        warnings.push(
            `profile 声明了第三方 bundle 但**没装**：${declaredDeps.missing.join('、')}（找过：${join(profileDir, 'node_modules')}）。`,
            '已经把它从这份 profile 的 bundles 里摘掉了 —— 不摘的话 DSH 启动时解析不到 bundle 会**直接抛**，' +
                '整棵树起不来（面板上只有一句「agent 启动失败」）。代价是它对应的那一块功能没有。',
            declaredDeps.hint,
        );
    }

    return {
        ok: true,
        dshHome,
        profileDir,
        version: PROFILE_VERSION,
        changes,
        profileExisted,
        deps: { ...deps, declared: declaredDeps.declared, missingDeclared: declaredDeps.missing },
        warnings,
    };
}

module.exports = {
    installProfile,
    resolveDshHome,
    PROFILE_NAME,
    PROFILE_VERSION,
    PLUGIN_PACKAGE_NAME,
    // 导出给 `verify-stats.js` 的「分发场景」断言用：**别人没装这个第三方插件**时，
    // 装出去的那份 manifest 必须自己把那一行摘掉（否则 DSH 起不来），而不是照抄真源。
    syncProfileManifest,
    isInstalled,
    checkDeclaredDeps,
};

// 直接 `node install-profile.js` 时打印一份报告，方便手工排查。
if (require.main === module) {
    try {
        const report = installProfile();
        console.log(`[dsh_chat] profile 已就位：${report.profileDir}`);
        console.log(`[dsh_chat] 版本 ${report.version}；${report.changes.length === 0 ? '无变更（已是最新）' : ''}`);
        for (const line of report.changes) console.log(`  - ${line}`);
        for (const line of report.warnings ?? []) console.warn(`[dsh_chat] ⚠ ${line}`);
        // 依赖不齐 → 退出码 1，这样它能当门禁用（之前无论缺什么都 exit 0）。
        const missingDeps = (report.deps && !report.deps.ok) || (report.deps?.missingDeclared?.length ?? 0) > 0;
        if (missingDeps) process.exitCode = 1;
    } catch (error) {
        console.error(`[dsh_chat] 安装 profile 失败：${error instanceof Error ? error.message : error}`);
        process.exitCode = 1;
    }
}
