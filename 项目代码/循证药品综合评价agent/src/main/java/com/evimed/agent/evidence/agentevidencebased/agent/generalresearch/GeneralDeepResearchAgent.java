package com.evimed.agent.evidence.agentevidencebased.agent.generalresearch;

import com.evimed.agent.evidence.agentevidencebased.agent.BaseAgent;
import com.evimed.agent.evidence.agentevidencebased.agent.messaging.AgentSink;
import com.evimed.agent.evidence.agentevidencebased.entity.EvidenceOverAllState;
import com.evimed.agent.evidence.agentevidencebased.entity.record.*;
import com.evimed.agent.evidence.agentevidencebased.prompts.GeneralResearchPrompts;
import com.evimed.agent.evidence.agentevidencebased.service.AgentTaskManager;
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
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.converter.BeanOutputConverter;
import org.springframework.ai.model.tool.ToolCallingChatOptions;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.core.ParameterizedTypeReference;
import reactor.core.Disposable;
import reactor.core.Disposables;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;

/**
 * 通用深度研究 Agent（Plan-Execute-Critique 循环）
 * 直接移植自 LLMentor PlanExecuteAgent，使用通用 GeneralResearchPrompts。
 * 适用于任意类型问题（新闻事件、技术分析、通用问答等），不限于医学领域。
 *
 * 与 EvidenceDeepResearchAgent 的区别：
 * - 使用 GeneralResearchPrompts（通用提示词）
 * - 不进行报告类型检测
 * - 报告生成为单步 summarizeStream（无 TOC，无 OSS 上传）
 */
@Slf4j
public class GeneralDeepResearchAgent extends BaseAgent {

    private static final int DEFAULT_MAX_ROUNDS = 5;
    private static final int DEFAULT_CONTEXT_CHAR_LIMIT = 50_000;
    private static final int DEFAULT_MAX_TOOL_RETRIES = 2;
    private static final int EXECUTE_TIMEOUT_MINUTES = 15;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final int maxRounds;
    private final int contextCharLimit;
    private final int maxToolRetries;
    private final Semaphore toolSemaphore;
    private final List<ToolCallback> tools;
    private final ChatClient chatClient;

    // ===== Per-execution 状态（每次 execute() 调用重置）=====
    private volatile Disposable.Composite compositeDisposable;
    private volatile List<SearchResult> allReferences;
    private volatile CompletableFuture<Void> executionFuture;

    public GeneralDeepResearchAgent(ChatModel chatModel, List<ToolCallback> tools) {
        super("general-deep-research", chatModel, "general-research");
        this.tools = tools != null ? tools : List.of();
        this.maxRounds = DEFAULT_MAX_ROUNDS;
        this.contextCharLimit = DEFAULT_CONTEXT_CHAR_LIMIT;
        this.maxToolRetries = DEFAULT_MAX_TOOL_RETRIES;
        this.toolSemaphore = new Semaphore(3);
        this.chatClient = ChatClient.builder(chatModel).build();
    }

    // ===== 入口：阻塞执行 =====

    @Override
    public void execute(String sessionId, String question, AgentSink sink) {
        if (isTaskRunning(sessionId)) {
            sink.error("该会话正在执行中，请稍后再试");
            return;
        }

        initTimers();
        clearUsedTools();

        executionFuture = new CompletableFuture<>();
        compositeDisposable = Disposables.composite();
        allReferences = new ArrayList<>();
        AtomicBoolean stopped = new AtomicBoolean(false);
        StringBuilder finalAnswerBuffer = new StringBuilder();
        StringBuilder thinkingBuffer = new StringBuilder();

        AgentTaskManager.TaskInfo taskInfo = registerTask(sessionId, () -> {
            if (stopped.compareAndSet(false, true)) {
                compositeDisposable.dispose();
                sink.error("您已停止该任务");
                executionFuture.completeExceptionally(new RuntimeException("用户已停止"));
            }
        });
        if (taskInfo == null) {
            sink.error("该会话正在执行中，请稍后再试");
            return;
        }

        EvidenceOverAllState state = initStateAndSaveQuestion(sessionId, question);

        clarifyRequirementPhase(state, sink, stopped, thinkingBuffer,
                () -> generateResearchTopicPhase(state, sink, stopped, thinkingBuffer,
                        () -> executeLoopPhase(state, sink, stopped, finalAnswerBuffer, thinkingBuffer)));

        if (taskManager != null) {
            taskManager.setDisposable(sessionId, compositeDisposable);
        }

        try {
            executionFuture.get(EXECUTE_TIMEOUT_MINUTES, TimeUnit.MINUTES);
        } catch (Exception e) {
            if (!stopped.get()) {
                log.warn("执行超时或被中断: sessionId={}", sessionId, e);
                sink.error("执行超时，请重试");
            }
        } finally {
            if (finalAnswerBuffer.length() > 0) {
                saveAnswer(finalAnswerBuffer.toString(), thinkingBuffer.toString());
            }
            removeTask(sessionId);
            if (!compositeDisposable.isDisposed()) {
                compositeDisposable.dispose();
            }
        }
    }

    // ===== 初始化状态 =====

    private EvidenceOverAllState initStateAndSaveQuestion(String sessionId, String question) {
        // 通用 Agent 无需报告类型，传 null
        EvidenceOverAllState state = new EvidenceOverAllState(sessionId, question, null, null);

        try {
            ChatMemory memory = buildChatMemory(sessionId, 100);
            List<Message> history = memory.get(sessionId);
            if (history != null && !history.isEmpty()) {
                history.forEach(state::add);
            }
        } catch (Exception e) {
            log.warn("加载会话历史失败: sessionId={}, err={}", sessionId, e.getMessage());
        }

        state.add(new UserMessage(question));
        saveQuestion(sessionId, question);
        return state;
    }

    // ===== 阶段一：需求澄清 =====

    private void clarifyRequirementPhase(EvidenceOverAllState state, AgentSink sink,
                                          AtomicBoolean stopped, StringBuilder thinkingBuffer,
                                          Runnable onComplete) {
        emit(sink, stopped, "🔍 正在分析您的需求...\n", "thinking", thinkingBuffer);

        List<Message> messages = new ArrayList<>();
        messages.add(new SystemMessage(GeneralResearchPrompts.REQUIREMENT_CLARIFICATION));
        messages.addAll(state.getMessages());

        StringBuilder responseBuffer = new StringBuilder();

        Disposable disposable = chatClient.prompt()
                .messages(messages)
                .stream()
                .content()
                .doOnNext(chunk -> {
                    responseBuffer.append(chunk);
                    emit(sink, stopped, chunk, "thinking", thinkingBuffer);
                })
                .doOnComplete(() -> handleClarificationComplete(responseBuffer, sink, stopped, thinkingBuffer, onComplete))
                .doOnError(err -> handlePhaseError("需求澄清异常", err, sink, stopped))
                .subscribeOn(Schedulers.boundedElastic())
                .subscribe();

        compositeDisposable.add(disposable);
    }

    private void handleClarificationComplete(StringBuilder responseBuffer, AgentSink sink,
                                              AtomicBoolean stopped, StringBuilder thinkingBuffer,
                                              Runnable onComplete) {
        String response = responseBuffer.toString();
        emit(sink, stopped, "\n✅ 需求分析完成\n", "thinking", thinkingBuffer);

        if (response.contains("【需要补充信息】")) {
            String pauseMessage = "⏸【暂停深入研究】" + response.replace("【需要补充信息】", "").trim();
            sink.rawMessage(pauseMessage);
            if (stopped.compareAndSet(false, true)) {
                sink.complete();
                executionFuture.complete(null);
            }
        } else {
            emit(sink, stopped, "✅ 信息充足，准备生成研究维度\n", "thinking", thinkingBuffer);
            onComplete.run();
        }
    }

    // ===== 阶段二：研究维度生成 =====

    private void generateResearchTopicPhase(EvidenceOverAllState state, AgentSink sink,
                                             AtomicBoolean stopped, StringBuilder thinkingBuffer,
                                             Runnable onComplete) {
        emit(sink, stopped, "📝 正在生成研究维度...\n", "thinking", thinkingBuffer);

        List<Message> messages = new ArrayList<>();
        messages.add(new SystemMessage(GeneralResearchPrompts.RESEARCH_TOPIC_GENERATION));
        messages.addAll(state.getMessages());
        messages.add(new UserMessage("<original_question>" + state.getQuestion() + "</original_question>"));

        StringBuilder topicBuffer = new StringBuilder();

        Disposable disposable = chatClient.prompt()
                .messages(messages)
                .stream()
                .content()
                .doOnNext(chunk -> {
                    topicBuffer.append(chunk);
                    emit(sink, stopped, chunk, "thinking", thinkingBuffer);
                })
                .doOnComplete(() -> {
                    state.setRefinedResearchTopic(topicBuffer.toString());
                    emit(sink, stopped, "\n✅ 研究维度已生成\n\n", "thinking", thinkingBuffer);
                    onComplete.run();
                })
                .doOnError(err -> handlePhaseError("研究维度生成异常", err, sink, stopped))
                .subscribeOn(Schedulers.boundedElastic())
                .subscribe();

        compositeDisposable.add(disposable);
    }

    // ===== 阶段三：执行循环 =====

    private void executeLoopPhase(EvidenceOverAllState state, AgentSink sink,
                                   AtomicBoolean stopped, StringBuilder finalAnswerBuffer,
                                   StringBuilder thinkingBuffer) {
        Mono<Void> executionMono = executeLoop(state, sink, stopped, finalAnswerBuffer, thinkingBuffer);

        Disposable disposable = executionMono
                .subscribeOn(Schedulers.boundedElastic())
                .subscribe(
                        null,
                        e -> {
                            log.error("执行循环异常", e);
                            if (stopped.compareAndSet(false, true)) {
                                sink.error("执行失败: " + e.getMessage());
                                executionFuture.completeExceptionally(e);
                            }
                        }
                );

        compositeDisposable.add(disposable);
    }

    private Mono<Void> executeLoop(EvidenceOverAllState state, AgentSink sink,
                                    AtomicBoolean stopped, StringBuilder finalAnswerBuffer,
                                    StringBuilder thinkingBuffer) {
        return Mono.fromRunnable(() -> {
            try {
                while (state.getRound() < maxRounds && !stopped.get() && !compositeDisposable.isDisposed()) {
                    state.nextRound();
                    log.info("===== Plan-Execute Round {} =====", state.getRound());

                    emit(sink, stopped, "\n🔄 第 " + state.getRound() + " 轮研究开始\n", "thinking", thinkingBuffer);

                    List<EvidencePlanTask> plan = generatePlan(state, sink, stopped, thinkingBuffer);
                    if (stopped.get() || compositeDisposable.isDisposed()) return;

                    if (plan.isEmpty() || plan.stream().allMatch(t -> t.id() == null)) {
                        break;
                    }

                    displayPlanInUI(plan, state, sink, state.getRound() == 1);

                    emit(sink, stopped, "\n--- 开始执行任务 ---\n\n", "thinking", thinkingBuffer);

                    Map<String, EvidenceTaskResult> results = executePlan(plan, state, sink, stopped, thinkingBuffer);
                    if (stopped.get() || compositeDisposable.isDisposed()) return;

                    emit(sink, stopped, "\n--- 任务执行完成 ---\n\n", "thinking", thinkingBuffer);

                    EvidenceCritiqueResult critique = critique(state, plan, results, sink, stopped, thinkingBuffer);
                    if (stopped.get() || compositeDisposable.isDisposed()) return;

                    state.addRound(new EvidencePlanRoundState(state.getRound(), plan, results, critique));

                    if (critique.passed()) break;

                    state.add(new AssistantMessage("""
                            【Critique Feedback】
                            %s
                            """.formatted(critique.feedback())));

                    emit(sink, stopped, "\n--- 准备进入下一轮迭代 ---\n", "thinking", thinkingBuffer);

                    compressIfNeeded(state, sink, stopped, thinkingBuffer);
                }

                emit(sink, stopped, "\n✅ 研究阶段完成，准备生成最终报告\n", "thinking", thinkingBuffer);

                generateFinalReport(state, sink, stopped, finalAnswerBuffer, thinkingBuffer);

            } catch (Exception e) {
                if (compositeDisposable.isDisposed() || Thread.currentThread().isInterrupted()
                        || (e.getMessage() != null && e.getMessage().contains("interrupted"))) {
                    log.info("GeneralDeepResearchAgent 被用户停止: {}", e.getMessage());
                    if (stopped.compareAndSet(false, true)) {
                        sink.complete();
                        executionFuture.complete(null);
                    }
                } else {
                    log.error("执行循环异常", e);
                    throw e;
                }
            }
        });
    }

    // ===== 计划生成 =====

    private List<EvidencePlanTask> generatePlan(EvidenceOverAllState state, AgentSink sink,
                                                  AtomicBoolean stopped, StringBuilder thinkingBuffer) {
        String toolDesc = renderToolDescriptions();

        BeanOutputConverter<List<EvidencePlanTask>> converter =
                new BeanOutputConverter<>(new ParameterizedTypeReference<>() {});

        String systemContent = """
                当前是迭代的第 %d 轮次。

                ## 可用工具说明（仅用于规划参考）
                %s

                ## 输出格式（严格 JSON，不含其他文字）
                %s

                """.formatted(state.getRound(), toolDesc, converter.getFormat())
                + GeneralResearchPrompts.PLAN;

        Prompt prompt = new Prompt(List.of(
                new SystemMessage(systemContent),
                new UserMessage(buildPlanUserMessage(state))
        ));

        emit(sink, stopped, "📋 正在生成执行计划...\n", "thinking", thinkingBuffer);
        if (stopped.get() || compositeDisposable.isDisposed()) return new ArrayList<>();

        String json = chatClient.prompt()
                .messages(prompt.getInstructions())
                .call()
                .content();

        List<EvidencePlanTask> planTasks = converter.convert(json);
        if (planTasks == null) planTasks = new ArrayList<>();

        emit(sink, stopped, "✅ 执行计划已生成，共 " + planTasks.size() + " 个任务\n", "thinking", thinkingBuffer);

        if (!planTasks.isEmpty()) {
            StringBuilder planText = new StringBuilder("\n📋 执行计划：\n");
            for (EvidencePlanTask task : planTasks) {
                planText.append(String.format("  🟠 %s\n", task.instruction()));
            }
            emit(sink, stopped, planText.toString(), "thinking", thinkingBuffer);
        }

        return planTasks;
    }

    private String buildPlanUserMessage(EvidenceOverAllState state) {
        StringBuilder userMessage = new StringBuilder();
        userMessage.append("【用户问题】\n").append(state.getQuestion());

        boolean hasPreviousCritique = false;
        if (!state.getRounds().isEmpty()) {
            EvidencePlanRoundState lastRound = state.getRounds().get(state.getRounds().size() - 1);
            if (lastRound != null && lastRound.critique() != null && !lastRound.critique().passed()) {
                hasPreviousCritique = true;
                userMessage.append("\n\n【上一轮评估反馈】\n").append(lastRound.critique().feedback());
            }
        }

        if (!hasPreviousCritique && state.getRefinedResearchTopic() != null
                && !state.getRefinedResearchTopic().isEmpty()) {
            userMessage.append("\n\n【研究维度】\n").append(state.getRefinedResearchTopic());
        }

        return userMessage.toString();
    }

    // ===== 计划 UI 展示 =====

    private void displayPlanInUI(List<EvidencePlanTask> plan, EvidenceOverAllState state,
                                   AgentSink sink, boolean isFirstRound) {
        state.setCurrentPlan(plan);
        List<String> titles = state.getCurrentTitles();
        List<String> details = state.getCurrentDetails();
        String analysis = "已规划第 " + state.getRound() + " 轮研究任务（共 " + plan.size() + " 个）";

        if (isFirstRound) {
            sink.previewPlan(analysis, titles, details);
            sink.orchestraPlan(analysis, titles, details);
        } else {
            sink.rawMessage("\n📋 第 " + state.getRound() + " 轮执行计划：\n");
            for (EvidencePlanTask task : plan) {
                sink.rawMessage("  🟠 " + task.instruction() + "\n");
            }
        }

        sink.status(titles, state.getCurrentStatuses());
    }

    // ===== 计划执行 =====

    private Map<String, EvidenceTaskResult> executePlan(List<EvidencePlanTask> plan,
                                                          EvidenceOverAllState state, AgentSink sink,
                                                          AtomicBoolean stopped, StringBuilder thinkingBuffer) {
        Map<String, EvidenceTaskResult> results = new ConcurrentHashMap<>();

        Map<Integer, List<EvidencePlanTask>> grouped = plan.stream()
                .collect(Collectors.groupingBy(EvidencePlanTask::order));

        Map<String, String> accumulatedResults = new ConcurrentHashMap<>();

        for (Integer order : new TreeSet<>(grouped.keySet())) {
            if (stopped.get() || compositeDisposable.isDisposed()) break;

            String dependencyContext = buildDependencyContext(accumulatedResults, plan, order);
            List<EvidencePlanTask> tasks = grouped.get(order);

            CountDownLatch latch = new CountDownLatch(tasks.size());

            for (EvidencePlanTask task : tasks) {
                Disposable taskDisposable = Mono.fromRunnable(() -> {
                    try {
                        if (compositeDisposable.isDisposed()) { latch.countDown(); return; }
                        toolSemaphore.acquire();

                        if (task.id() == null || task.id().isEmpty()) {
                            latch.countDown(); toolSemaphore.release(); return;
                        }
                        if (compositeDisposable.isDisposed()) {
                            toolSemaphore.release(); latch.countDown(); return;
                        }

                        state.updateTaskStatus(task.id(), "doing");
                        sink.status(state.getCurrentTitles(), state.getCurrentStatuses());

                        EvidenceTaskResult result = executeWithRetry(task, dependencyContext, sink, stopped, thinkingBuffer);
                        results.put(task.id(), result);

                        if (result.success() && result.output() != null) {
                            accumulatedResults.put(task.id(), result.output());
                        }

                        state.add(new AssistantMessage("""
                                【Completed Task Result】
                                taskId: %s
                                success: %s
                                result:
                                %s
                                error:
                                %s
                                【End Task Result】
                                """.formatted(task.id(), result.success(), result.output(), result.error())));

                        state.updateTaskStatus(task.id(), "done");
                        sink.status(state.getCurrentTitles(), state.getCurrentStatuses());

                    } catch (InterruptedException e) {
                        log.info("任务 {} 执行被中断", task.id());
                        Thread.currentThread().interrupt();
                        results.put(task.id(), new EvidenceTaskResult(task.id(), false, null, "执行被中断"));
                        state.updateTaskStatus(task.id(), "done");
                    } catch (Exception e) {
                        if (compositeDisposable.isDisposed() || Thread.currentThread().isInterrupted()
                                || (e.getMessage() != null && e.getMessage().contains("interrupted"))) {
                            log.info("任务 {} 被用户停止", task.id());
                            results.put(task.id(), new EvidenceTaskResult(task.id(), false, null, "被用户停止"));
                        } else {
                            log.error("任务 {} 执行异常", task.id(), e);
                            results.put(task.id(), new EvidenceTaskResult(task.id(), false, null, e.getMessage()));
                        }
                        state.updateTaskStatus(task.id(), "done");
                    } finally {
                        toolSemaphore.release();
                        latch.countDown();
                    }
                }).subscribeOn(Schedulers.boundedElastic()).subscribe();

                compositeDisposable.add(taskDisposable);
            }

            try {
                latch.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                log.warn("executePlan 被中断");
                break;
            }
        }

        return results;
    }

    // ===== 单任务执行（内联 ReAct 循环）=====

    private EvidenceTaskResult executeWithRetry(EvidencePlanTask task, String dependencyContext,
                                                  AgentSink sink, AtomicBoolean stopped,
                                                  StringBuilder thinkingBuffer) {
        if (stopped.get() || compositeDisposable.isDisposed()) {
            return new EvidenceTaskResult(task.id(), false, null, "任务被停止");
        }

        emit(sink, stopped, "⚙️ 正在执行任务 " + task.id() + ": " + task.instruction() + "\n", "thinking", thinkingBuffer);

        String fullContext = """
                【Available Results】
                %s

                【Current Task】
                %s
                """.formatted(dependencyContext, task.instruction());

        ToolCallingChatOptions toolOptions = ToolCallingChatOptions.builder()
                .toolCallbacks(tools)
                .internalToolExecutionEnabled(false)
                .build();

        List<Message> messages = new ArrayList<>();
        messages.add(new SystemMessage(GeneralResearchPrompts.EXECUTE));
        messages.add(new UserMessage(fullContext));

        int maxReactRounds = maxToolRetries + 1;
        for (int round = 0; round < maxReactRounds; round++) {
            if (stopped.get() || compositeDisposable.isDisposed()) {
                return new EvidenceTaskResult(task.id(), false, null, "任务被停止");
            }
            try {
                Prompt prompt = new Prompt(messages, toolOptions);
                ChatResponse response = chatModel.call(prompt);

                if (response == null || response.getResult() == null) break;

                AssistantMessage assistantMsg = response.getResult().getOutput();
                List<AssistantMessage.ToolCall> toolCalls = assistantMsg.getToolCalls();
                String text = assistantMsg.getText();

                if (toolCalls == null || toolCalls.isEmpty()) {
                    if (text != null && !text.isBlank()) {
                        emit(sink, stopped, "执行结果: " + summarizeOutput(text) + "\n\n", "thinking", thinkingBuffer);
                        return new EvidenceTaskResult(task.id(), true, text, null);
                    }
                    break;
                }

                messages.add(assistantMsg);
                executeToolCallsBlocking(task, toolCalls, messages, sink, stopped, thinkingBuffer);

            } catch (Exception e) {
                if (compositeDisposable.isDisposed() || Thread.currentThread().isInterrupted()
                        || (e.getMessage() != null && e.getMessage().contains("interrupted"))) {
                    return new EvidenceTaskResult(task.id(), false, null, "任务被停止");
                }
                log.warn("任务 {} 第 {} 轮执行异常: {}", task.id(), round, e.getMessage());
                if (round == maxReactRounds - 1) {
                    return new EvidenceTaskResult(task.id(), false, null, "执行异常: " + e.getMessage());
                }
            }
        }

        emit(sink, stopped, "❌ 任务 " + task.id() + " 执行失败\n\n", "thinking", thinkingBuffer);
        return new EvidenceTaskResult(task.id(), false, null, "执行失败");
    }

    private void executeToolCallsBlocking(EvidencePlanTask task,
                                           List<AssistantMessage.ToolCall> toolCalls,
                                           List<Message> messages, AgentSink sink,
                                           AtomicBoolean stopped, StringBuilder thinkingBuffer) {
        for (AssistantMessage.ToolCall tc : toolCalls) {
            if (stopped.get() || compositeDisposable.isDisposed()) break;

            String callId = tc.id();
            String toolName = tc.name();
            String argsJson = tc.arguments();

            sink.toolCallStart("正在调用工具: " + toolName, callId, argsJson);

            ToolCallback callback = findTool(toolName);
            if (callback == null) {
                messages.add(ToolResponseMessage.builder()
                        .responses(List.of(new ToolResponseMessage.ToolResponse(
                                callId, toolName, "{\"error\":\"工具未找到: " + toolName + "\"}")))
                        .build());
                sink.toolCallEnd("工具未找到: " + toolName, callId);
                continue;
            }

            try {
                Object result = callback.call(argsJson);
                String resultStr = result.toString();

                messages.add(ToolResponseMessage.builder()
                        .responses(List.of(new ToolResponseMessage.ToolResponse(callId, toolName, resultStr)))
                        .build());

                recordUsedTool(toolName);

                int found = parseAndCollectReferences(resultStr);
                if (toolName.contains("tavily") || toolName.contains("search")) {
                    sink.toolCallEnd("检索完成，找到 " + found + " 条结果", callId);
                } else {
                    sink.toolCallEnd("工具执行完成", callId);
                }

            } catch (Exception e) {
                log.warn("工具 {} 执行失败: {}", toolName, e.getMessage());
                messages.add(ToolResponseMessage.builder()
                        .responses(List.of(new ToolResponseMessage.ToolResponse(
                                callId, toolName, "{\"error\":\"" + e.getMessage() + "\"}")))
                        .build());
                sink.toolCallEnd("工具执行失败: " + e.getMessage(), callId);
            }
        }
    }

    // ===== 依赖上下文构建 =====

    private String buildDependencyContext(Map<String, String> results, List<EvidencePlanTask> plan, int currentOrder) {
        if (currentOrder == 1) return "无\n";
        StringBuilder context = new StringBuilder();
        boolean hasDependencies = false;
        for (Map.Entry<String, String> entry : results.entrySet()) {
            EvidencePlanTask task = plan.stream()
                    .filter(t -> t.id() != null && t.id().equals(entry.getKey()))
                    .findFirst().orElse(null);
            if (task != null && task.order() == currentOrder - 1) {
                context.append(String.format("任务 %s: %s\n\n", entry.getKey(), entry.getValue()));
                hasDependencies = true;
            }
        }
        return hasDependencies ? context.toString() : "无\n";
    }

    // ===== 研究评审 =====

    private EvidenceCritiqueResult critique(EvidenceOverAllState state, List<EvidencePlanTask> currentPlan,
                                              Map<String, EvidenceTaskResult> currentResults,
                                              AgentSink sink, AtomicBoolean stopped,
                                              StringBuilder thinkingBuffer) {
        BeanOutputConverter<EvidenceCritiqueResult> converter =
                new BeanOutputConverter<>(new ParameterizedTypeReference<>() {});

        emit(sink, stopped, "\n🔍 正在评估当前研究结果...\n", "thinking", thinkingBuffer);

        if (stopped.get() || compositeDisposable.isDisposed()) {
            return new EvidenceCritiqueResult(true, "任务已取消");
        }

        StringBuilder userMessage = new StringBuilder();
        userMessage.append("【用户原始问题】\n").append(state.getQuestion());
        userMessage.append("\n\n【研究维度】\n")
                .append(state.getRefinedResearchTopic() != null ? state.getRefinedResearchTopic() : "未生成");

        userMessage.append("\n\n【当前轮次的执行计划】\n");
        if (currentPlan != null && !currentPlan.isEmpty()) {
            for (EvidencePlanTask task : currentPlan) {
                userMessage.append(String.format("- %s\n", task.instruction()));
            }
        }

        userMessage.append("\n\n【当前轮次的工具结果】\n");
        if (currentResults != null && !currentResults.isEmpty()) {
            for (Map.Entry<String, EvidenceTaskResult> entry : currentResults.entrySet()) {
                EvidenceTaskResult result = entry.getValue();
                if (result != null && result.success() && result.output() != null) {
                    userMessage.append(String.format("任务 %s: %s\n\n", entry.getKey(), result.output()));
                } else if (result != null && !result.success()) {
                    userMessage.append(String.format("任务 %s: 执行失败 - %s\n\n", entry.getKey(), result.error()));
                }
            }
        }

        String systemContent = GeneralResearchPrompts.CRITIQUE + "\n" + converter.getFormat();
        Prompt prompt = new Prompt(List.of(
                new SystemMessage(systemContent),
                new UserMessage(userMessage.toString())
        ));

        String raw = chatClient.prompt(prompt).call().content();
        EvidenceCritiqueResult result = converter.convert(raw);
        if (result == null) result = new EvidenceCritiqueResult(true, "评审解析失败，默认通过");

        if (result.passed()) {
            emit(sink, stopped, "✅ 研究结果评估通过，准备生成最终报告\n", "thinking", thinkingBuffer);
        } else {
            emit(sink, stopped, "⚠️ 评估未通过，原因：" + result.feedback() + "\n", "thinking", thinkingBuffer);
        }

        return result;
    }

    // ===== 上下文压缩 =====

    private void compressIfNeeded(EvidenceOverAllState state, AgentSink sink,
                                   AtomicBoolean stopped, StringBuilder thinkingBuffer) {
        if (state.currentChars() < contextCharLimit) return;

        log.warn("上下文过大，开始压缩，当前大小: {}", state.currentChars());
        emit(sink, stopped, "📦 上下文过长，正在压缩...\n", "thinking", thinkingBuffer);

        if (stopped.get() || compositeDisposable.isDisposed()) return;

        Prompt prompt = new Prompt(List.of(
                new SystemMessage("""
                        ## 最大压缩限制（必须遵守）
                        你输出的最终内容总字符数不得超过：%d
                        这是硬性上限。

                        """.formatted(contextCharLimit) + GeneralResearchPrompts.COMPRESS),
                new UserMessage(renderMessages(state.getMessages()))
        ));

        String snapshot = chatModel.call(prompt).getResult().getOutput().getText();
        state.clearMessages();
        state.add(new SystemMessage("【Compressed Agent State】\n" + snapshot));
        log.warn("压缩完成，新大小: {}", state.currentChars());
        emit(sink, stopped, "✅ 上下文压缩完成\n", "thinking", thinkingBuffer);
    }

    // ===== 报告生成（单步，对应 LLMentor summarizeStream）=====

    private void generateFinalReport(EvidenceOverAllState state, AgentSink sink,
                                      AtomicBoolean stopped, StringBuilder finalAnswerBuffer,
                                      StringBuilder thinkingBuffer) {
        emit(sink, stopped, "\n📝 正在生成最终分析报告...\n\n", "thinking", thinkingBuffer);

        String toolResults = state.extractToolResults();

        Prompt prompt = new Prompt(List.of(
                new SystemMessage(GeneralResearchPrompts.SUMMARIZE),
                new UserMessage("""
                        【用户原始问题】
                        %s

                        【研究主题】
                        %s

                        【工具检索结果】
                        %s
                        """.formatted(
                        state.getQuestion(),
                        state.getRefinedResearchTopic() != null ? state.getRefinedResearchTopic() : "通用研究",
                        toolResults.isEmpty() ? "（未检索到相关结果）" : toolResults
                ))
        ));

        Disposable disposable = chatClient.prompt()
                .messages(prompt.getInstructions())
                .stream()
                .chatResponse()
                .publishOn(Schedulers.boundedElastic())
                .doOnNext(chunk -> {
                    if (stopped.get() || compositeDisposable.isDisposed()) return;
                    if (chunk == null || chunk.getResult() == null || chunk.getResult().getOutput() == null) return;
                    String text = chunk.getResult().getOutput().getText();
                    if (text != null && !text.isEmpty()) {
                        recordFirstResponse();
                        finalAnswerBuffer.append(text);
                        sink.streamAppend(text);
                    }
                })
                .doOnComplete(() -> {
                    sink.complete();
                    List<SearchResult> uniqueRefs = deduplicateReferences(allReferences);
                    if (!uniqueRefs.isEmpty()) {
                        sink.newMessage("");
                        sink.reference(formatReferences(uniqueRefs));
                    }
                    if (stopped.compareAndSet(false, true)) {
                        executionFuture.complete(null);
                    } else if (!executionFuture.isDone()) {
                        executionFuture.complete(null);
                    }
                })
                .doOnError(e -> {
                    log.error("生成报告失败", e);
                    if (stopped.compareAndSet(false, true)) {
                        sink.error("生成报告失败: " + e.getMessage());
                        executionFuture.completeExceptionally(e);
                    }
                })
                .subscribe();

        compositeDisposable.add(disposable);
    }

    // ===== 工具方法 =====

    private ToolCallback findTool(String name) {
        return tools.stream()
                .filter(t -> t.getToolDefinition().name().equals(name))
                .findFirst().orElse(null);
    }

    private int parseAndCollectReferences(String resultJson) {
        if (resultJson == null || resultJson.isBlank()) return 0;
        try {
            JsonNode root = MAPPER.readTree(resultJson);
            if (root.isArray() && !root.isEmpty()) {
                JsonNode textNode = root.get(0).get("text");
                if (textNode != null) {
                    JsonNode textJson = textNode.isTextual()
                            ? MAPPER.readTree(textNode.asText()) : textNode;
                    JsonNode results = textJson.get("results");
                    if (results != null && results.isArray()) {
                        int count = 0;
                        for (JsonNode item : results) {
                            String url = safeText(item, "url");
                            String title = safeText(item, "title");
                            String content = safeText(item, "content");
                            if (url != null && !url.isBlank()) {
                                synchronized (allReferences) { allReferences.add(new SearchResult(url, title, content)); }
                                count++;
                            }
                        }
                        return count;
                    }
                }
            }
            if (root.has("results") && root.get("results").isArray()) {
                int count = 0;
                for (JsonNode item : root.get("results")) {
                    String url = safeText(item, "url"); String title = safeText(item, "title"); String content = safeText(item, "content");
                    if (url != null && !url.isBlank()) {
                        synchronized (allReferences) { allReferences.add(new SearchResult(url, title, content)); }
                        count++;
                    }
                }
                return count;
            }
        } catch (Exception e) {
            log.debug("解析参考文献失败: {}", e.getMessage());
        }
        return 0;
    }

    private String safeText(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return (v == null || v.isNull()) ? null : v.asText();
    }

    private List<SearchResult> deduplicateReferences(List<SearchResult> refs) {
        if (refs == null) return new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        List<SearchResult> unique = new ArrayList<>();
        for (SearchResult r : refs) {
            if (r.url() != null && seen.add(r.url())) unique.add(r);
        }
        return unique;
    }

    private String formatReferences(List<SearchResult> references) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < references.size(); i++) {
            SearchResult r = references.get(i);
            if (r.title() != null && !r.title().isBlank()) {
                sb.append("[").append(i + 1).append("] **").append(r.title()).append("**\n");
            } else {
                sb.append("[").append(i + 1).append("] ");
            }
            if (r.url() != null && !r.url().isBlank()) {
                sb.append("   ").append(r.url()).append("\n");
            }
            sb.append("\n");
        }
        return sb.toString().trim();
    }

    private void handlePhaseError(String logMessage, Throwable err, AgentSink sink, AtomicBoolean stopped) {
        log.error(logMessage, err);
        if (stopped.compareAndSet(false, true)) {
            sink.error(logMessage + ": " + err.getMessage());
            executionFuture.completeExceptionally(err);
        }
    }

    private String renderToolDescriptions() {
        if (tools == null || tools.isEmpty()) return "（当前无可用工具）";
        StringBuilder sb = new StringBuilder();
        for (ToolCallback tool : tools) {
            sb.append("- ").append(tool.getToolDefinition().name())
                    .append(": ").append(tool.getToolDefinition().description()).append("\n");
        }
        return sb.toString();
    }

    private String renderMessages(List<Message> messages) {
        StringBuilder sb = new StringBuilder();
        for (Message m : messages) {
            sb.append("\n\n[").append(m.getMessageType()).append("]\n\n").append(m.getText());
        }
        return sb.toString();
    }

    private String summarizeOutput(String text) {
        if (text == null) return "";
        return text.length() > 200 ? text.substring(0, 200) + "..." : text;
    }

    private void emit(AgentSink sink, AtomicBoolean stopped, String content, String type) {
        if (stopped.get() || compositeDisposable.isDisposed()) return;
        if ("thinking".equals(type)) {
            sink.rawMessage(content);
        } else {
            sink.streamAppend(content);
        }
    }

    private void emit(AgentSink sink, AtomicBoolean stopped, String content, String type,
                      StringBuilder thinkingBuffer) {
        if (stopped.get() || compositeDisposable.isDisposed()) return;
        if ("thinking".equals(type)) {
            if (thinkingBuffer != null) {
                thinkingBuffer.append(content);
                sink.rawMessage(thinkingBuffer.toString());
            } else {
                sink.rawMessage(content);
            }
        } else {
            sink.streamAppend(content);
        }
    }
}
