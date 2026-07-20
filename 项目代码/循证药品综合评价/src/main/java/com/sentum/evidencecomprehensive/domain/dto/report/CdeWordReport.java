package com.sentum.evidencecomprehensive.domain.dto.report;

import cn.hutool.core.date.DateTime;
import com.alibaba.fastjson.JSONObject;
import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * @Description: 报告-cde数据  cdeId - 课题 id（id - questionId ）
 */
@Data
@Document("evidence_cde_report")
public class CdeWordReport {
    
    /**
     * id
     */
    @Id
    private String id;

    /**
     * id
     */
    private String cdeId;

    /**
     * 课题 id
     */
    private String questionId;

    /**
     * 药
     */
    private String drugName;

    /**
     * 创建时间
     */
    private DateTime createTime;

    /**
     * 
     */
    private JSONObject cde;
}
