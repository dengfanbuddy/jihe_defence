/**
 * 扩展设置 —— 通过 `Editor.Profile` 存到**本机**（`local`），不跟着工程进 Git。
 *
 * 存 local 而不是 project：node 路径、模型、自动启动这些都是「这台机器上的编辑器」
 * 的状态，跟着工程走会让同事拉下来就冲突。
 */

/** 设置的内存镜像类型（定义在 constants，面板也要用同一份）。 */
import type { DshChatSettings, PanelPalette, PanelTheme } from './constants';

export type { DshChatSettings };

/** 设置键名（Editor.Profile 的 key）。 */
export const SETTINGS_KEY = 'settings';

/** 默认设置。 */
export const DEFAULT_SETTINGS: DshChatSettings = {
    autoStart: true,
    nodePath: '',
    dshBin: '',
    provider: 'deepseek-official',
    // 与 $DSH_HOME/settings.yaml 里 agent-default-model 的口径保持一致；
    // 换了默认模型在这里改，或直接改设置。
    model: 'deepseek-v4-flash-vision-exp',
    reasoningEffort: 'high',
    maxTokens: 0,
    workdir: '',
    showStderrNotes: false,
    // 面板外观：默认跟随（能认出编辑器主题就跟编辑器，认不出跟系统），配色用 DSH 官方色板，
    // 字号用 token 默认的 14px
    theme: 'auto',
    palette: 'dsw',
    fontSize: 0,
};

/** 内存镜像 —— 避免每次动作都 await 一次 Profile 读盘。 */
let current: DshChatSettings = { ...DEFAULT_SETTINGS };

/** 面板字号允许的范围（与 DSH web 客户端的 12~17px 一致；0 = 用默认 14）。 */
const FONT_SIZE_RANGE = { min: 12, max: 17 };

/** 把任意来源（配置文件可能被手改坏）收敛成合法设置。 */
export function normalizeSettings(raw: unknown): DshChatSettings {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<DshChatSettings>;
    const str = (value: unknown, fallback: string): string =>
        typeof value === 'string' && value.trim() ? value.trim() : fallback;
    const num = (value: unknown, fallback: number): number => {
        const n = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
    };
    /** 字号：0 或空 = 默认；其余钳到 12~17。 */
    const fontSize = (value: unknown): number => {
        const n = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, Math.trunc(n)));
    };
    const theme = (value: unknown): PanelTheme =>
        value === 'dark' || value === 'light' || value === 'auto' ? value : DEFAULT_SETTINGS.theme;
    /** 配色：只认这两个值，其余（含被手改坏的值）回落默认 —— 覆盖层靠这个值命中，写错就是静默不生效。 */
    const palette = (value: unknown): PanelPalette =>
        value === 'editor' || value === 'dsw' ? value : DEFAULT_SETTINGS.palette;
    return {
        autoStart: typeof input.autoStart === 'boolean' ? input.autoStart : DEFAULT_SETTINGS.autoStart,
        nodePath: str(input.nodePath, DEFAULT_SETTINGS.nodePath),
        dshBin: str(input.dshBin, DEFAULT_SETTINGS.dshBin),
        provider: str(input.provider, DEFAULT_SETTINGS.provider),
        model: str(input.model, DEFAULT_SETTINGS.model),
        reasoningEffort: typeof input.reasoningEffort === 'string' ? input.reasoningEffort.trim() : DEFAULT_SETTINGS.reasoningEffort,
        maxTokens: num(input.maxTokens, DEFAULT_SETTINGS.maxTokens),
        workdir: str(input.workdir, DEFAULT_SETTINGS.workdir),
        showStderrNotes: typeof input.showStderrNotes === 'boolean' ? input.showStderrNotes : DEFAULT_SETTINGS.showStderrNotes,
        theme: theme(input.theme),
        palette: palette(input.palette),
        fontSize: fontSize(input.fontSize),
    };
}

/** 当前生效的设置。 */
export function getSettings(): DshChatSettings {
    return current;
}

/** 从编辑器配置里读一次。读失败回落默认值（不让设置问题挡住启动）。 */
export async function loadSettings(extensionName: string): Promise<DshChatSettings> {
    try {
        const raw = await Editor.Profile.getConfig(extensionName, SETTINGS_KEY, 'local');
        current = normalizeSettings(raw);
    } catch (error) {
        console.warn(`[dsh_chat] 读取设置失败，回落默认值：`, error);
        current = { ...DEFAULT_SETTINGS };
    }
    return current;
}

/** 合并写入（只覆盖传入的字段）。 */
export async function updateSettings(extensionName: string, patch: unknown): Promise<DshChatSettings> {
    const merged = normalizeSettings({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
    current = merged;
    try {
        await Editor.Profile.setConfig(extensionName, SETTINGS_KEY, merged as unknown as object, 'local');
    } catch (error) {
        console.warn(`[dsh_chat] 写入设置失败：`, error);
    }
    return current;
}
