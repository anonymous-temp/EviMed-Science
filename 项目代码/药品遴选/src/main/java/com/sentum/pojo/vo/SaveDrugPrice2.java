package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 将用户输入的药品价格数据存储
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class SaveDrugPrice2 {
    @Id
    private String id;
    /**
     * 药品名称
     */
    @ApiModelProperty("药品名称")
    private String drugName;

    @ApiModelProperty("药品id")
    private String drugId;

    /**
     * 转换比
     */
    @ApiModelProperty("单次用药量")
    private String singleQuantity;

    @ApiModelProperty("给药频次")
    private String frequency;

    @ApiModelProperty("单价")
    private Double price;

    @ApiModelProperty("目标药品是否有同通用名药品? 价格最低的药品名称")
    private String alternativeDrugName;

    @ApiModelProperty("通用名药品单次用药量")
    private String alternativeSingleQuantity;

    @ApiModelProperty("通用名药品每日频次")
    private String alternativeFrequency;

    @ApiModelProperty("通用名药品单价")
    private String alternativePrice;

    @ApiModelProperty("可替代药品")
    private String replaceableDrug;

    @ApiModelProperty("可替代药品单次用药量")
    private String replaceableSingleQuantity;

    @ApiModelProperty("可替代药品频次")
    private String replaceableFrequency;

    @ApiModelProperty("可替代药品单价")
    private String replaceablePrice;


}
