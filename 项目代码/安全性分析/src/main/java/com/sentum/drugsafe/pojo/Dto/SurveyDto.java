package com.sentum.drugsafe.pojo.Dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import org.springframework.data.mongodb.core.mapping.Document;

import java.io.Serializable;
import java.util.List;

@Data
@ApiModel("问卷调查请求类")
@Document("evaluation_survey")
public class SurveyDto implements Serializable {

    @ApiModelProperty("用户姓名")
    private String userName;

    @ApiModelProperty("用户联系方式")
    private String userPhone;

    @ApiModelProperty("用户所在单位")
    private String userUnit;


    @ApiModelProperty("所要分析的数据库")
    private String database;

    @ApiModelProperty("药品类型")
    private String drugType;

    @ApiModelProperty("是否过滤复方制剂")
    private String filter;

    @ApiModelProperty("是否限定药品在报告中的作用")
    private List<String> drugEffect;

    @ApiModelProperty("是否有需要限定的不良反应")
    private String pt;

    @ApiModelProperty("是否限定适应症")
    private String indication;

    @ApiModelProperty("是否限定时间范围")
    private String time;

    @ApiModelProperty("是否有必要的分析维度")
    private String dimension;




}
