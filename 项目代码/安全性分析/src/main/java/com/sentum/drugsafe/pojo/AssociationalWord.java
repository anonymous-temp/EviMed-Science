package com.sentum.drugsafe.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;

/**
 * 药物警戒联想词（包含药品+不良反应）
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document(indexName = "drug_adverse_associational_index", shards = 3)
public class AssociationalWord {
    @Id
    private String id;
    /**
     * 联想词
     */
    @Field(type = FieldType.Keyword)
    private String word;
    /**
     * 该词的长度
     */
    @Field(type = FieldType.Integer)
    private Integer size;
}
