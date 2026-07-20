package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 发布页相关数据
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evaluation_release_data")
public class ReleaseData {
    /**
     * id
     */
    @Id
    private String id;
    /**
     * 报告名称
     */
    private String name;
    /**
     * 药品名称
     */
    private String drugName;
    /**
     * 疾病名称
     */
    private String disease;
    /**
     * 发布作者的唯一id
     */
    private String userId;
    /**
     * 发布作者
     */
    private String author;
    /**
     * 发布单位
     */
    private String workUnit;
    /**
     * 发布科室
     */
    private String department;
    /**
     * 简介
     */
    private String profile;
    /**
     * 发布时间
     */
    private String time;
    /**
     * 文件所在位置
     */
    private String filePath;

    /**
     * 文件名称
     */
    private String fileName;
}
