package com.sentum.evidencecomprehensive.domain.mongo.report;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 *  国家基本药物
 */
@Data
@Document("national_essential_medicines_information")
@NoArgsConstructor
@AllArgsConstructor
public class EssentialMedicines {

    @Id
    private String id;
    
    /**
     * 药品名称
     */
    @Field("variety_name")
    private String varietyName;

    /**
     * 剂型与规格
     */
    @Field("dosage_form_and_specification")
    private String dosageFormAndSpecification;

    /**
     * 备注
     */
    @Field("note")
    private String note;

    /**
     * name1
     */
    @Field("name1")
    private String name1;

    /**
     * name2
     */
    @Field("name2")
    private String name2;

    /**
     * name3
     */
    @Field("name3")
    private String name3;

    /**
     * name4
     */
    @Field("name4")
    private String name4;

    /**
     * name5
     */
    @Field("name5")
    private String name5;
}

