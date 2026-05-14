# AI Creation 模块 — 自包含集成指南

本目录(`web/src/features/ai-creation/`)是 **对话 / 生图 / 视频** 三个用户页面的唯一所有者。
所有页面逻辑、子组件、样式、业务工具、网络适配器、后台控制器、测试都集中放在这里,
以便后续每次合并上游 `new-api` 新版本时,**绝大部分代码只需要整体覆盖本目录**,而不需要去
全仓库零散修改文件。

> ⚠️ **给后续维护的 AI / 开发者的核心规则**
>
> 1. **新增任何代码默认放进本目录**(包括组件、hooks、工具、样式、静态资源、测试)。
>    只有当变更明显属于"全局框架职责"(路由注册、全局侧边栏、布局开关、i18n 资源、
>    管理面板配置)时,才被允许去修改"外部触点"清单中的文件。
> 2. **不要**在 `web/src/components/ai-creation/`、`web/src/pages/AiCreation/`(除三个
>    薄路由 wrapper)、`web/src/contexts/`、`web/src/hooks/` 等位置放本模块的业务代码。
> 3. **不要**重新引入 `AiCreationCenter`、父级 Tab 容器、`features/ai-creation/index.jsx`
>    或 `pages/AiCreation/index.jsx`。导航模型固定为侧边栏三个同级直链。
> 4. 任何面向用户的中文文案必须使用 `t('中文key')` 并同步全部 7 个 locale。

---

## 目录索引

```
web/src/features/ai-creation/
├── README.md                       ← 本文件,合并/接入说明
├── ChatTab.jsx                     ← /console/ai-creation/chat 主入口
├── ImageGenerationTab.jsx          ← /console/ai-creation/image 主入口
├── VideoGenerationTab.jsx          ← /console/ai-creation/video 主入口
├── ImageSingleTab.jsx              ← 生图-单图模式 + 导出 ComposerSelect
├── ImageBatchTab.jsx               ← 生图-批量(Excel)模式
├── VideoSingleTab.jsx              ← 视频-单视频模式
├── VideoBatchTab.jsx               ← 视频-批量模式
├── chat/
│   ├── ChatSidebar.jsx             ← 会话历史栏 + 移动端 drawer
│   ├── ChatHeader.jsx              ← 顶栏 + 模型/分组切换
│   ├── ChatComposer.jsx            ← 输入区
│   ├── ChatMessageFrame.jsx        ← 消息容器
│   ├── ChatMessageActions.jsx      ← 消息操作按钮
│   ├── ChatModelMenu.jsx           ← 模型选择浮层
│   └── chatStyles.css              ← 对话页专属覆盖样式
├── styles.css                      ← 生图/视频专属样式
├── imageBatchExcel.css             ← 批量 Excel 样式(图片+视频共用)
├── adapters.js                     ← 上游 API 请求/响应适配
├── services.js                     ← generateImages / generateVideo 入口
├── constants.js                    ← CREATION_TABS / TASK_STATUS / 比例 / 白名单 / 案例图
├── chatSessions.js                 ← 对话会话本地存储
├── utils.js                        ← 共享工具函数(含 getTimestampId 等)
├── imageBatchQueue.js              ← 生图批量队列(localStorage 持久化)
├── imageBatchTable.js              ← 生图批量表格列定义
├── imageCreationController.js      ← 生图后台轮询控制器(全局副作用)
├── videoBatchQueue.js              ← 视频批量队列
├── videoBatchTable.js              ← 视频批量表格列定义
├── videoCreationController.js      ← 视频后台轮询控制器(全局副作用)
└── __tests__/                      ← 模块自带回归测试,合并后必跑
    ├── aiCreationAdapters.test.mjs
    ├── aiCreationI18n.test.mjs
    ├── aiCreationStructure.test.mjs
    ├── aiCreationChatPolish.test.mjs
    ├── aiCreationChatA11y.test.mjs
    └── imageBatchQueue.test.mjs
```

---

## 一、模块内部约束(改这里时遵守)

### 1. 路由入口

- `ChatTab.jsx` → `/console/ai-creation/chat`
- `ImageGenerationTab.jsx` → `/console/ai-creation/image`
- `VideoGenerationTab.jsx` → `/console/ai-creation/video`

### 2. CSS 引入方式

- 三个主 Tab 自身负责 `import './xxx.css'`,**不要**把样式上抛到 `web/src/index.css`
  或全局入口。
- 当前:
  - `ChatTab.jsx` 中 `import './chat/chatStyles.css'`
  - `ImageGenerationTab.jsx` / `VideoGenerationTab.jsx` 中 `import './imageBatchExcel.css'` + `import './styles.css'`
  - `ImageBatchTab.jsx` / `VideoBatchTab.jsx` 中 `import './imageBatchExcel.css'`
- 必须保留的 scoped 选择器(被结构测试断言):
  - `.ai-creation-composer`
  - `.ai-batch-result-folder`
  - `.ai-creation-queue-dock`
  - `.ai-creation-page .batch-excel-shell`

### 3. 对话页设计基线

- `ChatTab.jsx` 拥有页面外壳、空状态、建议按钮、会话编排。
- `chat/ChatSidebar.jsx` 拥有历史栏 + 移动端 drawer。
- `chat/ChatHeader.jsx` 拥有顶栏 + 模型/分组切换 + 移动端侧栏开关。
- 复用宿主项目的 `components/playground/ChatArea.jsx`、`MessageContent.jsx`、
  `MessageActions.jsx`、`CodeViewer.jsx` 渲染消息体。
- 基础 markdown / 代码 token 规则来自宿主 `components/common/markdown/markdown.css`,
  `chat/chatStyles.css` 只做页面级覆盖。
- 视觉基线:**白底页面 + 浅灰栏 + 柔和边框 + 紧凑 composer**。不要重新引入紫色 / 重渐变。

### 4. 生图 / 视频页要点

- 批量队列在用户提交时立即入队本地任务卡,然后在后台调 `generateImages` / `generateVideo`。
- 每个本地队列项对应一次上游请求(`count: 1`),让每张卡有独立的成功/失败状态。
- 队列/任务 ID 必须用 `utils.js` 中的 `getTimestampId` 等共享 helper 生成,**禁止**
  在组件里直接用 `Date.now()` 拼 ID(快速连点会撞 ID)。
- 持久化到浏览器存储的队列数据要紧凑,**不要**把大块 base64 参考图重复存进每张图片卡。
- `imageCreationController.js` / `videoCreationController.js` 在 `App.jsx` 顶层被 import
  以保证用户离开页面后任务继续轮询(副作用模块,不要懒加载)。

### 5. 必须保留的结构关键字(被 `__tests__/aiCreationStructure.test.mjs` 锁定)

修改文件时如果触碰到这些 token,请同步更新测试或保留它们:

- `ImageGenerationTab.jsx`:`ai-creation-page--image`、`ai-creation-route-chip`、
  `ImageSingleTab`、`ImageBatchTab`、`useScenePreference`、`IMAGE_MODEL_WHITELIST`、
  `subscribeImageTasks`、`ImageQueueDock`、`function WorkCard`、`function GeneratingDots`、
  `function PreviewLightbox`、`function NoImageAccessPanel`
- `VideoGenerationTab.jsx`:同上一组的视频版(`ai-creation-page--video` / `VIDEO_MODEL_WHITELIST`
  / `subscribeVideoTasks` / `VideoQueueDock` / `NoVideoAccessPanel`)
- `ImageSingleTab.jsx`:`function ComposerSelect`、`MAX_ATTACHMENTS = 5`、
  `placeholder={t('描述新图片')}`、`ai-creation-composer`、`createImageBatchQueueItems`、
  `referenceImages: attachments.map`、`title={t('上传参考图')}`
- `VideoSingleTab.jsx`:`placeholder={t('描述新视频')}`、`VIDEO_DURATIONS = [6, 10, 12, 16, 20]`、
  `MAX_ATTACHMENTS = 7`、`createVideoBatchQueueItems`、`referenceImages: attachments.map`、
  `title={t('上传参考图')}`
- `ImageBatchTab.jsx` / `VideoBatchTab.jsx`:`batch-excel-shell`、`ai-batch-results`、
  `onEnqueue`、`onPreview`、`download`、`historyRef`
- `promptLibrary/zhCNPromptLibrary.js`:EvoLinkAI 中文 prompt library 静态数据,图片使用 `/prompt-library/`

---

## 二、外部触点清单(合并上游时必须补回的 7 处)

> 把上游新版 `new-api` 下载下来后,先把本目录**整体覆盖**进去,然后按下面 7 处依次补丁。
> 每条都注明"插在哪里、插入什么、为什么不能内化"。

### 触点 1 — `web/src/App.jsx`(路由注册)

无法内化:Router 必须在宿主 `App.jsx` 内声明。

需要添加的内容:

```jsx
// 顶部 lazy import(与其他 lazy 页放一起)
const AiChat = lazy(() => import('./pages/AiCreation/Chat'));
const AiImage = lazy(() => import('./pages/AiCreation/Image'));
const AiVideo = lazy(() => import('./pages/AiCreation/Video'));

// 紧接 lazy 之后的副作用 import(全局后台轮询,必须在用户登录后尽早执行)
import './features/ai-creation/imageCreationController.js';
import './features/ai-creation/videoCreationController.js';
```

在 `<Routes>` 中插入三条路由(在 `/console/playground` 之后):

```jsx
<Route path='/console/ai-creation/chat'  element={<PrivateRoute><Suspense fallback={<Loading/>} key={location.pathname}><AiChat/></Suspense></PrivateRoute>} />
<Route path='/console/ai-creation/image' element={<PrivateRoute><Suspense fallback={<Loading/>} key={location.pathname}><AiImage/></Suspense></PrivateRoute>} />
<Route path='/console/ai-creation/video' element={<PrivateRoute><Suspense fallback={<Loading/>} key={location.pathname}><AiVideo/></Suspense></PrivateRoute>} />
```

### 触点 2 — `web/src/pages/AiCreation/` 三个薄 wrapper

无法完全内化:`App.jsx` 通过 `pages/AiCreation/*` 懒加载;wrapper 还负责套顶部
固定栏(`mt-[64px] h-[calc(100vh-64px)]`)。

需要的文件(总计 3 个,极简):

`pages/AiCreation/Chat.jsx`:

```jsx
import React from 'react';
import ChatTab from '../../features/ai-creation/ChatTab';
const AiChat = () => (
  <div
    className='mt-[64px] h-[calc(100vh-64px)] overflow-hidden'
    style={{ background: 'var(--semi-color-bg-0)' }}
  >
    <ChatTab />
  </div>
);
export default AiChat;
```

`pages/AiCreation/Image.jsx`:

```jsx
import React from 'react';
import ImageGenerationTab from '../../features/ai-creation/ImageGenerationTab';
const AiImage = () => (
  <div className='mt-[64px] h-[calc(100vh-64px)] bg-white'>
    <ImageGenerationTab />
  </div>
);
export default AiImage;
```

`pages/AiCreation/Video.jsx`:

```jsx
import React from 'react';
import VideoGenerationTab from '../../features/ai-creation/VideoGenerationTab';
const AiVideo = () => (
  <div className='mt-[64px] h-[calc(100vh-64px)] bg-white'>
    <VideoGenerationTab />
  </div>
);
export default AiVideo;
```

> 禁止在 `pages/AiCreation/` 下放业务 UI、服务适配、任务卡或共享控件。这些都属于
> `web/src/features/ai-creation/`。也禁止新增 `pages/AiCreation/index.jsx`。

### 触点 3 — `web/src/components/layout/SiderBar.jsx`(侧边栏菜单)

无法内化:这是宿主项目唯一的全局侧边栏。

a) 在路径常量映射中加入三条:

```js
aiCreationChat:  '/console/ai-creation/chat',
aiCreationImage: '/console/ai-creation/image',
aiCreationVideo: '/console/ai-creation/video',
```

b) 在 `chatMenuItems` 数组的最前面插入三个直链项:

```jsx
{ text: t('对话'), itemKey: 'aiCreationChat',  to: '/console/ai-creation/chat'  },
{ text: t('生图'), itemKey: 'aiCreationImage', to: '/console/ai-creation/image' },
{ text: t('视频'), itemKey: 'aiCreationVideo', to: '/console/ai-creation/video' },
```

c) 在 selected key 回退匹配逻辑中加入(当无精确路由命中时):

```js
if (!matchingKey && currentPath.startsWith('/console/ai-creation')) {
  if (currentPath.includes('/image')) matchingKey = 'aiCreationImage';
  else if (currentPath.includes('/video')) matchingKey = 'aiCreationVideo';
  else matchingKey = 'aiCreationChat';
}
```

### 触点 4 — `web/src/hooks/common/useSidebar.js`(管理面板默认开关)

无法内化:管理员侧边栏可见性配置必须落到这里。

a) 在 `DEFAULT_ADMIN_CONFIG.chat` 中加入(放在 `chat` 子节点的字段里):

```js
aiCreationChat:  true,
aiCreationImage: true,
aiCreationVideo: true,
```

b) 在文件中保留 / 加入 `normalizeAiCreationConfig`,做老字段 `aiCreation` 到新三个字段的兼容标准化(参见现有实现)。

### 触点 5 — `web/src/components/layout/PageLayout.jsx`(布局开关)

无法内化:布局壳子由宿主全局控制。

```js
// 关闭对话页的页脚:
const shouldHideFooter =
  cardProPages.includes(location.pathname) ||
  location.pathname === '/console/ai-creation/chat';

// 关闭 AI 创作页的内边距:
const shouldInnerPadding =
  location.pathname.includes('/console') &&
  !location.pathname.startsWith('/console/chat') &&
  location.pathname !== '/console/playground' &&
  !location.pathname.startsWith('/console/ai-creation');
```

### 触点 6 — `web/public/prompt-library/`(创作灵感素材图)

无法内化(暂时):创作灵感图片由同步脚本写入 `web/public/prompt-library/`,
并被 `__tests__/aiCreationStructure.test.mjs` 校验为本地静态图片。

合并时:复制 `web/public/prompt-library/`,或在目标仓库运行 `npm run prompt-library:sync` 重新生成。

### 触点 7 — `web/src/i18n/locales/{zh-CN,zh-TW,en,fr,ru,ja,vi}.json`(翻译资源)

无法内化:i18next 通过宿主的 `i18n/locales/*.json` 加载。

- 本模块所有面向用户的中文字符串都走 `t('中文key')`。
- `__tests__/aiCreationI18n.test.mjs` 会**递归扫描**本目录,把所有 `t('xxx')` 提取
  出来,在 7 个 locale 文件里全部查找,缺一个就失败。
- 合并新上游版本时,必须把当前 7 个 locale 文件中**属于 AI Creation 的 key**(
  对照本目录代码的 `t(...)` 集合)合并进上游的 locale 文件。

> 当前 AI Creation 模块约 **180** 个独立翻译 key,均散落在 `zh-CN.json` / `zh-TW.json`
> / `en.json` / `fr.json` / `ru.json` / `ja.json` / `vi.json` 中。
> 由于 i18n 文件按"中文 key → 各语种值"的扁平 JSON 组织,**只新增/合并自己的 key**
> 通常不会与上游冲突,但要避免覆盖上游同名 key 的翻译。

---

## 三、合并上游新版本的标准流程

1. 把上游新版 `new-api` 解压到新目录;
2. 把本仓库的 **整个** `web/src/features/ai-creation/` 目录覆盖过去;
3. 把本仓库的 `web/public/prompt-library/` 复制过去,或重新运行 `npm run prompt-library:sync`;
4. 按 §二的 7 处触点依次打补丁:
   - **必改**:`App.jsx`、`pages/AiCreation/{Chat,Image,Video}.jsx`、`SiderBar.jsx`、
     `useSidebar.js`、`PageLayout.jsx`、7 个 locale JSON;
5. 安装并构建前端:
   ```bash
   cd web
   bun install
   bun run build
   ```
6. 跑本模块全部回归测试(必须全部通过):
   ```bash
   cd web
   node src/features/ai-creation/__tests__/aiCreationStructure.test.mjs
   node src/features/ai-creation/__tests__/aiCreationI18n.test.mjs
   node src/features/ai-creation/__tests__/aiCreationAdapters.test.mjs
   node src/features/ai-creation/__tests__/aiCreationChatPolish.test.mjs
   node src/features/ai-creation/__tests__/aiCreationChatA11y.test.mjs
   node src/features/ai-creation/__tests__/imageBatchQueue.test.mjs
   ```
7. 手动验证三条路由:
   - `/console/ai-creation/chat`(对话页:白底 + 浅灰栏,移动端 drawer 正常)
   - `/console/ai-creation/image`(生图:单图 / 批量切换;Excel 批量正常导入导出)
   - `/console/ai-creation/video`(视频:单视频 / 批量;参考图上传 ≤ 7 张)
   - 离开页面后,生图 / 视频任务仍在后台轮询(`imageCreationController` /
     `videoCreationController` 已在 `App.jsx` 顶层 import)。

---

## 四、给后续 AI 的硬性要求(写代码前先读)

- ✅ **新代码默认放进 `web/src/features/ai-creation/`**,只有当变更明显属于路由 /
  导航 / 全局布局 / 全局 i18n / 全局管理配置时,才被允许去碰外部触点。
- ✅ 任何新增样式都放在本目录的 CSS 文件中(`styles.css` / `chat/chatStyles.css` /
  `imageBatchExcel.css`),并由对应 jsx 自己 `import`。
- ✅ 任何新增工具函数 / 适配器 / 常量 / 类型放进本目录已有的 `utils.js` /
  `adapters.js` / `services.js` / `constants.js`,不要在 `web/src/helpers/` 等公共目
  录里新增 AI Creation 专用 helper。
- ✅ 任何新增用户文案使用 `t('中文key')`,并把 key 同步加进**全部 7 个 locale 文件**。
- ✅ 改完代码运行本目录 `__tests__/*` 6 个测试全过。
- ❌ 不要新增 `features/ai-creation/index.jsx` 或 `pages/AiCreation/index.jsx`。
- ❌ 不要再创建 `web/src/components/ai-creation/`(第二实现)。
- ❌ 不要恢复"创作中心"父级 Tab 容器、紫色重渐变、第二套导航壳。
- ❌ 不要修改 `new-api` 与 `QuantumNous` 相关的品牌、版权、署名信息(项目硬规则)。

---

## 五、图片 / 视频 API 实际接入说明（2026-05-12 已核实）

> 本节只记录当前项目代码里**已经存在并已核实**的行为，不写推测。

### 1. Playground 路由

- 图片生成：`POST /pg/images/generations`
- 图片编辑：`POST /pg/images/edits`
- 视频生成：`POST /pg/videos`
- 视频轮询：`GET /pg/videos/:task_id`
- 兼容旧视频路径：
  - `POST /pg/video/generations`
  - `GET /pg/video/generations/:task_id`

对应代码：

- `router/relay-router.go`
- `controller/playground.go`

### 2. 前端视频是怎么发请求的

当前前端 `generateVideo()` 位于：

- `web/src/features/ai-creation/services.js`

当模型命中 Grok 分支时，前端会调用：

- `buildVideoFormData()`
- 文件：`web/src/features/ai-creation/adapters.js`

实际提交的 multipart 字段为：

| 字段                |       是否发送 | 说明                                     |
| ------------------- | -------------: | ---------------------------------------- |
| `model`             |           必发 | 当前视频模型名                           |
| `prompt`            |           必发 | 视频提示词                               |
| `seconds`           |     有值时发送 | 时长，前端把 `6s` 这类值转成纯数字字符串 |
| `size`              |           必发 | 分辨率尺寸字符串                         |
| `resolution_name`   |           必发 | 当前前端只会发 `480p` 或 `720p`          |
| `preset`            |           必发 | 默认 `normal`                            |
| `input_reference[]` | 有参考图时发送 | 最多 7 张                                |

#### 当前前端 16:9 对应尺寸

文件：`web/src/features/ai-creation/adapters.js`

- `16:9 + 480p` → `1280x720`
- `16:9 + 720p` → `1792x1024`
- `9:16 + 480p` → `720x1280`
- `9:16 + 720p` → `1024x1792`
- `1:1` → `1024x1024`

所以你前面要的 **16:9 视频**，在这个项目当前实现里，720p 走的是：

```txt
size=1792x1024
resolution_name=720p
```

### 3. 后端视频是怎么接的

视频任务入口：

- `controller/relay.go -> RelayTask()`
- `relay/relay_task.go -> RelayTaskSubmit()`
- `relay/channel/task/sora/adaptor.go`

请求校验位于：

- `relay/common/relay_utils.go`

已核实规则：

1. `prompt` 不能为空白  
   `validatePrompt()` 会对 `strings.TrimSpace(prompt)` 做校验，空白直接报错。

2. Grok 视频请求会被保存到 `task_request`  
   后续适配器、计费和入库都从这里取请求信息。

3. 视频提交成功后会返回任务 ID，再由前端轮询 `GET /pg/videos/:task_id`

### 4. 你之前那个 curl 请求，代码层面能确认的问题

你给出的 `curl` 里，`prompt` 这一段实际是空白：

```txt
Content-Disposition: form-data; name="prompt"


```

而当前项目后端明确要求：

- `prompt` 去掉空格后必须非空

所以**仅从你贴出来的请求体内容本身**，已经可以确认：

- 字段名基本对
- 但 `prompt` 不合法
- 该请求不符合当前项目的视频校验规则

### 5. 图片模型当前接法

前端图片入口：

- `web/src/features/ai-creation/services.js -> generateImages()`

当前前端分三条路径：

1. **纯生成**
   - 路由：`POST /pg/images/generations`
   - 构造：`buildImageGenerationPayload()`

2. **Grok 参考图编辑**
   - 路由：`POST /pg/images/edits`
   - 构造：`buildGrokImageEditFormData()`

3. **GPT Image 编辑**
   - 路由：`POST /pg/images/edits`
   - 构造：`buildGptImageEditFormData()`

#### 当前图片请求里已核实支持的主要参数

| 字段              | 场景        | 说明                 |
| ----------------- | ----------- | -------------------- |
| `model`           | 生成 / 编辑 | 模型名               |
| `prompt`          | 生成 / 编辑 | 提示词               |
| `n`               | 生成 / 编辑 | 生成张数             |
| `size`            | 生成 / 编辑 | 尺寸，如 `1024x1024` |
| `quality`         | 图片        | 质量参数             |
| `response_format` | Grok 编辑   | 当前前端固定发 `url` |
| `image[]`         | Grok 编辑   | 参考图数组           |
| `image`           | GPT 编辑    | 参考图，字段可重复   |
| `group`           | GPT 编辑    | 当前表单支持透传     |

后端图片解析位于：

- `relay/helper/valid_request.go`

### 6. 这次已修复的真实问题

已确认并已修复的问题：

- **视频任务入库后 `tasks.properties.input` 会丢失 prompt**

现象证据（已查本地数据库）：

- `tasks.data` 里能看到真实视频 prompt
- 但 `tasks.properties.input` 为空字符串

修复方式：

- 在 `controller/relay.go` 成功创建任务对象后，
  从 `task_request` 中取回请求 prompt，
  写入 `task.Properties.Input`

新增验证：

- `controller/relay_task_properties_test.go`

已跑测试：

```bash
go test ./controller -run 'TestPopulateTaskRequestInput|TestOpenAIVideoInitialResult'
```

### 7. 如果你要手工构造一个符合当前项目的 16:9 Grok 视频请求

最少应满足：

```txt
POST /pg/videos
model=grok-imagine-video
prompt=非空提示词
seconds=6
size=1792x1024
resolution_name=720p
preset=normal
```

如果带参考图，再追加：

```txt
input_reference[]=<file or url>
```
