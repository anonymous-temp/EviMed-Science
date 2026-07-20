package com.sentum.drugsafe.pojo;

import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.List;

@Data
public class WordVO {
    @ApiModelProperty("分词")
    private String word;
    @ApiModelProperty("分词类型")
    private String type;
    @ApiModelProperty("分词翻译")
    private String trans;
    @ApiModelProperty("英文同义词")
    private List<String> enSynonym;
    @ApiModelProperty("中文同义词")
    private List<String> zhSynonym;
    @ApiModelProperty("用户补充同义词")
    private List<String> userSynonym;
}
