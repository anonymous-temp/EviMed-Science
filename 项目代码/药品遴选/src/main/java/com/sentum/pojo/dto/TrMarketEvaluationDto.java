package com.sentum.pojo.dto;

import lombok.Data;

@Data
public class TrMarketEvaluationDto {

    // 市场评价总得分
    private Double totalScore;
    // 市场独特性得分
    private Double marketUniquenessScore;
    // 市场独特性选项
    private String marketUniquenessOption;
    // 市场独特性内容
    private String marketUniquenessContent;
    // 经济性得分
    private Double economicScore;
    // 经济性选项
    private String economicOption;
    //日均治疗费用选项
    private String dailyTreatmentCostOption;
    //日均治疗费用得分
    private Double dailyTreatmentCostScore;
    //经济学优势选项
    private Object economicAdvantageOption;
    // 经济性优势得分
    private Double economicAdvantageScore;
    // 政策属性得分
    private Double policyAttributeScore;
    // 国家基本药物得分
    private Double nationalEssentialDrugsScore;
    // 国家基本药物要求
    private String nationalEssentialDrugsRequirement;
    // 国家医保药品得分
    private Double nationalMedicalInsuranceDrugsScore;
    // 国家医保药品支付要求
    private String nationalMedicalInsuranceDrugsPaymentRequirement;
    // 集中带量采购药品或国家谈判品种（协议期内）得分
    private Double centralizedVolumePurchasingDrugsScore;
    // 集中带量采购药品或国家谈判品种（协议期内）来源
    private String centralizedVolumePurchasingDrugsSource;


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



    //经济学优势得分
    public void setEconomicScore() {
        this.dailyTreatmentCostScore = (dailyTreatmentCostScore != null) ? dailyTreatmentCostScore : 0.0;
        this.economicAdvantageScore = (economicAdvantageScore != null) ? economicAdvantageScore : 0.0;
        this.economicScore = dailyTreatmentCostScore+economicAdvantageScore;
    }


    //政策属相总分
    public void setPolicyAttributeScore() {
        this.nationalEssentialDrugsScore = (nationalEssentialDrugsScore != null) ? nationalEssentialDrugsScore : 0.0;
        this.nationalMedicalInsuranceDrugsScore = (nationalMedicalInsuranceDrugsScore != null) ? nationalMedicalInsuranceDrugsScore : 0.0;
        this.centralizedVolumePurchasingDrugsScore = (centralizedVolumePurchasingDrugsScore != null) ? centralizedVolumePurchasingDrugsScore : 0.0;
        this.policyAttributeScore = nationalEssentialDrugsScore + nationalMedicalInsuranceDrugsScore + centralizedVolumePurchasingDrugsScore;
    }

    public void setProductionEnterpriseStatusScore() {
        this.productionEnterpriseScore = (productionEnterpriseScore != null) ? productionEnterpriseScore : 0.0;
        this.ownPlantingBaseScore = (ownPlantingBaseScore != null) ? ownPlantingBaseScore : 0.0;
        this.productionEnterpriseStatusScore = productionEnterpriseScore + ownPlantingBaseScore;
    }


    public void setTotalScore() {
        this.marketUniquenessScore = (marketUniquenessScore != null) ? marketUniquenessScore : 0.0;
        this.economicScore = (economicScore != null) ? economicScore : 0.0;
        this.policyAttributeScore = (policyAttributeScore != null) ? policyAttributeScore : 0.0;
        this.productionEnterpriseStatusScore = (productionEnterpriseStatusScore != null) ? productionEnterpriseStatusScore : 0.0;
        this.totalScore = marketUniquenessScore + economicScore  + policyAttributeScore+productionEnterpriseStatusScore;
    }
}
