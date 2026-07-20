package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * cde纳入/排除实体类
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_cde_include_exclude")
public class CdeIncludeOrExclude {
    @Id
    private String id;
    /**
     * 检索id，课题id
     */
    private String conditionId;
    /**
     * 文献id
     */
    private String cdeId;
    /**
     * 1-纳入；2-排除
     */
    private Integer status;
    /**
     * 用户id
     */
    private Long userId;
    /**
     * 纳入/排除时间戳
     */
    private Long timeStamp;
}
