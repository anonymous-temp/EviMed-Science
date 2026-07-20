package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.io.Serializable;
import java.util.List;

/**
 * @Description: 同义词接收实体类
 */
@ApiModel(value = "同义词接收实体类")
@Data
public class SynonymVo implements Serializable {
    /**
     * 药或者病的名称
     */
    @ApiModelProperty(value = "药或者病的名称")
    private String drugOrDisease;
    
    /**
     * 单药名1，单药分类2，单疾病3，商品4
     */
    @ApiModelProperty(value = "单药名1，单药分类2，单疾病3，商品4")
    private String type;

    /**
     * 同义词列表 gpt分析的时候所使用
     */
    @ApiModelProperty(value = "同义词列表 gpt分析的时候所使用")
    private List<String> synonyms;

    /**
     * 反勾选同义词列表
     */
    @ApiModelProperty(value = "反勾选同义词列表")
    private List<String> excludeSynonyms;
}
