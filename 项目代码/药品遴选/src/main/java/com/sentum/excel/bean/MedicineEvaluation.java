package com.sentum.excel.bean;

import com.alibaba.excel.annotation.ExcelProperty;
import lombok.Data;

import java.io.Serializable;

@Data
public class MedicineEvaluation implements Serializable {

    // 基础信息
    @ExcelProperty("序号")
    private String serialNumber;

    @ExcelProperty("日期")
    private String date;

    @ExcelProperty("通用名")
    private String commonName;

    @ExcelProperty("规格")
    private String specification;

    @ExcelProperty("厂家")
    private String manufacturer;

    @ExcelProperty("单价（元）")
    private String price;

    @ExcelProperty("总分\n")
    private String totalScore;

    // 传承评价22
    @ExcelProperty({"传承评价22", "组方\n来源10"})
    private String recipeSourceScore;

    @ExcelProperty({"传承评价22", "理论支撑6", "中医药\n理论指导2"})
    private String theoryGuidanceScore;

    @ExcelProperty({"传承评价22", "理论支撑6", "遵循君臣\n佐使配伍2"})
    private String theoryCombinationScore;

    @ExcelProperty({"传承评价22", "理论支撑6", "药性\n归经相符1"})
    private String theoryPathogenesisScore;

    @ExcelProperty({"传承评价22", "理论支撑6", "炮制品\n选择1"})
    private String theoryPotScore;

    @ExcelProperty({"传承评价22", "病证结合6", "病证症描\n述精准5"})
    private String diseaseCombinationScore;

    @ExcelProperty({"传承评价22", "病证结合6", "病或证或症状清楚3"})
    private String diseaseCombinationScore1;

    @ExcelProperty({"传承评价22", "病证结合6", "联用西医术语\n1"})
    private String diseaseCombinationScore2;

    // 临床评价25
    @ExcelProperty({"临床评价25", "临床\n定位5"})
    private String clinicalPositioningScore;

    @ExcelProperty({"临床评价25", "临床研究5"})
    private String clinicalResearchScore;

    @ExcelProperty({"临床评价25", "证据推\n荐10"})
    private String evidenceRecommendationScore;

    @ExcelProperty({"临床评价25", "临床\n需求5"})
    private String clinicalDemandScore;

//    // 安全评价20
//    @ExcelProperty({"安全评价20", "安全信息评价\n8"})
//    private String safetyInfoScore;

    @ExcelProperty({"安全评价20", "安全信息评价\n8", "不良反应、禁忌等描述清晰2"})
    private String adverseReactionScore;

    @ExcelProperty({"安全评价20", "安全信息评价\n8", "警示语或注意事项等清楚2"})
    private String warningNoteScore;

    @ExcelProperty({"安全评价20", "安全信息评价\n8", "辅料\n明确1"})
    private String excipientScore;

    @ExcelProperty({"安全评价20", "安全信息评价\n8", "安全性\n再评价\n3"})
    private String safetyReevaluationScore;

    @ExcelProperty({"安全评价20", "人群限制\n7", "儿童2"})
    private String pediatricDrugUseScore;

    @ExcelProperty({"安全评价20", "人群限制\n7", "妊娠期1"})
    private String pregnancyDrugUseScore;

    @ExcelProperty({"安全评价20", "人群限制\n7", "哺乳期1"})
    private String lactationDrugUseScore;

    @ExcelProperty({"安全评价20", "人群限制\n7", "肝功\n异常\n1"})
    private String liverDysfunctionDrugUseScore;

    @ExcelProperty({"安全评价20", "人群限制\n7", "肾功\n异常\n1"})
    private String kidneyDysfunctionDrugUseScore;

    @ExcelProperty({"安全评价20", "人群限制\n7", "运动员1"})
    private String athleteDrugUseScore;

    @ExcelProperty({"安全评价20", "不良\n反应\n分级5"})
    private String adverseReactionStratificationScore;

    // 技术评价14
    @ExcelProperty({"技术评价14", "适宜性\n8", "给药\n频次2"})
    private String administrationFrequencyScore;

    @ExcelProperty({"技术评价14", "适宜性\n8", "包装量与日剂量1"})
    private String packagingSpecificationScore;

    @ExcelProperty({"技术评价14", "适宜性\n8", "大包装1"})
    private String largePackageAdoptionScore;

    @ExcelProperty({"技术评价14", "适宜性\n8", "单次用量\n与规格1"})
    private String singleDoseScore;

    @ExcelProperty({"技术评价14", "适宜性\n8", "疗程\n明确1"})
    private String courseOfTreatmentScore;

    @ExcelProperty({"技术评价14", "适宜性\n8", "贮藏条件1"})
    private String storageScore;

    @ExcelProperty({"技术评价14", "适宜性\n8", "有效期1"})
    private String validityPeriodScore;

    @ExcelProperty({"技术评价14", "国家中药保护品种3","保护品种3"})
    private String nationalTraditionalChineseMedicineProtectionScore;

    @ExcelProperty({"技术评价14", "国家中药保护品种3", "过保品种2"})
    private String nationalTraditionalChineseMedicineProtectionScore2;

    @ExcelProperty({"技术评价14", "国家中药保护品种3", "非保护品种1"})
    private String nationalTraditionalChineseMedicineProtectionScore1;

    @ExcelProperty({"技术评价14", "附加属性3", "中国药典得分1"})
    private String chinesePharmacopoeiaScore;

    @ExcelProperty({"技术评价14", "附加属性3", "专利得分1"})
    private String patentScore;

    @ExcelProperty({"技术评价14", "附加属性3", "独家品种得分1"})
    private String exclusiveVarietyScore;




//    @ExcelProperty({"技术评价14", "附加属性3"})
//    private String additionalZodiacScore;

    // 市场评价
    @ExcelProperty({"市场评价19", "市场独\n特性3"})
    private String marketUniquenessScore;

    @ExcelProperty({"市场评价19", "经济性（与同类中成药相比）5", "日均费\n用较低3"})
    private String dailyTreatmentCostScore;

    @ExcelProperty({"市场评价19", "经济性（与同类中成药相比）5", "经济学\n优势2"})
    private String economicAdvantageScore;

    @ExcelProperty({"市场评价19", "政策属性\n7", "基本\n药物3"})
    private String nationalEssentialDrugsScore;

    @ExcelProperty({"市场评价19", "政策属性\n7", "医保目\n录收载3"})
    private String nationalMedicalInsuranceDrugsScore;

    @ExcelProperty({"市场评价19", "政策属性\n7", "集采或\n国谈1"})
    private String centralizedVolumePurchasingDrugsScore;

    @ExcelProperty({"市场评价19", "生产企业\n状况4", "工信部百强榜/老字号品牌3"})
    private String productionEnterpriseScore;

    @ExcelProperty({"市场评价19", "生产企业\n状况4", "种植基地或质量追溯1"})
    private String ownPlantingBaseScore;



//    @ExcelProperty("调入/\n调出")
//    private String transfer;

//    @ExcelProperty("评价人")
//    private String evaluator;

    // 总分计算方法


}