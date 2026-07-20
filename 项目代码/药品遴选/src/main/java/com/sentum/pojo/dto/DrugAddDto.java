package com.sentum.pojo.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 药品信息表
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("用户补充的说明书相关信息")
@Document("evaluation_drug_add")
public class DrugAddDto {
    @ApiModelProperty("药品id")
    private String drugId;
    /**
     * 药品名称
     */
    @ApiModelProperty("药品通用名称")
    private String drugName;

    /**
     * 注册账号
     */
    @ApiModelProperty("药品注册账号")
    private String register;
    /**
     * 药品规格
     */
    @ApiModelProperty("药品规格")
    private String specifications;
    /**
     * 剂型
     */
    @ApiModelProperty("剂型")
    private String dosageForm;
    /**
     * 商品中文
     */
    @ApiModelProperty("商品名称")
    private String communityNameZh;

    /**
     * 五级英文
     */
    @ApiModelProperty("药品英文")
    private String drugEn;

    /**
     * 适应症
     */
    @ApiModelProperty("药品适应症")
    private String indication;


    /**
     * 药理作用
     */
    @ApiModelProperty("药品药理作用")
    private String pharmacology;
    /**
     * 药代动力学
     */
    @ApiModelProperty("药代动力学")
    private String pharmacokinetics;
    /**
     * 药品给药剂量
     */
    @ApiModelProperty("药品给药剂量")
    private String dosageAdministered;
    /**
     * 给药频次
     */
    @ApiModelProperty("药品给药频次")
    private String dosageFrequency;
    /**
     * 贮藏
     */
    @ApiModelProperty("药品贮藏条件")
    private String storage;
    /**
     * 有效期
     */
    @ApiModelProperty("药品有效期")
    private String indate;

    /**
     * 不良反应
     */
    @ApiModelProperty("药品中度不良反应")
    private String moderateAdverseReaction;

    @ApiModelProperty("药品重度不良反应")
    private String severeAdverseReaction;
    /**
     * 孕妇及哺乳期妇女
     */
    @ApiModelProperty("药品孕妇及哺乳期妇女用药")
    private String pregnantWomen;
    /**
     * 儿童用药
     */
    @ApiModelProperty("药品儿童用药")
    private String childrenMedicine;
    /**
     * 老人用药
     */
    @ApiModelProperty("药品老年用药")
    private String geriatricMedicine;
    /**
     * 药物相互作用
     */
    @ApiModelProperty("药品药物相互作用")
    private String drugInteraction;

    /**
     * 成分
     */
    @ApiModelProperty("药品主要成分")
    private String ingredient;
    /**
     * 辅料
     */
    @ApiModelProperty("药品辅料")
    private String accessory;
    /**
     * 注意事项
     */
    @ApiModelProperty("药品注意事项")
    private String notes;
    /**
     * 禁忌
     */
    @ApiModelProperty("药品禁忌")
    private String taboo;

    /**
     * 药品厂家
     */
    @ApiModelProperty("药品厂家")
    private String manufacturer;

    @ApiModelProperty("肾病是否可用")
    private String kidneyPatients;

    @ApiModelProperty("肝病是否可用")
    private String liverPatients;

    @ApiModelProperty("流程id")
    private String searchId;

    private Long userId;


}
