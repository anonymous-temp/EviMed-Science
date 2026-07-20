package com.sentum.drugsafe.pojo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.time.LocalDate;
import java.util.Date;

@ApiModel(value = "SearchCondition对象", description = "高级搜索条件表")
@Data
public class SearchCondition {

    @ApiModelProperty("药品名称，一行是一个()，相同药品用OR联接，模糊与否放[]里")
    private String drugNames;

    @ApiModelProperty("不良反应名称，一行是一个(),相同的不良反应使用OR联接，模糊与否放[]里")
    private String adverse;

    @ApiModelProperty("报告开始时间")
    private String reportStartTime;

    @ApiModelProperty("报告结束时间")
    private Long reportEndTime;

    @ApiModelProperty("是否智能检索（英文扩展）")
    private Long   isIntelligent;

    @ApiModelProperty("是否同义词拓展")
    private String isSynonym;

    @ApiModelProperty("是否模糊检索，1 模糊 0精准")
    private String isVague;

    @ApiModelProperty("是否包含报告")
    private String isPrecise;



}
