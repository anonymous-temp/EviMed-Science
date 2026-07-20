package com.evimed.agent.evidence.agentevidencebased.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.evimed.agent.evidence.agentevidencebased.entity.AgentSession;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;

/**
 * Agent 会话记录 Mapper
 */
@Mapper
public interface AgentSessionMapper extends BaseMapper<AgentSession> {

    /**
     * 按会话ID查询最近N条记录（按创建时间倒序）
     */
    @Select("SELECT * FROM ai_session WHERE session_id = #{sessionId} " +
            "ORDER BY create_time DESC LIMIT #{limit}")
    List<AgentSession> findRecentBySessionId(@Param("sessionId") String sessionId,
                                             @Param("limit") int limit);
}
