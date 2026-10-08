"use strict";
/**
 * 「运行预览」（编辑器里的 game view）的**只读探针**。
 *
 * ## ⛔ 这个模块**不再开关预览**（2026-10-08 撤掉）
 *
 * 这里曾经有第三件事：`play` / `stop` / `pause` / `resume` / `step` 五个动作
 * （走 `Editor.Message.send` + 场景进程直调 `cce.PreviewPlay`）。**整条撤了**，
 * 因为它与**编辑器那块画布黑掉**的两次现场都在同一条时间线上，而它换来的能力在本工程几乎为零：
 *
 * | 时间 | 现场 |
 * |---|---|
 * | 2026-10-08 04:48 | `真机验收2.md` R6 跑完（含两次 `cce.PreviewPlay` 起停 + 抓图重绘）后，场景面板**画面停住**、切场景也不更新，**只有重启编辑器**恢复；`docs/冻结诊断.md` |
 * | 2026-10-08 14:59 | 面板 agent 加 `Cmp_Game` 那次会话里，同一块画布抓回来的是**全空的一张图**（`blankRatio 0.988`），用户看到的就是**黑屏** |
 *
 * 「预览」本身在这台真机上也**没什么用**：编辑器内跑起来后卡在首场景 `Loading` 的
 * `loadBundle('scripts')`（`0%`，既不成功也不失败，`cc.assetManager.bundles` 里只有 `internal`），
 * 也就是**在本工程里它根本进不了游戏**。
 *
 * ⇒ 现在只剩**只读**：`querySceneMode()` 问一句「场景现在处在哪个模式」。
 * 要跑游戏请人在编辑器工具栏上自己按那颗播放键 —— 那条路与本扩展无关，
 * 出了画面问题也不会有人以为是工具干的。
 *
 * ## 留下的这条只读路（三条诚实口径）
 *
 * 1. **不猜模式**：`query-scene-mode` 回来什么就报什么；只有落在已知那四个串上才归一成
 *    `mode`，否则 `'unknown'` + 原值（编辑器换版本时立刻看得见，而不是安静地猜错）。
 * 2. **失败不吞**：消息抛错就把编辑器原文放进 `error` —— 「这个版本的编辑器没有这条消息」
 *    与「预览没在跑」是两件事，不许混成一句。
 *    ⚠ 顺带一条**如实记下的事实**：`query-scene-mode` 这条消息在编辑器安装里**只有声明、没有任何调用方**
 *    （`builtin/scene/package.json:2038` 是它唯一出现的地方，`@types/message.d.ts` 里也没有它的类型），
 *    所以「它会回 `SceneModeType` 那几个字符串」只是**从 `queryMode()` 的签名推的、没被证实**。
 *    正因为这样，本模块**只把它当一条来源**：回什么就报什么，认不出就 `unknown`，
 *    而运行态的**真判据**是场景进程那条独立来源（`cce.PreviewPlay._state`，见 `source/scene.ts` 的
 *    `readSceneMode`）—— 它只读，不碰任何状态。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCENE_MODES = void 0;
exports.querySceneMode = querySceneMode;
/** 编辑器场景的四种模式（`@types/cce/3d/facade/scene-facade-state-interface.d.ts` 的 `SceneModeType`）。 */
exports.SCENE_MODES = ['general', 'prefab', 'animation', 'preview'];
function describe(error) {
    if (error instanceof Error)
        return error.message;
    if (error && typeof error === 'object') {
        const anyErr = error;
        if (typeof anyErr.message === 'string')
            return anyErr.message;
    }
    return String(error);
}
/** 问 scene 包一句话（**不抛**：失败也回成 `{ok:false, error}`）。 */
async function askScene(message) {
    try {
        const value = await Editor.Message.request('scene', message);
        return { ok: true, value };
    }
    catch (err) {
        return { ok: false, error: describe(err) };
    }
}
/**
 * 问「场景现在是什么模式」。**只读**：这条消息不改任何状态。
 *
 * @returns `mode` 只在那四个已知串上才有值；否则 `'unknown'` + `note` + 原值。
 */
async function querySceneMode() {
    const outcome = await askScene('query-scene-mode');
    const raw = typeof outcome.value === 'string' ? outcome.value.trim() : null;
    if (!outcome.ok) {
        return { ...outcome, mode: 'unknown', raw, note: '这条消息没问通（见 error）—— 模式未知' };
    }
    const hit = raw !== null ? exports.SCENE_MODES.find((mode) => mode === raw) : undefined;
    if (hit)
        return { ...outcome, mode: hit, raw };
    return {
        ...outcome,
        mode: 'unknown',
        raw,
        note: raw === null ? `这条消息回的不是一个字符串：${JSON.stringify(outcome.value)}` : `模式串认不出来（${JSON.stringify(raw)}）`,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJldmlldy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9wcmV2aWV3LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQWtDRzs7O0FBbURILHdDQWNDO0FBL0RELDhGQUE4RjtBQUNqRixRQUFBLFdBQVcsR0FBRyxDQUFDLFNBQVMsRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFNBQVMsQ0FBVSxDQUFDO0FBd0JsRixTQUFTLFFBQVEsQ0FBQyxLQUFjO0lBQzVCLElBQUksS0FBSyxZQUFZLEtBQUs7UUFBRSxPQUFPLEtBQUssQ0FBQyxPQUFPLENBQUM7SUFDakQsSUFBSSxLQUFLLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDckMsTUFBTSxNQUFNLEdBQUcsS0FBOEIsQ0FBQztRQUM5QyxJQUFJLE9BQU8sTUFBTSxDQUFDLE9BQU8sS0FBSyxRQUFRO1lBQUUsT0FBTyxNQUFNLENBQUMsT0FBTyxDQUFDO0lBQ2xFLENBQUM7SUFDRCxPQUFPLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUN6QixDQUFDO0FBRUQsc0RBQXNEO0FBQ3RELEtBQUssVUFBVSxRQUFRLENBQUMsT0FBZTtJQUNuQyxJQUFJLENBQUM7UUFDRCxNQUFNLEtBQUssR0FBRyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxPQUFPLENBQUMsQ0FBQztRQUM3RCxPQUFPLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsQ0FBQztJQUMvQixDQUFDO0lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNYLE9BQU8sRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxRQUFRLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztJQUMvQyxDQUFDO0FBQ0wsQ0FBQztBQUVEOzs7O0dBSUc7QUFDSSxLQUFLLFVBQVUsY0FBYztJQUNoQyxNQUFNLE9BQU8sR0FBRyxNQUFNLFFBQVEsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0lBQ25ELE1BQU0sR0FBRyxHQUFHLE9BQU8sT0FBTyxDQUFDLEtBQUssS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUM1RSxJQUFJLENBQUMsT0FBTyxDQUFDLEVBQUUsRUFBRSxDQUFDO1FBQ2QsT0FBTyxFQUFFLEdBQUcsT0FBTyxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsR0FBRyxFQUFFLElBQUksRUFBRSx5QkFBeUIsRUFBRSxDQUFDO0lBQ2pGLENBQUM7SUFDRCxNQUFNLEdBQUcsR0FBRyxHQUFHLEtBQUssSUFBSSxDQUFDLENBQUMsQ0FBQyxtQkFBVyxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7SUFDaEYsSUFBSSxHQUFHO1FBQUUsT0FBTyxFQUFFLEdBQUcsT0FBTyxFQUFFLElBQUksRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLENBQUM7SUFDL0MsT0FBTztRQUNILEdBQUcsT0FBTztRQUNWLElBQUksRUFBRSxTQUFTO1FBQ2YsR0FBRztRQUNILElBQUksRUFBRSxHQUFHLEtBQUssSUFBSSxDQUFDLENBQUMsQ0FBQyxpQkFBaUIsSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsV0FBVyxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxHQUFHO0tBQzVHLENBQUM7QUFDTixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiDjgIzov5DooYzpooTop4jjgI3vvIjnvJbovpHlmajph4znmoQgZ2FtZSB2aWV377yJ55qEKirlj6ror7vmjqLpkogqKuOAglxuICpcbiAqICMjIOKblCDov5nkuKrmqKHlnZcqKuS4jeWGjeW8gOWFs+mihOiniCoq77yIMjAyNi0xMC0wOCDmkqTmjonvvIlcbiAqXG4gKiDov5nph4zmm77nu4/mnInnrKzkuInku7bkuovvvJpgcGxheWAgLyBgc3RvcGAgLyBgcGF1c2VgIC8gYHJlc3VtZWAgLyBgc3RlcGAg5LqU5Liq5Yqo5L2cXG4gKiDvvIjotbAgYEVkaXRvci5NZXNzYWdlLnNlbmRgICsg5Zy65pmv6L+b56iL55u06LCDIGBjY2UuUHJldmlld1BsYXlg77yJ44CCKirmlbTmnaHmkqTkuoYqKu+8jFxuICog5Zug5Li65a6D5LiOKirnvJbovpHlmajpgqPlnZfnlLvluIPpu5HmjokqKueahOS4pOasoeeOsOWcuumDveWcqOWQjOS4gOadoeaXtumXtOe6v+S4iu+8jOiAjOWug+aNouadpeeahOiDveWKm+WcqOacrOW3peeoi+WHoOS5juS4uumbtu+8mlxuICpcbiAqIHwg5pe26Ze0IHwg546w5Zy6IHxcbiAqIHwtLS18LS0tfFxuICogfCAyMDI2LTEwLTA4IDA0OjQ4IHwgYOecn+acuumqjOaUtjIubWRgIFI2IOi3keWujO+8iOWQq+S4pOasoSBgY2NlLlByZXZpZXdQbGF5YCDotbflgZwgKyDmipPlm77ph43nu5jvvInlkI7vvIzlnLrmma/pnaLmnb8qKueUu+mdouWBnOS9jyoq44CB5YiH5Zy65pmv5Lmf5LiN5pu05paw77yMKirlj6rmnInph43lkK/nvJbovpHlmagqKuaBouWkje+8m2Bkb2NzL+WGu+e7k+iviuaWrS5tZGAgfFxuICogfCAyMDI2LTEwLTA4IDE0OjU5IHwg6Z2i5p2/IGFnZW50IOWKoCBgQ21wX0dhbWVgIOmCo+asoeS8muivnemHjO+8jOWQjOS4gOWdl+eUu+W4g+aKk+WbnuadpeeahOaYryoq5YWo56m655qE5LiA5byg5Zu+KirvvIhgYmxhbmtSYXRpbyAwLjk4OGDvvInvvIznlKjmiLfnnIvliLDnmoTlsLHmmK8qKum7keWxjyoqIHxcbiAqXG4gKiDjgIzpooTop4jjgI3mnKzouqvlnKjov5nlj7DnnJ/mnLrkuIrkuZ8qKuayoeS7gOS5iOeUqCoq77ya57yW6L6R5Zmo5YaF6LeR6LW35p2l5ZCO5Y2h5Zyo6aaW5Zy65pmvIGBMb2FkaW5nYCDnmoRcbiAqIGBsb2FkQnVuZGxlKCdzY3JpcHRzJylg77yIYDAlYO+8jOaXouS4jeaIkOWKn+S5n+S4jeWksei0pe+8jGBjYy5hc3NldE1hbmFnZXIuYnVuZGxlc2Ag6YeM5Y+q5pyJIGBpbnRlcm5hbGDvvInvvIxcbiAqIOS5n+WwseaYryoq5Zyo5pys5bel56iL6YeM5a6D5qC55pys6L+b5LiN5LqG5ri45oiPKirjgIJcbiAqXG4gKiDih5Ig546w5Zyo5Y+q5YmpKirlj6ror7sqKu+8mmBxdWVyeVNjZW5lTW9kZSgpYCDpl67kuIDlj6XjgIzlnLrmma/njrDlnKjlpITlnKjlk6rkuKrmqKHlvI/jgI3jgIJcbiAqIOimgei3kea4uOaIj+ivt+S6uuWcqOe8lui+keWZqOW3peWFt+agj+S4iuiHquW3seaMiemCo+mil+aSreaUvumUriDigJTigJQg6YKj5p2h6Lev5LiO5pys5omp5bGV5peg5YWz77yMXG4gKiDlh7rkuobnlLvpnaLpl67popjkuZ/kuI3kvJrmnInkurrku6XkuLrmmK/lt6XlhbflubLnmoTjgIJcbiAqXG4gKiAjIyDnlZnkuIvnmoTov5nmnaHlj6ror7vot6/vvIjkuInmnaHor5rlrp7lj6PlvoTvvIlcbiAqXG4gKiAxLiAqKuS4jeeMnOaooeW8jyoq77yaYHF1ZXJ5LXNjZW5lLW1vZGVgIOWbnuadpeS7gOS5iOWwseaKpeS7gOS5iO+8m+WPquacieiQveWcqOW3suefpemCo+Wbm+S4quS4suS4iuaJjeW9kuS4gOaIkFxuICogICAgYG1vZGVg77yM5ZCm5YiZIGAndW5rbm93bidgICsg5Y6f5YC877yI57yW6L6R5Zmo5o2i54mI5pys5pe256uL5Yi755yL5b6X6KeB77yM6ICM5LiN5piv5a6J6Z2Z5Zyw54yc6ZSZ77yJ44CCXG4gKiAyLiAqKuWksei0peS4jeWQnioq77ya5raI5oGv5oqb6ZSZ5bCx5oqK57yW6L6R5Zmo5Y6f5paH5pS+6L+bIGBlcnJvcmAg4oCU4oCUIOOAjOi/meS4queJiOacrOeahOe8lui+keWZqOayoeaciei/meadoea2iOaBr+OAjVxuICogICAg5LiO44CM6aKE6KeI5rKh5Zyo6LeR44CN5piv5Lik5Lu25LqL77yM5LiN6K645re35oiQ5LiA5Y+l44CCXG4gKiAgICDimqAg6aG65bim5LiA5p2hKirlpoLlrp7orrDkuIvnmoTkuovlrp4qKu+8mmBxdWVyeS1zY2VuZS1tb2RlYCDov5nmnaHmtojmga/lnKjnvJbovpHlmajlronoo4Xph4wqKuWPquacieWjsOaYjuOAgeayoeacieS7u+S9leiwg+eUqOaWuSoqXG4gKiAgICDvvIhgYnVpbHRpbi9zY2VuZS9wYWNrYWdlLmpzb246MjAzOGAg5piv5a6D5ZSv5LiA5Ye6546w55qE5Zyw5pa577yMYEB0eXBlcy9tZXNzYWdlLmQudHNgIOmHjOS5n+ayoeacieWug+eahOexu+Wei++8ie+8jFxuICogICAg5omA5Lul44CM5a6D5Lya5ZueIGBTY2VuZU1vZGVUeXBlYCDpgqPlh6DkuKrlrZfnrKbkuLLjgI3lj6rmmK8qKuS7jiBgcXVlcnlNb2RlKClgIOeahOetvuWQjeaOqOeahOOAgeayoeiiq+ivgeWunioq44CCXG4gKiAgICDmraPlm6DkuLrov5nmoLfvvIzmnKzmqKHlnZcqKuWPquaKiuWug+W9k+S4gOadoeadpea6kCoq77ya5Zue5LuA5LmI5bCx5oql5LuA5LmI77yM6K6k5LiN5Ye65bCxIGB1bmtub3duYO+8jFxuICogICAg6ICM6L+Q6KGM5oCB55qEKirnnJ/liKTmja4qKuaYr+WcuuaZr+i/m+eoi+mCo+adoeeLrOeri+adpea6kO+8iGBjY2UuUHJldmlld1BsYXkuX3N0YXRlYO+8jOingSBgc291cmNlL3NjZW5lLnRzYCDnmoRcbiAqICAgIGByZWFkU2NlbmVNb2RlYO+8ieKAlOKAlCDlroPlj6ror7vvvIzkuI3norDku7vkvZXnirbmgIHjgIJcbiAqL1xuXG4vKiog57yW6L6R5Zmo5Zy65pmv55qE5Zub56eN5qih5byP77yIYEB0eXBlcy9jY2UvM2QvZmFjYWRlL3NjZW5lLWZhY2FkZS1zdGF0ZS1pbnRlcmZhY2UuZC50c2Ag55qEIGBTY2VuZU1vZGVUeXBlYO+8ieOAgiAqL1xuZXhwb3J0IGNvbnN0IFNDRU5FX01PREVTID0gWydnZW5lcmFsJywgJ3ByZWZhYicsICdhbmltYXRpb24nLCAncHJldmlldyddIGFzIGNvbnN0O1xuXG4vKiog5b2S5LiA5LmL5ZCO55qE5qih5byP77yb6K6k5LiN5Ye65p2l5bCx5pivIGAndW5rbm93bidg44CCICovXG5leHBvcnQgdHlwZSBTY2VuZU1vZGUgPSAodHlwZW9mIFNDRU5FX01PREVTKVtudW1iZXJdIHwgJ3Vua25vd24nO1xuXG4vKiog5LiA5p2hIHNjZW5lIOa2iOaBr+eahOWbnuaJp++8iOWksei0peS5n+Wbnu+8jOS4jeaKm++8ieOAgiAqL1xuZXhwb3J0IGludGVyZmFjZSBNZXNzYWdlT3V0Y29tZSB7XG4gICAgb2s6IGJvb2xlYW47XG4gICAgLyoqIOa2iOaBr+eahOi/lOWbnuWAvOWOn+aWh++8iGBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0YCDnmoTov5Tlm57vvIkgKi9cbiAgICB2YWx1ZT86IHVua25vd247XG4gICAgLyoqIOWksei0peaXtue8lui+keWZqOeahOWOn+aWhyAqL1xuICAgIGVycm9yPzogc3RyaW5nO1xufVxuXG4vKiog5qih5byP55qE5o6i6ZKI57uT5p6c77yaKirljp/lp4vlgLwgKyDlvZLkuIDlgLwgKyDkuLrku4DkuYjkuI3lvZLkuIAqKuOAgiAqL1xuZXhwb3J0IGludGVyZmFjZSBTY2VuZU1vZGVQcm9iZSBleHRlbmRzIE1lc3NhZ2VPdXRjb21lIHtcbiAgICAvKiog5b2S5LiA5ZCO55qE5qih5byPICovXG4gICAgbW9kZTogU2NlbmVNb2RlO1xuICAgIC8qKiBgdmFsdWVgIOaYr+Wtl+espuS4suaXtueahOWOn+aWh++8iOayoeacieWwseaYryBudWxs77yJICovXG4gICAgcmF3OiBzdHJpbmcgfCBudWxsO1xuICAgIC8qKiDorqTkuI3lh7rmnaXml7bnmoTor7TmmI7vvIjorqTlvpflh7rmnaXlsLHmmK8gdW5kZWZpbmVk77yJICovXG4gICAgbm90ZT86IHN0cmluZztcbn1cblxuZnVuY3Rpb24gZGVzY3JpYmUoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSByZXR1cm4gZXJyb3IubWVzc2FnZTtcbiAgICBpZiAoZXJyb3IgJiYgdHlwZW9mIGVycm9yID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCBhbnlFcnIgPSBlcnJvciBhcyB7IG1lc3NhZ2U/OiB1bmtub3duIH07XG4gICAgICAgIGlmICh0eXBlb2YgYW55RXJyLm1lc3NhZ2UgPT09ICdzdHJpbmcnKSByZXR1cm4gYW55RXJyLm1lc3NhZ2U7XG4gICAgfVxuICAgIHJldHVybiBTdHJpbmcoZXJyb3IpO1xufVxuXG4vKiog6ZeuIHNjZW5lIOWMheS4gOWPpeivne+8iCoq5LiN5oqbKirvvJrlpLHotKXkuZ/lm57miJAgYHtvazpmYWxzZSwgZXJyb3J9YO+8ieOAgiAqL1xuYXN5bmMgZnVuY3Rpb24gYXNrU2NlbmUobWVzc2FnZTogc3RyaW5nKTogUHJvbWlzZTxNZXNzYWdlT3V0Y29tZT4ge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCBtZXNzYWdlKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlIH07XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGRlc2NyaWJlKGVycikgfTtcbiAgICB9XG59XG5cbi8qKlxuICog6Zeu44CM5Zy65pmv546w5Zyo5piv5LuA5LmI5qih5byP44CN44CCKirlj6ror7sqKu+8mui/meadoea2iOaBr+S4jeaUueS7u+S9leeKtuaAgeOAglxuICpcbiAqIEByZXR1cm5zIGBtb2RlYCDlj6rlnKjpgqPlm5vkuKrlt7Lnn6XkuLLkuIrmiY3mnInlgLzvvJvlkKbliJkgYCd1bmtub3duJ2AgKyBgbm90ZWAgKyDljp/lgLzjgIJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHF1ZXJ5U2NlbmVNb2RlKCk6IFByb21pc2U8U2NlbmVNb2RlUHJvYmU+IHtcbiAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgYXNrU2NlbmUoJ3F1ZXJ5LXNjZW5lLW1vZGUnKTtcbiAgICBjb25zdCByYXcgPSB0eXBlb2Ygb3V0Y29tZS52YWx1ZSA9PT0gJ3N0cmluZycgPyBvdXRjb21lLnZhbHVlLnRyaW0oKSA6IG51bGw7XG4gICAgaWYgKCFvdXRjb21lLm9rKSB7XG4gICAgICAgIHJldHVybiB7IC4uLm91dGNvbWUsIG1vZGU6ICd1bmtub3duJywgcmF3LCBub3RlOiAn6L+Z5p2h5raI5oGv5rKh6Zeu6YCa77yI6KeBIGVycm9y77yJ4oCU4oCUIOaooeW8j+acquefpScgfTtcbiAgICB9XG4gICAgY29uc3QgaGl0ID0gcmF3ICE9PSBudWxsID8gU0NFTkVfTU9ERVMuZmluZCgobW9kZSkgPT4gbW9kZSA9PT0gcmF3KSA6IHVuZGVmaW5lZDtcbiAgICBpZiAoaGl0KSByZXR1cm4geyAuLi5vdXRjb21lLCBtb2RlOiBoaXQsIHJhdyB9O1xuICAgIHJldHVybiB7XG4gICAgICAgIC4uLm91dGNvbWUsXG4gICAgICAgIG1vZGU6ICd1bmtub3duJyxcbiAgICAgICAgcmF3LFxuICAgICAgICBub3RlOiByYXcgPT09IG51bGwgPyBg6L+Z5p2h5raI5oGv5Zue55qE5LiN5piv5LiA5Liq5a2X56ym5Liy77yaJHtKU09OLnN0cmluZ2lmeShvdXRjb21lLnZhbHVlKX1gIDogYOaooeW8j+S4suiupOS4jeWHuuadpe+8iCR7SlNPTi5zdHJpbmdpZnkocmF3KX3vvIlgLFxuICAgIH07XG59XG4iXX0=