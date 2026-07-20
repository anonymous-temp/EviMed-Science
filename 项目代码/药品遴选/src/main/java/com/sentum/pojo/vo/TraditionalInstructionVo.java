package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

@Data
public class TraditionalInstructionVo {

    @ApiModelProperty(value = "不良反应")
    private String adverseReaction;

    @ApiModelProperty(value = "儿童用药")
    private String children;

    @ApiModelProperty(value = "老人用药")
    private String elderly;

    @ApiModelProperty(value = "孕妇以及哺乳期用药")
    private String pregnant;

    @ApiModelProperty(value = "肝功能异常者用药")
    private String liver;

    @ApiModelProperty(value = "肾功能异常者用药")
    private String kidney;


    public TraditionalInstructionVo (){
        this.adverseReaction = "";
        this.children = "";
        this.elderly = "";
        this.pregnant = "";
        this.liver = "";
        this.kidney = "";

    }



}
