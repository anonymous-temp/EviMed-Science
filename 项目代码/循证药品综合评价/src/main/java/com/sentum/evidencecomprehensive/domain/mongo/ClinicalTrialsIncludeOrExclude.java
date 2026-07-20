package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 临床试验纳入/排除实体类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_clinical_trials_include_exclude")
public class ClinicalTrialsIncludeOrExclude {
    @Id
    private String id;
    /**
     * 检索id，课题id
     */
    private String conditionId;
    /**
     * 临床试验的登记号
     */
    private String registerNo;
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
