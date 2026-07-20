package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;

@ApiModel("相关内容")
@Data
public class RelatedVo {
    @ApiModelProperty("说明书")
    private List<InstructionsInfoVo>  instructionsInfo;

    @ApiModelProperty("指南")
    private List<GuidelinesVo>  guide;


    @ApiModelProperty("文献")
    private List<Object>  literature;
}
