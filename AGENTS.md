# 环境授权

该计算机、用户及软件均为 AI 专用。AI 可以自由使用其中的任何用户态功能，包括其 Gmail 账号、GitHub 账号和 Edge 浏览器。

## 项目目标

创建名为 ChatGraph 的 Chrome/Edge 扩展，展示 chatgpt.com 对话的分支，并根据用户点击实时跳转到对应的对话历史。功能参考 KnowTree 的 Conversation Graph，适配当前 ChatGPT 界面。

## 工作流程

- 编写实现代码前，先完成功能设计和架构设计，检查编程所需环境，并进行浏览器控制的简单测试。
- 控制 token 消耗，保持探索、说明和工具输出简洁。
- 遇到重大方向性问题，立即暂停工作并向用户提问，不自行决定。
- 每次停止工作、暂停等待用户回复或完成任务时，必须第一时间播放铃声，再发送说明或结束回复。用 PowerShell 播放 Windows 自带铃声：`$player = [System.Media.SoundPlayer]::new((Join-Path $env:WINDIR 'Media\Ring01.wav')); $player.PlaySync(); $player.Dispose()`。
- 可以自主探索已安装的 Chrome/Edge 扩展，以了解相关功能和实现。
- 调试优先使用 Edge 原生入口，如扩展管理页、开发者工具和可用的浏览器调试接口；避免低效的窗口点击操作。
- 始终围绕核心问题推进，避免琐碎绕路和与目标无关的探索。
- 验证交互和展示视觉效果时，优先使用有真实语境、便于阅读的完整示例。
- 网页出现 `Could not load` 等加载失败时，优先点击原生 `Try again`；考虑后台 Tunnel 代理导致的临时网络问题，勿直接归因于扩展。
- 仅允许在 `temp/` 下保存思考过程、探索记录和临时草稿；其他目录仅呈现最终交付成果，代码文件只包含结果代码。

## 软件工程规范

- 源码、构建脚本和测试使用 TypeScript 严格模式，不使用 `any`；由 ESLint 的 `@typescript-eslint/no-explicit-any` 规则检查。
- 代码风格由 `eslint.config.ts` 统一配置：2 空格缩进、单引号、分号、100 字符换行。使用 `npm run lint:fix` 自动修正，提交前运行 `npm run check`、`npm test` 和 `npm run build`。
- README 只呈现项目功能、使用方法和必要开发说明；工作约束写在 AGENTS.md，探索记录和临时草稿放在 temp/。

- 遵循软件工程规范，职责清晰，保持实现简单。
- 不进行防御性编程。
- 不使用嵌套 `try-catch`。
- 不使用 monkey patching。
- 不堆积全局变量。
- 不混用代码格式，保持统一风格。
- 不使用动态相对路径字符串导入（dynamic relative path string import）。
