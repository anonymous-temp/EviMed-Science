package com.sentum.evidencecomprehensive.pojo.vo;

import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/10/15
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class GuideConfirmVo {
    @ApiModelProperty("指南id")
    private String id;

    @ApiModelProperty("指南标题")
    private String title;

    @ApiModelProperty("组织机构")
    private String organization;

    @ApiModelProperty("发布日期")
    private String fbdate;

    @ApiModelProperty("制定者")
    private String zdz;

    @ApiModelProperty("内容详情")
    private String blocks;

    @ApiModelProperty("年份")
    private String year;

    @ApiModelProperty("1-文献类型指南；0-指南")
    private Integer isPaper;
}
