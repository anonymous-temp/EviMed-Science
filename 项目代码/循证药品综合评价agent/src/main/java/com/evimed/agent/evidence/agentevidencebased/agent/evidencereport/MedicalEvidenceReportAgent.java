package com.evimed.agent.evidence.agentevidencebased.agent.evidencereport;

import com.evimed.agent.evidence.agentevidencebased.agent.BaseAgent;
import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template.MedicalReportTemplate;
import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template.MedicalReportTemplateRegistry;
import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template.MedicalReportType;
import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template.TemplateChapter;
import com.evimed.agent.evidence.agentevidencebased.agent.messaging.AgentSink;
import com.evimed.agent.evidence.agentevidencebased.entity.EvidenceOverAllState;
import com.evimed.agent.evidence.agentevidencebased.entity.record.*;
import com.evimed.agent.evidence.agentevidencebased.infrastructure.OssReportUploader;
import com.evimed.agent.evidence.agentevidencebased.prompts.GeneralResearchPrompts;
import com.evimed.agent.evidence.agentevidencebased.prompts.MedicalReportPrompts;
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
 * 医学循证报告 Agent
 *
 * 六阶段线性回调链（外层固定顺序）+ 内层自适应搜索循环：
 *   需求澄清 → 任务规划（确认报告结构）→ 证据搜索（Plan-Execute-Critique）
 *             → 证据整理 → 报告撰写 → 交付报告（OSS 上传）
 *
 * 与 GeneralDeepResearchAgent 的核心区别：
 *   - 外层是线性阶段链，不是单一循环
 *   - taskPlanningPhase 先确认报告结构，后续所有阶段都以结构为锚
 *   - 搜索阶段内部仍使用 Plan-Execute-Critique 保证证据质量
 *   - writePhase 流式输出同时写入 buffer，deliverPhase 上传 OSS
 */
@Slf4j
public class MedicalEvidenceReportAgent extends BaseAgent {

    private static final int DEFAULT_MAX_SEARCH_ROUNDS = 3;
    private static final int DEFAULT_CONTEXT_CHAR_LIMIT = 60_000;
    private static final int DEFAULT_MAX_TOOL_RETRIES = 2;
    private static final int EXECUTE_TIMEOUT_MINUTES = 20;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final int maxSearchRounds;
    private final int contextCharLimit;
    private final int maxToolRetries;
    private final Semaphore toolSemaphore;
    private final List<ToolCallback> tools;
    private final ChatClient chatClient;

    /** 可选，不注入则跳过 OSS 上传 */
    private OssReportUploader ossReportUploader;

    // ===== 顶层阶段定义（固定，对应 orchestraPlan 展示的四个执行阶段）=====

    private static final List<String> PHASE_TITLES = List.of("检索证据", "整理分析", "撰写报告", "交付报告");
    private static final List<String> PHASE_DETAILS = List.of(
            "系统检索相关文献、指南及安全性数据",
            "按报告结构整理证据，提炼关键发现",
            "依据证据逐章撰写完整循证医学报告",
            "生成报告文件并上传交付"
    );
    private static final int PHASE_SEARCH   = 0;
    private static final int PHASE_ORGANIZE = 1;
    private static final int PHASE_WRITE    = 2;
    private static final int PHASE_DELIVER  = 3;

    // ===== Per-execution 状态（每次 execute() 重置）=====
    private volatile Disposable.Composite compositeDisposable;
    private volatile CompletableFuture<Void> executionFuture;
    private volatile String reportStructure;      // taskPlanningPhase 生成的报告目录
    private volatile String organizedContent;     // organizePhase 整理的证据要点
    private volatile List<SearchResult> allReferences;
    private volatile String[] phaseStatuses;      // 顶层四阶段状态：todo/doing/done
    private volatile String reportUrl;            // deliverPhase 上传后的 OSS URL
    private volatile String reportDisplayTitle;   // 展示给前端的报告标题

    public MedicalEvidenceReportAgent(ChatModel chatModel, List<ToolCallback> tools) {
        super("medical-evidence-report", chatModel, "medical-evidence-report");
        this.tools = tools != null ? tools : List.of();
        this.maxSearchRounds = DEFAULT_MAX_SEARCH_ROUNDS;
        this.contextCharLimit = DEFAULT_CONTEXT_CHAR_LIMIT;
        this.maxToolRetries = DEFAULT_MAX_TOOL_RETRIES;
        this.toolSemaphore = new Semaphore(3);
        this.chatClient = ChatClient.builder(chatModel).build();
    }

    public void setOssReportUploader(OssReportUploader ossReportUploader) {
        this.ossReportUploader = ossReportUploader;
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
        reportStructure = null;
        organizedContent = null;
        reportUrl = null;
        reportDisplayTitle = null;
        phaseStatuses = new String[]{"todo", "todo", "todo", "todo"};

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

        MedicalReportType reportType = detectReportType(question);
        MedicalReportTemplate template = MedicalReportTemplateRegistry.getTemplate(reportType);
        log.info("检测报告类型: {} → {}", reportType, template.displayName());

        EvidenceOverAllState state = initStateAndSaveQuestion(sessionId, question, reportType, template);

        // ===== 六阶段回调链 =====
        clarifyRequirementPhase(state, sink, stopped, thinkingBuffer,
                () -> taskPlanningPhase(state, sink, stopped, thinkingBuffer,
                        () -> searchPhase(state, sink, stopped, thinkingBuffer,
                                () -> organizePhase(state, sink, stopped, thinkingBuffer,
                                        () -> writePhase(state, sink, stopped, finalAnswerBuffer, thinkingBuffer,
                                                () -> deliverPhase(state, sink, stopped, finalAnswerBuffer))))));

        if (taskManager != null) {
            taskManager.setDisposable(sessionId, compositeDisposable);
        }

        try {
            executionFuture.get(EXECUTE_TIMEOUT_MINUTES, TimeUnit.MINUTES);
            // 正常完成后在顶层发送 finish（含报告 URL 和标题）
            if (reportUrl != null && !reportUrl.isBlank()) {
                sink.finish(reportUrl, reportDisplayTitle);
            }
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

    private EvidenceOverAllState initStateAndSaveQuestion(String sessionId, String question,
                                                           MedicalReportType reportType,
                                                           MedicalReportTemplate template) {
        EvidenceOverAllState state = new EvidenceOverAllState(sessionId, question, reportType, template);

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

    // ===== 报告类型检测（LLM 语义判断）=====

    private MedicalReportType detectReportType(String question) {
        try {
            String prompt = """
                    你是医学报告类型分类专家。根据用户的研究需求，判断最适合的报告类型。

                    ## 报告类型说明
                    - HTA_ASSESSMENT：卫生技术评估，含临床有效性、安全性、经济学评估、医保准入建议
                    - EVIDENCE_SYNTHESIS：循证综合，系统整合多项研究证据，评价某干预措施的总体效果
                    - SYSTEMATIC_REVIEW：系统综述，严格按 PRISMA 方法学检索、筛选、评价文献
                    - DRUG_SAFETY_REPORT：药物安全性报告，聚焦不良反应、上市后监测、风险管理

                    ## 用户需求
                    %s

                    只输出以下四个枚举值之一，不要有任何其他内容：
                    HTA_ASSESSMENT / EVIDENCE_SYNTHESIS / SYSTEMATIC_REVIEW / DRUG_SAFETY_REPORT
                    """.formatted(question);

            String result = chatClient.prompt()
                    .user(prompt)
                    .call()
                    .content();

            if (result != null) {
                String trimmed = result.trim().toUpperCase();
                for (MedicalReportType type : MedicalReportType.values()) {
                    if (trimmed.contains(type.name())) {
                        log.info("LLM 报告类型判断: {} → {}", type, question.substring(0, Math.min(40, question.length())));
                        return type;
                    }
                }
            }
        } catch (Exception e) {
            log.warn("LLM 报告类型判断失败，降级为默认类型: {}", e.getMessage());
        }
        return MedicalReportType.HTA_ASSESSMENT;
    }

    // ===== 阶段一：需求澄清 =====

    private void clarifyRequirementPhase(EvidenceOverAllState state, AgentSink sink,
                                          AtomicBoolean stopped, StringBuilder thinkingBuffer,
                                          Runnable onComplete) {
        emit(sink, stopped, "🔍 正在分析您的研究需求...\n", "thinking", thinkingBuffer);
        thinkingBuffer.setLength(0);

        List<Message> messages = new ArrayList<>();
        messages.add(new SystemMessage(MedicalReportPrompts.REQUIREMENT_CLARIFICATION));
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
        emit(sink, stopped, "\n", "thinking", thinkingBuffer);

        if (response.contains("【需要补充信息】")) {
            String pauseMessage = "⏸【暂停深入研究】" + response.replace("【需要补充信息】", "").trim();
            sink.rawMessage(pauseMessage);
            if (stopped.compareAndSet(false, true)) {
                sink.complete();
                executionFuture.complete(null);
            }
        } else {
            emit(sink, stopped, "✅ 需求明确，开始规划报告结构\n", "thinking", thinkingBuffer);
            onComplete.run();
        }
    }

    // ===== 阶段二：任务规划（生成报告结构）=====

    private void taskPlanningPhase(EvidenceOverAllState state, AgentSink sink,
                                    AtomicBoolean stopped, StringBuilder thinkingBuffer,
                                    Runnable onComplete) {
        thinkingBuffer.setLength(0);
        emit(sink, stopped, "\n📊 正在生成报告结构...\n", "thinking", thinkingBuffer);

        MedicalReportTemplate template = state.getReportTemplate();
        String templateContent = template != null ? template.toPromptString() : "（使用通用医学报告模板）";

        String systemContent = """
                ## 报告类型参考模板（%s）
                %s

                ## 用户研究需求
                %s
                """.formatted(
                template != null ? template.displayName() : "医学研究报告",
                templateContent,
                state.getQuestion())
                + MedicalReportPrompts.TASK_PLANNING;

        StringBuilder structureBuffer = new StringBuilder();

        Disposable disposable = chatClient.prompt()
                .messages(List.of(new SystemMessage(systemContent)))
                .stream()
                .content()
                .doOnNext(chunk -> {
                    structureBuffer.append(chunk);
                    emit(sink, stopped, chunk, "thinking", thinkingBuffer);
                })
                .doOnComplete(() -> {
                    reportStructure = structureBuffer.toString();
                    state.setRefinedResearchTopic(reportStructure);
//                    emit(sink, stopped, "\n✅ 报告结构已确认\n\n", "thinking", thinkingBuffer);
                    displayReportStructureAsPlan(state, template, sink);
                    onComplete.run();
                })
                .doOnError(err -> handlePhaseError("报告结构生成异常", err, sink, stopped))
                .subscribeOn(Schedulers.boundedElastic())
                .subscribe();

        compositeDisposable.add(disposable);
    }

    private void displayReportStructureAsPlan(EvidenceOverAllState state,
                                               MedicalReportTemplate template, AgentSink sink) {
        // 顶层展示的是执行阶段，不是报告章节
        // 报告章节已通过 thinking 流式输出展示给用户
        String analysis = (template != null ? template.displayName() : "循证医学报告") + " · 共 4 个执行阶段";
        sink.previewPlan(analysis, PHASE_TITLES, PHASE_DETAILS);
        sink.orchestraPlan(analysis, PHASE_TITLES, PHASE_DETAILS);
    }

    /**
     * 更新顶层阶段状态并推送给前端。
     * phaseIndex 对应的阶段设为 doing，之前的全部设为 done，之后的保持 todo。
     */
    private void updatePhaseStatus(int phaseIndex, AgentSink sink) {
        for (int i = 0; i < phaseStatuses.length; i++) {
            if (i < phaseIndex)       phaseStatuses[i] = "done";
            else if (i == phaseIndex) phaseStatuses[i] = "doing";
            else                      phaseStatuses[i] = "todo";
        }
        sink.status(PHASE_TITLES, List.of(phaseStatuses));
    }

    private void markAllPhasesDone(AgentSink sink) {
        Arrays.fill(phaseStatuses, "done");
        sink.status(PHASE_TITLES, List.of(phaseStatuses));
    }

    // ===== 阶段三：证据搜索（内层 Plan-Execute-Critique 循环）=====

    private void searchPhase(EvidenceOverAllState state, AgentSink sink,
                              AtomicBoolean stopped, StringBuilder thinkingBuffer,
                              Runnable onComplete) {
        updatePhaseStatus(PHASE_SEARCH, sink);
        thinkingBuffer.setLength(0);
        emit(sink, stopped, "\n🔬 开始证据检索阶段\n", "thinking", thinkingBuffer);

        Disposable disposable = Mono.fromRunnable(() -> runSearchLoop(state, sink, stopped, thinkingBuffer, onComplete))
                .subscribeOn(Schedulers.boundedElastic())
                .subscribe(
                        null,
                        e -> {
                            if (compositeDisposable.isDisposed() || Thread.currentThread().isInterrupted()
                                    || (e.getMessage() != null && e.getMessage().contains("interrupted"))) {
                                log.info("MedicalEvidenceReportAgent 搜索被用户停止");
                                if (stopped.compareAndSet(false, true)) {
                                    sink.complete();
                                    executionFuture.complete(null);
                                }
                            } else {
                                log.error("搜索阶段异常", e);
                                if (stopped.compareAndSet(false, true)) {
                                    sink.error("搜索阶段失败: " + e.getMessage());
                                    executionFuture.completeExceptionally(e);
                                }
                            }
                        });

        compositeDisposable.add(disposable);
    }

    private void runSearchLoop(EvidenceOverAllState state, AgentSink sink,
                                AtomicBoolean stopped, StringBuilder thinkingBuffer,
                                Runnable onComplete) {
        try {
            while (state.getRound() < maxSearchRounds && !stopped.get() && !compositeDisposable.isDisposed()) {
                state.nextRound();
                log.info("===== 证据检索 Round {} =====", state.getRound());
                emit(sink, stopped, "\n🔄 第 " + state.getRound() + " 轮检索开始\n", "thinking", thinkingBuffer);
                sink.newMessage("");
                thinkingBuffer.setLength(0);

                List<EvidencePlanTask> plan = generateSearchPlan(state, sink, stopped, thinkingBuffer);
                if (stopped.get() || compositeDisposable.isDisposed()) return;

                if (plan.isEmpty() || plan.stream().allMatch(t -> t.id() == null)) {
                    log.info("搜索计划为空，提前结束检索循环");
                    break;
                }

                displaySearchPlanInUI(plan, state, sink, state.getRound() == 1);

                Map<String, EvidenceTaskResult> results = executePlan(plan, state, sink, stopped, thinkingBuffer);
                if (stopped.get() || compositeDisposable.isDisposed()) return;

                EvidenceCritiqueResult critique = critiqueSearch(state, plan, results, sink, stopped, thinkingBuffer);
                if (stopped.get() || compositeDisposable.isDisposed()) return;

                state.addRound(new EvidencePlanRoundState(state.getRound(), plan, results, critique));

                if (critique.passed()) {
                    emit(sink, stopped, "✅ 证据充分，结束检索\n", "thinking", thinkingBuffer);
                    sink.newMessage("");
                    thinkingBuffer.setLength(0);
                    break;
                }

                state.add(new AssistantMessage("""
                        【Critique Feedback】
                        %s
                        """.formatted(critique.feedback())));

//                emit(sink, stopped, "\n--- 准备进入下一轮检索 ---\n", "thinking", thinkingBuffer);
//                sink.newMessage("");
                thinkingBuffer.setLength(0);
                compressIfNeeded(state, sink, stopped, thinkingBuffer);
            }

            emit(sink, stopped, "\n✅ 证据检索完成，进入整理阶段\n", "thinking", thinkingBuffer);
            sink.newMessage("");
            thinkingBuffer.setLength(0);
            onComplete.run();

        } catch (Exception e) {
            if (compositeDisposable.isDisposed() || Thread.currentThread().isInterrupted()
                    || (e.getMessage() != null && e.getMessage().contains("interrupted"))) {
                log.info("搜索循环被用户停止: {}", e.getMessage());
                if (stopped.compareAndSet(false, true)) {
                    sink.complete();
                    executionFuture.complete(null);
                }
            } else {
                log.error("搜索循环异常", e);
                throw e;
            }
        }
    }

    // ===== 搜索计划生成 =====

    private List<EvidencePlanTask> generateSearchPlan(EvidenceOverAllState state, AgentSink sink,
                                                        AtomicBoolean stopped, StringBuilder thinkingBuffer) {
        String toolDesc = renderToolDescriptions();
        BeanOutputConverter<List<EvidencePlanTask>> converter =
                new BeanOutputConverter<>(new ParameterizedTypeReference<>() {});

        String currentStructure = reportStructure != null ? reportStructure : "（结构待生成）";

        String systemContent = """
                ## 当前是第 %d 轮检索

                ## 报告目录结构
                %s

                ## 可用工具
                %s

                ## 输出格式（严格 JSON，不含其他文字）
                %s
                """.formatted(state.getRound(), currentStructure, toolDesc, converter.getFormat())
                + MedicalReportPrompts.SEARCH_PLAN;

        emit(sink, stopped, "📋 正在规划检索任务...\n", "thinking", thinkingBuffer);
        sink.newMessage("");
        thinkingBuffer.setLength(0);
        if (stopped.get() || compositeDisposable.isDisposed()) return new ArrayList<>();

        String json = chatClient.prompt()
                .messages(List.of(
                        new SystemMessage(systemContent),
                        new UserMessage(buildSearchPlanUserMessage(state))
                ))
                .call()
                .content();

        List<EvidencePlanTask> planTasks = converter.convert(json);
        if (planTasks == null) planTasks = new ArrayList<>();

        emit(sink, stopped, "✅ 检索计划已生成，共 " + planTasks.size() + " 个任务\n", "thinking", thinkingBuffer);
        sink.newMessage("");
        thinkingBuffer.setLength(0);

        if (!planTasks.isEmpty()) {
            StringBuilder planText = new StringBuilder("📋 **本轮检索计划：**\n\n");
            for (EvidencePlanTask task : planTasks) {
                planText.append(String.format("- 🟠 %s\n", task.title()));
            }
            emit(sink, stopped, planText.toString(), "thinking", thinkingBuffer);
            sink.newMessage("");
            thinkingBuffer.setLength(0);
        }

        return planTasks;
    }

    private String buildSearchPlanUserMessage(EvidenceOverAllState state) {
        StringBuilder sb = new StringBuilder();
        sb.append("【用户研究需求】\n").append(state.getQuestion());

        if (!state.getRounds().isEmpty()) {
            EvidencePlanRoundState lastRound = state.getRounds().get(state.getRounds().size() - 1);
            if (lastRound != null && lastRound.critique() != null && !lastRound.critique().passed()) {
                sb.append("\n\n【上一轮评审反馈，本轮需要补充】\n").append(lastRound.critique().feedback());
            }
        }

        String existingResults = state.extractToolResults();
        if (!existingResults.isEmpty()) {
            int maxLen = Math.min(existingResults.length(), 2000);
            sb.append("\n\n【已检索到的证据摘要（前2000字）】\n").append(existingResults, 0, maxLen);
        }

        return sb.toString();
    }

    // ===== 搜索计划 UI 展示 =====

    private void displaySearchPlanInUI(List<EvidencePlanTask> plan, EvidenceOverAllState state,
                                        AgentSink sink, boolean isFirstRound) {
        state.setCurrentPlan(plan);

        if (!isFirstRound) {
            sink.rawMessage("\n📋 第 " + state.getRound() + " 轮检索计划：" + plan.size() + " 个任务\n");
        }
    }

    // ===== 执行检索计划（并发，按 order 分批）=====

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
                            toolSemaphore.release(); latch.countDown(); return;
                        }
                        if (compositeDisposable.isDisposed()) {
                            toolSemaphore.release(); latch.countDown(); return;
                        }

                        state.updateTaskStatus(task.id(), "doing");

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

                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        results.put(task.id(), new EvidenceTaskResult(task.id(), false, null, "执行被中断"));
                        state.updateTaskStatus(task.id(), "done");
                    } catch (Exception e) {
                        if (compositeDisposable.isDisposed() || Thread.currentThread().isInterrupted()
                                || (e.getMessage() != null && e.getMessage().contains("interrupted"))) {
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

        String fullContext = """
                【已有检索结果】
                %s

                【当前任务】
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
                        emit(sink, stopped, "结果摘要: " + summarizeOutput(text) + "\n\n", "thinking", thinkingBuffer);
                        sink.newMessage("");
                        thinkingBuffer.setLength(0);
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

            sink.toolCallStart("调用工具: " + toolName + " | " + task.title(), callId, argsJson);

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
                sink.toolCallEnd("检索完成，找到 " + found + " 条结果", callId);

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

    // ===== 证据充分性评审 =====

    private EvidenceCritiqueResult critiqueSearch(EvidenceOverAllState state,
                                                    List<EvidencePlanTask> currentPlan,
                                                    Map<String, EvidenceTaskResult> currentResults,
                                                    AgentSink sink, AtomicBoolean stopped,
                                                    StringBuilder thinkingBuffer) {
        BeanOutputConverter<EvidenceCritiqueResult> converter =
                new BeanOutputConverter<>(new ParameterizedTypeReference<>() {});

        emit(sink, stopped, "\n🔍 评估证据充分性...\n", "thinking", thinkingBuffer);
        sink.newMessage("");
        thinkingBuffer.setLength(0);
        if (stopped.get() || compositeDisposable.isDisposed()) {
            return new EvidenceCritiqueResult(true, "任务已取消");
        }

        String currentStructure = reportStructure != null ? reportStructure : "（结构待生成）";

        StringBuilder userMessage = new StringBuilder();
        userMessage.append("【报告目录结构】\n").append(currentStructure);
        userMessage.append("\n\n【本轮检索计划】\n");
        if (currentPlan != null) {
            currentPlan.forEach(t -> userMessage.append("- ").append(t.instruction()).append("\n"));
        }
        userMessage.append("\n\n【本轮检索结果】\n");
        if (currentResults != null) {
            currentResults.forEach((id, r) -> {
                if (r != null && r.success() && r.output() != null) {
                    userMessage.append(String.format("任务 %s:\n%s\n\n", id, r.output()));
                } else if (r != null && !r.success()) {
                    userMessage.append(String.format("任务 %s: 失败 - %s\n\n", id, r.error()));
                }
            });
        }

        String systemContent = """
                ## 报告目录结构（评审参考）
                %s
                """.formatted(currentStructure)
                + MedicalReportPrompts.SEARCH_CRITIQUE + "\n" + converter.getFormat();

        String raw = chatClient.prompt()
                .messages(List.of(
                        new SystemMessage(systemContent),
                        new UserMessage(userMessage.toString())
                ))
                .call()
                .content();

        EvidenceCritiqueResult result = converter.convert(raw);
        if (result == null) result = new EvidenceCritiqueResult(true, "评审解析失败，默认通过");

        if (result.passed()) {
            emit(sink, stopped, "✅ 证据评估通过\n", "thinking", thinkingBuffer);
            sink.newMessage("");
            thinkingBuffer.setLength(0);
        } else {
            emit(sink, stopped, "⚠️ 证据不足：" + result.feedback() + "\n", "thinking", thinkingBuffer);
            sink.newMessage("");
            thinkingBuffer.setLength(0);
        }

        return result;
    }

    // ===== 上下文压缩 =====

    private void compressIfNeeded(EvidenceOverAllState state, AgentSink sink,
                                   AtomicBoolean stopped, StringBuilder thinkingBuffer) {
        if (state.currentChars() < contextCharLimit) return;

        log.warn("上下文过大，开始压缩，当前大小: {}", state.currentChars());
        emit(sink, stopped, "📦 上下文过长，正在压缩...\n", "thinking", thinkingBuffer);
        sink.newMessage("");
        thinkingBuffer.setLength(0);
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
        sink.newMessage("");
        thinkingBuffer.setLength(0);
    }

    // ===== 依赖上下文构建 =====

    private String buildDependencyContext(Map<String, String> results, List<EvidencePlanTask> plan,
                                           int currentOrder) {
        if (currentOrder == 1) return "无\n";
        StringBuilder context = new StringBuilder();
        boolean has = false;
        for (Map.Entry<String, String> entry : results.entrySet()) {
            EvidencePlanTask task = plan.stream()
                    .filter(t -> t.id() != null && t.id().equals(entry.getKey()))
                    .findFirst().orElse(null);
            if (task != null && task.order() == currentOrder - 1) {
                context.append(String.format("任务 %s: %s\n\n", entry.getKey(), entry.getValue()));
                has = true;
            }
        }
        return has ? context.toString() : "无\n";
    }

    // ===== 阶段四：证据整理 =====

    private void organizePhase(EvidenceOverAllState state, AgentSink sink,
                                AtomicBoolean stopped, StringBuilder thinkingBuffer,
                                Runnable onComplete) {
        updatePhaseStatus(PHASE_ORGANIZE, sink);
        thinkingBuffer.setLength(0);
        emit(sink, stopped, "\n🗂️ 正在整理证据资料...\n", "thinking", thinkingBuffer);
        thinkingBuffer.setLength(0);

        String toolResults = state.extractToolResults();
        String currentStructure = reportStructure != null ? reportStructure : "";

        String systemContent = """
                ## 报告目录结构
                %s
                """.formatted(currentStructure)
                + MedicalReportPrompts.ORGANIZE;

        String userContent = toolResults.isEmpty()
                ? "（当前未检索到相关证据）"
                : toolResults;

        StringBuilder organizeBuffer = new StringBuilder();

        Disposable disposable = chatClient.prompt()
                .messages(List.of(
                        new SystemMessage(systemContent),
                        new UserMessage(userContent)
                ))
                .stream()
                .content()
                .doOnNext(chunk -> {
                    organizeBuffer.append(chunk);
                    emit(sink, stopped, chunk, "thinking", thinkingBuffer);
                })
                .doOnComplete(() -> {
                    sink.newMessage("");
                    organizedContent = organizeBuffer.toString();
                    emit(sink, stopped, "\n✅ 证据整理完成\n\n", "thinking", thinkingBuffer);
                    onComplete.run();
                })
                .doOnError(err -> handlePhaseError("证据整理异常", err, sink, stopped))
                .subscribeOn(Schedulers.boundedElastic())
                .subscribe();

        compositeDisposable.add(disposable);
    }

    // ===== 阶段五：报告撰写 =====

    private static final String[] WRITE_WAITING_MESSAGES = {
            "✍️ 正在为您撰写循证报告，这通常需要 2～4 分钟，请稍候...",
            "📝 正在逐章梳理证据、撰写报告，请您耐心等待几分钟...",
            "🖊️ 基于检索结果，正在将证据整合为完整的循证医学报告，请稍候...",
            "📄 报告撰写中，将依据证据逐步完成各章节，预计需要 2～3 分钟...",
            "🔬 正在深度整合证据并生成循证报告，请稍候片刻，报告即将呈现...",
            "📖 正在精心撰写您的循证医学报告，预计需要几分钟，请耐心等待..."
    };

    private void writePhase(EvidenceOverAllState state, AgentSink sink,
                             AtomicBoolean stopped, StringBuilder finalAnswerBuffer,
                             StringBuilder thinkingBuffer, Runnable onComplete) {
        updatePhaseStatus(PHASE_WRITE, sink);
        thinkingBuffer.setLength(0);
        String waitMsg = WRITE_WAITING_MESSAGES[
                (int) (Math.random() * WRITE_WAITING_MESSAGES.length)];
        emit(sink, stopped, waitMsg, "thinking", thinkingBuffer);

        String currentStructure = reportStructure != null ? reportStructure : "";
        String evidence = (organizedContent != null && !organizedContent.isBlank())
                ? organizedContent
                : state.extractToolResults();

        String systemContent = """
                ## 报告目录结构（必须严格遵守）
                %s
                """.formatted(currentStructure)
                + MedicalReportPrompts.WRITE;

        String userContent = """
                【用户研究需求】
                %s

                【整理好的证据资料】
                %s
                """.formatted(
                state.getQuestion(),
                evidence.isEmpty() ? "（暂无检索结果，请尽量基于已知知识撰写并标注需补充之处）" : evidence);

        Disposable disposable = chatClient.prompt()
                .messages(List.of(
                        new SystemMessage(systemContent),
                        new UserMessage(userContent)
                ))
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
                        // sink.streamAppend(finalAnswerBuffer.toString().trim()); // 撰写阶段不实时输出内容，由交付阶段统一呈现
                    }
                })
                .doOnComplete(() -> {
                    emit(sink, stopped, "\n\n✅ 报告撰写完成\n", "thinking", thinkingBuffer);
                    onComplete.run();
                })
                .doOnError(e -> handlePhaseError("报告撰写异常", e, sink, stopped))
                .subscribe();

        compositeDisposable.add(disposable);
    }

    // ===== 阶段六：交付报告（OSS 上传）=====

    private void deliverPhase(EvidenceOverAllState state, AgentSink sink,
                               AtomicBoolean stopped, StringBuilder finalAnswerBuffer) {
        updatePhaseStatus(PHASE_DELIVER, sink);
        try {
            if (ossReportUploader != null && finalAnswerBuffer.length() > 0) {
                emit(sink, stopped, "\n📤 正在上传报告...\n", "thinking", new StringBuilder());

                String reportTypeName = state.getReportType() != null
                        ? state.getReportType().name().toLowerCase()
                        : "medical";
                // 从用户问题中提取关键词作为文件名前缀（去掉非法字符，限长30）
                String questionSlug = state.getQuestion()
                        .replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]+", "")
                        .replaceAll("\\s+", "_")
                        .replaceAll("_+", "_")
                        .replaceAll("^_|_$", "");
                if (questionSlug.length() > 30) {
                    questionSlug = questionSlug.substring(0, 30);
                }
                String fileName = reportTypeName + "_" + questionSlug + "_report.md";
                String reportTitle = state.getReportType() != null
                        ? state.getReportType().getDisplayName() + "：" + state.getQuestion()
                        : state.getQuestion();

                // TODO: 替换为真实 userId（从 session 获取）
                Map<String, String> uploadResult = ossReportUploader.uploadReportContent(
                        0L, finalAnswerBuffer.toString(), fileName);

                String url = uploadResult != null ? uploadResult.get("url") : null;
                if (url != null && !url.isBlank()) {
                    sink.rawMessage("\n\n📄 **报告已生成**: [点击下载报告](" + url + ")\n");
                    sink.newMessage("");
                    // 存入顶层字段，由 execute() 在 future 完成后统一调用 sink.finish
                    this.reportUrl = url;
                    this.reportDisplayTitle = reportTitle;
                    log.info("报告上传成功: url={}, sessionId={}", url, state.getSessionId());
                } else {
                    log.warn("报告上传成功但未获取到 URL");
                }
            }
        } catch (Exception e) {
            log.error("报告上传失败，不影响文字输出", e);
        }

        // 收集引用（参考文献已写入报告正文末尾，UI 侧不再单独展示引用链接）
//        List<SearchResult> uniqueRefs = deduplicateReferences(allReferences);
//        if (!uniqueRefs.isEmpty()) {
//            sink.newMessage("");
//            sink.reference(formatReferences(uniqueRefs));
//        }

        markAllPhasesDone(sink);
        sink.complete();
        if (stopped.compareAndSet(false, true)) {
            executionFuture.complete(null);
        } else if (!executionFuture.isDone()) {
            executionFuture.complete(null);
        }
    }

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
        return text.length() > 300 ? text.substring(0, 300) + "..." : text;
    }

    private void emit(AgentSink sink, AtomicBoolean stopped, String content, String type,
                      StringBuilder thinkingBuffer) {
        if (stopped.get() || compositeDisposable.isDisposed()) return;
        if ("thinking".equals(type)) {
            if (thinkingBuffer != null) thinkingBuffer.append(content);
            sink.rawMessage(thinkingBuffer.toString().trim());
        } else {
            sink.streamAppend(content);
        }
    }
}
