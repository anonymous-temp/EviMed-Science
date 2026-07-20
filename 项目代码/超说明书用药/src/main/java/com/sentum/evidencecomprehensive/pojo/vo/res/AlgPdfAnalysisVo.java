package com.sentum.evidencecomprehensive.pojo.vo.res;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;

@Data
@ApiModel("算法解析pdf之后的初始数据")
public class AlgPdfAnalysisVo {
    /**
     * 质量评价中 每个 mode 实体
     */
    private List<AlgPdfModeVo> algPdfModeVos;
    /**
     * 文献类型
     */
    private String type;
    /**
     * 文献质量高低
     */
    private String qualityMeta;
    /**
     * 是
     */
    private int yesNum;
    /**
     * 部分是
     */
    private int partNum;
    /**
     * 否
     */
    private int noNum;
    /**
     * 不适用
     */
    private int notApplicableNum;
    /**
     * 其他类型
     */
    private int otherNum;
}
