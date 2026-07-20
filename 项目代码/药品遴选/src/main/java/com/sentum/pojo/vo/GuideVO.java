package com.sentum.pojo.vo;

/**
 * Copyright 2022 ab173.com
 */
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import org.springframework.data.elasticsearch.annotations.Document;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;

import java.util.List;


@Data
@Document(indexName = "guide_data_index12",shards = 3)
public class GuideVO {
    @Field(type = FieldType.Keyword)
    @ApiModelProperty("id")
    private String id;
    @Field(type = FieldType.Keyword)
    @ApiModelProperty("url")
    private String url;
    @Field(type = FieldType.Keyword)
    @ApiModelProperty("年份")
    private String ysar;
    @ApiModelProperty("主题")
    @Field(type = FieldType.Text)
    private String zhuti_name;
    @Field(type = FieldType.Text)
    @ApiModelProperty("标题")
    private String title;
    @ApiModelProperty("文献类型")
    @Field(type = FieldType.Keyword)
    private String wxlx;
    @Field(type = FieldType.Keyword)
    @ApiModelProperty("发布日期")
    private String fbdate;
    @Field(type = FieldType.Long)
    private Long dateTs;
    @ApiModelProperty("出处")
    @Field(type = FieldType.Keyword)
    private String cc;
    @Field(type = FieldType.Keyword)
    @ApiModelProperty("pdf URL")
    private String pdf_url;
    @Field(type = FieldType.Keyword)
    @ApiModelProperty("pdf名称")
    private String pdf_name;
    @Field(type = FieldType.Text)
    @ApiModelProperty("内容介绍")
    private String nrjs;
    @Field(type = FieldType.Keyword)
    @ApiModelProperty("制定者")
    private String zdz;
    @Field(type = FieldType.Text)
    @ApiModelProperty("制定者类型")
    private String zdzType;
//    @Field(type = FieldType.Keyword)
//    @ApiModelProperty("关键字")
//    private String gjz;
    @ApiModelProperty("name")
    @Field(type = FieldType.Text)
//    @org.springframework.data.mongodb.core.mapping.Field("title")
    private String name;
    @ApiModelProperty("排除标志")
    private int exclude;
    @ApiModelProperty("收藏标志")
    private int starMark;
    @Field(type = FieldType.Text)
    private String pdf_txt;
    @Field(type = FieldType.Long)
    @ApiModelProperty("浏览数量")
    private long llsl;
    @Field(type = FieldType.Long)
    @ApiModelProperty("分享数量")
    private long fxsl;
    @Field(type = FieldType.Long)
    @ApiModelProperty("评论数量")
    private long plsl;
    @Field(type = FieldType.Long)
    @ApiModelProperty("收藏数量")
    private long scsl;
    @ApiModelProperty("指南评分")
    private String score = "0";
    @Field(type = FieldType.Keyword)
    @ApiModelProperty("指南关键字")
    private List<String> keywords;
    @ApiModelProperty("指南翻译 1 有翻译 0 没有翻译")
    private Integer trans = 1;
    @ApiModelProperty("搜索提示内容")
    private String hs;
    @ApiModelProperty("纳入状态")
    private Integer accept;
    @ApiModelProperty("订阅状态")
    private Integer subscribe;
    @Field(type = FieldType.Keyword)
    @ApiModelProperty("语言 zh 中文 en 英语")
    private String language;
    private int imageCnt;
    @Field(type = FieldType.Keyword)
    private String source;
    @Field(type = FieldType.Keyword)
    private String gjz;
    @Field(type = FieldType.Text)
    private List<String> blocks;
    /**
     * 1-文献类型指南；0-指南
     */
    @Field(type = FieldType.Keyword)
    private Integer isPaper;
    /**
     * 文本块
     */
    private String block;
    /**
     * 文本块中的指南id
     */
    private String guideId;


    private String scorex = "0";


    private String guideInfo;
    
    //根据id去重，重写方法
    //根据id去重，重写方法
    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;

        GuideVO guideVO = (GuideVO) o;

        return id != null ? id.equals(guideVO.id) : guideVO.id == null;
    }

    @Override
    public int hashCode() {
        return id != null ? id.hashCode() : 0;
    }

}