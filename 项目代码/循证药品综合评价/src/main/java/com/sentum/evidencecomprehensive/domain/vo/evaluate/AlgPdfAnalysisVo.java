package com.sentum.evidencecomprehensive.domain.vo.evaluate;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;

/**
 * Description: 算法解析pdf之后的初始数据
 */
@Data
@ApiModel("算法解析pdf之后的初始数据")
public class AlgPdfAnalysisVo {

    @ApiModelProperty("质量评价中 每个 mode 实体")
    private List<AlgPdfModeVo> algPdfModeVos;

    @ApiModelProperty("文献类型")
    private String type;

    @ApiModelProperty("文献质量高低")
    private String qualityMeta;

    @ApiModelProperty("是")
    private int yesNum;

    @ApiModelProperty("部分是")
    private int partNum;

    @ApiModelProperty("否")
    private int noNum;

    @ApiModelProperty("不适用")
    private int notApplicableNum;

    @ApiModelProperty("其他类型")
    private int otherNum;
}
