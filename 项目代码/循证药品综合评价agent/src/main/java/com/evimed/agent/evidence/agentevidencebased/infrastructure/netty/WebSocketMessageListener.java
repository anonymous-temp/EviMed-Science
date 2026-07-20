package com.evimed.agent.evidence.agentevidencebased.infrastructure.netty;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.evimed.agent.evidence.agentevidencebased.agent.messaging.AgentSink;
import com.evimed.agent.evidence.agentevidencebased.agent.messaging.AgentSinkImpl;
import com.evimed.agent.evidence.agentevidencebased.infrastructure.handler.AgentMessageSender;
import com.evimed.agent.evidence.agentevidencebased.service.AgentDispatcher;
import com.evimed.agent.evidence.agentevidencebased.service.AgentTaskManager;
import com.evimed.agent.evidence.agentevidencebased.enums.AgentType;
import io.netty.channel.Channel;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.*;

/**
 * WebSocket 消息事件监听器
 *
 * 并发设计（与 evidence-based-agent 保持一致）：
 *   - 每个 sessionId 独享一个 SingleThreadExecutor，同一用户消息天然串行
 *   - 不同用户并行执行，互不干扰
 *   - 定时清理过期的 session executor
 */
@Slf4j
@Component
public class WebSocketMessageListener {

    private final NettyWebSocketClient webSocketClient;
    private final AgentDispatcher agentDispatcher;
    private final AgentTaskManager agentTaskManager;

    @Value("${upstream.wesocket.client-type:medical-qa-agent}")
    private String clientType;

    /** per-session 单线程执行器，保证同一用户消息串行 */
    private final ConcurrentHashMap<String, ExecutorService> sessionExecutors = new ConcurrentHashMap<>();

    /** 活跃 session 记录（用于定时清理） */
    private final Set<String> activeSessions = ConcurrentHashMap.newKeySet();

    public WebSocketMessageListener(NettyWebSocketClient webSocketClient,
                                     AgentDispatcher agentDispatcher,
                                     AgentTaskManager agentTaskManager) {
        this.webSocketClient = webSocketClient;
        this.agentDispatcher = agentDispatcher;
        this.agentTaskManager = agentTaskManager;
    }

    /**
     * 处理 WebSocket 消息事件
     * 同步监听（不加 @Async），由 per-session executor 承担异步
     */
    @EventListener
    public void handleWebSocketMessage(WebSocketMessageEvent event) {
        String sessionId = event.getChannelId();
        String type = event.getType();
        String content = event.getContent();
        Channel channel = event.getChannel();
        JSONObject messageContext = event.getMessageContext();

        try {
            switch (type) {
                case "text" -> handleUserMessage(channel, sessionId, content, messageContext);
                case "terminate" -> handleTerminate(sessionId);
                case "clear" -> handleClear(sessionId);
                default -> log.debug("收到未处理的消息类型: type={}", type);
            }
        } catch (Exception e) {
            log.error("处理 WebSocket 消息失败: sessionId={}", sessionId, e);
        }
    }

    /**
     * 处理用户消息：提交到该 session 的单线程 executor
     */
    private void handleUserMessage(Channel channel, String sessionId, String content,
                                    JSONObject messageContext) {
        String userMessage;
        Integer agentTypeCode = null;
        try {
            JSONObject contentObj = JSON.parseObject(content);
            userMessage = contentObj.getString("content");
            // 前端传数字 code：1=问答 2=文件上传 3=PPT 4=深度研究
            agentTypeCode = contentObj.getInteger("agentType");
            if (userMessage == null || userMessage.isBlank()) {
                log.warn("消息内容为空: sessionId={}", sessionId);
                return;
            }
        } catch (Exception e) {
            userMessage = content;
        }

        AgentType agentType = AgentType.fromCode(agentTypeCode);
        final String finalUserMessage = userMessage;
        final AgentType finalAgentType = agentType;
        log.info("收到用户消息: sessionId={}, agentType={}(code={}), message={}",
                sessionId, agentType, agentTypeCode, userMessage);

        AgentMessageSender<Channel> messageSender = buildMessageSender(channel, messageContext);
        AgentSink sink = new AgentSinkImpl(messageSender);

        activeSessions.add(sessionId);

        ExecutorService sessionExecutor = sessionExecutors.computeIfAbsent(
                sessionId, k -> Executors.newSingleThreadExecutor(r -> {
                    Thread t = new Thread(r, "agent-session-" + k);
                    t.setDaemon(true);
                    return t;
                }));

        sessionExecutor.submit(() -> {
            try {
                agentDispatcher.dispatch(sessionId, finalUserMessage, finalAgentType, sink);
            } catch (Exception e) {
                log.error("处理消息时发生错误: sessionId={}", sessionId, e);
                sink.error("处理消息时发生错误: " + e.getMessage());
            }
        });
    }

    /**
     * 处理终止指令：停止当前任务
     */
    private void handleTerminate(String sessionId) {
        log.info("收到终止指令: sessionId={}", sessionId);
        agentTaskManager.stopTask(sessionId);
        activeSessions.remove(sessionId);
        shutdownSessionExecutor(sessionId);
    }

    /**
     * 处理清除会话指令
     */
    private void handleClear(String sessionId) {
        log.info("收到清除会话指令: sessionId={}", sessionId);
        agentTaskManager.stopTask(sessionId);
        activeSessions.remove(sessionId);
        shutdownSessionExecutor(sessionId);
    }

    /**
     * 构建消息发送器，绑定 channel 和路由信息
     */
    private AgentMessageSender<Channel> buildMessageSender(Channel channel, JSONObject messageContext) {
        AgentMessageSender<Channel> sender = new AgentMessageSender<>(
                channel,
                this::doSendMessage,
                clientType
        );
        if (messageContext != null) {
            sender.withContextSupplier(() -> messageContext);
        }
        return sender;
    }

    /**
     * 实际发送消息（通过 Netty WebSocket 客户端）
     */
    private void doSendMessage(Channel channel, String message) {
        if (webSocketClient != null && webSocketClient.isConnected()) {
            webSocketClient.sendMessage(message);
        } else {
            log.warn("WebSocket 客户端未连接，无法发送消息");
        }
    }

    private void shutdownSessionExecutor(String sessionId) {
        ExecutorService ex = sessionExecutors.remove(sessionId);
        if (ex != null) {
            ex.shutdownNow();
            log.debug("Session executor shutdown: sessionId={}", sessionId);
        }
    }

    public Set<String> getActiveSessionIds() {
        return activeSessions;
    }

    /**
     * 定时清理：每 90 秒清理已无活跃任务的 session executor
     */
    @Scheduled(fixedDelay = 90_000)
    public void cleanupOrphanedExecutors() {
        sessionExecutors.keySet().removeIf(sessionId -> {
            if (!activeSessions.contains(sessionId) && !agentTaskManager.hasRunningTask(sessionId)) {
                ExecutorService ex = sessionExecutors.get(sessionId);
                if (ex != null) ex.shutdownNow();
                log.debug("清理孤儿 executor: sessionId={}", sessionId);
                return true;
            }
            return false;
        });
    }
}
