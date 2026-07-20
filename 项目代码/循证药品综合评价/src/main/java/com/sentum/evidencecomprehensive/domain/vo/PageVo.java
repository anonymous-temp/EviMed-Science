package com.sentum.evidencecomprehensive.domain.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 分页查询时使用的vo类
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("分页查询时使用的vo类")
public class PageVo<T> {
    /**
     * pageNum 当前页
     */
    @ApiModelProperty("当前页")
    private Integer pageNum;

    /**
     * pageSize 每页的数量
     */
    @ApiModelProperty("每页的数量")
    private Integer pageSize;

    /**
     * total 总共的条数
     */
    @ApiModelProperty("总共的条数")
    private Long total;

    /**
     * pages 总共的页数
     */
    @ApiModelProperty("总共的页数")
    private Integer pages;

    /**
     * list 返回的集合
     */
    @ApiModelProperty("返回的集合")
    private List<T> list;
}
