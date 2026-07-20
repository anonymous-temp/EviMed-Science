package com.sentum.evidencecomprehensive.domain.vo.req;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;

import java.util.List;

/**
 * Description: HTA 搜索使用DTO
 */

@Data
@Slf4j
@ApiModel(value = "HTA 搜索使用DTO")
public class HTASearchRequest {
    @ApiModelProperty("检索id")
    private String id;
    @ApiModelProperty("操作类型 0默认 1纳入")
    private Integer operateType = 0;
    @ApiModelProperty("搜索栏-国家")
    private List<String> country;
    @ApiModelProperty("搜索栏-发布时间 0正序 1倒叙")
    private Integer published = 1;
    @ApiModelProperty("发表时间-起始年份")
    private Integer startYear;
    @ApiModelProperty("发表时间-结束年份")
    private Integer endYear;
    @ApiModelProperty("二次检索输入框输入内容")
    private String search;
    @ApiModelProperty("排序条件，0-相关度；1-发表时间；默认0-相关度")
    private Integer sortType = 0;
    @ApiModelProperty("排序方向，0-倒叙，大到小；1-正序小到大。默认0-倒叙")
    private Integer sortDirection = 0;
    @ApiModelProperty("请求分页码数，默认第一页")
    private Integer pageNum = 1;
    @ApiModelProperty("请求分页大小，默认大小10")
    private Integer pageSize = 10;
}
