package com.sentum.evidencecomprehensive.pojo.bo.mongo;

import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * cde 实体类
 */
@Data
@Document("cde_data")
public class CdeData {
    @Id
    private String id;
    
    /**
     * 药品名称
     */
    @Field("drgnamecn")
    private String drgnamecn;

    /**
     * 类型
     */
    @Field("drugtype")
    private String drugtype;

    /**
     * 等级
     */
    @Field("registerkind")
    private String registerkind;

    /**
     * createddate
     */
    @Field("createddate")
    private String createddate;

    /**
     * 适应症
     */
    @Field("indication")
    private String indication;

    /**
     * 有效性
     */
    @Field("effective")
    private String effective;

    /**
     * 安全性
     */
    @Field("safety")
    private String safety;

    /**
     * 结论
     */
    @Field("conclusion")
    private String conclusion;

    /**
     * drug_info
     */
    @Field("drug_info")
    private String drugInfo;
}
