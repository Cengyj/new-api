# AI Creation routes

This folder only contains thin route wrappers for the three direct sidebar entries:

- `Chat.jsx` -> `features/ai-creation/ChatTab.jsx`
- `Image.jsx` -> `features/ai-creation/ImageGenerationTab.jsx`
- `Video.jsx` -> `features/ai-creation/VideoGenerationTab.jsx`

Do not put product UI, layout experiments, service adapters, task cards, or shared controls in this folder. Those belong in `web/src/features/ai-creation/`.

Do not add a parent `index.jsx` or a "创作中心" tab container here. The intended navigation model is direct entries at the same level as Playground: 对话, 生图, 视频.
