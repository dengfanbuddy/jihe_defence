import { resources, SpriteAtlas, SpriteFrame } from 'cc';

/**
 * 图标加载（**图集优先 + 三级降级**）—— 全工程图标消费者共用的**唯一实现**。
 *
 * ── 为什么要三层 ──
 * 图标集（`textures/relics`、`textures/skills`）已从「一堆碎图」改成 Cocos 的**图集资源 Atlas**
 * （TexturePacker 的 `plist` + 同名 `png` 一对，如 `textures/skills/skills.plist` + `skills.png`）。
 * 但配表里的 `icon` 列**一直是不带扩展名的相对路径**（`textures/skills/split_shot`），一个字都不用改 ——
 * 帧名取路径主干（`split_shot`），图集路径由目录反推（`textures/skills/skills`）。
 *
 * ⚠ `skills.plist` 与 `skills.png` **同名** → "去掉扩展名的路径"**不唯一**：
 * 哪个资产保留干净路径、哪个被补上扩展名，由构建/预览的资源表去歧义，**没有公开契约**。
 * 所以每一层都列了候选、按顺序试，第一个成功的就是答案；并且会把"**是哪个候选命中的**"打进日志
 * （`ezgame.info`，每张图集每条路只报一次）—— 那是唯一能观察到真实路径表的办法。
 * 详见 `docs/relic-icon/README.md` §7.4.5。
 *
 * ── 三级降级（任一层命中即返回）──
 *   ① **图集本体**：`resources.load(<base> 或 <base>.plist, SpriteAtlas)` → `atlas.getSpriteFrame(帧名)`
 *      （导入产物里 `spriteFrames` 的键 = 碎图文件名**去扩展名**，所以帧名不带 `.png`）；
 *   ② **直取帧子资源**：`<base>.plist/<帧名>` / `<base>/<帧名>`（帧本身也是可寻址子资源）；
 *   ③ **旧口径碎图**：`<icon 路径>/spriteFrame` —— 图集被删 / 回退成碎图方案时界面不会变空白，
 *      而且**故意不成图集**的图（`textures/skills/bullet.png` 占位图）本来就该走这条。
 *
 * ── 用法 ──
 * ```ts
 * AtlasIcon.loadIconFrame('textures/skills/split_shot').then((sf) => {
 *     if (sf) sprite.spriteFrame = sf;   // 全失败是 null，不是 reject —— 由调用方决定怎么办
 * });
 * ```
 * 只管 **resources 内的本地路径**；远程 URL（`http(s)://`）不走这里
 * （见 `ShopRelicsItem.loadIcon` 的 `ezgame.res.loadRemoteFrame` 分支）。
 */
export class AtlasIcon {

    /**
     * 解析一个 `icon` 值 → SpriteFrame。**全失败 resolve(null)，永不 reject** ——
     * 调用方自己决定是报错、留占位图还是清空（本函数不碰任何节点）。
     *
     * **按 `icon` 值缓存结果（含失败）**：列表类 UI（局外遗物图鉴 37 行）每次显示都会重建整列，
     * 不缓存就会把同一批图反复 `resources.load` 一遍。缓存放这一层而不是各调用方 ——
     * 图集本体的缓存在这里，帧的缓存理应也在同一层（否则每个消费者各写一份、各自过期）。
     */
    static loadIconFrame(iconPath: string): Promise<SpriteFrame | null> {
        if (!iconPath) return Promise.resolve(null);
        let promise = AtlasIcon.framePromises.get(iconPath);
        if (!promise) {
            promise = AtlasIcon.resolveIconFrame(iconPath);
            AtlasIcon.framePromises.set(iconPath, promise);
        }
        return promise;
    }

    /** 真正的三级降级实现（缓存由 `loadIconFrame` 负责） */
    private static resolveIconFrame(iconPath: string): Promise<SpriteFrame | null> {
        const base = AtlasIcon.atlasBaseOf(iconPath);
        const key = AtlasIcon.frameKeyOf(iconPath);
        if (!base) {
            // 没有斜杠 → 反推不出图集路径，直接落到第 ③ 步（旧碎图）
            return AtlasIcon.tryLoose(iconPath, iconPath, key);
        }

        return AtlasIcon.ensureAtlas(base).then((atlas) => {
            // ① 图集本体
            const sf = atlas && atlas.getSpriteFrame(key);
            if (sf) {
                AtlasIcon.reportHit(base, '图集本体', base, key);
                return sf;
            }
            // ② 直取帧子资源 → ③ 旧碎图
            const candidates = [`${base}.plist/${key}`, `${base}/${key}`];
            return AtlasIcon.tryPaths(candidates, base, '图集帧子资源', key).then((hit) => {
                return hit ? hit : AtlasIcon.tryLoose(iconPath, base, key);
            });
        });
    }

    /* ===================================================================
     * 内部实现
     * =================================================================== */

    /** 日志前缀（共用实现 → 不再挂 `[遗物面板]` / `[技能槽]` 那种宿主前缀） */
    private static readonly LOG_TAG = '[图标]';

    /**
     * 图集本体缓存：图集路径 → 加载 promise。
     * **加载中 / 加载失败都缓存 promise** —— 失败的也留在 map 里，这样一个缺失的图集
     * 只会在全进程里被尝试一次，而不是每个图标都重试一遍（300+ 个图标就是 300+ 次白试）。
     */
    private static readonly atlasPromises: Map<string, Promise<SpriteAtlas | null>> = new Map<string, Promise<SpriteAtlas | null>>();

    /**
     * 帧缓存：`icon` 值 → 解析 promise（**含解析失败的**）。
     * 失败的也留着，这样一个不存在的 icon 只会被尝试一次，而不是每次重建列表都重试。
     */
    private static readonly framePromises: Map<string, Promise<SpriteFrame | null>> = new Map<string, Promise<SpriteFrame | null>>();

    /** 已报过「命中哪条路」的组合（图集 + 层），**每张图集的每条路只报一次**，不随图标刷屏 */
    private static readonly hitReported: Set<string> = new Set<string>();

    /**
     * 从 `icon` 路径取**帧名**：`textures/skills/split_shot` → `split_shot`。
     * 图集里帧的键就是碎图文件名去扩展名（实测导入产物 `library/<uuid>.json` 的 `spriteFrames` 键是
     * `abyssal_blade` 而非 `abyssal_blade.png`），所以这里**不能**带扩展名。
     */
    private static frameKeyOf(iconPath: string): string {
        const i = iconPath.lastIndexOf('/');
        return i >= 0 ? iconPath.slice(i + 1) : iconPath;
    }

    /**
     * 从 `icon` 路径反推**图集路径**（单一条通用规则）：
     * `textures/<dir>/<stem>` → `textures/<dir>/<dir>`。
     *
     *   · `textures/skills/split_shot`     → `textures/skills/skills`
     *   · `textures/relics/quelling_blade` → `textures/relics/relics`
     *
     * 没有斜杠（凑不出目录名）→ 返回空串，调用方直接跳到第 ③ 步。
     */
    private static atlasBaseOf(iconPath: string): string {
        const slash = iconPath.lastIndexOf('/');
        if (slash <= 0) return '';
        const dir = iconPath.slice(0, slash);          // textures/skills
        const dirSlash = dir.lastIndexOf('/');
        const leaf = dirSlash >= 0 ? dir.slice(dirSlash + 1) : dir;   // skills
        return leaf ? `${dir}/${leaf}` : '';
    }

    /**
     * 取图集本体（**每个图集路径只加载一次**，见 `atlasPromises`）。
     * 拿不到就 resolve(null)、**不抛错** —— 调用方会继续走直取帧 / 旧碎图路径。
     */
    private static ensureAtlas(base: string): Promise<SpriteAtlas | null> {
        let promise = AtlasIcon.atlasPromises.get(base);
        if (!promise) {
            promise = AtlasIcon.loadAtlasFrom(base, 0);
            AtlasIcon.atlasPromises.set(base, promise);
        }
        return promise;
    }

    /**
     * 依次试图集本体的候选路径（`<base>` 与 `<base>.plist`，见类头 ⚠）。
     * 全试完 → 警告一次并 resolve(null)（promise 已被缓存，所以不会重复警告）。
     */
    private static loadAtlasFrom(base: string, index: number): Promise<SpriteAtlas | null> {
        const candidates = [base, `${base}.plist`];
        if (index >= candidates.length) {
            ezgame.warn(`${AtlasIcon.LOG_TAG} 图集没取到：${base}（改走直取帧 / 旧碎图路径）`);
            return Promise.resolve(null);
        }
        const path = candidates[index];
        return new Promise<SpriteAtlas | null>((resolve) => {
            resources.load(path, SpriteAtlas, (err, atlas) => {
                if (!err && atlas) {
                    ezgame.info(`${AtlasIcon.LOG_TAG} 图集已加载：${path}（${atlas.getSpriteFrames().length} 帧）`);
                    resolve(atlas);
                    return;
                }
                AtlasIcon.loadAtlasFrom(base, index + 1).then(resolve);
            });
        });
    }

    /** 依次试路径，返回第一个能加载成 SpriteFrame 的（全失败 → null） */
    private static tryPaths(paths: string[], tag: string, kind: string, key: string): Promise<SpriteFrame | null> {
        if (!paths.length) return Promise.resolve(null);
        const head = paths[0];
        const rest = paths.slice(1);
        return new Promise<SpriteFrame | null>((resolve) => {
            resources.load(head, SpriteFrame, (err, sf) => {
                if (!err && sf) {
                    AtlasIcon.reportHit(tag, kind, head, key);
                    resolve(sf);
                    return;
                }
                AtlasIcon.tryPaths(rest, tag, kind, key).then(resolve);
            });
        });
    }

    /** 第 ③ 步（旧口径）：`<icon 路径>/spriteFrame`（碎图） */
    private static tryLoose(iconPath: string, tag: string, key: string): Promise<SpriteFrame | null> {
        return AtlasIcon.tryPaths([`${iconPath}/spriteFrame`], tag, '旧碎图', key);
    }

    /**
     * 「哪条路命中」**每张图集的每条路只报一次**（不是每个图标一次）——
     * 用来确认真实资源路径表长什么样：全走 `图集本体` 说明图集正常；
     * 出现 `旧碎图` 说明图集没生效或该图本来就不在图集里。
     */
    private static reportHit(tag: string, kind: string, how: string, key: string): void {
        const slot = `${tag}|${kind}`;
        if (AtlasIcon.hitReported.has(slot)) return;
        AtlasIcon.hitReported.add(slot);
        ezgame.info(`${AtlasIcon.LOG_TAG} 图标命中路径：${kind}（${how}）｜首个帧名：${key}`);
    }
}
