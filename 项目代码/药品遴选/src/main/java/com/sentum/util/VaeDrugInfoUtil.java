package com.sentum.util;


import com.sentum.enums.InformationTypeEnum;
import com.sentum.pojo.DrugInfoNew;
import org.apache.commons.lang3.StringUtils;

public class VaeDrugInfoUtil {



    public static String getVaeInfo(DrugInfoNew drugInfoNew, InformationTypeEnum informationTypeEnum){

        if (informationTypeEnum == InformationTypeEnum.INSTRUCTIONS||informationTypeEnum == InformationTypeEnum.INSTRUCTIONS2){
            return drugInfoNew.getInstruction();
        }
        // if (informationTypeEnum == InformationTypeEnum.GUIDE){
        //
        // }
        // if (informationTypeEnum == InformationTypeEnum.LITERATURE){
        //
        // }
        //医保
        if (informationTypeEnum == InformationTypeEnum.MEDICAL_INSURANCE){
            StringBuilder stringBuilder = new StringBuilder();
            if (StringUtils.isNotEmpty(drugInfoNew.getMedicalInsurance())){
                stringBuilder.append("该药品属于医保").append(drugInfoNew.getMedicalInsurance()).append("类,");
                if (StringUtils.isNotEmpty(drugInfoNew.getPaymentScope())){
                    stringBuilder.append("有支付限制,").append(drugInfoNew.getPaymentScope());
                }else {
                    stringBuilder.append("无支付限制");
                }
            }else {
                stringBuilder.append("该药品不属于医保");
            }

        }
        if (informationTypeEnum == InformationTypeEnum.NATIONAL_BASE_DRUG){
            if("是".equals(drugInfoNew.getEssentialMedicines())){
                return "该药品属于国家基本药物";
            }else {
                return "该药品不属于国家基本药物";
            }

        }
        if (informationTypeEnum == InformationTypeEnum.NATIONAL_COLLECTION_DRUG){

            if ("不属于国家/联盟集中采购药品。".equals(drugInfoNew.getDrugCollection())){
                return "该药品不属于国家/联盟集中采购药品。";
            }else {
                return "该药品属于国家/联盟集中采购药品。";
            }
        }


        if (informationTypeEnum == InformationTypeEnum.SIMILAR_DRUG){

            StringBuilder stringBuilder = new StringBuilder();
            if ("是".equals(drugInfoNew.getIsProtected())){
                stringBuilder.append( "该药品属于国家保护品种");
            }else {
                stringBuilder.append( "该药品不属于国家保护品种");
            }

            if (StringUtils.isNotEmpty(drugInfoNew.getProtectionLevel())){
                stringBuilder.append(drugInfoNew.getProtectionLevel());
            }

            if (StringUtils.isNotEmpty(drugInfoNew.getProtectionPeriod())){
                stringBuilder.append(drugInfoNew.getProtectionPeriod());
            }

            if (StringUtils.isNotEmpty(drugInfoNew.getOriginalDrug())){
                stringBuilder.append(drugInfoNew.getOriginalDrug());
            }
            if (StringUtils.isNotEmpty(drugInfoNew.getReferenceDrug())){
                stringBuilder.append(drugInfoNew.getReferenceDrug());
            }

        }
        if (informationTypeEnum == InformationTypeEnum.CONSISTENCY_EVALUATION){

            if (StringUtils.isNotEmpty(drugInfoNew.getConsistencyDrug())){
                return drugInfoNew.getConsistencyDrug();
            }else {
                return "该药品无一致性评价";
            }

        }
        if (informationTypeEnum == InformationTypeEnum.OTHER){
            return "请你检索相关资料进行打分(需要保证资料可靠性)";
        }
        return "";

    }
}
