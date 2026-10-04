/**
 * 中文文案 —— 菜单路径 `i18n:menu.panel/dsh_chat` 的解。
 *
 * 为什么必须有：`package.json` 的 `contributions.menu` 用 `i18n:` 前缀寻址，
 * 而扩展原本**没有 i18n 目录** → 菜单组名会显示成原始 key（功能可用但很难看）。
 */
module.exports = {
    menu: {
        panel: {
            dsh_chat: 'DSH',
        },
    },
};
