package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * mongo中icd10数据
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_icd11")
public class Icd11 {
    @Id
    private String id;
    
    /**
     * 诊断名称-中文
     */
    private String chinese_name;
}
