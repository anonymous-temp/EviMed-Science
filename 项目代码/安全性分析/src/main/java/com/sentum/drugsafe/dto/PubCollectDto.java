package com.sentum.drugsafe.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

@Data
@ApiModel
public class PubCollectDto {

    @ApiModelProperty("发布id")
    private String releaseId;

    @ApiModelProperty("收藏或者取消收藏 true 收藏 false 取消收藏")
    private boolean status;
}
