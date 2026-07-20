package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;

@Data
public class DrugDisData {
    @ApiModelProperty(value = "标题")
    private String Title;

    @ApiModelProperty(value = "药物ID")
    private String drugId;

    @ApiModelProperty(value = "疾病名称")
    private String disease;

    private String drugZh;

    @ApiModelProperty(value = "信息详情")
    private InstructionDataVo info;

    @ApiModelProperty(value = "适应症")
    private String indication;

    @ApiModelProperty(value = "临床试验信息")
    private String clinical;

    @ApiModelProperty(value = "全球使用情况")
    private String globalUsage;

    @ApiModelProperty(value = "制造商")
    private String manufacturers;

    @ApiModelProperty(value = "指南列表")
    private List<GuidelinesVo> guide;

    @ApiModelProperty(value = "文献列表")
    private List<GuidelinesVo> literature;

    private String manufacturer;


    private String drugName;


}
