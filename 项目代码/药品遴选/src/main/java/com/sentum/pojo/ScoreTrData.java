package com.sentum.pojo;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.sentum.pojo.dto.TrClinicalEvaluationDto;
import lombok.Data;

import java.util.ArrayList;
import java.util.List;

@Data
public class ScoreTrData {


    private String inheritanceEvaluationTotalScore ;

    private String price;
    // 组方来源得分
    private String recipeSourceScore;
    // 理论支撑得分
    private String theorySupportScore;
    //理论支持-理论指导
    private String theoryGuidanceScore;
    //  理论支持-君臣佐使配伍
    private String theoryCombinationScore;
    //理论支持-药性、归经与治疗目标
    private String theoryPathogenesisScore;
    //理论支持-炮制品是否与治疗目标相符
    private String theoryPotScore;
    // 病症结合得分
    private String diseaseCombinationScore;
    //病症结合描述
    private String diseaseCombinationScore1;
    //病症结合西医术语描述
    private String diseaseCombinationScore2;





    private String trClinicalEvaluationTotalScore;
    //临床定位
    private String clinicalPositioningScore;
    // 临床研究得分
    private String clinicalResearchScore;
    // 证据推荐得分
    private String evidenceRecommendationScore;
    // 临床需求得分
    private String clinicalDemandScore;





    private String safetyEvaluationTotalScore;
    // 安全信息评价得分
    private String safetyInfoScore;
    // 不良反应、禁忌等描述得分
    private String adverseReactionScore;
    // 不良反应、禁忌等描述内容
    private String adverseReactionContent;
    // 说明书中警示语或注意事项得分
    private String warningNoteScore;
    // 说明书中警示语或注意事项内容
    private String warningNoteContent;
    // 辅料得分
    private String excipientScore;
    private String excipient;
    // 安全性再评价得分
    private String safetyReevaluationScore;
    // 安全性再评价内容
    private String safetyReevaluationContent;
    //人群限制得分
    private String crowdRestrictionScore;
    // 儿童用药得分
    private String pediatricDrugUseScore;
    // 妊娠期妇女用药得分
    private String pregnancyDrugUseScore;
    // 哺乳期妇女用药得分
    private String lactationDrugUseScore;
    // 肝功能异常者用药得分
    private String liverDysfunctionDrugUseScore;
    // 肾功能异常者用药得分
    private String kidneyDysfunctionDrugUseScore;
    // 运动员用药得分
    private String athleteDrugUseScore;
    // 不良反应分层得分
    private String adverseReactionStratificationScore;


    private String technologyEvaluationScore;
    // 适宜性得分
    private String suitabilityScore;
    // 给药频次得分
    private String administrationFrequencyScore;
    // 包装规格得分
    private String packagingSpecificationScore;
    // 采用大包装得分
    private String largePackageAdoptionScore;
    // 单次用量得分
    private String singleDoseScore;
    // 疗程得分
    private String courseOfTreatmentScore;
    // 贮藏得分
    private String storageScore;
    // 有效期得分
    private String validityPeriodScore;
    // 国家中药保护品种得分
    private String nationalTraditionalChineseMedicineProtectionScore;
    // 中国药典得分
    private String chinesePharmacopoeiaScore;
    // 专利得分
    private String patentScore;
    // 独家品种得分
    private String exclusiveVarietyScore;
    //附加属相得分
    private String additionalZodiacScore;
    // 生产企业状况zong得分
    private String productionEnterpriseStatusScore;
    //企业生产情况得分
    private String productionEnterpriseScore;
    //是否有自己的种植基地
    private String ownPlantingBaseScore;



    private String marketEvaluationTotalScore;
    // 市场独特性得分
    private String marketUniquenessScore;
    // 经济性得分
    private String economicScore;
    //日均治疗费用得分
    private String dailyTreatmentCostScore;
    // 经济性优势得分
    private String economicAdvantageScore;
    // 政策属性得分
    private String policyAttributeScore;
    // 国家基本药物得分
    private String nationalEssentialDrugsScore;
    // 国家医保药品得分
    private String nationalMedicalInsuranceDrugsScore;
    // 集中带量采购药品或国家谈判品种（协议期内）得分
    private String centralizedVolumePurchasingDrugsScore;

    
    private String totalScore;
    private String drugInfo;
    private String reportId;

    public void setTotalScore(){
        //其他项转String计算总和
        this.totalScore = String.valueOf(Double.parseDouble(this.inheritanceEvaluationTotalScore) + Double.parseDouble(this.trClinicalEvaluationTotalScore) + Double.parseDouble(this.safetyEvaluationTotalScore) + Double.parseDouble(this.technologyEvaluationScore) + Double.parseDouble(this.marketEvaluationTotalScore));
    }


}
