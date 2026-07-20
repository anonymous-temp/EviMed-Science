package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * hta纳入/排除实体类
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_hta_include_exclude")
public class HtaIncludeOrExclude {
    
    @Id
    private String id;
    
    /**
     * 检索id，课题id
     */
    @Field("conditionId")
    private String conditionId;
    
    /**
     * 文献id
     */
    @Field("htaId")
    private String htaId;
    
    /**
     * 1-纳入；2-排除
     */
    @Field("status")
    private Integer status;
    
    /**
     * 用户id
     */
    @Field("userId")
    private Long userId;
    
    /**
     * 纳入/排除时间戳
     */
    @Field("timeStamp")
    private Long timeStamp;
}
