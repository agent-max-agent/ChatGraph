# ChatGraph

Chrome / Edge 的 ChatGPT 对话分支侧栏。读取消息树与分叉来源，显示消息节点，点击已有分支打开对应对话并定位消息。

## 开发与加载

直接安装：从 [GitHub Releases](https://github.com/agent-max-agent/ChatGraph/releases) 下载 `ChatGraph-v0.1.0.zip` 并解压。在 `edge://extensions/` 或 `chrome://extensions/` 开启开发者模式，选择“加载解压缩的扩展”，选择解压后的目录。打开已登录的 ChatGPT 对话，点击 ChatGraph 工具栏按钮。

需要 Node.js 24 和 npm。

```sh
npm install
npm run build
npm test
npm run check
```

在 `edge://extensions/` 或 `chrome://extensions/` 开启开发者模式，选择“加载解压缩的扩展”，加载本项目的 `dist/`。打开已登录的 `chatgpt.com` 对话，点击 ChatGraph 工具栏按钮打开侧栏。

修改代码后重新运行构建，在扩展管理页重新加载扩展，并刷新聊天页面。`npm run dev` 监听 JavaScript 文件变化；修改静态资源后重新构建。

## 当前能力

- 读取当前会话及其父会话链，持久化已发现的分支关系。
- 绘制用户与助手消息节点，区分当前路径与分叉连线。
- 点击当前消息定位；点击其他已保存会话的节点跳转其 URI。
- 草稿地址与正式对话 UUID 分开处理。
- 原生新分支创建后展示草稿路径，续聊保存后自动关联正式对话。
- 点击同会话旧版本节点打开原生 Versions 窗口并定位。
- 目标消息尚未加载时，自动滚动原生历史区加载并定位。
- 通过“补录历史”发现已有子分支，支持暂停和继续，进度保存在本地。

已在 Edge 验证分叉保存、跨对话跳转、版本定位、历史补录、标签页同步和长对话定位。Chrome 153 已通过扩展加载、原生侧栏、消息图呈现及页面脚本访问检查；登录态完整流程在 Edge 验证。

对话索引保存在扩展本地存储，不上传至外部服务。请求使用 ChatGPT 当前登录态，访问令牌不保存。页面接口属于 ChatGPT 内部接口，界面或接口更新可能需要调整适配。

未发送消息的新分支是 ChatGPT 临时草稿，离开或重新加载后不能保证恢复；发送消息保存后，才可按正式 UUID 重复打开。ChatGraph 不拦截或修改原生“Branch in new chat”动作。

## 目录

- `src/`：后台协调、页面适配、图模型和侧栏。
- `public/`：Manifest、侧栏 HTML 与样式。
- `scripts/`：构建入口。
- `tests/`：图模型测试。
- `temp/`：本地探索与临时验证文件，不属于扩展发行内容。
