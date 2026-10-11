# ChatGraph

**English** | [简体中文](README.zh_CN.md)

Explore ChatGPT conversation branches as a tree in a Chrome / Edge side panel. Click a message to revisit it, compare alternate paths, and continue an earlier conversation.

[![Release](https://img.shields.io/github/v/release/agent-max-agent/ChatGraph?style=flat)](https://github.com/agent-max-agent/ChatGraph/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/agent-max-agent/ChatGraph/total?style=flat)](https://github.com/agent-max-agent/ChatGraph/releases)
[![Chrome / Edge](https://img.shields.io/badge/browser-Chrome%20%2F%20Edge-4285F4?style=flat)](#installation)

## Preview

| Conversation branches | Selected message |
| --- | --- |
| ![ChatGraph's English interface showing a conversation tree with the current path in green and dashed branch connections](docs/images/branch-graph.png) | ![ChatGraph's interface showing a selected message and its full text below the graph](docs/images/message-details.png) |

## Features

- View the current conversation and related branches, with one node per message. The current path is green; dashed lines connect branches.
- Click a message in the current conversation to scroll to it. Click a message in another saved branch to open that conversation and locate the message.
- Open ChatGPT's native Versions dialog to locate an older message version within the same conversation.
- See newly created branches as drafts. Once you send a message and ChatGPT saves the conversation, ChatGraph remembers the branch for later navigation.
- Scan history to find branches created before installing the extension. Pause and resume the scan, with progress saved locally.
- Automatically scroll to load messages that are not yet visible before locating them.
- Read selected messages in a floating bottom preview. Drag its top edge to resize it, or collapse it completely. Reopening restores its previous height while the graph fills the main area.
- Automatically follow your system's light or dark color scheme, including changes while the side panel is open.

A new branch remains a temporary ChatGPT draft until you send a message and the conversation is saved. Leaving or refreshing the page may lose the draft. Saved conversations can be reopened using their conversation IDs. ChatGraph does not intercept or modify ChatGPT's native “Branch in new chat” action. Use ChatGraph to switch between existing branches.

## Installation

### Option 1: Download a release

1. Open [GitHub Releases](https://github.com/agent-max-agent/ChatGraph/releases/latest) and download the extension ZIP from **Assets**.
2. Extract the ZIP into a folder you will keep on your computer.
3. Open `edge://extensions/` or `chrome://extensions/`, enable **Developer mode**, and choose **Load unpacked**. Select the extracted folder containing `manifest.json`.

### Option 2: Build from source

Requires Git, Node.js 24, and npm.

```sh
git clone https://github.com/agent-max-agent/ChatGraph.git
cd ChatGraph
npm install
npm run build
```

Open `edge://extensions/` or `chrome://extensions/`, enable **Developer mode**, and choose **Load unpacked**. Select the generated `dist/` folder.

### Open ChatGraph

Sign in to `chatgpt.com`, open a conversation, and click the ChatGraph toolbar icon to open the side panel.

The interface supports English and Simplified Chinese. It follows your browser language by default. To change it, open ChatGraph's details on the extensions page and select **Extension options**. Your selection is saved locally, and conversation text stays in its original language.

## Data and compatibility

Conversation data and branch relationships are stored locally and are not uploaded to other services. The extension reads data using your current ChatGPT session and does not store access tokens. It relies on ChatGPT's internal APIs, so website updates may require compatibility changes.

## Local development

After installing from source, use these commands to check and rebuild your changes:

```sh
npm run check
npm run build
npm test
```

After changing code, rebuild, reload the extension on the extensions page, and refresh the ChatGPT page. `npm run dev` watches TypeScript files; changes to HTML, CSS, or translation files require a new build.

`npm run check` checks types and code style; `npm run lint:fix` fixes formatting. Translation catalogs are in `public/_locales/en/messages.json` and `public/_locales/zh_CN/messages.json`.

## Project structure

- `src/`: TypeScript source for the background worker, page interaction, message tree, and side panel.
- `public/`: Extension manifest, side-panel HTML, styles, and translations.
- `scripts/`: Build scripts.
- `tests/`: Message-tree and localization tests.
- `docs/images/`: README screenshots.
- `temp/`: Local temporary files, excluded from the extension.

## Authors

Developed by [**Agent Max**](https://github.com/agent-max-agent) (GPT-6.1-Sol) with guidance from [**SaturnTsen**](https://github.com/SaturnTsen).

## License

Licensed under the [GNU General Public License v3.0](LICENSE) (GPL-3.0-only).
