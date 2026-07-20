package com.evimed.agent.evidence.agentevidencebased.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * Agent 会话记录实体
 * 对应数据库表 agent_session
 */
@Data
@TableName("ai_session")
public class AgentSession {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 会话ID（用户标识，对应 WebSocket 的 senderId） */
    @TableField("session_id")
    private String sessionId;

    /** 用户问题 */
    @TableField("question")
    private String question;

    /** AI 回答 */
    @TableField("answer")
    private String answer;

    /** 思考过程（LLM内部推理） */
    @TableField("thinking")
    private String thinking;

    /** 使用的工具列表（逗号分隔） */
    @TableField("tools")
    private String tools;

    /** Agent 类型（medical-qa / medical-report） */
    @TableField("agent_type")
    private String agentType;

    /** 参考链接JSON */
    @TableField("reference")
    private String reference;

    /** 首次响应耗时（毫秒） */
    @TableField("first_response_time")
    private Long firstResponseTime;

    /** 总响应耗时（毫秒） */
    @TableField("total_response_time")
    private Long totalResponseTime;

//    @TableField(fill = FieldFill.INSERT)
    @TableField("create_time")
    private LocalDateTime createTime;

//    @TableField(fill = FieldFill.INSERT_UPDATE)
    @TableField("update_time")
    private LocalDateTime updateTime;

    /**
     * 关联文件ID（用于关联ai_file_info或ai_ppt_inst）
     */
    @TableField("fileid")
    private String fileid;

    /**
     * 推荐问题JSON
     */
    @TableField("recommend")
    private String recommend;
}
