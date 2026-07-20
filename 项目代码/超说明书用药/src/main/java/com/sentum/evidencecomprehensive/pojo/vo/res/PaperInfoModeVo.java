package com.sentum.evidencecomprehensive.pojo.vo.res;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

/**
 * Description: 文献信息提取每个mode实体
 */
@Data
@ApiModel(value = "文献信息提取每个mode实体")
public class PaperInfoModeVo {
    @ApiModelProperty("模块id")
    String infoId;
    @ApiModelProperty("标题")
    String title;
    @ApiModelProperty("内容")
    String content;
}
