package com.sentum.evidencecomprehensive.domain.es;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;

/**
 * 关联词es映射实体类
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document(indexName = "drug_adverse_associational_index", shards = 3)
//@Document(indexName = "associational_word_index")
public class AssociationalWord {
    /**
     *id
     */
    @Id
    private String id;
    /**
     * 关联词
     */
    @Field(type = FieldType.Keyword)
    private String word;

    @Field(type = FieldType.Integer)
    private Integer size;
}
