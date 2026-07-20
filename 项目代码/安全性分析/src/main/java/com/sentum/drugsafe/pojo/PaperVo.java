package com.sentum.drugsafe.pojo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 文献的显示vo类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("文献的显示vo类")
public class PaperVo implements Serializable {
    private static final long serialVersionUID=1L;
    @ApiModelProperty("文献id")
    private String id;
    @ApiModelProperty("文献标题")
    private String title = "";
    @ApiModelProperty("文献摘要")
    private String summary = "";
    @ApiModelProperty("期刊名称")
    private String journal = "暂无";
    @ApiModelProperty("作者名称")
    private List<String> author = new ArrayList<>();
    @ApiModelProperty("文献类型")
    private List<Integer> type = new ArrayList<>();
    @ApiModelProperty("文献质量等级")
    private String quality = "";
    @ApiModelProperty("文献发表年份")
    private String year = "暂无";
    @ApiModelProperty("影响因子")
    private String jcr = "暂无";
    @ApiModelProperty("中文文献显示所属核心")
    private List<String> partition;
    @ApiModelProperty("英文文献显示分区")
    private List<String> enPartition;
    @ApiModelProperty("英文文献显示分区")
    private List<Map<String, Object>> englishPartition;
    @ApiModelProperty("收录方-文献来源")
    private List<String> source = new ArrayList<>();
    @ApiModelProperty("中文为false，英文为true")
    private Boolean language;
    @ApiModelProperty("原文链接")
    private String mainUrl = "";
    @ApiModelProperty("pdf链接")
    private String pdfUrl = "";
    @ApiModelProperty("用户上传的pdf链接")
    private String fileUrl = "";
    @ApiModelProperty("表示该文献被进行了纳排操作，0默认状态，1纳入状态，2排除状态")
    private Integer bringIntoOrExcludeMark = 0;
    @ApiModelProperty("收藏标记，1-已收藏，0-未收藏")
    private Integer collectionMark = 0;
    @ApiModelProperty("pdfToPic实体类")
    private PdfToPicVo pdfToPicVo;
}
