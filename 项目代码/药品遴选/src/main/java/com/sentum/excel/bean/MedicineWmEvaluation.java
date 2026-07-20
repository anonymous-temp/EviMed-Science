package com.sentum.excel.bean;


import com.alibaba.excel.annotation.ExcelIgnoreUnannotated;
import com.alibaba.excel.annotation.ExcelProperty;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;

import java.io.Serializable;
import java.text.SimpleDateFormat;
import java.util.Date;

@Slf4j
@Data
@ExcelIgnoreUnannotated
public class MedicineWmEvaluation implements Serializable {

    @ExcelProperty("序号")
    private String serialNumber;

    @ExcelProperty("日期")
    private String date;

    @ExcelProperty("通用名")
    private String genericName;

    @ExcelProperty("规格")
    private String specification;

    @ExcelProperty("厂家")
    private String manufacturer;

    @ExcelProperty("单价（元）")
    private String price;

    @ExcelProperty("总分\n")
    private String totalScore;

    @ExcelProperty({"药学特性28", "药理作用5"})
    private String pharmacologyScore;

    @ExcelProperty({"药学特性28", "体内过程5"})
    private String pharmacokineticsScore;

    @ExcelProperty({"药学特性28", "药剂学和使用方法12", "主要成分与辅料2"})
    private String componentScore;

    @ExcelProperty({"药学特性28", "药剂学和使用方法12", "规格与包装2"})
    private String packageScore;

    @ExcelProperty({"药学特性28", "药剂学和使用方法12", "剂型2"})
    private String dosageFormScore;

    @ExcelProperty({"药学特性28", "药剂学和使用方法12", "给药剂量2"})
    private String doseScore;

    @ExcelProperty({"药学特性28", "药剂学和使用方法12", "给药频次2"})
    private String drugFrequencyScore;

    @ExcelProperty({"药学特性28", "药剂学和使用方法12", "使用方便2"})
    private String convenienceScore;

    @ExcelProperty({"药学特性28", "贮藏条件4"})
    private String storageScore;

    @ExcelProperty({"药学特性28", "有效期2"})
    private String indateScore;

    @ExcelProperty({"有效性27", "适应症5"})
    private String indicationScore;

    @ExcelProperty({"有效性27", "指南推荐12"})
    private String guideScore;

    @ExcelProperty({"有效性27", "临床疗效10"})
    private String effectivenessScore;

    @ExcelProperty({"安全性25", "不良反应8", "中度不良反应3"})
    private String mildAdverseReactionScore;

    @ExcelProperty({"安全性25", "不良反应8", "重度不良反应5"})
    private String severeAdverseReactionScore;

    @ExcelProperty({"安全性25", "特殊人群11", "儿童可用2"})
    private String childrenMedicineScore;

    @ExcelProperty({"安全性25", "特殊人群11", "老人可用1"})
    private String geriatricMedicineScore;

    @ExcelProperty({"安全性25", "特殊人群11", "妊娠期可用1"})
    private String pregnantWomenScore;

    @ExcelProperty({"安全性25", "特殊人群11", "哺乳期可用1"})
    private String lactationScore;

    @ExcelProperty({"安全性25", "特殊人群11", "肝功异常可用3"})
    private String liverScore;

    @ExcelProperty({"安全性25", "特殊人群11", "肾功异常可用3"})
    private String renalScore;

    //相互作用
    private String drugInteractionScore;

    private void setDrugInteractionScore() {
        try {
            prohibitedConcurrentUse = "0";
            doseAdjustmentRequired = "0";
            noDoseAdjustmentRequired = "0";

            int score = Integer.parseInt(drugInteractionScore);
            switch(score) {
                case 1:
                    prohibitedConcurrentUse = "1";
                    break;
                case 2:
                    doseAdjustmentRequired = "2";
                    break;
                case 3:
                    noDoseAdjustmentRequired = "3";
                    break;
                default:
                    log.warn("Unexpected drugInteractionScore: {}", score);
            }
        } catch (NumberFormatException e) {
            log.error("Invalid drugInteractionScore: {}", drugInteractionScore, e);
        } catch (Exception e) {
            log.error("Unexpected error in setDrugInteractionScore", e);
        }
    }


    @ExcelProperty({"安全性25", "药物相互作用所致不良反应3", "无需调整用药剂量3"})
    private String noDoseAdjustmentRequired;

    @ExcelProperty({"安全性25", "药物相互作用所致不良反应3", "需要调整用药剂量2"})
    private String doseAdjustmentRequired;

    @ExcelProperty({"安全性25", "药物相互作用所致不良反应3", "禁止在同一时段使用1"})
    private String prohibitedConcurrentUse;

    @ExcelProperty({"安全性25", "其他3", "不良反应可逆性1"})
    private String reversibleReactionScore;

    @ExcelProperty({"安全性25", "其他3", "致畸、致癌1"})
    private String genicityAdverseReactionScore;

    @ExcelProperty({"安全性25", "其他3", "特别用药警示1"})
    private String alertAdverseReactionScore;


    @ExcelProperty({"经济性10", "同通用名药品3"})
    private String economicScore1;

    @ExcelProperty({"经济性10", "主要适应证可替代药品7"})
    private String economicScore2;


    private String isInsuranceScore;
    @ExcelProperty({"其他属性10", "国家医保3", "国家医保甲类，没有支付限制条件3"})
    private String isInsuranceScore1;

    @ExcelProperty({"其他属性10", "国家医保3", "国家医保甲类，有支付限制条件2.5"})
    private String isInsuranceScore2;

    @ExcelProperty({"其他属性10", "国家医保3", "国家医保乙类，没有支付限制条件2"})
    private String isInsuranceScore3;

    @ExcelProperty({"其他属性10", "国家医保3", "国家医保乙类，有支付限制条件1.5"})
    private String isInsuranceScore4;

    @ExcelProperty({"其他属性10", "国家医保3", "不在国家医保目录1"})
    private String isInsuranceScore5;

    private void setInsuranceScore() {
        try {

            isInsuranceScore1 = "0";
            isInsuranceScore2 = "0";
            isInsuranceScore3 = "0";
            isInsuranceScore4 = "0";
            isInsuranceScore5 = "0";

            double score = Double.parseDouble(isInsuranceScore);


            if (score == 3) {
                isInsuranceScore1 = "3"; // 国家医保甲类，没有支付限制条件
            } else if (score == 2) {
                isInsuranceScore3 = "2"; // 国家医保乙类，没有支付限制条件
            } else if (score == 1) {
                isInsuranceScore5 = "1"; // 不在国家医保目录
            } else if (score == 2.5) { // 处理 score 为 2.5 的情况
                isInsuranceScore2 = "2.5"; // 国家医保甲类，有支付限制条件
            } else if (score == 1.5) { // 处理 score 为 1.5 的情况
                isInsuranceScore4 = "1.5"; // 国家医保乙类，有支付限制条件
            } else {
                log.warn("Unexpected insurance score: {}", score);
            }
        } catch (NumberFormatException e) {
            log.error("Invalid isInsuranceScore: {}", isInsuranceScore, e);
        } catch (Exception e) {
            log.error("Unexpected error in setInsuranceScore", e);
        }

    }



    private void setBaseDrugScore() {
        try {
            isBaseScore1 = "0";
            isBaseScore2 = "0";
            isBaseScore3 = "0";
            double score = Double.parseDouble(isBaseScore);
            switch ((int) Math.round(score)) {
                case 3:
                    isBaseScore1 = "3"; // 国家基本药物，没有△要求
                    isBaseScore2 = "0";
                    isBaseScore3 = "0";
                    break;
                case 2:
                    isBaseScore2 = "2"; // 国家基本药物，有△要求
                    isBaseScore1 = "0";
                    isBaseScore3 = "0";
                    break;
                case 1:
                    isBaseScore3 = "1"; // 不在国家基本药物目录
                    isBaseScore1 = "0";
                    isBaseScore2 = "0";
                    break;
                default:
                    log.warn("Unexpected base drug score: {}", score);
            }
        } catch (NumberFormatException e) {
            log.error("Invalid isBaseScore: {}", isBaseScore, e);
        } catch (Exception e) {
            log.error("Unexpected error in setBaseDrugScore", e);
        }
    }



    public void setAll(){
        setBaseDrugScore();
        setInsuranceScore();
        setDrugInteractionScore();
        formatDate();
       setGuideCountry();
    }

    private void formatDate() {
        try {
            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
            this.date = sdf.format(new Date());
        } catch (Exception e) {
            log.error("Error formatting date: {}", this.date, e);
        }
    }

    private String isBaseScore;

    @ExcelProperty({"其他属性10", "国家基本药物3", "国家基本药物，没有△要求3"})
    private String isBaseScore1;

    @ExcelProperty({"其他属性10", "国家基本药物3", "国家基本药物，有△要求2"})
    private String isBaseScore2;

    @ExcelProperty({"其他属性10", "国家基本药物3", "不在国家基本药物目录1"})
    private String isBaseScore3;

    @ExcelProperty({"其他属性10", "国家集中采购1"})
    private String isConcentrateScore;

    @ExcelProperty({"其他属性10", "原研/参比/一致性评价1"})
    private String guideDrugSituationScore;

    @ExcelProperty({"其他属性10", "生产企业状况1"})
    private String guideEnterpriseScore;



    @ExcelProperty({"其他属性10", "全球使用情况1", "上市情况1"})
    private String listingStatus;

    @ExcelProperty({"其他属性10", "全球使用情况1", "销售情况0.5"})
    private String salesStatus;

    private String guideCountryScore;

    private void setGuideCountry(){
        try {
            double roundedScore = Double.parseDouble(guideCountryScore);

            listingStatus = "0";
            salesStatus = "0";

            if (roundedScore == 1) {
                listingStatus = "1"; // 国家基本药物，没有△要求
                salesStatus = "0";
            } else if (roundedScore == 0.5) {
                salesStatus = "0.5"; // 国家基本药物，有△要求
                listingStatus = "0";
            } else {
                log.warn("Unexpected base drug score: {}", roundedScore);
            }
        } catch (NumberFormatException e) {
            log.error("Invalid guideCountryScore: {}", guideCountryScore, e);
        } catch (Exception e) {
            log.error("Unexpected error in guideCountryScore", e);
        }

    }

}