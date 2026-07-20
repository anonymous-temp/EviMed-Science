package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("返回前台的药品价格的清单时使用的vo类")
public class DrugAndPriceVo {
    @ApiModelProperty("id")
    private String id;
    @ApiModelProperty("标题")
    private String title;
    @ApiModelProperty("标题-规格-厂家")
    private String name;
    @ApiModelProperty("中标价格")
    private String price;
    @ApiModelProperty("国家医保")
    private String insurance;
    @ApiModelProperty("国家基本药物，true是")
    private String isEssentialMedicines;
    @ApiModelProperty("规格")
    private String specifications;
    @ApiModelProperty("转换比")
    private String conversionRate;
    @ApiModelProperty("说明书原文链接")
    private String url;
    @ApiModelProperty("商品中文")
    private String communityNameZh;
    @ApiModelProperty("商品英文")
    private String communityNameEn;
    @ApiModelProperty("url后缀")
    private String urlSuffix;
}
