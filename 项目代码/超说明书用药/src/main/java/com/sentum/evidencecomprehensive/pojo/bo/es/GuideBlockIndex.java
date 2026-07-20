package com.sentum.evidencecomprehensive.pojo.bo.es;

import lombok.Data;
import org.springframework.data.elasticsearch.annotations.Document;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;

@Data
@Document(indexName = "guide_block_index",shards = 6)
public class GuideBlockIndex {
    @Field(type = FieldType.Keyword)
    private String guideId;
    @Field(type = FieldType.Keyword)
    private String language;
    @Field(type = FieldType.Text)
    private String block;
}
