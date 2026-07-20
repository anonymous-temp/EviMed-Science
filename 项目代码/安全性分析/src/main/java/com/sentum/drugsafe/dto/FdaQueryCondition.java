package com.sentum.drugsafe.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;

@Data
@ApiModel("fda接口参数")
@Document("fda_query_condition")
public class FdaQueryCondition {
    @ApiModelProperty
    @Id
    private String id;
    @ApiModelProperty("药品名称")
    private String drugName;
    @ApiModelProperty("药品匹配模式0精准1模糊")
    private int drugMatchMethod;
    @ApiModelProperty("药品")
    private List<String> drug;
    @ApiModelProperty("不良反应")
    private List<String> pt;
    @ApiModelProperty("药品匹配模式0精准1模糊")
    private int  ptMatchMethod;
    @ApiModelProperty("报告开始时间")
    private String reportStartTime;
    @ApiModelProperty("报告结束时间")
    private String reportEndTime;
    @ApiModelProperty("适应症")
    private List<String> indication;
    @ApiModelProperty("报告中作用")
    private List<String> role;
    @ApiModelProperty("严重不良反应结局")
    private List<String> seriousOutcome;
    @ApiModelProperty("职业")
    private List<String> career;
    @ApiModelProperty("性别")
    private List<String> sex;
    @ApiModelProperty("年龄")
    private List<String> age;
    @ApiModelProperty("是否展示未知数据,1是展示，0是不展示，默认展示")
    private String isShowUnknown;
    //结果id;
    private String resultId;
    private Boolean isOldTable = false;
}

