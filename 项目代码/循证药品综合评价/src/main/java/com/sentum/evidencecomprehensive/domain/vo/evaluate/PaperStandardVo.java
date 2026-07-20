package com.sentum.evidencecomprehensive.domain.vo.evaluate;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

@Data
@ApiModel(value = "文献质量评价编辑")
public class PaperStandardVo {
    
    @ApiModelProperty(value = "文献id")
    private String paperId;

    @ApiModelProperty(value = "课题 id")
    private String questionId;

    @ApiModelProperty(value = "评价标准id")
    private String standardId;

    @ApiModelProperty(value = "评价标准更改内容")
    private String standardValue;
}
