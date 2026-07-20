package com.sentum.pojo.vo;

import com.alibaba.fastjson.JSONObject;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("返回前台的药品说明书信息使用的vo类")
public class InstructionDataVo {
    /**
     * 药理作用
     */
    @ApiModelProperty("药理作用")
    private String pharmacology;

    /**
     * 药代动力学
     */
    @ApiModelProperty("药代动力学")
    private String pharmacokinetics;

    /**
     * 不良反应
     */
    @ApiModelProperty("不良反应")
    private String adverseReaction;

    /**
     * 中度不良反应
     */
    @ApiModelProperty("中度不良反应")
    private String commonAdverseReactions;

    /**
     * 重度不良反应
     */
    @ApiModelProperty("重度不良反应")
    private String seriousAdverseReactions;


    @ApiModelProperty("说明书url")
    private String url;

    @ApiModelProperty("药品名称拼接")
    private String drugNameDetail;

    @ApiModelProperty("是否使用说明书的不良反应，而非用药助手的")
    private String isAdverseReactions;
}
