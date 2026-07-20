package com.evimed.agent.evidence.agentevidencebased.service.impl;

import com.evimed.agent.evidence.agentevidencebased.entity.AgentSession;
import com.evimed.agent.evidence.agentevidencebased.mapper.AgentSessionMapper;
import com.evimed.agent.evidence.agentevidencebased.service.AiSessionService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Agent 会话服务实现（MyBatis-Plus）
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AiSessionServiceImpl implements AiSessionService {

    private final AgentSessionMapper sessionMapper;

    @Override
    public AgentSession saveQuestion(String sessionId, String question, String agentType) {
        AgentSession session = new AgentSession();
        session.setSessionId(sessionId);
        session.setQuestion(question);
        session.setAgentType(agentType);
        sessionMapper.insert(session);
        log.debug("保存用户问题: sessionId={}, id={}", sessionId, session.getId());
        return session;
    }

    @Override
    public void updateAnswer(Long id, String answer, String thinking, String tools,
                             long firstResponseTime, long totalResponseTime) {
        if (id == null) return;
        AgentSession session = new AgentSession();
        session.setId(id);
        session.setAnswer(answer);
        session.setThinking(thinking);
        session.setTools(tools);
        session.setFirstResponseTime(firstResponseTime);
        session.setTotalResponseTime(totalResponseTime);
        sessionMapper.updateById(session);
        log.debug("更新回答: id={}, answerLen={}", id, answer != null ? answer.length() : 0);
    }

    @Override
    public List<AgentSession> findRecentBySessionId(String sessionId, int maxMessages) {
        return sessionMapper.findRecentBySessionId(sessionId, maxMessages);
    }
}
