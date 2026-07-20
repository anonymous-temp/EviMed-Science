package com.sentum.evidencecomprehensive.domain.vo.evaluate;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

@Data
@ApiModel(value = "文献信息提取编辑")
public class PaperInfoEditVo {
    @ApiModelProperty(value = "文献id")
    private String paperId;

    @ApiModelProperty(value = "课题 id")
    private String questionId;

    @ApiModelProperty(value = "评价标准id")
    private String infoId;

    @ApiModelProperty(value = "评价标准更改内容")
    private String content;
}
