package com.sentum.enums;

import lombok.Getter;

@Getter
public enum TraditionalPromptEnum2 {



    //组方来源
    GROUP_SOURCE("adverseReactionRating","不良反应评分","中成药${drugName}组方是来源是完" +
            "全来源古代经典名方？还是在古代经典名方基础上化裁？还是由名老中医方或医院制剂转化？还是属于研制方(若不是前三个则归为最后这个)？请说明原因。并且进行打分，完全来源古代经典名方10分，" +
            "古代经典名方基础上化裁9分，老中医方或医院制剂转化8分，研制方7分"),

    //理论支撑
    THEORY_SUPPORT1("theorySupport1","理论支撑","中成药XX中君臣药的药性、归经与治疗目标是否相符）然后再根据评分规则进行打分，最高1分，最低0分"),
    THEORY_SUPPORT2("theorySupport2","理论支撑","中成药XX中君臣药的炮制品选择与治疗目标相符）然后再根据评分规则进行打分，最高1分，最低0分"),


    //病症结合
    DISEASE_COMBINATION("diseaseCombination","病症结合","功能主治疾病、证候、症状是否描述精确？且功能主治中疾病采用西医术语进行表述？请根据评分规则给出最终分值：\n" +
            "\n" +
            "□5 功能主治中疾病、证候、症状均描述精准\n" +
            "□3 功能主治中疾病或证候或症状描述清楚\n" +
            "□+1 功能主治中疾病采用西医术语表述（加分项）"),

    //临床定位
    CLINICAL_LOCATION("clinicalLocation","临床定位","中成药${drugName}是否属于治疗呼吸类传染病或者为儿童用药？回复是或者否"),

    //








        ;

        private String key;

        private String describe;

        private String defaultPrompt;



    TraditionalPromptEnum2(String key, String describe, String defaultPrompt){
            this.describe = describe;
            this.key = key;
            this.defaultPrompt = defaultPrompt;

        }
        public static  String TraditionalPromptEnum(String key){
            PromptEnum[] values = PromptEnum.values();
            for(PromptEnum value :values){
                if(value.getKey().equals(key)){
                    return value.getDescribe();
                }
            }
            return "";
        }

    }


