package com.sentum.evidencecomprehensive.domain.vo.req;

import com.sentum.evidencecomprehensive.domain.dto.GuideConditionDTO;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;
import java.util.ArrayList;
import java.util.List;

@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "GuideSearchRequest", description = "指南list检索实体类")
public class GuideSearchRequest {
    @NotNull
    @NotBlank
    @ApiModelProperty("检索id")
    private String id;
    @ApiModelProperty("语言类型，0-全部；1-中文；2-英文，默认0-全部")
    private Integer language = 0;
    @ApiModelProperty("操作类型 0默认 1纳入")
    private Integer operateType = 0;
    @ApiModelProperty("制定者的集合，多选")
    private List<String> authors = new ArrayList<>();
    @ApiModelProperty("发表时间-起始年份")
    private Integer startYear;
    @ApiModelProperty("发表时间-结束年份")
    private Integer endYear;
    @ApiModelProperty("二次检索输入框输入内容")
    private String search;
    @ApiModelProperty("排序条件，0-相关度；1-发表时间。默认0-相关度")
    private Integer sortType = 0;
    @ApiModelProperty("排序方向，0-倒叙，大到小；1-正序小到大。默认0-倒叙")
    private Integer sortDirection = 0;
    @ApiModelProperty("分页-每页大小默认10")
    private Integer pageSize = 10;
    @ApiModelProperty("分页-当前页数默认1")
    private Integer pageNum = 1;
    @ApiModelProperty("内部检索条件")
    private GuideConditionDTO guideConditionDTO;
}
