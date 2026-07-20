package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;

/**
 * 药品与适应症表
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
@Document("evaluation_drug_indication")
public class DrugAndIndication {
    @Id
    private String id;
    /**
     * 药品名称
     */
    private String drugName;
    /**
     * 药品英文名称
     */
    private String englishDrugName;
    /**
     * 适应症
     */
    private String indication;
    /**
     * 中文疾病名称
     */
    private List<String> diseaseZh;
    /**
     * 英文疾病名称
     */
    private List<String> diseaseEn;
    /**
     * 疾病同义词
     */
    private List<String> diseaseSynonym;
    /**
     * 治疗方案
     */
    private List<String> treatmentPlan;
    /**
     * 药品规格
     */
    private String specifications;
    /**
     * 药品厂家
     */
    private String manufacturer;
}
