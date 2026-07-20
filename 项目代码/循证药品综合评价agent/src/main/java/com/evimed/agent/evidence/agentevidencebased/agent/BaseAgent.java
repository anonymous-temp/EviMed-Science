package com.evimed.agent.evidence.agentevidencebased.agent;

import com.evimed.agent.evidence.agentevidencebased.agent.messaging.AgentSink;
import com.evimed.agent.evidence.agentevidencebased.entity.AgentSession;
import com.evimed.agent.evidence.agentevidencebased.prompts.MedicalAgentPrompts;
import com.evimed.agent.evidence.agentevidencebased.service.AgentTaskManager;
import com.evimed.agent.evidence.agentevidencebased.service.AiSessionService;
import com.alibaba.fastjson2.JSON;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.converter.BeanOutputConverter;
import org.springframework.core.ParameterizedTypeReference;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Agent 抽象基类
 * 适配 WebSocket + AgentSink 输出模式（区别于 dodo-agent 的 SSE + Sinks.Many）
 *
 * 子类实现 execute(sessionId, question, sink) — 阻塞调用，由 per-session 单线程执行器驱动
 */
@Slf4j
public abstract class BaseAgent {

    protected final ChatModel chatModel;
    protected final String name;
    protected final String agentType;

    protected AiSessionService sessionService;
    protected AgentTaskManager taskManager;

    // 推荐问题开关
    protected boolean enableRecommendations = true;

    // 计时
    protected long startTime;
    protected long firstResponseTime;

    // 工具追踪
    protected Set<String> usedTools = new HashSet<>();

    // 当前请求上下文（在 execute 内赋值）
    protected Long currentSessionDbId;
    protected String currentQuestion;

    protected BaseAgent(String name, ChatModel chatModel, String agentType) {
        this.name = name;
        this.chatModel = chatModel;
        this.agentType = agentType;
    }

    /**
     * 子类必须实现的核心执行方法。
     * 在 per-session 单线程执行器中被调用，应阻塞直到完成（或被中断）。
     *
     * @param sessionId 会话ID（WebSocket senderId，同时作为 chatMemory key）
     * @param question  用户问题
     * @param sink      输出接口（通过它发送流式文字、工具调用消息等）
     */
    public abstract void execute(String sessionId, String question, AgentSink sink);

    // ===== 历史记忆 =====

    /**
     * 从数据库加载历史记录，构建 in-memory ChatMemory
     */
    protected ChatMemory buildChatMemory(String sessionId, int maxMessages) {
        ChatMemory memory = MessageWindowChatMemory.builder().maxMessages(maxMessages).build();

        if (sessionService == null) {
            return memory;
        }

        List<AgentSession> history = sessionService.findRecentBySessionId(sessionId, maxMessages);
        if (history == null || history.isEmpty()) {
            return memory;
        }

        // 历史按时间倒序返回，先反转为正序再写入 memory
        for (int i = history.size() - 1; i >= 0; i--) {
            AgentSession record = history.get(i);
            if (record.getQuestion() != null) {
                memory.add(sessionId, new UserMessage(record.getQuestion()));
            }
            if (record.getAnswer() != null) {
                memory.add(sessionId, new AssistantMessage(record.getAnswer()));
            }
        }

        log.debug("加载会话历史: sessionId={}, records={}", sessionId, history.size());
        return memory;
    }

    /**
     * 将 ChatMemory 中的历史消息追加到 messages 列表（跳过 SystemMessage）
     */
    protected void loadChatHistory(String sessionId, ChatMemory memory, List<Message> messages) {
        if (memory == null) return;
        List<Message> history = memory.get(sessionId);
        if (history == null || history.isEmpty()) return;

        for (Message msg : history) {
            messages.add(new UserMessage("对话历史："));
            if (msg instanceof SystemMessage) continue;
            messages.add(msg);
        }
    }

    // ===== 任务管理 =====

    /**
     * 检查当前 session 是否已有任务在运行（防重入）
     */
    protected boolean isTaskRunning(String sessionId) {
        return taskManager != null && taskManager.hasRunningTask(sessionId);
    }

    /**
     * 向 AgentTaskManager 注册任务
     *
     * @param sessionId    会话ID
     * @param stopCallback 停止时回调（通知前端并释放 future）
     * @return 注册的 TaskInfo，失败返回 null
     */
    protected AgentTaskManager.TaskInfo registerTask(String sessionId, Runnable stopCallback) {
        if (taskManager == null) return null;
        AgentTaskManager.TaskInfo taskInfo = taskManager.registerTask(sessionId, stopCallback, agentType);
        if (taskInfo == null) {
            log.warn("任务注册失败，该会话已有任务在执行: sessionId={}", sessionId);
        }
        return taskInfo;
    }

    /**
     * 正常完成后移除任务
     */
    protected void removeTask(String sessionId) {
        if (taskManager != null) {
            taskManager.removeTask(sessionId);
        }
    }

    // ===== 计时工具 =====

    protected void initTimers() {
        startTime = System.currentTimeMillis();
        firstResponseTime = 0;
    }

    protected void recordFirstResponse() {
        if (firstResponseTime == 0 && startTime > 0) {
            firstResponseTime = System.currentTimeMillis() - startTime;
        }
    }

    protected long getTotalResponseTime() {
        return startTime > 0 ? System.currentTimeMillis() - startTime : 0;
    }

    // ===== 工具追踪 =====

    protected void clearUsedTools() {
        usedTools.clear();
    }

    protected void recordUsedTool(String toolName) {
        if (toolName != null) usedTools.add(toolName);
    }

    protected String getUsedToolsString() {
        return usedTools.isEmpty() ? "" : String.join(",", usedTools);
    }

    // ===== 持久化 =====

    /**
     * 保存用户问题到数据库（在 execute 开始时调用）
     */
    protected void saveQuestion(String sessionId, String question) {
        if (sessionService == null) return;
        AgentSession session = sessionService.saveQuestion(sessionId, question, agentType);
        if (session != null) {
            currentSessionDbId = session.getId();
        }
    }

    /**
     * 保存最终回答到数据库（在 execute 结束时调用）
     */
    protected void saveAnswer(String answer, String thinking) {
        if (sessionService == null || currentSessionDbId == null) return;
        sessionService.updateAnswer(
                currentSessionDbId, answer, thinking,
                getUsedToolsString(), firstResponseTime, getTotalResponseTime()
        );
    }

    // ===== 推荐问题（可选）=====

    /**
     * 生成推荐追问（同步调用，返回 JSON 数组字符串，失败返回 null）
     */
    protected String generateRecommendations(String conversationId, String currentQuestion, String currentAnswer) {
        if (!enableRecommendations) return null;

        try {
            List<Message> messages = new ArrayList<>();
            messages.add(new SystemMessage(MedicalAgentPrompts.getRecommendPrompt()));

            // 加载历史消息，提供上下文
            ChatMemory memory = buildChatMemory(conversationId, 6);
            loadChatHistory(conversationId, memory, messages);

            messages.add(new UserMessage(currentQuestion));
            if (currentAnswer != null) {
                messages.add(new AssistantMessage(currentAnswer));
            }

            BeanOutputConverter<List<String>> converter =
                    new BeanOutputConverter<>(new ParameterizedTypeReference<>() {});

            messages.add(new UserMessage("请根据上述对话生成3个推荐问题。输出格式为：\n" + converter.getFormat()));

            String response = ChatClient.builder(chatModel).build()
                    .prompt()
                    .messages(messages)
                    .call()
                    .content();

            if (response != null && !response.isEmpty()) {
                List<String> recommendations = converter.convert(response);
                if (recommendations != null && !recommendations.isEmpty()) {
                    String jsonStr = JSON.toJSONString(recommendations);
                    log.info("生成推荐问题成功: {}", jsonStr);
                    return jsonStr;
                }
            }

            log.warn("生成推荐问题失败，响应格式无效: {}", response);
            return null;
        } catch (Exception e) {
            log.error("生成推荐问题异常", e);
            return null;
        }
    }

    // ===== Setters（由 AgentConfig 注入）=====

    public void setSessionService(AiSessionService sessionService) {
        this.sessionService = sessionService;
    }

    public void setTaskManager(AgentTaskManager taskManager) {
        this.taskManager = taskManager;
    }

    public void setEnableRecommendations(boolean enableRecommendations) {
        this.enableRecommendations = enableRecommendations;
    }

    public String getAgentType() {
        return agentType;
    }
}
