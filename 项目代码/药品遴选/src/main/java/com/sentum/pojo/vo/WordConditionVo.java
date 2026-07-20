package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 检索词、翻译、同义词
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("展示检索词时使用的vo类")
public class WordConditionVo {
    @ApiModelProperty("原词")
    private String word;
    @ApiModelProperty("翻译")
    private String trans;
    @ApiModelProperty("同义词")
    private List<String> synonym;
    @ApiModelProperty("当前检索词的类型：单药名1，单药分类2，单疾病3，商品4")
    private Integer type;
}
