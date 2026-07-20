package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;

import java.lang.reflect.Type;
import java.util.List;

/**
 * 药品适应症索引
 *
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document(indexName = "drug_indication_index_v2", shards = 3)
public class DrugAndIndicationIndexNew {
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
     * 药品名称
     */
    private List<String> drugName;
    /**
     * 商品中文名称
     */
    private String commodityNameZh;
    /**
     * 商品英文品名称
     */
    private String commodityNameEn;
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
    /**
     * 用法用量
     */
    private String usageAndDosage;
    /**
     * 不良反应
     */
    private String adverseReaction;
    /**
     * 适应症
     */
    private String indications;

    //医保
    private String medicalInsurance;
    /**
     * 批准号
     */
    private String register;

    /**
     * 药品类型
     */
    private String drugType;

    /**
     * 适应症评分
     */
    @Field(type = FieldType.Integer)
    private Integer integrityScore;


    private String drugZh;

    private String drugEn;

    /**
     * 药品类别
     */
    private String drugCategory;




}
