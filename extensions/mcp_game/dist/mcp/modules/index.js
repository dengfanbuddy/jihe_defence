"use strict";
/**
 * MCP 模块统一导出
 *
 * 此文件被 source/main.ts 导入，触发所有 @MCPModule / @MCPTool 装饰器执行，
 * 从而自动向 MetadataRegistry 注册模块和工具元数据。
 *
 * 添加新模块时在此处增加一行 export。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TemplateModule = exports.CaptureModule = exports.BuilderModule = exports.ViewModule = exports.SpineModule = exports.LabelModule = exports.AnimationModule = exports.KnowledgeModule = exports.ValidationModule = exports.BroadcastModule = exports.DebugModule = exports.PrefabModule = exports.ProjectModule = exports.AssetModule = exports.SceneModule = void 0;
var SceneModule_1 = require("./SceneModule");
Object.defineProperty(exports, "SceneModule", { enumerable: true, get: function () { return SceneModule_1.SceneModule; } });
var AssetModule_1 = require("./AssetModule");
Object.defineProperty(exports, "AssetModule", { enumerable: true, get: function () { return AssetModule_1.AssetModule; } });
var ProjectModule_1 = require("./ProjectModule");
Object.defineProperty(exports, "ProjectModule", { enumerable: true, get: function () { return ProjectModule_1.ProjectModule; } });
var PrefabModule_1 = require("./PrefabModule");
Object.defineProperty(exports, "PrefabModule", { enumerable: true, get: function () { return PrefabModule_1.PrefabModule; } });
var DebugModule_1 = require("./DebugModule");
Object.defineProperty(exports, "DebugModule", { enumerable: true, get: function () { return DebugModule_1.DebugModule; } });
var BroadcastModule_1 = require("./BroadcastModule");
Object.defineProperty(exports, "BroadcastModule", { enumerable: true, get: function () { return BroadcastModule_1.BroadcastModule; } });
var ValidationModule_1 = require("./ValidationModule");
Object.defineProperty(exports, "ValidationModule", { enumerable: true, get: function () { return ValidationModule_1.ValidationModule; } });
var KnowledgeModule_1 = require("./KnowledgeModule");
Object.defineProperty(exports, "KnowledgeModule", { enumerable: true, get: function () { return KnowledgeModule_1.KnowledgeModule; } });
var AnimationModule_1 = require("./AnimationModule");
Object.defineProperty(exports, "AnimationModule", { enumerable: true, get: function () { return AnimationModule_1.AnimationModule; } });
var LabelModule_1 = require("./LabelModule");
Object.defineProperty(exports, "LabelModule", { enumerable: true, get: function () { return LabelModule_1.LabelModule; } });
var SpineModule_1 = require("./SpineModule");
Object.defineProperty(exports, "SpineModule", { enumerable: true, get: function () { return SpineModule_1.SpineModule; } });
var ViewModule_1 = require("./ViewModule");
Object.defineProperty(exports, "ViewModule", { enumerable: true, get: function () { return ViewModule_1.ViewModule; } });
var BuilderModule_1 = require("./BuilderModule");
Object.defineProperty(exports, "BuilderModule", { enumerable: true, get: function () { return BuilderModule_1.BuilderModule; } });
var CaptureModule_1 = require("./CaptureModule");
Object.defineProperty(exports, "CaptureModule", { enumerable: true, get: function () { return CaptureModule_1.CaptureModule; } });
var TemplateModule_1 = require("./TemplateModule");
Object.defineProperty(exports, "TemplateModule", { enumerable: true, get: function () { return TemplateModule_1.TemplateModule; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvbWNwL21vZHVsZXMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7O0dBT0c7OztBQUVILDZDQUE0QztBQUFuQywwR0FBQSxXQUFXLE9BQUE7QUFDcEIsNkNBQTRDO0FBQW5DLDBHQUFBLFdBQVcsT0FBQTtBQUNwQixpREFBZ0Q7QUFBdkMsOEdBQUEsYUFBYSxPQUFBO0FBQ3RCLCtDQUE4QztBQUFyQyw0R0FBQSxZQUFZLE9BQUE7QUFDckIsNkNBQTRDO0FBQW5DLDBHQUFBLFdBQVcsT0FBQTtBQUNwQixxREFBb0Q7QUFBM0Msa0hBQUEsZUFBZSxPQUFBO0FBQ3hCLHVEQUFzRDtBQUE3QyxvSEFBQSxnQkFBZ0IsT0FBQTtBQUN6QixxREFBb0Q7QUFBM0Msa0hBQUEsZUFBZSxPQUFBO0FBQ3hCLHFEQUFvRDtBQUEzQyxrSEFBQSxlQUFlLE9BQUE7QUFDeEIsNkNBQTRDO0FBQW5DLDBHQUFBLFdBQVcsT0FBQTtBQUNwQiw2Q0FBNEM7QUFBbkMsMEdBQUEsV0FBVyxPQUFBO0FBQ3BCLDJDQUEwQztBQUFqQyx3R0FBQSxVQUFVLE9BQUE7QUFDbkIsaURBQWdEO0FBQXZDLDhHQUFBLGFBQWEsT0FBQTtBQUN0QixpREFBZ0Q7QUFBdkMsOEdBQUEsYUFBYSxPQUFBO0FBQ3RCLG1EQUFrRDtBQUF6QyxnSEFBQSxjQUFjLE9BQUEiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE1DUCDmqKHlnZfnu5/kuIDlr7zlh7pcbiAqXG4gKiDmraTmlofku7booqsgc291cmNlL21haW4udHMg5a+85YWl77yM6Kem5Y+R5omA5pyJIEBNQ1BNb2R1bGUgLyBATUNQVG9vbCDoo4XppbDlmajmiafooYzvvIxcbiAqIOS7juiAjOiHquWKqOWQkSBNZXRhZGF0YVJlZ2lzdHJ5IOazqOWGjOaooeWdl+WSjOW3peWFt+WFg+aVsOaNruOAglxuICpcbiAqIOa3u+WKoOaWsOaooeWdl+aXtuWcqOatpOWkhOWinuWKoOS4gOihjCBleHBvcnTjgIJcbiAqL1xuXG5leHBvcnQgeyBTY2VuZU1vZHVsZSB9IGZyb20gJy4vU2NlbmVNb2R1bGUnO1xuZXhwb3J0IHsgQXNzZXRNb2R1bGUgfSBmcm9tICcuL0Fzc2V0TW9kdWxlJztcbmV4cG9ydCB7IFByb2plY3RNb2R1bGUgfSBmcm9tICcuL1Byb2plY3RNb2R1bGUnO1xuZXhwb3J0IHsgUHJlZmFiTW9kdWxlIH0gZnJvbSAnLi9QcmVmYWJNb2R1bGUnO1xuZXhwb3J0IHsgRGVidWdNb2R1bGUgfSBmcm9tICcuL0RlYnVnTW9kdWxlJztcbmV4cG9ydCB7IEJyb2FkY2FzdE1vZHVsZSB9IGZyb20gJy4vQnJvYWRjYXN0TW9kdWxlJztcbmV4cG9ydCB7IFZhbGlkYXRpb25Nb2R1bGUgfSBmcm9tICcuL1ZhbGlkYXRpb25Nb2R1bGUnO1xuZXhwb3J0IHsgS25vd2xlZGdlTW9kdWxlIH0gZnJvbSAnLi9Lbm93bGVkZ2VNb2R1bGUnO1xuZXhwb3J0IHsgQW5pbWF0aW9uTW9kdWxlIH0gZnJvbSAnLi9BbmltYXRpb25Nb2R1bGUnO1xuZXhwb3J0IHsgTGFiZWxNb2R1bGUgfSBmcm9tICcuL0xhYmVsTW9kdWxlJztcbmV4cG9ydCB7IFNwaW5lTW9kdWxlIH0gZnJvbSAnLi9TcGluZU1vZHVsZSc7XG5leHBvcnQgeyBWaWV3TW9kdWxlIH0gZnJvbSAnLi9WaWV3TW9kdWxlJztcbmV4cG9ydCB7IEJ1aWxkZXJNb2R1bGUgfSBmcm9tICcuL0J1aWxkZXJNb2R1bGUnO1xuZXhwb3J0IHsgQ2FwdHVyZU1vZHVsZSB9IGZyb20gJy4vQ2FwdHVyZU1vZHVsZSc7XG5leHBvcnQgeyBUZW1wbGF0ZU1vZHVsZSB9IGZyb20gJy4vVGVtcGxhdGVNb2R1bGUnO1xuIl19