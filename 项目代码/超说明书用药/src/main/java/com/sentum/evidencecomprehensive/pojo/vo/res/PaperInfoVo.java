package com.sentum.evidencecomprehensive.pojo.vo.res;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;

/**
 * Description: 文献的信息提取实体类
 */
@Data
@ApiModel("文献的信息提取实体类")
public class PaperInfoVo {
    @ApiModelProperty("质量评价中 每个 mode 实体")
    List<PaperInfoModeVo> paperInfoModeVos;
    @ApiModelProperty("量表pdf URL")
    String pdfUrl;
}
