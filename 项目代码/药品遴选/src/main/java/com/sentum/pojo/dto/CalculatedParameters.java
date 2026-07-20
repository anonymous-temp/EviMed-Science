package com.sentum.pojo.dto;


import lombok.Data;

@Data
public class CalculatedParameters {

    //包装
    private String packagQuantity;

    //单次用量
    private String singleDose;

    //用药频率
    private String medicationFrequency;

    //用法与用量
    private String usageAndDosage;

    //包装
    private String pack;

    //规格
    private String specifications;

    //价格
    private String price;

    //最小量规格
    private String miniQuantity;

    //计算类型    1：包装规格 2：采用大包装   3单次用量  4日均治疗费用
    private Integer type;



}
