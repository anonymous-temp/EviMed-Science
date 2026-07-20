package com.sentum.pojo;


import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

/**
 * 最后遴选评价条件的整合
 */
@Data
public class DrugToModel {

    /**
     * 药品名称
     */
    private String  drugName;

    /**
     * 疾病名称
     */
    private String disease;

    /**
     * 孕妇
     */
    private String pregnantWomen;
    /**
     * 儿童
     */
    private String childrenMedicine;
    /**
     * 老年
     */
    private String geriatricMedicine;

    /**
     * 用法
     */
    private String usageAndDosage;

    /**
     * 注意事项
     */
    private String notes;

    /**
     * 药物相互作用
     */
    private String drugInteraction;
    /**
     * 原研药
     */
    private String originalDrug;
    /**
     * 参考药
     */
    private String referenceDrug;
    /**
     * 一致性用药
     */
    private String consistencyDrug;

    /**
     * 药品规格
     */
    private String specifications;
    /**
     * 剂型
     */
    private String dosageForm;
    /**
     * 商品中文
     */
    private String communityNameZh;

    /**
     * 五级英文
     */
    private String drugEn;

    /**
     * 适应症
     */
    private String indication;


    /**
     * 药理作用
     */
    private String pharmacology;
    /**
     * 药代动力学
     */
    private String pharmacokinetics;
    /**
     * 药品给药剂量
     */
    private String dosageAdministered;
    /**
     * 给药频次
     */
    private String dosageFrequency;
    /**
     * 贮藏
     */
    private String storage;
    /**
     * 有效期
     */
    private String indate;

    /**
     * 不良反应
     */
    private String moderateAdverseReaction;

    /**
     * 重度不良反应
     */
    private String severeAdverseReaction;


    private String manufacturer;

    private String communityNameEn;

    private String xiaoling;


}
