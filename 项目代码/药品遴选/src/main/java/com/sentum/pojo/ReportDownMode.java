package com.sentum.pojo;


import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

import java.util.List;

@Data
public class ReportDownMode {

    private String packageScore;
    private String otherSafetyScore;
    private String singleQuantity;
    private String characteristicScore;
    private String AdverseReactionScore;
    private String alertAdverseReactionScore;
    private String replaceableSingleQuantity;
    private String guideEnterprise;
    private String guideCountryScore;
    private String singleQuantitynum;
    private String recommendation;
    private String convenience;
    private String reversibleReaction;
    private String frequency;
    private String geriatricMedicine;
    private String otherScore;
    private String doseScore;
    private String renalScore;
    private String price;
    private String pharmacology;
    private String storageScore;
    private String replaceablePrice;
    private String drugInteractionScore;
    private List<Guide> guide;
    private String effectiveScore;
    private String dosageFormScore;
    private String drugInfo;
    private String replaceableSingleQuantitynum;
    private String alternativeDrugName;
    @JsonProperty("package")
    private String packageName;
    private String liver;
    private String dosageForm;
    private String replaceableFrequency;
    private String indateScore;
    private String guideDrugSituationScore;
    private String usageAndDosageScore;
    private String economic1;
    private String economic2;
    private String alternativePrice;
    private String dose;
    private String geriatricMedicineScore;
    private String isConcentrateScore;
    private String replaceableDrug;
    private String lactation;
    private String drugName;
    private String alternativeSingleQuantity;
    private String indate;
    private String indication;
    private String isBase;
    private String drugFrequency;
    private String status;
    private String convenienceScore;
    private String guideScore;
    private boolean succeedtype;
    private String specialCrowdScore;
    private String lactationScore;
    private String reversibleReactionScore;
    private String isInsurance;
    private String storage;
    private String childrenMedicine;
    private String title;
    private String effectivenessScore;
    private String guideDrugSituation;
    private String alternativeFrequency;
    private String genicityAdverseReaction;
    private String indicationScore;
    private String AdverseReaction;
    //中度不良反应
    private String mildAdverseReactionScore;
    private String  mildAdverseReaction;


    //重度不良反应;
    private String severeAdverseReactionScore;
    private String severeAdverseReaction;


    private String pharmacokinetics;
    private String safetyScore;
    private String liverScore;
    private String economicScore;
    private String isConcentrate;
    private String effectiveness;
    private String disease;
    private String alternativeSingleQuantitynum;
    private String reportId;
    private String guideEnterpriseScore;
    private String componentScore;
    private String isInsuranceScore;
    private String pregnantWomen;
    private String totalScore;
    private String pharmacologyScore;
    private String renal;
    private String pregnantWomenScore;
    private String component;
    private String alertAdverseReaction;
    private String genicityAdverseReactionScore;
    private String childrenMedicineScore;
    private String drugFrequencyScore;
    private String drugId;
    private String guideCountry1;
    private String guideCountry2;
    private String drugInteraction;
    private String pharmacokineticsScore;
    private String isBaseScore;
    private String simpleTitle;

    // 内部类 Guide
    @Data
    public static class Guide {
        private String title;
        private String content;

        public String getTitle() {
            return title;
        }

        public void setTitle(String title) {
            this.title = title;
        }

        public String getContent() {
            return content;
        }

        public void setContent(String content) {
            this.content = content;
        }
    }
}
