package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.io.Serializable;
import java.util.List;

@Data
public class TraditionalDataVo implements Serializable {
    @ApiModelProperty(value = "标题")
    private String title;

    @ApiModelProperty(value = "药物ID")
    private String drugId;

    @ApiModelProperty(value = "药品名称")
    private String drugName;

    @ApiModelProperty(value = "说明书部分")
    private TraditionalInstructionVo instruction;

    @ApiModelProperty(value = "安全性评价")
    private String safety;

    @ApiModelProperty(value = "指南")
    private List<GuidelinesVo> guide;

    @ApiModelProperty(value = "古代经典名方目录")
    private String classic;

    @ApiModelProperty(value = "文献")
    private List<GuidelinesVo> literature;

    @ApiModelProperty(value = "药理作用")
    private String pharmacological;

    @ApiModelProperty(value = "指纹图谱研究")
    private String fingerprint;

    @ApiModelProperty(value = "有效性再评价")
    private String validity;

    @ApiModelProperty(value = "含量测定方法")
    private String content;

    @ApiModelProperty(value = "专利、所获奖项")
    private String patent;

    @ApiModelProperty(value = "企业状况")
    private String manufacturers;

    @ApiModelProperty(value = "企业")
    private String manufacturer;




}
