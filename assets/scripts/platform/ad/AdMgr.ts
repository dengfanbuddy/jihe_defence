import { LogMgr } from "../log/LogMgr";

/**
 * AdMgr —— 激励视频广告门面（平台无关，单例）
 *
 * 游戏侧只关心「有没有看完」这一个布尔结果，具体 SDK（抖音/微信/穿山甲…）由**接入方**通过
 * `AdMgr.inst.setProvider(...)` 注入，本项目不绑定任何渠道：
 *
 * ```ts
 * // 启动时（如 Loading.ts / 平台适配层）注入一次即可
 * AdMgr.inst.setProvider({
 *     isAvailable: () => true,
 *     showRewardVideo: (placement) => new Promise<boolean>((resolve) => {
 *         tt.createRewardedVideoAd({ adUnitId: 'xxx' })
 *           .onClose((res) => resolve(!!res?.isEnded))
 *           .load().then(() => ad.show());
 *     }),
 * })
 * ```
 *
 * **未注入 provider 时的开发兜底**：打一条 warn 并直接判定「看完」（`true`）。
 * 这样编辑器预览 / 单机调试也能把「看广告刷新」「看广告补选」整条流程跑通；
 * 真机上线前必须注入真 SDK，否则等于白送广告奖励 —— 所以这里用 warn 而不是静默。
 *
 * 用法：
 * ```ts
 * const ok = await AdMgr.inst.showRewardVideo('relic_refresh')
 * if (ok) { ...发放奖励... }
 * ```
 */

/** 广告位标识（只用于埋点/统计，不参与逻辑；新增广告位往这里加即可） */
export type AdPlacement =
    /** 遗物商店：金币不足时看广告免费刷新一次 */
    | 'relic_refresh'
    /** 遗物商店：本次刷新已选过一次，看广告再补选一个 */
    | 'relic_extra_pick'
    /** 选英雄：金币不足时看广告免费刷新一次候选 */
    | 'hero_refresh'
    /** 击杀商店（Buff 商店）：金币不足时看广告免费刷新摊位 */
    | 'buff_shop_refresh'
    /** 暂停界面：暂停达到时长后拉起一次 */
    | 'pause_resume'
    | string;

/** 平台接入方需要实现的接口 */
export interface IAdProvider {
    /** 该广告位当前是否可拉起（缺省视为可用）；返回 false 时不要给奖励 */
    isAvailable?(placement: AdPlacement): boolean;
    /** 拉起激励视频；**resolve(true) 才代表看完**（中途关闭 = false） */
    showRewardVideo(placement: AdPlacement): Promise<boolean>;
}

export class AdMgr {
    private static _ins: AdMgr = null;

    public static get inst(): AdMgr {
        if (!AdMgr._ins) AdMgr._ins = new AdMgr();
        return AdMgr._ins;
    }

    private provider: IAdProvider | null = null;
    /** 正在播放中：并发调用直接返回 false，避免同一个广告被拉起两次 */
    private playing = false;

    private constructor() { }

    /** 注入/替换平台广告实现（启动时调一次；传 null 可退回开发兜底） */
    public setProvider(provider: IAdProvider | null): void {
        this.provider = provider;
    }

    /** 是否已接入真 SDK（false = 走开发兜底，真机上不该出现这种状态） */
    public get hasProvider(): boolean {
        return !!this.provider;
    }

    /** 该广告位当前能否拉起（未接入时按「可拉起」处理，见文件头兜底说明） */
    public isAvailable(placement: AdPlacement): boolean {
        if (this.playing) return false;
        if (!this.provider) return true;
        return this.provider.isAvailable ? this.provider.isAvailable(placement) : true;
    }

    /**
     * 拉起激励视频。
     * @returns true = 看完（可发奖励）；false = 中途关闭 / 拉不起来 / 已在播放
     */
    public showRewardVideo(placement: AdPlacement): Promise<boolean> {
        if (this.playing) {
            LogMgr.warn(`[广告] ${placement}：上一个广告还没播完，本次忽略`);
            return Promise.resolve(false);
        }
        if (!this.provider) {
            LogMgr.warn(`[广告] ${placement}：未接入广告 SDK（AdMgr.setProvider 未调用）→ 开发兜底按「看完」处理`);
            return Promise.resolve(true);
        }
        if (this.provider.isAvailable && !this.provider.isAvailable(placement)) {
            LogMgr.warn(`[广告] ${placement}：当前不可用（平台返回 false）`);
            return Promise.resolve(false);
        }

        this.playing = true;
        return this.provider.showRewardVideo(placement)
            .then((ok) => !!ok)
            .catch((err) => {
                LogMgr.err(`[广告] ${placement}：拉起失败`, err);
                return false;
            })
            .then((ok) => {
                this.playing = false;
                return ok;
            });
    }
}
