package com.sentum.constants;

import java.util.Arrays;
import java.util.List;

/**
 * 通用常量信息
 * 
 * @author huqichen
 */
public class Constants {

    public static final String TOKEN            = "token";

    public final static String ACCESS_TOKEN     = "access_token_";

    public static final String USER_PREFIX="user_prefix";

    // 阿里平台
    public static final String QWEN3_MAX_600_PRM = "qwen3-max";
    public static final String QWEN3_MAX_2025_09_23_60_PRM = "qwen3-max-2025-09-23";
    public static final String GPT_4o_2024_11_20 = "gpt-4o-2024-11-20";
    public static final String GPT_4o = "gpt-4o";
    public static final String QWEN3_235B_A22B_INSTRUCT_2507 = "qwen3-235b-a22b-instruct-2507";
    public static final String QWEN3_MAX_2025_09_23 = "qwen3-max-2025-09-23";
    public static final String QWEN_MT_PLUS = "qwen-mt-plus";
    public static final String QWEN3_MAX = "qwen3-max";
    
    // DeepSeek 模型
    public static final String DEEPSEEK_CHAT = "deepseek-chat";
    public static final String DEEPSEEK_REASONER = "deepseek-reasoner";
    public static final String DEEPSEEK_V4_FLASH = "deepseek-v4-flash";
    public static final String DEEPSEEK_V4_PRO = "deepseek-v4-pro";
    
    // 默认模型（可全局切换）
    public static String DEFAULT_MODEL = DEEPSEEK_V4_PRO;
    
    // api 平台
    public static final String API_GEMINI_FLASH = "gemini-3-flash-preview";

    public static final List<String> REPORT_FIELDS_LIST = Arrays.asList(
            "start",
            "recipeSourceScore","recipeSourceContent",
            "theoryGuidanceScore","theoryGuidanceContent",
            "theoryCombinationScore","theoryCombinationContent",
            "theoryPathogenesisScore","theoryPathogenesisContent",
            "theoryPotScore","theoryPotContent",
            "theorySupportScore",
            "diseaseCombinationScore1","diseaseCombinationContent1",
            "diseaseCombinationScore2","diseaseCombinationContent2",
            "diseaseCombinationScore",
            "inheritanceEvaluationTotalScore",

            "clinicalPositioningScore","clinicalPositioningContent",
            "clinicalResearchScore","clinicalResearchContent",
            "evidenceRecommendationScore","evidenceRecommendationContent",
            "clinicalDemandScore",
            "clinicalDemandOption",
            "clinicalDemandContent",
            "trClinicalEvaluationTotalScore",

            "adverseReactionScore","adverseReactionContent",
            "warningNoteScore","warningNoteContent",
            "excipientScore","excipient",
            "safetyReevaluationScore","safetyReevaluationContent",
            "safetyInfoScore",
            "pediatricDrugUseScore","pediatricDrugUseContent",
            "pregnancyDrugUseScore","pregnancyDrugUseContent",
            "lactationDrugUseScore","lactationDrugUseContent",
            "liverDysfunctionDrugUseScore","liverDysfunctionDrugUseContent",
            "kidneyDysfunctionDrugUseScore","kidneyDysfunctionDrugUseContent",
            "athleteDrugUseScore","athleteDrugUseContent",
            "crowdRestrictionScore",
            "adverseReactionStratificationScore","adverseReactionStratificationContent",
            "safetyEvaluationTotalScore",
            "administrationFrequencyScore","administrationFrequencyContent",
            "packagingSpecificationScore","packagingSpecificationOption",
            "packagingSpecificationJson",
            "largePackageAdoptionScore","largePackageAdoptionOption",
            "largePackageAdoptionJson",
            "singleDoseScore","singleDoseOption",
            "singleDoseJson",
            "courseOfTreatmentScore","courseOfTreatmentContent",
            "storageScore","storageContent",
            "validityPeriodScore","validityPeriodContent",
            "suitabilityScore",

            "nationalTraditionalChineseMedicineProtectionScore","nationalTraditionalChineseMedicineProtectionContent",
            "chinesePharmacopoeiaScore","chinesePharmacopoeiaContent",
            "patentScore","patentNumber",
            "exclusiveVarietyScore","exclusiveVarietyInfo",
            "additionalZodiacScore",
            "technologyEvaluationScore",

            "marketUniquenessScore",
            "marketUniquenessOption",
            "marketUniquenessContent",
            "dailyTreatmentCostJson",
            "dailyTreatmentCostScore", "dailyTreatmentCostOption",
            "economicAdvantageScore", "economicAdvantageOption",
            "economicScore",
            "nationalEssentialDrugsRequirement", "nationalEssentialDrugsScore",
            "nationalMedicalInsuranceDrugsPaymentRequirement", "nationalMedicalInsuranceDrugsScore",
            "centralizedVolumePurchasingDrugsScore", "centralizedVolumePurchasingDrugsSource",
            "productionEnterpriseScore", "productionEnterpriseContent",
            "ownPlantingBaseScore", "ownPlantingBaseOption",
            "productionEnterpriseStatusScore",
            "policyAttributeScore",
            "marketEvaluationTotalScore",
            "end");

    public static final List<String> REPORT_FIELDS_LIST_WEST = Arrays.asList(
            "start",
            "pharmacologyScore", "pharmacology",
            "pharmacokineticsScore", "pharmacokinetics",
            "componentScore", "component",
            "packageScore", "package",
            "dosageFormScore", "dosageForm",
            "doseScore", "dose",
            "drugFrequencyScore", "drugFrequency",
            "convenienceScore", "convenience",
            "usageAndDosageScore",
            "storageScore", "storage",
            "indateScore", "indate",
            "characteristicScore",
            
            "indicationScore", "indication",
            "guideScore", "guide",
            "effectivenessScore", "effectiveness",
            "effectiveScore",
            
            "mildAdverseReactionScore", "mildAdverseReaction",
            "severeAdverseReactionScore", "severeAdverseReaction",
            "AdverseReactionScore",
            "childrenMedicineScore", "childrenMedicine",
            "geriatricMedicineScore", "geriatricMedicine",
            "pregnantWomenScore", "pregnantWomen",
            "lactationScore", "lactation",
            "liverScore", "liver",
            "renalScore", "renal",
            "specialCrowdScore",
            "drugInteractionScore", "drugInteraction",
            "reversibleReactionScore", "reversibleReaction",
            "genicityAdverseReactionScore", "genicityAdverseReaction",
            "alertAdverseReactionScore", "alertAdverseReaction",
            "otherSafetyScore",
            "safetyScore",

            "isInsuranceScore", "isInsurance",
            "isBaseScore", "isBase",
            "isConcentrateScore", "isConcentrate",
            "guideDrugSituationScore", "guideDrugSituation",
            "guideEnterpriseScore", "guideEnterprise",
            "guideCountryScore",
            "guideCountryScore1", "guideCountry1",
            "guideCountryScore2", "guideCountry2",
            "otherScore",
            "end");
}



