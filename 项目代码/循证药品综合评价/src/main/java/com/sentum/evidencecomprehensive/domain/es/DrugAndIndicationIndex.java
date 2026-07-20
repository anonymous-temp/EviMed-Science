package com.sentum.evidencecomprehensive.domain.es;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;

import java.util.List;

/**
 * 药品适应症索引
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document(indexName = "drug_indication_index_v2")
public class DrugAndIndicationIndex {
    @Id
    private String id;
    /**
     * 药品名称
     */
    private String zhDrugName;
    /**
     * 剂型
     */
    private String dosageForm;
    /**
     * 商品名称-中文
     */
    private String commodityNameZh;
    /**
     * 商品名称-英文
     */
    private String commodityNameEn;
    /**
     * 药品名称
     */
    private List<String> drugName;
    /**
     * 药品名称
     */
    private List<String> zhDrugNames;
    /**
     * 药品名称
     */
    private List<String> enDrugNames;
    /**
     * 所有疾病名称的集合
     */
    private List<String> disease;
    /**
     * 疾病名称中英文对照
     */
    private List<String> zhAndEn;
    /**
     * 疾病名称的集合-中文
     */
    private List<String> diseaseZh;
    /**
     * 疾病名称的集合-英文
     */
    private List<String> diseaseEn;
    /**
     * 适应症
     */
    private String indication;
    /**
     * 药品厂家
     */
    private String manufacturer;
    /**
     * 药品规格
     */
    private String specifications;

    private String drugZh;
    
    private String drugEn;
}
