package com.sentum.enums;

import lombok.Getter;

@Getter
public enum InformationTypeEnum {


    //说明书
    INSTRUCTIONS( "1", "说明书"),
    INSTRUCTIONS2( "1", "药品说明书"),



    //指南
    GUIDE( "2", "指南"),
    //文献
    LITERATURE( "3", "文献"),
    //医保
    MEDICAL_INSURANCE( "4", "医保目录（2024）"),
    //国家基药
    NATIONAL_BASE_DRUG( "5", "基药目录（2018）"),
    //国家集采
    NATIONAL_COLLECTION_DRUG( "6", "集采目录"),


    SIMILAR_DRUG( "9", "CDE"),
    //一致性评价
    CONSISTENCY_EVALUATION( "10", "CDE"),
    //其他
    OTHER( "11", "其他"),

    ;


    private String type;

    private String describe;


    InformationTypeEnum(String number, String name) {
        // 确保type字段被正确初始化
        this.type = number; // 或根据实际需要设置
        this.describe = name; // 确保describe也被初始化
    }

    //获取枚举
    public static InformationTypeEnum getInformationTypeEnum(String describe) {
        for (InformationTypeEnum value : values()) {
            if (value.describe.equals(describe)) {
                return value;
            }
        }
        return null;
    }


}
