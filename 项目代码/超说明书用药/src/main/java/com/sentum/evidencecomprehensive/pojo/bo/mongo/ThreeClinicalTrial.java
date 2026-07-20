package com.sentum.evidencecomprehensive.pojo.bo.mongo;

import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.List;

/**
 * 临床试验mongo对应实体类--clinicalTrial
 * @author zgm
 */
@Data
@Document("clinical_central")
public class ThreeClinicalTrial {
    @Id
    private String id;
    /**
     * 期刊
     */
    @Field("journal")
    private String journal;

    /**
     * 链接
     */
    @Field("url")
    private List<String> url;

    /**
     * 发版类型
     */
    @Field("publication_type")
    private List<String> publicationType;
}
