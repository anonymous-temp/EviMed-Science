package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 用户修改质量等级后存储类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_paper_quality")
public class PaperQuality {
    @Id
    private String id;
    /**
     * 文献id
     */
    private String paperId;
    /**
     * 检索id
     */
    private String conditionId;
    /**
     * 用户id
     */
    private Long userId;
    /**
     * 修改后的质量等级 0-低；1-中；2-高
     */
    private Integer quality;
    /**
     * 纳入时间戳
     */
    private Long timeStamp;
}
