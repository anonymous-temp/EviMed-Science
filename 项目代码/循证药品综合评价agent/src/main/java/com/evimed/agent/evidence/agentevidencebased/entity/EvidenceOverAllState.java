package com.evimed.agent.evidence.agentevidencebased.entity;

import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template.MedicalReportTemplate;
import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.template.MedicalReportType;
import com.evimed.agent.evidence.agentevidencebased.entity.record.EvidencePlanRoundState;
import com.evimed.agent.evidence.agentevidencebased.entity.record.EvidencePlanTask;
import com.evimed.agent.evidence.agentevidencebased.entity.record.EvidenceTaskResult;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.SystemMessage;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * 循证深度研究 Agent 整体状态
 * 对应 LLMentor 的 OverAllState，增加医学报告类型和任务 UI 状态管理。
 */
public class EvidenceOverAllState {

    private final String sessionId;
    private final String question;
    private final List<Message> messages = new ArrayList<>();
    private final List<EvidencePlanRoundState> rounds = new ArrayList<>();
    private int round = 0;

    /** 研究维度/主题（研究主题生成阶段赋值） */
    private String refinedResearchTopic;

    /** 报告类型（从用户问题识别） */
    private final MedicalReportType reportType;

    /** 对应报告类型的模板 */
    private final MedicalReportTemplate reportTemplate;

    /** 当前轮次的任务列表（用于 UI 状态更新） */
    private List<EvidencePlanTask> currentPlan = new ArrayList<>();

    /** taskId → 状态字符串（"todo" | "doing" | "done"） */
    private final Map<String, String> taskStatuses = new ConcurrentHashMap<>();

    public EvidenceOverAllState(String sessionId, String question,
                                MedicalReportType reportType, MedicalReportTemplate reportTemplate) {
        this.sessionId = sessionId;
        this.question = question;
        this.reportType = reportType;
        this.reportTemplate = reportTemplate;
    }

    // ===== 消息管理（与 LLMentor OverAllState 对齐） =====

    public void add(Message m) {
        messages.add(m);
    }

    public List<Message> getMessages() {
        return messages;
    }

    public void clearMessages() {
        messages.clear();
    }

    public int currentChars() {
        return messages.stream()
                .mapToInt(m -> m.getText() == null ? 0 : m.getText().length())
                .sum();
    }

    // ===== 轮次管理 =====

    public void nextRound() {
        round++;
    }

    public int getRound() {
        return round;
    }

    public void addRound(EvidencePlanRoundState r) {
        rounds.add(r);
    }

    public List<EvidencePlanRoundState> getRounds() {
        return rounds;
    }

    // ===== 任务 UI 状态管理 =====

    /**
     * 设置当前轮次的执行计划，并将所有任务初始化为 "todo"
     */
    public void setCurrentPlan(List<EvidencePlanTask> plan) {
        this.currentPlan = plan;
        taskStatuses.clear();
        if (plan != null) {
            for (EvidencePlanTask task : plan) {
                if (task.id() != null) {
                    taskStatuses.put(task.id(), "todo");
                }
            }
        }
    }

    public void updateTaskStatus(String taskId, String status) {
        if (taskId != null) {
            taskStatuses.put(taskId, status);
        }
    }

    public List<String> getCurrentTitles() {
        if (currentPlan == null) return new ArrayList<>();
        return currentPlan.stream()
                .map(EvidencePlanTask::title)
                .collect(Collectors.toList());
    }

    public List<String> getCurrentDetails() {
        if (currentPlan == null) return new ArrayList<>();
        return currentPlan.stream()
                .map(t -> t.detail() != null ? t.detail() : t.instruction())
                .collect(Collectors.toList());
    }

    public List<String> getCurrentStatuses() {
        if (currentPlan == null) return new ArrayList<>();
        return currentPlan.stream()
                .map(t -> taskStatuses.getOrDefault(t.id(), "todo"))
                .collect(Collectors.toList());
    }

    // ===== 工具结果提取（用于生成报告阶段） =====

    /**
     * 提取所有轮次的成功任务输出，供报告生成使用
     */
    public String extractToolResults() {
        if (rounds == null || rounds.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (EvidencePlanRoundState round : rounds) {
            if (round.results() != null && !round.results().isEmpty()) {
                for (Map.Entry<String, EvidenceTaskResult> entry : round.results().entrySet()) {
                    EvidenceTaskResult result = entry.getValue();
                    if (result != null && result.success() && result.output() != null) {
                        sb.append(String.format("【任务 %s 执行结果】\n%s\n\n",
                                entry.getKey(), result.output()));
                    }
                }
            }
        }
        return sb.toString();
    }

    // ===== Getters =====

    public String getSessionId() {
        return sessionId;
    }

    public String getQuestion() {
        return question;
    }

    public String getRefinedResearchTopic() {
        return refinedResearchTopic;
    }

    public void setRefinedResearchTopic(String refinedResearchTopic) {
        this.refinedResearchTopic = refinedResearchTopic;
    }

    public MedicalReportType getReportType() {
        return reportType;
    }

    public MedicalReportTemplate getReportTemplate() {
        return reportTemplate;
    }
}
