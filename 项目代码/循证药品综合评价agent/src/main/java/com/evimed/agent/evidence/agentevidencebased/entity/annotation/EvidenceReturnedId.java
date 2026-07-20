package com.evimed.agent.evidence.agentevidencebased.entity.annotation;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_evidence_returned")
public class EvidenceReturnedId {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String sessionId;

    private String evidenceType;

    private String evidenceId;

    private LocalDateTime createdAt;
}
