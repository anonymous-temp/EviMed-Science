package com.sentum.drugsafe.dto;

import com.sentum.drugsafe.pojo.WordVO;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;

@ApiModel("概览获取检索条件面板参数")
@Data
public class GetConditionDto {
    @ApiModelProperty("检索词")
    List<WordVO> words;
}
