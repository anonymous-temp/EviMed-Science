package com.evimed.agent.evidence.agentevidencebased.agent.messaging;

import com.evimed.agent.evidence.agentevidencebased.infrastructure.handler.AgentMessageSender;
import io.netty.channel.Channel;

import java.util.List;

/**
 * AgentSink 实现类
 * 包装 AgentMessageSender，提供统一的事件输出接口
 */
public class AgentSinkImpl implements AgentSink {

    private final AgentMessageSender<Channel> messageSender;

    public AgentSinkImpl(AgentMessageSender<Channel> messageSender) {
        this.messageSender = messageSender;
    }

    @Override
    public void previewPlan(String analysis, List<String> todo, List<String> todoDetails) {
        messageSender.sendPreviewPlanMessage(analysis, todo, todoDetails);
    }

    @Override
    public void orchestraPlan(String analysis, List<String> todo, List<String> todoDetails) {
        messageSender.sendOrchestraMessage(analysis, todo, todoDetails);
    }

    @Override
    public void status(List<String> titles, List<String> statuses) {
        messageSender.sendStatusMessage(titles, statuses);
    }

    @Override
    public void toolCallStart(String delta, String callId, String argument) {
        messageSender.sendToolCallMessage(delta, delta, callId, argument);
    }

    @Override
    public void toolCallEnd(String delta, String callId) {
        messageSender.sendToolCallOutputMessage(delta, callId);
    }

    @Override
    public void streamAppend(String delta) {
        messageSender.sendRawMessage(delta);
    }

    @Override
    public void newMessage(String content) {
        messageSender.sendNewMessage(content);
    }

    @Override
    public void rawMessage(String content) {
        messageSender.sendRawMessage(content);
    }

    @Override
    public void clarification(String intentSummary, List<String> questions, int timeoutSeconds) {
        messageSender.sendClarificationMessage(intentSummary, questions, timeoutSeconds);
    }

    @Override
    public void phasePreview(String phaseTitle, String description, List<String> steps) {
        messageSender.sendPhasePreviewMessage(phaseTitle, description, steps);
    }

    @Override
    public void phaseSummary(String phaseTitle, String summary, List<String> keyFindings) {
        messageSender.sendPhaseSummaryMessage(phaseTitle, summary, keyFindings);
    }

    @Override
    public void reportDelivery(String title, String author, String date,
                               String preview, String mdUrl, String fileName, String fileSize) {
        messageSender.sendReportDeliveryMessage(title, author, date, preview, mdUrl, fileName, fileSize);
    }

    @Override
    public void finish(String url, String name) {
        messageSender.sendFinishMessage(url, name);
    }

    @Override
    public void error(String errorMessage) {
        messageSender.sendErrorMessage(errorMessage);
    }

    @Override
    public void progress(int current, int total, String description) {
        messageSender.sendProgressMessage(current, total, description);
    }

    @Override
    public void reference(String referenceJson) {
        messageSender.sendReferenceMessage(referenceJson);
    }

    @Override
    public void recommend(String recommendJson) {
        messageSender.sendRecommendMessage(recommendJson);
    }

    @Override
    public void complete() {
    }
}
