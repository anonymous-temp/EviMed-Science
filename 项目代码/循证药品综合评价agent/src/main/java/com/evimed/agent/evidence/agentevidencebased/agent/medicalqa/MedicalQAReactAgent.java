package com.evimed.agent.evidence.agentevidencebased.agent.medicalqa;

import com.evimed.agent.evidence.agentevidencebased.agent.BaseAgent;
import com.evimed.agent.evidence.agentevidencebased.agent.messaging.AgentSink;
import com.evimed.agent.evidence.agentevidencebased.entity.record.AgentState;
import com.evimed.agent.evidence.agentevidencebased.entity.record.RoundMode;
import com.evimed.agent.evidence.agentevidencebased.entity.record.RoundState;
import com.evimed.agent.evidence.agentevidencebased.entity.record.SearchResult;
import com.evimed.agent.evidence.agentevidencebased.prompts.MedicalAgentPrompts;
import com.evimed.agent.evidence.agentevidencebased.service.AgentTaskManager;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.ToolResponseMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.model.Generation;
import org.springframework.ai.model.tool.ToolCallingChatOptions;
import org.springframework.ai.tool.ToolCallback;
import reactor.core.Disposable;
import reactor.core.scheduler.Schedulers;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 医学问答 ReAct Agent
 *
 * 基于 WebSearchReactAgent 改造，适配 AgentSink + 阻塞执行模式：
 * - execute() 阻塞调用（使用 CompletableFuture 等待 Reactor 完成）
 * - 所有输出通过 AgentSink 而非 Sinks.Many
 * - 停止机制：disposable.dispose() + stopCallback → sink.error()
 */
@Slf4j
public class MedicalQAReactAgent extends BaseAgent {

    private static final int DEFAULT_MAX_ROUNDS = 8;
    private static final int EXECUTE_TIMEOUT_MINUTES = 5;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final ChatClient chatClient;
    private final List<ToolCallback> tools;
    private final int maxRounds;

    public MedicalQAReactAgent(ChatModel chatModel, List<ToolCallback> tools, int maxRounds) {
        super("medical-qa-react", chatModel, "medical-qa");
        this.tools = tools != null ? tools : List.of();
        this.maxRounds = maxRounds > 0 ? maxRounds : DEFAULT_MAX_ROUNDS;

        ToolCallingChatOptions toolOptions = ToolCallingChatOptions.builder()
                .toolCallbacks(this.tools)
                .internalToolExecutionEnabled(false)
                .build();

        this.chatClient = ChatClient.builder(chatModel)
                .defaultOptions(toolOptions)
                .defaultToolCallbacks(this.tools)
                .build();
    }

    @Override
    public void execute(String sessionId, String question, AgentSink sink) {
        // 防重入检查
        if (isTaskRunning(sessionId)) {
            sink.error("该会话正在执行中，请稍后再试");
            return;
        }

        // 初始化计时器
        initTimers();
        clearUsedTools();

        // 控制变量
        CompletableFuture<Void> future = new CompletableFuture<>();
        AtomicBoolean completed = new AtomicBoolean(false);
        // 注册任务（停止时：cancel LLM + 通知前端）
        AgentTaskManager.TaskInfo taskInfo = registerTask(sessionId, () -> {
            if (completed.compareAndSet(false, true)) {
                sink.error("您已停止该任务");
                future.completeExceptionally(new RuntimeException("用户已停止"));
            }
        });
        if (taskInfo == null) {
            sink.error("该会话正在执行中，请稍后再试");
            return;
        }

        // 构建消息列表
        List<Message> messages = Collections.synchronizedList(new ArrayList<>());
        messages.add(new SystemMessage(MedicalAgentPrompts.getMedicalQAPrompt()));

        // 加载历史记忆
        ChatMemory memory = buildChatMemory(sessionId, 10);
        loadChatHistory(sessionId, memory, messages);

        messages.add(new UserMessage("<question>" + question + "</question>"));
        currentQuestion = question;

        // 持久化问题
        saveQuestion(sessionId, question);

        // 跨轮次状态
        AgentState agentState = new AgentState();
        StringBuilder finalAnswerBuffer = new StringBuilder();
        AtomicLong roundCounter = new AtomicLong(0);

        // 启动第一轮
        scheduleRound(sessionId, messages, sink, roundCounter, completed, finalAnswerBuffer,
                agentState, taskInfo, future);

        // 阻塞当前线程（session executor 线程）直到完成或超时
        try {
            future.get(EXECUTE_TIMEOUT_MINUTES, TimeUnit.MINUTES);
        } catch (Exception e) {
            if (!completed.get()) {
                log.warn("执行超时或被中断: sessionId={}", sessionId, e);
                sink.error("执行超时，请重试");
            }
        } finally {
            // 持久化最终答案
            if (finalAnswerBuffer.length() > 0) {
                saveAnswer(finalAnswerBuffer.toString(), null);
            }
            removeTask(sessionId);
        }
    }

    // ===== 核心 ReAct 循环 =====

    private void scheduleRound(String sessionId, List<Message> messages, AgentSink sink,
                               AtomicLong roundCounter, AtomicBoolean completed,
                               StringBuilder finalAnswerBuffer, AgentState agentState,
                               AgentTaskManager.TaskInfo taskInfo, CompletableFuture<Void> future) {
        roundCounter.incrementAndGet();
        RoundState state = new RoundState();

        Disposable disposable = chatClient.prompt()
                .messages(messages)
                .stream()
                .chatResponse()
                .publishOn(Schedulers.boundedElastic())
                .doOnNext(chunk -> {
                    if (!completed.get()) {
                        processChunk(chunk, sink, state, finalAnswerBuffer);
                    }
                })
                .doOnComplete(() -> {
                    if (!completed.get()) {
                        finishRound(sessionId, messages, sink, state, roundCounter, completed,
                                finalAnswerBuffer, agentState, taskInfo, future);
                    }
                    sink.finish("", "");
                })
                .doOnError(err -> {
                    if (completed.compareAndSet(false, true)) {
                        log.error("LLM 流发生错误: sessionId={}", sessionId, err);
                        sink.error("LLM 调用失败: " + err.getMessage());
                        future.completeExceptionally(err);
                    }
                })
                .subscribe();

        // 将 disposable 绑定到任务管理器，以支持 stopTask
        if (taskManager != null) {
            taskManager.setDisposable(sessionId, disposable);
        }
    }

    private void processChunk(ChatResponse chunk, AgentSink sink, RoundState state,
                               StringBuilder finalAnswerBuffer) {
        if (chunk == null || chunk.getResult() == null || chunk.getResult().getOutput() == null) {
            return;
        }

        Generation gen = chunk.getResult();
        String text = gen.getOutput().getText();
        List<AssistantMessage.ToolCall> toolCalls = gen.getOutput().getToolCalls();

        // 一旦发现 tool_call 立即切换模式
        if (toolCalls != null && !toolCalls.isEmpty()) {
            state.mode = RoundMode.TOOL_CALL;
            for (AssistantMessage.ToolCall incoming : toolCalls) {
                mergeToolCall(state, incoming);
            }
            return;
        }

        // 文本流式输出
        if (text != null && !text.isEmpty()) {
            recordFirstResponse();
            state.textBuffer.append(text);
            sink.streamAppend(state.textBuffer.toString().trim());
            finalAnswerBuffer.append(text);
        }
    }

    private void mergeToolCall(RoundState state, AssistantMessage.ToolCall incoming) {
        for (int i = 0; i < state.toolCalls.size(); i++) {
            AssistantMessage.ToolCall existing = state.toolCalls.get(i);
            if (existing.id().equals(incoming.id())) {
                String merged = Objects.toString(existing.arguments(), "")
                        + Objects.toString(incoming.arguments(), "");
                state.toolCalls.set(i, new AssistantMessage.ToolCall(
                        existing.id(), "function", existing.name(), merged));
                return;
            }
        }
        state.toolCalls.add(incoming);
    }

    private void finishRound(String sessionId, List<Message> messages, AgentSink sink,
                             RoundState state, AtomicLong roundCounter, AtomicBoolean completed,
                             StringBuilder finalAnswerBuffer, AgentState agentState,
                             AgentTaskManager.TaskInfo taskInfo, CompletableFuture<Void> future) {

        // 没有工具调用 → 最终回答
        if (state.getMode() != RoundMode.TOOL_CALL) {
            sink.complete();
            if (!agentState.searchResults.isEmpty()) {
                sink.newMessage("");
                sink.reference(formatReferences(agentState.searchResults));
            }
            String recommendations = generateRecommendations(sessionId, currentQuestion, finalAnswerBuffer.toString());
            if (recommendations != null) {
                sink.newMessage("");
                sink.recommend(formatRecommendations(recommendations));
            }
            if (completed.compareAndSet(false, true)) {
                future.complete(null);
            }
            return;
        }

        // 有工具调用 → 构建 AssistantMessage，执行工具
        String preToolText = state.textBuffer.toString().trim();
        AssistantMessage assistantMsg = AssistantMessage.builder()
                .content(preToolText)
                .toolCalls(state.toolCalls)
                .build();
        messages.add(assistantMsg);

        // 达到最大轮次 → 强制生成最终答案
        if (roundCounter.get() >= maxRounds) {
            forceFinalAnswer(sessionId, messages, sink, completed, finalAnswerBuffer, agentState, taskInfo, future);
            return;
        }

        // 执行工具调用，完成后进入下一轮
        executeToolCalls(sessionId, sink, state.toolCalls, messages, completed, agentState, () -> {
            if (!completed.get()) {
                scheduleRound(sessionId, messages, sink, roundCounter, completed,
                        finalAnswerBuffer, agentState, taskInfo, future);
            }
        });
    }

    private void forceFinalAnswer(String sessionId, List<Message> messages, AgentSink sink,
                                  AtomicBoolean completed, StringBuilder finalAnswerBuffer,
                                  AgentState agentState, AgentTaskManager.TaskInfo taskInfo,
                                  CompletableFuture<Void> future) {
        List<Message> newMessages = new ArrayList<>();
        newMessages.add(new SystemMessage(MedicalAgentPrompts.getMedicalQAPrompt()));
        for (Message msg : messages) {
            if (!(msg instanceof SystemMessage)) newMessages.add(msg);
        }
        newMessages.add(new UserMessage("""
                你已达到最大推理轮次限制。
                请基于当前已收集的证据直接给出最终回答，禁止再调用任何工具。
                """));

        messages.clear();
        messages.addAll(newMessages);

        Disposable disposable = chatClient.prompt()
                .messages(messages)
                .stream()
                .chatResponse()
                .publishOn(Schedulers.boundedElastic())
                .doOnNext(chunk -> {
                    if (chunk == null || chunk.getResult() == null) return;
                    String text = chunk.getResult().getOutput().getText();
                    if (text != null && !text.isEmpty() && !completed.get()) {
                        recordFirstResponse();
                        sink.streamAppend(text);
                        finalAnswerBuffer.append(text);
                    }
                })
                .doOnComplete(() -> {
                    sink.complete();
                    if (!agentState.searchResults.isEmpty()) {
                        sink.newMessage("");
                        sink.reference(formatReferences(agentState.searchResults));
                    }
                    String recommendations = generateRecommendations(sessionId, currentQuestion, finalAnswerBuffer.toString());
                    if (recommendations != null) {
                        sink.recommend(formatRecommendations(recommendations));
                    }
                    if (completed.compareAndSet(false, true)) {
                        future.complete(null);
                    }
                })
                .doOnError(err -> {
                    if (completed.compareAndSet(false, true)) {
                        sink.error("生成最终回答失败: " + err.getMessage());
                        future.completeExceptionally(err);
                    }
                })
                .subscribe();

        if (taskManager != null) {
            taskManager.setDisposable(sessionId, disposable);
        }
    }

    // ===== 工具执行 =====

    private void executeToolCalls(String sessionId, AgentSink sink,
                                  List<AssistantMessage.ToolCall> toolCalls,
                                  List<Message> messages, AtomicBoolean completed,
                                  AgentState agentState, Runnable onComplete) {
        int total = toolCalls.size();
        AtomicInteger doneCount = new AtomicInteger(0);

        for (AssistantMessage.ToolCall tc : toolCalls) {
            Schedulers.boundedElastic().schedule(() -> {
                if (completed.get()) {
                    if (doneCount.incrementAndGet() >= total) onComplete.run();
                    return;
                }

                String toolName = tc.name();
                String argsJson = tc.arguments();
                String callId = tc.id();

                // 提示用户正在调用工具
                String thinkingMsg = buildToolThinkingMessage(toolName, argsJson);
                sink.toolCallStart(thinkingMsg, callId, argsJson);

                ToolCallback callback = findTool(toolName);
                if (callback == null) {
                    addErrorResponse(messages, tc, "工具未找到: " + toolName);
                    sink.toolCallEnd("工具未找到: " + toolName, callId);
                    if (doneCount.incrementAndGet() >= total) onComplete.run();
                    return;
                }

                try {
                    Object result = callback.call(argsJson);
                    String resultStr = result.toString();

                    messages.add(ToolResponseMessage.builder()
                            .responses(List.of(new ToolResponseMessage.ToolResponse(callId, toolName, resultStr)))
                            .build());

                    recordUsedTool(toolName);

                    // 解析 Tavily 搜索结果
                    if (toolName.contains("tavily") || toolName.contains("search")) {
                        int found = parseAndCollectSearchResults(resultStr, agentState);
                        sink.toolCallEnd("检索完成，找到 " + found + " 条结果", callId);
                    } else {
                        sink.toolCallEnd("工具执行完成", callId);
                    }
                } catch (Exception e) {
                    log.warn("工具执行失败: tool={}, error={}", toolName, e.getMessage());
                    addErrorResponse(messages, tc, "工具执行失败: " + e.getMessage());
                    sink.toolCallEnd("工具调用失败: " + e.getMessage(), callId);
                } finally {
                    if (doneCount.incrementAndGet() >= total) onComplete.run();
                }
            });
        }
    }

    private String buildToolThinkingMessage(String toolName, String argsJson) {
        try {
            if (argsJson != null) {
                JSONObject args = JSON.parseObject(argsJson);
                String query = args.getString("query");
                if (query != null) {
                    return MedicalAgentPrompts.getSearchThinkingMessage(query);
                }
            }
        } catch (Exception ignored) {}
        return "正在调用工具: " + toolName;
    }

    private int parseAndCollectSearchResults(String resultJson, AgentState state) {
        try {
            JsonNode root = MAPPER.readTree(resultJson);
            if (!root.isArray() || root.isEmpty()) return 0;

            JsonNode textNode = root.get(0).get("text");
            if (textNode == null || textNode.isNull()) return 0;

            JsonNode textJson = textNode.isTextual()
                    ? MAPPER.readTree(textNode.asText())
                    : textNode;

            JsonNode results = textJson.get("results");
            if (results == null || !results.isArray()) return 0;

            int count = 0;
            for (JsonNode item : results) {
                String url = safeText(item, "url");
                String title = safeText(item, "title");
                String content = safeText(item, "content");
                if (url != null && !url.isBlank()) {
                    state.searchResults.add(new SearchResult(url, title, content));
                    count++;
                }
            }
            return count;
        } catch (Exception e) {
            log.warn("解析搜索结果失败: {}", e.getMessage());
            return 0;
        }
    }

    private String safeText(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v == null || v.isNull() ? null : v.asText();
    }

    private void addErrorResponse(List<Message> messages, AssistantMessage.ToolCall tc, String errMsg) {
        messages.add(ToolResponseMessage.builder()
                .responses(List.of(new ToolResponseMessage.ToolResponse(
                        tc.id(), tc.name(), "{\"error\":\"" + errMsg + "\"}")))
                .build());
    }

    private ToolCallback findTool(String name) {
        return tools.stream()
                .filter(t -> t.getToolDefinition().name().equals(name))
                .findFirst()
                .orElse(null);
    }

    private String formatReferences(List<SearchResult> results) {
        StringBuilder sb = new StringBuilder("**参考文献**\n\n");
        for (int i = 0; i < results.size(); i++) {
            SearchResult r = results.get(i);
            if (r.title() != null && !r.title().isBlank()) {
                sb.append(i + 1).append(". **").append(r.title()).append("**\n");
            } else {
                sb.append(i + 1).append(". ");
            }
            if (r.url() != null && !r.url().isBlank()) {
                sb.append("   ").append(r.url()).append("\n");
            }
            sb.append("\n");
        }
        return sb.toString().trim();
    }

    private String formatRecommendations(String recommendJson) {
        try {
            List<String> questions = com.alibaba.fastjson2.JSON.parseArray(recommendJson, String.class);
            if (questions == null || questions.isEmpty()) return null;
            StringBuilder sb = new StringBuilder("**推荐追问**\n\n");
            for (int i = 0; i < questions.size(); i++) {
                sb.append(i + 1).append(". ").append(questions.get(i)).append("\n");
            }
            return sb.toString().trim();
        } catch (Exception e) {
            log.warn("格式化推荐问题失败: {}", e.getMessage());
            return null;
        }
    }
}
