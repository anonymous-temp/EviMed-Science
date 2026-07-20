package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * cde收藏实体类
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_cde_collect")
public class CdeCollect {
    @Id
    private String id;
    /**
     * 检索id，课题id
     */
    private String conditionId;
    /**
     * 文献id
     */
    private String cdeId;
    /**
     * 用户id
     */
    private Long userId;
    /**
     * 收藏时间戳
     */
    private Long timeStamp;

    /**
     * 药品集采  实体类
     */
    @Data
    @Document("evaluation_medical_insurance_20250117")
    public static class MedicalInsurance {
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
         * 中药/西药
         */
        @Field("drug_type")
        private String drugType;
    
        /**
         * 医保类型
         */
        @Field("medical_type")
        private String medicalType;
    
        /**
         *  支付限制
         */
        @Field("payLimit")
        private String payLimit;
    
        /**
         *  名字 1
         */
        @Field("name1")
        private String name1;
    
        /**
         *  名字 2
         */
        @Field("name2")
        private String name2;
    
        /**
         *  名字 3
         */
        @Field("name3")
        private String name3;
    
        /*
         *  名字 4
         */
        @Field("name4")
        private String name4;
    
        /**
         *  名字 5
         */
        @Field("name5")
        private String name5;
    
        /**
         *  名字 6
         */
        @Field("name6")
        private String name6;
    
        /**
         *  名字 7
         */
        @Field("name7")
        private String name7;
    
        /**
         *  名字 8
         */
        @Field("name8")
        private String name8;
    
    }
}
