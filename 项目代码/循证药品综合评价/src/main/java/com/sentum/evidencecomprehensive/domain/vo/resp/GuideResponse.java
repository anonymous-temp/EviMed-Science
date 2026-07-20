package com.sentum.evidencecomprehensive.domain.vo.resp;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;

/**
 * 指南的显示vo类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("文献的显示vo类")
public class GuideResponse implements Serializable {
    private static final long serialVersionUID=1L;
    @ApiModelProperty("指南id")
    private String id;
    @ApiModelProperty("指南标题")
    private String title = "";
    @ApiModelProperty("指南内容简介")
    private String summary = "";
    @ApiModelProperty("指南发表日期")
    private String date = "暂无";
    @ApiModelProperty("指南制定者")
    private String author = "";
    @ApiModelProperty("语言 zh 中文 en 英语")
    private String language = "";
    @ApiModelProperty("指南评分")
    private String score = "-1";
    @ApiModelProperty("表示该指南被进行了纳排操作，0默认状态，1纳入状态，2排除状态")
    private Integer bringIntoOrExcludeMark = 0;
    @ApiModelProperty("收藏标记，1-已收藏，0-未收藏")
    private Integer collectionMark = 0;
    @ApiModelProperty("1-文献类型指南；0-指南")
    private Integer isPaper;
}
