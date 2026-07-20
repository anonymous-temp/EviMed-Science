package com.sentum.evidencecomprehensive.pojo.dto;

import com.sentum.evidencecomprehensive.pojo.info.JournalDivision;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "PaperSearchDto", description = "检索文献的dto类")
public class PaperSearchDto {
    @ApiModelProperty("检索id")
    private String id;
    @ApiModelProperty("用户选择文献类型，默认0Meta/系统评价")
    private Integer studyType = 0;
    @ApiModelProperty("查询类型，0-默认；1-纳入；2-排除，默认0")
    private Integer operateType = 0;
    @ApiModelProperty("语言类型，0-全部；1-中文；2-英文，默认0-全部")
    private Integer language = 0;
    @ApiModelProperty("期刊级别，默认不限，即不传值后端进行默认")
    private List<JournalDivision> journalLevel = new ArrayList<>();
    @ApiModelProperty("文献质量，0-不限；1-低；2-中；3-高，默认0-不限")
    private List<Integer> quality = Collections.singletonList(0);
    @ApiModelProperty("发表时间-起始年份")
    private Integer startYear;
    @ApiModelProperty("发表时间-结束年份")
    private Integer endYear;
    @ApiModelProperty("二次检索输入框输入内容")
    private String search;
    @ApiModelProperty("排序条件，0-相关度；1-影响引子；2-发表时间。默认0-相关度")
    private Integer sortType = 0;
    @ApiModelProperty("排序方向，0-倒叙，大到小；1-正序小到大。默认0-倒叙")
    private Integer sortDirection = 0;
    @ApiModelProperty("分页-每页大小默认10")
    private Integer pageSize = 10;
    @ApiModelProperty("分页-当前页数默认1")
    private Integer pageNum = 1;
}
