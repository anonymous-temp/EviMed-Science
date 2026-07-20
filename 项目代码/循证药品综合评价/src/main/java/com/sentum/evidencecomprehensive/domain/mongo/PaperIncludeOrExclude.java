package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 文献纳入/排除实体类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_paper_include_exclude")
public class PaperIncludeOrExclude {
    @Id
    private String id;
    /**
     * 检索id，课题id
     */
    private String conditionId;
    /**
     * 文献id
     */
    private String paperId;
    /**
     * 1-纳入；2-排除
     */
    private Integer status;
    /**
     * 0-默认状态，1-手动纳入，2-AI推荐纳入
     */
    private Integer type;
    /**
     * 用户id
     */
    private Long userId;
    /**
     * 纳入/排除时间戳
     */
    private Long timeStamp;
}
