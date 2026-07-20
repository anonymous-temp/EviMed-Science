package com.sentum.enums;

import lombok.Getter;

@Getter
public enum PromptEnum {
    INSTRUCTION("instruction", "说明书"),
    ADVERSE_REACTION("adverseReaction", "不良反应"),
    PREGNANT_WOMEN_1("specialCrowd_pregnantWomen_1", "特殊人群-孕妇-有说明书内容"),
    PREGNANT_WOMEN_2("specialCrowd_pregnantWomen_2", "特殊人群-孕妇-有说明书内容"),
    CHILDREN_MEDICINE("","");


    private String key;

    private String describe;

    PromptEnum (String key,String describe){
        this.describe = describe;
        this.key = key;
    }
    public static  String PromptEnum(String key){
        PromptEnum[] values = PromptEnum.values();
        for(PromptEnum value :values){
            if(value.getKey().equals(key)){
                return value.getDescribe();
            }
        }
        return "";
    }

}
