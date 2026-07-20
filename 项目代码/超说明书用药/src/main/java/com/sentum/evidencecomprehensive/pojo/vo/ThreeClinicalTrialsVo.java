package com.sentum.evidencecomprehensive.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;

/**
 * 第三个临床实验VO类
 */
@Data
@ApiModel("第三个临床试验vo类")
public class ThreeClinicalTrialsVo {

    @ApiModelProperty("id")
    private String id;

    @ApiModelProperty("cochraneId")
    private String cochraneId;

    @ApiModelProperty("题目")
    private String title;

    @ApiModelProperty("年份")
    private String year;

    @ApiModelProperty("关键字")
    private List<String> keyword;

    @ApiModelProperty("期刊")
    private String journal;

    @ApiModelProperty("发版类型")
    private List<String> publicationType;

    @ApiModelProperty("链接")
    private String url;
}
