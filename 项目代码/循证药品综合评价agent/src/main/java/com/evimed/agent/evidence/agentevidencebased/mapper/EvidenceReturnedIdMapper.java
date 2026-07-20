package com.evimed.agent.evidence.agentevidencebased.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.evimed.agent.evidence.agentevidencebased.entity.annotation.EvidenceReturnedId;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;

@Mapper
public interface EvidenceReturnedIdMapper extends BaseMapper<EvidenceReturnedId> {

    @Select("SELECT evidence_id FROM ai_evidence_returned WHERE session_id = #{sessionId} AND evidence_type = #{evidenceType}")
    List<String> selectReturnedIds(@Param("sessionId") String sessionId, @Param("evidenceType") String evidenceType);
}
