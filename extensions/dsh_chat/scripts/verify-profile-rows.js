/**
 * profile 行体检 —— **真起一次 `dsh --profile cocos`**，问它「那几个服务到底挂上没有」。
 *
 * ## 为什么需要一个「真启动」的验证
 *
 * `dsh --profile cocos --dump-config` 只能证明**配置合成对了**（行在、`disabled: false` 生效），
 * 证明不了**那行真的能挂起来**。而这两件事之间有一整类只在启动时才会炸的错：
 *
 * | 真实发生过的一次 | 表现 |
 * |---|---|
 * | `file-reference`（seam）与 `file-reference-local`（提供方）**都挂** → 两个 `FileReferenceService` 抢同一个服务名 | apply 阶段硬失败 ⇒ **整棵树起不来** ⇒ 面板上只有一句「agent 启动失败」 |
 * | `ctx.get('commands')` 取服务（而不是 `ctx.inject`） | 服务明明在，取值**恒为 undefined**、不报错 ⇒ 「命令表 / `@` 补全 / 发图」全部静默失效 |
 *
 * 两条都是 2026-12 用这个脚本抓到的，本地任何静态检查都看不见。
 *
 * ## 它怎么做的
 *
 * 1. 往 profile 的 `node_modules/` 里临时放一个探针插件（`dsh-cocos-probe`）；
 * 2. 用 `--patch` 叠加一行，把探针挂进树里；
 * 3. 真起 profile —— 探针在 `apply()` 里对每个服务**同时走两条取值路**
 *    （`ctx.get` 与 `ctx.inject`），4 秒后把结果写进一个 JSON 文件并退出；
 * 4. 读那个文件，断言；顺带删掉探针与临时 patch。
 *
 * ## 它**不**做什么
 *
 * 不碰编辑器、不连模型、不落任何会话（探针只报告服务、不创建 agent）。
 * 全程只读 profile 配置 + 临时写两个文件（跑完自己删）。
 *
 * ```sh
 * node scripts/verify-profile-rows.js
 * node scripts/verify-profile-rows.js --keep   # 保留探针与输出（排查用）
 * ```
 *
 * @module dsh_chat/verify-profile-rows
 */

'use strict';

const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');

const { resolveDshHome, PROFILE_NAME } = require('./install-profile.js');

const ROOT = resolve(__dirname, '..');
const PROJECT_ROOT = resolve(ROOT, '..', '..');
const TMP = join(PROJECT_ROOT, '.tmp');
const PROBE_NAME = 'dsh-cocos-probe';
const OUT_FILE = join(TMP, 'profile-rows-probe.json');
const PATCH_FILE = join(TMP, 'profile-rows-patch.yml');

/** 探针跑多久之后收工（秒）。启动要加载整棵树，实测 3~6 秒。 */
const PROBE_WAIT_MS = 14_000;

/** 必须挂上的服务：服务名 → 它身上那个「有就说明真挂上了」的方法。 */
const REQUIRED_SERVICES = {
    commands: 'list',
    fileReferences: 'list',
    attachments: 'saveImages',
    agents: 'get',
    sessionTitle: 'get',
};

let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) {
        failures += 1;
        process.exitCode = 1;
    }
};

/** 探针插件的源码。**用 `inject` 与 `get` 两条路各取一遍**，这正是它能抓错的原因。 */
const PROBE_SOURCE = `import { writeFileSync } from 'node:fs';

export const name = 'cocos-probe';

const SERVICES = ${JSON.stringify(Object.keys(REQUIRED_SERVICES))};

export function apply(ctx) {
    const viaGet = {};
    for (const service of SERVICES) {
        try {
            viaGet[service] = ctx.get(service) === undefined ? 'undefined' : 'present';
        } catch (error) {
            viaGet[service] = 'throw: ' + String(error);
        }
    }

    const viaInject = {};
    let pending = SERVICES.length;
    const finish = () => {
        setTimeout(() => {
            writeFileSync(
                process.env.DSH_PROBE_OUT,
                JSON.stringify({ viaGet, viaInject, services: SERVICES }, null, 2),
                'utf8',
            );
            process.exit(0);
        }, 500);
    };
    for (const service of SERVICES) {
        try {
            ctx.inject([service], (scoped) => {
                viaInject[service] = scoped[service] === undefined ? 'undefined' : 'present';
                pending -= 1;
                if (pending === 0) finish();
            });
        } catch (error) {
            viaInject[service] = 'throw: ' + String(error);
            pending -= 1;
        }
    }
    setTimeout(() => {
        writeFileSync(
            process.env.DSH_PROBE_OUT,
            JSON.stringify({ viaGet, viaInject, services: SERVICES, note: '超时（有些服务一直没出现）' }, null, 2),
            'utf8',
        );
        process.exit(0);
    }, ${PROBE_WAIT_MS - 4000});
}
`;

/**
 * 装探针（临时）：profile 的 `node_modules/<name>` 下两个文件。
 *
 * @param {string} modulesDir - profile 的 `node_modules`。
 * @returns {string} 探针目录。
 */
function installProbe(modulesDir) {
    const dir = join(modulesDir, PROBE_NAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: PROBE_NAME, version: '0.0.0', private: true, type: 'module', main: 'index.js' }, null, 4),
        'utf8',
    );
    writeFileSync(join(dir, 'index.js'), PROBE_SOURCE, 'utf8');
    return dir;
}

/**
 * 起 profile 并等探针写结果。
 *
 * @param {string} nodeExe - 系统 node。
 * @param {string} dshBin - `dsh` 的 `lib/bin.js`。
 * @returns {Promise<{code: number|null, stderr: string}>} 退出码与 stderr（失败时要看它）。
 */
function runProbe(nodeExe, dshBin) {
    return new Promise((done) => {
        const child = spawn(nodeExe, [dshBin, '--profile', PROFILE_NAME, '--patch', PATCH_FILE], {
            cwd: PROJECT_ROOT,
            env: { ...process.env, DSH_PROBE_OUT: OUT_FILE, DSH_TELEMETRY_DISABLED: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        // stdout 是 SDK 协议的地盘，这里有内容说明有插件往它上面写了东西（值得报出来）
        let stdout = '';
        child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
        });
        const timer = setTimeout(() => {
            child.kill();
            done({ code: null, stderr, stdout, timeout: true });
        }, PROBE_WAIT_MS + 8000);
        child.on('exit', (code) => {
            clearTimeout(timer);
            done({ code, stderr, stdout });
        });
    });
}

async function main() {
    const profileDir = join(resolveDshHome(), 'profiles', PROFILE_NAME);
    const modulesDir = join(profileDir, 'node_modules');
    console.log(`profile：${profileDir}`);

    const runtime = require(join(ROOT, 'dist', 'paths.js'));
    const settings = require(join(ROOT, 'dist', 'settings.js'));
    let nodeExe = null;
    let dshBin = null;
    try {
        const resolved = runtime.resolveRuntime(settings.getSettings ? settings.getSettings() : {});
        nodeExe = resolved.nodeExe;
        dshBin = resolved.dshBin;
    } catch (error) {
        check('能探测到 node 与 dsh（这一步不依赖编辑器）', false, String(error));
        return;
    }
    check('探测到 node', Boolean(nodeExe), String(nodeExe));
    check('探测到 dsh bin.js', Boolean(dshBin), String(dshBin));
    if (!nodeExe || !dshBin) return;

    // ---- 1. 配置层：两行都必须在、且 session-title-llm 是打开的 ----
    const patchText = readFileSync(join(ROOT, 'dsh-profile', 'cordis.patch.yml'), 'utf8');
    check('profile 层启用了会话标题的 LLM 提供方（显式 disabled: false）', /\n\s*disabled:\s*false\b/.test(patchText));
    check('profile 层挂了 file-reference-local', patchText.includes('@deepseek-ai/dsh-file-reference-local'));
    check(
        '⚠ *没有*同时挂 file-reference（那个 seam 包自己就注册服务，两个都挂会让整棵树起不来）',
        !/name:\s*'@deepseek-ai\/dsh-file-reference'\s*$/m.test(patchText),
    );

    // ---- 2. 真启动一次 ----
    mkdirSync(TMP, { recursive: true });
    writeFileSync(PATCH_FILE, `- insert:\n    - id: ${PROBE_NAME}\n      name: ${PROBE_NAME}\n`, 'utf8');
    rmSync(OUT_FILE, { force: true });
    const probeDir = installProbe(modulesDir);
    console.log(`\n真启动一次 profile（探针 ${PROBE_NAME}，约 ${Math.round(PROBE_WAIT_MS / 1000)} 秒）…`);

    let result;
    try {
        result = await runProbe(nodeExe, dshBin);
    } finally {
        if (!process.argv.includes('--keep')) {
            rmSync(probeDir, { recursive: true, force: true });
            rmSync(PATCH_FILE, { force: true });
        }
    }

    const boom = /failed to (apply|import) loader entry|Error: /i.test(result.stderr) && !existsSync(OUT_FILE);
    check(
        'profile 起得来（没有 apply 阶段的硬失败）',
        !boom,
        boom ? result.stderr.split('\n').filter((line) => /Error|failed to/.test(line)).slice(0, 4).join(' ｜ ') : '',
    );
    if (!existsSync(OUT_FILE)) {
        check('探针写出了结果文件', false, OUT_FILE + (result.timeout ? '（超时了）' : ''));
        console.log(result.stderr.split('\n').slice(-25).join('\n'));
        return;
    }

    const payload = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
    console.log(`\n服务（${payload.services.length} 个）：`);
    if (payload.note) console.log(`  ⚠ ${payload.note}`);

    // ---- 3. 断言：`inject` 那条路必须全都拿得到 ----
    for (const [service, method] of Object.entries(REQUIRED_SERVICES)) {
        check(
            `服务 ${service} 经 inject 拿得到`,
            payload.viaInject[service] === 'present',
            `viaInject=${payload.viaInject[service]} viaGet=${payload.viaGet[service]}`,
        );
    }
    /**
     * `ctx.get` 那条路**必须是 undefined** —— 这条断言看着奇怪，其实是本脚本存在的一半理由：
     * 它把「cordis 的服务只能靠 inject 取」这件事从"注释里的一句话"变成"一条会红的断言"。
     * 哪天 cordis 改了行为（`get` 也能取到），这条会红，那时两处代码可以简化；
     * 在那之前，谁把插件里的 `inject` 改回 `ctx.get`，`verify-bridge.js` 会先红。
     */
    const anyGet = Object.entries(payload.viaGet).filter(([, value]) => value !== 'undefined' && !String(value).startsWith('throw'));
    check(
        'ctx.get 取不到服务（cordis 的口径：只能 inject）—— 这条红了说明 DSH 变了，去看 hostService 的注释',
        anyGet.length === 0,
        anyGet.map(([name, value]) => `${name}=${value}`).join(', '),
    );
    check(
        'stderr 里没有「没有挂附件库 / 没挂命令注册表」这类降级警告（插件的取值方式没走错）',
        !/没有挂附件库|没有挂命令注册表|没有挂文件引用服务/.test(result.stderr),
    );
    /**
     * 顺带证明**真插件也在树里**（`install-profile.js` 装的那份 `dsh-cocos-bridge`）。
     *
     * 为什么不另写一个脚本去 import 它：这一条要验的正是「在真运行时里挂得起来」——
     * 静态 import 一个假 ctx 是 `verify-bridge.js` 的活，两者互补。
     */
    check(
        '真插件 dsh-cocos-bridge 也挂上了（四个工具注册的那行日志在）',
        result.stderr.includes('已注册原生工具'),
        result.stderr.split('\n').filter((line) => line.includes('cocos-bridge')).slice(0, 3).join(' ｜ '),
    );
    check(
        '真插件的 stderr 里没有「服务 X 的注入回调跑了，但拿到的还是空」这类自检告警',
        !/拿到的还是空/.test(result.stderr),
    );
    /**
     * **第三方 bundle：一个都不许有**（2026-12 的决定，与 `verify-stats.js` §8 那条红线同源）。
     *
     * 这条原来是「`dsh-cost-meter` 装了就真加载」的双向条件断言。口径改了：本 profile 的
     * `bundles` 里只有两个 in-box 的 `@deepseek-ai/*`（`dsh-base` / `dsh-sdk-app`），
     * 所以这里改成**红线** —— 真跑一次之后，配置里、日志里都不该出现第三方插件的痕迹。
     *
     * 为什么这条值得留（而不是删掉）：第三方 bundle 是**唯一**一类不在我们自己的
     * `cordis.patch.yml` 里的行 —— 那一行是它自己带的 patch 插进来的（profile 里只写了 bundle 名字）。
     * 于是「配置合成对了」与「它真能加载」之间隔着一整类只在启动时炸的错：少了依赖、
     * zod 版本对不上、服务名撞车……症状还全是**静默**的。哪天有人把它加回来，这条会立刻红。
     *
     * 顺带记一条实测事实：第三方插件会往 **stdout** 上写日志（`console.log`），
     * 而 `[cocos-bridge]` 那些在 stderr 上（`console.warn`）—— 那正是 `sdk-client.ts` 里
     * 「杂质行跳过并计数」存在的理由，所以两个流都要看。
     */
    const installedManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    const declaredHere = installedManifest.dsh?.profile?.bundles ?? [];
    const thirdPartyHere = declaredHere.filter((name) => !String(name).startsWith('@deepseek-ai/'));
    const thirdPartyLog = `${result.stderr}\n${result.stdout ?? ''}`
        .split('\n')
        .filter((line) => /^\[(?!cocos-bridge)/.test(line.trim()));
    check(
        '装出去的那份 profile 里**只有 in-box 的 bundle**（零第三方：声明了却没装会让整棵树起不来）',
        thirdPartyHere.length === 0,
        thirdPartyHere.length > 0 ? thirdPartyHere.join(',') : declaredHere.join(','),
    );
    check(
        '真跑一次之后日志里也没有第三方插件的加载行（有的话它已经进了合成结果，只是没人盯）',
        thirdPartyLog.length === 0,
        thirdPartyLog.slice(0, 2).join(' ｜ ') || '（没有）',
    );

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 条失败`}`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
    console.error(`verify-profile-rows 崩了：${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
});
