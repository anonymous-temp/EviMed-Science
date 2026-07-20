package com.sentum.evidencecomprehensive.domain.mongo.report;

import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * 药品集采  实体类
 */
@Data
@Document("evaluation_drug_procurement")
public class Procurement {
    @Id
    private String id;

    /**
     * 药品名称
     */
    @Field("drugName")
    private String drugName;

    /**
     * 剂型
     */
    @Field("dosageForm")
    private String dosageForm;

    /**
     * 包装
     */
    @Field("packing")
    private String packing;

    /**
     * 计价单位
     */
    @Field("unit")
    private String unit;

    /**
     * 生产企业
     */
    @Field("manufactor")
    private String manufactor;

    /**
     * 中选价格
     */
    @Field("price")
    private String price;

    /**
     *  来源
     */
    @Field("source")
    private String source;

}
