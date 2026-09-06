# Cocos MCP Extension Architecture

> Generated: 2026-06-29T17:21:01.069Z

| File | Size | Obfuscated | Decoder | Strings | Exports |
|------|------|-----------|---------|---------|---------|
| 🔒 auth/server-config.js | 25.0KB | Yes | _0x2bf8 | 20 | isAuthDisabled, getAuthConfig |
| 🔒 auth/device-identity.js | 90.1KB | Yes | _0x238f | 112 | getAppDataDir, getDeviceInfo, getStableMachineId, resetDeviceIdentity |
| 🔒 auth/license-manager.js | 128.7KB | Yes | _0x3313 | 152 | LicenseManager |
| 🔒 auth/update-checker.js | 41.3KB | Yes | _0xa58a | 58 | getSkippedVersion, setSkippedVersion, clearSkippedVersion, checkForUpdate, checkForUpdateWithSkip |
| 🔒 main.js | 130.6KB | Yes | _0x5afa | 164 | methods, load, unload |
| 🔒 mcp-server.js | 219.3KB | Yes | _0xd9bd | 227 | MCPServer |
| 🔒 mcp-client-configs.js | 36.6KB | Yes | _0x3077 | 86 | MCP_CLIENTS, generateJSONConfig, generateTOMLConfig, generateCLICommand, getConfigFilePath |
| 🔒 mcp-config-manager.js | 81.7KB | Yes | _0x48f4 | 147 | MCPConfigManager |
| ❌ scene.js | 52.1KB | Yes | _0x529b | 0 | - |
| 🔒 settings.js | 38.9KB | Yes | _0x1d03 | 84 | DEFAULT_SETTINGS, DEFAULT_TOOL_MANAGER_SETTINGS, readSettings, saveSettings, readToolManagerSettings, saveToolManagerSettings, exportToolConfiguration, importToolConfiguration, getInstalledVersion, saveVersionMarker, clearProjectConfigs |
| 🔒 tools/server-tools.js | 71.4KB | Yes | _0x47db | 104 | ServerTools |
| 🔒 tools/tool-manager.js | 89.2KB | Yes | _0x19c4 | 125 | ToolManager |
| 🔒 tools/node-tools.js | 485.8KB | Yes | _0x51dd | 131 | NodeTools |
| 🔒 tools/scene-tools.js | 138.4KB | Yes | _0x5202 | 120 | SceneTools |
| 🔒 tools/scene-view-tools.js | 137.8KB | Yes | _0x26b5 | 167 | SceneViewTools |
| 🔒 tools/component-tools.js | 618.6KB | Yes | _0x1a28 | 170 | ComponentTools |
| 🔒 tools/project-tools.js | 131.6KB | Yes | _0x305b | 97 | ProjectTools |
| 🔒 tools/prefab-tools.js | 587.3KB | Yes | _0x5e9c | 280 | PrefabTools |
| 🔒 tools/preferences-tools.js | 171.9KB | Yes | _0x5ac8 | 118 | PreferencesTools |
| 🔒 tools/reference-image-tools.js | 130.8KB | Yes | _0x9df6 | 69 | ReferenceImageTools |
| 🔒 tools/debug-tools.js | 79.1KB | Yes | _0x37da | 85 | DebugTools |
| 🔒 tools/asset-advanced-tools.js | 190.9KB | Yes | _0x2306 | 146 | AssetAdvancedTools |
| 🔒 tools/cocos/cocos-tools.js | 24.9KB | Yes | _0x5830 | 55 | CocosTools |
| 🔒 compat/api-adapter.js | 34.0KB | Yes | _0x2ddd | 34 | animationOperation, saveClipCache, queryComponentsList, queryAssets, trySetEditClip, tryChangeAnimationRoot, getCreatorAppBundlePaths, buildVersionedApiDocUrl, hasOctreeInfo, recordAnimation, saveAnimClip |
| 🔒 compat/version-detector.js | 36.2KB | Yes | _0x10bf | 49 | getCreatorVersion, initVersionDetector, destroyVersionDetector, isAtLeast, isV38OrAbove, getVersionSlug |
| ❌ panels/default/index.js | 169.2KB | Yes | _0x4f90 | 0 | - |
| ❌ panels/tool-manager/index.js | 124.8KB | Yes | _0x94ef | 0 | - |
| 🔒 types/index.js | 7.1KB | Yes | _0x5c61 | 14 | - |

---


## auth/server-config.js

- Size: 25.0KB
- Obfuscated: Yes
- Decoder: _0x2bf8
- Cache property: \x4f\x5a\x6d\x41\x68\x49
- Total decoded strings: 330

### Exports

| Name | Type | Value |
|------|------|-------|
| `isAuthDisabled` | function | false |
| `getAuthConfig` | function | {"serverUrl":"https://mcp.xman88.com","publicKey":"-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0HRbBcnlJIgMwDUGXfrTBkGqxoYzxBV2SqgNRglrzpOfnqgFvJtbZKJ4thXhwL/jpgSccOf6JjuBD |

### Decoded Strings (20 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 14 | `12833390jZVhta` |
| 2 | 13 | `5712687HMGVyH` |
| 3 | 13 | `1456668MTNtgo` |
| 4 | 12 | `221631JtxbpL` |
| 5 | 12 | `545654tYfIsH` |
| 6 | 10 | `4784GaEznb` |
| 7 | 10 | `2225wwsvlu` |
| 8 | 10 | `7539hdGiXL` |
| 9 | 9 | `504Jraapa` |
| 10 | 8 | `IN PUBLI` |
| 11 | 8 | `DF0Usa+g` |
| 12 | 8 | `I2jhCFlQ` |
| 13 | 8 | `22KhDZHj` |
| 14 | 8 | `getAuthC` |
| 15 | 7 | `8eevmfj` |
| 16 | 6 | `operty` |
| 17 | 5 | `|*3oO` |
| 18 | 5 | `kYiBc` |
| 19 | 5 | `v%5">` |
| 20 | 5 | `onfig` |

---

## auth/device-identity.js

- Size: 90.1KB
- Obfuscated: Yes
- Decoder: _0x238f
- Cache property: \x76\x44\x76\x68\x59\x43
- Total decoded strings: 2910

### Exports

| Name | Type | Value |
|------|------|-------|
| `getAppDataDir` | function | C:\Users\wx\AppData\Roaming\cocos-mcp |
| `getDeviceInfo` | function | {"machineId":"cdaded1cd730ee42d871d3143f80af5b78cdaefe7909cd4a7996e85c5beff182","hardwareHash":"1111507681edc327646b5178d7d19721","osInfo":"Microsoft Windows 10 רҵ�� 10.0.19045 (x64)","cocosVersion":" |
| `getStableMachineId` | function | cdaded1cd730ee42d871d3143f80af5b78cdaefe7909cd4a7996e85c5beff182 |
| `resetDeviceIdentity` | function |  |

### Decoded Strings (112 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `2360171HOlSnN` |
| 2 | 13 | `1835478QJeOwF` |
| 3 | 12 | `309316QQPxRu` |
| 4 | 12 | `123664BNRoVE` |
| 5 | 11 | `22023NbgSVL` |
| 6 | 11 | `92290GZiybs` |
| 7 | 9 | `269HuufTV` |
| 8 | 9 | `386dCgLKH` |
| 9 | 9 | `116KywubU` |
| 10 | 8 | `username` |
| 11 | 8 | `-product` |
| 12 | 8 | `odel\|Ch` |
| 13 | 8 | `__import` |
| 14 | 8 | `ed), kee` |
| 15 | 8 | `h] Devic` |
| 16 | 8 | `[MCP Aut` |
| 17 | 8 | `child_pr` |
| 18 | 8 | `orm GUID` |
| 19 | 8 | `roduct g` |
| 20 | 8 | `e identi` |
| 21 | 8 | `ion Supp` |
| 22 | 8 | `toString` |
| 23 | 8 | `ip Model` |
| 24 | 8 | `18VznlPd` |
| 25 | 8 | `hasOwnPr` |
| 26 | 8 | `l | grep` |
| 27 | 8 | `v/null |` |
| 28 | 8 | `10CifoyC` |
| 29 | 8 | `36bmiZct` |
| 30 | 8 | `__create` |
| 31 | 8 | `uleDefau` |
| 32 | 8 | `definePr` |
| 33 | 8 | `__esModu` |
| 34 | 8 | `getAppDa` |
| 35 | 8 | `getDevic` |
| 36 | 8 | `getStabl` |
| 37 | 8 | `eMachine` |
| 38 | 8 | `resetDev` |
| 39 | 8 | `iceIdent` |
| 40 | 8 | `getOwnPr` |
| 41 | 8 | `opertyNa` |
| 42 | 8 | `opertyDe` |
| 43 | 8 | `scriptor` |
| 44 | 8 | `.license` |
| 45 | 7 | `unknown` |
| 46 | 7 | `default` |
| 47 | 7 | `version` |
| 48 | 7 | ` error:` |
| 49 | 7 | `Binding` |
| 50 | 7 | `.device` |

---

## auth/license-manager.js

- Size: 128.7KB
- Obfuscated: Yes
- Decoder: _0x3313
- Cache property: \x48\x45\x57\x6c\x70\x65
- Total decoded strings: 3728

### Exports

| Name | Type | Value |
|------|------|-------|
| `LicenseManager` | function | Error: Class constructor _0x882c0b cannot be invoked without 'new' |

### Decoded Strings (152 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `1383535bzverR` |
| 2 | 13 | `1639224bVKQpz` |
| 3 | 12 | `628264wrgpsg` |
| 4 | 12 | `224627SwwbbI` |
| 5 | 12 | `439502xnAXbG` |
| 6 | 12 | `892292TjOfkw` |
| 7 | 11 | `16488GCURXc` |
| 8 | 10 | `3051hmlwKV` |
| 9 | 8 | `stopPeri` |
| 10 | 8 | `/api/coc` |
| 11 | 8 | `se initi` |
| 12 | 8 | `existsSy` |
| 13 | 8 | `se/activ` |
| 14 | 8 | `h] Faile` |
| 15 | 8 | `schedule` |
| 16 | 8 | `Network ` |
| 17 | 8 | `se/deact` |
| 18 | 8 | `on timeo` |
| 19 | 8 | `hasOwnPr` |
| 20 | 8 | `FromPack` |
| 21 | 8 | `disconne` |
| 22 | 8 | ` try aga` |
| 23 | 8 | `serverUr` |
| 24 | 8 | `handleDe` |
| 25 | 8 | `onlineCh` |
| 26 | 8 | ` invalid` |
| 27 | 8 | `connectS` |
| 28 | 8 | `initiali` |
| 29 | 8 | `h] Licen` |
| 30 | 8 | `isAuthDi` |
| 31 | 8 | `IsActive` |
| 32 | 8 | `vation e` |
| 33 | 8 | `ExpiryDa` |
| 34 | 8 | `clearLoc` |
| 35 | 8 | `d local ` |
| 36 | 8 | `viceRemo` |
| 37 | 8 | `_license` |
| 38 | 8 | `_storedL` |
| 39 | 8 | `_isLicen` |
| 40 | 8 | `s?licens` |
| 41 | 8 | `./device` |
| 42 | 8 | `__create` |
| 43 | 8 | `__setMod` |
| 44 | 8 | `uleDefau` |
| 45 | 8 | `__import` |
| 46 | 8 | `__esModu` |
| 47 | 8 | `LicenseM` |
| 48 | 8 | `getOwnPr` |
| 49 | 8 | `opertyNa` |
| 50 | 8 | `opertyDe` |

---

## auth/update-checker.js

- Size: 41.3KB
- Obfuscated: Yes
- Decoder: _0xa58a
- Cache property: \x68\x59\x6b\x53\x46\x4e
- Total decoded strings: 475

### Exports

| Name | Type | Value |
|------|------|-------|
| `getSkippedVersion` | function | null |
| `setSkippedVersion` | function |  |
| `clearSkippedVersion` | function |  |
| `checkForUpdate` | function | {} |
| `checkForUpdateWithSkip` | function | {} |

### Decoded Strings (58 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 14 | `19642192nnLQiL` |
| 2 | 13 | `1933032xcwTvh` |
| 3 | 13 | `2676849MzPOKf` |
| 4 | 13 | `5039956fktbEb` |
| 5 | 13 | `5598010KlquWk` |
| 6 | 13 | `3232691grgDrV` |
| 7 | 12 | `402068rMcRUy` |
| 8 | 8 | `__esModu` |
| 9 | 8 | `__create` |
| 10 | 8 | `__setMod` |
| 11 | 8 | `uleDefau` |
| 12 | 8 | `4|2|1|3|` |
| 13 | 8 | `definePr` |
| 14 | 8 | `edVersio` |
| 15 | 8 | `setSkipp` |
| 16 | 8 | `clearSki` |
| 17 | 8 | `ppedVers` |
| 18 | 8 | `checkFor` |
| 19 | 8 | `UpdateWi` |
| 20 | 8 | `getOwnPr` |
| 21 | 8 | `opertyNa` |
| 22 | 8 | `scriptor` |
| 23 | 8 | `writable` |
| 24 | 8 | `configur` |
| 25 | 8 | `./server` |
| 26 | 8 | `./device` |
| 27 | 8 | `-identit` |
| 28 | 7 | `message` |
| 29 | 7 | `6CLsXgb` |
| 30 | 7 | `Binding` |
| 31 | 7 | `default` |
| 32 | 7 | `-config` |
| 33 | 6 | `create` |
| 34 | 6 | `operty` |
| 35 | 6 | `Update` |
| 36 | 6 | `thSkip` |
| 37 | 6 | `length` |
| 38 | 6 | `normal` |
| 39 | 5 | `ycvOz` |
| 40 | 5 | `taDir` |
| 41 | 5 | `eSync` |
| 42 | 5 | `zfHNF` |
| 43 | 5 | `vocKq` |
| 44 | 5 | `ZcIAO` |
| 45 | 5 | `split` |
| 46 | 5 | `SQfYE` |
| 47 | 5 | `Wxing` |
| 48 | 5 | `kxcMj` |
| 49 | 5 | `YfdkF` |
| 50 | 5 | `goKgO` |

---

## main.js

- Size: 130.6KB
- Obfuscated: Yes
- Decoder: _0x5afa
- Cache property: \x78\x68\x69\x6d\x64\x48
- Total decoded strings: 4347

### Exports

| Name | Type | Value |
|------|------|-------|
| `methods` | object | Object with keys: openPanel, checkLicense, activateLicense, deactivateLicense, getLicenseInfo, startServer, stopServer, getServerStatus, updateSettings, getToolsList |
| `load` | function | Error: Editor is not defined |
| `unload` | function |  |

### Decoded Strings (164 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 14 | `11243880GlGDvr` |
| 2 | 14 | `11203938ZROMXy` |
| 3 | 13 | `6434760XmOJmi` |
| 4 | 13 | `1153101OWHtUX` |
| 5 | 13 | `1921792fyZEfs` |
| 6 | 12 | `155982KOoMPv` |
| 7 | 10 | `3081mUSJHx` |
| 8 | 9 | `724uoyxCq` |
| 9 | 8 | `l dialog` |
| 10 | 8 | `includes` |
| 11 | 8 | `autoStar` |
| 12 | 8 | `heck fai` |
| 13 | 8 | `Plugin l` |
| 14 | 8 | `getStatu` |
| 15 | 8 | `./auth/l` |
| 16 | 8 | `te confi` |
| 17 | 8 | `abledToo` |
| 18 | 8 | `d reject` |
| 19 | 8 | `te CLI c` |
| 20 | 8 | `icense-m` |
| 21 | 8 | `getEnabl` |
| 22 | 8 | `Dev mode` |
| 23 | 8 | `r functi` |
| 24 | 8 | `start ""` |
| 25 | 8 | `o device` |
| 26 | 8 | `o genera` |
| 27 | 8 | `onfig fi` |
| 28 | 8 | `MCPConfi` |
| 29 | 8 | `ntConfig` |
| 30 | 8 | `getStabl` |
| 31 | 8 | `isAutoCo` |
| 32 | 8 | ` server ` |
| 33 | 8 | `showMess` |
| 34 | 8 | `gManager` |
| 35 | 8 | `Progress` |
| 36 | 8 | `clearPro` |
| 37 | 8 | `AutoStar` |
| 38 | 8 | `CLIComma` |
| 39 | 8 | `t skippe` |
| 40 | 8 | `o load b` |
| 41 | 8 | `Failed t` |
| 42 | 8 | `ient str` |
| 43 | 8 | ` updates` |
| 44 | 8 | `./tools/` |
| 45 | 8 | `o restar` |
| 46 | 8 | `oad - in` |
| 47 | 8 | `ver kept` |
| 48 | 8 | `er kept ` |
| 49 | 8 | `ed due t` |
| 50 | 8 | `required` |

---

## mcp-server.js

- Size: 219.3KB
- Obfuscated: Yes
- Decoder: _0xd9bd
- Cache property: \x70\x51\x5a\x41\x69\x58
- Total decoded strings: 3360

### Exports

| Name | Type | Value |
|------|------|-------|
| `MCPServer` | function | Error: Class constructor _0xdb3572 cannot be invoked without 'new' |

### Decoded Strings (227 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `1125754ySTBbu` |
| 2 | 13 | `4258692BOzUBY` |
| 3 | 12 | `118594mdRqYq` |
| 4 | 12 | `977970KeHFqt` |
| 5 | 12 | `806200FbKFeS` |
| 6 | 11 | `69307KxWvDg` |
| 7 | 10 | `7945zXheYR` |
| 8 | 9 | `172aRJtgO` |
| 9 | 8 | `aming co` |
| 10 | 8 | `opertyDe` |
| 11 | 8 | `handleHt` |
| 12 | 8 | `lastTime` |
| 13 | 8 | `k, Layou` |
| 14 | 8 | `destroye` |
| 15 | 8 | `prototyp` |
| 16 | 8 | `ECONNABO` |
| 17 | 8 | `censeExp` |
| 18 | 8 | `llow-Hea` |
| 19 | 8 | `xpose-He` |
| 20 | 8 | `rn {did:` |
| 21 | 8 | `Type, Au` |
| 22 | 8 | `Mcp-Sess` |
| 23 | 8 | `expected` |
| 24 | 8 | `set_styl` |
| 25 | 8 | `project:` |
| 26 | 8 | `pi/{cate` |
| 27 | 8 | `heartbea` |
| 28 | 8 | `: invali` |
| 29 | 8 | `autoSave` |
| 30 | 8 | `setupToo` |
| 31 | 8 | `toolsLis` |
| 32 | 8 | `MCPLogge` |
| 33 | 8 | `MCPServe` |
| 34 | 8 | `urn 'no ` |
| 35 | 8 | `se chang` |
| 36 | 8 | `isLicens` |
| 37 | 8 | `reamingC` |
| 38 | 8 | `TION FAI` |
| 39 | 8 | `ide_in_h` |
| 40 | 8 | `__setMod` |
| 41 | 8 | `uleDefau` |
| 42 | 8 | `__import` |
| 43 | 8 | `definePr` |
| 44 | 8 | `__esModu` |
| 45 | 8 | `getOwnPr` |
| 46 | 8 | `opertyNa` |
| 47 | 8 | `scriptor` |
| 48 | 8 | `writable` |
| 49 | 8 | `cocos/co` |
| 50 | 8 | `cos-tool` |

---

## mcp-client-configs.js

- Size: 36.6KB
- Obfuscated: Yes
- Decoder: _0x3077
- Cache property: \x54\x4c\x67\x4f\x46\x50
- Total decoded strings: 1444

### Exports

| Name | Type | Value |
|------|------|-------|
| `MCP_CLIENTS` | object | Object with keys: cursor, windsurf, trae, codex-cli, claude-cli, gemini-cli |
| `generateJSONConfig` | function | Error: Cannot read properties of undefined (reading 'configFormat') |
| `generateTOMLConfig` | function | Error: Cannot read properties of undefined (reading 'serverName') |
| `generateCLICommand` | function | Error: Cannot destructure property 'clientType' of '_0x5a3225' as it is undefined. |
| `getConfigFilePath` | function | Error: Cannot read properties of undefined (reading 'configFileLocation') |

### Decoded Strings (86 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `2115332YEwtjY` |
| 2 | 13 | `1203212dtvmTa` |
| 3 | 13 | `5668385kqkeNN` |
| 4 | 13 | `4759768fGDEZY` |
| 5 | 13 | `9013797jhAYdo` |
| 6 | 12 | `540018iEDNSJ` |
| 7 | 12 | `289848pzANzc` |
| 8 | 8 | `generate` |
| 9 | 8 | `Trea CN ` |
| 10 | 8 | `# Codex ` |
| 11 | 8 | `serverUr` |
| 12 | 8 | `.codex/c` |
| 13 | 8 | `serverNa` |
| 14 | 8 | `stringif` |
| 15 | 8 | `Authoriz` |
| 16 | 8 | `i/settin` |
| 17 | 8 | `42ZuLWcv` |
| 18 | 8 | `10krVjyC` |
| 19 | 8 | `definePr` |
| 20 | 8 | `__esModu` |
| 21 | 8 | `TOMLConf` |
| 22 | 8 | `CLIComma` |
| 23 | 8 | `getConfi` |
| 24 | 8 | `MCP_CLIE` |
| 25 | 8 | `Cursor I` |
| 26 | 8 | `streamab` |
| 27 | 8 | `windsurf` |
| 28 | 8 | `Windsurf` |
| 29 | 8 | ` IDE - C` |
| 30 | 8 | `codex-cl` |
| 31 | 8 | `Codex CL` |
| 32 | 8 | `OpenAI C` |
| 33 | 8 | `~/.codex` |
| 34 | 8 | `/config.` |
| 35 | 8 | `%USERPRO` |
| 36 | 8 | `FILE%\.c` |
| 37 | 8 | `odex\con` |
| 38 | 8 | `claude-c` |
| 39 | 8 | `Anthropi` |
| 40 | 8 | `c Claude` |
| 41 | 8 | `~/.claud` |
| 42 | 8 | `e/config` |
| 43 | 8 | `laude\co` |
| 44 | 8 | `nfig.jso` |
| 45 | 8 | `Gemini C` |
| 46 | 8 | `Google G` |
| 47 | 8 | `FILE%\.g` |
| 48 | 8 | `emini\se` |
| 49 | 8 | `ttings.j` |
| 50 | 8 | `~/.gemin` |

---

## mcp-config-manager.js

- Size: 81.7KB
- Obfuscated: Yes
- Decoder: _0x48f4
- Cache property: \x55\x79\x49\x66\x42\x4c
- Total decoded strings: 2706

### Exports

| Name | Type | Value |
|------|------|-------|
| `MCPConfigManager` | function | Error: Class constructor _0x11e860 cannot be invoked without 'new' |

### Decoded Strings (147 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `1455950ZCqNUe` |
| 2 | 13 | `1955144VdUXIH` |
| 3 | 13 | `2919078yfjgji` |
| 4 | 12 | `290454LyzklQ` |
| 5 | 12 | `332326mFaALy` |
| 6 | 12 | `293364aoTPbj` |
| 7 | 11 | `14656osArUP` |
| 8 | 10 | `3114GYkkkA` |
| 9 | 8 | `toISOStr` |
| 10 | 8 | `stringif` |
| 11 | 8 | `removeSe` |
| 12 | 8 | `mlConten` |
| 13 | 8 | `igManage` |
| 14 | 8 | `removeFr` |
| 15 | 8 | `MCPConfi` |
| 16 | 8 | `serverUr` |
| 17 | 8 | `getOwnPr` |
| 18 | 8 | `codex-cl` |
| 19 | 8 | `normaliz` |
| 20 | 8 | `[MCPConf` |
| 21 | 8 | `MCP_CLIE` |
| 22 | 8 | `opertyNa` |
| 23 | 8 | `generate` |
| 24 | 8 | `streamab` |
| 25 | 8 | `r] Auto-` |
| 26 | 8 | `function` |
| 27 | 8 | `ading pa` |
| 28 | 8 | `mkdirSyn` |
| 29 | 8 | `startsWi` |
| 30 | 8 | `getConfi` |
| 31 | 8 | `leExists` |
| 32 | 8 | `prototyp` |
| 33 | 8 | `CLIComma` |
| 34 | 8 | `@iarna/t` |
| 35 | 8 | `claude-c` |
| 36 | 8 | `77wpYlcI` |
| 37 | 8 | `__create` |
| 38 | 8 | `__setMod` |
| 39 | 8 | `__import` |
| 40 | 8 | `definePr` |
| 41 | 8 | `__esModu` |
| 42 | 8 | `gManager` |
| 43 | 8 | `scriptor` |
| 44 | 8 | `writable` |
| 45 | 8 | `configur` |
| 46 | 8 | `configFi` |
| 47 | 8 | `readConf` |
| 48 | 8 | `backupCo` |
| 49 | 8 | `ensureCo` |
| 50 | 8 | `eForToml` |

---

## scene.js

- Size: 52.1KB
- Obfuscated: Yes
- Decoder: _0x529b
- Cache property: \x57\x64\x44\x6c\x79\x76
- Total decoded strings: 0
- Error: Editor is not defined

---

## settings.js

- Size: 38.9KB
- Obfuscated: Yes
- Decoder: _0x1d03
- Cache property: \x53\x75\x67\x67\x4a\x53
- Total decoded strings: 1460

### Exports

| Name | Type | Value |
|------|------|-------|
| `DEFAULT_SETTINGS` | object | Object with keys: port, autoStart, enableDebugLog, allowedOrigins, maxConnections |
| `DEFAULT_TOOL_MANAGER_SETTINGS` | object | Object with keys: configurations, currentConfigId, maxConfigSlots |
| `readSettings` | function | {"port":3000,"autoStart":false,"enableDebugLog":false,"allowedOrigins":["*"],"maxConnections":10} |
| `saveSettings` | function | Error: Editor is not defined |
| `readToolManagerSettings` | function | {"configurations":[],"currentConfigId":"","maxConfigSlots":5} |
| `saveToolManagerSettings` | function | Error: Editor is not defined |
| `exportToolConfiguration` | function |  |
| `importToolConfiguration` | function | Error: Invalid JSON format or configuration structure |
| `getInstalledVersion` | function | null |
| `saveVersionMarker` | function |  |
| `clearProjectConfigs` | function | Error: Editor is not defined |

### Decoded Strings (84 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 14 | `21560808NjtCKn` |
| 2 | 13 | `9354664gZtCME` |
| 3 | 12 | `743991CUVgdx` |
| 4 | 12 | `945495MSBdtt` |
| 5 | 11 | `19986fAtHCr` |
| 6 | 11 | `13180sTaoWd` |
| 7 | 10 | `7212LzGHhi` |
| 8 | 10 | `7887fnlDUj` |
| 9 | 9 | `264jNqTVL` |
| 10 | 9 | `220IEzncK` |
| 11 | 8 | `d versio` |
| 12 | 8 | `o read t` |
| 13 | 8 | `JSON for` |
| 14 | 8 | `getOwnPr` |
| 15 | 8 | `definePr` |
| 16 | 8 | `onfigura` |
| 17 | 8 | `__esModu` |
| 18 | 8 | `ool mana` |
| 19 | 8 | `opertyDe` |
| 20 | 8 | `ettings:` |
| 21 | 8 | `saveSett` |
| 22 | 8 | `olConfig` |
| 23 | 8 | `__create` |
| 24 | 8 | `__setMod` |
| 25 | 8 | `__import` |
| 26 | 8 | `DEFAULT_` |
| 27 | 8 | `AGER_SET` |
| 28 | 8 | `SETTINGS` |
| 29 | 8 | `readSett` |
| 30 | 8 | `readTool` |
| 31 | 8 | `ManagerS` |
| 32 | 8 | `exportTo` |
| 33 | 8 | `getInsta` |
| 34 | 8 | `ionMarke` |
| 35 | 8 | `jectConf` |
| 36 | 8 | `Failed t` |
| 37 | 8 | `o read s` |
| 38 | 8 | `writable` |
| 39 | 8 | `configur` |
| 40 | 8 | `TOOL_MAN` |
| 41 | 7 | `Project` |
| 42 | 7 | `uration` |
| 43 | 7 | `2UuYvvj` |
| 44 | 7 | `7CNDDmD` |
| 45 | 7 | `Binding` |
| 46 | 7 | `ettings` |
| 47 | 7 | `default` |
| 48 | 6 | `assign` |
| 49 | 5 | `$z\rA}` |
| 50 | 5 | `\n{a'@` |

---

## tools/server-tools.js

- Size: 71.4KB
- Obfuscated: Yes
- Decoder: _0x47db
- Cache property: \x72\x56\x46\x50\x78\x7a
- Total decoded strings: 1981

### Exports

| Name | Type | Value |
|------|------|-------|
| `ServerTools` | function | Error: Class constructor _0x4cd9f8 cannot be invoked without 'new' |

### Decoded Strings (104 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 14 | `14014818bIiQBe` |
| 2 | 14 | `17146644jJhFvf` |
| 3 | 13 | `1582545HhhCOM` |
| 4 | 13 | `2182704UpzdHu` |
| 5 | 12 | `564699dFaMGw` |
| 6 | 12 | `952242oBMlSX` |
| 7 | 12 | `564272vectiD` |
| 8 | 9 | `161wiBtvS` |
| 9 | 8 | `opertyNa` |
| 10 | 8 | `, and sy` |
| 11 | 8 | `ity conf` |
| 12 | 8 | `ectivity` |
| 13 | 8 | `ONNECTIV` |
| 14 | 8 | `work_int` |
| 15 | 8 | `getServe` |
| 16 | 8 | ` Use "ge` |
| 17 | 8 | `nterface` |
| 18 | 8 | `nnectivi` |
| 19 | 8 | `nformati` |
| 20 | 8 | `ils and ` |
| 21 | 8 | `cal for ` |
| 22 | 8 | `ServerTo` |
| 23 | 8 | `Sorted I` |
| 24 | 8 | `irmed in` |
| 25 | 8 | `Connecti` |
| 26 | 8 | `erfaces"` |
| 27 | 8 | `gacyTool` |
| 28 | 8 | `get_netw` |
| 29 | 8 | `uleDefau` |
| 30 | 8 | `Failed t` |
| 31 | 8 | `ters nee` |
| 32 | 8 | `10EGgIbi` |
| 33 | 8 | `11XZsjJc` |
| 34 | 8 | `__create` |
| 35 | 8 | `0|3|2|1|` |
| 36 | 8 | `definePr` |
| 37 | 8 | `__esModu` |
| 38 | 8 | `getOwnPr` |
| 39 | 8 | `scriptor` |
| 40 | 8 | `configur` |
| 41 | 8 | `getTools` |
| 42 | 8 | `querySer` |
| 43 | 8 | `verIPLis` |
| 44 | 8 | `querySor` |
| 45 | 8 | `tedServe` |
| 46 | 8 | `checkSer` |
| 47 | 8 | `verConne` |
| 48 | 8 | `getNetwo` |
| 49 | 8 | `rkInterf` |
| 50 | 8 | `rverInfo` |

---

## tools/tool-manager.js

- Size: 89.2KB
- Obfuscated: Yes
- Decoder: _0x19c4
- Cache property: \x4a\x71\x57\x79\x72\x46
- Total decoded strings: 3471

### Exports

| Name | Type | Value |
|------|------|-------|
| `ToolManager` | function | Error: Class constructor _0x2398f6 cannot be invoked without 'new' |

### Decoded Strings (125 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 12 | `158768ybXqcu` |
| 2 | 12 | `266952GajEUj` |
| 3 | 12 | `737120kqxisM` |
| 4 | 12 | `788682uuSlPg` |
| 5 | 11 | `52556mxlHsy` |
| 6 | 11 | `91876tfwKyf` |
| 7 | 10 | `3787MtfWQl` |
| 8 | 10 | `7376COuYnV` |
| 9 | 8 | `K7\tUd]:.` |
| 10 | 8 | `th confi` |
| 11 | 8 | `d with I` |
| 12 | 8 | `createdA` |
| 13 | 8 | ` Found c` |
| 14 | 8 | `successf` |
| 15 | 8 | `alled wi` |
| 16 | 8 | ` Current` |
| 17 | 8 | `nentToNo` |
| 18 | 8 | ` Setting` |
| 19 | 8 | `broadcas` |
| 20 | 8 | `olStatus` |
| 21 | 8 | `le confi` |
| 22 | 8 | `getScene` |
| 23 | 8 | `ntSceneI` |
| 24 | 8 | `availabl` |
| 25 | 8 | `settings` |
| 26 | 8 | `updatedA` |
| 27 | 8 | `zeAvaila` |
| 28 | 8 | `deleteNo` |
| 29 | 8 | `getCompo` |
| 30 | 8 | `sBatch c` |
| 31 | 8 | `not foun` |
| 32 | 8 | `getServe` |
| 33 | 8 | `[ToolMan` |
| 34 | 8 | `getToolM` |
| 35 | 8 | `configur` |
| 36 | 8 | `aving se` |
| 37 | 8 | `getPerfo` |
| 38 | 8 | `, new en` |
| 39 | 8 | `saveSett` |
| 40 | 8 | `bleTools` |
| 41 | 8 | `ager] In` |
| 42 | 8 | `Backend:` |
| 43 | 8 | `definePr` |
| 44 | 8 | `ToolMana` |
| 45 | 8 | `../setti` |
| 46 | 8 | `initiali` |
| 47 | 8 | `zeDefaul` |
| 48 | 8 | `getAvail` |
| 49 | 8 | `ableTool` |
| 50 | 8 | `getConfi` |

---

## tools/node-tools.js

- Size: 485.8KB
- Obfuscated: Yes
- Decoder: _0x51dd
- Cache property: \x77\x59\x62\x55\x4e\x72
- Total decoded strings: 2604

### Exports

| Name | Type | Value |
|------|------|-------|
| `NodeTools` | function | Error: Class constructor _0x28fd4d cannot be invoked without 'new' |

### Decoded Strings (131 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `2574756WdttQF` |
| 2 | 13 | `3807900gjTcGr` |
| 3 | 12 | `400035oLhbMe` |
| 4 | 12 | `345524uIWuhg` |
| 5 | 11 | `85256czdxJK` |
| 6 | 11 | `21846ssWpiu` |
| 7 | 10 | `2547TSGorE` |
| 8 | 10 | `9012XSrYNS` |
| 9 | 9 | `674QIVAGs` |
| 10 | 9 | `224lkemAY` |
| 11 | 8 | `ode name` |
| 12 | 8 | `duplicat` |
| 13 | 8 | `hildren ` |
| 14 | 8 | `e array ` |
| 15 | 8 | `ts befor` |
| 16 | 8 | `Preserve` |
| 17 | 8 | ` with ar` |
| 18 | 8 | `node_pro` |
| 19 | 8 | `Controls` |
| 20 | 8 | ` to clip` |
| 21 | 8 | `D is req` |
| 22 | 8 | `at from ` |
| 23 | 8 | `o get no` |
| 24 | 8 | `yer", "P` |
| 25 | 8 | `setSibli` |
| 26 | 8 | `-5678-12` |
| 27 | 8 | `= move d` |
| 28 | 8 | `2} doubl` |
| 29 | 8 | `componen` |
| 30 | 8 | `Node UUI` |
| 31 | 8 | `: Move o` |
| 32 | 8 | `on, rota` |
| 33 | 8 | `findNode` |
| 34 | 8 | `cc.Point` |
| 35 | 8 | `reset_co` |
| 36 | 8 | `element ` |
| 37 | 8 | `empty st` |
| 38 | 8 | `rayEleme` |
| 39 | 8 | `includes` |
| 40 | 8 | `don't re` |
| 41 | 8 | `Node err` |
| 42 | 8 | `definePr` |
| 43 | 8 | `__esModu` |
| 44 | 8 | `NodeTool` |
| 45 | 8 | `./compon` |
| 46 | 8 | `ent-tool` |
| 47 | 8 | `utils/as` |
| 48 | 8 | `set-ref-` |
| 49 | 8 | `resolver` |
| 50 | 8 | `utils/bu` |

---

## tools/scene-tools.js

- Size: 138.4KB
- Obfuscated: Yes
- Decoder: _0x5202
- Cache property: \x4a\x4a\x53\x52\x77\x6e
- Total decoded strings: 2516

### Exports

| Name | Type | Value |
|------|------|-------|
| `SceneTools` | function | Error: Class constructor _0x19be9e cannot be invoked without 'new' |

### Decoded Strings (120 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 14 | `23150160AUJEmL` |
| 2 | 13 | `3522152Jfrupr` |
| 3 | 13 | `3279654TTOUKx` |
| 4 | 12 | `779517HTfeiL` |
| 5 | 12 | `106544yJadcb` |
| 6 | 12 | `587405fbUAwo` |
| 7 | 11 | `60428ACnQzE` |
| 8 | 8 | ` compone` |
| 9 | 8 | `ols] Cle` |
| 10 | 8 | `nodeUuid` |
| 11 | 8 | `t action` |
| 12 | 8 | `children` |
| 13 | 8 | `neCompon` |
| 14 | 8 | `ify (che` |
| 15 | 8 | `The sour` |
| 16 | 8 | `D from b` |
| 17 | 8 | `sceneSna` |
| 18 | 8 | `ecutionC` |
| 19 | 8 | `gin_undo` |
| 20 | 8 | `handleLe` |
| 21 | 8 | `startsWi` |
| 22 | 8 | `[SceneTo` |
| 23 | 8 | `scene ma` |
| 24 | 8 | `t UUID t` |
| 25 | 8 | `ols] Sce` |
| 26 | 8 | `queryNod` |
| 27 | 8 | `lasses t` |
| 28 | 8 | `urned no` |
| 29 | 8 | `t). Reco` |
| 30 | 8 | ` Each el` |
| 31 | 8 | `er outpu` |
| 32 | 8 | `ft reloa` |
| 33 | 8 | `begin_un` |
| 34 | 8 | `list_com` |
| 35 | 8 | ` Used to` |
| 36 | 8 | `Scene cl` |
| 37 | 8 | `executeS` |
| 38 | 8 | `apshot c` |
| 39 | 8 | `restore_` |
| 40 | 8 | `22djVCrr` |
| 41 | 8 | `20eWpzkd` |
| 42 | 8 | `42JPnrsD` |
| 43 | 8 | `definePr` |
| 44 | 8 | `SceneToo` |
| 45 | 8 | `../compa` |
| 46 | 8 | `t/api-ad` |
| 47 | 8 | `getTools` |
| 48 | 8 | `trySaveC` |
| 49 | 8 | `openScen` |
| 50 | 8 | `clearSce` |

---

## tools/scene-view-tools.js

- Size: 137.8KB
- Obfuscated: Yes
- Decoder: _0x26b5
- Cache property: \x53\x6d\x66\x4e\x48\x4c
- Total decoded strings: 5280

### Exports

| Name | Type | Value |
|------|------|-------|
| `SceneViewTools` | function | Error: Class constructor _0x310af5 cannot be invoked without 'new' |

### Decoded Strings (167 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `1431282LAyUYj` |
| 2 | 13 | `3744102piEaPA` |
| 3 | 13 | `1211490RPzMHw` |
| 4 | 13 | `3093013ruIkrq` |
| 5 | 12 | `948504ksaBcp` |
| 6 | 11 | `26747cVcvVo` |
| 7 | 10 | `1608xHehWS` |
| 8 | 10 | `9928CMVHYK` |
| 9 | 8 | `o reset ` |
| 10 | 8 | `urrent s` |
| 11 | 8 | `Scene vi` |
| 12 | 8 | ` behavio` |
| 13 | 8 | `ox cente` |
| 14 | 8 | `gridVisi` |
| 15 | 8 | `o set to` |
| 16 | 8 | `ransform` |
| 17 | 8 | `queryVie` |
| 18 | 8 | `queryGiz` |
| 19 | 8 | `_on_node` |
| 20 | 8 | `nter" = ` |
| 21 | 8 | `K))F;on,` |
| 22 | 8 | `Current ` |
| 23 | 8 | `toolName` |
| 24 | 8 | `moToolNa` |
| 25 | 8 | `e = 3D i` |
| 26 | 8 | `point (R` |
| 27 | 8 | `setGridV` |
| 28 | 8 | `change_p` |
| 29 | 8 | `es. Loca` |
| 30 | 8 | `changeVi` |
| 31 | 8 | `te syste` |
| 32 | 8 | `tool act` |
| 33 | 8 | `query_vi` |
| 34 | 8 | `ntation,` |
| 35 | 8 | `query-gi` |
| 36 | 8 | `D mode f` |
| 37 | 8 | `setIconG` |
| 38 | 8 | `e change` |
| 39 | 8 | `gizmoPiv` |
| 40 | 8 | `set-icon` |
| 41 | 8 | ` | "alig` |
| 42 | 8 | `change_g` |
| 43 | 8 | `mation t` |
| 44 | 8 | `required` |
| 45 | 8 | `ect-orie` |
| 46 | 8 | `HN2Y0eO ` |
| 47 | 8 | `Camera f` |
| 48 | 8 | `mera ali` |
| 49 | 8 | `Gizmo pi` |
| 50 | 8 | `m pivot ` |

---

## tools/component-tools.js

- Size: 618.6KB
- Obfuscated: Yes
- Decoder: _0x1a28
- Cache property: \x42\x66\x59\x44\x6a\x64
- Total decoded strings: 1765

### Exports

| Name | Type | Value |
|------|------|-------|
| `ComponentTools` | function | Error: Class constructor _0x1227bf cannot be invoked without 'new' |

### Decoded Strings (170 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `3758238rXClih` |
| 2 | 13 | `2794100auZKCa` |
| 3 | 12 | `138798uPmLCk` |
| 4 | 12 | `917820icTgBU` |
| 5 | 11 | `50470ysBjuL` |
| 6 | 11 | `64092lRTpjY` |
| 7 | 11 | `29368EyuSrl` |
| 8 | 9 | `679pxUfrd` |
| 9 | 8 | `" if nee` |
| 10 | 8 | `l in Cre` |
| 11 | 8 | `perties:` |
| 12 | 8 | `ray refe` |
| 13 | 8 | ` for "ad` |
| 14 | 8 | `00,"heig` |
| 15 | 8 | `nt/nodeA` |
| 16 | 8 | `41c9f877` |
| 17 | 8 | `substrin` |
| 18 | 8 | `KFLOW: 1` |
| 19 | 8 | `ou meant` |
| 20 | 8 | ` verify.` |
| 21 | 8 | `for prop` |
| 22 | 8 | `pleCompo` |
| 23 | 8 | `ue must ` |
| 24 | 8 | `ure "han` |
| 25 | 8 | `: {"prop` |
| 26 | 8 | `cc.Compo` |
| 27 | 8 | `Componen` |
| 28 | 8 | `ventData` |
| 29 | 8 | `ntTools]` |
| 30 | 8 | ` or get ` |
| 31 | 8 | `48vRAzSb` |
| 32 | 8 | `11QlXObG` |
| 33 | 8 | `definePr` |
| 34 | 8 | `__esModu` |
| 35 | 8 | `./cocos/` |
| 36 | 8 | `utils/pa` |
| 37 | 8 | `utils/sm` |
| 38 | 8 | `art-defa` |
| 39 | 8 | `de-resol` |
| 40 | 8 | `utils/as` |
| 41 | 8 | `resolver` |
| 42 | 8 | `t/api-ad` |
| 43 | 8 | `cc.Label` |
| 44 | 8 | `cc.RichT` |
| 45 | 8 | `cc.Tiled` |
| 46 | 8 | `cc.Drago` |
| 47 | 8 | `cleSyste` |
| 48 | 8 | `cc.UISta` |
| 49 | 8 | `ticBatch` |
| 50 | 8 | `cc.MeshR` |

---

## tools/project-tools.js

- Size: 131.6KB
- Obfuscated: Yes
- Decoder: _0x305b
- Cache property: \x4d\x4b\x63\x6a\x62\x45
- Total decoded strings: 2669

### Exports

| Name | Type | Value |
|------|------|-------|
| `ProjectTools` | function | Error: Class constructor _0xaaf78f cannot be invoked without 'new' |

### Decoded Strings (97 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `2592252yCNnRl` |
| 2 | 13 | `3572090XByhzZ` |
| 3 | 13 | `1957926BauTzM` |
| 4 | 13 | `8023701rqGvTG` |
| 5 | 12 | `672396iSErpr` |
| 6 | 12 | `320791trQEBX` |
| 7 | 12 | `519405oFvbJh` |
| 8 | 8 | `\n       ` |
| 9 | 8 | `form;\n  ` |
| 10 | 8 | `es;\n    ` |
| 11 | 8 | `;\n      ` |
| 12 | 8 | `definePr` |
| 13 | 8 | `lderStat` |
| 14 | 8 | `/CocosCr` |
| 15 | 8 | `worker i` |
| 16 | 8 | ` success` |
| 17 | 8 | `.hasPlay` |
| 18 | 8 | `retrieve` |
| 19 | 8 | `runBrows` |
| 20 | 8 | `essfully` |
| 21 | 8 | `rm (REQU` |
| 22 | 8 | `ded: bro` |
| 23 | 8 | `IRED for` |
| 24 | 8 | `GameView` |
| 25 | 8 | `d_settin` |
| 26 | 8 | `killAllP` |
| 27 | 8 | `e/Simula` |
| 28 | 8 | `execInTo` |
| 29 | 8 | `droid" =` |
| 30 | 8 | `build pa` |
| 31 | 8 | `STEM: Co` |
| 32 | 8 | `Platform` |
| 33 | 8 | `obile we` |
| 34 | 8 | `getTitle` |
| 35 | 8 | `result.x` |
| 36 | 8 | `n). true` |
| 37 | 8 | `__esModu` |
| 38 | 8 | `ProjectT` |
| 39 | 8 | `child_pr` |
| 40 | 8 | `getTools` |
| 41 | 8 | `handlePr` |
| 42 | 8 | `ildSyste` |
| 43 | 8 | `runProje` |
| 44 | 8 | `runSimul` |
| 45 | 8 | `runEdito` |
| 46 | 8 | `rPreview` |
| 47 | 8 | `buildPro` |
| 48 | 8 | `getProje` |
| 49 | 8 | `Settings` |
| 50 | 8 | `openBuil` |

---

## tools/prefab-tools.js

- Size: 587.3KB
- Obfuscated: Yes
- Decoder: _0x5e9c
- Cache property: \x4c\x42\x61\x69\x57\x74
- Total decoded strings: 5002

### Exports

| Name | Type | Value |
|------|------|-------|
| `PrefabTools` | function | Error: Class constructor _0x2bdc33 cannot be invoked without 'new' |

### Decoded Strings (280 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 14 | `12907288HzsqyD` |
| 2 | 13 | `1810620zBkDJN` |
| 3 | 13 | `5341772kJijUn` |
| 4 | 13 | `1556885ETGUIQ` |
| 5 | 13 | `9472482iBEiTO` |
| 6 | 12 | `458620IozflB` |
| 7 | 11 | `15646CUpVOi` |
| 8 | 9 | `407pTeuWl` |
| 9 | 8 | `getCompo` |
| 10 | 8 | `nodeUuid` |
| 11 | 8 | `ne API: ` |
| 12 | 8 | `[DEBUG] ` |
| 13 | 8 | `createEn` |
| 14 | 8 | `_fontFam` |
| 15 | 8 | `red for ` |
| 16 | 8 | `properti` |
| 17 | 8 | `ode for ` |
| 18 | 8 | `_useGray` |
| 19 | 8 | `addGener` |
| 20 | 8 | `set-info` |
| 21 | 8 | `SceneNat` |
| 22 | 8 | `_spriteF` |
| 23 | 8 | `Properti` |
| 24 | 8 | `ts to pr` |
| 25 | 8 | `vePath r` |
| 26 | 8 | `query-pa` |
| 27 | 8 | ` failed:` |
| 28 | 8 | `createMe` |
| 29 | 8 | `parentUu` |
| 30 | 8 | `Lifecycl` |
| 31 | 8 | `itor Hie` |
| 32 | 8 | `dc-8152-` |
| 33 | 8 | `Example:` |
| 34 | 8 | `savePath` |
| 35 | 8 | `validate` |
| 36 | 8 | `spriteFr` |
| 37 | 8 | `MenuPane` |
| 38 | 8 | `c2Object` |
| 39 | 8 | `os asset` |
| 40 | 8 | `cc.Prefa` |
| 41 | 8 | `exitPref` |
| 42 | 8 | `ly. Use ` |
| 43 | 8 | `PrefabTo` |
| 44 | 8 | `itor-mod` |
| 45 | 8 | `getPrefa` |
| 46 | 8 | `loadPref` |
| 47 | 8 | `instanti` |
| 48 | 8 | `atePrefa` |
| 49 | 8 | `onnectio` |
| 50 | 8 | `manually` |

---

## tools/preferences-tools.js

- Size: 171.9KB
- Obfuscated: Yes
- Decoder: _0x5ac8
- Cache property: \x6f\x42\x4c\x43\x62\x59
- Total decoded strings: 3771

### Exports

| Name | Type | Value |
|------|------|-------|
| `PreferencesTools` | function | Error: Class constructor _0x20dc1f cannot be invoked without 'new' |

### Decoded Strings (118 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `1916116QGkMzB` |
| 2 | 13 | `4469670Vjfwdf` |
| 3 | 13 | `4859351xirTTw` |
| 4 | 13 | `1374498aGRUeB` |
| 5 | 12 | `533268TEDImH` |
| 6 | 12 | `986705YQWaey` |
| 7 | 10 | `6597ieAVoP` |
| 8 | 9 | `572fBPUJn` |
| 9 | 8 | `formatio` |
| 10 | 8 | `tor conf` |
| 11 | 8 | `handlePr` |
| 12 | 8 | `metadata` |
| 13 | 8 | `d beta f` |
| 14 | 8 | `searchIn` |
| 15 | 8 | `t_config` |
| 16 | 8 | `t be a n` |
| 17 | 8 | `warnings` |
| 18 | 8 | `ces tab ` |
| 19 | 8 | `ies" = g` |
| 20 | 8 | `xt size,` |
| 21 | 8 | `". Value` |
| 22 | 8 | `ata must` |
| 23 | 8 | `ols" (ed` |
| 24 | 8 | ` compila` |
| 25 | 8 | `cocosVer` |
| 26 | 8 | ` Check a` |
| 27 | 8 | ` categor` |
| 28 | 8 | ` availab` |
| 29 | 8 | `Cocos ve` |
| 30 | 8 | `Unknown ` |
| 31 | 8 | `Could no` |
| 32 | 8 | `ugin set` |
| 33 | 8 | `es to ex` |
| 34 | 8 | `ation ca` |
| 35 | 8 | `et avail` |
| 36 | 8 | `t this p` |
| 37 | 8 | `Native p` |
| 38 | 8 | `Missing ` |
| 39 | 8 | `setting.` |
| 40 | 8 | `Categori` |
| 41 | 8 | `Error re` |
| 42 | 8 | `tting pr` |
| 43 | 8 | `definePr` |
| 44 | 8 | `__esModu` |
| 45 | 8 | `getTools` |
| 46 | 8 | `eference` |
| 47 | 8 | `getPrefe` |
| 48 | 8 | `rencesCo` |
| 49 | 8 | `setPrefe` |
| 50 | 8 | `ferences` |

---

## tools/reference-image-tools.js

- Size: 130.8KB
- Obfuscated: Yes
- Decoder: _0x9df6
- Cache property: \x63\x44\x53\x65\x70\x59
- Total decoded strings: 1175

### Exports

| Name | Type | Value |
|------|------|-------|
| `ReferenceImageTools` | function | Error: Class constructor _0x5c666e cannot be invoked without 'new' |

### Decoded Strings (69 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `1823312VZHbfd` |
| 2 | 13 | `8169264fSFOME` |
| 3 | 13 | `4430338aOnOKV` |
| 4 | 12 | `520396jOdeWP` |
| 5 | 12 | `557025Flntov` |
| 6 | 11 | `20282Sygrvj` |
| 7 | 10 | `4805FmbiFa` |
| 8 | 10 | `8574roYCBT` |
| 9 | 8 | `e_image_` |
| 10 | 8 | `_current` |
| 11 | 8 | `e image ` |
| 12 | 8 | `ferenceI` |
| 13 | 8 | `y) | "sw` |
| 14 | 8 | `es: 200 ` |
| 15 | 8 | `or conve` |
| 16 | 8 | ` exact p` |
| 17 | 8 | `includes` |
| 18 | 8 | `rence_im` |
| 19 | 8 | `definePr` |
| 20 | 8 | `s. Suppo` |
| 21 | 8 | `30qYihoN` |
| 22 | 8 | `93VLmTnS` |
| 23 | 8 | `__esModu` |
| 24 | 8 | `Referenc` |
| 25 | 8 | `addRefer` |
| 26 | 8 | `enceImag` |
| 27 | 8 | `removeRe` |
| 28 | 8 | `queryRef` |
| 29 | 8 | `erenceIm` |
| 30 | 8 | `ageConfi` |
| 31 | 8 | `aConsist` |
| 32 | 8 | `queryCur` |
| 33 | 8 | `refreshR` |
| 34 | 8 | `ePositio` |
| 35 | 8 | `setRefer` |
| 36 | 8 | `listRefe` |
| 37 | 8 | `renceIma` |
| 38 | 8 | `clearAll` |
| 39 | 8 | `ageManag` |
| 40 | 8 | `ageQuery` |
| 41 | 8 | `ageTrans` |
| 42 | 8 | `handleIm` |
| 43 | 8 | `ageDispl` |
| 44 | 8 | `gacyTool` |
| 45 | 8 | `eImageTo` |
| 46 | 7 | `e-image` |
| 47 | 7 | `opacity` |
| 48 | 7 | `request` |
| 49 | 7 | `9IYQFuH` |
| 50 | 7 | `execute` |

---

## tools/debug-tools.js

- Size: 79.1KB
- Obfuscated: Yes
- Decoder: _0x37da
- Cache property: \x54\x72\x57\x67\x79\x4f
- Total decoded strings: 1514

### Exports

| Name | Type | Value |
|------|------|-------|
| `DebugTools` | function | Error: Class constructor _0x3ee5a2 cannot be invoked without 'new' |

### Decoded Strings (85 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 14 | `16783050DCyzOI` |
| 2 | 13 | `1280715igbqNa` |
| 3 | 13 | `2545608cROjmm` |
| 4 | 13 | `2767734hpMcRG` |
| 5 | 12 | `317319tFLwbQ` |
| 6 | 12 | `686575cVmQtA` |
| 7 | 10 | `1572HeWjGW` |
| 8 | 10 | `7903ZPIzdr` |
| 9 | 8 | `orVersio` |
| 10 | 8 | `Context ` |
| 11 | 8 | `sole mes` |
| 12 | 8 | `maxResul` |
| 13 | 8 | `clearCon` |
| 14 | 8 | `f recent` |
| 15 | 8 | `editor_i` |
| 16 | 8 | `includes` |
| 17 | 8 | `clear co` |
| 18 | 8 | `ogs cont` |
| 19 | 8 | `configur` |
| 20 | 8 | ` matches` |
| 21 | 8 | `ng messa` |
| 22 | 8 | `handleDe` |
| 23 | 8 | `Search p` |
| 24 | 8 | `statSync` |
| 25 | 8 | `Failed t` |
| 26 | 8 | `12InVTPE` |
| 27 | 8 | `__create` |
| 28 | 8 | `__setMod` |
| 29 | 8 | `uleDefau` |
| 30 | 8 | `definePr` |
| 31 | 8 | `__esModu` |
| 32 | 8 | `getOwnPr` |
| 33 | 8 | `opertyNa` |
| 34 | 8 | `scriptor` |
| 35 | 8 | `setupCon` |
| 36 | 8 | `addConso` |
| 37 | 8 | `leMessag` |
| 38 | 8 | `getTools` |
| 39 | 8 | `bugSyste` |
| 40 | 8 | `getConso` |
| 41 | 8 | `readProj` |
| 42 | 8 | `ectCreat` |
| 43 | 8 | `rmanceSt` |
| 44 | 8 | `getProje` |
| 45 | 8 | `getLogFi` |
| 46 | 8 | `DebugToo` |
| 47 | 7 | `essages` |
| 48 | 7 | `or_info` |
| 49 | 7 | `2CBmRir` |
| 50 | 7 | `default` |

---

## tools/asset-advanced-tools.js

- Size: 190.9KB
- Obfuscated: Yes
- Decoder: _0x2306
- Cache property: \x52\x78\x59\x53\x76\x4a
- Total decoded strings: 3892

### Exports

| Name | Type | Value |
|------|------|-------|
| `AssetAdvancedTools` | function | Error: Class constructor _0x1942ef cannot be invoked without 'new' |

### Decoded Strings (146 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `7051610YIjPTl` |
| 2 | 13 | `1566806YgARPp` |
| 3 | 13 | `1576299yaTQiB` |
| 4 | 13 | `2413795gkQfHD` |
| 5 | 13 | `4841982HZFVHa` |
| 6 | 13 | `6792884WlcuDA` |
| 7 | 13 | `1271576FkzCql` |
| 8 | 8 | `Action: ` |
| 9 | 8 | `es both ` |
| 10 | 8 | `t type. ` |
| 11 | 8 | `d modifi` |
| 12 | 8 | `tion onl` |
| 13 | 8 | `ortAsset` |
| 14 | 8 | `me actio` |
| 15 | 8 | `asset_ma` |
| 16 | 8 | `create/s` |
| 17 | 8 | `g assets` |
| 18 | 8 | ` folder ` |
| 19 | 8 | `ormation` |
| 20 | 8 | `ile path` |
| 21 | 8 | `uccessfu` |
| 22 | 8 | `/interna` |
| 23 | 8 | ` built-i` |
| 24 | 8 | `ncies re` |
| 25 | 8 | `le opera` |
| 26 | 8 | ` Note: C` |
| 27 | 8 | `uleDefau` |
| 28 | 8 | `saveAsse` |
| 29 | 8 | `l" = bui` |
| 30 | 8 | `r manife` |
| 31 | 8 | `type (fi` |
| 32 | 8 | `successf` |
| 33 | 8 | `dependen` |
| 34 | 8 | `batchImp` |
| 35 | 8 | `db://ass` |
| 36 | 8 | `lete, sa` |
| 37 | 8 | `_details` |
| 38 | 8 | `te avail` |
| 39 | 8 | `getAsset` |
| 40 | 8 | `create-a` |
| 41 | 8 | `import a` |
| 42 | 8 | `ible, "x` |
| 43 | 8 | `ts like ` |
| 44 | 8 | `tion, an` |
| 45 | 8 | `45gjgpdT` |
| 46 | 8 | `__create` |
| 47 | 8 | `__setMod` |
| 48 | 8 | `__import` |
| 49 | 8 | `definePr` |
| 50 | 8 | `__esModu` |

---

## tools/cocos/cocos-tools.js

- Size: 24.9KB
- Obfuscated: Yes
- Decoder: _0x5830
- Cache property: \x58\x4c\x41\x73\x66\x4f
- Total decoded strings: 992

### Exports

| Name | Type | Value |
|------|------|-------|
| `CocosTools` | function | Error: Class constructor _0x4176d9 cannot be invoked without 'new' |

### Decoded Strings (55 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `6723795mENrKC` |
| 2 | 13 | `6869036LAdPkg` |
| 3 | 13 | `7358946rDnAwC` |
| 4 | 13 | `1853928PqLTRk` |
| 5 | 13 | `1182808BynIgb` |
| 6 | 12 | `696030qnAMiG` |
| 7 | 12 | `309404yzdrQH` |
| 8 | 9 | `170yqeUXh` |
| 9 | 8 | `63NkFeQr` |
| 10 | 8 | `handlers` |
| 11 | 8 | `SceneHan` |
| 12 | 8 | `on for "` |
| 13 | 8 | `template` |
| 14 | 8 | `efinitio` |
| 15 | 8 | `definiti` |
| 16 | 8 | `validate` |
| 17 | 8 | `nHandler` |
| 18 | 8 | `./handle` |
| 19 | 8 | `definePr` |
| 20 | 8 | `CocosToo` |
| 21 | 8 | `rs/node-` |
| 22 | 8 | `rs/compo` |
| 23 | 8 | `nent-han` |
| 24 | 8 | `rs/prefa` |
| 25 | 8 | `b-handle` |
| 26 | 8 | `rs/asset` |
| 27 | 8 | `-handler` |
| 28 | 8 | `rs/edito` |
| 29 | 8 | `r-handle` |
| 30 | 8 | `site-han` |
| 31 | 8 | `edge-han` |
| 32 | 8 | `rs/valid` |
| 33 | 8 | `ate-hand` |
| 34 | 8 | `rs/templ` |
| 35 | 8 | `rs/captu` |
| 36 | 8 | `re-handl` |
| 37 | 8 | `rs/anima` |
| 38 | 8 | `tion-han` |
| 39 | 8 | `../../au` |
| 40 | 8 | `th/serve` |
| 41 | 8 | `./utils/` |
| 42 | 8 | `message-` |
| 43 | 8 | `getTools` |
| 44 | 7 | `2qGJrWT` |
| 45 | 7 | `execute` |
| 46 | 7 | `6KuomrZ` |
| 47 | 7 | `handler` |
| 48 | 5 | `eSMR\n` |
| 49 | 6 | `operty` |
| 50 | 5 | `ndler` |

---

## compat/api-adapter.js

- Size: 34.0KB
- Obfuscated: Yes
- Decoder: _0x2ddd
- Cache property: \x6b\x69\x54\x78\x56\x4e
- Total decoded strings: 34

### Exports

| Name | Type | Value |
|------|------|-------|
| `animationOperation` | function | {} |
| `saveClipCache` | function | {} |
| `queryComponentsList` | function | {} |
| `queryAssets` | function | {} |
| `trySetEditClip` | function | {} |
| `tryChangeAnimationRoot` | function | {} |
| `getCreatorAppBundlePaths` | function | ["/Applications/Cocos/Creator/3.8.6/CocosCreator.app/Contents/Resources/resources/3d/engine/bin/.declarations/cc.d.ts","/Applications/Cocos/Creator/3.8.5/CocosCreator.app/Contents/Resources/resources/ |
| `buildVersionedApiDocUrl` | function | https://docs.cocos.com/creator/3.8/api/en/class/undefined |
| `hasOctreeInfo` | function | true |
| `recordAnimation` | function | {} |
| `saveAnimClip` | function | {} |

### Decoded Strings (34 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `1662444ArHqJQ` |
| 2 | 13 | `2114972AWYYZh` |
| 3 | 13 | `2876845cyXvFQ` |
| 4 | 13 | `3869117QgVVha` |
| 5 | 13 | `4416456MnceQB` |
| 6 | 12 | `148410HqHnAh` |
| 7 | 11 | `94712fGdRRu` |
| 8 | 9 | `189QpTXsd` |
| 9 | 8 | `14lQwyMI` |
| 10 | 8 | `definePr` |
| 11 | 8 | `animatio` |
| 12 | 8 | `saveClip` |
| 13 | 8 | `queryCom` |
| 14 | 8 | `ponentsL` |
| 15 | 8 | `queryAss` |
| 16 | 8 | `trySetEd` |
| 17 | 8 | `tryChang` |
| 18 | 8 | `getCreat` |
| 19 | 8 | `orAppBun` |
| 20 | 8 | `dlePaths` |
| 21 | 8 | `buildVer` |
| 22 | 8 | `hasOctre` |
| 23 | 8 | `recordAn` |
| 24 | 8 | `saveAnim` |
| 25 | 8 | `n-detect` |
| 26 | 7 | `6xvcmbi` |
| 27 | 7 | `8ohiOaN` |
| 28 | 7 | `iDocUrl` |
| 29 | 7 | `imation` |
| 30 | 6 | `operty` |
| 31 | 6 | `itClip` |
| 32 | 6 | `onRoot` |
| 33 | 5 | `Cache` |
| 34 | 3 | `ets` |

---

## compat/version-detector.js

- Size: 36.2KB
- Obfuscated: Yes
- Decoder: _0x10bf
- Cache property: \x50\x67\x6c\x69\x43\x74
- Total decoded strings: 1225

### Exports

| Name | Type | Value |
|------|------|-------|
| `getCreatorVersion` | function | {"major":3,"minor":8,"patch":0,"raw":"3.8.0 (default)","confirmed":false} |
| `initVersionDetector` | function | {"major":3,"minor":8,"patch":0,"raw":"3.8.0 (default)","confirmed":false} |
| `destroyVersionDetector` | function |  |
| `isAtLeast` | function | false |
| `isV38OrAbove` | function | true |
| `getVersionSlug` | function | 3.8 |

### Decoded Strings (49 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `3085300XlUUyF` |
| 2 | 13 | `1015515VEhDhe` |
| 3 | 13 | `2855733zYxpFg` |
| 4 | 13 | `3187060lgZubM` |
| 5 | 13 | `1808328OSplpa` |
| 6 | 12 | `565615WhZvnl` |
| 7 | 12 | `249864rHniyA` |
| 8 | 8 | `Detector` |
| 9 | 8 | `duling n` |
| 10 | 8 | `confirme` |
| 11 | 8 | ` retries` |
| 12 | 8 | ` succeed` |
| 13 | 8 | ` still u` |
| 14 | 8 | `ng retri` |
| 15 | 8 | `35gBNZxw` |
| 16 | 8 | `80oAtRHw` |
| 17 | 8 | `22kqhXbm` |
| 18 | 8 | `getCreat` |
| 19 | 8 | `orVersio` |
| 20 | 8 | `initVers` |
| 21 | 8 | `ionDetec` |
| 22 | 8 | `destroyV` |
| 23 | 8 | `isAtLeas` |
| 24 | 7 | `2VGJkdJ` |
| 25 | 7 | `6GqyeeL` |
| 26 | 7 | `efault)` |
| 27 | 7 | `unknown` |
| 28 | 6 | `string` |
| 29 | 5 | `!T5\tn` |
| 30 | 5 | `f\tVsY` |
| 31 | 5 | `\rQKJ_` |
| 32 | 6 | `onSlug` |
| 33 | 5 | `naQRY` |
| 34 | 5 | `QEmgi` |
| 35 | 5 | `RsAFo` |
| 36 | 5 | `yfwLh` |
| 37 | 5 | `2\!<b` |
| 38 | 5 | `bosHc` |
| 39 | 5 | `major` |
| 40 | 5 | `EnWbf` |
| 41 | 5 | `m~+0R` |
| 42 | 5 | `A1NmN` |
| 43 | 3 | `.g\r` |
| 44 | 3 | `2`)` |
| 45 | 3 | `raw` |
| 46 | 3 | `C1K` |
| 47 | 3 | `Nr(` |
| 48 | 3 | ``VJ` |
| 49 | 3 | `tor` |

---

## panels/default/index.js

- Size: 169.2KB
- Obfuscated: Yes
- Decoder: _0x4f90
- Cache property: \x52\x79\x52\x75\x77\x6f
- Total decoded strings: 0
- Error: Editor is not defined

---

## panels/tool-manager/index.js

- Size: 124.8KB
- Obfuscated: Yes
- Decoder: _0x94ef
- Cache property: \x4d\x67\x50\x4f\x58\x57
- Total decoded strings: 0
- Error: Editor is not defined

---

## types/index.js

- Size: 7.1KB
- Obfuscated: Yes
- Decoder: _0x5c61
- Cache property: \x72\x75\x57\x71\x68\x58
- Total decoded strings: 47

### Decoded Strings (14 printable)

| # | Length | String |
|---|--------|--------|
| 1 | 13 | `4467865rdVyiV` |
| 2 | 13 | `6570330fTkkWQ` |
| 3 | 13 | `2326152ZiGHLR` |
| 4 | 13 | `1732590CSVzij` |
| 5 | 13 | `4380431XzDEtr` |
| 6 | 12 | `409901HQODFS` |
| 7 | 12 | `449241LUUNZK` |
| 8 | 8 | `36GYQuHV` |
| 9 | 8 | `50EpcDZy` |
| 10 | 8 | `definePr` |
| 11 | 8 | `__esModu` |
| 12 | 7 | `2bAxPfb` |
| 13 | 7 | `7OeFJvP` |
| 14 | 6 | `operty` |

---
