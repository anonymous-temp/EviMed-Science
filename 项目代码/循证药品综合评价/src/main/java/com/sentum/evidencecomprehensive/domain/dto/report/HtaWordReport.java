package com.sentum.evidencecomprehensive.domain.dto.report;

import cn.hutool.core.date.DateTime;
import com.alibaba.fastjson.JSONObject;
import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * @Description: word hta
 */
@Data
@Document("evidence_hta_report")
public class HtaWordReport {
    /**
     * id
     */
    @Id
    private String id;

    /**
     * id
     */
    private String htaId;

    /**
     * 课题 id
     */
    private String questionId;

    /**
     * 创建时间
     */
    private DateTime createTime;
    /**
     * 卫生技术评估（HTA）报告正文
     */
    private JSONObject hta;
}
