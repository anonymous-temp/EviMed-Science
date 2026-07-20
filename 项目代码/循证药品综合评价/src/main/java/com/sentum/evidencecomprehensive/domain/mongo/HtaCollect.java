package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * hta收藏实体类
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_hta_collect")
public class HtaCollect {
    @Id
    private String id;
    /**
     * 检索id，课题id
     */
    private String conditionId;
    /**
     * hta id
     */
    private String htaId;
    /**
     * 用户id
     */
    private Long userId;
    /**
     * 收藏时间戳
     */
    private Long timeStamp;
}
