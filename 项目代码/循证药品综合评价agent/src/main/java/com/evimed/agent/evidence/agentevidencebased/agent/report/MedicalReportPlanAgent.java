package com.evimed.agent.evidence.agentevidencebased.agent.report;

import com.evimed.agent.evidence.agentevidencebased.agent.BaseAgent;
import com.evimed.agent.evidence.agentevidencebased.agent.messaging.AgentSink;
import com.evimed.agent.evidence.agentevidencebased.prompts.MedicalAgentPrompts;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.evimed.agent.evidence.agentevidencebased.service.AgentTaskManager;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.ToolResponseMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.model.tool.ToolCallingChatOptions;
import org.springframework.ai.tool.ToolCallback;
import reactor.core.Disposable;
import reactor.core.scheduler.Schedulers;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 医学循证报告 Plan-Execute Agent
 *
 * 执行流程：
 * 1. 调用 LLM 生成结构化任务计划（JSON）
 * 2. 发送 previewPlan 给前端展示任务列表
 * 3. 逐个执行任务（LLM + 工具调用）
 * 4. 流式输出最终报告正文
 * 5. 发送 finish 信号
 */
@Slf4j
public class MedicalReportPlanAgent extends BaseAgent {

    private static final int EXECUTE_TIMEOUT_MINUTES = 10;

    private final ChatClient planningClient;   // 仅用于规划（不带工具）
    private final ChatClient executionClient;  // 用于执行（带工具）
    private final List<ToolCallback> tools;

    public MedicalReportPlanAgent(ChatModel chatModel, List<ToolCallback> tools) {
        super("medical-report-plan", chatModel, "medical-report");
        this.tools = tools != null ? tools : List.of();

        // 规划客户端：不挂工具，只生成任务 JSON
        this.planningClient = ChatClient.builder(chatModel).build();

        // 执行客户端：带工具，支持文献检索
        ToolCallingChatOptions toolOptions = ToolCallingChatOptions.builder()
                .toolCallbacks(this.tools)
                .internalToolExecutionEnabled(false)
                .build();
        this.executionClient = ChatClient.builder(chatModel)
                .defaultOptions(toolOptions)
                .defaultToolCallbacks(this.tools)
                .build();
    }

    @Override
    public void execute(String sessionId, String question, AgentSink sink) {
        if (isTaskRunning(sessionId)) {
            sink.error("该会话正在执行中，请稍后再试");
            return;
        }

        initTimers();
        clearUsedTools();

        CompletableFuture<Void> future = new CompletableFuture<>();
        AtomicBoolean completed = new AtomicBoolean(false);

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

        // 加载历史记忆
        List<Message> historyMessages = new ArrayList<>();
        loadChatHistory(sessionId, buildChatMemory(sessionId, 30), historyMessages);
        
        currentQuestion = question;
        saveQuestion(sessionId, question);

      

        

        // 在 boundedElastic 上异步执行整个 Plan-Execute 流程
        Disposable disposable = Schedulers.boundedElastic().schedule(() -> {
            try {
                runPlanExecute(sessionId, question, historyMessages, sink, completed, future);
            } catch (Exception e) {
                if (completed.compareAndSet(false, true)) {
                    log.error("报告生成失败: sessionId={}", sessionId, e);
                    sink.error("报告生成失败: " + e.getMessage());
                    future.completeExceptionally(e);
                }
            }
        });

        if (taskManager != null) {
            taskManager.setDisposable(sessionId, disposable);
        }

        try {
            future.get(EXECUTE_TIMEOUT_MINUTES, TimeUnit.MINUTES);
        } catch (Exception e) {
            if (!completed.get()) {
                log.warn("报告生成超时或被中断: sessionId={}", sessionId, e);
                sink.error("报告生成超时，请重试");
            }
        } finally {
            removeTask(sessionId);
        }
    }

    // ===== 主流程 =====

    private void runPlanExecute(String sessionId, String question, List<Message> historyMessages,
                                AgentSink sink, AtomicBoolean completed, CompletableFuture<Void> future) {
        // 1. 生成任务计划（携带历史上下文）
        ReportPlan plan = generatePlan(question, historyMessages);
        if (plan == null || plan.tasks.isEmpty()) {
            sink.error("任务规划失败，请重试");
            completed.set(true);
            future.completeExceptionally(new RuntimeException("规划失败"));
            return;
        }

        // 2. 发送任务大纲
        List<String> todoDetails = plan.tasks.stream()
                .map(t -> t.detail).toList();
        sink.previewPlan(plan.analysis, plan.tasks.stream().map(t -> t.title).toList(), todoDetails);

        // 3. 初始化状态：all todo
        List<String> titles = plan.tasks.stream().map(t -> t.title).toList();
        List<String> statuses = new ArrayList<>(List.of(new String[titles.size()]));
        statuses.replaceAll(s -> "todo");
        sink.status(titles, statuses);

        // 4. 逐个执行任务
        List<String> evidenceChunks = new ArrayList<>();

        for (int i = 0; i < plan.tasks.size(); i++) {
            if (completed.get()) return;

            TaskItem task = plan.tasks.get(i);
            statuses.set(i, "doing");
            sink.status(titles, List.copyOf(statuses));

            String evidence = executeTask(sessionId, question, task, sink, completed);
            if (evidence != null) {
                evidenceChunks.add("【" + task.title + "】\n" + evidence);
            }

            statuses.set(i, "done");
            sink.status(titles, List.copyOf(statuses));
        }

        if (completed.get()) return;

        // 5. 流式合成最终报告
        String reportName = "循证医学报告_" + question.substring(0, Math.min(20, question.length()));
        synthesizeReport(sessionId, question, evidenceChunks, sink, completed, future, reportName);
    }

    // ===== 规划 =====

    private ReportPlan generatePlan(String question, List<Message> historyMessages) {
        try {
            List<Message> messages = new ArrayList<>();
            messages.add(new SystemMessage(MedicalAgentPrompts.getReportPlanPrompt()));
            messages.addAll(historyMessages);
            messages.add(new UserMessage("研究问题：" + question));

            String response = planningClient.prompt()
                    .messages(messages)
                    .call()
                    .content();

            return parsePlan(response);
        } catch (Exception e) {
            log.error("生成任务计划失败: {}", e.getMessage());
            return null;
        }
    }

    private ReportPlan parsePlan(String json) {
        try {
            String cleaned = extractJson(json);
            JSONObject obj = JSON.parseObject(cleaned);
            String analysis = obj.getString("analysis");

            JSONArray tasks = obj.getJSONArray("tasks");
            List<TaskItem> taskList = new ArrayList<>();
            for (int i = 0; i < tasks.size(); i++) {
                JSONObject t = tasks.getJSONObject(i);
                taskList.add(new TaskItem(t.getString("title"), t.getString("detail")));
            }
            return new ReportPlan(analysis, taskList);
        } catch (Exception e) {
            log.warn("解析任务计划失败: {}", e.getMessage());
            return null;
        }
    }

    private String extractJson(String text) {
        if (text == null) return "{}";
        int start = text.indexOf('{');
        int end = text.lastIndexOf('}');
        if (start >= 0 && end > start) return text.substring(start, end + 1);
        return text;
    }

    // ===== 任务执行 =====

    private String executeTask(String sessionId, String question, TaskItem task,
                               AgentSink sink, AtomicBoolean completed) {
        List<Message> messages = new ArrayList<>();
        messages.add(new SystemMessage("""
                你是医学循证研究助手。请根据任务要求搜索文献证据，并提供摘要。
                回答简洁，聚焦证据核心，不超过500字。
                """));
        messages.add(new UserMessage("研究问题：" + question + "\n当前任务：" + task.title + "（" + task.detail + "）"));

        StringBuilder taskResult = new StringBuilder();

        try {
            // 简单执行：带工具的一轮调用
            CompletableFuture<String> taskFuture = new CompletableFuture<>();
            runTaskRound(sessionId, task, messages, sink, completed, taskResult, taskFuture);
            taskFuture.get(3, TimeUnit.MINUTES);
        } catch (Exception e) {
            log.warn("任务执行失败: task={}, error={}", task.title, e.getMessage());
        }

        return taskResult.toString();
    }

    private void runTaskRound(String sessionId, TaskItem task, List<Message> messages,
                              AgentSink sink, AtomicBoolean completed,
                              StringBuilder taskResult, CompletableFuture<String> taskFuture) {

        // 单轮带工具执行，采用手动工具调用方式
        org.springframework.ai.chat.model.ChatResponse response;
        try {
            response = executionClient.prompt()
                    .messages(messages)
                    .call()
                    .chatResponse();
        } catch (Exception e) {
            taskFuture.complete(taskResult.toString());
            return;
        }

        if (response == null || response.getResult() == null) {
            taskFuture.complete(taskResult.toString());
            return;
        }

        var output = response.getResult().getOutput();
        var toolCalls = output.getToolCalls();

        if (toolCalls != null && !toolCalls.isEmpty()) {
            // 执行工具调用
            AssistantMessage assistantMsg = AssistantMessage.builder().toolCalls(toolCalls).build();
            messages.add(assistantMsg);

            for (AssistantMessage.ToolCall tc : toolCalls) {
                String callId = tc.id();
                String toolName = tc.name();
                String argsJson = tc.arguments();

                sink.toolCallStart(MedicalAgentPrompts.getSearchThinkingMessage(
                        extractQuery(argsJson)), callId, argsJson);

                ToolCallback cb = findTool(toolName);
                if (cb != null) {
                    try {
                        Object result = cb.call(argsJson);
                        messages.add(ToolResponseMessage.builder()
                                .responses(List.of(new ToolResponseMessage.ToolResponse(callId, toolName, result.toString())))
                                .build());
                        recordUsedTool(toolName);
                        sink.toolCallEnd("检索完成", callId);
                    } catch (Exception e) {
                        messages.add(ToolResponseMessage.builder()
                                .responses(List.of(new ToolResponseMessage.ToolResponse(callId, toolName, "{\"error\":\"" + e.getMessage() + "\"}")))
                                .build());
                        sink.toolCallEnd("检索失败", callId);
                    }
                } else {
                    sink.toolCallEnd("工具未找到", callId);
                }
            }

            // 再次调用 LLM 得到最终答案
            try {
                String finalAnswer = planningClient.prompt()
                        .messages(messages)
                        .call()
                        .content();
                if (finalAnswer != null) {
                    taskResult.append(finalAnswer);
                }
            } catch (Exception e) {
                log.warn("任务最终回答生成失败: {}", e.getMessage());
            }
        } else {
            // 直接文字回答
            String text = output.getText();
            if (text != null) {
                taskResult.append(text);
            }
        }

        taskFuture.complete(taskResult.toString());
    }

    // ===== 报告合成 =====

    private void synthesizeReport(String sessionId, String question, List<String> evidenceChunks,
                                  AgentSink sink, AtomicBoolean completed,
                                  CompletableFuture<Void> future, String reportName) {
        String allEvidence = String.join("\n\n", evidenceChunks);
        List<Message> messages = new ArrayList<>();
        messages.add(new SystemMessage("""
                你是医学循证报告撰写专家。基于提供的证据材料，生成一份完整的循证医学报告。
                报告结构：背景与意义 → 研究方法 → 证据综合 → 临床结论 → 参考文献
                要求：逻辑清晰、证据标注规范、语言专业。
                """));
        messages.add(new UserMessage("研究问题：" + question + "\n\n已收集的证据材料：\n" + allEvidence));

        StringBuilder reportBuffer = new StringBuilder();

        Disposable disposable = planningClient.prompt()
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
                        reportBuffer.append(text);
                    }
                })
                .doOnComplete(() -> {
                    sink.complete();
                    sink.finish("", reportName);

                    // 持久化报告
                    if (reportBuffer.length() > 0) {
                        saveAnswer(reportBuffer.toString(), null);
                    }

                    if (completed.compareAndSet(false, true)) {
                        future.complete(null);
                    }
                })
                .doOnError(err -> {
                    if (completed.compareAndSet(false, true)) {
                        sink.error("报告生成失败: " + err.getMessage());
                        future.completeExceptionally(err);
                    }
                })
                .subscribe();

        if (taskManager != null) {
            taskManager.setDisposable(sessionId, disposable);
        }
    }

    // ===== 工具辅助 =====

    private ToolCallback findTool(String name) {
        return tools.stream()
                .filter(t -> t.getToolDefinition().name().equals(name))
                .findFirst().orElse(null);
    }

    private String extractQuery(String argsJson) {
        try {
            if (argsJson != null) {
                JSONObject args = JSON.parseObject(argsJson);
                String q = args.getString("query");
                if (q != null) return q;
            }
        } catch (Exception ignored) {}
        return "相关文献";
    }

    // ===== 内部数据类 =====

    private record ReportPlan(String analysis, List<TaskItem> tasks) {}

    private record TaskItem(String title, String detail) {}
}
