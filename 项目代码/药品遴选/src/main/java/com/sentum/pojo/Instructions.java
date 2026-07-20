package com.sentum.pojo;

import cn.hutool.core.collection.CollUtil;
import com.sentum.enums.ContentTagEnum;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.apache.commons.lang.StringUtils;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;

@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("instructions_complete")
public class Instructions {

    private String id;
    private String ref_id;
    private String source;
    private String url;
    private List<DrugContent> drugName;
    private List<DrugContent> drugNameEn;
    private List<DrugContent> communityName;
    private List<DrugContent> manufacturer;
    private List<DrugContent> manufacturerShort;
    private List<DrugContent> specifications; // 考虑根据实际结构定义为更具体的类型
    private List<DrugContent> dosageForm;
    private List<DrugContent> ingredient;
    private List<DrugContent> indications;
    private List<DrugContent> usageAndDosage;
    private List<DrugContent> pregnantWomen;
    private List<DrugContent> geriatricMedicine;
    private List<DrugContent> childrenMedicine;
    private List<DrugContent> adverseReaction;
    private List<DrugContent> notes;
    private List<DrugContent> pharmacokinetics;
    private List<DrugContent> pharmacology;
    private List<DrugContent> toxicology;
    private List<DrugContent> storage;
    private List<DrugContent> pack;
    private List<DrugContent> taboo;
    private List<DrugContent> drugInteractio;
    private List<DrugContent> characteristics;
    private List<DrugContent> approvalDate;
    private List<DrugContent> modifyDate;
    private List<DrugContent> updateDate;
    private List<DrugContent> indate;
    private List<DrugContent> warning;
    private List<DrugContent> approvalNumber;
    private List<DrugContent> otc;
    private List<DrugContent> clinicalTrial;
    private List<DrugContent> chemicalComposition;
    private List<DrugContent> takingAndEating;
    private List<DrugContent> drugAdminCls;
    private List<DrugContent> retailPrice;
    private List<DrugContent> drugPicture;
    private List<DrugContent> function;
    private List<DrugContent> mainIngredient;
    private List<DrugContent> keyIngredient;
    private List<DrugContent> healthFunction;
    private List<DrugContent> pinyin;
    private List<DrugContent> productionAddress;
    private List<DrugContent> overdose;
    private List<DrugContent> standard;
    private List<DrugContent> precautions;
    private List<DrugContent> category;
    private List<DrugContent> delegator;
    private List<DrugContent> importDrugRegNum;
    private List<DrugContent> usageIntroduction;
    private List<DrugContent> agentCompany;
    private List<DrugContent> packagingCompany;
    private List<DrugContent> pregnancyGrade;
    private List<DrugContent> lactationGrade;
    private List<DrugContent> effectCategory;
    private List<DrugContent> references;
    private List<DrugContent> effectAndUse;
    private List<DrugContent> medicalInsurance;
    private List<DrugContent> compositionAndCharacteristics;
    private List<DrugContent> immunizationProgramAndDose;
    private List<DrugContent> patientMedEdu;
    private List<DrugContent> vaccinationObject;
    private List<DrugContent> importLicenseNum;
    private List<DrugContent> radioactiveIsotopeHalfLife;
    private List<DrugContent> radioactiveActivityAndMarkingTime;
    private List<DrugContent> internalRadiationAbsorbedDose;
    private List<DrugContent> packagingAddress;
    private List<DrugContent> images;
    private String approvalNumber2;
    private String drugName2;
    private String productNameZh2;
    private String productNameEn2;
    private String manufacturer2;
    private String dosageForm2;
    private String specifications2;
    private String drugCode2;
    private String drugCodeRemarks2;
    private String firstLevelCode;
    private String firstLevelEnglish;
    private String firstLevelEnglishSynonyms;
    private String firstLevelChinese;
    private String firstLevelChineseSynonyms;
    private String secondLevelCode;
    private String secondLevelEnglish;
    private String secondLevelEnglishSynonyms;
    private String secondLevelChinese;
    private String thirdLevelCode;
    private String thirdLevelEnglish;
    private String thirdLevelEnglishSynonyms;
    private String thirdLevelChinese;
    private String thirdLevelChineseSynonyms;
    private String fourthLevelCode;
    private String fourthLevelEnglish;
    private String fourthLevelEnglishSynonyms;
    private String fourthLevelChinese;
    private String fifthLevelCode;
    private String fifthLevelEnglish;
    private String fifthLevelEnglishSynonyms;
    private String fifthLevelChinese;
    private String fifthLevelChineseSynonyms;
    private String NMPAInstructionsSynonyms;
    private String NMPAInstructionsEnglish;
    private String classAB;
    private String isPaymentRestriction;
    private String isBasicMedicine;
    private String isDeltaRequirement;
    private String isSkinTestRequired;
    private String isCentralizedPurchasingMedicine;
    private String indicationsOriginal;
    private String indicationsNew;
    private String isOriginalDrug;
    private String isConsistencyEvaluationDrug;
    private String isGenericDrugReferenceDrug;
    private String unit;
    private String unitPrice;
    private String price;
    private String conversionRatio;
    private String centralizedPurchasingMedicinePrice;
    private String specificationPackaging;
    private String singleOrCompoundPreparation;
    private List<DrugContent>  matched_images;


    public String getTxt(List<DrugContent> list){
        StringBuilder stringBuilder = new StringBuilder();
        if (CollUtil.isNotEmpty(list)) {
            for (DrugContent drugContent : list) {
                if (ContentTagEnum.TXT.getType().equals(drugContent.getTag())) {
                    stringBuilder.append(drugContent.getContent());
                    stringBuilder.append("\n");
                }
            }
//            if (stringBuilder.length() >= 2) {
//                stringBuilder.delete(stringBuilder.length() - 2, stringBuilder.length());
//            }
            return stringBuilder.toString();
        }else {
            return "";
        }
    }
    public String getTxt(String x){
        if (StringUtils.isNotEmpty(x)) {
           return x;
        }else {
            return "";
        }
    }

}
