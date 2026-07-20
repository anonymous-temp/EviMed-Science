package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.Data;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;


/**
 * @author gxp
 * @ date 2023/3/22 19:11
 */
@Data
@Document("instructions")
public class Instruction {

    @Field("_id")
    private String id;
    /**
     * 英语名称 显示用的通用名（优先级2）
     */
    private String englishName;
    /**
     * 成分
     */
    private String components;
    /**
     * 禁忌
     */
    private String taboo;
    private String imagePath;
    /**
     * 儿童用药
     */
    private String medicationInChildren;
    /**
     * 药品不良反应
     */
    private String adrs;
    private Integer pageSize;
    /**
     * 来源	中国 nmpa 美国fda 欧盟ema 日本 pmda
     */
    private String source;
    /**
     * 怀孕和哺乳期妇女 特殊人群
     */
    private String pregnantAndLactatingWomen;
    /**
     * 规格
     */
    private String specifications;
    private String uuid;
    /**
     * 通用名称 显示用的成分名（优先级3）
     */
    private String genericNames;
    /**
     * 商品名称 显示用的商品名（优先级1）
     */
    private String tradeNames;
    /**
     * 分数	等于适应症长度
     */
    private Integer score;
    /**
     * 英语名称 检索P
     */
    private String simpleEnglishName;
    /**
     * pdf存放地址
     */
    @Field("pdf_name")
    private String pdfName;
    /**
     * 英语名称 检索P
     */
    private String simpleGenericNames;
    /**
     * 适应症 显示用的适应症
     */
    private String indication;
    /**
     * 老年药物 特殊人群
     */
    private String geriatricMedications;
    /**
     * 药企名称
     */
    private String enterpriseName;

    /**
     * 用法用量
     */
    private String usage;

}
