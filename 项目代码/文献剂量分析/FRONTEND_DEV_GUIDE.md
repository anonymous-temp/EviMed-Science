# 证据工厂前端开发规范文档

> 本文档基于实际调试经验整理，用于约束 AI 辅助开发时的操作边界，防止破坏核心消息流转机制。

---

## 一、项目结构总览

```
lx-manus/src/
├── stores/modules/
│   ├── websocketMessage.js     ⚠️ 核心文件，消息路由总控，严禁随意修改
│   └── websocketSession.js     存储所有会话的消息数组
├── utils/
│   └── webSocketService.js     ⚠️ WebSocket 连接与队列调度，严禁随意修改
├── components/
│   ├── chatDetail/ChatDetail.vue              对话主容器
│   └── researchWorkflow/
│       ├── research-topic-selection.vue       科研选题渲染组件
│       ├── statistical-analysis.vue           统计分析渲染组件
│       ├── paper-review.vue                   论文预审渲染组件
│       ├── evidence-based.vue                 循证综合评价渲染组件
│       ├── drug-safety-analysis.vue           药物安全分析渲染组件
│       ├── quantitative-analysis.vue          定量分析渲染组件
│       └── project-application-form.vue       课题申请书渲染组件
```

---

## 二、WebSocket 消息协议

### 2.1 消息外层结构（Java 网关格式）

```json
{
  "type": "text",
  "userId": "用户ID",
  "parentId": "会话ID（session级别）",
  "id": "消息ID（同一次请求全程同一个UUID）",
  "agentType": "research-topic-selection",
  "senderId": "python-client-id",
  "targetClientId": "前端clientId",
  "content": "{ ...JSON字符串... }"
}
```

> **关键约定**：同一次用户请求，后端发出的所有消息（orchestra、status、stream、finish）共用同一个 `message.id`（UUID）。前端依赖此 `id` 关联任务计划与内容归属，**不得改变此约定**。

### 2.2 `content` 内层消息类型一览

| `content.type` | 用途 | 触发的前端行为 |
|---|---|---|
| `orchestra` | 发送任务计划列表 | 初始化 `sessionPlan`，展示待办步骤 |
| `status` | 更新每步任务状态 | 创建/更新任务容器（doing→创建，done→标完成） |
| `stream` | 流式文本/图片内容 | 替换或追加到任务容器的 `.data[]` |
| `raw` | 工具调用提示 | 展示"正在搜索/正在分析"加载态 |
| `text_finish` | 重置路由状态 | `prevDoingIndex=0`，后续消息回到顶层 |
| `finish` | 返回最终报告链接 | 渲染下载/预览按钮 |
| `report_writing_stream` | 报告生成流 | 顶层流式展示最终报告 |

---

## 三、websocketMessage.js 核心机制

### 3.1 任务计划存储（sessionPlan）

```
orchestra 消息到达
  └── message.content.data.item.todo（字符串数组）
        └── setSessionPlan(todo, message.id)
              └── sessionPlan[message.id] = [{id, status:'todo', todo:'问题全景分析'}, ...]
```

**约束**：
- `sessionPlan` 以 `message.id` 为 key，同一请求的 orchestra 和 status 必须携带相同的 `id`
- `updatePlanStatus` 首行检查 `if (!sessionPlan[id]) return`，若 orchestra 消息丢失则整个任务容器不会被创建，后续 stream 全部丢弃

### 3.2 任务容器创建规则（updatePlanStatus）

```
status 消息到达（todo.status === 'doing'）
  └── 检查 sessionPlan[id] 存在
  └── 检查 session.messages 中是否已有同名任务容器（alreadyPushed）
  └── push { type:'task', data:[], todo, show:true, id } 到 session.messages
```

```
status 消息到达（todo.status === 'done'）
  └── 找到对应 task 容器，设置 todo.status = 'done'
```

**约束**：
- 任务容器结构为 `{ type:'task', data:[], todo:{title,status}, show:true, id }`，**不得修改此结构**，渲染组件直接依赖这些字段
- `alreadyPushed` 用 `m.todo?.title === todo.title` 判重，title 必须保持唯一

### 3.3 Stream 消息路由（两层替换逻辑）

#### 顶层替换（session.messages 级别）
```
条件：当前消息是 stream/text，且 session.lastMessage 也是 stream/text
行为：session.messages[length-1] = 当前消息（直接替换，不追加）
      + return（提前返回，不再走任务容器路由）
```

#### 任务容器内替换（session.messages[last].data 级别）
```
条件：prevDoingIndex=1，tasks=[]（即处于某步骤 doing 状态中）
      当前消息是 stream/text，且 data[last] 也是 stream/text
行为：session.messages[last].data[length-1] = 当前消息（替换）

条件：同上，但当前消息不是 stream/text（或 data 为空）
行为：session.messages[last].data.push(当前消息)（追加）
```

**约束**：
- 流式文本采用**累积替换模式**：后端每次发送的 delta 是完整累积内容，前端替换上一条
- 图片（base64 inline）与文字**必须在同一条 stream 消息中发送**（`delta = 文字内容 + 图片markdown`），否则图片消息替换文字消息后文字丢失
- **严禁**将图片单独作为一条 stream 消息发送（除非前面先发送截断消息）

### 3.4 路由状态变量

| 变量 | 位置 | 含义 | 修改时机 |
|---|---|---|---|
| `sessionsInfo.prevDoingIndex` | websocketMessage.js | 1=当前处于某步骤执行中，0=空闲 | status 消息触发 |
| `sessionsInfo.task` | websocketMessage.js | 当前 status 消息的任务数组，处理完立即清空 | status 消息后清为 `[]` |
| `session.lastMessage` | session 对象 | 最后一条顶层消息，用于判断是否触发顶层替换 | 顶层 push 时更新 |

**约束**：
- `text_finish` 消息将 `prevDoingIndex` 重置为 0，此后消息进入顶层，不再进入任务容器
- 不得在其他地方手动修改 `prevDoingIndex`

### 3.5 消息队列处理（webSocketService.js）

```
WebSocket onmessage → receiveQueue.push(message)
requestAnimationFrame → processMessageQueueChunk()
  └── 每帧取 config.messageChunkSize 条消息批量处理
  └── 每条调用 handleSingleMessage()
```

**约束**：
- 消息严格按入队顺序处理，后端发送顺序决定前端处理顺序
- 若某条消息处理耗时过长（如渲染大图），后续消息将在下一帧批量追赶，产生"内容闪现"
- 后端发送大图（base64）后应留出足够延迟再发下一模块内容，避免前端队列积压

---

## 四、agentType 与 Python 服务对应关系

| agentType | Vue 渲染组件 | Python 服务 | 端口 | Vite 代理路径 |
|---|---|---|---|---|
| `research-topic-selection` | research-topic-selection.vue | research_topic_selection | **6008** | `/ws-research` |
| `statistical-analysis` | statistical-analysis.vue | data_analysis | **8001** | `/ws-analysis` |
| `paper-review` | paper-review.vue | paper_review | **6009** | `/ws-review` |
| `evidence-based-comprehensive-evaluation` | evidence-based.vue | — | — | — |
| `drug-safety-analysis` | drug-safety-analysis.vue | — | — | — |
| `quantitative-analysis` | quantitative-analysis.vue | — | — | — |
| `project-application-form` | project-application-form.vue | — | — | — |

> `statistical-analysis` 必须使用 **8001** 端口，避免与 research-topic-selection 的 6008 冲突。

---

## 五、渲染组件规范（researchWorkflow/*.vue）

### 5.1 任务容器渲染结构（通用模式）

```vue
<!-- 遍历 props.msg.messages -->
<div v-for="(message, index) in props.msg.messages">

  <!-- 任务容器（type=task） -->
  <div v-show="message.type == 'task' && message.show">
    <!-- 遍历任务容器内的消息 -->
    <div v-for="(taskMessage, taskIndex) in message.data">
      <!-- 只渲染 stream/text 类型 -->
      <div v-if="taskMessage.content?.type === 'stream'
                 && taskMessage.content.data.type === 'text'">
        <div v-html="transMarkDown(taskMessage.content.data.delta)"></div>
      </div>
    </div>
  </div>

  <!-- 顶层 stream 消息 -->
  <div v-if="message.content?.type === 'stream'
             && message.content.data?.type === 'text'">
    {{ message.content.data.delta }}
  </div>

</div>
```

**约束**：
- 任务容器内**只渲染** `content.type === 'stream' && content.data.type === 'text'` 的消息
- `content.data.delta` 是完整累积文本（含 Markdown 图片语法），直接传入 `transMarkDown()` 渲染
- `message.show` 控制任务容器展开/折叠，初始值为 `true`，**不得默认设为 false**

### 5.2 finish 消息处理

```js
// content.type === 'finish'
// content.data.md  → 报告链接（OSS URL 或 base64 data URI）
// content.data.pdf → PDF 链接（可为空）
// content.data.name → 报告名称
```

---

## 六、禁止操作清单

| 操作 | 原因 |
|---|---|
| 修改 `websocketMessage.js` 中 `updatePlanStatus` 的 `sessionPlan[id]` 判断逻辑 | 任务容器创建的核心守卫 |
| 修改任务容器结构 `{type,data,todo,show,id}` 中任意字段名 | 渲染组件与路由逻辑均依赖此结构 |
| 修改顶层 stream 替换逻辑（lines 581-597） | 影响所有 agentType 的普通流式展示 |
| 将图片单独作为一条 stream 消息发送（不携带前置文本） | 替换机制会导致文字内容丢失 |
| 修改 `prevDoingIndex` 的赋值逻辑 | 决定消息进入任务容器还是顶层 |
| 在 `text_finish` 之前向顶层 push 消息（非任务容器内） | 会破坏任务容器的消息归属 |
| 修改 `data_analysis` 服务端口为 8000 | 与 research-topic-selection 冲突 |
| 在后端图片发送后不加延迟立刻发送下一模块内容 | 前端渲染大图时队列积压，内容闪现 |

---

## 七、后端消息发送顺序规范

每个分析模块的标准发送顺序：

```
1. send_status(index, "doing")          ← 必须在内容之前，前端据此创建任务容器
2. send_tool_call(str_type, display)    ← 展示加载提示
3. [流式内容 on_token × N 次]           ← 累积发送，每次包含完整文本
   或 [打字机 stream × N 次]
4. [图片消息，若有]                      ← delta = 完整文本 + 图片markdown
5. send_status(index, "done")           ← 标记完成
```
