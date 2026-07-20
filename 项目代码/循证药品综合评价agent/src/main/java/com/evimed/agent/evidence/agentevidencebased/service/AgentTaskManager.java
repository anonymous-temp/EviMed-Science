package com.evimed.agent.evidence.agentevidencebased.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import reactor.core.Disposable;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Agent 任务管理器
 * 管理正在执行的任务，支持按 sessionId 停止任务
 *
 * 与 dodo-agent 的差异：
 *   - 去掉了 Sinks.Many（SSE 专用），改为 stopCallback（WebSocket 直接发消息）
 *   - stopTask() 调用 disposable.dispose() 取消 LLM 流 + 调用 stopCallback 通知前端
 */
@Slf4j
@Component
public class AgentTaskManager {

    public static class TaskInfo {
        private volatile Disposable disposable;
        private final Runnable stopCallback;
        private final long createTime;
        private final String agentType;

        public TaskInfo(Runnable stopCallback, String agentType) {
            this.stopCallback = stopCallback;
            this.agentType = agentType;
            this.createTime = System.currentTimeMillis();
        }

        public void setDisposable(Disposable disposable) {
            this.disposable = disposable;
        }

        public Disposable getDisposable() {
            return disposable;
        }

        public long getCreateTime() {
            return createTime;
        }

        public String getAgentType() {
            return agentType;
        }
    }

    /** sessionId → TaskInfo */
    private final Map<String, TaskInfo> taskMap = new ConcurrentHashMap<>();

    /**
     * 注册任务
     *
     * @param sessionId    会话ID
     * @param stopCallback 停止时回调（通常是 sink.error("已停止")）
     * @param agentType    Agent类型（用于日志）
     * @return 任务信息，如果已有任务则返回 null（防并发重入）
     */
    public TaskInfo registerTask(String sessionId, Runnable stopCallback, String agentType) {
        if (taskMap.containsKey(sessionId)) {
            log.warn("会话 {} 已有任务在执行，拒绝注册新任务", sessionId);
            return null;
        }
        TaskInfo taskInfo = new TaskInfo(stopCallback, agentType);
        taskMap.put(sessionId, taskInfo);
        log.info("注册任务: sessionId={}, agentType={}", sessionId, agentType);
        return taskInfo;
    }

    /**
     * 设置任务的 Disposable（在 LLM 调用开始后设置）
     */
    public void setDisposable(String sessionId, Disposable disposable) {
        TaskInfo taskInfo = taskMap.get(sessionId);
        if (taskInfo != null) {
            taskInfo.setDisposable(disposable);
        }
    }

    /**
     * 停止任务
     * 1. 取消 LLM 响应流（disposable.dispose）
     * 2. 调用 stopCallback 通知前端（发送停止消息）
     * 3. 从 taskMap 移除
     */
    public boolean stopTask(String sessionId) {
        TaskInfo taskInfo = taskMap.get(sessionId);
        if (taskInfo == null) {
            log.warn("会话 {} 没有正在执行的任务", sessionId);
            return false;
        }

        try {
            // 1. 取消 LLM 流
            Disposable disposable = taskInfo.getDisposable();
            if (disposable != null && !disposable.isDisposed()) {
                disposable.dispose();
                log.info("已取消 LLM 流: sessionId={}", sessionId);
            }

            // 2. 通知前端（通过 AgentSink 发送停止消息）
            if (taskInfo.stopCallback != null) {
                try {
                    taskInfo.stopCallback.run();
                } catch (Exception e) {
                    log.warn("执行 stopCallback 失败: sessionId={}", sessionId, e);
                }
            }

            taskMap.remove(sessionId);
            log.info("任务已停止: sessionId={}", sessionId);
            return true;
        } catch (Exception e) {
            log.error("停止任务失败: sessionId={}", sessionId, e);
            return false;
        }
    }

    /**
     * 任务完成后移除（正常完成，不需要 stopCallback）
     */
    public void removeTask(String sessionId) {
        TaskInfo removed = taskMap.remove(sessionId);
        if (removed != null) {
            log.debug("移除已完成任务: sessionId={}", sessionId);
        }
    }

    /**
     * 检查会话是否有正在执行的任务
     */
    public boolean hasRunningTask(String sessionId) {
        return taskMap.containsKey(sessionId);
    }

    /**
     * 获取任务信息
     */
    public TaskInfo getTask(String sessionId) {
        return taskMap.get(sessionId);
    }
}
