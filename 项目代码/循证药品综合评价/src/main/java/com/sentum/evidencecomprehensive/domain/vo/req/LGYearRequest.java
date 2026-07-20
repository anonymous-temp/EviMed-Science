package com.sentum.evidencecomprehensive.domain.vo.req;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;

/**
 * Description: 文献指南时间范围确定
 */
@Data
@ApiModel("文献指南时间范围确定类")
public class LGYearRequest {
    
    @ApiModelProperty("课题 id")
    private String id;

    @ApiModelProperty("弹框指南检索起始年份")
    private String guideStartYear;
    
    @ApiModelProperty("弹框指南检索结束年份")
    private String guideEndYear;
    
    @ApiModelProperty("弹框文献检索起始年份")
    private String literatureStartYear;
    
    @ApiModelProperty("弹框文献检索结束年份")
    private String literatureEndYear;
    
    @ApiModelProperty("弹框中文期刊来源")
    private List<String> zhJournal;
    
    @ApiModelProperty("弹框英文期刊来源")
    private List<String> enJournal;
}
