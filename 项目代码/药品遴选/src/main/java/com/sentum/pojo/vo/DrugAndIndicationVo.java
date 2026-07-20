package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("返回前台的药品适应症的清单时使用的vo类")
public class DrugAndIndicationVo {
    @ApiModelProperty("id")
    private String id;
    @ApiModelProperty("标题")
    private String title;
    @ApiModelProperty("标题-规格-厂家")
    private String name;
    @ApiModelProperty("规格")
    private String specifications;
    @ApiModelProperty("转换比")
    private String conversionRate;
    @ApiModelProperty("适应症")
    private String indication;
    @ApiModelProperty("说明书原文链接")
    private String url;
    @ApiModelProperty("商品中文名")
    private String commodityNameZh;
    @ApiModelProperty("商品英文名")
    private String commodityNameEn;
    @ApiModelProperty("是否可以补充说明书")
    private Boolean isbn;
    @ApiModelProperty("置灰的字段")
    private List<String> grav;
    @ApiModelProperty("说明书url后缀")
    private String urlSuffix;
}
