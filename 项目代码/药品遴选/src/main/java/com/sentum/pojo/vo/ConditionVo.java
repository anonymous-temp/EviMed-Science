package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

/**
 * 检索词、翻译、同义词及经系统判定后的组合状态
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("返回前台检索词、翻译、同义词及经系统判定后的组合状态时使用的vo类")
public class ConditionVo {
    @ApiModelProperty("检索词的原词、翻译、同义词等相关数据")
    private List<WordConditionVo> data;
    @ApiModelProperty("单药名1，单药分类2，单疾病3，药名+疾病4，药分类+疾病5，商品6，商品+疾病7")
    private Integer status;
    @ApiModelProperty("每页大小")
    private Integer pageSize = 10;
    @ApiModelProperty("当前页")
    private Integer pageNum = 1;
    @ApiModelProperty("药品分类2，5下用户勾选的药品集合名称")
    private List<String> drugs;
    @ApiModelProperty("在列表页用户输入的检索条件")
    private String searchWord;
    @ApiModelProperty("app单独的返回的数据内容")
    private List<Map<String, Object>> appData;
    @ApiModelProperty("检索的id")
    private String searchId;
    @ApiModelProperty("app单独的返回的数据内容")
    private List<Map<String, Object>> appDataSdy;

    private String drugCategory;

    private String scaleId;

}
