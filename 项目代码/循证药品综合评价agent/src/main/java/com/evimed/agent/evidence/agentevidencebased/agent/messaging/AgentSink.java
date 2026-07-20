package com.evimed.agent.evidence.agentevidencebased.agent.messaging;

import java.util.List;

/**
 * 智能体事件输出接口
 * Agent 通过此接口向前端发送消息，与 evidence-based-agent 的 AgentSink 保持一致
 * 底层由 AgentSinkImpl 实现，调用 AgentMessageSender 格式化并通过 WebSocket 发送
 */
public interface AgentSink {

    // ===== 任务规划相关 =====

    /** 发送任务大纲预览（previewPlan） */
    void previewPlan(String analysis, List<String> todo, List<String> todoDetails);

    /** 发送任务编排进度（orchestra） */
    void orchestraPlan(String analysis, List<String> todo, List<String> todoDetails);

    /** 发送任务状态更新（status：todo/doing/done） */
    void status(List<String> titles, List<String> statuses);

    // ===== 工具调用相关 =====

    /** 工具调用开始（"正在检索 PubMed..."） */
    void toolCallStart(String delta, String callId, String argument);

    /** 工具调用结束（"检索到 50 篇文献"） */
    void toolCallEnd(String delta, String callId);

    // ===== 文本输出 =====

    /** 流式追加文本（带 50ms 节流缓冲） */
    void streamAppend(String delta);

    /** 新消息开始（new type） */
    void newMessage(String content);

    /** 发送原始文本（直接发送，不缓冲） */
    void rawMessage(String content);

    // ===== 交互 =====

    /** 澄清提问（带倒计时） */
    void clarification(String intentSummary, List<String> questions, int timeoutSeconds);

    // ===== 阶段相关 =====

    /** 阶段预告 */
    void phasePreview(String phaseTitle, String description, List<String> steps);

    /** 阶段总结 */
    void phaseSummary(String phaseTitle, String summary, List<String> keyFindings);

    // ===== 完成相关 =====

    /** 报告卡片交付 */
    void reportDelivery(String title, String author, String date,
                        String preview, String mdUrl, String fileName, String fileSize);

    /** 报告完成（含下载链接） */
    void finish(String url, String name);

    /** 错误消息 */
    void error(String errorMessage);

    /** 进度消息 */
    void progress(int current, int total, String description);

    /** 参考链接（回答结束时发送） */
    default void reference(String referenceJson) {}

    /** 推荐追问（回答结束时发送） */
    default void recommend(String recommendJson) {}

    /** 正常完成（刷新流式缓冲区，确保最后一批内容发送出去） */
    default void complete() {}
}
