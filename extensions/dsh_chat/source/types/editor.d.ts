/**
 * 我们**实际用到**的那几个编辑器 API 的环境声明。
 *
 * 为什么不直接 `import type` 整套 `@cocos/creator-types`：
 *
 * - 那套类型要多装一份 `@cocos/creator-types` 依赖，而本扩展只需要 `@types/node`
 *   （见 `package.json` 的 devDependencies），这样克隆下来 `npm i && npm run build` 就能编。
 * - 我们只碰 7 个 API。把用到的声明写在这儿，比拉进来一份 66 万字符的
 *   `electron.d.ts` 更容易读，也让「我们依赖了编辑器什么」这件事一眼可见。
 *
 * ⚠ 这里是**手写**的：如果哪天要用的 API 不在下面，请**补声明**再调用，
 * 不要图省事写 `(Editor as any)` —— 那样编译期就失去了唯一的把关。
 *
 * 声明细节对齐 `@cocos/creator-types/editor`（本地实测于 3.8.6）。
 */

declare namespace Editor {
    /** 当前工程信息 */
    namespace Project {
        /** 工程根目录的绝对路径。DSH 子进程的 cwd 与工具的工作目录都以它为准。 */
        const path: string;
    }

    /** 编辑器应用信息 */
    namespace App {
        /** 编辑器版本，如 `3.8.6`。 */
        const version: string;
        /** 应用名，如 `CocosCreator`。 */
        const name: string;
        /** 编辑器安装目录（`Editor.App.path + '/node_modules'` 是场景进程补依赖用的）。 */
        const path: string;
    }

    /**
     * 扩展包管理。
     *
     * 场景脚本（`source/scene.ts`）要按**绝对路径** require 本扩展的 `dist/core/recipes.js` ——
     * 场景进程里 `__dirname` 是 `electron.asar/renderer`，相对路径不通，
     * 只能问编辑器要扩展根：`Editor.Package.getPath('dsh_chat')`。
     */
    namespace Package {
        /** 扩展根目录（`extensions/dsh_chat`）；拿不到时返回 undefined。 */
        function getPath(extensionName: string): string | undefined;
    }

    /** 主进程 ↔ 渲染进程（面板）的消息总线 */
    namespace Message {
        /**
         * 调某个扩展/内置包的消息方法。
         * @param name 包名，如 `'dsh_chat'`、`'scene'`、`'asset-db'`
         * @param message 消息名
         * @param args 参数
         */
        function request(name: string, message: string, ...args: unknown[]): Promise<unknown>;

        /**
         * **发一条不等回执**的消息（fire-and-forget）。
         *
         * 为什么需要它：真机实测（`docs/真机验收-结果.md`）`editor-preview-set-play(true)`
         * **120s 不回执** —— 用 `request` 等这条消息就是把自己挂死，而它的**副作用（把预览跑起来）
         * 其实发生了**。所以「先 send、再按状态复探」是本工程对这类消息的口径。
         *
         * 用法出处（编辑器自带工具栏）：`builtin/preview/static/toolbar/middle.js` 里的
         * `Editor.Message.send("console","update-extension-visible")`。
         */
        function send(name: string, message: string, ...args: unknown[]): void;

        /** 向所有窗口广播一条消息（面板侧用 `Message.__protected__.addBroadcastListener` 收）。 */
        function broadcast(message: string, ...args: unknown[]): void;

        /** 保护接口：面板侧的广播监听注册/注销。 */
        const __protected__: {
            addBroadcastListener(message: string, func: (...args: unknown[]) => void): void;
            removeBroadcastListener(message: string, func: (...args: unknown[]) => void): void;
        };
    }

    /** 面板管理 */
    namespace Panel {
        /** 打开一个面板（按扩展名或面板 id）。 */
        function open(name: string): Promise<boolean>;
        /**
         * **在另一个面板旁边打开**（Cocos 官方 API）。
         *
         * 这就是「把 DSH 面板停靠到 Inspector 旁边」的正路：
         * `Editor.Panel.openBeside('inspector', 'dsh_chat')`。
         *
         * ⚠ 实测：**面板已经开着时返回 `false` 且什么都不做** —— 想让它生效得先 `close()`。
         */
        function openBeside(besidePanel: string, name: string, ...args: unknown[]): Promise<boolean>;
        /** 关闭一个面板。 */
        function close(name: string): Promise<boolean>;
        /** 聚焦一个已打开的面板。 */
        function focus(name: string): Promise<boolean>;
        /** 面板是否已打开。 */
        function has(name: string): Promise<boolean>;
        /** 面板定义入口——只在渲染进程里可用。 */
        function define(spec: unknown): unknown;
    }

    /** 扩展本地配置读写（`local` = 这台机器，`project` = 跟着工程走） */
    namespace Profile {
        function getConfig(pkgName: string, key: string, protocol?: 'local' | 'project' | 'global' | 'default'): Promise<unknown>;
        function setConfig(pkgName: string, key: string, value: unknown, protocol?: 'local' | 'project' | 'global'): Promise<void>;
    }

    /** 日志（编辑器控制台）。DSH 子进程的 stdout/stderr 我们自己接管，不走这里。 */
    namespace Logger {
        function info(...args: unknown[]): void;
        function warn(...args: unknown[]): void;
        function error(...args: unknown[]): void;
        function debug(...args: unknown[]): void;
    }
}
