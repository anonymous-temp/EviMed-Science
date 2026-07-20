package com.evimed.agent.evidence.agentevidencebased.service;

import com.evimed.agent.evidence.agentevidencebased.entity.AgentSession;

import java.util.List;

/**
 * Agent 会话服务接口
 * 负责问答记录的持久化（保存问题、更新答案、查询历史）
 */
public interface AiSessionService {

    /**
     * 保存用户问题（对话开始时调用）
     *
     * @param sessionId 会话ID
     * @param question  用户问题
     * @param agentType Agent类型
     * @return 保存后的会话记录（含自增ID）
     */
    AgentSession saveQuestion(String sessionId, String question, String agentType);

    /**
     * 更新回答（对话结束时调用）
     *
     * @param id                 会话记录ID
     * @param answer             最终答案
     * @param thinking           思考过程（可为null）
     * @param tools              使用的工具列表（逗号分隔）
     * @param firstResponseTime  首次响应耗时（ms）
     * @param totalResponseTime  总响应耗时（ms）
     */
    void updateAnswer(Long id, String answer, String thinking, String tools,
                      long firstResponseTime, long totalResponseTime);

    /**
     * 查询最近的会话历史（用于加载记忆）
     *
     * @param sessionId   会话ID
     * @param maxMessages 最大条数
     * @return 按时间倒序的会话列表
     */
    List<AgentSession> findRecentBySessionId(String sessionId, int maxMessages);
}
