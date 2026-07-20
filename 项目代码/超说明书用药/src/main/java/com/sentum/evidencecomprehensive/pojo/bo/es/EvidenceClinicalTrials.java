package com.sentum.evidencecomprehensive.pojo.bo.es;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;

import java.util.List;

/**
 * 临床试验干预措施及解决指标
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document(indexName = "evidence_clinical_trials_index")
public class EvidenceClinicalTrials {
    @Id
    private String id;
    /**
     * 干预措施
     */
    private List<String> intervention;
    /**
     * 结局指标
     */
    private List<String> outcome;
    /**
     * 中文临川试验1，英文2
     */
    private Integer type;
}
