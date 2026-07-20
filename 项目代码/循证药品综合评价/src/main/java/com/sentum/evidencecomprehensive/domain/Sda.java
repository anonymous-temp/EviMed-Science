package com.sentum.evidencecomprehensive.domain;

import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.List;

/**
 * 药物警戒
 */
@Data
@Document("sda_pharmacovigilance")
public class Sda {
    @Id
    private String id;
    
    /**
     * 标题
     */
    @Field("title")
    private String title;

    /**
     * url
     */
    @Field("title_url")
    private String titleUrl;

    /**
     * 源码
     */
    @Field("sound_code")
    private String soundCode;

    /**
     * 标题概要
     */
    @Field("synopsis")
    private List<String> synopsis;

    /**
     * 日期
     */
    @Field("data_time")
    private String dateTime;
}
