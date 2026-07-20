package com.evimed.agent.evidence.agentevidencebased.agent.evidencereport;

import com.evimed.agent.evidence.agentevidencebased.agent.BaseAgent;
import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template.MedicalReportTemplate;
import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template.MedicalReportTemplateRegistry;
import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template.MedicalReportType;
import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template.TemplateChapter;
import com.evimed.agent.evidence.agentevidencebased.agent.messaging.AgentSink;
import com.evimed.agent.evidence.agentevidencebased.entity.AgentSession;
import com.evimed.agent.evidence.agentevidencebased.entity.EvidenceOverAllState;
import com.evimed.agent.evidence.agentevidencebased.entity.record.*;
import com.evimed.agent.evidence.agentevidencebased.infrastructure.OssReportUploader;
import com.evimed.agent.evidence.agentevidencebased.infrastructure.util.LLMCostCalculator;
import com.evimed.agent.evidence.agentevidencebased.prompts.GeneralResearchPrompts;
import com.evimed.agent.evidence.agentevidencebased.prompts.KBMedicalReportPrompts;
import com.evimed.agent.evidence.agentevidencebased.service.AgentTaskManager;
import com.evimed.agent.evidence.agentevidencebased.tools.EvidenceRetrievalTool;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
import org.springframework.ai.support.ToolCallbacks;
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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
/**
 * 知识库循证报告 Agent（KB版）
 *
 * 六阶段线性回调链（外层固定顺序）+ 内层自适应搜索循环：
 *   需求澄清 → 任务规划（确认报告结构）→ 证据搜索（Plan-Execute-Critique）
 *             → 证据整理 → 报告撰写 → 交付报告（OSS 上传）
 *
 * 与 MedicalEvidenceReportAgent 的核心区别：
 *   - 使用本地知识库工具（EvidenceRetrievalTool）替代 Tavily 网络搜索
 *   - parseAndCollectReferences 解析 EvidenceResponse 格式（items 数组），而非 Tavily 格式
 */
@Slf4j
public class KBEvidenceReportAgent extends BaseAgent {

    private static final int DEFAULT_MAX_SEARCH_ROUNDS = 5;
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
    private volatile CitationRegistry citationRegistry;  // 文献引用注册表
    private volatile String[] phaseStatuses;      // 顶层四阶段状态：todo/doing/done
    private volatile String reportUrl;            // deliverPhase 上传后的 OSS URL
    private volatile String reportDisplayTitle;   // 展示给前端的报告标题
    private volatile LLMCostCalculator.CostStats costStats;  // LLM 成本统计

    public KBEvidenceReportAgent(ChatModel chatModel, EvidenceRetrievalTool evidenceRetrievalTool) {
        super("kb-evidence-report", chatModel, "kb-evidence-report");
        this.tools = evidenceRetrievalTool != null
            ? List.of(ToolCallbacks.from(evidenceRetrievalTool))
            : List.of();
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
        costStats = LLMCostCalculator.createStats();

        // ===== 检查历史记录：区分澄清回复 / 报告追问 / 首次生成 =====
        ChatMemory memory = buildChatMemory(sessionId, 10);
        List<Message> history = memory.get(sessionId);
        if (history != null && !history.isEmpty()) {
            List<AgentSession> recentSessions = sessionService.findRecentBySessionId(sessionId, 1);
            if (recentSessions != null && !recentSessions.isEmpty()) {
                AgentSession lastSession = recentSessions.getFirst();
                String lastAnswer = lastSession.getAnswer();

                if (lastAnswer != null && lastAnswer.contains("【需要补充信息】")) {
                    // 澄清回复：合并原始问题 + 用户补充信息，重新走完整报告流程
                    String originalQuestion = lastSession.getQuestion();
                    question = originalQuestion + "\n用户补充说明：" + question;
                    log.info("检测到澄清回复，合并问题: original={}, supplement={}",
                            originalQuestion, question);
                    // 不 return，继续走下方首次生成报告的完整流程
                } else {
                    // 有历史报告，进入追问模式
                    log.info("检测到历史报告，进入追问模式: sessionId={}", sessionId);
                    handleFollowUpQuestion(sessionId, question, sink, memory);
                    return;
                }
            }
        }

        // ===== 首次生成报告的完整流程（含澄清回复后重入） =====
        executionFuture = new CompletableFuture<>();
        compositeDisposable = Disposables.composite();
        allReferences = new ArrayList<>();
        citationRegistry = new CitationRegistry();
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
                // 保存到 ChatMemory，支持后续追问
//                memory.add(sessionId, new UserMessage(question));
//                memory.add(sessionId, new AssistantMessage(finalAnswerBuffer.toString()));
                log.info("报告已保存到 ChatMemory，支持追问: sessionId={}", sessionId);
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

            ChatResponse resp = chatClient.prompt()
                    .user(prompt)
                    .call()
                    .chatResponse();

            if (resp != null && resp.getMetadata() != null) {
                costStats.add(resp.getMetadata().getUsage());
            }

            String result = resp != null ? resp.getResult().getOutput().getText() : null;

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
        messages.add(new SystemMessage(KBMedicalReportPrompts.REQUIREMENT_CLARIFICATION));
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
                .doOnComplete(() -> {
                    // 估算 token 消耗
                    String inputText = messages.stream()
                            .map(m -> m.getText())
                            .reduce("", (a, b) -> a + b);
                    costStats.addEstimated(inputText, responseBuffer.toString());
                    handleClarificationComplete(responseBuffer, sink, stopped, thinkingBuffer, onComplete);
                })
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
            // 保存澄清回复到 DB，下一轮 execute 通过 answer 中的标记识别澄清场景
            saveAnswer(response, null);
            if (stopped.compareAndSet(false, true)) {
                sink.complete();
                executionFuture.complete(null);
                sink.finish("","");
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
                + KBMedicalReportPrompts.TASK_PLANNING;

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
                    // 估算 token 消耗
                    costStats.addEstimated(systemContent, structureBuffer.toString());

                    String fullOutput = structureBuffer.toString();
                    // 解析标题和目录结构：第一行是标题，空行后是目录
                    String[] lines = fullOutput.split("\n", 3);
                    if (lines.length >= 3) {
                        reportDisplayTitle = lines[0].trim();
                        reportStructure = lines[2].trim();  // 跳过空行
                    } else {
                        reportDisplayTitle = "循证医学报告";
                        reportStructure = fullOutput;
                    }
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
//        emit(sink, stopped, "\n🔬 开始证据检索阶段\n", "thinking", thinkingBuffer);

        Disposable disposable = Mono.fromRunnable(() -> runSearchLoop(state, sink, stopped, thinkingBuffer, onComplete))
                .subscribeOn(Schedulers.boundedElastic())
                .subscribe(
                        null,
                        e -> {
                            if (compositeDisposable.isDisposed() || Thread.currentThread().isInterrupted()
                                    || (e.getMessage() != null && e.getMessage().contains("interrupted"))) {
                                log.info("KBEvidenceReportAgent 搜索被用户停止");
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

                // 并行筛选：逐条判断文献相关性，剔除无用文献
                results = filterIrrelevantItems(results, state.getQuestion(), reportStructure, sink, stopped, thinkingBuffer);
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
                + KBMedicalReportPrompts.SEARCH_PLAN;

        emit(sink, stopped, "📋 正在规划检索任务...\n", "thinking", thinkingBuffer);
//        sink.newMessage("");
        thinkingBuffer.setLength(0);
        if (stopped.get() || compositeDisposable.isDisposed()) return new ArrayList<>();

        ChatResponse resp = chatClient.prompt()
                .messages(List.of(
                        new SystemMessage(systemContent),
                        new UserMessage(buildSearchPlanUserMessage(state))
                ))
                .call()
                .chatResponse();

        if (resp != null && resp.getMetadata() != null) {
            costStats.add(resp.getMetadata().getUsage());
        }

        String json = resp != null ? resp.getResult().getOutput().getText() : "";

        List<EvidencePlanTask> planTasks = converter.convert(json);
        if (planTasks == null) planTasks = new ArrayList<>();

//        emit(sink, stopped, "✅ 检索计划已生成，共 " + planTasks.size() + " 个任务\n", "thinking", thinkingBuffer);
//        sink.newMessage("");
//        thinkingBuffer.setLength(0);

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

//        String existingResults = state.extractToolResults();
//        if (!existingResults.isEmpty()) {
//            int maxLen = Math.min(existingResults.length(), 2000);
//            sb.append("\n\n【已检索到的证据摘要（前2000字）】\n").append(existingResults, 0, maxLen);
//        }

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

    // ===== 执行检索计划（并发，按 order 分批）+ 批量总结 =====

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
            List<EvidenceTaskResult> batchResults = new ArrayList<>();

            // 阶段1：并发执行工具调用（不总结）
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

                        // 使用新方法：只执行工具，不总结
                        EvidenceTaskResult result = executeToolsOnly(task, dependencyContext, state.getSessionId(), sink, stopped, thinkingBuffer);
                        results.put(task.id(), result);
                        synchronized (batchResults) {
                            batchResults.add(result);
                        }

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

            // 阶段2：批量总结本批次所有任务的结果（流式）
             if (!batchResults.isEmpty() && !stopped.get()) {
//                emit(sink, stopped, "✓ ", "thinking", thinkingBuffer);
                String batchSummary = batchSummarizeStreaming(tasks, batchResults, sink, stopped);
                if (batchSummary != null && !batchSummary.isBlank()) {
                    emit(sink, stopped, "\n\n", "thinking", thinkingBuffer);
                    sink.newMessage("");
                    thinkingBuffer.setLength(0);

                    // 保存批量总结到 accumulatedResults 和 state
                    for (int i = 0; i < tasks.size(); i++) {
                        EvidencePlanTask task = tasks.get(i);
                        EvidenceTaskResult result = batchResults.get(i);
                        if (result.success()) {
                            accumulatedResults.put(task.id(), batchSummary);
                        }
                    }

                    state.add(new AssistantMessage("""
                            【Batch Summary for Order %d】
                            %s
                            【End Batch Summary】
                            """.formatted(order, batchSummary)));
                }
            }

            // 原有逻辑（已注释，保留以便回退）
            /*
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

                        EvidenceTaskResult result = executeWithRetry(task, dependencyContext, state.getSessionId(), sink, stopped, thinkingBuffer);
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
            */
        }

        return results;
    }

    // ===== 单任务执行（内联 ReAct 循环）=====

    private EvidenceTaskResult executeWithRetry(EvidencePlanTask task, String dependencyContext,
                                                  String sessionId,
                                                  AgentSink sink, AtomicBoolean stopped,
                                                  StringBuilder thinkingBuffer) {
        if (stopped.get() || compositeDisposable.isDisposed()) {
            return new EvidenceTaskResult(task.id(), false, null, "任务被停止");
        }

        String fullContext = """
                <sessionid>%s</sessionid>

                【已有检索结果】
                %s

                【当前任务】
                %s
                """.formatted(sessionId != null ? sessionId : "", dependencyContext, task.instruction());

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
                if (response != null && response.getMetadata() != null) {
                    costStats.add(response.getMetadata().getUsage());
                }
                if (response == null || response.getResult() == null) break;

                AssistantMessage assistantMsg = response.getResult().getOutput();
                List<AssistantMessage.ToolCall> toolCalls = assistantMsg.getToolCalls();
                String text = assistantMsg.getText();

                if (toolCalls == null || toolCalls.isEmpty()) {
                    if (text != null && !text.isBlank()) {
                        emit(sink, stopped, "结果摘要: " + (text.length() > 100 ? text.substring(0, 100) + "..." : text) + "\n\n", "thinking", thinkingBuffer);
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

    // ===== 新增：只执行工具调用，不总结（用于批量总结） =====

    private EvidenceTaskResult executeToolsOnly(EvidencePlanTask task, String dependencyContext,
                                                 String sessionId, AgentSink sink,
                                                 AtomicBoolean stopped, StringBuilder thinkingBuffer) {
        if (stopped.get() || compositeDisposable.isDisposed()) {
            return new EvidenceTaskResult(task.id(), false, null, "任务被停止");
        }

        String fullContext = """
                <sessionid>%s</sessionid>

                【已有检索结果】
                %s

                【当前任务】
                %s
                """.formatted(sessionId != null ? sessionId : "", dependencyContext, task.instruction());

        ToolCallingChatOptions toolOptions = ToolCallingChatOptions.builder()
                .toolCallbacks(tools)
                .internalToolExecutionEnabled(false)
                .build();

        List<Message> messages = new ArrayList<>();
        messages.add(new SystemMessage(GeneralResearchPrompts.EXECUTE));
        messages.add(new UserMessage(fullContext));

        StringBuilder toolResultsBuffer = new StringBuilder();

        int maxReactRounds = maxToolRetries + 1;
        for (int round = 0; round < maxReactRounds; round++) {
            if (stopped.get() || compositeDisposable.isDisposed()) {
                return new EvidenceTaskResult(task.id(), false, null, "任务被停止");
            }
            try {
                Prompt prompt = new Prompt(messages, toolOptions);
                ChatResponse response = chatModel.call(prompt);
                if (response != null && response.getMetadata() != null) {
                    costStats.add(response.getMetadata().getUsage());
                }
                if (response == null || response.getResult() == null) break;

                AssistantMessage assistantMsg = response.getResult().getOutput();
                List<AssistantMessage.ToolCall> toolCalls = assistantMsg.getToolCalls();

                if (toolCalls == null || toolCalls.isEmpty()) {
                    break;
                }

                messages.add(assistantMsg);
                String toolResults = executeToolCallsAndCollect(task, toolCalls, messages, sink, stopped, thinkingBuffer);
                toolResultsBuffer.append(toolResults);

            } catch (Exception e) {
                if (compositeDisposable.isDisposed() || Thread.currentThread().isInterrupted()) {
                    return new EvidenceTaskResult(task.id(), false, null, "任务被停止");
                }
                log.warn("任务 {} 工具执行异常: {}", task.id(), e.getMessage());
                if (round == maxReactRounds - 1) {
                    return new EvidenceTaskResult(task.id(), false, null, "执行异常: " + e.getMessage());
                }
            }
        }

        return new EvidenceTaskResult(task.id(), true, toolResultsBuffer.toString(), null);
    }

    private String executeToolCallsAndCollect(EvidencePlanTask task,
                                               List<AssistantMessage.ToolCall> toolCalls,
                                               List<Message> messages, AgentSink sink,
                                               AtomicBoolean stopped, StringBuilder thinkingBuffer) {
        StringBuilder results = new StringBuilder();
        for (AssistantMessage.ToolCall tc : toolCalls) {
            if (stopped.get() || compositeDisposable.isDisposed()) break;

            String callId = tc.id();
            String toolName = tc.name();
            String argsJson = tc.arguments();

            // 从工具参数中提取具体标识（如药物名/搜索意图），避免同一 task 多次调用时前端显示完全相同
            String displayLabel = extractToolCallLabel(argsJson);
            String displayText = displayLabel != null
                    ? "检索数据: " + displayLabel
                    : "检索数据: " + task.title();
            sink.toolCallStart(displayText, callId, argsJson);

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

                // 先注册文献，再替换 JSON 中的 ID 为引用编号，避免 LLM 直接使用原始 ID
                int found = parseAndCollectReferences(resultStr);
                String rewrittenResult = replaceIdsWithCitationNumbers(resultStr);

                messages.add(ToolResponseMessage.builder()
                        .responses(List.of(new ToolResponseMessage.ToolResponse(callId, toolName, rewrittenResult)))
                        .build());

                recordUsedTool(toolName);
                sink.toolCallEnd("检索完成，找到 " + found + " 条结果", callId);

                results.append("\n【工具: ").append(toolName).append("】\n").append(resultStr).append("\n");

            } catch (Exception e) {
                log.warn("工具 {} 执行失败: {}", toolName, e.getMessage());
                messages.add(ToolResponseMessage.builder()
                        .responses(List.of(new ToolResponseMessage.ToolResponse(
                                callId, toolName, "{\"error\":\"" + e.getMessage() + "\"}")))
                        .build());
                sink.toolCallEnd("执行失败: " + e.getMessage(), callId);
            }
        }
        return results.toString();
    }

    // ===== 批量总结多个任务的工具结果（流式） =====

    private String batchSummarizeStreaming(List<EvidencePlanTask> tasks, List<EvidenceTaskResult> results,
                                            AgentSink sink, AtomicBoolean stopped) {
        if (results.isEmpty()) return "";

        StringBuilder taskDesc = new StringBuilder();
        StringBuilder allResults = new StringBuilder();

        for (int i = 0; i < tasks.size(); i++) {
            EvidencePlanTask task = tasks.get(i);
            EvidenceTaskResult result = results.get(i);
            taskDesc.append(i + 1).append(". ").append(task.title()).append("\n");
            if (result.success() && result.output() != null) {
                allResults.append("\n【任务").append(i + 1).append("：").append(task.title()).append("】\n");
                allResults.append(result.output()).append("\n");
            }
        }

        String prompt = """
                你刚完成了以下 %d 个检索任务：
                %s

                工具返回的原始结果：
                %s

                【总结要求】
                1. 用一个连贯的段落总结所有检索结果（最多不超过2段）
                2. 直接呈现核心数据和结论，不要说"检索到X篇"等元信息
                3. 不要按数据源类型分段（不要写"RCT显示..."、"指南推荐..."等小标题）
                4. 融合所有来源的信息，形成统一的叙述
                5. 控制在150-300字以内

                输出格式：直接输出内容，不要前言、小标题或总结性语句。
                """.formatted(tasks.size(), taskDesc.toString(), allResults.toString());

        StringBuilder summaryBuffer = new StringBuilder();
        CountDownLatch latch = new CountDownLatch(1);

        try {
            chatClient.prompt()
                    .user(prompt)
                    .stream()
                    .chatResponse()
                    .publishOn(Schedulers.boundedElastic())
                    .doOnNext(chunk -> {
                        if (stopped.get()) return;
                        if (chunk != null) {
                            if (chunk.getMetadata() != null) {
                                costStats.add(chunk.getMetadata().getUsage());
                            }
                            if (chunk.getResult() != null) {
                                String text = chunk.getResult().getOutput().getText();
                                if (text != null && !text.isEmpty()) {
                                    summaryBuffer.append(text);
                                    sink.streamAppend(summaryBuffer.toString().trim());
                                }
                            }
                        }
                    })
                    .doOnComplete(() -> {
                        sink.newMessage("");
                        latch.countDown();
                    })
                    .doOnError(err -> {
                        log.warn("批量总结流式输出失败: {}", err.getMessage());
                        latch.countDown();
                    })
                    .subscribe();

            latch.await(120, TimeUnit.SECONDS);
            return summaryBuffer.toString().trim();
        } catch (Exception e) {
            log.warn("批量总结失败: {}", e.getMessage());
            return allResults.toString();
        }
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

                // 先注册文献，再替换 JSON 中的 ID 为引用编号，避免 LLM 直接使用原始 ID
                int found = parseAndCollectReferences(resultStr);
                String rewrittenResult = replaceIdsWithCitationNumbers(resultStr);

                messages.add(ToolResponseMessage.builder()
                        .responses(List.of(new ToolResponseMessage.ToolResponse(callId, toolName, rewrittenResult)))
                        .build());

                recordUsedTool(toolName);
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

    // ===== 并行文献相关性筛选 =====

    /**
     * 逐条并行判断文献与研究主题的相关性，剔除无关文献。
     * <p>
     * 从 results 的 output JSON 中提取每条 item，并行调用 LLM 判断相关性，
     * 然后从 results 和 CitationRegistry 中移除无关文献。
     */
    private Map<String, EvidenceTaskResult> filterIrrelevantItems(
            Map<String, EvidenceTaskResult> results, String question, String structure,
            AgentSink sink, AtomicBoolean stopped, StringBuilder thinkingBuffer) {

        // 1. 从所有 results 的 output JSON 中提取 item 列表
        List<ItemRef> allItems = extractAllItems(results);
        if (allItems.isEmpty()) return results;

        emit(sink, stopped, String.format("\n🔬 正在逐条评估证据的相关性...\n", allItems.size()),
                "thinking", thinkingBuffer);
//        sink.newMessage("");
        thinkingBuffer.setLength(0);

        // 2. 并行调用 LLM 判断每条文献的相关性
        Set<String> irrelevantIds = new ConcurrentHashMap<String, Boolean>().keySet(Boolean.TRUE);
        CountDownLatch latch = new CountDownLatch(allItems.size());

        String structureContext = structure != null ? structure : "";

        for (ItemRef ref : allItems) {
            Mono.fromRunnable(() -> {
                try {
                    if (stopped.get()) { latch.countDown(); return; }
                    boolean relevant = judgeRelevance(ref, question, structureContext);
                    if (!relevant) {
                        irrelevantIds.add(ref.id);
                    }
                } catch (Exception e) {
                    log.warn("文献相关性判断异常，默认保留: id={}, err={}", ref.id, e.getMessage());
                } finally {
                    latch.countDown();
                }
            }).subscribeOn(Schedulers.boundedElastic()).subscribe();
        }

        try {
            latch.await(120, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.warn("文献筛选被中断");
            return results;
        }

        if (irrelevantIds.isEmpty()) {
            emit(sink, stopped, "✅ 所有文献均与研究主题相关\n", "thinking", thinkingBuffer);
            sink.newMessage("");
            thinkingBuffer.setLength(0);
            return results;
        }

        // 3. 从 CitationRegistry 中移除无关文献
        int removed = citationRegistry.removeByIds(irrelevantIds);

        // 4. 从 results 的 output JSON 中移除无关 item
        Map<String, EvidenceTaskResult> filtered = removeItemsFromResults(results, irrelevantIds);

//        emit(sink, stopped, String.format("🗑️ 剔除 %d 篇无关文献，保留 %d 篇\n",
//                removed, allItems.size() - irrelevantIds.size()), "thinking", thinkingBuffer);
//        sink.newMessage("");
//        thinkingBuffer.setLength(0);

        return filtered;
    }

    /** 从 results 的 output JSON 中提取所有文献 item 的关键信息 */
    private List<ItemRef> extractAllItems(Map<String, EvidenceTaskResult> results) {
        List<ItemRef> items = new ArrayList<>();
        for (Map.Entry<String, EvidenceTaskResult> entry : results.entrySet()) {
            EvidenceTaskResult r = entry.getValue();
            if (r == null || !r.success() || r.output() == null) continue;
            try {
                // output 可能包含多段 【工具: xxx】\n{json}\n
                String output = r.output();
                int searchFrom = 0;
                while (searchFrom < output.length()) {
                    int jsonStart = output.indexOf("{\"query\"", searchFrom);
                    if (jsonStart < 0) jsonStart = output.indexOf("{\"items\"", searchFrom);
                    if (jsonStart < 0) break;

                    // 找到匹配的 } 结束
                    int depth = 0;
                    int jsonEnd = jsonStart;
                    for (int i = jsonStart; i < output.length(); i++) {
                        if (output.charAt(i) == '{') depth++;
                        else if (output.charAt(i) == '}') depth--;
                        if (depth == 0) { jsonEnd = i + 1; break; }
                    }
                    if (jsonEnd <= jsonStart) break;

                    String jsonStr = output.substring(jsonStart, jsonEnd);
                    JsonNode root = MAPPER.readTree(jsonStr);
                    JsonNode itemsNode = root.get("items");
                    if (itemsNode != null && itemsNode.isArray()) {
                        for (JsonNode item : itemsNode) {
                            String id = safeText(item, "id");
                            if (id == null || id.isBlank()) continue;
                            String title = safeText(item, "title");
                            String source = safeText(item, "source");
                            String year = safeText(item, "year");
                            String type = safeText(item, "type");
                            String summary = safeText(item, "summary");
                            items.add(new ItemRef(id, title, source, year, type, summary, entry.getKey()));
                        }
                    }
                    searchFrom = jsonEnd;
                }
            } catch (Exception e) {
                log.debug("提取文献 item 失败: taskId={}, err={}", entry.getKey(), e.getMessage());
            }
        }
        return items;
    }

    /** 单条文献相关性判断 */
    private boolean judgeRelevance(ItemRef ref, String question, String structure) {
        String prompt = """
                研究主题：%s

                报告章节结构：
                %s

                请判断以下文献是否与上述研究主题相关（能为报告任一章节提供有用信息）。

                文献信息：
                - 标题：%s
                - 来源：%s
                - 年份：%s
                - 类型：%s
                - 摘要：%s

                只回答 true 或 false（true=相关，false=不相关）。
                如果不确定，回答 true（宁可保留）。
                """.formatted(
                question,
                structure,
                ref.title != null ? ref.title : "未知",
                ref.source != null ? ref.source : "未知",
                ref.year != null ? ref.year : "未知",
                ref.type != null ? ref.type : "未知",
                ref.summary != null ? ref.summary : "无摘要"
        );

        try {
            ChatResponse resp = chatClient.prompt().user(prompt).call().chatResponse();
            if (resp != null && resp.getMetadata() != null) {
                costStats.add(resp.getMetadata().getUsage());
            }
            String answer = resp != null && resp.getResult() != null
                    ? resp.getResult().getOutput().getText() : null;
            if (answer != null) {
                String trimmed = answer.trim().toLowerCase();
                return !trimmed.startsWith("false");
            }
        } catch (Exception e) {
            log.warn("相关性判断调用失败，默认保留: {}", e.getMessage());
        }
        return true; // 异常时默认保留
    }

    /** 从 results 的 output JSON 中移除指定 ID 的 item */
    private Map<String, EvidenceTaskResult> removeItemsFromResults(
            Map<String, EvidenceTaskResult> results, Set<String> idsToRemove) {
        Map<String, EvidenceTaskResult> filtered = new ConcurrentHashMap<>();
        for (Map.Entry<String, EvidenceTaskResult> entry : results.entrySet()) {
            EvidenceTaskResult r = entry.getValue();
            if (r == null || !r.success() || r.output() == null) {
                filtered.put(entry.getKey(), r);
                continue;
            }
            try {
                String output = r.output();
                StringBuilder newOutput = new StringBuilder();
                int searchFrom = 0;
                while (searchFrom < output.length()) {
                    int jsonStart = output.indexOf("{\"query\"", searchFrom);
                    if (jsonStart < 0) jsonStart = output.indexOf("{\"items\"", searchFrom);
                    if (jsonStart < 0) {
                        newOutput.append(output.substring(searchFrom));
                        break;
                    }
                    // 保留 JSON 之前的文本（如 【工具: xxx】）
                    newOutput.append(output, searchFrom, jsonStart);

                    int depth = 0;
                    int jsonEnd = jsonStart;
                    for (int i = jsonStart; i < output.length(); i++) {
                        if (output.charAt(i) == '{') depth++;
                        else if (output.charAt(i) == '}') depth--;
                        if (depth == 0) { jsonEnd = i + 1; break; }
                    }
                    if (jsonEnd <= jsonStart) {
                        newOutput.append(output.substring(jsonStart));
                        break;
                    }

                    String jsonStr = output.substring(jsonStart, jsonEnd);
                    ObjectNode root = (ObjectNode) MAPPER.readTree(jsonStr);
                    JsonNode itemsNode = root.get("items");
                    if (itemsNode != null && itemsNode.isArray()) {
                        ArrayNode newItems = MAPPER.createArrayNode();
                        for (JsonNode item : itemsNode) {
                            String id = safeText(item, "id");
                            if (id != null && !idsToRemove.contains(id)) {
                                newItems.add(item);
                            }
                        }
                        root.set("items", newItems);
                    }
                    newOutput.append(MAPPER.writeValueAsString(root));
                    searchFrom = jsonEnd;
                }
                filtered.put(entry.getKey(), new EvidenceTaskResult(
                        r.taskId(), true, newOutput.toString(), null));
            } catch (Exception e) {
                log.debug("过滤 results JSON 失败，保留原始: taskId={}", entry.getKey());
                filtered.put(entry.getKey(), r);
            }
        }
        return filtered;
    }

    /** 文献引用信息（用于相关性判断） */
    private record ItemRef(String id, String title, String source, String year,
                           String type, String summary, String taskId) {}

    // ===== 证据充分性评审 =====

    private EvidenceCritiqueResult critiqueSearch(EvidenceOverAllState state,
                                                    List<EvidencePlanTask> currentPlan,
                                                    Map<String, EvidenceTaskResult> currentResults,
                                                    AgentSink sink, AtomicBoolean stopped,
                                                    StringBuilder thinkingBuffer) {
        BeanOutputConverter<EvidenceCritiqueResult> converter =
                new BeanOutputConverter<>(new ParameterizedTypeReference<>() {});

        emit(sink, stopped, "\n🔍 评估证据充分性...\n", "thinking", thinkingBuffer);
//        sink.newMessage("");
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
                + KBMedicalReportPrompts.SEARCH_CRITIQUE + "\n" + converter.getFormat();

        // 流式输出 critique 反馈（只输出 feedback 字段的值）
        StringBuilder rawBuilder = new StringBuilder();
        StringBuilder displayBuilder = new StringBuilder();
        int[] lastExtractedLength = {0};

        chatClient.prompt()
                .messages(List.of(
                        new SystemMessage(systemContent),
                        new UserMessage(userMessage.toString())
                ))
                .stream()
                .content()
                .doOnNext(chunk -> {
                    rawBuilder.append(chunk);
                    String current = rawBuilder.toString();

                    // 尝试提取 feedback 字段的值
                    String extracted = extractFeedbackValue(current);
                    if (extracted != null && extracted.length() > lastExtractedLength[0]) {
                        String newContent = extracted.substring(lastExtractedLength[0]);
                        displayBuilder.append(newContent);
                        sink.streamAppend(displayBuilder.toString().trim());
                        lastExtractedLength[0] = extracted.length();
                    }
                })
                .blockLast();

        // 估算 token 消耗
        costStats.addEstimated(systemContent + userMessage.toString(), rawBuilder.toString());

        sink.newMessage("");
        thinkingBuffer.setLength(0);

        EvidenceCritiqueResult result = converter.convert(rawBuilder.toString());
        if (result == null) result = new EvidenceCritiqueResult(true, "评审解析失败，默认通过");

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
        if (prompt != null) {
            ChatResponse resp = chatModel.call(prompt);
            if (resp != null && resp.getMetadata() != null) {
                costStats.add(resp.getMetadata().getUsage());
            }
            snapshot = resp.getResult().getOutput().getText();
        }
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

        String toolResults = replaceAllIdsInToolResults(state.extractToolResults());
        String currentStructure = reportStructure != null ? reportStructure : "";

        String citationGuide = buildCitationGuide();

        String systemContent = """
                ## 报告目录结构
                %s

                %s
                """.formatted(currentStructure, citationGuide)
                + KBMedicalReportPrompts.ORGANIZE;

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
                    // 估算 token 消耗
                    costStats.addEstimated(systemContent + userContent, organizeBuffer.toString());

                    organizedContent = organizeBuffer.toString();
//                    emit(sink, stopped, "\n✅ 证据整理完成\n\n", "thinking", thinkingBuffer);
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
        thinkingBuffer.setLength(0);

        MedicalReportTemplate template = state.getReportTemplate();
        List<TemplateChapter> deferredChapters = getDeferredChapters(template);

        if (deferredChapters.isEmpty()) {
            // 无延迟章节，单次调用写全部
            writeAllChapters(state, null, sink, stopped, finalAnswerBuffer, thinkingBuffer, onComplete);
        } else {
            // 两阶段：先写主体，再补写延迟章节
            List<String> deferredTitles = deferredChapters.stream()
                    .map(TemplateChapter::title).collect(Collectors.toList());
//            emit(sink, stopped, "\n📝 第一阶段：撰写主体章节...\n", "thinking", thinkingBuffer);
            StringBuilder mainBodyBuffer = new StringBuilder();
            writeAllChapters(state, deferredTitles, sink, stopped, mainBodyBuffer, thinkingBuffer, () -> {
//                emit(sink, stopped, "\n📝 第二阶段：基于全文补写摘要与背景章节...\n", "thinking", thinkingBuffer);
                StringBuilder deferredBuffer = new StringBuilder();
                writeDeferredChapters(state, deferredChapters, mainBodyBuffer.toString(),
                        sink, stopped, deferredBuffer, thinkingBuffer, () -> {
                            // 组装：标题 → 延迟章节（摘要/背景）→ 主体
                            String title = reportDisplayTitle != null ? reportDisplayTitle : "循证医学报告";
                            finalAnswerBuffer.append("# ").append(title).append("\n\n");
                            finalAnswerBuffer.append(deferredBuffer);
                            if (!deferredBuffer.isEmpty()) finalAnswerBuffer.append("\n\n");
                            // 移除主体中 LLM 可能输出的标题行（# 开头的第一行）
                            String mainBody = mainBodyBuffer.toString().stripLeading();
                            if (mainBody.startsWith("# ")) {
                                int firstNewline = mainBody.indexOf('\n');
                                if (firstNewline > 0) {
                                    mainBody = mainBody.substring(firstNewline + 1).stripLeading();
                                }
                            }
                            finalAnswerBuffer.append(mainBody);
                            emit(sink, stopped, "\n\n✅ 报告撰写完成\n", "thinking", thinkingBuffer);
                            onComplete.run();
                        });
            });
        }
    }

    /** 获取模板中所有 deferWrite=true 的章节，按 order 升序排列 */
    private List<TemplateChapter> getDeferredChapters(MedicalReportTemplate template) {
        if (template == null) return Collections.emptyList();
        return template.chapters().stream()
                .filter(TemplateChapter::deferWrite)
                .sorted(Comparator.comparingInt(TemplateChapter::order))
                .collect(Collectors.toList());
    }

    /**
     * 调用 LLM 撰写章节。
     * @param skipTitles 需要跳过的章节标题列表（null 表示不跳过任何章节）
     */
    private void writeAllChapters(EvidenceOverAllState state, List<String> skipTitles,
                                   AgentSink sink, AtomicBoolean stopped,
                                   StringBuilder buffer, StringBuilder thinkingBuffer,
                                   Runnable onComplete) {
        String currentStructure = reportStructure != null ? reportStructure : "";
        String citationGuide = buildCitationGuide();

        // 优先使用 ORGANIZE 阶段整理好的证据要点；仅当为空时回退到原始 JSON
        String evidence;
        if (organizedContent != null && !organizedContent.isBlank()) {
            evidence = organizedContent;
            log.info("WRITE 阶段使用 ORGANIZE 整理后的证据（{}字符）", evidence.length());
        } else {
            evidence = replaceAllIdsInToolResults(state.extractToolResults());
            log.warn("ORGANIZE 输出为空，WRITE 阶段回退使用原始证据 JSON（{}字符）", evidence.length());
        }

        // 构建章节撰写规格（含 layout 字段）
        String chaptersLayoutSpec = buildChaptersLayoutSpec(state.getReportTemplate(), skipTitles);

        // 从目录结构中移除需要跳过的章节
        String structureWithSkip = currentStructure;
        if (skipTitles != null && !skipTitles.isEmpty()) {
            structureWithSkip = removeSkippedChaptersFromStructure(currentStructure, skipTitles, state.getReportTemplate());
            structureWithSkip += "\n\n⚠️ 以下章节请跳过不写（将在报告完成后基于全文内容单独补写）：" +
                    String.join("、", skipTitles);
        }

        String systemContent = """
                ## 报告标题
                %s

                ## 报告目录结构（必须严格遵守）
                %s

                %s

                %s
                """.formatted(
                reportDisplayTitle != null ? reportDisplayTitle : "循证医学报告",
                structureWithSkip,
                chaptersLayoutSpec,
                citationGuide)
                + KBMedicalReportPrompts.WRITE;

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
                        buffer.append(text);
                    }
                })
                .doOnComplete(onComplete::run)
                .doOnError(e -> handlePhaseError("报告撰写异常", e, sink, stopped))
                .subscribe();

        compositeDisposable.add(disposable);
    }

    /**
     * 构建章节撰写规格（含 description + layout），排除跳过的章节
     */
    private String buildChaptersLayoutSpec(MedicalReportTemplate template, List<String> skipTitles) {
        if (template == null || template.chapters().isEmpty()) {
            return "";
        }

        StringBuilder spec = new StringBuilder("## 章节撰写规格\n");
        for (TemplateChapter ch : template.chapters()) {
            // 跳过延迟撰写的章节
            if (skipTitles != null && skipTitles.contains(ch.title())) {
                continue;
            }

            spec.append("\n### ").append(ch.order()).append(". ").append(ch.title()).append("\n");
            if (ch.description() != null && !ch.description().isBlank()) {
                spec.append(ch.description().strip()).append("\n");
            }
            if (ch.layout() != null && !ch.layout().isBlank()) {
                spec.append(ch.layout().strip()).append("\n");
            }
        }
        return spec.toString();
    }

    /**
     * 从目录结构中移除需要跳过的章节标题
     */
    private String removeSkippedChaptersFromStructure(String structure, List<String> skipTitles, MedicalReportTemplate template) {
        if (structure == null || structure.isBlank() || skipTitles == null || skipTitles.isEmpty()) {
            return structure;
        }

        String[] lines = structure.split("\n");
        StringBuilder result = new StringBuilder();
        for (String line : lines) {
            boolean shouldSkip = false;
            for (String skipTitle : skipTitles) {
                if (line.contains(skipTitle)) {
                    shouldSkip = true;
                    break;
                }
            }
            if (!shouldSkip) {
                // 用模板 order 值纠正行首编号
                if (template != null) {
                    String corrected = correctLineNumbering(line, template);
                    result.append(corrected).append("\n");
                } else {
                    result.append(line).append("\n");
                }
            }
        }
        return result.toString().trim();
    }

    /**
     * 用模板中的 order 值纠正行首的章节编号。
     * 例如将 "3. 疾病概述 — ..." 纠正为 "2. 疾病概述 — ..."（如果模板中该章节 order=2）。
     */
    private String correctLineNumbering(String line, MedicalReportTemplate template) {
        for (TemplateChapter ch : template.chapters()) {
            if (ch.order() == 0) continue; // 前置章节无编号
            String title = ch.title();
            if (line.contains(title)) {
                // 匹配行首编号模式：可能是 "3. 疾病概述" 或 "3.疾病概述"
                String corrected = line.replaceFirst("^\\d+\\.\\s*" + java.util.regex.Pattern.quote(title),
                        ch.order() + ". " + title);
                return corrected;
            }
        }
        return line;
    }

    /**
     * 清理证据内容中的内部标记
     */
    private String cleanInternalMarkers(String content) {
        if (content == null || content.isBlank()) {
            return content;
        }
        return content
                .replaceAll("\\[EVIDENCE_BEGIN\\]", "")
                .replaceAll("\\[EVIDENCE_END\\]", "")
                .replaceAll("\\[CONTENT_SUMMARY_BEGIN\\]", "")
                .replaceAll("\\[CONTENT_SUMMARY_END\\]", "")
                .trim();
    }

    /**
     * 基于已完成的主体报告，调用 LLM 补写延迟章节（摘要/研究背景等）。
     */
    private void writeDeferredChapters(EvidenceOverAllState state,
                                        List<TemplateChapter> deferredChapters,
                                        String mainBody,
                                        AgentSink sink, AtomicBoolean stopped,
                                        StringBuilder buffer, StringBuilder thinkingBuffer,
                                        Runnable onComplete) {
        // 构建延迟章节的撰写规格（含 description + layout）
        StringBuilder chaptersSpec = new StringBuilder();
        for (TemplateChapter ch : deferredChapters) {
            chaptersSpec.append("## ").append(ch.order()).append(". ").append(ch.title()).append("\n");
            if (ch.description() != null && !ch.description().isBlank()) {
                chaptersSpec.append(ch.description().strip()).append("\n");
            }
            if (ch.layout() != null && !ch.layout().isBlank()) {
                chaptersSpec.append(ch.layout().strip()).append("\n");
            }
            chaptersSpec.append("\n");
        }

        String systemContent = """
                ## 已完成的报告主体内容
                %s

                ## 需要补写的章节
                %s
                """.formatted(mainBody, chaptersSpec)
                + KBMedicalReportPrompts.WRITE_DEFERRED;

        String userContent = "【用户研究需求】\n" + state.getQuestion();

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
                    if (chunk != null) {
                        if (chunk.getMetadata() != null) {
                            costStats.add(chunk.getMetadata().getUsage());
                        }
                        if (chunk.getResult() != null && chunk.getResult().getOutput() != null) {
                            String text = chunk.getResult().getOutput().getText();
                            if (text != null && !text.isEmpty()) {
                                buffer.append(text);
                            }
                        }
                    }
                })
                .doOnComplete(onComplete::run)
                .doOnError(e -> handlePhaseError("延迟章节补写异常", e, sink, stopped))
                .subscribe();

        compositeDisposable.add(disposable);
    }

    // ===== 阶段六：交付报告（OSS 上传）=====

    private void deliverPhase(EvidenceOverAllState state, AgentSink sink,
                               AtomicBoolean stopped, StringBuilder finalAnswerBuffer) {
        updatePhaseStatus(PHASE_DELIVER, sink);

        // 应用引用重新编号和格式化参考文献
        if (citationRegistry != null && !citationRegistry.isEmpty()) {
            String[] resequenced = CitationFormatter.resequenceAndFormat(
                    finalAnswerBuffer.toString(), citationRegistry);
            finalAnswerBuffer.setLength(0);
            finalAnswerBuffer.append(resequenced[0]);  // 重新编号后的正文
            if (!resequenced[1].isBlank()) {
                finalAnswerBuffer.append(resequenced[1]);  // 参考文献区块
            }
            log.info("引用重新编号完成，共 {} 条被引用文献", citationRegistry.size());
        }

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
                String reportTitle = reportDisplayTitle != null && !reportDisplayTitle.isBlank()
                        ? reportDisplayTitle
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

        // 输出成本统计
        costStats.calculate();
        log.info("📊 LLM 成本统计: {}", costStats.format());
//        sink.rawMessage("\n\n---\n💰 " + costStats.format());

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

    /**
     * 从工具调用参数 JSON 中提取可读标签，用于前端展示区分同一 task 内的多次调用。
     * 优先取 searchIntent，其次 drugName，最后 keywords / query。
     */
    private String extractToolCallLabel(String argsJson) {
        if (argsJson == null || argsJson.isBlank()) return null;
        try {
            JsonNode node = MAPPER.readTree(argsJson);
            // searchIntent 是所有工具方法的第一个参数，通常是中文描述
            String intent = textOf(node, "searchIntent");
            if (intent != null) return intent;
            // fetchDrugInstruction / searchFaers 用 drugName
            String drug = textOf(node, "drugName");
            if (drug != null) return drug;
            // searchInstructions 用 keywords
            String kw = textOf(node, "keywords");
            if (kw != null) return kw;
            // 兜底：query
            return textOf(node, "query");
        } catch (Exception e) {
            return null;
        }
    }

    private static String textOf(JsonNode node, String field) {
        JsonNode f = node.get(field);
        if (f != null && f.isTextual() && !f.asText().isBlank()) {
            return f.asText().trim();
        }
        return null;
    }

    private int parseAndCollectReferences(String resultJson) {
        if (resultJson == null || resultJson.isBlank()) return 0;
        try {
            JsonNode root = MAPPER.readTree(resultJson);
            // EvidenceResponse format: { "items": [...] }
            JsonNode items = root.get("items");
            if (items != null && items.isArray()) {
                int count = 0;
                for (JsonNode item : items) {
                    EvidenceRetrievalTool.EvidenceItem evidenceItem = parseEvidenceItem(item);
                    if (evidenceItem != null && evidenceItem.getId() != null) {
                        int num = citationRegistry.register(evidenceItem);
                        if (num > 0) count++;

                        // 保留旧的 allReferences 用于兼容
                        String url = evidenceItem.getUrl() != null ? evidenceItem.getUrl() : "";
                        String title = evidenceItem.getTitle() != null ? evidenceItem.getTitle() : "";
                        String snippet = evidenceItem.getSnippet() != null ? evidenceItem.getSnippet() : "";
                        synchronized (allReferences) {
                            allReferences.add(new SearchResult(url, title, snippet));
                        }
                    }
                }
                return count;
            }
            // Fallback: Tavily array format [{ "text": { "results": [...] } }]
            if (root.isArray() && !root.isEmpty()) {
                JsonNode textNode = root.get(0).get("text");
                if (textNode != null) {
                    JsonNode textJson = textNode.isTextual()
                            ? MAPPER.readTree(textNode.asText()) : textNode;
                    JsonNode results = textJson.get("results");
                    if (results != null && results.isArray()) {
                        int count = 0;
                        for (JsonNode item : results) {
                            String url     = safeText(item, "url");
                            String title   = safeText(item, "title");
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

    /**
     * 将工具返回的 EvidenceResponse JSON 中每个 item 的原始 id 替换为引用编号。
     * 例如：{"id":"4_491_67235d247c3b2fe5e9bd4fbb"} → {"id":"[3]"}
     * 这样 LLM 在生成报告时只能看到 [N] 编号，不会直接使用原始 ID 作为引用标记。
     */
    private String replaceIdsWithCitationNumbers(String resultJson) {
        if (resultJson == null || resultJson.isBlank()) return resultJson;
        try {
            ObjectNode root =
                    (ObjectNode) MAPPER.readTree(resultJson);
            JsonNode itemsNode = root.get("items");
            if (itemsNode == null || !itemsNode.isArray()) return resultJson;

            ArrayNode newItems =
                    MAPPER.createArrayNode();
            for (JsonNode item : itemsNode) {
                String rawId = item.has("id") ? item.get("id").asText() : null;
                ObjectNode newItem =
                        item.deepCopy();
                if (rawId != null && !rawId.isBlank()) {
                    Integer citNum = citationRegistry.getNum(rawId);
                    if (citNum != null) {
                        newItem.put("id", "[" + citNum + "]");
                    }
                }
                newItems.add(newItem);
            }
            root.set("items", newItems);
            return MAPPER.writeValueAsString(root);
        } catch (Exception e) {
            log.debug("替换引用编号失败，使用原始 JSON: {}", e.getMessage());
            return resultJson;
        }
    }

    /**
     * 对 extractToolResults() 返回的文本，将所有 "id":"xxx" 中的原始 ID 替换为 [N] 编号。
     * 直接正则匹配 id 字段，无需解析 JSON 结构。
     */
    private String replaceAllIdsInToolResults(String toolResults) {
        if (toolResults == null || toolResults.isBlank()) return toolResults;
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"id\"\\s*:\\s*\"([^\"]+)\"")
                .matcher(toolResults);
        StringBuilder sb = new StringBuilder();
        while (m.find()) {
            String rawId = m.group(1);
            Integer citNum = citationRegistry.getNum(rawId);
            if (citNum != null) {
                m.appendReplacement(sb, "\"id\":\"[" + citNum + "]\"");
            }
        }
        m.appendTail(sb);
        return sb.toString();
    }


    private String safeText(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return (v == null || v.isNull()) ? null : v.asText();
    }

    private String buildCitationGuide() {
        if (citationRegistry == null || citationRegistry.isEmpty()) {
            return "";
        }

        StringBuilder guide = new StringBuilder("## 文献引用编号与摘要\n");
        guide.append("""
                以下为检索到的文献详情，撰写时使用 [N] 标记引用。
                每条文献标注了来源类型标签：[GUIDE]=临床指南/专家共识、[RCT/文献]=临床研究文献、[说明书]=药品说明书、[FAERS]=药物警戒数据。
                ⚠️ 指南章节仅允许引用标记为 [GUIDE] 的文献，严禁将 RCT/文献 冒充指南引用。

                """);

        for (int i = 1; i <= Math.min(citationRegistry.size(), 50); i++) {
            EvidenceRetrievalTool.EvidenceItem item = citationRegistry.getItem(i);
            if (item != null) {
                String title = item.getTitle() != null ? item.getTitle() : "未知标题";
                String sourceTag = mapSourceTag(item.getSource());
                // 第一行：编号 + 来源标签 + 标题 + 年份 + 研究类型
                guide.append(String.format("[%d] %s %s", i, sourceTag, title));
                if (item.getYear() != null && !item.getYear().isBlank()) {
                    guide.append(" (").append(item.getYear()).append(")");
                }
                if (item.getType() != null && !item.getType().isBlank()) {
                    guide.append(" | ").append(item.getType());
                }
                guide.append("\n");

                // 第二行起：摘要/snippet
                String detail = pickBestDetail(item);
                if (detail != null && !detail.isBlank()) {
                    if (detail.length() > 300) {
                        detail = detail.substring(0, 300) + "...";
                    }
                    guide.append(detail).append("\n");
                }
                guide.append("\n");
            }
        }

        if (citationRegistry.size() > 50) {
            guide.append(String.format("... 共 %d 条文献\n", citationRegistry.size()));
        }

        return guide.toString();
    }

    /** 将 EvidenceItem.source 映射为可读的来源标签 */
    private static String mapSourceTag(String source) {
        if (source == null) return "[RCT/文献]";
        return switch (source) {
            case "GUIDE" -> "[GUIDE]";
            case "INSTRUCTION" -> "[说明书]";
            case "FAERS" -> "[FAERS]";
            default -> "[RCT/文献]";   // BLOCK, ES_BM25 等均为研究文献
        };
    }

    /** 从 EvidenceItem 中选取最适合展示的详情文本 */
    private String pickBestDetail(EvidenceRetrievalTool.EvidenceItem item) {
        // 指南类型优先用 nrjs（指南原文摘录）
        if (item.getNrjs() != null && !item.getNrjs().isBlank()) {
            return item.getNrjs();
        }
        // 通用：优先 snippet（检索片段，通常含关键数据），其次 summary
        if (item.getSnippet() != null && !item.getSnippet().isBlank()) {
            return item.getSnippet();
        }
        if (item.getSummary() != null && !item.getSummary().isBlank()) {
            return item.getSummary();
        }
        return null;
    }

    private EvidenceRetrievalTool.EvidenceItem parseEvidenceItem(JsonNode item) {
        String id = safeText(item, "id");
        if (id == null || id.isBlank()) return null;

        return EvidenceRetrievalTool.EvidenceItem.builder()
                .id(id)
                .source(safeText(item, "source"))
                .title(safeText(item, "title"))
                .year(safeText(item, "year"))
                .type(safeText(item, "type"))
                .snippet(safeText(item, "snippet"))
                .url(safeText(item, "url"))
                .raw(parseRawMap(item.get("raw")))
                .build();
    }

    private Map<String, String> parseRawMap(JsonNode rawNode) {
        if (rawNode == null || rawNode.isNull()) return new LinkedHashMap<>();
        Map<String, String> map = new LinkedHashMap<>();
        rawNode.fields().forEachRemaining(e -> {
            if (e.getValue() != null && !e.getValue().isNull()) {
                map.put(e.getKey(), e.getValue().asText());
            }
        });
        return map;
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

    /**
     * 从 JSON 字符串中提取 feedback 字段的值
     */
    private String extractFeedbackValue(String json) {
        if (json == null || json.isBlank()) return null;

        int feedbackStart = json.indexOf("\"feedback\"");
        if (feedbackStart < 0) return null;

        int colonPos = json.indexOf(":", feedbackStart);
        if (colonPos < 0) return null;

        int quoteStart = json.indexOf("\"", colonPos + 1);
        if (quoteStart < 0) return null;

        // 查找结束引号（处理转义）
        int pos = quoteStart + 1;
        StringBuilder result = new StringBuilder();
        while (pos < json.length()) {
            char c = json.charAt(pos);
            if (c == '\\' && pos + 1 < json.length()) {
                // 转义字符
                pos += 2;
                continue;
            }
            if (c == '"') {
                // 找到结束引号
                return result.toString();
            }
            result.append(c);
            pos++;
        }

        // 未找到结束引号，返回当前累积的内容
        return result.toString();
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

    /**
     * 处理追问（报告生成后的多轮对话）
     */
    private void handleFollowUpQuestion(String sessionId, String question, AgentSink sink, ChatMemory memory) {
        saveQuestion(sessionId, question);

        List<Message> messages = new ArrayList<>();
        messages.add(new SystemMessage("""
                你是一位循证医学专家。用户已经生成了一份医学报告，现在对报告内容进行追问。
                请基于之前生成的报告内容，简洁、专业地回答用户的问题。
                如果问题超出报告范围，请如实说明。
                """));

        loadChatHistory(sessionId, memory, messages);
        messages.add(new UserMessage(question));

        StringBuilder answerBuffer = new StringBuilder();

        try {
            chatClient.prompt()
                    .messages(messages)
                    .stream()
                    .content()
                    .doOnNext(chunk -> {
                        recordFirstResponse();
                        answerBuffer.append(chunk);
                        sink.streamAppend(answerBuffer.toString().trim());
                    })
                    .doOnComplete(() -> {
                        String answer = answerBuffer.toString();
                        // 估算 token 消耗
                        String inputText = messages.stream()
                                .map(m -> m.getText())
                                .reduce("", (a, b) -> a + b);
                        costStats.addEstimated(inputText, answer);

                        memory.add(sessionId, new UserMessage(question));
                        memory.add(sessionId, new AssistantMessage(answer));
                        saveAnswer(answer, null);
                        sink.complete();
                        sink.finish("", "");
                    })
                    .doOnError(err -> {
                        log.error("追问处理失败", err);
                        sink.error("回答失败: " + err.getMessage());
                    })
                    .blockLast();
        } catch (Exception e) {
            log.error("追问处理异常", e);
            sink.error("回答失败: " + e.getMessage());
        } finally {
            removeTask(sessionId);
        }
    }
}
