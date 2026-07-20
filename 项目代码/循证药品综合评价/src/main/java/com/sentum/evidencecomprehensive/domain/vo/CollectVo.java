package com.sentum.evidencecomprehensive.domain.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

/**
 * Description: hta报告收藏实体
 */
@Data
@ApiModel("hta报告收藏实体类")
public class CollectVo {
    @ApiModelProperty("hta报告id")
    private String id;
    
    @ApiModelProperty("是否收藏 0取消收藏 1收藏")
    private String collect = "0";
}
