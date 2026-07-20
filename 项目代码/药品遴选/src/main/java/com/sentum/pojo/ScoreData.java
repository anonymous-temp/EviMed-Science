package com.sentum.pojo;

import com.alibaba.excel.annotation.ExcelProperty;
import com.sentum.excel.bean.MedicineWmEvaluation;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.text.DecimalFormat;
import java.util.regex.Matcher;
import java.util.regex.Pattern;


@Data
@AllArgsConstructor
@NoArgsConstructor
public class ScoreData {
    private String characteristicScore;
    private String effectiveScore;
    private String safetyScore;
    private String economicScore;
    private String economicScore1;
    private String economicScore2;
    private String otherScore;
    private String totalScore;
    private String reportId;
    private String drugInfo;
    private String price;
    private MedicineWmEvaluation scoreInfo;






        private String pharmacologyScore;


        private String pharmacokineticsScore;


        private String componentScore;


        private String packageScore;


        private String dosageFormScore;


        private String doseScore;


        private String drugFrequencyScore;


        private String convenienceScore;


        private String storageScore;


        private String indateScore;


        private String indicationScore;


        private String guideScore;


        private String effectivenessScore;


        private String mildAdverseReactionScore;


        private String severeAdverseReactionScore;


        private String childrenMedicineScore;


        private String geriatricMedicineScore;


        private String pregnantWomenScore;


        private String lactationScore;


        private String liverScore;


        private String renalScore;


        private String noDoseAdjustmentRequired;


        private String doseAdjustmentRequired;


        private String prohibitedConcurrentUse;


        private String reversibleReactionScore;


        private String genicityAdverseReactionScore;


        private String alertAdverseReactionScore;



        private String isInsuranceScore;

        private String isInsuranceScore1;


        private String isInsuranceScore2;


        private String isInsuranceScore3;


        private String isInsuranceScore4;


        private String isInsuranceScore5;

        private String isBaseScore;


        private String isBaseScore1;


        private String isBaseScore2;


        private String isBaseScore3;


        private String isConcentrateScore;


        private String guideDrugSituationScore;


        private String guideEnterpriseScore;


        private String guideCountryScore;

        private String guideCountryScore1;

        private String guideCountryScore2;

        private String listingStatus;


        private String salesStatus;

        private String drugInteractionScore;





    public void setTotalScore() {
        //检验除总分外其他字段，如果是空或者不是个数字则赋值为0

        if(characteristicScore==null||characteristicScore.equals("")){
            characteristicScore="0";
        }
        if(effectiveScore==null||effectiveScore.equals("")){
            effectiveScore="0";
        }

        if(safetyScore==null||safetyScore.equals("")){
            safetyScore="0";
        }
        if(economicScore==null||economicScore.equals("")){
            economicScore="0";
        }
        if(otherScore==null||otherScore.equals("")){
            otherScore="0";
        }

        //其他所有的分数相加
        this.totalScore =formatScore( Double.parseDouble(characteristicScore)+Double.parseDouble(effectiveScore)+Double.parseDouble(safetyScore)+Double.parseDouble(economicScore)+Double.parseDouble(otherScore)+"");
    }
    public static double extractLastNumber(String input) {
        if (input == null || input.isEmpty()) {
            return 0.0;
        }

        // 定义正则表达式，匹配一个或多个数字（包括小数）
        String regex = "\\d+(\\.\\d+)?";
        Pattern pattern = Pattern.compile(regex);
        Matcher matcher = pattern.matcher(input);

        String lastNumber = null;
        // 查找所有匹配的数字
        while (matcher.find()) {
            lastNumber = matcher.group();
        }

        // 返回最后一个匹配的数字，若无匹配则返回0.0
        return lastNumber != null ? Double.parseDouble(lastNumber) : 0.0;
    }

    private String formatScore(String score) {
        //(1) 得分为整数的，直接显示分值，数值后不需要.00。如15;
        //(2) 得分为非整数的，请保留小数点后两位有效数字。
        double number = 0;
        try {
            number = Double.parseDouble(score);
        } catch (NumberFormatException e) {

            number = extractLastNumber(score);

        }

        if (number % 1 == 0) { // 判断是否为整数
            return new DecimalFormat("#").format(number);
        } else {
            return new DecimalFormat("#.##").format(number);
        }
    }
}


