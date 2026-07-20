package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 指南收藏实体类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_guide_collect")
public class GuideCollect {
    @Id
    private String id;
    /**
     * 检索id，课题id
     */
    private String conditionId;
    /**
     * 文献id
     */
    private String guideId;
    /**
     * 用户id
     */
    private Long userId;
    /**
     * 收藏时间戳
     */
    private Long timeStamp;
}
