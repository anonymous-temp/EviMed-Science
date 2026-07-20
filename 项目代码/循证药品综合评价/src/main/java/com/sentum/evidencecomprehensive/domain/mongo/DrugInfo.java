package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;
import java.util.Objects;

/**
 * 药品信息表
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evaluation_drug_info_v2")
public class DrugInfo {
    @Id
    private String id;
    /**
     * 国药准字
     */
    private String register;
    
    /**
     * 药品名称
     */
    private String drugName;
    /**
     * 药品厂家
     */
    private String manufacturer;
    /**
     * 药品规格
     */
    private String specifications;
    /**
     * 剂型
     */
    private String dosageForm;
    /**
     * 商品中文
     */
    private String communityNameZh;
    /**
     * 商品英文
     */
    private String communityNameEn;
    /**
     * 五级英文
     */
    private String drugEn;
    /**
     * 五级英文同义词
     */
    private List<String> drugSynonymEn;
    /**
     * 五级中文
     */
    private String drugZh;
    /**
     * 五级中文同义词
     */
    private List<String> drugSynonymZh;
    /**
     * 医保情况
     */
    private String medicalInsurance;
    
    
    
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
     * 单方制剂/复方制剂
     */
    private String drugType;
    /**
     * 集采药品中标价格（元）
     */
    private String outbidPrice;
    
    
    /**
     * 去重使用
     */
    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        DrugInfo drugInfo = (DrugInfo) o;
        return Objects.equals(drugName, drugInfo.drugName)
                && Objects.equals(dosageForm, drugInfo.getDosageForm())
                && Objects.equals(specifications, drugInfo.getSpecifications())
                && Objects.equals(manufacturer, drugInfo.getManufacturer())
                && Objects.equals(drugZh, drugInfo.drugZh)
                && Objects.equals(medicalInsurance, drugInfo.medicalInsurance);
    }

    @Override
    public int hashCode() {
        return Objects.hash(drugName, dosageForm, specifications, manufacturer, drugZh, medicalInsurance);
    }
}
