package com.sentum.evidencecomprehensive.pojo.bo.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 指南纳入/排除实体类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_guide_include_exclude")
public class GuideIncludeOrExclude {
    @Id
    private String id;
    /**
     * 检索id，课题id
     */
    private String conditionId;
    /**
     * 指南id
     */
    private String guideId;
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
