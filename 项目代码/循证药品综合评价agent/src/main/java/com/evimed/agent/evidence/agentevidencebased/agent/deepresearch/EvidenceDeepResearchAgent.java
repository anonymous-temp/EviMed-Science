package com.evimed.agent.evidence.agentevidencebased.agent.deepresearch;

import com.evimed.agent.evidence.agentevidencebased.agent.BaseAgent;
import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template.MedicalReportTemplate;
import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template.MedicalReportTemplateRegistry;
import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template.MedicalReportType;
import com.evimed.agent.evidence.agentevidencebased.agent.messaging.AgentSink;
import com.evimed.agent.evidence.agentevidencebased.entity.EvidenceOverAllState;
import com.evimed.agent.evidence.agentevidencebased.entity.record.*;
import com.evimed.agent.evidence.agentevidencebased.prompts.EvidenceMedicalPrompts;
import com.evimed.agent.evidence.agentevidencebased.infrastructure.OssReportUploader;
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
 * 循证深度研究 Agent（Plan-Execute-Critique 循环）
 *
 * 对应 LLMentor 的 PlanExecuteAgent，适配 WebSocket + AgentSink 输出模式：
 * - execute() 阻塞调用（CompletableFuture 桥接 Reactor 异步执行）
 * - 三阶段回调链：需求澄清 → 研究主题生成 → 执行循环
 * - Plan-Execute-Critique 最多 maxRounds 轮
 * - Scheme C 两步报告生成：适配章节大纲 → 流式报告
 */
@Slf4j
public class EvidenceDeepResearchAgent extends BaseAgent {

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
    private final ChatClient chatClient;  // 无工具，用于规划/评审/报告生成

    // ===== 可选依赖（由 AgentDispatcher 注入）=====
    private OssReportUploader ossReportUploader;

    // ===== Per-execution 状态（每次 execute() 调用重置）=====
    private volatile Disposable.Composite compositeDisposable;
    private volatile List<SearchResult> allReferences;
    private volatile CompletableFuture<Void> executionFuture;

    public EvidenceDeepResearchAgent(ChatModel chatModel, List<ToolCallback> tools) {
        super("evidence-deep-research", chatModel, "deep-research");
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
        // 防重入
        if (isTaskRunning(sessionId)) {
            sink.error("该会话正在执行中，请稍后再试");
            return;
        }

        initTimers();
        clearUsedTools();

        // Per-execution 初始化
        executionFuture = new CompletableFuture<>();
        compositeDisposable = Disposables.composite();
        allReferences = new ArrayList<>();
        AtomicBoolean stopped = new AtomicBoolean(false);
        StringBuilder finalAnswerBuffer = new StringBuilder();
        StringBuilder thinkingBuffer = new StringBuilder();

        // 注册任务（停止时：dispose + 通知前端 + complete future）
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

        // 初始化状态并保存问题
        EvidenceOverAllState state = initStateAndSaveQuestion(sessionId, question);

        // 启动三阶段回调链：需求澄清 → 研究主题生成 → 执行循环
        clarifyRequirementPhase(state, sink, stopped, thinkingBuffer,
                () -> generateResearchTopicPhase(state, sink, stopped, thinkingBuffer,
                        () -> executeLoopPhase(state, sink, stopped, finalAnswerBuffer, thinkingBuffer)));

        // 注册 compositeDisposable（支持 stopTask 取消）
        if (taskManager != null) {
            taskManager.setDisposable(sessionId, compositeDisposable);
        }

        // 阻塞当前线程直到完成或超时
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
        MedicalReportType reportType = detectReportType(question);
        MedicalReportTemplate template = MedicalReportTemplateRegistry.getTemplate(reportType);
        log.info("检测到报告类型: {}, sessionId={}", reportType, sessionId);

        EvidenceOverAllState state = new EvidenceOverAllState(sessionId, question, reportType, template);

        // 加载会话历史（跳过 SystemMessage）
        try {
            ChatMemory memory = buildChatMemory(sessionId, 100);
            List<Message> history = memory.get(sessionId);
            if (history != null && !history.isEmpty()) {
                history.stream()
//                        .filter(m -> !(m instanceof SystemMessage))
                        .forEach(state::add);
            }
        } catch (Exception e) {
            log.warn("加载会话历史失败: sessionId={}, err={}", sessionId, e.getMessage());
        }

        state.add(new UserMessage(question));
        saveQuestion(sessionId, question);

        return state;
    }

    // ===== 阶段一：需求澄清（对应 LLMentor clarifyRequirementPhase）=====

    private void clarifyRequirementPhase(EvidenceOverAllState state, AgentSink sink,
                                          AtomicBoolean stopped, StringBuilder thinkingBuffer,
                                          Runnable onComplete) {
        emit(sink, stopped, "🔍 正在分析您的需求...\n", "thinking", thinkingBuffer);
        thinkingBuffer.setLength(0);
        
        List<Message> messages = new ArrayList<>();
        messages.add(new SystemMessage(EvidenceMedicalPrompts.REQUIREMENT_CLARIFICATION));
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
//        emit(sink, stopped, "\n✅ 需求分析完成\n", "thinking", thinkingBuffer);

        boolean needsMoreInfo = response.contains("【需要补充信息】");

        if (needsMoreInfo) {
            // 暂停研究，等待用户补充信息
            String pauseMessage = "⏸【暂停深入研究】" + response.replace("【需要补充信息】", "").trim();
            sink.rawMessage(pauseMessage);
            if (stopped.compareAndSet(false, true)) {
                sink.complete();
                executionFuture.complete(null);
            }
        } else {
//            emit(sink, stopped, "✅ 信息充足，准备生成研究维度\n", "thinking", thinkingBuffer);
            onComplete.run();
        }
    }

    // ===== 阶段二：研究维度生成（对应 LLMentor generateResearchTopicPhase）=====

    private void generateResearchTopicPhase(EvidenceOverAllState state, AgentSink sink,
                                             AtomicBoolean stopped, StringBuilder thinkingBuffer,
                                             Runnable onComplete) {
        emit(sink, stopped, "📝 正在生成研究维度...\n", "thinking", thinkingBuffer);

        List<Message> messages = new ArrayList<>();
        messages.add(new SystemMessage(EvidenceMedicalPrompts.MEDICAL_RESEARCH_TOPIC_GENERATION));
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
                .doOnComplete(() -> handleResearchTopicComplete(topicBuffer, state, sink, stopped, thinkingBuffer, onComplete))
                .doOnError(err -> handlePhaseError("研究维度生成异常", err, sink, stopped))
                .subscribeOn(Schedulers.boundedElastic())
                .subscribe();

        compositeDisposable.add(disposable);
    }

    private void handleResearchTopicComplete(StringBuilder topicBuffer, EvidenceOverAllState state,
                                              AgentSink sink, AtomicBoolean stopped,
                                              StringBuilder thinkingBuffer, Runnable onComplete) {
        String topic = topicBuffer.toString();
        state.setRefinedResearchTopic(topic);
        emit(sink, stopped, "\n✅ 研究维度已生成\n\n", "thinking", thinkingBuffer);
        onComplete.run();
    }

    // ===== 阶段三：执行循环（对应 LLMentor executeLoopPhase）=====

    private void executeLoopPhase(EvidenceOverAllState state, AgentSink sink,
                                   AtomicBoolean stopped, StringBuilder finalAnswerBuffer,
                                   StringBuilder thinkingBuffer) {
        Mono<Void> executionMono = executeLoop(state, sink, stopped, finalAnswerBuffer, thinkingBuffer);

        Disposable executionDisposable = executionMono
                .subscribeOn(Schedulers.boundedElastic())
                .subscribe(
                        unused -> { /* 正常完成，do nothing */ },
                        e -> handleExecutionError(e, sink, stopped)
                );

        compositeDisposable.add(executionDisposable);
    }

    private void handleExecutionError(Throwable e, AgentSink sink, AtomicBoolean stopped) {
        if (compositeDisposable.isDisposed() || Thread.currentThread().isInterrupted()
                || (e.getMessage() != null && e.getMessage().contains("interrupted"))) {
            log.info("EvidenceDeepResearchAgent 执行被用户停止: {}", e.getMessage());
        } else {
            log.error("EvidenceDeepResearchAgent 执行异常", e);
            if (stopped.compareAndSet(false, true)) {
                sink.error("执行异常: " + e.getMessage());
                executionFuture.completeExceptionally(e);
            }
        }
    }

    // ===== 核心执行循环（对应 LLMentor executeLoop）=====

    private Mono<Void> executeLoop(EvidenceOverAllState state, AgentSink sink,
                                    AtomicBoolean stopped, StringBuilder finalAnswerBuffer,
                                    StringBuilder thinkingBuffer) {
        return Mono.fromRunnable(() -> {
            try {
                while (state.getRound() < maxRounds && !stopped.get() && !compositeDisposable.isDisposed()) {
                    state.nextRound();
                    log.info("===== Plan-Execute Round {} =====", state.getRound());
                    emit(sink, stopped, "\n🔄 第 " + state.getRound() + " 轮研究开始\n", "thinking", thinkingBuffer);

                    // 生成执行计划
                    List<EvidencePlanTask> plan = generatePlan(state, sink, stopped, thinkingBuffer);
                    if (stopped.get() || compositeDisposable.isDisposed()) return;

                    // 空计划或所有 id 为 null → 证据已充分，跳过执行进入报告
                    if (plan.isEmpty() || plan.stream().allMatch(t -> t.id() == null)) {
                        emit(sink, stopped, "✅ 当前证据已充分，跳过工具检索\n", "thinking", thinkingBuffer);
                        break;
                    }

                    // 在 UI 展示任务计划
                    displayPlanInUI(plan, state, sink, state.getRound() == 1);

                    emit(sink, stopped, "\n--- 开始执行任务 ---\n\n", "thinking", thinkingBuffer);
                    Map<String, EvidenceTaskResult> results = executePlan(plan, state, sink, stopped, thinkingBuffer);
                    if (stopped.get() || compositeDisposable.isDisposed()) return;

                    emit(sink, stopped, "\n--- 任务执行完成 ---\n\n", "thinking", thinkingBuffer);
                    EvidenceCritiqueResult critique = critique(state, plan, results, sink, stopped, thinkingBuffer);
                    if (stopped.get() || compositeDisposable.isDisposed()) return;

                    state.addRound(new EvidencePlanRoundState(state.getRound(), plan, results, critique));

                    if (critique.passed()) {
                        break;
                    }

                    // Critique 未通过：将反馈加入 state，继续下一轮
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
                    log.info("EvidenceDeepResearchAgent 执行被用户停止: {}", e.getMessage());
                    sink.rawMessage("⏹ 用户已停止生成\n");
                    if (stopped.compareAndSet(false, true)) {
                        executionFuture.complete(null);
                    }
                } else {
                    log.error("EvidenceDeepResearchAgent 执行异常", e);
                    throw e;
                }
            }
        });
    }

    // ===== 计划生成（对应 LLMentor generatePlan）=====

    private List<EvidencePlanTask> generatePlan(EvidenceOverAllState state, AgentSink sink,
                                                  AtomicBoolean stopped, StringBuilder thinkingBuffer) {
        String toolDesc = renderToolDescriptions();
        String templateContext = state.getReportTemplate() != null ?
                state.getReportTemplate().toPromptString() : "";

        BeanOutputConverter<List<EvidencePlanTask>> converter =
                new BeanOutputConverter<>(new ParameterizedTypeReference<>() {});

        String systemContent = """
                当前是迭代的第 %d 轮次。

                ## 可用工具说明（仅用于规划参考）
                %s

                ## 报告类型模板章节建议（供参考，非强制）
                %s

                ## 输出格式（严格 JSON，不含其他文字）
                %s

                """.formatted(state.getRound(), toolDesc, templateContext, converter.getFormat())
                + EvidenceMedicalPrompts.MEDICAL_PLAN;

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

    /**
     * 构建规划阶段的用户消息（对应 LLMentor buildPlanUserMessage）
     */
    private String buildPlanUserMessage(EvidenceOverAllState state) {
        StringBuilder userMessage = new StringBuilder();

        userMessage.append("【用户问题】\n").append(state.getQuestion());

        // 检查是否有上一轮批判反馈
        boolean hasPreviousCritique = false;
        if (!state.getRounds().isEmpty()) {
            EvidencePlanRoundState lastRound = state.getRounds().get(state.getRounds().size() - 1);
            if (lastRound != null && lastRound.critique() != null && !lastRound.critique().passed()) {
                hasPreviousCritique = true;
                userMessage.append("\n\n【上一轮评估反馈】\n").append(lastRound.critique().feedback());
            }
        }

        // 只有在没有上一轮批判时，才添加研究维度（避免信息重复）
        if (!hasPreviousCritique && state.getRefinedResearchTopic() != null
                && !state.getRefinedResearchTopic().isEmpty()) {
            userMessage.append("\n\n【研究维度】\n").append(state.getRefinedResearchTopic());
        }

        return userMessage.toString();
    }

    // ===== 任务计划 UI 展示 =====

    private void displayPlanInUI(List<EvidencePlanTask> plan, EvidenceOverAllState state,
                                   AgentSink sink, boolean isFirstRound) {
        // 初始化 state 任务状态（全部设为 "todo"）
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

        // 初始化全部状态为 "todo"
        sink.status(titles, state.getCurrentStatuses());
    }

    // ===== 计划执行（对应 LLMentor executePlan）=====

    private Map<String, EvidenceTaskResult> executePlan(List<EvidencePlanTask> plan,
                                                          EvidenceOverAllState state, AgentSink sink,
                                                          AtomicBoolean stopped, StringBuilder thinkingBuffer) {
        Map<String, EvidenceTaskResult> results = new ConcurrentHashMap<>();

        // 按 order 分组：同 order 并行，不同 order 串行
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
                        if (compositeDisposable.isDisposed()) {
                            latch.countDown();
                            return;
                        }
                        toolSemaphore.acquire();

                        if (task.id() == null || task.id().isEmpty()) {
                            latch.countDown();
                            toolSemaphore.release();
                            return;
                        }

                        if (compositeDisposable.isDisposed()) {
                            toolSemaphore.release();
                            latch.countDown();
                            return;
                        }

                        // 更新任务状态为 "doing"
                        state.updateTaskStatus(task.id(), "doing");
                        sink.status(state.getCurrentTitles(), state.getCurrentStatuses());

                        EvidenceTaskResult result = executeWithRetry(task, dependencyContext, sink, stopped, thinkingBuffer);
                        results.put(task.id(), result);

                        if (result.success() && result.output() != null) {
                            accumulatedResults.put(task.id(), result.output());
                        }

                        // 记录任务完成到 state messages
                        state.add(new AssistantMessage("""
                                【Completed Task Result】
                                taskId: %s
                                success: %s
                                result:
                                %s
                                error:
                                %s
                                【End Task Result】
                                """.formatted(
                                task.id(),
                                result.success(),
                                result.output(),
                                result.error()
                        )));

                        // 更新任务状态为 "done"
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
                            log.info("任务 {} 被用户停止: {}", task.id(), e.getMessage());
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

    // ===== 单任务执行（内联 ReAct 循环，对应 LLMentor executeWithRetry + SimpleReactAgent）=====

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

        // 内联 ReAct 循环（阻塞，因为运行在 Schedulers.boundedElastic() 上）
        ToolCallingChatOptions toolOptions = ToolCallingChatOptions.builder()
                .toolCallbacks(tools)
                .internalToolExecutionEnabled(false)
                .build();

        List<Message> messages = new ArrayList<>();
        messages.add(new SystemMessage(EvidenceMedicalPrompts.EXECUTE));
        messages.add(new UserMessage(fullContext));

        int maxReactRounds = maxToolRetries + 1;
        for (int round = 0; round < maxReactRounds; round++) {
            if (stopped.get() || compositeDisposable.isDisposed()) {
                return new EvidenceTaskResult(task.id(), false, null, "任务被停止");
            }

            try {
                Prompt prompt = new Prompt(messages, toolOptions);
                ChatResponse response = chatModel.call(prompt);

                if (response == null || response.getResult() == null) {
                    break;
                }

                AssistantMessage assistantMsg = response.getResult().getOutput();
                List<AssistantMessage.ToolCall> toolCalls = assistantMsg.getToolCalls();
                String text = assistantMsg.getText();

                if (toolCalls == null || toolCalls.isEmpty()) {
                    // 无工具调用 → 这是最终答案
                    if (text != null && !text.isBlank()) {
                        emit(sink, stopped, "执行结果: " + summarizeOutput(text) + "\n\n", "thinking", thinkingBuffer);
                        return new EvidenceTaskResult(task.id(), true, text, null);
                    }
                    break;
                }

                // 有工具调用 → 执行工具
                messages.add(assistantMsg);
                executeToolCallsBlocking(task, toolCalls, messages, sink, stopped, thinkingBuffer);

            } catch (Exception e) {
                if (compositeDisposable.isDisposed() || Thread.currentThread().isInterrupted()
                        || (e.getMessage() != null && e.getMessage().contains("interrupted"))) {
                    log.info("任务 {} ReAct 被停止: {}", task.id(), e.getMessage());
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

    /**
     * 同步执行一批工具调用（内联，运行在 boundedElastic 线程上）
     */
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

                // 解析并收集参考文献
                if (toolName.contains("tavily") || toolName.contains("search")) {
                    int found = parseAndCollectReferences(resultStr);
                    sink.toolCallEnd("检索完成，找到 " + found + " 条结果", callId);
                } else {
                    parseAndCollectReferences(resultStr);
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

    // ===== 依赖上下文构建（对应 LLMentor buildDependencyContext）=====

    private String buildDependencyContext(Map<String, String> results, List<EvidencePlanTask> plan, int currentOrder) {
        StringBuilder context = new StringBuilder();

        if (currentOrder == 1) {
            return context.append("无\n").toString();
        }

        boolean hasDependencies = false;
        for (Map.Entry<String, String> entry : results.entrySet()) {
            EvidencePlanTask task = plan.stream()
                    .filter(t -> t.id() != null && t.id().equals(entry.getKey()))
                    .findFirst()
                    .orElse(null);

            if (task != null && task.order() == currentOrder - 1) {
                if (!hasDependencies) {
                    context.append("任务 ");
                    hasDependencies = true;
                }
                context.append(String.format("%s: %s\n\n", entry.getKey(), entry.getValue()));
            }
        }

        if (!hasDependencies) {
            context.append("无\n");
        }

        return context.toString();
    }

    // ===== 研究评审（对应 LLMentor critique）=====

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
                .append(state.getRefinedResearchTopic() != null ? state.getRefinedResearchTopic() : "未生成研究维度");

        userMessage.append("\n\n【当前轮次的执行计划】\n");
        if (currentPlan != null && !currentPlan.isEmpty()) {
            for (EvidencePlanTask task : currentPlan) {
                userMessage.append(String.format("- %s\n", task.instruction()));
            }
        } else {
            userMessage.append("无\n");
        }

        userMessage.append("\n\n【当前轮次的工具结果】\n");
        if (currentResults != null && !currentResults.isEmpty()) {
            for (Map.Entry<String, EvidenceTaskResult> entry : currentResults.entrySet()) {
                EvidenceTaskResult result = entry.getValue();
                if (result != null && result.success() && result.output() != null) {
                    userMessage.append(String.format("任务 %s: %s\n\n", entry.getKey(), result.output()));
                } else if (result != null && !result.success()) {
                    userMessage.append(String.format("任务 %s: 执行失败 - %s\n\n",
                            entry.getKey(), result.error()));
                }
            }
        } else {
            userMessage.append("无\n");
        }

        String systemContent = EvidenceMedicalPrompts.MEDICAL_CRITIQUE + "\n" + converter.getFormat();
        Prompt prompt = new Prompt(List.of(
                new SystemMessage(systemContent),
                new UserMessage(userMessage.toString())
        ));

        String raw = chatClient.prompt(prompt).call().content();
        EvidenceCritiqueResult result = converter.convert(raw);
        if (result == null) {
            result = new EvidenceCritiqueResult(true, "评审解析失败，默认通过");
        }

        if (result.passed()) {
            emit(sink, stopped, "✅ 研究结果评估通过，准备生成最终报告\n", "thinking", thinkingBuffer);
        } else {
            emit(sink, stopped, "⚠️ 评估未通过，原因：" + result.feedback() + "\n", "thinking", thinkingBuffer);
        }

        return result;
    }

    // ===== 上下文压缩（对应 LLMentor compressIfNeeded）=====

    private void compressIfNeeded(EvidenceOverAllState state, AgentSink sink,
                                   AtomicBoolean stopped, StringBuilder thinkingBuffer) {
        if (state.currentChars() < contextCharLimit) return;

        log.warn("===== 上下文过大，开始压缩，当前大小: {} =====", state.currentChars());
        emit(sink, stopped, "📦 上下文过长，正在压缩...\n", "thinking", thinkingBuffer);

        if (stopped.get() || compositeDisposable.isDisposed()) return;

        Prompt prompt = new Prompt(List.of(
                new SystemMessage("""
                        ## 最大压缩限制（必须遵守）
                        你输出的最终内容总字符数不得超过：%d
                        这是硬性上限。

                        """.formatted(contextCharLimit) + EvidenceMedicalPrompts.COMPRESS),
                new UserMessage(renderMessages(state.getMessages()))
        ));

        String snapshot = chatModel.call(prompt)
                .getResult()
                .getOutput()
                .getText();

        state.clearMessages();
        state.add(new SystemMessage("【Compressed Agent State】\n" + snapshot));
        log.warn("===== 压缩完成，新大小: {} =====", state.currentChars());
        emit(sink, stopped, "✅ 上下文压缩完成\n", "thinking", thinkingBuffer);
    }

    // ===== 报告生成（Scheme C，替代 LLMentor summarizeStream）=====

    /**
     * 两步报告生成：
     * Step-1: 生成适配的章节大纲（generateAdaptedToc）
     * Step-2: 流式生成完整报告（streaming with sink.streamAppend）
     */
    private void generateFinalReport(EvidenceOverAllState state, AgentSink sink,
                                      AtomicBoolean stopped, StringBuilder finalAnswerBuffer,
                                      StringBuilder thinkingBuffer) {
        emit(sink, stopped, "\n📝 正在生成最终研究报告...\n\n", "thinking", thinkingBuffer);

        // Step-1: 生成适配章节大纲
        List<String> tocChapters = generateAdaptedToc(state, sink, stopped);
        if (stopped.get() || compositeDisposable.isDisposed()) return;

        // 将章节大纲展示给用户（复用 previewPlan）
        if (!tocChapters.isEmpty()) {
            List<String> tocDetails = tocChapters.stream()
                    .map(ch -> "本章节将基于检索证据撰写")
                    .collect(Collectors.toList());
            sink.previewPlan("报告章节大纲", tocChapters, tocDetails);
        }

        // Step-2: 流式生成完整报告
        String toolResults = state.extractToolResults();
        String templateContext = state.getReportTemplate() != null ?
                state.getReportTemplate().toPromptString() : "";

        Prompt prompt = new Prompt(List.of(
                new SystemMessage(EvidenceMedicalPrompts.getMedicalSummarizePrompt(templateContext)),
                new UserMessage("""
                        【用户原始问题】
                        %s

                        【研究维度】
                        %s

                        【报告章节结构（按此结构撰写）】
                        %s

                        【工具检索结果】
                        %s
                        """.formatted(
                        state.getQuestion(),
                        state.getRefinedResearchTopic() != null ? state.getRefinedResearchTopic() : "通用医学研究",
                        String.join("\n", tocChapters),
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
                    if (chunk == null || chunk.getResult() == null
                            || chunk.getResult().getOutput() == null) return;
                    String text = chunk.getResult().getOutput().getText();
                    if (text != null && !text.isEmpty()) {
                        recordFirstResponse();
                        finalAnswerBuffer.append(text);
                        sink.streamAppend(text);
                    }
                })
                .doOnComplete(() -> {
                    sink.complete();
                    // 附加参考文献
                    List<SearchResult> uniqueRefs = deduplicateReferences(allReferences);
                    if (!uniqueRefs.isEmpty()) {
                        sink.newMessage("");
                        sink.reference(formatReferences(uniqueRefs));
                    }
                    // 上传报告到 OSS 并发送 finish 消息
                    uploadAndDeliverReport(finalAnswerBuffer.toString(), state.getQuestion(), sink);
                    // 完成 future（释放 execute() 阻塞）
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

    /**
     * Step-1: 生成适配章节大纲（对应 Scheme C 第一步）
     */
    private List<String> generateAdaptedToc(EvidenceOverAllState state, AgentSink sink,
                                              AtomicBoolean stopped) {
        emit(sink, stopped, "📑 正在生成报告章节大纲...\n", "thinking");
        if (stopped.get() || compositeDisposable.isDisposed()) return new ArrayList<>();

        BeanOutputConverter<List<String>> converter =
                new BeanOutputConverter<>(new ParameterizedTypeReference<>() {});

        String templateContext = state.getReportTemplate() != null ?
                state.getReportTemplate().toPromptString() : "";
        String toolResults = state.extractToolResults();

        try {
            String raw = chatClient.prompt()
                    .system(EvidenceMedicalPrompts.MEDICAL_GENERATE_TOC)
                    .user("""
                            【用户问题】
                            %s

                            【研究维度】
                            %s

                            【报告类型】
                            %s

                            【模板章节建议（可调整）】
                            %s

                            【收集到的证据概要（供参考）】
                            %s

                            请生成适合本次研究内容的报告章节标题列表。
                            输出格式要求：%s
                            """.formatted(
                            state.getQuestion(),
                            state.getRefinedResearchTopic() != null ? state.getRefinedResearchTopic() : "通用医学研究",
                            state.getReportType().getDisplayName(),
                            templateContext,
                            toolResults.isEmpty() ? "暂无工具检索结果" :
                                    toolResults.substring(0, Math.min(2000, toolResults.length())),
                            converter.getFormat()
                    ))
                    .call()
                    .content();

            List<String> chapters = converter.convert(raw);
            if (chapters != null && !chapters.isEmpty()) {
                emit(sink, stopped, "✅ 章节大纲已生成，共 " + chapters.size() + " 章\n", "thinking");
                return chapters;
            }
        } catch (Exception e) {
            log.warn("生成章节大纲失败，使用模板默认章节: {}", e.getMessage());
        }

        // Fallback: 使用模板章节
        if (state.getReportTemplate() != null) {
            return state.getReportTemplate().getChapterTitles();
        }
        return List.of("研究概述", "方法学", "结果分析", "结论与建议", "参考文献");
    }

    // ===== 工具相关工具方法 =====

    private ToolCallback findTool(String name) {
        return tools.stream()
                .filter(t -> t.getToolDefinition().name().equals(name))
                .findFirst()
                .orElse(null);
    }

    /**
     * 解析工具结果并收集参考文献（支持 Tavily 格式和通用格式）
     */
    private int parseAndCollectReferences(String resultJson) {
        if (resultJson == null || resultJson.isBlank()) return 0;
        try {
            JsonNode root = MAPPER.readTree(resultJson);

            // Tavily 格式：[{text: "{...results...}"}]
            if (root.isArray() && !root.isEmpty()) {
                JsonNode textNode = root.get(0).get("text");
                if (textNode != null) {
                    JsonNode textJson = textNode.isTextual()
                            ? MAPPER.readTree(textNode.asText())
                            : textNode;
                    JsonNode results = textJson.get("results");
                    if (results != null && results.isArray()) {
                        int count = 0;
                        for (JsonNode item : results) {
                            String url = safeText(item, "url");
                            String title = safeText(item, "title");
                            String content = safeText(item, "content");
                            if (url != null && !url.isBlank()) {
                                synchronized (allReferences) {
                                    allReferences.add(new SearchResult(url, title, content));
                                }
                                count++;
                            }
                        }
                        return count;
                    }
                }
            }

            // 直接 results 数组格式
            if (root.has("results") && root.get("results").isArray()) {
                int count = 0;
                for (JsonNode item : root.get("results")) {
                    String url = safeText(item, "url");
                    String title = safeText(item, "title");
                    String content = safeText(item, "content");
                    if (url != null && !url.isBlank()) {
                        synchronized (allReferences) {
                            allReferences.add(new SearchResult(url, title, content));
                        }
                        count++;
                    }
                }
                return count;
            }
        } catch (Exception e) {
            log.debug("解析参考文献失败（可能是非搜索工具结果）: {}", e.getMessage());
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
            if (r.url() != null && seen.add(r.url())) {
                unique.add(r);
            }
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

    // ===== 报告类型识别 =====

    private MedicalReportType detectReportType(String question) {
        if (question == null) return MedicalReportType.HTA_ASSESSMENT;
        String lower = question.toLowerCase();

        if (lower.contains("系统综述") || lower.contains("systematic review")
                || lower.contains("meta分析") || lower.contains("meta-analysis")) {
            return MedicalReportType.SYSTEMATIC_REVIEW;
        }
        if ((lower.contains("循证") && lower.contains("综合")) || lower.contains("evidence synthesis")) {
            return MedicalReportType.EVIDENCE_SYNTHESIS;
        }
        if (lower.contains("药物安全") || lower.contains("drug safety")
                || (lower.contains("安全性") && lower.contains("不良反应"))) {
            return MedicalReportType.DRUG_SAFETY_REPORT;
        }
        if (lower.contains("hta") || lower.contains("卫生技术评估")) {
            return MedicalReportType.HTA_ASSESSMENT;
        }
        // 默认 HTA
        return MedicalReportType.HTA_ASSESSMENT;
    }

    // ===== 辅助方法 =====

    /**
     * 发送内容（对应 LLMentor emit(sink, finished, content, type)）
     * - "thinking" → sink.rawMessage（过程消息，不缓冲）
     * - "text"     → sink.streamAppend（最终答案，带节流缓冲）
     */
    private void emit(AgentSink sink, AtomicBoolean stopped, String content, String type) {
        if (stopped.get() || compositeDisposable.isDisposed()) return;
        if ("thinking".equals(type)) {
            sink.rawMessage(content);
        } else {
            sink.streamAppend(content);
        }
    }

    /**
     * 发送内容并同步收集到 thinkingBuffer（对应 LLMentor emit(sink, finished, content, type, thinkingBuffer)）
     * thinking 类型：先 append 到 buffer，再以全量内容 rawMessage 发出（前端 replace 渲染）。
     */
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

    // ===== OSS 上传 =====

    /**
     * 上传报告到 OSS 并发送 finish 消息（报告流式生成完成后调用）
     * 若 ossReportUploader 未注入，则以空 URL 直接发送 finish。
     */
    private void uploadAndDeliverReport(String reportContent, String question, AgentSink sink) {
        String ossUrl = "";
        // 用问题前 20 字作为文件名
        String shortQ = question != null && question.length() > 20
                ? question.substring(0, 20) : (question != null ? question : "循证报告");
        String reportFileName = shortQ.replaceAll("[\\\\/:*?\"<>|]", "") + "_循证报告.md";

        if (reportContent != null && !reportContent.isBlank() && ossReportUploader != null) {
            try {
                Map<String, String> uploadResult = ossReportUploader.uploadReportContent(0L, reportContent, reportFileName);
                if (uploadResult != null && uploadResult.containsKey("url")) {
                    ossUrl = uploadResult.get("url");
                    reportFileName = uploadResult.getOrDefault("fileName", reportFileName);
                } else {
                    log.warn("OSS 上传返回结果为空，将以空 URL 发送 finish 消息");
                }
            } catch (Exception e) {
                log.error("上传报告到 OSS 失败: {}", e.getMessage(), e);
            }
        } else if (ossReportUploader == null) {
            log.warn("OssReportUploader 未注入，跳过 OSS 上传");
        }

        sink.finish(ossUrl, reportFileName);
        log.info("已发送 finish 消息: url={}, name={}", ossUrl, reportFileName);
    }

    public void setOssReportUploader(OssReportUploader ossReportUploader) {
        this.ossReportUploader = ossReportUploader;
    }

    private void handlePhaseError(String logMessage, Throwable err, AgentSink sink, AtomicBoolean stopped) {        log.error(logMessage, err);
        if (stopped.compareAndSet(false, true)) {
            sink.error(logMessage + ": " + err.getMessage());
            executionFuture.completeExceptionally(err);
        }
    }

    private String renderToolDescriptions() {
        if (tools == null || tools.isEmpty()) return "（当前无可用工具）";
        StringBuilder sb = new StringBuilder();
        for (ToolCallback tool : tools) {
            sb.append("- ")
                    .append(tool.getToolDefinition().name())
                    .append(": ")
                    .append(tool.getToolDefinition().description())
                    .append("\n");
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

    /**
     * 截取输出摘要（避免 emit 内容过长）
     */
    private String summarizeOutput(String text) {
        if (text == null) return "";
        return text.length() > 200 ? text.substring(0, 200) + "..." : text;
    }
}
