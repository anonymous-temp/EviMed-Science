package com.sentum.evidencecomprehensive.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;
import java.util.List;

/**
 * 弹框接收文献指南的vo类
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("弹框接收文献指南的vo类")
@Builder
public class LiteratureGuideVo{
    
    @ApiModelProperty("课题id")
    private String id;

    @ApiModelProperty("指南编辑实体类")
    private List<GuideConfirmVo> guideConfirmVo;

    @ApiModelProperty("指南编辑实体类")
    private List<LiteratureConfirmVo> literatureConfirmVo;
}



