package com.sentum.evidencecomprehensive.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 分页查询时使用的vo类
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("站内信数据")
public class MailVo {
    @ApiModelProperty("站内信id")
    private String id;
    @ApiModelProperty("站内信内容，<b>标签为高亮显示")
    private String info;
    @ApiModelProperty("站内信创建时间")
    private String dateTime;
    @ApiModelProperty("0-未读；1-已读")
    private Integer status;
}
