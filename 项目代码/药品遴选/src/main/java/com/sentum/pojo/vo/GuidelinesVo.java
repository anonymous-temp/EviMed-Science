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
@ApiModel("返回前台的指南信息使用的vo类")
public class GuidelinesVo {
    @ApiModelProperty(value = "标题")
    private String title;
    @ApiModelProperty(value = "发布机构")
    private String zdz;
    @ApiModelProperty(value = "发布时间")
    private String fdaDate;
    @ApiModelProperty(value = "内容")
    private String content;
    @ApiModelProperty(value = "类型")
    private String type;
    @ApiModelProperty(value = "id")
    private String id;
    @ApiModelProperty(value = "是否是指南页面")
    private Integer isPaper;
    @ApiModelProperty(value = "作者")
    private List<String> author;
    @ApiModelProperty(value = "显示字段")
    private String showField;
}
