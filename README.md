# ChatGraph

ChatGraph 是一个 Chrome / Edge 扩展，用树状图展示 ChatGPT 对话的分支。点击图中的消息，就能回到对应的聊天记录，方便比较不同版本、接着聊之前的思路。

## 安装和使用

1. 从 [GitHub Releases](https://github.com/agent-max-agent/ChatGraph/releases) 下载扩展压缩包并解压。已发布的 v0.1.0 只有中文界面；本次新增的中英文切换请先从源码构建。
2. 打开 `edge://extensions/` 或 `chrome://extensions/`，开启开发者模式，点击“加载解压缩的扩展”，选择解压后的目录。
3. 登录 `chatgpt.com` 并打开一个对话，点击工具栏上的 ChatGraph 图标，展开侧栏。

界面支持中文和英文，默认跟随浏览器语言，也可以在侧栏右上角手动切换。语言选择会保存在本机，不会翻译你的聊天内容。

## 本地开发

需要 Node.js 24 和 npm。

```sh
npm install
npm run check
npm run build
npm test
```

构建后，按上面的安装步骤加载 `dist/`。

修改代码后重新构建，在扩展管理页重新加载扩展，再刷新 ChatGPT 页面。`npm run dev` 会监听 TypeScript 文件变化；修改 HTML、样式或翻译文件后需重新构建。

源码启用 TypeScript 严格模式，不使用 `any`；`npm run check` 检查类型并禁止显式 `any`。翻译文件位于 `public/_locales/en/messages.json` 和 `public/_locales/zh_CN/messages.json`，两种语言使用相同的文案键。

## 功能

- 展示当前对话及相关分支，每条消息对应一个节点。绿色标出当前聊天路径，虚线连接分支。
- 点击当前对话中的消息，滚动到对应位置；点击其他已保存分支中的消息，打开那个对话并定位。
- 点击同一对话中的旧版本消息，打开 ChatGPT 自带的 Versions 窗口，找到对应版本。
- 新建分支后先显示草稿；发送消息并保存后，自动记录正式对话。
- 点击“扫描历史”，找出安装扩展前创建的分支。扫描可以暂停、继续，进度保存在本机。
- 长对话中尚未加载的消息，会在自动滚动、加载后定位。

新建分支后如果还没发送消息，它只是 ChatGPT 的临时草稿。离开或刷新页面后，草稿不一定能恢复；发送消息并保存后，才能通过保存后的对话 ID 再次打开。ChatGraph 不会拦截或修改 ChatGPT 自带的“Branch in new chat”操作。

## 数据和兼容性

对话数据和分支关系保存在扩展的本地存储中，不会上传到其他服务。扩展使用 ChatGPT 当前的登录状态读取数据，不保存访问令牌。由于使用了 ChatGPT 内部接口，网站更新后可能需要调整扩展。

此前已在 Edge 验证分支保存、跨对话跳转、历史版本定位、历史扫描、标签页同步和长对话定位。Chrome 153 已验证扩展加载、侧栏显示和页面数据读取；登录后的完整流程在 Edge 验证。

## 项目结构

- `src/`：TypeScript 源码，包括后台、页面交互、消息树和侧栏。
- `public/`：扩展配置、侧栏 HTML、样式和翻译文件。
- `scripts/`：构建与代码检查脚本。
- `tests/`：消息树和多语言测试。
- `temp/`：本地探索和临时验证文件，不包含在扩展中。
