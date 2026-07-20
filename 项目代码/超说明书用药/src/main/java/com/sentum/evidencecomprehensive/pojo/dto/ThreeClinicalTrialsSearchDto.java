package com.sentum.evidencecomprehensive.pojo.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "ClinicalTrialsSearchDto", description = "检索临床试验的dto类")
public class ThreeClinicalTrialsSearchDto {
    @ApiModelProperty("课题id")
    private String id;
    @ApiModelProperty("搜索框输入内容")
    private String searchData;
    @ApiModelProperty("开始年份")
    private String startYear;
    @ApiModelProperty("结束年份")
    private String endYear;
    @ApiModelProperty("来源")
    private List<String> source;
    @ApiModelProperty("语言")
    private List<String> language;
    @ApiModelProperty("注册时间排序，0默认值默认排序状态；1正序；2倒序")
    private Integer registrationTimeSort = 0;
    @ApiModelProperty("分页-每页大小默认10")
    private Integer pageSize = 10;
    @ApiModelProperty("分页-当前页数默认1")
    private Integer pageNum = 1;
}
