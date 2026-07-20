package com.evimed.agent.evidence.agentevidencebased.infrastructure.handler;

import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import lombok.Setter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.function.BiConsumer;
import java.util.function.Supplier;

/**
 * Agent 消息发送器
 * 统一管理所有发送到前端的消息格式和发送逻辑
 * 与 evidence-based-agent 的 AgentMessageSender 保持格式一致
 *
 * 支持的消息类型（内层 type）：
 *   stream       - 流式文本输出
 *   new          - 新消息开始
 *   previewPlan  - 任务大纲预览
 *   orchestra    - 任务编排进度
 *   status       - 任务状态（todo/doing/done）
 *   raw          - 包含 tool_call / tool_call_output / error 等
 *   finish       - 报告生成完成（含下载链接）
 *   clarification - 澄清提问
 *   phase_preview - 阶段预告
 *   phase_summary - 阶段总结
 *   report_delivery - 报告卡片交付
 */
@Slf4j
@Component
public class AgentMessageSender<T> {

    /** 当前通道（泛型，支持 Netty Channel 或其他） */
    private T channel;

    /** 消息发送器（具体传输实现） */
    private BiConsumer<T, String> messageSender;

    /** 消息上下文提供者（用于获取路由信息：id, parentId, senderId 等） */
    @Setter
    private Supplier<JSONObject> messageContextSupplier;

    /** 完成回调 */
    @Setter
    private Runnable onFinishCallback;

    /** clientType，用作外层消息的 senderType 和 agentType */
    @Value("${upstream.wesocket.client-type:medical-qa-agent}")
    private String clientType;

    /** 默认构造（Spring Bean 使用，需手动 set channel & sender） */
    public AgentMessageSender() {
    }

    /**
     * 带参数的构造（手动创建实例使用）
     */
    public AgentMessageSender(T channel,
                               BiConsumer<T, String> messageSender,
                               String clientType) {
        this.channel = channel;
        this.messageSender = messageSender;
        this.clientType = clientType;
    }

    public AgentMessageSender<T> withContextSupplier(Supplier<JSONObject> supplier) {
        this.messageContextSupplier = supplier;
        return this;
    }

    public AgentMessageSender<T> withOnFinish(Runnable callback) {
        this.onFinishCallback = callback;
        return this;
    }

    public void setChannelAndSender(T channel, BiConsumer<T, String> sender) {
        this.channel = channel;
        this.messageSender = sender;
    }

    public boolean isReady() {
        return channel != null && messageSender != null;
    }

    // ============================================================
    // 文本消息
    // ============================================================

    /** 流式文本输出（stream type） */
    public void sendRawMessage(String content) {
        if (!isReady()) return;
        JSONObject innerData = new JSONObject();
        innerData.put("type", "text");
        innerData.put("delta", content);
        innerData.put("inprogress", true);
        innerData.put("callid", null);
        innerData.put("argument", null);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "stream");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    /** 新消息开始（new type） */
    public void sendNewMessage(String content) {
        if (!isReady()) return;
        JSONObject innerData = new JSONObject();
        innerData.put("type", "text");
        innerData.put("delta", content);
        innerData.put("inprogress", true);
        innerData.put("callid", null);
        innerData.put("argument", null);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "new");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    // ============================================================
    // 任务规划相关
    // ============================================================

    /** 任务大纲预览（previewPlan type） */
    public void sendPreviewPlanMessage(String analysis, List<String> todo, List<String> todoDetails) {
        if (!isReady()) return;
        JSONObject itemData = new JSONObject();
        itemData.put("analysis", analysis);
        itemData.put("todo", todo);
        itemData.put("todo_details", todoDetails);

        JSONObject innerData = new JSONObject();
        innerData.put("type", "plan");
        innerData.put("item", itemData);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "previewPlan");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    /** 任务编排进度（orchestra type） */
    public void sendOrchestraMessage(String analysis, List<String> todo, List<String> todoDetails) {
        if (!isReady()) return;
        JSONObject itemData = new JSONObject();
        itemData.put("analysis", analysis);
        itemData.put("todo", todo);
        itemData.put("todo_details", todoDetails);

        JSONObject innerData = new JSONObject();
        innerData.put("type", "plan");
        innerData.put("item", itemData);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "orchestra");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    /** 任务状态更新（status type，状态值：todo/doing/done） */
    public void sendStatusMessage(List<String> titles, List<String> statuses) {
        if (!isReady()) return;
        JSONArray itemList = new JSONArray();
        for (int i = 0; i < titles.size(); i++) {
            JSONObject itemInfo = new JSONObject();
            itemInfo.put("title", titles.get(i));
            itemInfo.put("status", i < statuses.size() ? statuses.get(i) : "todo");
            itemList.add(itemInfo);
        }

        JSONObject innerData = new JSONObject();
        innerData.put("type", "task_status");
        innerData.put("item", itemList);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "status");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    // ============================================================
    // 工具调用相关
    // ============================================================

    /** 工具调用开始（正在搜索...） */
    public void sendToolCallMessage(String delta, String frontDisplay, String callId, String argument) {
        if (!isReady()) return;
        JSONObject innerData = new JSONObject();
        innerData.put("type", "tool_call");
        innerData.put("delta", delta);
        innerData.put("front_display", frontDisplay != null ? frontDisplay : "");
        innerData.put("callid", callId);
        innerData.put("argument", argument != null ? argument : "");
        innerData.put("inprogress", true);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "raw");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    /** 工具调用结束（找到 N 篇文献） */
    public void sendToolCallOutputMessage(String delta, String callId) {
        if (!isReady()) return;
        JSONObject innerData = new JSONObject();
        innerData.put("type", "tool_call_output");
        innerData.put("delta", delta);
        innerData.put("callid", callId);
        innerData.put("argument", null);
        innerData.put("inprogress", false);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "raw");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    // ============================================================
    // 完成 / 报告
    // ============================================================

    /** 报告生成完成（finish type，含下载链接） */
    public void sendFinishMessage(String url, String name) {
        if (!isReady()) return;
        JSONObject innerData = new JSONObject();
        innerData.put("md", url != null ? url : "");
        innerData.put("pdf", "");
        innerData.put("name", name != null ? name : "Medical Evidence Report");

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "finish");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));

        if (onFinishCallback != null) {
            onFinishCallback.run();
        }
    }

    /** 报告卡片交付（report_delivery type） */
    public void sendReportDeliveryMessage(String title, String author, String date,
                                           String preview, String mdUrl, String fileName, String fileSize) {
        if (!isReady()) return;
        JSONObject innerData = new JSONObject();
        innerData.put("md", mdUrl != null ? mdUrl : "");
        innerData.put("pdf", "");
        innerData.put("name", fileName != null ? fileName : "Evimed Report");
        innerData.put("title", title != null ? title : "循证报告");
        innerData.put("author", author != null ? author : "Evimed AI");
        innerData.put("date", date != null ? date : java.time.LocalDate.now().toString());
        innerData.put("preview", preview != null ? preview : "");
        innerData.put("file_size", fileSize != null ? fileSize : "");

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "report_delivery");
        innerContent.put("clazz", "agent");
        innerContent.put("data", innerData);

        messageSender.accept(channel, buildCompleteMessage(innerContent));
        log.info("报告交付消息已发送: {}", title);
    }

    // ============================================================
    // 交互 / 提示
    // ============================================================

    /** 澄清提问（clarification type，带倒计时） */
    public void sendClarificationMessage(String intentSummary, List<String> questions, int timeoutSeconds) {
        if (!isReady()) return;
        JSONObject itemData = new JSONObject();
        itemData.put("intent_summary", intentSummary);
        itemData.put("questions", questions);
        itemData.put("timeout_seconds", timeoutSeconds);
        itemData.put("start_time", System.currentTimeMillis());

        JSONObject innerData = new JSONObject();
        innerData.put("type", "clarification");
        innerData.put("item", itemData);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "clarification");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    /** 阶段预告（phase_preview type） */
    public void sendPhasePreviewMessage(String phaseTitle, String description, List<String> steps) {
        if (!isReady()) return;
        JSONObject itemData = new JSONObject();
        itemData.put("phase_title", phaseTitle);
        itemData.put("description", description);
        itemData.put("steps", steps);

        JSONObject innerData = new JSONObject();
        innerData.put("type", "phase_preview");
        innerData.put("item", itemData);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "phase_preview");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    /** 阶段总结（phase_summary type） */
    public void sendPhaseSummaryMessage(String phaseTitle, String summary, List<String> keyFindings) {
        if (!isReady()) return;
        JSONObject itemData = new JSONObject();
        itemData.put("phase_title", phaseTitle);
        itemData.put("summary", summary);
        itemData.put("key_findings", keyFindings);

        JSONObject innerData = new JSONObject();
        innerData.put("type", "phase_summary");
        innerData.put("item", itemData);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "phase_summary");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    /** 参考链接（reference type） */
    public void sendReferenceMessage(String referenceJson) {
        if (!isReady()) return;
        JSONObject innerData = new JSONObject();
        innerData.put("type", "text");
        innerData.put("subtype", "reference");
        innerData.put("delta", referenceJson);
        innerData.put("inprogress", false);
        innerData.put("callid", null);
        innerData.put("argument", null);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "stream");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    /** 推荐追问（recommend type） */
    public void sendRecommendMessage(String recommendJson) {
        if (!isReady()) return;
        JSONObject innerData = new JSONObject();
        innerData.put("type", "text");
        innerData.put("subtype", "recommend");
        innerData.put("delta", recommendJson);
        innerData.put("inprogress", false);
        innerData.put("callid", null);
        innerData.put("argument", null);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "stream");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    /** 错误消息 */
    public void sendErrorMessage(String errorMessage) {
        if (!isReady()) return;
        JSONObject innerData = new JSONObject();
        innerData.put("type", "error");
        innerData.put("delta", errorMessage);
        innerData.put("inprogress", false);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "raw");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    /** 进度消息 */
    public void sendProgressMessage(int current, int total, String description) {
        if (!isReady()) return;
        JSONObject innerData = new JSONObject();
        innerData.put("type", "progress");
        innerData.put("current", current);
        innerData.put("total", total);
        innerData.put("description", description);
        innerData.put("percentage", total > 0 ? (current * 100 / total) : 0);

        JSONObject innerContent = new JSONObject();
        innerContent.put("type", "raw");
        innerContent.put("data", innerData);
        innerContent.put("class", "agent");

        messageSender.accept(channel, buildCompleteMessage(innerContent));
    }

    // ============================================================
    // 构建外层完整消息（路由信息）
    // ============================================================

    /**
     * 构建完整的外层消息（包含路由信息）
     * 与 evidence-based-agent AgentMessageSender.buildCompleteMessage 格式完全一致：
     * - senderId/targetClientId 互换（回给原来的发送方）
     * - 保留 id/parentId/userId 用于消息追踪
     */
    private String buildCompleteMessage(JSONObject innerContent) {
        JSONObject outerMessage = new JSONObject();
        outerMessage.put("type", "text");
        outerMessage.put("content", innerContent.toJSONString());

        if (messageContextSupplier != null) {
            JSONObject context = messageContextSupplier.get();
            if (context != null) {
                String id = context.getString("id");
                String parentId = context.getString("parentId");
                String userId = context.getString("userId");
                String senderId = context.getString("senderId");
                String targetClientId = context.getString("targetClientId");

                // 互换 senderId/targetClientId，将消息回传给原发送方
                if (senderId != null) outerMessage.put("senderId", targetClientId);
                if (targetClientId != null) outerMessage.put("targetClientId", senderId);
                if (id != null) outerMessage.put("id", id);
                if (parentId != null) outerMessage.put("parentId", parentId);
                if (userId != null) outerMessage.put("userId", userId);
            }
        }

        outerMessage.put("senderType", clientType);
        outerMessage.put("agentType", clientType);

        return outerMessage.toJSONString();
    }
}
