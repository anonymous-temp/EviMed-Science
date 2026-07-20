package com.sentum.pojo.dto;

import lombok.Data;

@Data
public class TrTechnologyEvaluationDto {
    // 技术评价总得分
    private Double totalScore;
    // 适宜性得分
    private Double suitabilityScore;
    // 给药频次得分
    private Double administrationFrequencyScore;
    // 给药频次内容
    private String administrationFrequencyContent;
    // 包装规格得分
    private Double packagingSpecificationScore;
    // 包装规格选项
    private String packagingSpecificationOption;
    // 采用大包装得分
    private Double largePackageAdoptionScore;
    // 采用大包装选项
    private String largePackageAdoptionOption;
    // 单次用量选项
    private String singleDoseOption;
    // 单次用量得分
    private Double singleDoseScore;
    // 疗程得分
    private Double courseOfTreatmentScore;
    // 疗程内容
    private String courseOfTreatmentContent;
    // 贮藏得分
    private Double storageScore;
    // 贮藏内容
    private String storageContent;
    // 有效期得分
    private Double validityPeriodScore;
    // 有效期内容
    private String validityPeriodContent;
    // 国家中药保护品种得分
    private Double nationalTraditionalChineseMedicineProtectionScore;
    // 国家中药保护品种内容
    private String nationalTraditionalChineseMedicineProtectionContent;

    // 中国药典得分
    private Double chinesePharmacopoeiaScore;
    // 中国药典内容
    private String chinesePharmacopoeiaContent;
    // 专利得分
    private Double patentScore;
    // 专利号
    private String patentNumber;
    // 独家品种得分
    private Double exclusiveVarietyScore;
    // 独家品种信息
    private String exclusiveVarietyInfo;
    //附加属相得分
    private Double additionalZodiacScore;
    // 生产企业状况zong得分
    private Double productionEnterpriseStatusScore;
    // 生产企业状况内容
    private String productionEnterpriseStatusContent;
    //企业生产情况得分
    private Double productionEnterpriseScore;
    //企业情况得分
    private String productionEnterpriseContent;
    //是否有自己的种植基地
    private Double ownPlantingBaseScore;
    private String ownPlantingBaseOption;

    //适宜性得分
    public void setSuitabilityScore() {
        this.administrationFrequencyScore = (administrationFrequencyScore != null) ? administrationFrequencyScore : 0.0;
        this.packagingSpecificationScore = (packagingSpecificationScore != null) ? packagingSpecificationScore : 0.0;
        this.largePackageAdoptionScore = (largePackageAdoptionScore != null) ? largePackageAdoptionScore : 0.0;
        this.singleDoseScore = (singleDoseScore != null) ? singleDoseScore : 0.0;
        this.courseOfTreatmentScore = (courseOfTreatmentScore != null) ? courseOfTreatmentScore : 0.0;
        this.storageScore = (storageScore != null) ? storageScore : 0.0;
        this.validityPeriodScore = (validityPeriodScore != null) ? validityPeriodScore : 0.0;

        this.suitabilityScore = administrationFrequencyScore + packagingSpecificationScore + largePackageAdoptionScore
                + courseOfTreatmentScore + storageScore + validityPeriodScore+ singleDoseScore;
    }






    public void setAdditionalZodiacScore() {
        this.chinesePharmacopoeiaScore = (chinesePharmacopoeiaScore != null) ? chinesePharmacopoeiaScore : 0.0;
        this.patentScore = (patentScore != null) ? patentScore : 0.0;
        this.exclusiveVarietyScore = (exclusiveVarietyScore != null) ? exclusiveVarietyScore : 0.0;
        this.additionalZodiacScore =  chinesePharmacopoeiaScore + patentScore + exclusiveVarietyScore;
    }




    public void setTotalScore() {
        this.productionEnterpriseScore = (productionEnterpriseScore != null) ? productionEnterpriseScore : 0.0;
        this.ownPlantingBaseScore = (ownPlantingBaseScore != null) ? ownPlantingBaseScore : 0.0;
        this.productionEnterpriseStatusScore = productionEnterpriseScore+ownPlantingBaseScore;
        this.suitabilityScore = (suitabilityScore != null) ? suitabilityScore : 0.0;
        this.nationalTraditionalChineseMedicineProtectionScore = (nationalTraditionalChineseMedicineProtectionScore != null) ? nationalTraditionalChineseMedicineProtectionScore : 0.0;
        this.additionalZodiacScore = (additionalZodiacScore != null) ? additionalZodiacScore : 0.0;
        this.productionEnterpriseStatusScore = (productionEnterpriseStatusScore != null) ? productionEnterpriseStatusScore : 0.0;
        this.totalScore = suitabilityScore + nationalTraditionalChineseMedicineProtectionScore + additionalZodiacScore
                + productionEnterpriseStatusScore;
    }


}
